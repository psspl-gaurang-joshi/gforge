import assert from "node:assert/strict";
import test from "node:test";

import { runCli } from "../src/cli.js";

test("prints help by default", async () => {
  const result = await runCli([], createStreams());

  assert.equal(result.exitCode, 0);
});

test("prints version", async () => {
  const streams = createStreams();
  const result = await runCli(["--version"], streams);

  assert.equal(result.exitCode, 0);
  assert.match(streams.stdout.value, /^gforge 0\.1\.0\n$/);
});

test("recognizes planned installer commands as not implemented", async () => {
  for (const command of ["install", "update", "uninstall"]) {
    const streams = createStreams();
    const result = await runCli([command], streams);

    assert.equal(result.exitCode, 2);
    assert.match(streams.stderr.value, new RegExp(`gforge ${command} is not implemented yet`));
  }
});

test("runs read-only verification", async () => {
  const streams = createStreams();
  const result = await runCli(["verify"], streams, {
    detectEnvironment: async () => ({
      platform: { name: "darwin", arch: "arm64", supported: true, isWsl: false },
      home: { path: "/Users/example", present: true },
      shell: { path: "/bin/zsh", name: "zsh", supported: true },
      git: { available: true, version: "2.45.0", rawVersion: "git version 2.45.0" }
    })
  });

  assert.equal(result.exitCode, 0);
  assert.match(streams.stdout.value, /PASS platform: darwin arm64/);
  assert.match(streams.stdout.value, /PASS git: git version 2\.45\.0/);
  assert.equal(streams.stderr.value, "");
});

test("fails verification when git is unavailable", async () => {
  const streams = createStreams();
  const result = await runCli(["verify"], streams, {
    detectEnvironment: async () => ({
      platform: { name: "darwin", arch: "arm64", supported: true, isWsl: false },
      home: { path: "/Users/example", present: true },
      shell: { path: "/bin/zsh", name: "zsh", supported: true },
      git: { available: false, version: null, rawVersion: null, errorCode: "ENOENT" }
    })
  });

  assert.equal(result.exitCode, 1);
  assert.match(streams.stdout.value, /FAIL git: git not found/);
});

test("rejects unknown commands", async () => {
  const streams = createStreams();
  const result = await runCli(["wat"], streams);

  assert.equal(result.exitCode, 1);
  assert.match(streams.stderr.value, /Unknown command: wat/);
});

function createStreams() {
  return {
    stdout: createWritable(),
    stderr: createWritable()
  };
}

function createWritable() {
  return {
    value: "",
    write(chunk) {
      this.value += chunk;
    }
  };
}
