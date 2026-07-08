import { VERSION } from "./metadata.js";
import { detectEnvironment } from "./environment.js";
import {
  formatInstallResult,
  installManagedHooks,
  uninstallManagedHooks,
  updateManagedHooks,
  verifyManagedHooks
} from "./installer.js";
import { createVerificationReport, formatVerificationReport } from "./verify.js";

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

  if (command === "install") {
    const result = await (options.installManagedHooks ?? installManagedHooks)(options);
    const output = formatInstallResult(result);

    if (result.ok) {
      streams.stdout.write(output);
    } else {
      streams.stderr.write(output);
    }

    return { exitCode: result.exitCode };
  }

  if (command === "update") {
    const result = await (options.updateManagedHooks ?? updateManagedHooks)(options);
    const output = formatInstallResult(result);

    if (result.ok) {
      streams.stdout.write(output);
    } else {
      streams.stderr.write(output);
    }

    return { exitCode: result.exitCode };
  }

  if (command === "uninstall") {
    const result = await (options.uninstallManagedHooks ?? uninstallManagedHooks)(options);
    const output = formatInstallResult(result);

    if (result.ok) {
      streams.stdout.write(output);
    } else {
      streams.stderr.write(output);
    }

    return { exitCode: result.exitCode };
  }

  if (command === "verify") {
    const environment = await (options.detectEnvironment ?? detectEnvironment)();
    const managedHooksReport = await (options.verifyManagedHooks ?? verifyManagedHooks)({
      ...options,
      environment
    });
    const report = createVerificationReport(environment, managedHooksReport);

    streams.stdout.write(formatVerificationReport(report));
    return { exitCode: report.exitCode };
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
  verify      Verify environment and managed hooks
  update      Update managed hooks
  uninstall   Remove GForge-owned hooks and configuration
  version     Print version
  help        Print help
`;
}
