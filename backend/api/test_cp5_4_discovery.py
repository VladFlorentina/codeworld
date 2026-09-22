"""
Validation test suite for Checkpoint 5.4:
GitHub App Installations & Repository Discovery.

Tests:
  1. GET /api/v1/github/installations without session -> 401
  2. GET /api/v1/github/installations with valid user + zero installations -> 200 empty
  3. GET /api/v1/github/installations with existing installation -> correct DTO & install_url
  4. GET /api/v1/github/repositories with zero installations -> 200 empty
  5. GET /api/v1/github/repositories with 1 installation + repos -> correct DTO & privacy flags
  6. GET /api/v1/github/repositories with multiple installations -> aggregated cleanly
  7. Pagination > 100 repositories -> loops through pages and aggregates all
  8. Expired user token -> triggers refresh lifecycle and succeeds
  9. GitHub 401/revoked -> controlled 401 re-auth response
 10. Security: No GitHub tokens leaked in responses
 11. Regressions: /health, POST /repositories, GET /cities/{id}, /auth/me
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timedelta, timezone
import json
from unittest.mock import AsyncMock, patch

import httpx
from sqlalchemy import select

from app.config import settings
from app.database import AsyncSessionLocal
from app.main import app
from app.security.encryption import decrypt_token, encrypt_token
from app.security.session import create_session_cookie_value
from codeworld_db import User


async def run_discovery_tests():
    print("==================================================================")
    print("  CHECKPOINT 5.4: GITHUB INSTALLATIONS & REPOSITORY DISCOVERY    ")
    print("==================================================================")

    # Set dummy slug for testing install URL
    orig_slug = settings.github_app_slug
    settings.github_app_slug = "codeworld-dev-test"

    transport = httpx.ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://testserver") as client:
        # Create a test user in DB for this test suite
        test_gh_user_id = 88776655
        test_plain_token = "ghu_TestValidDiscoveryToken12345"
        test_plain_refresh = "ghr_TestValidDiscoveryRefresh12345"
        test_user_id = None

        async with AsyncSessionLocal() as session:
            # Clean up if leftover
            res = await session.execute(select(User).where(User.github_user_id == test_gh_user_id))
            existing = res.scalars().first()
            if existing:
                await session.delete(existing)
                await session.commit()

            test_user = User(
                github_user_id=test_gh_user_id,
                github_login="discovery-tester",
                avatar_url="https://avatars.githubusercontent.com/u/88776655",
                encrypted_user_access_token=encrypt_token(test_plain_token),
                encrypted_refresh_token=encrypt_token(test_plain_refresh),
                user_token_expires_at=datetime.now(timezone.utc) + timedelta(hours=2),
                refresh_token_expires_at=datetime.now(timezone.utc) + timedelta(days=30),
            )
            session.add(test_user)
            await session.commit()
            await session.refresh(test_user)
            test_user_id = test_user.id

        session_cookie = create_session_cookie_value(test_user_id)
        auth_cookies = {settings.session_cookie_name: session_cookie}

        try:
            # ─────────────────────────────────────────────────────────────
            # 1. /github/installations without session -> 401
            # ─────────────────────────────────────────────────────────────
            print("\n--- [Test 1: /github/installations without session -> 401] ---")
            r1 = await client.get("/api/v1/github/installations")
            print(f"Status unauthenticated: {r1.status_code}")
            assert r1.status_code == 401
            print("✓ PASS: 401 on unauthenticated installations request.")

            # ─────────────────────────────────────────────────────────────
            # 2. User with zero installations -> 200 empty
            # ─────────────────────────────────────────────────────────────
            print("\n--- [Test 2: Zero installations -> 200 empty] ---")
            with patch("app.services.github_installations.fetch_user_installations", new=AsyncMock(return_value=[])):
                r2 = await client.get("/api/v1/github/installations", cookies=auth_cookies)
                print(f"Status: {r2.status_code}, data: {r2.json()}")
                assert r2.status_code == 200
                data2 = r2.json()
                assert data2["installations"] == []
                assert data2["install_url"] == "https://github.com/apps/codeworld-dev-test/installations/new"
                print("✓ PASS: Zero installations returns empty list + valid install_url.")

            # ─────────────────────────────────────────────────────────────
            # 3. Existing installation -> correct DTO
            # ─────────────────────────────────────────────────────────────
            print("\n--- [Test 3: Existing installation DTO] ---")
            mock_insts = [
                {
                    "id": 554433,
                    "account_login": "discovery-tester",
                    "account_type": "User",
                    "repository_selection": "selected",
                }
            ]
            with patch("app.services.github_installations.fetch_user_installations", new=AsyncMock(return_value=mock_insts)):
                r3 = await client.get("/api/v1/github/installations", cookies=auth_cookies)
                assert r3.status_code == 200
                data3 = r3.json()
                assert len(data3["installations"]) == 1
                inst = data3["installations"][0]
                assert inst["id"] == 554433
                assert inst["account_login"] == "discovery-tester"
                assert inst["account_type"] == "User"
                assert inst["repository_selection"] == "selected"
                assert data3["install_url"] == "https://github.com/apps/codeworld-dev-test/installations/new"
                print("✓ PASS: Installation DTO mapped cleanly without raw GitHub fields.")

            # ─────────────────────────────────────────────────────────────
            # 4. /github/repositories with zero installations -> 200 empty
            # ─────────────────────────────────────────────────────────────
            print("\n--- [Test 4: /github/repositories zero installations] ---")
            with patch("app.services.github_installations.fetch_user_installations", new=AsyncMock(return_value=[])):
                r4 = await client.get("/api/v1/github/repositories", cookies=auth_cookies)
                assert r4.status_code == 200
                assert r4.json()["repositories"] == []
                print("✓ PASS: /github/repositories with 0 installations returns empty list.")

            # ─────────────────────────────────────────────────────────────
            # 5. /github/repositories with 1 installation + repos -> correct DTO & privacy
            # ─────────────────────────────────────────────────────────────
            print("\n--- [Test 5: 1 installation + repositories DTO] ---")
            mock_repos_inst1 = [
                {
                    "id": 101,
                    "installation_id": 554433,
                    "owner": "discovery-tester",
                    "name": "public-project",
                    "full_name": "discovery-tester/public-project",
                    "private": False,
                    "html_url": "https://github.com/discovery-tester/public-project",
                    "default_branch": "main",
                },
                {
                    "id": 102,
                    "installation_id": 554433,
                    "owner": "discovery-tester",
                    "name": "secret-project",
                    "full_name": "discovery-tester/secret-project",
                    "private": True,
                    "html_url": "https://github.com/discovery-tester/secret-project",
                    "default_branch": "master",
                },
            ]
            with patch("app.services.github_installations.fetch_user_installations", new=AsyncMock(return_value=mock_insts)), \
                 patch("app.services.github_installations.fetch_installation_repositories", new=AsyncMock(return_value=mock_repos_inst1)):
                r5 = await client.get("/api/v1/github/repositories", cookies=auth_cookies)
                assert r5.status_code == 200
                data5 = r5.json()
                repos = data5["repositories"]
                assert len(repos) == 2
                assert repos[0]["name"] == "public-project"
                assert repos[0]["private"] is False
                assert repos[0]["installation_id"] == 554433
                assert repos[1]["name"] == "secret-project"
                assert repos[1]["private"] is True
                assert repos[1]["default_branch"] == "master"
                print("✓ PASS: Repositories DTO correctly represents public and private projects.")

            # ─────────────────────────────────────────────────────────────
            # 6. Multiple installations -> clean aggregation
            # ─────────────────────────────────────────────────────────────
            print("\n--- [Test 6: Multiple installations aggregation] ---")
            mock_multi_insts = [
                {"id": 111, "account_login": "discovery-user", "account_type": "User", "repository_selection": "selected"},
                {"id": 222, "account_login": "discovery-org", "account_type": "Organization", "repository_selection": "all"},
            ]
            async def _fake_inst_repos(installation_id, access_token, client=None):
                if installation_id == 111:
                    return [
                        {"id": 1, "installation_id": 111, "owner": "discovery-user", "name": "user-repo-1", "full_name": "discovery-user/user-repo-1", "private": False, "html_url": "...", "default_branch": "main"},
                    ]
                else:
                    return [
                        {"id": 2, "installation_id": 222, "owner": "discovery-org", "name": "org-repo-1", "full_name": "discovery-org/org-repo-1", "private": True, "html_url": "...", "default_branch": "main"},
                        {"id": 3, "installation_id": 222, "owner": "discovery-org", "name": "org-repo-2", "full_name": "discovery-org/org-repo-2", "private": False, "html_url": "...", "default_branch": "dev"},
                    ]

            with patch("app.services.github_installations.fetch_user_installations", new=AsyncMock(return_value=mock_multi_insts)), \
                 patch("app.services.github_installations.fetch_installation_repositories", new=_fake_inst_repos):
                r6 = await client.get("/api/v1/github/repositories", cookies=auth_cookies)
                assert r6.status_code == 200
                data6 = r6.json()["repositories"]
                assert len(data6) == 3
                inst_ids = [r["installation_id"] for r in data6]
                assert 111 in inst_ids and 222 in inst_ids
                print("✓ PASS: Multiple installations aggregated properly with respective installation IDs.")

            # ─────────────────────────────────────────────────────────────
            # 7. Pagination (>100 repositories)
            # ─────────────────────────────────────────────────────────────
            print("\n--- [Test 7: Pagination handling (>100 repositories)] ---")
            # Test actual fetch_installation_repositories pagination loop using mock http responses
            page1_items = [{"id": i, "name": f"repo-{i}", "full_name": f"org/repo-{i}", "private": False} for i in range(1, 101)]
            page2_items = [{"id": i, "name": f"repo-{i}", "full_name": f"org/repo-{i}", "private": False} for i in range(101, 141)]

            async def _fake_paged_get(url, params=None, headers=None, **kwargs):
                page = params.get("page", 1) if params else 1
                if page == 1:
                    return httpx.Response(200, json={"total_count": 140, "repositories": page1_items})
                elif page == 2:
                    return httpx.Response(200, json={"total_count": 140, "repositories": page2_items})
                return httpx.Response(200, json={"total_count": 140, "repositories": []})

            mock_http_client = AsyncMock()
            mock_http_client.get = _fake_paged_get

            from app.services.github_installations import fetch_installation_repositories
            paged_repos = await fetch_installation_repositories(installation_id=999, access_token="test_token", client=mock_http_client)
            print(f"Total repositories fetched across pages: {len(paged_repos)}")
            assert len(paged_repos) == 140
            assert paged_repos[0]["id"] == 1
            assert paged_repos[-1]["id"] == 140
            print("✓ PASS: Pagination fetched 140 repos across 2 pages seamlessly.")

            # ─────────────────────────────────────────────────────────────
            # 8. Expired user token -> triggers refresh lifecycle
            # ─────────────────────────────────────────────────────────────
            print("\n--- [Test 8: Expired token refresh lifecycle] ---")
            async with AsyncSessionLocal() as session:
                res = await session.execute(select(User).where(User.id == test_user_id))
                u = res.scalars().first()
                u.user_token_expires_at = datetime.now(timezone.utc) - timedelta(minutes=5)
                await session.commit()

            refreshed_tokens = {
                "access_token": "ghu_RefreshedDiscoveryToken999",
                "refresh_token": "ghr_RefreshedDiscoveryToken999",
                "expires_in": 28800,
                "refresh_token_expires_in": 15811200,
            }
            with patch("app.services.github_auth.refresh_github_user_token", new=AsyncMock(return_value=refreshed_tokens)), \
                 patch("app.services.github_installations.fetch_user_installations", new=AsyncMock(return_value=[])):
                r8 = await client.get("/api/v1/github/installations", cookies=auth_cookies)
                assert r8.status_code == 200

                async with AsyncSessionLocal() as session:
                    res = await session.execute(select(User).where(User.id == test_user_id))
                    u_refreshed = res.scalars().first()
                    assert decrypt_token(u_refreshed.encrypted_user_access_token) == "ghu_RefreshedDiscoveryToken999"
                    assert u_refreshed.user_token_expires_at > datetime.now(timezone.utc)
                    print("  Verified access token was transparently refreshed and persisted in DB.")
            print("✓ PASS: Expired token is refreshed transparently before GitHub API calls.")

            # ─────────────────────────────────────────────────────────────
            # 9. GitHub 401 / Revoked -> Controlled 401 re-auth response
            # ─────────────────────────────────────────────────────────────
            print("\n--- [Test 9: GitHub 401 / Revoked Token] ---")
            async def _fake_revoked_get(url, **kwargs):
                return httpx.Response(401, json={"message": "Bad credentials"})

            mock_revoked_client = AsyncMock()
            mock_revoked_client.get = _fake_revoked_get
            mock_revoked_client.__aenter__.return_value = mock_revoked_client
            mock_revoked_client.__aexit__.return_value = None

            with patch("app.services.github_installations.httpx.AsyncClient", return_value=mock_revoked_client):
                r9 = await client.get("/api/v1/github/installations", cookies=auth_cookies)
                print(f"Revoked token status: {r9.status_code}, body: {r9.json()}")
                assert r9.status_code == 401
                assert "re-authenticate" in r9.json()["detail"].lower() or "invalid" in r9.json()["detail"].lower()
            print("✓ PASS: GitHub 401 returns controlled 401 re-authentication required.")

            # ─────────────────────────────────────────────────────────────
            # 10. Security: No tokens in responses
            # ─────────────────────────────────────────────────────────────
            print("\n--- [Test 10: Token Leakage Check] ---")
            with patch("app.services.github_installations.fetch_user_installations", new=AsyncMock(return_value=mock_insts)), \
                 patch("app.services.github_installations.fetch_installation_repositories", new=AsyncMock(return_value=mock_repos_inst1)):
                resp_inst = await client.get("/api/v1/github/installations", cookies=auth_cookies)
                resp_repos = await client.get("/api/v1/github/repositories", cookies=auth_cookies)

                for r in [resp_inst, resp_repos]:
                    text = r.text
                    assert "ghu_" not in text
                    assert "ghr_" not in text
                    assert "access_token" not in text
                    assert "encrypted" not in text
            print("✓ PASS: No tokens or internal secrets leaked in responses.")

            # ─────────────────────────────────────────────────────────────
            # 11. Regressions
            # ─────────────────────────────────────────────────────────────
            print("\n--- [Test 11: Regression Checks] ---")
            h_res = await client.get("/api/v1/health")
            assert h_res.status_code == 200
            assert h_res.json()["status"] == "ok"
            print("✓ /health: 200 OK")

            f_res = await client.post("/api/v1/repositories", json={"url": "https://github.com/tiangolo/fastapi"})
            assert f_res.status_code == 200
            assert f_res.json()["status"] == "ready"
            print("✓ POST /repositories: 200 ready")

            c_res = await client.get("/api/v1/cities/2e945127-9c5d-4b5a-a0d9-9d52e2cbadfe")
            assert c_res.status_code == 200
            assert len(c_res.json()["buildings"]) > 0
            print("✓ GET /cities/{id}: 200 OK")

            me_res = await client.get("/api/v1/auth/me", cookies=auth_cookies)
            assert me_res.status_code == 200
            assert me_res.json()["github_user_id"] == test_gh_user_id
            print("✓ GET /auth/me: 200 OK")

            print("\n==================================================================")
            print("     ALL CHECKPOINT 5.4 DISCOVERY TESTS PASSED!                  ")
            print("==================================================================")

        finally:
            settings.github_app_slug = orig_slug
            # Cleanup test user from DB
            if test_user_id:
                async with AsyncSessionLocal() as session:
                    res = await session.execute(select(User).where(User.id == test_user_id))
                    u = res.scalars().first()
                    if u:
                        await session.delete(u)
                        await session.commit()


if __name__ == "__main__":
    asyncio.run(run_discovery_tests())
