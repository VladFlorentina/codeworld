"use client";

import React, { useMemo } from "react";
import { QuadraticBezierLine } from "@react-three/drei";
import { LayoutConnection } from "@/types/layout";

interface ConnectionLinesProps {
  connections: LayoutConnection[];
  selectedBuildingId: string | null;
}

/**
 * Renders dependency connection curves exclusively for the currently selected building.
 * - If no building is selected, renders nothing (avoids cluttering the city with all 400 lines).
 * - Outgoing imports: Cyan (#38bdf8)
 * - Incoming dependants: Purple (#a855f7)
 * - Circular dependencies: Amber (#f59e0b)
 */
export default function ConnectionLines({
  connections,
  selectedBuildingId,
}: ConnectionLinesProps) {
  const activeConnections = useMemo(() => {
    if (!selectedBuildingId) return [];
    return connections.filter(
      (c) =>
        c.source_building_id === selectedBuildingId ||
        c.target_building_id === selectedBuildingId
    );
  }, [connections, selectedBuildingId]);

  React.useEffect(() => {
    if (typeof window !== "undefined") {
      (window as any).__activeConnectionsCount = activeConnections.length;
    }
    return () => {
      if (typeof window !== "undefined") {
        (window as any).__activeConnectionsCount = 0;
      }
    };
  }, [activeConnections.length]);

  if (activeConnections.length === 0) return null;

  return (
    <group name="selected-connections">
      {activeConnections.map((c) => {
        const isOutgoing = c.source_building_id === selectedBuildingId;
        const [x0, y0, z0] = c.source;
        const [x1, y1, z1] = c.target;

        // Calculate elevated arc midpoint to bridge gracefully above intermediate buildings
        const dx = x1 - x0;
        const dz = z1 - z0;
        const horizontalDistance = Math.hypot(dx, dz);
        const midX = (x0 + x1) / 2;
        const midZ = (z0 + z1) / 2;
        const arcLift = Math.min(22, 2.5 + horizontalDistance * 0.22);
        const midY = Math.max(y0, y1) + arcLift;

        let lineColor = isOutgoing ? "#38bdf8" : "#a855f7";
        if (c.is_circular) {
          lineColor = "#f59e0b";
        }

        return (
          <QuadraticBezierLine
            key={c.id}
            start={c.source}
            end={c.target}
            mid={[midX, midY, midZ]}
            color={lineColor}
            lineWidth={1.6}
            transparent
            opacity={0.88}
          />
        );
      })}
    </group>
  );
}
