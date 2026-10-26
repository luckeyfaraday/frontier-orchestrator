import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexInvocation,
  buildGrokInvocation,
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

test("Kimi review runs read-only via a restricted agent-file", () => {
  const invocation = buildKimiInvocation(
    { ...request, mode: "review" },
    { cli: "kimi", workingDirectory: "/workspace" },
  );

  assert.ok(invocation.args.includes("--prompt"));
  assert.equal(invocation.args[invocation.args.indexOf("--output-format") + 1], "text");
  // Kimi 2.x rejects --auto / --yolo / --plan with --prompt; read-only is
  // enforced by a restricted agent-file instead.
  assert.ok(!invocation.args.includes("--plan"));
  assert.ok(!invocation.args.includes("--auto"));
  assert.ok(!invocation.args.includes("--yolo"));
  assert.ok(invocation.args.includes("--agent-file"));
  const agentFile = invocation.args[invocation.args.indexOf("--agent-file") + 1] ?? "";
  assert.match(agentFile, /kimi-readonly\.md$/);
  assert.equal(invocation.stdin, undefined);
  const promptArg = invocation.args[invocation.args.indexOf("--prompt") + 1] ?? "";
  assert.match(promptArg, /design\/frontend specialist/);
});

test("Kimi implementation runs unrestricted (no read-only agent-file)", () => {
  const invocation = buildKimiInvocation(request, {
    cli: "kimi",
    workingDirectory: "/workspace",
  });

  assert.ok(!invocation.args.includes("--agent-file"));
  assert.ok(!invocation.args.includes("--plan"));
});

test("Kimi passes a model override through", () => {
  const invocation = buildKimiInvocation(
    { ...request, model: "kimi-k2" },
    { cli: "kimi", workingDirectory: "/workspace" },
  );

  assert.deepEqual(invocation.args.slice(-2), ["--model", "kimi-k2"]);
});

test("specialist prompt includes explicit scope and acceptance criteria", () => {
  const prompt = buildSpecialistPrompt("codex-backend", request, "/workspace");

  assert.match(prompt, /- server\//);
  assert.match(prompt, /Return 200 for an authenticated user/);
  assert.match(prompt, /Do not redesign or broadly edit UI\/frontend files/);
});

test("Grok implementation uses a workspace sandbox and a domain-neutral prompt", () => {
  const invocation = buildGrokInvocation(request, {
    cli: "grok-custom",
    workingDirectory: "/workspace",
  });

  assert.equal(invocation.command, "grok-custom");
  assert.ok(invocation.args.includes("workspace"));
  assert.ok(invocation.args.includes("bypassPermissions"));
  assert.ok(invocation.args.includes("--no-memory"));
  assert.ok(invocation.args.includes("--no-subagents"));
  assert.match(invocation.args[1] ?? "", /tooling\/maintenance specialist/);
  assert.match(invocation.args[1] ?? "", /domain-neutral codebase maintenance/);
  assert.match(invocation.args[1] ?? "", /Those areas belong to Codex or Kimi/);
  assert.match(invocation.args[1] ?? "", /Never accept a task solely because Grok is faster/);
});

test("Grok analysis restricts the agent to read-only tools", () => {
  const invocation = buildGrokInvocation(
    { ...request, mode: "analyze", model: "available-grok-model" },
    { cli: "grok", workingDirectory: "/workspace" },
  );

  assert.ok(invocation.args.includes("read-only"));
  assert.ok(invocation.args.includes("plan"));
  assert.ok(invocation.args.includes("read_file,grep,list_dir"));
  assert.deepEqual(invocation.args.slice(-2), ["--model", "available-grok-model"]);
});
