// GForge secret-scanning engine.
//
// This module is intentionally self-contained: it imports only Node built-ins,
// so the installer can copy it verbatim into ~/.gforge/hooks and run it as a
// pre-commit hook without depending on the globally installed package (whose
// path changes across Node/nvm versions).
//
// It never prints matched secret values — only file paths, line numbers, and
// rule identifiers.

import { execFileSync, spawn } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// Baked at install time (see getScannerContent in hooks.js). Left as a literal
// placeholder in source; only used for the update-available notice.
const RUNNING_VERSION = "__GFORGE_VERSION__";

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
// A path segment is identifier-shaped: optionally dot-prefixed, letter-initial,
// and carrying few digits. Random base64 segments fail on digit density.
const PATH_SEGMENT = /^\.?[A-Za-z][A-Za-z0-9_.-]*$/;
const PATH_SEGMENT_MAX_DIGITS = 2;
const PATH_SEGMENT_MAX_DIGIT_RATIO = 0.15;
const PATH_MIN_LOWERCASE_RATIO = 0.55;
const IDENTIFIER_MIN_VOWEL_RATIO = 0.3; // English words ~40% vowels; random secrets ~16%
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

function ratioOf(str, pattern) {
  if (!str) return 0;
  return (str.match(pattern) || []).length / str.length;
}

function isPathSegment(segment) {
  if (!PATH_SEGMENT.test(segment)) return false;
  const digits = (segment.match(/[0-9]/g) || []).length;
  return digits <= PATH_SEGMENT_MAX_DIGITS || digits / segment.length <= PATH_SEGMENT_MAX_DIGIT_RATIO;
}

// `/` belongs in ENTROPY_TOKEN because base64 secrets use it — but that also
// makes an entire import path one token, and the concatenation scores far above
// the bare name (`src/components/GlobalFilterSidebar/GlobalFilterSummaryTrigger`
// is 4.229; `GlobalFilterSummaryTrigger` alone is 3.825). So a path is scored
// per segment instead of whole.
//
// The gate is the load-bearing part. Splitting *every* token on `/` costs real
// detection, because standard base64 uses `/` as an alphabet character: over
// random 40-char AWS secret access keys, unconditional splitting drops
// detection to ~86%. Requiring identifier-shaped segments plus a
// lowercase-heavy token holds that at ~99.8%, since random base64 is only ~40%
// lowercase and its segments carry ~25% digits.
//
// Deliberately splits on `/` only. `-` and `_` are the base64url alphabet, so
// splitting on them too would cut detection of a token embedded in a URL path
// (e.g. `/auth/reset/<base64url>`) from 100% to ~95%.
function looksLikePath(token) {
  if (!token.includes("/")) return false;
  const segments = token.split("/").filter(Boolean);
  if (segments.length < 2 || !segments.every(isPathSegment)) return false;
  const alphanumeric = token.replace(/[^A-Za-z0-9]/g, "");
  return ratioOf(alphanumeric, /[a-z]/g) >= PATH_MIN_LOWERCASE_RATIO;
}

// The strings actually scored for one matched token: a path's segments, or the
// token itself.
export function entropyCandidates(token) {
  return looksLikePath(token) ? token.split("/").filter(Boolean) : [token];
}

// A plain identifier (camelCase / PascalCase / snake_case): identifier characters
// only - no base64/base64url symbols (+ / = -) - with few digits and a
// vowel-rich body. English-word names like `buildBookingMatchWhereClause` clear
// 4.2 bits of entropy but are ~40% vowels; random base64/hex secrets are ~16%
// vowels and digit-heavy, so they fail the vowel or the digit gate. Excluding
// identifiers keeps ~96-99% of random-secret detection (see issue #17).
export function looksLikeIdentifier(token) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(token)) return false;
  const digits = (token.match(/[0-9]/g) || []).length;
  const fewDigits = digits <= PATH_SEGMENT_MAX_DIGITS || digits / token.length <= PATH_SEGMENT_MAX_DIGIT_RATIO;
  const vowels = (token.match(/[aeiouAEIOU]/g) || []).length;
  return fewDigits && vowels / token.length >= IDENTIFIER_MIN_VOWEL_RATIO;
}

