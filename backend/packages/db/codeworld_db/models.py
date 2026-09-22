from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Enum,
    Float,
    ForeignKey,
    Integer,
    String,
    Text,
    UniqueConstraint,
    false,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
from sqlalchemy.orm import Mapped, mapped_column, relationship

from codeworld_db.base import Base
from codeworld_db.enums import (
    AnalysisRunStatus,
    EdgeType,
    RepositoryStatus,
    SyncType,
)


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


def new_uuid() -> str:
    return str(uuid.uuid4())


class User(Base):
    __tablename__ = "users"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=new_uuid
    )
    github_user_id: Mapped[int] = mapped_column(
        BigInteger, unique=True, index=True, nullable=False
    )
    github_login: Mapped[str] = mapped_column(
        String(255), index=True, nullable=False
    )
    avatar_url: Mapped[str | None] = mapped_column(String(1024))
    encrypted_user_access_token: Mapped[str] = mapped_column(Text, nullable=False)
    encrypted_refresh_token: Mapped[str | None] = mapped_column(Text)
    user_token_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    refresh_token_expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )


class Repository(Base):
    __tablename__ = "repositories"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=new_uuid
    )
    github_owner: Mapped[str] = mapped_column(String(255), nullable=False)
    github_name: Mapped[str] = mapped_column(String(255), nullable=False)
    full_name: Mapped[str] = mapped_column(String(512), nullable=False)
    description: Mapped[str | None] = mapped_column(Text)
    default_branch: Mapped[str] = mapped_column(String(255), default="main")
    clone_url: Mapped[str] = mapped_column(String(1024), nullable=False)
    status: Mapped[RepositoryStatus] = mapped_column(
        Enum(RepositoryStatus, name="repositorystatus", values_callable=lambda x: [e.value for e in x]),
        default=RepositoryStatus.pending, nullable=False
    )
    sync_type: Mapped[SyncType] = mapped_column(
        Enum(SyncType, name="synctype", values_callable=lambda x: [e.value for e in x]),
        default=SyncType.public, nullable=False
    )
    is_private: Mapped[bool] = mapped_column(
        Boolean, default=False, server_default=false(), nullable=False
    )
    github_repository_id: Mapped[int | None] = mapped_column(
        BigInteger, unique=True, nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False
    )

    __table_args__ = (
        UniqueConstraint("github_owner", "github_name", name="uq_repository_full_name"),
    )

    analysis_runs: Mapped[list["AnalysisRun"]] = relationship(
        back_populates="repository", cascade="all, delete-orphan"
    )
    cities: Mapped[list["City"]] = relationship(
        back_populates="repository", cascade="all, delete-orphan"
    )


class AnalysisRun(Base):
    __tablename__ = "analysis_runs"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=new_uuid
    )
    repository_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("repositories.id", ondelete="CASCADE"), nullable=False
    )
    commit_sha: Mapped[str | None] = mapped_column(String(40))
    status: Mapped[AnalysisRunStatus] = mapped_column(
        Enum(AnalysisRunStatus, name="analysisrunstatus", values_callable=lambda x: [e.value for e in x]),
        default=AnalysisRunStatus.queued, nullable=False
    )
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    error_message: Mapped[str | None] = mapped_column(Text)
    analysis_meta: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )

    repository: Mapped["Repository"] = relationship(back_populates="analysis_runs")
    file_records: Mapped[list["FileRecord"]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )
    dependency_edges: Mapped[list["DependencyEdge"]] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )
    city: Mapped["City | None"] = relationship(
        back_populates="run", cascade="all, delete-orphan"
    )


class FileRecord(Base):
    __tablename__ = "file_records"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=new_uuid
    )
    run_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("analysis_runs.id", ondelete="CASCADE"), nullable=False
    )
    path: Mapped[str] = mapped_column(String(2048), nullable=False)
    language: Mapped[str | None] = mapped_column(String(64))
    loc: Mapped[int] = mapped_column(Integer, default=0)
    complexity: Mapped[int] = mapped_column(Integer, default=0)
    function_count: Mapped[int] = mapped_column(Integer, default=0)
    class_count: Mapped[int] = mapped_column(Integer, default=0)
    import_count: Mapped[int] = mapped_column(Integer, default=0)
    metrics: Mapped[dict | None] = mapped_column(JSONB)

    run: Mapped["AnalysisRun"] = relationship(back_populates="file_records")
    building: Mapped["Building | None"] = relationship(
        back_populates="file_record", cascade="all, delete-orphan"
    )


