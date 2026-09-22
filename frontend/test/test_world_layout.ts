import { WorldCityDTO } from "../src/types/world";
import { getEcosystem } from "../src/lib/ecosystems";
import {
  computeWorldLayout,
  calculateCityRadius,
  compareText,
  LAYOUT_CONSTANTS,
} from "../src/lib/worldLayout";

// Floating-point tolerance strictly for numeric noise with full precision coordinates
const EPSILON = 1e-7;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

function euclideanDistance(
  p1: { x: number; y: number },
  p2: { x: number; y: number }
): number {
  const dx = p1.x - p2.x;
  const dy = p1.y - p2.y;
  return Math.sqrt(dx * dx + dy * dy);
}

// Real data from WM1 explore/world endpoint
const REAL_WM1_CITIES: WorldCityDTO[] = [
  {
    repository_id: "d2ec51fe-6e43-4c27-816e-37a07f18d85f",
    owner: "VladFlorentina",
    name: "codeworld",
    full_name: "VladFlorentina/codeworld",
    description: null,
    primary_language: "Python",
    total_files: 111,
    total_loc: 17368,
    complexity: 1171,
    commit_sha: "6f4b9171244cf0618ba7caaf79ab4c303542867c",
    analyzed_at: "2026-09-22T12:11:11.843381Z",
  },
  {
    repository_id: "2e945127-9c5d-4b5a-a0d9-9d52e2cbadfe",
    owner: "encode",
    name: "starlette",
    full_name: "encode/starlette",
    description: null,
    primary_language: "Python",
    total_files: 132,
    total_loc: 21991,
    complexity: 1549,
    commit_sha: "57de5fa9c2a98089a78d32d560e9b23e62560d5f",
    analyzed_at: "2026-09-21T16:49:34.022358Z",
  },
  {
    repository_id: "4b50f50c-15ed-46ff-8063-cb86ae0df251",
    owner: "pallets",
    name: "click",
    full_name: "pallets/click",
    description: null,
    primary_language: "Python",
    total_files: 161,
    total_loc: 30733,
    complexity: 2021,
    commit_sha: "6aabf099bfdd4c1e75fe8d0e0d4241372b988ab1",
    analyzed_at: "2026-09-21T18:16:07.715982Z",
  },
  {
    repository_id: "9ca0ba88-7ab2-45e4-b92e-26dcf16ef8ac",
    owner: "tiangolo",
    name: "fastapi",
    full_name: "tiangolo/fastapi",
    description: null,
    primary_language: "Python",
    total_files: 2867,
    total_loc: 248304,
    complexity: 3237,
    commit_sha: "50113da16fec53b66b80d75e80a89296de4fa5a5",
    analyzed_at: "2026-09-21T16:49:21.951741Z",
  },
];

function generateSyntheticCities(count: number): WorldCityDTO[] {
  const languages = [
    "Python",
    "TypeScript",
    "JavaScript",
    "Rust",
    "Go",
    "Java",
    "C++",
    "Ruby",
    "HTML",
    "Unknown",
  ];
  const owners = [
    "org-alpha",
    "org-beta",
    "org-gamma",
    "org-delta",
    "dev-vlad",
    "dev-alex",
    "corp-one",
    "corp-two",
  ];

  const cities: WorldCityDTO[] = [];
  for (let i = 0; i < count; i++) {
    const owner = owners[i % owners.length];
    const lang = languages[i % languages.length];
    const files = ((i * 137) % 5000) + 1;
    cities.push({
      repository_id: `synth-repo-${String(i).padStart(4, "0")}`,
      owner,
      name: `repo-${i}`,
      full_name: `${owner}/repo-${i}`,
      description: `Synthetic repo ${i}`,
      primary_language: lang,
      total_files: files,
      total_loc: files * 50,
      complexity: Math.floor(files * 1.5),
      commit_sha: "0123456789abcdef0123456789abcdef01234567",
      analyzed_at: "2026-09-22T00:00:00Z",
    });
  }
  return cities;
}

