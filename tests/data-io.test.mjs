import test from "node:test";
import assert from "node:assert/strict";

import { retryOptional } from "../scripts/lib/data-io.mjs";

test("optional source retries recover from one transient failure", async () => {
  let calls = 0;
  const result = await retryOptional(async () => {
    calls += 1;
    if (calls === 1) throw new Error("temporary DNS failure");
    return "recovered";
  }, { attempts: 2, delayMs: 0 });

  assert.equal(result, "recovered");
  assert.equal(calls, 2);
});

test("optional source retries stay bounded and preserve the final error", async () => {
  let calls = 0;
  await assert.rejects(
    retryOptional(async () => {
      calls += 1;
      throw new Error(`failure ${calls}`);
    }, { attempts: 3, delayMs: 0 }),
    /failure 3/,
  );
  assert.equal(calls, 3);
});
