"""
Generic fallback analyzer for languages without a dedicated AST analyzer.

For languages we don't specifically support (Go, Rust, Java, etc.),
we still want useful data: LOC counts and file size are meaningful
for the 3D city even without structural information.

This analyzer:
  - Always supports any language (and None).
  - Counts LOC (total, blank, code).
  - Returns zero for function_count, class_count, complexity, imports.
  - Sets parse_error to a note explaining why counts are zero.

As we add more language-specific analyzers, this fallback becomes
less frequently used. It ensures the pipeline always produces
*something* rather than silently dropping unsupported files.
"""
from __future__ import annotations

from analyzer.ast.base import ASTAnalyzer, count_lines
from analyzer.models import FileAnalysis, FileInfo


class GenericAnalyzer(ASTAnalyzer):
    """
    Fallback analyzer: LOC counts only, no structural analysis.

    Used for any language that doesn't have a dedicated analyzer.
    """

    def supports(self, language: str | None) -> bool:
        # This analyzer is the catch-all fallback.
        # It should always be registered LAST in the analyzer list.
        return True

    def analyze(self, source: str, file_info: FileInfo) -> FileAnalysis:
        result = FileAnalysis(file_info=file_info)
        result.loc_total, result.loc_blank, result.loc_code = count_lines(source)

        lang = file_info.language or "unknown"
        result.parse_error = (
            f"No AST analyzer available for {lang}. "
            "LOC counts are available; structural metrics are not."
        )
        return result
