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

// System scope (e.g. /etc/gitconfig, or org policy pushed via
// GIT_CONFIG_SYSTEM) sits BELOW global in git's real precedence order
// (local > global > system) — so a system-mandated core.hooksPath is never
// itself in danger of being overridden by a repo or global value, but it IS
// at risk of being silently *shadowed*: writing a new global value outranks
// it, even though nothing at the system level was ever touched (issue #41).
export async function getSystemHooksPath(execFileFn = execFileAsync) {
  try {
    const result = await execFileFn("git", ["config", "--system", "--get", "core.hooksPath"]);
    const value = String(result.stdout ?? "").trim();

    return value || null;
  } catch (error) {
    if (error?.code === 1 || error?.code === "1") {
      // Covers both "key not set" and "no system gitconfig file at all"
      // (verified directly: git exits 1 for --get in both cases, unlike
      // --list, which fails differently when the file is entirely absent).
      return null;
    }

    throw error;
  }
}

// Resolves core.hooksPath the way git actually would in the current directory:
// a repository-local value overrides the global one, which in turn overrides
// a system-level one. Used by verify to warn when a repo-local hooks setup
// (e.g. Husky, lefthook) shadows GForge.
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

// The current repository's actual .git directory (verified: exits non-zero,
// e.g. 128, for any reason it can't be determined — no single exit code
// covers every case the way config --get's "1" does, so any failure here
// uniformly means "nothing to check", never something worth surfacing).
export async function getRepoGitDir(execFileFn = execFileAsync) {
  try {
    const result = await execFileFn("git", ["rev-parse", "--git-dir"]);
    const value = String(result.stdout ?? "").trim();

    return value || null;
  } catch {
    return null;
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
