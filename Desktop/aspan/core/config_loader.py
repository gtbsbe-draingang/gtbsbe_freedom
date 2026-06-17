from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml
from pydantic import BaseModel, Field, field_validator


class AppConfig(BaseModel):
    analysis_horizon_years: int = Field(gt=0)
    kwp_per_m2: float = Field(gt=0)
    grid_capacity_solar_fraction: float = Field(gt=0)
    daytime_fraction_default: float = Field(gt=0, le=1)
    default_specific_yield_kwh_per_kwp: float = Field(gt=0)
    conservative_roof_area_m2_default: float = Field(gt=0)
    daytime_fraction_by_industry: dict[str, float]
    performance_ratio: float = Field(gt=0, le=1)
    panel_degradation_rate: float = Field(ge=0, lt=1)
    use_nasa_power: bool = True
    tariff_escalation_rate: float = Field(ge=0)
    ppa_discount_to_grid_tariff: float = Field(ge=0, lt=1)
    ppa_tariff_per_kwh_default: float | None = Field(default=None, ge=0)
    diesel_price_per_liter: float = Field(gt=0)
    diesel_kwh_per_liter: float = Field(gt=0)
    system_cost_per_kwp: float = Field(gt=0)
    default_latitude_by_country: dict[str, float]
    default_longitude_by_country: dict[str, float]
    nasa_power_cache_dir: str
    output_dir: str
    proposal_log_path: str

    @field_validator("daytime_fraction_by_industry")
    @classmethod
    def validate_daytime_fractions(cls, value: dict[str, float]) -> dict[str, float]:
        for key, fraction in value.items():
            if fraction <= 0 or fraction > 1:
                raise ValueError(f"daytime fraction for {key} must be in (0, 1]")
        return value

    def daytime_fraction_for(self, industry: str) -> float:
        key = industry.strip().lower().replace(" ", "_")
        return self.daytime_fraction_by_industry.get(
            key,
            self.daytime_fraction_by_industry.get("default", self.daytime_fraction_default),
        )

    def default_coordinates_for(self, country: str) -> tuple[float | None, float | None]:
        return (
            self.default_latitude_by_country.get(country),
            self.default_longitude_by_country.get(country),
        )


def load_config(path: str | Path = "config.yaml") -> AppConfig:
    config_path = Path(path)
    with config_path.open("r", encoding="utf-8") as handle:
        data: dict[str, Any] = yaml.safe_load(handle) or {}
    return AppConfig.model_validate(data)

