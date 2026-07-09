import { join } from "node:path";

export const MANAGED_DIRECTORY_NAME = ".gforge";
export const HOOKS_DIRECTORY_NAME = "hooks";
export const STATE_FILE_NAME = "state.json";

export const PRE_COMMIT_HOOK = `#!/usr/bin/env sh
# GForge managed pre-commit hook.
# Blocks commits whose staged changes appear to contain secrets.
# Only file paths are ever printed, never the matched secret values.
set -u

# High-confidence secret value shapes, plus name=value assignments for a few
# credential types that have no reliable value shape. Matching is case
# insensitive (see grep -i below) so lowercased variable names are still caught.
PATTERN='(-----BEGIN [A-Z ]*PRIVATE KEY-----|(AKIA|ASIA)[0-9A-Z]{16}|gh[opsur]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AIza[0-9A-Za-z_-]{35}|sk-[A-Za-z0-9]{20,}|[rsp]k_(live|test)_[A-Za-z0-9]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|npm_[A-Za-z0-9]{36}|(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|GITHUB_TOKEN|NPM_TOKEN)[[:space:]]*[:=][[:space:]]*"?[A-Za-z0-9/+_-]{16,})'

# Inspect only the paths that are part of THIS commit (staged, excluding
# deletions). Pre-existing content in unchanged files must not block unrelated
# commits. Fail closed if the staged file list cannot be produced.
staged=$(git -c core.quotePath=false diff --cached --name-only --diff-filter=d) || {
  echo "GForge: unable to inspect staged changes; commit blocked for safety." >&2
  exit 1
}

[ -n "$staged" ] || exit 0

# Scan the staged blob of each changed file. Emit only the path on a match, or a
# clear error marker if a file could not be scanned (fail closed, not open).
# grep -a scans binary/attribute-marked files too, so they cannot hide secrets.
findings=$(
  printf '%s\\n' "$staged" | while IFS= read -r file; do
    [ -n "$file" ] || continue
    git show ":$file" 2>/dev/null | grep -E -i -a -q "$PATTERN"
    rc=$?
    if [ "$rc" -eq 0 ]; then
      printf '%s\\n' "$file"
    elif [ "$rc" -gt 1 ]; then
      printf '%s\\t(could not scan; blocked)\\n' "$file"
    fi
  done
)

if [ -n "$findings" ]; then
  echo "GForge blocked this commit because staged changes may contain secrets." >&2
  echo "Review these files and remove sensitive values before committing:" >&2
  printf '%s\\n' "$findings" >&2
  echo "If this is a false positive, bypass once with: git commit --no-verify" >&2
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
