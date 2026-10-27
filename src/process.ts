import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import path from "node:path";

export interface CommandInvocation {
  command: string;
  args: string[];
  cwd: string;
  stdin?: string;
  env?: NodeJS.ProcessEnv;
}

export interface CommandResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  idleTimedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface RunCommandOptions {
  timeoutMs: number;
  /** Stop the command when it writes nothing to stdout or stderr for this long. */
  idleTimeoutMs?: number;
  maxCapturedBytes: number;
  registry?: ActiveProcessRegistry;
  signal?: AbortSignal;
}

export function parseNpmCmdShim(content: string): string | undefined {
  return content.match(/"(?:%dp0%[\\/]|%~dp0[\\/]?)([^"\r\n]+\.(?:js|mjs|cjs))"/i)?.[1];
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

export function resolveSpawnTarget(
  command: string,
  args: string[],
  options: { platform?: NodeJS.Platform; env?: NodeJS.ProcessEnv } = {},
): { command: string; args: string[] } {
  if (/\.(?:js|mjs|cjs)$/i.test(command)) {
    return { command: process.execPath, args: [command, ...args] };
  }

  if ((options.platform ?? process.platform) !== "win32") {
    return { command, args };
  }

  const env = options.env ?? process.env;
  const extensions = (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .filter((extension) => /^\.(?:COM|EXE|BAT|CMD)$/i.test(extension));
  const candidates = /[\\/]/.test(command) || path.win32.extname(command) !== ""
    ? [command]
    : (env.PATH?.split(";") ?? []).flatMap((directory) =>
      extensions.map((extension) => path.win32.join(directory, command + extension)),
    );
  const file = candidates.find(isFile);
  if (file === undefined) {
    return { command, args };
  }

  const extension = path.win32.extname(file).toLowerCase();
  if (extension === ".exe" || extension === ".com") {
    return { command: path.win32.resolve(file), args };
  }

  if (extension === ".cmd" || extension === ".bat") {
    const relativeScript = parseNpmCmdShim(readFileSync(file, "utf8"));
    if (relativeScript !== undefined) {
      const script = path.win32.resolve(path.win32.dirname(file), relativeScript);
      if (isFile(script)) {
        return { command: process.execPath, args: [script, ...args] };
      }
    }

    throw new Error(
      "Node cannot spawn .cmd/.bat files without a shell: " + file +
      ". Point the FRONTIER_*_CLI variable at the native executable or the JavaScript entry file.",
    );
  }

  return { command, args };
}

class TailBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;
  public truncated = false;

  constructor(private readonly maximumBytes: number) {}

  append(chunk: Buffer): void {
    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;

    while (this.bytes > this.maximumBytes && this.chunks.length > 0) {
      const first = this.chunks[0];
      if (first === undefined) {
        break;
      }

      const excess = this.bytes - this.maximumBytes;
      if (first.byteLength <= excess) {
        this.chunks.shift();
        this.bytes -= first.byteLength;
      } else {
        this.chunks[0] = first.subarray(excess);
        this.bytes -= excess;
      }
      this.truncated = true;
    }
  }

  toString(): string {
    return Buffer.concat(this.chunks).toString("utf8");
  }
}

function terminateProcess(pid: number | undefined, signal: NodeJS.Signals): void {
  if (pid === undefined) {
    return;
  }

  try {
    if (process.platform === "win32") {
      // taskkill /T also ends grandchildren. If it is unavailable or denied,
      // still end the direct child so timeouts and cancellation cannot hang.
      const killDirectChild = () => {
        try {
          process.kill(pid, signal);
        } catch {
          // The process may already have exited.
        }
      };
      spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      })
        .once("error", killDirectChild)
        .once("exit", (code) => {
          if (code !== 0) {
            killDirectChild();
          }
        });
    } else {
      process.kill(-pid, signal);
    }
  } catch {
    // The process may already have exited.
  }
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve();
  }

  return new Promise((resolve) => child.once("close", () => resolve()));
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ActiveProcessRegistry {
  private readonly children = new Set<ChildProcessWithoutNullStreams>();

  track(child: ChildProcessWithoutNullStreams): () => void {
    this.children.add(child);
    let released = false;

    return () => {
      if (released) {
        return;
      }
      released = true;
      this.children.delete(child);
    };
  }

  async terminateAll(gracePeriodMs: number = 2_000): Promise<void> {
    const children = [...this.children];
    if (children.length === 0) {
      return;
    }

    for (const child of children) {
      terminateProcess(child.pid, "SIGTERM");
    }

    await Promise.race([
      Promise.all(children.map(async (child) => await waitForExit(child))),
      delay(gracePeriodMs),
    ]);

    const remaining = children.filter(
      (child) => child.exitCode === null && child.signalCode === null,
    );
    for (const child of remaining) {
      terminateProcess(child.pid, "SIGKILL");
    }

    await Promise.race([
      Promise.all(remaining.map(async (child) => await waitForExit(child))),
      delay(1_000),
    ]);
  }
}

export async function runCommand(
  invocation: CommandInvocation,
  options: RunCommandOptions,
): Promise<CommandResult> {
  const startedAt = Date.now();
  const stdout = new TailBuffer(options.maxCapturedBytes);
  const stderr = new TailBuffer(options.maxCapturedBytes);

  return await new Promise<CommandResult>((resolve, reject) => {
    const env = invocation.env ?? process.env;
    const target = resolveSpawnTarget(invocation.command, invocation.args, { env });
    const child = spawn(target.command, target.args, {
      cwd: invocation.cwd,
      env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const releaseProcess = options.registry?.track(child);

    let stopReason: "timeout" | "idle" | "cancelled" | undefined;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const stop = (reason: "timeout" | "idle" | "cancelled") => {
      if (stopReason !== undefined) {
        return;
      }
      stopReason = reason;
      terminateProcess(child.pid, "SIGTERM");
      forceKillTimer = setTimeout(() => terminateProcess(child.pid, "SIGKILL"), 2_000);
      forceKillTimer.unref();
    };

    const timeout = setTimeout(() => stop("timeout"), options.timeoutMs);
    timeout.unref();

    // A specialist that keeps producing output is working; silence means it is stuck.
    const idleTimer =
      options.idleTimeoutMs === undefined
        ? undefined
        : setTimeout(() => stop("idle"), options.idleTimeoutMs);
    idleTimer?.unref();

    // The MCP client cancels the request when it stops waiting; without this the
    // specialist would keep editing files and holding its concurrency slot.
    const onAbort = () => stop("cancelled");
    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted === true) {
      onAbort();
    }

    const cleanup = () => {
      clearTimeout(timeout);
      clearTimeout(idleTimer);
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
      options.signal?.removeEventListener("abort", onAbort);
      releaseProcess?.();
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout.append(chunk);
      idleTimer?.refresh();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr.append(chunk);
      idleTimer?.refresh();
    });

    child.once("error", (error) => {
      cleanup();
      reject(error);
    });

    child.once("close", (exitCode, signal) => {
      cleanup();

      resolve({
        exitCode,
        signal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut: stopReason === "timeout",
        idleTimedOut: stopReason === "idle",
        cancelled: stopReason === "cancelled",
        durationMs: Date.now() - startedAt,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });

    child.stdin.end(invocation.stdin ?? "");
  });
}
