import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installManagedHooks, uninstallManagedHooks, updateManagedHooks, verifyManagedHooks } from "../src/installer.js";
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

test("updates managed hooks idempotently", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock();
  const hooksDirectory = resolveHooksDirectory(homePath);
  const hookPath = join(hooksDirectory, "pre-commit");

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });
  await writeFile(hookPath, "#!/usr/bin/env sh\nexit 0\n");

  const result = await updateManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  assert.equal(result.ok, true);
  assert.equal(await readFile(hookPath, "utf8"), PRE_COMMIT_HOOK);
  assert.equal(git.hooksPath(), hooksDirectory);
});

test("uninstalls managed hooks and restores previous hooks path", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock("/existing/hooks");
  const hooksDirectory = resolveHooksDirectory(homePath);

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  const result = await uninstallManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  assert.equal(result.ok, true);
  assert.equal(git.hooksPath(), "/existing/hooks");
  await assert.rejects(stat(join(hooksDirectory, "pre-commit")), { code: "ENOENT" });
  await assert.rejects(stat(resolveStatePath(homePath)), { code: "ENOENT" });
});

test("uninstalls managed hooks and unsets hooks path when no previous path exists", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock();

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  const result = await uninstallManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  assert.equal(result.ok, true);
  assert.equal(git.hooksPath(), null);
});

test("uninstall tolerates corrupted state file", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock();

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });
  await writeFile(resolveStatePath(homePath), "not json\n");

  const result = await uninstallManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  assert.equal(result.ok, true);
  assert.equal(git.hooksPath(), null);
});

test("uninstall does not overwrite unrelated hooks path", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock("/existing/hooks");

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  git.setHooksPath("/other/hooks");
  const result = await uninstallManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  assert.equal(result.ok, true);
  assert.equal(git.hooksPath(), "/other/hooks");
  assert.match(result.messages.join("\n"), /Skipped core\.hooksPath restore/);
});

test("uninstall leaves non-empty GForge directories in place", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock();

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });
  await mkdir(resolveHooksDirectory(homePath), { recursive: true });
  await writeFile(join(resolveHooksDirectory(homePath), "custom"), "user file\n");

  const result = await uninstallManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  assert.equal(result.ok, true);
  assert.match(result.messages.join("\n"), /Left non-empty GForge directories in place/);
  assert.equal(await readFile(join(resolveHooksDirectory(homePath), "custom"), "utf8"), "user file\n");
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
    setHooksPath: (value) => {
      hooksPath = value;
    },
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

      if (args.join(" ") === "config --global --unset core.hooksPath") {
        hooksPath = null;
        return { stdout: "" };
      }

      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    }
  };
}
