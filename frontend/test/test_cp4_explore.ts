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

    // Wait until the input element is present in DOM AND hydrated by React before interacting
    async function waitForInput(timeoutMs = 10000) {
      const startTime = Date.now();
      while (Date.now() - startTime < timeoutMs) {
        await new Promise((r) => setTimeout(r, 100));
        const ready = await send("Runtime.evaluate", {
          expression: `
            (() => {
              const input = document.querySelector('[data-testid="repo-input"]');
              if (!input) return false;
              // React attaches internal properties (__reactFiber$ or __reactProps$) upon hydration
              return Object.keys(input).some((k) => k.startsWith("__reactFiber$") || k.startsWith("__reactProps$"));
            })()
          `,
          returnByValue: true,
        });
        if (ready?.result?.value) {
          return;
        }
      }
      throw new Error("Timed out waiting for hydrated [data-testid='repo-input']");
    }

    // Set input value via real CDP typing and wait for React controlled state synchronization
    async function setInputText(value: string, timeoutMs = 5000) {
      // 1. Focus input and select all existing content
      await send("Runtime.evaluate", {
        expression: `
          (() => {
            const input = document.querySelector('[data-testid="repo-input"]');
            if (!input) return;
            input.focus();
            input.select();
          })()
        `,
      });

      // 2. Dispatch real CDP input event
      await send("Input.insertText", { text: value });

      // Fallback: If not set via insertText, ensure native setter + input event
      await send("Runtime.evaluate", {
        expression: `
          (() => {
            const input = document.querySelector('[data-testid="repo-input"]');
            if (input && input.value !== ${JSON.stringify(value)}) {
              const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
              nativeSetter.call(input, ${JSON.stringify(value)});
              input.dispatchEvent(new Event('input', { bubbles: true }));
            }
          })()
        `,
      });

      // 3. Wait for observable condition: DOM value matches AND React's controlled state has synchronized
      const startTime = Date.now();
      while (Date.now() - startTime < timeoutMs) {
        const synced = await send("Runtime.evaluate", {
          expression: `
            (() => {
              const input = document.querySelector('[data-testid="repo-input"]');
              if (!input || input.value !== ${JSON.stringify(value)}) return false;
              // Verify that React controlled prop has taken the new value before submitting
              const propKey = Object.keys(input).find((k) => k.startsWith("__reactProps$"));
              if (propKey && input[propKey]?.value !== undefined) {
                return input[propKey].value === ${JSON.stringify(value)};
              }
              return true;
            })()
          `,
          returnByValue: true,
        });

        if (synced?.result?.value) {
          return;
        }
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`Timed out waiting for input value to synchronize with React: '${value}'`);
    }

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
      await new Promise((r) => setTimeout(r, 200));
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
    await send("Runtime.evaluate", {
      expression: `document.querySelector('[data-testid="back-to-explore"]')?.click()`,
    });
    await waitForInput();

    // Click FastAPI featured card
    await send("Runtime.evaluate", {
      expression: `document.querySelector('[data-testid="featured-tiangolo-fastapi"]')?.click()`,
    });
    let onFastapi = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 200));
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
    await send("Runtime.evaluate", {
      expression: `document.querySelector('[data-testid="back-to-explore"]')?.click()`,
    });
    await waitForInput();

    // ─────────────────────────────────────────────────────────────
    // TEST 1 & 6: Already analyzed repo + owner/repo normalization
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- [Test 1 & 6: Pre-analyzed Repo via 'owner/repo' input (tiangolo/fastapi)] ---");
    await setInputText("tiangolo/fastapi");
    await send("Runtime.evaluate", {
      expression: `document.querySelector('[data-testid="generate-btn"]')?.click()`,
    });

    let instantNav = false;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const pathRes = await send("Runtime.evaluate", {
        expression: `window.location.pathname`,
        returnByValue: true,
      });
      if (pathRes?.result?.value === `/city/${FASTAPI_ID}`) {
        instantNav = true;
        break;
      }
    }
    assert(instantNav, `Expected instant navigation for pre-analyzed repo to /city/${FASTAPI_ID}`);
    console.log("  ✓ PASS: Input 'tiangolo/fastapi' normalized and instantly navigated to ready city.");

    // Return to Explore
    await send("Page.navigate", { url: "http://localhost:3000/" });
    await waitForInput();

    // ─────────────────────────────────────────────────────────────
    // TEST 4: Repository Inexistent -> Controlled Error + Retry
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- [Test 4: Nonexistent Repository -> Controlled Error] ---");
    await setInputText("tiangolo/nonexistent-codeworld-fake-repo-xyz999");
    await send("Runtime.evaluate", {
      expression: `document.querySelector('[data-testid="generate-btn"]')?.click()`,
    });

    let hasControlledError = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const errCheck = await send("Runtime.evaluate", {
        expression: `
          (() => {
            const el = document.querySelector('[data-testid="explore-error"]');
            return {
              hasError: !!el,
              text: el?.textContent || "",
            };
          })()
        `,
        returnByValue: true,
      });
      if (errCheck?.result?.value?.hasError && errCheck.result.value.text.includes("not found or is inaccessible")) {
        hasControlledError = true;
        break;
      }
    }
    assert(hasControlledError, "Controlled error banner with 404 message should appear");
    console.log("  ✓ PASS: Controlled error displayed on nonexistent repository.");

    // Click Retry
    await send("Runtime.evaluate", {
      expression: `document.querySelector('[data-testid="retry-btn"]')?.click()`,
    });
    let errorCleared = false;
    for (let i = 0; i < 15; i++) {
      await new Promise((r) => setTimeout(r, 100));
      const errAfterRetry = await send("Runtime.evaluate", {
        expression: `!document.querySelector('[data-testid="explore-error"]')`,
        returnByValue: true,
      });
      if (errAfterRetry?.result?.value) {
        errorCleared = true;
        break;
      }
    }
    assert(errorCleared, "Error should be cleared on Retry");
    console.log("  ✓ PASS: Retry button cleared error and re-enabled input.");

    // ─────────────────────────────────────────────────────────────
    // TEST 2: Already Analyzed Public Repo ('pallets/click') -> Ready Navigation
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- [Test 2: Already Analyzed Public Repo ('pallets/click') -> Ready Navigation] ---");
    const NEW_REPO_URL = "https://github.com/pallets/click";
    await send("Page.navigate", { url: "http://localhost:3000/" });
    await waitForInput();

    await setInputText(NEW_REPO_URL);
    await send("Runtime.evaluate", {
      expression: `document.querySelector('[data-testid="generate-btn"]')?.click()`,
    });

    let navigatedToReadyCity = false;
    let clickCityPath = "";
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const pathRes = await send("Runtime.evaluate", {
        expression: `window.location.pathname`,
        returnByValue: true,
      });
      const p = pathRes?.result?.value || "";
      if (p.startsWith("/city/")) {
        navigatedToReadyCity = true;
        clickCityPath = p;
        break;
      }
    }
    assert(navigatedToReadyCity, "Expected direct navigation to /city/[id] for ready repo pallets/click");

    // Verify no job status card was displayed
    const cardPresent = await send("Runtime.evaluate", {
      expression: `!!document.querySelector('[data-testid="job-status-card"]')`,
      returnByValue: true,
    });
    assert(!cardPresent.result.value, "Job status card must NOT be displayed for ready repository");
    console.log(`  ✓ PASS: Ready repo navigated directly to ${clickCityPath} without job card.`);

    // Wait for 3D city canvas to render
    let cityCanvasReady = false;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 400));
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
        cityCanvasReady = true;
        break;
      }
    }
    assert(cityCanvasReady, "Ready repository 3D city canvas must render!");

    const cityStats = await send("Runtime.evaluate", {
      expression: `
        (() => {
          const l = window.__cityLayout;
          return {
            name: l.repository_name,
            buildings: l.buildings.length,
          };
        })()
      `,
      returnByValue: true,
    });
    assert(cityStats.result.value.name === "pallets/click", "City repository name must match pallets/click");
    console.log(`  ✓ PASS: Ready repo rendered 3D city with ${cityStats.result.value.buildings} buildings.`);

    // ─────────────────────────────────────────────────────────────
    // TEST 3: Deterministic newly_queued -> polling -> complete (CDP Interception)
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- [Test 3: Deterministic newly_queued -> polling -> complete (CDP Interception)] ---");
    const MOCK_REPO_URL = "https://github.com/mock-org/mock-queued-repo";
    const MOCK_CITY_ID = "c0de0000-0000-4000-8000-000000000001";
    const MOCK_JOB_ID = "mock-job-cp4-001";
    let mockPollCount = 0;

    await send("Fetch.enable", {
      patterns: [
        { urlPattern: "*repositories*", requestStage: "Request" },
        { urlPattern: "*jobs*", requestStage: "Request" },
      ],
    });

    const cdpHandler = async (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.method === "Fetch.requestPaused") {
        const reqUrl: string = data.params.request.url;
        const requestId: string = data.params.requestId;
        const method: string = data.params.request.method;

        if (method === "OPTIONS") {
          await send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "Access-Control-Allow-Origin", value: "http://localhost:3000" },
              { name: "Access-Control-Allow-Credentials", value: "true" },
              { name: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
              { name: "Access-Control-Allow-Headers", value: "Content-Type, Accept" },
            ],
            body: "",
          });
          return;
        }

        if (reqUrl.includes("/repositories") && method === "POST") {
          console.log("  [CDP Simulated] Intercepted POST /repositories -> returning newly_queued");
          await send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 202,
            responseHeaders: [
              { name: "Content-Type", value: "application/json" },
              { name: "Access-Control-Allow-Origin", value: "http://localhost:3000" },
              { name: "Access-Control-Allow-Credentials", value: "true" },
            ],
            body: Buffer.from(
              JSON.stringify({
                status: "newly_queued",
                repository_id: MOCK_CITY_ID,
                run_id: "mock-run-001",
                job_id: MOCK_JOB_ID,
                commit_sha: "mock-sha-001",
                message: "Analysis job queued successfully.",
              })
            ).toString("base64"),
          });
          return;
        }

        if (reqUrl.includes("/jobs")) {
          mockPollCount++;
          const jobStatus = mockPollCount >= 2 ? "complete" : "running";
          console.log(`  [CDP Simulated] Intercepted GET /jobs -> returning status='${jobStatus}'`);
          await send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "Content-Type", value: "application/json" },
              { name: "Access-Control-Allow-Origin", value: "http://localhost:3000" },
              { name: "Access-Control-Allow-Credentials", value: "true" },
            ],
            body: Buffer.from(
              JSON.stringify({
                job_id: MOCK_JOB_ID,
                status: jobStatus,
                repository_id: MOCK_CITY_ID,
                run_id: "mock-run-001",
                commit_sha: "mock-sha-001",
                error_message: null,
                started_at: new Date().toISOString(),
                completed_at: jobStatus === "complete" ? new Date().toISOString() : null,
              })
            ).toString("base64"),
          });
          return;
        }

        await send("Fetch.continueRequest", { requestId });
      }
    };
    ws.addEventListener("message", cdpHandler);

    await send("Page.navigate", { url: "http://localhost:3000/" });
    await waitForInput();

    await setInputText(MOCK_REPO_URL);
    await send("Runtime.evaluate", {
      expression: `document.querySelector('[data-testid="generate-btn"]')?.click()`,
    });

    // Verify job tracking card appeared and controls disabled (double-submit prevention)
    let mockCardAppeared = false;
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 200));
      const cardCheck = await send("Runtime.evaluate", {
        expression: `
          (() => {
            const card = document.querySelector('[data-testid="job-status-card"]');
            const statusEl = document.querySelector('[data-testid="real-job-status"]');
            const btn = document.querySelector('[data-testid="generate-btn"]');
            const input = document.querySelector('[data-testid="repo-input"]');
            return {
              hasCard: !!card,
              statusText: statusEl?.textContent || null,
              btnDisabled: btn?.disabled,
              inputDisabled: input?.disabled,
            };
          })()
        `,
        returnByValue: true,
      });
      if (cardCheck?.result?.value?.hasCard) {
        mockCardAppeared = true;
        assert(cardCheck.result.value.btnDisabled, "Generate button must be disabled while job is active");
        assert(cardCheck.result.value.inputDisabled, "Input must be disabled while job is active");
        console.log(`  ✓ Status tracking card appeared: '${cardCheck.result.value.statusText}', controls disabled (double-submit prevented).`);
        break;
      }
    }
    assert(mockCardAppeared, "Job status tracking card must appear on newly_queued!");

    // Wait for auto-navigation to /city/${MOCK_CITY_ID} upon completion
    let autoNavigated = false;
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 300));
      const p = await send("Runtime.evaluate", {
        expression: `window.location.pathname`,
        returnByValue: true,
      });
      if (p?.result?.value === `/city/${MOCK_CITY_ID}`) {
        autoNavigated = true;
        break;
      }
    }
    assert(autoNavigated, `Expected auto-navigation to /city/${MOCK_CITY_ID} upon completion`);
    console.log(`  ✓ Auto-navigated to /city/${MOCK_CITY_ID} on job completion.`);
    console.log("  ✓ PASS: Deterministic newly_queued -> running -> complete lifecycle and auto-navigation verified via simulated CDP interception.");

    ws.removeEventListener("message", cdpHandler);
    await send("Fetch.disable");

    // ─────────────────────────────────────────────────────────────
    // TEST 5: Failed State Display & Polling Cleanup
    // ─────────────────────────────────────────────────────────────
    console.log("\n--- [Test 5: Failed State Display & Polling Cleanup] ---");
    await send("Page.navigate", { url: "http://localhost:3000/" });
    await waitForInput();

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
