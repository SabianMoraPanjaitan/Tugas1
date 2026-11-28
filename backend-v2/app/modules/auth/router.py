"""/api/auth/*: the same URLs and answers as the old backend, so MyPACS's api.js works unchanged."""
from fastapi import APIRouter, Depends, HTTPException, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.config import get_settings
from app.core.db import get_db
from app.modules.audit.service import record
from app.modules.auth import service
from app.modules.auth.deps import SESSION_COOKIE, current_user, request_token
from app.modules.auth.models import User

router = APIRouter(prefix="/api/auth", tags=["auth"])


class LoginBody(BaseModel):
    username: str = Field(min_length=1, max_length=64)
    password: str = Field(min_length=1, max_length=256)


def _set_cookie(response: Response, token: str) -> None:
    s = get_settings()
    response.set_cookie(SESSION_COOKIE, token, max_age=s.session_ttl_hours * 3600,
                        httponly=True, samesite="lax", secure=s.cookie_secure)


@router.post("/login")
def login(body: LoginBody, request: Request, response: Response, db: Session = Depends(get_db)):
    username = body.username.strip()
    user = service.authenticate(db, username, body.password)
    if user is None:
        record(db, "login_failed", request=request, username=username)
        db.commit()        # keep the failed-login entry even though we answer with an error
        raise HTTPException(status_code=401, detail="Username atau password salah")
    token = service.create_session(db, user)
    record(db, "login", request=request, user=user)
    db.commit()
    _set_cookie(response, token)       # cookie = this browser's default login
    return {**service.public_user(user), "token": token}   # token = this tab's own login


@router.post("/tab-session")
def tab_session(request: Request, db: Session = Depends(get_db)):
    """A separate login for one browser tab, as the account this browser's cookie is logged in with."""
    user = service.user_for_token(db, request.cookies.get(SESSION_COOKIE, ""))
    if user is None:
        raise HTTPException(status_code=401, detail="Belum login di browser ini")
    token = service.create_session(db, user)
    db.commit()
    return {**service.public_user(user), "token": token}


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)):
    """Ends only this tab's login; other tabs keep theirs."""
    token = request_token(request)
    user = service.user_for_token(db, token)
    service.end_session(db, token)
    if user is not None:
        record(db, "logout", request=request, user=user)
    db.commit()
    if request.cookies.get(SESSION_COOKIE, "") == token:
        response.delete_cookie(SESSION_COOKIE)
    return {"ok": True}


@router.get("/me")
def me(user: User = Depends(current_user)):
    return service.public_user(user)
