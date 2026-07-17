import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadRuntimeConfig, resolveWorkingDirectory } from "../src/config.js";

test("resolveWorkingDirectory accepts directories beneath the project root", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frontier-config-"));
  await mkdir(path.join(root, "packages", "api"), { recursive: true });
  const config = await loadRuntimeConfig({ FRONTIER_PROJECT_ROOT: root }, root);

  const resolved = await resolveWorkingDirectory("packages/api", config);
  assert.equal(resolved, path.join(root, "packages", "api"));
});

test("resolveWorkingDirectory rejects paths outside allowed roots", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frontier-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "frontier-outside-"));
  const config = await loadRuntimeConfig({ FRONTIER_PROJECT_ROOT: root }, root);

  await assert.rejects(resolveWorkingDirectory(outside, config), /outside the allowed roots/);
});

test("resolveWorkingDirectory resolves symlinks before containment checks", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "frontier-root-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "frontier-outside-"));
  await symlink(outside, path.join(root, "escape"));
  const config = await loadRuntimeConfig({ FRONTIER_PROJECT_ROOT: root }, root);

  await assert.rejects(resolveWorkingDirectory("escape", config), /outside the allowed roots/);
});
