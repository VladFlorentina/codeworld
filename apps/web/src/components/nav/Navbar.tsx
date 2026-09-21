"use client";

import React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAuth } from "@/context/AuthContext";
import { getGitHubLoginUrl } from "@/lib/api";

export default function Navbar() {
  const { user, status, logout } = useAuth();
  const pathname = usePathname();

  const isExplore = pathname === "/";
  const isMyRepositories = pathname?.startsWith("/my-repositories");

  return (
    <header className="sticky top-0 z-50 flex h-14 w-full shrink-0 items-center justify-between border-b border-neutral-800/80 bg-[#0a0f1d]/90 px-4 backdrop-blur-md sm:px-6">
      {/* Brand & Nav */}
      <div className="flex items-center gap-6">
        <Link href="/" className="group flex items-center gap-2.5">
          <span className="flex h-7 w-7 items-center justify-center rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 group-hover:border-emerald-400/60 transition-colors">
            <svg
              className="h-4 w-4"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <rect x="3" y="3" width="7" height="18" rx="1" />
              <rect x="14" y="8" width="7" height="13" rx="1" />
            </svg>
          </span>
          <span className="font-mono text-sm font-bold tracking-tight text-neutral-100 group-hover:text-emerald-400 transition-colors">
            CodeWorld
          </span>
        </Link>

        {/* Primary Nav Links */}
        <nav className="flex items-center gap-1">
          <Link
            href="/"
            className={`rounded-md px-2.5 py-1 text-xs font-mono transition-colors ${
              isExplore
                ? "bg-neutral-800/80 text-emerald-400"
                : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/40"
            }`}
          >
            Explore
          </Link>
          <Link
            href="/my-repositories"
            className={`rounded-md px-2.5 py-1 text-xs font-mono transition-colors ${
              isMyRepositories
                ? "bg-neutral-800/80 text-emerald-400"
                : "text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800/40"
            }`}
          >
            My Repositories
          </Link>
        </nav>
      </div>

      {/* Auth Actions */}
      <div className="flex items-center gap-3">
        {status === "loading" && (
          <div className="h-7 w-28 animate-pulse rounded-full bg-neutral-800/50" />
        )}

        {status === "authenticated" && user && (
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-2 rounded-full border border-neutral-800 bg-neutral-900/70 px-2.5 py-1">
              {user.avatar_url ? (
                <img
                  src={user.avatar_url}
                  alt={user.github_login}
                  className="h-5 w-5 rounded-full border border-neutral-700 object-cover"
                />
              ) : (
                <div className="flex h-5 w-5 items-center justify-center rounded-full bg-neutral-800 text-[10px] font-mono text-neutral-300">
                  {user.github_login.slice(0, 2).toUpperCase()}
                </div>
              )}
              <span className="text-xs font-mono font-medium text-neutral-200">
                {user.github_login}
              </span>
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_6px_rgba(52,211,153,0.8)]" />
            </div>

            <button
              onClick={() => logout()}
              type="button"
              className="rounded border border-neutral-800 bg-neutral-900/40 px-2.5 py-1 text-xs font-mono text-neutral-400 transition-colors hover:border-red-900/60 hover:bg-red-950/30 hover:text-red-300"
            >
              Logout
            </button>
          </div>
        )}

        {(status === "unauthenticated" || status === "error") && (
          <a
            href={getGitHubLoginUrl()}
            className="inline-flex items-center gap-2 rounded-md border border-neutral-700/80 bg-neutral-900/80 px-3 py-1.5 text-xs font-mono font-medium text-neutral-200 shadow-sm transition-all hover:border-emerald-500/50 hover:bg-emerald-950/30 hover:text-emerald-300"
          >
            <svg
              className="h-3.5 w-3.5 fill-current"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path
                fillRule="evenodd"
                clipRule="evenodd"
                d="M12 2C6.477 2 2 6.484 2 12.017c0 4.425 2.865 8.18 6.839 9.504.5.092.682-.217.682-.483 0-.237-.008-.868-.013-1.703-2.782.605-3.369-1.343-3.369-1.343-.454-1.158-1.11-1.466-1.11-1.466-.908-.62.069-.608.069-.608 1.003.07 1.53 1.032 1.53 1.032.892 1.53 2.341 1.088 2.91.832.092-.647.35-1.088.636-1.338-2.22-.253-4.555-1.113-4.555-4.951 0-1.093.39-1.988 1.029-2.688-.103-.253-.446-1.272.098-2.65 0 0 .84-.27 2.75 1.026A9.564 9.564 0 0112 6.844c.85.004 1.705.115 2.504.337 1.909-1.296 2.747-1.027 2.747-1.027.546 1.379.202 2.398.1 2.651.64.7 1.028 1.595 1.028 2.688 0 3.848-2.339 4.695-4.566 4.943.359.309.678.92.678 1.855 0 1.338-.012 2.419-.012 2.747 0 .268.18.58.688.482A10.019 10.019 0 0022 12.017C22 6.484 17.522 2 12 2z"
              />
            </svg>
            <span>Connect GitHub</span>
          </a>
        )}
      </div>
    </header>
  );
}
