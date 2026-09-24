"use client";

import React, { memo } from "react";
import { PositionedCity } from "@/types/world";
import { EcosystemTheme } from "./worldTheme";

interface CityNodeProps {
  city: PositionedCity;
  theme: EcosystemTheme;
  isSelected?: boolean;
  onSelect?: (city: PositionedCity) => void;
  isDragActive?: () => boolean;
}

export const CityNode = memo(function CityNode({
  city,
  theme,
  isSelected = false,
  onSelect,
  isDragActive,
}: CityNodeProps) {
  const { city: data, x, y, radius } = city;

  const handleClick = (e: React.MouseEvent) => {
    // 1. Drag blocks selection and accidental navigation
    if (isDragActive && isDragActive()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }

    // 2. Allow native navigation on modifier keys (Ctrl, Cmd, Shift, Alt, middle-click)
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) {
      return;
    }

    // 3. Normal click (including triggered via Enter key on native link) transforms into selection
    e.preventDefault();
    onSelect?.(city);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === " ") {
      e.preventDefault();
      onSelect?.(city);
    }
  };

  return (
    <a
      href={`/city/${data.repository_id}`}
      data-testid={`city-node-${data.repository_id}`}
      aria-label={`${data.full_name}, ${data.primary_language}, ${data.total_files} files`}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      className="cursor-pointer group outline-none focus-visible:outline-none"
    >
      <title>{`${data.full_name}\n${data.primary_language} • ${data.total_files.toLocaleString()} files • ${data.total_loc.toLocaleString()} LOC`}</title>

      {/* Selected highlight ring */}
      {isSelected && (
        <circle
          cx={x}
          cy={y}
          r={radius + 4}
          fill="none"
          stroke="#ffffff"
          strokeWidth={2}
          strokeDasharray="4 3"
          data-testid={`city-selected-ring-${data.repository_id}`}
          className="pointer-events-none"
        />
      )}

      {/* Halo / boundary circle */}
      <circle
        cx={x}
        cy={y}
        r={radius}
        fill={theme.cityFill}
        stroke={isSelected ? "#ffffff" : theme.cityStroke}
        strokeWidth={isSelected ? 2.5 : 1.5}
        className="transition-all duration-150 group-hover:brightness-125 group-focus-visible:stroke-white group-focus-visible:stroke-[2.5px]"
      />

      {/* Core disk */}
      <circle
        cx={x}
        cy={y}
        r={Math.max(3, radius * 0.35)}
        fill={isSelected ? "#ffffff" : theme.cityStroke}
        opacity={isSelected ? 1 : 0.8}
        className="transition-opacity group-hover:opacity-100"
      />

      {/* Repository name label */}
      <text
        x={x}
        y={y + radius + 12}
        textAnchor="middle"
        fill={isSelected ? "#ffffff" : "#e5e7eb"}
        fontWeight={isSelected ? "bold" : "normal"}
        fontSize={11}
        fontFamily="monospace"
        className="select-none pointer-events-none group-hover:fill-emerald-300 transition-colors"
      >
        {data.name}
      </text>
    </a>
  );
});
