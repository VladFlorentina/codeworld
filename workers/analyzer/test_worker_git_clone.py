"""
Worker-side tests for Checkpoint 5.5B:
Authenticated Git Clone, Child-Process Env Isolation, GIT_ASKPASS, and Cleanup.
"""
from __future__ import annotations

import os
from pathlib import Path
import tempfile
from unittest.mock import AsyncMock, patch

from analyzer.cloner import CloneError, clone_repository, cleanup_clone


def run_worker_git_clone_tests():
    print("==================================================================")
    print("  CHECKPOINT 5.5B: WORKER SECURE GIT CLONE & GIT_ASKPASS TESTS   ")
    print("==================================================================")

    priv_full_name = "test-org/secret-repo"
    priv_commit_sha = "c0ffee1234567890abcdef1234567890abcdef12"

    # ── Test 1: Isolated child-process environment & pure URL ───────────────
    print("\n--- Test 1: Child-process environment isolation & pure URL ---")
    initial_environ = dict(os.environ)

    with patch("git.Repo.clone_from") as mock_clone:
        mock_repo_instance = AsyncMock()
        mock_repo_instance.head.commit.hexsha = priv_commit_sha
        mock_clone.return_value = mock_repo_instance

        with tempfile.TemporaryDirectory() as tmp_base:
            clone_path, owner, repo_name, commit_sha = clone_repository(
                url=f"https://github.com/{priv_full_name}",
                base_dir=Path(tmp_base),
                auth_token="ghs_VerySecretWorkerInstallationToken123",
            )

            # 1. URL called by GitPython must NOT contain any token
            called_url = mock_clone.call_args[0][0]
            assert called_url == f"https://github.com/{priv_full_name}"
            assert "ghs_" not in called_url
            print(f"✓ Pure clone URL verified: {called_url}")

            # 2. Child environment passed to git clone must contain askpass credentials
            called_env = mock_clone.call_args[1].get("env")
            assert called_env is not None
            assert called_env["CODEWORLD_GIT_USERNAME"] == "x-access-token"
            assert called_env["CODEWORLD_GIT_PASSWORD"] == "ghs_VerySecretWorkerInstallationToken123"
            assert called_env["GIT_TERMINAL_PROMPT"] == "0"
            assert "git_askpass.sh" in called_env["GIT_ASKPASS"]
            print("✓ Child process env contains GIT_ASKPASS and credentials.")

            # 3. Parent os.environ MUST NOT be mutated
            assert "CODEWORLD_GIT_PASSWORD" not in os.environ
            assert "GIT_ASKPASS" not in os.environ
            assert os.environ == initial_environ
            print("✓ Parent process os.environ remains strictly unmodified.")

    # ── Test 2: Clone failure handling (401/403) & error sanitization ───────
    print("\n--- Test 2: Clone failure handling (401/403) & error sanitization ---")
    with patch("git.Repo.clone_from", side_effect=Exception("fatal: Authentication failed for 'https://github.com/test-org/secret-repo'")):
        with tempfile.TemporaryDirectory() as tmp_base:
            try:
                clone_repository(
                    url=f"https://github.com/{priv_full_name}",
                    base_dir=Path(tmp_base),
                    auth_token="ghs_InvalidToken",
                )
                assert False, "Should have raised CloneError"
            except CloneError as err:
                assert "git clone failed" in str(err)
                print(f"✓ Caught expected CloneError cleanly: {err}")

    # ── Test 3: Guaranteed cleanup on failure ────────────────────────────────
    print("\n--- Test 3: Guaranteed cleanup on failure ---")
    with tempfile.TemporaryDirectory() as tmp_base:
        dummy_dir = Path(tmp_base) / "partial_failed_clone"
        dummy_dir.mkdir(parents=True, exist_ok=True)
        (dummy_dir / "dirty_file.txt").write_text("uncleaned data")
        assert dummy_dir.exists()

        cleanup_clone(dummy_dir)
        assert not dummy_dir.exists(), "Clone directory must be deleted after cleanup"
        print("✓ Partial/temporary clone folder cleanly removed.")

    print("\n==================================================================")
    print("     ALL WORKER GIT CLONE TESTS PASSED!                          ")
    print("==================================================================")


if __name__ == "__main__":
    run_worker_git_clone_tests()
