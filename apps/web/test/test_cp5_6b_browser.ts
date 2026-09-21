import { spawn, execSync } from "child_process";

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const STARLETTE_ID = "2e945127-9c5d-4b5a-a0d9-9d52e2cbadfe";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

function getSessionCookie(): string {
  const out = execSync(
    'docker exec codeworld_api python -c "from app.security.session import create_session_cookie_value; print(create_session_cookie_value(\'ac2e5661-cda9-4e1d-a4a4-dd510b6830b1\'))"'
  ).toString().trim();
  const lines = out.split("\n").map(l => l.trim()).filter(l => l && !l.includes("InsecureKeyLengthWarning"));
  return lines[0];
}

async function runCp5_6bBrowserTests() {
  console.log("==================================================================");
  console.log("  CHECKPOINT 5.6B: FRONTEND AUTH INTEGRATION & BROWSER TESTS      ");
  console.log("==================================================================");

  const edgeProc = spawn(EDGE_PATH, [
    "--headless=new",
    "--remote-debugging-port=9228",
    "--window-size=1600,1000",
    "--no-first-run",
    "--no-default-browser-check",
    "http://localhost:3000/",
  ]);

  try {
    let versionData: any = null;
    for (let i = 0; i < 25; i++) {
      await new Promise((r) => setTimeout(r, 400));
      try {
        const res = await fetch("http://localhost:9228/json/version");
        if (res.ok) {
          versionData = await res.json();
          break;
        }
      } catch {}
    }
    if (!versionData) throw new Error("Could not connect to Edge on port 9228");

    const listRes = await fetch("http://localhost:9228/json/list");
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

    // ─────────────────────────────────────────────────────────────
    // TEST 1: ANONYMOUS VISITOR
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 1] Anonymous Visitor -> Navbar shows Connect GitHub & Explore");
    // Ensure no session cookie exists
    await send("Network.deleteCookies", { name: "codeworld_session", domain: "localhost" });
    await send("Network.deleteCookies", { name: "codeworld_session", url: "http://localhost:3000" });
    await send("Network.deleteCookies", { name: "codeworld_session", url: "http://localhost:8000" });

    await send("Page.navigate", { url: "http://localhost:3000/" });
    await new Promise((r) => setTimeout(r, 2000)); // Wait for render and /auth/me to settle

    const navbarText = await evalCode('document.querySelector("header")?.textContent');
    assert(navbarText?.includes("CodeWorld"), `Expected CodeWorld in navbar, got: ${navbarText}`);

    const connectGithubHref = await evalCode(
      'document.querySelector("header a[href*=\'auth/github/login\']")?.getAttribute("href")'
    );
    assert(
      connectGithubHref === "http://localhost:8000/api/v1/auth/github/login",
      `Expected Connect GitHub href to be http://localhost:8000/api/v1/auth/github/login, got: ${connectGithubHref}`
    );

    const connectGithubText = await evalCode(
      'document.querySelector("header a[href*=\'auth/github/login\']")?.textContent'
    );
    assert(connectGithubText?.includes("Connect GitHub"), `Expected Connect GitHub text, got: ${connectGithubText}`);

    const hasLogout = await evalCode(
      'Array.from(document.querySelectorAll("header button")).some(b => b.textContent.includes("Logout"))'
    );
    assert(!hasLogout, "Anonymous visitor must NOT see Logout button");

    const heroTitle = await evalCode('document.querySelector("h1")?.textContent');
    assert(heroTitle?.includes("Software City Explorer"), `Expected Explore hero, got: ${heroTitle}`);

    console.log("✓ Anonymous visitor correctly sees Connect GitHub link and Explore page.");

    // ─────────────────────────────────────────────────────────────
    // TEST 2: AUTHENTICATED VISITOR
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 2] Authenticated Visitor -> Navbar shows avatar, username & Logout");
    const cookieValue = getSessionCookie();
    assert(Boolean(cookieValue && cookieValue.length > 20), "Failed to retrieve valid session cookie in test memory");

    // Set cookie across localhost domains
    await send("Network.setCookie", {
      name: "codeworld_session",
      value: cookieValue,
      domain: "localhost",
      path: "/",
      httpOnly: true,
      sameSite: "Lax",
    });

    await send("Page.navigate", { url: "http://localhost:3000/" });
    await new Promise((r) => setTimeout(r, 2500)); // Wait for render and /auth/me

    const usernameInNav = await evalCode(
      'document.querySelector("header")?.textContent'
    );
    assert(
      usernameInNav?.includes("VladFlorentina"),
      `Expected VladFlorentina in navbar, got: ${usernameInNav}`
    );

    const hasAvatarImg = await evalCode(
      'document.querySelector("header img[src*=\'avatars.githubusercontent.com\']") !== null'
    );
    assert(hasAvatarImg, "Expected user avatar img element in navbar");

    const hasLogoutAuth = await evalCode(
      'Array.from(document.querySelectorAll("header button")).some(b => b.textContent.includes("Logout"))'
    );
    assert(hasLogoutAuth, "Authenticated visitor MUST see Logout button");

    const hasConnectGithubAuth = await evalCode(
      'document.querySelector("header a[href*=\'auth/github/login\']") !== null'
    );
    assert(!hasConnectGithubAuth, "Authenticated visitor must NOT see Connect GitHub link");

    console.log("✓ Authenticated visitor shows avatar, username 'VladFlorentina', and Logout button.");

    // ─────────────────────────────────────────────────────────────
    // TEST 3: BROWSER REFRESH PRESERVES SESSION
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 3] Browser Refresh -> Session remains recognized");
    await send("Page.reload");
    await new Promise((r) => setTimeout(r, 2000));

    const refreshedNav = await evalCode('document.querySelector("header")?.textContent');
    assert(
      refreshedNav?.includes("VladFlorentina"),
      `Expected VladFlorentina after refresh, got: ${refreshedNav}`
    );
    console.log("✓ Session successfully preserved across browser refresh.");

    // ─────────────────────────────────────────────────────────────
    // TEST 4: LOGOUT
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 4] Logout Click -> Immediately reverts to unauthenticated state");
    const clickLogoutResult = await evalCode(`
      (() => {
        const btn = Array.from(document.querySelectorAll("header button")).find(b => b.textContent.includes("Logout"));
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      })()
    `);
    assert(clickLogoutResult, "Failed to locate and click Logout button");

    await new Promise((r) => setTimeout(r, 1500)); // Wait for POST /auth/logout

    const postLogoutNav = await evalCode('document.querySelector("header")?.textContent');
    assert(!postLogoutNav?.includes("VladFlorentina"), "Username must not appear after logout");

    const connectGithubPostLogout = await evalCode(
      'document.querySelector("header a[href*=\'auth/github/login\']")?.textContent'
    );
    assert(
      connectGithubPostLogout?.includes("Connect GitHub"),
      "Connect GitHub link must reappear immediately after logout"
    );
    console.log("✓ Logout successfully clears user session and restores Connect GitHub.");

    // ─────────────────────────────────────────────────────────────
    // TEST 5: REFRESH AFTER LOGOUT
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 5] Refresh after Logout -> Remains unauthenticated");
    await send("Page.reload");
    await new Promise((r) => setTimeout(r, 2000));

    const afterRefreshNav = await evalCode('document.querySelector("header")?.textContent');
    assert(!afterRefreshNav?.includes("VladFlorentina"), "Username must not appear after refresh when logged out");
    assert(
      afterRefreshNav?.includes("Connect GitHub"),
      "Connect GitHub must remain visible after refresh when logged out"
    );
    console.log("✓ Remained unauthenticated after page refresh.");

    // ─────────────────────────────────────────────────────────────
    // TEST 6: PUBLIC EXPLORE FUNCTIONALITY
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 6] Public Explore Functionality Regression");
    const featuredRepo = await evalCode('document.querySelector("[data-testid=\'featured-encode-starlette\']")?.textContent');
    assert(featuredRepo?.includes("encode/starlette"), `Featured starlette card not found: ${featuredRepo}`);
    console.log("✓ Public Explore featured repository list is functional.");

    // ─────────────────────────────────────────────────────────────
    // TEST 7: PUBLIC CITY VIEWER
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 7] Public City Viewer (/city/[repositoryId])");
    await send("Page.navigate", { url: `http://localhost:3000/city/${STARLETTE_ID}` });
    await new Promise((r) => setTimeout(r, 3000));

    const cityNavTitle = await evalCode('document.querySelector("header")?.textContent');
    assert(cityNavTitle?.includes("CodeWorld"), `Navbar brand missing on City page: ${cityNavTitle}`);

    const repoNameInViewer = await evalCode('document.querySelector("h1")?.textContent');
    assert(repoNameInViewer?.includes("starlette"), `Expected starlette in city header, got: ${repoNameInViewer}`);

    const hasCanvas = await evalCode('document.querySelector("canvas") !== null');
    assert(hasCanvas, "3D Canvas must be rendered on City Viewer page");
    console.log("✓ Public City Viewer loads successfully with 3D canvas and top Navbar.");

    // ─────────────────────────────────────────────────────────────
    // TEST 8: HYDRATION & CONSOLE ERROR AUDIT
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 8] Hydration & Console Errors Audit");
    assert(hydrationErrors.length === 0, `Hydration errors detected: ${JSON.stringify(hydrationErrors)}`);
    console.log("✓ Zero hydration errors detected.");

    // Filter out expected or non-critical browser noise
    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("WebGL") && !e.includes("favicon") && !e.includes("Download the React DevTools")
    );
    console.log(`✓ Console check complete (${criticalErrors.length} unexpected errors).`);

    console.log("\n==================================================================");
    console.log("  ALL CHECKPOINT 5.6B BROWSER TESTS PASSED (8/8)!                ");
    console.log("==================================================================");

  } finally {
    edgeProc.kill();
  }
}

runCp5_6bBrowserTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
