#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { spawn } from "node:child_process";
import { z } from "zod";
import { loadRuntimeConfig, resolveWorkingDirectory, type RuntimeConfig } from "./config.js";
import { SpecialistCoordinator } from "./coordinator.js";
import {
  buildCodexInvocation,
  buildGrokInvocation,
  buildKimiInvocation,
  type DelegationMode,
  type DelegationRequest,
  type Specialist,
} from "./specialists.js";

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

const delegationInput = {
  task: z.string().min(1).max(20_000).describe("Concrete, self-contained specialist task."),
  mode: z
    .enum(["analyze", "implement", "review"])
    .default("implement")
    .describe("Analyze/review are read-only; implement may edit the workspace."),
  working_directory: z
    .string()
    .max(4_096)
    .default(".")
    .describe("Directory relative to the Claude project root, or an allowed absolute path."),
  context: z
    .string()
    .max(20_000)
    .optional()
    .describe("Relevant architectural context, interfaces, decisions, and constraints."),
  file_scope: z
    .array(z.string().min(1).max(500))
    .max(100)
    .optional()
    .describe("Files or directories this specialist owns for this task."),
  acceptance_criteria: z
    .array(z.string().min(1).max(1_000))
    .max(50)
    .optional()
    .describe("Observable conditions the specialist should satisfy."),
  model: z.string().min(1).max(200).optional().describe("Optional provider-specific model override."),
  timeout_seconds: z
    .number()
    .int()
    .min(30)
    .max(3_600)
    .default(1_200)
    .describe("Hard timeout for the specialist CLI process."),
  allow_concurrent_mutation: z
    .boolean()
    .default(false)
    .describe("Allow simultaneous edits in one workspace only when file scopes are known not to overlap."),
};

interface DelegateArguments {
  task: string;
  mode: DelegationMode;
  working_directory: string;
  context?: string;
  file_scope?: string[];
  acceptance_criteria?: string[];
  model?: string;
  timeout_seconds: number;
  allow_concurrent_mutation: boolean;
}

function compactText(value: string, maximumCharacters: number): { text: string; truncated: boolean } {
  const clean = value.replace(ANSI_PATTERN, "").trim();
  if (clean.length <= maximumCharacters) {
    return { text: clean, truncated: false };
  }

  const prefixLength = Math.min(4_000, Math.floor(maximumCharacters / 4));
  const suffixLength = maximumCharacters - prefixLength;
  return {
    text:
      clean.slice(0, prefixLength) +
      "\n\n[... specialist output truncated by frontier-orchestrator ...]\n\n" +
      clean.slice(-suffixLength),
    truncated: true,
  };
}

function commandVersion(command: string): Promise<{ available: boolean; version?: string; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, ["--version"], {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let settled = false;

    const finish = (result: { available: boolean; version?: string; error?: string }) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(result);
    };

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ available: false, error: "Version check timed out after 10 seconds." });
    }, 10_000);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
    child.once("error", (error) => {
      clearTimeout(timeout);
      finish({ available: false, error: error.message });
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      const output = Buffer.concat([...stdout, ...stderr]).toString("utf8").trim();
      if (code === 0) {
        finish({ available: true, version: output || "available" });
      } else {
        finish({ available: false, error: output || `Exited with code ${String(code)}` });
      }
    });
  });
}

function buildRequest(args: DelegateArguments): DelegationRequest {
  return {
    task: args.task,
    mode: args.mode,
    ...(args.context === undefined ? {} : { context: args.context }),
    ...(args.file_scope === undefined ? {} : { fileScope: args.file_scope }),
    ...(args.acceptance_criteria === undefined
      ? {}
      : { acceptanceCriteria: args.acceptance_criteria }),
    ...(args.model === undefined ? {} : { model: args.model }),
  };
}

function failureHint(specialist: Specialist, stdout: string, stderr: string): string | undefined {
  const combined = `${stdout}\n${stderr}`;

  if (specialist === "kimi-frontend" && /LLM not set|LLM is not set/i.test(combined)) {
    return "Kimi has no configured model. Run `kimi login`, complete the provider/model setup, then retry.";
  }

  if (/not logged in|authentication|unauthorized|401/i.test(combined)) {
    switch (specialist) {
      case "codex-backend":
        return "Codex authentication may be missing or expired. Run `codex login status` and sign in if needed.";
      case "kimi-frontend":
        return "Kimi authentication may be missing or expired. Run `kimi login` and retry.";
      case "grok-builder":
        return "Grok authentication may be missing or expired. Run `grok login` and retry.";
    }
  }

  return undefined;
}

