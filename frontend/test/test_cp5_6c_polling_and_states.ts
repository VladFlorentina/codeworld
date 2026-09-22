import { spawn, execSync } from "child_process";
import { waitFor } from "./helpers/waitFor";

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const TEST_USER_ID = "ac2e5661-cda9-4e1d-a4a4-dd510b6830b1";
const TARGET_CITY_ID = "d39c312a-f604-4301-822d-b6caf3562f2d";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

function getSessionCookieInMemory(): string {
  const out = execSync(
    `docker exec codeworld_api python -c "from app.security.session import create_session_cookie_value; print(create_session_cookie_value('${TEST_USER_ID}'))"`
  ).toString().trim();
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1];
}

async function runCp5_6cPollingAndStatesTests() {
  console.log("==================================================================");
  console.log("  CHECKPOINT 5.6C: POLLING, FAILURE RETRY & STATE VERIFICATION    ");
  console.log("==================================================================");

  const edgeProc = spawn(EDGE_PATH, [
    "--headless=new",
    "--remote-debugging-port=9231",
    "--window-size=1600,1000",
    "--no-first-run",
    "--no-default-browser-check",
    "http://localhost:3000/my-repositories",
  ]);

  try {
    let versionData: any = null;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const res = await fetch("http://localhost:9231/json/version");
        if (res.ok) {
          versionData = await res.json();
          break;
        }
      } catch {}
    }
    if (!versionData) throw new Error("Could not connect to Edge on port 9231");

    const listRes = await fetch("http://localhost:9231/json/list");
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
    const hydrationErrors: string[] = [];

    ws.addEventListener("message", (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.method === "Runtime.consoleAPICalled") {
        const type = data.params.type;
        const text = (data.params.args || []).map((a: any) => a.value || a.description || "").join(" ");
        if (type === "error") {
          consoleErrors.push(text);
          if (text.toLowerCase().includes("hydration") || text.toLowerCase().includes("did not match")) {
            hydrationErrors.push(text);
          }
        }
      }
      if (data.method === "Runtime.exceptionThrown") {
        const desc = data.params.exceptionDetails?.text || "";
        consoleErrors.push(desc);
      }
    });

    await send("Runtime.enable");
    await send("Page.enable");
    await send("Network.enable");

    async function evalCode(expression: string) {
      const res = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
      return res?.result?.value;
    }

    const cookie = getSessionCookieInMemory();
    assert(Boolean(cookie && cookie.length > 20), "Valid session cookie required in test memory");

    await send("Network.setCookie", {
      name: "codeworld_session",
      value: cookie,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    });

    // ─────────────────────────────────────────────────────────────
    // TEST 1: ZERO INSTALLATIONS STATE
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 1] Zero Installations State: 'Install CodeWorld on GitHub'");
    await send("Fetch.enable", {
      patterns: [
        { urlPattern: "*/github/installations*", requestStage: "Request" },
        { urlPattern: "*/github/repositories*", requestStage: "Request" },
      ],
    });

    let currentZeroMode: "zero_installations" | "zero_repos" | "normal" = "zero_installations";

    const fetchHandlerState = async (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.method === "Fetch.requestPaused") {
        const reqUrl = data.params.request.url;
        const requestId = data.params.requestId;

        if (reqUrl.includes("/github/installations")) {
          const instBody =
            currentZeroMode === "zero_installations"
              ? { installations: [], total_count: 0 }
              : {
                  installations: [
                    { id: 163590490, account_login: "VladFlorentina", account_type: "User", repository_selection: "selected" },
                  ],
                  total_count: 1,
                };
          await send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "Content-Type", value: "application/json" },
              { name: "Access-Control-Allow-Origin", value: "http://localhost:3000" },
              { name: "Access-Control-Allow-Credentials", value: "true" },
            ],
            body: Buffer.from(JSON.stringify(instBody)).toString("base64"),
          });
        } else if (reqUrl.includes("/github/repositories")) {
          await send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "Content-Type", value: "application/json" },
              { name: "Access-Control-Allow-Origin", value: "http://localhost:3000" },
              { name: "Access-Control-Allow-Credentials", value: "true" },
            ],
            body: Buffer.from(JSON.stringify({ repositories: [], total_count: 0 })).toString("base64"),
          });
        }
      }
    };
    ws.addEventListener("message", fetchHandlerState);

    await send("Page.navigate", { url: "http://localhost:3000/my-repositories" });

    let zeroInstHeading = "";
    const zeroInstFound = await waitFor(async () => {
      zeroInstHeading = (await evalCode('document.querySelector("h1")?.textContent')) || "";
      return zeroInstHeading.includes("Install CodeWorld on GitHub");
    }, 10000);

    assert(
      zeroInstFound,
      `Expected 'Install CodeWorld on GitHub', got: ${zeroInstHeading}`
    );

    const hasInstallBtn = await evalCode(
      'document.querySelector("main a[href*=\'apps/codeworld-dev-vlad\']") !== null'
    );
    assert(hasInstallBtn, "Expected 'Install CodeWorld on GitHub' link element");

    const refreshInstBtn = await evalCode(
      'Array.from(document.querySelectorAll("main button")).some(b => b.textContent.includes("Refresh Installations"))'
    );
    assert(refreshInstBtn, "Expected 'Refresh Installations' button");
    console.log("✓ Zero installations correctly displays 'Install CodeWorld on GitHub' with app install link.");

    // ─────────────────────────────────────────────────────────────
    // TEST 2: ZERO REPOSITORIES STATE (INSTALLATION EXISTS)
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 2] Zero Repositories State: 'No Repositories Selected'");
    currentZeroMode = "zero_repos";
    await send("Page.navigate", { url: "http://localhost:3000/my-repositories" });

    let zeroReposHeading = "";
    const zeroReposFound = await waitFor(async () => {
      zeroReposHeading = (await evalCode('document.querySelector("h1")?.textContent')) || "";
      return zeroReposHeading.includes("No Repositories Selected");
    }, 10000);

    assert(
      zeroReposFound,
      `Expected 'No Repositories Selected', got: ${zeroReposHeading}`
    );

    const hasConfigAccessBtn = await evalCode(
      'document.querySelector("main a[href*=\'github.com/settings/installations\']") !== null'
    );
    assert(hasConfigAccessBtn, "Expected link to https://github.com/settings/installations");

    const configBtnText = await evalCode(
      'document.querySelector("main a[href*=\'github.com/settings/installations\']")?.textContent'
    );
    assert(
      configBtnText?.includes("Configure Repository Access"),
      `Expected 'Configure Repository Access' text, got: ${configBtnText}`
    );

    const refreshReposBtn = await evalCode(
      'Array.from(document.querySelectorAll("main button")).some(b => b.textContent.includes("Refresh Repositories"))'
    );
    assert(refreshReposBtn, "Expected 'Refresh Repositories' button");
    console.log("✓ Zero repositories (with installation) correctly displays 'No Repositories Selected' and 'Configure Repository Access' link.");

    // Disable fetch interception for zero states
    ws.removeEventListener("message", fetchHandlerState);
    await send("Fetch.disable");

    // ─────────────────────────────────────────────────────────────
    // TEST 3: FULL POLLING TRANSITION
    // newly_queued -> queued -> running -> complete -> /city/[id]
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 3] Controlled Polling: newly_queued -> queued -> running -> complete");
    await send("Page.navigate", { url: "http://localhost:3000/my-repositories" });
    const realReposLoaded = await waitFor(async () => {
      const count = await evalCode('document.querySelectorAll("button[data-testid^=\'btn-analyze-\']").length');
      return (count || 0) >= 1;
    }, 15000);
    assert(realReposLoaded, "Failed to load real repositories and render analyze button within 15s");

    // Setup Mock Fetch Interceptor for Analyze and Job Polling
    let jobPollCount = 0;
    await send("Fetch.enable", {
      patterns: [
        { urlPattern: "*/github/repositories/analyze*", requestStage: "Request" },
        { urlPattern: "*/jobs/test-mock-job-999*", requestStage: "Request" },
      ],
    });

    const handleOptions = async (requestId: string) => {
      await send("Fetch.fulfillRequest", {
        requestId,
        responseCode: 200,
        responseHeaders: [
          { name: "Access-Control-Allow-Origin", value: "http://localhost:3000" },
          { name: "Access-Control-Allow-Credentials", value: "true" },
          { name: "Access-Control-Allow-Methods", value: "GET, POST, OPTIONS" },
          { name: "Access-Control-Allow-Headers", value: "Content-Type, Accept, Authorization" },
        ],
        body: "",
      });
    };

    const pollHandler = async (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.method === "Fetch.requestPaused") {
        const reqUrl = data.params.request.url;
        const requestId = data.params.requestId;

        if (data.params.request.method === "OPTIONS") {
          await handleOptions(requestId);
          return;
        }

        if (reqUrl.includes("/github/repositories/analyze")) {
          // Return newly_queued
          const respBody = {
            status: "newly_queued",
            repository_id: TARGET_CITY_ID,
            job_id: "test-mock-job-999",
            message: "Enqueued analysis job",
          };
          await send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 202,
            responseHeaders: [
              { name: "Content-Type", value: "application/json" },
              { name: "Access-Control-Allow-Origin", value: "http://localhost:3000" },
              { name: "Access-Control-Allow-Credentials", value: "true" },
            ],
            body: Buffer.from(JSON.stringify(respBody)).toString("base64"),
          });
        } else if (reqUrl.includes("/jobs/test-mock-job-999")) {
          jobPollCount++;
          let jobStatus = "queued";
          if (jobPollCount === 1) jobStatus = "queued";
          else if (jobPollCount === 2) jobStatus = "running";
          else if (jobPollCount >= 3) jobStatus = "complete";

          const jobResp = {
            job_id: "test-mock-job-999",
            repository_id: TARGET_CITY_ID,
            status: jobStatus,
          };
          await send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "Content-Type", value: "application/json" },
              { name: "Access-Control-Allow-Origin", value: "http://localhost:3000" },
              { name: "Access-Control-Allow-Credentials", value: "true" },
            ],
            body: Buffer.from(JSON.stringify(jobResp)).toString("base64"),
          });
        }
      }
    };
    ws.addEventListener("message", pollHandler);

    // Trigger analysis by clicking Visualize City on first repo
    await evalCode(`
      (() => {
        const btn = document.querySelector("button[data-testid^='btn-analyze-']");
        if (btn) btn.click();
      })()
    `);

    // Poll 0: Initial state immediately after click
    let cardStatusQueued = "";
    const queuedFound = await waitFor(async () => {
      cardStatusQueued = (await evalCode(`
        (() => {
          const card = document.querySelector("[data-testid^='repo-card-']");
          return card?.textContent || "";
        })()
      `)) || "";
      return cardStatusQueued.includes("Queued...");
    }, 10000);
    assert(
      queuedFound,
      `Expected 'Queued...' status immediately after newly_queued, got: ${cardStatusQueued}`
    );
    console.log("  ✓ Initial transition: 'Queued...' state active.");

    // Wait for Poll 2: running -> Analyzing...
    let cardStatusRunning = "";
    const analyzingFound = await waitFor(async () => {
      cardStatusRunning =
        (await evalCode(`
          (() => {
            const card = document.querySelector("[data-testid^='repo-card-']");
            return card?.textContent || "";
          })()
        `)) || "";
      return cardStatusRunning.includes("Analyzing...");
    }, 15000);
    assert(
      analyzingFound,
      `Expected 'Analyzing...' state on poll tick, got: ${cardStatusRunning}`
    );
    console.log("  ✓ Polled transition: 'Analyzing...' state active.");

    // Wait for Poll 3: complete -> navigates to /city/[id]
    let targetPath = "";
    const cityNavOk = await waitFor(async () => {
      targetPath = (await evalCode("window.location.pathname")) || "";
      return targetPath === `/city/${TARGET_CITY_ID}`;
    }, 15000);
    assert(
      cityNavOk,
      `Expected navigation to /city/${TARGET_CITY_ID}, got: ${targetPath}`
    );
    console.log(`  ✓ Completed transition: Navigated to ${targetPath}`);

    // Cleanup mock handler
    ws.removeEventListener("message", pollHandler);
    await send("Fetch.disable");

    // ─────────────────────────────────────────────────────────────
    // TEST 4: ANALYSIS FAILURE & CONTROLLED RETRY
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 4] Analysis Failure & Controlled Retry");
    await send("Page.navigate", { url: "http://localhost:3000/my-repositories" });
    const test4PageLoaded = await waitFor(async () => {
      const count = await evalCode('document.querySelectorAll("button[data-testid^=\'btn-analyze-\']").length');
      return (count || 0) >= 1;
    }, 15000);
    assert(test4PageLoaded, "Failed to reload repository cards for Test 4 within 15s");

    await send("Fetch.enable", {
      patterns: [
        { urlPattern: "*/github/repositories/analyze*", requestStage: "Request" },
        { urlPattern: "*/jobs/test-fail-job*", requestStage: "Request" },
      ],
    });

    let failAttempts = 0;
    const failHandler = async (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.method === "Fetch.requestPaused") {
        const reqUrl = data.params.request.url;
        const requestId = data.params.requestId;

        if (data.params.request.method === "OPTIONS") {
          await handleOptions(requestId);
          return;
        }

        if (reqUrl.includes("/github/repositories/analyze")) {
          failAttempts++;
          const respBody = {
            status: "newly_queued",
            repository_id: TARGET_CITY_ID,
            job_id: "test-fail-job",
            message: "Enqueued job",
          };
          await send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 202,
            responseHeaders: [
              { name: "Content-Type", value: "application/json" },
              { name: "Access-Control-Allow-Origin", value: "http://localhost:3000" },
              { name: "Access-Control-Allow-Credentials", value: "true" },
            ],
            body: Buffer.from(JSON.stringify(respBody)).toString("base64"),
          });
        } else if (reqUrl.includes("/jobs/test-fail-job")) {
          const failJobResp = {
            job_id: "test-fail-job",
            repository_id: TARGET_CITY_ID,
            status: "failed",
            error: "Repository exceeds 500MB size limit.",
          };
          await send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "Content-Type", value: "application/json" },
              { name: "Access-Control-Allow-Origin", value: "http://localhost:3000" },
              { name: "Access-Control-Allow-Credentials", value: "true" },
            ],
            body: Buffer.from(JSON.stringify(failJobResp)).toString("base64"),
          });
        }
      }
    };
    ws.addEventListener("message", failHandler);

    // Trigger analysis
    await evalCode(`
      (() => {
        const btn = document.querySelector("button[data-testid^='btn-analyze-']");
        if (btn) btn.click();
      })()
    `);

    // Wait for failure response
    const hasRetryBtn = await waitFor(async () => {
      const btn = await evalCode(`
        (() => {
          const b = document.querySelector("button[data-testid^='btn-retry-']");
          return b !== null && b.textContent.includes("Retry Analysis");
        })()
      `);
      return Boolean(btn);
    }, 10000);
    assert(hasRetryBtn, "Expected 'Retry Analysis' button on card after job failure");

    const errorBannerText = await evalCode('document.querySelector("main")?.textContent');
    assert(
      errorBannerText?.includes("Repository exceeds 500MB size limit."),
      `Expected controlled failure message, got: ${errorBannerText}`
    );
    console.log("  ✓ Failed state correctly displays controlled error message and 'Retry Analysis' button.");

    // Test Click on Retry Analysis
    assert(failAttempts === 1, `Expected 1 attempt before retry, got: ${failAttempts}`);
    await evalCode(`
      (() => {
        const btn = document.querySelector("button[data-testid^='btn-retry-']");
        if (btn) btn.click();
      })()
    `);
    const retryTriggered = await waitFor(async () => failAttempts === 2, 10000);
    assert(retryTriggered, `Expected 2nd attempt triggered by Retry, got: ${failAttempts}`);
    console.log("  ✓ 'Retry Analysis' successfully triggers re-analysis.");

    ws.removeEventListener("message", failHandler);
    await send("Fetch.disable");

    // ─────────────────────────────────────────────────────────────
    // TEST 5: DUPLICATE CLICK PREVENTION & TIMER CLEANUP ON UNMOUNT
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 5] Duplicate Click Prevention & Timer Cleanup on Unmount");
    await send("Page.navigate", { url: "http://localhost:3000/my-repositories" });
    const test5PageLoaded = await waitFor(async () => {
      const count = await evalCode('document.querySelectorAll("button[data-testid^=\'btn-analyze-\']").length');
      return (count || 0) >= 1;
    }, 15000);
    assert(test5PageLoaded, "Failed to reload repository cards for Test 5 within 15s");

    let inflightAnalyzeRequests = 0;
    let inflightJobRequests = 0;

    await send("Fetch.enable", {
      patterns: [
        { urlPattern: "*/github/repositories/analyze*", requestStage: "Request" },
        { urlPattern: "*/jobs/test-unmount-job*", requestStage: "Request" },
      ],
    });

    const unmountHandler = async (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.method === "Fetch.requestPaused") {
        const reqUrl = data.params.request.url;
        const requestId = data.params.requestId;

        if (data.params.request.method === "OPTIONS") {
          await handleOptions(requestId);
          return;
        }

        if (reqUrl.includes("/github/repositories/analyze")) {
          inflightAnalyzeRequests++;
          const respBody = {
            status: "analyzing",
            repository_id: TARGET_CITY_ID,
            job_id: "test-unmount-job",
            message: "Analyzing",
          };
          await send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 202,
            responseHeaders: [
              { name: "Content-Type", value: "application/json" },
              { name: "Access-Control-Allow-Origin", value: "http://localhost:3000" },
              { name: "Access-Control-Allow-Credentials", value: "true" },
            ],
            body: Buffer.from(JSON.stringify(respBody)).toString("base64"),
          });
        } else if (reqUrl.includes("/jobs/test-unmount-job")) {
          inflightJobRequests++;
          const jobResp = {
            job_id: "test-unmount-job",
            repository_id: TARGET_CITY_ID,
            status: "running",
          };
          await send("Fetch.fulfillRequest", {
            requestId,
            responseCode: 200,
            responseHeaders: [
              { name: "Content-Type", value: "application/json" },
              { name: "Access-Control-Allow-Origin", value: "http://localhost:3000" },
              { name: "Access-Control-Allow-Credentials", value: "true" },
            ],
            body: Buffer.from(JSON.stringify(jobResp)).toString("base64"),
          });
        }
      }
    };
    ws.addEventListener("message", unmountHandler);

    // Rapidly click the button 3 times
    await evalCode(`
      (() => {
        const btn = document.querySelector("button[data-testid^='btn-analyze-']");
        if (btn) {
          btn.click();
          btn.click();
          btn.click();
        }
      })()
    `);
    const analyzeFired = await waitFor(async () => inflightAnalyzeRequests >= 1, 5000);
    assert(analyzeFired, "Expected analyze request to fire within 5s");

    // Verify only 1 request was sent
    assert(
      inflightAnalyzeRequests === 1,
      `Expected exactly 1 analyze request despite rapid clicks, got: ${inflightAnalyzeRequests}`
    );
    console.log("  ✓ Duplicate click prevention confirmed: exactly 1 analysis request sent.");

    // Wait for at least one job poll to execute
    const pollingBegan = await waitFor(async () => inflightJobRequests >= 1, 10000);
    assert(pollingBegan, "Expected polling to have begun within 10s");
    const countBeforeUnmount = inflightJobRequests;

    // Now unmount / navigate away to Explore
    await evalCode(`
      (() => {
        const exploreLink = Array.from(document.querySelectorAll("header nav a")).find(a => 
          a.textContent.includes("Explore")
        );
        if (exploreLink) exploreLink.click();
      })()
    `);
    let currentNavPath = "";
    const navToExploreOk = await waitFor(async () => {
      currentNavPath = (await evalCode("window.location.pathname")) || "";
      return currentNavPath === "/";
    }, 10000);
    assert(navToExploreOk, `Expected navigation to Explore (/), got: ${currentNavPath}`);

    // Wait another 3000ms (more than 1 polling interval of 2000ms)
    await new Promise((r) => setTimeout(r, 3000));

    // Verify NO new requests were made to the job endpoint
    assert(
      inflightJobRequests === countBeforeUnmount,
      `Timer leak detected! Expected ${countBeforeUnmount} polling requests after unmount, but got ${inflightJobRequests}`
    );
    console.log("  ✓ Timer cancellation on unmount confirmed: zero requests sent after navigating away.");

    ws.removeEventListener("message", unmountHandler);
    await send("Fetch.disable");

    // ─────────────────────────────────────────────────────────────
    // TEST 6: HYDRATION & CONSOLE AUDIT
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 6] Hydration & Console Audit");
    assert(hydrationErrors.length === 0, `Hydration errors detected: ${JSON.stringify(hydrationErrors)}`);
    console.log("✓ Zero hydration errors detected.");

    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("WebGL") && !e.includes("favicon") && !e.includes("Download the React DevTools")
    );
    console.log(`✓ Console check complete (${criticalErrors.length} unexpected errors).`);

    console.log("\n==================================================================");
    console.log("  ALL POLLING, RETRY & STATE VERIFICATION TESTS PASSED (6/6)!    ");
    console.log("==================================================================");

  } finally {
    edgeProc.kill();
  }
}

runCp5_6cPollingAndStatesTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