class DependencyEdge(Base):
    __tablename__ = "dependency_edges"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=new_uuid
    )
    run_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("analysis_runs.id", ondelete="CASCADE"), nullable=False
    )
    source_file: Mapped[str] = mapped_column(String(2048), nullable=False)
    target_file: Mapped[str] = mapped_column(String(2048), nullable=False)
    edge_type: Mapped[EdgeType] = mapped_column(
        Enum(EdgeType, name="edgetype", values_callable=lambda x: [e.value for e in x]), nullable=False
    )

    run: Mapped["AnalysisRun"] = relationship(back_populates="dependency_edges")


class City(Base):
    __tablename__ = "cities"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=new_uuid
    )
    run_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("analysis_runs.id", ondelete="CASCADE"),
        nullable=False, unique=True
    )
    repository_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("repositories.id", ondelete="CASCADE"), nullable=False
    )
    generated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), default=utcnow, nullable=False
    )

    run: Mapped["AnalysisRun"] = relationship(back_populates="city")
    repository: Mapped["Repository"] = relationship(back_populates="cities")
    districts: Mapped[list["District"]] = relationship(
        back_populates="city", cascade="all, delete-orphan"
    )
    buildings: Mapped[list["Building"]] = relationship(
        back_populates="city", cascade="all, delete-orphan"
    )
    connections: Mapped[list["Connection"]] = relationship(
        back_populates="city", cascade="all, delete-orphan"
    )


class District(Base):
    __tablename__ = "districts"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=new_uuid
    )
    city_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("cities.id", ondelete="CASCADE"), nullable=False
    )
    parent_id: Mapped[str | None] = mapped_column(
        UUID(as_uuid=False), ForeignKey("districts.id", ondelete="CASCADE")
    )
    path: Mapped[str] = mapped_column(String(2048), nullable=False)
    name: Mapped[str] = mapped_column(String(512), nullable=False)
    depth: Mapped[int] = mapped_column(Integer, default=0)

    city: Mapped["City"] = relationship(back_populates="districts")
    buildings: Mapped[list["Building"]] = relationship(back_populates="district")
    children: Mapped[list["District"]] = relationship("District")


class Building(Base):
    __tablename__ = "buildings"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=new_uuid
    )
    city_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("cities.id", ondelete="CASCADE"), nullable=False
    )
    district_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("districts.id", ondelete="CASCADE"), nullable=False
    )
    file_record_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("file_records.id", ondelete="CASCADE"), nullable=False
    )
    name: Mapped[str] = mapped_column(String(512), nullable=False)
    path: Mapped[str] = mapped_column(String(2048), nullable=False)
    height: Mapped[float] = mapped_column(Float, default=1.0)
    width: Mapped[float] = mapped_column(Float, default=1.0)
    depth: Mapped[float] = mapped_column(Float, default=1.0)
    color_hex: Mapped[str] = mapped_column(String(7), default="#888888")
    position_x: Mapped[float] = mapped_column(Float, default=0.0)
    position_z: Mapped[float] = mapped_column(Float, default=0.0)

    city: Mapped["City"] = relationship(back_populates="buildings")
    district: Mapped["District"] = relationship(back_populates="buildings")
    file_record: Mapped["FileRecord"] = relationship(back_populates="building")


class Connection(Base):
    __tablename__ = "connections"

    id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), primary_key=True, default=new_uuid
    )
    city_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("cities.id", ondelete="CASCADE"), nullable=False
    )
    source_building_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("buildings.id", ondelete="CASCADE"), nullable=False
    )
    target_building_id: Mapped[str] = mapped_column(
        UUID(as_uuid=False), ForeignKey("buildings.id", ondelete="CASCADE"), nullable=False
    )
    connection_type: Mapped[str] = mapped_column(String(32), default="import")

    city: Mapped["City"] = relationship(back_populates="connections")
