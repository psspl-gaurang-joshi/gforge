// npm postinstall hook.
//
// When GForge is ALREADY active on this machine (global core.hooksPath points at
// the managed hooks directory), refresh the installed hook to this package's
// version. This makes `npm install -g gforge` upgrade the on-disk engine too, so
// users never have to remember to run `gforge update` after upgrading.
//
// Safety rules:
//   - Never fail the npm install: all errors are swallowed and we always exit 0.
//   - Only act when GForge is already active (never auto-install on a first,
//     explicit `npm install`; first-time setup stays a deliberate `gforge install`).
//   - Honor GFORGE_SKIP_POSTINSTALL as an escape hatch.

import { homedir } from "node:os";

async function main() {
  if (process.env.GFORGE_SKIP_POSTINSTALL) return;

  const home = homedir();
  if (!home) return;

  const { getGlobalHooksPath } = await import("../src/git-config.js");
  const { resolveHooksDirectory } = await import("../src/hooks.js");

  const hooksDirectory = resolveHooksDirectory(home);
  const current = await getGlobalHooksPath().catch(() => null);
  if (current !== hooksDirectory) return; // GForge is not active here; do nothing.

  const { installManagedHooks } = await import("../src/installer.js");
  const result = await installManagedHooks();
  if (result?.ok) {
    process.stdout.write("gforge: refreshed the managed git hooks to the installed version.\n");
  }
}

main()
  .catch(() => {
    // Never break `npm install` because of the hook refresh.
  })
  .finally(() => {
    process.exit(0);
  });
