import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { installManagedHooks, uninstallManagedHooks, updateManagedHooks, verifyManagedHooks } from "../src/installer.js";
import {
  SCANNER_FILE_NAME,
  getScannerContent,
  resolveHooksDirectory,
  resolvePreCommitPath,
  resolveScannerPath,
  resolveStatePath
} from "../src/hooks.js";

test("installs managed hooks and configures global hooks path", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock();
  const result = await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });
  const hooksDirectory = resolveHooksDirectory(homePath);
  const scannerPath = resolveScannerPath(homePath);
  const preCommitPath = resolvePreCommitPath(homePath);

  assert.equal(result.ok, true);
  assert.equal(git.hooksPath(), hooksDirectory);
  // The scanner engine is copied verbatim from the package source.
  assert.equal(await readFile(scannerPath, "utf8"), getScannerContent());
  // pre-commit is an executable shim that delegates to the scanner.
  const preCommit = await readFile(preCommitPath, "utf8");
  assert.match(preCommit, new RegExp(SCANNER_FILE_NAME));
  assert.equal(Boolean((await stat(preCommitPath)).mode & 0o111), true);
});

test("bakes the install-time node path into the hook shim as a fallback", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock();

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile,
    nodePath: "/opt/custom/bin/node"
  });

  const preCommit = await readFile(resolvePreCommitPath(homePath), "utf8");
  assert.match(preCommit, /\/opt\/custom\/bin\/node/);
  assert.match(preCommit, /exec "\$NODE" "\$SCANNER"/);
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

test("records the gforge version in state so upgrades are detectable", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock();

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  const state = JSON.parse(await readFile(resolveStatePath(homePath), "utf8"));
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(state.gforgeVersion, pkg.version);
});

test("verify flags a stale on-disk engine and points at the fix", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock();

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });
  // Simulate an upgraded package whose on-disk hook was not refreshed.
  await writeFile(resolveScannerPath(homePath), "// stale engine\n");

  const report = await verifyManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  const scannerCheck = report.checks.find((check) => check.label.startsWith(SCANNER_FILE_NAME));
  assert.equal(scannerCheck.status, "FAIL");
  assert.match(scannerCheck.detail, /stale|gforge update/);
});

test("updates managed hooks idempotently", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock();
  const hooksDirectory = resolveHooksDirectory(homePath);
  const scannerPath = resolveScannerPath(homePath);

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });
  await writeFile(scannerPath, "// tampered scanner\n");

  const result = await updateManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  assert.equal(result.ok, true);
  assert.equal(await readFile(scannerPath, "utf8"), getScannerContent());
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

test("issue #40: uninstall aborts without deleting anything when reading core.hooksPath fails transiently", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock();
  const hooksDirectory = resolveHooksDirectory(homePath);

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  // The real gitconfig still has core.hooksPath = the managed directory -
  // only this one read of it fails, transiently (e.g. a momentary lock/IO
  // error), which must not be mistaken for "not configured".
  const flakyExecFile = async (command, args) => {
    if (args.join(" ") === "config --global --get core.hooksPath") {
      const error = new Error("could not lock config file .gitconfig: File exists");
      error.code = "EBUSY";
      throw error;
    }
    return git.execFile(command, args);
  };

  const result = await uninstallManagedHooks({
    environment: createEnvironment(homePath),
    execFile: flakyExecFile
  });

  assert.equal(result.ok, false);
  // Nothing was touched: the managed hook file is still on disk, the
  // gitconfig value is untouched, and it still points at that same
  // directory - so no commit-blocking hook silently goes dark machine-wide.
  await assert.doesNotReject(stat(join(hooksDirectory, "pre-commit")));
  assert.equal(git.hooksPath(), hooksDirectory);
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

test("installs both managed files and delegates the pre-commit shim to the scanner", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock();

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  const scannerPath = resolveScannerPath(homePath);
  const preCommit = await readFile(resolvePreCommitPath(homePath), "utf8");

  // The engine file exists and the shim runs it via node.
  assert.equal((await readFile(scannerPath, "utf8")).length > 0, true);
  assert.match(preCommit, /exec "\$NODE" "\$SCANNER"/);
  // Fail-closed if no node runtime is found.
  assert.match(preCommit, /blocking commit for safety/);
});

test("reinstall does not fabricate a backup over a recorded 'was unset' state", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock();

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  // Something external repoints core.hooksPath away from the managed dir before a reinstall.
  git.setHooksPath("/some/other/hooks");
  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  const state = JSON.parse(await readFile(resolveStatePath(homePath), "utf8"));
  assert.equal(state.previousCoreHooksPath, null);
});

test("reinstall preserves an unreadable state file instead of discarding it", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock("/existing/hooks");

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });
  await writeFile(resolveStatePath(homePath), "totally not json");

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  assert.equal(await readFile(`${resolveStatePath(homePath)}.corrupt`, "utf8"), "totally not json");
  const state = JSON.parse(await readFile(resolveStatePath(homePath), "utf8"));
  assert.equal(state.managedBy, "gforge");
});

