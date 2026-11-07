import re
from decimal import Decimal
from functools import lru_cache
from pathlib import Path

from pydantic import SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# The checklist version the app shows by default: what /config reports as `default_checklist` and
# what the queue's `final` summarises.
DEFAULT_CHECKLIST_ID = "official-chat"
DEFAULT_CHECKLIST_VERSION = 1


class Settings(BaseSettings):
    # env_ignore_empty: `ANTHROPIC_API_KEY=` (as copied from .env.example) means "not set", and an
    # empty CORS_ORIGINS= is not a JSON parse error.
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", env_ignore_empty=True)

    anthropic_api_key: SecretStr | None = None  # env ANTHROPIC_API_KEY
    organizer_api_url: SecretStr | None = None  # env ORGANIZER_API_URL; group_id is replaced, nothing else
    base_path: str = "/api"
    cors_origins: list[str] = []
    frame_ancestors: list[str] = ["'self'"]
    db_path: Path = Path("cqa.db")
    default_model: str = "claude-haiku-5-5"
    prices: dict[str, dict[str, Decimal]] = {  # USD per 1M tokens; first-party API rates
        "claude-haiku-5-5": {"input": Decimal("0.10"), "output": Decimal("0.50")},
        "claude-sonnet-5-5": {"input": Decimal("2.00"), "output": Decimal("10.00")},
    }
    max_parallel_calls: int = 8
    web_dist: Path | None = None  # override for the static UI directory (tests)

    @field_validator("base_path")
    @classmethod
    def _normalise_base_path(cls, value: str) -> str:
        # "/api", "api" and "/api/" all mean "/api"; "/" means no prefix.
        trimmed = value.strip().strip("/")
        return f"/{trimmed}" if trimmed else ""

    @field_validator("frame_ancestors")
    @classmethod
    def _frame_ancestors_are_plain_sources(cls, value: list[str]) -> list[str]:
        # These go into a Content-Security-Policy header: a source with whitespace, ';' or ','
        # would smuggle in another directive.
        for source in value:
            if not source or re.search(r"[\s;,]", source):
                raise ValueError(f"invalid frame-ancestors source: {source!r}")
        return value

    @property
    def model_key_configured(self) -> bool:
        """True when a non-blank Anthropic key is set. Never exposes the key itself."""
        key = self.anthropic_api_key
        return key is not None and bool(key.get_secret_value().strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()
