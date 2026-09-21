import { spawn } from "child_process";
import fs from "fs";
import path from "path";

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const ARTIFACT_DIR = "C:\\Users\\Huawei\\.gemini\\antigravity\\brain\\1f05e87d-e26f-46aa-95ee-fd6ad75a62e9";

async function capture() {
  console.log("=== CAPTURING 3D VISUAL SANITY SCREENSHOTS ===");

  const edgeProc = spawn(EDGE_PATH, [
    "--headless=new",
    "--remote-debugging-port=9222",
    "--window-size=1600,1000",
    "--no-first-run",
    "--no-default-browser-check",
    "http://localhost:3000",
  ]);

  try {
    // Wait for CDP
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

    console.log("Waiting 6 seconds for WebGL render...");
    await new Promise((r) => setTimeout(r, 6000));

    // 1. Capture Overview Screenshot
    console.log("Capturing Overview screenshot...");
    const shotOverview = await send("Page.captureScreenshot", { format: "png" });
    const overviewPath = path.join(ARTIFACT_DIR, "starlette_city_overview.png");
    fs.writeFileSync(overviewPath, Buffer.from(shotOverview.data, "base64"));
    console.log("Saved overview screenshot to:", overviewPath);

    // Also inspect scene details from browser
    const sceneAnalysis = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const canvas = document.querySelector('canvas');
          if (!canvas) return { error: 'No canvas' };

          return {
            canvasWidth: canvas.clientWidth,
            canvasHeight: canvas.clientHeight,
            pixelRatio: window.devicePixelRatio,
          };
        })()
      `,
      returnByValue: true,
    });
    console.log("Browser Scene Analysis:", sceneAnalysis.result.value);

    // 2. Adjust camera closer to test subdistricts & building terraces
    await send("Runtime.evaluate", {
      expression: `
        (() => {
          const canvas = document.querySelector('canvas');
          // Dispatch wheel events or keyboard to zoom in
          const event = new WheelEvent('wheel', {
            deltaY: -800,
            clientX: 800,
            clientY: 500,
            bubbles: true,
          });
          canvas.dispatchEvent(event);
        })()
      `,
    });

    await new Promise((r) => setTimeout(r, 1000));
    console.log("Capturing Closer Angled screenshot...");
    const shotCloser = await send("Page.captureScreenshot", { format: "png" });
    const closerPath = path.join(ARTIFACT_DIR, "starlette_city_closer.png");
    fs.writeFileSync(closerPath, Buffer.from(shotCloser.data, "base64"));
    console.log("Saved closer screenshot to:", closerPath);

    ws.close();
    console.log("Screenshot capture completed successfully!");
  } finally {
    edgeProc.kill();
  }
}

capture().catch((err) => {
  console.error("Capture failed:", err);
  process.exit(1);
});
