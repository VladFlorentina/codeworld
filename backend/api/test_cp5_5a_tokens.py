"""
Validation test suite for Checkpoint 5.5A:
GitHub App Private Key + JWT + Installation Access Token (In-Memory).

Tests:
 1. Loader fails when path is not configured (no fallbacks)
 2. Loader fails when file not found
 3. Loader fails when file is empty
 4. Loader fails when file is invalid PEM
 5. Loader fails when key is non-RSA (EC key)
 6. Loader succeeds with valid RSA PEM
 7. JWT generation fails when client_id is missing
 8. JWT generation verifies RS256, claims (iss, iat, exp), and RSA signature
 9. InstallationAccessToken DTO masks token in repr/str (memory-only)
10. Installation token mock exchange 201 Created (verifies headers & DTO)
11. Installation token exchange fails on invalid installation_id
12. Installation token mock exchange 401 Unauthorized
13. Installation token mock exchange 403 Forbidden
14. Installation token mock exchange 404 Not Found
15. Installation token mock exchange 422 Validation Error
16. Phase 1 & Phase 2 Regressions (/health, POST /repositories, GET /cities/{id})
17. Real smoke test (conditional on real key populated on host)
"""
from __future__ import annotations

import asyncio
from datetime import datetime, timezone
import os
from pathlib import Path
import tempfile
import time

from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import ec, rsa
import httpx
import jwt

from app.config import settings
from app.main import app
from app.services.github_app_auth import (
    GitHubAppConfigurationError,
    GitHubInstallationTokenError,
    InstallationAccessToken,
    create_installation_access_token,
    generate_github_app_jwt,
    load_github_app_private_key,
)


def generate_test_rsa_key() -> rsa.RSAPrivateKey:
    return rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
    )


def write_test_rsa_pem(key: rsa.RSAPrivateKey, file_path: Path) -> str:
    pem_bytes = key.private_bytes(
        encoding=serialization.Encoding.PEM,
        format=serialization.PrivateFormat.PKCS8,
        encryption_algorithm=serialization.NoEncryption(),
    )
    file_path.write_bytes(pem_bytes)
    return str(file_path)


