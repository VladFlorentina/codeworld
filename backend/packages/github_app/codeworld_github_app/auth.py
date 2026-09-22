from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import logging
import os
from pathlib import Path
import time
from typing import Any

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
import httpx
import jwt

logger = logging.getLogger(__name__)

DEFAULT_API_VERSION = "2022-11-28"
DEFAULT_USER_AGENT = "CodeWorld-App"


class GitHubAppAuthError(Exception):
    """Base exception for GitHub App authentication and authorization errors."""
    pass


class GitHubAppConfigurationError(GitHubAppAuthError):
    """Raised when GitHub App configuration (client_id, private_key_path) is missing or invalid."""
    pass


class GitHubInstallationTokenError(GitHubAppAuthError):
    """Raised when GitHub API rejects or fails the installation access token exchange."""

    def __init__(self, message: str, status_code: int | None = None):
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class InstallationAccessToken:
    """
    Runtime-only in-memory DTO for GitHub App installation access token.
    Never persisted to DB, Redis, or logs.
    """
    token: str
    expires_at: datetime
    permissions: dict[str, str]
    repository_selection: str | None = None

    def __repr__(self) -> str:
        # Defensive mask: ensure string formatting / logging never prints the actual secret
        return (
            f"InstallationAccessToken(token='***', "
            f"expires_at={self.expires_at!r}, "
            f"permissions={self.permissions!r}, "
            f"repository_selection={self.repository_selection!r})"
        )


def load_github_app_private_key(key_path: str | None = None) -> RSAPrivateKey:
    """
    Loads and validates the GitHub App RSA private key from the explicit file path.
    Strictly NO fallbacks: uses key_path or GITHUB_APP_PRIVATE_KEY_PATH environment variable.
    Fails clearly if the path is missing, unreadable, or not a valid RSA private key.
    Never exposes key contents.
    """
    target_path = key_path if key_path is not None else os.getenv("GITHUB_APP_PRIVATE_KEY_PATH")
    if not target_path:
        raise GitHubAppConfigurationError(
            "GITHUB_APP_PRIVATE_KEY_PATH is not configured. Cannot load GitHub App private key."
        )

    path_obj = Path(target_path)
    if not path_obj.is_file():
        raise GitHubAppConfigurationError(
            f"GitHub App private key file not found at configured path: {target_path}"
        )

    try:
        key_bytes = path_obj.read_bytes()
    except Exception as exc:
        raise GitHubAppConfigurationError(
            f"Failed to read GitHub App private key file at {target_path}: {exc.__class__.__name__}"
        ) from exc

    if not key_bytes.strip():
        raise GitHubAppConfigurationError(
            f"GitHub App private key file at {target_path} is empty."
        )

    try:
        private_key = serialization.load_pem_private_key(
            key_bytes,
            password=None,
        )
    except Exception as exc:
        raise GitHubAppConfigurationError(
            f"GitHub App private key at {target_path} is not a valid PEM private key: {exc.__class__.__name__}"
        ) from exc

    if not isinstance(private_key, RSAPrivateKey):
        raise GitHubAppConfigurationError(
            f"GitHub App private key at {target_path} is not an RSA private key (got {type(private_key).__name__})."
        )

    return private_key


def generate_github_app_jwt(
    private_key: RSAPrivateKey | None = None,
    client_id: str | None = None,
    key_path: str | None = None,
    now: int | None = None,
) -> str:
    """
    Generates a RS256 signed JWT for authenticating as the GitHub App.
    Claims:
      - iss: GITHUB_APP_CLIENT_ID
      - iat: now - 60 seconds (clock drift tolerance)
      - exp: now + 600 seconds (10 minutes max allowed by GitHub)
    """
    app_client_id = client_id or os.getenv("GITHUB_APP_CLIENT_ID")
    if not app_client_id:
        raise GitHubAppConfigurationError(
            "GITHUB_APP_CLIENT_ID is not configured. Cannot generate GitHub App JWT."
        )

    if private_key is None:
        private_key = load_github_app_private_key(key_path=key_path)

    current_timestamp = now if now is not None else int(time.time())
    payload: dict[str, Any] = {
        "iat": current_timestamp - 60,
        "exp": current_timestamp + 600,
        "iss": app_client_id,
    }

    token = jwt.encode(payload, private_key, algorithm="RS256")
    return token


