import React, { useEffect } from "react";
import { useJobPolling, UseJobPollingOptions, UseJobPollingReturn } from "../src/hooks/useJobPolling";
import { JobStatus, JobStatusResponse } from "../src/types/city";

// =====================================================================
// Minimal DOM Mock for React 19 execution in Node test environment
// =====================================================================
class MockNode {
  nodeType = 1;
  nodeName = "DIV";
  tagName = "DIV";
  ownerDocument = null as any;
  childNodes: any[] = [];
  firstChild: any = null;
  lastChild: any = null;
  parentNode: any = null;
  nextSibling: any = null;
  previousSibling: any = null;
  style = {};
  setAttribute() {}
  removeAttribute() {}
  appendChild(child: any) {
    this.childNodes.push(child);
    this.lastChild = child;
    if (!this.firstChild) this.firstChild = child;
    child.parentNode = this;
    return child;
  }
  removeChild(child: any) {
    const idx = this.childNodes.indexOf(child);
    if (idx !== -1) this.childNodes.splice(idx, 1);
    return child;
  }
  insertBefore(newChild: any, _refChild: any) {
    this.appendChild(newChild);
    return newChild;
  }
  addEventListener() {}
  removeEventListener() {}
}

const doc = new MockNode();
doc.nodeType = 9;
(doc as any).createElement = () => {
  const el = new MockNode();
  el.ownerDocument = doc;
  return el;
};
(doc as any).createElementNS = () => {
  const el = new MockNode();
  el.ownerDocument = doc;
  return el;
};
(doc as any).createTextNode = () => new MockNode();
(doc as any).createComment = () => new MockNode();
(doc as any).documentElement = new MockNode();

(global as any).window = global;
(global as any).HTMLIFrameElement = class HTMLIFrameElement {};
(doc as any).defaultView = global;
(doc as any).activeElement = null;
(global as any).document = doc;
(global as any).Node = MockNode;
(global as any).Element = MockNode;
(global as any).Document = MockNode;
(global as any).navigator = { userAgent: "node" };
(global as any).IS_REACT_ACT_ENVIRONMENT = true;

// Helper assert
function assert(condition: boolean, message: string) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    throw new Error(message);
  }
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Test harness for mounting useJobPolling
interface HarnessRef<TMeta = Record<string, unknown>> {
  hook: UseJobPollingReturn<TMeta> | null;
  renderCount: number;
}

function TestComponent<TMeta = Record<string, unknown>>({
  options,
  harnessRef,
}: {
  options: UseJobPollingOptions<TMeta>;
  harnessRef: HarnessRef<TMeta>;
}) {
  const hook = useJobPolling<TMeta>(options);
  harnessRef.hook = hook;
  harnessRef.renderCount++;
  return null;
}

function mockJob(partial: Partial<JobStatusResponse> & { job_id: string; status: JobStatus }): JobStatusResponse {
  return {
    run_id: "run-mock",
    repository_id: "repo-mock",
    error: null,
    started_at: null,
    completed_at: null,
    ...partial,
  };
}

