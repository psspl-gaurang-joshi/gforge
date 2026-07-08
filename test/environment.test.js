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
