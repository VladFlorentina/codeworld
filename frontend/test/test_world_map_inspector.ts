import { spawn } from "child_process";
import { waitFor } from "./helpers/waitFor";
import { WorldMapResponse } from "../src/types/world";

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9238;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

async function runWorldMapInspectorTests() {
  console.log("==================================================================");
  console.log("     WM4: WORLD MAP INSPECTOR & INTERACTIONS BROWSER TESTS       ");
  console.log("==================================================================");

  // 1. Fetch live payload directly to assert dynamic counts and metadata
  console.log("\n[Step 1] Fetching live backend payload from /api/v1/explore/world...");
  const exploreRes = await fetch("http://localhost:8000/api/v1/explore/world");
  assert(exploreRes.ok, `Failed to fetch explore/world: HTTP ${exploreRes.status}`);
  const worldData: WorldMapResponse = await exploreRes.json();
  console.log(`✓ Live explore world returned ${worldData.total_cities} cities.`);
  assert(worldData.cities.length >= 2, "Expected at least 2 cities in live backend payload for testing");

  // 2. Launch headless Edge instance
  console.log("\n[Step 2] Launching Edge browser on port " + PORT + "...");
  const edgeProc = spawn(EDGE_PATH, [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    "--window-size=1600,1000",
    "--no-first-run",
    "--no-default-browser-check",
    "http://localhost:3000/",
  ]);

  try {
    let versionData: any = null;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const res = await fetch(`http://localhost:${PORT}/json/version`);
        if (res.ok) {
          versionData = await res.json();
          break;
        }
      } catch {}
    }
    if (!versionData) throw new Error(`Could not connect to Edge on port ${PORT}`);

    const listRes = await fetch(`http://localhost:${PORT}/json/list`);
    const targets = await listRes.json();
    const pageTarget = targets.find((t: any) => t.type === "page");
    if (!pageTarget) throw new Error("No page target found");

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    let msgId = 1;
    function send(method: string, params: any = {}): Promise<any> {
      const id = msgId++;
      return new Promise<any>((resolve) => {
        const handler = (event: MessageEvent) => {
          const data = JSON.parse(event.data);
          if (data.id === id) {
            ws.removeEventListener("message", handler);
            resolve(data.result);
          }
        };
        ws.addEventListener("message", handler);
        ws.send(JSON.stringify({ id, method, params }));
      });
    }

    const consoleErrors: string[] = [];
    ws.addEventListener("message", (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.method === "Runtime.consoleAPICalled" && data.params.type === "error") {
        const text = (data.params.args || []).map((a: any) => a.value || a.description || "").join(" ");
        consoleErrors.push(text);
      }
      if (data.method === "Runtime.exceptionThrown") {
        consoleErrors.push(data.params.exceptionDetails?.text || "");
      }
    });

    await send("Page.enable");
    await send("Runtime.enable");

    async function evalCode(expression: string): Promise<any> {
      const res = await send("Runtime.evaluate", {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (res?.exceptionDetails) {
        throw new Error(`Eval error: ${JSON.stringify(res.exceptionDetails)}`);
      }
      return res?.result?.value;
    }

    // Wait for World Map SVG to mount
    const hasSvg = await waitFor(async () => {
      return Boolean(await evalCode(`document.querySelector('[data-testid="world-map-svg"]') !== null`));
    }, 12000);
    assert(hasSvg, "world-map-svg must render on explore page");

    const targetCity1 = worldData.cities[0];
    const targetCity2 = worldData.cities[1];

    // -------------------------------------------------------------
    // Test 1: Initial state - Inspector is not visible
    // -------------------------------------------------------------
    console.log("\n[Test 1] Verifying initial state: inspector is not displayed...");
    const initialInspector = await evalCode(`document.querySelector('[data-testid="world-inspector"]') !== null`);
    assert(!initialInspector, "Inspector should NOT be displayed initially");
    console.log("✓ Inspector is cleanly closed on initial page load.");

    // -------------------------------------------------------------
    // Test 2: Normal click on city node selects city & opens Inspector without navigation
    // -------------------------------------------------------------
    console.log(`\n[Test 2] Clicking city node for '${targetCity1.full_name}'...`);
    const clickPos = await evalCode(`
      (() => {
        const node = document.querySelector('[data-testid="city-node-${targetCity1.repository_id}"]');
        node.scrollIntoView({ block: 'center' });
        const r = node.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()
    `);

    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: clickPos.x,
      y: clickPos.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: clickPos.x,
      y: clickPos.y,
      button: "left",
      buttons: 0,
    });

    const hasInspectorAfterClick = await waitFor(async () => {
      return Boolean(await evalCode(`document.querySelector('[data-testid="world-inspector"]') !== null`));
    }, 6000);
    assert(hasInspectorAfterClick, "Inspector must open upon clicking city node");

    const currentPath = await evalCode(`window.location.pathname`);
    assert(currentPath === "/", `Expected page path to remain '/', got '${currentPath}' (navigation must be prevented)`);
    console.log("✓ Normal click prevented page navigation and opened WorldInspector.");

    // -------------------------------------------------------------
    // Test 3: Inspector displays all required metadata
    // -------------------------------------------------------------
    console.log("\n[Test 3] Verifying inspector repository metadata...");
    const metadata = await evalCode(`
      (() => {
        return {
          title: document.querySelector('[data-testid="inspector-title"]')?.textContent?.trim(),
          fullName: document.querySelector('[data-testid="inspector-fullname"]')?.textContent?.trim(),
          owner: document.querySelector('[data-testid="inspector-owner"]')?.textContent?.trim(),
          ecosystem: document.querySelector('[data-testid="inspector-ecosystem"]')?.textContent?.trim(),
          language: document.querySelector('[data-testid="inspector-language"]')?.textContent?.trim(),
          description: document.querySelector('[data-testid="inspector-description"]')?.textContent?.trim(),
          files: document.querySelector('[data-testid="inspector-files"]')?.textContent?.trim(),
          loc: document.querySelector('[data-testid="inspector-loc"]')?.textContent?.trim(),
          complexity: document.querySelector('[data-testid="inspector-complexity"]')?.textContent?.trim(),
          commitSha: document.querySelector('[data-testid="inspector-commit-sha"]')?.textContent?.trim(),
          analyzedAt: document.querySelector('[data-testid="inspector-analyzed-at"]')?.textContent?.trim(),
        };
      })()
    `);

    assert(metadata.title === targetCity1.name, `Expected title '${targetCity1.name}', got '${metadata.title}'`);
    assert(metadata.fullName === targetCity1.full_name, `Expected full name '${targetCity1.full_name}', got '${metadata.fullName}'`);
    assert(metadata.owner === targetCity1.owner, `Expected owner '${targetCity1.owner}', got '${metadata.owner}'`);
    assert(Boolean(metadata.ecosystem), "Ecosystem badge must be displayed");
    assert(metadata.language === (targetCity1.primary_language || "Unknown"), `Expected language '${targetCity1.primary_language}', got '${metadata.language}'`);
    assert(Boolean(metadata.description), "Description must be displayed");
    assert(metadata.files === targetCity1.total_files.toLocaleString(), `Expected files '${targetCity1.total_files.toLocaleString()}', got '${metadata.files}'`);
    assert(metadata.loc === targetCity1.total_loc.toLocaleString(), `Expected LOC '${targetCity1.total_loc.toLocaleString()}', got '${metadata.loc}'`);
    assert(metadata.complexity === targetCity1.complexity.toLocaleString(), `Expected complexity '${targetCity1.complexity.toLocaleString()}', got '${metadata.complexity}'`);
    assert(metadata.commitSha === (targetCity1.commit_sha ? targetCity1.commit_sha.slice(0, 7) : "N/A"), "Short commit SHA must match");
    assert(Boolean(metadata.analyzedAt) && metadata.analyzedAt !== "N/A", `Expected formatted date, got '${metadata.analyzedAt}'`);
    console.log("✓ Inspector correctly displays complete repository metadata:", metadata);

    // -------------------------------------------------------------
    // Test 4: Visual highlight on selected city
    // -------------------------------------------------------------
    console.log("\n[Test 4] Verifying selected highlight ring on the active city...");
    const hasSelectedRing = await evalCode(
      `document.querySelector('[data-testid="city-selected-ring-${targetCity1.repository_id}"]') !== null`
    );
    assert(hasSelectedRing, "Selected city must display a highlight ring");

    const otherCityHasRing = await evalCode(
      `document.querySelector('[data-testid="city-selected-ring-${targetCity2.repository_id}"]') !== null`
    );
    assert(!otherCityHasRing, "Non-selected city must NOT have a highlight ring");
    console.log("✓ Selected city has distinct visual highlight ring; unselected city does not.");

    // -------------------------------------------------------------
    // Test 5: Drag-pan over city does NOT accidentally select or dismiss
    // -------------------------------------------------------------
    console.log("\n[Test 5] Simulating drag-pan over city node...");
    // First close the inspector to test drag from unselected state
    await evalCode(`document.querySelector('[data-testid="inspector-close-btn"]')?.click()`);
    await waitFor(async () => {
      return Boolean(await evalCode(`document.querySelector('[data-testid="world-inspector"]') === null`));
    }, 4000);

    const city2Pos = await evalCode(`
      (() => {
        const node = document.querySelector('[data-testid="city-node-${targetCity2.repository_id}"]');
        node.scrollIntoView({ block: 'center' });
        const r = node.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()
    `);

    // Perform drag gesture starting on city2
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: city2Pos.x,
      y: city2Pos.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: city2Pos.x + 70,
      y: city2Pos.y + 40,
      button: "left",
      buttons: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: city2Pos.x + 70,
      y: city2Pos.y + 40,
      button: "left",
      buttons: 0,
    });

    await new Promise((r) => setTimeout(r, 150));
    const inspectorAfterDrag = await evalCode(`document.querySelector('[data-testid="world-inspector"]') !== null`);
    assert(!inspectorAfterDrag, "Drag-pan across city node must NOT trigger selection or open inspector");
    console.log("✓ Drag-pan over city node did not cause accidental selection.");

    // -------------------------------------------------------------
    // Test 6: Close button dismisses inspector
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing Close button dismissal...");
    // Re-select city 1
    await evalCode(`document.querySelector('[data-testid="city-node-${targetCity1.repository_id}"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`);
    await waitFor(async () => {
      return Boolean(await evalCode(`document.querySelector('[data-testid="world-inspector"]') !== null`));
    }, 4000);

    await evalCode(`document.querySelector('[data-testid="inspector-close-btn"]')?.click()`);
    const inspectorClosedByBtn = await waitFor(async () => {
      return Boolean(await evalCode(`document.querySelector('[data-testid="world-inspector"]') === null`));
    }, 4000);
    assert(inspectorClosedByBtn, "Close button must dismiss the inspector");

    const ringCleared = await evalCode(
      `document.querySelector('[data-testid="city-selected-ring-${targetCity1.repository_id}"]') === null`
    );
    assert(ringCleared, "Highlight ring must be removed when inspector is closed");
    console.log("✓ Close button cleanly dismissed inspector and removed highlight ring.");

    // -------------------------------------------------------------
    // Test 7: Click on empty SVG background dismisses inspector
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing dismissal on SVG background click...");
    await evalCode(`document.querySelector('[data-testid="city-node-${targetCity1.repository_id}"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`);
    await waitFor(async () => {
      return Boolean(await evalCode(`document.querySelector('[data-testid="world-inspector"]') !== null`));
    }, 4000);

    // Click SVG top-left corner (empty background)
    const svgCorner = await evalCode(`
      (() => {
        const svg = document.querySelector('[data-testid="world-map-svg"]');
        const r = svg.getBoundingClientRect();
        return { x: Math.round(r.left + 15), y: Math.round(r.top + 15) };
      })()
    `);
    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: svgCorner.x,
      y: svgCorner.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: svgCorner.x,
      y: svgCorner.y,
      button: "left",
      buttons: 0,
    });

    const inspectorClosedByBg = await waitFor(async () => {
      return Boolean(await evalCode(`document.querySelector('[data-testid="world-inspector"]') === null`));
    }, 4000);
    assert(inspectorClosedByBg, "Clicking SVG background must dismiss inspector");
    console.log("✓ Empty SVG background click cleanly dismissed inspector.");

    // -------------------------------------------------------------
    // Test 8: Escape key dismisses inspector
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing Escape key dismissal...");
    await evalCode(`document.querySelector('[data-testid="city-node-${targetCity1.repository_id}"]')?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }))`);
    await waitFor(async () => {
      return Boolean(await evalCode(`document.querySelector('[data-testid="world-inspector"]') !== null`));
    }, 4000);

    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Escape",
      code: "Escape",
      windowsVirtualKeyCode: 27,
    });

    const inspectorClosedByEsc = await waitFor(async () => {
      return Boolean(await evalCode(`document.querySelector('[data-testid="world-inspector"]') === null`));
    }, 4000);
    assert(inspectorClosedByEsc, "Pressing Escape must dismiss inspector");
    console.log("✓ Escape key dismissed inspector cleanly.");

    // -------------------------------------------------------------
    // Test 9: Keyboard accessibility (Space & Enter selection)
    // -------------------------------------------------------------
    console.log("\n[Test 9] Testing keyboard selection via Space and Enter...");
    // Focus city2
    await evalCode(`document.querySelector('[data-testid="city-node-${targetCity2.repository_id}"]').focus()`);

    // Press Space
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: " ",
      code: "Space",
      windowsVirtualKeyCode: 32,
    });

    const openedBySpace = await waitFor(async () => {
      const title = await evalCode(`document.querySelector('[data-testid="inspector-title"]')?.textContent?.trim()`);
      return title === targetCity2.name;
    }, 5000);
    assert(openedBySpace, "Pressing Space on focused city node must select it and open inspector");
    console.log("✓ Space key on focused city node opened inspector for " + targetCity2.name);

    // Dismiss with Escape
    await send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    await waitFor(async () => Boolean(await evalCode(`document.querySelector('[data-testid="world-inspector"]') === null`)), 4000);

    // Focus city1 and press Enter
    await evalCode(`document.querySelector('[data-testid="city-node-${targetCity1.repository_id}"]').focus()`);
    await send("Input.dispatchKeyEvent", {
      type: "rawKeyDown",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });
    await send("Input.dispatchKeyEvent", {
      type: "keyUp",
      key: "Enter",
      code: "Enter",
      windowsVirtualKeyCode: 13,
    });

    const openedByEnter = await waitFor(async () => {
      const title = await evalCode(`document.querySelector('[data-testid="inspector-title"]')?.textContent?.trim()`);
      return title === targetCity1.name;
    }, 5000);
    assert(openedByEnter, "Pressing Enter on focused city node must select it and open inspector");
    console.log("✓ Enter key on focused city node opened inspector for " + targetCity1.name);

    // -------------------------------------------------------------
    // Test 10: Explicit responsive layout test at ~600px width
    // -------------------------------------------------------------
    console.log("\n[Test 10] Testing responsive layout at 600px width...");
    await send("Emulation.setDeviceMetricsOverride", {
      width: 600,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false,
    });

    await new Promise((r) => setTimeout(r, 300));

    const responsiveLayoutInfo = await evalCode(`
      (() => {
        const inspector = document.querySelector('[data-testid="world-inspector"]');
        const zoomIn = document.querySelector('[data-testid="zoom-in-btn"]');
        const container = inspector?.parentElement;
        const iRect = inspector?.getBoundingClientRect();
        const zRect = zoomIn?.getBoundingClientRect();
        const cRect = container?.getBoundingClientRect();

        return {
          hasInspector: !!inspector,
          hasZoom: !!zoomIn,
          // Inspector should be docked at the bottom of the container
          isDockedBottom: iRect && cRect && Math.abs(iRect.bottom - cRect.bottom) < 15,
          isFullWidth: iRect && cRect && iRect.width > cRect.width * 0.9,
          // Zoom controls must not be covered by inspector
          controlsAccessible: zRect && iRect && zRect.bottom < iRect.top,
          zTop: zRect?.top,
          iTop: iRect?.top,
        };
      })()
    `);

    assert(responsiveLayoutInfo.hasInspector, "Inspector must remain rendered at 600px width");
    assert(responsiveLayoutInfo.isDockedBottom, "Inspector must be docked at the bottom at 600px width");
    assert(responsiveLayoutInfo.isFullWidth, "Inspector must span full width at 600px width");
    assert(responsiveLayoutInfo.controlsAccessible, `Zoom controls must be placed above inspector without overlap (zBottom < iTop)`);
    console.log("✓ Responsive layout verified at 600px width: inspector docked bottom, zoom controls fully accessible.");

    // Test zoom control click at 600px
    const zoomTransformBefore = await evalCode(
      `document.querySelector('[data-testid="world-camera-group"]')?.getAttribute('transform')`
    );
    await evalCode(`document.querySelector('[data-testid="zoom-in-btn"]')?.click()`);
    const zoomTransformAfter = await evalCode(
      `document.querySelector('[data-testid="world-camera-group"]')?.getAttribute('transform')`
    );
    assert(zoomTransformBefore !== zoomTransformAfter, "Zoom In button must work at 600px width");
    console.log("✓ Main map controls are fully usable in 600px responsive mode.");

    // Restore desktop viewport
    await send("Emulation.clearDeviceMetricsOverride");
    await new Promise((r) => setTimeout(r, 200));

    // -------------------------------------------------------------
    // Test 11: CTA Enter 3D City navigates to /city/[repository_id]
    // -------------------------------------------------------------
    console.log("\n[Test 11] Testing CTA 'Enter 3D City' navigation...");
    const ctaHref = await evalCode(`document.querySelector('[data-testid="inspector-enter-city"]')?.getAttribute('href')`);
    assert(
      ctaHref === `/city/${targetCity1.repository_id}`,
      `Expected CTA href '/city/${targetCity1.repository_id}', got '${ctaHref}'`
    );

    // Click CTA
    await evalCode(`document.querySelector('[data-testid="inspector-enter-city"]')?.click()`);

    const navigatedToCity = await waitFor(async () => {
      const path = await evalCode(`window.location.pathname`);
      return path === `/city/${targetCity1.repository_id}`;
    }, 8000);
    assert(navigatedToCity, `Expected navigation to '/city/${targetCity1.repository_id}' upon clicking Enter 3D City`);
    console.log(`✓ Successfully navigated to /city/${targetCity1.repository_id} via inspector CTA.`);

    // -------------------------------------------------------------
    // Test 12: Zero unexpected console errors
    // -------------------------------------------------------------
    console.log("\n[Test 12] Checking for unexpected console errors...");
    const relevantErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("net::ERR_")
    );
    assert(relevantErrors.length === 0, `Unexpected console errors: ${relevantErrors.join(", ")}`);
    console.log("✓ Zero unexpected console errors recorded.");

    console.log("\n==================================================================");
    console.log("  ALL WM4 WORLD MAP INSPECTOR & INTERACTION TESTS PASSED (12/12)! ");
    console.log("==================================================================");
  } finally {
    try {
      edgeProc.kill("SIGKILL");
    } catch {}
  }
}

runWorldMapInspectorTests().catch((err) => {
  console.error("WM4 Inspector Tests Failed:", err);
  process.exit(1);
});
