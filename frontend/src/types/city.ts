/**
 * Contract mirroring backend CityDTO produced by CodeWorld analyzer.
 * All types correspond 1:1 with Python dataclasses in analyzer.world_generator.
 */

export interface BuildingMetricsDTO {
  loc_total: number;
  loc_code: number;
  loc_blank: number;
  complexity: number;
  function_count: number;
  class_count: number;
  interface_count: number;
  in_degree: number;
  out_degree: number;
  is_in_cycle: boolean;
}

export interface BuildingDTO {
  id: string;
  district_id: string;
  name: string;
  path: string;
  language: string | null;
  color_hex: string;
  metrics: BuildingMetricsDTO;
}

export interface DistrictDTO {
  id: string;
  path: string;
  name: string;
  parent_id: string | null;
  depth: number;
}

export interface ConnectionDTO {
  id: string;
  source_building_id: string;
  target_building_id: string;
  connection_type: string;
  is_circular: boolean;
}

export interface CitySummaryDTO {
  total_files: number;
  total_loc_code: number;
  total_complexity: number;
  languages: Record<string, number>;
  circular_dependency_count: number;
}

export interface CityDTO {
  repository_name: string;
  commit_sha: string | null;
  summary: CitySummaryDTO;
  districts: DistrictDTO[];
  buildings: BuildingDTO[];
  connections: ConnectionDTO[];
}

export type SubmitStatus = "ready" | "analyzing" | "newly_queued";

export interface SubmitRepositoryResponse {
  status: SubmitStatus;
  repository_id: string;
  run_id: string;
  job_id: string | null;
  commit_sha: string;
  message: string;
}

export type JobStatus = "queued" | "running" | "complete" | "failed";

export interface JobStatusResponse {
  job_id: string;
  run_id: string;
  repository_id: string;
  status: JobStatus;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
}

