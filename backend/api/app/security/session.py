from __future__ import annotations

from datetime import datetime, timedelta, timezone
import jwt
from app.config import settings


def create_pkce_state_cookie_value(state: str, code_verifier: str, max_age: int = 600) -> str:
    """
    Creates a signed, tamper-resistant JWT containing OAuth state and PKCE code_verifier.
    TTL defaults to 10 minutes (600 seconds).
    """
    now = datetime.now(timezone.utc)
    payload = {
        "sub": "oauth_pkce",
        "state": state,
        "verifier": code_verifier,
        "iat": now,
        "exp": now + timedelta(seconds=max_age),
    }
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")


def verify_pkce_state_cookie_value(cookie_value: str | None) -> dict[str, str]:
    """
    Verifies and decodes the signed temporary PKCE cookie.
    Returns a dict with 'state' and 'verifier'.
    Raises ValueError if missing, invalid, tampered, or expired.
    """
    if not cookie_value:
        raise ValueError("Missing PKCE state cookie.")

    try:
        payload = jwt.decode(
            cookie_value,
            settings.secret_key,
            algorithms=["HS256"],
            options={"require": ["exp", "sub", "state", "verifier"]},
        )
        if payload.get("sub") != "oauth_pkce":
            raise ValueError("Invalid PKCE cookie subject.")
        return {
            "state": str(payload["state"]),
            "verifier": str(payload["verifier"]),
        }
    except jwt.ExpiredSignatureError as exc:
        raise ValueError("PKCE state cookie has expired. Please try connecting again.") from exc
    except jwt.PyJWTError as exc:
        raise ValueError("Invalid or tampered PKCE state cookie.") from exc


def create_session_cookie_value(user_id: str, max_age: int | None = None) -> str:
    """
    Creates a signed, tamper-resistant session token containing the user's UUID.
    Does NOT include any GitHub access tokens or secrets.
    """
    if max_age is None:
        max_age = settings.session_max_age_seconds

    now = datetime.now(timezone.utc)
    payload = {
        "sub": str(user_id),
        "type": "session",
        "iat": now,
        "exp": now + timedelta(seconds=max_age),
    }
    return jwt.encode(payload, settings.secret_key, algorithm="HS256")


def verify_session_cookie_value(cookie_value: str | None) -> str:
    """
    Verifies and decodes the CodeWorld session cookie.
    Returns the authenticated user UUID string.
    Raises ValueError if missing, invalid, tampered, or expired.
    """
    if not cookie_value:
        raise ValueError("Missing session cookie.")

    try:
        payload = jwt.decode(
            cookie_value,
            settings.secret_key,
            algorithms=["HS256"],
            options={"require": ["exp", "sub", "type"]},
        )
        if payload.get("type") != "session":
            raise ValueError("Invalid session token type.")
        user_id = payload.get("sub")
        if not user_id:
            raise ValueError("Session token missing user identity.")
        return str(user_id)
    except jwt.ExpiredSignatureError as exc:
        raise ValueError("Session expired. Please log in again.") from exc
    except jwt.PyJWTError as exc:
        raise ValueError("Invalid session cookie.") from exc
