"use client";

import React, { useState, useEffect, useRef, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import {
  getRepositories,
  getInstallations,
  analyzeGitHubRepository,
  getJobStatus,
  getGitHubLoginUrl,
  ApiError,
} from "@/lib/api";
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
  const [activeJob, setActiveJob] = useState<{
    repoId: number;
    jobId: string;
    status: JobStatus;
    codeWorldRepoId: string;
  } | null>(null);
  const [actionError, setActionError] = useState<{
    repoId: number;
    message: string;
  } | null>(null);

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);
  const isAnalyzingRef = useRef<boolean>(false);

  const clearPolling = () => {
    isAnalyzingRef.current = false;
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
      pollIntervalRef.current = null;
    }
  };

  useEffect(() => {
    return () => {
      clearPolling();
    };
  }, []);

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
      clearPolling();
      setActiveJob(null);
      setAnalyzingRepoId(null);
    }
  }, [status]);

  const handleAnalyze = async (repo: GitHubRepositoryDTO) => {
    // Prevent duplicate polling or concurrent analysis requests synchronously
    if (isAnalyzingRef.current || activeJob || analyzingRepoId) return;
    isAnalyzingRef.current = true;

    setActionError(null);
    clearPolling();
    isAnalyzingRef.current = true; // Maintain lock after clearPolling
    setAnalyzingRepoId(repo.id);

    try {
      const res = await analyzeGitHubRepository({
        installation_id: repo.installation_id,
        repository_id: repo.id,
      });

      if (res.status === "ready") {
        // City is ready immediately: navigate directly to CodeWorld repository UUID
        clearPolling();
        setActiveJob(null);
        setAnalyzingRepoId(null);
        router.push(`/city/${res.repository_id}`);
        return;
      }

      if ((res.status === "analyzing" || res.status === "newly_queued") && res.job_id) {
        const initialStatus: JobStatus = res.status === "analyzing" ? "running" : "queued";
        setActiveJob({
          repoId: repo.id,
          jobId: res.job_id,
          status: initialStatus,
          codeWorldRepoId: res.repository_id,
        });
        setAnalyzingRepoId(null);

        // Polling interval every 2000ms
        pollIntervalRef.current = setInterval(async () => {
          // Guard: if timer was cleared while request was inflight, do nothing
          if (!pollIntervalRef.current) return;

          try {
            const jobData = await getJobStatus(res.job_id!);
            if (!pollIntervalRef.current) return;

            if (jobData.status === "complete") {
              clearPolling();
              setActiveJob(null);
              router.push(`/city/${res.repository_id}`);
            } else if (jobData.status === "failed") {
              clearPolling();
              setActiveJob(null);
              setAnalyzingRepoId(null);
              setActionError({
                repoId: repo.id,
                message: jobData.error || "Analysis job failed. Please try again.",
              });
            } else {
              setActiveJob((prev) =>
                prev && prev.jobId === res.job_id
                  ? { ...prev, status: jobData.status }
                  : prev
              );
            }
          } catch (pollErr: unknown) {
            if (!pollIntervalRef.current) return;
            clearPolling();
            setActiveJob(null);
            setAnalyzingRepoId(null);
            const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
            setActionError({
              repoId: repo.id,
              message: `Polling error: ${msg}`,
            });
          }
        }, 2000);
      } else {
        throw new Error(res.message || "Unexpected response from server");
      }
    } catch (err: unknown) {
      clearPolling();
      setActiveJob(null);
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

  // ─────────────────────────────────────────────────────────────
  // STATE 1: UNAUTHENTICATED
  // ─────────────────────────────────────────────────────────────
  if (status === "unauthenticated") {
    return (
      <main className="relative flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center bg-[#0a0f1d] px-6 py-12 text-white">
        <div className="pointer-events-none absolute top-1/4 h-96 w-96 rounded-full bg-emerald-500/10 blur-3xl" />
        <div className="relative z-10 w-full max-w-lg text-center">
          <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-neutral-700/80 bg-neutral-900/60 px-3.5 py-1 text-xs font-mono text-neutral-300 backdrop-blur-sm">
            <span className="h-2 w-2 rounded-full bg-amber-400" />
            <span>Authentication Required</span>
          </div>

          <h1 className="text-3xl font-extrabold tracking-tight sm:text-4xl text-neutral-100">
            Connect Your GitHub Account
          </h1>
          <p className="mt-3 text-sm text-neutral-400">
            Sign in with GitHub to access and visualize your private and organization repositories in 3D.
          </p>

          <div className="mt-8">
            <a
              href={getGitHubLoginUrl()}
              className="inline-flex items-center gap-2.5 rounded-lg bg-emerald-500 px-5 py-2.5 text-sm font-semibold text-neutral-950 shadow-lg shadow-emerald-500/20 transition-all hover:bg-emerald-400 hover:shadow-emerald-500/30"
            >
              <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24" aria-hidden="true">
                <path
                  fillRule="evenodd"
                  clipRule="evenodd"
                  d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                />
              </svg>
              <span>Connect with GitHub</span>
            </a>
          </div>

          <div className="mt-6">
            <Link href="/" className="text-xs font-mono text-neutral-500 hover:text-neutral-400 underline">
              &larr; Return to Public Explore
            </Link>
          </div>
        </div>
      </main>
    );
  }

  // ─────────────────────────────────────────────────────────────
  // LOADING SKELETON
  // ─────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────
  // STATE 4: SESSION EXPIRED OR FETCH ERROR
  // ─────────────────────────────────────────────────────────────
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

  // ─────────────────────────────────────────────────────────────
  // STATE 2A: AUTHENTICATED, ZERO INSTALLATIONS
  // ─────────────────────────────────────────────────────────────
  if (!loadingData && installations.length === 0) {
    return (
      <main className="min-h-[calc(100vh-3.5rem)] bg-[#0a0f1d] px-6 py-12 text-white">
        <div className="mx-auto max-w-2xl text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900 text-neutral-400">
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M12 2v20M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6" />
            </svg>
          </div>

          <h1 className="text-2xl font-bold tracking-tight text-neutral-100 sm:text-3xl">
            Install CodeWorld on GitHub
          </h1>
          <p className="mt-3 text-sm text-neutral-400">
            CodeWorld is connected to your GitHub account (<span className="text-neutral-200 font-mono font-medium">{user?.github_login}</span>), but the CodeWorld GitHub App is not installed on your account or organization yet.
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href="https://github.com/apps/codeworld-dev-vlad/installations/new"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-neutral-950 shadow-md shadow-emerald-500/20 hover:bg-emerald-400 transition-colors"
            >
              <svg className="h-4 w-4 fill-current" viewBox="0 0 24 24">
                <path
                  fillRule="evenodd"
                  clipRule="evenodd"
                  d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
                />
              </svg>
              <span>Install CodeWorld on GitHub</span>
            </a>

            <button
              onClick={() => loadRepositories()}
              className="rounded-lg border border-neutral-700 bg-neutral-900/60 px-4 py-2 text-xs font-mono text-neutral-300 hover:bg-neutral-800 transition-colors"
            >
              Refresh Installations
            </button>
          </div>
        </div>
      </main>
    );
  }

  // ─────────────────────────────────────────────────────────────
  // STATE 2B: AUTHENTICATED, INSTALLATION EXISTS BUT ZERO REPOSITORIES
  // ─────────────────────────────────────────────────────────────
  if (!loadingData && installations.length > 0 && repositories.length === 0) {
    return (
      <main className="min-h-[calc(100vh-3.5rem)] bg-[#0a0f1d] px-6 py-12 text-white">
        <div className="mx-auto max-w-2xl text-center">
          <div className="mx-auto mb-4 flex h-12 w-12 items-center justify-center rounded-xl border border-neutral-800 bg-neutral-900 text-neutral-400">
            <svg className="h-6 w-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75">
              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
            </svg>
          </div>

          <h1 className="text-2xl font-bold tracking-tight text-neutral-100 sm:text-3xl">
            No Repositories Selected
          </h1>
          <p className="mt-3 text-sm text-neutral-400">
            CodeWorld is installed on your GitHub account (<span className="text-neutral-200 font-mono font-medium">{user?.github_login}</span>), but no repositories have been granted access. Configure your repository selection in GitHub settings to visualize them.
          </p>

          <div className="mt-8 flex flex-col items-center justify-center gap-3 sm:flex-row">
            <a
              href="https://github.com/settings/installations"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-2 rounded-lg bg-emerald-500 px-4 py-2 text-xs font-semibold text-neutral-950 shadow-md shadow-emerald-500/20 hover:bg-emerald-400 transition-colors"
            >
              <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <circle cx="12" cy="12" r="3" />
                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
              </svg>
              <span>Configure Repository Access</span>
            </a>

            <button
              onClick={() => loadRepositories()}
              className="rounded-lg border border-neutral-700 bg-neutral-900/60 px-4 py-2 text-xs font-mono text-neutral-300 hover:bg-neutral-800 transition-colors"
            >
              Refresh Repositories
            </button>
          </div>
        </div>
      </main>
    );
  }

  // ─────────────────────────────────────────────────────────────
  // STATE 3: AUTHENTICATED, REPOSITORIES AVAILABLE
  // ─────────────────────────────────────────────────────────────
  return (
    <main className="min-h-[calc(100vh-3.5rem)] bg-[#0a0f1d] px-4 py-8 text-white sm:px-6 lg:px-8">
      <div className="mx-auto max-w-6xl">
        {/* Header section */}
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

        {/* Filter & search bar */}
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

        {/* Global error banner if action failed */}
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

        {/* Repositories grid */}
        <div className="mt-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {filteredRepositories.map((repo) => {
            const isProcessingThis =
              analyzingRepoId === repo.id || (activeJob && activeJob.repoId === repo.id);
            const isQueued = activeJob && activeJob.repoId === repo.id && activeJob.status === "queued";
            const isRunning = activeJob && activeJob.repoId === repo.id && activeJob.status === "running";

            return (
              <div
                key={repo.id}
                data-testid={`repo-card-${repo.id}`}
                className={`relative flex flex-col justify-between rounded-xl border p-5 transition-all ${
                  isProcessingThis
                    ? "border-emerald-500/60 bg-emerald-950/20 shadow-lg shadow-emerald-500/10"
                    : "border-neutral-800/80 bg-neutral-900/50 hover:border-neutral-700/80 hover:bg-neutral-900/80"
                }`}
              >
                <div>
                  {/* Top badges */}
                  <div className="flex items-center justify-between gap-2">
                    {/* Visibility badge */}
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

                    {/* Default branch badge */}
                    <span className="rounded border border-neutral-800 bg-neutral-900/80 px-1.5 py-0.5 text-[10px] font-mono text-neutral-400">
                      {repo.default_branch || "main"}
                    </span>
                  </div>

                  {/* Repository title */}
                  <div className="mt-3">
                    <h2
                      title={repo.full_name}
                      className="font-mono text-sm font-semibold text-neutral-100 truncate"
                    >
                      {repo.full_name}
                    </h2>
                  </div>
                </div>

                {/* Bottom action controls */}
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

                  {/* Action button */}
                  {isProcessingThis ? (
                    <div className="flex items-center gap-2">
                      <div className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-emerald-400 border-t-transparent" />
                      <span className="font-mono text-xs text-emerald-400">
                        {isQueued
                          ? "Queued..."
                          : isRunning
                          ? "Analyzing..."
                          : "Preparing..."}
                      </span>
                    </div>
                  ) : actionError?.repoId === repo.id ? (
                    <button
                      onClick={() => handleAnalyze(repo)}
                      disabled={Boolean(activeJob || analyzingRepoId)}
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
                      onClick={() => handleAnalyze(repo)}
                      disabled={Boolean(activeJob || analyzingRepoId)}
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
          })}
        </div>

        {/* Empty filter message */}
        {filteredRepositories.length === 0 && repositories.length > 0 && (
          <div className="mt-12 text-center text-xs font-mono text-neutral-500">
            No repositories matching &quot;{searchQuery}&quot;.
          </div>
        )}
      </div>
    </main>
  );
}
