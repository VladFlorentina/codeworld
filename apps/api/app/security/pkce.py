from __future__ import annotations

import base64
import hashlib
import secrets


def generate_code_verifier(length: int = 64) -> str:
    """
    Generate an RFC 7636 compliant PKCE code_verifier.

    Uses high-entropy cryptographic random string consisting of
    unreserved URL characters [A-Za-z0-9-._~].
    Length must be between 43 and 128 characters.
    """
    if not (43 <= length <= 128):
        raise ValueError("PKCE code_verifier length must be between 43 and 128 characters.")
    # secrets.token_urlsafe generates urlsafe base64 without padding
    # token_urlsafe(nbytes) returns ~1.33 * nbytes characters
    token = secrets.token_urlsafe(length)
    return token[:length]


def generate_code_challenge(verifier: str) -> str:
    """
    Generate an RFC 7636 compliant PKCE code_challenge from a code_verifier.

    Code challenge method: S256
    code_challenge = BASE64URL-ENCODE(SHA256(ASCII(code_verifier))) without padding.
    """
    if not verifier:
        raise ValueError("code_verifier cannot be empty.")
    sha256_digest = hashlib.sha256(verifier.encode("ascii")).digest()
    challenge = base64.urlsafe_b64encode(sha256_digest).decode("ascii").rstrip("=")
    return challenge


def generate_state(length: int = 32) -> str:
    """
    Generate a cryptographically secure random state token for OAuth CSRF protection.
    """
    return secrets.token_urlsafe(length)