function hasHighEntropyToken(line) {
  const tokens = line.match(ENTROPY_TOKEN);
  if (!tokens) return false;
  for (const token of tokens) {
    for (const candidate of entropyCandidates(token)) {
      if (candidate.length < ENTROPY_MIN_LENGTH) continue;
      if (looksLikeIdentifier(candidate)) continue; // natural identifier name, not a secret
      if (shannonEntropy(candidate) >= ENTROPY_THRESHOLD) return true;
    }
  }
  return false;
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

    // One entropy finding per line is enough.
    if (!skipEntropy && hasHighEntropyToken(line)) {
      findings.push({
        file: filePath,
        line: lineNumber,
        ruleId: "high-entropy-string",
        description: "high-entropy string with no recognizable name"
      });
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
// Reporting (never prints matched values). Danger-styled when the output is an
// interactive terminal; plain otherwise (pipes, CI, NO_COLOR).
// ---------------------------------------------------------------------------
function makePalette(enabled) {
  const wrap = (code) => (text) => (enabled ? `[${code}m${text}[0m` : text);
  return {
    danger: wrap("1;97;41"), // bold white on red — the banner
    red: wrap("31"),
    redBold: wrap("1;31"),
    yellow: wrap("33"),
    bold: wrap("1"),
    dim: wrap("2")
  };
}

export function colorEnabled(stream) {
  if (process.env.NO_COLOR) return false;
  if (process.env.FORCE_COLOR) return true;
  return Boolean(stream && stream.isTTY);
}

export function formatReport({ findings, gitleaks }, options = {}) {
  const c = makePalette(Boolean(options.color));
  const lines = [];
  lines.push(c.danger("  ⚒  GForge - COMMIT BLOCKED  "));
  lines.push(c.redBold("Potential secrets detected in staged changes:"));
  lines.push("");

  const byFile = new Map();
  for (const f of findings) {
    if (!byFile.has(f.file)) byFile.set(f.file, []);
    byFile.get(f.file).push(f);
  }

  for (const [file, fileFindings] of byFile) {
    lines.push(`  ${c.bold(file)}`);
    for (const f of fileFindings) {
      const where = f.line > 0 ? `line ${f.line}` : "file";
      lines.push(`    ${c.red("✗")} ${c.yellow(`[${f.ruleId}]`)} ${f.description} (${where})`);
    }
  }

  if (gitleaks?.leaks) {
    lines.push(`  ${c.yellow("(gitleaks also reported findings in the staged changes)")}`);
  }

  lines.push("");
  lines.push(c.dim("No secret values are printed above. To proceed you can:"));
  lines.push(c.dim("  - remove the secret from the staged change, or"));
  lines.push(c.dim("  - mark a false positive with an inline `gforge:allow` comment, or"));
  lines.push(c.dim("  - add a path/pattern to a .gforgeignore file, or"));
  lines.push(c.dim("  - bypass this one commit with: git commit --no-verify"));
  return `${lines.join("\n")}\n`;
}

export function runPreCommit(write = (s) => process.stderr.write(s)) {
  const result = scanStaged();
  const blocked = result.findings.length > 0 || result.gitleaks?.leaks;
  if (blocked) {
    write(formatReport(result, { color: colorEnabled(process.stderr) }));
    return 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Update notification (never blocks or delays the commit).
//
// The commit path only READS a cache written by a detached background check, so
// no network happens on the critical path. Once/day the hook fire-and-forgets a
// background refresh of that cache; with GFORGE_AUTO_UPDATE=1 the background
// process also upgrades the package.
// ---------------------------------------------------------------------------
const UPDATE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const REGISTRY_URL = "https://registry.npmjs.org/gforge/latest";

function updateCachePath() {
  return join(homedir(), ".gforge", "update-check.json");
}

function versionIsNewer(latest, current) {
  const pa = String(latest).split(".").map((n) => parseInt(n, 10) || 0);
  const pb = String(current).split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i += 1) {
    if ((pa[i] || 0) > (pb[i] || 0)) return true;
    if ((pa[i] || 0) < (pb[i] || 0)) return false;
  }
  return false;
}

// Reads the cached latest version, prints a one-line notice if newer, and once a
// day fire-and-forgets a background refresh. Fully best-effort — any failure is
// swallowed so it can never affect the commit.
function maybeUpdateNotice(write) {
  try {
    let cache = null;
    try {
      cache = JSON.parse(readFileSync(updateCachePath(), "utf8"));
    } catch {
      cache = null;
    }

    if (cache && cache.latest && RUNNING_VERSION[0] !== "_" && versionIsNewer(cache.latest, RUNNING_VERSION)) {
      write(`\ngforge: v${cache.latest} is available (you have v${RUNNING_VERSION}). Run: gforge update\n`);
    }

    const stale = !cache || (Date.now() - (cache.checkedAt || 0)) > UPDATE_CACHE_TTL_MS;
    if (stale) {
      const self = fileURLToPath(import.meta.url);
      const child = spawn(process.execPath, [self, "__update-check"], {
        detached: true,
        stdio: "ignore"
      });
      child.unref();
    }
  } catch {
    // Never let update logic affect a commit.
  }
}

// Background worker: refresh the cache and (opt-in) auto-upgrade. Detached from
// the commit, so it may take its time.
async function runUpdateCheck() {
  const cachePath = updateCachePath();
  let latest = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 6000);
    try {
      const response = await fetch(REGISTRY_URL, { signal: controller.signal });
      if (response.ok) {
        const body = await response.json();
        if (body && /^\d+\.\d+\.\d+/.test(String(body.version || ""))) latest = body.version;
      }
    } finally {
      clearTimeout(timer);
    }
  } catch {
    latest = null;
  }

  try {
    // Always stamp checkedAt so a failed check still waits a day before retrying.
    writeFileSync(cachePath, `${JSON.stringify({ checkedAt: Date.now(), latest: latest ?? null })}\n`);
  } catch {
    // ignore
  }

  // Auto-install is ON by default; opt out with GFORGE_AUTO_UPDATE=0/false/off/no.
  const optOut = ["0", "false", "off", "no"].includes(String(process.env.GFORGE_AUTO_UPDATE || "").toLowerCase());
  const safeVersion = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(String(latest || ""));
  if (latest && safeVersion && !optOut && RUNNING_VERSION[0] !== "_" && versionIsNewer(latest, RUNNING_VERSION)) {
    try {
      // Install target is the constant gforge@latest (== the version we just
      // detected); nothing registry-derived is interpolated into the command.
      const npm = spawn("npm", ["install", "-g", "gforge@latest"], {
        stdio: "ignore",
        shell: process.platform === "win32"
      });
      await new Promise((resolve) => npm.on("close", resolve).on("error", resolve));
    } catch {
      // ignore; the notice will still prompt a manual `gforge update`.
    }
  }
}

// Run as a hook when executed directly (e.g. ~/.gforge/hooks/gforge-scan.mjs).
const invokedDirectly =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (invokedDirectly) {
  if (process.argv[2] === "__update-check") {
    runUpdateCheck().finally(() => process.exit(0));
  } else {
    try {
      const code = runPreCommit();
      maybeUpdateNotice((s) => process.stderr.write(s));
      process.exit(code);
    } catch (error) {
      // Fail closed: if the scanner cannot run, block rather than risk a leak.
      process.stderr.write(`GForge: secret scan could not complete, blocking commit for safety.\n${error?.message ?? error}\n`);
      process.exit(1);
    }
  }
}
