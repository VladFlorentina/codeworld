"""
Abstract base class for all AST analyzers.

Design contract:
  - Every language-specific analyzer implements exactly two methods:
      supports(language) → bool
      analyze(source, file_info) → FileAnalysis
  - analyze() NEVER raises. Any parse error is captured in
    FileAnalysis.parse_error and the function returns whatever
    partial data it managed to collect. This is deliberate:
    one bad file must never abort the entire analysis run.
  - Analyzers are stateless — instantiate once, call analyze() many times.
  - The pipeline selects the first analyzer where supports() returns True.
    Order matters: register more specific analyzers before generic ones.
"""
from __future__ import annotations

from abc import ABC, abstractmethod

from analyzer.models import FileAnalysis, FileInfo


class ASTAnalyzer(ABC):
    """
    Base class for all language-specific AST analyzers.

    Adding support for a new language means:
      1. Create a new subclass in analyzer/ast/.
      2. Implement supports() and analyze().
      3. Register it in analyzer/ast/__init__.py.
    That is all. The pipeline does not change.
    """

    @abstractmethod
    def supports(self, language: str) -> bool:
        """
        Return True if this analyzer can handle the given language label.

        The label is the value returned by language.detect_language(),
        e.g. "Python", "TypeScript", "JavaScript".
        """

    @abstractmethod
    def analyze(self, source: str, file_info: FileInfo) -> FileAnalysis:
        """
        Parse source code and extract structural information.

        Args:
            source:    Full source code of the file as a UTF-8 string.
            file_info: FileInfo for this file (path, language, size, etc.)

        Returns:
            FileAnalysis with counts, imports, and complexity.
            If parsing fails, returns a FileAnalysis with parse_error set
            and zeros for all counts.

        This method must NEVER raise an exception.
        """


def count_lines(source: str) -> tuple[int, int, int]:
    """
    Count total, blank, and code lines in a source file.

    Returns:
        (loc_total, loc_blank, loc_code)

    loc_code = loc_total - loc_blank
    (Comments are included in loc_code — differentiating them
    requires language-specific AST knowledge done per analyzer.)

    This helper is language-agnostic and used by all analyzers.
    """
    lines = source.splitlines()
    loc_total = len(lines)
    loc_blank = sum(1 for line in lines if not line.strip())
    loc_code = loc_total - loc_blank
    return loc_total, loc_blank, loc_code
