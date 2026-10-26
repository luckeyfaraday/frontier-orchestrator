import { fileURLToPath } from "node:url";
import type { CommandInvocation } from "./process.js";

// Restricted read-only agent used for Kimi analyze/review (see buildKimiInvocation).
const KIMI_READONLY_AGENT_FILE =
  process.env.FRONTIER_KIMI_READONLY_AGENT ??
  fileURLToPath(new URL("../../agents/kimi-readonly.md", import.meta.url));

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

interface InvocationOptions {
  cli: string;
  workingDirectory: string;
}

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
): CommandInvocation {
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
  };
}

export function buildKimiInvocation(
  request: DelegationRequest,
  options: InvocationOptions,
): CommandInvocation {
  // Kimi Code 2.x headless (`--prompt`) runs under the `auto` permission policy:
  // it executes tools and edits files with no interactive approval. The mode
  // flags (--auto / --yolo / --plan) cannot be combined with --prompt, so
  // read-only analyze/review is enforced by selecting a restricted agent whose
  // tool allowlist excludes every write/edit/command tool (agents/kimi-readonly.md);
  // implement runs unrestricted. The prompt is passed via --prompt (not stdin)
  // and the workspace is the process cwd. The older
  // --work-dir / --print / --final-message-only flags were removed upstream.
  const args = [
    "--prompt",
    buildSpecialistPrompt("kimi-frontend", request, options.workingDirectory),
    "--output-format",
    "text",
  ];

  if (request.mode !== "implement") {
    args.push("--agent-file", KIMI_READONLY_AGENT_FILE);
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
