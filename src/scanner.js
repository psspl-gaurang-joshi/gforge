// GForge secret-scanning engine.
//
// This module is intentionally self-contained: it imports only Node built-ins,
// so the installer can copy it verbatim into ~/.gforge/hooks and run it as a
// pre-commit hook without depending on the globally installed package (whose
// path changes across Node/nvm versions).
//
// It never prints matched secret values — only file paths, line numbers, and
// rule identifiers.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Provider / value-shape rules (high confidence). Ported and adapted from the
// well-known gitleaks ruleset. Each regex is matched per line.
// ---------------------------------------------------------------------------
export const PROVIDER_RULES = [
  { id: "private-key", description: "Private key block", regex: /-----BEGIN(?: [A-Z0-9]+)* PRIVATE KEY(?: BLOCK)?-----/ },
  { id: "aws-access-key-id", description: "AWS access key ID", regex: /\b(?:AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|A3T[A-Z0-9])[A-Z0-9]{16}\b/ },
  { id: "github-pat", description: "GitHub personal access token", regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/ },
  { id: "github-fine-grained-pat", description: "GitHub fine-grained token", regex: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/ },
  { id: "gitlab-pat", description: "GitLab personal access token", regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/ },
  { id: "slack-token", description: "Slack token", regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
  { id: "slack-app-token", description: "Slack app token", regex: /\bxapp-[0-9]-[A-Za-z0-9-]{10,}\b/ },
  { id: "slack-webhook", description: "Slack webhook URL", regex: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/[A-Za-z0-9]+/ },
  { id: "stripe-secret-key", description: "Stripe secret/restricted key", regex: /\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/ },
  { id: "google-api-key", description: "Google API key", regex: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: "gcp-oauth-secret", description: "Google OAuth client secret", regex: /\bGOCSPX-[A-Za-z0-9_-]{20,}\b/ },
  { id: "twilio-api-key", description: "Twilio API key/SID", regex: /\b(?:SK|AC)[0-9a-fA-F]{32}\b/ },
  { id: "sendgrid-key", description: "SendGrid API key", regex: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { id: "mailgun-key", description: "Mailgun API key", regex: /\bkey-[0-9a-zA-Z]{32}\b/ },
  { id: "mailchimp-key", description: "Mailchimp API key", regex: /\b[0-9a-f]{32}-us[0-9]{1,2}\b/ },
  { id: "npm-token", description: "npm access token", regex: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: "pypi-token", description: "PyPI upload token", regex: /\bpypi-AgEIcHlwaS[A-Za-z0-9_-]{50,}\b/ },
  { id: "openai-key", description: "OpenAI API key", regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/ },
  { id: "anthropic-key", description: "Anthropic API key", regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/ },
  { id: "digitalocean-token", description: "DigitalOcean token", regex: /\bdo[oprt]_v1_[a-f0-9]{64}\b/ },
  { id: "doppler-token", description: "Doppler token", regex: /\bdp\.(?:pt|st|ct|sa)\.[A-Za-z0-9]{40,}\b/ },
  { id: "shopify-token", description: "Shopify access token", regex: /\bshp(?:at|ca|pa|ss)_[a-fA-F0-9]{32}\b/ },
  { id: "square-token", description: "Square access token", regex: /\b(?:sq0atp-[A-Za-z0-9_-]{22}|EAAA[A-Za-z0-9_-]{60})\b/ },
  { id: "telegram-bot-token", description: "Telegram bot token", regex: /\b[0-9]{8,10}:AA[A-Za-z0-9_-]{33}\b/ },
  { id: "jwt", description: "JSON Web Token", regex: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  { id: "basic-auth-url", description: "Credentials embedded in URL", regex: /\b[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s:@]{3,}@/i }
];

// Generic credential-keyword assignment (e.g. DB_PASS=..., password: "..."),
// handled specially so the assigned VALUE can be classified. A hardcoded literal
// is flagged, but a reference such as process.env.DB_PASSWORD, a function call,
// or an interpolation is NOT — blocking well-written config would defeat the
// purpose and train developers to bypass the hook.
export const GENERIC_SECRET_RULE_ID = "generic-secret-assignment";
const GENERIC_SECRET_DESCRIPTION = "hardcoded value assigned to a credential keyword";
const GENERIC_KEYWORD_RE = /(?:^|[^A-Za-z0-9])(?:passwd|password|passphrase|pwd|pass|secret(?:[_-]?key)?|token|access[_-]?token|auth(?:[_-]?token)?|authorization|bearer|api[_-]?key|apikey|access[_-]?key|client[_-]?secret|private[_-]?key|encryption[_-]?key|signing[_-]?key|session[_-]?key|connection[_-]?string|conn[_-]?str|credentials?)["'`]?\s*[:=]\s*(\S.*)$/i;
const VALUE_PLACEHOLDER_RE = /^(your|my|the|changeme|change[_-]?me|example|placeholder|redacted|dummy|sample|test|none|null|nil|undefined|true|false|xxx+|x{3,}|\*+|todo|tbd|password|passwd|secret|token|value|string)$/i;
const VALUE_REFERENCE_ROOT_RE = /^(process|import|globalThis|window|os|System|Deno|ENV|env|config|configService|vault|secret|secrets|settings)$/i;

// Decide whether the value assigned to a credential keyword is a hardcoded
// literal (flag) rather than a reference/placeholder (ignore).
export function looksLikeHardcodedSecret(rawValue, options = {}) {
  let value = String(rawValue).trim();
  const quote = value[0];
  const quoted = quote === '"' || quote === "'" || quote === "`";
  if (quoted) {
    const end = value.indexOf(quote, 1);
    value = end === -1 ? value.slice(1) : value.slice(1, end);
  } else {
    value = value.split(/[\s,;)}\]]/)[0];
  }
  value = value.trim();

  if (value.length < 4) return false;
  // Interpolations / template placeholders are references regardless of quoting.
  if (/\$\{|\{\{|%\(|<%|#\{/.test(value)) return false;
  if (!quoted) {
    // Unquoted expressions: shell vars, member access, function calls, env lookups.
    if (value.startsWith("$")) return false;
    if (/[.(]/.test(value)) return false;
    if (VALUE_REFERENCE_ROOT_RE.test(value)) return false;
    // In source code, an unquoted bare identifier (user.password = hashedPassword)
    // is a variable reference, not a literal. In config/env/YAML files an unquoted
    // bare word IS the literal value, so only exempt this for code files.
    if (options.codeFile && /^[A-Za-z_$][\w$]*$/.test(value)) return false;
  }
  // Env-name-like placeholders (DB_PASSWORD) and common dummy values.
  if (/^[A-Z][A-Z0-9_]{2,}$/.test(value)) return false;
  if (VALUE_PLACEHOLDER_RE.test(value)) return false;
  if (/^<.*>$/.test(value) || value === "...") return false;

  return true;
}

// Known source-code file types, where unquoted bare identifiers are variable
// references. Anything else (.env, .yml, .ini, .properties, .txt, …) is treated
// as a config/literal file.
const CODE_EXTENSIONS = new Set([
  "js", "jsx", "ts", "tsx", "mjs", "cjs", "py", "rb", "go", "java", "kt", "kts",
  "php", "cs", "cpp", "cc", "cxx", "c", "h", "hpp", "rs", "swift", "scala", "dart",
  "lua", "pl", "pm", "r", "mm", "vue", "svelte", "groovy", "clj", "ex", "exs"
]);

function isCodeFile(filePath) {
  const name = basename(filePath).toLowerCase();
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return false;
  return CODE_EXTENSIONS.has(name.slice(dot + 1));
}

// ---------------------------------------------------------------------------
// Secret-file rules: files that should essentially never be committed. Matched
// against the file's basename (and a couple of path suffixes).
// ---------------------------------------------------------------------------
const ALLOWED_ENV_SUFFIXES = new Set(["example", "sample", "template", "dist", "defaults", "tpl", "test"]);

// True for env template files (.env.example, .env.sample, ...) that are meant
// to be committed with placeholder values.
export function isEnvTemplate(filePath) {
  const name = basename(filePath).toLowerCase();
  if (!name.startsWith(".env.")) return false;
  return ALLOWED_ENV_SUFFIXES.has(name.slice(".env.".length));
}

export function matchFilenameRule(filePath) {
  const name = basename(filePath).toLowerCase();

  // Environment files, except obvious templates (.env.example, .env.sample, ...).
  if (name === ".env") {
    return { id: "secret-file-env", description: ".env file (may contain secrets)" };
  }
  if (name.startsWith(".env.")) {
    const suffix = name.slice(".env.".length);
    if (!ALLOWED_ENV_SUFFIXES.has(suffix)) {
      return { id: "secret-file-env", description: "environment file (may contain secrets)" };
    }
  }

  // Private key material and credential stores.
  const exactNames = new Set([
    "id_rsa", "id_dsa", "id_ecdsa", "id_ed25519",
    ".git-credentials", ".htpasswd", ".pgpass", ".netrc",
    "credentials"
  ]);
  if (exactNames.has(name)) {
    return { id: "secret-file", description: "credential/private-key file" };
  }

  const secretExtensions = [".p12", ".pfx", ".pkcs12", ".keystore", ".jks", ".ppk", ".kdbx"];
  if (secretExtensions.some((ext) => name.endsWith(ext))) {
    return { id: "secret-file", description: "keystore/credential file" };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Entropy detection for high-entropy strings that carry no recognizable name.
// ---------------------------------------------------------------------------
const ENTROPY_MIN_LENGTH = 20;
const ENTROPY_THRESHOLD = 4.2; // pure hex/decimal/UUID cannot reach this; base64-like secrets do.
const ENTROPY_TOKEN = /[A-Za-z0-9+/=_-]{20,}/g;
const LOCKFILE_NAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml",
  "composer.lock", "gemfile.lock", "go.sum", "cargo.lock", "poetry.lock",
  "podfile.lock", "flake.lock"
]);

export function shannonEntropy(str) {
  if (!str) return 0;
  const freq = new Map();
  for (const ch of str) freq.set(ch, (freq.get(ch) || 0) + 1);
  let entropy = 0;
  for (const count of freq.values()) {
    const p = count / str.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

function looksBinary(content) {
  const sample = content.slice(0, 8000);
  let control = 0;
  for (let i = 0; i < sample.length; i += 1) {
    const code = sample.charCodeAt(i);
    if (code === 0) return true;
    if (code < 9 || (code > 13 && code < 32)) control += 1;
  }
  return control / (sample.length || 1) > 0.3;
}

// ---------------------------------------------------------------------------
// Allowlist: a .gforgeignore (or .gitleaksignore) file whose non-comment lines
// are path substrings/regexes to skip, plus inline `gforge:allow` comments.
// ---------------------------------------------------------------------------
const INLINE_ALLOW = /(?:gforge|gitleaks):allow/i;

export function parseAllowlist(text) {
  if (!text) return [];
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map((line) => {
      try {
        return new RegExp(line);
      } catch {
        // Not a valid regex: treat as a literal path substring.
        return { test: (value) => value.includes(line) };
      }
    });
}

function isPathAllowlisted(filePath, allowlist) {
  return allowlist.some((matcher) => matcher.test(filePath));
}

// ---------------------------------------------------------------------------
// Core text scanner.
// ---------------------------------------------------------------------------
export function scanText(filePath, content, options = {}) {
  const findings = [];
  const name = basename(filePath).toLowerCase();
  const skipEntropy =
    options.entropy === false ||
    LOCKFILE_NAMES.has(name) ||
    name.endsWith(".min.js") ||
    name.endsWith(".min.css") ||
    name.endsWith(".map") ||
    looksBinary(content);

  const includeGeneric = options.generic !== false;
  const codeFile = isCodeFile(filePath);
  // Twilio auth tokens are bare 32-hex strings (no prefix), indistinguishable
  // from an MD5 on their own. Only treat a 32-hex string as a token when the
  // file also carries Twilio context (an AC…/SK… SID or the word "twilio").
  const twilioContext = /twilio/i.test(content) || /\b(?:AC|SK)[0-9a-fA-F]{32}\b/.test(content);
  const lines = content.split(/\r?\n/);

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (INLINE_ALLOW.test(line)) continue;
    const lineNumber = i + 1;

    for (const rule of PROVIDER_RULES) {
      if (rule.regex.test(line)) {
        findings.push({ file: filePath, line: lineNumber, ruleId: rule.id, description: rule.description });
      }
    }

    if (twilioContext && /(?<![A-Za-z0-9])[0-9a-fA-F]{32}(?![A-Za-z0-9])/.test(line)) {
      findings.push({
        file: filePath,
        line: lineNumber,
        ruleId: "twilio-auth-token",
        description: "possible Twilio auth token (32-hex value in a Twilio context)"
      });
    }

    if (includeGeneric) {
      const match = line.match(GENERIC_KEYWORD_RE);
      if (match && looksLikeHardcodedSecret(match[1], { codeFile })) {
        findings.push({
          file: filePath,
          line: lineNumber,
          ruleId: GENERIC_SECRET_RULE_ID,
          description: GENERIC_SECRET_DESCRIPTION
        });
      }
    }

    if (!skipEntropy) {
      const tokens = line.match(ENTROPY_TOKEN);
      if (tokens) {
        for (const token of tokens) {
          if (token.length < ENTROPY_MIN_LENGTH) continue;
          if (shannonEntropy(token) >= ENTROPY_THRESHOLD) {
            findings.push({
              file: filePath,
              line: lineNumber,
              ruleId: "high-entropy-string",
              description: "high-entropy string with no recognizable name"
            });
            break; // one entropy finding per line is enough
          }
        }
      }
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Git integration.
// ---------------------------------------------------------------------------
function git(args, options = {}) {
  // Capture stdout; silence stderr so expected failures (e.g. `git show` for a
  // path that is not staged) do not spew "fatal:" noise on every commit.
  return execFileSync("git", args, {
    maxBuffer: 1024 * 1024 * 512,
    stdio: ["ignore", "pipe", "ignore"],
    ...options
  });
}

function stagedFiles() {
  // -z emits raw NUL-delimited paths (no quoting/escaping), so no core.quotePath needed.
  const out = git(["diff", "--cached", "-z", "--name-only", "--diff-filter=ACMR"]);
  return out.toString("utf8").split("\0").filter(Boolean);
}

// Decode a git blob to text, honoring BOMs and BOM-less UTF-16 (common on
// Windows, e.g. files written by PowerShell's `>`/Out-File). Without this a
// UTF-16 secret reads as interleaved NUL bytes and no rule matches. Falls back
// to latin1 so binary content is still scanned byte-for-byte.
export function decodeBlob(buf) {
  if (!buf || buf.length === 0) return "";
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.toString("utf16le", 2);
  if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
    const swapped = Buffer.from(buf.subarray(2));
    swapped.swap16();
    return swapped.toString("utf16le");
  }
  if (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) {
    return buf.toString("utf8", 3);
  }
  // BOM-less UTF-16LE heuristic: many NULs in the odd byte positions.
  const sample = Math.min(buf.length, 1024);
  if (sample >= 4) {
    let zeros = 0;
    let checked = 0;
    for (let i = 1; i < sample; i += 2) {
      checked += 1;
      if (buf[i] === 0) zeros += 1;
    }
    if (checked > 0 && zeros / checked > 0.7) return buf.toString("utf16le");
  }
  return buf.toString("latin1");
}

function stagedContent(filePath) {
  try {
    return decodeBlob(git(["show", `:${filePath}`]));
  } catch {
    return null; // submodule/gitlink or unreadable; nothing to scan.
  }
}

function loadAllowlist() {
  let root;
  try {
    root = git(["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  } catch {
    return [];
  }
  const patterns = [];
  for (const file of [".gforgeignore", ".gitleaksignore"]) {
    const content = stagedOrWorkingFile(root, file);
    if (content) patterns.push(...parseAllowlist(content));
  }
  return patterns;
}

function stagedOrWorkingFile(root, relPath) {
  // Prefer the staged version, fall back to the working tree.
  const staged = stagedContent(relPath);
  if (staged !== null) return staged;
  try {
    return readFileSync(`${root}/${relPath}`, "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// .env cross-reference: the highest-precision signal. Collect the actual secret
// VALUES from the repo's (git-ignored) .env files, then flag any staged file
// that hardcodes one of those values verbatim — the classic "copied the token
// out of .env into the code" leak. Values are never printed.
// ---------------------------------------------------------------------------
const DOTENV_FILES = [
  ".env", ".env.local", ".env.development", ".env.production",
  ".env.staging", ".env.test", ".env.development.local", ".env.production.local"
];
const DOTENV_KEY_IS_SECRET = /(pass|pwd|secret|token|key|auth|cred|api|private|access|signature|salt)/i;
const DOTENV_VALUE_STOPLIST = /^(true|false|null|none|undefined|localhost|127\.0\.0\.1|0\.0\.0\.0|development|production|staging|test|changeme|example|placeholder|your[_-].*|xxx+)$/i;

function looksLikeDotenvSecret(key, value) {
  if (value.length < 6) return false;
  if (DOTENV_VALUE_STOPLIST.test(value)) return false;
  if (/^\d+$/.test(value)) return false; // ports, ids
  if (DOTENV_KEY_IS_SECRET.test(key)) return true;
  // Otherwise only treat long, random-looking values as secrets.
  return value.length >= 12 && /[A-Za-z]/.test(value) && /[0-9]/.test(value);
}

function loadDotenvSecrets() {
  let root;
  try {
    root = git(["rev-parse", "--show-toplevel"]).toString("utf8").trim();
  } catch {
    return [];
  }
  const secrets = new Set();
  for (const file of DOTENV_FILES) {
    let text;
    try {
      text = decodeBlob(readFileSync(`${root}/${file}`));
    } catch {
      continue;
    }
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (!match) continue;
      let value = match[2].trim();
      const q = value[0];
      if ((q === '"' || q === "'" || q === "`") && value.endsWith(q)) {
        value = value.slice(1, -1);
      } else {
        value = value.split(/\s+#/)[0].trim(); // drop trailing inline comment
      }
      if (looksLikeDotenvSecret(match[1], value)) secrets.add(value);
    }
  }
  return [...secrets];
}

function lineOfSubstring(content, needle) {
  const index = content.indexOf(needle);
  if (index === -1) return 0;
  return content.slice(0, index).split(/\r?\n/).length;
}

// Optional turbo layer: if the gitleaks binary is installed, run it over the
// staged changes and merge its verdict. Uses --redact so no secret is printed.
function runGitleaks() {
  try {
    execFileSync("gitleaks", ["version"], { stdio: "ignore" });
  } catch {
    return { available: false, leaks: false };
  }

  try {
    execFileSync("gitleaks", ["protect", "--staged", "--redact", "--no-banner"], { stdio: "pipe" });
    return { available: true, leaks: false };
  } catch (error) {
    if (error && error.status === 1) {
      return { available: true, leaks: true };
    }
    // Unsupported subcommand on a newer/older gitleaks, or another error:
    // do not block on gitleaks itself; the native engine still ran.
    return { available: true, leaks: false, errored: true };
  }
}

export function scanStaged(options = {}) {
  const allowlist = options.allowlist ?? loadAllowlist();
  const files = options.files ?? stagedFiles();
  const dotenvSecrets = options.dotenvSecrets ?? loadDotenvSecrets();
  const findings = [];

  for (const file of files) {
    if (isPathAllowlisted(file, allowlist)) continue;

    const fileRule = matchFilenameRule(file);
    if (fileRule) {
      findings.push({ file, line: 0, ruleId: fileRule.id, description: fileRule.description });
    }

    const content = options.read ? options.read(file) : stagedContent(file);
    if (content === null || content === undefined) continue;

    // Highest-precision check: a real secret value from .env hardcoded here.
    for (const secret of dotenvSecrets) {
      if (content.includes(secret)) {
        findings.push({
          file,
          line: lineOfSubstring(content, secret),
          ruleId: "hardcoded-dotenv-secret",
          description: "a secret value from a .env file is hardcoded here"
        });
        break; // one is enough to block; do not enumerate values
      }
    }

    // Env templates are meant to hold placeholder values, so skip the generic
    // keyword and entropy rules for them, but still catch a real provider token.
    const fileOptions = isEnvTemplate(file) ? { ...options, generic: false, entropy: false } : options;
    findings.push(...scanText(file, content, fileOptions));
  }

  const gitleaks = options.runGitleaks === false ? { available: false, leaks: false } : runGitleaks();
  return { findings, gitleaks };
}

// ---------------------------------------------------------------------------
// Reporting (never prints matched values).
// ---------------------------------------------------------------------------
export function formatReport({ findings, gitleaks }) {
  const lines = [];
  lines.push("GForge blocked this commit — potential secrets detected in staged changes.");
  lines.push("");

  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }

  for (const [file, fileFindings] of byFile) {
    lines.push(`  ${file}`);
    for (const f of fileFindings) {
      const where = f.line > 0 ? `line ${f.line}` : "file";
      lines.push(`    - [${f.ruleId}] ${f.description} (${where})`);
    }
  }

  if (gitleaks?.leaks) {
    lines.push("  (gitleaks also reported findings in the staged changes)");
  }

  lines.push("");
  lines.push("No secret values are printed above. To proceed you can:");
  lines.push("  - remove the secret from the staged change, or");
  lines.push("  - mark a false positive with an inline `gforge:allow` comment, or");
  lines.push("  - add a path/pattern to a .gforgeignore file, or");
  lines.push("  - bypass this one commit with: git commit --no-verify");
  return `${lines.join("\n")}\n`;
}

export function runPreCommit(write = (s) => process.stderr.write(s)) {
  const result = scanStaged();
  const blocked = result.findings.length > 0 || result.gitleaks?.leaks;
  if (blocked) {
    write(formatReport(result));
    return 1;
  }
  return 0;
}

// Run as a hook when executed directly (e.g. ~/.gforge/hooks/gforge-scan.mjs).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  try {
    process.exit(runPreCommit());
  } catch (error) {
    // Fail closed: if the scanner cannot run, block rather than risk a leak.
    process.stderr.write(`GForge: secret scan could not complete, blocking commit for safety.\n${error?.message ?? error}\n`);
    process.exit(1);
  }
}
