"use client";

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { WorldMapResponse } from "@/types/world";
import { getWorldMap } from "@/lib/api";
import { computeWorldLayout } from "@/lib/worldLayout";
import { WorldViewport } from "./WorldViewport";

export function WorldMap() {
  const [data, setData] = useState<WorldMapResponse | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);

  const fetchWorld = useCallback(async (signal?: AbortSignal) => {
    setIsLoading(true);
    setError(null);

    try {
      const response = await getWorldMap(signal);
      setData(response);
    } catch (err: unknown) {
      if (signal?.aborted) return;
      setError("Unable to load the World Map. Please try again.");
    } finally {
      if (!signal?.aborted) {
        setIsLoading(false);
      }
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    fetchWorld(controller.signal);

    return () => {
      controller.abort();
    };
  }, [fetchWorld]);

  // Memoize world layout calculation: re-runs only when backend data changes
  const layout = useMemo(() => {
    if (!data || !data.cities) return null;
    return computeWorldLayout(data.cities);
  }, [data]);

  return (
    <div className="w-full">
      <div className="flex items-center justify-between mb-3 px-1">
        <div>
          <h2 className="text-sm font-mono uppercase tracking-wider text-neutral-400">
            World Map &bull; Planetary Overview
          </h2>
          <p className="text-xs text-neutral-500 mt-0.5">
            Ecosystem archipelago &bull; Repositories grouped by owner
          </p>
        </div>
      </div>

      {isLoading && (
        <div
          data-testid="world-map-loading"
          className="flex h-[620px] w-full flex-col items-center justify-center rounded-2xl border border-neutral-800 bg-[#070b14]"
        >
          <div className="h-8 w-8 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
          <p className="mt-4 font-mono text-xs text-neutral-400">
            Mapping CodeWorld Ecosystems...
          </p>
        </div>
      )}

      {!isLoading && error && (
        <div
          data-testid="world-map-error"
          className="flex h-[620px] w-full flex-col items-center justify-center rounded-2xl border border-red-500/20 bg-[#070b14] p-6 text-center"
        >
          <div className="rounded-full bg-red-950/40 p-3 border border-red-500/30">
            <span className="text-red-400 text-lg">&times;</span>
          </div>
          <h3 className="mt-3 text-sm font-semibold text-neutral-200">
            World Map Unavailable
          </h3>
          <p className="mt-1 max-w-sm text-xs text-neutral-400 font-mono">
            {error}
          </p>
          <button
            type="button"
            data-testid="world-map-retry-btn"
            onClick={() => fetchWorld()}
            className="mt-5 rounded-lg bg-red-900/40 hover:bg-red-800/60 border border-red-700/50 px-4 py-2 text-xs font-mono text-red-200 transition-colors cursor-pointer"
          >
            Retry Connection
          </button>
        </div>
      )}

      {!isLoading && !error && data && data.cities.length === 0 && (
        <div
          data-testid="world-map-empty"
          className="flex h-[620px] w-full flex-col items-center justify-center rounded-2xl border border-neutral-800 bg-[#070b14] p-6 text-center"
        >
          <div className="rounded-full bg-neutral-900 p-3 border border-neutral-800">
            <span className="text-neutral-500 text-base">&empty;</span>
          </div>
          <h3 className="mt-3 text-sm font-semibold text-neutral-200">
            No Repositories on the World Map Yet
          </h3>
          <p className="mt-1 max-w-md text-xs text-neutral-400 leading-relaxed">
            Enter a public GitHub repository URL above to analyze your first software city and establish a new province.
          </p>
        </div>
      )}

      {!isLoading && !error && layout && data && data.cities.length > 0 && (
        <WorldViewport layout={layout} />
      )}
    </div>
  );
}
