import { CityDTO, DistrictDTO, BuildingDTO } from "@/types/city";
import {
  LayoutCity,
  LayoutDistrict,
  LayoutBuilding,
  LayoutConnection,
  LayoutBounds,
} from "@/types/layout";

export const LAYOUT_CONFIG = {
  BUILDING_WIDTH: 2.0,
  BUILDING_DEPTH: 2.0,
  BUILDING_GAP: 1.0,
  DISTRICT_PADDING: 2.0,
  DISTRICT_GAP: 3.0,
  MIN_DISTRICT_WIDTH: 6.0,
  MIN_DISTRICT_DEPTH: 6.0,
  PLATE_THICKNESS: 0.12,
  ELEVATION_STEP: 0.06,
};

/**
 * Returns the bottom elevation of a district plate at a given hierarchy depth.
 */
export function getDistrictElevation(depth: number): number {
  return depth * LAYOUT_CONFIG.ELEVATION_STEP;
}

/**
 * Returns the base elevation where buildings rest (top of parent district plate).
 */
export function getBuildingBaseElevation(depth: number): number {
  return getDistrictElevation(depth) + LAYOUT_CONFIG.PLATE_THICKNESS;
}

/**
 * Computes building height based on lines of code (loc_code).
 * Isolated for calibration and visual tuning.
 */
export function calculateBuildingHeight(locCode: number): number {
  if (locCode <= 0) return 1.0;
  const height = Math.max(1.0, Math.log2(locCode + 1) * 1.0);
  return Math.round(height * 100) / 100;
}

interface LocalBuildingPlacement {
  building: BuildingDTO;
  localCenterX: number;
  localCenterZ: number;
  width: number;
  height: number;
  depth: number;
}

interface DistrictLayoutNode {
  district: DistrictDTO;
  width: number;
  depth_z: number;
  localX: number;
  localZ: number;
  localBuildings: LocalBuildingPlacement[];
  children: DistrictLayoutNode[];
}

type LayoutBlock =
  | { type: "buildings"; width: number; depth: number }
  | { type: "district"; node: DistrictLayoutNode; width: number; depth: number };

/**
 * Pure, deterministic function that transforms a CityDTO into a 3D layout representation.
 * - Hierarchical grid layout: districts encompass their direct buildings and child subdistricts.
 * - Deterministic: identical inputs produce identical coordinates, regardless of input array order.
 * - Non-mutating: does not modify the input CityDTO.
 */
