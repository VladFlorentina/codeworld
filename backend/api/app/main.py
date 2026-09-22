from __future__ import annotations

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.config import settings
from app.database import engine, Base
from app.routers import health, repositories, cities, jobs, auth, github, explore

app = FastAPI(
    title="CodeWorld API",
    description="Backend for the CodeWorld 3D repository visualization platform.",
    version="0.1.0",
    docs_url="/docs",
    redoc_url="/redoc",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(health.router, prefix="/api/v1", tags=["health"])
app.include_router(repositories.router, prefix="/api/v1", tags=["repositories"])
app.include_router(cities.router, prefix="/api/v1", tags=["cities"])
app.include_router(jobs.router, prefix="/api/v1", tags=["jobs"])
app.include_router(auth.router, prefix="/api/v1", tags=["auth"])
app.include_router(github.router, prefix="/api/v1", tags=["github"])
app.include_router(explore.router, prefix="/api/v1", tags=["explore"])
