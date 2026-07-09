import { readFileSync } from "node:fs";
import { join } from "node:path";

export const MANAGED_DIRECTORY_NAME = ".gforge";
export const HOOKS_DIRECTORY_NAME = "hooks";
export const STATE_FILE_NAME = "state.json";

export const SCANNER_FILE_NAME = "gforge-scan.mjs";
export const PRE_COMMIT_FILE_NAME = "pre-commit";

// The managed hook delegates to the Node scanner. The scanner file is the
// single source of truth (src/scanner.js) copied verbatim into the hooks
// directory so it runs even if the global package is later moved or removed.
export function getScannerContent() {
  return readFileSync(new URL("./scanner.js", import.meta.url), "utf8");
}

// POSIX sh shim. It resolves a Node runtime robustly — GForge is installed via
// npm so Node exists, but git may run the hook from a GUI client whose PATH
// lacks nvm's node; the install-time interpreter path is baked in as a fallback.
// Fails closed (blocks the commit) if no Node runtime can be found.
export function buildPreCommitHook(nodePath) {
  const raw = String(nodePath ?? "");
  const fwd = raw.replace(/\\/g, "/").replace(/"/g, '\\"'); // forward slashes: friendlier in Git Bash
  const escapedRaw = raw.replace(/"/g, '\\"');
  return `#!/usr/bin/env sh
# GForge managed pre-commit hook. Delegates secret scanning to the Node engine.
set -u

HOOK_DIR=$(cd "$(dirname "$0")" && pwd)
SCANNER="$HOOK_DIR/${SCANNER_FILE_NAME}"

# On Git for Windows the hook runs under MSYS sh; translate the scanner path to a
# native Windows path so a native node.exe can resolve the module. No-op elsewhere.
if command -v cygpath >/dev/null 2>&1; then
  SCANNER=$(cygpath -w "$SCANNER" 2>/dev/null || printf '%s' "$SCANNER")
fi

# Resolve a Node runtime. GForge is installed via npm so Node exists, but git may
# run the hook from an environment (GUI client, minimal PATH) that lacks it. Try
# PATH first, then the interpreter path recorded at install time.
NODE="\${GFORGE_NODE:-}"
if [ -z "$NODE" ]; then
  for candidate in node node.exe; do
    if command -v "$candidate" >/dev/null 2>&1; then NODE="$candidate"; break; fi
  done
fi
if [ -z "$NODE" ]; then
  for candidate in "${fwd}" "${escapedRaw}"; do
    if [ -n "$candidate" ] && [ -x "$candidate" ]; then NODE="$candidate"; break; fi
  done
fi

if [ -z "$NODE" ]; then
  echo "GForge: no Node.js runtime found to scan for secrets; blocking commit for safety." >&2
  echo "Set GFORGE_NODE to your node path, or run: gforge install" >&2
  exit 1
fi

exec "$NODE" "$SCANNER" pre-commit
`;
}

// The set of files GForge writes into the hooks directory.
export function getManagedFiles(nodePath) {
  return [
    { name: SCANNER_FILE_NAME, content: getScannerContent(), mode: 0o644, executable: false },
    { name: PRE_COMMIT_FILE_NAME, content: buildPreCommitHook(nodePath), mode: 0o755, executable: true }
  ];
}

export const MANAGED_FILE_NAMES = [SCANNER_FILE_NAME, PRE_COMMIT_FILE_NAME];

export function resolveManagedDirectory(homePath) {
  return join(homePath, MANAGED_DIRECTORY_NAME);
}

export function resolveHooksDirectory(homePath) {
  return join(resolveManagedDirectory(homePath), HOOKS_DIRECTORY_NAME);
}

export function resolveStatePath(homePath) {
  return join(resolveManagedDirectory(homePath), STATE_FILE_NAME);
}

export function resolveScannerPath(homePath) {
  return join(resolveHooksDirectory(homePath), SCANNER_FILE_NAME);
}

export function resolvePreCommitPath(homePath) {
  return join(resolveHooksDirectory(homePath), PRE_COMMIT_FILE_NAME);
}
