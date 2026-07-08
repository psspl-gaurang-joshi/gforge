export function createVerificationReport(environment) {
  const checks = [
    {
      status: environment.platform.supported ? "PASS" : "FAIL",
      label: "platform",
      detail: `${environment.platform.name} ${environment.platform.arch}`.trim()
    },
    {
      status: environment.home.present ? "PASS" : "FAIL",
      label: "home",
      detail: environment.home.path ?? "not detected"
    },
    {
      status: environment.shell.supported ? "PASS" : "WARN",
      label: "shell",
      detail: formatShell(environment.shell)
    },
    {
      status: environment.git.available ? "PASS" : "FAIL",
      label: "git",
      detail: environment.git.available ? environment.git.rawVersion : "git not found"
    }
  ];

  return {
    checks,
    exitCode: checks.some((check) => check.status === "FAIL") ? 1 : 0
  };
}

export function formatVerificationReport(report) {
  const lines = ["GForge read-only verification", ""];

  for (const check of report.checks) {
    lines.push(`${check.status} ${check.label}: ${check.detail}`);
  }

  return `${lines.join("\n")}\n`;
}

function formatShell(shell) {
  if (!shell.name) {
    return "not detected";
  }

  return shell.path && shell.path !== shell.name ? `${shell.name} (${shell.path})` : shell.name;
}
