from __future__ import annotations

import pytest

from core.calc_engine import (
    calculate_ppa_tariff,
    calculate_proposal,
    daytime_consumption_estimate,
    recommended_kwp,
    scenario_grid_diesel,
    scenario_grid_replacement,
)
from core.config_loader import AppConfig
from core.models import BillData, ClientInfo


@pytest.fixture
def config() -> AppConfig:
    return AppConfig(
        analysis_horizon_years=15,
        kwp_per_m2=0.15,
        grid_capacity_solar_fraction=0.70,
        daytime_fraction_default=0.70,
        default_specific_yield_kwh_per_kwp=1500,
        conservative_roof_area_m2_default=1000,
        daytime_fraction_by_industry={"manufacturing": 0.75, "default": 0.70},
        performance_ratio=0.80,
        panel_degradation_rate=0.005,
        use_nasa_power=False,
        tariff_escalation_rate=0.03,
        ppa_discount_to_grid_tariff=0.15,
        ppa_tariff_per_kwh_default=None,
        diesel_price_per_liter=1.20,
        diesel_kwh_per_liter=3.5,
        system_cost_per_kwp=850,
        default_latitude_by_country={"Ghana": 5.6037},
        default_longitude_by_country={"Ghana": -0.1870},
        nasa_power_cache_dir="cache/test_nasa",
        output_dir="outputs",
        proposal_log_path="logs/proposal_runs.jsonl",
    )


def test_daytime_consumption_estimate(config: AppConfig) -> None:
    assert daytime_consumption_estimate(10000, "manufacturing", config) == 7500
    assert daytime_consumption_estimate(10000, "unknown", config) == 7000
    assert daytime_consumption_estimate(10000, "manufacturing", config, 0.8) == 8000


def test_recommended_kwp_consumption_constraint(config: AppConfig) -> None:
    result = recommended_kwp(10000, roof_area_m2=5000, grid_kva=1000, config=config)
    assert result.binding_constraint == "consumption"
    assert result.recommended_kwp == pytest.approx(80)


def test_recommended_kwp_roof_constraint(config: AppConfig) -> None:
    result = recommended_kwp(20000, roof_area_m2=300, grid_kva=1000, config=config)
    assert result.binding_constraint == "roof"
    assert result.recommended_kwp == pytest.approx(45)


def test_recommended_kwp_grid_constraint(config: AppConfig) -> None:
    result = recommended_kwp(20000, roof_area_m2=5000, grid_kva=50, config=config)
    assert result.binding_constraint == "grid"
    assert result.recommended_kwp == pytest.approx(35)


def test_grid_replacement_savings_year_1(config: AppConfig) -> None:
    result = scenario_grid_replacement(
        annual_solar_production_kwh=100000,
        annual_daytime_consumption_kwh=80000,
        grid_tariff_per_kwh=0.20,
        ppa_tariff_per_kwh=0.15,
        config=config,
    )
    assert result.annual_savings_year_1 == pytest.approx(4000)
    assert result.monthly_savings_year_1 == pytest.approx(333.333333)


def test_grid_diesel_savings_year_1(config: AppConfig) -> None:
    result = scenario_grid_diesel(
        annual_solar_production_kwh=100000,
        annual_daytime_consumption_kwh=80000,
        grid_tariff_per_kwh=0.20,
        ppa_tariff_per_kwh=0.15,
        diesel_price_per_liter=1.20,
        diesel_kwh_per_liter=3.5,
        config=config,
    )
    blended = 0.5 * 0.20 + 0.5 * (1.20 / 3.5)
    assert result.annual_savings_year_1 == pytest.approx(80000 * (blended - 0.15))


def test_15_year_cumulative_savings_with_escalation_and_degradation(config: AppConfig) -> None:
    result = scenario_grid_replacement(
        annual_solar_production_kwh=100000,
        annual_daytime_consumption_kwh=100000,
        grid_tariff_per_kwh=0.20,
        ppa_tariff_per_kwh=0.15,
        config=config,
    )
    expected = 0.0
    for year in range(1, 16):
        degraded = 100000 * ((1 - 0.005) ** (year - 1))
        tariff = 0.20 * ((1 + 0.03) ** (year - 1))
        expected += degraded * (tariff - 0.15)
    assert result.cumulative_savings == pytest.approx(expected)


def test_ppa_tariff_default_calculation(config: AppConfig) -> None:
    assert calculate_ppa_tariff(0.20, config) == pytest.approx(0.17)
    assert calculate_ppa_tariff(0.20, config, override=0.16) == pytest.approx(0.16)


def test_missing_roof_grid_constraints_do_not_crash(config: AppConfig) -> None:
    result = recommended_kwp(10000, roof_area_m2=None, grid_kva=None, config=config)
    assert result.binding_constraint == "consumption"
    assert result.recommended_kwp == pytest.approx(80)
    assert result.notes


def test_calculate_proposal_uses_default_ppa_and_location(config: AppConfig) -> None:
    bill = BillData(
        monthly_kwh=10000,
        currency="USD",
        total_cost=2000,
        tariff_per_kwh=0.20,
        billing_period_start=None,
        billing_period_end=None,
        field_confidence={"monthly_kwh": 0.9},
    )
    client = ClientInfo(
        client_name="Sample Client",
        industry="manufacturing",
        country="Ghana",
        has_diesel_generators=True,
    )
    result = calculate_proposal(bill, client, config)
    assert result.ppa_tariff_per_kwh == pytest.approx(0.17)
    assert result.assumptions.latitude == pytest.approx(5.6037)
    assert result.assumptions.roof_area_m2 == pytest.approx(1000)