async function runAllTests() {
  console.log("==================================================================");
  console.log("  CHECKPOINT Q3: USE_JOB_POLLING UNIT & COMPONENT TESTS            ");
  console.log("==================================================================");

  const ReactDOMClient = await import("react-dom/client");

  // Helper to mount hook
  async function renderHook<TMeta = Record<string, unknown>>(options: UseJobPollingOptions<TMeta>) {
    const harnessRef: HarnessRef<TMeta> = { hook: null, renderCount: 0 };
    const container = (doc as any).createElement();
    const root = ReactDOMClient.createRoot(container as any);

    await React.act(async () => {
      root.render(React.createElement(TestComponent<TMeta>, { options, harnessRef }));
    });

    return {
      getHook: () => harnessRef.hook!,
      getRenderCount: () => harnessRef.renderCount,
      rerender: async (newOptions: UseJobPollingOptions<TMeta>) => {
        await React.act(async () => {
          root.render(React.createElement(TestComponent<TMeta>, { options: newOptions, harnessRef }));
        });
      },
      unmount: async () => {
        await React.act(async () => {
          root.unmount();
        });
      },
    };
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 1: Transition queued -> running -> complete
  // ─────────────────────────────────────────────────────────────
  console.log("\n[TEST 1] Transition queued -> running -> complete");
  {
    const responses: JobStatusResponse[] = [
      mockJob({ status: "queued", job_id: "job-1", repository_id: "repo-1" }),
      mockJob({ status: "running", job_id: "job-1", repository_id: "repo-1" }),
      mockJob({ status: "complete", job_id: "job-1", repository_id: "repo-1" }),
    ];
    let callIdx = 0;
    const statusChanges: string[] = [];
    let completedJob: JobStatusResponse | null = null;
    let completedMeta: any = null;

    const { getHook, unmount } = await renderHook<{ repositoryId: string }>({
      intervalMs: 25,
      fetcher: async (id) => {
        assert(id === "job-1", `Expected jobId job-1, got ${id}`);
        const resp = responses[Math.min(callIdx++, responses.length - 1)];
        return resp;
      },
      onStatusChange: (st, job, meta) => {
        statusChanges.push(st);
      },
      onComplete: (job, meta) => {
        completedJob = job;
        completedMeta = meta;
      },
    });

    await React.act(async () => {
      getHook().startPolling("job-1", "queued", { repositoryId: "repo-1" });
    });

    assert(getHook().activeJob?.status === "queued", "Initial status should be queued");
    assert(getHook().activeJob?.jobId === "job-1", "Job ID should be job-1");
    assert(getHook().activeJob?.repositoryId === "repo-1", "Meta should be preserved");
    assert(getHook().isPolling === true, "isPolling should be true");

    // Wait for all 3 polls
    await React.act(async () => {
      await sleep(150);
    });

    assert(completedJob !== null, "onComplete should have been called");
    assert((completedJob as any)?.status === "complete", "completed status should be complete");
    assert(completedMeta?.repositoryId === "repo-1", "completedMeta repositoryId should match");
    assert(getHook().isPolling === false, "isPolling should be false after complete");
    assert(statusChanges.includes("running"), "Status changes should include running");

    await unmount();
    console.log("  ✅ PASS: queued -> running -> complete transition verified");
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 2: Job failed state
  // ─────────────────────────────────────────────────────────────
  console.log("\n[TEST 2] Job failed state handling");
  {
    let failedError: string | null = null;
    let failedMeta: any = null;

    const { getHook, unmount } = await renderHook<{ repositoryId: string }>({
      intervalMs: 25,
      fetcher: async () =>
        mockJob({
          status: "failed",
          job_id: "job-2",
          error: "Clone failed: repository not found",
        }),
      onFailed: (err, _job, meta) => {
        failedError = err;
        failedMeta = meta;
      },
    });

    await React.act(async () => {
      getHook().startPolling("job-2", "running", { repositoryId: "repo-2" });
    });

    await React.act(async () => {
      await sleep(60);
    });

    assert(failedError === "Clone failed: repository not found", `Expected error message, got: ${failedError}`);
    assert(failedMeta?.repositoryId === "repo-2", "Meta should be passed to onFailed");
    assert(getHook().activeJob === null, "activeJob should be reset to null on failure");
    assert(getHook().isPolling === false, "isPolling should be false after failure");

    await unmount();
    console.log("  ✅ PASS: Job failed state properly handled");
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 3: Network error handling
  // ─────────────────────────────────────────────────────────────
  console.log("\n[TEST 3] Network error handling");
  {
    let caughtError: Error | null = null;
    let errorMeta: any = null;

    const { getHook, unmount } = await renderHook<{ repositoryId: string }>({
      intervalMs: 25,
      fetcher: async () => {
        throw new Error("HTTP 502 Bad Gateway");
      },
      onError: (err, meta) => {
        caughtError = err;
        errorMeta = meta;
      },
    });

    await React.act(async () => {
      getHook().startPolling("job-3", "queued", { repositoryId: "repo-3" });
    });

    await React.act(async () => {
      await sleep(60);
    });

    assert(caughtError !== null, "onError should be called on network error");
    assert(caughtError!.message === "HTTP 502 Bad Gateway", `Expected error message, got: ${caughtError!.message}`);
    assert(errorMeta?.repositoryId === "repo-3", "Meta should be passed to onError");
    assert(getHook().activeJob === null, "activeJob should be reset to null on error");
    assert(getHook().isPolling === false, "isPolling should be false after error");

    await unmount();
    console.log("  ✅ PASS: Network error properly handled and polling stopped");
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 4: Overlapping call protection (Sequential tick polling)
  // ─────────────────────────────────────────────────────────────
  console.log("\n[TEST 4] Overlapping call protection (max 1 active in-flight request)");
  {
    let inFlight = 0;
    let maxInFlight = 0;
    let totalPolls = 0;

    const { getHook, unmount } = await renderHook({
      intervalMs: 15, // interval is shorter than response time
      fetcher: async () => {
        inFlight++;
        if (inFlight > maxInFlight) maxInFlight = inFlight;
        totalPolls++;
        await sleep(50); // slow response: 50ms > 15ms interval
        inFlight--;
        return mockJob({ status: "running", job_id: "job-slow" });
      },
    });

    await React.act(async () => {
      getHook().startPolling("job-slow", "running", {});
    });

    await React.act(async () => {
      await sleep(220); // allow several ticks to occur
    });

    await React.act(async () => {
      getHook().stopPolling();
    });

    assert(maxInFlight === 1, `Max in-flight requests must be 1, was: ${maxInFlight}`);
    assert(totalPolls >= 3, `Expected at least 3 sequential polls, got: ${totalPolls}`);

    await unmount();
    console.log(`  ✅ PASS: Sequential tick guaranteed max 1 in-flight request (maxInFlight: ${maxInFlight}, total: ${totalPolls})`);
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 5: Fast job switching
  // ─────────────────────────────────────────────────────────────
  console.log("\n[TEST 5] Fast job switching ignores delayed response from first job");
  {
    const completedJobs: string[] = [];

    const { getHook, unmount } = await renderHook({
      intervalMs: 20,
      fetcher: async (jobId) => {
        if (jobId === "job-A") {
          await sleep(100); // job-A is slow
          return mockJob({ status: "complete", job_id: "job-A" });
        }
        await sleep(20); // job-B is fast
        return mockJob({ status: "complete", job_id: "job-B" });
      },
      onComplete: (job) => {
        completedJobs.push(job.job_id);
      },
    });

    await React.act(async () => {
      getHook().startPolling("job-A", "running", { name: "A" });
    });

    // Before job-A responds, switch to job-B
    await React.act(async () => {
      await sleep(25);
      getHook().startPolling("job-B", "running", { name: "B" });
    });

    // Wait for both to finish
    await React.act(async () => {
      await sleep(160);
    });

    assert(
      completedJobs.length === 1 && completedJobs[0] === "job-B",
      `Expected only job-B to complete, got: ${JSON.stringify(completedJobs)}`
    );

    await unmount();
    console.log("  ✅ PASS: Late response from superseded job-A discarded; only job-B completed");
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 6: Stop & restart with same jobId
  // ─────────────────────────────────────────────────────────────
  console.log("\n[TEST 6] Stop & restart with same jobId discards old in-flight response");
  {
    let genCount = 0;
    const completedGenerations: number[] = [];
    let failedCalled = false;

    const { getHook, unmount } = await renderHook({
      intervalMs: 20,
      fetcher: async (jobId) => {
        genCount++;
        const currentGen = genCount;
        if (currentGen === 1) {
          await sleep(100); // 1st run is slow and will return "failed"
          return mockJob({ status: "failed", job_id: jobId, error: "stale fail" });
        }
        await sleep(20); // 2nd run is fast and returns "complete"
        return mockJob({ status: "complete", job_id: jobId });
      },
      onFailed: () => {
        failedCalled = true;
      },
      onComplete: () => {
        completedGenerations.push(genCount);
      },
    });

    // Start 1st run
    await React.act(async () => {
      getHook().startPolling("job-same", "running", {});
    });

    // Stop and immediately restart with SAME jobId
    await React.act(async () => {
      await sleep(25);
      getHook().stopPolling();
      getHook().startPolling("job-same", "running", {});
    });

    // Wait for everything to settle
    await React.act(async () => {
      await sleep(150);
    });

    assert(!failedCalled, "Stale failed response from 1st run must NOT trigger onFailed");
    assert(completedGenerations.length === 1, "Only 2nd run should complete");

    await unmount();
    console.log("  ✅ PASS: Generation token protected against stale response for identical jobId");
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 7: Unmount with delayed response
  // ─────────────────────────────────────────────────────────────
  console.log("\n[TEST 7] Unmount with delayed response does not error or trigger callbacks");
  {
    let callbackAfterUnmount = false;

    const { getHook, unmount } = await renderHook({
      intervalMs: 20,
      fetcher: async () => {
        await sleep(80);
        return mockJob({ status: "complete", job_id: "job-unmount" });
      },
      onComplete: () => {
        callbackAfterUnmount = true;
      },
    });

    await React.act(async () => {
      getHook().startPolling("job-unmount", "running", {});
    });

    // Wait for request to start, then unmount immediately while in-flight
    await React.act(async () => {
      await sleep(25);
    });

    await unmount();

    // Wait for in-flight fetch to resolve after unmount
    await sleep(100);

    assert(!callbackAfterUnmount, "onComplete must not fire after unmount");

    console.log("  ✅ PASS: Unmount cleanup safely cancels polling and ignores delayed response");
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 8: Terminal callback invoked exactly once
  // ─────────────────────────────────────────────────────────────
  console.log("\n[TEST 8] Terminal callback invoked exactly once");
  {
    let completeCount = 0;

    const { getHook, unmount } = await renderHook({
      intervalMs: 20,
      fetcher: async () =>
        mockJob({
          status: "complete",
          job_id: "job-terminal",
        }),
      onComplete: () => {
        completeCount++;
      },
    });

    await React.act(async () => {
      getHook().startPolling("job-terminal", "queued", {});
    });

    await React.act(async () => {
      await sleep(120); // wait multiple intervals
    });

    assert(completeCount === 1, `onComplete should be called exactly once, was called ${completeCount} times`);

    await unmount();
    console.log("  ✅ PASS: Terminal callback invoked exactly once");
  }

  // ─────────────────────────────────────────────────────────────
  // TEST 9: Hook stability across rerenders
  // ─────────────────────────────────────────────────────────────
  console.log("\n[TEST 9] Hook stability across parent rerenders");
  {
    let rerenderComplete = false;

    const { getHook, rerender, unmount } = await renderHook({
      intervalMs: 50,
      fetcher: async () => {
        await sleep(20);
        return mockJob({ status: "complete", job_id: "job-stable" });
      },
      onComplete: () => {
        rerenderComplete = true;
      },
    });

    await React.act(async () => {
      getHook().startPolling("job-stable", "queued", {});
    });

    // Rerender parent component with new options object reference
    await rerender({
      intervalMs: 50,
      fetcher: async () => mockJob({ status: "complete", job_id: "job-stable" }),
      onComplete: () => {
        rerenderComplete = true;
      },
    });

    await React.act(async () => {
      await sleep(80);
    });

    assert(rerenderComplete, "Polling should successfully complete despite parent rerender");

    await unmount();
    console.log("  ✅ PASS: Polling unaffected by parent rerender with new options reference");
  }

  console.log("\n==================================================================");
  console.log("  🎉 ALL 9 HOOK UNIT & COMPONENT TESTS PASSED PERFECTLY!         ");
  console.log("==================================================================");
}

runAllTests().catch((err) => {
  console.error("\n❌ TEST SUITE FAILED:", err);
  process.exit(1);
});
