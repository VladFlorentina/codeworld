import { spawn } from "child_process";

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const STARLETTE_ID = "2e945127-9c5d-4b5a-a0d9-9d52e2cbadfe";
const FASTAPI_ID = "9ca0ba88-7ab2-45e4-b92e-26dcf16ef8ac";
const INVALID_ID = "00000000-0000-0000-0000-000000000000";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

async function runCp3ViewerTests() {
  console.log("==================================================================");
  console.log("    CHECKPOINT 3: ROUTING & VIEWER VALIDATION (/city/[id])       ");
  console.log("==================================================================");

  const edgeProc = spawn(EDGE_PATH, [
    "--headless=new",
    "--remote-debugging-port=9225",
    "--window-size=1600,1000",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ]);

  try {
    let versionData: any = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const res = await fetch("http://localhost:9225/json/version");
        if (res.ok) {
          versionData = await res.json();
          break;
        }
      } catch {}
    }
    if (!versionData) throw new Error("Could not connect to Edge on port 9225");

    const listRes = await fetch("http://localhost:9225/json/list");
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

    const consoleErrors: string[] = [];
    ws.addEventListener("message", (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.method === "Runtime.consoleAPICalled" && data.params.type === "error") {
        const text = data.params.args.map((a: any) => a.value || a.description || "").join(" ");
        consoleErrors.push(text);
      } else if (data.method === "Runtime.exceptionThrown") {
        const text = data.params.exceptionDetails.text + " " + (data.params.exceptionDetails.exception?.description || "");
        consoleErrors.push(text);
      }
    });

    await send("Page.enable");
    await send("Runtime.enable");

    // ─────────────────────────────────────────────────────────────
    // TEST 1: Starlette Viewer (/city/2e945127...)
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- [Test 1: Starlette City Viewer (/city/2e945127...)] ---");
    await send("Page.navigate", { url: `http://localhost:3000/city/${STARLETTE_ID}` });

    let starletteReady = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const check = await send("Runtime.evaluate", {
        expression: `
          (() => {
            const hasCanvas = !!document.querySelector('canvas');
            const l = window.__cityLayout;
            return { hasCanvas, hasLayout: !!(l && l.buildings && l.buildings.length === 132) };
          })()
        `,
        returnByValue: true,
      });
      if (check?.result?.value?.hasCanvas && check?.result?.value?.hasLayout) {
        starletteReady = true;
        break;
      }
    }
    assert(starletteReady, "Starlette city viewer did not load within timeout!");
    console.log("  ✓ Starlette loaded: canvas rendered with 132 buildings.");

    // Check Starlette metrics
    const starletteStats = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const l = window.__cityLayout;
          return {
            name: l.repository_name,
            districts: l.districts.length,
            buildings: l.buildings.length,
            connections: l.connections.length,
          };
        })()
      `,
      returnByValue: true,
    });
    const sVal = starletteStats.result.value;
    console.log("  Starlette stats:", sVal);
    assert(sVal.districts === 12, `Expected 12 districts, got ${sVal.districts}`);
    assert(sVal.buildings === 132, `Expected 132 buildings, got ${sVal.buildings}`);
    assert(sVal.connections === 400, `Expected 400 connections, got ${sVal.connections}`);
    console.log("  ✓ Starlette exact scale verified: 12 districts, 132 buildings, 400 connections.");

    // Test Starlette building selection & inspector
    console.log("  Testing selection on 'starlette/routing.py'...");
    await send("Runtime.evaluate", {
      expression: `
        (() => {
          const b = window.__cityLayout.buildings.find(b => b.path === 'starlette/routing.py');
          window.__selectBuilding(b.id);
        })()
      `,
    });
    await new Promise((r) => setTimeout(r, 500));

    const starletteInspectorCheck = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const inspector = document.querySelector('[data-testid="building-inspector"]');
          return {
            hasInspector: !!inspector,
            path: inspector?.querySelector('[data-testid="inspector-path"]')?.textContent,
            activeConns: window.__activeConnectionsCount,
          };
        })()
      `,
      returnByValue: true,
    });
    console.log("  Starlette Inspector:", starletteInspectorCheck.result.value);
    assert(starletteInspectorCheck.result.value.hasInspector, "Inspector must be visible");
    assert(starletteInspectorCheck.result.value.path === "starlette/routing.py", "Path must match");
    assert(starletteInspectorCheck.result.value.activeConns === 40, `Expected 40 active connections, got ${starletteInspectorCheck.result.value.activeConns}`);
    console.log("  ✓ Starlette inspector and 40 connection lines verified!");

    // Test back button link
    console.log("  Testing '← Explore Worlds' link navigation...");
    await send("Runtime.evaluate", {
      expression: `
        (() => {
          const el = document.querySelector('[data-testid="back-to-explore"]');
          if (el) el.click();
        })()
      `,
    });

    let navigatedToRoot = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const urlCheck = await send("Runtime.evaluate", {
        expression: `window.location.pathname`,
        returnByValue: true,
      });
      if (urlCheck?.result?.value === "/") {
        navigatedToRoot = true;
        break;
      }
    }
    assert(navigatedToRoot, `Expected path '/', but navigation did not complete within timeout`);
    console.log("  ✓ Navigation back to '/' verified.");

    // ─────────────────────────────────────────────────────────────
    // TEST 2: FastAPI Viewer (/city/9ca0ba88...)
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- [Test 2: FastAPI City Viewer (/city/9ca0ba88...)] ---");
    await send("Page.navigate", { url: `http://localhost:3000/city/${FASTAPI_ID}` });

    let fastapiReady = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 400));
      const check = await send("Runtime.evaluate", {
        expression: `
          (() => {
            const hasCanvas = !!document.querySelector('canvas');
            const l = window.__cityLayout;
            return { hasCanvas, hasLayout: !!(l && l.buildings && l.buildings.length === 2867) };
          })()
        `,
        returnByValue: true,
      });
      if (check?.result?.value?.hasCanvas && check?.result?.value?.hasLayout) {
        fastapiReady = true;
        break;
      }
    }
    assert(fastapiReady, "FastAPI city viewer did not load within timeout!");
    console.log("  ✓ FastAPI loaded: canvas rendered with 2,867 buildings.");

    // Check FastAPI metrics
    const fastapiStats = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const l = window.__cityLayout;
          return {
            name: l.repository_name,
            districts: l.districts.length,
            buildings: l.buildings.length,
            connections: l.connections.length,
          };
        })()
      `,
      returnByValue: true,
    });
    const fVal = fastapiStats.result.value;
    console.log("  FastAPI stats:", fVal);
    assert(fVal.districts === 381, `Expected 381 districts, got ${fVal.districts}`);
    assert(fVal.buildings === 2867, `Expected 2867 buildings, got ${fVal.buildings}`);
    assert(fVal.connections === 1609, `Expected 1609 connections, got ${fVal.connections}`);
    console.log("  ✓ FastAPI exact scale verified: 381 districts, 2,867 buildings, 1,609 connections.");

    // Test FastAPI selection on hub: `fastapi/__init__.py`
    console.log("  Testing selection on massive hub 'fastapi/__init__.py' (595 conns)...");
    await send("Runtime.evaluate", {
      expression: `
        (() => {
          const b = window.__cityLayout.buildings.find(b => b.path === 'fastapi/__init__.py');
          window.__selectBuilding(b.id);
        })()
      `,
    });
    await new Promise((r) => setTimeout(r, 600));

    const fastapiHubCheck = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const inspector = document.querySelector('[data-testid="building-inspector"]');
          return {
            hasInspector: !!inspector,
            path: inspector?.querySelector('[data-testid="inspector-path"]')?.textContent,
            activeConns: window.__activeConnectionsCount,
          };
        })()
      `,
      returnByValue: true,
    });
    console.log("  FastAPI Hub Inspector:", fastapiHubCheck.result.value);
    assert(fastapiHubCheck.result.value.hasInspector, "Inspector must be visible");
    assert(fastapiHubCheck.result.value.path === "fastapi/__init__.py", "Path must match");
    assert(fastapiHubCheck.result.value.activeConns === 595, `Expected 595 active connections, got ${fastapiHubCheck.result.value.activeConns}`);
    console.log("  ✓ FastAPI massive hub inspector and 595 lines rendered perfectly!");

    // ─────────────────────────────────────────────────────────────
    // TEST 3: Invalid repository_id produces controlled error
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- [Test 3: Invalid repository_id (/city/00000000...)] ---");
    await send("Page.navigate", { url: `http://localhost:3000/city/${INVALID_ID}` });
    await new Promise((r) => setTimeout(r, 1200));

    const errorStateCheck = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const errEl = document.querySelector('[data-testid="viewer-error"]');
          return {
            hasError: !!errEl,
            text: errEl?.textContent || null,
          };
        })()
      `,
      returnByValue: true,
    });
    console.log("  Error state check:", errorStateCheck.result.value);
    assert(errorStateCheck.result.value.hasError, "Error UI should be displayed");
    assert(errorStateCheck.result.value.text.includes("Failed to load city layout"), "Should contain error message");
    console.log("  ✓ Controlled error state verified on invalid repositoryId (no app crash).");

    // ─────────────────────────────────────────────────────────────
    // TEST 4: Browser console errors check
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- [Test 4: Browser Console Errors] ---");
    // Filter out expected 404 fetch errors for the invalid repository test
    const unexpectedErrors = consoleErrors.filter(
      (e) => !e.includes("404") && !e.includes("Failed to load resource")
    );
    console.log("  Total unexpected console errors:", unexpectedErrors.length);
    assert(unexpectedErrors.length === 0, `Unexpected errors: ${unexpectedErrors.join("; ")}`);
    console.log("  ✓ PASS: Zero unexpected console errors or runtime exceptions!");

    console.log("\n==================================================================");
    console.log("    ALL CHECKPOINT 3 ROUTING & VIEWER TESTS PASSED!              ");
    console.log("==================================================================");

    ws.close();
  } finally {
    edgeProc.kill();
  }
}

runCp3ViewerTests().catch((err) => {
  console.error("CP3 Tests failed:", err);
  process.exit(1);
});
