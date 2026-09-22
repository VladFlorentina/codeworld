"use client";

import React, { useMemo } from "react";
import { LayoutDistrict } from "@/types/layout";
import { LAYOUT_CONFIG, getDistrictElevation } from "@/lib/layout";

interface DistrictPlatesProps {
  districts: LayoutDistrict[];
}

// Color palette mapping hierarchy depth to elegant slate tones
const DEPTH_COLORS = [
  "#0f172a", // Depth 0: Root (slate-900)
  "#1e293b", // Depth 1: Main top-level folders (slate-800)
  "#334155", // Depth 2: Sub-folders (slate-700)
  "#475569", // Depth 3: Deep nested folders (slate-600)
  "#64748b", // Depth 4+: (slate-500)
];

/**
 * Renders hierarchical ground plates for all repository districts.
 * Deeper districts are slightly elevated to form intuitive multi-level terraces.
 */
export default function DistrictPlates({ districts }: DistrictPlatesProps) {
  const sortedDistricts = useMemo(() => {
    // Render lower depth first so nested plates layer naturally on top
    return [...districts].sort((a, b) => a.depth - b.depth);
  }, [districts]);

  return (
    <group name="district-plates">
      {sortedDistricts.map((d) => {
        const color = DEPTH_COLORS[Math.min(d.depth, DEPTH_COLORS.length - 1)];
        const elevation = getDistrictElevation(d.depth);
        const plateY = elevation + LAYOUT_CONFIG.PLATE_THICKNESS / 2;

        return (
          <group key={d.id} position={[d.centerX, plateY, d.centerZ]}>
            <mesh receiveShadow>
              <boxGeometry args={[d.width, LAYOUT_CONFIG.PLATE_THICKNESS, d.depth_z]} />
              <meshStandardMaterial
                color={color}
                roughness={0.75}
                metalness={0.1}
                transparent={d.depth === 0}
                opacity={d.depth === 0 ? 0.7 : 0.85}
              />
            </mesh>
          </group>
        );
      })}
    </group>
  );
}
