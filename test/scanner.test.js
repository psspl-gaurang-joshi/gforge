import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeBlob,
  entropyCandidates,
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

test("entropy does not flag ordinary long identifiers (issue #17)", () => {
  for (const id of [
    "buildBookingMatchWhereClause",
    "ManagerDashboardUpcomingAnalyticsCard",
    "UpdateLocationSummaryEmailPreferencesDto",
    "fetchRawAudioFromPBX"
  ]) {
    assert.equal(ruleIds("service.ts", `  async ${id}(input) {`).includes("high-entropy-string"), false, id);
  }
  // But an identifier-shaped string that is actually random (vowel-sparse) is caught.
  assert.ok(ruleIds("a.ts", 'const k = "Zx9Kq2mVbN7pLwR4tYaSdFgHjKlPoIuY"').includes("high-entropy-string"));
});

// --- entropy tokenizer: paths vs. base64 (issue #1) ------------------------
// A long path used to be scored as one token, so the concatenation crossed the
// threshold even when every identifier in it was ordinary. Fixtures below are
// real lines from an audited monorepo.

const AWS_SECRET_KEY = "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY"; // canonical AWS example key, 40 b64 chars, two "/"
const B64URL_TOKEN = "kM8Yq-3xZv7TbN2wRp5LsJ4hGf9dCe1aUiOoPqXyZmA"; // 43 chars, "-" and "_" are alphabet here

test("entropy scores path segments, not the whole path", () => {
  // The concatenated path scores 4.229; the bare identifier scores 3.825.
  const importLine =
    "import GlobalFilterSummaryTrigger from 'src/components/GlobalFilterSidebar/GlobalFilterSummaryTrigger'";
  assert.equal(ruleIds("Layout.tsx", importLine).length, 0);
  assert.equal(ruleIds("x.tsx", "from 'src/components/agent-dashboard/AgentCallVolumeChart'").length, 0);
  assert.equal(ruleIds("x.ts", " * documents/modules/webhook-implementation/bug-fix/).").length, 0);
  // Dotfile directory segments, i.e. build caches.
  assert.equal(ruleIds("x.js", "// node_modules/.vite/deps/chunk-QWERTYUIOP").length, 0);
  // Version and acronym segments carry digits without being random.
  assert.equal(ruleIds("x.ts", "from 'client/src/api/v2/endpoints/CustomerBookingEndpoints'").length, 0);
  assert.equal(ruleIds("x.ts", "from 'src/modules/oauth2/strategies/GoogleOAuth2Strategy'").length, 0);
  assert.equal(ruleIds("x.ts", "from 'src/aws/s3/S3StorageAdapterFactory'").length, 0);
});

test("entropy leaves ordinary path-shaped prose alone", () => {
  // Markdown links, CDN URLs, scoped package names, and deep relative paths all
  // tokenize as one long "/"-joined string.
  assert.equal(ruleIds("README.md", "See [the guide](documents/modules/webhook-implementation/setup/).").length, 0);
  assert.equal(ruleIds("index.html", '<script src="https://cdn.example.com/static/js/main-chunk"></script>').length, 0);
  assert.equal(ruleIds("x.ts", "import { thing } from '@babel/plugin-transform-runtime/lib/helpers'").length, 0);
  assert.equal(ruleIds("x.ts", "from '../../../shared/infrastructure/persistence/RepositoryFactory'").length, 0);
  assert.equal(ruleIds("Makefile", "OUT := build/artifacts/linux-amd64/release-bundle").length, 0);
});

test("path splitting does not hide base64 secrets containing a slash", () => {
  // The AWS key's segments look identifier-ish; only the lowercase-ratio gate
  // keeps it out of the path branch. Losing this is the whole risk of the fix.
  assert.ok(ruleIds("a.ts", `const k = "${AWS_SECRET_KEY}"`).includes("high-entropy-string"));
  assert.ok(ruleIds("a.env", `AWS_SECRET_ACCESS_KEY=${AWS_SECRET_KEY}`).includes("high-entropy-string"));
  // base64url shapes, including one sitting in a URL path — the case that rules
  // out also splitting on "-" and "_".
  assert.ok(ruleIds("a.ts", `sig = '${B64URL_TOKEN}'`).includes("high-entropy-string"));
  assert.ok(ruleIds("a.ts", `url = '/auth/reset/${B64URL_TOKEN}'`).includes("high-entropy-string"));
  assert.ok(ruleIds("a.ts", `url = '/api/v1/token/${B64URL_TOKEN}'`).includes("high-entropy-string"));
  // Padded base64 with slashes, and a long opaque blob.
  assert.ok(ruleIds("a.ts", 'blob = "Zm9vL2Jhci9iYXo/cXV4Kzk4NzY1NDMyMTBhYmNkZWY="').includes("high-entropy-string"));
});

