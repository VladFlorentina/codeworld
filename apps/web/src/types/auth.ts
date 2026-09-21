export interface UserDTO {
  id: string;
  github_user_id: number;
  github_login: string;
  avatar_url: string | null;
}

export interface GitHubInstallationDTO {
  id: number;
  account_login: string;
  account_type: string;
  repository_selection: "all" | "selected";
}

export interface GitHubInstallationsResponse {
  installations: GitHubInstallationDTO[];
  total_count: number;
}

export interface GitHubRepositoryDTO {
  id: number; // numeric GitHub repository ID
  installation_id: number;
  owner: string;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch: string;
}

export interface GitHubRepositoriesResponse {
  repositories: GitHubRepositoryDTO[];
  total_count: number;
}

export interface AnalyzeGitHubRepositoryRequest {
  installation_id: number;
  repository_id: number;
}
