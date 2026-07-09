# GForge

GForge is a small installer for secure global Git hooks on developer workstations.

The goal is simple: install, verify, update, and remove a managed global Git hook setup that helps prevent unsafe commits across repositories on a workstation.

Current status: managed hook install, verify, update, and uninstall.

## Scope

GForge should:

- Detect Git and supported shell/platform basics.
- Install a managed global Git hooks directory.
- Configure Git to use the managed hooks through `core.hooksPath`.
- Provide security-focused hooks, starting with secret-leak prevention.
- Verify the installed hook path and hook files.
- Update managed hooks safely.
- Uninstall only GForge-owned files and config.

GForge should not:

- Manage CI/CD, cloud infrastructure, IDEs, or application deployment.
- Become a general workstation provisioning platform.
- Include UI, design system, or frontend work.
- Store secrets or weaken Git/security behavior.

## Supported Targets

Initial targets:

- macOS with Bash or Zsh
- Linux with Bash
- Windows through PowerShell or WSL

## Minimal Repository Docs

- `README.md`: project overview
- `PLAN.md`: implementation plan
- `AGENTS.md`: generic AI/automation contributor rules
- `LICENSE`: Apache License 2.0
- `NOTICE`: required project notice

## Development Rule

Keep documentation short. Prefer updating these files over adding new docs unless a new file is truly needed.

## Installation

Prerequisites:

- Node.js 20 or newer
- Git

Install globally from this repository:

```bash
npm install -g git+ssh://git@github.com/psspl-gaurang-joshi/gforge.git
```

Install from a local clone:

```bash
npm install -g .
```

During development, link the local CLI:

```bash
npm link
```

## Development

Run tests with:

```bash
npm test
```

Check package contents with:

```bash
npm run package:check
```

## Usage

Verify the current workstation state:

```bash
gforge verify
```

Install managed global hooks with:

```bash
gforge install
```

This creates `~/.gforge/hooks`, installs GForge-managed hooks, and sets global Git `core.hooksPath`.

Update managed hooks with:

```bash
gforge update
```

Uninstall GForge-owned hooks and restore prior Git hook configuration with:

```bash
gforge uninstall
```

To remove the global npm package after uninstalling hooks:

```bash
npm uninstall -g @psspl-gaurang-joshi/gforge
```

## Managed pre-commit hook

The managed `pre-commit` hook scans only the files staged for the current commit
(not the whole repository) and blocks the commit if any appear to contain a
secret. It reports the file paths only and never prints the matched value.

It flags common credential shapes: private keys, AWS access key IDs, GitHub and
Google API keys, Stripe and npm tokens, plus `AWS_ACCESS_KEY_ID`,
`AWS_SECRET_ACCESS_KEY`, `GITHUB_TOKEN`, and `NPM_TOKEN` assigned to a value. A
bare reference such as `process.env.GITHUB_TOKEN` is not flagged. To commit past a
false positive, use `git commit --no-verify`.

Detection is best-effort and not a substitute for keeping secrets out of Git.

## Scope limitation

GForge configures Git's global `core.hooksPath`. Git lets a repository-local or
system `core.hooksPath` override the global one, so in a repository that sets its
own hooks path (for example Husky or lefthook) the managed hook does not run.
`gforge verify` warns when it detects such an override in the current repository.

## License

Licensed under the Apache License, Version 2.0. Preserve the notice in `NOTICE` when redistributing.
