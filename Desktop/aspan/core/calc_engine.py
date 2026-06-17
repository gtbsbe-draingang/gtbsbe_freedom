from __future__ import annotations

import calendar
import json
import logging
from pathlib import Path
from typing import NamedTuple

import requests

from core.config_loader import AppConfig
from core.models import (
    AssumptionsUsed,
    BillData,
    CalcResult,
    ClientInfo,
    PVRecommendation,
    ScenarioResult,
)

logger = logging.getLogger(__name__)


class ProductionEstimate(NamedTuple):
    annual_kwh: float
    source: str
    warnings: list[str]


def daytime_consumption_estimate(
    monthly_kwh: float,
    industry: str,
    config: AppConfig,
    daytime_fraction_override: float | None = None,
) -> float:
    fraction = (
        daytime_fraction_override
        if daytime_fraction_override is not None
        else config.daytime_fraction_for(industry)
    )
    return monthly_kwh * fraction


def recommended_kwp(
    daytime_kwh_monthly: float,
    roof_area_m2: float | None,
    grid_kva: float | None,
    config: AppConfig,
) -> PVRecommendation:
    """Recommend PV size as the minimum available sizing constraint.

    Formulas:
    consumption_limited_kwp = daytime_kwh_monthly * 12 / default_specific_yield_kwh_per_kwp
    roof_limited_kwp = roof_area_m2 * kwp_per_m2
    grid_limited_kwp = grid_kva * grid_capacity_solar_fraction

    Missing roof or grid values are excluded from the minimum. Consumption is
    always included because BillData guarantees positive monthly kWh.
    """
    annual_daytime_kwh = max(daytime_kwh_monthly, 0) * 12
    constraints = {
        "consumption": annual_daytime_kwh / config.default_specific_yield_kwh_per_kwp
    }
    notes: list[str] = []

    if roof_area_m2 is not None and roof_area_m2 > 0:
        constraints["roof"] = roof_area_m2 * config.kwp_per_m2
    else:
        notes.append("Roof area unavailable; roof constraint excluded from sizing.")

    if grid_kva is not None and grid_kva > 0:
        constraints["grid"] = grid_kva * config.grid_capacity_solar_fraction
    else:
        notes.append("Grid connection capacity unavailable; grid constraint excluded from sizing.")

    binding_constraint, kwp = min(constraints.items(), key=lambda item: item[1])
    if kwp <= 0:
        kwp = 1.0
        binding_constraint = "minimum_viable_size"
        notes.append("Calculated system size was non-positive; minimum 1 kWp used.")

    return PVRecommendation(
        recommended_kwp=kwp,
        binding_constraint=binding_constraint,
        constraints_kwp=constraints,
        notes=notes,
    )


def _cache_key(lat: float, lon: float) -> str:
    return f"nasa_power_{lat:.3f}_{lon:.3f}.json".replace("-", "m").replace(".", "p")


def _fetch_nasa_power_annual_irradiance(lat: float, lon: float, config: AppConfig) -> float:
    cache_dir = Path(config.nasa_power_cache_dir)
    cache_dir.mkdir(parents=True, exist_ok=True)
    cache_path = cache_dir / _cache_key(lat, lon)

    if cache_path.exists():
        data = json.loads(cache_path.read_text(encoding="utf-8"))
    else:
        response = requests.get(
            "https://power.larc.nasa.gov/api/temporal/monthly/point",
            params={
                "parameters": "ALLSKY_SFC_SW_DWN",
                "community": "RE",
                "longitude": lon,
                "latitude": lat,
                "start": "2022",
                "end": "2022",
                "format": "JSON",
            },
            timeout=10,
        )
        response.raise_for_status()
        data = response.json()
        cache_path.write_text(json.dumps(data, indent=2), encoding="utf-8")

    values = data["properties"]["parameter"]["ALLSKY_SFC_SW_DWN"]
    annual_irradiance = 0.0
    for month in range(1, 13):
        key = f"2022{month:02d}"
        daily_avg = float(values[key])
        annual_irradiance += daily_avg * calendar.monthrange(2022, month)[1]
    return annual_irradiance


