from __future__ import annotations

import logging
from datetime import datetime, timedelta, timezone
from urllib.parse import urlencode

from fastapi import HTTPException, status
import httpx
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.security.encryption import decrypt_token, encrypt_token
from codeworld_db import User

logger = logging.getLogger(__name__)

GITHUB_OAUTH_AUTHORIZE_URL = "https://github.com/login/oauth/authorize"
GITHUB_OAUTH_ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token"
GITHUB_USER_API_URL = "https://api.github.com/user"
DEFAULT_USER_AGENT = "CodeWorld-App"


class AuthenticationRequiredException(HTTPException):
    """Raised when user credentials/refresh tokens are expired, revoked, or invalid."""

    def __init__(self, detail: str = "Authentication required. Please reconnect with GitHub."):
        super().__init__(status_code=status.HTTP_401_UNAUTHORIZED, detail=detail)


def build_github_authorize_url(state: str, code_challenge: str) -> str:
    """
    Constructs the GitHub App OAuth authorization URL with PKCE (RFC 7636).
    Never includes client_secret, plain tokens, or the code_verifier.
    """
    if not settings.github_app_client_id:
        raise ValueError("GITHUB_APP_CLIENT_ID is not configured.")

    params = {
        "client_id": settings.github_app_client_id,
        "redirect_uri": settings.github_app_redirect_uri,
        "state": state,
        "code_challenge": code_challenge,
        "code_challenge_method": "S256",
    }
    return f"{GITHUB_OAUTH_AUTHORIZE_URL}?{urlencode(params)}"


async def exchange_code_for_user_token(
    code: str,
    code_verifier: str,
    redirect_uri: str | None = None,
    client: httpx.AsyncClient | None = None,
) -> dict:
    """
    Exchanges an authorization code and PKCE code_verifier for a GitHub user access token.
    Explicitly requests JSON from GitHub.
    """
    if not settings.github_app_client_id or not settings.github_app_client_secret:
        raise ValueError("GitHub App client ID and secret must be configured.")

    payload = {
        "client_id": settings.github_app_client_id,
        "client_secret": settings.github_app_client_secret,
        "code": code,
        "code_verifier": code_verifier,
        "redirect_uri": redirect_uri or settings.github_app_redirect_uri,
    }
    headers = {
        "Accept": "application/json",
        "User-Agent": DEFAULT_USER_AGENT,
    }

    async def _post(http_client: httpx.AsyncClient) -> dict:
        resp = await http_client.post(
            GITHUB_OAUTH_ACCESS_TOKEN_URL,
            data=payload,
            headers=headers,
            timeout=10.0,
        )
        if resp.status_code != 200:
            raise ValueError(f"GitHub token exchange returned status {resp.status_code}: {resp.text}")
        data = resp.json()
        if "error" in data:
            err_desc = data.get("error_description", data["error"])
            raise ValueError(f"GitHub OAuth error: {err_desc}")
        if "access_token" not in data:
            raise ValueError("GitHub response missing access_token.")
        return data

    if client is not None:
        return await _post(client)

    async with httpx.AsyncClient() as new_client:
        return await _post(new_client)


async def fetch_github_user_profile(
    access_token: str,
    client: httpx.AsyncClient | None = None,
) -> dict:
    """
    Fetches the authenticated GitHub user profile.
    Extracts the numeric ID (stable user identity) and login.
    """
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": DEFAULT_USER_AGENT,
        "X-GitHub-Api-Version": settings.github_api_version,
    }

    async def _get(http_client: httpx.AsyncClient) -> dict:
        resp = await http_client.get(
            GITHUB_USER_API_URL,
            headers=headers,
            timeout=10.0,
        )
        if resp.status_code != 200:
            raise ValueError(f"Failed to fetch GitHub profile (status {resp.status_code}): {resp.text}")
        data = resp.json()
        if "id" not in data or "login" not in data:
            raise ValueError("GitHub user profile missing required fields (id, login).")
        return data

    if client is not None:
        return await _get(client)

    async with httpx.AsyncClient() as new_client:
        return await _get(new_client)


