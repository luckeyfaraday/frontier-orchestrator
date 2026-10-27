import assert from "node:assert/strict";
import path from "node:path";
import test from "node:test";
import {
  buildCodexInvocation,
  buildGrokInvocation,
  buildKimiInvocation,
  buildSpecialistPrompt,
  extractKimiFinalMessage,
  KIMI_MAX_INLINE_PROMPT_CHARS,
  type DelegationRequest,
  type KimiInvocationOptions,
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
  assert.equal(invocation.reportsProgress, true);
});

test("Codex analysis uses a read-only sandbox", () => {
  const invocation = buildCodexInvocation(
    { ...request, mode: "analyze" },
    { cli: "codex", workingDirectory: "/workspace" },
  );

  assert.ok(invocation.args.includes("read-only"));
});

const kimiOptions: KimiInvocationOptions = {
  cli: "kimi-custom",
  workingDirectory: path.resolve("workspace"),
  scratchDirectory: path.resolve("scratch directory"),
};

for (const mode of ["analyze", "review", "implement"] as const) {
  test(`Kimi ${mode} uses stream-json and the appropriate agent tools`, () => {
    const modeRequest = { ...request, mode };
    const invocation = buildKimiInvocation(modeRequest, kimiOptions);

    assert.equal(invocation.command, kimiOptions.cli);
    assert.equal(invocation.cwd, kimiOptions.workingDirectory);
    assert.equal(invocation.stdin, undefined);
    assert.ok(!Object.hasOwn(invocation, "stdin"));
    assert.equal(invocation.extractFinalMessage, extractKimiFinalMessage);
    assert.equal(invocation.reportsProgress, true);
    assert.equal(
      invocation.args[invocation.args.indexOf("-p") + 1],
      buildSpecialistPrompt("kimi-frontend", modeRequest, kimiOptions.workingDirectory),
    );
    assert.equal(invocation.args[invocation.args.indexOf("--output-format") + 1], "stream-json");
    assert.ok(!invocation.args.includes("--add-dir"));
    for (const flag of ["--work-dir", "--print", "--final-message-only", "--plan"]) {
      assert.ok(!invocation.args.includes(flag));
    }

    if (mode === "implement") {
      assert.ok(!invocation.args.includes("--agent-file"));
      assert.equal(invocation.files, undefined);
      assert.ok(!Object.hasOwn(invocation, "files"));
      return;
    }

    const agentPath = path.join(kimiOptions.scratchDirectory, "frontier-readonly.md");
    assert.equal(invocation.args[invocation.args.indexOf("--agent-file") + 1], agentPath);
    assert.deepEqual(invocation.files, [{
      path: agentPath,
      content: `---
name: frontier-readonly
description: Read-only reviewer used by frontier-orchestrator analyze/review mode
tools: [Read, ReadMediaFile, Grep, Glob]
disallowedTools: [Bash, Write, Edit, FetchURL, Agent, AgentSwarm]
subagents: []
---

\${base_prompt}

You are running in READ-ONLY mode. You cannot modify files or run commands; only inspect the workspace.
Your last message is the entire handoff to the caller, so make it complete and self-contained.
`,
    }]);
  });
}

test("Kimi passes the model override with -m", () => {
  const invocation = buildKimiInvocation({ ...request, model: "kimi-model" }, kimiOptions);

  assert.deepEqual(invocation.args.slice(-2), ["-m", "kimi-model"]);
});

for (const mode of ["analyze", "review", "implement"] as const) {
  test(`Kimi ${mode} passes long prompts through a scratch task file`, () => {
    const longRequest = { ...request, mode, task: "x".repeat(KIMI_MAX_INLINE_PROMPT_CHARS + 1) };
    const prompt = buildSpecialistPrompt("kimi-frontend", longRequest, kimiOptions.workingDirectory);
    const invocation = buildKimiInvocation(longRequest, kimiOptions);
    const taskPath = path.join(kimiOptions.scratchDirectory, "task.md");

    assert.ok(prompt.length > KIMI_MAX_INLINE_PROMPT_CHARS);
    assert.equal(
      invocation.args[invocation.args.indexOf("-p") + 1],
      `Your complete task instructions are in the file ${taskPath}. Read that whole file with the Read tool first, then follow those instructions exactly.`,
    );
    assert.equal(
      invocation.args[invocation.args.indexOf("--add-dir") + 1],
      kimiOptions.scratchDirectory,
    );
    assert.deepEqual(invocation.files?.find((file) => file.path === taskPath), {
      path: taskPath,
      content: prompt,
    });
    assert.equal(invocation.files?.length, mode === "implement" ? 1 : 2);
  });
}

test("Kimi inlines prompts at the inline character limit", () => {
  const options = { ...kimiOptions, workingDirectory: "/workspace" };
  const basePrompt = buildSpecialistPrompt("kimi-frontend", { ...request, task: "" }, options.workingDirectory);
  const boundaryRequest = { ...request, task: "x".repeat(KIMI_MAX_INLINE_PROMPT_CHARS - basePrompt.length) };
  const prompt = buildSpecialistPrompt("kimi-frontend", boundaryRequest, options.workingDirectory);
  const invocation = buildKimiInvocation(boundaryRequest, options);

  assert.equal(prompt.length, KIMI_MAX_INLINE_PROMPT_CHARS);
  assert.equal(invocation.args[invocation.args.indexOf("-p") + 1], prompt);
  assert.ok(!invocation.args.includes("--add-dir"));
  assert.equal(invocation.files, undefined);
});