def annual_production_estimate(
    lat: float | None,
    lon: float | None,
    kwp: float,
    config: AppConfig,
) -> ProductionEstimate:
    warnings: list[str] = []
    if lat is None or lon is None:
        annual_kwh = kwp * config.default_specific_yield_kwh_per_kwp
        warnings.append("Latitude/longitude unavailable; default specific yield used.")
        return ProductionEstimate(annual_kwh, "fallback_default_specific_yield", warnings)

    if not config.use_nasa_power:
        annual_kwh = kwp * config.default_specific_yield_kwh_per_kwp
        return ProductionEstimate(annual_kwh, "fallback_default_specific_yield", warnings)

    try:
        annual_irradiance = _fetch_nasa_power_annual_irradiance(lat, lon, config)
        annual_kwh = kwp * annual_irradiance * config.performance_ratio
        return ProductionEstimate(annual_kwh, "nasa_power_allsky_sfc_sw_dwn", warnings)
    except Exception as exc:  # noqa: BLE001 - fallback must catch messy external failures.
        logger.warning("NASA POWER fallback used: %s", exc)
        annual_kwh = kwp * config.default_specific_yield_kwh_per_kwp
        warnings.append("NASA POWER unavailable; default specific yield used.")
        return ProductionEstimate(annual_kwh, "fallback_default_specific_yield", warnings)


def annual_production_kwh(lat: float, lon: float, kwp: float, config: AppConfig) -> float:
    return annual_production_estimate(lat, lon, kwp, config).annual_kwh


def scenario_grid_replacement(
    annual_solar_production_kwh: float,
    annual_daytime_consumption_kwh: float,
    grid_tariff_per_kwh: float,
    ppa_tariff_per_kwh: float,
    config: AppConfig,
) -> ScenarioResult:
    year_1_solar_used = min(annual_solar_production_kwh, annual_daytime_consumption_kwh)
    yearly_savings: list[float] = []

    for year in range(1, config.analysis_horizon_years + 1):
        degraded_solar_used = year_1_solar_used * ((1 - config.panel_degradation_rate) ** (year - 1))
        escalated_grid_tariff = grid_tariff_per_kwh * ((1 + config.tariff_escalation_rate) ** (year - 1))
        yearly_savings.append(degraded_solar_used * (escalated_grid_tariff - ppa_tariff_per_kwh))

    annual_year_1 = yearly_savings[0]
    return ScenarioResult(
        name="Grid Replacement",
        monthly_savings_year_1=annual_year_1 / 12,
        annual_savings_year_1=annual_year_1,
        cumulative_savings=sum(yearly_savings),
        year_1_solar_used_kwh=year_1_solar_used,
        yearly_savings=yearly_savings,
        current_cost_per_kwh_year_1=grid_tariff_per_kwh,
        ppa_tariff_per_kwh=ppa_tariff_per_kwh,
    )


def scenario_grid_diesel(
    annual_solar_production_kwh: float,
    annual_daytime_consumption_kwh: float,
    grid_tariff_per_kwh: float,
    ppa_tariff_per_kwh: float,
    diesel_price_per_liter: float,
    diesel_kwh_per_liter: float,
    config: AppConfig,
) -> ScenarioResult:
    diesel_cost_per_kwh = diesel_price_per_liter / diesel_kwh_per_liter
    year_1_solar_used = min(annual_solar_production_kwh, annual_daytime_consumption_kwh)
    yearly_savings: list[float] = []

    for year in range(1, config.analysis_horizon_years + 1):
        degraded_solar_used = year_1_solar_used * ((1 - config.panel_degradation_rate) ** (year - 1))
        escalated_grid_tariff = grid_tariff_per_kwh * ((1 + config.tariff_escalation_rate) ** (year - 1))
        escalated_diesel_cost = diesel_cost_per_kwh * ((1 + config.tariff_escalation_rate) ** (year - 1))
        blended_current_cost = 0.5 * escalated_grid_tariff + 0.5 * escalated_diesel_cost
        yearly_savings.append(degraded_solar_used * (blended_current_cost - ppa_tariff_per_kwh))

    annual_year_1 = yearly_savings[0]
    blended_year_1 = 0.5 * grid_tariff_per_kwh + 0.5 * diesel_cost_per_kwh
    return ScenarioResult(
        name="Grid + Diesel",
        monthly_savings_year_1=annual_year_1 / 12,
        annual_savings_year_1=annual_year_1,
        cumulative_savings=sum(yearly_savings),
        year_1_solar_used_kwh=year_1_solar_used,
        yearly_savings=yearly_savings,
        current_cost_per_kwh_year_1=blended_year_1,
        ppa_tariff_per_kwh=ppa_tariff_per_kwh,
    )


