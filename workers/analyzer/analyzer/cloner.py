"""
Repository cloning for the CodeWorld analysis pipeline.

Security considerations (treating repository contents as untrusted):
  - Clone into a controlled base directory with a random UUID subdirectory.
    This prevents any possibility of path collisions between concurrent jobs.
  - Shallow clone (--depth=1) fetches only the latest commit.
    This is faster and avoids downloading the full history (Phase 7 will
    fetch history incrementally only when needed).
  - We record the HEAD commit SHA immediately after cloning.
    This SHA ties the analysis run to an exact point in time.
  - If cloning fails, we clean up the partial clone directory.
  - We enforce a size limit AFTER cloning. Git does not expose the final
    uncompressed size before cloning, so we check after the fact and
    abort if the clone is too large.
  - Never follow symlinks outside the clone root (handled by discovery.py).

Why GitPython?
  It wraps the system git binary, so we get full git compatibility without
  reimplementing any git protocol. For cloning a public repository, it is
  the simplest correct choice.
"""
from __future__ import annotations

import logging
import os
import shutil
import uuid
from pathlib import Path

import git
from git import Repo

logger = logging.getLogger(__name__)

# Default base directory for clones. Overridden by the
# GITHUB_CLONE_BASE_DIR environment variable in the worker.
DEFAULT_CLONE_BASE = Path(
    os.getenv("GITHUB_CLONE_BASE_DIR", "/tmp/codeworld_repos")
)

# Maximum repository size on disk after cloning (bytes).
# Default: 500 MB. Overridden by MAX_REPO_SIZE_MB env var.
MAX_CLONE_SIZE_BYTES = int(os.getenv("MAX_REPO_SIZE_MB", "500")) * 1024 * 1024


class CloneError(Exception):
    """Raised when repository cloning fails for any reason."""


def _parse_github_url(url: str) -> tuple[str, str]:
    """
    Extract (owner, repo_name) from a normalized GitHub HTTPS URL.

    The URL is expected to already be validated and normalized by the
    Pydantic schema in the API layer (no .git suffix, no trailing slash).

    Examples:
        "https://github.com/tiangolo/fastapi" → ("tiangolo", "fastapi")
    """
    path = url.removeprefix("https://github.com/")
    parts = [p for p in path.split("/") if p]
    if len(parts) < 2:
        raise CloneError(f"Cannot parse owner/repo from URL: {url}")
    return parts[0], parts[1]


def _directory_size(path: Path) -> int:
    """Return total size in bytes of all files under path."""
    total = 0
    for entry in path.rglob("*"):
        if entry.is_file():
            try:
                total += entry.stat().st_size
            except OSError:
                pass
    return total


