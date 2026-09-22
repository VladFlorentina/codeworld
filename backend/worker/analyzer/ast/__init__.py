"""
AST analyzer registry.

This module is the single place where analyzers are registered
and where the pipeline asks "which analyzer handles this file?".

To add a new language:
  1. Create analyzer/ast/your_language_analyzer.py
  2. Implement ASTAnalyzer (supports + analyze)
  3. Add it to ANALYZERS below, BEFORE GenericAnalyzer.

Order matters: the first analyzer where supports() returns True is used.
GenericAnalyzer must always be last.
"""
from __future__ import annotations

import logging

from analyzer.ast.base import ASTAnalyzer
from analyzer.ast.generic_analyzer import GenericAnalyzer
from analyzer.ast.python_analyzer import PythonAnalyzer
from analyzer.ast.typescript_analyzer import TypeScriptAnalyzer
from analyzer.models import FileAnalysis, FileInfo

logger = logging.getLogger(__name__)

# ── Analyzer registry ─────────────────────────────────────────
# Add new analyzers here. Order = priority. GenericAnalyzer must be last.
ANALYZERS: list[ASTAnalyzer] = [
    PythonAnalyzer(),
    TypeScriptAnalyzer(),
    # Future: GoAnalyzer(), RustAnalyzer(), JavaAnalyzer(), ...
    GenericAnalyzer(),  # Must be last — catches everything else
]


def get_analyzer(language: str | None) -> ASTAnalyzer:
    """
    Return the first analyzer that supports the given language.
    Always returns something (GenericAnalyzer at minimum).
    """
    for analyzer in ANALYZERS:
        if analyzer.supports(language):
            return analyzer
    # Unreachable — GenericAnalyzer.supports() always returns True
    return GenericAnalyzer()


def analyze_file(file_info: FileInfo) -> FileAnalysis:
    """
    Read a source file and run the appropriate AST analyzer on it.

    This is the main entry point called by the pipeline for each file.
    Handles file reading errors gracefully — returns FileAnalysis with
    parse_error set rather than raising.

    Args:
        file_info: FileInfo describing the file to analyze.

    Returns:
        FileAnalysis — always. Never raises.
    """
    # ── Read source ───────────────────────────────────────────
    try:
        with open(file_info.absolute_path, encoding="utf-8", errors="replace") as f:
            source = f.read()
    except OSError as exc:
        result = FileAnalysis(file_info=file_info)
        result.parse_error = f"Could not read file: {exc}"
        logger.warning(
            "File read error",
            extra={"path": file_info.path, "error": str(exc)},
        )
        return result

    # ── Select analyzer and run ───────────────────────────────
    analyzer = get_analyzer(file_info.language)

    try:
        return analyzer.analyze(source, file_info)
    except Exception as exc:
        # Defensive: analyze() should never raise, but if it does,
        # capture it rather than aborting the entire pipeline.
        logger.error(
            "Analyzer raised unexpectedly",
            extra={
                "path": file_info.path,
                "analyzer": type(analyzer).__name__,
                "error": str(exc),
            },
            exc_info=True,
        )
        result = FileAnalysis(file_info=file_info)
        result.parse_error = f"Analyzer internal error: {exc}"
        return result
