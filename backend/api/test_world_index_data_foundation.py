"""WI1A model, taxonomy, and transactional PostgreSQL migration checks.

Run with: python -m unittest test_world_index_data_foundation
The database test creates its table in a throwaway schema and rolls back the
whole transaction; it does not apply Alembic 0004 to the application schema.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import unittest
import uuid

from alembic.migration import MigrationContext
from alembic.operations import Operations
from sqlalchemy import create_engine, inspect, insert, select, text, update
from sqlalchemy.exc import IntegrityError, OperationalError

from codeworld_db import AnalysisRun, City, Repository, WorldIndexRepository
from codeworld_db.world_taxonomy import (
    CURRENT_TAXONOMY_VERSION,
    TAXONOMIES,
    get_world_taxonomy,
)


MIGRATION_PATH = Path(__file__).parent / "alembic" / "versions" / "0004_world_index_foundation.py"


def load_migration():
    spec = importlib.util.spec_from_file_location("world_index_revision_0004", MIGRATION_PATH)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def record(github_id: int, **overrides):
    now = datetime(2026, 9, 25, 12, tzinfo=timezone.utc)
    values = {
        "github_repository_id": github_id,
        "github_owner_id": 12345,
        "owner_login": "wi1a-test-owner",
        "name": f"repo-{github_id}",
        "full_name": f"wi1a-test-owner/repo-{github_id}",
        "canonical_url": f"https://github.com/wi1a-test-owner/repo-{github_id}",
        "visibility": "public",
        "discovery_source": "analyzed_backfill",
        "last_refreshed_at": now,
        "last_public_verified_at": now,
    }
    values.update(overrides)
    return values


def reviewed_evidence(
    language_bytes: dict[str, int], ecosystem_bytes: dict[str, int],
    leader: dict, runner_up: dict | None, observed_head_sha: str | None,
) -> dict:
    return {
        "language_bytes_snapshot": language_bytes,
        "ecosystem_bytes": ecosystem_bytes,
        "language_observed_at": "2026-09-25T12:00:00+00:00",
        "observed_head_sha": observed_head_sha,
        "taxonomy_version": "wi1a.1",
        "classification_version": "reviewed-v0",
        "share_basis": "mapped_ecosystem_bytes",
        "leader": leader,
        "runner_up": runner_up,
        "decision_method": "manual_review",
        "decision_reason": "Reviewed language distribution and repository purpose.",
    }


class TaxonomyTests(unittest.TestCase):
    def test_versioned_mapping_and_tags(self):
        taxonomy = get_world_taxonomy(CURRENT_TAXONOMY_VERSION)
        self.assertEqual(CURRENT_TAXONOMY_VERSION, "wi1a.1")
        self.assertTrue({
            "python", "web", "rust", "go", "jvm", "native", "dotnet", "ruby",
            "php", "apple", "dart", "beam",
        }.issubset(taxonomy.ecosystems))
        self.assertEqual(taxonomy.ecosystem_for_language("Objective-C"), "apple")
        self.assertEqual(taxonomy.ecosystem_for_language("Objective-C++"), "apple")
        self.assertEqual(taxonomy.ecosystem_for_language("Vim Script"), "vim")
        self.assertEqual(taxonomy.ecosystem_for_language("Tcl"), "tcl")
        self.assertEqual(taxonomy.ecosystem_for_language("C#"), "dotnet")
        self.assertIsNone(taxonomy.ecosystem_for_language("Markdown"))
        self.assertEqual(taxonomy.cross_cutting_tags, {"mobile", "scientific"})
        self.assertTrue(taxonomy.cross_cutting_tags.isdisjoint(taxonomy.ecosystems))
        self.assertEqual(
            taxonomy.aggregate_bytes({"Python": 70, "Cython": 5, "Markdown": 20}),
            ({"python": 75}, 20),
        )
        with self.assertRaises(TypeError):
            taxonomy.language_to_ecosystem["python"] = "web"
        with self.assertRaises(TypeError):
            TAXONOMIES["wi1a.1"] = taxonomy

    def test_published_mapping_fingerprint(self):
        """A mapping change must create a new version instead of rewriting v1."""
        mapping = get_world_taxonomy("wi1a.1").language_to_ecosystem
        canonical = json.dumps(sorted(mapping.items()), separators=(",", ":"))
        self.assertEqual(
            hashlib.sha256(canonical.encode()).hexdigest(),
            "dcb1cd200693f90af1af4f96921d3e8cf1b82a9102e6e20fdaaa97ad6c55fe6e",
        )


class WorldIndexMigrationTests(unittest.TestCase):
    def test_upgrade_constraints_identity_link_and_downgrade(self):
        database_url = os.getenv(
            "WI1A_TEST_DATABASE_URL",
            "postgresql+psycopg2://codeworld:codeworld@localhost:5432/codeworld",
        )
        engine = create_engine(database_url, connect_args={"connect_timeout": 5})
        try:
            try:
                connection = engine.connect()
            except OperationalError as exc:
                self.fail(f"PostgreSQL is required for the WI1A migration test: {exc}")

            with connection:
                transaction = connection.begin()
                try:
                    existing_tables = ("repositories", "analysis_runs", "cities")
                    before = {
                        table: [column["name"] for column in inspect(connection).get_columns(table, schema="public")]
                        for table in existing_tables
                    }
                    schema = f"wi1a_test_{uuid.uuid4().hex[:12]}"
                    connection.exec_driver_sql(f'CREATE SCHEMA "{schema}"')
                    connection.exec_driver_sql(f'CREATE TABLE "{schema}".repositories (id uuid PRIMARY KEY)')
                    connection.exec_driver_sql(f'SET LOCAL search_path TO "{schema}", public')

                    migration = load_migration()
                    self.assertEqual(migration.revision, "0004")
                    self.assertEqual(migration.down_revision, "0003")
                    context = MigrationContext.configure(connection)
                    with Operations.context(context):
                        migration.upgrade()

                    foreign_key_schema = connection.execute(text(
                        "SELECT n.nspname FROM pg_constraint c "
                        "JOIN pg_class t ON t.oid = c.confrelid "
                        "JOIN pg_namespace n ON n.oid = t.relnamespace "
                        "WHERE c.conrelid = to_regclass(:table_name) AND c.contype = 'f'"
                    ), {"table_name": f"{schema}.world_index_repositories"}).scalar_one()
                    self.assertEqual(foreign_key_schema, schema)

                    inspector = inspect(connection)
                    self.assertIn("world_index_repositories", inspector.get_table_names(schema=schema))
                    self.assertEqual(
                        set(WorldIndexRepository.__table__.columns.keys()),
                        {column["name"] for column in inspector.get_columns(
                            "world_index_repositories", schema=schema
                        )},
                    )
                    checks = {
                        item["name"] for item in inspector.get_check_constraints(
                            "world_index_repositories", schema=schema
                        )
                    }
                    self.assertTrue({
                        "ck_world_index_public_only", "ck_world_index_classification_home",
                        "ck_world_index_language_bytes_object",
                        "ck_world_index_classification_evidence_object",
                        "ck_world_index_reviewed_evidence", "ck_world_index_reason_present",
                    }.issubset(checks))
                    indexes = {
                        item["name"] for item in inspector.get_indexes(
                            "world_index_repositories", schema=schema
                        )
                    }
                    self.assertTrue({
                        "ix_world_index_owner_repo", "ix_world_index_classification",
                        "ix_world_index_last_refreshed",
                    }.issubset(indexes))

                    table = WorldIndexRepository.__table__
                    original_evidence = reviewed_evidence(
                        {"Python": 120, "Tcl": 30}, {"python": 120, "tcl": 30},
                        {"ecosystem": "python", "share": 0.8},
                        {"ecosystem": "tcl", "share": 0.2}, "a" * 40,
                    )
                    connection.execute(insert(table).values(record(
                        1001, language_bytes={"Python": 120, "Tcl": 30},
                        language_observed_at=datetime(2026, 9, 25, 12, tzinfo=timezone.utc),
                        observed_head_sha="a" * 40,
                        classification_state="home", home_ecosystem="python",
                        classification_version="reviewed-v0", confidence="high",
                        reason_code="manual_review", classified_at=datetime(2026, 9, 25, 13, tzinfo=timezone.utc),
                        classification_evidence=original_evidence,
                    )))
                    connection.execute(insert(table).values(record(1002, reason_code="languages_pending")))
                    connection.execute(insert(table).values(record(
                        1012, classification_state="confluence", reason_code="manual_review",
                        classification_version="reviewed-v0",
                        classified_at=datetime(2026, 9, 25, 13, tzinfo=timezone.utc),
                        classification_evidence=reviewed_evidence(
                            {"Python": 50, "TypeScript": 50}, {"python": 50, "web": 50},
                            {"ecosystem": "python", "share": 0.5},
                            {"ecosystem": "web", "share": 0.5}, None,
                        ),
                    )))
                    row = connection.execute(select(table).where(table.c.github_repository_id == 1001)).one()
                    self.assertEqual(row.language_bytes, {"Python": 120, "Tcl": 30})
                    self.assertEqual(row.classification_evidence["ecosystem_bytes"], {"python": 120, "tcl": 30})
                    self.assertEqual(row.visibility, "public")
                    self.assertEqual(row.repository_id, None)
                    self.assertEqual(
                        connection.execute(select(table.c.language_bytes).where(
                            table.c.github_repository_id == 1002
                        )).scalar_one(), {}
                    )

                    # The latest observation changes; the reviewed evidence does not.
                    connection.execute(update(table).where(table.c.github_repository_id == 1001).values(
                        language_bytes={"Rust": 999},
                        language_observed_at=datetime(2026, 9, 26, 12, tzinfo=timezone.utc),
                        observed_head_sha="b" * 40,
                    ))
                    refreshed = connection.execute(select(table).where(table.c.github_repository_id == 1001)).one()
                    self.assertEqual(refreshed.language_bytes, {"Rust": 999})
                    self.assertEqual(refreshed.classification_evidence, original_evidence)
                    self._reject(connection, update(table).where(
                        table.c.github_repository_id == 1001
                    ).values(classification_evidence=None))
                    incomplete = dict(original_evidence)
                    incomplete.pop("language_bytes_snapshot")
                    self._reject(connection, update(table).where(
                        table.c.github_repository_id == 1001
                    ).values(classification_evidence=incomplete))
                    empty_distribution = dict(original_evidence)
                    empty_distribution["ecosystem_bytes"] = {}
                    self._reject(connection, update(table).where(
                        table.c.github_repository_id == 1001
                    ).values(classification_evidence=empty_distribution))
                    mismatched_version = dict(original_evidence)
                    mismatched_version["taxonomy_version"] = "future-version"
                    self._reject(connection, update(table).where(
                        table.c.github_repository_id == 1001
                    ).values(classification_evidence=mismatched_version))

                    # Numeric ID remains the key when the owner/name changes.
                    connection.execute(update(table).where(table.c.github_repository_id == 1001).values(
                        owner_login="renamed-owner", full_name="renamed-owner/repo-1001"
                    ))
                    renamed = connection.execute(select(table).where(table.c.github_repository_id == 1001)).one()
                    self.assertEqual(renamed.full_name, "renamed-owner/repo-1001")
                    self._reject(connection, insert(table).values(record(1001)))

                    self._reject(connection, insert(table).values(record(0)))
                    self._reject(connection, insert(table).values(record(1013, github_owner_id=0)))
                    self._reject(connection, insert(table).values(record(1003, visibility="private")))
                    missing_visibility = record(1014)
                    del missing_visibility["visibility"]
                    self._reject(connection, insert(table).values(missing_visibility))
                    self._reject(connection, insert(table).values(record(1004, classification_state="home")))
                    self._reject(connection, insert(table).values(record(
                        1005, classification_state="home", home_ecosystem="  "
                    )))
                    self._reject(connection, insert(table).values(record(
                        1006, classification_state="confluence", home_ecosystem="web"
                    )))
                    self._reject(connection, insert(table).values(record(
                        1007, classification_state="unclassified", home_ecosystem="rust"
                    )))
                    self._reject(connection, insert(table).values(record(
                        1008, classification_state="other"
                    )))
                    self._reject(connection, insert(table).values(record(
                        1009, language_bytes=["Python"]
                    )))
                    self._reject(connection, insert(table).values(record(
                        1010, classification_evidence=["bad"]
                    )))
                    self._reject(connection, insert(table).values(record(1015, reason_code=" ")))

                    repository_id = str(uuid.uuid4())
                    connection.execute(text("INSERT INTO repositories (id) VALUES (:id)"), {"id": repository_id})
                    connection.execute(update(table).where(table.c.github_repository_id == 1001).values(
                        repository_id=repository_id
                    ))
                    self._reject(connection, insert(table).values(record(1011, repository_id=repository_id)))
                    connection.execute(text("DELETE FROM repositories WHERE id = :id"), {"id": repository_id})
                    self.assertIsNone(connection.execute(
                        select(table.c.repository_id).where(table.c.github_repository_id == 1001)
                    ).scalar_one())

                    after = {
                        table_name: [column["name"] for column in inspect(connection).get_columns(
                            table_name, schema="public"
                        )]
                        for table_name in existing_tables
                    }
                    self.assertEqual(before, after)
                    self.assertEqual(Repository.__tablename__, "repositories")
                    self.assertEqual(AnalysisRun.__tablename__, "analysis_runs")
                    self.assertEqual(City.__tablename__, "cities")

                    with Operations.context(context):
                        migration.downgrade()
                    self.assertNotIn("world_index_repositories", inspect(connection).get_table_names(schema=schema))
                finally:
                    transaction.rollback()
        finally:
            engine.dispose()

    def _reject(self, connection, statement):
        with self.assertRaises(IntegrityError):
            with connection.begin_nested():
                connection.execute(statement)


if __name__ == "__main__":
    unittest.main()
