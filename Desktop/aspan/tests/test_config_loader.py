from __future__ import annotations

from core.config_loader import load_config


def test_load_config() -> None:
    config = load_config("config.yaml")
    assert config.analysis_horizon_years == 15
    assert config.daytime_fraction_for("food_processing") == 0.75
    assert config.default_coordinates_for("Ghana") == (5.6037, -0.187)