test("a high-entropy segment inside a path is still flagged", () => {
  // Splitting must not blanket-exempt anything containing a "/". A hashed
  // filename is a real (if low-value) hit: the segment alone scores 4.316.
  assert.ok(ruleIds("index.html", 'href="/assets/vendor-apexcharts-BlCFUAhW.js"').includes("high-entropy-string"));
  // A secret concatenated onto a legitimate path prefix stays visible.
  assert.ok(ruleIds("a.ts", `const u = 'src/components/${AWS_SECRET_KEY}'`).includes("high-entropy-string"));
});

test("a path and a secret on the same line still yields a finding", () => {
  const line = `import x from 'src/components/agent-dashboard/AgentCallVolumeChart'; const k = "${AWS_SECRET_KEY}";`;
  assert.ok(ruleIds("x.ts", line).includes("high-entropy-string"));
});

test("entropyCandidates decomposes paths and leaves opaque tokens whole", () => {
  assert.deepEqual(entropyCandidates("src/components/GlobalFilterSidebar/GlobalFilterSummaryTrigger"), [
    "src",
    "components",
    "GlobalFilterSidebar",
    "GlobalFilterSummaryTrigger"
  ]);
  // Leading and trailing separators must not produce empty candidates.
  assert.deepEqual(entropyCandidates("/documents/modules/webhook-implementation/"), [
    "documents",
    "modules",
    "webhook-implementation"
  ]);
  // Not paths: no separator, a single segment, base64 padding (=), or a segment
  // that is long and random rather than a name are all scored whole.
  assert.deepEqual(entropyCandidates(AWS_SECRET_KEY), [AWS_SECRET_KEY]);
  assert.deepEqual(entropyCandidates(B64URL_TOKEN), [B64URL_TOKEN]);
  assert.deepEqual(entropyCandidates("Zx9Kq2mVbN7pLwR4tYaSdFgHjKlPoIuY"), ["Zx9Kq2mVbN7pLwR4tYaSdFgHjKlPoIuY"]);
  assert.deepEqual(entropyCandidates("/onlyonesegmentislongenough"), ["/onlyonesegmentislongenough"]);
  assert.deepEqual(entropyCandidates("aGVsbG8=/d29ybGQ="), ["aGVsbG8=/d29ybGQ="]);
  // SCREAMING_SNAKE_CASE segments are clean const/env names, not base64 (which is
  // mixed-case), so an all-caps path decomposes per-segment too (issue #19).
  assert.deepEqual(entropyCandidates("SRC/COMPONENTS/GLOBALFILTERSUMMARYTRIGGER"), [
    "SRC",
    "COMPONENTS",
    "GLOBALFILTERSUMMARYTRIGGER"
  ]);
});

test("issue #19: f-string interpolation and SCREAMING_SNAKE path segments are not secrets", () => {
  // 1) f-string / interpolated-string values are references, not literals.
  assert.equal(ruleIds("voice_changer.py", `    headers = {"Authorization": f"Bearer {token}"}`).length, 0);
  assert.equal(ruleIds("a.py", `auth = f"Bearer {access_token}"`).length, 0);
  assert.equal(ruleIds("a.cs", `password = $"{dbPassword}"`).length, 0);
  // 2) a shell/env var path with a SCREAMING_SNAKE segment is not high-entropy.
  assert.equal(
    ruleIds("setup.sh", `  python -m pip install -r "$BACKEND_DIR/requirements.txt"`).includes("high-entropy-string"),
    false
  );
  assert.equal(entropyCandidates("BACKEND_DIR/requirements").length, 2);
  // But real hardcoded secrets are still caught.
  assert.ok(ruleIds("a.py", 'password = "MyR3alHardcodedValue"').includes("generic-secret-assignment"));
  assert.ok(ruleIds("a.ts", `const k = "${AWS_SECRET_KEY}"`).includes("high-entropy-string"));
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

test("decodes UTF-16/BOM blobs so Windows/PowerShell files are scanned", () => {
  const secret = "password=SuperSecretValue123";
  const utf16le = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(`${secret}\n`, "utf16le")]);
  assert.equal(decodeBlob(utf16le).includes(secret), true);
  // A real secret in a UTF-16 file must be detected once decoded.
  assert.ok(scanText("config.txt", decodeBlob(utf16le), { runGitleaks: false }).some((f) => f.ruleId === "generic-secret-assignment"));
  // UTF-8 with BOM and plain UTF-8 both round-trip.
  assert.equal(decodeBlob(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(secret)])), secret);
  assert.equal(decodeBlob(Buffer.from(secret)), secret);
});

test("does not flag trivial non-secret values (PASS=123)", () => {
  assert.equal(ruleIds("config.txt", "PASS=123").length, 0);
  assert.equal(ruleIds("config.txt", "PORT=3000").length, 0);
  assert.equal(ruleIds("config.txt", "DEBUG=true").length, 0);
});

test("shannon entropy scores random strings above plain text", () => {
  assert.ok(shannonEntropy("Zx9Kq2mVbN7pLwR4tYaSdFgHjKl") > 4.2);
  assert.ok(shannonEntropy("aaaaaaaaaaaaaaaaaaaa") < 1);
});