def calculate_ppa_tariff(
    grid_tariff_per_kwh: float,
    config: AppConfig,
    override: float | None = None,
) -> float:
    if override is not None:
        return override
    if config.ppa_tariff_per_kwh_default is not None:
        return config.ppa_tariff_per_kwh_default
    return grid_tariff_per_kwh * (1 - config.ppa_discount_to_grid_tariff)


def calculate_proposal(
    bill: BillData,
    client: ClientInfo,
    config: AppConfig,
) -> CalcResult:
    warnings: list[str] = []
    confidence_notes: list[str] = []

    daytime_fraction = (
        client.daytime_fraction_override
        if client.daytime_fraction_override is not None
        else config.daytime_fraction_for(client.industry)
    )
    daytime_monthly = daytime_consumption_estimate(
        bill.monthly_kwh,
        client.industry,
        config,
        client.daytime_fraction_override,
    )
    annual_daytime = daytime_monthly * 12

    roof_area = client.available_roof_area_m2
    if roof_area is None or roof_area <= 0:
        roof_area = config.conservative_roof_area_m2_default
        confidence_notes.append(
            f"Roof area missing; conservative fallback of {roof_area:.0f} m2 used."
        )
        warnings.append("Roof area was not provided; fallback roof area used.")

    lat = client.latitude
    lon = client.longitude
    if lat is None or lon is None:
        default_lat, default_lon = config.default_coordinates_for(client.country)
        lat = lat if lat is not None else default_lat
        lon = lon if lon is not None else default_lon
        confidence_notes.append("Location coordinates missing; country default coordinates used.")
        warnings.append("Latitude/longitude were not provided; country defaults used.")

    pv = recommended_kwp(daytime_monthly, roof_area, client.grid_connection_kva, config)
    warnings.extend(pv.notes)

    production = annual_production_estimate(lat, lon, pv.recommended_kwp, config)
    warnings.extend(production.warnings)

    ppa_tariff = calculate_ppa_tariff(
        bill.tariff_per_kwh,
        config,
        client.ppa_tariff_per_kwh_override,
    )
    diesel_price = client.diesel_price_per_liter_override or config.diesel_price_per_liter

    grid_result = scenario_grid_replacement(
        production.annual_kwh,
        annual_daytime,
        bill.tariff_per_kwh,
        ppa_tariff,
        config,
    )
    diesel_result = scenario_grid_diesel(
        production.annual_kwh,
        annual_daytime,
        bill.tariff_per_kwh,
        ppa_tariff,
        diesel_price,
        config.diesel_kwh_per_liter,
        config,
    )

    assumptions = AssumptionsUsed(
        monthly_kwh=bill.monthly_kwh,
        daytime_fraction=daytime_fraction,
        roof_area_m2=roof_area,
        grid_capacity_kva=client.grid_connection_kva,
        latitude=lat,
        longitude=lon,
        recommended_kwp=pv.recommended_kwp,
        ppa_tariff_per_kwh=ppa_tariff,
        grid_tariff_per_kwh=bill.tariff_per_kwh,
        diesel_price_per_liter=diesel_price,
        diesel_kwh_per_liter=config.diesel_kwh_per_liter,
        performance_ratio=config.performance_ratio,
        panel_degradation_rate=config.panel_degradation_rate,
        tariff_escalation_rate=config.tariff_escalation_rate,
        analysis_horizon_years=config.analysis_horizon_years,
        production_source=production.source,
        confidence_notes=confidence_notes,
        extraction_notes=bill.extraction_notes,
    )

    return CalcResult(
        daytime_kwh_monthly=daytime_monthly,
        annual_daytime_consumption_kwh=annual_daytime,
        pv_recommendation=pv,
        annual_solar_production_kwh=production.annual_kwh,
        ppa_tariff_per_kwh=ppa_tariff,
        scenario_grid_replacement=grid_result,
        scenario_grid_diesel=diesel_result,
        assumptions=assumptions,
        warnings=warnings,
    )

