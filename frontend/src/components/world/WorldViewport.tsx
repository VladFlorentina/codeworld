"use client";

import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { WorldBounds, WorldLayout, PositionedCity } from "@/types/world";
import { getEcosystemTheme } from "./worldTheme";
import { CityNode } from "./CityNode";
import { WorldInspector } from "./WorldInspector";

interface WorldViewportProps {
  layout: WorldLayout;
}

function computeInitialFit(
  bounds: WorldBounds | null,
  containerW: number,
  containerH: number
): {
  pan: { x: number; y: number };
  zoom: number;
  minZoom: number;
  maxZoom: number;
} {
  const defaultMaxZoom = 4;

  if (!bounds || containerW <= 0 || containerH <= 0) {
    return {
      pan: { x: containerW / 2, y: containerH / 2 },
      zoom: 1,
      minZoom: 0.1,
      maxZoom: defaultMaxZoom,
    };
  }

  const PADDING = 60;
  const paddedW = Math.max(bounds.width + 2 * PADDING, 1);
  const paddedH = Math.max(bounds.height + 2 * PADDING, 1);

  const fitZoom = Math.min(
    containerW / paddedW,
    containerH / paddedH,
    1.5
  );

  const minZoom = Math.min(0.1, fitZoom);

  const centerX = (bounds.minX + bounds.maxX) / 2;
  const centerY = (bounds.minY + bounds.maxY) / 2;

  const panX = containerW / 2 - centerX * fitZoom;
  const panY = containerH / 2 - centerY * fitZoom;

  return {
    pan: { x: panX, y: panY },
    zoom: fitZoom,
    minZoom,
    maxZoom: defaultMaxZoom,
  };
}

