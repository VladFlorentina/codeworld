"""
Validation test suite for Checkpoint 5.3:
GitHub App User Authorization + PKCE + CodeWorld Session.

Uses a single asyncio event loop and httpx.AsyncClient with ASGITransport
to share the asyncpg connection pool seamlessly across test steps.
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
from unittest.mock import AsyncMock, patch
from urllib.parse import parse_qs, urlparse

import httpx
from sqlalchemy import select

from app.config import settings
from app.database import AsyncSessionLocal
from app.main import app
from app.security.encryption import decrypt_token, encrypt_token
from app.security.pkce import generate_code_challenge, generate_code_verifier, generate_state
from app.security.session import (
    create_pkce_state_cookie_value,
    create_session_cookie_value,
    verify_pkce_state_cookie_value,
    verify_session_cookie_value,
)
from app.services.github_auth import (
    AuthenticationRequiredException,
    get_valid_user_access_token,
)
from codeworld_db import User


async def run_auth_tests():
    print("==================================================================")
    print("      CHECKPOINT 5.3: GITHUB AUTH & SESSION VERIFICATION          ")
    print("==================================================================")

    orig_client_id = settings.github_app_client_id
    orig_client_secret = settings.github_app_client_secret
    settings.github_app_client_id = "test-client-id-12345"
    settings.github_app_client_secret = "test-client-secret-67890"

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        try:
            # ─────────────────────────────────────────────────────────────
            # 1. Login Endpoint
            # ─────────────────────────────────────────────────────────────
            print("\n--- [Test 1: GET /auth/github/login] ---")
            login_res = await client.get("/api/v1/auth/github/login", follow_redirects=False)
            print(f"Status: {login_res.status_code}")
            assert login_res.status_code == 307, f"Expected 307, got {login_res.status_code}"

            location = login_res.headers.get("location")
            print(f"Redirect Location: {location}")
            assert location.startswith("https://github.com/login/oauth/authorize")

            parsed_url = urlparse(location)
            query_params = parse_qs(parsed_url.query)

            assert query_params["client_id"] == ["test-client-id-12345"]
            assert "state" in query_params
            assert "code_challenge" in query_params
            assert query_params["code_challenge_method"] == ["S256"]
            assert "client_secret" not in query_params
            assert "code_verifier" not in query_params

            pkce_cookie = login_res.cookies.get(settings.oauth_pkce_cookie_name)
            assert pkce_cookie is not None, "PKCE cookie must be set on login response"
            cookie_data = verify_pkce_state_cookie_value(pkce_cookie)
            assert cookie_data["state"] == query_params["state"][0]
            assert len(cookie_data["verifier"]) >= 43
            print("✓ PASS: Login endpoint constructs secure PKCE URL and signed cookie.")

            # ─────────────────────────────────────────────────────────────
            # 2. Callback Error Scenarios
            # ─────────────────────────────────────────────────────────────
            print("\n--- [Test 2: Callback Error Scenarios] ---")
            # 2a. Missing state or code
            err1 = await client.get("/api/v1/auth/github/callback?code=only_code")
            print(f"Missing state status: {err1.status_code}")
            assert err1.status_code == 400

            # 2b. Missing PKCE cookie
            err2 = await client.get("/api/v1/auth/github/callback?code=some_code&state=some_state")
            print(f"Missing cookie status: {err2.status_code}")
            assert err2.status_code == 400

            # 2c. State mismatch
            err3 = await client.get(
                "/api/v1/auth/github/callback?code=some_code&state=tampered_state",
                cookies={settings.oauth_pkce_cookie_name: pkce_cookie},
            )
            print(f"State mismatch status: {err3.status_code}")
            assert err3.status_code == 400

            # 2d. Expired PKCE cookie
            expired_cookie = create_pkce_state_cookie_value("state123", "verifier123", max_age=-10)
            err4 = await client.get(
                "/api/v1/auth/github/callback?code=some_code&state=state123",
                cookies={settings.oauth_pkce_cookie_name: expired_cookie},
            )
            print(f"Expired cookie status: {err4.status_code}")
            assert err4.status_code == 400
            print("✓ PASS: Callback strictly rejects missing, mismatched, and expired states.")

            # ─────────────────────────────────────────────────────────────
            # 3. Valid Callback Flow
            # ─────────────────────────────────────────────────────────────
            print("\n--- [Test 3: Valid Callback Flow] ---")
            state_valid = generate_state(32)
            verifier_valid = generate_code_verifier(64)
            valid_pkce_cookie = create_pkce_state_cookie_value(state_valid, verifier_valid, max_age=600)

            mock_token_resp = {
                "access_token": "ghu_MockAccessToken1234567890",
                "token_type": "bearer",
                "expires_in": 28800,
                "refresh_token": "ghr_MockRefreshToken1234567890",
                "refresh_token_expires_in": 15811200,
            }
            mock_user_profile = {
                "id": 99887766,
                "login": "codeworld-tester",
                "avatar_url": "https://avatars.githubusercontent.com/u/99887766?v=4",
            }

            with patch("app.routers.auth.exchange_code_for_user_token", new=AsyncMock(return_value=mock_token_resp)), \
                 patch("app.routers.auth.fetch_github_user_profile", new=AsyncMock(return_value=mock_user_profile)):

                cb_res = await client.get(
                    f"/api/v1/auth/github/callback?code=valid_test_code&state={state_valid}",
                    cookies={settings.oauth_pkce_cookie_name: valid_pkce_cookie},
                    follow_redirects=False,
                )
                print(f"Callback status: {cb_res.status_code}")
                assert cb_res.status_code == 307
                assert cb_res.headers["location"] == settings.auth_success_redirect_url

                # Check session cookie set
                session_cookie = cb_res.cookies.get(settings.session_cookie_name)
                assert session_cookie is not None, "Session cookie must be set on callback success"
                authed_user_id = verify_session_cookie_value(session_cookie)
                print(f"Authenticated User ID from session cookie: {authed_user_id}")

                # Verify in PostgreSQL
                async with AsyncSessionLocal() as session:
                    res = await session.execute(select(User).where(User.github_user_id == 99887766))
                    u = res.scalars().first()
                    assert u is not None
                    assert u.id == authed_user_id
                    assert u.github_login == "codeworld-tester"
                    assert u.avatar_url == "https://avatars.githubusercontent.com/u/99887766?v=4"
                    # Check token encryption
                    assert u.encrypted_user_access_token != "ghu_MockAccessToken1234567890"
                    assert decrypt_token(u.encrypted_user_access_token) == "ghu_MockAccessToken1234567890"
                    assert decrypt_token(u.encrypted_refresh_token) == "ghr_MockRefreshToken1234567890"
                    assert u.user_token_expires_at is not None
                    assert u.refresh_token_expires_at is not None
                    print("  Verified User record in DB with encrypted tokens.")

                print("✓ PASS: Valid callback creates user, encrypts tokens, and sets session cookie.")

            # ─────────────────────────────────────────────────────────────
            # 4. Repeat Callback (Idempotent Upsert)
            # ─────────────────────────────────────────────────────────────
            print("\n--- [Test 4: Repeat Callback Updates User] ---")
            state_repeat = generate_state(32)
            verifier_repeat = generate_code_verifier(64)
            repeat_cookie = create_pkce_state_cookie_value(state_repeat, verifier_repeat, max_age=600)

            mock_token_resp_updated = {
                "access_token": "ghu_NewAccessToken9999",
                "expires_in": 28800,
                "refresh_token": "ghr_NewRefreshToken9999",
                "refresh_token_expires_in": 15811200,
            }
            mock_user_profile_updated = {
                "id": 99887766,  # SAME numeric ID
                "login": "codeworld-tester-renamed",  # Updated login
                "avatar_url": "https://avatars.githubusercontent.com/u/99887766?v=5",
            }

            with patch("app.routers.auth.exchange_code_for_user_token", new=AsyncMock(return_value=mock_token_resp_updated)), \
                 patch("app.routers.auth.fetch_github_user_profile", new=AsyncMock(return_value=mock_user_profile_updated)):

                cb_repeat_res = await client.get(
                    f"/api/v1/auth/github/callback?code=another_code&state={state_repeat}",
                    cookies={settings.oauth_pkce_cookie_name: repeat_cookie},
                    follow_redirects=False,
                )
                assert cb_repeat_res.status_code == 307

                async with AsyncSessionLocal() as session:
                    res = await session.execute(select(User).where(User.github_user_id == 99887766))
                    all_users = res.scalars().all()
                    assert len(all_users) == 1, f"Expected 1 user, found {len(all_users)}"
                    u = all_users[0]
                    assert u.github_login == "codeworld-tester-renamed"
                    assert decrypt_token(u.encrypted_user_access_token) == "ghu_NewAccessToken9999"
                    assert decrypt_token(u.encrypted_refresh_token) == "ghr_NewRefreshToken9999"
                    print("  Verified single user updated without duplication.")

                print("✓ PASS: Repeat callback for same github_user_id cleanly updates existing user.")

            # ─────────────────────────────────────────────────────────────
            # 5. /auth/me Endpoint
            # ─────────────────────────────────────────────────────────────
            print("\n--- [Test 5: GET /auth/me] ---")
            # Unauthenticated: clear client cookies
            client.cookies.clear()
            me_unauth = await client.get("/api/v1/auth/me")
            print(f"Unauthenticated /auth/me status: {me_unauth.status_code}")
            assert me_unauth.status_code == 401

            # Invalid session token
            me_invalid = await client.get(
                "/api/v1/auth/me",
                cookies={settings.session_cookie_name: "tampered.jwt.cookie"},
            )
            assert me_invalid.status_code == 401

            # Authenticated with valid session cookie
            client.cookies.clear()
            me_auth = await client.get(
                "/api/v1/auth/me",
                cookies={settings.session_cookie_name: session_cookie},
            )
            print(f"Authenticated /auth/me status: {me_auth.status_code}, data: {me_auth.json()}")
            assert me_auth.status_code == 200
            data = me_auth.json()
            assert data["github_user_id"] == 99887766
            assert data["github_login"] == "codeworld-tester-renamed"
            assert "access_token" not in data, "No tokens should ever be exposed via /auth/me"
            print("✓ PASS: /auth/me returns user profile securely without exposing tokens.")

            # ─────────────────────────────────────────────────────────────
            # 6. /auth/logout Endpoint
            # ─────────────────────────────────────────────────────────────
            print("\n--- [Test 6: POST /auth/logout] ---")
            logout_res = await client.post(
                "/api/v1/auth/logout",
                cookies={settings.session_cookie_name: session_cookie},
            )
            print(f"Logout status: {logout_res.status_code}, headers: {logout_res.headers.get('set-cookie')}")
            assert logout_res.status_code == 200
            assert logout_res.json()["status"] == "ok"
            set_cookie_str = logout_res.headers.get("set-cookie", "")
            assert settings.session_cookie_name in set_cookie_str
            assert "Max-Age=0" in set_cookie_str or "max-age=0" in set_cookie_str.lower()

            # Client cookie jar clear (reflecting browser cookie deletion on Max-Age=0)
            client.cookies.clear()
            me_after_logout = await client.get("/api/v1/auth/me")
            assert me_after_logout.status_code == 401
            print("✓ PASS: Logout endpoint clears session cookie and unauthenticates user.")

            # ─────────────────────────────────────────────────────────────
            # 7. Token Refresh Helper Tests
            # ─────────────────────────────────────────────────────────────
            print("\n--- [Test 7: Token Refresh Helper (get_valid_user_access_token)] ---")
            async with AsyncSessionLocal() as session:
                res = await session.execute(select(User).where(User.github_user_id == 99887766))
                u = res.scalars().first()

                # 7a. Valid token (expires in 1 hour) -> no refresh needed
                u.user_token_expires_at = datetime.now(timezone.utc) + timedelta(hours=1)
                u.encrypted_user_access_token = encrypt_token("ghu_valid_now")
                await session.commit()

                with patch("app.services.github_auth.refresh_github_user_token") as mock_refresh:
                    tok = await get_valid_user_access_token(u, session)
                    assert tok == "ghu_valid_now"
                    mock_refresh.assert_not_called()
                print("  ✓ 7a: Valid token returns immediately without calling GitHub refresh.")

                # 7b. Expired token -> refresh + token rotation
                u.user_token_expires_at = datetime.now(timezone.utc) - timedelta(minutes=5)
                u.encrypted_refresh_token = encrypt_token("ghr_old_refresh")
                u.refresh_token_expires_at = datetime.now(timezone.utc) + timedelta(days=30)
                await session.commit()

                mock_refreshed_data = {
                    "access_token": "ghu_refreshed_access_token_888",
                    "refresh_token": "ghr_rotated_refresh_token_999",
                    "expires_in": 28800,
                    "refresh_token_expires_in": 15811200,
                }
                with patch("app.services.github_auth.refresh_github_user_token", new=AsyncMock(return_value=mock_refreshed_data)):
                    new_tok = await get_valid_user_access_token(u, session)
                    assert new_tok == "ghu_refreshed_access_token_888"

                    # Verify in DB
                    await session.refresh(u)
                    assert decrypt_token(u.encrypted_user_access_token) == "ghu_refreshed_access_token_888"
                    assert decrypt_token(u.encrypted_refresh_token) == "ghr_rotated_refresh_token_999"
                    assert u.user_token_expires_at > datetime.now(timezone.utc)
                print("  ✓ 7b: Expired token triggers GitHub refresh, rotates refresh token, and updates DB.")

                # 7c. Expired/revoked refresh token -> AuthenticationRequiredException
                u.user_token_expires_at = datetime.now(timezone.utc) - timedelta(minutes=5)
                u.refresh_token_expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
                await session.commit()

                try:
                    await get_valid_user_access_token(u, session)
                    assert False, "Expected AuthenticationRequiredException for expired refresh token"
                except AuthenticationRequiredException as exc:
                    print(f"  Caught expected AuthenticationRequiredException: {exc.detail}")
                    assert exc.status_code == 401
                print("  ✓ 7c: Expired/revoked refresh token requires re-authentication.")

                # Clean up test user
                await session.delete(u)
                await session.commit()

            # ─────────────────────────────────────────────────────────────
            # 8. Regression Verification
            # ─────────────────────────────────────────────────────────────
            print("\n--- [Test 8: Regression Verification] ---")
            # Health check
            h_res = await client.get("/api/v1/health")
            assert h_res.status_code == 200
            assert h_res.json()["status"] == "ok"
            print("✓ PASS: /health returns 200 OK")

            # Public Explore repo
            f_res = await client.post("/api/v1/repositories", json={"url": "https://github.com/tiangolo/fastapi"})
            assert f_res.status_code == 200
            assert f_res.json()["status"] == "ready"
            print("✓ PASS: POST /repositories returns 200 ready")

            # Public City viewer
            c_res = await client.get("/api/v1/cities/2e945127-9c5d-4b5a-a0d9-9d52e2cbadfe")
            assert c_res.status_code == 200
            assert len(c_res.json()["buildings"]) > 0
            print("✓ PASS: GET /cities/{id} returns completed city layout")

            print("\n==================================================================")
            print("     ALL CHECKPOINT 5.3 AUTHENTICATION TESTS PASSED!             ")
            print("==================================================================")

        finally:
            settings.github_app_client_id = orig_client_id
            settings.github_app_client_secret = orig_client_secret


if __name__ == "__main__":
    asyncio.run(run_auth_tests())
