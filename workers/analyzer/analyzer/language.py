"""
Language detection for source files.

Design decisions:
  - Detection is based on file extension only. This is fast, deterministic,
    and correct for the vast majority of files in a source repository.
  - We do NOT use content sniffing in the MVP. Shebang-line detection
    (#!/usr/bin/env python) could be added later for extensionless scripts.
  - The language color palette mirrors GitHub Linguist so the 3D city
    uses instantly recognizable colors for developers.
  - Unknown extensions return None — the building gets a neutral grey color.
    We never discard a file just because we don't know its language.
"""
from __future__ import annotations

from pathlib import Path

# ─────────────────────────────────────────────────────────────
# Extension → Language name
# ─────────────────────────────────────────────────────────────
# Lowercase extension (including dot) → human-readable language label.
# This is the source of truth for language detection in the MVP.
# Add new entries here to support additional languages in future phases.

EXTENSION_MAP: dict[str, str] = {
    # Python
    ".py": "Python",
    ".pyi": "Python",
    ".pyw": "Python",
    # TypeScript
    ".ts": "TypeScript",
    ".tsx": "TypeScript",
    ".mts": "TypeScript",
    ".cts": "TypeScript",
    # JavaScript
    ".js": "JavaScript",
    ".jsx": "JavaScript",
    ".mjs": "JavaScript",
    ".cjs": "JavaScript",
    # Java
    ".java": "Java",
    # Go
    ".go": "Go",
    # Rust
    ".rs": "Rust",
    # C / C++
    ".c": "C",
    ".h": "C",
    ".cpp": "C++",
    ".cc": "C++",
    ".cxx": "C++",
    ".hpp": "C++",
    ".hh": "C++",
    # C#
    ".cs": "C#",
    # Ruby
    ".rb": "Ruby",
    ".rake": "Ruby",
    # PHP
    ".php": "PHP",
    # Swift
    ".swift": "Swift",
    # Kotlin
    ".kt": "Kotlin",
    ".kts": "Kotlin",
    # Scala
    ".scala": "Scala",
    ".sc": "Scala",
    # Dart
    ".dart": "Dart",
    # Elixir
    ".ex": "Elixir",
    ".exs": "Elixir",
    # Haskell
    ".hs": "Haskell",
    ".lhs": "Haskell",
    # Lua
    ".lua": "Lua",
    # R
    ".r": "R",
    ".R": "R",
    # HTML
    ".html": "HTML",
    ".htm": "HTML",
    # CSS
    ".css": "CSS",
    ".scss": "SCSS",
    ".sass": "Sass",
    ".less": "Less",
    # Data / Config
    ".json": "JSON",
    ".jsonc": "JSON",
    ".yaml": "YAML",
    ".yml": "YAML",
    ".toml": "TOML",
    ".xml": "XML",
    # Documentation
    ".md": "Markdown",
    ".mdx": "Markdown",
    ".rst": "reStructuredText",
    ".txt": "Text",
    # Shell
    ".sh": "Shell",
    ".bash": "Shell",
    ".zsh": "Shell",
    ".fish": "Shell",
    ".ps1": "PowerShell",
    # SQL
    ".sql": "SQL",
    # GraphQL
    ".graphql": "GraphQL",
    ".gql": "GraphQL",
    # Protocol Buffers
    ".proto": "Protocol Buffers",
    # Terraform
    ".tf": "HCL",
    ".hcl": "HCL",
    # Vue / Svelte / Astro
    ".vue": "Vue",
    ".svelte": "Svelte",
    ".astro": "Astro",
    # Dockerfile (handled separately — see detect_language)
    # Makefile (handled separately)
}

# ─────────────────────────────────────────────────────────────
# Language → GitHub Linguist hex color
# ─────────────────────────────────────────────────────────────
# Used by the world generator to assign building colors.
# Source: https://github.com/github/linguist/blob/master/lib/linguist/languages.yml

