# GForge

[![npm version](https://img.shields.io/npm/v/gforge.svg)](https://www.npmjs.com/package/gforge)
[![node](https://img.shields.io/node/v/gforge.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/gforge.svg)](LICENSE)

GForge is a **git firewall** for developer workstations. It installs a managed
global `pre-commit` hook that blocks commits containing secrets — passwords, API
keys, tokens, private keys, `.env` files, and high-entropy strings — across every
repository on the machine, on macOS, Linux, and Windows.

Install once, and every `git commit` on the workstation is scanned before it can
leak a credential.

## Features

- **One command, all repositories.** Configures Git's global `core.hooksPath`, so
  the firewall applies to every repo without per-project setup.
- **Deep secret detection.** A comprehensive engine covers several layers:
  - **`.env` cross-reference** — blocks any staged file that hardcodes a real secret
    value found in your git-ignored `.env` files (e.g. a token pasted out of `.env`).
  - **Provider rules** — 25+ credential shapes (AWS, GitHub/GitLab, Google, Slack,
    Stripe, Twilio, SendGrid, npm, PyPI, OpenAI, private keys, JWTs, DB URLs, …).
  - **Generic secrets** — any credential keyword assigned to a value
    (`DB_PASS=…`, `password: …`, `api_key = …`), so custom secrets are caught too.
  - **Entropy** — high-entropy strings that have no recognizable variable name.
- **Secret-file blocking.** `.env` (and `.env.*`, except templates like
  `.env.example`), `id_rsa`, `*.p12`/`*.pfx`, keystores, `.npmrc`, and more.
- **gitleaks turbo.** If the [gitleaks](https://github.com/gitleaks/gitleaks)
  binary is installed, GForge also runs it and merges its findings — GForge's
  engine works on its own, and gets even stronger when gitleaks is present.
- **Never leaks the secret.** Reports only file paths, line numbers, and rule
  names — the matched value is never printed.
- **Managed false positives.** A `.gforgeignore` file and inline `gforge:allow`
  comments let you silence known-safe matches.
- **Cross-platform.** macOS (Bash/Zsh), Linux (Bash), and Windows (Git Bash / WSL).
- **Safe lifecycle.** `install` is idempotent, `verify` is read-only, and
  `uninstall` removes only GForge-owned files and restores your prior Git config.
- **Zero runtime dependencies.**

## Requirements

- Node.js 20 or newer
- Git

## Installation

Install globally from npm:

```bash
npm install -g gforge
```

<details>
<summary>Other install methods</summary>

Install from the Git repository:

```bash
npm install -g git+https://github.com/psspl-gaurang-joshi/gforge.git
```

Install from a local clone:

```bash
npm install -g .
```

Link the local CLI during development:

```bash
npm link
```

</details>

After installing, run it once to set up the global hooks:

```bash
gforge install
```

## Upgrading

```bash
npm install -g gforge
```

If GForge is already active, upgrading **automatically refreshes** the installed
hook to the new version (via a postinstall step) — no extra command needed.
`gforge verify` will confirm `gforge-scan.mjs-content: managed content matches`.

Two caveats:

- If you install with `npm install --ignore-scripts` (or your environment blocks
  install scripts), run `gforge update` yourself after upgrading.
- `gforge verify` reports `installed engine is stale — run gforge update` whenever
  the on-disk hook lags the installed CLI, so a missed refresh is easy to spot.

## Usage

```bash
gforge <command>
```

| Command | Description |
| --- | --- |
| `gforge install` | Install managed global hooks and set global `core.hooksPath`. |
| `gforge verify` | Read-only check of environment and installed hooks. |
| `gforge update` | Re-apply the latest managed hooks (idempotent). |
| `gforge uninstall` | Remove GForge-owned hooks and restore prior Git config. |
| `gforge version` | Print the version. |
| `gforge help` | Print help. |

### Example

```bash
# Check the workstation before installing
gforge verify

# Install the managed global hooks
gforge install

# From now on, commits containing a secret are blocked:
echo 'DB_PASS=gForgeDBa@34$5@!' > config.txt
git add config.txt
git commit -m "add config"
# -> GForge blocks the commit and lists config.txt (never printing the value)

# Remove everything GForge installed
gforge uninstall
```

## How detection works

The `pre-commit` hook scans only the files staged for the current commit (not the
whole repository) and blocks the commit if any appear to contain a secret. It
reports file paths, line numbers, and rule names — **never** the matched value.

Detection runs five layers:

0. **`.env` cross-reference (highest precision)** — GForge reads the actual secret
   values from your repo's (git-ignored) `.env` files and blocks any staged file
   that hardcodes one of them verbatim. This catches the classic "copied the token
   out of `.env` and pasted it into the code" leak with essentially no false
   positives. Values are read only in memory and never printed.
1. **Provider rules** — fixed credential shapes for AWS, GitHub, GitLab, Google,
   Slack, Stripe, Twilio (including bare auth tokens in a Twilio context), SendGrid,
   Mailgun, npm, PyPI, OpenAI, Anthropic, DigitalOcean, Shopify, Telegram, JWTs,
   PEM private keys, and URLs with embedded credentials.
2. **Generic secrets** — any credential keyword (`password`, `pass`, `pwd`,
   `secret`, `token`, `api_key`, `access_key`, `client_secret`, `private_key`,
   `connection_string`, `credentials`, …) assigned to a hardcoded value, e.g.
   `DB_PASS=…` or `password: "MyS3cretDbPass"`. Values that are **references**
   (`password: process.env.DB_PASSWORD`, `config.get(...)`, `${VAR}` interpolation,
   `$VAR`) or obvious placeholders are not flagged — so well-written config keeps
   working.
3. **Entropy** — high-entropy strings with no recognizable name. Tuned to skip git
   SHAs, UUIDs, and lockfiles.
4. **Secret files** — `.env` and `.env.*` (except templates like `.env.example`),
   `id_rsa`, `*.p12`/`*.pfx`, keystores, `.git-credentials`, `.netrc`, and more.

If the [gitleaks](https://github.com/gitleaks/gitleaks) binary is on your `PATH`,
GForge also runs `gitleaks protect --staged` and merges its verdict.

Detection is best-effort and not a substitute for keeping secrets out of Git.

## Managing false positives

Maximum coverage means occasional false positives. Three escape hatches:

- **Inline:** add a `gforge:allow` (or `gitleaks:allow`) comment on the line.
- **Per-repo:** add a path or regex to a `.gforgeignore` file at the repo root
  (a `.gitleaksignore` is also honored). Example:

  ```gitignore
  # .gforgeignore
  test/fixtures/
  ^docs/sample-config\.md$
  ```

- **One-off:** bypass a single commit with `git commit --no-verify`.

## Configuration and file layout

GForge stores its files under the user's home directory and touches only global
Git config:

- `~/.gforge/hooks/pre-commit` — the managed hook (a small shim).
- `~/.gforge/hooks/gforge-scan.mjs` — the self-contained scanner engine.
- `~/.gforge/state.json` — records the prior `core.hooksPath` and the Node path so
  `uninstall` can restore your configuration.

Git lets a repository-local or system `core.hooksPath` override the global one, so
in a repository that sets its own hooks path (for example Husky or lefthook) the
managed hook does not run. `gforge verify` warns when it detects such an override
in the current repository.

## Programmatic use

GForge is primarily a CLI. The command runner is also exposed for scripting:

```js
import { runCli } from "gforge";

const result = await runCli(["verify"], { stdout: process.stdout, stderr: process.stderr });
process.exit(result.exitCode);
```

## Development

```bash
npm test              # run the test suite
npm run package:check # inspect the publishable tarball contents
```

## Contributing

Issues and pull requests are welcome at
[the GitHub repository](https://github.com/psspl-gaurang-joshi/gforge). Please keep
changes focused, run `npm test` before submitting, and preserve the Apache 2.0
license header and `NOTICE`.

## Security

To report a vulnerability, follow the process in [SECURITY.md](SECURITY.md). Do not
open a public issue for security reports, and never include real secrets in a
report.

## License

Licensed under the Apache License, Version 2.0. Preserve the notice in `NOTICE`
when redistributing.
