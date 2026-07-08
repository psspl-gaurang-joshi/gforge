import { execFile } from "node:child_process";
import { basename } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32"]);
const SUPPORTED_SHELLS = new Set(["bash", "zsh", "pwsh", "powershell"]);

export async function detectEnvironment(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const homeDirectory = options.homeDirectory ?? homedir();
  const execFileFn = options.execFile ?? execFileAsync;
  const shellPath = detectShellPath(env, platform);
  const shellName = shellPath ? normalizeShellName(shellPath) : null;

  return {
    platform: {
      name: platform,
      arch,
      supported: SUPPORTED_PLATFORMS.has(platform),
      isWsl: platform === "linux" && Boolean(env.WSL_DISTRO_NAME)
    },
    home: {
      path: homeDirectory || null,
      present: Boolean(homeDirectory)
    },
    shell: {
      path: shellPath,
      name: shellName,
      supported: shellName ? SUPPORTED_SHELLS.has(shellName) : false
    },
    git: await detectGit(execFileFn)
  };
}

async function detectGit(execFileFn) {
  try {
    const result = await execFileFn("git", ["--version"]);
    const rawVersion = String(result.stdout ?? "").trim();

    return {
      available: true,
      version: parseGitVersion(rawVersion),
      rawVersion
    };
  } catch (error) {
    return {
      available: false,
      version: null,
      rawVersion: null,
      errorCode: error?.code ?? "UNKNOWN"
    };
  }
}

function detectShellPath(env, platform) {
  if (platform === "win32") {
    return env.PSModulePath ? "powershell" : env.ComSpec ?? env.SHELL ?? null;
  }

  return env.SHELL ?? null;
}

function normalizeShellName(shellPath) {
  const name = basename(shellPath).toLowerCase();

  if (name === "powershell.exe") {
    return "powershell";
  }

  if (name === "pwsh.exe") {
    return "pwsh";
  }

  return name;
}

function parseGitVersion(rawVersion) {
  const match = rawVersion.match(/git version\s+(.+)/i);
  return match ? match[1] : rawVersion || null;
}
