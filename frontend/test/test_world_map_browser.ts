import { spawn } from "child_process";
import { waitFor } from "./helpers/waitFor";
import { WorldMapResponse } from "../src/types/world";

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9235;

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

async function runWorldMapBrowserTests() {
  console.log("==================================================================");
  console.log("     WM3: CORE 2D SVG WORLD MAP AUTOMATED BROWSER TESTS          ");
  console.log("==================================================================");

  // 1. Fetch live payload directly to assert dynamic counts and IDs
  console.log("\n[Step 1] Fetching live backend payload from /api/v1/explore/world...");
  const exploreRes = await fetch("http://localhost:8000/api/v1/explore/world");
  assert(exploreRes.ok, `Failed to fetch explore/world: HTTP ${exploreRes.status}`);
  const worldData: WorldMapResponse = await exploreRes.json();
  console.log(`✓ Live explore world returned ${worldData.total_cities} cities.`);
  assert(worldData.cities.length > 0, "Expected at least 1 city in live backend payload");

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

    // Intercept mode state
    let interceptMode: "pass" | "500" | "empty" | "hold" = "pass";
    let heldRequestId: string | null = null;
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

      if (data.method === "Fetch.requestPaused") {
        const reqId = data.params.requestId;
        const url = data.params.request.url;

        if (url.includes("/explore/world")) {
          if (interceptMode === "hold") {
            heldRequestId = reqId;
            return;
          } else if (interceptMode === "500") {
            send("Fetch.fulfillRequest", {
              requestId: reqId,
              responseCode: 500,
              responseHeaders: [
                { name: "Content-Type", value: "application/json" },
                { name: "Access-Control-Allow-Origin", value: "http://localhost:3000" },
              ],
              body: Buffer.from(JSON.stringify({ detail: "Simulated Backend Error" })).toString("base64"),
            });
            return;
          } else if (interceptMode === "empty") {
            send("Fetch.fulfillRequest", {
              requestId: reqId,
              responseCode: 200,
              responseHeaders: [
                { name: "Content-Type", value: "application/json" },
                { name: "Access-Control-Allow-Origin", value: "http://localhost:3000" },
              ],
              body: Buffer.from(JSON.stringify({ cities: [], total_cities: 0 })).toString("base64"),
            });
            return;
          }
        }

        send("Fetch.continueRequest", { requestId: reqId });
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

    // -------------------------------------------------------------
    // Test 1: Verify existing Explore submit & featured worlds exist
    // -------------------------------------------------------------
    console.log("\n[Test 1] Verifying existing Explore page structure is intact...");
    const hasRepoInput = await waitFor(async () => {
      return Boolean(await evalCode(`document.querySelector('[data-testid="repo-input"]') !== null`));
    }, 10000);
    assert(hasRepoInput, "repo-input element must exist on page");

    const hasGenerateBtn = await evalCode(`document.querySelector('[data-testid="generate-btn"]') !== null`);
    assert(hasGenerateBtn, "generate-btn element must exist on page");

    const hasFeaturedWorld = await evalCode(
      `document.querySelector('[data-testid="featured-encode-starlette"]') !== null`
    );
    assert(hasFeaturedWorld, "featured-encode-starlette card must exist on page");
    console.log("✓ Existing Explore submit inputs and featured cards preserved.");

    // -------------------------------------------------------------
    // Test 2: Verify World Map SVG and camera group render
    // -------------------------------------------------------------
    console.log("\n[Test 2] Verifying World Map SVG and camera group...");
    const hasSvg = await waitFor(async () => {
      return Boolean(await evalCode(`document.querySelector('[data-testid="world-map-svg"]') !== null`));
    }, 10000);
    assert(hasSvg, "world-map-svg must render on page");

    const hasCamera = await evalCode(`document.querySelector('[data-testid="world-camera-group"]') !== null`);
    assert(hasCamera, "world-camera-group must exist inside SVG");
    console.log("✓ World Map SVG rendered with camera transformation group.");

    // -------------------------------------------------------------
    // Test 3: Dynamic City count, IDs, and semantic <a> links
    // -------------------------------------------------------------
    console.log("\n[Test 3] Verifying dynamic city nodes against live payload...");
    const renderedNodesCount = await evalCode(
      `document.querySelectorAll('a[data-testid^="city-node-"]').length`
    );
    assert(
      renderedNodesCount === worldData.cities.length,
      `Expected ${worldData.cities.length} rendered city nodes, got ${renderedNodesCount}`
    );

    for (const city of worldData.cities) {
      const nodeSelector = `[data-testid="city-node-${city.repository_id}"]`;
      const nodeExists = await evalCode(`document.querySelector('${nodeSelector}') !== null`);
      assert(nodeExists, `City node for repository ${city.full_name} (${city.repository_id}) must exist`);

      const href = await evalCode(`document.querySelector('${nodeSelector}')?.getAttribute('href')`);
      assert(
        href === `/city/${city.repository_id}`,
        `Expected href to be '/city/${city.repository_id}', got '${href}'`
      );

      const ariaLabel = await evalCode(`document.querySelector('${nodeSelector}')?.getAttribute('aria-label')`);
      assert(
        Boolean(ariaLabel && ariaLabel.includes(city.full_name)),
        `City node must have aria-label containing ${city.full_name}`
      );
    }
    console.log(`✓ All ${worldData.cities.length} cities rendered with correct repository_id links and aria-labels.`);

    // -------------------------------------------------------------
    // Test 4: Initial fit uses bounds
    // -------------------------------------------------------------
    console.log("\n[Test 4] Verifying initial camera fit...");
    const initialTransform = await evalCode(
      `document.querySelector('[data-testid="world-camera-group"]')?.getAttribute('transform')`
    );
    assert(Boolean(initialTransform), "Camera group must have transform attribute");
    assert(!initialTransform.includes("NaN"), `Transform must not contain NaN: ${initialTransform}`);
    console.log(`✓ Initial camera transform: ${initialTransform}`);

    // -------------------------------------------------------------
    // Test 5: Pan changes viewport
    // -------------------------------------------------------------
    console.log("\n[Test 5] Simulating pointer drag pan via native CDP mouse events...");
    const center = await evalCode(`
      (() => {
        const svg = document.querySelector('[data-testid="world-map-svg"]');
        svg.scrollIntoView({ block: 'center' });
        const r = svg.getBoundingClientRect();
        return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
      })()
    `);

    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: center.x,
      y: center.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: center.x + 80,
      y: center.y + 60,
      button: "left",
      buttons: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: center.x + 80,
      y: center.y + 60,
      button: "left",
      buttons: 0,
    });

    await new Promise((r) => setTimeout(r, 100));

    const pannedTransform = await waitFor(async () => {
      const t = await evalCode(
        `document.querySelector('[data-testid="world-camera-group"]')?.getAttribute('transform')`
      );
      return t && t !== initialTransform;
    }, 4000);
    assert(pannedTransform, "Transform must change after pointer drag pan");

    const currentTransform = await evalCode(
      `document.querySelector('[data-testid="world-camera-group"]')?.getAttribute('transform')`
    );
    console.log(`✓ Pan updated transform to: ${currentTransform}`);

    // -------------------------------------------------------------
    // Test 6: Zoom In & Zoom Out buttons
    // -------------------------------------------------------------
    console.log("\n[Test 6] Testing Zoom In and Zoom Out controls...");
    await evalCode(`document.querySelector('[data-testid="zoom-in-btn"]')?.click()`);
    const zoomedInTransform = await evalCode(
      `document.querySelector('[data-testid="world-camera-group"]')?.getAttribute('transform')`
    );
    assert(zoomedInTransform !== pannedTransform, "Transform must change on Zoom In");

    await evalCode(`document.querySelector('[data-testid="zoom-out-btn"]')?.click()`);
    const zoomedOutTransform = await evalCode(
      `document.querySelector('[data-testid="world-camera-group"]')?.getAttribute('transform')`
    );
    assert(zoomedOutTransform !== zoomedInTransform, "Transform must change on Zoom Out");
    console.log("✓ Zoom controls adjust camera scale correctly.");

    // -------------------------------------------------------------
    // Test 7: Reset View restores camera
    // -------------------------------------------------------------
    console.log("\n[Test 7] Testing Reset View control...");
    await evalCode(`document.querySelector('[data-testid="reset-view-btn"]')?.click()`);
    const resetTransform = await evalCode(
      `document.querySelector('[data-testid="world-camera-group"]')?.getAttribute('transform')`
    );
    assert(
      resetTransform === initialTransform,
      `Expected reset transform '${initialTransform}', got '${resetTransform}'`
    );
    console.log("✓ Reset View cleanly restored initial camera positioning.");

    // -------------------------------------------------------------
    // Test 8: Deterministic City Navigation
    // -------------------------------------------------------------
    console.log("\n[Test 8] Testing city click navigation to /city/[repositoryId]...");
    const targetCity = worldData.cities[0];
    const clickInfo = await evalCode(`
      (() => {
        const node = document.querySelector('[data-testid="city-node-${targetCity.repository_id}"]');
        node.scrollIntoView({ block: 'center' });
        const r = node.getBoundingClientRect();
        const pt = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
        const el = document.elementFromPoint(pt.x, pt.y);

        window.__clickEventFired = false;
        node.addEventListener('click', (e) => {
          window.__clickEventFired = true;
          window.__clickDefaultPrevented = e.defaultPrevented;
        });

        return { pt, elTag: el?.tagName, href: node.getAttribute('href'), hrefBaseVal: node.href?.baseVal };
      })()
    `);

    await send("Input.dispatchMouseEvent", {
      type: "mousePressed",
      x: clickInfo.pt.x,
      y: clickInfo.pt.y,
      button: "left",
      buttons: 1,
      clickCount: 1,
    });
    await send("Input.dispatchMouseEvent", {
      type: "mouseReleased",
      x: clickInfo.pt.x,
      y: clickInfo.pt.y,
      button: "left",
      buttons: 0,
    });

    const navigated = await waitFor(async () => {
      const path = await evalCode(`window.location.pathname`);
      return path === `/city/${targetCity.repository_id}`;
    }, 8000);
    assert(navigated, `Expected navigation to '/city/${targetCity.repository_id}'`);
    console.log(`✓ Successfully navigated to /city/${targetCity.repository_id} on city click.`);

    // -------------------------------------------------------------
    // Test 9: Deterministic Loading State via Request Hold
    // -------------------------------------------------------------
    console.log("\n[Test 9] Testing Loading State with Request Hold...");
    await send("Fetch.enable", {
      patterns: [{ urlPattern: "*explore/world*", requestStage: "Request" }],
    });

    interceptMode = "hold";
    heldRequestId = null;
    await send("Page.navigate", { url: "http://localhost:3000/" });

    // 1. Observe loading card while request is held
    const hasLoadingCard = await waitFor(async () => {
      return Boolean(await evalCode(`document.querySelector('[data-testid="world-map-loading"]') !== null`));
    }, 8000);
    assert(hasLoadingCard, "world-map-loading must be visible while explore/world request is pending");
    console.log("✓ Loading spinner/card observed in DOM while request is pending.");

    // 2. Release request and observe transition to ready state
    interceptMode = "pass";
    if (heldRequestId) {
      await send("Fetch.continueRequest", { requestId: heldRequestId });
      heldRequestId = null;
    }

    const hasReadyMapAfterLoading = await waitFor(async () => {
      return Boolean(await evalCode(`document.querySelector('[data-testid="world-map-svg"]') !== null`));
    }, 8000);
    assert(hasReadyMapAfterLoading, "world-map-svg must appear after held request is released");
    console.log("✓ World Map cleanly transitioned from loading to ready state.");

    // -------------------------------------------------------------
    // Test 10: Clean Abort on Component Unmount
    // -------------------------------------------------------------
    console.log("\n[Test 10] Testing clean AbortController cleanup on component unmount...");
    interceptMode = "hold";
    heldRequestId = null;
    await send("Page.navigate", { url: "http://localhost:3000/" });

    // Wait until loading is active on explore page
    await waitFor(async () => {
      return Boolean(await evalCode(`document.querySelector('[data-testid="world-map-loading"]') !== null`));
    }, 8000);

    // Navigate away while explore/world is still pending (unmounts WorldMap and triggers controller.abort())
    await send("Page.navigate", { url: "http://localhost:3000/my-repositories" });

    const navigatedAway = await waitFor(async () => {
      const path = await evalCode(`window.location.pathname`);
      return path === "/my-repositories";
    }, 8000);
    assert(navigatedAway, "Successfully navigated to /my-repositories while request was held");

    // Release any held request
    interceptMode = "pass";
    if (heldRequestId) {
      try {
        await send("Fetch.continueRequest", { requestId: heldRequestId });
      } catch {}
      heldRequestId = null;
    }

    // Verify no unmount warnings or console errors occurred
    const relevantErrors = consoleErrors.filter(
      (e) => !e.includes("favicon") && !e.includes("net::ERR_")
    );
    assert(relevantErrors.length === 0, `Unexpected errors during unmount: ${relevantErrors.join(", ")}`);
    console.log("✓ Component unmounted cleanly during pending fetch without console warnings or state leaks.");

    // -------------------------------------------------------------
    // Test 11: Deterministic Error State & Retry via CDP Fetch Interception
    // -------------------------------------------------------------
    console.log("\n[Test 11] Testing Error State & Retry with CDP Interception...");
    interceptMode = "500";
    await send("Page.navigate", { url: "http://localhost:3000/" });

    const hasErrorState = await waitFor(async () => {
      return Boolean(await evalCode(`document.querySelector('[data-testid="world-map-error"]') !== null`));
    }, 8000);
    assert(hasErrorState, "world-map-error card must appear when endpoint returns HTTP 500");

    const hasRetryBtn = await evalCode(`document.querySelector('[data-testid="world-map-retry-btn"]') !== null`);
    assert(hasRetryBtn, "Retry button must appear in error state");
    console.log("✓ Error state triggered and rendered correctly on HTTP 500.");

    // Test retry recovery
    console.log("Testing Retry recovery...");
    interceptMode = "pass";
    await evalCode(`document.querySelector('[data-testid="world-map-retry-btn"]')?.click()`);

    const recovered = await waitFor(async () => {
      return Boolean(await evalCode(`document.querySelector('[data-testid="world-map-svg"]') !== null`));
    }, 8000);
    assert(recovered, "World Map SVG must recover upon clicking Retry");
    console.log("✓ World Map cleanly recovered to ready state after retry.");

    // -------------------------------------------------------------
    // Test 12: Deterministic Empty State via CDP Fetch Interception
    // -------------------------------------------------------------
    console.log("\n[Test 12] Testing Empty State with CDP Interception...");
    interceptMode = "empty";
    await send("Page.navigate", { url: "http://localhost:3000/" });

    const hasEmptyState = await waitFor(async () => {
      return Boolean(await evalCode(`document.querySelector('[data-testid="world-map-empty"]') !== null`));
    }, 8000);
    assert(hasEmptyState, "world-map-empty card must appear when endpoint returns 0 cities");
    console.log("✓ Empty state rendered correctly for zero cities payload.");

    await send("Fetch.disable");

    console.log("\n==================================================================");
    console.log("  ALL WM3 CORE 2D SVG WORLD MAP BROWSER TESTS PASSED (12/12)!    ");
    console.log("==================================================================");
  } finally {
    try {
      edgeProc.kill("SIGKILL");
    } catch {}
  }
}

runWorldMapBrowserTests().catch((err) => {
  console.error(err);
  process.exit(1);
});
