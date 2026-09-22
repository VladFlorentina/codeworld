"use client";

import React from "react";
import { GitHubRepositoryDTO } from "@/types/auth";

export interface RepositoryCardProps {
  repo: GitHubRepositoryDTO;
  isProcessing: boolean;
  statusText?: string | null;
  hasActionError: boolean;
  disableActions: boolean;
  onAnalyze: (repo: GitHubRepositoryDTO) => void;
}

export function RepositoryCard({
  repo,
  isProcessing,
  statusText,
  hasActionError,
  disableActions,
  onAnalyze,
}: RepositoryCardProps) {
  return (
    <div
      data-testid={`repo-card-${repo.id}`}
      className={`relative flex flex-col justify-between rounded-xl border p-5 transition-all ${
        isProcessing
          ? "border-emerald-500/60 bg-emerald-950/20 shadow-lg shadow-emerald-500/10"
          : "border-neutral-800/80 bg-neutral-900/50 hover:border-neutral-700/80 hover:bg-neutral-900/80"
      }`}
    >
      <div>
        <div className="flex items-center justify-between gap-2">
          {repo.private ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-amber-500/40 bg-amber-500/10 px-2 py-0.5 text-[10px] font-mono font-medium text-amber-400">
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                <path d="M7 11V7a5 5 0 0 1 10 0v4" />
              </svg>
              <span>Private</span>
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-neutral-700 bg-neutral-800/60 px-2 py-0.5 text-[10px] font-mono font-medium text-neutral-300">
              <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="10" />
                <line x1="2" y1="12" x2="22" y2="12" />
                <path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" />
              </svg>
              <span>Public</span>
            </span>
          )}

          <span className="rounded border border-neutral-800 bg-neutral-900/80 px-1.5 py-0.5 text-[10px] font-mono text-neutral-400">
            {repo.default_branch || "main"}
          </span>
        </div>

        <div className="mt-3">
          <h2
            title={repo.full_name}
            className="font-mono text-sm font-semibold text-neutral-100 truncate"
          >
            {repo.full_name}
          </h2>
        </div>
      </div>

      <div className="mt-5 flex items-center justify-between gap-3 border-t border-neutral-850 pt-4">
        <a
          href={repo.html_url}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-1 text-[11px] font-mono text-neutral-400 hover:text-neutral-200 transition-colors"
        >
          <span>GitHub</span>
          <svg className="h-3 w-3" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
            <polyline points="15 3 21 3 21 9" />
            <line x1="10" y1="14" x2="21" y2="3" />
          </svg>
        </a>

        {isProcessing ? (
          <div className="flex items-center gap-2">
            <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-emerald-400 border-t-transparent" />
            <span className="font-mono text-xs text-emerald-400">
              {statusText || "Preparing..."}
            </span>
          </div>
        ) : hasActionError ? (
          <button
            onClick={() => onAnalyze(repo)}
            disabled={disableActions}
            data-testid={`btn-retry-${repo.id}`}
            className="inline-flex items-center gap-1.5 rounded-md bg-red-950/40 border border-red-800/60 px-3 py-1.5 text-xs font-mono font-medium text-red-300 transition-all hover:bg-red-900/60 hover:text-white disabled:opacity-40 disabled:pointer-events-none"
          >
            <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
            </svg>
            <span>Retry Analysis</span>
          </button>
        ) : (
          <button
            onClick={() => onAnalyze(repo)}
            disabled={disableActions}
            data-testid={`btn-analyze-${repo.id}`}
            className="inline-flex items-center gap-1.5 rounded-md bg-emerald-500/10 border border-emerald-500/30 px-3 py-1.5 text-xs font-mono font-medium text-emerald-400 transition-all hover:bg-emerald-500 hover:text-neutral-950 disabled:opacity-40 disabled:pointer-events-none"
          >
            <svg
              className="h-3.5 w-3.5"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="3" y="3" width="7" height="18" rx="1" />
              <rect x="14" y="8" width="7" height="13" rx="1" />
            </svg>
            <span>Visualize City</span>
          </button>
        )}
      </div>
    </div>
  );
}
