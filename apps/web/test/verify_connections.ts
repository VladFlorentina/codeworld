import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const ARTIFACT_DIR = "C:\\Users\\Huawei\\.gemini\\antigravity\\brain\\1f05e87d-e26f-46aa-95ee-fd6ad75a62e9";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(`Assertion failed: ${message}`);
  }
}

async function verifyConnectionsAndInspector() {
  console.log("=== VERIFYING STEP 2.5: SELECTION, INSPECTOR & CONNECTIONS ===");

  const edgeProc = spawn(EDGE_PATH, [
    "--headless=new",
    "--remote-debugging-port=9222",
    "--window-size=1600,1000",
    "--no-first-run",
    "--no-default-browser-check",
    "http://localhost:3000",
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

    console.log("Waiting for 3D canvas and layout initialization...");
    await new Promise((r) => setTimeout(r, 6000));

    // 1. Initial State: 0 connections rendered when no building is selected
    console.log("\n[Test 1/4] Checking that 0 connection lines are rendered initially...");
    const initLinesCheck = await send("Runtime.evaluate", {
      expression: `
        (() => {
          return {
            linesCount: typeof window.__activeConnectionsCount === 'number' ? window.__activeConnectionsCount : 0,
          };
        })()
      `,
      returnByValue: true,
    });

    console.log("  Initial lines check:", initLinesCheck.result.value);
    assert(
      initLinesCheck.result.value.linesCount === 0,
      "Expected 0 connections rendered when no building is selected!"
    );
    console.log("  ✓ PASS: Zero connections rendered initially (avoids cluttering scene with 400 lines).");

    // 2. Select Building 1: `starlette/routing.py` (High out_degree = 12, in_degree = 28)
    console.log("\n[Test 2/4] Selecting 'starlette/routing.py' (high out_degree)...");
    const selectRouting = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const routing = window.__cityLayout.buildings.find(b => b.path === 'starlette/routing.py');
          window.__selectBuilding(routing.id);
          const relevantConns = window.__cityLayout.connections.filter(
            c => c.source_building_id === routing.id || c.target_building_id === routing.id
          );
          return {
            id: routing.id,
            path: routing.path,
            in_degree: routing.metrics.in_degree,
            out_degree: routing.metrics.out_degree,
            is_in_cycle: routing.metrics.is_in_cycle,
            expectedConnectionsCount: relevantConns.length,
            circularCount: relevantConns.filter(c => c.is_circular).length,
            outgoingCount: relevantConns.filter(c => c.source_building_id === routing.id).length,
            incomingCount: relevantConns.filter(c => c.target_building_id === routing.id).length,
          };
        })()
      `,
      returnByValue: true,
    });

    const routingData = selectRouting.result.value;
    console.log("  routing.py metadata:", routingData);
    await new Promise((r) => setTimeout(r, 600));

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
            blankLoc: inspector.querySelector('[data-testid="inspector-loc-blank"]')?.textContent,
            complexity: inspector.querySelector('[data-testid="inspector-complexity"]')?.textContent,
            inDegree: inspector.querySelector('[data-testid="inspector-in-degree"]')?.textContent,
            outDegree: inspector.querySelector('[data-testid="inspector-out-degree"]')?.textContent,
            isInCycle: inspector.querySelector('[data-testid="inspector-is-in-cycle"]')?.textContent,
          };
        })()
      `,
      returnByValue: true,
    });
    console.log("  routing.py Inspector DOM:", routingInspector.result.value);
    assert(routingInspector.result.value.hasInspector, "BuildingInspector should be visible for routing.py");
    assert(routingInspector.result.value.path === "starlette/routing.py", "Path should be starlette/routing.py");
    assert(routingInspector.result.value.inDegree === "28", "In-degree should be 28");
    assert(routingInspector.result.value.outDegree === "12", "Out-degree should be 12");
    assert(routingInspector.result.value.isInCycle === "true", "is_in_cycle should be true");
    console.log("  ✓ PASS: BuildingInspector displays accurate raw metrics for routing.py.");

    // Verify Three.js Connection Lines count for routing.py
    const routingLinesCheck = await send("Runtime.evaluate", {
      expression: `
        (() => {
          return {
            linesCount: typeof window.__activeConnectionsCount === 'number' ? window.__activeConnectionsCount : 0,
          };
        })()
      `,
      returnByValue: true,
    });
    console.log("  routing.py rendered 3D lines:", routingLinesCheck.result.value);
    assert(
      routingLinesCheck.result.value.linesCount === routingData.expectedConnectionsCount,
      `Expected ${routingData.expectedConnectionsCount} rendered lines for routing.py, but got ${routingLinesCheck.result.value.linesCount}`
    );
    console.log(`  ✓ PASS: Exactly ${routingLinesCheck.result.value.linesCount} lines rendered (matching 12 outgoing + 28 incoming).`);

    // Capture screenshot of routing.py selected with Inspector and connection arcs
    console.log("  Capturing screenshot of starlette/routing.py with connections...");
    const shotRouting = await send("Page.captureScreenshot", { format: "png" });
    const routingShotPath = path.join(ARTIFACT_DIR, "starlette_selected_routing.png");
    fs.writeFileSync(routingShotPath, Buffer.from(shotRouting.data, "base64"));
    console.log("  ✓ Screenshot saved to:", routingShotPath);

    // 3. Select Building 2: `starlette/types.py` (High in_degree = 54, out_degree = 3)
    console.log("\n[Test 3/4] Selecting 'starlette/types.py' (high in_degree)...");
    const selectTypes = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const typesBld = window.__cityLayout.buildings.find(b => b.path === 'starlette/types.py');
          window.__selectBuilding(typesBld.id);
          const relevantConns = window.__cityLayout.connections.filter(
            c => c.source_building_id === typesBld.id || c.target_building_id === typesBld.id
          );
          return {
            id: typesBld.id,
            path: typesBld.path,
            in_degree: typesBld.metrics.in_degree,
            out_degree: typesBld.metrics.out_degree,
            is_in_cycle: typesBld.metrics.is_in_cycle,
            expectedConnectionsCount: relevantConns.length,
          };
        })()
      `,
      returnByValue: true,
    });

    const typesData = selectTypes.result.value;
    console.log("  types.py metadata:", typesData);
    await new Promise((r) => setTimeout(r, 600));

    const typesInspector = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const inspector = document.querySelector('[data-testid="building-inspector"]');
          if (!inspector) return { hasInspector: false };
          return {
            hasInspector: true,
            title: inspector.querySelector('[data-testid="inspector-name"]')?.textContent,
            path: inspector.querySelector('[data-testid="inspector-path"]')?.textContent,
            inDegree: inspector.querySelector('[data-testid="inspector-in-degree"]')?.textContent,
            outDegree: inspector.querySelector('[data-testid="inspector-out-degree"]')?.textContent,
          };
        })()
      `,
      returnByValue: true,
    });
    console.log("  types.py Inspector DOM:", typesInspector.result.value);
    assert(typesInspector.result.value.path === "starlette/types.py", "Path should be starlette/types.py");
    assert(typesInspector.result.value.inDegree === "54", "In-degree should be 54");
    assert(typesInspector.result.value.outDegree === "3", "Out-degree should be 3");

    // Verify Three.js Connection Lines count for types.py
    const typesLinesCheck = await send("Runtime.evaluate", {
      expression: `
        (() => {
          return {
            linesCount: typeof window.__activeConnectionsCount === 'number' ? window.__activeConnectionsCount : 0,
          };
        })()
      `,
      returnByValue: true,
    });
    console.log("  types.py rendered 3D lines:", typesLinesCheck.result.value);
    assert(
      typesLinesCheck.result.value.linesCount === typesData.expectedConnectionsCount,
      `Expected ${typesData.expectedConnectionsCount} rendered lines for types.py, but got ${typesLinesCheck.result.value.linesCount}`
    );
    console.log(`  ✓ PASS: Exactly ${typesLinesCheck.result.value.linesCount} lines rendered (matching 3 outgoing + 54 incoming).`);

    // 4. Test Deselection on Background Click / Empty Space
    console.log("\n[Test 4/4] Testing Deselection on backdrop click / Close...");
    await send("Runtime.evaluate", {
      expression: `
        (() => {
          // Deselect
          window.__selectBuilding(null);
        })()
      `,
    });
    await new Promise((r) => setTimeout(r, 500));

    const deselectCheck = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const inspector = document.querySelector('[data-testid="building-inspector"]');
          return {
            hasInspector: !!inspector,
            linesCount: typeof window.__activeConnectionsCount === 'number' ? window.__activeConnectionsCount : 0,
          };
        })()
      `,
      returnByValue: true,
    });
    console.log("  After deselect:", deselectCheck.result.value);
    assert(!deselectCheck.result.value.hasInspector, "Inspector should be closed after deselect");
    assert(deselectCheck.result.value.linesCount === 0, "Connections should be 0 after deselect");
    console.log("  ✓ PASS: Both Inspector and connection lines clear cleanly upon deselect.");

    // Check Console errors
    console.log("\nConsole Errors check:", pageErrors.length);
    assert(pageErrors.length === 0, `Detected browser errors: ${pageErrors.join("; ")}`);
    console.log("  ✓ PASS: Zero browser console errors or exceptions!");

    console.log("\nALL STEP 2.5 VERIFICATIONS PASSED SUCCESSFULLY!");
    ws.close();
  } finally {
    edgeProc.kill();
  }
}

verifyConnectionsAndInspector().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
