import path from "node:path";
import type { CommandInvocation } from "./process.js";

export type DelegationMode = "analyze" | "implement" | "review";
export type Specialist = "codex-backend" | "kimi-frontend" | "grok-builder";

export interface DelegationRequest {
  task: string;
  mode: DelegationMode;
  context?: string;
  fileScope?: string[];
  acceptanceCriteria?: string[];
  model?: string;
}

export interface SpecialistInvocation extends CommandInvocation {
  /** Files the caller must write (UTF-8) before spawning. Paths are absolute. */
  files?: Array<{ path: string; content: string }>;
  /** Converts raw stdout into the final message. Returns undefined when no final message exists. */
  extractFinalMessage?: (stdout: string) => string | undefined;
  /** True when the CLI writes output while it works, so prolonged silence means it is stuck. */
  reportsProgress?: boolean;
}

interface InvocationOptions {
  cli: string;
  workingDirectory: string;
}

export interface KimiInvocationOptions {
  cli: string;
  workingDirectory: string;
  /** Existing empty temp directory owned and deleted by the caller. */
  scratchDirectory: string;
}

export const KIMI_MAX_INLINE_PROMPT_CHARS = 24_000;

const KIMI_READONLY_AGENT = `---
name: frontier-readonly
description: Read-only reviewer used by frontier-orchestrator analyze/review mode
tools: [Read, ReadMediaFile, Grep, Glob]
disallowedTools: [Bash, Write, Edit, FetchURL, Agent, AgentSwarm]
subagents: []
---

\${base_prompt}

You are running in READ-ONLY mode. You cannot modify files or run commands; only inspect the workspace.
Your last message is the entire handoff to the caller, so make it complete and self-contained.
`;

const ROLE_GUIDANCE: Record<Specialist, string> = {
  "codex-backend": `Own backend engineering: server code, APIs, databases, auth, data flows, infrastructure, security, performance, and backend-focused tests.
Do not redesign or broadly edit UI/frontend files. If the task requires a frontend change, describe the contract or follow-up needed for the frontend specialist.`,
  "kimi-frontend": `Own product design and frontend engineering: information architecture, interaction design, visual systems, components, client state, accessibility, responsiveness, animation, and frontend-focused tests.
Do not redesign backend services or data models. If the task requires a backend change, describe the exact API or contract needed from the backend specialist.`,
  "grok-builder": `Own domain-neutral codebase maintenance and developer tooling: build configuration, dependency and toolchain upgrades, CI and release automation, mechanical repository-wide transformations, generated boilerplate, and test or lint cleanup.
Do not implement or change backend application behavior, APIs, data, auth, security, frontend product behavior, UX, or visual design unless Claude explicitly says the user overrode normal routing. Those areas belong to Codex or Kimi even when the change looks simple. Never accept a task solely because Grok is faster.`,
};

const SPECIALIST_LABELS: Record<Specialist, string> = {
  "codex-backend": "backend",
  "kimi-frontend": "design/frontend",
  "grok-builder": "tooling/maintenance",
};

function renderList(items: string[] | undefined, emptyValue: string): string {
  if (items === undefined || items.length === 0) {
    return emptyValue;
  }

  return items.map((item) => `- ${item}`).join("\n");
}

export function buildSpecialistPrompt(
  specialist: Specialist,
  request: DelegationRequest,
  workingDirectory: string,
): string {
  const operation =
    request.mode === "implement"
      ? "Implement the requested change directly in the workspace."
      : request.mode === "review"
        ? "Review the current implementation without modifying files."
        : "Analyze the request and produce an implementation-ready plan without modifying files.";

  return `You are the ${SPECIALIST_LABELS[specialist]} specialist in a multi-agent workflow led by Claude Code.
Claude is the lead integrator and will inspect your work, coordinate the other specialists, and make the final decision.

## Ownership

${ROLE_GUIDANCE[specialist]}

## Operation

${operation}

## Task

${request.task}

## Workspace

${workingDirectory}

## File scope

${renderList(request.fileScope, "- Inspect the repository and stay within your ownership boundary.")}

## Acceptance criteria

${renderList(request.acceptanceCriteria, "- Satisfy the task and verify the result proportionally to risk.")}

## Additional context

${request.context?.trim() || "No additional context was supplied."}

## Working rules

- Inspect relevant existing code and conventions before deciding.
- Treat the file scope as an ownership boundary. Do not touch files outside it unless essential; report any exception explicitly.
- Preserve unrelated user changes and avoid destructive version-control operations.
- Keep interface changes explicit so Claude can hand them to the other specialists.
- Run focused checks when the mode permits it. Do not claim checks passed unless you ran them.
- Keep the final response concise and use exactly these headings:
  - Summary
  - Files changed
  - Verification
  - Contract handoff
  - Risks or follow-ups
`;
}

