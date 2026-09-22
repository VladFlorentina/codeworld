import { spawn, execSync } from "child_process";

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const TEST_USER_ID = "ac2e5661-cda9-4e1d-a4a4-dd510b6830b1";
const PRIVATE_REPO_ID = "d39c312a-f604-4301-822d-b6caf3562f2d";
const PUBLIC_REPO_ID = "2e945127-9c5d-4b5a-a0d9-9d52e2cbadfe";
const NONEXISTENT_REPO_ID = "00000000-0000-0000-0000-000000000000";

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

async function waitFor(fn: () => Promise<boolean>, timeoutMs = 10000, intervalMs = 100): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}

async function runCp5_6dPrivateViewerTests() {
  console.log("==================================================================");
  console.log("  CHECKPOINT 5.6D: PRIVATE CITY VIEWER & VERIFICATION TESTS       ");
  console.log("==================================================================");

  const edgeProc = spawn(EDGE_PATH, [
    "--headless=new",
    "--remote-debugging-port=9233",
    "--window-size=1600,1000",
    "--no-first-run",
    "--no-default-browser-check",
    "about:blank",
  ]);

  try {
    let versionData: any = null;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const res = await fetch("http://localhost:9233/json/version");
        if (res.ok) {
          versionData = await res.json();
          break;
        }
      } catch {}
    }
    if (!versionData) throw new Error("Could not connect to Edge on port 9233");

    const listRes = await fetch("http://localhost:9233/json/list");
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

    async function clearCookies() {
      await send("Network.deleteCookies", { name: "codeworld_session", domain: "localhost" });
      await send("Network.deleteCookies", { name: "codeworld_session", url: "http://localhost:3000" });
      await send("Network.deleteCookies", { name: "codeworld_session", url: "http://localhost:8000" });
    }

    async function setAuthCookie() {
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
    }

    // ─────────────────────────────────────────────────────────────
    // TEST 1: PUBLIC CITY VIEWER REGRESSION
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 1] Public City Viewer Regression");
    await clearCookies();
    await send("Page.navigate", { url: `http://localhost:3000/city/${PUBLIC_REPO_ID}` });

    const publicLoaded = await waitFor(async () => {
      const headerText = await evalCode('document.querySelector("header h1")?.textContent');
      return headerText?.includes("encode/starlette") || false;
    }, 12000);
    assert(publicLoaded, "Public city 'encode/starlette' must load without authentication");

    const canvasExists = await waitFor(async () => {
      const el = await evalCode('Boolean(document.querySelector("canvas"))');
      return el === true;
    }, 8000);
    assert(canvasExists, "3D canvas element must be rendered for public city");
    console.log("✓ Public city loads cleanly and renders 3D viewport without authentication.");

    // ─────────────────────────────────────────────────────────────
    // TEST 2: ANONYMOUS ACCESS TO PRIVATE CITY (401)
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 2] Anonymous Access to Private City -> Controlled 401 UI");
    await clearCookies();
    await send("Page.navigate", { url: `http://localhost:3000/city/${PRIVATE_REPO_ID}` });

    const state401Rendered = await waitFor(async () => {
      const el = await evalCode('Boolean(document.querySelector("[data-testid=\'viewer-401\']"))');
      return el === true;
    }, 8000);
    assert(state401Rendered, "Dedicated 401 UI must render when anonymous accesses private city");

    const title401 = await evalCode('document.querySelector("[data-testid=\'viewer-401\'] h2")?.textContent');
    assert(title401 === "Authentication Required", `Expected 'Authentication Required', got: '${title401}'`);

    const loginLink = await evalCode('document.querySelector("[data-testid=\'viewer-401\'] a[href*=\'auth/github/login\']")?.getAttribute("href")');
    assert(Boolean(loginLink?.includes("/auth/github/login")), "Must contain link to GitHub login flow");

    const backLink401 = await evalCode('document.querySelector("[data-testid=\'viewer-401\'] a[href=\'/\']")?.textContent');
    assert(backLink401?.includes("Back to Explore"), "Must contain 'Back to Explore' navigation link");

    const pageText = await evalCode("document.body.innerText");
    assert(!pageText.includes("Traceback"), "Raw traceback must NEVER be visible in UI");
    assert(!pageText.includes("Internal Server Error"), "Internal server error must not leak");
    console.log("✓ Anonymous visitor correctly receives controlled 401 UI with Connect GitHub CTA.");

    // ─────────────────────────────────────────────────────────────
    // TEST 3: AUTHORIZED ACCESS TO PRIVATE CITY (200)
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 3] Authorized Access to Private City -> 3D Canvas Renders (200)");
    await setAuthCookie();
    await send("Page.navigate", { url: `http://localhost:3000/city/${PRIVATE_REPO_ID}` });

    const privateLoaded = await waitFor(async () => {
      const headerText = await evalCode('document.querySelector("header h1")?.textContent');
      return headerText?.includes("VladFlorentina/codeworld-private-test") || false;
    }, 15000);
    assert(privateLoaded, "Authorized user must view 'VladFlorentina/codeworld-private-test'");

    const privateCanvasExists = await waitFor(async () => {
      const el = await evalCode('Boolean(document.querySelector("canvas"))');
      return el === true;
    }, 8000);
    assert(privateCanvasExists, "3D canvas must be active for authorized private city");

    const error401Gone = await evalCode('document.querySelector("[data-testid=\'viewer-401\']") === null');
    assert(error401Gone, "401 error container must not be present for authorized user");
    console.log("✓ Authorized user successfully opens private city with 3D canvas viewport.");

    // ─────────────────────────────────────────────────────────────
    // TEST 4: LOGOUT BEHAVIOR ON PRIVATE CITY
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 4] Logout Behavior: Cookie Removed -> Refresh Transitions to 401");
    await clearCookies();
    await send("Page.reload");

    const reloadedTo401 = await waitFor(async () => {
      const el = await evalCode('Boolean(document.querySelector("[data-testid=\'viewer-401\']"))');
      return el === true;
    }, 8000);
    assert(reloadedTo401, "After logout, reloading private city must transition to controlled 401 state");

    const canvasAfterLogout = await evalCode('Boolean(document.querySelector("canvas"))');
    assert(!canvasAfterLogout, "3D canvas must NOT be rendered after logout");
    console.log("✓ Logout behavior confirmed: private city access is revoked and transitions to 401.");

    // ─────────────────────────────────────────────────────────────
    // TEST 5: CONTROLLED 404 FOR NONEXISTENT CITY
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 5] Controlled 404 for Nonexistent City / Repository");
    await send("Page.navigate", { url: `http://localhost:3000/city/${NONEXISTENT_REPO_ID}` });

    const state404Rendered = await waitFor(async () => {
      const el = await evalCode('Boolean(document.querySelector("[data-testid=\'viewer-404\']"))');
      return el === true;
    }, 8000);
    assert(state404Rendered, "Dedicated 404 UI must render for nonexistent city");

    const title404 = await evalCode('document.querySelector("[data-testid=\'viewer-404\'] h2")?.textContent');
    assert(title404 === "City Not Found", `Expected 'City Not Found', got: '${title404}'`);

    const exploreLink = await evalCode('document.querySelector("[data-testid=\'viewer-404\'] a[href=\'/\']")?.textContent');
    assert(exploreLink?.includes("Explore Public Cities"), "404 must link back to public cities explore");
    console.log("✓ Nonexistent city correctly displays controlled 404 state.");

    // ─────────────────────────────────────────────────────────────
    // TEST 6: CONTROLLED 403 ACCESS DENIED STATE
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 6] Controlled 403 Access Denied State");
    await setAuthCookie();

    // Enable network interception to simulate 403 Forbidden from backend
    await send("Fetch.enable", {
      patterns: [{ urlPattern: "*/cities/*", requestStage: "Request" }],
    });

    const fetch403Handler = async (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.method === "Fetch.requestPaused") {
        const reqId = data.params.requestId;
        await send("Fetch.fulfillRequest", {
          requestId: reqId,
          responseCode: 403,
          responseHeaders: [
            { name: "Content-Type", value: "application/json" },
            { name: "Access-Control-Allow-Origin", value: "http://localhost:3000" },
            { name: "Access-Control-Allow-Credentials", value: "true" },
          ],
          body: Buffer.from(JSON.stringify({ detail: "Access denied: user does not have access to this repository" })).toString("base64"),
        });
      }
    };

    ws.addEventListener("message", fetch403Handler);
    await send("Page.navigate", { url: `http://localhost:3000/city/${PRIVATE_REPO_ID}` });

    const state403Rendered = await waitFor(async () => {
      const el = await evalCode('Boolean(document.querySelector("[data-testid=\'viewer-403\']"))');
      return el === true;
    }, 8000);
    assert(state403Rendered, "Dedicated 403 UI must render when user is denied repository access");

    const title403 = await evalCode('document.querySelector("[data-testid=\'viewer-403\'] h2")?.textContent');
    assert(title403 === "Access Denied", `Expected 'Access Denied', got: '${title403}'`);

    const desc403 = await evalCode('document.querySelector("[data-testid=\'viewer-403\'] p")?.textContent');
    assert(desc403?.includes("does not have access"), "403 description must clearly explain missing access");

    const myReposLink403 = await evalCode('document.querySelector("[data-testid=\'viewer-403\'] a[href=\'/my-repositories\']")?.textContent');
    assert(myReposLink403?.includes("My Repositories"), "403 state must link to My Repositories");

    // Clean up interception
    ws.removeEventListener("message", fetch403Handler);
    await send("Fetch.disable");
    console.log("✓ Unauthorized user on private city receives dedicated 403 Access Denied UI.");

    // ─────────────────────────────────────────────────────────────
    // TEST 7: HYDRATION & CONSOLE AUDIT
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 7] Hydration & Console Audit");
    assert(hydrationErrors.length === 0, `Hydration errors detected: ${JSON.stringify(hydrationErrors)}`);
    console.log("✓ Zero hydration errors detected.");
    console.log(`✓ Console check complete (${consoleErrors.length} total logged messages).`);

    console.log("\n==================================================================");
    console.log("  ALL CHECKPOINT 5.6D PRIVATE VIEWER TESTS PASSED (7/7)!         ");
    console.log("==================================================================");
  } finally {
    edgeProc.kill();
  }
}

runCp5_6dPrivateViewerTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
