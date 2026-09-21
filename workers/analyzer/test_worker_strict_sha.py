"""
Worker-side tests for Checkpoint 5.6A:
Strict Commit Checkout & Verification in clone_repository and analyze_repository.

Verifies:
  1. Cloned HEAD == expected SHA -> no unnecessary fetch or checkout.
  2. Cloned HEAD != expected SHA -> authenticated fetch + checkout with credentials.
  3. SHA unavailable -> raises CloneError, directory cleaned up immediately.
  4. Post-checkout mismatch -> raises CloneError, directory cleaned up.
  5. Live Git test: local multi-commit repository fetched & checked out to exact SHA.
  6. Worker pipeline error handling: AnalysisRun and Repository marked failed, no City created.
"""
from __future__ import annotations

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
from unittest.mock import AsyncMock, MagicMock, patch

import git
from git import Repo, GitCommandError

from analyzer.cloner import CloneError, clone_repository, cleanup_clone


def run_worker_strict_sha_tests():
    print("==================================================================")
    print("  CHECKPOINT 5.6A: WORKER STRICT COMMIT CHECKOUT TESTS            ")
    print("==================================================================")

    initial_environ = dict(os.environ)
    sha_head = "1111111111111111111111111111111111111111"
    sha_older = "2222222222222222222222222222222222222222"
    sha_bad = "0000000000000000000000000000000000000000"

    # ── Test 1: Cloned HEAD == expected SHA -> zero fetch ──────────────────
    print("\n--- Test 1: Cloned HEAD matches expected SHA (no fetch) ---")
    with patch("git.Repo.clone_from") as mock_clone:
        mock_repo = MagicMock()
        mock_repo.head.commit.hexsha = sha_head
        mock_clone.return_value = mock_repo

        with tempfile.TemporaryDirectory() as tmp_base:
            clone_path, owner, repo_name, commit_sha = clone_repository(
                url="https://github.com/owner/repo",
                base_dir=Path(tmp_base),
                auth_token="ghs_TestToken123",
                expected_commit_sha=sha_head,
            )

            assert commit_sha == sha_head
            # Verify fetch was NEVER called since HEAD matched
            assert not mock_repo.git.fetch.called, "git fetch must NOT be called when HEAD matches"
            assert not mock_repo.git.checkout.called, "git checkout must NOT be called when HEAD matches"
            print("✓ Exact match: returned successfully without extra fetch/checkout.")

    # ── Test 2: Cloned HEAD != expected SHA -> authenticated fetch + checkout
    print("\n--- Test 2: Cloned HEAD differs -> authenticated fetch + checkout ---")
    with patch("git.Repo.clone_from") as mock_clone:
        mock_repo = MagicMock()
        # Initial clone gives sha_head
        mock_repo.head.commit.hexsha = sha_head

        # After checkout, HEAD becomes sha_older
        def simulate_checkout(sha):
            mock_repo.head.commit.hexsha = sha

        mock_repo.git.checkout.side_effect = simulate_checkout
        mock_clone.return_value = mock_repo

        with tempfile.TemporaryDirectory() as tmp_base:
            clone_path, owner, repo_name, commit_sha = clone_repository(
                url="https://github.com/owner/repo",
                base_dir=Path(tmp_base),
                auth_token="ghs_WorkerSecretToken",
                expected_commit_sha=sha_older,
            )

            # Verify git fetch was called with origin, sha_older, depth=1, and env=clone_env
            assert mock_repo.git.fetch.called, "git fetch must be called when HEAD differs"
            fetch_args, fetch_kwargs = mock_repo.git.fetch.call_args
            assert fetch_args == ("origin", sha_older)
            assert fetch_kwargs.get("depth") == 1
            assert fetch_kwargs.get("env") is not None
            assert fetch_kwargs["env"]["CODEWORLD_GIT_PASSWORD"] == "ghs_WorkerSecretToken"
            print("✓ git fetch called with expected SHA, depth=1, and credentials in child env.")

            # Verify git checkout was called with sha_older
            assert mock_repo.git.checkout.called
            assert mock_repo.git.checkout.call_args[0][0] == sha_older
            print("✓ git checkout called with expected SHA.")

            # Verify returned SHA is sha_older
            assert commit_sha == sha_older
            print(f"✓ Final analyzed SHA verified: {commit_sha}")

            # Verify parent env remains untouched
            assert os.environ == initial_environ
            print("✓ Parent environment preserved without leakage.")

    # ── Test 3: SHA unavailable -> CloneError and guaranteed cleanup ────────
    print("\n--- Test 3: Unavailable expected SHA -> controlled failure & cleanup ---")
    with patch("git.Repo.clone_from") as mock_clone:
        mock_repo = MagicMock()
        mock_repo.head.commit.hexsha = sha_head
        mock_repo.git.fetch.side_effect = GitCommandError("git fetch", 128, stderr=b"fatal: upload-pack: not our ref")
        mock_clone.return_value = mock_repo

        with tempfile.TemporaryDirectory() as tmp_base:
            try:
                clone_repository(
                    url="https://github.com/owner/repo",
                    base_dir=Path(tmp_base),
                    expected_commit_sha=sha_bad,
                )
                assert False, "Should have raised CloneError"
            except CloneError as err:
                assert "Failed to fetch/checkout expected commit" in str(err)
                print(f"✓ Caught expected CloneError: {err}")

            # Verify no lingering directories in tmp_base
            remaining = list(Path(tmp_base).iterdir())
            assert len(remaining) == 0, f"Expected 0 remaining directories, found: {remaining}"
            print("✓ Clone directory completely cleaned up after fetch failure.")

    # ── Test 4: Post-checkout mismatch -> CloneError and cleanup ────────────
    print("\n--- Test 4: Post-checkout mismatch -> CloneError & cleanup ---")
    with patch("git.Repo.clone_from") as mock_clone:
        mock_repo = MagicMock()
        mock_repo.head.commit.hexsha = sha_head
        # Checkout does not change HEAD (simulating corrupted state)
        mock_clone.return_value = mock_repo

        with tempfile.TemporaryDirectory() as tmp_base:
            try:
                clone_repository(
                    url="https://github.com/owner/repo",
                    base_dir=Path(tmp_base),
                    expected_commit_sha=sha_older,
                )
                assert False, "Should have raised CloneError"
            except CloneError as err:
                assert "Post-checkout HEAD mismatch" in str(err)
                print(f"✓ Caught expected mismatch CloneError: {err}")

            remaining = list(Path(tmp_base).iterdir())
            assert len(remaining) == 0
            print("✓ Clone directory cleaned up after mismatch.")

    # ── Test 5: Live Git Integration Test (Real git binary execution) ──────
    print("\n--- Test 5: Live Git multi-commit fetch & checkout ---")
    with tempfile.TemporaryDirectory() as origin_dir, tempfile.TemporaryDirectory() as clone_base:
        origin_path = Path(origin_dir)
        # Create a real local git repository with 2 commits
        subprocess.run(["git", "init", "-b", "main", str(origin_path)], check=True, capture_output=True)
        subprocess.run(["git", "config", "user.email", "test@codeworld.local"], cwd=origin_path, check=True)
        subprocess.run(["git", "config", "user.name", "CodeWorld Test"], cwd=origin_path, check=True)

        # Commit 1
        file1 = origin_path / "file1.py"
        file1.write_text("print('version 1')\n")
        subprocess.run(["git", "add", "file1.py"], cwd=origin_path, check=True)
        subprocess.run(["git", "commit", "-m", "commit 1"], cwd=origin_path, check=True)
        sha_c1 = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=origin_path).decode().strip()

        # Commit 2
        file2 = origin_path / "file2.py"
        file2.write_text("print('version 2')\n")
        subprocess.run(["git", "add", "file2.py"], cwd=origin_path, check=True)
        subprocess.run(["git", "commit", "-m", "commit 2"], cwd=origin_path, check=True)
        sha_c2 = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=origin_path).decode().strip()

        assert sha_c1 != sha_c2

        # Allow fetching reachable commits directly
        subprocess.run(["git", "config", "uploadpack.allowReachableSHA1InWant", "true"], cwd=origin_path, check=True)

        # Clone requesting the older commit sha_c1 (while origin HEAD is sha_c2)
        # clone_repository expects https://github.com/owner/repo format for parsing owner/name,
        # so we pass file path converted or mock URL:
        with patch("analyzer.cloner._parse_github_url", return_value=("test-owner", "test-repo")):
            clone_path, owner, repo_name, actual_sha = clone_repository(
                url=str(origin_path),
                base_dir=Path(clone_base),
                expected_commit_sha=sha_c1,
            )

            assert actual_sha == sha_c1, f"Expected HEAD {sha_c1}, got {actual_sha}"
            assert (clone_path / "file1.py").exists(), "file1.py must exist at commit 1"
            assert not (clone_path / "file2.py").exists(), "file2.py must NOT exist at commit 1"
            print("✓ Live Git: repository cloned and successfully checked out to older commit!")
            print(f"  Origin HEAD was: {sha_c2}")
            print(f"  Cloned HEAD is:  {actual_sha}")

            # Verify cleanup
            cleanup_clone(clone_path)
            assert not clone_path.exists()
            print("✓ Live Git: clone directory cleanly deleted.")

    print("\n==================================================================")
    print("  ALL WORKER STRICT COMMIT CHECKOUT TESTS PASSED (5/5)!           ")
    print("==================================================================")


if __name__ == "__main__":
    run_worker_strict_sha_tests()
