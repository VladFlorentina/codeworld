"use client";

import React from "react";
import { LayoutBuilding } from "@/types/layout";

interface BuildingInspectorProps {
  building: LayoutBuilding | null;
  onClose: () => void;
}

/**
 * BuildingInspector — HTML component displaying detailed raw metrics
 * for the currently selected building.
 */
export default function BuildingInspector({
  building,
  onClose,
}: BuildingInspectorProps) {
  if (!building) return null;

  const { metrics } = building;

  return (
    <aside
      data-testid="building-inspector"
      className="absolute top-16 right-6 z-20 w-84 max-w-[calc(100vw-3rem)] rounded-xl border border-neutral-800/90 bg-[#0f172a]/95 p-5 shadow-2xl backdrop-blur-md text-neutral-200 transition-all"
    >
      {/* Header with Color Tag, Name, and Close Button */}
      <div className="flex items-start justify-between gap-3 border-b border-neutral-800 pb-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span
            className="h-3.5 w-3.5 shrink-0 rounded-full border border-white/20"
            style={{ backgroundColor: building.color_hex || "#888888" }}
            title={building.language || "Unknown"}
          />
          <div className="truncate">
            <h2
              data-testid="inspector-name"
              className="text-sm font-bold text-white truncate"
              title={building.name}
            >
              {building.name}
            </h2>
            <span
              data-testid="inspector-language"
              className="text-[11px] font-mono text-neutral-400"
            >
              {building.language || "Unknown"}
            </span>
          </div>
        </div>

        <button
          onClick={onClose}
          data-testid="inspector-close-btn"
          className="shrink-0 rounded p-1 text-neutral-400 hover:bg-neutral-800 hover:text-white transition-colors cursor-pointer"
          title="Close inspector"
          aria-label="Close inspector"
        >
          <svg
            xmlns="http://www.w3.org/2000/svg"
            className="h-4 w-4"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>

      {/* Path & Color Hex */}
      <div className="py-3 space-y-1.5 border-b border-neutral-800/60 font-mono text-xs">
        <div>
          <span className="text-neutral-500 block text-[10px] uppercase tracking-wider">Path</span>
          <span data-testid="inspector-path" className="text-neutral-300 break-all select-all">
            {building.path}
          </span>
        </div>
        <div className="flex items-center justify-between text-[11px] pt-1">
          <span className="text-neutral-500">Color Hex:</span>
          <span data-testid="inspector-color-hex" className="text-neutral-300 font-mono select-all">
            {building.color_hex}
          </span>
        </div>
      </div>

      {/* Raw Metrics Section */}
      <div className="pt-3 space-y-3 text-xs font-mono">
        <div className="text-[10px] font-semibold text-neutral-400 uppercase tracking-wider">
          Metrics &amp; Dependency Graph
        </div>

        {/* Lines of Code Grid */}
        <div className="grid grid-cols-3 gap-2 bg-neutral-950/60 p-2.5 rounded-lg border border-neutral-800/60 text-center">
          <div>
            <div className="text-neutral-500 text-[10px]">Total LOC</div>
            <div data-testid="inspector-loc-total" className="text-neutral-100 font-bold">
              {metrics.loc_total}
            </div>
          </div>
          <div>
            <div className="text-neutral-500 text-[10px]">Code LOC</div>
            <div data-testid="inspector-loc-code" className="text-emerald-400 font-bold">
              {metrics.loc_code}
            </div>
          </div>
          <div>
            <div className="text-neutral-500 text-[10px]">Blank LOC</div>
            <div data-testid="inspector-loc-blank" className="text-neutral-400 font-bold">
              {metrics.loc_blank}
            </div>
          </div>
        </div>

        {/* Complexity & Counts Grid */}
        <div className="grid grid-cols-2 gap-2">
          <div className="bg-neutral-950/50 p-2 rounded border border-neutral-800/40 flex justify-between items-center">
            <span className="text-neutral-400 text-[11px]">Complexity:</span>
            <span data-testid="inspector-complexity" className="text-neutral-100 font-bold">
              {metrics.complexity}
            </span>
          </div>
          <div className="bg-neutral-950/50 p-2 rounded border border-neutral-800/40 flex justify-between items-center">
            <span className="text-neutral-400 text-[11px]">Functions:</span>
            <span data-testid="inspector-function-count" className="text-neutral-100 font-bold">
              {metrics.function_count}
            </span>
          </div>
          <div className="bg-neutral-950/50 p-2 rounded border border-neutral-800/40 flex justify-between items-center">
            <span className="text-neutral-400 text-[11px]">Classes:</span>
            <span data-testid="inspector-class-count" className="text-neutral-100 font-bold">
              {metrics.class_count}
            </span>
          </div>
          <div className="bg-neutral-950/50 p-2 rounded border border-neutral-800/40 flex justify-between items-center">
            <span className="text-neutral-400 text-[11px]">Interfaces:</span>
            <span data-testid="inspector-interface-count" className="text-neutral-100 font-bold">
              {metrics.interface_count}
            </span>
          </div>
        </div>

        {/* Dependency Graph Degrees & Cycle */}
        <div className="space-y-1.5 pt-1">
          <div className="bg-neutral-950/50 p-2 rounded border border-neutral-800/40 flex justify-between items-center">
            <span className="text-neutral-400 text-[11px]">In-Degree (imported by):</span>
            <span data-testid="inspector-in-degree" className="text-sky-400 font-bold">
              {metrics.in_degree}
            </span>
          </div>
          <div className="bg-neutral-950/50 p-2 rounded border border-neutral-800/40 flex justify-between items-center">
            <span className="text-neutral-400 text-[11px]">Out-Degree (imports):</span>
            <span data-testid="inspector-out-degree" className="text-cyan-400 font-bold">
              {metrics.out_degree}
            </span>
          </div>
          <div className="bg-neutral-950/50 p-2 rounded border border-neutral-800/40 flex justify-between items-center">
            <span className="text-neutral-400 text-[11px]">Is in cycle:</span>
            <span
              data-testid="inspector-is-in-cycle"
              className={`font-bold ${
                metrics.is_in_cycle ? "text-amber-400" : "text-neutral-400"
              }`}
            >
              {metrics.is_in_cycle ? "true" : "false"}
            </span>
          </div>
        </div>
      </div>
    </aside>
  );
}