export function computeCityLayout(city: CityDTO): LayoutCity {
  // Sort districts deterministically: root first, then by depth, then by path
  const sortedDistricts = [...city.districts].sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.path.localeCompare(b.path);
  });

  // Sort buildings deterministically by path
  const sortedBuildings = [...city.buildings].sort((a, b) =>
    a.path.localeCompare(b.path)
  );

  if (sortedDistricts.length === 0) {
    return {
      repository_name: city.repository_name,
      commit_sha: city.commit_sha,
      summary: { ...city.summary },
      districts: [],
      buildings: [],
      connections: [],
      bounds: { width: 0, depth: 0, minX: 0, maxX: 0, minZ: 0, maxZ: 0 },
    };
  }

  const districtsById = new Map<string, DistrictDTO>();
  for (const d of sortedDistricts) {
    districtsById.set(d.id, d);
  }

  const childrenByParent = new Map<string, DistrictDTO[]>();
  for (const d of sortedDistricts) {
    if (d.parent_id !== null && districtsById.has(d.parent_id)) {
      const list = childrenByParent.get(d.parent_id) || [];
      list.push(d);
      childrenByParent.set(d.parent_id, list);
    }
  }
  for (const list of childrenByParent.values()) {
    list.sort((a, b) => a.path.localeCompare(b.path));
  }

  const buildingsByDistrict = new Map<string, BuildingDTO[]>();
  for (const b of sortedBuildings) {
    const list = buildingsByDistrict.get(b.district_id) || [];
    list.push(b);
    buildingsByDistrict.set(b.district_id, list);
  }
  for (const list of buildingsByDistrict.values()) {
    list.sort((a, b) => a.path.localeCompare(b.path));
  }

  function layoutDistrictNode(district: DistrictDTO): DistrictLayoutNode {
    const childDistricts = childrenByParent.get(district.id) || [];
    const childNodes = childDistricts.map((cd) => layoutDistrictNode(cd));

    const directBuildings = buildingsByDistrict.get(district.id) || [];
    const buildingOffsets = directBuildings.map((b, i) => {
      const cols = Math.max(1, Math.ceil(Math.sqrt(directBuildings.length)));
      const col = i % cols;
      const row = Math.floor(i / cols);
      const relCenterX =
        col * (LAYOUT_CONFIG.BUILDING_WIDTH + LAYOUT_CONFIG.BUILDING_GAP) +
        LAYOUT_CONFIG.BUILDING_WIDTH / 2;
      const relCenterZ =
        row * (LAYOUT_CONFIG.BUILDING_DEPTH + LAYOUT_CONFIG.BUILDING_GAP) +
        LAYOUT_CONFIG.BUILDING_DEPTH / 2;
      const height = calculateBuildingHeight(b.metrics.loc_code);
      return {
        building: b,
        relCenterX,
        relCenterZ,
        width: LAYOUT_CONFIG.BUILDING_WIDTH,
        height,
        depth: LAYOUT_CONFIG.BUILDING_DEPTH,
      };
    });

    const blocks: LayoutBlock[] = [];

    if (buildingOffsets.length > 0) {
      const cols = Math.max(1, Math.ceil(Math.sqrt(directBuildings.length)));
      const rows = Math.ceil(directBuildings.length / cols);
      const bldGridWidth =
        cols * LAYOUT_CONFIG.BUILDING_WIDTH +
        (cols - 1) * LAYOUT_CONFIG.BUILDING_GAP;
      const bldGridDepth =
        rows * LAYOUT_CONFIG.BUILDING_DEPTH +
        (rows - 1) * LAYOUT_CONFIG.BUILDING_GAP;

      blocks.push({
        type: "buildings",
        width: bldGridWidth,
        depth: bldGridDepth,
      });
    }

    for (const childNode of childNodes) {
      blocks.push({
        type: "district",
        node: childNode,
        width: childNode.width,
        depth: childNode.depth_z,
      });
    }

    // If district has no buildings and no subdistricts
    if (blocks.length === 0) {
      return {
        district,
        width: LAYOUT_CONFIG.MIN_DISTRICT_WIDTH,
        depth_z: LAYOUT_CONFIG.MIN_DISTRICT_DEPTH,
        localX: 0,
        localZ: 0,
        localBuildings: [],
        children: childNodes,
      };
    }

    // Shelf packing for blocks inside district
    let totalArea = 0;
    let maxBlockWidth = 0;
    for (const block of blocks) {
      totalArea +=
        (block.width + LAYOUT_CONFIG.DISTRICT_GAP) *
        (block.depth + LAYOUT_CONFIG.DISTRICT_GAP);
      if (block.width > maxBlockWidth) {
        maxBlockWidth = block.width;
      }
    }
    const idealWidth = Math.sqrt(totalArea);
    const targetWidth = Math.max(maxBlockWidth, idealWidth);

    interface PlacedBlock {
      block: LayoutBlock;
      x: number;
      z: number;
    }

    const shelves: PlacedBlock[][] = [];
    let currentShelf: PlacedBlock[] = [];
    let currentX = LAYOUT_CONFIG.DISTRICT_PADDING;
    let currentZ = LAYOUT_CONFIG.DISTRICT_PADDING;
    let currentShelfHeight = 0;
    let maxOccupiedWidth = 0;

    for (const block of blocks) {
      const neededWidth =
        currentShelf.length > 0
          ? LAYOUT_CONFIG.DISTRICT_GAP + block.width
          : block.width;

      if (
        currentShelf.length > 0 &&
        currentX + neededWidth > LAYOUT_CONFIG.DISTRICT_PADDING + targetWidth
      ) {
        currentZ += currentShelfHeight + LAYOUT_CONFIG.DISTRICT_GAP;
        currentX = LAYOUT_CONFIG.DISTRICT_PADDING;
        currentShelfHeight = 0;
        shelves.push(currentShelf);
        currentShelf = [];
      }

      if (currentShelf.length > 0) {
        currentX += LAYOUT_CONFIG.DISTRICT_GAP;
      }

      currentShelf.push({
        block,
        x: currentX,
        z: currentZ,
      });

      currentShelfHeight = Math.max(currentShelfHeight, block.depth);
      currentX += block.width;
      maxOccupiedWidth = Math.max(maxOccupiedWidth, currentX);
    }

    if (currentShelf.length > 0) {
      shelves.push(currentShelf);
    }

    const totalOccupiedDepth = currentZ + currentShelfHeight;
    const districtWidth = Math.max(
      LAYOUT_CONFIG.MIN_DISTRICT_WIDTH,
      maxOccupiedWidth + LAYOUT_CONFIG.DISTRICT_PADDING
    );
    const districtDepthZ = Math.max(
      LAYOUT_CONFIG.MIN_DISTRICT_DEPTH,
      totalOccupiedDepth + LAYOUT_CONFIG.DISTRICT_PADDING
    );

    let localBuildings: LocalBuildingPlacement[] = [];

    for (const shelf of shelves) {
      for (const placed of shelf) {
        if (placed.block.type === "buildings") {
          localBuildings = buildingOffsets.map((bo) => ({
            building: bo.building,
            localCenterX: placed.x + bo.relCenterX,
            localCenterZ: placed.z + bo.relCenterZ,
            width: bo.width,
            height: bo.height,
            depth: bo.depth,
          }));
        } else if (placed.block.type === "district") {
          placed.block.node.localX = placed.x;
          placed.block.node.localZ = placed.z;
        }
      }
    }

    return {
      district,
      width: districtWidth,
      depth_z: districtDepthZ,
      localX: 0,
      localZ: 0,
      localBuildings,
      children: childNodes,
    };
  }

  const rootDistricts = sortedDistricts.filter(
    (d) => d.parent_id === null || !districtsById.has(d.parent_id)
  );

  const rootNodes = rootDistricts.map((rd) => layoutDistrictNode(rd));

  // Arrange multiple top-level roots along X with DISTRICT_GAP
  let currentRootX = 0;
  for (const rn of rootNodes) {
    rn.localX = currentRootX;
    rn.localZ = 0;
    currentRootX += rn.width + LAYOUT_CONFIG.DISTRICT_GAP;
  }

  const layoutDistricts: LayoutDistrict[] = [];
  const layoutBuildings: LayoutBuilding[] = [];

  function resolveWorldCoordinates(
    node: DistrictLayoutNode,
    parentWorldX: number,
    parentWorldZ: number
  ) {
    const worldX = parentWorldX + node.localX;
    const worldZ = parentWorldZ + node.localZ;

    layoutDistricts.push({
      id: node.district.id,
      path: node.district.path,
      name: node.district.name,
      parent_id: node.district.parent_id,
      depth: node.district.depth,
      x: worldX,
      z: worldZ,
      width: node.width,
      depth_z: node.depth_z,
      centerX: worldX + node.width / 2,
      centerZ: worldZ + node.depth_z / 2,
      minX: worldX,
      maxX: worldX + node.width,
      minZ: worldZ,
      maxZ: worldZ + node.depth_z,
    });

    for (const lb of node.localBuildings) {
      const bWorldCenterX = worldX + lb.localCenterX;
      const bWorldCenterZ = worldZ + lb.localCenterZ;
      const bWorldCenterY = lb.height / 2;

      layoutBuildings.push({
        id: lb.building.id,
        district_id: lb.building.district_id,
        name: lb.building.name,
        path: lb.building.path,
        language: lb.building.language,
        color_hex: lb.building.color_hex,
        x: bWorldCenterX,
        y: bWorldCenterY,
        z: bWorldCenterZ,
        width: lb.width,
        height: lb.height,
        depth: lb.depth,
        minX: bWorldCenterX - lb.width / 2,
        maxX: bWorldCenterX + lb.width / 2,
        minZ: bWorldCenterZ - lb.depth / 2,
        maxZ: bWorldCenterZ + lb.depth / 2,
        metrics: lb.building.metrics,
      });
    }

    for (const child of node.children) {
      resolveWorldCoordinates(child, worldX, worldZ);
    }
  }

  for (const rn of rootNodes) {
    resolveWorldCoordinates(rn, 0, 0);
  }

  const buildingMap = new Map<string, LayoutBuilding>();
  for (const b of layoutBuildings) {
    buildingMap.set(b.id, b);
  }

  const layoutConnections: LayoutConnection[] = [];
  const sortedConnections = [...city.connections].sort((a, b) =>
    a.id.localeCompare(b.id)
  );

  for (const conn of sortedConnections) {
    const src = buildingMap.get(conn.source_building_id);
    const tgt = buildingMap.get(conn.target_building_id);
    if (src && tgt) {
      const srcDistrict = districtsById.get(src.district_id);
      const srcDepth = srcDistrict ? srcDistrict.depth : 0;
      const srcTopY = getBuildingBaseElevation(srcDepth) + src.height;

      const tgtDistrict = districtsById.get(tgt.district_id);
      const tgtDepth = tgtDistrict ? tgtDistrict.depth : 0;
      const tgtTopY = getBuildingBaseElevation(tgtDepth) + tgt.height;

      layoutConnections.push({
        id: conn.id,
        source_building_id: conn.source_building_id,
        target_building_id: conn.target_building_id,
        connection_type: conn.connection_type,
        is_circular: conn.is_circular,
        source: [src.x, srcTopY, src.z],
        target: [tgt.x, tgtTopY, tgt.z],
      });
    }
  }

  // Final deterministic sorting
  layoutDistricts.sort((a, b) => {
    if (a.depth !== b.depth) return a.depth - b.depth;
    return a.path.localeCompare(b.path);
  });
  layoutBuildings.sort((a, b) => a.path.localeCompare(b.path));
  layoutConnections.sort((a, b) => a.id.localeCompare(b.id));

  let minX = 0;
  let maxX = 0;
  let minZ = 0;
  let maxZ = 0;

  if (layoutDistricts.length > 0) {
    minX = Math.min(...layoutDistricts.map((d) => d.minX));
    maxX = Math.max(...layoutDistricts.map((d) => d.maxX));
    minZ = Math.min(...layoutDistricts.map((d) => d.minZ));
    maxZ = Math.max(...layoutDistricts.map((d) => d.maxZ));
  }

  const bounds: LayoutBounds = {
    width: maxX - minX,
    depth: maxZ - minZ,
    minX,
    maxX,
    minZ,
    maxZ,
  };

  return {
    repository_name: city.repository_name,
    commit_sha: city.commit_sha,
    summary: { ...city.summary },
    districts: layoutDistricts,
    buildings: layoutBuildings,
    connections: layoutConnections,
    bounds,
  };
}
