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

test("detects a variety of hardcoded password/credential assignments", () => {
  assert.ok(ruleIds("a.js", 'const password = "s3cr3tValue!"').includes("generic-secret-assignment"));
  assert.ok(ruleIds("a.py", "PASSWORD = 'hunter2value'").includes("generic-secret-assignment"));
  assert.ok(ruleIds("a.json", '"client_secret": "abcd1234efgh5678"').includes("generic-secret-assignment"));
  assert.ok(ruleIds("a.ini", "connection_string=Server=db;Pwd=abcd1234;").includes("generic-secret-assignment"));
  assert.ok(ruleIds("a.txt", "Authorization: Bearer abcdef2345token").includes("generic-secret-assignment"));
  assert.ok(ruleIds("a.env", "SESSION_KEY=9f8e7d6c5b4a3210").includes("generic-secret-assignment"));
});

test("does not flag credential keys wired to env vars / references (well-written config)", () => {
  // The critical real-world case: Sequelize/config files that read secrets from
  // the environment must NOT be blocked.
  assert.equal(ruleIds("config/db.js", "password: process.env.DB_PASSWORD,").length, 0);
  assert.equal(ruleIds("config/db.js", "password: config.get('db.password'),").length, 0);
  assert.equal(ruleIds("config/db.js", "password: getSecret('db'),").length, 0);
  assert.equal(ruleIds("config/db.js", 'password: `${DB_PASSWORD}`,').length, 0);
  assert.equal(ruleIds("app.py", "password = os.environ['DB_PASSWORD']").length, 0);
  assert.equal(ruleIds("app.sh", "PASSWORD=$DB_PASSWORD").length, 0);
  assert.equal(ruleIds("config.json", '"password": "DB_PASSWORD"').length, 0); // env-name placeholder
  assert.equal(ruleIds(".env.example", "DB_PASSWORD=changeme").length, 0);
});

test("still flags hardcoded credentials in config files (Sequelize-style)", () => {
  assert.ok(ruleIds("config/config.json", '"password": "MyS3cretDbPass"').includes("generic-secret-assignment"));
  assert.ok(ruleIds("config/db.js", "password: 'MyS3cretDbPass',").includes("generic-secret-assignment"));
});

test("in code, an unquoted bare identifier is a variable reference, not a literal", () => {
  assert.equal(ruleIds("auth.js", "user.password = hashedPassword").length, 0);
  assert.equal(ruleIds("auth.ts", "const password = hashedValue;").length, 0);
  assert.equal(ruleIds("login.py", "password = user_input").length, 0);
  // But a quoted literal in code is still a hardcoded secret.
  assert.ok(ruleIds("auth.js", 'const password = "hunter2secret";').includes("generic-secret-assignment"));
});

test("in config/env/yaml files, an unquoted bare word is a literal and is flagged", () => {
  assert.ok(ruleIds(".env", "PASSWORD=hunter2secret").includes("generic-secret-assignment"));
  assert.ok(ruleIds("app.yml", "password: hunter2secret").includes("generic-secret-assignment"));
  assert.ok(ruleIds("db.properties", "db.password=hunter2secret").includes("generic-secret-assignment"));
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

test("detects a bare Twilio auth token only in a Twilio context", () => {
  const token = "0123456789abcdef0123456789abcdef"; // 32 hex, no keyword
  assert.ok(ruleIds("app.js", `const c = twilio(sid, '${token}');`).includes("twilio-auth-token"));
  assert.ok(ruleIds("app.js", `const sid='AC${"a".repeat(32)}';\nconst t='${token}';`).includes("twilio-auth-token"));
  // No Twilio context: a bare 32-hex string (etag/md5) must NOT be flagged.
  assert.equal(ruleIds("hash.js", `const etag = '${token}';`).includes("twilio-auth-token"), false);
  // A 40-hex git SHA must not match the 32-hex token rule even with context.
  assert.equal(
    ruleIds("app.js", "// twilio\nconst sha='9e3c1f2a5b7d8e0a1c2b3d4e5f60718293a4b5c6';").includes("twilio-auth-token"),
    false
  );
});

test("cross-references staged code against .env secret values", () => {
  const token = "0123456789abcdef0123456789abcdef";
  const leak = scanStaged({
    ...opts, allowlist: [], dotenvSecrets: [token],
    files: ["src/twilioClient.js"], read: () => `const client = twilio(sid, "${token}");`
  });
  assert.ok(leak.findings.some((f) => f.ruleId === "hardcoded-dotenv-secret"));
  // The report must not print the value.
  assert.doesNotMatch(formatReport(leak), new RegExp(token));

  const clean = scanStaged({
    ...opts, allowlist: [], dotenvSecrets: [token],
    files: ["clean.js"], read: () => "const answer = 42;"
  });
  assert.equal(clean.findings.length, 0);
});

test("shannon entropy scores random strings above plain text", () => {
  assert.ok(shannonEntropy("Zx9Kq2mVbN7pLwR4tYaSdFgHjKl") > 4.2);
  assert.ok(shannonEntropy("aaaaaaaaaaaaaaaaaaaa") < 1);
});
