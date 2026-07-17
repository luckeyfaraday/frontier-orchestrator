import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

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
  durationMs: number;
  stdoutTruncated: boolean;
  stderrTruncated: boolean;
}

export interface RunCommandOptions {
  timeoutMs: number;
  maxCapturedBytes: number;
  registry?: ActiveProcessRegistry;
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
      process.kill(pid, signal);
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
    const child = spawn(invocation.command, invocation.args, {
      cwd: invocation.cwd,
      env: invocation.env ?? process.env,
      detached: process.platform !== "win32",
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const releaseProcess = options.registry?.track(child);

    let timedOut = false;
    let forceKillTimer: NodeJS.Timeout | undefined;

    const timeout = setTimeout(() => {
      timedOut = true;
      terminateProcess(child.pid, "SIGTERM");
      forceKillTimer = setTimeout(() => terminateProcess(child.pid, "SIGKILL"), 2_000);
      forceKillTimer.unref();
    }, options.timeoutMs);
    timeout.unref();

    child.stdout.on("data", (chunk: Buffer) => stdout.append(chunk));
    child.stderr.on("data", (chunk: Buffer) => stderr.append(chunk));

    child.once("error", (error) => {
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
      releaseProcess?.();
      reject(error);
    });

    child.once("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (forceKillTimer !== undefined) {
        clearTimeout(forceKillTimer);
      }
      releaseProcess?.();

      resolve({
        exitCode,
        signal,
        stdout: stdout.toString(),
        stderr: stderr.toString(),
        timedOut,
        durationMs: Date.now() - startedAt,
        stdoutTruncated: stdout.truncated,
        stderrTruncated: stderr.truncated,
      });
    });

    child.stdin.end(invocation.stdin ?? "");
  });
}
