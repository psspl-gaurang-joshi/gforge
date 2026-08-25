import assert from "node:assert/strict";
import test from "node:test";

import { createVerificationReport, formatVerificationReport } from "../src/verify.js";

test("creates successful report when required checks pass", () => {
  const report = createVerificationReport(
    {
      platform: { name: "linux", arch: "x64", supported: true },
      home: { path: "/home/example", present: true },
      shell: { path: "/bin/bash", name: "bash", supported: true },
      git: { available: true, rawVersion: "git version 2.45.0" }
    },
    {
      checks: [{ status: "PASS", label: "hooks-path", detail: "configured" }]
    }
  );

  assert.equal(report.exitCode, 0);
  assert.equal(report.checks.every((check) => check.status === "PASS"), true);
});

test("reports the .env cross-reference so a silently dead layer is visible", () => {
  const monorepo = createVerificationReport(healthyEnvironment(), null, {
    inRepo: true,
    root: "/repo",
    files: ["client/.env", "server/.env"],
    secretCount: 7
  });
  const output = formatVerificationReport(monorepo);

  assert.equal(monorepo.exitCode, 0);
  assert.match(output, /PASS dotenv-cross-reference: 7 value\(s\) cross-referenced from client\/\.env, server\/\.env/);

  // No .env anywhere: the layer loads nothing, and verification must say so.
  const inactive = createVerificationReport(healthyEnvironment(), null, {
    inRepo: true,
    root: "/repo",
    files: [],
    secretCount: 0
  });
  assert.equal(inactive.exitCode, 0); // informational: a repo may legitimately have none
  assert.match(formatVerificationReport(inactive), /WARN dotenv-cross-reference: no \.env file found/);

  // Files found, but nothing secret-shaped in them: still inert.
  const empty = createVerificationReport(healthyEnvironment(), null, {
    inRepo: true,
    root: "/repo",
    files: [".env"],
    secretCount: 0
  });
  assert.match(formatVerificationReport(empty), /WARN dotenv-cross-reference: \.env hold no secret-shaped values/);

  // Outside a git repository the check is omitted entirely.
  const outside = createVerificationReport(healthyEnvironment(), null, {
    inRepo: false,
    root: null,
    files: [],
    secretCount: 0
  });
  assert.equal(outside.checks.some((check) => check.label === "dotenv-cross-reference"), false);
  assert.equal(createVerificationReport(healthyEnvironment()).checks.some((c) => c.label === "dotenv-cross-reference"), false);
});

test("formats warnings without failing verification", () => {
  const report = createVerificationReport({
    platform: { name: "linux", arch: "x64", supported: true },
    home: { path: "/home/example", present: true },
    shell: { path: null, name: null, supported: false },
    git: { available: true, rawVersion: "git version 2.45.0" }
  });

  assert.equal(report.exitCode, 0);
  assert.match(formatVerificationReport(report), /WARN shell: not detected/);
});

function healthyEnvironment() {
  return {
    platform: { name: "linux", arch: "x64", supported: true },
    home: { path: "/home/example", present: true },
    shell: { path: "/bin/bash", name: "bash", supported: true },
    git: { available: true, rawVersion: "git version 2.45.0" }
  };
}
