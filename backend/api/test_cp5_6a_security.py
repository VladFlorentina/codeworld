"""
Test suite for Checkpoint 5.6A: Backend Security & Authorization.

Verifies:
  1. Public repository anonymous -> 200 OK
  2. Private repository anonymous -> 401 Unauthorized
  3. Private repository invalid/expired session -> 401 Unauthorized
  4. Private repository user without access -> 403 Forbidden
  5. Private repository authorized user -> 200 OK
  6. Public job anonymous -> 200 OK
  7. Private job anonymous -> 401 Unauthorized (zero leak of error or metadata)
  8. Private job user without access -> 403 Forbidden (zero leak)
  9. Private job authorized user -> 200 OK (normal response with status & error)
 10. Private City anonymous -> 401 Unauthorized
 11. Private City user without access -> 403 Forbidden
 12. Private City authorized user -> 200 OK (preserves CP5.5B behavior)
 13. Non-existent repository / job -> 404 Not Found
 14. CORS allowlist: http://127.0.0.1:3000 and http://localhost:3000 with credentials
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import uuid
from unittest.mock import AsyncMock, patch

import httpx
from sqlalchemy import select

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
    District,
    FileRecord,
    Repository,
    RepositoryStatus,
    User,
)


async def run_cp5_6a_security_tests():
    print("==================================================================")
    print("  CHECKPOINT 5.6A: BACKEND SECURITY & ACCESS AUTHORIZATION TESTS")
    print("==================================================================")

    # Clean IDs for test resources
    auth_user_id = str(uuid.uuid4())
    unauth_user_id = str(uuid.uuid4())
    pub_repo_id = str(uuid.uuid4())
    priv_repo_id = str(uuid.uuid4())
    pub_job_id = f"pub-job-{uuid.uuid4().hex[:8]}"
    priv_job_id = f"priv-job-{uuid.uuid4().hex[:8]}"
    pub_run_id = str(uuid.uuid4())
    priv_run_id = str(uuid.uuid4())
    priv_city_run_id = str(uuid.uuid4())
    priv_city_id = str(uuid.uuid4())

    gh_repo_priv_id = 888001
    gh_repo_other_id = 777001

    auth_cookie_val = create_session_cookie_value(auth_user_id)
    unauth_cookie_val = create_session_cookie_value(unauth_user_id)
    auth_cookies = {settings.session_cookie_name: auth_cookie_val}
    unauth_cookies = {settings.session_cookie_name: unauth_cookie_val}
    bad_cookies = {settings.session_cookie_name: "invalid.session.token"}

    now = datetime.now(timezone.utc)

    # 1. Setup DB records
    async with AsyncSessionLocal() as session:
        # Authorized user (has access to gh_repo_priv_id)
        user_auth = User(
            id=auth_user_id,
            github_user_id=888111,
            github_login="authorized-dev",
            encrypted_user_access_token=encrypt_token("ghu_auth_token_123"),
            user_token_expires_at=now.replace(year=now.year + 1),
        )
        # Unauthorized user (does NOT have access to gh_repo_priv_id)
        user_unauth = User(
            id=unauth_user_id,
            github_user_id=777111,
            github_login="unauthorized-dev",
            encrypted_user_access_token=encrypt_token("ghu_unauth_token_456"),
            user_token_expires_at=now.replace(year=now.year + 1),
        )
        # Public repository
        pub_repo = Repository(
            id=pub_repo_id,
            github_owner="public-owner",
            github_name="public-repo",
            full_name="public-owner/public-repo",
            clone_url="https://github.com/public-owner/public-repo",
            is_private=False,
            status=RepositoryStatus.ready,
        )
        # Private repository
        priv_repo = Repository(
            id=priv_repo_id,
            github_owner="private-owner",
            github_name="private-repo",
            full_name="private-owner/private-repo",
            clone_url="https://github.com/private-owner/private-repo",
            is_private=True,
            github_repository_id=gh_repo_priv_id,
            status=RepositoryStatus.ready,
        )
        # Public AnalysisRun
        pub_run = AnalysisRun(
            id=pub_run_id,
            repository_id=pub_repo_id,
            commit_sha="aaaa111122223333444455556666777788889999",
            status=AnalysisRunStatus.complete,
            analysis_meta={"job_id": pub_job_id},
        )
        # Private AnalysisRun with error message
        priv_run = AnalysisRun(
            id=priv_run_id,
            repository_id=priv_repo_id,
            commit_sha="bbbb111122223333444455556666777788889999",
            status=AnalysisRunStatus.failed,
            error_message="CONFIDENTIAL_TRACEBACK_AND_INTERNAL_ERROR",
            analysis_meta={"job_id": priv_job_id},
        )
        # Private Run for City
        priv_city_run = AnalysisRun(
            id=priv_city_run_id,
            repository_id=priv_repo_id,
            commit_sha="cccc111122223333444455556666777788889999",
            status=AnalysisRunStatus.complete,
            analysis_meta={"job_id": "priv-city-job"},
        )
        priv_city = City(
            id=priv_city_id,
            repository_id=priv_repo_id,
            run_id=priv_city_run_id,
            generated_at=now,
        )
        priv_district = District(
            id=str(uuid.uuid4()),
            city_id=priv_city_id,
            name="core",
            path="core",
            depth=0,
        )

        session.add_all([
            user_auth, user_unauth,
            pub_repo, priv_repo,
            pub_run, priv_run, priv_city_run,
            priv_city, priv_district,
        ])
        await session.commit()
    print("✓ Test database fixtures seeded successfully.")

    # Mock github_installations.fetch_all_user_repositories:
    # If access_token contains "auth_token" -> returns [{"id": 888001, "full_name": "private-owner/private-repo"}]
    # Otherwise -> returns [{"id": 777001, "full_name": "other-owner/other-repo"}]
    async def mock_fetch_all_user_repos(access_token: str, client=None):
        if access_token == "ghu_auth_token_123":
            return [{"id": gh_repo_priv_id, "full_name": "private-owner/private-repo"}]
        return [{"id": gh_repo_other_id, "full_name": "other-owner/other-repo"}]

    try:
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://localhost:8000") as client:
            with patch(
                "app.services.github_installations.fetch_all_user_repositories",
                side_effect=mock_fetch_all_user_repos,
            ):
                # -------------------------------------------------------------
                # 1. GET /api/v1/repositories/{id}
                # -------------------------------------------------------------
                print("\n[Test 1] Public repository anonymous -> 200 OK")
                resp = await client.get(f"/api/v1/repositories/{pub_repo_id}")
                assert resp.status_code == 200, f"Expected 200, got {resp.status_code}"
                data = resp.json()
                assert data["id"] == pub_repo_id
                assert data["full_name"] == "public-owner/public-repo"
                print("✓ Public repository anonymously accessible with full metadata.")

                print("\n[Test 2] Private repository anonymous -> 401 Unauthorized")
                resp = await client.get(f"/api/v1/repositories/{priv_repo_id}")
                assert resp.status_code == 401, f"Expected 401, got {resp.status_code}"
                assert "Authentication required" in resp.json().get("detail", "")
                print("✓ Private repository returns 401 without session cookie.")

                print("\n[Test 3] Private repository invalid session -> 401 Unauthorized")
                resp = await client.get(f"/api/v1/repositories/{priv_repo_id}", cookies=bad_cookies)
                assert resp.status_code == 401, f"Expected 401, got {resp.status_code}"
                print("✓ Private repository returns 401 for corrupted/invalid cookie.")

                print("\n[Test 4] Private repository unauthorized user -> 403 Forbidden")
                resp = await client.get(f"/api/v1/repositories/{priv_repo_id}", cookies=unauth_cookies)
                assert resp.status_code == 403, f"Expected 403, got {resp.status_code}"
                assert "Access denied" in resp.json().get("detail", "")
                print("✓ Private repository returns 403 when user lacks GitHub App access.")

                print("\n[Test 5] Private repository authorized user -> 200 OK")
                resp = await client.get(f"/api/v1/repositories/{priv_repo_id}", cookies=auth_cookies)
                assert resp.status_code == 200, f"Expected 200, got {resp.status_code}"
                data = resp.json()
                assert data["id"] == priv_repo_id
                assert data["full_name"] == "private-owner/private-repo"
                print("✓ Private repository authorized user receives 200 with metadata.")

                # -------------------------------------------------------------
                # 2. GET /api/v1/jobs/{job_id}
                # -------------------------------------------------------------
                print("\n[Test 6] Public job anonymous -> 200 OK")
                resp = await client.get(f"/api/v1/jobs/{pub_job_id}")
                assert resp.status_code == 200, f"Expected 200, got {resp.status_code}"
                data = resp.json()
                assert data["job_id"] == pub_job_id
                assert data["status"] == "complete"
                assert data["repository_id"] == pub_repo_id
                print("✓ Public job status anonymously accessible.")

                print("\n[Test 7] Private job anonymous -> 401 Unauthorized (NO metadata leak)")
                resp = await client.get(f"/api/v1/jobs/{priv_job_id}")
                assert resp.status_code == 401, f"Expected 401, got {resp.status_code}"
                resp_text = resp.text
                assert "CONFIDENTIAL_TRACEBACK_AND_INTERNAL_ERROR" not in resp_text, "Error message leaked!"
                assert priv_repo_id not in resp_text, "Repository ID leaked!"
                assert "status" not in resp.json(), "Job status leaked!"
                print("✓ Private job returns 401 anonymously without leaking error or metadata.")

                print("\n[Test 8] Private job unauthorized user -> 403 Forbidden (NO metadata leak)")
                resp = await client.get(f"/api/v1/jobs/{priv_job_id}", cookies=unauth_cookies)
                assert resp.status_code == 403, f"Expected 403, got {resp.status_code}"
                resp_text = resp.text
                assert "CONFIDENTIAL_TRACEBACK_AND_INTERNAL_ERROR" not in resp_text, "Error message leaked!"
                assert priv_repo_id not in resp_text, "Repository ID leaked!"
                print("✓ Private job returns 403 for unauthorized user without leaking metadata.")

                print("\n[Test 9] Private job authorized user -> 200 OK")
                resp = await client.get(f"/api/v1/jobs/{priv_job_id}", cookies=auth_cookies)
                assert resp.status_code == 200, f"Expected 200, got {resp.status_code}"
                data = resp.json()
                assert data["job_id"] == priv_job_id
                assert data["status"] == "failed"
                assert data["error"] == "Repository analysis failed during pipeline processing."
                assert "CONFIDENTIAL_TRACEBACK" not in resp.text
                assert data["repository_id"] == priv_repo_id
                print("✓ Private job authorized user receives 200 with sanitized error message (no raw traceback).")

                # Also test run_id lookup as fallback for job endpoint
                resp = await client.get(f"/api/v1/jobs/{priv_run_id}", cookies=auth_cookies)
                assert resp.status_code == 200, f"Expected 200 for run_id lookup, got {resp.status_code}"
                assert resp.json()["run_id"] == priv_run_id
                print("✓ Fallback lookup by run_id also correctly authorized.")

                # -------------------------------------------------------------
                # 3. GET /api/v1/cities/{repository_id}
                # -------------------------------------------------------------
                print("\n[Test 10] Private City anonymous -> 401 Unauthorized")
                resp = await client.get(f"/api/v1/cities/{priv_repo_id}")
                assert resp.status_code == 401, f"Expected 401, got {resp.status_code}"
                print("✓ Private City anonymous returns 401.")

                print("\n[Test 11] Private City unauthorized user -> 403 Forbidden")
                resp = await client.get(f"/api/v1/cities/{priv_repo_id}", cookies=unauth_cookies)
                assert resp.status_code == 403, f"Expected 403, got {resp.status_code}"
                print("✓ Private City unauthorized user returns 403.")

                print("\n[Test 12] Private City authorized user -> 200 OK (preserves CP5.5B)")
                resp = await client.get(f"/api/v1/cities/{priv_repo_id}", cookies=auth_cookies)
                assert resp.status_code == 200, f"Expected 200, got {resp.status_code}"
                city_data = resp.json()
                assert city_data["repository_name"] == "private-owner/private-repo"
                assert "districts" in city_data
                print("✓ Private City authorized user receives 200 with complete city representation.")

                # -------------------------------------------------------------
                # 4. Non-existent resources -> 404
                # -------------------------------------------------------------
                print("\n[Test 13] Non-existent repository -> 404 Not Found")
                dummy_id = str(uuid.uuid4())
                resp = await client.get(f"/api/v1/repositories/{dummy_id}", cookies=auth_cookies)
                assert resp.status_code == 404, f"Expected 404, got {resp.status_code}"

                print("\n[Test 14] Non-existent job -> 404 Not Found")
                resp = await client.get("/api/v1/jobs/non-existent-job-xyz", cookies=auth_cookies)
                assert resp.status_code == 404, f"Expected 404, got {resp.status_code}"
                print("✓ Non-existent resources return clean 404.")

                # -------------------------------------------------------------
                # 5. CORS Allowlist
                # -------------------------------------------------------------
                print("\n[Test 15] CORS: http://localhost:3000 and http://127.0.0.1:3000")
                cors_headers_1 = {"Origin": "http://localhost:3000"}
                resp = await client.options(
                    "/api/v1/repositories",
                    headers={
                        "Origin": "http://localhost:3000",
                        "Access-Control-Request-Method": "POST",
                    },
                )
                assert resp.headers.get("access-control-allow-origin") == "http://localhost:3000"
                assert resp.headers.get("access-control-allow-credentials") == "true"

                resp = await client.options(
                    "/api/v1/repositories",
                    headers={
                        "Origin": "http://127.0.0.1:3000",
                        "Access-Control-Request-Method": "POST",
                    },
                )
                assert resp.headers.get("access-control-allow-origin") == "http://127.0.0.1:3000"
                assert resp.headers.get("access-control-allow-credentials") == "true"

                # Disallowed origin should NOT receive allow-origin header
                resp = await client.options(
                    "/api/v1/repositories",
                    headers={
                        "Origin": "http://evil-attacker.com",
                        "Access-Control-Request-Method": "POST",
                    },
                )
                assert resp.headers.get("access-control-allow-origin") is None
                print("✓ CORS correctly configured for localhost:3000 and 127.0.0.1:3000 with credentials.")

    finally:
        # Cleanup seeded DB records
        async with AsyncSessionLocal() as session:
            # Delete city, district, runs, repos, users
            await session.execute(select(District))
            # Clean up directly
            for r_id in [priv_city_run_id, priv_run_id, pub_run_id]:
                r = await session.get(AnalysisRun, r_id)
                if r:
                    await session.delete(r)
            c = await session.get(City, priv_city_id)
            if c:
                await session.delete(c)
            for repo_id in [priv_repo_id, pub_repo_id]:
                rp = await session.get(Repository, repo_id)
                if rp:
                    await session.delete(rp)
            for u_id in [auth_user_id, unauth_user_id]:
                u = await session.get(User, u_id)
                if u:
                    await session.delete(u)
            await session.commit()
        print("✓ Test database cleanup complete.")

    print("\n==================================================================")
    print("  ALL CHECKPOINT 5.6A BACKEND SECURITY TESTS PASSED (15/15)!")
    print("==================================================================")


if __name__ == "__main__":
    asyncio.run(run_cp5_6a_security_tests())
