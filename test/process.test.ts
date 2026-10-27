import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import {
  ActiveProcessRegistry,
  parseNpmCmdShim,
  resolveSpawnTarget,
  runCommand,
} from "../src/process.js";

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

test("ActiveProcessRegistry terminates an in-flight command", async () => {
  const registry = new ActiveProcessRegistry();
  const startedAt = Date.now();
  const running = runCommand(
    {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
    },
    {
      timeoutMs: 10_000,
      maxCapturedBytes: 10_000,
      registry,
    },
  );

  await delay(100);
  await registry.terminateAll(200);
  const result = await running;

  assert.ok(result.signal !== null || result.exitCode !== 0);
  assert.ok(Date.now() - startedAt < 3_000);
});

test("runCommand terminates the child when the request signal aborts", async () => {
  const controller = new AbortController();
  const startedAt = Date.now();
  const running = runCommand(
    {
      command: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      cwd: process.cwd(),
    },
    {
      timeoutMs: 10_000,
      maxCapturedBytes: 10_000,
      signal: controller.signal,
    },
  );

  await delay(100);
  controller.abort();
  const result = await running;

  assert.equal(result.cancelled, true);
  assert.equal(result.timedOut, false);
  assert.ok(result.signal !== null || result.exitCode !== 0);
  assert.ok(Date.now() - startedAt < 3_000);
});

const kimiScript = String.raw`node_modules\@moonshot-ai\kimi-code\dist\main.mjs`;
const codexScript = String.raw`node_modules\@openai\codex\bin\codex.js`;
const kimiShim = String.raw`@ECHO off
GOTO start
:find_dp0
SET dp0=%~dp0
EXIT /b
:start
SETLOCAL
CALL :find_dp0

IF EXIST "%dp0%\node.exe" (
  SET "_prog=%dp0%\node.exe"
) ELSE (
  SET "_prog=node"
  SET PATHEXT=%PATHEXT:;.JS;=;%
)

endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\node_modules\@moonshot-ai\kimi-code\dist\main.mjs" %*`;
const codexShim = kimiShim.replace(kimiScript, codexScript);

async function temporaryDirectory(t: TestContext): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "frontier-process-"));
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  t.after(async () => await rm(directory, { recursive: true, force: true }));
  return directory;
}

async function waitFor(
  condition: () => boolean | Promise<boolean>,
  message: string,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    assert.ok(Date.now() < deadline, message);
    await delay(25);
  }
}

test("parseNpmCmdShim extracts npm JavaScript entry files", () => {
  assert.equal(parseNpmCmdShim(kimiShim), kimiScript);
  assert.equal(parseNpmCmdShim(codexShim), codexScript);
  assert.equal(
    parseNpmCmdShim(String.raw`"node" "%~dp0node_modules\tool\index.CJS" %*`),
    String.raw`node_modules\tool\index.CJS`,
  );
  assert.equal(
    parseNpmCmdShim(String.raw`"node" "%~dp0\node_modules\tool\index.js" %*`),
    String.raw`node_modules\tool\index.js`,
  );
  assert.equal(parseNpmCmdShim("@echo off\r\necho unrelated batch content\r\n"), undefined);
});

test("resolveSpawnTarget runs JavaScript entry files with Node on every platform", () => {
  for (const extension of ["js", "mjs", "cjs", "MJS"]) {
    const command = path.join(os.tmpdir(), "specialist." + extension);
    const args = ["--version"];
    assert.deepEqual(resolveSpawnTarget(command, args), {
      command: process.execPath,
      args: [command, ...args],
    });
    assert.deepEqual(args, ["--version"]);
  }
});

test("resolveSpawnTarget leaves a plain Linux command unchanged", () => {
  assert.deepEqual(resolveSpawnTarget("kimi", ["--version"], { platform: "linux" }), {
    command: "kimi",
    args: ["--version"],
  });
});

test("resolveSpawnTarget finds npm shims instead of POSIX scripts on Windows", {
  skip: process.platform !== "win32",
}, async (t) => {
  const directory = await temporaryDirectory(t);
  const script = path.win32.join(directory, kimiScript);
  await mkdir(path.win32.dirname(script), { recursive: true });
  await writeFile(script, "");
  await writeFile(path.win32.join(directory, "kimi"), "#!/bin/sh\n");
  await writeFile(path.win32.join(directory, "kimi.js"), "");
  const shim = path.win32.join(directory, "kimi.cmd");
  await writeFile(shim, kimiShim);
  const options = {
    platform: "win32" as const,
    env: { PATH: directory, PATHEXT: ".COM;.EXE;.BAT;.CMD;.JS" },
  };

  assert.deepEqual(resolveSpawnTarget("kimi", ["--version"], options), {
    command: process.execPath,
    args: [script, "--version"],
  });
  assert.deepEqual(resolveSpawnTarget(shim, ["--version"], options), {
    command: process.execPath,
    args: [script, "--version"],
  });

  await rm(shim);
  assert.deepEqual(resolveSpawnTarget("kimi", ["--version"], options), {
    command: "kimi",
    args: ["--version"],
  });
});

