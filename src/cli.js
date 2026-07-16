import { VERSION } from "./metadata.js";
import { detectEnvironment } from "./environment.js";
import {
  formatInstallResult,
  installManagedHooks,
  uninstallManagedHooks,
  updateManagedHooks,
  verifyManagedHooks
} from "./installer.js";
import {
  getLatestVersion,
  isNewer,
  performSelfUpgrade,
  readCachedUpdateNotice
} from "./npm-update.js";
import { createVerificationReport, formatVerificationReport } from "./verify.js";

export async function runCli(args, streams, options = {}) {
  const command = args[0] ?? "help";

  if (command === "help" || command === "--help" || command === "-h") {
    streams.stdout.write(banner(streams.stdout) + helpText());
    return { exitCode: 0 };
  }

  if (command === "version" || command === "--version" || command === "-v") {
    streams.stdout.write(`gforge ${VERSION}\n`);
    return { exitCode: 0 };
  }

  if (command === "install" || command === "update") {
    return runInstallOrUpdate(command, args, options, streams);
  }

  if (command === "uninstall") {
    return runMutation("uninstall", options.uninstallManagedHooks ?? uninstallManagedHooks, options, streams);
  }

  if (command === "verify") {
    const environment = await (options.detectEnvironment ?? detectEnvironment)();
    const managedHooksReport = await (options.verifyManagedHooks ?? verifyManagedHooks)({
      ...options,
      environment
    });
    const report = createVerificationReport(environment, managedHooksReport);

    streams.stdout.write(formatVerificationReport(report));
    const notice = (options.readCachedUpdateNotice ?? readCachedUpdateNotice)(VERSION);
    if (notice) streams.stdout.write(`\n${notice}\n`);
    return { exitCode: report.exitCode };
  }

  streams.stderr.write(`${banner(streams.stderr)}Unknown command: ${command}\n\n${helpText()}`);
  return { exitCode: 1 };
}

// install/update first try to upgrade the globally installed package to the
// latest published version (unless disabled), then apply the managed hooks. With
// --force, it reinstalls the latest even when already current.
async function runInstallOrUpdate(command, args, options, streams) {
  const force = args.includes("--force") || args.includes("-f");
  const selfUpdateDisabled = Boolean(process.env.GFORGE_NO_SELF_UPDATE) || options.skipSelfUpdate;

  if (!selfUpdateDisabled) {
    const latest = await (options.getLatestVersion ?? getLatestVersion)(options);
    // --force reinstalls the latest, but never installs a version older than the
    // one already running (no accidental downgrade when local is ahead of npm).
    const shouldUpgrade = latest && (isNewer(latest, VERSION) || (force && !isNewer(VERSION, latest)));

    if (shouldUpgrade) {
      streams.stdout.write(
        isNewer(latest, VERSION)
          ? `GForge: upgrading ${VERSION} → ${latest}...\n`
          : `GForge: reinstalling gforge@${latest} (forced)...\n`
      );
      try {
        const result = await (options.performSelfUpgrade ?? performSelfUpgrade)(command, latest, options);
        if (result.ok && result.reexeced) {
          // The freshly installed binary already ran the command with new code.
          return { exitCode: 0 };
        }
        if (result.ok) {
          // Package upgraded, but the new binary could not be re-exec'd. Set up
          // hooks now with the running code so they are actually installed.
          streams.stdout.write(`GForge: upgraded to ${latest}; setting up hooks with the current version...\n`);
        } else {
          streams.stderr.write(`GForge: upgrade failed (${result.error ?? "unknown"}); continuing with ${VERSION}.\n`);
        }
      } catch (error) {
        streams.stderr.write(`GForge: upgrade failed (${error?.message ?? error}); continuing with ${VERSION}.\n`);
      }
      // Fall through: set up/refresh hooks with the currently installed version.
    } else if (latest && force && isNewer(VERSION, latest)) {
      streams.stdout.write(`GForge: installed version (${VERSION}) is ahead of the latest published (${latest}); not downgrading. Refreshing hooks.\n`);
    } else if (latest && !isNewer(latest, VERSION)) {
      streams.stdout.write(`GForge: already on the latest version (${VERSION}).\n`);
    }
  }

  const operation = command === "install"
    ? (options.installManagedHooks ?? installManagedHooks)
    : (options.updateManagedHooks ?? updateManagedHooks);
  return runMutation(command, operation, options, streams);
}

// Runs a state-mutating command, turning any unexpected failure (permission
// errors, an unwritable global gitconfig, etc.) into a friendly message and a
// non-zero exit code instead of an unhandled rejection and a raw stack trace.
async function runMutation(command, operation, options, streams) {
  try {
    const result = await operation(options);
    const output = formatInstallResult(result);

    if (result.ok) {
      streams.stdout.write(output);
    } else {
      streams.stderr.write(output);
    }

    return { exitCode: result.exitCode };
  } catch (error) {
    const detail = error?.message ?? String(error);
    streams.stderr.write(`GForge ${command} failed\n\n${detail}\n`);
    return { exitCode: 1 };
  }
}

const LOGO = [
  " ██████╗ ███████╗ ██████╗ ██████╗  ██████╗ ███████╗",
  "██╔════╝ ██╔════╝██╔═══██╗██╔══██╗██╔════╝ ██╔════╝",
  "██║  ███╗█████╗  ██║   ██║██████╔╝██║  ███╗█████╗  ",
  "██║   ██║██╔══╝  ██║   ██║██╔══██╗██║   ██║██╔══╝  ",
  "╚██████╔╝██║     ╚██████╔╝██║  ██║╚██████╔╝███████╗",
  " ╚═════╝ ╚═╝      ╚═════╝ ╚═╝  ╚═╝ ╚═════╝ ╚══════╝"
].join("\n");

// Colored GForge wordmark + tagline. Colors only when the target stream is an
// interactive terminal (and NO_COLOR is not set), so pipes / CI stay clean.
function banner(stream) {
  const color = !process.env.NO_COLOR && Boolean(stream && stream.isTTY);
  const esc = String.fromCharCode(27);
  const paint = (code, text) => (color ? `${esc}[${code}m${text}${esc}[0m` : text);
  // 1 = bold, 3 = italic, 38;5;141 = purple (256-color).
  const tagline = "  ⚒  Governance Forge - The secret firewall behind every commit.";
  const pillars = " Secure • Standardize • Govern • Scale";
  return `${paint("1;3;38;5;141", LOGO)}\n${paint("2;3", tagline)}\n\n${paint("38;5;141", pillars)}\n\n`;
}

function helpText() {
  return `gforge ${VERSION}

Secure global Git hooks installer for developer workstations.

Usage:
  gforge <command> [options]

Commands:
  install     Upgrade to the latest published version (if any) and install hooks
  verify      Verify environment and managed hooks
  update      Upgrade to the latest published version (if any) and refresh hooks
  uninstall   Remove GForge-owned hooks and configuration
  version     Print version
  help        Print help

Options:
  --force     With install/update, reinstall the latest version even if current

Environment:
  GFORGE_AUTO_UPDATE=0       Disable automatic background upgrades (on by default)
  GFORGE_NO_SELF_UPDATE=1    Skip the npm self-upgrade in install/update
  GFORGE_SKIP_POSTINSTALL=1  Skip auto-setup during npm install
`;
}
