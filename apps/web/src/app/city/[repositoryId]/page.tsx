"use client";

import React, { use, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { getCity } from "@/lib/api";
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

export default function CityViewerPage({
  params,
}: {
  params: Promise<{ repositoryId: string }>;
}) {
  const { repositoryId } = use(params);

  const [layout, setLayout] = useState<LayoutCity | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
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
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
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
      {/* Top Navigation Bar */}
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
              {layout ? layout.repository_name : "Loading Repository..."}
            </h1>
            {layout?.commit_sha && (
              <span className="rounded bg-neutral-800/80 px-1.5 py-0.5 text-[11px] font-mono text-neutral-400">
                {layout.commit_sha.slice(0, 7)}
              </span>
            )}
          </div>
        </div>

        {/* City Scale & Timing Telemetry */}
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

      {/* Main 3D Viewport & Inspector Overlay */}
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
          <div data-testid="viewer-error" className="flex h-full w-full flex-col items-center justify-center gap-4 bg-[#0a0f1d] px-4 text-center">
            <div className="rounded-xl border border-red-500/30 bg-red-950/30 p-6 max-w-lg">
              <div className="text-red-400 font-semibold mb-2 flex items-center justify-center gap-2">
                <span>Failed to load city layout</span>
              </div>
              <p className="text-xs font-mono text-red-300/80 mb-4">{error}</p>
              <div className="flex items-center justify-center gap-3">
                <button
                  onClick={() => loadCityData(repositoryId)}
                  className="rounded bg-red-600 hover:bg-red-500 px-4 py-2 text-xs font-medium text-white transition-colors cursor-pointer"
                >
                  Retry
                </button>
                <Link
                  href="/"
                  className="rounded border border-neutral-700 bg-neutral-800 hover:bg-neutral-700 px-4 py-2 text-xs font-medium text-neutral-200 transition-colors"
                >
                  Back to Explore
                </Link>
              </div>
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
