import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function getGlobalHooksPath(execFileFn = execFileAsync) {
  try {
    const result = await execFileFn("git", ["config", "--global", "--get", "core.hooksPath"]);
    const value = String(result.stdout ?? "").trim();

    return value || null;
  } catch (error) {
    if (error?.code === 1 || error?.code === "1") {
      return null;
    }

    throw error;
  }
}

// Resolves core.hooksPath the way git actually would in the current directory:
// a repository-local or system value overrides the global one. Used by verify to
// warn when a repo-local hooks setup (e.g. Husky, lefthook) shadows GForge.
export async function getEffectiveHooksPath(execFileFn = execFileAsync) {
  try {
    const result = await execFileFn("git", ["config", "--get", "core.hooksPath"]);
    const value = String(result.stdout ?? "").trim();

    return value || null;
  } catch (error) {
    if (error?.code === 1 || error?.code === "1") {
      return null;
    }

    throw error;
  }
}

export async function setGlobalHooksPath(hooksPath, execFileFn = execFileAsync) {
  await execFileFn("git", ["config", "--global", "core.hooksPath", hooksPath]);
}

export async function unsetGlobalHooksPath(execFileFn = execFileAsync) {
  try {
    await execFileFn("git", ["config", "--global", "--unset", "core.hooksPath"]);
  } catch (error) {
    if (error?.code === 1 || error?.code === "1" || error?.code === 5 || error?.code === "5") {
      return;
    }

    throw error;
  }
}