export function buildCodexInvocation(
  request: DelegationRequest,
  options: InvocationOptions,
): SpecialistInvocation {
  const args = [
    "exec",
    "--ephemeral",
    "--skip-git-repo-check",
    "--color",
    "never",
    "--cd",
    options.workingDirectory,
    "--sandbox",
    request.mode === "implement" ? "workspace-write" : "read-only",
  ];

  if (request.model !== undefined) {
    args.push("--model", request.model);
  }

  args.push("-");

  return {
    command: options.cli,
    args,
    cwd: options.workingDirectory,
    stdin: buildSpecialistPrompt("codex-backend", request, options.workingDirectory),
    // codex exec streams its transcript (messages, commands, results) to stderr.
    reportsProgress: true,
  };
}

export function buildKimiInvocation(
  request: DelegationRequest,
  options: KimiInvocationOptions,
): SpecialistInvocation {
  let prompt = buildSpecialistPrompt("kimi-frontend", request, options.workingDirectory);
  const escapedLength = prompt.length + (prompt.match(/["\\]/g)?.length ?? 0);
  const files: NonNullable<SpecialistInvocation["files"]> = [];
  const args = ["--output-format", "stream-json"];

  if (escapedLength > KIMI_MAX_INLINE_PROMPT_CHARS) {
    const taskPath = path.join(options.scratchDirectory, "task.md");
    files.push({ path: taskPath, content: prompt });
    prompt = `Your complete task instructions are in the file ${taskPath}. Read that whole file with the Read tool first, then follow those instructions exactly.`;
    args.push("--add-dir", options.scratchDirectory);
  }

  args.push("-p", prompt);

  if (request.mode !== "implement") {
    const agentPath = path.join(options.scratchDirectory, "frontier-readonly.md");
    files.push({ path: agentPath, content: KIMI_READONLY_AGENT });
    args.push("--agent-file", agentPath);
  }

  if (request.model !== undefined) {
    args.push("-m", request.model);
  }

  return {
    command: options.cli,
    args,
    cwd: options.workingDirectory,
    ...(files.length > 0 ? { files } : {}),
    extractFinalMessage: extractKimiFinalMessage,
    // stream-json emits one line per message and tool result.
    reportsProgress: true,
  };
}

export function extractKimiFinalMessage(stdout: string): string | undefined {
  let finalMessage: string | undefined;

  for (const line of stdout.split(/\r?\n/)) {
    if (line.trim().length === 0) {
      continue;
    }

    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch {
      continue;
    }

    if (
      typeof message !== "object" ||
      message === null ||
      !("role" in message) ||
      message.role !== "assistant" ||
      !("content" in message)
    ) {
      continue;
    }

    const content = message.content;
    const text = typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
          .filter(
            (part: unknown): part is { type: "text"; text: string } =>
              typeof part === "object" &&
              part !== null &&
              "type" in part &&
              part.type === "text" &&
              "text" in part &&
              typeof part.text === "string",
          )
          .map((part) => part.text)
          .join("")
        : "";

    if (text.trim().length > 0) {
      finalMessage = text.trimEnd();
    }
  }

  return finalMessage;
}

export function buildGrokInvocation(
  request: DelegationRequest,
  options: InvocationOptions,
): CommandInvocation {
  const args = [
    "-p",
    buildSpecialistPrompt("grok-builder", request, options.workingDirectory),
    "--cwd",
    options.workingDirectory,
    "--output-format",
    "plain",
    "--permission-mode",
    request.mode === "implement" ? "bypassPermissions" : "plan",
    "--sandbox",
    request.mode === "implement" ? "workspace" : "read-only",
    "--no-memory",
    "--no-subagents",
  ];

  if (request.mode !== "implement") {
    args.push("--tools", "read_file,grep,list_dir");
  }

  if (request.model !== undefined) {
    args.push("--model", request.model);
  }

  return {
    command: options.cli,
    args,
    cwd: options.workingDirectory,
  };
}
