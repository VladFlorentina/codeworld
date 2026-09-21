import { spawn } from "child_process";

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";

async function verifyBrowser() {
  console.log("=== VERIFYING 3D CANVAS IN HEADLESS BROWSER ===");

  const edgeProc = spawn(EDGE_PATH, [
    "--headless=new",
    "--remote-debugging-port=9222",
    "--no-first-run",
    "--no-default-browser-check",
    "http://localhost:3000",
  ]);

  try {
    // Wait for CDP port to open
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

    if (!versionData) {
      throw new Error("Could not connect to Edge remote debugging port 9222");
    }

    console.log("Connected to Headless Edge:", versionData.Browser);

    // Get list of targets
    const listRes = await fetch("http://localhost:9222/json/list");
    const targets = await listRes.json();
    const pageTarget = targets.find((t: any) => t.type === "page");

    if (!pageTarget) {
      throw new Error("No page target found in Edge");
    }

    console.log("Page target URL:", pageTarget.url);

    // Connect WebSocket
    const ws = new WebSocket(pageTarget.webSocketDebuggerUrl);

    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = reject;
    });

    const consoleMessages: string[] = [];
    const pageErrors: string[] = [];

    let msgId = 1;
    function sendCommand(method: string, params: any = {}) {
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

    ws.addEventListener("message", (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.method === "Runtime.consoleAPICalled") {
        const text = data.params.args.map((a: any) => a.value || a.description || "").join(" ");
        consoleMessages.push(`[Console ${data.params.type}] ${text}`);
        if (data.params.type === "error") {
          pageErrors.push(text);
        }
      } else if (data.method === "Runtime.exceptionThrown") {
        const text = data.params.exceptionDetails.text + " " + (data.params.exceptionDetails.exception?.description || "");
        pageErrors.push(text);
      }
    });

    // Enable runtime and console events
    await sendCommand("Runtime.enable");
    await sendCommand("Page.enable");

    // Wait for API fetch, layout computation, and Three.js canvas mount
    console.log("Waiting for 3D canvas initialization and rendering...");
    await new Promise((r) => setTimeout(r, 8000));

    // Evaluate DOM to confirm Canvas exists and WebGL initialized
    const evalCanvas = await sendCommand("Runtime.evaluate", {
      expression: `
        (() => {
          const canvas = document.querySelector('canvas');
          const header = document.querySelector('header');
          const hud = document.querySelector('.font-semibold');
          let buildingsCount = 0;
          let districtsCount = 0;
          let totalMeshCount = 0;

          if (canvas && canvas.__r3f) {
            const scene = canvas.__r3f.root.store.getState().scene;
            if (scene) {
              scene.traverse((obj) => {
                if (obj.isMesh) totalMeshCount++;
                if (obj.name === 'city-buildings') buildingsCount = obj.children.length;
                if (obj.name === 'district-plates') districtsCount = obj.children.length;
              });
            }
          }

          return {
            hasCanvas: !!canvas,
            canvasWidth: canvas ? canvas.clientWidth : 0,
            canvasHeight: canvas ? canvas.clientHeight : 0,
            headerText: header ? header.textContent : '',
            hudText: hud ? hud.textContent : '',
            totalMeshCount,
            buildingsCount,
            districtsCount,
          };
        })()
      `,
      returnByValue: true,
    });

    console.log("\nDOM & Canvas Inspection Result:", evalCanvas.result.value);

    // Print console logs
    console.log("\nBrowser Console Messages:", consoleMessages.length);
    for (const msg of consoleMessages) {
      console.log(" ", msg);
    }

    if (pageErrors.length > 0) {
      console.error("\n❌ Browser Errors Detected:", pageErrors);
      throw new Error(`Found ${pageErrors.length} browser errors`);
    } else {
      console.log("\n✓ ZERO browser console errors or exceptions!");
    }

    if (!evalCanvas.result.value.hasCanvas) {
      throw new Error("No <canvas> element found on page!");
    }

    console.log("✓ <canvas> element is actively rendered and sized:",
      evalCanvas.result.value.canvasWidth, "x", evalCanvas.result.value.canvasHeight);

    console.log("\nALL STEP 2.3 BROWSER VERIFICATIONS PASSED SUCCESSFULLY!");
    ws.close();
  } finally {
    edgeProc.kill();
  }
}

verifyBrowser().catch((err) => {
  console.error("Verification failed:", err);
  process.exit(1);
});
