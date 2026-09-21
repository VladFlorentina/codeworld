"""
Pydantic request/response schemas for the repositories router.

Schemas vs Models:
  - app/models/   = SQLAlchemy ORM (database layer)
  - app/schemas/  = Pydantic (API layer: validation, serialization, Swagger docs)

These two layers are intentionally separate. The API never exposes ORM objects
directly — it always goes through a schema. This gives us control over exactly
what fields are readable/writable through the API.
"""
from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, HttpUrl, field_validator


class SubmitRepositoryRequest(BaseModel):
    """
    Request body for POST /api/v1/repositories.

    The client sends a GitHub repository URL. We validate it here
    before touching the database or enqueueing any job.
    """

    url: str

    @field_validator("url")
    @classmethod
    def validate_github_url(cls, v: str) -> str:
        """
        Ensure the URL is a valid GitHub repository URL.

        We enforce github.com here for two reasons:
          1. Security: prevents SSRF by allowlisting the host.
          2. Scope: CodeWorld only analyzes GitHub repos in the MVP.

        Valid examples:
          https://github.com/owner/repo
          https://github.com/owner/repo.git
          https://github.com/owner/repo/

        Invalid:
          https://gitlab.com/owner/repo
          https://github.com/owner             (no repo name)
          ftp://github.com/owner/repo          (wrong scheme)
        """
        v = v.strip().rstrip("/")

        # Remove trailing .git for consistency
        if v.endswith(".git"):
            v = v[:-4]

        # Must be HTTPS
        if not v.startswith("https://"):
            raise ValueError("Repository URL must use HTTPS (https://github.com/owner/repo)")

        # Must be github.com
        if not v.startswith("https://github.com/"):
            raise ValueError("Only GitHub repositories are supported (https://github.com/...)")

        # Must have at least owner/repo path segments
        path = v.removeprefix("https://github.com/")
        parts = [p for p in path.split("/") if p]
        if len(parts) < 2:
            raise ValueError(
                "URL must include both owner and repository name "
                "(https://github.com/owner/repo)"
            )

        return v

    model_config = {
        "json_schema_extra": {
            "examples": [
                {"url": "https://github.com/tiangolo/fastapi"},
            ]
        }
    }


class SubmitRepositoryResponse(BaseModel):
    """
    Response for POST /api/v1/repositories.

    Status values:
      - 'ready': City already exists for this repository and commit SHA (HTTP 200).
      - 'analyzing': An active AnalysisRun is already in progress for this SHA (HTTP 202).
      - 'newly_queued': A new AnalysisRun was created and enqueued to ARQ (HTTP 202).
    """

    status: Literal["ready", "analyzing", "newly_queued"]
    repository_id: str
    run_id: str
    job_id: str | None = None
    commit_sha: str
    message: str


class UserProfileResponse(BaseModel):
    """
    Response for GET /api/v1/auth/me.
    """

    id: str
    github_user_id: int
    github_login: str
    avatar_url: str | None = None


class GitHubInstallationDTO(BaseModel):
    id: int
    account_login: str
    account_type: str
    repository_selection: str


class GitHubInstallationsResponse(BaseModel):
    install_url: str | None = None
    installations: list[GitHubInstallationDTO]


class GitHubRepositoryDTO(BaseModel):
    id: int
    installation_id: int
    owner: str
    name: str
    full_name: str
    private: bool
    html_url: str
    default_branch: str


class GitHubRepositoriesResponse(BaseModel):
    repositories: list[GitHubRepositoryDTO]


class AnalyzeGitHubRepositoryRequest(BaseModel):
    installation_id: int
    repository_id: int


