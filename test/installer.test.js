import assert from "node:assert/strict";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installManagedHooks, verifyManagedHooks } from "../src/installer.js";
import { PRE_COMMIT_HOOK, resolveHooksDirectory, resolveStatePath } from "../src/hooks.js";

test("installs managed hooks and configures global hooks path", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock();
  const result = await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });
  const hooksDirectory = resolveHooksDirectory(homePath);
  const hookPath = join(hooksDirectory, "pre-commit");

  assert.equal(result.ok, true);
  assert.equal(git.hooksPath(), hooksDirectory);
  assert.equal(await readFile(hookPath, "utf8"), PRE_COMMIT_HOOK);
  assert.equal(Boolean((await stat(hookPath)).mode & 0o111), true);
});

test("preserves previous global hooks path in state", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock("/existing/hooks");

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  const state = JSON.parse(await readFile(resolveStatePath(homePath), "utf8"));
  assert.equal(state.previousCoreHooksPath, "/existing/hooks");
});

test("verifies installed managed hooks", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock();

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  const report = await verifyManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  assert.equal(report.checks.every((check) => check.status === "PASS"), true);
});

test("verify reports missing managed hooks", async () => {
  const homePath = await createTempHome();
  const report = await verifyManagedHooks({
    environment: createEnvironment(homePath),
    execFile: createGitConfigMock().execFile
  });

  assert.equal(report.checks.some((check) => check.status === "FAIL"), true);
});

test("pre-commit hook lists files without printing matched secret values", () => {
  assert.match(PRE_COMMIT_HOOK, /git grep --cached -l/);
  assert.doesNotMatch(PRE_COMMIT_HOOK, /git grep --cached -n/);
});

async function createTempHome() {
  return mkdtemp(join(tmpdir(), "gforge-test-"));
}

function createEnvironment(homePath) {
  return {
    platform: { name: "darwin", arch: "arm64", supported: true, isWsl: false },
    home: { path: homePath, present: true },
    shell: { path: "/bin/zsh", name: "zsh", supported: true },
    git: { available: true, version: "2.45.0", rawVersion: "git version 2.45.0" }
  };
}

function createGitConfigMock(initialHooksPath = null) {
  let hooksPath = initialHooksPath;

  return {
    hooksPath: () => hooksPath,
    execFile: async (command, args) => {
      assert.equal(command, "git");

      if (args.join(" ") === "config --global --get core.hooksPath") {
        if (!hooksPath) {
          const error = new Error("unset");
          error.code = 1;
          throw error;
        }

        return { stdout: `${hooksPath}\n` };
      }

      if (args.slice(0, 3).join(" ") === "config --global core.hooksPath") {
        hooksPath = args[3];
        return { stdout: "" };
      }

      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    }
  };
}
