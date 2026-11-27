from app.core import security


def test_hash_and_verify():
    stored = security.hash_password("correct horse", iterations=1000)
    assert stored.startswith("pbkdf2_sha256$1000$")
    assert security.verify_password("correct horse", stored)
    assert not security.verify_password("wrong horse", stored)


def test_same_password_gets_different_salts():
    assert security.hash_password("pw", iterations=1000) != security.hash_password("pw", iterations=1000)


def test_malformed_or_foreign_hash_is_rejected_not_crashing():
    assert not security.verify_password("x", "")
    assert not security.verify_password("x", "not-a-hash")
    assert not security.verify_password("x", "bcrypt$12$abc$def")


def test_token_digest_is_stable_and_not_the_token():
    token = security.new_session_token()
    assert security.token_digest(token) == security.token_digest(token)
    assert len(security.token_digest(token)) == 64
    assert security.token_digest(token) != token
