import type { RuntimeConfig } from "./config.js";
import path from "node:path";
import {
  ActiveProcessRegistry,
  runCommand,
  type CommandInvocation,
  type CommandResult,
} from "./process.js";

export class ConcurrencyGate {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly maximum: number) {}

  async acquire(): Promise<() => void> {
    if (this.active >= this.maximum) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    } else {
      this.active += 1;
    }

    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      const next = this.waiters.shift();
      if (next !== undefined) {
        next();
      } else {
        this.active -= 1;
      }
    };
  }
}

export class WorkspaceMutationGuard {
  private readonly activeMutations = new Map<string, number>();

  acquire(workingDirectory: string, allowConcurrentMutation: boolean): () => void {
    const conflictingWorkspace = [...this.activeMutations.keys()].find((activeDirectory) => {
      const relativeFromActive = path.relative(activeDirectory, workingDirectory);
      const relativeFromRequested = path.relative(workingDirectory, activeDirectory);
      return (
        relativeFromActive === "" ||
        (!relativeFromActive.startsWith(`..${path.sep}`) &&
          relativeFromActive !== ".." &&
          !path.isAbsolute(relativeFromActive)) ||
        (!relativeFromRequested.startsWith(`..${path.sep}`) &&
          relativeFromRequested !== ".." &&
          !path.isAbsolute(relativeFromRequested))
      );
    });

    if (conflictingWorkspace !== undefined && !allowConcurrentMutation) {
      throw new Error(
        `Another specialist is already mutating ${conflictingWorkspace}, which overlaps ${workingDirectory}. ` +
          "Wait for it to finish, or explicitly allow concurrent mutation only when file scopes do not overlap.",
      );
    }

    const active = this.activeMutations.get(workingDirectory) ?? 0;
    this.activeMutations.set(workingDirectory, active + 1);
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      const remaining = (this.activeMutations.get(workingDirectory) ?? 1) - 1;
      if (remaining <= 0) {
        this.activeMutations.delete(workingDirectory);
      } else {
        this.activeMutations.set(workingDirectory, remaining);
      }
    };
  }
}

export class SpecialistCoordinator {
  private readonly concurrency: ConcurrencyGate;
  private readonly mutations = new WorkspaceMutationGuard();
  private readonly processes = new ActiveProcessRegistry();

  constructor(private readonly config: RuntimeConfig) {
    this.concurrency = new ConcurrencyGate(config.maxConcurrency);
  }

  async run(
    invocation: CommandInvocation,
    timeoutSeconds: number,
    mutatesWorkspace: boolean,
    allowConcurrentMutation: boolean,
  ): Promise<CommandResult> {
    const releaseConcurrency = await this.concurrency.acquire();
    let releaseMutation: (() => void) | undefined;

    try {
      if (mutatesWorkspace) {
        releaseMutation = this.mutations.acquire(invocation.cwd, allowConcurrentMutation);
      }

      return await runCommand(invocation, {
        timeoutMs: timeoutSeconds * 1_000,
        maxCapturedBytes: this.config.maxCapturedBytes,
        registry: this.processes,
      });
    } finally {
      releaseMutation?.();
      releaseConcurrency();
    }
  }

  async shutdown(): Promise<void> {
    await this.processes.terminateAll();
  }
}
