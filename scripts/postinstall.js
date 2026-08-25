// npm postinstall hook.
//
// Goal: `npm install -g gforge` is all a developer needs — this step sets up (or
// refreshes) the managed global git hooks automatically, so nobody has to
// remember a separate `gforge install`.
//
// Safety rules:
//   - Never fail the npm install: all errors are swallowed and we always exit 0.
//   - Only act on an actual global install (npm_config_global === "true").
//     A plain local `npm install gforge` in some unrelated project — or gforge
//     showing up as a transitive/dev dependency of any package — must never
//     rewrite the invoking machine's real, shared ~/.gitconfig.
//   - Skip in CI / build images (process.env.CI) — reconfiguring global git there
//     is pointless and surprising.
//   - Honor GFORGE_SKIP_POSTINSTALL as an explicit escape hatch.
//   - Never silently clobber an existing, non-GForge global core.hooksPath; tell
//     the user to run `gforge install` if they want GForge to take it over.

import { homedir } from "node:os";
import { pathToFileURL } from "node:url";

// Extracted so the "should we even touch global git config" decision is unit
// testable without exercising the actual install side effects. Anything other
// than the literal npm-set "true" is treated as "not a global install" -
// fail closed towards leaving the machine's git config untouched.
export function shouldRunPostinstall(env) {
  if (env.npm_config_global !== "true") return false;
  if (env.GFORGE_SKIP_POSTINSTALL || env.CI) return false;
  return true;
}

async function main() {
  if (!shouldRunPostinstall(process.env)) return;

  const home = homedir();
  if (!home) return;

  const { getGlobalHooksPath } = await import("../src/git-config.js");
  const { resolveHooksDirectory } = await import("../src/hooks.js");
  const { installManagedHooks } = await import("../src/installer.js");

  const hooksDirectory = resolveHooksDirectory(home);
  const current = await getGlobalHooksPath().catch(() => null);

  if (current && current !== hooksDirectory) {
    // Respect an existing custom global hooks path (e.g. a team setup); don't
    // take it over during an npm install.
    process.stdout.write(
      `gforge: a global core.hooksPath is already set (${current}).\n` +
      "        Run `gforge install` if you want GForge to manage it.\n"
    );
    return;
  }

  const alreadyActive = current === hooksDirectory;
  const result = await installManagedHooks();
  if (!result?.ok) return; // e.g. git not found — stay quiet; user can run `gforge install`

  if (alreadyActive) {
    process.stdout.write("gforge: refreshed the managed git hooks to the installed version.\n");
  } else {
    process.stdout.write(
      "gforge: installed global git hooks — every commit is now scanned for secrets.\n" +
      "        Verify with `gforge verify`; remove with `gforge uninstall`.\n"
    );
  }
}

// Only run (and only ever call process.exit) when npm actually executes this
// file directly as the postinstall lifecycle script - not when something
// (e.g. a test) imports it purely for the shouldRunPostinstall export.
const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main()
    .catch(() => {
      // Never break `npm install` because of hook setup.
    })
    .finally(() => {
      process.exit(0);
    });
}
