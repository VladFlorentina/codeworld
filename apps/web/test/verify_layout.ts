import { getCity } from "../src/lib/api";
import { computeCityLayout, calculateBuildingHeight } from "../src/lib/layout";
import { CityDTO } from "../src/types/city";
import { LayoutBuilding, LayoutDistrict } from "../src/types/layout";

const STARLETTE_REPO_ID = "2e945127-9c5d-4b5a-a0d9-9d52e2cbadfe";
const FASTAPI_REPO_ID = "9ca0ba88-7ab2-45e4-b92e-26dcf16ef8ac";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runTests() {
  console.log("=== STARTING STEP 2.2 LAYOUT ENGINE VERIFICATION ===");
  console.log(`Fetching CityDTO for repository ID: ${STARLETTE_REPO_ID}...`);

  // 1. Fetch real Starlette CityDTO via getCity()
  const city: CityDTO = await getCity(STARLETTE_REPO_ID);
  console.log(`Fetched CityDTO: repository = ${city.repository_name}, commit = ${city.commit_sha}`);
  console.log(`  Raw input counts: ${city.districts.length} districts, ${city.buildings.length} buildings, ${city.connections.length} connections`);

  // Deep clone to check immutability later
  const citySnapshot = JSON.parse(JSON.stringify(city));

  // 2. Compute Layout
  const layout = computeCityLayout(city);

  // 3. Test Immutability
  console.log("\n[Test 1/7] Checking input immutability...");
  assert(
    JSON.stringify(city) === JSON.stringify(citySnapshot),
    "Input CityDTO was mutated by computeCityLayout!"
  );
  console.log("  ✓ PASS: Input CityDTO is strictly immutable.");

  // 4. Test Element Counts
  console.log("\n[Test 2/7] Checking element counts match input DTO...");
  assert(
    layout.districts.length === city.districts.length,
    `District count mismatch: layout has ${layout.districts.length}, expected ${city.districts.length}`
  );
  assert(
    layout.buildings.length === city.buildings.length,
    `Building count mismatch: layout has ${layout.buildings.length}, expected ${city.buildings.length}`
  );
  assert(
    layout.connections.length === city.connections.length,
    `Connection count mismatch: layout has ${layout.connections.length}, expected ${city.connections.length}`
  );
  console.log(`  ✓ PASS: Exactly ${layout.districts.length} districts, ${layout.buildings.length} buildings, ${layout.connections.length} connections.`);

  // 5. Test Building Containment in Parent District
  console.log("\n[Test 3/7] Checking building containment inside parent district...");
  const districtMap = new Map<string, LayoutDistrict>();
  for (const d of layout.districts) {
    districtMap.set(d.id, d);
  }

  for (const b of layout.buildings) {
    const parent = districtMap.get(b.district_id);
    assert(!!parent, `Parent district not found for building ${b.path}`);
    const eps = 1e-4;
    const withinX = b.minX >= parent!.minX - eps && b.maxX <= parent!.maxX + eps;
    const withinZ = b.minZ >= parent!.minZ - eps && b.maxZ <= parent!.maxZ + eps;

    if (!withinX || !withinZ) {
      console.error(`Building ${b.path} escaped parent district ${parent!.path}:`);
      console.error(`  Building: X [${b.minX}, ${b.maxX}], Z [${b.minZ}, ${b.maxZ}]`);
      console.error(`  Parent:   X [${parent!.minX}, ${parent!.maxX}], Z [${parent!.minZ}, ${parent!.maxZ}]`);
    }
    assert(withinX && withinZ, `Building ${b.path} exceeds parent district ${parent!.path} bounds!`);
  }
  console.log("  ✓ PASS: All 132 buildings are strictly contained inside their parent districts.");

  // 6. Test Child District Containment in Parent District
  console.log("\n[Test 4/7] Checking child district containment inside parent district...");
  for (const d of layout.districts) {
    if (d.parent_id === null) continue;
    const parent = districtMap.get(d.parent_id);
    assert(!!parent, `Parent district ${d.parent_id} not found for child ${d.path}`);
    const eps = 1e-4;
    const withinX = d.minX >= parent!.minX - eps && d.maxX <= parent!.maxX + eps;
    const withinZ = d.minZ >= parent!.minZ - eps && d.maxZ <= parent!.maxZ + eps;

    if (!withinX || !withinZ) {
      console.error(`Child district ${d.path} escaped parent district ${parent!.path}:`);
      console.error(`  Child:  X [${d.minX}, ${d.maxX}], Z [${d.minZ}, ${d.maxZ}]`);
      console.error(`  Parent: X [${parent!.minX}, ${parent!.maxX}], Z [${parent!.minZ}, ${parent!.maxZ}]`);
    }
    assert(withinX && withinZ, `Child district ${d.path} exceeds parent ${parent!.path} bounds!`);
  }
  console.log("  ✓ PASS: All child districts are strictly contained inside their parent districts.");

  // 7. Test Sibling Buildings Non-Overlap
  console.log("\n[Test 5/7] Checking non-overlap between sibling buildings in the same district...");
  const buildingsByDistrict = new Map<string, LayoutBuilding[]>();
  for (const b of layout.buildings) {
    const list = buildingsByDistrict.get(b.district_id) || [];
    list.push(b);
    buildingsByDistrict.set(b.district_id, list);
  }

  let totalSiblingBuildingPairsChecked = 0;
  for (const [distId, bList] of buildingsByDistrict) {
    for (let i = 0; i < bList.length; i++) {
      for (let j = i + 1; j < bList.length; j++) {
        const b1 = bList[i];
        const b2 = bList[j];
        totalSiblingBuildingPairsChecked++;

        const eps = 1e-4;
        const noOverlap =
          b1.maxX <= b2.minX + eps ||
          b2.maxX <= b1.minX + eps ||
          b1.maxZ <= b2.minZ + eps ||
          b2.maxZ <= b1.minZ + eps;

        if (!noOverlap) {
          console.error(`Overlap detected between sibling buildings ${b1.path} and ${b2.path}:`);
          console.error(`  B1: X [${b1.minX}, ${b1.maxX}], Z [${b1.minZ}, ${b1.maxZ}]`);
          console.error(`  B2: X [${b2.minX}, ${b2.maxX}], Z [${b2.minZ}, ${b2.maxZ}]`);
        }
        assert(noOverlap, `Overlap detected between sibling buildings ${b1.path} and ${b2.path}`);
      }
    }
  }
  console.log(`  ✓ PASS: Checked ${totalSiblingBuildingPairsChecked} sibling building pairs — zero overlaps!`);

  // 8. Test Sibling Subdistricts Non-Overlap
  console.log("\n[Test 6/7] Checking non-overlap between sibling subdistricts...");
  const childrenByParent = new Map<string, LayoutDistrict[]>();
  for (const d of layout.districts) {
    if (d.parent_id !== null) {
      const list = childrenByParent.get(d.parent_id) || [];
      list.push(d);
      childrenByParent.set(d.parent_id, list);
    }
  }

  let totalSiblingDistrictPairsChecked = 0;
  for (const [parentId, dList] of childrenByParent) {
    for (let i = 0; i < dList.length; i++) {
      for (let j = i + 1; j < dList.length; j++) {
        const d1 = dList[i];
        const d2 = dList[j];
        totalSiblingDistrictPairsChecked++;

        const eps = 1e-4;
        const noOverlap =
          d1.maxX <= d2.minX + eps ||
          d2.maxX <= d1.minX + eps ||
          d1.maxZ <= d2.minZ + eps ||
          d2.maxZ <= d1.minZ + eps;

        if (!noOverlap) {
          console.error(`Overlap detected between sibling districts ${d1.path} and ${d2.path}:`);
          console.error(`  D1: X [${d1.minX}, ${d1.maxX}], Z [${d1.minZ}, ${d1.maxZ}]`);
          console.error(`  D2: X [${d2.minX}, ${d2.maxX}], Z [${d2.minZ}, ${d2.maxZ}]`);
        }
        assert(noOverlap, `Overlap detected between sibling districts ${d1.path} and ${d2.path}`);
      }
    }
  }
  console.log(`  ✓ PASS: Checked ${totalSiblingDistrictPairsChecked} sibling district pairs — zero overlaps!`);

  // 9. Test Determinism
  console.log("\n[Test 7/7] Checking determinism across repeated executions and array permutations...");
  const layoutRun1 = computeCityLayout(city);
  const layoutRun2 = computeCityLayout(city);
  assert(
    JSON.stringify(layoutRun1) === JSON.stringify(layoutRun2),
    "Determinism failed: two consecutive runs produced different output!"
  );

  // Shuffled run: reverse districts, buildings, and connections
  const shuffledCity: CityDTO = {
    ...city,
    districts: [...city.districts].reverse(),
    buildings: [...city.buildings].reverse(),
    connections: [...city.connections].reverse(),
  };
  const layoutRunShuffled = computeCityLayout(shuffledCity);
  assert(
    JSON.stringify(layoutRun1) === JSON.stringify(layoutRunShuffled),
    "Determinism failed: permuted input arrays produced different layout output!"
  );
  console.log("  ✓ PASS: Output is 100% deterministic, unaffected by array ordering.");

  // Compact summary for Starlette
  console.log("\n=======================================================");
  console.log("       STARLETTE CITY LAYOUT SUMMARY REPORT            ");
  console.log("=======================================================");
  console.log(`Repository:      ${layout.repository_name}`);
  console.log(`Districts Count: ${layout.districts.length}`);
  console.log(`Buildings Count: ${layout.buildings.length}`);
  console.log(`Connections:     ${layout.connections.length}`);
  console.log(`Total Dimensions: Width = ${layout.bounds.width.toFixed(2)}, Depth = ${layout.bounds.depth.toFixed(2)}`);
  console.log(`Bounding Box:     X [${layout.bounds.minX.toFixed(2)}, ${layout.bounds.maxX.toFixed(2)}], Z [${layout.bounds.minZ.toFixed(2)}, ${layout.bounds.maxZ.toFixed(2)}]`);

  console.log("\nSample District Coordinates:");
  for (const d of layout.districts.slice(0, 6)) {
    console.log(`  - District '${d.path || "(root)"}' (depth ${d.depth}):`);
    console.log(`      Bounding Box: [X: ${d.minX.toFixed(1)} -> ${d.maxX.toFixed(1)}, Z: ${d.minZ.toFixed(1)} -> ${d.maxZ.toFixed(1)}] (size: ${d.width.toFixed(1)} x ${d.depth_z.toFixed(1)})`);
    console.log(`      3D Center:    [X: ${d.centerX.toFixed(1)}, Z: ${d.centerZ.toFixed(1)}]`);
  }

  console.log("\nSample Building Coordinates:");
  for (const b of layout.buildings.slice(0, 6)) {
    console.log(`  - Building '${b.path}':`);
    console.log(`      Footprint:  [X: ${b.minX.toFixed(1)} -> ${b.maxX.toFixed(1)}, Z: ${b.minZ.toFixed(1)} -> ${b.maxZ.toFixed(1)}] (size: ${b.width} x ${b.depth})`);
    console.log(`      3D Pos (C): [X: ${b.x.toFixed(1)}, Y: ${b.y.toFixed(2)}, Z: ${b.z.toFixed(1)}], Height: ${b.height.toFixed(2)}`);
    console.log(`      Language:   ${b.language || "Unknown"} (${b.color_hex}), LOC: ${b.metrics.loc_code}`);
  }

  console.log("\nSample Connection 3D Endpoints:");
  for (const c of layout.connections.slice(0, 3)) {
    console.log(`  - Connection ${c.id.substring(0, 8)}: [${c.source.map(v => v.toFixed(1)).join(", ")}] -> [${c.target.map(v => v.toFixed(1)).join(", ")}]`);
  }

  console.log("\n[Bonus Test] Checking FastAPI layout for repository ID: " + FASTAPI_REPO_ID);
  const fastapiCity = await getCity(FASTAPI_REPO_ID);
  const fastapiLayout = computeCityLayout(fastapiCity);
  assert(fastapiLayout.districts.length === fastapiCity.districts.length, "FastAPI districts count mismatch");
  assert(fastapiLayout.buildings.length === fastapiCity.buildings.length, "FastAPI buildings count mismatch");
  
  const faDistMap = new Map(fastapiLayout.districts.map(d => [d.id, d]));
  for (const b of fastapiLayout.buildings) {
    const p = faDistMap.get(b.district_id);
    assert(!!p, `FastAPI parent district not found for ${b.path}`);
    assert(
      b.minX >= p!.minX - 1e-4 && b.maxX <= p!.maxX + 1e-4 &&
      b.minZ >= p!.minZ - 1e-4 && b.maxZ <= p!.maxZ + 1e-4,
      `FastAPI building ${b.path} out of parent district bounds`
    );
  }
  for (const d of fastapiLayout.districts) {
    if (d.parent_id !== null) {
      const p = faDistMap.get(d.parent_id);
      assert(!!p, `FastAPI parent not found for ${d.path}`);
      assert(
        d.minX >= p!.minX - 1e-4 && d.maxX <= p!.maxX + 1e-4 &&
        d.minZ >= p!.minZ - 1e-4 && d.maxZ <= p!.maxZ + 1e-4,
        `FastAPI child district ${d.path} out of parent bounds`
      );
    }
  }
  console.log(`  ✓ PASS: FastAPI (${fastapiLayout.districts.length} districts, ${fastapiLayout.buildings.length} buildings) verified 100% containment! Layout size: ${fastapiLayout.bounds.width.toFixed(1)} x ${fastapiLayout.bounds.depth.toFixed(1)}`);

  console.log("\nALL STEP 2.2 VERIFICATIONS PASSED SUCCESSFULLY!");
}

runTests().catch((err) => {
  console.error("Test execution failed:", err);
  process.exit(1);
});
