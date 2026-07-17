import type { CommandInvocation } from "./process.js";

export type DelegationMode = "analyze" | "implement" | "review";
export type Specialist = "codex-backend" | "kimi-frontend";

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

  return `You are the ${specialist === "codex-backend" ? "backend" : "design/frontend"} specialist in a multi-agent workflow led by Claude Code.
Claude is the lead integrator and will inspect your work, coordinate the other specialist, and make the final decision.

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
- Keep interface changes explicit so Claude can hand them to the other specialist.
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
  const args = [
    "--work-dir",
    options.workingDirectory,
    "--print",
    "--final-message-only",
  ];

  if (request.mode !== "implement") {
    args.push("--plan");
  }

  if (request.model !== undefined) {
    args.push("--model", request.model);
  }

  return {
    command: options.cli,
    args,
    cwd: options.workingDirectory,
    stdin: buildSpecialistPrompt("kimi-frontend", request, options.workingDirectory),
  };
}
