"use client";

import React, { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { getJobStatus, submitRepository } from "@/lib/api";
import { JobStatus } from "@/types/city";

interface ActiveJob {
  jobId: string;
  repositoryId: string;
  status: JobStatus;
}

const FEATURED_WORLDS = [
  {
    id: "2e945127-9c5d-4b5a-a0d9-9d52e2cbadfe",
    name: "encode/starlette",
    description: "Lightweight ASGI framework & toolkit (12 districts, 132 buildings, 400 connections)",
    badge: "Compact City",
    url: "https://github.com/encode/starlette",
  },
  {
    id: "9ca0ba88-7ab2-45e4-b92e-26dcf16ef8ac",
    name: "tiangolo/fastapi",
    description: "Modern high-performance web framework (381 districts, 2,867 buildings, 1,609 connections)",
    badge: "Large Scale City",
    url: "https://github.com/tiangolo/fastapi",
  },
];

export default function ExplorePage() {
  const router = useRouter();

  const [inputUrl, setInputUrl] = useState<string>("");
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [activeJob, setActiveJob] = useState<ActiveJob | null>(null);
  const [error, setError] = useState<string | null>(null);

  const pollIntervalRef = useRef<NodeJS.Timeout | null>(null);

  const clearPolling = () => {
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

  // Accepts "owner/repo" or full "https://github.com/owner/repo"
  const normalizeGithubUrl = (raw: string): string => {
    const trimmed = raw.trim();
    if (!trimmed) return "";

    if (trimmed.startsWith("https://github.com/")) {
      return trimmed.replace(/\/$/, "");
    }

    if (trimmed.startsWith("http://github.com/")) {
      return trimmed.replace("http://", "https://").replace(/\/$/, "");
    }

    // If host is something else (e.g. gitlab, bitbucket), preserve it for backend validation error
    if (trimmed.includes("://")) {
      return trimmed;
    }

    const parts = trimmed.split("/").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 2 && !parts[0].includes(".")) {
      return `https://github.com/${parts[0]}/${parts[1]}`;
    }

    return trimmed;
  };

  const handleSubmit = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    setError(null);
    clearPolling();

    const normalized = normalizeGithubUrl(inputUrl);
    if (!normalized) {
      setError("Please enter a GitHub repository URL or owner/repo (e.g. tiangolo/fastapi)");
      return;
    }

    if (!normalized.startsWith("https://github.com/")) {
      setError("Only public GitHub repositories are supported (https://github.com/owner/repo)");
      return;
    }

    setIsSubmitting(true);

    try {
      const res = await submitRepository(normalized);

      if (res.status === "ready") {
        router.push(`/city/${res.repository_id}`);
        return;
      }

      if ((res.status === "analyzing" || res.status === "newly_queued") && res.job_id) {
        const initialStatus: JobStatus = res.status === "analyzing" ? "running" : "queued";
        setActiveJob({
          jobId: res.job_id,
          repositoryId: res.repository_id,
          status: initialStatus,
        });

        pollIntervalRef.current = setInterval(async () => {
          try {
            const jobData = await getJobStatus(res.job_id!);
            if (jobData.status === "complete") {
              clearPolling();
              router.push(`/city/${res.repository_id}`);
            } else if (jobData.status === "failed") {
              clearPolling();
              setActiveJob(null);
              setIsSubmitting(false);
              setError(jobData.error || "Repository analysis failed. Please try again.");
            } else {
              setActiveJob((prev) =>
                prev ? { ...prev, status: jobData.status } : null
              );
            }
          } catch (pollErr: unknown) {
            clearPolling();
            setActiveJob(null);
            setIsSubmitting(false);
            const msg = pollErr instanceof Error ? pollErr.message : String(pollErr);
            setError(`Status polling error: ${msg}`);
          }
        }, 2000);
      } else {
        throw new Error(res.message || "Unexpected response from server");
      }
    } catch (err: unknown) {
      clearPolling();
      setActiveJob(null);
      setIsSubmitting(false);
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
    }
  };

  const handleRetry = () => {
    setError(null);
    setIsSubmitting(false);
    setActiveJob(null);
    clearPolling();
  };

  return (
    <main className="relative flex min-h-[calc(100vh-3.5rem)] flex-col items-center justify-center bg-[#0a0f1d] px-6 py-12 text-white">
      <div className="pointer-events-none absolute top-1/4 h-96 w-96 rounded-full bg-emerald-500/10 blur-3xl" />

      <div className="relative z-10 w-full max-w-2xl text-center">
        <div className="mb-4 inline-flex items-center gap-2 rounded-full border border-emerald-500/30 bg-emerald-950/40 px-3.5 py-1 text-xs font-mono text-emerald-400 backdrop-blur-sm">
          <span className="h-2 w-2 rounded-full bg-emerald-400 animate-pulse shadow-[0_0_8px_rgba(52,211,153,0.8)]" />
          <span>CodeWorld &bull; Explore</span>
        </div>

        <h1 className="text-4xl font-extrabold tracking-tight sm:text-5xl text-neutral-100">
          Software City Explorer
        </h1>
        <p className="mt-3 text-neutral-400 text-sm sm:text-base max-w-lg mx-auto">
          Transform any public GitHub repository into an interactive 3D software city.
          Visualize directory hierarchy, lines of code, and internal dependencies.
        </p>

        <form onSubmit={handleSubmit} className="mt-8 flex flex-col sm:flex-row gap-2">
          <div className="relative flex-1">
            <input
              type="text"
              data-testid="repo-input"
              value={inputUrl}
              onChange={(e) => setInputUrl(e.target.value)}
              disabled={isSubmitting || !!activeJob}
              placeholder="e.g. tiangolo/fastapi or https://github.com/..."
              className="w-full rounded-xl border border-neutral-800 bg-neutral-900/90 px-4 py-3.5 text-sm font-mono text-neutral-100 placeholder-neutral-500 shadow-inner backdrop-blur-sm transition-all focus:border-emerald-500/60 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-50"
            />
          </div>

          <button
            type="submit"
            data-testid="generate-btn"
            disabled={isSubmitting || !!activeJob}
            className="flex items-center justify-center gap-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 disabled:bg-neutral-800 disabled:text-neutral-500 px-6 py-3.5 text-sm font-semibold text-white shadow-lg shadow-emerald-950/50 transition-all cursor-pointer disabled:cursor-not-allowed"
          >
            {isSubmitting || activeJob ? (
              <>
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-white/80 border-t-transparent" />
                <span>Processing...</span>
              </>
            ) : (
              <span>Generate / Open World</span>
            )}
          </button>
        </form>

        {activeJob && (
          <div
            data-testid="job-status-card"
            className="mt-6 rounded-2xl border border-neutral-800 bg-neutral-900/90 p-5 text-left backdrop-blur-md shadow-xl"
          >
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="h-4 w-4 animate-spin rounded-full border-2 border-emerald-500 border-t-transparent" />
                <div>
                  <h3 className="text-sm font-semibold text-neutral-200">
                    Analyzing Repository
                  </h3>
                  <p className="text-xs font-mono text-neutral-400 mt-0.5">
                    Job ID: {activeJob.jobId}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-2">
                <span className="text-xs text-neutral-500">Status:</span>
                <span
                  data-testid="real-job-status"
                  className={`rounded-full px-3 py-0.5 text-xs font-mono font-medium capitalize ${
                    activeJob.status === "running"
                      ? "border border-emerald-500/30 bg-emerald-950/60 text-emerald-300"
                      : "border border-amber-500/30 bg-amber-950/60 text-amber-300"
                  }`}
                >
                  {activeJob.status}
                </span>
              </div>
            </div>

            <p className="mt-3 text-xs text-neutral-400 font-mono border-t border-neutral-800/80 pt-3">
              {activeJob.status === "running"
                ? "Repository cloned. Running AST analysis and computing city layout..."
                : "Waiting for an available worker in queue..."}
            </p>
          </div>
        )}

        {error && (
          <div
            data-testid="explore-error"
            className="mt-6 flex flex-col items-center justify-between gap-3 rounded-2xl border border-red-500/30 bg-red-950/30 p-4 text-left sm:flex-row backdrop-blur-sm"
          >
            <div className="flex items-center gap-3">
              <span className="text-red-400 text-sm font-semibold">&bull;</span>
              <p className="text-xs font-mono text-red-200">{error}</p>
            </div>
            <button
              onClick={handleRetry}
              data-testid="retry-btn"
              className="rounded-lg bg-red-800/60 hover:bg-red-700/60 px-3 py-1.5 text-xs font-medium text-red-100 transition-colors cursor-pointer shrink-0"
            >
              Retry
            </button>
          </div>
        )}

        <div className="mt-12 text-left">
          <div className="flex items-center justify-between mb-3">
            <h2 className="text-xs font-mono uppercase tracking-wider text-neutral-500">
              Featured Worlds (Ready to Explore)
            </h2>
            <span className="text-xs font-mono text-neutral-600">MVP Pre-analyzed</span>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {FEATURED_WORLDS.map((repo) => (
              <Link
                key={repo.id}
                href={`/city/${repo.id}`}
                data-testid={`featured-${repo.name.replace("/", "-")}`}
                className="group flex flex-col justify-between rounded-xl border border-neutral-800 bg-neutral-900/50 p-4 transition-all hover:border-emerald-500/50 hover:bg-neutral-900 shadow-sm"
              >
                <div>
                  <div className="flex items-center justify-between">
                    <span className="font-semibold text-neutral-200 group-hover:text-emerald-400 transition-colors">
                      {repo.name}
                    </span>
                    <span className="rounded bg-neutral-800 px-2 py-0.5 text-[10px] font-mono text-neutral-400">
                      {repo.badge}
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-neutral-400 leading-relaxed">
                    {repo.description}
                  </p>
                </div>

                <div className="mt-4 flex items-center justify-between border-t border-neutral-800/60 pt-2.5 text-xs font-mono text-neutral-500 group-hover:text-emerald-400 transition-colors">
                  <span>Open 3D City</span>
                  <span>&rarr;</span>
                </div>
              </Link>
            ))}
          </div>
        </div>
      </div>
    </main>
  );
}
