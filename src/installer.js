import { chmod, mkdir, readFile, rename, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { detectEnvironment } from "./environment.js";
import {
  getEffectiveHooksPath,
  getGlobalHooksPath,
  setGlobalHooksPath,
  unsetGlobalHooksPath
} from "./git-config.js";
import {
  MANAGED_FILE_NAMES,
  PRE_COMMIT_FILE_NAME,
  SCANNER_FILE_NAME,
  getManagedFiles,
  getScannerContent,
  resolveHooksDirectory,
  resolveManagedDirectory,
  resolvePreCommitPath,
  resolveScannerPath,
  resolveStatePath
} from "./hooks.js";

export async function installManagedHooks(options = {}) {
  const environment = options.environment ?? (await detectEnvironment(options));
  const execFileFn = options.execFile;
  const preflight = validateInstallPreflight(environment);

  if (preflight.length > 0) {
    return {
      ok: false,
      command: "install",
      exitCode: 1,
      hooksDirectory: null,
      messages: preflight
    };
  }

  const homePath = environment.home.path;
  const nodePath = options.nodePath ?? process.execPath;
  const managedDirectory = resolveManagedDirectory(homePath);
  const hooksDirectory = resolveHooksDirectory(homePath);
  const statePath = resolveStatePath(homePath);
  const previousHooksPath = await getGlobalHooksPath(execFileFn);

  await mkdir(hooksDirectory, { recursive: true, mode: 0o700 });
  await writeManagedFiles(hooksDirectory, nodePath);
  await writeInstallState(statePath, hooksDirectory, previousHooksPath, nodePath);
  await setGlobalHooksPath(hooksDirectory, execFileFn);

  return {
    ok: true,
    command: "install",
    exitCode: 0,
    hooksDirectory,
    managedDirectory,
    messages: [
      `Installed managed hooks in ${hooksDirectory}`,
      `Configured global core.hooksPath to ${hooksDirectory}`
    ]
  };
}

export async function updateManagedHooks(options = {}) {
  const result = await installManagedHooks(options);

  if (!result.ok) {
    return {
      ...result,
      command: "update"
    };
  }

  return {
    ...result,
    command: "update",
    messages: [
      `Updated managed hooks in ${result.hooksDirectory}`,
      `Configured global core.hooksPath to ${result.hooksDirectory}`
    ]
  };
}

export async function uninstallManagedHooks(options = {}) {
  const environment = options.environment ?? (await detectEnvironment(options));
  const execFileFn = options.execFile;
  const preflight = validateUninstallPreflight(environment);

  if (preflight.length > 0) {
    return {
      ok: false,
      command: "uninstall",
      exitCode: 1,
      hooksDirectory: null,
      messages: preflight
    };
  }

  const homePath = environment.home.path;
  const managedDirectory = resolveManagedDirectory(homePath);
  const hooksDirectory = resolveHooksDirectory(homePath);
  const statePath = resolveStatePath(homePath);
  const { state, corrupt } = await readStateFile(statePath);
  const configuredHooksPath = await safeGetGlobalHooksPath(execFileFn);
  const messages = [];

  if (configuredHooksPath === hooksDirectory) {
    if (state?.previousCoreHooksPath) {
      await setGlobalHooksPath(state.previousCoreHooksPath, execFileFn);
      messages.push(`Restored global core.hooksPath to ${state.previousCoreHooksPath}`);
    } else {
      await unsetGlobalHooksPath(execFileFn);
      messages.push(
        corrupt
          ? "Unset global core.hooksPath; GForge state file was unreadable so no prior value could be restored"
          : "Removed global core.hooksPath managed by GForge"
      );
    }
  } else {
    messages.push(
      configuredHooksPath
        ? `Skipped core.hooksPath restore because it points to ${configuredHooksPath}`
        : "Skipped core.hooksPath restore because it is not configured"
    );
  }

  await removeManagedFiles(hooksDirectory, statePath);
  const removedHooksDirectory = await removeEmptyDirectory(hooksDirectory);
  const removedManagedDirectory = await removeEmptyDirectory(managedDirectory);

  messages.push("Removed GForge-owned hook and state files");

  if (!removedHooksDirectory || !removedManagedDirectory) {
    messages.push("Left non-empty GForge directories in place");
  }

  return {
    ok: true,
    command: "uninstall",
    exitCode: 0,
    hooksDirectory,
    managedDirectory,
    messages
  };
}

export async function verifyManagedHooks(options = {}) {
  const environment = options.environment ?? (await detectEnvironment(options));
  const execFileFn = options.execFile;
  const checks = [];

  if (!environment.home.present) {
    return {
      hooksDirectory: null,
      checks: [
        {
          status: "FAIL",
          label: "hooks-directory",
          detail: "home directory not detected"
        }
      ]
    };
  }

  const hooksDirectory = resolveHooksDirectory(environment.home.path);
  const configuredHooksPath = await safeGetGlobalHooksPath(execFileFn);

  checks.push({
    status: configuredHooksPath === hooksDirectory ? "PASS" : "FAIL",
    label: "hooks-path",
    detail: configuredHooksPath
      ? `core.hooksPath is ${configuredHooksPath}`
      : "core.hooksPath is not configured"
  });

  const effectiveHooksPath = await safeGetEffectiveHooksPath(execFileFn);
  if (effectiveHooksPath && effectiveHooksPath !== hooksDirectory) {
    checks.push({
      status: "WARN",
      label: "effective-hooks-path",
      detail: `core.hooksPath resolves to ${effectiveHooksPath} here; a repository-local or system override shadows the managed hooks, so GForge will not run in this repository`
    });
  }

  checks.push(await checkDirectory(hooksDirectory));

  const scannerPath = resolveScannerPath(environment.home.path);
  checks.push(await checkHookContent(SCANNER_FILE_NAME, scannerPath, getScannerContent()));

  const preCommitPath = resolvePreCommitPath(environment.home.path);
  checks.push(await checkPreCommitShim(preCommitPath));
  checks.push(await checkHookExecutable(PRE_COMMIT_FILE_NAME, preCommitPath, environment.platform.name));

  return {
    hooksDirectory,
    checks
  };
}

// The pre-commit shim embeds a machine-specific Node path, so verify checks its
// structure (present and delegating to the managed scanner) rather than an
// exact byte match.
async function checkPreCommitShim(preCommitPath) {
  try {
    const content = await readFile(preCommitPath, "utf8");
    const wired = content.includes(SCANNER_FILE_NAME) && content.includes("exec");
    return {
      status: wired ? "PASS" : "FAIL",
      label: `${PRE_COMMIT_FILE_NAME}-content`,
      detail: wired ? "delegates to managed scanner" : "does not delegate to managed scanner"
    };
  } catch {
    return {
      status: "FAIL",
      label: `${PRE_COMMIT_FILE_NAME}-content`,
      detail: `${preCommitPath} not found`
    };
  }
}

export function formatInstallResult(result) {
  const command = result.command ?? "install";
  const header = result.ok ? `GForge ${command} complete` : `GForge ${command} failed`;
  return `${[header, "", ...result.messages].join("\n")}\n`;
}

function validateInstallPreflight(environment) {
  const messages = [];

  if (!environment.platform.supported) {
    messages.push(`Unsupported platform: ${environment.platform.name}`);
  }

  if (!environment.home.present) {
    messages.push("Home directory not detected.");
  }

  if (!environment.git.available) {
    messages.push("Git is required but was not found.");
  }

  return messages;
}

function validateUninstallPreflight(environment) {
  const messages = [];

  if (!environment.home.present) {
    messages.push("Home directory not detected.");
  }

  if (!environment.git.available) {
    messages.push("Git is required but was not found.");
  }

  return messages;
}

async function writeManagedFiles(hooksDirectory, nodePath) {
  for (const file of getManagedFiles(nodePath)) {
    await writeFileAtomic(join(hooksDirectory, file.name), file.content, file.mode);
  }
}

// Write via a sibling temp file and rename into place so readers (a concurrent
// git commit, or a crash mid-write) never observe a truncated or empty hook.
async function writeFileAtomic(filePath, content, mode) {
  const tempPath = `${filePath}.gforge-tmp`;
  await writeFile(tempPath, content, { mode });
  await chmod(tempPath, mode);
  await rename(tempPath, filePath);
}

async function removeManagedFiles(hooksDirectory, statePath) {
  for (const name of MANAGED_FILE_NAMES) {
    await removeFile(join(hooksDirectory, name));
  }

  await removeFile(statePath);
}

async function removeFile(filePath) {
  try {
    await unlink(filePath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
  }
}

async function removeEmptyDirectory(directoryPath) {
  try {
    await rmdir(directoryPath);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      return true;
    }

    if (error?.code === "ENOTEMPTY" || error?.code === "EEXIST") {
      return false;
    }

    throw error;
  }
}

async function writeInstallState(statePath, hooksDirectory, currentHooksPath, nodePath) {
  const { corrupt, state: existingState } = await readStateFile(statePath);

  if (corrupt) {
    // Never silently discard an unreadable backup; preserve it for recovery
    // rather than overwriting the only record of the original hooks path.
    await preserveCorruptState(statePath);
  }

  let previousCoreHooksPath;
  if (existingState && "previousCoreHooksPath" in existingState) {
    // A prior install already recorded the original config (including a
    // deliberate null meaning "was unset"); never overwrite that backup.
    previousCoreHooksPath = existingState.previousCoreHooksPath;
  } else if (currentHooksPath && currentHooksPath !== hooksDirectory) {
    previousCoreHooksPath = currentHooksPath;
  } else {
    previousCoreHooksPath = null;
  }

  const state = {
    version: 2,
    managedBy: "gforge",
    hooksDirectory,
    nodePath: nodePath ?? null,
    previousCoreHooksPath
  };

  await writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`, 0o600);
}

// Distinguishes a genuinely absent state file (fresh install) from a present
// but unparseable one, so a corrupt file is not mistaken for "no prior state".
async function readStateFile(statePath) {
  let raw;
  try {
    raw = await readFile(statePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return { present: false, corrupt: false, state: null };
    }

    throw error;
  }

  try {
    return { present: true, corrupt: false, state: JSON.parse(raw) };
  } catch {
    return { present: true, corrupt: true, state: null };
  }
}

async function preserveCorruptState(statePath) {
  try {
    await rename(statePath, `${statePath}.corrupt`);
  } catch {
    // Best effort only: if it cannot be preserved, the fresh write proceeds.
  }
}

async function safeGetGlobalHooksPath(execFileFn) {
  try {
    return await getGlobalHooksPath(execFileFn);
  } catch {
    return null;
  }
}

async function safeGetEffectiveHooksPath(execFileFn) {
  try {
    return await getEffectiveHooksPath(execFileFn);
  } catch {
    return null;
  }
}

async function checkDirectory(hooksDirectory) {
  try {
    const directoryStat = await stat(hooksDirectory);
    return {
      status: directoryStat.isDirectory() ? "PASS" : "FAIL",
      label: "hooks-directory",
      detail: hooksDirectory
    };
  } catch {
    return {
      status: "FAIL",
      label: "hooks-directory",
      detail: `${hooksDirectory} not found`
    };
  }
}

async function checkHookContent(name, hookPath, expectedContent) {
  try {
    const actualContent = await readFile(hookPath, "utf8");
    return {
      status: actualContent === expectedContent ? "PASS" : "FAIL",
      label: `${name}-content`,
      detail: actualContent === expectedContent ? "managed content matches" : "managed content differs"
    };
  } catch {
    return {
      status: "FAIL",
      label: `${name}-content`,
      detail: `${hookPath} not found`
    };
  }
}

async function checkHookExecutable(name, hookPath, platform) {
  if (platform === "win32") {
    return {
      status: "PASS",
      label: `${name}-executable`,
      detail: "not required on win32"
    };
  }

  try {
    const hookStat = await stat(hookPath);
    const executable = Boolean(hookStat.mode & 0o111);
    return {
      status: executable ? "PASS" : "FAIL",
      label: `${name}-executable`,
      detail: executable ? "executable" : "not executable"
    };
  } catch {
    return {
      status: "FAIL",
      label: `${name}-executable`,
      detail: `${hookPath} not found`
    };
  }
}
