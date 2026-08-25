# AGENTS.md

Generic contributor rules for any AI or automation agent working on GForge.

## Read First

1. `README.md`
2. `PLAN.md`
3. `AGENTS.md`

## Project Scope

GForge is a secure global Git hooks installer for developer workstations.

Do not expand it into:

- Full workstation provisioning
- CI/CD tooling
- Cloud or Kubernetes automation
- Frontend, UI, design system, or branding work
- Generated documentation or agent-skill systems

## Working Rules

- Commit as the repository owner's configured git user only. Never add an AI
  tool (e.g. Claude) as a co-author or include a `Co-Authored-By` trailer.
- Keep docs and code token-friendly.
- Prefer updating the existing root docs over adding new docs.
- Do not invent commands, APIs, or scope.
- Make install operations idempotent.
- Make verify operations read-only.
- Make uninstall remove only GForge-owned files and config.
- Never store or print secrets.
- Preserve the Apache 2.0 license and `NOTICE`.

## Validation

Run configured formatting, linting, type checks, tests, and builds when they exist.

For documentation-only work, check headings, stale references, empty files, and wording clarity.
