#!/usr/bin/env node

import { runCli } from "../src/cli.js";

const result = await runCli(process.argv.slice(2), {
  stdout: process.stdout,
  stderr: process.stderr
});

process.exitCode = result.exitCode;
