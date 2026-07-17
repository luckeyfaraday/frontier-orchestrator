import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexInvocation,
  buildKimiInvocation,
  buildSpecialistPrompt,
  type DelegationRequest,
} from "../src/specialists.js";

const request: DelegationRequest = {
  task: "Add a profile endpoint and document its client contract.",
  mode: "implement",
  context: "The frontend expects JSON.",
  fileScope: ["server/", "test/"],
  acceptanceCriteria: ["Return 200 for an authenticated user."],
};

test("Codex implementation uses workspace-write and stdin", () => {
  const invocation = buildCodexInvocation(request, {
    cli: "codex-custom",
    workingDirectory: "/workspace",
  });

  assert.equal(invocation.command, "codex-custom");
  assert.ok(invocation.args.includes("workspace-write"));
  assert.equal(invocation.args.at(-1), "-");
  assert.match(invocation.stdin ?? "", /backend specialist/);
  assert.match(invocation.stdin ?? "", /Contract handoff/);
});

test("Codex analysis uses a read-only sandbox", () => {
  const invocation = buildCodexInvocation(
    { ...request, mode: "analyze" },
    { cli: "codex", workingDirectory: "/workspace" },
  );

  assert.ok(invocation.args.includes("read-only"));
});

test("Kimi review starts in plan mode and receives the prompt through stdin", () => {
  const invocation = buildKimiInvocation(
    { ...request, mode: "review" },
    { cli: "kimi", workingDirectory: "/workspace" },
  );

  assert.ok(invocation.args.includes("--plan"));
  assert.ok(!invocation.args.includes("--prompt"));
  assert.match(invocation.stdin ?? "", /design\/frontend specialist/);
});

test("Kimi implementation does not force plan mode", () => {
  const invocation = buildKimiInvocation(request, {
    cli: "kimi",
    workingDirectory: "/workspace",
  });

  assert.ok(!invocation.args.includes("--plan"));
});

test("specialist prompt includes explicit scope and acceptance criteria", () => {
  const prompt = buildSpecialistPrompt("codex-backend", request, "/workspace");

  assert.match(prompt, /- server\//);
  assert.match(prompt, /Return 200 for an authenticated user/);
  assert.match(prompt, /Do not redesign or broadly edit UI\/frontend files/);
});
