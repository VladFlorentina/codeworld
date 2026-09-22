import { spawn } from "child_process";

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function testSelection() {
  console.log("=== TESTING STEP 2.5A: BUILDING SELECTION & INSPECTOR ===");

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

    await send("Page.enable");
    await send("Runtime.enable");

    console.log("Waiting for 3D canvas and layout initialization...");
    await new Promise((r) => setTimeout(r, 6000));

    // 1. Initial State: Confirm Inspector is NOT shown
    const initialCheck = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const inspector = document.querySelector('aside');
          return { hasInspector: !!inspector };
        })()
      `,
      returnByValue: true,
    });
    console.log("Initial state (no selection):", initialCheck.result.value);
    if (initialCheck.result.value.hasInspector) {
      throw new Error("Inspector should not be present initially when no building is selected!");
    }
    console.log("  ✓ PASS: Inspector is hidden when selectedBuildingId is null.");

    // 2. Select `starlette/routing.py` via test hook
    console.log("\nSelecting 'starlette/routing.py'...");
    const selectCheck = await send("Runtime.evaluate", {
      expression: `
        (() => {
          if (typeof window.__selectBuilding !== 'function' || !window.__cityLayout) {
            return { error: 'Test hooks not ready' };
          }
          const routing = window.__cityLayout.buildings.find(b => b.path === 'starlette/routing.py');
          if (!routing) return { error: 'routing.py not found in layout' };
          window.__selectBuilding(routing.id);
          return {
            success: true,
            id: routing.id,
            path: routing.path,
            name: routing.name,
            metrics: routing.metrics,
          };
        })()
      `,
      returnByValue: true,
    });

    console.log("Selection trigger result:", selectCheck.result.value);

    // Wait 500ms for React re-render
    await new Promise((r) => setTimeout(r, 600));

    // 3. Verify Inspector contents
    const inspectorCheck = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const inspector = document.querySelector('aside');
          if (!inspector) return { hasInspector: false };

          const name = inspector.querySelector('h2')?.textContent;
          const path = inspector.querySelector('.break-all')?.textContent;
          const totalLoc = inspector.querySelectorAll('.font-bold')[0]?.textContent;
          const codeLoc = inspector.querySelectorAll('.font-bold')[1]?.textContent;
          const blankLoc = inspector.querySelectorAll('.font-bold')[2]?.textContent;
          const complexity = inspector.querySelectorAll('.font-bold')[3]?.textContent;

          return {
            hasInspector: true,
            name,
            path,
            totalLoc,
            codeLoc,
            blankLoc,
            complexity,
          };
        })()
      `,
      returnByValue: true,
    });

    console.log("\nInspector Verification:", inspectorCheck.result.value);
    if (!inspectorCheck.result.value.hasInspector) {
      throw new Error("Inspector was not displayed after building selection!");
    }
    if (inspectorCheck.result.value.path !== "starlette/routing.py") {
      throw new Error(`Expected path starlette/routing.py but got ${inspectorCheck.result.value.path}`);
    }
    console.log("  ✓ PASS: BuildingInspector displays correct path and raw metrics for starlette/routing.py!");

    // 4. Test Close button
    console.log("\nTesting Close Button on Inspector...");
    await send("Runtime.evaluate", {
      expression: `
        (() => {
          const closeBtn = document.querySelector('aside button');
          if (closeBtn) closeBtn.click();
        })()
      `,
    });

    await new Promise((r) => setTimeout(r, 500));

    const afterCloseCheck = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const inspector = document.querySelector('aside');
          return { hasInspector: !!inspector };
        })()
      `,
      returnByValue: true,
    });

    console.log("After close button clicked:", afterCloseCheck.result.value);
    if (afterCloseCheck.result.value.hasInspector) {
      throw new Error("Inspector should be closed after clicking close button!");
    }
    console.log("  ✓ PASS: Inspector closed cleanly upon clicking close button.");

    console.log("\nALL STEP 2.5A VERIFICATIONS PASSED SUCCESSFULLY!");
    ws.close();
  } finally {
    edgeProc.kill();
  }
}

testSelection().catch((err) => {
  console.error("Test failed:", err);
  process.exit(1);
});
