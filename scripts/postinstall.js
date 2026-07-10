// npm postinstall hook.
//
// Goal: `npm install -g gforge` is all a developer needs — this step sets up (or
// refreshes) the managed global git hooks automatically, so nobody has to
// remember a separate `gforge install`.
//
// Safety rules:
//   - Never fail the npm install: all errors are swallowed and we always exit 0.
//   - Skip in CI / build images (process.env.CI) — reconfiguring global git there
//     is pointless and surprising.
//   - Honor GFORGE_SKIP_POSTINSTALL as an explicit escape hatch.
//   - Never silently clobber an existing, non-GForge global core.hooksPath; tell
//     the user to run `gforge install` if they want GForge to take it over.

import { homedir } from "node:os";

async function main() {
  if (process.env.GFORGE_SKIP_POSTINSTALL || process.env.CI) return;

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

main()
  .catch(() => {
    // Never break `npm install` because of hook setup.
  })
  .finally(() => {
    process.exit(0);
  });
