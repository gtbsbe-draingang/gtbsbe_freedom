import re
from decimal import Decimal
from functools import lru_cache
from pathlib import Path

from pydantic import Field, SecretStr, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# backend/ and its .env, found from this file so they are the same whatever the working directory is
# (`uv run cqa-serve` from the repo root reads the same .env as one from backend/).
BACKEND_DIR = Path(__file__).resolve().parents[1]
ENV_FILE = BACKEND_DIR / ".env"

# The checklist version the app shows by default: what /config reports as `default_checklist` and
# what the queue's `final` summarises.
DEFAULT_CHECKLIST_ID = "official-chat"
DEFAULT_CHECKLIST_VERSION = 1


class Settings(BaseSettings):
    # env_ignore_empty: `ANTHROPIC_API_KEY=` (as copied from .env.example) means "not set", and an
    # empty CORS_ORIGINS= is not a JSON parse error.
    model_config = SettingsConfigDict(env_file=ENV_FILE, extra="ignore", env_ignore_empty=True)

    anthropic_api_key: SecretStr | None = None  # env ANTHROPIC_API_KEY
    # env ANTHROPIC_BASE_URL: an Anthropic-compatible server (e.g. a local vLLM, no `/v1`).
    # Unset means the Claude API. Read here because .env values are not exported to the SDK.
    anthropic_base_url: str | None = None
    # env MODEL_TIMEOUT_SECONDS: how long one model request may take before the client gives up and
    # retries. 60 suits the Claude API; a local model on a shared GPU can need several minutes for a
    # long answer.
    model_timeout_seconds: float = Field(default=60.0, gt=0)
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
