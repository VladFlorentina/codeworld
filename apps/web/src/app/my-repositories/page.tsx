"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { useJobPolling } from "@/hooks/useJobPolling";
import {
  getRepositories,
  getInstallations,
  analyzeGitHubRepository,
  getGitHubLoginUrl,
  ApiError,
} from "@/lib/api";
import {
  UnauthenticatedState,
  NoInstallationsState,
  NoRepositoriesState,
} from "@/components/repositories/RepositoryStates";
import { RepositoryCard } from "@/components/repositories/RepositoryCard";
import { GitHubRepositoryDTO, GitHubInstallationDTO } from "@/types/auth";
import { JobStatus } from "@/types/city";

export default function MyRepositoriesPage() {
  const router = useRouter();
  const { user, status, error: authError } = useAuth();

  const [repositories, setRepositories] = useState<GitHubRepositoryDTO[]>([]);
  const [installations, setInstallations] = useState<GitHubInstallationDTO[]>([]);
  const [loadingData, setLoadingData] = useState<boolean>(false);
  const [fetchError, setFetchError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>("");

  // Analysis / Polling state
  const [analyzingRepoId, setAnalyzingRepoId] = useState<number | null>(null);
  const [actionError, setActionError] = useState<{
    repoId: number;
    message: string;
  } | null>(null);

  const isAnalyzingRef = useRef<boolean>(false);

  const {
    activeJob,
    startPolling,
    stopPolling,
    clearActiveJob,
  } = useJobPolling<{ repoId: number; codeWorldRepoId: string }>({
    onComplete: (_job, meta) => {
      isAnalyzingRef.current = false;
      clearActiveJob();
      router.push(`/city/${meta.codeWorldRepoId}`);
    },
    onFailed: (errorMsg, _job, meta) => {
      isAnalyzingRef.current = false;
      setAnalyzingRepoId(null);
      setActionError({
        repoId: meta.repoId,
        message: errorMsg,
      });
    },
    onError: (err, meta) => {
      isAnalyzingRef.current = false;
      setAnalyzingRepoId(null);
      setActionError({
        repoId: meta.repoId,
        message: `Polling error: ${err.message}`,
      });
    },
  });

  const loadRepositories = async () => {
    setLoadingData(true);
    setFetchError(null);
    try {
      const [reposRes, instRes] = await Promise.all([
        getRepositories(),
        getInstallations().catch(() => ({ installations: [], total_count: 0 })),
      ]);
      setRepositories(reposRes.repositories || []);
      setInstallations(instRes.installations || []);
    } catch (err: unknown) {
      if (err instanceof ApiError && err.status === 401) {
        setFetchError("Session expired. Please log in again.");
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        setFetchError(`Could not load GitHub repositories: ${msg}`);
      }
    } finally {
      setLoadingData(false);
    }
  };

  useEffect(() => {
    if (status === "authenticated") {
      loadRepositories();
    } else {
      setRepositories([]);
      setInstallations([]);
      stopPolling();
      clearActiveJob();
      setAnalyzingRepoId(null);
    }
  }, [status]);

  const handleAnalyze = async (repo: GitHubRepositoryDTO) => {
    // Prevent duplicate polling or concurrent analysis requests synchronously
    if (isAnalyzingRef.current || activeJob || analyzingRepoId) return;
    isAnalyzingRef.current = true;

    setActionError(null);
    stopPolling();
    isAnalyzingRef.current = true; // Maintain lock after stopPolling
    setAnalyzingRepoId(repo.id);

    try {
      const res = await analyzeGitHubRepository({
        installation_id: repo.installation_id,
        repository_id: repo.id,
      });

      if (res.status === "ready") {
        isAnalyzingRef.current = false;
        stopPolling();
        clearActiveJob();
        setAnalyzingRepoId(null);
        router.push(`/city/${res.repository_id}`);
        return;
      }

      if ((res.status === "analyzing" || res.status === "newly_queued") && res.job_id) {
        isAnalyzingRef.current = false;
        const initialStatus: JobStatus = res.status === "analyzing" ? "running" : "queued";
        setAnalyzingRepoId(null);
        startPolling(res.job_id, initialStatus, {
          repoId: repo.id,
          codeWorldRepoId: res.repository_id,
        });
      } else {
        throw new Error(res.message || "Unexpected response from server");
      }
    } catch (err: unknown) {
      isAnalyzingRef.current = false;
      stopPolling();
      clearActiveJob();
      setAnalyzingRepoId(null);
      const msg = err instanceof Error ? err.message : String(err);
      setActionError({
        repoId: repo.id,
        message: msg,
      });
    }
  };

  const filteredRepositories = useMemo(() => {
    if (!searchQuery.trim()) return repositories;
    const q = searchQuery.toLowerCase().trim();
    return repositories.filter(
      (r) =>
        r.full_name.toLowerCase().includes(q) ||
        r.owner.toLowerCase().includes(q) ||
        r.name.toLowerCase().includes(q)
    );
  }, [repositories, searchQuery]);

  if (status === "unauthenticated") {
    return <UnauthenticatedState />;
  }

  if (status === "loading") {
    return (
      <main className="min-h-[calc(100vh-3.5rem)] bg-[#0a0f1d] px-6 py-10 text-white">
        <div className="mx-auto max-w-5xl space-y-6">
          <div className="h-8 w-48 animate-pulse rounded bg-neutral-800" />
          <div className="h-4 w-72 animate-pulse rounded bg-neutral-850" />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {[1, 2, 3].map((i) => (
              <div key={i} className="h-40 animate-pulse rounded-xl border border-neutral-850 bg-neutral-900/40" />
            ))}
          </div>
        </div>
      </main>
    );
  }

  if (fetchError || authError) {
    return (
      <main className="relative flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center bg-[#0a0f1d] px-6 py-12 text-white">
        <div className="relative z-10 w-full max-w-md rounded-2xl border border-red-900/50 bg-neutral-900/80 p-6 text-center shadow-xl">
          <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-red-950/80 text-red-400 border border-red-800/60">
            <svg className="h-5 w-5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
          </div>
          <h2 className="text-lg font-bold text-neutral-100">Connection or Session Error</h2>
          <p className="mt-2 text-xs text-neutral-400">
            {fetchError || authError}
          </p>

          <div className="mt-6 flex flex-col gap-2">
            <a
              href={getGitHubLoginUrl()}
              className="inline-flex items-center justify-center rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-neutral-950 hover:bg-emerald-400 transition-colors"
            >
              Reconnect with GitHub
            </a>
            <button
              onClick={() => loadRepositories()}
              className="rounded-lg border border-neutral-700 bg-neutral-800/60 px-4 py-2 text-xs font-mono text-neutral-300 hover:bg-neutral-800 transition-colors"
            >
              Retry
            </button>
          </div>
        </div>
      </main>
    );
  }

  if (!loadingData && installations.length === 0) {
    return (
      <NoInstallationsState
        login={user?.github_login}
        onRefresh={loadRepositories}
      />
    );
  }

  if (!loadingData && installations.length > 0 && repositories.length === 0) {
    return (
      <NoRepositoriesState
        login={user?.github_login}
        onRefresh={loadRepositories}
      />
    );
  }

  return (
    <main className="min-h-[calc(100vh-3.5rem)] bg-[#0a0f1d] px-4 py-8 text-white sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-neutral-800/80 pb-6">
          <div>
            <div className="flex items-center gap-2">
              <h1 className="text-2xl font-bold tracking-tight text-neutral-100 sm:text-3xl">
                My Repositories
              </h1>
              <span className="rounded-full border border-neutral-800 bg-neutral-900 px-2.5 py-0.5 text-xs font-mono text-neutral-400">
                {repositories.length}
              </span>
            </div>
            <p className="mt-1 text-xs sm:text-sm text-neutral-400">
              Repositories accessible via CodeWorld GitHub App installation for{" "}
              <span className="text-neutral-200 font-mono font-medium">
                {user?.github_login}
              </span>
              .
            </p>
          </div>

          <div className="flex items-center gap-2.5">
            <a
              href="https://github.com/apps/codeworld-dev-vlad/installations/new"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1.5 rounded-md border border-neutral-700/80 bg-neutral-900/80 px-3 py-1.5 text-xs font-mono text-neutral-300 transition-colors hover:border-neutral-600 hover:bg-neutral-800"
            >
              <svg className="h-3.5 w-3.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <line x1="12" y1="5" x2="12" y2="19" />
                <line x1="5" y1="12" x2="19" y2="12" />
              </svg>
              <span>Add / Manage Repositories</span>
            </a>

            <button
              onClick={() => loadRepositories()}
              disabled={loadingData}
              title="Refresh repository list"
              className="rounded-md border border-neutral-800 bg-neutral-900/60 p-2 text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
            >
              <svg
                className={`h-3.5 w-3.5 ${loadingData ? "animate-spin text-emerald-400" : ""}`}
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67" />
              </svg>
            </button>
          </div>
        </div>

        <div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div className="relative w-full max-w-sm">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3 text-neutral-500">
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="11" cy="11" r="8" />
                <line x1="21" y1="21" x2="16.65" y2="16.65" />
              </svg>
            </div>
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search repositories by name or owner..."
              className="w-full rounded-lg border border-neutral-800 bg-neutral-900/70 py-1.5 pl-9 pr-4 text-xs font-mono text-neutral-200 placeholder-neutral-500 focus:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500/60"
            />
          </div>

          <div className="text-xs font-mono text-neutral-500">
            Showing {filteredRepositories.length} of {repositories.length} repositories
          </div>
        </div>

        {actionError && (
          <div className="mt-4 flex items-center justify-between rounded-lg border border-red-900/60 bg-red-950/40 px-4 py-2.5 text-xs text-red-300">
            <span>{actionError.message}</span>
            <button
              onClick={() => setActionError(null)}
              className="font-mono text-xs text-red-400 hover:text-red-200"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredRepositories.map((repo) => {
            const isProcessingThis =
              Boolean(analyzingRepoId === repo.id || (activeJob && activeJob.repoId === repo.id));
            const isQueued = activeJob && activeJob.repoId === repo.id && activeJob.status === "queued";
            const isRunning = activeJob && activeJob.repoId === repo.id && activeJob.status === "running";
            const statusText = isQueued
              ? "Queued..."
              : isRunning
              ? "Analyzing..."
              : "Preparing...";

            return (
              <RepositoryCard
                key={repo.id}
                repo={repo}
                isProcessing={isProcessingThis}
                statusText={statusText}
                hasActionError={actionError?.repoId === repo.id}
                disableActions={Boolean(activeJob || analyzingRepoId)}
                onAnalyze={handleAnalyze}
              />
            );
          })}
        </div>

        {filteredRepositories.length === 0 && repositories.length > 0 && (
          <div className="mt-12 text-center text-xs font-mono text-neutral-500">
            No repositories matching &quot;{searchQuery}&quot;.
          </div>
        )}
      </div>
    </main>
  );
}
