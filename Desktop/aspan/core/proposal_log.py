from __future__ import annotations

import json
from datetime import datetime, timezone
from pathlib import Path

from core.config_loader import AppConfig
from core.models import BillData, CalcResult, ClientInfo


def append_proposal_log(
    client: ClientInfo,
    bill: BillData,
    calc: CalcResult,
    output_pptx_path: str,
    facts_pack_files_used: list[str],
    style_reference_used: str | None,
    config: AppConfig,
) -> None:
    path = Path(config.proposal_log_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    confidence_summary = {
        key: value for key, value in sorted(bill.field_confidence.items())
    }
    row = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "client_name": client.client_name,
        "industry": client.industry,
        "country": client.country,
        "recommended_kwp": calc.pv_recommendation.recommended_kwp,
        "annual_production_kwh": calc.annual_solar_production_kwh,
        "scenario_grid_replacement_annual_savings": calc.scenario_grid_replacement.annual_savings_year_1,
        "scenario_grid_replacement_15_year_savings": calc.scenario_grid_replacement.cumulative_savings,
        "scenario_grid_diesel_annual_savings": calc.scenario_grid_diesel.annual_savings_year_1,
        "scenario_grid_diesel_15_year_savings": calc.scenario_grid_diesel.cumulative_savings,
        "output_pptx_path": output_pptx_path,
        "assumptions_summary": calc.assumptions.model_dump(mode="json"),
        "facts_pack_files_used": facts_pack_files_used,
        "style_reference_used": style_reference_used,
        "extraction_confidence_summary": confidence_summary,
    }
    with path.open("a", encoding="utf-8") as handle:
        handle.write(json.dumps(row) + "\n")

