from __future__ import annotations

import logging
from typing import Any

from fastapi import HTTPException, status
import httpx

from app.config import settings
from app.services.github_auth import (
    DEFAULT_USER_AGENT,
    AuthenticationRequiredException,
)

logger = logging.getLogger(__name__)

GITHUB_API_BASE_URL = "https://api.github.com"


def get_github_app_install_url() -> str | None:
    """
    Constructs the GitHub App public installation URL if GITHUB_APP_SLUG is configured.
    Format: https://github.com/apps/{slug}/installations/new
    """
    if not settings.github_app_slug:
        return None
    return f"https://github.com/apps/{settings.github_app_slug}/installations/new"


async def fetch_user_installations(
    access_token: str,
    client: httpx.AsyncClient | None = None,
) -> list[dict[str, Any]]:
    """
    Fetches all GitHub App installations accessible to the user using pagination.
    Endpoint: GET /user/installations
    """
    installations: list[dict[str, Any]] = []
    page = 1
    per_page = 100
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": DEFAULT_USER_AGENT,
        "X-GitHub-Api-Version": settings.github_api_version,
    }

    async def _fetch(http_client: httpx.AsyncClient) -> list[dict[str, Any]]:
        nonlocal page
        while True:
            resp = await http_client.get(
                f"{GITHUB_API_BASE_URL}/user/installations",
                params={"per_page": per_page, "page": page},
                headers=headers,
                timeout=10.0,
            )
            if resp.status_code == status.HTTP_401_UNAUTHORIZED:
                raise AuthenticationRequiredException(
                    "GitHub user token is invalid or has been revoked. Please re-authenticate."
                )
            if resp.status_code == status.HTTP_403_FORBIDDEN:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="GitHub API permission denied or rate limit exceeded.",
                )
            if resp.status_code != status.HTTP_200_OK:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"GitHub API error fetching installations: HTTP {resp.status_code}",
                )

            data = resp.json()
            page_items = data.get("installations", [])
            total_count = data.get("total_count", len(page_items))

            for item in page_items:
                account = item.get("account") or {}
                installations.append({
                    "id": item["id"],
                    "account_login": account.get("login", ""),
                    "account_type": account.get("type", "User"),
                    "repository_selection": item.get("repository_selection", "all"),
                })

            if len(page_items) < per_page or len(installations) >= total_count:
                break
            page += 1

        return installations

    if client is not None:
        return await _fetch(client)

    async with httpx.AsyncClient() as new_client:
        return await _fetch(new_client)


async def fetch_installation_repositories(
    installation_id: int,
    access_token: str,
    client: httpx.AsyncClient | None = None,
) -> list[dict[str, Any]]:
    """
    Fetches all repositories accessible through a specific installation using pagination.
    Endpoint: GET /user/installations/{installation_id}/repositories
    """
    repos: list[dict[str, Any]] = []
    page = 1
    per_page = 100
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": DEFAULT_USER_AGENT,
        "X-GitHub-Api-Version": settings.github_api_version,
    }

    async def _fetch(http_client: httpx.AsyncClient) -> list[dict[str, Any]]:
        nonlocal page
        while True:
            resp = await http_client.get(
                f"{GITHUB_API_BASE_URL}/user/installations/{installation_id}/repositories",
                params={"per_page": per_page, "page": page},
                headers=headers,
                timeout=10.0,
            )
            if resp.status_code == status.HTTP_401_UNAUTHORIZED:
                raise AuthenticationRequiredException(
                    "GitHub user token is invalid or has been revoked. Please re-authenticate."
                )
            if resp.status_code == status.HTTP_403_FORBIDDEN:
                raise HTTPException(
                    status_code=status.HTTP_403_FORBIDDEN,
                    detail="GitHub API permission denied or rate limit exceeded.",
                )
            if resp.status_code != status.HTTP_200_OK:
                raise HTTPException(
                    status_code=status.HTTP_502_BAD_GATEWAY,
                    detail=f"GitHub API error fetching repositories for installation {installation_id}: HTTP {resp.status_code}",
                )

            data = resp.json()
            page_items = data.get("repositories", [])
            total_count = data.get("total_count", len(page_items))

            for r in page_items:
                owner_val = r.get("owner")
                owner_login = owner_val.get("login", "") if isinstance(owner_val, dict) else str(owner_val or "")
                repos.append({
                    "id": r["id"],
                    "installation_id": installation_id,
                    "owner": owner_login,
                    "name": r.get("name", ""),
                    "full_name": r.get("full_name", f"{owner_login}/{r.get('name', '')}"),
                    "private": bool(r.get("private", False)),
                    "html_url": r.get("html_url", ""),
                    "default_branch": r.get("default_branch", "main"),
                })

            if len(page_items) < per_page or len(repos) >= total_count:
                break
            page += 1

        return repos

    if client is not None:
        return await _fetch(client)

    async with httpx.AsyncClient() as new_client:
        return await _fetch(new_client)


async def fetch_all_user_repositories(
    access_token: str,
    client: httpx.AsyncClient | None = None,
) -> list[dict[str, Any]]:
    """
    Discovers all repositories accessible to the user across all their CodeWorld GitHub App installations.
    Aggregates repositories without duplicates.
    Zero installations returns an empty list cleanly.
    """
    installations = await fetch_user_installations(access_token=access_token, client=client)
    if not installations:
        return []

    all_repos: list[dict[str, Any]] = []
    seen_ids: set[int] = set()

    for inst in installations:
        inst_id = inst["id"]
        inst_repos = await fetch_installation_repositories(
            installation_id=inst_id,
            access_token=access_token,
            client=client,
        )
        for repo in inst_repos:
            repo_id = repo["id"]
            if repo_id not in seen_ids:
                seen_ids.add(repo_id)
                all_repos.append(repo)

    return all_repos


async def fetch_repository_head_commit(
    owner: str,
    repo_name: str,
    branch: str,
    access_token: str,
    client: httpx.AsyncClient | None = None,
) -> str:
    """
    Fetches the latest commit SHA of a repository branch using authenticated GitHub API.
    Endpoint: GET /repos/{owner}/{repo}/commits/{branch}
    """
    headers = {
        "Authorization": f"Bearer {access_token}",
        "Accept": "application/vnd.github+json",
        "User-Agent": DEFAULT_USER_AGENT,
        "X-GitHub-Api-Version": settings.github_api_version,
    }
    url = f"{GITHUB_API_BASE_URL}/repos/{owner}/{repo_name}/commits/{branch}"

    async def _get(c: httpx.AsyncClient) -> str:
        resp = await c.get(url, headers=headers, timeout=10.0)
        if resp.status_code == status.HTTP_401_UNAUTHORIZED:
            raise AuthenticationRequiredException("GitHub token invalid or expired.")
        if resp.status_code != status.HTTP_200_OK:
            raise HTTPException(
                status_code=resp.status_code if resp.status_code in (403, 404) else status.HTTP_502_BAD_GATEWAY,
                detail=f"GitHub API failed resolving HEAD commit for {owner}/{repo_name}: HTTP {resp.status_code}",
            )
        data = resp.json()
        sha = data.get("sha")
        if not sha or len(sha) != 40:
            raise HTTPException(
                status_code=status.HTTP_502_BAD_GATEWAY,
                detail="Invalid commit SHA returned by GitHub API.",
            )
        return sha

    if client is not None:
        return await _get(client)

    async with httpx.AsyncClient() as new_client:
        return await _get(new_client)

