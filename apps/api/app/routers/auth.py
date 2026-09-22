from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response, status
from fastapi.responses import JSONResponse, RedirectResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.database import get_db
from app.schemas import UserProfileResponse
from app.security.pkce import generate_code_challenge, generate_code_verifier, generate_state
from app.security.session import (
    create_pkce_state_cookie_value,
    create_session_cookie_value,
    verify_pkce_state_cookie_value,
    verify_session_cookie_value,
)
from app.services.github_auth import (
    build_github_authorize_url,
    exchange_code_for_user_token,
    fetch_github_user_profile,
    upsert_user_from_oauth,
)
from codeworld_db import User

logger = logging.getLogger(__name__)

router = APIRouter()


def _delete_pkce_cookie(response: Response) -> None:
    """Helper to clean up temporary PKCE state cookie."""
    response.delete_cookie(
        key=settings.oauth_pkce_cookie_name,
        path="/",
        samesite="lax",
        secure=not settings.is_development,
    )


async def get_current_user(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> User:
    """
    FastAPI dependency for authenticating user requests via the signed session cookie.
    Interrogates PostgreSQL directly without calling GitHub API.
    """
    session_cookie = request.cookies.get(settings.session_cookie_name)
    if not session_cookie:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated. Session cookie missing.",
        )

    try:
        user_id = verify_session_cookie_value(session_cookie)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=str(exc),
        ) from exc

    user = await db.get(User, user_id)
    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found.",
        )

    return user


@router.get("/auth/github/login")
async def github_login():
    """
    Initiates the GitHub App OAuth flow with PKCE (RFC 7636).
    Sets a short-lived, tamper-resistant cookie with the state and verifier,
    and redirects the browser to GitHub's authorization page.
    """
    state = generate_state(32)
    code_verifier = generate_code_verifier(64)
    code_challenge = generate_code_challenge(code_verifier)

    pkce_token = create_pkce_state_cookie_value(
        state=state,
        code_verifier=code_verifier,
        max_age=settings.oauth_pkce_max_age_seconds,
    )

    try:
        authorize_url = build_github_authorize_url(state=state, code_challenge=code_challenge)
    except ValueError as exc:
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=str(exc),
        ) from exc

    response = RedirectResponse(url=authorize_url, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    response.set_cookie(
        key=settings.oauth_pkce_cookie_name,
        value=pkce_token,
        max_age=settings.oauth_pkce_max_age_seconds,
        httponly=True,
        samesite="lax",
        secure=not settings.is_development,
        path="/",
    )
    return response


@router.get("/auth/github/callback")
async def github_callback(
    request: Request,
    code: str | None = Query(None),
    state: str | None = Query(None),
    error: str | None = Query(None),
    error_description: str | None = Query(None),
    db: AsyncSession = Depends(get_db),
):
    """Handle GitHub App OAuth callback with PKCE verification and user session creation."""
    pkce_cookie = request.cookies.get(settings.oauth_pkce_cookie_name)

    if error:
        err_msg = error_description or error
        logger.warning("GitHub OAuth callback received error: %s", err_msg)
        resp = JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"detail": f"GitHub authorization failed: {err_msg}"},
        )
        _delete_pkce_cookie(resp)
        return resp

    if not code or not state:
        resp = JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"detail": "Missing required code or state parameter."},
        )
        _delete_pkce_cookie(resp)
        return resp

    try:
        pkce_data = verify_pkce_state_cookie_value(pkce_cookie)
    except ValueError as exc:
        logger.warning("PKCE cookie verification failed: %s", exc)
        resp = JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"detail": f"OAuth verification failed: {exc}"},
        )
        _delete_pkce_cookie(resp)
        return resp

    if pkce_data["state"] != state:
        logger.warning("OAuth state mismatch: received %s, expected %s", state, pkce_data["state"])
        resp = JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"detail": "Invalid OAuth state parameter."},
        )
        _delete_pkce_cookie(resp)
        return resp

    code_verifier = pkce_data["verifier"]

    try:
        token_data = await exchange_code_for_user_token(code=code, code_verifier=code_verifier)
    except Exception as exc:
        logger.error("Failed to exchange code for token: %s", exc)
        resp = JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"detail": f"Token exchange failed: {exc}"},
        )
        _delete_pkce_cookie(resp)
        return resp

    access_token = token_data["access_token"]
    refresh_token = token_data.get("refresh_token")
    expires_in = token_data.get("expires_in")
    refresh_token_expires_in = token_data.get("refresh_token_expires_in")

    try:
        user_profile = await fetch_github_user_profile(access_token)
    except Exception as exc:
        logger.error("Failed to fetch GitHub profile: %s", exc)
        resp = JSONResponse(
            status_code=status.HTTP_400_BAD_REQUEST,
            content={"detail": f"Failed to fetch user profile: {exc}"},
        )
        _delete_pkce_cookie(resp)
        return resp

    try:
        user = await upsert_user_from_oauth(
            db=db,
            profile=user_profile,
            token_data=token_data,
        )
    except Exception as exc:
        logger.error("Failed to persist user from OAuth callback: %s", exc.__class__.__name__)
        resp = JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content={"detail": "Failed to save user session."},
        )
        _delete_pkce_cookie(resp)
        return resp

    session_token = create_session_cookie_value(
        user_id=user.id,
        max_age=settings.session_max_age_seconds,
    )

    redirect_target = settings.auth_success_redirect_url
    response = RedirectResponse(url=redirect_target, status_code=status.HTTP_307_TEMPORARY_REDIRECT)
    response.set_cookie(
        key=settings.session_cookie_name,
        value=session_token,
        max_age=settings.session_max_age_seconds,
        httponly=True,
        samesite="lax",
        secure=not settings.is_development,
        path="/",
    )

    _delete_pkce_cookie(response)
    return response


@router.get("/auth/me", response_model=UserProfileResponse)
async def get_me(current_user: User = Depends(get_current_user)):
    """
    Returns the authenticated user profile from PostgreSQL session.
    Does not make any external calls to GitHub.
    """
    return UserProfileResponse(
        id=current_user.id,
        github_user_id=current_user.github_user_id,
        github_login=current_user.github_login,
        avatar_url=current_user.avatar_url,
    )


@router.post("/auth/logout")
async def logout():
    """
    Logs out the user by clearing the CodeWorld session cookie.
    """
    response = JSONResponse(content={"status": "ok", "message": "Logged out successfully."})
    response.delete_cookie(
        key=settings.session_cookie_name,
        path="/",
        samesite="lax",
        secure=not settings.is_development,
    )
    return response
