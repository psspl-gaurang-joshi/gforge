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
