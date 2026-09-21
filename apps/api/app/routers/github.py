from __future__ import annotations

import logging
from fastapi import APIRouter, Depends, HTTPException, Response, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.routers.auth import get_current_user
from app.schemas import (
    AnalyzeGitHubRepositoryRequest,
    GitHubInstallationsResponse,
    GitHubRepositoriesResponse,
    SubmitRepositoryResponse,
)
from app.services import github_installations
from app.services.github_auth import get_valid_user_access_token
from app.services.repository_service import ensure_repository_analysis
from codeworld_db import User

logger = logging.getLogger(__name__)

router = APIRouter()


@router.get("/github/installations", response_model=GitHubInstallationsResponse)
async def list_user_installations(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Lists all GitHub App installations accessible to the authenticated user.
    Uses the user's valid GitHub access token (refreshed automatically if needed).
    Returns minimal installation DTOs and the install_url. Zero installations is a normal state.
    """
    access_token = await get_valid_user_access_token(current_user, db)
    installations = await github_installations.fetch_user_installations(access_token=access_token)
    install_url = github_installations.get_github_app_install_url()

    return GitHubInstallationsResponse(
        install_url=install_url,
        installations=installations,
    )


@router.get("/github/repositories", response_model=GitHubRepositoriesResponse)
async def list_user_repositories(
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
):
    """
    Discovers all repositories accessible to the user across all their CodeWorld GitHub App installations.
    Aggregates repositories across installations without duplicates.
    Zero installations or zero repositories returns an empty list cleanly.
    """
    access_token = await get_valid_user_access_token(current_user, db)
    repos = await github_installations.fetch_all_user_repositories(access_token=access_token)

    return GitHubRepositoriesResponse(repositories=repos)


@router.post("/github/repositories/analyze", response_model=SubmitRepositoryResponse)
async def analyze_github_repository(
    body: AnalyzeGitHubRepositoryRequest,
    response: Response,
    current_user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SubmitRepositoryResponse:
    """
    Analyzes a GitHub repository (public or private) discovered via GitHub App.

    Flow:
      1. Requires valid CodeWorld session (current_user).
      2. Obtains valid GitHub user access token (with automatic refresh).
      3. Verifies installation_id is accessible to the user (403 if not).
      4. Verifies numeric repository_id belongs to that installation (404 if not).
      5. Extracts verified metadata from GitHub API (owner, name, full_name, private, branch, clone_url).
      6. Resolves current HEAD commit SHA via authenticated GitHub API.
      7. Delegates to unified ensure_repository_analysis for dedup, concurrency handling, and ARQ queueing.
    """
    access_token = await get_valid_user_access_token(current_user, db)

    # Verify user access to installation
    installations = await github_installations.fetch_user_installations(access_token=access_token)
    user_inst_ids = {inst["id"] for inst in installations}
    if body.installation_id not in user_inst_ids:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Installation is not accessible to this user.",
        )

    # Verify repository belongs to this installation
    inst_repos = await github_installations.fetch_installation_repositories(
        installation_id=body.installation_id,
        access_token=access_token,
    )
    matched_repo = next((r for r in inst_repos if r["id"] == body.repository_id), None)
    if not matched_repo:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Repository not found in specified installation.",
        )

    owner = matched_repo["owner"]
    name = matched_repo["name"]
    full_name = matched_repo["full_name"]
    is_private = matched_repo["private"]
    default_branch = matched_repo.get("default_branch") or "main"
    clone_url = matched_repo.get("html_url") or f"https://github.com/{full_name}"

    # Resolve HEAD commit SHA authenticated
    current_head_sha = await github_installations.fetch_repository_head_commit(
        owner=owner,
        repo_name=name,
        branch=default_branch,
        access_token=access_token,
    )

    # Delegate to unified analysis ensuring service
    resp_code, result = await ensure_repository_analysis(
        db=db,
        owner=owner,
        name=name,
        full_name=full_name,
        clone_url=clone_url,
        current_head_sha=current_head_sha,
        is_private=is_private,
        github_repository_id=body.repository_id,
        default_branch=default_branch,
        installation_id=body.installation_id,
    )
    response.status_code = resp_code
    return result

