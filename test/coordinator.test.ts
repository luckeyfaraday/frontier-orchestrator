import assert from "node:assert/strict";
import test from "node:test";
import { ConcurrencyGate, WorkspaceMutationGuard } from "../src/coordinator.js";

test("ConcurrencyGate transfers a released slot to the oldest waiter", async () => {
  const gate = new ConcurrencyGate(1);
  const releaseFirst = await gate.acquire();
  let secondAcquired = false;
  const second = gate.acquire().then((release) => {
    secondAcquired = true;
    return release;
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(secondAcquired, false);

  releaseFirst();
  const releaseSecond = await second;
  assert.equal(secondAcquired, true);
  releaseSecond();
});

test("WorkspaceMutationGuard rejects overlapping parent and child directories", () => {
  const guard = new WorkspaceMutationGuard();
  const release = guard.acquire("/workspace", false);

  assert.throws(
    () => guard.acquire("/workspace/apps/web", false),
    /overlaps/,
  );

  release();
  const releaseChild = guard.acquire("/workspace/apps/web", false);
  releaseChild();
});

test("WorkspaceMutationGuard permits an explicit concurrent override", () => {
  const guard = new WorkspaceMutationGuard();
  const releaseParent = guard.acquire("/workspace", false);
  const releaseChild = guard.acquire("/workspace/apps/web", true);

  releaseChild();
  releaseParent();
});
