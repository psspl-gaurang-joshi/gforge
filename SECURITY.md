# Security Policy

## Supported Versions

GForge is in early development and has no released versions yet.

| Version | Supported          |
| ------- | ------------------ |
| Unreleased `master` | Yes |

## Reporting a Vulnerability

Report security issues privately by emailing:

```text
Gaurang Joshi <gaurangnil@gmail.com>
```

Do not open a public issue for vulnerabilities.

Include:

- A clear description of the issue.
- Steps to reproduce when safe.
- Affected files, commands, or hook behavior.
- Any known impact.

Do not include real secrets, tokens, passwords, private keys, or customer data in the report.

## Security Scope

GForge manages global Git hook configuration. Security-sensitive areas include:

- Hook installation and update behavior.
- Global Git configuration changes.
- Secret detection logic.
- Logging output.
- Uninstall behavior.

## Response Expectations

The maintainer will review valid reports, ask for clarification if needed, and prioritize fixes based on risk and project maturity.
