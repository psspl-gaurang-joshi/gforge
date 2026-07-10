// npm self-update helpers: query the registry for the latest published version
// and upgrade the globally installed package. All network/child-process calls are
// injectable so the CLI logic can be unit-tested without touching npm.

import { execFile, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const PACKAGE_NAME = "gforge";

// Numeric compare of X.Y.Z (prerelease/build metadata ignored).
export function compareVersions(a, b) {
  const pa = String(a).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(b).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    const x = pa[i] || 0;
    const y = pb[i] || 0;
    if (x > y) return 1;
    if (x < y) return -1;
  }
  return 0;
}

export function isNewer(latest, current) {
  return compareVersions(latest, current) > 0;
}

// Reads the cache written by the hook's background check and returns a one-line
// notice if a newer version is available, else null. Never throws.
export function readCachedUpdateNotice(currentVersion) {
  try {
    const cache = JSON.parse(readFileSync(join(homedir(), ".gforge", "update-check.json"), "utf8"));
    if (cache && cache.latest && isNewer(cache.latest, currentVersion)) {
      return `gforge v${cache.latest} is available (you have v${currentVersion}). Run: gforge update`;
    }
  } catch {
    // no cache yet / unreadable — no notice
  }
  return null;
}

// Best-effort: returns the latest published version, or null if offline / npm
// unavailable / anything unexpected. Never throws.
export async function getLatestVersion(options = {}) {
  const exec = options.execFile ?? execFileAsync;
  try {
    const { stdout } = await exec("npm", ["view", PACKAGE_NAME, "version"], {
      timeout: options.timeoutMs ?? 8000
    });
    const value = String(stdout).trim();
    return /^\d+\.\d+\.\d+/.test(value) ? value : null;
  } catch {
    return null;
  }
}

async function getGlobalBinPath(options = {}) {
  const exec = options.execFile ?? execFileAsync;
  try {
    const { stdout } = await exec("npm", ["root", "-g"], { timeout: options.timeoutMs ?? 8000 });
    const root = String(stdout).trim();
    return root ? join(root, PACKAGE_NAME, "bin", "gforge.js") : null;
  } catch {
    return null;
  }
}

// Upgrade the global package to `version`, then re-exec the freshly installed
// binary to finish the requested command with the NEW code (guarded against
// recursion via GFORGE_NO_SELF_UPDATE). Returns { ok, ... }; never throws.
export async function performSelfUpgrade(command, version, options = {}) {
  const run = options.spawnSync ?? spawnSync;
  const spec = `${PACKAGE_NAME}@${version}`;

  const install = run("npm", ["install", "-g", spec], { stdio: "inherit" });
  if (!install || install.status !== 0) {
    return { ok: false, error: `npm install -g ${spec} exited with status ${install ? install.status : "unknown"}` };
  }

  const bin = options.binPath ?? (await getGlobalBinPath(options));
  if (!bin) {
    // Could not locate the new binary. When GForge was already active the
    // postinstall step will have refreshed the hook, so treat as success.
    return { ok: true, reexeced: false };
  }

  const node = options.nodePath ?? process.execPath;
  const child = run(node, [bin, command], {
    stdio: "inherit",
    env: { ...process.env, GFORGE_NO_SELF_UPDATE: "1" }
  });
  return { ok: !!child && child.status === 0, reexeced: true, status: child ? child.status : null };
}
