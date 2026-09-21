"use client";

import React, { useMemo } from "react";
import { Canvas, useThree } from "@react-three/fiber";
import { OrbitControls } from "@react-three/drei";
import { LayoutCity } from "@/types/layout";
import DistrictPlates from "./DistrictPlates";
import Buildings from "./Buildings";
import ConnectionLines from "./ConnectionLines";

function SceneStatsTracker() {
  const { gl } = useThree();

  React.useEffect(() => {
    if (typeof window !== "undefined") {
      (window as any).__getSceneStats = () => {
        return {
          drawCalls: gl.info.render.calls,
          triangles: gl.info.render.triangles,
          geometries: gl.info.memory.geometries,
          textures: gl.info.memory.textures,
        };
      };
    }
  }, [gl]);

  return null;
}

interface CityCanvasProps {
  layout: LayoutCity;
  selectedBuildingId?: string | null;
  onSelectBuilding?: (id: string | null) => void;
}

/**
 * CityCanvas — Client Component hosting the React Three Fiber 3D viewport.
 * - Entirely decoupled from specific repositories: receives layout via props.
 * - Dynamic camera positioning computed from layout.bounds.
 * - OrbitControls for rotate (left-click), pan (right-click), and zoom (wheel).
 * - Renders all hierarchical district plates and all building towers.
 */
export default function CityCanvas({
  layout,
  selectedBuildingId = null,
  onSelectBuilding,
}: CityCanvasProps) {
  const { bounds, districts, buildings } = layout;

  // Calculate center and maximum horizontal dimension from layout.bounds
  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerZ = (bounds.minZ + bounds.maxZ) / 2;
  const maxDim = Math.max(bounds.width, bounds.depth, 20);

  // Dynamic camera position: elevated isometric diagonal perspective
  const cameraPosition = useMemo<[number, number, number]>(() => {
    return [
      centerX + maxDim * 0.65,
      maxDim * 0.85,
      centerZ + maxDim * 0.85,
    ];
  }, [centerX, centerZ, maxDim]);

  const target = useMemo<[number, number, number]>(() => {
    return [centerX, 0, centerZ];
  }, [centerX, centerZ]);

  return (
    <div className="relative w-full h-full min-h-[600px] overflow-hidden select-none bg-[#0a0f1d]">
      <Canvas
        camera={{
          position: cameraPosition,
          fov: 48,
          near: 0.5,
          far: Math.max(3000, maxDim * 10),
        }}
        gl={{ antialias: true }}
        onPointerMissed={() => onSelectBuilding?.(null)}
        className="w-full h-full"
      >
        {/* Deep Slate Background & Depth Fog */}
        <color attach="background" args={["#0a0f1d"]} />
        <fog attach="fog" args={["#0a0f1d", maxDim * 1.5, maxDim * 4]} />

        {/* Illumination: Ambient + Balanced Directional Lights */}
        <ambientLight intensity={0.7} />
        <directionalLight
          position={[centerX + maxDim * 0.5, maxDim * 1.2, centerZ + maxDim * 0.5]}
          intensity={1.2}
        />
        <directionalLight
          position={[centerX - maxDim * 0.5, maxDim * 0.6, centerZ - maxDim * 0.5]}
          intensity={0.4}
        />

        {/* Orbit Controls */}
        <OrbitControls
          target={target}
          enableDamping={true}
          dampingFactor={0.05}
          maxPolarAngle={Math.PI / 2 - 0.03} // Keep camera above ground
          minDistance={4}
          maxDistance={maxDim * 4}
          makeDefault
        />

        {/* Global Foundation Base */}
        <mesh position={[centerX, -0.15, centerZ]}>
          <boxGeometry args={[bounds.width + 12, 0.3, bounds.depth + 12]} />
          <meshStandardMaterial color="#0b1120" roughness={0.9} />
        </mesh>

        {/* Structural Grid Reference */}
        <gridHelper
          args={[
            Math.max(bounds.width, bounds.depth) * 1.5,
            Math.max(10, Math.round(maxDim / 6)),
            "#334155",
            "#1e293b",
          ]}
          position={[centerX, 0.01, centerZ]}
        />

        {/* 1. All District Plates (Terraces) */}
        <DistrictPlates districts={districts} />

        {/* 2. All Repository Buildings */}
        <Buildings
          buildings={buildings}
          districts={districts}
          selectedBuildingId={selectedBuildingId}
          onSelectBuilding={onSelectBuilding}
        />

        {/* 3. Dynamic Dependency Connection Arcs for Selected Building */}
        <ConnectionLines
          connections={layout.connections}
          selectedBuildingId={selectedBuildingId}
        />

        {/* Scene performance and render telemetry */}
        <SceneStatsTracker />
      </Canvas>

      {/* HUD Info Overlay */}
      <div className="absolute top-4 left-4 pointer-events-none flex flex-col gap-1 text-xs font-mono text-neutral-300 bg-neutral-900/80 backdrop-blur border border-neutral-800 rounded-lg p-3 shadow-lg">
        <div className="font-semibold text-neutral-100 flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-400" />
          {layout.repository_name}
        </div>
        <div className="text-neutral-400">
          City Bounds: {bounds.width.toFixed(1)} x {bounds.depth.toFixed(1)} units
        </div>
        <div className="text-neutral-400">
          Districts: {districts.length} | Buildings: {buildings.length} | Connections: {layout.connections.length}
        </div>
      </div>

      {/* Navigation Help Controls */}
      <div className="absolute bottom-4 right-4 pointer-events-none text-xs font-mono text-neutral-400 bg-neutral-900/70 backdrop-blur border border-neutral-800/80 rounded px-2.5 py-1">
        Left Click: Rotate | Right Click: Pan | Scroll: Zoom
      </div>
    </div>
  );
}
