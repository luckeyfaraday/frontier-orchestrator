import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export interface RuntimeConfig {
  projectRoot: string;
  allowedRoots: string[];
  codexCli: string;
  kimiCli: string;
  maxConcurrency: number;
  maxCapturedBytes: number;
  maxResultChars: number;
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < 1) {
    return fallback;
  }

  return Math.min(parsed, maximum);
}

async function canonicalDirectory(candidate: string): Promise<string> {
  const resolved = await realpath(path.resolve(candidate));
  const metadata = await stat(resolved);

  if (!metadata.isDirectory()) {
    throw new Error(`Allowed workspace is not a directory: ${candidate}`);
  }

  return resolved;
}

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative))
  );
}

export async function loadRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): Promise<RuntimeConfig> {
  const projectRoot = await canonicalDirectory(
    env.FRONTIER_PROJECT_ROOT ?? env.CLAUDE_PROJECT_DIR ?? cwd,
  );

  const configuredRoots = (env.FRONTIER_ALLOWED_ROOTS ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);

  const allowedRoots = new Set<string>([projectRoot]);
  for (const root of configuredRoots) {
    allowedRoots.add(await canonicalDirectory(root));
  }

  return {
    projectRoot,
    allowedRoots: [...allowedRoots],
    codexCli: env.FRONTIER_CODEX_CLI ?? "codex",
    kimiCli: env.FRONTIER_KIMI_CLI ?? "kimi",
    maxConcurrency: positiveInteger(env.FRONTIER_MAX_CONCURRENCY, 2, 8),
    maxCapturedBytes: positiveInteger(env.FRONTIER_MAX_CAPTURED_BYTES, 2_000_000, 20_000_000),
    maxResultChars: positiveInteger(env.FRONTIER_MAX_RESULT_CHARS, 30_000, 100_000),
  };
}

export async function resolveWorkingDirectory(
  requested: string | undefined,
  config: Pick<RuntimeConfig, "projectRoot" | "allowedRoots">,
): Promise<string> {
  const unresolved = requested ?? ".";
  const candidate = path.isAbsolute(unresolved)
    ? unresolved
    : path.resolve(config.projectRoot, unresolved);
  const canonical = await canonicalDirectory(candidate);

  if (!config.allowedRoots.some((root) => isWithin(root, canonical))) {
    throw new Error(
      `Working directory is outside the allowed roots: ${canonical}. ` +
        `Allowed roots: ${config.allowedRoots.join(", ")}`,
    );
  }

  return canonical;
}