async def run_cp5_5a_tests():
    print("==================================================================")
    print("  CHECKPOINT 5.5A: GITHUB APP RSA KEY, JWT & INSTALLATION TOKEN  ")
    print("==================================================================")

    test_key = generate_test_rsa_key()

    with tempfile.TemporaryDirectory() as tmp_dir:
        tmp_path = Path(tmp_dir)
        valid_pem_path = tmp_path / "valid_test_key.pem"
        write_test_rsa_pem(test_key, valid_pem_path)

        # ── Test 1: Loader fails when path not configured ───────────────────
        print("\n--- Test 1: Loader fails when path not configured ---")
        orig_path = settings.github_app_private_key_path
        try:
            settings.github_app_private_key_path = None
            try:
                load_github_app_private_key()
                assert False, "Should have raised GitHubAppConfigurationError"
            except GitHubAppConfigurationError as exc:
                assert "not configured" in str(exc)
                print(f"✓ Rejected with clear error: {exc}")
        finally:
            settings.github_app_private_key_path = orig_path

        # ── Test 2: Loader fails when file not found ────────────────────────
        print("\n--- Test 2: Loader fails when file not found (no fallback) ---")
        missing_path = str(tmp_path / "does_not_exist.pem")
        try:
            load_github_app_private_key(key_path=missing_path)
            assert False, "Should have raised GitHubAppConfigurationError"
        except GitHubAppConfigurationError as exc:
            assert "not found" in str(exc)
            print(f"✓ Rejected missing file: {exc}")

        # ── Test 3: Loader fails when file is empty ─────────────────────────
        print("\n--- Test 3: Loader fails when file is empty ---")
        empty_path = tmp_path / "empty.pem"
        empty_path.write_bytes(b"")
        try:
            load_github_app_private_key(key_path=str(empty_path))
            assert False, "Should have raised GitHubAppConfigurationError"
        except GitHubAppConfigurationError as exc:
            assert "empty" in str(exc)
            print(f"✓ Rejected empty file: {exc}")

        # ── Test 4: Loader fails when file contains invalid PEM ─────────────
        print("\n--- Test 4: Loader fails when file contains invalid PEM ---")
        corrupt_path = tmp_path / "corrupt.pem"
        corrupt_path.write_bytes(b"-----BEGIN RSA PRIVATE KEY-----\ncorrupted_data\n-----END RSA PRIVATE KEY-----")
        try:
            load_github_app_private_key(key_path=str(corrupt_path))
            assert False, "Should have raised GitHubAppConfigurationError"
        except GitHubAppConfigurationError as exc:
            assert "not a valid PEM" in str(exc)
            print(f"✓ Rejected corrupt PEM: {exc}")

        # ── Test 5: Loader fails when key is non-RSA (e.g. EC key) ──────────
        print("\n--- Test 5: Loader rejects non-RSA key (EC key) ---")
        ec_key = ec.generate_private_key(ec.SECP256R1())
        ec_pem = ec_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption(),
        )
        ec_path = tmp_path / "ec_key.pem"
        ec_path.write_bytes(ec_pem)
        try:
            load_github_app_private_key(key_path=str(ec_path))
            assert False, "Should have raised GitHubAppConfigurationError"
        except GitHubAppConfigurationError as exc:
            assert "not an RSA private key" in str(exc)
            print(f"✓ Rejected non-RSA key: {exc}")

        # ── Test 6: Loader succeeds with valid RSA PEM ──────────────────────
        print("\n--- Test 6: Loader succeeds with valid RSA PEM ---")
        loaded_key = load_github_app_private_key(key_path=str(valid_pem_path))
        assert isinstance(loaded_key, rsa.RSAPrivateKey)
        assert loaded_key.key_size == 2048
        print("✓ Loaded 2048-bit RSAPrivateKey successfully")

        # ── Test 7: JWT generation fails when client_id is missing ──────────
        print("\n--- Test 7: JWT generation fails when client_id is missing ---")
        orig_client_id = settings.github_app_client_id
        try:
            settings.github_app_client_id = None
            try:
                generate_github_app_jwt(private_key=test_key, client_id=None)
                assert False, "Should have raised GitHubAppConfigurationError"
            except GitHubAppConfigurationError as exc:
                assert "GITHUB_APP_CLIENT_ID is not configured" in str(exc)
                print(f"✓ Rejected missing client_id: {exc}")
        finally:
            settings.github_app_client_id = orig_client_id

        # ── Test 8: JWT generation verifies claims and RS256 signature ──────
        print("\n--- Test 8: JWT verifies claims and RS256 signature ---")
        test_client_id = "Iv23testClientIdMock"
        now_ts = int(time.time())
        jwt_token = generate_github_app_jwt(
            private_key=test_key,
            client_id=test_client_id,
            now=now_ts,
        )
        assert isinstance(jwt_token, str)
        assert len(jwt_token) > 50

        # Decode using public key derived from private key
        public_key = test_key.public_key()
        decoded = jwt.decode(
            jwt_token,
            public_key,
            algorithms=["RS256"],
            options={"require": ["iss", "iat", "exp"]},
        )
        assert decoded["iss"] == test_client_id
        assert decoded["iat"] == now_ts - 60
        assert decoded["exp"] == now_ts + 600
        print(f"✓ JWT RS256 signature valid | iss: {decoded['iss']} | iat: {decoded['iat']} | exp: {decoded['exp']}")

        # ── Test 9: InstallationAccessToken DTO memory-only masking ─────────
        print("\n--- Test 9: InstallationAccessToken DTO masks token in repr ---")
        raw_secret_token = "ghs_MockSuperSecretToken9876543210"
        dto = InstallationAccessToken(
            token=raw_secret_token,
            expires_at=datetime(2026, 9, 22, 10, 0, 0, tzinfo=timezone.utc),
            permissions={"contents": "read", "metadata": "read"},
            repository_selection="selected",
        )
        assert dto.token == raw_secret_token
        assert raw_secret_token not in repr(dto)
        assert raw_secret_token not in str(dto)
        assert "token='***'" in repr(dto)
        print(f"✓ Repr defensive mask: {repr(dto)}")

        # ── Test 10: Mock installation token exchange 201 Created ───────────
        print("\n--- Test 10: Mock installation token exchange 201 Created ---")
        test_installation_id = 163590490
        captured_headers = {}

        def mock_201_handler(request: httpx.Request):
            nonlocal captured_headers
            captured_headers = dict(request.headers)
            assert str(test_installation_id) in str(request.url)
            return httpx.Response(
                201,
                json={
                    "token": "ghs_MockInstallationToken1234567890",
                    "expires_at": "2026-09-22T01:00:00Z",
                    "permissions": {"contents": "read", "metadata": "read"},
                    "repository_selection": "selected",
                },
            )

        transport = httpx.MockTransport(mock_201_handler)
        async with httpx.AsyncClient(transport=transport) as mock_client:
            token_result = await create_installation_access_token(
                installation_id=test_installation_id,
                private_key=test_key,
                client_id=test_client_id,
                http_client=mock_client,
            )

        assert isinstance(token_result, InstallationAccessToken)
        assert token_result.token.startswith("ghs_")
        assert token_result.permissions.get("contents") == "read"
        assert token_result.permissions.get("metadata") == "read"
        assert token_result.repository_selection == "selected"
        assert captured_headers.get("authorization", "").startswith("Bearer ")
        assert captured_headers.get("accept") == "application/vnd.github+json"
        assert captured_headers.get("x-github-api-version") == settings.github_api_version
        print("✓ Token received with correct headers and permissions (contents: read)")

        # ── Test 11: Installation token exchange fails on invalid ID ────────
        print("\n--- Test 11: Installation token fails on invalid ID ---")
        try:
            await create_installation_access_token(installation_id=0)
            assert False, "Should have raised GitHubInstallationTokenError"
        except GitHubInstallationTokenError as exc:
            assert "Invalid installation_id" in str(exc)
            print(f"✓ Rejected invalid installation_id: {exc}")

        # ── Test 12: Mock installation token exchange 401 Unauthorized ──────
        print("\n--- Test 12: Mock installation token exchange 401 Unauthorized ---")
        def mock_401_handler(request: httpx.Request):
            return httpx.Response(401, json={"message": "Bad credentials"})

        transport = httpx.MockTransport(mock_401_handler)
        async with httpx.AsyncClient(transport=transport) as mock_client:
            try:
                await create_installation_access_token(
                    installation_id=test_installation_id,
                    private_key=test_key,
                    client_id=test_client_id,
                    http_client=mock_client,
                )
                assert False, "Should have raised GitHubInstallationTokenError"
            except GitHubInstallationTokenError as exc:
                assert exc.status_code == 401
                assert "401" in str(exc)
                print(f"✓ Handled 401 cleanly: {exc}")

        # ── Test 13: Mock installation token exchange 403 Forbidden ─────────
        print("\n--- Test 13: Mock installation token exchange 403 Forbidden ---")
        def mock_403_handler(request: httpx.Request):
            return httpx.Response(403, json={"message": "Resource not accessible by integration"})

        transport = httpx.MockTransport(mock_403_handler)
        async with httpx.AsyncClient(transport=transport) as mock_client:
            try:
                await create_installation_access_token(
                    installation_id=test_installation_id,
                    private_key=test_key,
                    client_id=test_client_id,
                    http_client=mock_client,
                )
                assert False, "Should have raised GitHubInstallationTokenError"
            except GitHubInstallationTokenError as exc:
                assert exc.status_code == 403
                assert "403" in str(exc)
                print(f"✓ Handled 403 cleanly: {exc}")

        # ── Test 14: Mock installation token exchange 404 Not Found ─────────
        print("\n--- Test 14: Mock installation token exchange 404 Not Found ---")
        def mock_404_handler(request: httpx.Request):
            return httpx.Response(404, json={"message": "Not Found"})

        transport = httpx.MockTransport(mock_404_handler)
        async with httpx.AsyncClient(transport=transport) as mock_client:
            try:
                await create_installation_access_token(
                    installation_id=999999999,
                    private_key=test_key,
                    client_id=test_client_id,
                    http_client=mock_client,
                )
                assert False, "Should have raised GitHubInstallationTokenError"
            except GitHubInstallationTokenError as exc:
                assert exc.status_code == 404
                assert "404" in str(exc)
                print(f"✓ Handled 404 cleanly: {exc}")

        # ── Test 15: Mock installation token exchange 422 Validation Error ───
        print("\n--- Test 15: Mock installation token exchange 422 Validation Error ---")
        def mock_422_handler(request: httpx.Request):
            return httpx.Response(422, json={"message": "Validation Failed"})

        transport = httpx.MockTransport(mock_422_handler)
        async with httpx.AsyncClient(transport=transport) as mock_client:
            try:
                await create_installation_access_token(
                    installation_id=test_installation_id,
                    private_key=test_key,
                    client_id=test_client_id,
                    http_client=mock_client,
                )
                assert False, "Should have raised GitHubInstallationTokenError"
            except GitHubInstallationTokenError as exc:
                assert exc.status_code == 422
                assert "422" in str(exc)
                print(f"✓ Handled 422 cleanly: {exc}")

        # ── Test 16: Phase 1 & Phase 2 Regressions ──────────────────────────
        print("\n--- Test 16: Regressions (/health, POST /repositories, GET /cities/{id}) ---")
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as client:
            resp = await client.get("/api/v1/health")
            assert resp.status_code == 200, f"/api/v1/health returned {resp.status_code}"
            assert resp.json()["status"] == "ok"
            print("✓ /api/v1/health: 200 OK")

            repo_resp = await client.post("/api/v1/repositories", json={"url": "https://github.com/tiangolo/fastapi"})
            assert repo_resp.status_code == 200
            assert repo_resp.json()["status"] == "ready"
            print("✓ POST /api/v1/repositories: 200 ready")

            city_resp = await client.get("/api/v1/cities/2e945127-9c5d-4b5a-a0d9-9d52e2cbadfe")
            assert city_resp.status_code == 200
            assert len(city_resp.json()["buildings"]) > 0
            print("✓ GET /api/v1/cities/{id}: 200 OK")

        # ── Test 17: Real Smoke Test (Conditional) ──────────────────────────
        print("\n--- Test 17: Real GitHub App Installation Token Smoke Test ---")
        real_key_path = settings.github_app_private_key_path
        can_run_smoke = False
        if real_key_path and Path(real_key_path).is_file():
            file_size = Path(real_key_path).stat().st_size
            if file_size > 100 and settings.github_app_client_id:
                can_run_smoke = True

        if not can_run_smoke:
            print("↷ SKIPPED: Real private key file not populated or < 100 bytes.")
            print(f"  Path checked: {real_key_path}")
        else:
            real_installation_id = 163590490
            print(f"  Contacting GitHub API for installation {real_installation_id}...")
            real_token_result = await create_installation_access_token(
                installation_id=real_installation_id,
            )

            # Strict boolean checks without printing or logging token value
            token_present = bool(real_token_result.token)
            token_has_expected_github_installation_token_form = (
                isinstance(real_token_result.token, str) and real_token_result.token.startswith("ghs_")
            )
            expires_at_present = (
                real_token_result.expires_at is not None
                and isinstance(real_token_result.expires_at, datetime)
            )
            contents_permission = real_token_result.permissions.get("contents")

            assert token_present is True, "Token must be present"
            assert token_has_expected_github_installation_token_form is True, "Token must start with ghs_"
            assert expires_at_present is True, "expires_at must be valid datetime"
            assert contents_permission == "read", f"Contents permission must be 'read', got: {contents_permission}"

            print("✓ REAL SMOKE TEST PASSED:")
            print(f"  token_present: {token_present}")
            print(f"  token_has_expected_github_installation_token_form: {token_has_expected_github_installation_token_form}")
            print(f"  expires_at_present: {expires_at_present}")
            print(f"  contents_permission: {contents_permission}")
            print(f"  repository_selection: {real_token_result.repository_selection}")

    print("\n==================================================================")
    print("     ALL CHECKPOINT 5.5A TESTS PASSED!                           ")
    print("==================================================================")


if __name__ == "__main__":
    asyncio.run(run_cp5_5a_tests())
