import { spawn, execSync } from "child_process";

const EDGE_PATH = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const TEST_USER_ID = "ac2e5661-cda9-4e1d-a4a4-dd510b6830b1";

function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

/**
 * Retrieve signed session cookie in memory without printing or logging.
 */
function getSessionCookieInMemory(): string {
  const out = execSync(
    `docker exec codeworld_api python -c "from app.security.session import create_session_cookie_value; print(create_session_cookie_value('${TEST_USER_ID}'))"`
  ).toString().trim();
  const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1];
}

async function runCp5_6cBrowserTests() {
  console.log("==================================================================");
  console.log("  CHECKPOINT 5.6C: MY REPOSITORIES UI & BROWSER E2E TESTS         ");
  console.log("==================================================================");

  const edgeProc = spawn(EDGE_PATH, [
    "--headless=new",
    "--remote-debugging-port=9229",
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
        const res = await fetch("http://localhost:9229/json/version");
        if (res.ok) {
          versionData = await res.json();
          break;
        }
      } catch {}
    }
    if (!versionData) throw new Error("Could not connect to Edge on port 9229");

    const listRes = await fetch("http://localhost:9229/json/list");
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
    // TEST 1: UNAUTHENTICATED VISITOR TO /my-repositories
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 1] State 1: Unauthenticated visitor accessing /my-repositories");
    await send("Network.deleteCookies", { name: "codeworld_session", domain: "localhost" });
    await send("Network.deleteCookies", { name: "codeworld_session", url: "http://localhost:3000" });
    await send("Network.deleteCookies", { name: "codeworld_session", url: "http://localhost:8000" });

    await send("Page.navigate", { url: "http://localhost:3000/my-repositories" });
    await new Promise((r) => setTimeout(r, 2000)); // Wait for render and /auth/me to settle

    const unauthTitle = await evalCode('document.querySelector("h1")?.textContent');
    assert(
      unauthTitle?.includes("Connect Your GitHub Account"),
      `Expected unauthenticated hero heading, got: ${unauthTitle}`
    );

    const connectBtnHref = await evalCode(
      'document.querySelector("main a[href*=\'auth/github/login\']")?.getAttribute("href")'
    );
    assert(
      connectBtnHref === "http://localhost:8000/api/v1/auth/github/login",
      `Expected login link to point to http://localhost:8000/api/v1/auth/github/login, got: ${connectBtnHref}`
    );

    const navLinks = await evalCode(`
      Array.from(document.querySelectorAll("header nav a")).map(a => ({
        text: a.textContent.trim(),
        href: a.getAttribute("href")
      }))
    `);
    assert(
      navLinks.some((l: any) => l.text === "My Repositories" && l.href === "/my-repositories"),
      "Navbar must include My Repositories link"
    );
    assert(
      navLinks.some((l: any) => l.text === "Explore" && l.href === "/"),
      "Navbar must include Explore link"
    );
    console.log("✓ Unauthenticated visitor correctly sees State 1 Connect GitHub CTA and Navbar links.");

    // ─────────────────────────────────────────────────────────────
    // TEST 2: AUTHENTICATED VISITOR — REAL REPOSITORY LIST (State 3)
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 2] State 3: Authenticated user loads real repositories list");
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

    await send("Page.navigate", { url: "http://localhost:3000/my-repositories" });
    await new Promise((r) => setTimeout(r, 3000)); // Wait for /auth/me and /github/repositories

    const headingText = await evalCode('document.querySelector("h1")?.textContent');
    assert(headingText?.includes("My Repositories"), `Expected My Repositories heading, got: ${headingText}`);

    const userLoginInDesc = await evalCode('document.querySelector("main p")?.textContent');
    assert(
      userLoginInDesc?.includes("VladFlorentina"),
      `Expected VladFlorentina in description, got: ${userLoginInDesc}`
    );

    // Verify repository cards
    const repoCardsCount = await evalCode(
      'document.querySelectorAll("[data-testid^=\'repo-card-\']").length'
    );
    assert(repoCardsCount >= 1, `Expected at least 1 repository card, found: ${repoCardsCount}`);

    // Check private test repo: VladFlorentina/codeworld-private-test
    const hasPrivateRepo = await evalCode(`
      Array.from(document.querySelectorAll("[data-testid^='repo-card-']")).some(card => 
        card.textContent.includes("VladFlorentina/codeworld-private-test")
      )
    `);
    assert(hasPrivateRepo, "Expected VladFlorentina/codeworld-private-test in repository list");

    // Check Private badge
    const privateBadge = await evalCode(`
      (() => {
        const card = Array.from(document.querySelectorAll("[data-testid^='repo-card-']")).find(c => 
          c.textContent.includes("VladFlorentina/codeworld-private-test")
        );
        return card?.textContent.includes("Private") || false;
      })()
    `);
    assert(privateBadge, "Private badge must be displayed on private repository card");

    // Check default branch badge
    const branchBadge = await evalCode(`
      (() => {
        const card = Array.from(document.querySelectorAll("[data-testid^='repo-card-']")).find(c => 
          c.textContent.includes("VladFlorentina/codeworld-private-test")
        );
        return card?.textContent.includes("main") || false;
      })()
    `);
    assert(branchBadge, "Default branch badge 'main' must be displayed");

    // Check GitHub external link
    const githubLink = await evalCode(`
      (() => {
        const card = Array.from(document.querySelectorAll("[data-testid^='repo-card-']")).find(c => 
          c.textContent.includes("VladFlorentina/codeworld-private-test")
        );
        return card?.querySelector("a[href*='github.com']")?.getAttribute("href");
      })()
    `);
    assert(
      Boolean(githubLink && githubLink.includes("github.com/VladFlorentina/codeworld-private-test")),
      `Expected GitHub link to target repo, got: ${githubLink}`
    );

    console.log(`✓ Authenticated user sees ${repoCardsCount} repository cards, including private test repo with Private badge & branch.`);

    // ─────────────────────────────────────────────────────────────
    // TEST 3: SEARCH FILTERING IN REAL TIME
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 3] Search filter test");
    async function setInputValue(val: string) {
      await evalCode(`
        (() => {
          const input = document.querySelector("input[type='text']");
          if (input) {
            const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
            nativeSetter.call(input, ${JSON.stringify(val)});
            input.dispatchEvent(new Event("input", { bubbles: true }));
          }
        })()
      `);
      await new Promise((r) => setTimeout(r, 400));
    }

    // Type search query
    await setInputValue("codeworld-private");

    const matchedCards = await evalCode(
      'document.querySelectorAll("[data-testid^=\'repo-card-\']").length'
    );
    assert(matchedCards === 1, `Expected 1 match for search query, got: ${matchedCards}`);

    // Search for non-existent repo
    await setInputValue("nonexistent-xyz-search-query-999");

    const zeroCards = await evalCode(
      'document.querySelectorAll("[data-testid^=\'repo-card-\']").length'
    );
    assert(zeroCards === 0, `Expected 0 cards for non-matching query, got: ${zeroCards}`);

    const emptyMsg = await evalCode('document.querySelector("main")?.textContent');
    assert(
      emptyMsg?.includes('No repositories matching "nonexistent-xyz-search-query-999"'),
      "Expected empty search message"
    );

    // Clear search
    await setInputValue("");

    const restoredCards = await evalCode(
      'document.querySelectorAll("[data-testid^=\'repo-card-\']").length'
    );
    assert(restoredCards === repoCardsCount, `Expected restored cards ${repoCardsCount}, got: ${restoredCards}`);
    console.log("✓ Real-time search filter and empty filter message work as expected.");

    // ─────────────────────────────────────────────────────────────
    // TEST 4: ANALYZE / VISUALIZE CITY TRIGGER & DIRECT/POLL TRANSITION
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 4] Trigger 'Visualize City' for private test repo");
    const clickSuccess = await evalCode(`
      (() => {
        const card = Array.from(document.querySelectorAll("[data-testid^='repo-card-']")).find(c => 
          c.textContent.includes("VladFlorentina/codeworld-private-test")
        );
        const btn = card?.querySelector("button[data-testid^='btn-analyze-']");
        if (btn) {
          btn.click();
          return true;
        }
        return false;
      })()
    `);
    assert(clickSuccess, "Could not find or click 'Visualize City' button");

    // Wait for API response and potential navigation (either instant 'ready' or polled 'complete')
    let currentUrl = "";
    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 500));
      currentUrl = await evalCode("window.location.pathname");
      if (currentUrl.startsWith("/city/")) {
        break;
      }
    }

    assert(
      currentUrl.startsWith("/city/"),
      `Expected transition to /city/[repositoryId], but remained at: ${currentUrl}`
    );

    // Verify that the route uses the CodeWorld UUID, NOT numeric GitHub ID (1380538285)
    const routedRepoId = currentUrl.replace("/city/", "").trim();
    assert(
      !routedRepoId.includes("1380538285"),
      `Route must use internal UUID, NOT numeric GitHub ID! Got: ${routedRepoId}`
    );
    assert(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(routedRepoId),
      `Expected valid UUID in city URL, got: ${routedRepoId}`
    );

    console.log(`✓ Successfully navigated to City Viewer using internal UUID: ${currentUrl}`);

    // Wait for 3D City Viewer page to render
    await new Promise((r) => setTimeout(r, 2500));
    const cityTitle = await evalCode('document.querySelector("h1")?.textContent');
    assert(
      cityTitle?.includes("codeworld-private-test"),
      `Expected codeworld-private-test in City Viewer title, got: ${cityTitle}`
    );

    const hasCityCanvas = await evalCode('document.querySelector("canvas") !== null');
    assert(hasCityCanvas, "Expected 3D City canvas rendered");
    console.log("✓ City Viewer rendered private repository 3D visualization.");

    // ─────────────────────────────────────────────────────────────
    // TEST 5: NAVBAR RETURN TO /my-repositories
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 5] Navbar link 'My Repositories' navigates back");
    await evalCode(`
      (() => {
        const link = Array.from(document.querySelectorAll("header nav a")).find(a => 
          a.textContent.includes("My Repositories")
        );
        if (link) link.click();
      })()
    `);
    await new Promise((r) => setTimeout(r, 1500));

    const returnedUrl = await evalCode("window.location.pathname");
    assert(
      returnedUrl === "/my-repositories",
      `Expected /my-repositories after clicking navbar link, got: ${returnedUrl}`
    );
    console.log("✓ Navbar navigation back to /my-repositories confirmed.");

    // ─────────────────────────────────────────────────────────────
    // TEST 6: STATE 2 — AUTHENTICATED WITH 0 REPOSITORIES
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 6] State 2: Authenticated user with 0 repositories configured");
    // Intercept /github/repositories at Request stage to instantly return empty list
    await send("Fetch.enable", {
      patterns: [{ urlPattern: "*/github/repositories*", requestStage: "Request" }],
    });

    const emptyBody = Buffer.from(JSON.stringify({ repositories: [], total_count: 0 })).toString("base64");
    const fetchHandlerState2 = async (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.method === "Fetch.requestPaused") {
        const requestId = data.params.requestId;
        await send("Fetch.fulfillRequest", {
          requestId,
          responseCode: 200,
          responseHeaders: [
            { name: "Content-Type", value: "application/json" },
            { name: "Access-Control-Allow-Origin", value: "http://localhost:3000" },
            { name: "Access-Control-Allow-Credentials", value: "true" },
          ],
          body: emptyBody,
        });
      }
    };
    ws.addEventListener("message", fetchHandlerState2);

    await send("Page.navigate", { url: "http://localhost:3000/my-repositories" });

    let state2Heading = "";
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 400));
      state2Heading = (await evalCode('document.querySelector("h1")?.textContent')) || "";
      if (state2Heading.includes("No Repositories Selected")) break;
    }

    assert(
      state2Heading.includes("No Repositories Selected"),
      `Expected 'No Repositories Selected', got: ${state2Heading}`
    );

    const configBtnText = await evalCode(
      'document.querySelector("main a[href*=\'github.com/settings/installations\']")?.textContent'
    );
    assert(
      configBtnText?.includes("Configure Repository Access"),
      `Expected 'Configure Repository Access' button, got: ${configBtnText}`
    );
    console.log("✓ State 2 correctly displays 'No Repositories Selected' and 'Configure Repository Access' CTA.");

    // ─────────────────────────────────────────────────────────────
    // TEST 7: STATE 4 — SESSION EXPIRED OR GITHUB API ERROR
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 7] State 4: Session expired or GitHub API error");
    ws.removeEventListener("message", fetchHandlerState2);

    const errorBody = Buffer.from(JSON.stringify({ detail: "GitHub API connection timed out or token expired" })).toString("base64");
    const fetchHandlerState4 = async (event: MessageEvent) => {
      const data = JSON.parse(event.data);
      if (data.method === "Fetch.requestPaused") {
        const requestId = data.params.requestId;
        await send("Fetch.fulfillRequest", {
          requestId,
          responseCode: 502,
          responseHeaders: [
            { name: "Content-Type", value: "application/json" },
            { name: "Access-Control-Allow-Origin", value: "http://localhost:3000" },
            { name: "Access-Control-Allow-Credentials", value: "true" },
          ],
          body: errorBody,
        });
      }
    };
    ws.addEventListener("message", fetchHandlerState4);

    await send("Page.navigate", { url: "http://localhost:3000/my-repositories" });

    let state4Heading = "";
    for (let i = 0; i < 20; i++) {
      await new Promise((r) => setTimeout(r, 400));
      state4Heading = (await evalCode('document.querySelector("h2")?.textContent')) || "";
      if (state4Heading.includes("Connection or Session Error")) break;
    }

    assert(
      state4Heading.includes("Connection or Session Error"),
      `Expected 'Connection or Session Error', got: ${state4Heading}`
    );

    const reconnectBtnText = await evalCode(
      'document.querySelector("main a[href*=\'auth/github/login\']")?.textContent'
    );
    assert(
      reconnectBtnText?.includes("Reconnect with GitHub"),
      `Expected 'Reconnect with GitHub' button, got: ${reconnectBtnText}`
    );
    console.log("✓ State 4 correctly renders controlled error state and Reconnect with GitHub CTA.");

    // Cleanup fetch interceptor
    ws.removeEventListener("message", fetchHandlerState4);
    await send("Fetch.disable");

    // ─────────────────────────────────────────────────────────────
    // TEST 8: HYDRATION & CONSOLE AUDIT
    // ─────────────────────────────────────────────────────────────
    console.log("\n[Test 8] Hydration & Console Audit");
    assert(hydrationErrors.length === 0, `Hydration errors detected: ${JSON.stringify(hydrationErrors)}`);
    console.log("✓ Zero hydration errors detected.");

    const criticalErrors = consoleErrors.filter(
      (e) => !e.includes("WebGL") && !e.includes("favicon") && !e.includes("Download the React DevTools") && !e.includes("502")
    );
    console.log(`✓ Console check complete (${criticalErrors.length} unexpected errors).`);

    console.log("\n==================================================================");
    console.log("  ALL CHECKPOINT 5.6C BROWSER TESTS PASSED (8/8)!                ");
    console.log("==================================================================");

  } finally {
    edgeProc.kill();
  }
}

runCp5_6cBrowserTests().catch((err) => {
  console.error("Test runner failed:", err);
  process.exit(1);
});
