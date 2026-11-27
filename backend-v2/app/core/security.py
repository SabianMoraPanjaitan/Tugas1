"""Password hashing and session tokens (standard library only).

Passwords: PBKDF2-HMAC-SHA256, 600,000 iterations (OWASP 2023 guidance), random 16-byte salt.
Stored as one string "pbkdf2_sha256$<iterations>$<salt hex>$<hash hex>", so the iteration count
can be raised later without breaking old hashes.

Session tokens: 32 random bytes for the browser; the database only keeps their SHA-256,
so a leaked database copy cannot be used to log in.
"""
import hashlib
import hmac
import secrets

ALGORITHM = "pbkdf2_sha256"
ITERATIONS = 600_000


def hash_password(password: str, *, iterations: int = ITERATIONS, salt: str | None = None) -> str:
    salt = salt or secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt), iterations)
    return f"{ALGORITHM}${iterations}${salt}${digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    try:
        algorithm, iterations, salt, expected = stored.split("$")
        if algorithm != ALGORITHM:
            return False
        actual = hash_password(password, iterations=int(iterations), salt=salt).split("$")[3]
    except (ValueError, TypeError):
        return False
    return hmac.compare_digest(actual, expected)


_DUMMY_HASH = hash_password("timing-equaliser")


def burn_password_check(password: str) -> None:
    """Spend the same time as a real check, so a wrong username is not faster than a wrong password."""
    verify_password(password, _DUMMY_HASH)


def new_session_token() -> str:
    return secrets.token_urlsafe(32)


def token_digest(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