def clone_repository(
    url: str,
    base_dir: Path | None = None,
    auth_token: str | None = None,
    expected_commit_sha: str | None = None,
) -> tuple[Path, str, str, str]:
    """
    Clone a GitHub repository (public or private) and return key metadata.

    Args:
        url:                 Normalized GitHub HTTPS URL (https://github.com/owner/repo).
        base_dir:            Base directory for clones. Defaults to DEFAULT_CLONE_BASE.
        auth_token:          Optional installation access token for authenticated private clones.
                             When provided, injected into child process via GIT_ASKPASS environment.
                             Never embedded in the clone URL or command line args.
        expected_commit_sha: Optional expected HEAD commit SHA (40 hex chars). When provided,
                             verifies that the cloned repository HEAD matches this SHA.
                             If cloned HEAD differs (e.g. new commit pushed between enqueue and clone),
                             fetches and checks out expected_commit_sha using authenticated credentials.
                             If expected_commit_sha cannot be fetched/checked out, raises CloneError
                             and cleans up the directory immediately.

    Returns:
        A tuple of (clone_path, owner, repo_name, commit_sha) where:
          - clone_path  is the absolute Path to the cloned directory
          - owner       is the GitHub username or organization
          - repo_name   is the repository name
          - commit_sha  is the analyzed commit SHA (40 hex chars)

    Raises:
        CloneError: On any failure (network, size limit, git error, SHA mismatch).

    The caller is responsible for cleanup via cleanup_clone(clone_path).
    """
    base = base_dir or DEFAULT_CLONE_BASE
    base.mkdir(parents=True, exist_ok=True)

    owner, repo_name = _parse_github_url(url)

    # Each clone gets a unique directory so concurrent jobs never collide.
    clone_id = uuid.uuid4().hex[:12]
    clone_path = base / f"{owner}__{repo_name}__{clone_id}"

    logger.info(
        "Cloning repository",
        extra={
            "url": url,
            "clone_path": str(clone_path),
            "is_authenticated": bool(auth_token),
            "expected_commit_sha": expected_commit_sha,
        },
    )

    clone_env: dict[str, str] | None = None
    if auth_token:
        askpass_script = Path(__file__).parent / "git_askpass.sh"
        if not os.access(askpass_script, os.X_OK):
            try:
                askpass_script.chmod(askpass_script.stat().st_mode | 0o755)
            except OSError:
                pass
        # Isolated child environment: do NOT mutate global os.environ
        clone_env = {
            **os.environ,
            "GIT_ASKPASS": str(askpass_script),
            "CODEWORLD_GIT_USERNAME": "x-access-token",
            "CODEWORLD_GIT_PASSWORD": auth_token,
            "GIT_TERMINAL_PROMPT": "0",
        }

    try:
        try:
            repo = Repo.clone_from(
                url,
                clone_path,
                env=clone_env,
                depth=1,                      # shallow — only latest commit
                single_branch=True,           # only default branch
                no_tags=True,                 # skip tag objects (saves bandwidth)
            )
        except (git.GitCommandError, Exception) as exc:
            clean_stderr = getattr(exc, "stderr", None)
            if clean_stderr and isinstance(clean_stderr, str):
                clean_stderr = clean_stderr.strip()
            else:
                clean_stderr = str(exc)
            raise CloneError(
                f"git clone failed for {url}: {clean_stderr}"
            ) from exc

        # ── Commit SHA Verification & Strict Checkout ─────────────
        try:
            cloned_sha = repo.head.commit.hexsha
        except Exception:
            cloned_sha = "unknown"

        if expected_commit_sha and cloned_sha.lower() != expected_commit_sha.lower():
            logger.info(
                "Cloned HEAD differs from expected commit SHA; fetching expected commit",
                extra={
                    "url": url,
                    "cloned_sha": cloned_sha,
                    "expected_commit_sha": expected_commit_sha,
                },
            )
            try:
                # Fetch expected commit with depth=1 using authenticated environment
                repo.git.fetch("origin", expected_commit_sha, depth=1, env=clone_env)
                repo.git.checkout(expected_commit_sha)
            except (git.GitCommandError, Exception) as exc:
                clean_stderr = getattr(exc, "stderr", None)
                if clean_stderr and isinstance(clean_stderr, str):
                    clean_stderr = clean_stderr.strip()
                else:
                    clean_stderr = str(exc)
                raise CloneError(
                    f"Failed to fetch/checkout expected commit {expected_commit_sha} for {url}: {clean_stderr}"
                ) from exc

        # Verify actual HEAD == expected SHA
        try:
            actual_sha = repo.head.commit.hexsha
        except Exception:
            actual_sha = "unknown"

        if expected_commit_sha and actual_sha.lower() != expected_commit_sha.lower():
            raise CloneError(
                f"Post-checkout HEAD mismatch for {url}: expected {expected_commit_sha}, got {actual_sha}"
            )

        # ── Size check ────────────────────────────────────────────
        # We check after cloning and checkout because git does not expose uncompressed size
        # before the clone. If too large, we delete and abort.
        size_bytes = _directory_size(clone_path)
        if size_bytes > MAX_CLONE_SIZE_BYTES:
            size_mb = size_bytes / (1024 * 1024)
            limit_mb = MAX_CLONE_SIZE_BYTES / (1024 * 1024)
            raise CloneError(
                f"Repository is too large ({size_mb:.0f} MB > {limit_mb:.0f} MB limit). "
                "Set MAX_REPO_SIZE_MB to increase the limit."
            )

        logger.info(
            "Clone complete",
            extra={
                "url": url,
                "commit_sha": actual_sha,
                "size_mb": round(size_bytes / (1024 * 1024), 1),
                "clone_path": str(clone_path),
            },
        )

        return clone_path, owner, repo_name, actual_sha

    except Exception:
        # Guarantee cleanup on any failure in clone, fetch, checkout, or size check
        if clone_path.exists():
            shutil.rmtree(clone_path, ignore_errors=True)
        raise
    finally:
        clone_env = None


def cleanup_clone(clone_path: Path) -> None:
    """
    Delete a cloned repository directory.

    Should be called by the worker after analysis is complete
    (whether it succeeded or failed) to avoid filling up disk.
    In Phase 4 we may keep clones cached for incremental re-analysis.
    """
    if clone_path.exists():
        shutil.rmtree(clone_path, ignore_errors=True)
        logger.info("Cleaned up clone", extra={"path": str(clone_path)})
