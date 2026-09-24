import { CityDTO, JobStatusResponse, SubmitRepositoryResponse } from "@/types/city";
import {
  AnalyzeGitHubRepositoryRequest,
  GitHubInstallationsResponse,
  GitHubRepositoriesResponse,
  UserDTO,
} from "@/types/auth";
import { WorldMapResponse } from "@/types/world";

export class ApiError extends Error {
  status: number;
  statusText: string;

  constructor(message: string, status: number, statusText: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.statusText = statusText;
  }
}

export const getBaseUrl = () =>
  (process.env.NEXT_PUBLIC_API_BASE_URL || "http://localhost:8000/api/v1").replace(
    /\/$/,
    ""
  );

/**
 * Returns the direct URL for initiating the GitHub OAuth login flow.
 */
export function getGitHubLoginUrl(): string {
  return `${getBaseUrl()}/auth/github/login`;
}

/**
 * Fetch the currently authenticated user profile from /auth/me.
 * Returns null if the user is unauthenticated (HTTP 401).
 * Always includes credentials for session cookie delivery.
 */
export async function getCurrentUser(): Promise<UserDTO | null> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/auth/me`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    credentials: "include",
    cache: "no-store",
  });

  if (response.status === 401) {
    return null;
  }

  if (!response.ok) {
    let errorDetail = "";
    try {
      const errorJson = await response.json();
      errorDetail = errorJson.detail || JSON.stringify(errorJson);
    } catch {
      errorDetail = await response.text();
    }
    throw new ApiError(
      errorDetail || `Failed to fetch current user: [HTTP ${response.status}]`,
      response.status,
      response.statusText
    );
  }

  return response.json();
}

/**
 * Log out the current user by revoking the session cookie on backend.
 */
export async function logout(): Promise<void> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/auth/logout`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
    },
    credentials: "include",
    cache: "no-store",
  });

  if (!response.ok && response.status !== 401) {
    let errorDetail = "";
    try {
      const errorJson = await response.json();
      errorDetail = errorJson.detail || JSON.stringify(errorJson);
    } catch {
      errorDetail = await response.text();
    }
    throw new ApiError(
      errorDetail || `Failed to logout: [HTTP ${response.status}]`,
      response.status,
      response.statusText
    );
  }
}

/**
 * Fetch GitHub App installations accessible to the authenticated user.
 */
export async function getInstallations(): Promise<GitHubInstallationsResponse> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/github/installations`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    credentials: "include",
    cache: "no-store",
  });

  if (!response.ok) {
    let errorDetail = "";
    try {
      const errorJson = await response.json();
      errorDetail = errorJson.detail || JSON.stringify(errorJson);
    } catch {
      errorDetail = await response.text();
    }
    throw new ApiError(
      errorDetail || `Failed to fetch installations: [HTTP ${response.status}]`,
      response.status,
      response.statusText
    );
  }

  return response.json();
}

/**
 * Fetch all GitHub repositories accessible to the user across installations.
 */
export async function getRepositories(): Promise<GitHubRepositoriesResponse> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/github/repositories`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    credentials: "include",
    cache: "no-store",
  });

  if (!response.ok) {
    let errorDetail = "";
    try {
      const errorJson = await response.json();
      errorDetail = errorJson.detail || JSON.stringify(errorJson);
    } catch {
      errorDetail = await response.text();
    }
    throw new ApiError(
      errorDetail || `Failed to fetch repositories: [HTTP ${response.status}]`,
      response.status,
      response.statusText
    );
  }

  return response.json();
}

/**
 * Submit an authenticated GitHub App repository for analysis.
 */
