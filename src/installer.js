import { chmod, mkdir, readFile, rmdir, stat, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { detectEnvironment } from "./environment.js";
import { getGlobalHooksPath, setGlobalHooksPath, unsetGlobalHooksPath } from "./git-config.js";
import {
  MANAGED_HOOKS,
  resolveHooksDirectory,
  resolveManagedDirectory,
  resolveStatePath
} from "./hooks.js";

const EXECUTABLE_MODE = 0o755;

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
  const managedDirectory = resolveManagedDirectory(homePath);
  const hooksDirectory = resolveHooksDirectory(homePath);
  const statePath = resolveStatePath(homePath);
  const previousHooksPath = await getGlobalHooksPath(execFileFn);

  await mkdir(hooksDirectory, { recursive: true, mode: 0o700 });
  await writeManagedHooks(hooksDirectory);
  await writeInstallState(statePath, hooksDirectory, previousHooksPath);
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
  const state = await readJsonFile(statePath);
  const configuredHooksPath = await getGlobalHooksPath(execFileFn);
  const messages = [];

  if (configuredHooksPath === hooksDirectory) {
    if (state?.previousCoreHooksPath) {
      await setGlobalHooksPath(state.previousCoreHooksPath, execFileFn);
      messages.push(`Restored global core.hooksPath to ${state.previousCoreHooksPath}`);
    } else {
      await unsetGlobalHooksPath(execFileFn);
      messages.push("Removed global core.hooksPath managed by GForge");
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

  checks.push(await checkDirectory(hooksDirectory));

  for (const [name, expectedContent] of MANAGED_HOOKS) {
    const hookPath = join(hooksDirectory, name);
    checks.push(await checkHookContent(name, hookPath, expectedContent));
    checks.push(await checkHookExecutable(name, hookPath, environment.platform.name));
  }

  return {
    hooksDirectory,
    checks
  };
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

async function writeManagedHooks(hooksDirectory) {
  for (const [name, content] of MANAGED_HOOKS) {
    const hookPath = join(hooksDirectory, name);
    await writeFile(hookPath, content, { mode: EXECUTABLE_MODE });
    await chmod(hookPath, EXECUTABLE_MODE);
  }
}

async function removeManagedFiles(hooksDirectory, statePath) {
  for (const name of MANAGED_HOOKS.keys()) {
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

async function writeInstallState(statePath, hooksDirectory, currentHooksPath) {
  const existingState = await readJsonFile(statePath);
  const previousCoreHooksPath =
    existingState?.previousCoreHooksPath ??
    (currentHooksPath && currentHooksPath !== hooksDirectory ? currentHooksPath : null);

  const state = {
    version: 1,
    managedBy: "gforge",
    hooksDirectory,
    previousCoreHooksPath
  };

  await writeFile(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  await chmod(statePath, 0o600);
}

async function readJsonFile(filePath) {
  try {
    return JSON.parse(await readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT" || error instanceof SyntaxError) {
      return null;
    }

    throw error;
  }
}

async function safeGetGlobalHooksPath(execFileFn) {
  try {
    return await getGlobalHooksPath(execFileFn);
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