async function delegate(
  specialist: Specialist,
  args: DelegateArguments,
  config: RuntimeConfig,
  coordinator: SpecialistCoordinator,
) {
  try {
    const workingDirectory = await resolveWorkingDirectory(args.working_directory, config);
    const request = buildRequest(args);
    const invocation = (() => {
      switch (specialist) {
        case "codex-backend":
          return buildCodexInvocation(request, {
            cli: config.codexCli,
            workingDirectory,
          });
        case "kimi-frontend":
          return buildKimiInvocation(request, {
            cli: config.kimiCli,
            workingDirectory,
          });
        case "grok-builder":
          return buildGrokInvocation(request, {
            cli: config.grokCli,
            workingDirectory,
          });
      }
    })();

    const result = await coordinator.run(
      invocation,
      args.timeout_seconds,
      args.mode === "implement",
      args.allow_concurrent_mutation,
    );
    const finalMessage = compactText(result.stdout, config.maxResultChars);
    const diagnostics = compactText(result.stderr, Math.min(config.maxResultChars, 12_000));
    const failed = result.exitCode !== 0 || result.timedOut;
    const hint = failed ? failureHint(specialist, result.stdout, result.stderr) : undefined;

    const payload = {
      specialist,
      mode: args.mode,
      working_directory: workingDirectory,
      exit_code: result.exitCode,
      signal: result.signal,
      timed_out: result.timedOut,
      duration_ms: result.durationMs,
      output_truncated: finalMessage.truncated || result.stdoutTruncated,
      final_message: finalMessage.text,
      ...(failed
        ? {
            diagnostics: diagnostics.text,
            diagnostics_truncated: diagnostics.truncated || result.stderrTruncated,
            ...(hint === undefined ? {} : { hint }),
          }
        : {}),
    };

    return {
      content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
      isError: failed,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: "text" as const, text: `Delegation failed: ${message}` }],
      isError: true,
    };
  }
}

async function main(): Promise<void> {
  const config = await loadRuntimeConfig();
  const coordinator = new SpecialistCoordinator(config);
  const server = new McpServer(
    {
      name: "frontier-orchestrator",
      version: "0.1.0",
    },
    {
      instructions:
        "Claude is the lead integrator. Use delegate_backend for server/data/infrastructure work, delegate_frontend for design/UI/client work, and delegate_build for bounded cross-cutting implementation, migrations, refactors, build tooling, or debugging. Split mixed tasks at explicit contracts. Avoid concurrent implementation in overlapping files. Inspect and verify specialist changes before presenting completion.",
    },
  );

  server.registerTool(
    "specialist_status",
    {
      title: "Check specialist availability",
      description:
        "Check whether the configured Codex, Kimi, and Grok CLIs are available. This does not verify account authentication.",
      inputSchema: {},
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      },
    },
    async () => {
      const [codex, kimi, grok] = await Promise.all([
        commandVersion(config.codexCli),
        commandVersion(config.kimiCli),
        commandVersion(config.grokCli),
      ]);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              {
                project_root: config.projectRoot,
                allowed_roots: config.allowedRoots,
                max_concurrency: config.maxConcurrency,
                codex,
                kimi,
                grok,
              },
              null,
              2,
            ),
          },
        ],
      };
    },
  );

  server.registerTool(
    "delegate_backend",
    {
      title: "Delegate backend work to Codex",
      description:
        "Delegate backend, API, database, auth, infrastructure, security, performance, or backend-test work to Codex. Use analyze/review for read-only work and implement for edits.",
      inputSchema: delegationInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) =>
      await delegate("codex-backend", args as DelegateArguments, config, coordinator),
  );

  server.registerTool(
    "delegate_frontend",
    {
      title: "Delegate frontend and design work to Kimi",
      description:
        "Delegate product design, UX, visual systems, components, styling, accessibility, responsive behavior, animation, client state, or frontend-test work to Kimi. Use analyze/review for read-only work and implement for edits.",
      inputSchema: delegationInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) =>
      await delegate("kimi-frontend", args as DelegateArguments, config, coordinator),
  );

  server.registerTool(
    "delegate_build",
    {
      title: "Delegate general build work to Grok Build",
      description:
        "Delegate bounded cross-cutting implementation, repository-wide refactors, migrations, debugging, build tooling, or broad test work to Grok Build. Use analyze/review for read-only work and implement for edits.",
      inputSchema: delegationInput,
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      },
    },
    async (args) =>
      await delegate("grok-builder", args as DelegateArguments, config, coordinator),
  );

  const transport = new StdioServerTransport();
  await server.connect(transport);

  let closing = false;
  const close = async () => {
    if (closing) {
      return;
    }
    closing = true;
    await coordinator.shutdown();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", close);
  process.on("SIGTERM", close);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack ?? error.message : String(error);
  process.stderr.write(`frontier-orchestrator failed to start: ${message}\n`);
  process.exit(1);
});
