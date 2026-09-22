/**
 * Type definitions for Phase 6: World Map & Deterministic Layout.
 */

export interface WorldCityDTO {
  repository_id: string;
  owner: string;
  name: string;
  full_name: string;
  description: string | null;
  primary_language: string;
  total_files: number;
  total_loc: number;
  complexity: number;
  commit_sha: string;
  analyzed_at: string | null;
}

export interface WorldMapResponse {
  cities: WorldCityDTO[];
  total_cities: number;
}

export type EcosystemKey =
  | "python"
  | "web"
  | "rust"
  | "go"
  | "jvm"
  | "native"
  | "frontier";

export interface PositionedCity {
  city: WorldCityDTO;
  ecosystem: EcosystemKey;
  x: number;
  y: number;
  radius: number;
}

export interface LayoutCountry {
  owner: string;
  ecosystem: EcosystemKey;
  x: number;
  y: number;
  radius: number;
  cities: PositionedCity[];
}

export interface LayoutContinent {
  ecosystem: EcosystemKey;
  displayName: string;
  x: number;
  y: number;
  radius: number;
  countries: LayoutCountry[];
}

export interface WorldBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  width: number;
  height: number;
}

export interface WorldLayout {
  continents: LayoutContinent[];
  cities: PositionedCity[];
  totalCities: number;
  bounds: WorldBounds | null;
}
