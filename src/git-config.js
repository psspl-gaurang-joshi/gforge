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

export async function setGlobalHooksPath(hooksPath, execFileFn = execFileAsync) {
  await execFileFn("git", ["config", "--global", "core.hooksPath", hooksPath]);
}
