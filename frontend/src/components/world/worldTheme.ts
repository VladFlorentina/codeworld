import { EcosystemKey } from "@/types/world";

export interface EcosystemTheme {
  plateFill: string;
  plateStroke: string;
  plateLabel: string;
  countryFill: string;
  countryStroke: string;
  cityFill: string;
  cityStroke: string;
  cityGlow: string;
}

export const ECOSYSTEM_THEMES: Record<EcosystemKey, EcosystemTheme> = {
  python: {
    plateFill: "rgba(59, 130, 246, 0.04)",
    plateStroke: "rgba(59, 130, 246, 0.25)",
    plateLabel: "#93c5fd",
    countryFill: "rgba(59, 130, 246, 0.08)",
    countryStroke: "rgba(59, 130, 246, 0.35)",
    cityFill: "#1e3a8a",
    cityStroke: "#60a5fa",
    cityGlow: "rgba(96, 165, 250, 0.6)",
  },
  web: {
    plateFill: "rgba(245, 158, 11, 0.04)",
    plateStroke: "rgba(245, 158, 11, 0.25)",
    plateLabel: "#fcd34d",
    countryFill: "rgba(245, 158, 11, 0.08)",
    countryStroke: "rgba(245, 158, 11, 0.35)",
    cityFill: "#78350f",
    cityStroke: "#fbbf24",
    cityGlow: "rgba(251, 191, 36, 0.6)",
  },
  rust: {
    plateFill: "rgba(249, 115, 22, 0.04)",
    plateStroke: "rgba(249, 115, 22, 0.25)",
    plateLabel: "#fdba74",
    countryFill: "rgba(249, 115, 22, 0.08)",
    countryStroke: "rgba(249, 115, 22, 0.35)",
    cityFill: "#7c2d12",
    cityStroke: "#fb923c",
    cityGlow: "rgba(251, 146, 60, 0.6)",
  },
  go: {
    plateFill: "rgba(6, 182, 212, 0.04)",
    plateStroke: "rgba(6, 182, 212, 0.25)",
    plateLabel: "#67e8f9",
    countryFill: "rgba(6, 182, 212, 0.08)",
    countryStroke: "rgba(6, 182, 212, 0.35)",
    cityFill: "#164e63",
    cityStroke: "#22d3ee",
    cityGlow: "rgba(34, 211, 238, 0.6)",
  },
  jvm: {
    plateFill: "rgba(239, 68, 68, 0.04)",
    plateStroke: "rgba(239, 68, 68, 0.25)",
    plateLabel: "#fca5a5",
    countryFill: "rgba(239, 68, 68, 0.08)",
    countryStroke: "rgba(239, 68, 68, 0.35)",
    cityFill: "#7f1d1d",
    cityStroke: "#f87171",
    cityGlow: "rgba(248, 113, 113, 0.6)",
  },
  native: {
    plateFill: "rgba(168, 85, 247, 0.04)",
    plateStroke: "rgba(168, 85, 247, 0.25)",
    plateLabel: "#d8b4fe",
    countryFill: "rgba(168, 85, 247, 0.08)",
    countryStroke: "rgba(168, 85, 247, 0.35)",
    cityFill: "#581c87",
    cityStroke: "#c084fc",
    cityGlow: "rgba(192, 132, 252, 0.6)",
  },
  frontier: {
    plateFill: "rgba(156, 163, 175, 0.04)",
    plateStroke: "rgba(156, 163, 175, 0.25)",
    plateLabel: "#d1d5db",
    countryFill: "rgba(156, 163, 175, 0.08)",
    countryStroke: "rgba(156, 163, 175, 0.35)",
    cityFill: "#374151",
    cityStroke: "#9ca3af",
    cityGlow: "rgba(156, 163, 175, 0.6)",
  },
};

export function getEcosystemTheme(ecosystem: EcosystemKey): EcosystemTheme {
  return ECOSYSTEM_THEMES[ecosystem] ?? ECOSYSTEM_THEMES.frontier;
}