LANGUAGE_COLORS: dict[str, str] = {
    "Python": "#3572A5",
    "TypeScript": "#3178c6",
    "JavaScript": "#f1e05a",
    "Java": "#b07219",
    "Go": "#00ADD8",
    "Rust": "#dea584",
    "C": "#555555",
    "C++": "#f34b7d",
    "C#": "#178600",
    "Ruby": "#701516",
    "PHP": "#4F5D95",
    "Swift": "#F05138",
    "Kotlin": "#A97BFF",
    "Scala": "#c22d40",
    "Dart": "#00B4AB",
    "Elixir": "#6e4a7e",
    "Haskell": "#5e5086",
    "Lua": "#000080",
    "R": "#198CE7",
    "HTML": "#e34c26",
    "CSS": "#563d7c",
    "SCSS": "#c6538c",
    "Sass": "#a53b70",
    "Less": "#1d365d",
    "JSON": "#292929",
    "YAML": "#cb171e",
    "TOML": "#9c4221",
    "XML": "#0060ac",
    "Markdown": "#083fa1",
    "reStructuredText": "#141414",
    "Shell": "#89e051",
    "PowerShell": "#012456",
    "SQL": "#e38c00",
    "GraphQL": "#e10098",
    "Protocol Buffers": "#0e7fc0",
    "HCL": "#844FBA",
    "Vue": "#41b883",
    "Svelte": "#ff3e00",
    "Astro": "#ff5a03",
    "Dockerfile": "#384d54",
    "Makefile": "#427819",
    "Text": "#aaaaaa",
}

# Color used when language is unknown or None
DEFAULT_COLOR = "#888888"

# ─────────────────────────────────────────────────────────────
# Extensions we know are binary — skip these during discovery
# ─────────────────────────────────────────────────────────────
BINARY_EXTENSIONS: frozenset[str] = frozenset({
    # Images
    ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".svg", ".webp",
    ".tiff", ".tif", ".avif", ".heic",
    # Fonts
    ".ttf", ".otf", ".woff", ".woff2", ".eot",
    # Audio / Video
    ".mp3", ".mp4", ".wav", ".ogg", ".flac", ".avi", ".mov", ".mkv", ".webm",
    # Archives
    ".zip", ".tar", ".gz", ".bz2", ".xz", ".7z", ".rar",
    # Compiled / Binary
    ".pyc", ".pyo", ".class", ".o", ".a", ".so", ".dll", ".exe",
    ".wasm", ".bin", ".dat",
    # Documents
    ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
    # Databases
    ".db", ".sqlite", ".sqlite3",
    # Lock files with no analysis value
    ".lock",
})


# ─────────────────────────────────────────────────────────────
# Public API
# ─────────────────────────────────────────────────────────────

def detect_language(path: str | Path) -> str | None:
    """
    Detect the programming language of a file from its path.

    Returns the language label (e.g. "Python") or None if unknown.
    Detection is purely based on filename/extension — no file I/O.

    Examples:
        detect_language("src/main.py")        → "Python"
        detect_language("app/Button.tsx")     → "TypeScript"
        detect_language("Dockerfile")         → "Dockerfile"
        detect_language("Makefile")           → "Makefile"
        detect_language("src/data.bin")       → None
    """
    p = Path(path)
    name = p.name
    suffix = p.suffix.lower()

    # Special filenames that have no extension
    if name == "Dockerfile" or name.startswith("Dockerfile."):
        return "Dockerfile"
    if name == "Makefile" or name == "makefile" or name == "GNUmakefile":
        return "Makefile"
    if name == ".env" or name.startswith(".env."):
        return None  # Not a source file worth analyzing

    return EXTENSION_MAP.get(suffix)


def is_binary_extension(path: str | Path) -> bool:
    """
    Return True if the file extension is a known binary format.

    This is a fast pre-filter used by discovery.py to skip binary
    files before attempting to read them as text.
    """
    suffix = Path(path).suffix.lower()
    return suffix in BINARY_EXTENSIONS


def get_language_color(language: str | None) -> str:
    """
    Return the hex color for a language.
    Falls back to DEFAULT_COLOR for unknown languages.
    """
    if language is None:
        return DEFAULT_COLOR
    return LANGUAGE_COLORS.get(language, DEFAULT_COLOR)
