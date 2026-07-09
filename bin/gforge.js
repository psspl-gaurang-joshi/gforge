#!/usr/bin/env node

import { runCli } from "../src/cli.js";

try {
  const result = await runCli(process.argv.slice(2), {
    stdout: process.stdout,
    stderr: process.stderr
  });

  process.exitCode = result.exitCode;
} catch (error) {
  const detail = error?.message ?? String(error);
  process.stderr.write(`GForge encountered an unexpected error: ${detail}\n`);
  process.exitCode = 1;
}
