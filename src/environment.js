import { execFile } from "node:child_process";
import { basename } from "node:path";
import { homedir } from "node:os";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SUPPORTED_PLATFORMS = new Set(["darwin", "linux", "win32"]);
const SUPPORTED_SHELLS = new Set(["bash", "zsh", "pwsh", "powershell"]);

// Mirrors `engines.node` in package.json. Kept as a literal rather than parsed
// from package.json at runtime so detection stays dependency- and I/O-free;
// a test asserts the two never drift apart (issue #52).
export const MIN_NODE_MAJOR = 20;

// npm only enforces `engines` when engine-strict is on, so gforge can be
// installed and run on an older Node than it supports. Nothing then reports
// that, and the first symptom is an unrelated-looking runtime error somewhere
// else in the tool - so detect it and let verify say so plainly (issue #52).
export function detectNode(rawVersion = process.versions.node) {
  const version = String(rawVersion ?? "").trim() || null;
  const match = version?.match(/^v?(\d+)\./);
  const major = match ? Number(match[1]) : null;

  return {
    version,
    major,
    // Unparseable fails closed (treated as unsupported) rather than assuming
    // support, matching how the git-version gate handles the same ambiguity.
    supported: major !== null && major >= MIN_NODE_MAJOR
  };
}

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
    node: detectNode(options.nodeVersion ?? process.versions.node),
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
    // PSModulePath is inherited by virtually every Windows process (cmd, Explorer
    // children, pwsh) so it cannot signal a live PowerShell session. Prefer a real
    // shell hint: SHELL (set by Git Bash/WSL), then the pwsh session marker, then
    // ComSpec (typically cmd.exe). The shell field is informational only; hooks run
    // through git's bundled sh regardless.
    if (env.SHELL) {
      return env.SHELL;
    }

    if (env.POWERSHELL_DISTRIBUTION_CHANNEL) {
      return "pwsh";
    }

    return env.ComSpec ?? null;
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