test("install leaves no temporary files behind", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock();

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  await assert.rejects(stat(`${resolvePreCommitPath(homePath)}.gforge-tmp`), { code: "ENOENT" });
  await assert.rejects(stat(`${resolveScannerPath(homePath)}.gforge-tmp`), { code: "ENOENT" });
  await assert.rejects(stat(`${resolveStatePath(homePath)}.gforge-tmp`), { code: "ENOENT" });
});

test("verify warns when a repo-local hooks path shadows the managed hooks", async () => {
  const homePath = await createTempHome();
  const hooksDirectory = resolveHooksDirectory(homePath);
  const execFile = async (command, args) => {
    assert.equal(command, "git");
    const joined = args.join(" ");

    if (joined === "config --global --get core.hooksPath") {
      return { stdout: `${hooksDirectory}\n` };
    }

    if (joined === "config --get core.hooksPath") {
      return { stdout: "/repo/.husky/_\n" };
    }

    throw new Error(`Unexpected git args: ${joined}`);
  };

  const report = await verifyManagedHooks({
    environment: createEnvironment(homePath),
    execFile
  });

  const warning = report.checks.find((check) => check.label === "effective-hooks-path");
  assert.ok(warning, "expected an effective-hooks-path check");
  assert.equal(warning.status, "WARN");
  assert.match(warning.detail, /\.husky/);
  // issue #42: this check says GForge will not run here, so it must be marked
  // blocking - that flag is what makes `gforge verify` exit non-zero instead
  // of reporting an unprotected repository as healthy.
  assert.equal(warning.blocking, true);
});

test("issue #40: uninstall aborts, and removes nothing, when the global gitconfig cannot be read", async () => {
  // Previously this uninstall would still remove the managed hook/state files
  // and report success - treating an unreadable gitconfig exactly like "no
  // hooksPath configured". If the real config value was still the managed
  // directory, that left global core.hooksPath silently pointed at deleted
  // files: every git hook on the machine, of any kind, goes dark with no
  // warning. The read failure must abort instead of being flattened away.
  const homePath = await createTempHome();
  const git = createGitConfigMock();

  await installManagedHooks({
    environment: createEnvironment(homePath),
    execFile: git.execFile
  });

  // Simulate a malformed ~/.gitconfig: reads fail with a non-1 exit code.
  const execFile = async (command, args) => {
    const joined = args.join(" ");

    if (joined === "config --global --get core.hooksPath" || joined === "config --get core.hooksPath") {
      const error = new Error("fatal: bad config");
      error.code = 128;
      throw error;
    }

    return git.execFile(command, args);
  };

  const result = await uninstallManagedHooks({
    environment: createEnvironment(homePath),
    execFile
  });

  assert.equal(result.ok, false);
  await assert.doesNotReject(stat(join(resolveHooksDirectory(homePath), "pre-commit")));
  await assert.doesNotReject(stat(resolveStatePath(homePath)));
});

test("refuses to install on a git older than 2.9 (no core.hooksPath support)", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock();
  const environment = { ...createEnvironment(homePath), git: { available: true, version: "2.8.4", rawVersion: "git version 2.8.4" } };

  const result = await installManagedHooks({ environment, execFile: git.execFile });

  assert.equal(result.ok, false);
  assert.match(result.messages.join("\n"), /does not support core\.hooksPath/);
  // Must fail closed: nothing should have been configured against this git.
  assert.equal(git.hooksPath(), null);
});

test("installs fine on exactly the minimum supported git version (2.9.0)", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock();
  const environment = { ...createEnvironment(homePath), git: { available: true, version: "2.9.0", rawVersion: "git version 2.9.0" } };

  const result = await installManagedHooks({ environment, execFile: git.execFile });

  assert.equal(result.ok, true);
});

test("tolerates platform-specific suffixes on the git version string (e.g. Apple Git builds)", async () => {
  const homePath = await createTempHome();
  const git = createGitConfigMock();
  const environment = {
    ...createEnvironment(homePath),
    git: { available: true, version: "2.39.2 (Apple Git-143)", rawVersion: "git version 2.39.2 (Apple Git-143)" }
  };

  const result = await installManagedHooks({ environment, execFile: git.execFile });

  assert.equal(result.ok, true);
});

test("verify fails the git-version check on an old git even if hooksPath happens to be configured", async () => {
  const homePath = await createTempHome();
  const hooksDirectory = resolveHooksDirectory(homePath);
  // Simulates the exact silent-failure scenario from the bug report: an old
  // git that accepted and stored core.hooksPath without ever consulting it.
  const git = createGitConfigMock(hooksDirectory);
  const environment = { ...createEnvironment(homePath), git: { available: true, version: "2.7.0", rawVersion: "git version 2.7.0" } };

  const report = await verifyManagedHooks({ environment, execFile: git.execFile });

  const versionCheck = report.checks.find((check) => check.label === "git-version");
  assert.ok(versionCheck, "expected a git-version check");
  assert.equal(versionCheck.status, "FAIL");
  assert.match(versionCheck.detail, /does not support core\.hooksPath/);
  // The hooks-path check itself can still legitimately show PASS - that's
  // exactly the trap: config matches, but the hook never runs.
  const hooksPathCheck = report.checks.find((check) => check.label === "hooks-path");
  assert.equal(hooksPathCheck.status, "PASS");
});

