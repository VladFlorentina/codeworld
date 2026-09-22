import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const ARTIFACT_DIR = "C:\\Users\\Huawei\\.gemini\\antigravity\\brain\\1f05e87d-e26f-46aa-95ee-fd6ad75a62e9";
const FASTAPI_REPO_ID = "9ca0ba88-7ab2-45e4-b92e-26dcf16ef8ac";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function runFastApiBenchmark() {
  console.log("=================================================================");
  console.log("   PHASE 2 • STEP 2.6: SCALE & PERFORMANCE VALIDATION (FASTAPI)   ");
  console.log("=================================================================");
  console.log(`Repository ID: ${FASTAPI_REPO_ID}`);

  const edgeProc = spawn(EDGE_PATH, [
    "--headless=new",
    "--remote-debugging-port=9222",
    "--window-size=1600,1000",
    "--no-first-run",
    "--no-default-browser-check",
    `http://localhost:3000?repo=${FASTAPI_REPO_ID}`,
  ]);

  try {
    let versionData: any = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      try {
        const res = await fetch("http://localhost:9222/json/version");
        if (res.ok) {
          versionData = await res.json();
          break;
        }
      } catch {}
    }
    if (!versionData) throw new Error("Could not connect to Edge on port 9222");

    const listRes = await fetch("http://localhost:9222/json/list");
    const targets = await listRes.json();
    const pageTarget = targets.find((t: any) => t.type === "page");
    if (!pageTarget) throw new Error("No page target found");

    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    let msgId = 1;
    function send(method: string, params: any = {}) {
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

    const consoleMessages: string[] = [];
    const pageErrors: string[] = [];

    ws.addEventListener("message", (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.method === "Runtime.consoleAPICalled") {
        const text = data.params.args.map((a: any) => a.value || a.description || "").join(" ");
        consoleMessages.push(`[${data.params.type}] ${text}`);
        if (data.params.type === "error") pageErrors.push(text);
      } else if (data.method === "Runtime.exceptionThrown") {
        const text = data.params.exceptionDetails.text + " " + (data.params.exceptionDetails.exception?.description || "");
        pageErrors.push(text);
      }
    });

    await send("Page.enable");
    await send("Runtime.enable");

    console.log("\nWaiting for FastAPI data fetch, layout compute, and initial 3D render...");
    // Polling until canvas and layout are ready
    let loadReady = false;
    let pollCount = 0;
    while (!loadReady && pollCount < 40) {
      await new Promise((r) => setTimeout(r, 500));
      pollCount++;
      const check = await send("Runtime.evaluate", {
        expression: `
          (() => {
            const hasCanvas = !!document.querySelector('canvas');
            const hasLayout = !!(window.__cityLayout && window.__cityLayout.buildings.length > 2000);
            return { hasCanvas, hasLayout };
          })()
        `,
        returnByValue: true,
      });
      if (check.result.value?.hasCanvas && check.result.value?.hasLayout) {
        loadReady = true;
      }
    }

    if (!loadReady) throw new Error("FastAPI layout did not load within timeout!");
    console.log(`FastAPI loaded and rendered after ~${pollCount * 500}ms.`);

    // Wait 2 extra seconds for stable rendering
    await new Promise((r) => setTimeout(r, 2000));

    // 1. Timings & Scale Metrics
    console.log("\n--- [Metric 1: Timings & Scale] ---");
    const metricsResult = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const l = window.__cityLayout;
          const t = window.__timings;
          const mem = window.performance && window.performance.memory;
          return {
            repoName: l.repository_name,
            districtsCount: l.districts.length,
            buildingsCount: l.buildings.length,
            connectionsCount: l.connections.length,
            cityBounds: l.bounds,
            fetchTimeMs: t ? t.fetchMs : null,
            layoutTimeMs: t ? t.layoutMs : null,
            jsHeapUsedMB: mem ? (mem.usedJSHeapSize / (1024 * 1024)).toFixed(1) : 'N/A',
            jsHeapTotalMB: mem ? (mem.totalJSHeapSize / (1024 * 1024)).toFixed(1) : 'N/A',
          };
        })()
      `,
      returnByValue: true,
    });

    if (metricsResult.exceptionDetails) {
      throw new Error(`Metric 1 evaluation error: ${JSON.stringify(metricsResult.exceptionDetails)}`);
    }

    const m = metricsResult.result.value;
    console.log(`Repository:          ${m.repoName}`);
    console.log(`Districts Count:     ${m.districtsCount}`);
    console.log(`Buildings Count:     ${m.buildingsCount}`);
    console.log(`Connections Count:   ${m.connectionsCount}`);
    console.log(`City Bounds:         ${m.cityBounds.width} x ${m.cityBounds.depth} units`);
    console.log(`DTO Fetch Time:      ${m.fetchTimeMs} ms`);
    console.log(`Layout Compute Time: ${m.layoutTimeMs} ms`);
    console.log(`JS Heap Memory:      ${m.jsHeapUsedMB} MB / ${m.jsHeapTotalMB} MB`);

    assert(m.districtsCount === 381, `Expected 381 districts, got ${m.districtsCount}`);
    assert(m.buildingsCount === 2867, `Expected 2867 buildings, got ${m.buildingsCount}`);
    assert(m.connectionsCount === 1609, `Expected 1609 connections, got ${m.connectionsCount}`);

    // 2. Three.js Scene Stats (Draw calls, Triangles, Geometries)
    console.log("\n--- [Metric 2: Three.js Render & GPU Stats] ---");
    const sceneStatsResult = await send("Runtime.evaluate", {
      expression: `
        (() => {
          if (typeof window.__getSceneStats === 'function') {
            return window.__getSceneStats();
          }
          return { error: '__getSceneStats not found' };
        })()
      `,
      returnByValue: true,
    });
    const sStats = sceneStatsResult.result.value;
    console.log("Scene Stats:", sStats);
    console.log(`  Draw Calls: ${sStats.drawCalls}`);
    console.log(`  Triangles:  ${sStats.triangles}`);
    console.log(`  Geometries: ${sStats.geometries}`);

    // 3. FPS & OrbitControls Fluidity Benchmark
    console.log("\n--- [Metric 3: OrbitControls & Animation Fluidity] ---");
    const fpsBenchmark = await send("Runtime.evaluate", {
      awaitPromise: true,
      expression: `
        new Promise((resolve) => {
          const canvas = document.querySelector('canvas');
          let frameCount = 0;
          let startTime = performance.now();
          const frameTimes = [];
          let lastTime = startTime;

          // Simulate gentle orbit pan/rotation events during measurement
          let interval = setInterval(() => {
            if (canvas) {
              canvas.dispatchEvent(new MouseEvent('mousemove', { clientX: 500 + (frameCount % 100), clientY: 400 }));
            }
          }, 16);

          function step(now) {
            frameCount++;
            frameTimes.push(now - lastTime);
            lastTime = now;
            if (now - startTime < 1500) {
              requestAnimationFrame(step);
            } else {
              clearInterval(interval);
              const totalDuration = now - startTime;
              const avgFps = (frameCount / (totalDuration / 1000)).toFixed(1);
              const maxFrameTime = Math.max(...frameTimes).toFixed(1);
              const avgFrameTime = (totalDuration / frameCount).toFixed(1);
              resolve({
                avgFps: Number(avgFps),
                avgFrameTimeMs: Number(avgFrameTime),
                maxFrameTimeMs: Number(maxFrameTime),
                totalFrames: frameCount,
              });
            }
          }
          requestAnimationFrame(step);
        });
      `,
      returnByValue: true,
    });

    const fpsResult = fpsBenchmark.result.value;
    console.log(`  Average FPS:          ${fpsResult.avgFps} FPS`);
    console.log(`  Average Frame Time:   ${fpsResult.avgFrameTimeMs} ms`);
    console.log(`  Max Frame Time:       ${fpsResult.maxFrameTimeMs} ms`);
    console.log(`  Total Frames Sampled: ${fpsResult.totalFrames}`);

    // 4. Capture Overview Screenshot of FastAPI
    console.log("\n--- [Metric 4: Capturing Overview Screenshot] ---");
    const shotFastapiOverview = await send("Page.captureScreenshot", { format: "png" });
    const fastapiOverviewPath = path.join(ARTIFACT_DIR, "fastapi_city_overview.png");
    fs.writeFileSync(fastapiOverviewPath, Buffer.from(shotFastapiOverview.data, "base64"));
    console.log("  ✓ Saved FastAPI overview screenshot to:", fastapiOverviewPath);

    // 5. Test Selection on High-Degree Building: `fastapi/routing.py`
    console.log("\n--- [Metric 5: Selection & Inspector Behavior on 'fastapi/routing.py'] ---");
    const selectRouting = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const t0 = performance.now();
          const routing = window.__cityLayout.buildings.find(b => b.path === 'fastapi/routing.py');
          window.__selectBuilding(routing.id);
          const t1 = performance.now();
          const relevantConns = window.__cityLayout.connections.filter(
            c => c.source_building_id === routing.id || c.target_building_id === routing.id
          );
          return {
            selectLatencyMs: Number((t1 - t0).toFixed(2)),
            id: routing.id,
            path: routing.path,
            name: routing.name,
            metrics: routing.metrics,
            expectedConnections: relevantConns.length,
          };
        })()
      `,
      returnByValue: true,
    });
    const routingSel = selectRouting.result.value;
    console.log(`  Selection Latency: ${routingSel.selectLatencyMs} ms`);
    console.log("  routing.py metadata:", {
      path: routingSel.path,
      loc_code: routingSel.metrics.loc_code,
      complexity: routingSel.metrics.complexity,
      in_degree: routingSel.metrics.in_degree,
      out_degree: routingSel.metrics.out_degree,
      expectedConnections: routingSel.expectedConnections,
    });

    await new Promise((r) => setTimeout(r, 600));

    // Verify Inspector DOM for routing.py
    const routingInspector = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const inspector = document.querySelector('[data-testid="building-inspector"]');
          if (!inspector) return { hasInspector: false };
          return {
            hasInspector: true,
            title: inspector.querySelector('[data-testid="inspector-name"]')?.textContent,
            path: inspector.querySelector('[data-testid="inspector-path"]')?.textContent,
            totalLoc: inspector.querySelector('[data-testid="inspector-loc-total"]')?.textContent,
            codeLoc: inspector.querySelector('[data-testid="inspector-loc-code"]')?.textContent,
            complexity: inspector.querySelector('[data-testid="inspector-complexity"]')?.textContent,
            inDegree: inspector.querySelector('[data-testid="inspector-in-degree"]')?.textContent,
            outDegree: inspector.querySelector('[data-testid="inspector-out-degree"]')?.textContent,
            activeConns: window.__activeConnectionsCount,
          };
        })()
      `,
      returnByValue: true,
    });
    console.log("  routing.py Inspector DOM:", routingInspector.result.value);
    assert(routingInspector.result.value.hasInspector, "Inspector must be visible");
    assert(routingInspector.result.value.path === "fastapi/routing.py", "Path must match");
    assert(routingInspector.result.value.codeLoc === "5730", "Code LOC should be 5730");
    assert(routingInspector.result.value.activeConns === routingSel.expectedConnections,
      `Expected ${routingSel.expectedConnections} active connections, got ${routingInspector.result.value.activeConns}`);
    console.log(`  ✓ PASS: routing.py inspector verified with exactly ${routingInspector.result.value.activeConns} connection lines!`);

    // 6. Test Massive High-Degree Hub: `fastapi/__init__.py` (595 connections!)
    console.log("\n--- [Metric 6: Massive Degree Hub Behavior on 'fastapi/__init__.py'] ---");
    const selectInit = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const t0 = performance.now();
          const initBld = window.__cityLayout.buildings.find(b => b.path === 'fastapi/__init__.py');
          window.__selectBuilding(initBld.id);
          const t1 = performance.now();
          const relevantConns = window.__cityLayout.connections.filter(
            c => c.source_building_id === initBld.id || c.target_building_id === initBld.id
          );
          return {
            selectLatencyMs: Number((t1 - t0).toFixed(2)),
            id: initBld.id,
            path: initBld.path,
            in_degree: initBld.metrics.in_degree,
            out_degree: initBld.metrics.out_degree,
            expectedConnections: relevantConns.length,
          };
        })()
      `,
      returnByValue: true,
    });
    const initSel = selectInit.result.value;
    console.log("  __init__.py metadata:", initSel);
    await new Promise((r) => setTimeout(r, 800));

    const initLinesCheck = await send("Runtime.evaluate", {
      expression: `
        (() => {
          return {
            activeConns: window.__activeConnectionsCount,
          };
        })()
      `,
      returnByValue: true,
    });
    console.log(`  Rendered lines for __init__.py: ${initLinesCheck.result.value.activeConns}`);
    assert(initLinesCheck.result.value.activeConns === initSel.expectedConnections,
      `Expected ${initSel.expectedConnections} lines, got ${initLinesCheck.result.value.activeConns}`);
    console.log(`  ✓ PASS: Exactly ${initSel.expectedConnections} lines rendered for massive hub without crash!`);

    // Capture screenshot with __init__.py selected
    console.log("  Capturing screenshot of FastAPI with __init__.py connections...");
    const shotFastapiHub = await send("Page.captureScreenshot", { format: "png" });
    const fastapiHubPath = path.join(ARTIFACT_DIR, "fastapi_selected_hub.png");
    fs.writeFileSync(fastapiHubPath, Buffer.from(shotFastapiHub.data, "base64"));
    console.log("  ✓ Saved FastAPI selected hub screenshot to:", fastapiHubPath);

    // 7. Test Deselect
    console.log("\n--- [Metric 7: Deselection Test] ---");
    await send("Runtime.evaluate", {
      expression: `window.__selectBuilding(null);`,
    });
    await new Promise((r) => setTimeout(r, 400));
    const deselectCheck = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const inspector = document.querySelector('[data-testid="building-inspector"]');
          return {
            hasInspector: !!inspector,
            activeConns: window.__activeConnectionsCount,
          };
        })()
      `,
      returnByValue: true,
    });
    console.log("  After deselect:", deselectCheck.result.value);
    assert(!deselectCheck.result.value.hasInspector, "Inspector should be hidden");
    assert(deselectCheck.result.value.activeConns === 0, "Active conns should be 0");
    console.log("  ✓ PASS: Deselection clean.");

    // 8. Console errors check
    console.log("\n--- [Metric 8: Browser Console Errors] ---");
    console.log("  Total console errors:", pageErrors.length);
    assert(pageErrors.length === 0, `Browser errors: ${pageErrors.join("; ")}`);
    console.log("  ✓ PASS: Zero console errors or exceptions!");

    console.log("\n=================================================================");
    console.log("         FASTAPI PERFORMANCE BENCHMARK COMPLETED!               ");
    console.log("=================================================================");
    ws.close();
  } finally {
    edgeProc.kill();
  }
}

runFastApiBenchmark().catch((err) => {
  console.error("Benchmark failed:", err);
  process.exit(1);
});
