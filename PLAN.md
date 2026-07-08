# GForge Plan

Current goal: build a minimal installer for secure global Git hooks.

## MVP

1. Create a small command entry point. Done.
2. Detect Git, platform, shell, and home directory. Done.
3. Create a GForge-owned hooks directory. Done.
4. Install initial security hooks. Done.
5. Configure global `core.hooksPath`. Done.
6. Add `verify`, `update`, and `uninstall` commands. Done.
7. Add tests for repeated runs and safe uninstall. Done.

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
3. Add packaged installation instructions.
4. Expand hook coverage after the first safe baseline.
5. Prepare release validation.