test("issue #41: verify warns when a classic .git/hooks/pre-commit is dormant under GForge's global path", async () => {
  const homePath = await createTempHome();
  const repoGitDir = await createTempHome(); // reused as a stand-in "repo" .git directory
  await mkdir(join(repoGitDir, "hooks"), { recursive: true });
  const classicHook = join(repoGitDir, "hooks", "pre-commit");
  await writeFile(classicHook, "#!/bin/sh\nexit 1\n");
  await chmod(classicHook, 0o755);

  const hooksDirectory = resolveHooksDirectory(homePath);
  const git = createGitConfigMock(hooksDirectory, repoGitDir); // GForge already the active hooksPath

  const report = await verifyManagedHooks({ environment: createEnvironment(homePath), execFile: git.execFile });

  const shadowed = report.checks.find((check) => check.label === "classic-hook-shadowed");
  assert.ok(shadowed, "expected a classic-hook-shadowed check");
  assert.equal(shadowed.status, "WARN");
  assert.match(shadowed.detail, /is executable but dormant/);
  assert.match(shadowed.detail, new RegExp(classicHook.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("issue #41: no warning when there is no classic hook file, it isn't executable, or GForge isn't the active hooksPath", async () => {
  const homePath = await createTempHome();
  const hooksDirectory = resolveHooksDirectory(homePath);

  // No classic hook file at all.
  const emptyRepoDir = await createTempHome();
  await mkdir(join(emptyRepoDir, "hooks"), { recursive: true });
  let git = createGitConfigMock(hooksDirectory, emptyRepoDir);
  let report = await verifyManagedHooks({ environment: createEnvironment(homePath), execFile: git.execFile });
  assert.equal(report.checks.some((check) => check.label === "classic-hook-shadowed"), false);

  // Classic hook file present but not executable - git would never have run
  // it either, so it isn't something GForge's install newly broke.
  const nonExecRepoDir = await createTempHome();
  await mkdir(join(nonExecRepoDir, "hooks"), { recursive: true });
  await writeFile(join(nonExecRepoDir, "hooks", "pre-commit"), "#!/bin/sh\nexit 1\n");
  git = createGitConfigMock(hooksDirectory, nonExecRepoDir);
  report = await verifyManagedHooks({ environment: createEnvironment(homePath), execFile: git.execFile });
  assert.equal(report.checks.some((check) => check.label === "classic-hook-shadowed"), false);

  // A classic hook exists and GForge is installed, but something else (e.g.
  // Husky) is the hooksPath actually in effect here - already surfaced via
  // effective-hooks-path, so this check does not also fire. A dedicated mock
  // (not the one above) so "config --get" and "rev-parse --git-dir" cannot
  // accidentally resolve against the wrong scenario's directories.
  const shadowedByOtherDir = await createTempHome();
  await mkdir(join(shadowedByOtherDir, "hooks"), { recursive: true });
  const otherClassicHook = join(shadowedByOtherDir, "hooks", "pre-commit");
  await writeFile(otherClassicHook, "#!/bin/sh\nexit 1\n");
  await chmod(otherClassicHook, 0o755);
  const otherGit = createGitConfigMock(hooksDirectory, shadowedByOtherDir);
  const execFile = async (command, args) => {
    if (args.join(" ") === "config --get core.hooksPath") return { stdout: "/opt/husky/hooks\n" };
    return otherGit.execFile(command, args);
  };
  report = await verifyManagedHooks({ environment: createEnvironment(homePath), execFile });
  assert.equal(report.checks.some((check) => check.label === "classic-hook-shadowed"), false);
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

// gitDir, when provided, simulates running inside a repository whose
// `git rev-parse --git-dir` resolves to that path; the default (null)
// simulates not being inside a git repository at all (rev-parse fails),
// matching where every pre-existing test in this file already runs from.
function createGitConfigMock(initialHooksPath = null, gitDir = null) {
  let hooksPath = initialHooksPath;

  return {
    hooksPath: () => hooksPath,
    setHooksPath: (value) => {
      hooksPath = value;
    },
    execFile: async (command, args) => {
      assert.equal(command, "git");

      if (
        args.join(" ") === "config --global --get core.hooksPath" ||
        args.join(" ") === "config --get core.hooksPath"
      ) {
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

      if (args.join(" ") === "rev-parse --git-dir") {
        if (!gitDir) {
          const error = new Error("fatal: not a git repository (or any of the parent directories): .git");
          error.code = 128;
          throw error;
        }
        return { stdout: `${gitDir}\n` };
      }

      throw new Error(`Unexpected git args: ${args.join(" ")}`);
    }
  };
}
