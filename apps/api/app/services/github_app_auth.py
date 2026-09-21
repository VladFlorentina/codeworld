from __future__ import annotations

from typing import Any
from cryptography.hazmat.primitives.asymmetric.rsa import RSAPrivateKey
import httpx

from app.config import settings
from codeworld_github_app import (
    GitHubAppAuthError,
    GitHubAppConfigurationError,
    GitHubInstallationTokenError,
    InstallationAccessToken,
    generate_github_app_jwt as _shared_generate_jwt,
    load_github_app_private_key as _shared_load_key,
    create_installation_access_token as _shared_create_token,
)


def load_github_app_private_key(key_path: str | None = None) -> RSAPrivateKey:
    target_path = key_path if key_path is not None else settings.github_app_private_key_path
    if not target_path:
        raise GitHubAppConfigurationError(
            "GITHUB_APP_PRIVATE_KEY_PATH is not configured. Cannot load GitHub App private key."
        )
    return _shared_load_key(key_path=target_path)


def generate_github_app_jwt(
    private_key: RSAPrivateKey | None = None,
    client_id: str | None = None,
    key_path: str | None = None,
    now: int | None = None,
) -> str:
    app_client_id = client_id if client_id is not None else settings.github_app_client_id
    if not app_client_id:
        raise GitHubAppConfigurationError(
            "GITHUB_APP_CLIENT_ID is not configured. Cannot generate GitHub App JWT."
        )
    target_path = key_path if key_path is not None else settings.github_app_private_key_path
    return _shared_generate_jwt(
        private_key=private_key,
        client_id=app_client_id,
        key_path=target_path,
        now=now,
    )


async def create_installation_access_token(
    installation_id: int,
    repository_ids: list[int] | None = None,
    private_key: RSAPrivateKey | None = None,
    client_id: str | None = None,
    key_path: str | None = None,
    http_client: httpx.AsyncClient | None = None,
) -> InstallationAccessToken:
    app_client_id = client_id or settings.github_app_client_id
    target_path = key_path or settings.github_app_private_key_path
    return await _shared_create_token(
        installation_id=installation_id,
        repository_ids=repository_ids,
        private_key=private_key,
        client_id=app_client_id,
        key_path=target_path,
        http_client=http_client,
        api_version=settings.github_api_version,
    )


__all__ = [
    "GitHubAppAuthError",
    "GitHubAppConfigurationError",
    "GitHubInstallationTokenError",
    "InstallationAccessToken",
    "load_github_app_private_key",
    "generate_github_app_jwt",
    "create_installation_access_token",
]
