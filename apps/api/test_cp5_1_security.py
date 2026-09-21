"""
Validation test suite for Checkpoint 5.1 — Configurare & Securitate.

Tests required:
  1. encrypt(token) != token
  2. decrypt(encrypt(token)) == token
  3. missing / invalid TOKEN_ENCRYPTION_KEY -> fail fast
  4. PKCE verification (RFC 7636 compliance, test vectors)
  5. API configuration startup & environment variables
  6. Existing /health and public Explore regression tests
"""
import httpx
from cryptography.fernet import Fernet
from app.config import settings
from app.security.encryption import encrypt_token, decrypt_token
from app.security.pkce import generate_code_verifier, generate_code_challenge, generate_state


def run_cp5_1_tests():
    print("==================================================================")
    print("      CHECKPOINT 5.1: SECURITY & CONFIGURATION VERIFICATION       ")
    print("==================================================================")

    # ─────────────────────────────────────────────────────────────
    # TEST 1: Encryption does not equal plaintext
    # ─────────────────────────────────────────────────────────────
    print("\n--- [Test 1: encrypt(token) != token] ---")
    sample_token = "ghu_16C7e42F292c6912E7710c838347Ae178B4a"
    encrypted = encrypt_token(sample_token)
    print(f"Sample token:    {sample_token}")
    print(f"Encrypted token: {encrypted}")
    assert encrypted != sample_token, "Encrypted token must differ from plaintext"
    assert not encrypted.startswith("ghu_"), "Plaintext prefix must not be visible in ciphertext"
    print("✓ PASS: encrypt(token) != token")

    # ─────────────────────────────────────────────────────────────
    # TEST 2: decrypt(encrypt(token)) == token (Roundtrip)
    # ─────────────────────────────────────────────────────────────
    print("\n--- [Test 2: decrypt(encrypt(token)) == token] ---")
    decrypted = decrypt_token(encrypted)
    print(f"Decrypted token: {decrypted}")
    assert decrypted == sample_token, f"Decrypted token '{decrypted}' != '{sample_token}'"

    # Multi-token test with refresh tokens
    sample_refresh = "ghr_1B4a92c6912E7710c838347Ae178B4a16C7e42F2"
    enc_refresh = encrypt_token(sample_refresh)
    dec_refresh = decrypt_token(enc_refresh)
    assert dec_refresh == sample_refresh
    print("✓ PASS: decrypt(encrypt(token)) == token for both access and refresh tokens")

    # ─────────────────────────────────────────────────────────────
    # TEST 3: Missing or invalid key fails fast
    # ─────────────────────────────────────────────────────────────
    print("\n--- [Test 3: Missing / Invalid TOKEN_ENCRYPTION_KEY fails fast] ---")
    # A. Missing key
    try:
        encrypt_token("some_token", key="")
        assert False, "Expected ValueError on empty key"
    except ValueError as exc:
        print(f"Caught expected ValueError for empty key: {exc}")
        assert "TOKEN_ENCRYPTION_KEY is not configured" in str(exc)

    try:
        decrypt_token(encrypted, key=None if settings.token_encryption_key is None else "")
        assert False, "Expected ValueError on empty key for decrypt"
    except ValueError as exc:
        print(f"Caught expected ValueError for empty key in decrypt: {exc}")

    # B. Invalid format key (not 32 bytes base64)
    try:
        encrypt_token("some_token", key="not-a-valid-fernet-key")
        assert False, "Expected ValueError on malformed key"
    except ValueError as exc:
        print(f"Caught expected ValueError for malformed key: {exc}")
        assert "Invalid TOKEN_ENCRYPTION_KEY format" in str(exc)

    # C. Tampered / wrong key decryption
    other_valid_key = Fernet.generate_key().decode()
    try:
        decrypt_token(encrypted, key=other_valid_key)
        assert False, "Expected ValueError when decrypting with different key"
    except ValueError as exc:
        print(f"Caught expected ValueError for wrong key: {exc}")
        assert "Decryption failed" in str(exc)
    print("✓ PASS: Missing, invalid, and mismatched keys fail fast with clear errors.")

    # ─────────────────────────────────────────────────────────────
    # TEST 4: PKCE RFC 7636 Compliance
    # ─────────────────────────────────────────────────────────────
    print("\n--- [Test 4: PKCE RFC 7636 Verification] ---")
    # Standard RFC 7636 Appendix B test vector:
    # verifier: "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    # challenge: "E9Melhoa2OwvFrGMTJguCH5rtGKiBp3dWLrk1Lzoqys"
    rfc_verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
    expected_challenge = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
    actual_challenge = generate_code_challenge(rfc_verifier)
    print(f"RFC 7636 Test Verifier:   {rfc_verifier}")
    print(f"Expected Challenge S256:  {expected_challenge}")
    print(f"Generated Challenge S256: {actual_challenge}")
    assert actual_challenge == expected_challenge, f"PKCE S256 mismatch! Expected {expected_challenge}, got {actual_challenge}"

    # Random generation properties
    v1 = generate_code_verifier(64)
    v2 = generate_code_verifier(64)
    assert len(v1) == 64
    assert v1 != v2, "Code verifiers must be distinct and random"
    c1 = generate_code_challenge(v1)
    assert len(c1) == 43, f"S256 challenge length should be 43 characters (unpadded base64url of 32 bytes), got {len(c1)}"

    s1 = generate_state(32)
    assert len(s1) >= 32
    print("✓ PASS: PKCE implementation is 100% compliant with RFC 7636 S256 specifications.")

    # ─────────────────────────────────────────────────────────────
    # TEST 5: API Settings Configuration Verification
    # ─────────────────────────────────────────────────────────────
    print("\n--- [Test 5: API Settings Configuration] ---")
    print(f"settings.token_encryption_key: {'Configured (masked)' if settings.token_encryption_key else 'None'}")
    print(f"settings.session_cookie_name:  {settings.session_cookie_name}")
    print(f"settings.session_max_age_seconds: {settings.session_max_age_seconds}")
    assert settings.token_encryption_key is not None, "token_encryption_key must be configured"
    assert settings.session_cookie_name == "codeworld_session"
    assert settings.session_max_age_seconds == 7 * 24 * 3600
    print("✓ PASS: Configuration settings verified.")

    # ─────────────────────────────────────────────────────────────
    # TEST 6: Existing Endpoints Health & Public Explore Regression
    # ─────────────────────────────────────────────────────────────
    print("\n--- [Test 6: Existing Endpoints Regression Check] ---")
    with httpx.Client(base_url="http://localhost:8000/api/v1", timeout=10.0) as client:
        # Check /health
        h_res = client.get("/health")
        print(f"GET /health: status={h_res.status_code}, body={h_res.json()}")
        assert h_res.status_code == 200
        assert h_res.json()["status"] == "ok"

        # Check public Explore ensure-world on tiangolo/fastapi
        f_res = client.post("/repositories", json={"url": "https://github.com/tiangolo/fastapi"})
        print(f"POST /repositories (fastapi): status={f_res.status_code}, status_field={f_res.json().get('status')}")
        assert f_res.status_code == 200
        assert f_res.json()["status"] == "ready"
        print("✓ PASS: /health and public Explore remain 100% functional and regress-free.")

    print("\n==================================================================")
    print("    ALL CHECKPOINT 5.1 SECURITY & CONFIG TESTS PASSED!           ")
    print("==================================================================")


if __name__ == "__main__":
    run_cp5_1_tests()
