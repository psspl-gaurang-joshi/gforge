# GForge

[![npm version](https://img.shields.io/npm/v/@psspl-gaurang-joshi/gforge.svg)](https://www.npmjs.com/package/@psspl-gaurang-joshi/gforge)
[![node](https://img.shields.io/node/v/@psspl-gaurang-joshi/gforge.svg)](https://nodejs.org)
[![license](https://img.shields.io/npm/l/@psspl-gaurang-joshi/gforge.svg)](LICENSE)

Secure global Git hooks installer for developer workstations. GForge installs a
managed global `pre-commit` hook that blocks commits containing secrets, across
every repository on the machine, on macOS, Linux, and Windows.

Install once, and every `git commit` on the workstation is checked before it can
leak an API key, token, or private key.

## Features

- **One command, all repositories.** Configures Git's global `core.hooksPath`, so
  the hook applies to every repo without per-project setup.
- **Secret-aware pre-commit hook.** Scans only the files staged for the current
  commit and blocks it when a likely secret is found. Reports file paths only,
  never the matched value.
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
npm install -g @psspl-gaurang-joshi/gforge
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

# From now on, commits with a leaked secret are blocked:
echo 'AWS_SECRET=AKIAIOSFODNN7EXAMPLE' > config.txt
git add config.txt
git commit -m "add config"
# -> GForge blocks the commit and lists config.txt

# Remove everything GForge installed
gforge uninstall
```

## How the managed pre-commit hook works

The `pre-commit` hook scans only the files staged for the current commit (not the
whole repository) and blocks the commit if any appear to contain a secret. It
reports file paths only and never prints the matched value.

It flags common credential shapes — private keys, AWS access key IDs, GitHub and
Google API keys, Stripe and npm tokens — plus `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, and `NPM_TOKEN` assigned to a value. A
bare reference such as `process.env.GITHUB_TOKEN` is not flagged. To commit past a
false positive, use `git commit --no-verify`.

Detection is best-effort and not a substitute for keeping secrets out of Git.

## Configuration and file layout

GForge stores its files under the user's home directory and touches only global
Git config:

- `~/.gforge/hooks/` — managed hook scripts (`core.hooksPath` points here).
- `~/.gforge/state.json` — records the prior `core.hooksPath` so `uninstall` can
  restore it.

Git lets a repository-local or system `core.hooksPath` override the global one, so
in a repository that sets its own hooks path (for example Husky or lefthook) the
managed hook does not run. `gforge verify` warns when it detects such an override
in the current repository.

## Programmatic use

GForge is primarily a CLI. The command runner is also exposed for scripting:

```js
import { runCli } from "@psspl-gaurang-joshi/gforge";

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
