"""
Python AST analyzer using tree-sitter.

Extracts from Python source files:
  - Function definitions (def + async def)
  - Class definitions
  - Import statements (import x, from x import y)
  - Cyclomatic complexity estimate
  - LOC counts

Why tree-sitter instead of Python's built-in `ast` module?
  - The built-in `ast` module can only parse syntactically valid Python.
    Files with syntax errors raise SyntaxError and produce nothing.
  - tree-sitter is an error-tolerant parser: it produces a partial AST
    even for files with syntax errors, marked with ERROR nodes.
    This means we still extract functions and imports from mostly-valid files.
  - tree-sitter is language-agnostic — the same traversal infrastructure
    works for all language analyzers, making the codebase consistent.

Complexity estimation:
  We compute a rough cyclomatic complexity by counting decision points
  (branches) in the AST. This is not identical to McCabe complexity
  (which counts per-function), but gives a useful file-level signal.

  Decision points counted: if, elif, else (with body), for, while,
  with, except, and, or, conditional expression (ternary), match arms.
"""
from __future__ import annotations

import logging

import tree_sitter_python as tspython
from tree_sitter import Language, Node, Parser

from analyzer.ast.base import ASTAnalyzer, count_lines
from analyzer.models import FileAnalysis, FileInfo, ImportedSymbol

logger = logging.getLogger(__name__)

# Initialize once at module load — Language objects are expensive to create.
_PY_LANGUAGE = Language(tspython.language())
_parser = Parser(_PY_LANGUAGE)

# Node types that represent a decision point for complexity counting.
# Each occurrence adds 1 to the complexity score.
_COMPLEXITY_NODES: frozenset[str] = frozenset({
    "if_statement",
    "elif_clause",
    "else_clause",
    "for_statement",
    "while_statement",
    "with_statement",
    "except_clause",
    "boolean_operator",      # and / or
    "conditional_expression", # x if cond else y
    "match_statement",
    "case_clause",
    "try_statement",
})


def _walk(node: Node, visitor):
    """Depth-first traversal of a tree-sitter AST node."""
    visitor(node)
    for child in node.children:
        _walk(child, visitor)


def _extract_text(node: Node, source_bytes: bytes) -> str:
    """Extract the raw source text for a node."""
    return source_bytes[node.start_byte:node.end_byte].decode("utf-8", errors="replace")


def _parse_import(node: Node, source_bytes: bytes) -> ImportedSymbol | None:
    """
    Convert an import_statement or import_from_statement AST node
    into an ImportedSymbol.

    Examples:
      import os                → raw="os",         is_external=True
      import os.path           → raw="os.path",    is_external=True
      from pathlib import Path → raw="pathlib",    is_external=True
      from . import utils      → raw=".",          is_external=False
      from ..auth import login → raw="..auth",     is_external=False
      from app.models import X → raw="app.models", is_external=? (unresolved)

    Resolution of relative imports to absolute paths is done later
    in deps.py, which has access to the full file tree.
    """
    if node.type == "import_statement":
        # e.g. `import os` or `import os, sys`
        # Child 1 is the module name(s)
        for child in node.children:
            if child.type in ("dotted_name", "aliased_import"):
                raw = _extract_text(child, source_bytes).split(" as ")[0].strip()
                return ImportedSymbol(
                    raw=raw,
                    is_external=not raw.startswith("."),
                )
        return None

    if node.type == "import_from_statement":
        # e.g. `from pathlib import Path` or `from . import utils`
        # The "from" part is what matters for the dependency edge.
        from_part = None
        for child in node.children:
            if child.type == "relative_import":
                # Relative import: from . import x  or  from ..auth import x
                dots = ""
                module = ""
                for sub in child.children:
                    if sub.type == "import_prefix":
                        dots = _extract_text(sub, source_bytes)
                    elif sub.type == "dotted_name":
                        module = _extract_text(sub, source_bytes)
                from_part = dots + module
                break
            elif child.type == "dotted_name" and from_part is None:
                from_part = _extract_text(child, source_bytes)

        if from_part is not None:
            is_external = not from_part.startswith(".")
            return ImportedSymbol(raw=from_part, is_external=is_external)

    return None


class PythonAnalyzer(ASTAnalyzer):
    """AST analyzer for Python source files."""

    def supports(self, language: str) -> bool:
        return language == "Python"

    def analyze(self, source: str, file_info: FileInfo) -> FileAnalysis:
        result = FileAnalysis(file_info=file_info)

        # ── LOC counts (no parsing needed) ───────────────────
        result.loc_total, result.loc_blank, result.loc_code = count_lines(source)

        # ── Parse with tree-sitter ────────────────────────────
        try:
            source_bytes = source.encode("utf-8")
            tree = _parser.parse(source_bytes)
        except Exception as exc:
            result.parse_error = f"tree-sitter parse failed: {exc}"
            logger.debug(
                "Python parse error",
                extra={"path": file_info.path, "error": str(exc)},
            )
            return result

        # ── Walk AST and collect metrics ─────────────────────
        complexity = 0
        functions = 0
        classes = 0
        imports: list[ImportedSymbol] = []

        def visit(node: Node) -> None:
            nonlocal complexity, functions, classes

            t = node.type

            # Count decision points for complexity
            if t in _COMPLEXITY_NODES:
                complexity += 1

            # Count function definitions (def and async def)
            if t in ("function_definition", "async_function_definition"):
                functions += 1

            # Count class definitions
            if t == "class_definition":
                classes += 1

            # Extract imports
            if t in ("import_statement", "import_from_statement"):
                sym = _parse_import(node, source_bytes)
                if sym is not None:
                    imports.append(sym)

            # Note: we don't stop recursion even for functions/classes —
            # nested functions and inner classes should still be counted.

        _walk(tree.root_node, visit)

        result.complexity = max(1, complexity)  # minimum complexity is 1
        result.function_count = functions
        result.class_count = classes
        result.imports = imports

        # Check if tree-sitter reported parse errors
        # (ERROR nodes in the tree mean the file had syntax issues)
        has_errors = any(
            node.type == "ERROR"
            for node in _iter_nodes(tree.root_node)
        )
        if has_errors:
            result.parse_error = "file contains syntax errors (partial analysis completed)"

        return result


def _iter_nodes(node: Node):
    """Iterate all nodes in a tree (generator version of _walk)."""
    yield node
    for child in node.children:
        yield from _iter_nodes(child)
