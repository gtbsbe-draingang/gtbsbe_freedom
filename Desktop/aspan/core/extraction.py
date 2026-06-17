from __future__ import annotations

import base64
import json
import logging
import mimetypes
import os
import re
from datetime import date
from pathlib import Path
from typing import Any

from pydantic import ValidationError

from core.config_loader import AppConfig
from core.models import BillData

logger = logging.getLogger(__name__)


def fallback_bill(reason: str) -> BillData:
    return BillData(
        monthly_kwh=10000,
        currency="USD",
        total_cost=2000,
        tariff_per_kwh=0.20,
        billing_period_start=None,
        billing_period_end=None,
        extraction_notes=[reason, "Fallback bill data must be reviewed before client use."],
        field_confidence={
            "monthly_kwh": 0.1,
            "currency": 0.1,
            "total_cost": 0.1,
            "tariff_per_kwh": 0.1,
        },
    )


def _extract_json_object(text: str) -> dict[str, Any]:
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not match:
        raise json.JSONDecodeError("No JSON object found", text, 0)
    return json.loads(match.group(0))


def _content_block_for_file(file_path: str) -> dict[str, Any]:
    path = Path(file_path)
    media_type = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    data = base64.b64encode(path.read_bytes()).decode("ascii")
    if media_type.startswith("image/"):
        return {
            "type": "image",
            "source": {"type": "base64", "media_type": media_type, "data": data},
        }
    return {
        "type": "document",
        "source": {"type": "base64", "media_type": media_type, "data": data},
    }


def _call_claude_for_bill(file_path: str) -> dict[str, Any]:
    from anthropic import Anthropic

    client = Anthropic(api_key=os.getenv("ANTHROPIC_API_KEY"))
    model = os.getenv("ANTHROPIC_VISION_MODEL", "claude-3-5-sonnet-latest")
    prompt = """
Extract utility bill data into strict JSON. Handle English, Russian, Kazakh, and French bills.
Return exactly this JSON object and no prose:
{
  "monthly_kwh": number | null,
  "currency": "USD" | "GHS" | "XOF" | "NGN" | "KZT" | "RUB" | string,
  "total_cost": number | null,
  "tariff_per_kwh": number | null,
  "billing_period_start": "YYYY-MM-DD" | null,
  "billing_period_end": "YYYY-MM-DD" | null,
  "extraction_notes": ["short note"],
  "field_confidence": {
    "monthly_kwh": number between 0 and 1,
    "currency": number between 0 and 1,
    "total_cost": number between 0 and 1,
    "tariff_per_kwh": number between 0 and 1
  }
}
If a value is missing, use null and explain it in extraction_notes. Do not guess silently.
"""
    message = client.messages.create(
        model=model,
        max_tokens=1200,
        messages=[
            {
                "role": "user",
                "content": [
                    {"type": "text", "text": prompt},
                    _content_block_for_file(file_path),
                ],
            }
        ],
    )
    text = "".join(block.text for block in message.content if getattr(block, "type", None) == "text")
    return _extract_json_object(text)


def extract_bill(file_path: str, config: AppConfig) -> BillData:  # noqa: ARG001
    if not Path(file_path).exists():
        return fallback_bill(f"Bill file not found: {file_path}")
    if not os.getenv("ANTHROPIC_API_KEY"):
        return fallback_bill("ANTHROPIC_API_KEY not set; extraction fallback used.")

    last_error: Exception | None = None
    for _attempt in range(2):
        try:
            payload = _call_claude_for_bill(file_path)
            return BillData.model_validate(payload)
        except (json.JSONDecodeError, ValidationError, OSError, Exception) as exc:  # noqa: BLE001
            logger.warning("Bill extraction attempt failed: %s", exc)
            last_error = exc

    return fallback_bill(f"Claude extraction failed twice: {last_error}")


def extract_multiple_bills(file_paths: list[str], config: AppConfig) -> BillData:
    if not file_paths:
        return fallback_bill("No bills uploaded; fallback bill data used.")

    bills = [extract_bill(path, config) for path in file_paths]
    usable = [bill for bill in bills if bill.monthly_kwh > 0 and bill.total_cost >= 0]
    if not usable:
        return fallback_bill("No usable bill data extracted.")

    count = len(usable)
    monthly_kwh = sum(bill.monthly_kwh for bill in usable) / count
    total_cost = sum(bill.total_cost for bill in usable) / count
    tariff = sum(bill.tariff_per_kwh for bill in usable) / count
    currency = usable[0].currency
    notes: list[str] = []
    confidence: dict[str, float] = {}

    for bill in bills:
        notes.extend(bill.extraction_notes)
        for key, value in bill.field_confidence.items():
            confidence.setdefault(key, 0)
            confidence[key] += value / count

    min_kwh = min(bill.monthly_kwh for bill in usable)
    max_kwh = max(bill.monthly_kwh for bill in usable)
    if min_kwh > 0 and max_kwh > 1.4 * min_kwh:
        notes.append("Possible seasonality: max monthly kWh is more than 1.4x min monthly kWh.")

    starts = [bill.billing_period_start for bill in usable if bill.billing_period_start]
    ends = [bill.billing_period_end for bill in usable if bill.billing_period_end]
    billing_start: date | None = min(starts) if starts else None
    billing_end: date | None = max(ends) if ends else None

    return BillData(
        monthly_kwh=monthly_kwh,
        currency=currency,
        total_cost=total_cost,
        tariff_per_kwh=tariff,
        billing_period_start=billing_start,
        billing_period_end=billing_end,
        extraction_notes=notes,
        field_confidence=confidence,
    )

