# GForge Plan

Current goal: build a minimal installer for secure global Git hooks.

## MVP

1. Create a small command entry point. Done.
2. Detect Git, platform, shell, and home directory. Done.
3. Create a GForge-owned hooks directory.
4. Install initial security hooks.
5. Configure global `core.hooksPath`.
6. Add `verify`, `update`, and `uninstall` commands.
7. Add tests for repeated runs and safe uninstall.

## Suggested Commands

Final command names can change during implementation, but the product should support:

```bash
gforge install
gforge verify
gforge update
gforge uninstall
```

## Safety Requirements

- Re-running install must be safe.
- Verify must be read-only.
- Uninstall must remove only GForge-owned files/config.
- Git config changes must be backed up or clearly reversible.
- Hooks must avoid exposing secrets in logs.

## Next Work

1. Initialize Git for this repository.
2. Choose implementation stack.
3. Implement install/verify for global hooks.
4. Add update and uninstall behavior.
5. Add packaged installation instructions.
