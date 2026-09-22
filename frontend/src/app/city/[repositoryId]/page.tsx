"use client";

import React, { use, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { ApiError, getCity, getGitHubLoginUrl } from "@/lib/api";
import { computeCityLayout } from "@/lib/layout";
import { LayoutCity } from "@/types/layout";
import BuildingInspector from "@/components/inspector/BuildingInspector";

// Dynamically import CityCanvas with SSR disabled to ensure WebGL context only runs client-side
const CityCanvas = dynamic(() => import("@/components/canvas/CityCanvas"), {
  ssr: false,
  loading: () => (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 bg-[#0a0f1d] text-neutral-400">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
      <span className="text-sm font-mono tracking-wide">Initializing 3D Canvas...</span>
    </div>
  ),
});

interface CityViewerError {
  status: number;
  title: string;
  message: string;
}

export default function CityViewerPage({
  params,
}: {
  params: Promise<{ repositoryId: string }>;
}) {
  const { repositoryId } = use(params);

  const [layout, setLayout] = useState<LayoutCity | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<CityViewerError | null>(null);
  const [selectedBuildingId, setSelectedBuildingId] = useState<string | null>(null);
  const [timings, setTimings] = useState<{ fetchMs: number; layoutMs: number } | null>(null);

  const loadCityData = async (targetRepoId: string) => {
    setLoading(true);
    setError(null);
    setSelectedBuildingId(null);
    try {
      const t0 = performance.now();
      const city = await getCity(targetRepoId);
      const t1 = performance.now();
      const computedLayout = computeCityLayout(city);
      const t2 = performance.now();

      const fetchMs = Math.round(t1 - t0);
      const layoutMs = Math.round(t2 - t1);
      setTimings({ fetchMs, layoutMs });
      setLayout(computedLayout);

      if (typeof window !== "undefined") {
        (window as any).__timings = { fetchMs, layoutMs };
        (window as any).__cityLayout = computedLayout;
      }
    } catch (err: unknown) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          setError({
            status: 401,
            title: "Authentication Required",
            message: "This software city belongs to a private repository. Connect your GitHub account to access it.",
          });
        } else if (err.status === 403) {
          setError({
            status: 403,
            title: "Access Denied",
            message: "Your connected GitHub account does not have access to this private repository in the CodeWorld GitHub App.",
          });
        } else if (err.status === 404) {
          setError({
            status: 404,
            title: "City Not Found",
            message: "The requested software city or repository was not found.",
          });
        } else {
          setError({
            status: err.status,
            title: "Unable to Load City",
            message: "A server error occurred while retrieving this software city. Please try again.",
          });
        }
      } else {
        setError({
          status: 0,
          title: "Connection Error",
          message: "Unable to connect to the CodeWorld server. Please check your network connection.",
        });
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (repositoryId) {
      loadCityData(repositoryId);
    }
  }, [repositoryId]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      (window as any).__selectBuilding = setSelectedBuildingId;
      (window as any).__cityLayout = layout;
    }
  }, [layout]);

  const selectedBuilding = useMemo(() => {
    if (!layout || !selectedBuildingId) return null;
    return layout.buildings.find((b) => b.id === selectedBuildingId) || null;
  }, [layout, selectedBuildingId]);

  return (
    <div className="relative flex h-[calc(100vh-3.5rem)] w-full flex-col overflow-hidden bg-[#0a0f1d] text-white">
      <header className="z-10 flex h-14 items-center justify-between border-b border-neutral-800/80 bg-[#0f172a]/80 px-6 backdrop-blur-md">
        <div className="flex items-center gap-4">
          <Link
            href="/"
            data-testid="back-to-explore"
            className="flex items-center gap-1.5 rounded-lg border border-neutral-800 bg-neutral-900/90 px-3 py-1 text-xs font-medium text-neutral-300 transition-colors hover:border-neutral-700 hover:bg-neutral-800 hover:text-white"
          >
            <span>&larr;</span>
            <span>Explore Worlds</span>
          </Link>

          <div className="h-4 w-px bg-neutral-800" />

          <div className="flex items-center gap-2.5">
            <span className="h-2.5 w-2.5 rounded-sm bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" />
            <h1 className="text-sm font-semibold tracking-tight text-neutral-100 font-mono">
              {layout ? layout.repository_name : error ? "City Viewer" : "Loading Repository..."}
            </h1>
            {layout?.commit_sha && (
              <span className="rounded bg-neutral-800/80 px-1.5 py-0.5 text-[11px] font-mono text-neutral-400">
                {layout.commit_sha.slice(0, 7)}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-4 text-xs font-mono">
          {timings && (
            <div className="hidden md:flex items-center gap-2 text-neutral-400 border border-neutral-800/60 rounded px-2.5 py-1 bg-neutral-950/40">
              <span>Fetch: <strong className="text-emerald-400">{timings.fetchMs}ms</strong></span>
              <span className="text-neutral-600">&bull;</span>
              <span>Layout: <strong className="text-sky-400">{timings.layoutMs}ms</strong></span>
            </div>
          )}

          {layout && (
            <div className="hidden lg:flex items-center gap-3 text-neutral-400">
              <span>Districts: <strong className="text-neutral-200">{layout.districts.length}</strong></span>
              <span className="text-neutral-600">&bull;</span>
              <span>Buildings: <strong className="text-neutral-200">{layout.buildings.length}</strong></span>
              <span className="text-neutral-600">&bull;</span>
              <span>Connections: <strong className="text-neutral-200">{layout.connections.length}</strong></span>
            </div>
          )}
        </div>
      </header>

      <div className="relative flex-1 w-full h-[calc(100vh-3.5rem)]">
        {loading && (
          <div data-testid="viewer-loading" className="flex h-full w-full flex-col items-center justify-center gap-4 bg-[#0a0f1d]">
            <div className="h-10 w-10 animate-spin rounded-full border-3 border-emerald-500 border-t-transparent" />
            <div className="text-center font-mono text-sm text-neutral-300">
              <p>Fetching repository city data from CodeWorld API...</p>
              <p className="text-xs text-neutral-500 mt-1">Calculating 3D city layout</p>
            </div>
          </div>
        )}

        {error && (
          <div data-testid="viewer-error-container" className="flex h-full w-full flex-col items-center justify-center gap-4 bg-[#0a0f1d] px-4 text-center">
            <div
              data-testid={`viewer-error-${error.status || "generic"}`}
              className="w-full max-w-md rounded-2xl border border-neutral-800 bg-neutral-900/90 p-8 shadow-2xl backdrop-blur-md"
            >
              {error.status === 401 && (
                <div data-testid="viewer-401">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-amber-500/30 bg-amber-950/40 text-amber-400">
                    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                  </div>
                  <h2 className="text-xl font-bold tracking-tight text-neutral-100">{error.title}</h2>
                  <p className="mt-2 text-xs text-neutral-400 leading-relaxed">{error.message}</p>
                  <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
                    <a
                      href={getGitHubLoginUrl()}
                      className="inline-flex w-full sm:w-auto items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-neutral-950 shadow-md shadow-emerald-500/20 hover:bg-emerald-400 transition-colors"
                    >
                      <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24">
                        <path
                          fillRule="evenodd"
                          clipRule="evenodd"
                          d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                        />
                      </svg>
                      <span>Connect GitHub</span>
                    </a>
                    <Link
                      href="/"
                      className="inline-flex w-full sm:w-auto items-center justify-center rounded-lg border border-neutral-700 bg-neutral-800/80 px-4 py-2 text-xs font-mono text-neutral-300 hover:bg-neutral-800 transition-colors"
                    >
                      Back to Explore
                    </Link>
                  </div>
                </div>
              )}

              {error.status === 403 && (
                <div data-testid="viewer-403">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-red-500/30 bg-red-950/40 text-red-400">
                    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  </div>
                  <h2 className="text-xl font-bold tracking-tight text-neutral-100">{error.title}</h2>
                  <p className="mt-2 text-xs text-neutral-400 leading-relaxed">{error.message}</p>
                  <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
                    <Link
                      href="/my-repositories"
                      className="inline-flex w-full sm:w-auto items-center justify-center rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-neutral-950 shadow-md shadow-emerald-500/20 hover:bg-emerald-400 transition-colors"
                    >
                      My Repositories
                    </Link>
                    <Link
                      href="/"
                      className="inline-flex w-full sm:w-auto items-center justify-center rounded-lg border border-neutral-700 bg-neutral-800/80 px-4 py-2 text-xs font-mono text-neutral-300 hover:bg-neutral-800 transition-colors"
                    >
                      Back to Explore
                    </Link>
                  </div>
                </div>
              )}

              {error.status === 404 && (
                <div data-testid="viewer-404">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-neutral-700 bg-neutral-800/60 text-neutral-400">
                    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="11" cy="11" r="8" />
                      <line x1="21" y1="21" x2="16.65" y2="16.65" />
                    </svg>
                  </div>
                  <h2 className="text-xl font-bold tracking-tight text-neutral-100">{error.title}</h2>
                  <p className="mt-2 text-xs text-neutral-400 leading-relaxed">{error.message}</p>
                  <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
                    <Link
                      href="/"
                      className="inline-flex w-full sm:w-auto items-center justify-center rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-neutral-950 shadow-md shadow-emerald-500/20 hover:bg-emerald-400 transition-colors"
                    >
                      Explore Public Cities
                    </Link>
                    <Link
                      href="/my-repositories"
                      className="inline-flex w-full sm:w-auto items-center justify-center rounded-lg border border-neutral-700 bg-neutral-800/80 px-4 py-2 text-xs font-mono text-neutral-300 hover:bg-neutral-800 transition-colors"
                    >
                      My Repositories
                    </Link>
                  </div>
                </div>
              )}

              {error.status !== 401 && error.status !== 403 && error.status !== 404 && (
                <div data-testid="viewer-error">
                  <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-red-500/30 bg-red-950/40 text-red-400">
                    <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <circle cx="12" cy="12" r="10" />
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  </div>
                  <h2 className="text-xl font-bold tracking-tight text-neutral-100">{error.title}</h2>
                  <p className="mt-2 text-xs text-neutral-400 leading-relaxed">{error.message}</p>
                  <div className="mt-6 flex flex-col sm:flex-row items-center justify-center gap-3">
                    <button
                      onClick={() => loadCityData(repositoryId)}
                      className="inline-flex w-full sm:w-auto items-center justify-center rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-neutral-950 shadow-md shadow-emerald-500/20 hover:bg-emerald-400 transition-colors cursor-pointer"
                    >
                      Retry
                    </button>
                    <Link
                      href="/"
                      className="inline-flex w-full sm:w-auto items-center justify-center rounded-lg border border-neutral-700 bg-neutral-800/80 px-4 py-2 text-xs font-mono text-neutral-300 hover:bg-neutral-800 transition-colors"
                    >
                      Back to Explore
                    </Link>
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {!loading && !error && layout && (
          <>
            <CityCanvas
              layout={layout}
              selectedBuildingId={selectedBuildingId}
              onSelectBuilding={setSelectedBuildingId}
            />
            <BuildingInspector
              building={selectedBuilding}
              onClose={() => setSelectedBuildingId(null)}
            />
          </>
        )}
      </div>
    </div>
  );
}
