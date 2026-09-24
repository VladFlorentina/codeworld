"use client";

import React, { memo } from "react";
import { PositionedCity } from "@/types/world";
import { EcosystemTheme } from "./worldTheme";

interface CityNodeProps {
  city: PositionedCity;
  theme: EcosystemTheme;
  onCityClick?: (e: React.MouseEvent) => void;
}

export const CityNode = memo(function CityNode({
  city,
  theme,
  onCityClick,
}: CityNodeProps) {
  const { city: data, x, y, radius } = city;

  return (
    <a
      href={`/city/${data.repository_id}`}
      data-testid={`city-node-${data.repository_id}`}
      aria-label={`${data.full_name}, ${data.primary_language}, ${data.total_files} files`}
      onClick={onCityClick}
      className="cursor-pointer group focus:outline-none"
    >
      <title>{`${data.full_name}\n${data.primary_language} • ${data.total_files.toLocaleString()} files • ${data.total_loc.toLocaleString()} LOC`}</title>

      {/* Halo / boundary circle */}
      <circle
        cx={x}
        cy={y}
        r={radius}
        fill={theme.cityFill}
        stroke={theme.cityStroke}
        strokeWidth={1.5}
        className="transition-all duration-150 group-hover:brightness-125 group-focus-visible:stroke-white group-focus-visible:stroke-[3px]"
      />

      {/* Core disk */}
      <circle
        cx={x}
        cy={y}
        r={Math.max(3, radius * 0.35)}
        fill={theme.cityStroke}
        opacity={0.8}
        className="transition-opacity group-hover:opacity-100"
      />

      {/* Repository name label */}
      <text
        x={x}
        y={y + radius + 12}
        textAnchor="middle"
        fill="#e5e7eb"
        fontSize={11}
        fontFamily="monospace"
        className="select-none pointer-events-none group-hover:fill-emerald-300 transition-colors"
      >
        {data.name}
      </text>
    </a>
  );
});
