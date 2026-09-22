import { EcosystemKey } from "@/types/world";

export const CANONICAL_ECOSYSTEM_ORDER: readonly EcosystemKey[] = [
  "python",
  "web",
  "rust",
  "go",
  "jvm",
  "native",
  "frontier",
] as const;

const ECOSYSTEM_DISPLAY_NAMES: Record<EcosystemKey, string> = {
  python: "Pythonia",
  web: "Weboria",
  rust: "Rustica",
  go: "Goland",
  jvm: "Javaland",
  native: "Native Realm",
  frontier: "The Frontier",
};

const LANGUAGE_TO_ECOSYSTEM: Record<string, EcosystemKey> = {
  // Python
  python: "python",

  // Web
  typescript: "web",
  javascript: "web",
  html: "web",
  css: "web",
  scss: "web",
  sass: "web",
  less: "web",
  vue: "web",
  svelte: "web",
  astro: "web",

  // Systems / Rust
  rust: "rust",

  // Cloud / Go
  go: "go",

  // JVM
  java: "jvm",
  kotlin: "jvm",
  scala: "jvm",

  // Native Systems
  c: "native",
  "c++": "native",
  cpp: "native",

  // Explicit frontier mappings (e.g. C# not yet in .NET continent for WM2)
  "c#": "frontier",
  csharp: "frontier",
  shell: "frontier",
  powershell: "frontier",
  dockerfile: "frontier",
  makefile: "frontier",
  unknown: "frontier",
};

/**
 * Deterministically maps a raw primary language string to its EcosystemKey.
 * Unknown or empty values cleanly fall back to "frontier".
 */
export function getEcosystem(language: string | null | undefined): EcosystemKey {
  if (!language) {
    return "frontier";
  }

  const normalized = language.trim().toLowerCase();
  return LANGUAGE_TO_ECOSYSTEM[normalized] ?? "frontier";
}

/**
 * Returns the human-readable thematic display name for an ecosystem key.
 */
export function getEcosystemDisplayName(ecosystem: EcosystemKey): string {
  return ECOSYSTEM_DISPLAY_NAMES[ecosystem] ?? "The Frontier";
}
