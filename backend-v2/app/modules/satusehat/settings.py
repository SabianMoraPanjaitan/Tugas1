"""The names the SATUSEHAT client (client.py, ported unchanged from the old backend) reads as `config.X`,
filled from this backend's settings (.env)."""
from app.core.config import get_settings

_s = get_settings()

SATUSEHAT_BASE = _s.satusehat_base.rstrip("/")
OAUTH_URL = f"{SATUSEHAT_BASE}/oauth2/v1"
FHIR_URL = f"{SATUSEHAT_BASE}/fhir-r4/v1"

CLIENT_ID = _s.satusehat_client_id.strip()
CLIENT_SECRET = _s.satusehat_client_secret.strip()
ORG_ID = _s.satusehat_org_id.strip()

MODE = _s.satusehat_mode          # LIVE or MOCK
MOCK = MODE == "MOCK"

PRACTITIONER_ID = _s.satusehat_practitioner_id.strip()
PRACTITIONER_NAME = _s.satusehat_practitioner_name.strip()
DEFAULT_PATIENT_ID = _s.satusehat_patient_id.strip()
DEFAULT_PATIENT_NAME = _s.satusehat_patient_name.strip()
LOCATION_ID = _s.satusehat_location_id.strip()
