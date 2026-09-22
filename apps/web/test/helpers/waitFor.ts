/**
 * Deterministic condition polling helper for CodeWorld browser tests.
 * Periodically polls the predicate function until it returns true or timeoutMs is exceeded.
 */
export async function waitFor(
  fn: () => Promise<boolean>,
  timeoutMs = 10000,
  intervalMs = 100
): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return false;
}
