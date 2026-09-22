"""File discovery for the CodeWorld analysis pipeline."""
from __future__ import annotations

import logging
import os
from pathlib import Path

import git

from analyzer.language import detect_language, is_binary_extension
from analyzer.models import FileInfo

logger = logging.getLogger(__name__)

MAX_FILES = int(os.getenv("MAX_FILES_PER_ANALYSIS", "10000"))
MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024

SKIP_DIRS: frozenset[str] = frozenset({
    "node_modules",
    ".git",
    ".github",
    ".venv",
    "venv",
    "env",
    "__pycache__",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
    "dist",
    "build",
    "out",
    ".next",
    ".nuxt",
    "coverage",
    ".coverage",
    "vendor",
    "target",
    "bin",
    "obj",
    ".gradle",
    ".idea",
    ".vscode",
    "Pods",
    "DerivedData",
})

SKIP_EXTENSIONS: frozenset[str] = frozenset({
    ".min.js",
    ".min.css",
    ".map",
    ".snap",
    ".pyc",
    ".pyo",
})


def discover_files(clone_path: Path) -> tuple[list[FileInfo], list[tuple[str, str]]]:
    """Discover analyzable source files using git ls-files and path filtering."""
    files: list[FileInfo] = []
    skipped: list[tuple[str, str]] = []

    try:
        repo = git.Repo(clone_path)
    except git.InvalidGitRepositoryError:
        logger.error("Not a valid git repository", extra={"path": str(clone_path)})
        return _fallback_walk(clone_path, skipped), skipped

    try:
        tracked_str = repo.git.ls_files()
    except git.GitCommandError as exc:
        logger.error("git ls-files failed", extra={"error": str(exc)})
        return _fallback_walk(clone_path, skipped), skipped

    tracked_paths = [p for p in tracked_str.splitlines() if p.strip()]
    logger.info(
        "git ls-files complete",
        extra={"clone_path": str(clone_path), "tracked_count": len(tracked_paths)},
    )

    # ── Filter and build FileInfo list ───────────────────────
    for relative_path in tracked_paths:
        # Enforce maximum file count
        if len(files) >= MAX_FILES:
            skipped.append((relative_path, f"file count limit ({MAX_FILES}) reached"))
            continue

        absolute_path = clone_path / relative_path
        path_obj = Path(relative_path)

        # Security: ensure the file resolves within the clone root.
        # This prevents symlink attacks where a tracked symlink points
        # to a file outside the repository directory.
        try:
            resolved = absolute_path.resolve()
            clone_resolved = clone_path.resolve()
            if not str(resolved).startswith(str(clone_resolved)):
                skipped.append((relative_path, "symlink escapes clone root (security)"))
                logger.warning(
                    "Skipping path traversal attempt",
                    extra={"path": relative_path},
                )
                continue
        except OSError:
            skipped.append((relative_path, "could not resolve path"))
            continue

        # Skip if any path component is in SKIP_DIRS
        if any(part in SKIP_DIRS for part in path_obj.parts):
            skipped.append((relative_path, "in skipped directory"))
            continue

        # Skip known binary extensions
        if is_binary_extension(relative_path):
            skipped.append((relative_path, "binary file type"))
            continue

        # Skip double-extensions like .min.js
        name_lower = path_obj.name.lower()
        if any(name_lower.endswith(ext) for ext in SKIP_EXTENSIONS):
            skipped.append((relative_path, "generated/minified file"))
            continue

        # Skip if the file doesn't exist on disk (deleted but still tracked, race condition)
        if not absolute_path.is_file():
            skipped.append((relative_path, "file not found on disk"))
            continue

        # Get file size
        try:
            size_bytes = absolute_path.stat().st_size
        except OSError as exc:
            skipped.append((relative_path, f"stat failed: {exc}"))
            continue

        # Detect language
        language = detect_language(relative_path)

        files.append(
            FileInfo(
                path=relative_path,
                absolute_path=str(absolute_path),
                language=language,
                size_bytes=size_bytes,
                extension=path_obj.suffix.lower(),
            )
        )

    logger.info(
        "File discovery complete",
        extra={
            "total_files": len(files),
            "skipped_files": len(skipped),
            "languages": list({f.language for f in files if f.language}),
        },
    )

    return files, skipped


def _fallback_walk(
    root: Path, skipped: list[tuple[str, str]]
) -> list[FileInfo]:
    """
    Fallback file discovery using os.walk when git ls-files is unavailable.

    This is less accurate than git ls-files (does not respect .gitignore)
    but ensures the pipeline can still produce some result rather than
    failing completely. The result is logged clearly as a fallback.
    """
    logger.warning(
        "Using fallback os.walk discovery (git ls-files unavailable). "
        "Results may include .gitignored files.",
        extra={"root": str(root)},
    )
    files: list[FileInfo] = []

    for dirpath, dirnames, filenames in os.walk(root):
        # Modify dirnames in-place to prevent os.walk from descending
        # into directories we want to skip.
        dirnames[:] = [d for d in dirnames if d not in SKIP_DIRS]

        for filename in filenames:
            if len(files) >= MAX_FILES:
                break

            absolute = Path(dirpath) / filename
            relative = str(absolute.relative_to(root))

            if is_binary_extension(filename):
                skipped.append((relative, "binary file type (fallback walk)"))
                continue

            try:
                size_bytes = absolute.stat().st_size
            except OSError:
                continue

            files.append(
                FileInfo(
                    path=relative,
                    absolute_path=str(absolute),
                    language=detect_language(filename),
                    size_bytes=size_bytes,
                    extension=Path(filename).suffix.lower(),
                )
            )

    return files


def summarize_discovery(files: list[FileInfo]) -> dict:
    """
    Produce a human-readable summary of a discovery result.
    Used for logging and for the analysis_meta JSONB field.
    """
    by_language: dict[str, int] = {}
    for f in files:
        lang = f.language or "Unknown"
        by_language[lang] = by_language.get(lang, 0) + 1

    return {
        "total_files": len(files),
        "total_size_bytes": sum(f.size_bytes for f in files),
        "languages": dict(sorted(by_language.items(), key=lambda x: -x[1])),
    }
