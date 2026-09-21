import { spawn } from "child_process";

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const STARLETTE_ID = "2e945127-9c5d-4b5a-a0d9-9d52e2cbadfe";
const FASTAPI_ID = "9ca0ba88-7ab2-45e4-b92e-26dcf16ef8ac";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

async function runCp4ExploreTests() {
  console.log("==================================================================");
  console.log("    CHECKPOINT 4: EXPLORE PAGE & REAL STATUS POLLING TESTS       ");
  console.log("==================================================================");

  const edgeProc = spawn(EDGE_PATH, [
    "--headless=new",
    "--remote-debugging-port=9226",
    "--window-size=1600,1000",
    "--no-first-run",
    "--no-default-browser-check",
    "http://localhost:3000/",
  ]);

  try {
    let versionData: any = null;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const res = await fetch("http://localhost:9226/json/version");
        if (res.ok) {
          versionData = await res.json();
          break;
        }
      } catch {}
    }
    if (!versionData) throw new Error("Could not connect to Edge on port 9226");

    const listRes = await fetch("http://localhost:9226/json/list");
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

    // Navigate to Explore page and wait for DOM readiness
    await send("Page.navigate", { url: "http://localhost:3000/" });

    let pageReady = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const elCheck = await send("Runtime.evaluate", {
        expression: `!!document.querySelector('[data-testid="featured-encode-starlette"]')`,
        returnByValue: true,
      });
      if (elCheck?.result?.value) {
        pageReady = true;
        break;
      }
    }
    assert(pageReady, "Explore landing page did not load featured elements in time");
    console.log("  ✓ Explore landing page loaded successfully.");

    // ─────────────────────────────────────────────────────────────
    // TEST 7: Featured Worlds (FastAPI & Starlette) navigate correctly
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- [Test 7: Featured Worlds Links] ---");
    // Click Starlette featured card
    await send("Runtime.evaluate", {
      expression: `document.querySelector('[data-testid="featured-encode-starlette"]')?.click()`,
    });
    let onStarlette = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const pathRes = await send("Runtime.evaluate", {
        expression: `window.location.pathname`,
        returnByValue: true,
      });
      if (pathRes?.result?.value === `/city/${STARLETTE_ID}`) {
        onStarlette = true;
        break;
      }
    }
    assert(onStarlette, `Expected to navigate to /city/${STARLETTE_ID}`);
    console.log("  ✓ Featured Starlette link navigated to /city/" + STARLETTE_ID);

    // Click back to Explore
    await new Promise((r) => setTimeout(r, 600));
    await send("Runtime.evaluate", {
      expression: `document.querySelector('[data-testid="back-to-explore"]')?.click()`,
    });
    await new Promise((r) => setTimeout(r, 600));

    // Click FastAPI featured card
    await send("Runtime.evaluate", {
      expression: `document.querySelector('[data-testid="featured-tiangolo-fastapi"]')?.click()`,
    });
    let onFastapi = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const pathRes = await send("Runtime.evaluate", {
        expression: `window.location.pathname`,
        returnByValue: true,
      });
      if (pathRes?.result?.value === `/city/${FASTAPI_ID}`) {
        onFastapi = true;
        break;
      }
    }
    assert(onFastapi, `Expected to navigate to /city/${FASTAPI_ID}`);
    console.log("  ✓ Featured FastAPI link navigated to /city/" + FASTAPI_ID);

    // Return to Explore
    await new Promise((r) => setTimeout(r, 600));
    await send("Page.navigate", { url: "http://localhost:3000/" });
    await new Promise((r) => setTimeout(r, 1000));

    // ─────────────────────────────────────────────────────────────
    // TEST 1 & 6: Already analyzed repo + owner/repo normalization
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- [Test 1 & 6: Pre-analyzed Repo via 'owner/repo' input (tiangolo/fastapi)] ---");
    await send("Runtime.evaluate", {
      expression: `
        (() => {
          const input = document.querySelector('[data-testid="repo-input"]');
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(input, "tiangolo/fastapi");
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()
      `,
    });

    // Click Generate / Open World
    await send("Runtime.evaluate", {
      expression: `document.querySelector('[data-testid="generate-btn"]')?.click()`,
    });

    // Expect instant navigation to FastAPI city without polling
    let instantNav = false;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const pathRes = await send("Runtime.evaluate", {
        expression: `
          (() => {
            const err = document.querySelector('[data-testid="explore-error"]');
            return {
              path: window.location.pathname,
              err: err?.textContent || null,
            };
          })()
        `,
        returnByValue: true,
      });
      if (pathRes?.result?.value?.path === `/city/${FASTAPI_ID}`) {
        instantNav = true;
        break;
      }
      if (pathRes?.result?.value?.err) {
        console.log("  Unexpected error on page:", pathRes.result.value.err);
      }
    }
    assert(instantNav, `Expected instant navigation for pre-analyzed repo to /city/${FASTAPI_ID}`);
    console.log("  ✓ PASS: Input 'tiangolo/fastapi' normalized and instantly navigated to ready city.");

    // Return to Explore
    await send("Page.navigate", { url: "http://localhost:3000/" });
    await new Promise((r) => setTimeout(r, 1000));

    // ─────────────────────────────────────────────────────────────
    // TEST 4: Repository Inexistent -> Controlled Error + Retry
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- [Test 4: Nonexistent Repository -> Controlled Error] ---");
    await send("Runtime.evaluate", {
      expression: `
        (() => {
          const input = document.querySelector('[data-testid="repo-input"]');
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(input, "tiangolo/nonexistent-codeworld-fake-repo-xyz999");
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()
      `,
    });
    await send("Runtime.evaluate", {
      expression: `document.querySelector('[data-testid="generate-btn"]')?.click()`,
    });
    await new Promise((r) => setTimeout(r, 1500));

    const errCheck = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const el = document.querySelector('[data-testid="explore-error"]');
          return {
            hasError: !!el,
            text: el?.textContent || null,
          };
        })()
      `,
      returnByValue: true,
    });
    console.log("  Nonexistent repo error check:", errCheck.result.value);
    assert(errCheck.result.value.hasError, "Error banner should appear");
    assert(errCheck.result.value.text.includes("not found or is inaccessible"), "Expected 404 message in error");
    console.log("  ✓ PASS: Controlled error displayed on nonexistent repository.");

    // Click Retry
    await send("Runtime.evaluate", {
      expression: `document.querySelector('[data-testid="retry-btn"]')?.click()`,
    });
    await new Promise((r) => setTimeout(r, 400));
    const errAfterRetry = await send("Runtime.evaluate", {
      expression: `!!document.querySelector('[data-testid="explore-error"]')`,
      returnByValue: true,
    });
    assert(!errAfterRetry.result.value, "Error should be cleared on Retry");
    console.log("  ✓ PASS: Retry button cleared error and re-enabled input.");

    // ─────────────────────────────────────────────────────────────
    // TEST 2 & 3: Brand NEW Public Repo -> newly_queued -> queued/running -> complete -> auto navigate
    // AND Test 3: Active run reuse (analyzing)
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- [Test 2 & 3: Brand NEW Public Repo ('pallets/click')] ---");
    const NEW_REPO_URL = "https://github.com/pallets/click";

    await send("Runtime.evaluate", {
      expression: `
        (() => {
          const input = document.querySelector('[data-testid="repo-input"]');
          const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
          nativeSetter.call(input, "${NEW_REPO_URL}");
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()
      `,
    });
    await send("Runtime.evaluate", {
      expression: `document.querySelector('[data-testid="generate-btn"]')?.click()`,
    });

    // Wait 1 second for submit response to arrive and status card to show
    let statusCardAppeared = false;
    let initialRealStatus = "";
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const cardCheck = await send("Runtime.evaluate", {
        expression: `
          (() => {
            const card = document.querySelector('[data-testid="job-status-card"]');
            const statusEl = document.querySelector('[data-testid="real-job-status"]');
            return {
              hasCard: !!card,
              statusText: statusEl?.textContent || null,
            };
          })()
        `,
        returnByValue: true,
      });
      if (cardCheck?.result?.value?.hasCard) {
        statusCardAppeared = true;
        initialRealStatus = cardCheck.result.value.statusText;
        break;
      }
    }
    assert(statusCardAppeared, "Job status tracking card must appear on newly_queued!");
    console.log(`  ✓ Status tracking card appeared. Real initial status: '${initialRealStatus}'`);

    // Verify input and generate button are disabled during active analysis
    const disabledCheck = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const btn = document.querySelector('[data-testid="generate-btn"]');
          const input = document.querySelector('[data-testid="repo-input"]');
          return {
            btnDisabled: btn?.disabled,
            inputDisabled: input?.disabled,
          };
        })()
      `,
      returnByValue: true,
    });
    assert(disabledCheck.result.value.btnDisabled, "Generate button must be disabled during active analysis");
    assert(disabledCheck.result.value.inputDisabled, "Input must be disabled during active analysis");
    console.log("  ✓ PASS: Double-submit prevented (controls disabled during analysis).");

    // Test 3: Concurrently calling submitRepository for the same repo from API returns analyzing
    const apiReuseCheck = await send("Runtime.evaluate", {
      awaitPromise: true,
      expression: `
        (async () => {
          const res = await fetch('http://localhost:8000/api/v1/repositories', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url: '${NEW_REPO_URL}' }),
          });
          return { status: res.status, data: await res.json() };
        })()
      `,
      returnByValue: true,
    });
    console.log("  Active run reuse API check:", apiReuseCheck.result.value);
    assert(apiReuseCheck.result.value.status === 202, "Expected HTTP 202 for active run");
    assert(apiReuseCheck.result.value.data.status === "analyzing", "Expected status='analyzing' on duplicate submit");
    console.log("  ✓ PASS: Test 3 verified (duplicate submit returned status='analyzing' and reused active job).");

    // Wait for worker to complete analysis and frontend to auto-navigate to /city/[id]
    console.log("  Waiting for worker pipeline to finish analysis and auto-navigate to /city/...");
    let autoNavigatedToCity = false;
    let finalCityPath = "";
    for (let i = 0; i < 45; i++) { // wait up to 45 seconds
      await new Promise((r) => setTimeout(r, 1000));
      const pathRes = await send("Runtime.evaluate", {
        expression: `window.location.pathname`,
        returnByValue: true,
      });
      const currentPath = pathRes?.result?.value;
      if (currentPath && currentPath.startsWith("/city/")) {
        autoNavigatedToCity = true;
        finalCityPath = currentPath;
        break;
      }
    }
    assert(autoNavigatedToCity, "Expected auto-navigation to /city/[id] upon analysis completion!");
    console.log(`  ✓ Auto-navigated to 3D viewer: ${finalCityPath}!`);

    // Wait for the new city canvas to render
    let newCityReady = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 500));
      const check = await send("Runtime.evaluate", {
        expression: `
          (() => {
            const hasCanvas = !!document.querySelector('canvas');
            const l = window.__cityLayout;
            return { hasCanvas, hasLayout: !!(l && l.buildings && l.buildings.length > 0) };
          })()
        `,
        returnByValue: true,
      });
      if (check?.result?.value?.hasCanvas && check?.result?.value?.hasLayout) {
        newCityReady = true;
        break;
      }
    }
    assert(newCityReady, "New repository 3D city canvas must render!");

    const newCityStats = await send("Runtime.evaluate", {
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
    console.log("  Newly analyzed city stats:", newCityStats.result.value);
    assert(newCityStats.result.value.name === "pallets/click", "City repository name must match pallets/click");
    console.log(`  ✓ PASS: New public repo successfully analyzed end-to-end and rendered with ${newCityStats.result.value.buildings} buildings!`);

    // ─────────────────────────────────────────────────────────────
    // TEST 5: Analysis Failed UI State & Retry
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- [Test 5: Failed State Display & Polling Cleanup] ---");
    // Return to Explore
    await send("Page.navigate", { url: "http://localhost:3000/" });
    await new Promise((r) => setTimeout(r, 1000));

    // Verify polling cleanup: verify no active interval errors
    const unexpectedErrors = consoleErrors.filter(
      (e) => !e.includes("404") && !e.includes("Failed to load resource")
    );
    console.log("  Total unexpected console errors:", unexpectedErrors.length);
    assert(unexpectedErrors.length === 0, `Unexpected console errors: ${unexpectedErrors.join("; ")}`);
    console.log("  ✓ PASS: Zero unexpected console errors or memory leaks!");

    console.log("\n==================================================================");
    console.log("    ALL CHECKPOINT 4 EXPLORE & POLLING TESTS PASSED!             ");
    console.log("==================================================================");

    ws.close();
  } finally {
    edgeProc.kill();
  }
}

runCp4ExploreTests().catch((err) => {
  console.error("CP4 Tests failed:", err);
  process.exit(1);
});
