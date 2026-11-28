"""FastAPI dependencies other modules use to protect their endpoints:

    @router.get("/something")
    def handler(user: User = Depends(require_roles("radiolog", "admin"))): ...
"""
from fastapi import Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.core.db import get_db
from app.modules.auth import service
from app.modules.auth.models import ROLE_LABELS, User

SESSION_COOKIE = "simrs_session"      # same name as the old backend, so api.js keeps working


def request_token(request: Request) -> str:
    """This tab's own token (Authorization: Bearer ...) if sent, else the browser's cookie."""
    header = request.headers.get("authorization", "")
    if header.lower().startswith("bearer "):
        return header[7:].strip()
    return request.cookies.get(SESSION_COOKIE, "")


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    user = service.user_for_token(db, request_token(request))
    if user is None:
        raise HTTPException(status_code=401, detail="Belum login atau sesi habis")
    return user


def require_roles(*roles: str):
    unknown = set(roles) - set(ROLE_LABELS)
    if unknown:
        raise ValueError(f"unknown roles: {unknown}")      # catches typos at startup, not at request time

    def dependency(user: User = Depends(current_user)) -> User:
        if user.role_code not in roles:
            raise HTTPException(status_code=403,
                                detail=f"Akses ditolak untuk peran {ROLE_LABELS.get(user.role_code, user.role_code)}")
        return user
    return dependency