function verifyNoCollisions(layout: ReturnType<typeof computeWorldLayout>) {
  // 1. Check city collisions with full CITY_GAP
  const cities = layout.cities;
  for (let i = 0; i < cities.length; i++) {
    for (let j = i + 1; j < cities.length; j++) {
      const c1 = cities[i];
      const c2 = cities[j];
      const dist = euclideanDistance(c1, c2);
      const minRequired = c1.radius + c2.radius + LAYOUT_CONSTANTS.CITY_GAP;
      assert(
        dist + EPSILON >= minRequired,
        `City collision detected between ${c1.city.full_name} (${c1.x}, ${c1.y}, r=${c1.radius}) and ${c2.city.full_name} (${c2.x}, ${c2.y}, r=${c2.radius}): distance ${dist.toFixed(2)} < required ${minRequired.toFixed(2)}`
      );
    }
  }

  // 2. Check country collisions within each continent with full COUNTRY_GAP
  for (const cont of layout.continents) {
    const countries = cont.countries;
    for (let i = 0; i < countries.length; i++) {
      for (let j = i + 1; j < countries.length; j++) {
        const k1 = countries[i];
        const k2 = countries[j];
        const dist = euclideanDistance(k1, k2);
        const minRequired = k1.radius + k2.radius + LAYOUT_CONSTANTS.COUNTRY_GAP;
        assert(
          dist + EPSILON >= minRequired,
          `Country collision in continent ${cont.ecosystem} between ${k1.owner} and ${k2.owner}: distance ${dist.toFixed(2)} < required ${minRequired.toFixed(2)}`
        );
      }
    }
  }

  // 3. Check continent collisions with full CONTINENT_GAP
  const continents = layout.continents;
  for (let i = 0; i < continents.length; i++) {
    for (let j = i + 1; j < continents.length; j++) {
      const e1 = continents[i];
      const e2 = continents[j];
      const dist = euclideanDistance(e1, e2);
      const minRequired = e1.radius + e2.radius + LAYOUT_CONSTANTS.CONTINENT_GAP;
      assert(
        dist + EPSILON >= minRequired,
        `Continent collision between ${e1.ecosystem} and ${e2.ecosystem}: distance ${dist.toFixed(2)} < required ${minRequired.toFixed(2)}`
      );
    }
  }
}