async def refresh_github_user_token(
    refresh_token: str,
    client: httpx.AsyncClient | None = None,
) -> dict:
    """
    Refreshes an expired user access token using the user's refresh token.
    GitHub rotates refresh tokens upon successful refresh.
    """
    if not settings.github_app_client_id or not settings.github_app_client_secret:
        raise ValueError("GitHub App client ID and secret must be configured.")

    payload = {
        "client_id": settings.github_app_client_id,
        "client_secret": settings.github_app_client_secret,
        "grant_type": "refresh_token",
        "refresh_token": refresh_token,
    }
    headers = {
        "Accept": "application/json",
        "User-Agent": DEFAULT_USER_AGENT,
    }

    async def _post(http_client: httpx.AsyncClient) -> dict:
        resp = await http_client.post(
            GITHUB_OAUTH_ACCESS_TOKEN_URL,
            data=payload,
            headers=headers,
            timeout=10.0,
        )
        if resp.status_code != 200:
            raise AuthenticationRequiredException(
                f"GitHub token refresh HTTP {resp.status_code}: {resp.text}"
            )
        data = resp.json()
        if "error" in data:
            err_desc = data.get("error_description", data["error"])
            raise AuthenticationRequiredException(f"Token refresh rejected by GitHub: {err_desc}")
        if "access_token" not in data:
            raise AuthenticationRequiredException("GitHub refresh response missing access_token.")
        return data

    if client is not None:
        return await _post(client)

    async with httpx.AsyncClient() as new_client:
        return await _post(new_client)


async def get_valid_user_access_token(
    user: User,
    db: AsyncSession,
    http_client: httpx.AsyncClient | None = None,
) -> str:
    """
    Retrieves a valid, decrypted plaintext GitHub user access token for the given User.

    1. If user_token_expires_at is in the future (> 60s safety buffer),
       returns decrypted access token directly.
    2. If expired and a valid refresh token exists:
       - Decrypts refresh token.
       - Requests new access token + rotated refresh token from GitHub.
       - Encrypts both new tokens and updates DB in a single transaction.
       - Returns the new plaintext access token.
    3. If refresh token is expired or revoked by GitHub:
       - Raises AuthenticationRequiredException (re-authentication required).
    """
    now = datetime.now(timezone.utc)

    # Check if access token is still valid (with 60-second buffer)
    if user.user_token_expires_at is None or user.user_token_expires_at > now + timedelta(seconds=60):
        try:
            return decrypt_token(user.encrypted_user_access_token)
        except Exception as exc:
            logger.error("Failed to decrypt stored access token for user %s: %s", user.id, exc)
            raise AuthenticationRequiredException("Failed to decrypt access token. Re-authentication required.") from exc

    # Access token is expired: attempt refresh
    logger.info("Access token expired for user %s (%s). Attempting refresh.", user.id, user.github_login)
    if not user.encrypted_refresh_token:
        raise AuthenticationRequiredException("Access token expired and no refresh token is stored.")

    if user.refresh_token_expires_at is not None and user.refresh_token_expires_at <= now:
        raise AuthenticationRequiredException("Refresh token has expired. Re-authentication required.")

    try:
        plain_refresh_token = decrypt_token(user.encrypted_refresh_token)
    except Exception as exc:
        logger.error("Failed to decrypt stored refresh token for user %s: %s", user.id, exc)
        raise AuthenticationRequiredException("Corrupted refresh token. Re-authentication required.") from exc

    # Perform GitHub refresh request
    refresh_data = await refresh_github_user_token(plain_refresh_token, client=http_client)

    new_access_token = refresh_data["access_token"]
    new_refresh_token = refresh_data.get("refresh_token")
    expires_in = refresh_data.get("expires_in")
    refresh_expires_in = refresh_data.get("refresh_token_expires_in")

    # Encrypt new credentials
    user.encrypted_user_access_token = encrypt_token(new_access_token)
    if new_refresh_token:
        # Crucial: GitHub rotates refresh token on each refresh. Never keep old refresh token.
        user.encrypted_refresh_token = encrypt_token(new_refresh_token)

    if expires_in:
        user.user_token_expires_at = now + timedelta(seconds=int(expires_in))
    if refresh_expires_in:
        user.refresh_token_expires_at = now + timedelta(seconds=int(refresh_expires_in))

    user.updated_at = now

    # Persist atomically in single transaction
    await db.commit()
    await db.refresh(user)

    logger.info("Successfully refreshed and rotated tokens for user %s (%s).", user.id, user.github_login)
    return new_access_token
