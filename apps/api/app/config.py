from __future__ import annotations

from functools import lru_cache
from typing import List

from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    """
    Application configuration loaded from environment variables.

    pydantic-settings reads values from the environment automatically.
    In development these come from the .env file (loaded by Docker Compose).
    In production they come from the actual environment.
    """

    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        case_sensitive=False,
    )

    environment: str = "development"
    secret_key: str = "dev-secret-change-in-production-32b"
    database_url: str = (
        "postgresql+asyncpg://codeworld:codeworld@localhost:5432/codeworld"
    )
    redis_url: str = "redis://localhost:6379"
    cors_origins: List[str] = ["http://localhost:3000", "http://127.0.0.1:3000"]

    github_clone_base_dir: str = "/tmp/codeworld_repos"
    max_repo_size_mb: int = 500
    analysis_timeout_seconds: int = 300

    github_app_id: str | None = None
    github_app_client_id: str | None = None
    github_app_client_secret: str | None = None
    github_app_private_key: str | None = None
    github_app_private_key_path: str | None = None
    github_app_slug: str | None = None
    token_encryption_key: str | None = None
    github_api_version: str = "2022-11-28"
    session_cookie_name: str = "codeworld_session"
    session_max_age_seconds: int = 7 * 24 * 3600
    frontend_url: str = "http://localhost:3000"
    github_app_redirect_uri: str = "http://localhost:8000/api/v1/auth/github/callback"
    auth_success_redirect_url: str = "http://localhost:3000/my-repositories"
    oauth_pkce_cookie_name: str = "codeworld_oauth_pkce"
    oauth_pkce_max_age_seconds: int = 600

    @property
    def is_development(self) -> bool:
        return self.environment == "development"


@lru_cache()
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