async function runWorldLayoutTests() {
  console.log("==================================================================");
  console.log("  CHECKPOINT WM2: DETERMINISTIC WORLD LAYOUT & ECOSYSTEM TESTS   ");
  console.log("==================================================================");

  // -------------------------------------------------------------
  // Test 1: Empty input -> bounds: null, 0 cities, 0 continents
  // -------------------------------------------------------------
  console.log("\n[Test 1] Empty input -> bounds: null");
  const emptyLayout = computeWorldLayout([]);
  assert(emptyLayout.totalCities === 0, "Expected 0 totalCities");
  assert(emptyLayout.cities.length === 0, "Expected 0 cities array");
  assert(emptyLayout.continents.length === 0, "Expected 0 continents");
  assert(emptyLayout.bounds === null, "Expected bounds to be null for empty input");
  console.log("✓ Empty input handled cleanly with null bounds.");

  // -------------------------------------------------------------
  // Test 2: Single city layout
  // -------------------------------------------------------------
  console.log("\n[Test 2] Single city layout");
  const singleLayout = computeWorldLayout([REAL_WM1_CITIES[0]]);
  assert(singleLayout.totalCities === 1, "Expected 1 totalCities");
  assert(singleLayout.continents.length === 1, "Expected 1 continent");
  assert(singleLayout.continents[0].countries.length === 1, "Expected 1 country");
  assert(singleLayout.bounds !== null, "Expected bounds not null");
  assert(singleLayout.cities[0].x === 0 && singleLayout.cities[0].y === 0, "Single city should be at (0, 0)");
  console.log("✓ Single city positioned at origin with valid single continent/country.");

  // -------------------------------------------------------------
  // Test 3: Same input -> Identical layout output (ordinal determinism)
  // -------------------------------------------------------------
  console.log("\n[Test 3] Same input -> Identical layout output");
  const layoutA = computeWorldLayout(REAL_WM1_CITIES);
  const layoutB = computeWorldLayout(REAL_WM1_CITIES);
  assert(JSON.stringify(layoutA) === JSON.stringify(layoutB), "Repeated call produced different layout");
  console.log("✓ Identical input produces identical coordinates and bounds.");

  // -------------------------------------------------------------
  // Test 4: Shuffled input -> Identical layout output
  // -------------------------------------------------------------
  console.log("\n[Test 4] Shuffled input -> Identical layout output");
  const shuffled = [
    REAL_WM1_CITIES[2],
    REAL_WM1_CITIES[0],
    REAL_WM1_CITIES[3],
    REAL_WM1_CITIES[1],
  ];
  const layoutShuffled = computeWorldLayout(shuffled);
  assert(
    JSON.stringify(layoutA) === JSON.stringify(layoutShuffled),
    "Shuffled input produced different layout from original"
  );
  console.log("✓ Shuffled input produces 100% identical layout.");

  // -------------------------------------------------------------
  // Test 5: Radius min/max clamping and logarithmic scaling
  // -------------------------------------------------------------
  console.log("\n[Test 5] City radius calculation & bounds");
  assert(calculateCityRadius(0) === 12, "0 files must equal minimum radius 12");
  assert(calculateCityRadius(1) === 14.26, "1 file radius check");
  assert(calculateCityRadius(100) === 27.03, "100 files radius check");
  assert(calculateCityRadius(2867) === 36, "FastAPI (2867 files) must clamp to maximum radius 36");
  assert(calculateCityRadius(100000) === 36, "Extreme file count must clamp to 36");
  console.log("✓ City radius formula correctly scales and clamps between [12, 36].");

  // -------------------------------------------------------------
  // Test 6: Ecosystem classification & Unknown -> Frontier
  // -------------------------------------------------------------
  console.log("\n[Test 6] Ecosystem classification & frontier fallback");
  assert(getEcosystem("Python") === "python", "Python mapping");
  assert(getEcosystem("TypeScript") === "web", "TypeScript mapping");
  assert(getEcosystem("JavaScript") === "web", "JavaScript mapping");
  assert(getEcosystem("HTML") === "web", "HTML mapping");
  assert(getEcosystem("CSS") === "web", "CSS mapping");
  assert(getEcosystem("Rust") === "rust", "Rust mapping");
  assert(getEcosystem("Go") === "go", "Go mapping");
  assert(getEcosystem("Java") === "jvm", "Java mapping");
  assert(getEcosystem("Kotlin") === "jvm", "Kotlin mapping");
  assert(getEcosystem("C") === "native", "C mapping");
  assert(getEcosystem("C++") === "native", "C++ mapping");
  assert(getEcosystem("C#") === "frontier", "C# mapping to frontier per spec");
  assert(getEcosystem("Unknown") === "frontier", "Unknown mapping to frontier");
  assert(getEcosystem("") === "frontier", "Empty string mapping to frontier");
  assert(getEcosystem(null) === "frontier", "Null mapping to frontier");
  assert(getEcosystem("Brainfuck") === "frontier", "Unrecognized language mapping to frontier");
  console.log("✓ All languages mapped correctly with deterministic frontier fallback.");

  // -------------------------------------------------------------
  // Test 7: Owner with multiple repos in same ecosystem -> 1 country
  // -------------------------------------------------------------
  console.log("\n[Test 7] Owner with multiple repos in same ecosystem");
  const multiRepoSameOwner: WorldCityDTO[] = [
    {
      repository_id: "r1",
      owner: "pallets",
      name: "click",
      full_name: "pallets/click",
      description: null,
      primary_language: "Python",
      total_files: 100,
      total_loc: 1000,
      complexity: 50,
      commit_sha: "aaaa",
      analyzed_at: null,
    },
    {
      repository_id: "r2",
      owner: "pallets",
      name: "flask",
      full_name: "pallets/flask",
      description: null,
      primary_language: "Python",
      total_files: 200,
      total_loc: 2000,
      complexity: 100,
      commit_sha: "bbbb",
      analyzed_at: null,
    },
  ];
  const layoutSameOwner = computeWorldLayout(multiRepoSameOwner);
  assert(layoutSameOwner.continents.length === 1, "Expected 1 continent");
  assert(layoutSameOwner.continents[0].countries.length === 1, "Expected 1 country for owner pallets");
  assert(layoutSameOwner.continents[0].countries[0].cities.length === 2, "Expected 2 cities in country pallets");
  console.log("✓ Multiple repositories from same owner grouped into single country.");

  // -------------------------------------------------------------
  // Test 8: Owner split across multiple ecosystems
  // -------------------------------------------------------------
  console.log("\n[Test 8] Owner split across multiple ecosystems");
  const multiEcoOwner: WorldCityDTO[] = [
    {
      repository_id: "r-py",
      owner: "VladFlorentina",
      name: "backend-py",
      full_name: "VladFlorentina/backend-py",
      description: null,
      primary_language: "Python",
      total_files: 50,
      total_loc: 1000,
      complexity: 50,
      commit_sha: "1111",
      analyzed_at: null,
    },
    {
      repository_id: "r-ts",
      owner: "VladFlorentina",
      name: "frontend-ts",
      full_name: "VladFlorentina/frontend-ts",
      description: null,
      primary_language: "TypeScript",
      total_files: 80,
      total_loc: 2000,
      complexity: 70,
      commit_sha: "2222",
      analyzed_at: null,
    },
  ];
  const layoutMultiEco = computeWorldLayout(multiEcoOwner);
  assert(layoutMultiEco.continents.length === 2, "Expected 2 continents (Pythonia and Weboria)");
  const pyCont = layoutMultiEco.continents.find((c) => c.ecosystem === "python")!;
  const webCont = layoutMultiEco.continents.find((c) => c.ecosystem === "web")!;
  assert(Boolean(pyCont), "Python continent present");
  assert(Boolean(webCont), "Web continent present");
  assert(pyCont.countries.some((k) => k.owner === "VladFlorentina"), "VladFlorentina province in Pythonia");
  assert(webCont.countries.some((k) => k.owner === "VladFlorentina"), "VladFlorentina province in Weboria");
  console.log("✓ Multi-ecosystem owner cleanly partitioned into respective continents.");

  // -------------------------------------------------------------
  // Test 9: Zero Collision Verification on Real WM1 Data
  // -------------------------------------------------------------
  console.log("\n[Test 9] Geometric collision assertions on real WM1 data (with real configured gaps)");
  verifyNoCollisions(layoutA);
  console.log("✓ Real data: distance >= r1 + r2 + CITY_GAP verified for all city pairs.");

  // -------------------------------------------------------------
  // Test 10: Synthetic Scale Tests (20, 100, 500 cities)
  // -------------------------------------------------------------
  console.log("\n[Test 10] Synthetic scale tests & geometric spacing verification");

  for (const size of [20, 100, 500]) {
    const syntheticCities = generateSyntheticCities(size);
    const t0 = performance.now();
    const layout = computeWorldLayout(syntheticCities);
    const t1 = performance.now();
    const elapsed = Math.round((t1 - t0) * 100) / 100;

    assert(layout.totalCities === size, `Expected ${size} total cities, got ${layout.totalCities}`);
    assert(layout.cities.length === size, `Expected ${size} positioned cities`);
    assert(layout.bounds !== null, "Bounds must not be null");

    // Verify spacing across all cities, countries, continents with configured gaps
    verifyNoCollisions(layout);

    console.log(
      `✓ Scale test ${size} cities: ${layout.continents.length} continents, ${layout.cities.length} cities positioned in ${elapsed}ms with full gap compliance.`
    );
  }

  console.log("\n==================================================================");
  console.log("  ALL CHECKPOINT WM2 WORLD LAYOUT TESTS PASSED (10/10)!          ");
  console.log("==================================================================");
}

runWorldLayoutTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
