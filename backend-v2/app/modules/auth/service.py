"""Login rules: check passwords, create / end / look up sessions, manage accounts."""
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from app.core import security
from app.core.config import get_settings
from app.modules.auth.models import ROLE_LABELS, User, UserSession


class UnknownRole(ValueError):
    pass


def public_user(user: User) -> dict:
    """The user as the MyPACS pages expect it (same shape as the old backend)."""
    return {"username": user.username, "full_name": user.full_name,
            "role": user.role_code, "role_label": ROLE_LABELS.get(user.role_code, user.role_code)}


def authenticate(db: Session, username: str, password: str) -> User | None:
    user = db.scalar(select(User).where(User.username == username))
    if user is None or not user.is_active:
        security.burn_password_check(password)
        return None
    return user if security.verify_password(password, user.password_hash) else None


def create_session(db: Session, user: User) -> str:
    now = datetime.now(timezone.utc)
    db.execute(delete(UserSession).where(UserSession.expires_at < now))      # tidy expired logins
    token = security.new_session_token()
    db.add(UserSession(token_hash=security.token_digest(token), user_id=user.id,
                       expires_at=now + timedelta(hours=get_settings().session_ttl_hours)))
    return token


def end_session(db: Session, token: str) -> None:
    if token:
        db.execute(delete(UserSession).where(UserSession.token_hash == security.token_digest(token)))


def user_for_token(db: Session, token: str) -> User | None:
    if not token:
        return None
    row = db.scalar(select(UserSession).where(UserSession.token_hash == security.token_digest(token),
                                              UserSession.expires_at > datetime.now(timezone.utc)))
    if row is None or not row.user.is_active:
        return None
    return row.user


# ---- account management (used by scripts/manage_users.py) ----
def create_user(db: Session, username: str, password: str, role: str, full_name: str) -> User:
    if role not in ROLE_LABELS:
        raise UnknownRole(f"unknown role '{role}', expected one of: {', '.join(ROLE_LABELS)}")
    user = User(username=username, full_name=full_name, role_code=role,
                password_hash=security.hash_password(password))
    db.add(user)
    db.flush()
    return user


def set_password(db: Session, username: str, password: str) -> bool:
    user = db.scalar(select(User).where(User.username == username))
    if user is None:
        return False
    user.password_hash = security.hash_password(password)
    db.execute(delete(UserSession).where(UserSession.user_id == user.id))   # log out everywhere
    return True
