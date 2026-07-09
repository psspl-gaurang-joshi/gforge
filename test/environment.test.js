import assert from "node:assert/strict";
import test from "node:test";

import { detectEnvironment } from "../src/environment.js";

test("detects supported Unix environment and Git", async () => {
  const environment = await detectEnvironment({
    env: { SHELL: "/bin/zsh" },
    platform: "darwin",
    arch: "arm64",
    homeDirectory: "/Users/example",
    execFile: async () => ({ stdout: "git version 2.45.0\n" })
  });

  assert.deepEqual(environment.platform, {
    name: "darwin",
    arch: "arm64",
    supported: true,
    isWsl: false
  });
  assert.deepEqual(environment.home, {
    path: "/Users/example",
    present: true
  });
  assert.deepEqual(environment.shell, {
    path: "/bin/zsh",
    name: "zsh",
    supported: true
  });
  assert.equal(environment.git.available, true);
  assert.equal(environment.git.version, "2.45.0");
});

test("does not mislabel every Windows process as PowerShell", async () => {
  const environment = await detectEnvironment({
    env: { PSModulePath: "C:/Modules", ComSpec: "C:/Windows/System32/cmd.exe" },
    platform: "win32",
    arch: "x64",
    homeDirectory: "C:/Users/example",
    execFile: async () => ({ stdout: "git version 2.45.0\n" })
  });

  assert.equal(environment.shell.name, "cmd.exe");
});

test("detects a pwsh session on Windows via its distribution channel marker", async () => {
  const environment = await detectEnvironment({
    env: {
      PSModulePath: "C:/Modules",
      POWERSHELL_DISTRIBUTION_CHANNEL: "MSI:Windows 10",
      ComSpec: "C:/Windows/System32/cmd.exe"
    },
    platform: "win32",
    arch: "x64",
    homeDirectory: "C:/Users/example",
    execFile: async () => ({ stdout: "git version 2.45.0\n" })
  });

  assert.equal(environment.shell.name, "pwsh");
  assert.equal(environment.shell.supported, true);
});

test("reports missing Git without throwing", async () => {
  const environment = await detectEnvironment({
    env: { SHELL: "/bin/bash" },
    platform: "linux",
    arch: "x64",
    homeDirectory: "/home/example",
    execFile: async () => {
      const error = new Error("not found");
      error.code = "ENOENT";
      throw error;
    }
  });

  assert.equal(environment.git.available, false);
  assert.equal(environment.git.errorCode, "ENOENT");
});