export async function analyzeGitHubRepository(
  payload: AnalyzeGitHubRepositoryRequest
): Promise<SubmitRepositoryResponse> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/github/repositories/analyze`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    credentials: "include",
    body: JSON.stringify(payload),
    cache: "no-store",
  });

  if (!response.ok) {
    let errorDetail = "";
    try {
      const errorJson = await response.json();
      errorDetail = errorJson.detail || JSON.stringify(errorJson);
    } catch {
      errorDetail = await response.text();
    }
    throw new ApiError(
      errorDetail || `Request failed with status ${response.status}`,
      response.status,
      response.statusText
    );
  }

  return response.json();
}

/**
 * Fetch the completed CityDTO for a repository from CodeWorld REST API.
 * Uses NEXT_PUBLIC_API_BASE_URL with fallback to http://localhost:8000/api/v1.
 * Sends credentials for private city access authorization.
 */
export async function getCity(repositoryId: string): Promise<CityDTO> {
  const baseUrl = getBaseUrl();
  const url = `${baseUrl}/cities/${encodeURIComponent(repositoryId)}`;

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    credentials: "include",
    cache: "no-store",
  });

  if (!response.ok) {
    let errorDetail = "";
    try {
      const errorJson = await response.json();
      errorDetail = errorJson.detail || JSON.stringify(errorJson);
    } catch {
      errorDetail = await response.text();
    }
    throw new ApiError(
      `Failed to fetch city for repository '${repositoryId}': [HTTP ${response.status} ${response.statusText}] ${errorDetail}`,
      response.status,
      response.statusText
    );
  }

  const data: CityDTO = await response.json();
  return data;
}

/**
 * Submit a public GitHub repository URL to the ensure-world endpoint.
 * Returns ready (200), analyzing (202), or newly_queued (202).
 */
export async function submitRepository(
  url: string
): Promise<SubmitRepositoryResponse> {
  const baseUrl = getBaseUrl();
  const endpoint = `${baseUrl}/repositories`;

  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    credentials: "include",
    body: JSON.stringify({ url }),
    cache: "no-store",
  });

  if (!response.ok) {
    let errorDetail = "";
    try {
      const errorJson = await response.json();
      errorDetail = errorJson.detail || JSON.stringify(errorJson);
    } catch {
      errorDetail = await response.text();
    }
    throw new ApiError(
      errorDetail || `Request failed with status ${response.status}`,
      response.status,
      response.statusText
    );
  }

  const data: SubmitRepositoryResponse = await response.json();
  return data;
}

/**
 * Poll the analysis job status by jobId.
 * Returns status: "queued" | "running" | "complete" | "failed".
 */
export async function getJobStatus(jobId: string): Promise<JobStatusResponse> {
  const baseUrl = getBaseUrl();
  const endpoint = `${baseUrl}/jobs/${encodeURIComponent(jobId)}`;

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    credentials: "include",
    cache: "no-store",
  });

  if (!response.ok) {
    let errorDetail = "";
    try {
      const errorJson = await response.json();
      errorDetail = errorJson.detail || JSON.stringify(errorJson);
    } catch {
      errorDetail = await response.text();
    }
    throw new ApiError(
      errorDetail || `Failed to fetch job status: [HTTP ${response.status}]`,
      response.status,
      response.statusText
    );
  }

  const data: JobStatusResponse = await response.json();
  return data;
}

/**
 * Fetch all analyzed public repositories formatted for the World Map.
 * Endpoint: GET /api/v1/explore/world
 */
export async function getWorldMap(
  signal?: AbortSignal
): Promise<WorldMapResponse> {
  const baseUrl = getBaseUrl();
  const endpoint = `${baseUrl}/explore/world`;

  const response = await fetch(endpoint, {
    method: "GET",
    headers: {
      Accept: "application/json",
    },
    cache: "no-store",
    signal,
  });

  if (!response.ok) {
    const rawText = await response.text();
    let errorDetail = "";
    try {
      const errorJson = JSON.parse(rawText);
      errorDetail = errorJson.detail || JSON.stringify(errorJson);
    } catch {
      errorDetail = rawText;
    }
    throw new ApiError(
      errorDetail || `Failed to fetch world map: [HTTP ${response.status}]`,
      response.status,
      response.statusText
    );
  }

  const data: WorldMapResponse = await response.json();
  return data;
}
