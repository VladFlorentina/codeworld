import {
  EcosystemKey,
  LayoutContinent,
  LayoutCountry,
  PositionedCity,
  WorldBounds,
  WorldCityDTO,
  WorldLayout,
} from "@/types/world";
import {
  CANONICAL_ECOSYSTEM_ORDER,
  getEcosystem,
  getEcosystemDisplayName,
} from "./ecosystems";

export const LAYOUT_CONSTANTS = {
  // City geometry
  CITY_MIN_RADIUS: 12,
  CITY_MAX_RADIUS: 36,
  CITY_BASE_RADIUS: 12,
  CITY_SCALE_FACTOR: 7.5,
  CITY_GAP: 16,

  // Country geometry
  COUNTRY_PADDING: 24,
  COUNTRY_GAP: 36,

  // Continent geometry
  CONTINENT_PADDING: 48,
  CONTINENT_GAP: 80,
} as const;

/**
 * Ordinal string comparator independent of system locale.
 */
export function compareText(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * Calculates deterministic city radius from total_files.
 * Formula: clamp(12, 36, 12 + 7.5 * log10(total_files + 1))
 */
export function calculateCityRadius(totalFiles: number): number {
  const safeFiles = Math.max(0, totalFiles);
  const rawRadius =
    LAYOUT_CONSTANTS.CITY_BASE_RADIUS +
    LAYOUT_CONSTANTS.CITY_SCALE_FACTOR * Math.log10(safeFiles + 1);
  const clamped = Math.max(
    LAYOUT_CONSTANTS.CITY_MIN_RADIUS,
    Math.min(LAYOUT_CONSTANTS.CITY_MAX_RADIUS, rawRadius)
  );
  return Math.round(clamped * 100) / 100;
}

interface LocalDiskPlacement<T> {
  item: T;
  localX: number;
  localY: number;
  radius: number;
}

interface PackedDiskResult<T> {
  placements: LocalDiskPlacement<T>[];
  boundingRadius: number;
}

/**
 * Concentric ring disk packing based on exact chord distance trigonometry.
 *
 * For child disks with maximum radius rMax and configured gap:
 *   requiredSpacing = 2 * rMax + gap
 *
 * For ring k with radius R_k = k * requiredSpacing:
 *   2 * R_k * sin(pi / M_k) >= requiredSpacing
 *   M_k = floor(pi / asin(requiredSpacing / (2 * R_k)))
 *
 * Mathematically guarantees that for any two packed children i != j:
 *   centerDistance(i, j) >= requiredSpacing >= r_i + r_j + gap
 */
function packDisksOnRings<T>(
  items: T[],
  getRadius: (item: T) => number,
  gap: number,
  padding: number
): PackedDiskResult<T> {
  if (items.length === 0) {
    return { placements: [], boundingRadius: 0 };
  }

  const radii = items.map(getRadius);
  const rMax = Math.max(...radii);
  const requiredSpacing = 2 * rMax + gap;

  if (items.length === 1) {
    return {
      placements: [
        {
          item: items[0],
          localX: 0,
          localY: 0,
          radius: radii[0],
        },
      ],
      boundingRadius: rMax + padding,
    };
  }

  const placements: LocalDiskPlacement<T>[] = [
    {
      item: items[0],
      localX: 0,
      localY: 0,
      radius: radii[0],
    },
  ];

  let placedCount = 1;
  let currentRing = 1;
  let outermostCenterDist = 0;

  while (placedCount < items.length) {
    const ringRadius = currentRing * requiredSpacing;
    const ratio = requiredSpacing / (2 * ringRadius); // exactly 1 / (2 * currentRing)

    // Exact max capacity on this ring: 2 * R * sin(pi / M) >= requiredSpacing
    const maxCapacity = Math.floor(Math.PI / Math.asin(ratio));
    const itemsOnThisRing = Math.min(items.length - placedCount, maxCapacity);

    outermostCenterDist = ringRadius;

    for (let j = 0; j < itemsOnThisRing; j++) {
      const angle = (2 * Math.PI * j) / itemsOnThisRing;
      const localX = ringRadius * Math.cos(angle);
      const localY = ringRadius * Math.sin(angle);

      placements.push({
        item: items[placedCount],
        localX,
        localY,
        radius: radii[placedCount],
      });
      placedCount++;
    }

    currentRing++;
  }

  const boundingRadius = outermostCenterDist + rMax + padding;

  return { placements, boundingRadius };
}

/**
 * Packs non-empty continents along a circular archipelago ring around world origin (0, 0).
 *
 * For K continents with maximum radius rMax:
 *   ringRadius = requiredSpacing / (2 * sin(pi / K))
 * ensuring distance between any two adjacent continent centers >= 2 * rMax + gap.
 */
function packContinentsOnWorld(
  continents: Array<{ ecosystem: EcosystemKey; radius: number }>,
  gap: number
): Map<EcosystemKey, { x: number; y: number }> {
  const result = new Map<EcosystemKey, { x: number; y: number }>();
  if (continents.length === 0) return result;

  if (continents.length === 1) {
    result.set(continents[0].ecosystem, { x: 0, y: 0 });
    return result;
  }

  const K = continents.length;
  const rMax = Math.max(...continents.map((c) => c.radius));
  const requiredSpacing = 2 * rMax + gap;

  const ringRadius = Math.max(
    requiredSpacing,
    requiredSpacing / (2 * Math.sin(Math.PI / K))
  );

  continents.forEach((cont, idx) => {
    const angle = -Math.PI / 4 + (2 * Math.PI * idx) / K;
    const x = ringRadius * Math.cos(angle);
    const y = ringRadius * Math.sin(angle);
    result.set(cont.ecosystem, { x, y });
  });

  return result;
}

interface CountryDraft {
  owner: string;
  ecosystem: EcosystemKey;
  radius: number;
  cityPlacements: LocalDiskPlacement<WorldCityDTO>[];
}

interface ContinentDraft {
  ecosystem: EcosystemKey;
  displayName: string;
  radius: number;
  countryPlacements: LocalDiskPlacement<CountryDraft>[];
}

/**
 * Builds a packed Country draft with locally placed cities.
 */
function buildCountryDraft(
  owner: string,
  cities: WorldCityDTO[],
  ecosystem: EcosystemKey
): CountryDraft {
  // Stable ordinal sort by repository_id
  const sortedCities = [...cities].sort((a, b) =>
    compareText(a.repository_id, b.repository_id)
  );

  const packed = packDisksOnRings(
    sortedCities,
    (c) => calculateCityRadius(c.total_files),
    LAYOUT_CONSTANTS.CITY_GAP,
    LAYOUT_CONSTANTS.COUNTRY_PADDING
  );

  return {
    owner,
    ecosystem,
    radius: packed.boundingRadius,
    cityPlacements: packed.placements,
  };
}

/**
 * Builds a packed Continent draft with locally placed country drafts.
 */
function buildContinentDraft(
  ecosystem: EcosystemKey,
  countryDrafts: CountryDraft[]
): ContinentDraft {
  const packed = packDisksOnRings(
    countryDrafts,
    (c) => c.radius,
    LAYOUT_CONSTANTS.COUNTRY_GAP,
    LAYOUT_CONSTANTS.CONTINENT_PADDING
  );

  return {
    ecosystem,
    displayName: getEcosystemDisplayName(ecosystem),
    radius: packed.boundingRadius,
    countryPlacements: packed.placements,
  };
}

/**
 * Calculates world bounding box covering all continent disks.
 */
function calculateWorldBounds(continents: LayoutContinent[]): WorldBounds | null {
  if (continents.length === 0) return null;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;

  for (const cont of continents) {
    minX = Math.min(minX, cont.x - cont.radius);
    maxX = Math.max(maxX, cont.x + cont.radius);
    minY = Math.min(minY, cont.y - cont.radius);
    maxY = Math.max(maxY, cont.y + cont.radius);
  }

  if (!isFinite(minX) || !isFinite(maxX) || !isFinite(minY) || !isFinite(maxY)) {
    return null;
  }

  return {
    minX,
    maxX,
    minY,
    maxY,
    width: maxX - minX,
    height: maxY - minY,
  };
}

/**
 * Pure, deterministic layout function that transforms WorldCityDTO[] into WorldLayout.
 *
 * Guarantees:
 *   - 100% deterministic (ordinal sorting, immune to input order or system locale).
 *   - Mathematically guaranteed zero overlap between any two cities, countries, or continents.
 *   - Returns bounds: null for empty input.
 */
export function computeWorldLayout(cities: WorldCityDTO[]): WorldLayout {
  if (!cities || cities.length === 0) {
    return {
      continents: [],
      cities: [],
      totalCities: 0,
      bounds: null,
    };
  }

  // 1. Initial stable ordinal sort: owner -> name -> repository_id
  const sortedInput = [...cities].sort((a, b) => {
    const ownerCmp = compareText(a.owner, b.owner);
    if (ownerCmp !== 0) return ownerCmp;
    const nameCmp = compareText(a.name, b.name);
    if (nameCmp !== 0) return nameCmp;
    return compareText(a.repository_id, b.repository_id);
  });

  // 2. Classify and group into Ecosystem -> Owner -> City[]
  const ecosystemMap = new Map<EcosystemKey, Map<string, WorldCityDTO[]>>();

  for (const city of sortedInput) {
    const eco = getEcosystem(city.primary_language);
    if (!ecosystemMap.has(eco)) {
      ecosystemMap.set(eco, new Map<string, WorldCityDTO[]>());
    }
    const ownerMap = ecosystemMap.get(eco)!;
    if (!ownerMap.has(city.owner)) {
      ownerMap.set(city.owner, []);
    }
    ownerMap.get(city.owner)!.push(city);
  }

  // 3. Build drafts for active ecosystems in canonical order
  const continentDrafts: ContinentDraft[] = [];

  for (const eco of CANONICAL_ECOSYSTEM_ORDER) {
    if (!ecosystemMap.has(eco)) continue;
    const ownerMap = ecosystemMap.get(eco)!;

    // Stable ordinal sort of owners within ecosystem
    const sortedOwners = Array.from(ownerMap.keys()).sort(compareText);

    const countryDrafts: CountryDraft[] = sortedOwners.map((owner) =>
      buildCountryDraft(owner, ownerMap.get(owner)!, eco)
    );

    continentDrafts.push(buildContinentDraft(eco, countryDrafts));
  }

  // 4. Place Continents on World Map
  const continentPositions = packContinentsOnWorld(
    continentDrafts.map((c) => ({ ecosystem: c.ecosystem, radius: c.radius })),
    LAYOUT_CONSTANTS.CONTINENT_GAP
  );

  // 5. Assemble Hierarchical Layout and Absolute Coordinates
  const finalContinents: LayoutContinent[] = [];
  const allPositionedCities: PositionedCity[] = [];

  for (const cDraft of continentDrafts) {
    const contPos = continentPositions.get(cDraft.ecosystem) ?? { x: 0, y: 0 };
    const finalCountries: LayoutCountry[] = [];

    for (const countryPlacement of cDraft.countryPlacements) {
      const countryDraft = countryPlacement.item;
      const countryAbsX = contPos.x + countryPlacement.localX;
      const countryAbsY = contPos.y + countryPlacement.localY;

      const finalCountryCities: PositionedCity[] = [];

      for (const cityPlacement of countryDraft.cityPlacements) {
        const cityDTO = cityPlacement.item;
        const cityAbsX = countryAbsX + cityPlacement.localX;
        const cityAbsY = countryAbsY + cityPlacement.localY;

        const posCity: PositionedCity = {
          city: cityDTO,
          ecosystem: cDraft.ecosystem,
          x: cityAbsX,
          y: cityAbsY,
          radius: cityPlacement.radius,
        };

        finalCountryCities.push(posCity);
        allPositionedCities.push(posCity);
      }

      finalCountries.push({
        owner: countryDraft.owner,
        ecosystem: countryDraft.ecosystem,
        x: countryAbsX,
        y: countryAbsY,
        radius: countryDraft.radius,
        cities: finalCountryCities,
      });
    }

    finalContinents.push({
      ecosystem: cDraft.ecosystem,
      displayName: cDraft.displayName,
      x: contPos.x,
      y: contPos.y,
      radius: cDraft.radius,
      countries: finalCountries,
    });
  }

  return {
    continents: finalContinents,
    cities: allPositionedCities,
    totalCities: allPositionedCities.length,
    bounds: calculateWorldBounds(finalContinents),
  };
}
