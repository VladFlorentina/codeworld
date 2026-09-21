"use client";

import React, { useMemo } from "react";
import { LayoutBuilding, LayoutDistrict } from "@/types/layout";
import { getBuildingBaseElevation } from "@/lib/layout";

interface BuildingsProps {
  buildings: LayoutBuilding[];
  districts?: LayoutDistrict[];
  selectedBuildingId?: string | null;
  onSelectBuilding?: (id: string | null) => void;
}

/**
 * Renders all buildings in the software city.
 * Supports interactive selection via click and clear reversible visual highlight.
 */
export default function Buildings({
  buildings,
  districts = [],
  selectedBuildingId = null,
  onSelectBuilding,
}: BuildingsProps) {
  // Lookup map to get district depth for accurate vertical positioning
  const districtDepthMap = useMemo(() => {
    const map = new Map<string, number>();
    for (const d of districts) {
      map.set(d.id, d.depth);
    }
    return map;
  }, [districts]);

  return (
    <group name="city-buildings">
      {buildings.map((b) => {
        const depth = districtDepthMap.get(b.district_id) ?? 0;
        const baseElevation = getBuildingBaseElevation(depth);
        const centerY = baseElevation + b.height / 2;
        const isSelected = selectedBuildingId === b.id;

        return (
          <group key={b.id} position={[b.x, centerY, b.z]}>
            {/* Primary Building Mesh */}
            <mesh
              castShadow
              receiveShadow
              onClick={(e) => {
                e.stopPropagation(); // Prevent deselect on canvas
                onSelectBuilding?.(b.id);
              }}
              onPointerOver={(e) => {
                e.stopPropagation();
                document.body.style.cursor = "pointer";
              }}
              onPointerOut={() => {
                document.body.style.cursor = "default";
              }}
            >
              <boxGeometry args={[b.width, b.height, b.depth]} />
              <meshStandardMaterial
                color={b.color_hex || "#888888"}
                emissive={isSelected ? "#38bdf8" : "#000000"}
                emissiveIntensity={isSelected ? 0.35 : 0}
                roughness={isSelected ? 0.2 : 0.35}
                metalness={isSelected ? 0.25 : 0.15}
              />
            </mesh>

            {/* Reversible Selection Wireframe Cage (clean highlight without post-processing) */}
            {isSelected && (
              <mesh>
                <boxGeometry args={[b.width + 0.15, b.height + 0.15, b.depth + 0.15]} />
                <meshBasicMaterial color="#38bdf8" wireframe />
              </mesh>
            )}
          </group>
        );
      })}
    </group>
  );
}
