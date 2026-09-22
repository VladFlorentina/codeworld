"use client";

import React from "react";
import Link from "next/link";
import { getGitHubLoginUrl } from "@/lib/api";

export function UnauthenticatedState() {
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

export interface NoInstallationsStateProps {
  login?: string;
  onRefresh: () => void;
}

export function NoInstallationsState({ login, onRefresh }: NoInstallationsStateProps) {
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
          CodeWorld is connected to your GitHub account (<span className="text-neutral-200 font-mono font-medium">{login}</span>), but the CodeWorld GitHub App is not installed on your account or organization yet.
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
            onClick={onRefresh}
            className="rounded-lg border border-neutral-700 bg-neutral-900/60 px-4 py-2 text-xs font-mono text-neutral-300 hover:bg-neutral-800 transition-colors"
          >
            Refresh Installations
          </button>
        </div>
      </div>
    </main>
  );
}

export interface NoRepositoriesStateProps {
  login?: string;
  onRefresh: () => void;
}

export function NoRepositoriesState({ login, onRefresh }: NoRepositoriesStateProps) {
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
          CodeWorld is installed on your GitHub account (<span className="text-neutral-200 font-mono font-medium">{login}</span>), but no repositories have been granted access. Configure your repository selection in GitHub settings to visualize them.
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
            onClick={onRefresh}
            className="rounded-lg border border-neutral-700 bg-neutral-900/60 px-4 py-2 text-xs font-mono text-neutral-300 hover:bg-neutral-800 transition-colors"
          >
            Refresh Repositories
          </button>
        </div>
      </div>
    </main>
  );
}
