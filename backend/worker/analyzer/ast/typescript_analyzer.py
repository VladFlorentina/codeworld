"""
TypeScript and JavaScript AST analyzer using tree-sitter.

Handles: TypeScript (.ts), TSX (.tsx), JavaScript (.js, .jsx, .mjs, .cjs)

TypeScript is a superset of JavaScript, so the TS grammar parses JS too.
We use the TSX grammar for .tsx and .jsx files (supports JSX syntax).
The plain TS grammar is used for .ts, .js, .mjs, .cjs files.

Extracted information:
  - Function declarations, arrow functions, method definitions
  - Class declarations, interface declarations (counted as classes)
  - Import statements (ES module syntax)
  - Complexity estimate

Node types in the TypeScript tree-sitter grammar:
  Functions:
    function_declaration         function foo() {}
    generator_function_declaration  function* foo() {}
    method_definition            class { foo() {} }
    arrow_function               const f = () => {}
    function_expression          const f = function() {}

  Classes:
    class_declaration            class Foo {}
    abstract_class_declaration   abstract class Foo {}
    interface_declaration        interface IFoo {}  (TypeScript only)

  Imports:
    import_statement             import x from 'y'
    The source string is in the `source` child node (string type).

Complexity decision points:
  if_statement, else_clause, for_statement, for_in_statement,
  while_statement, do_statement, switch_case, catch_clause,
  ternary_expression, logical_expression (&&, ||, ??),
  optional_chain (?)
"""
from __future__ import annotations

import logging

import tree_sitter_typescript as tstyp
from tree_sitter import Language, Node, Parser

from analyzer.ast.base import ASTAnalyzer, count_lines
from analyzer.models import FileAnalysis, FileInfo, ImportedSymbol

logger = logging.getLogger(__name__)

# Initialize language objects once at module load.
# tree-sitter-typescript provides two grammars:
#   language_typescript() — for .ts and .js files
#   language_tsx()        — for .tsx and .jsx files (adds JSX support)
_TS_LANGUAGE = Language(tstyp.language_typescript())
_TSX_LANGUAGE = Language(tstyp.language_tsx())

_ts_parser = Parser(_TS_LANGUAGE)
_tsx_parser = Parser(_TSX_LANGUAGE)

# Node types that imply JSX syntax — use TSX grammar for these extensions.
_JSX_EXTENSIONS: frozenset[str] = frozenset({".tsx", ".jsx"})

_COMPLEXITY_NODES: frozenset[str] = frozenset({
    "if_statement",
    "else_clause",
    "for_statement",
    "for_in_statement",
    "while_statement",
    "do_statement",
    "switch_case",
    "catch_clause",
    "ternary_expression",
    "logical_expression",   # &&, ||, ??
    "optional_chain",
})

_FUNCTION_NODES: frozenset[str] = frozenset({
    "function_declaration",
    "generator_function_declaration",
    "method_definition",
    "arrow_function",
    "function_expression",
    "generator_function",
})

_CLASS_NODES: frozenset[str] = frozenset({
    "class_declaration",
    "abstract_class_declaration",
    # interface_declaration intentionally excluded — counted separately below.
})

# TypeScript interfaces are compile-time contracts erased at runtime.
# They carry different architectural meaning than classes and are
# counted in interface_count, not class_count.
_INTERFACE_NODES: frozenset[str] = frozenset({
    "interface_declaration",
})


def _walk(node: Node, visitor):
    """Depth-first traversal of a tree-sitter AST node."""
    visitor(node)
    for child in node.children:
        _walk(child, visitor)


def _iter_nodes(node: Node):
    yield node
    for child in node.children:
        yield from _iter_nodes(child)


def _extract_text(node: Node, source_bytes: bytes) -> str:
    return source_bytes[node.start_byte:node.end_byte].decode("utf-8", errors="replace")


def _parse_import(node: Node, source_bytes: bytes) -> ImportedSymbol | None:
    """
    Extract the module path from an ES module import_statement node.

    Handles all forms:
      import React from 'react'             → raw='react',      external=True
      import { useState } from 'react'      → raw='react',      external=True
      import type { FC } from 'react'       → raw='react',      external=True
      import * as fs from 'fs'              → raw='fs',         external=True
      import './styles.css'                 → raw='./styles.css', external=False
      import { foo } from './utils'         → raw='./utils',    external=False
      import { bar } from '@/components/x'  → raw='@/components/x', external=False
      const x = await import('module')      → handled as call_expression, skipped for now

    External heuristic:
      - Starts with '.' or '/' → intra-repo (relative or absolute import)
      - Starts with '@/' → path alias (treated as intra-repo, resolved in deps.py)
      - Everything else → external npm package
    """
    if node.type != "import_statement":
        return None

    # Find the string node that holds the module path.
    # In the TS grammar, the source of an import is always a string child.
    for child in node.children:
        if child.type == "string":
            raw = _extract_text(child, source_bytes).strip("'\"` ")
            if not raw:
                return None

            # Classify as external or intra-repo
            is_external = not (raw.startswith(".") or raw.startswith("/") or raw.startswith("@/"))

            return ImportedSymbol(raw=raw, is_external=is_external)

    return None


class TypeScriptAnalyzer(ASTAnalyzer):
    """AST analyzer for TypeScript and JavaScript source files."""

    def supports(self, language: str) -> bool:
        return language in ("TypeScript", "JavaScript")

    def analyze(self, source: str, file_info: FileInfo) -> FileAnalysis:
        result = FileAnalysis(file_info=file_info)

        # ── LOC counts ────────────────────────────────────────
        result.loc_total, result.loc_blank, result.loc_code = count_lines(source)

        # ── Choose grammar based on file extension ────────────
        use_tsx = file_info.extension in _JSX_EXTENSIONS
        parser = _tsx_parser if use_tsx else _ts_parser

        # ── Parse ─────────────────────────────────────────────
        try:
            source_bytes = source.encode("utf-8")
            tree = parser.parse(source_bytes)
        except Exception as exc:
            result.parse_error = f"tree-sitter parse failed: {exc}"
            logger.debug(
                "TypeScript/JS parse error",
                extra={"path": file_info.path, "error": str(exc)},
            )
            return result

        # ── Walk AST ──────────────────────────────────────────
        complexity = 0
        functions = 0
        classes = 0
        interfaces = 0
        imports: list[ImportedSymbol] = []

        def visit(node: Node) -> None:
            nonlocal complexity, functions, classes, interfaces

            t = node.type

            if t in _COMPLEXITY_NODES:
                complexity += 1

            if t in _FUNCTION_NODES:
                functions += 1

            if t in _CLASS_NODES:
                classes += 1

            if t in _INTERFACE_NODES:
                interfaces += 1

            if t == "import_statement":
                sym = _parse_import(node, source_bytes)
                if sym is not None:
                    imports.append(sym)

        _walk(tree.root_node, visit)

        result.complexity = max(1, complexity)
        result.function_count = functions
        result.class_count = classes
        result.interface_count = interfaces
        result.imports = imports

        # Record parse errors from ERROR nodes
        has_errors = any(
            node.type == "ERROR" for node in _iter_nodes(tree.root_node)
        )
        if has_errors:
            result.parse_error = "file contains syntax errors (partial analysis completed)"

        return result