async def create_installation_access_token(
    installation_id: int,
    repository_ids: list[int] | None = None,
    private_key: RSAPrivateKey | None = None,
    client_id: str | None = None,
    key_path: str | None = None,
    http_client: httpx.AsyncClient | None = None,
    api_version: str = DEFAULT_API_VERSION,
    user_agent: str = DEFAULT_USER_AGENT,
) -> InstallationAccessToken:
    """
    Requests a short-lived GitHub App installation access token on demand.
    POST https://api.github.com/app/installations/{installation_id}/access_tokens

    Supports optional least-privilege scoping via repository_ids=[...].
    The returned InstallationAccessToken is held strictly in memory.
    Never persisted to DB, Redis, ARQ, or logs.
    """
    if not installation_id or installation_id <= 0:
        raise GitHubInstallationTokenError("Invalid installation_id provided.")

    app_jwt = generate_github_app_jwt(
        private_key=private_key,
        client_id=client_id,
        key_path=key_path,
    )

    url = f"https://api.github.com/app/installations/{installation_id}/access_tokens"
    headers = {
        "Authorization": f"Bearer {app_jwt}",
        "Accept": "application/vnd.github+json",
        "User-Agent": user_agent,
        "X-GitHub-Api-Version": api_version,
    }

    json_body: dict[str, Any] = {}
    if repository_ids is not None:
        json_body["repository_ids"] = repository_ids

    async def _post(client: httpx.AsyncClient) -> InstallationAccessToken:
        try:
            resp = await client.post(
                url,
                headers=headers,
                json=json_body if json_body else None,
                timeout=10.0,
            )
        except httpx.RequestError as exc:
            raise GitHubInstallationTokenError(
                f"Network error requesting installation access token: {exc.__class__.__name__}"
            ) from exc

        if resp.status_code == 201:
            data = resp.json()
            token_str = data.get("token")
            expires_at_raw = data.get("expires_at")
            if not token_str or not expires_at_raw:
                raise GitHubInstallationTokenError(
                    "GitHub API 201 response missing 'token' or 'expires_at'."
                )

            try:
                expires_at = datetime.fromisoformat(expires_at_raw.replace("Z", "+00:00"))
            except ValueError:
                expires_at = datetime.now(timezone.utc)

            return InstallationAccessToken(
                token=token_str,
                expires_at=expires_at,
                permissions=data.get("permissions", {}),
                repository_selection=data.get("repository_selection"),
            )

        status_code = resp.status_code
        error_msg = f"GitHub API error requesting installation token (HTTP {status_code})"

        try:
            err_data = resp.json()
            if isinstance(err_data, dict) and "message" in err_data:
                error_msg = f"{error_msg}: {err_data['message']}"
        except Exception:
            pass

        if status_code == 401:
            raise GitHubInstallationTokenError(
                f"GitHub App authentication failed (HTTP 401). Verify client_id and private key: {error_msg}",
                status_code=401,
            )
        elif status_code == 403:
            raise GitHubInstallationTokenError(
                f"Forbidden (HTTP 403). Installation may be suspended or rate limit reached: {error_msg}",
                status_code=403,
            )
        elif status_code == 404:
            raise GitHubInstallationTokenError(
                f"Installation {installation_id} not found (HTTP 404): {error_msg}",
                status_code=404,
            )
        elif status_code == 422:
            raise GitHubInstallationTokenError(
                f"Unprocessable Entity (HTTP 422): {error_msg}",
                status_code=422,
            )
        else:
            raise GitHubInstallationTokenError(error_msg, status_code=status_code)

    if http_client is not None:
        return await _post(http_client)
    async with httpx.AsyncClient() as new_client:
        return await _post(new_client)
