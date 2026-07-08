import { VERSION } from "./metadata.js";
import { detectEnvironment } from "./environment.js";
import { createVerificationReport, formatVerificationReport } from "./verify.js";

const PLANNED_COMMANDS = new Set(["install", "update", "uninstall"]);

export async function runCli(args, streams, options = {}) {
  const command = args[0] ?? "help";

  if (command === "help" || command === "--help" || command === "-h") {
    streams.stdout.write(helpText());
    return { exitCode: 0 };
  }

  if (command === "version" || command === "--version" || command === "-v") {
    streams.stdout.write(`gforge ${VERSION}\n`);
    return { exitCode: 0 };
  }

  if (command === "verify") {
    const environment = await (options.detectEnvironment ?? detectEnvironment)();
    const report = createVerificationReport(environment);

    streams.stdout.write(formatVerificationReport(report));
    return { exitCode: report.exitCode };
  }

  if (PLANNED_COMMANDS.has(command)) {
    streams.stderr.write(`gforge ${command} is not implemented yet.\n`);
    return { exitCode: 2 };
  }

  streams.stderr.write(`Unknown command: ${command}\n\n${helpText()}`);
  return { exitCode: 1 };
}

function helpText() {
  return `gforge ${VERSION}

Secure global Git hooks installer for developer workstations.

Usage:
  gforge <command>

Commands:
  install     Install managed global Git hooks
  verify      Run read-only environment checks
  update      Update managed hooks
  uninstall   Remove GForge-owned hooks and configuration
  version     Print version
  help        Print help

Installer commands are planned and will be implemented in follow-up tasks.
`;
}
