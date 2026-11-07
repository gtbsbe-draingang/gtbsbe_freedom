"""S3 (#17): cost formula (the c_llm_calls log is S7, test_cost_log.py)."""

from decimal import Decimal

import pytest

from evaluator.cost import call_cost

M = 1_000_000


def cost(model="claude-haiku-5-5", i=0, w=0, r=0, o=0):
    return call_cost(
        model,
        input_tokens=i,
        cache_write_tokens=w,
        cache_read_tokens=r,
        output_tokens=o,
    )


def test_each_component_per_million() -> None:
    assert cost(i=M) == Decimal("0.100000")
    assert cost(w=M) == Decimal("0.125000")  # input x 1.25
    assert cost(r=M) == Decimal("0.010000")  # input x 0.10
    assert cost(o=M) == Decimal("0.500000")


def test_sum_and_other_model() -> None:
    assert cost(i=2000, w=10000, r=50000, o=600) == Decimal("0.002250")
    assert cost("claude-sonnet-5-5", i=M, o=M) == Decimal("12.000000")


def test_quantized_to_six_decimals_half_up() -> None:
    assert cost(i=5) == Decimal("0.000001")  # 5e-7 rounds up
    assert cost(i=4) == Decimal("0.000000")
    assert str(cost()) == "0.000000"
    assert isinstance(cost(i=1), Decimal)


def test_unknown_model_is_key_error() -> None:
    with pytest.raises(KeyError):
        cost("claude-nope", i=1)
