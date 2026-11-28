"""Writing audit entries. Call `record(...)` from any module; it joins the request's transaction,
so the entry is saved together with the change it describes (or not at all if that change fails)."""
import ipaddress

from fastapi import Request
from sqlalchemy.orm import Session

from app.modules.audit.models import AuditLog


def client_ip(request: Request | None) -> str | None:
    host = request.client.host if request is not None and request.client else None
    try:
        return str(ipaddress.ip_address(host)) if host else None
    except ValueError:
        return None   # e.g. "testclient" in tests


def record(db: Session, action: str, *, request: Request | None = None, user=None, username: str | None = None,
           entity_type: str | None = None, entity_id=None, patient_id: int | None = None,
           detail: dict | None = None) -> None:
    db.add(AuditLog(
        action=action,
        user_id=user.id if user is not None else None,
        username=user.username if user is not None else username,
        entity_type=entity_type,
        entity_id=str(entity_id) if entity_id is not None else None,
        patient_id=patient_id,
        ip=client_ip(request),
        detail=detail or {},
    ))
