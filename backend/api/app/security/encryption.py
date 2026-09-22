from __future__ import annotations

import logging
from cryptography.fernet import Fernet, InvalidToken

from app.config import settings

logger = logging.getLogger(__name__)


def _get_fernet(key: str | None = None) -> Fernet:
    """
    Instantiate and return a Fernet cipher using TOKEN_ENCRYPTION_KEY.

    Fails fast with ValueError if key is missing, empty, or not a valid Fernet key.
    """
    raw_key = key if key is not None else settings.token_encryption_key

    if not raw_key or not raw_key.strip():
        raise ValueError(
            "TOKEN_ENCRYPTION_KEY is not configured. "
            "A dedicated 32-byte url-safe base64 key must be provided in the environment."
        )

    try:
        key_bytes = raw_key.strip().encode("utf-8")
        return Fernet(key_bytes)
    except Exception as exc:
        raise ValueError(
            f"Invalid TOKEN_ENCRYPTION_KEY format: {exc}. "
            "Must be a valid 32-byte url-safe base64-encoded key."
        ) from exc


def encrypt_token(token: str, key: str | None = None) -> str:
    """Encrypt a plaintext token using Fernet symmetric encryption."""
    if not token:
        raise ValueError("Cannot encrypt an empty token.")

    fernet = _get_fernet(key)
    encrypted_bytes = fernet.encrypt(token.encode("utf-8"))
    return encrypted_bytes.decode("utf-8")


def decrypt_token(cipher_text: str, key: str | None = None) -> str:
    """Decrypt a Fernet ciphertext back to its plaintext token."""
    if not cipher_text:
        raise ValueError("Cannot decrypt empty ciphertext.")

    fernet = _get_fernet(key)
    try:
        decrypted_bytes = fernet.decrypt(cipher_text.encode("utf-8"))
        return decrypted_bytes.decode("utf-8")
    except InvalidToken as exc:
        raise ValueError("Decryption failed: invalid token ciphertext or corrupted data.") from exc
