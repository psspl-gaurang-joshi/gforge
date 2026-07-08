import { join } from "node:path";

export const MANAGED_DIRECTORY_NAME = ".gforge";
export const HOOKS_DIRECTORY_NAME = "hooks";
export const STATE_FILE_NAME = "state.json";

export const PRE_COMMIT_HOOK = `#!/usr/bin/env sh
set -u

PATTERN='(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|NPM_TOKEN|-----BEGIN [A-Z ]*PRIVATE KEY-----|ghp_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]+|sk-[A-Za-z0-9]{20,}|xox[baprs]-[A-Za-z0-9-]+)'

matches="$(git grep --cached -l -I -E "$PATTERN" -- . 2>/dev/null || true)"

if [ -n "$matches" ]; then
  echo "GForge blocked this commit because staged files may contain secrets." >&2
  echo "Review these files and remove sensitive values before committing:" >&2
  printf '%s\\n' "$matches" >&2
  exit 1
fi

exit 0
`;

export const MANAGED_HOOKS = new Map([["pre-commit", PRE_COMMIT_HOOK]]);

export function resolveManagedDirectory(homePath) {
  return join(homePath, MANAGED_DIRECTORY_NAME);
}

export function resolveHooksDirectory(homePath) {
  return join(resolveManagedDirectory(homePath), HOOKS_DIRECTORY_NAME);
}

export function resolveStatePath(homePath) {
  return join(resolveManagedDirectory(homePath), STATE_FILE_NAME);
}
