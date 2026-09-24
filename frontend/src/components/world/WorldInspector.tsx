"use client";

import React from "react";
import { PositionedCity } from "@/types/world";
import { getEcosystemDisplayName } from "@/lib/ecosystems";
import { getEcosystemTheme } from "./worldTheme";

interface WorldInspectorProps {
  city: PositionedCity;
  onClose: () => void;
}

function formatAnalyzedDate(dateStr: string | null): string {
  if (!dateStr) return "N/A";
  try {
    const d = new Date(dateStr);
    if (isNaN(d.getTime())) return "N/A";
    const year = d.getUTCFullYear();
    const month = String(d.getUTCMonth() + 1).padStart(2, "0");
    const day = String(d.getUTCDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
  } catch {
    return "N/A";
  }
}

export function WorldInspector({ city, onClose }: WorldInspectorProps) {
  const { city: data, ecosystem } = city;
  const theme = getEcosystemTheme(ecosystem);
  const ecosystemName = getEcosystemDisplayName(ecosystem);
  const shortSha = data.commit_sha ? data.commit_sha.slice(0, 7) : "N/A";
  const formattedDate = formatAnalyzedDate(data.analyzed_at);

  return (
    <div
      data-testid="world-inspector"
      role="region"
      aria-label={`Inspector for ${data.full_name}`}
      className="absolute z-20 bottom-0 left-0 right-0 w-full max-h-[50vh] rounded-b-2xl rounded-t-2xl border-t md:bottom-auto md:left-auto md:top-4 md:right-4 md:w-88 md:max-h-[560px] md:rounded-2xl md:border border-neutral-800 bg-[#0d121f]/95 p-4 md:p-5 shadow-2xl backdrop-blur-md overflow-y-auto"
    >
      {/* Header: Ecosystem tag + Close button */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span
            data-testid="inspector-ecosystem"
            className="inline-flex items-center px-2 py-0.5 rounded-full text-xs font-mono font-medium"
            style={{
              backgroundColor: theme.countryFill,
              color: theme.plateLabel,
              border: `1px solid ${theme.countryStroke}`,
            }}
          >
            {ecosystemName}
          </span>
          <span
            data-testid="inspector-owner"
            className="text-xs font-mono text-neutral-400"
          >
            {data.owner}
          </span>
        </div>

        <button
          type="button"
          data-testid="inspector-close-btn"
          onClick={onClose}
          aria-label="Close inspector"
          className="flex h-7 w-7 items-center justify-center rounded-lg text-neutral-400 hover:text-white hover:bg-neutral-800 transition-colors cursor-pointer text-sm font-mono shrink-0"
        >
          ✕
        </button>
      </div>

      {/* Repository Name & Description */}
      <div className="mt-2.5">
        <h3
          data-testid="inspector-title"
          className="text-base font-semibold text-white tracking-tight break-words font-mono"
          title={data.full_name}
        >
          {data.name}
        </h3>
        <p
          data-testid="inspector-fullname"
          className="text-xs font-mono text-neutral-500 break-all"
        >
          {data.full_name}
        </p>
        <p
          data-testid="inspector-description"
          className="mt-2 text-xs text-neutral-300 leading-relaxed line-clamp-3"
        >
          {data.description || "No description provided."}
        </p>
      </div>

      {/* Key Metrics Grid */}
      <div className="mt-4 grid grid-cols-2 gap-2 text-xs font-mono">
        <div className="rounded-lg bg-neutral-900/80 border border-neutral-800/80 p-2.5">
          <span className="text-neutral-500 block text-[11px]">Language</span>
          <span data-testid="inspector-language" className="text-neutral-200 font-medium truncate block">
            {data.primary_language || "Unknown"}
          </span>
        </div>
        <div className="rounded-lg bg-neutral-900/80 border border-neutral-800/80 p-2.5">
          <span className="text-neutral-500 block text-[11px]">Total Files</span>
          <span data-testid="inspector-files" className="text-neutral-200 font-medium">
            {data.total_files.toLocaleString()}
          </span>
        </div>
        <div className="rounded-lg bg-neutral-900/80 border border-neutral-800/80 p-2.5">
          <span className="text-neutral-500 block text-[11px]">Total LOC</span>
          <span data-testid="inspector-loc" className="text-neutral-200 font-medium">
            {data.total_loc.toLocaleString()}
          </span>
        </div>
        <div className="rounded-lg bg-neutral-900/80 border border-neutral-800/80 p-2.5">
          <span className="text-neutral-500 block text-[11px]">Complexity</span>
          <span data-testid="inspector-complexity" className="text-neutral-200 font-medium">
            {data.complexity.toLocaleString()}
          </span>
        </div>
      </div>

      {/* Run Metadata */}
      <div className="mt-3 flex items-center justify-between text-[11px] font-mono text-neutral-500 px-0.5">
        <div>
          <span>Commit: </span>
          <span data-testid="inspector-commit-sha" className="text-neutral-400">
            {shortSha}
          </span>
        </div>
        <div>
          <span>Analyzed: </span>
          <span data-testid="inspector-analyzed-at" className="text-neutral-400">
            {formattedDate}
          </span>
        </div>
      </div>

      {/* Semantic CTA to 3D City */}
      <div className="mt-4">
        <a
          href={`/city/${data.repository_id}`}
          data-testid="inspector-enter-city"
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-emerald-500/15 hover:bg-emerald-500/25 border border-emerald-500/40 px-4 py-2.5 text-xs font-mono font-medium text-emerald-300 transition-colors text-center"
        >
          <span>Enter 3D City</span>
          <span>&rarr;</span>
        </a>
      </div>
    </div>
  );
}
