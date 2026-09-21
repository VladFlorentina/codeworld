import { BuildingMetricsDTO, CitySummaryDTO } from "./city";

export interface LayoutBuilding {
  id: string;
  district_id: string;
  name: string;
  path: string;
  language: string | null;
  color_hex: string;

  // 3D center position (for Three.js mesh positioning)
  x: number;
  y: number; // height / 2 so base rests at ground level (y = 0)
  z: number;

  // Dimensions
  width: number;
  height: number;
  depth: number;

  // 2D bounding box (horizontal footprint in world coordinates)
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;

  metrics: BuildingMetricsDTO;
}

export interface LayoutDistrict {
  id: string;
  path: string;
  name: string;
  parent_id: string | null;
  depth: number; // Hierarchy depth (0 = root, 1 = subfolder, ...)

  // 2D bounding box (world space)
  x: number; // minX corner
  z: number; // minZ corner
  width: number; // size along X
  depth_z: number; // size along Z

  // 3D center position (for Three.js district ground plate mesh)
  centerX: number;
  centerZ: number;

  // Explicit bounding coordinates for containment/collision checks
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface LayoutConnection {
  id: string;
  source_building_id: string;
  target_building_id: string;
  connection_type: string;
  is_circular: boolean;

  // 3D coordinates for endpoints (source rooftop to target rooftop)
  source: [number, number, number];
  target: [number, number, number];
}

export interface LayoutBounds {
  width: number;
  depth: number;
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface LayoutCity {
  repository_name: string;
  commit_sha: string | null;
  summary: CitySummaryDTO;
  districts: LayoutDistrict[];
  buildings: LayoutBuilding[];
  connections: LayoutConnection[];
  bounds: LayoutBounds;
}