test("resolveSpawnTarget honors Windows PATH and PATHEXT order", {
  skip: process.platform !== "win32",
}, async (t) => {
  const directory = await temporaryDirectory(t);
  const laterDirectory = path.win32.join(directory, "later");
  await mkdir(laterDirectory);
  const executable = path.win32.join(directory, "tool.exe");
  const comFile = path.win32.join(directory, "tool.COM");
  await writeFile(executable, "");
  await writeFile(comFile, "");
  await writeFile(path.win32.join(laterDirectory, "tool.exe"), "");

  assert.deepEqual(resolveSpawnTarget("tool", ["--version"], {
    platform: "win32",
    env: { PATH: directory },
  }), { command: comFile, args: ["--version"] });
  assert.deepEqual(resolveSpawnTarget("tool", [], {
    platform: "win32",
    env: { PATH: directory, PATHEXT: ".exe;.COM" },
  }), { command: executable, args: [] });

  await rm(executable);
  assert.deepEqual(resolveSpawnTarget("tool", [], {
    platform: "win32",
    env: { PATH: directory + ";" + laterDirectory, PATHEXT: ".EXE;.COM" },
  }), { command: comFile, args: [] });

  const relativeFile = path.win32.relative(process.cwd(), comFile);
  assert.deepEqual(resolveSpawnTarget(relativeFile, ["--version"], {
    platform: "win32",
    env: {},
  }), { command: comFile, args: ["--version"] });
});

test("resolveSpawnTarget rejects unsupported or broken Windows batch shims", {
  skip: process.platform !== "win32",
}, async (t) => {
  const directory = await temporaryDirectory(t);
  const unparseable = path.win32.join(directory, "unparseable.cmd");
  const missingScript = path.win32.join(directory, "missing.bat");
  await writeFile(unparseable, "@echo off\r\necho unrelated batch content\r\n");
  await writeFile(missingScript, kimiShim);

  for (const command of [unparseable, missingScript]) {
    assert.throws(() => resolveSpawnTarget(command, [], { platform: "win32" }), {
      message: /Node cannot spawn \.cmd\/\.bat files without a shell.*FRONTIER_\*_CLI.*native executable or the JavaScript entry file/,
    });
  }
});

test("runCommand resolves Windows shims using the invocation environment", {
  skip: process.platform !== "win32",
}, async (t) => {
  const directory = await temporaryDirectory(t);
  const script = path.win32.join(directory, kimiScript);
  await mkdir(path.win32.dirname(script), { recursive: true });
  await writeFile(script, "console.log(JSON.stringify(process.argv.slice(2)));");
  await writeFile(path.win32.join(directory, "kimi.cmd"), kimiShim);
  const args = ["prompt with spaces", "& echo unexpected", '"quoted"'];
  const result = await runCommand({
    command: "kimi",
    args,
    cwd: directory,
    env: { ...process.env, PATH: directory, PATHEXT: ".CMD" },
  }, {
    timeoutMs: 10_000,
    maxCapturedBytes: 10_000,
  });

  assert.equal(result.exitCode, 0);
  assert.deepEqual(JSON.parse(result.stdout), args);
});

test("runCommand terminates grandchildren when the request signal aborts", async (t) => {
  const directory = await temporaryDirectory(t);
  const pidFile = path.join(directory, "grandchild.pid");
  const controller = new AbortController();
  const parent = [
    'const { spawn } = require("node:child_process");',
    'const { writeFileSync } = require("node:fs");',
    'const grandchild = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
    // Keep the POSIX parent alive until it has reaped the terminated grandchild.
    'process.on("SIGTERM", () => {});',
    'grandchild.once("exit", () => process.exit(0));',
    'grandchild.once("spawn", () => {',
    '  console.log(grandchild.pid);',
    '  writeFileSync(process.argv[1], String(grandchild.pid));',
    '});',
  ].join("\n");
  const running = runCommand({
    command: process.execPath,
    args: ["-e", parent, pidFile],
    cwd: process.cwd(),
  }, {
    timeoutMs: 10_000,
    maxCapturedBytes: 10_000,
    signal: controller.signal,
  });

  let grandchildPid = 0;
  try {
    await waitFor(async () => {
      try {
        grandchildPid = Number(await readFile(pidFile, "utf8"));
        return Number.isInteger(grandchildPid) && grandchildPid > 0;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
          throw error;
        }
        return false;
      }
    }, "The parent did not report its grandchild PID within 5 seconds");

    controller.abort();
    await waitFor(() => {
      try {
        process.kill(grandchildPid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          throw error;
        }
        return true;
      }
    }, "The grandchild still exists 5 seconds after cancellation");
    const result = await running;
    assert.equal(result.cancelled, true);
    assert.equal(result.timedOut, false);
    assert.equal(Number(result.stdout.trim()), grandchildPid);
  } finally {
    controller.abort();
    if (grandchildPid > 0) {
      try {
        process.kill(grandchildPid, "SIGKILL");
      } catch {
        // The grandchild may already have exited.
      }
    }
    await running;
  }
});

test("runCommand stops a command that goes silent for the idle timeout", async () => {
  const startedAt = Date.now();
  const result = await runCommand(
    {
      command: process.execPath,
      args: ["-e", 'console.log("started"); setInterval(() => {}, 1000)'],
      cwd: process.cwd(),
    },
    {
      timeoutMs: 10_000,
      idleTimeoutMs: 300,
      maxCapturedBytes: 10_000,
    },
  );

  assert.equal(result.idleTimedOut, true);
  assert.equal(result.timedOut, false);
  assert.equal(result.cancelled, false);
  assert.match(result.stdout, /started/);
  assert.ok(Date.now() - startedAt < 5_000);
});

test("runCommand keeps a command alive while it produces output", async () => {
  const result = await runCommand(
    {
      command: process.execPath,
      args: [
        "-e",
        'let n = 0; const t = setInterval(() => { console.error("tick"); if (++n === 8) { clearInterval(t); console.log("done"); } }, 100)',
      ],
      cwd: process.cwd(),
    },
    {
      timeoutMs: 10_000,
      idleTimeoutMs: 400,
      maxCapturedBytes: 10_000,
    },
  );

  assert.equal(result.idleTimedOut, false);
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /done/);
});
