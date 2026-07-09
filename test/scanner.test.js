import assert from "node:assert/strict";
import test from "node:test";

import {
  formatReport,
  isEnvTemplate,
  matchFilenameRule,
  parseAllowlist,
  scanStaged,
  scanText,
  shannonEntropy
} from "../src/scanner.js";

const opts = { runGitleaks: false };
const ruleIds = (path, text, extra = {}) => scanText(path, text, { ...opts, ...extra }).map((f) => f.ruleId);

test("detects a generic keyword=value secret (the DB_PASS regression)", () => {
  assert.ok(ruleIds("config.txt", "DB_PASS=psspl@443e").includes("generic-secret-assignment"));
  assert.ok(ruleIds("a.yml", 'password: "hunter2longvalue"').includes("generic-secret-assignment"));
  assert.ok(ruleIds("a.js", "const api_key = 'abcd1234efgh'").includes("generic-secret-assignment"));
});

test("detects provider tokens and private keys", () => {
  assert.ok(ruleIds("a", `ghp_${"a".repeat(36)}`).includes("github-pat"));
  assert.ok(ruleIds("a", "AKIAIOSFODNN7EXAMPLE").includes("aws-access-key-id"));
  assert.ok(ruleIds("a", `sk_live_${"a".repeat(24)}`).includes("stripe-secret-key"));
  assert.ok(ruleIds("a", `AIza${"A1b2".repeat(8)}xyz`).includes("google-api-key"));
  assert.ok(ruleIds("a", "-----BEGIN RSA PRIVATE KEY-----").includes("private-key"));
});

test("detects credentials embedded in a URL", () => {
  assert.ok(ruleIds("a", "postgres://user:supersecret@db:5432/app").includes("basic-auth-url"));
});

test("detects unnamed high-entropy strings", () => {
  assert.ok(ruleIds("a", 'x = "Zx9Kq2mVbN7pLwR4tYaSdFgHjKlPoIuY"').includes("high-entropy-string"));
});

test("does not flag bare references or ordinary code (false positives)", () => {
  assert.equal(ruleIds("a", "const t = process.env.GITHUB_TOKEN").length, 0);
  assert.equal(ruleIds("a", "token: ${{ secrets.GITHUB_TOKEN }}").length, 0);
  assert.equal(ruleIds("a", "the quick brown fox jumps over the lazy dog").length, 0);
  assert.equal(ruleIds("a", "password=").length, 0);
});

test("entropy ignores git SHAs, UUIDs, and lockfiles", () => {
  assert.ok(!ruleIds("a", "rev 9e3c1f2a5b7d8e0a1c2b3d4e5f60718293a4b5c6").includes("high-entropy-string"));
  assert.ok(!ruleIds("a", "id=123e4567-e89b-12d3-a456-426614174000").includes("high-entropy-string"));
  assert.ok(!ruleIds("package-lock.json", `"integrity":"sha512-${"Zx9Kq2mV".repeat(6)}"`).includes("high-entropy-string"));
});

test("inline gforge:allow suppresses a line", () => {
  assert.equal(ruleIds("a", "DB_PASS=psspl@443e # gforge:allow").length, 0);
  assert.equal(ruleIds("a", "DB_PASS=psspl@443e // gitleaks:allow").length, 0);
});

test("filename rules block secret files but allow templates", () => {
  assert.equal(matchFilenameRule(".env")?.id, "secret-file-env");
  assert.equal(matchFilenameRule("app/.env.production")?.id, "secret-file-env");
  assert.equal(matchFilenameRule(".env.example"), null);
  assert.equal(matchFilenameRule("deploy/id_rsa")?.id, "secret-file");
  assert.equal(matchFilenameRule("cert.p12")?.id, "secret-file");
  assert.equal(matchFilenameRule("src/app.js"), null);
});

test("env templates skip generic/entropy rules but still catch real tokens", () => {
  assert.ok(isEnvTemplate(".env.example"));
  assert.ok(!isEnvTemplate(".env"));
  // Placeholder assignment is allowed in a template...
  assert.equal(scanStaged({ ...opts, allowlist: [], files: [".env.example"], read: () => "SECRET=your-value-here" }).findings.length, 0);
  // ...but a real token is still blocked.
  const real = scanStaged({ ...opts, allowlist: [], files: [".env.example"], read: () => `GITHUB_TOKEN=ghp_${"a".repeat(36)}` });
  assert.ok(real.findings.some((f) => f.ruleId === "github-pat"));
});

test("allowlist skips matching paths", () => {
  const allowlist = parseAllowlist("config.txt\n# comment\n^secrets/");
  const blocked = scanStaged({ ...opts, allowlist, files: ["other.txt"], read: () => "DB_PASS=psspl@443e" });
  assert.ok(blocked.findings.length > 0);
  const allowed = scanStaged({ ...opts, allowlist, files: ["config.txt"], read: () => "DB_PASS=psspl@443e" });
  assert.equal(allowed.findings.length, 0);
  const allowedDir = scanStaged({ ...opts, allowlist, files: ["secrets/prod.txt"], read: () => "DB_PASS=psspl@443e" });
  assert.equal(allowedDir.findings.length, 0);
});

test("report never contains the matched secret value", () => {
  const result = scanStaged({ ...opts, allowlist: [], files: ["config.txt"], read: () => "DB_PASS=psspl@443e" });
  const report = formatReport(result);
  assert.doesNotMatch(report, /psspl@443e/);
  assert.match(report, /config\.txt/);
  assert.match(report, /generic-secret-assignment/);
});

test("shannon entropy scores random strings above plain text", () => {
  assert.ok(shannonEntropy("Zx9Kq2mVbN7pLwR4tYaSdFgHjKl") > 4.2);
  assert.ok(shannonEntropy("aaaaaaaaaaaaaaaaaaaa") < 1);
});
