from __future__ import annotations

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from core.config_loader import load_config
from core.models import BillData, ClientInfo
from core.pipeline import generate_proposal_artifacts


def main() -> None:
    config = load_config().model_copy(update={"use_nasa_power": False})
    bill = BillData(
        monthly_kwh=72000,
        currency="USD",
        total_cost=18000,
        tariff_per_kwh=0.25,
        billing_period_start=None,
        billing_period_end=None,
        extraction_notes=["Sample run uses confirmed dummy bill data."],
        field_confidence={
            "monthly_kwh": 1.0,
            "currency": 1.0,
            "total_cost": 1.0,
            "tariff_per_kwh": 1.0,
        },
    )
    client = ClientInfo(
        client_name="Neskao Sample",
        industry="food_processing",
        country="Ghana",
        city="Accra",
        business_description="Food processing customer evaluating daytime solar PPA savings.",
        has_diesel_generators=True,
        grid_connection_kva=600,
        available_roof_area_m2=4200,
        daytime_fraction_override=0.75,
        ppa_tariff_per_kwh_override=None,
        diesel_price_per_liter_override=1.20,
    )
    response = generate_proposal_artifacts(bill, client, config)
    print(response.output_pptx_path)
    for warning in response.warnings:
        print(f"WARNING: {warning}")


if __name__ == "__main__":
    main()
