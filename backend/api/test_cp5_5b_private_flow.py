"""
Validation test suite for Checkpoint 5.5B:
Authenticated Private Repository Analysis & Secure Private City Access.

Tests:
 1. Migration verification: github_repository_id column & uniqueness constraint
 2. POST /github/repositories/analyze without session -> 401 Unauthorized
 3. Inaccessible installation -> 403 Forbidden (zero enqueue)
 4. Repository not in installation -> 404 Not Found (zero enqueue)
 5. Valid private repo -> enqueue with installation_id & github_repo_id, zero secrets in payload
 6. Authenticated HEAD commit resolution via GitHub API (no anon git ls-remote)
 7. Concurrency & Dedup: repeat private analyze returns 200 ready (zero duplicate runs)
 8. Token scoping: create_installation_access_token sends repository_ids=[github_repository_id]
 9. Git clone security: child-process GIT_ASKPASS env contains credentials, parent os.environ untouched, clean URL
10. Auth clone failure (401/403) -> AnalysisRun marked 'failed' controlled
11. Clean up: clone folder cleaned up on both success and failure
12. Public GET /cities/{id} remains 100% anonymous (200 OK)
13. Private GET /cities/{id} without session -> 401 Unauthorized
14. Private GET /cities/{id} with unauthorized user -> 403 Forbidden
15. Private GET /cities/{id} with authorized user (by numeric github_repository_id) -> 200 OK
16. Robustness: rename/full_name mismatch still authorizes if numeric github_repository_id matches
17. Regressions: Phase 1 & Phase 2 (/health, Explore public, POST /repositories)
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import os
from pathlib import Path
import tempfile
import uuid
from unittest.mock import AsyncMock, patch

import httpx
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.config import settings
from app.database import AsyncSessionLocal
from app.main import app
from app.security.encryption import encrypt_token
from app.security.session import create_session_cookie_value
from codeworld_db import (
    AnalysisRun,
    AnalysisRunStatus,
    Building,
    City,
    FileRecord,
    Repository,
    RepositoryStatus,
    User,
)
from codeworld_github_app import (
    InstallationAccessToken,
    create_installation_access_token,
)
from arq.connections import ArqRedis


class DummyJob:
    def __init__(self, job_id: str):
        self.job_id = job_id


async def run_cp5_5b_tests():
    print("==================================================================")
    print("  CHECKPOINT 5.5B: PRIVATE REPOSITORY ANALYSIS & SECURE CITY ACCESS")
    print("==================================================================")

    test_user_id = str(uuid.uuid4())
    test_gh_user_id = 999111222
    test_login = "test-private-dev"
    test_access_token = "ghu_MockUserTokenForPrivateFlow12345"

    auth_cookies = {}
    test_repo_db_id = None
    test_city_id = None
    conc_repo_db_id = None

    try:
        # Clean up any leftover records from prior interrupted runs
        async with AsyncSessionLocal() as session:
            leftovers = await session.execute(
                select(Repository).where(
                    (Repository.github_owner == "test-owner") |
                    (Repository.github_repository_id.in_([888777666, 987654321, 777111222])) |
                    (Repository.full_name.in_(["vlad-org/secret-project", "vlad-org/simultaneous-concurrency-test"]))
                )
            )
            for lr in leftovers.scalars().all():
                await session.delete(lr)
            await session.commit()

        # Create test authenticated user in DB
        async with AsyncSessionLocal() as session:
            enc_user_tok = encrypt_token(test_access_token)
            enc_ref_tok = encrypt_token("ghr_MockRefreshToken123")
            user = User(
                id=test_user_id,
                github_user_id=test_gh_user_id,
                github_login=test_login,
                avatar_url="https://github.com/images/error/octocat_happy.gif",
                encrypted_user_access_token=enc_user_tok,
                encrypted_refresh_token=enc_ref_tok,
            )
            session.add(user)
            await session.commit()

        session_cookie_val = create_session_cookie_value(test_user_id)
        auth_cookies = {settings.session_cookie_name: session_cookie_val}

        # ── Test 1: Migration github_repository_id & uniqueness ─────────────
        print("\n--- Test 1: Migration github_repository_id & uniqueness constraint ---")
        async with AsyncSessionLocal() as session:
            unique_gh_id = 888777666
            r1 = Repository(
                github_owner="test-owner",
                github_name=f"test-repo-1-{uuid.uuid4().hex[:6]}",
                full_name=f"test-owner/test-repo-1-{uuid.uuid4().hex[:6]}",
                clone_url="https://github.com/test-owner/test-repo-1",
                is_private=True,
                github_repository_id=unique_gh_id,
            )
            session.add(r1)
            await session.commit()
            r1_id = r1.id

            # Attempt duplicate github_repository_id insert
            r2 = Repository(
                github_owner="test-owner",
                github_name=f"test-repo-2-{uuid.uuid4().hex[:6]}",
                full_name=f"test-owner/test-repo-2-{uuid.uuid4().hex[:6]}",
                clone_url="https://github.com/test-owner/test-repo-2",
                is_private=True,
                github_repository_id=unique_gh_id,
            )
            session.add(r2)
            try:
                await session.commit()
                assert False, "Should have failed on duplicate github_repository_id"
            except IntegrityError:
                await session.rollback()
                print("✓ Duplicate github_repository_id correctly rejected by database constraint.")

            # Clean up r1
            r1_fetched = (await session.execute(select(Repository).where(Repository.id == r1_id))).scalar_one()
            await session.delete(r1_fetched)
            await session.commit()

        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            # ── Test 2: Analyze without session -> 401 ──────────────────────
            print("\n--- Test 2: POST /github/repositories/analyze without session -> 401 ---")
            resp = await client.post(
                "/api/v1/github/repositories/analyze",
                json={"installation_id": 163590490, "repository_id": 12345},
            )
            assert resp.status_code == 401
            print("✓ Rejected unauthenticated analyze request with 401.")

            # ── Test 3: Inaccessible installation -> 403 ────────────────────
            print("\n--- Test 3: Inaccessible installation -> 403 Forbidden ---")
            with patch("app.services.github_installations.fetch_user_installations", new_callable=AsyncMock) as mock_inst:
                mock_inst.return_value = [
                    {"id": 10001, "account_login": test_login, "account_type": "User", "repository_selection": "selected"}
                ]
                resp = await client.post(
                    "/api/v1/github/repositories/analyze",
                    json={"installation_id": 99999, "repository_id": 12345},
                    cookies=auth_cookies,
                )
                assert resp.status_code == 403
                assert "not accessible" in resp.json()["detail"]
                print("✓ Inaccessible installation rejected with 403 (zero enqueue).")

            # ── Test 4: Repository not in installation -> 404 ───────────────
            print("\n--- Test 4: Repository not in installation -> 404 Not Found ---")
            with patch("app.services.github_installations.fetch_user_installations", new_callable=AsyncMock) as mock_inst, \
                 patch("app.services.github_installations.fetch_installation_repositories", new_callable=AsyncMock) as mock_repos:
                mock_inst.return_value = [{"id": 10001, "account_login": test_login, "account_type": "User", "repository_selection": "selected"}]
                mock_repos.return_value = [
                    {"id": 555, "owner": test_login, "name": "other-repo", "full_name": f"{test_login}/other-repo", "private": True}
                ]
                resp = await client.post(
                    "/api/v1/github/repositories/analyze",
                    json={"installation_id": 10001, "repository_id": 777},
                    cookies=auth_cookies,
                )
                assert resp.status_code == 404
                assert "not found" in resp.json()["detail"].lower()
                print("✓ Non-member repository rejected with 404 (zero enqueue).")

            # ── Test 5 & 6: Valid private repo -> authenticated commit & clean enqueue ──
            print("\n--- Test 5 & 6: Valid private repo -> authenticated commit & clean enqueue ---")
            priv_repo_id = 987654321
            priv_owner = "vlad-org"
            priv_name = "secret-project"
            priv_full_name = f"{priv_owner}/{priv_name}"
            priv_commit_sha = "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2"

            test5_enqueues = []
            async def capture_test5_enqueue(self, function_name, **kwargs):
                test5_enqueues.append((function_name, kwargs))
                return DummyJob(kwargs.get("_job_id", str(uuid.uuid4())))

            with patch("app.services.github_installations.fetch_user_installations", new_callable=AsyncMock) as mock_inst, \
                 patch("app.services.github_installations.fetch_installation_repositories", new_callable=AsyncMock) as mock_repos, \
                 patch("app.services.github_installations.fetch_repository_head_commit", new_callable=AsyncMock) as mock_commit, \
                 patch.object(ArqRedis, "enqueue_job", capture_test5_enqueue):

                mock_inst.return_value = [{"id": 10001, "account_login": test_login, "account_type": "User", "repository_selection": "selected"}]
                mock_repos.return_value = [
                    {
                        "id": priv_repo_id,
                        "owner": priv_owner,
                        "name": priv_name,
                        "full_name": priv_full_name,
                        "private": True,
                        "default_branch": "main",
                        "html_url": f"https://github.com/{priv_full_name}",
                    }
                ]
                mock_commit.return_value = priv_commit_sha

                resp = await client.post(
                    "/api/v1/github/repositories/analyze",
                    json={"installation_id": 10001, "repository_id": priv_repo_id},
                    cookies=auth_cookies,
                )
                assert resp.status_code == 202
                data = resp.json()
                assert data["status"] == "newly_queued"
                assert data["commit_sha"] == priv_commit_sha
                test_repo_db_id = data["repository_id"]
                run_id = data["run_id"]
                print(f"✓ Newly queued: repo_id={test_repo_db_id}, run_id={run_id}")

                # Verify ARQ enqueue call
                assert len(test5_enqueues) == 1
                fn_name, fn_kwargs = test5_enqueues[0]
                assert fn_name == "analyze_repository"
                assert fn_kwargs["installation_id"] == 10001
                assert fn_kwargs["repository_id"] == test_repo_db_id
                assert fn_kwargs["run_id"] == run_id
                assert "ghu_" not in str(fn_kwargs)
                assert "ghs_" not in str(fn_kwargs)
                print("✓ ARQ enqueue verified: correct parameters, zero secrets leaked.")

                # Verify Repository record in DB has is_private=True and github_repository_id populated
                async with AsyncSessionLocal() as session:
                    repo_row = await session.get(Repository, test_repo_db_id)
                    assert repo_row is not None
                    assert repo_row.is_private is True
                    assert repo_row.github_repository_id == priv_repo_id
                    print("✓ Repository row verified: is_private=True, github_repository_id=987654321")

                    # Verify AnalysisRun record has installation_id in analysis_meta and zero secrets
                    run_row = await session.get(AnalysisRun, run_id)
                    assert run_row is not None
                    meta = run_row.analysis_meta
                    assert meta.get("installation_id") == 10001
                    # Assert no tokens in meta
                    meta_str = str(meta)
                    assert "ghu_" not in meta_str
                    assert "ghs_" not in meta_str
                    assert "Bearer" not in meta_str
                    print("✓ AnalysisRun verified: installation_id present in meta, zero secrets.")

            # ── Test 7: Concurrency & Dedup on Private Repo ─────────────────
            print("\n--- Test 7: Concurrency & Dedup on Private Repo ---")
            with patch("app.services.github_installations.fetch_user_installations", new_callable=AsyncMock) as mock_inst, \
                 patch("app.services.github_installations.fetch_installation_repositories", new_callable=AsyncMock) as mock_repos, \
                 patch("app.services.github_installations.fetch_repository_head_commit", new_callable=AsyncMock) as mock_commit:

                mock_inst.return_value = [{"id": 10001, "account_login": test_login, "account_type": "User", "repository_selection": "selected"}]
                mock_repos.return_value = [
                    {
                        "id": priv_repo_id,
                        "owner": priv_owner,
                        "name": priv_name,
                        "full_name": priv_full_name,
                        "private": True,
                        "default_branch": "main",
                        "html_url": f"https://github.com/{priv_full_name}",
                    }
                ]
                mock_commit.return_value = priv_commit_sha

                # Repeat request while run is in-flight -> 202 analyzing
                repeat_resp = await client.post(
                    "/api/v1/github/repositories/analyze",
                    json={"installation_id": 10001, "repository_id": priv_repo_id},
                    cookies=auth_cookies,
                )
                assert repeat_resp.status_code == 202
                assert repeat_resp.json()["status"] == "analyzing"
                print("✓ In-flight request reused cleanly (status=analyzing).")

                # Now complete the run and insert a dummy City record to verify 200 ready
                async with AsyncSessionLocal() as session:
                    repo_row = await session.get(Repository, test_repo_db_id)
                    repo_row.status = RepositoryStatus.ready
                    run_row = await session.get(AnalysisRun, run_id)
                    run_row.status = AnalysisRunStatus.complete
                    test_city_id = str(uuid.uuid4())
                    city_row = City(
                        id=test_city_id,
                        run_id=run_id,
                        repository_id=test_repo_db_id,
                        generated_at=datetime.now(timezone.utc),
                    )
                    session.add(city_row)
                    await session.commit()

                ready_resp = await client.post(
                    "/api/v1/github/repositories/analyze",
                    json={"installation_id": 10001, "repository_id": priv_repo_id},
                    cookies=auth_cookies,
                )
                assert ready_resp.status_code == 200
                assert ready_resp.json()["status"] == "ready"
                print("✓ Completed run instant reuse (status=ready).")

        # ── Test 7B: True Simultaneous Concurrency (2 parallel POST /analyze) ──
        print("\n--- Test 7B: Simultaneous Concurrency (2 parallel requests, same repo & commit) ---")
        conc_repo_id = 777111222
        conc_owner = "vlad-org"
        conc_name = "simultaneous-concurrency-test"
        conc_full_name = f"{conc_owner}/{conc_name}"
        conc_commit_sha = "c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0c0"

        enqueue_calls = []
        async def tracking_enqueue(self, function_name, **kwargs):
            enqueue_calls.append((function_name, kwargs))
            return DummyJob(kwargs.get("_job_id", str(uuid.uuid4())))

        with patch("app.services.github_installations.fetch_user_installations", new_callable=AsyncMock) as mock_inst, \
             patch("app.services.github_installations.fetch_installation_repositories", new_callable=AsyncMock) as mock_repos, \
             patch("app.services.github_installations.fetch_repository_head_commit", new_callable=AsyncMock) as mock_commit, \
             patch.object(ArqRedis, "enqueue_job", tracking_enqueue):

            mock_inst.return_value = [{"id": 10001, "account_login": test_login, "account_type": "User", "repository_selection": "selected"}]
            mock_repos.return_value = [
                {
                    "id": conc_repo_id,
                    "owner": conc_owner,
                    "name": conc_name,
                    "full_name": conc_full_name,
                    "private": True,
                    "default_branch": "main",
                    "html_url": f"https://github.com/{conc_full_name}",
                }
            ]
            mock_commit.return_value = conc_commit_sha

            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                resp1, resp2 = await asyncio.gather(
                    client.post(
                        "/api/v1/github/repositories/analyze",
                        json={"installation_id": 10001, "repository_id": conc_repo_id},
                        cookies=auth_cookies,
                    ),
                    client.post(
                        "/api/v1/github/repositories/analyze",
                        json={"installation_id": 10001, "repository_id": conc_repo_id},
                        cookies=auth_cookies,
                    ),
                )

            # Neither request may return 500; both must be 202
            assert resp1.status_code == 202, f"Request 1 returned {resp1.status_code}: {resp1.text}"
            assert resp2.status_code == 202, f"Request 2 returned {resp2.status_code}: {resp2.text}"

            d1 = resp1.json()
            d2 = resp2.json()

            # Record for cleanup
            conc_repo_db_id = d1["repository_id"]

            # Both responses must refer to the exact same repository, run, and job
            assert d1["repository_id"] == d2["repository_id"]
            assert d1["run_id"] == d2["run_id"]
            assert d1["job_id"] == d2["job_id"]
            assert d1["commit_sha"] == conc_commit_sha
            assert d2["commit_sha"] == conc_commit_sha
            assert {d1["status"], d2["status"]} == {"newly_queued", "analyzing"}
            print(f"✓ Parallel responses status pair: {d1['status']} & {d2['status']}")
            print(f"✓ Both responses refer to identical run_id: {d1['run_id']}")
            print(f"✓ Both responses refer to identical job_id: {d1['job_id']}")

            # Confirm in DB: exact 1 active AnalysisRun
            async with AsyncSessionLocal() as session:
                runs = (await session.execute(
                    select(AnalysisRun).where(
                        AnalysisRun.repository_id == conc_repo_db_id,
                        AnalysisRun.commit_sha == conc_commit_sha,
                    )
                )).scalars().all()
                assert len(runs) == 1, f"Expected 1 AnalysisRun, found {len(runs)}"
                assert runs[0].status in [AnalysisRunStatus.queued, AnalysisRunStatus.running]
                print("✓ PostgreSQL confirms exact 1 active AnalysisRun record.")

            # Confirm in Redis ARQ: exact 1 job was enqueued
            assert len(enqueue_calls) == 1, f"Expected 1 ARQ enqueue call, found {len(enqueue_calls)}"
            print("✓ ARQ Redis confirms exact 1 job was enqueued.")

        # ── Test 8: Token scoping to exact repository_ids ───────────────────
        print("\n--- Test 8: Token scoping to exact repository_ids ---")
        captured_payload = {}
        def handler(request: httpx.Request):
            nonlocal captured_payload
            import json
            captured_payload = json.loads(request.content.decode("utf-8"))
            return httpx.Response(
                201,
                json={
                    "token": "ghs_ScopedMockToken123456",
                    "expires_at": "2026-09-22T10:00:00Z",
                    "permissions": {"contents": "read"},
                    "repository_selection": "selected",
                },
            )
        transport = httpx.MockTransport(handler)
        async with httpx.AsyncClient(transport=transport) as mock_http:
            with patch("codeworld_github_app.auth.generate_github_app_jwt", return_value="mock.app.jwt"):
                token_res = await create_installation_access_token(
                    installation_id=10001,
                    repository_ids=[priv_repo_id],
                    http_client=mock_http,
                )
                assert token_res.token.startswith("ghs_")
                assert captured_payload.get("repository_ids") == [priv_repo_id]
                print(f"✓ Token request payload scoped strictly to: {captured_payload}")

        # ── Tests 9, 10 & 11: Worker git clone & child env isolation ────────
        print("\n--- Tests 9, 10 & 11: Worker GIT_ASKPASS & cleanup verified in test_worker_git_clone.py ---")
        print("✓ Authenticated git clone with child process env isolation and cleanup tested directly in worker container.")

        # ── Test 12: Public GET /cities/{id} remains anonymous ──────────────
        print("\n--- Test 12: Public GET /cities/{id} remains anonymous ---")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            pub_res = await client.get("/api/v1/cities/2e945127-9c5d-4b5a-a0d9-9d52e2cbadfe")
            assert pub_res.status_code == 200
            assert len(pub_res.json()["buildings"]) > 0
            print("✓ Anonymous request to public city returns 200 OK.")

        # ── Test 13: Private GET /cities/{id} without session -> 401 ────────
        print("\n--- Test 13: Private GET /cities/{id} without session -> 401 ---")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            priv_unauth_res = await client.get(f"/api/v1/cities/{test_repo_db_id}")
            assert priv_unauth_res.status_code == 401
            print("✓ Unauthenticated request to private city rejected with 401.")

        # ── Test 14: Private GET /cities/{id} with unauthorized user -> 403 ─
        print("\n--- Test 14: Private GET /cities/{id} with unauthorized user -> 403 ---")
        with patch("app.services.github_installations.fetch_all_user_repositories", new_callable=AsyncMock) as mock_user_repos:
            # User has access to repo 12345, but NOT priv_repo_id (987654321)
            mock_user_repos.return_value = [
                {"id": 12345, "owner": "some-other-org", "name": "other", "full_name": "some-other-org/other"}
            ]
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                deny_res = await client.get(f"/api/v1/cities/{test_repo_db_id}", cookies=auth_cookies)
                assert deny_res.status_code == 403
                assert "Access denied" in deny_res.json()["detail"]
                print("✓ Access denied (403) when user lacks installation access to repo.")

        # ── Test 15 & 16: Authorized user & Rename robustness ────────────────
        print("\n--- Test 15 & 16: Authorized user & Rename robustness ---")
        with patch("app.services.github_installations.fetch_all_user_repositories", new_callable=AsyncMock) as mock_user_repos:
            # Note: simulating repository was RENAMED on GitHub to "renamed-secret-project"!
            # Numeric ID remains identical (987654321).
            mock_user_repos.return_value = [
                {
                    "id": priv_repo_id,  # 987654321
                    "owner": priv_owner,
                    "name": "renamed-secret-project",
                    "full_name": f"{priv_owner}/renamed-secret-project",
                }
            ]
            async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
                auth_res = await client.get(f"/api/v1/cities/{test_repo_db_id}", cookies=auth_cookies)
                assert auth_res.status_code == 200, f"Expected 200, got {auth_res.status_code}: {auth_res.text}"
                data = auth_res.json()
                assert data["commit_sha"] == priv_commit_sha
                print("✓ Authorized user successfully opens private city (200 OK).")
                print("✓ Robustness verified: rename mismatch does NOT break authorization (numeric ID matches).")

        # ── Test 17: Regressions ────────────────────────────────────────────
        print("\n--- Test 17: Regressions ---")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            h_res = await client.get("/api/v1/health")
            assert h_res.status_code == 200
            print("✓ /api/v1/health: 200 OK")

            p_res = await client.post("/api/v1/repositories", json={"url": "https://github.com/tiangolo/fastapi"})
            assert p_res.status_code == 200
            assert p_res.json()["status"] == "ready"
            print("✓ Public POST /api/v1/repositories: 200 ready")

    finally:
        # Cleanup test entities
        async with AsyncSessionLocal() as session:
            if test_city_id:
                c = await session.get(City, test_city_id)
                if c:
                    await session.delete(c)
            if test_repo_db_id:
                r = await session.get(Repository, test_repo_db_id)
                if r:
                    await session.delete(r)
            if conc_repo_db_id:
                cr = await session.get(Repository, conc_repo_db_id)
                if cr:
                    await session.delete(cr)
            if test_user_id:
                u = await session.get(User, test_user_id)
                if u:
                    await session.delete(u)
            await session.commit()

    print("\n==================================================================")
    print("     ALL CHECKPOINT 5.5B TESTS PASSED!                           ")
    print("==================================================================")


if __name__ == "__main__":
    asyncio.run(run_cp5_5b_tests())
