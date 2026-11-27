"""Settings, read from environment variables or backend-v2/.env.

pydantic-settings turns each field into an env var of the same name (case-insensitive),
e.g. DATABASE_URL -> settings.database_url, and checks the type.
"""
from functools import lru_cache
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[2]          # .../backend-v2
REPO_DIR = BACKEND_DIR.parent                               # .../Tugas1

_PLACEHOLDERS = {"", "paste_your_client_id_here", "paste_your_client_secret_here"}


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=BACKEND_DIR / ".env", env_file_encoding="utf-8", extra="ignore")

    database_url: str = "postgresql+psycopg://pacs:change_me@localhost:5432/pacs"
    storage_dir: Path = Path("storage")
    max_upload_mb: int = 2048            # per file; a single uncompressed CT slice is about 0.5 MB
    session_ttl_hours: int = 12
    cors_origins: str = ""
    cookie_secure: bool = False
    frontend_dir: Path = REPO_DIR / "Frontend"

    satusehat_org_id: str = ""
    satusehat_client_id: str = ""
    satusehat_client_secret: str = ""
    satusehat_base: str = "https://api-satusehat-stg.dto.kemkes.go.id"
    satusehat_mock: bool = False
    # Sandbox actors for the radiology chain (defaults = SATUSEHAT's published sandbox dummies).
    satusehat_practitioner_id: str = "10009880728"
    satusehat_practitioner_name: str = "dr. Alexander"
    satusehat_patient_id: str = "P02478375538"
    satusehat_patient_name: str = "Ardianto Putra"
    satusehat_location_id: str = ""      # empty = use the org's first Location, or create "Instalasi Radiologi"

    @property
    def storage_path(self) -> Path:
        """Absolute storage folder (relative values are taken from backend-v2/)."""
        return self.storage_dir if self.storage_dir.is_absolute() else BACKEND_DIR / self.storage_dir

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]

    @property
    def satusehat_mode(self) -> str:
        has_creds = (self.satusehat_client_id.strip() not in _PLACEHOLDERS
                     and self.satusehat_client_secret.strip() not in _PLACEHOLDERS)
        return "LIVE" if has_creds and not self.satusehat_mock else "MOCK"


@lru_cache
def get_settings() -> Settings:
    return Settings()