export function WorldViewport({ layout }: WorldViewportProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Camera state
  const [pan, setPan] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
  const [zoom, setZoom] = useState<number>(1);
  const [minZoom, setMinZoom] = useState<number>(0.1);
  const [maxZoom, setMaxZoom] = useState<number>(4);

  // Inspector selection state
  const [selectedCityId, setSelectedCityId] = useState<string | null>(null);
  const selectedCity = useMemo(
    () => layout.cities.find((c) => c.city.repository_id === selectedCityId) || null,
    [layout.cities, selectedCityId]
  );

  // Interaction refs
  const isPanningRef = useRef<boolean>(false);
  const startPointRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const startPanRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 });
  const didDragRef = useRef<boolean>(false);
  const hasUserInteractedRef = useRef<boolean>(false);

  // Fit camera to world layout
  const applyFit = useCallback(
    (force: boolean = false) => {
      if (!containerRef.current) return;
      if (!force && hasUserInteractedRef.current) return;

      const rect = containerRef.current.getBoundingClientRect();
      const fit = computeInitialFit(layout.bounds, rect.width, rect.height);
      setPan(fit.pan);
      setZoom(fit.zoom);
      setMinZoom(fit.minZoom);
      setMaxZoom(fit.maxZoom);
    },
    [layout.bounds]
  );

  // Fit on mount or when layout changes
  useEffect(() => {
    hasUserInteractedRef.current = false;
    applyFit(true);
  }, [applyFit]);

  // ResizeObserver: auto-fit only if user has not manually moved the camera
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() => {
      applyFit(false);
    });

    observer.observe(el);
    return () => observer.disconnect();
  }, [applyFit]);

  // Non-passive wheel listener for smooth zoom centered on pointer
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const handleWheel = (e: WheelEvent) => {
      e.preventDefault();

      const rect = el.getBoundingClientRect();
      const pointerX = e.clientX - rect.left;
      const pointerY = e.clientY - rect.top;

      const zoomFactor = e.deltaY < 0 ? 1.15 : 0.85;

      setZoom((prevZoom) => {
        const nextZoom = Math.min(maxZoom, Math.max(minZoom, prevZoom * zoomFactor));
        if (nextZoom === prevZoom) return prevZoom;

        setPan((prevPan) => {
          const nextPanX = pointerX - (pointerX - prevPan.x) * (nextZoom / prevZoom);
          const nextPanY = pointerY - (pointerY - prevPan.y) * (nextZoom / prevZoom);
          return { x: nextPanX, y: nextPanY };
        });

        hasUserInteractedRef.current = true;
        return nextZoom;
      });
    };

    el.addEventListener("wheel", handleWheel, { passive: false });
    return () => el.removeEventListener("wheel", handleWheel);
  }, [minZoom, maxZoom]);

  // Pointer drag pan handlers
  const handlePointerDown = (e: React.PointerEvent<SVGSVGElement>) => {
    if (e.button !== 0) return; // Only primary mouse button

    isPanningRef.current = true;
    startPointRef.current = { x: e.clientX, y: e.clientY };
    startPanRef.current = { ...pan };
    didDragRef.current = false;
  };

  const handlePointerMove = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!isPanningRef.current) return;

    const dx = e.clientX - startPointRef.current.x;
    const dy = e.clientY - startPointRef.current.y;

    if (!didDragRef.current && Math.hypot(dx, dy) > 5) {
      didDragRef.current = true;
      hasUserInteractedRef.current = true;
      try {
        e.currentTarget.setPointerCapture(e.pointerId);
      } catch {
        // Ignore if pointer capture fails
      }
    }

    if (didDragRef.current) {
      setPan({
        x: startPanRef.current.x + dx,
        y: startPanRef.current.y + dy,
      });
    }
  };

  const handlePointerUp = (e: React.PointerEvent<SVGSVGElement>) => {
    if (!isPanningRef.current) return;
    isPanningRef.current = false;

    if (didDragRef.current) {
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // Ignore if capture was already released
      }
    }

    // Reset didDrag after click event dispatch cycle
    setTimeout(() => {
      didDragRef.current = false;
    }, 50);
  };

  // City selection & drag handlers
  const handleSelectCity = useCallback((city: PositionedCity) => {
    setSelectedCityId(city.city.repository_id);
  }, []);

  const isDragActive = useCallback(() => didDragRef.current, []);

  // Background SVG click handler (deselects if click was on empty SVG canvas)
  const handleSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    if (didDragRef.current) return;
    const target = e.target as Element | null;
    const isCity = target?.closest('[data-testid^="city-node-"]');
    if (!isCity) {
      setSelectedCityId(null);
    }
  };

  // Keyboard Escape listener: closes inspector
  useEffect(() => {
    if (!selectedCityId) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        setSelectedCityId(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [selectedCityId]);

  // Zoom controls (+, -, reset)
  const handleZoomCenter = (factor: number) => {
    if (!containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const cx = rect.width / 2;
    const cy = rect.height / 2;

    setZoom((prevZoom) => {
      const nextZoom = Math.min(maxZoom, Math.max(minZoom, prevZoom * factor));
      if (nextZoom === prevZoom) return prevZoom;

      setPan((prevPan) => {
        const nextPanX = cx - (cx - prevPan.x) * (nextZoom / prevZoom);
        const nextPanY = cy - (cy - prevPan.y) * (nextZoom / prevZoom);
        return { x: nextPanX, y: nextPanY };
      });

      hasUserInteractedRef.current = true;
      return nextZoom;
    });
  };

  const handleResetView = () => {
    hasUserInteractedRef.current = false;
    applyFit(true);
  };

  // Static scene memoization: rebuilds only when layout or city click handler changes
  const sceneMarkup = useMemo(() => {
    return (
      <>
        {/* 1. Continents Layer */}
        <g className="continents-layer">
          {layout.continents.map((continent) => {
            const theme = getEcosystemTheme(continent.ecosystem);
            return (
              <g key={continent.ecosystem} className="continent-plate">
                <circle
                  cx={continent.x}
                  cy={continent.y}
                  r={continent.radius}
                  fill={theme.plateFill}
                  stroke={theme.plateStroke}
                  strokeWidth={1.5}
                  strokeDasharray="6 4"
                  className="pointer-events-none"
                />
                <text
                  x={continent.x}
                  y={continent.y - continent.radius + 24}
                  textAnchor="middle"
                  fill={theme.plateLabel}
                  fontSize={14}
                  fontWeight="bold"
                  fontFamily="sans-serif"
                  letterSpacing="0.05em"
                  className="select-none pointer-events-none uppercase"
                >
                  {continent.displayName}
                </text>
              </g>
            );
          })}
        </g>

        {/* 2. Countries Layer */}
        <g className="countries-layer">
          {layout.continents.flatMap((continent) =>
            continent.countries.map((country) => {
              const theme = getEcosystemTheme(continent.ecosystem);
              return (
                <circle
                  key={`${country.ecosystem}:${country.owner}`}
                  cx={country.x}
                  cy={country.y}
                  r={country.radius}
                  fill={theme.countryFill}
                  stroke={theme.countryStroke}
                  strokeWidth={1}
                  className="pointer-events-none"
                />
              );
            })
          )}
        </g>

        {/* 3. Cities Layer */}
        <g className="cities-layer">
          {layout.cities.map((posCity) => {
            const theme = getEcosystemTheme(posCity.ecosystem);
            const isSelected = posCity.city.repository_id === selectedCityId;
            return (
              <CityNode
                key={posCity.city.repository_id}
                city={posCity}
                theme={theme}
                isSelected={isSelected}
                onSelect={handleSelectCity}
                isDragActive={isDragActive}
              />
            );
          })}
        </g>
      </>
    );
  }, [layout, selectedCityId, handleSelectCity, isDragActive]);

  return (
    <div
      ref={containerRef}
      className="relative w-full h-[620px] rounded-2xl border border-neutral-800 bg-[#070b14] overflow-hidden select-none"
    >
      {/* SVG Canvas */}
      <svg
        data-testid="world-map-svg"
        width="100%"
        height="100%"
        onClick={handleSvgClick}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
        className="w-full h-full cursor-grab active:cursor-grabbing overflow-hidden"
      >
        <g
          data-testid="world-camera-group"
          transform={`translate(${pan.x}, ${pan.y}) scale(${zoom})`}
        >
          {sceneMarkup}
        </g>
      </svg>

      {/* Floating Viewport Controls: top-right on mobile, bottom-right on desktop */}
      <div className="absolute top-4 right-4 md:top-auto md:bottom-4 md:right-4 z-10 flex items-center gap-1.5 rounded-xl border border-neutral-800/80 bg-neutral-900/90 p-1.5 backdrop-blur-md shadow-lg">
        <button
          type="button"
          data-testid="zoom-in-btn"
          onClick={() => handleZoomCenter(1.25)}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-300 hover:bg-neutral-800 hover:text-white transition-colors cursor-pointer text-base font-mono"
          title="Zoom In"
        >
          +
        </button>
        <button
          type="button"
          data-testid="zoom-out-btn"
          onClick={() => handleZoomCenter(0.8)}
          className="flex h-8 w-8 items-center justify-center rounded-lg text-neutral-300 hover:bg-neutral-800 hover:text-white transition-colors cursor-pointer text-base font-mono"
          title="Zoom Out"
        >
          &minus;
        </button>
        <div className="h-4 w-px bg-neutral-800 my-auto" />
        <button
          type="button"
          data-testid="reset-view-btn"
          onClick={handleResetView}
          className="flex h-8 px-2.5 items-center justify-center rounded-lg text-xs font-mono text-neutral-400 hover:bg-neutral-800 hover:text-white transition-colors cursor-pointer"
          title="Reset View"
        >
          Reset
        </button>
      </div>

      {/* City count & status tag */}
      <div className="absolute top-4 left-4 z-10 flex items-center gap-2 rounded-xl border border-neutral-800/80 bg-neutral-900/80 px-3 py-1.5 backdrop-blur-md">
        <span className="h-2 w-2 rounded-full bg-emerald-400" />
        <span className="text-xs font-mono text-neutral-300">
          {layout.totalCities} {layout.totalCities === 1 ? "Repository" : "Repositories"}
        </span>
        <span className="text-neutral-600">&bull;</span>
        <span className="text-xs font-mono text-neutral-400">
          {layout.continents.length} {layout.continents.length === 1 ? "Ecosystem" : "Ecosystems"}
        </span>
      </div>

      {/* Inspector Panel */}
      {selectedCity && (
        <WorldInspector
          city={selectedCity}
          onClose={() => setSelectedCityId(null)}
        />
      )}
    </div>
  );
}
