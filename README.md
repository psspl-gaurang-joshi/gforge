# GForge

GForge is a small installer for secure global Git hooks on developer workstations.

The goal is simple: install, verify, update, and remove a managed global Git hook setup that helps prevent unsafe commits across repositories on a workstation.

Current status: documentation cleanup. Implementation has not started.

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

## License

Licensed under the Apache License, Version 2.0. Preserve the notice in `NOTICE` when redistributing.