for (const character of ['"', "\\"]) {
  test(`Kimi counts escaped ${JSON.stringify(character)} characters toward the inline limit`, () => {
    const options = { ...kimiOptions, workingDirectory: "/workspace" };
    const basePrompt = buildSpecialistPrompt("kimi-frontend", { ...request, task: "" }, options.workingDirectory);
    const task = "x".repeat(KIMI_MAX_INLINE_PROMPT_CHARS - basePrompt.length - 2) + character;
    const atLimitRequest = { ...request, task };
    const atLimitPrompt = buildSpecialistPrompt("kimi-frontend", atLimitRequest, options.workingDirectory);
    const atLimitInvocation = buildKimiInvocation(atLimitRequest, options);

    assert.equal(atLimitPrompt.length, KIMI_MAX_INLINE_PROMPT_CHARS - 1);
    assert.equal(atLimitInvocation.args[atLimitInvocation.args.indexOf("-p") + 1], atLimitPrompt);
    assert.equal(atLimitInvocation.files, undefined);

    const overLimitRequest = { ...request, task: task + "x" };
    const overLimitPrompt = buildSpecialistPrompt("kimi-frontend", overLimitRequest, options.workingDirectory);
    const overLimitInvocation = buildKimiInvocation(overLimitRequest, options);

    assert.equal(overLimitPrompt.length, KIMI_MAX_INLINE_PROMPT_CHARS);
    assert.deepEqual(overLimitInvocation.files, [{
      path: path.join(options.scratchDirectory, "task.md"),
      content: overLimitPrompt,
    }]);
    assert.ok(overLimitInvocation.args.includes("--add-dir"));
  });
}

test("Kimi extractor ignores meta content after the final answer", () => {
  const stdout = [
    '{"role":"meta","type":"system.version","version":"2.3.2"}',
    '{"role":"assistant","content":"Final answer here"}',
    '{"role":"meta","type":"session.resume_hint","session_id":"session_x","command":"kimi -r session_x","content":"To resume this session: kimi -r session_x"}',
  ].join("\n");

  assert.equal(extractKimiFinalMessage(stdout), "Final answer here");
});

test("Kimi extractor returns the last non-blank assistant answer and trims only the end", () => {
  const stdout = [
    { role: "assistant", content: "Earlier answer" },
    { role: "user", content: "User input" },
    { role: "assistant", content: "  Final answer  \n" },
    { role: "assistant", content: " \t\n" },
  ].map((message) => JSON.stringify(message)).join("\n");

  assert.equal(extractKimiFinalMessage(stdout), "  Final answer");
});

test("Kimi extractor joins only text parts of array content", () => {
  const stdout = JSON.stringify({
    role: "assistant",
    content: [
      { type: "thinking", text: "Internal reasoning" },
      { type: "text", text: "First" },
      { type: "tool_use", text: "Ignored tool content" },
      null,
      "Ignored string part",
      { type: "text", text: 42 },
      { type: "text", text: " second  \n" },
    ],
  });

  assert.equal(extractKimiFinalMessage(stdout), "First second");
});

test("Kimi extractor skips invalid JSON and blank lines with CRLF output", () => {
  const stdout = [
    "",
    "not JSON",
    "null",
    "42",
    '"a JSON string"',
    "[]",
    '{"role":"assistant","content":"Valid answer"}',
    " \t",
    '{"role":"assistant","content":',
    "",
  ].join("\r\n");

  assert.equal(extractKimiFinalMessage(stdout), "Valid answer");
});

test("Kimi extractor ignores later assistant messages that only call tools", () => {
  const stdout = [
    { role: "assistant", content: "Keep this answer" },
    { role: "assistant", content: "", tool_calls: [{ name: "Read" }] },
    { role: "assistant", content: [], tool_calls: [{ name: "Grep" }] },
    { role: "assistant", tool_calls: [{ name: "Glob" }] },
  ].map((message) => JSON.stringify(message)).join("\n");

  assert.equal(extractKimiFinalMessage(stdout), "Keep this answer");
});

test("Kimi extractor returns undefined when no assistant text exists", () => {
  for (const stdout of [
    "",
    " \r\n\t\n",
    "invalid JSON",
    "null",
    '{"role":"meta","content":"Resume hint"}',
    '{"role":"user","content":"User input"}',
    '{"content":"Missing role"}',
    '{"role":"assistant"}',
    '{"role":"assistant","content":null}',
    '{"role":"assistant","content":42}',
    '{"role":"assistant","content":""}',
    '{"role":"assistant","content":" \\t"}',
    '{"role":"assistant","content":[]}',
    '{"role":"assistant","content":[{"type":"tool_use","text":"Read"}]}',
    '{"role":"assistant","content":[{"type":"text","text":" "}]}',
    '{"role":"assistant","content":"","tool_calls":[{"name":"Read"}]}',
  ]) {
    assert.equal(extractKimiFinalMessage(stdout), undefined, stdout);
  }
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
  // Plain output arrives only at the end, so silence is not a stuck signal.
  assert.ok(!("reportsProgress" in invocation));
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
