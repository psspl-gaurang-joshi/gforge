import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { runCli } from "../src/cli.js";

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

test("prints help by default", async () => {
  const result = await runCli([], createStreams());

  assert.equal(result.exitCode, 0);
});

test("prints version", async () => {
  const streams = createStreams();
  const result = await runCli(["--version"], streams);

  assert.equal(result.exitCode, 0);
  assert.equal(streams.stdout.value, `gforge ${pkg.version}\n`);
});

test("runs managed hooks install", async () => {
  const streams = createStreams();
  const result = await runCli(["install"], streams, {
    installManagedHooks: async () => ({
      ok: true,
      exitCode: 0,
      hooksDirectory: "/Users/example/.gforge/hooks",
      messages: ["Installed managed hooks in /Users/example/.gforge/hooks"]
    })
  });

  assert.equal(result.exitCode, 0);
  assert.match(streams.stdout.value, /GForge install complete/);
  assert.match(streams.stdout.value, /Installed managed hooks/);
});

test("runs managed hooks update", async () => {
  const streams = createStreams();
  const result = await runCli(["update"], streams, {
    updateManagedHooks: async () => ({
      ok: true,
      command: "update",
      exitCode: 0,
      hooksDirectory: "/Users/example/.gforge/hooks",
      messages: ["Updated managed hooks in /Users/example/.gforge/hooks"]
    })
  });

  assert.equal(result.exitCode, 0);
  assert.match(streams.stdout.value, /GForge update complete/);
});

test("runs managed hooks uninstall", async () => {
  const streams = createStreams();
  const result = await runCli(["uninstall"], streams, {
    uninstallManagedHooks: async () => ({
      ok: true,
      command: "uninstall",
      exitCode: 0,
      hooksDirectory: "/Users/example/.gforge/hooks",
      messages: ["Removed GForge-owned hook and state files"]
    })
  });

  assert.equal(result.exitCode, 0);
  assert.match(streams.stdout.value, /GForge uninstall complete/);
});

test("runs read-only verification", async () => {
  const streams = createStreams();
  const result = await runCli(["verify"], streams, {
    detectEnvironment: async () => ({
      platform: { name: "darwin", arch: "arm64", supported: true, isWsl: false },
      home: { path: "/Users/example", present: true },
      shell: { path: "/bin/zsh", name: "zsh", supported: true },
      git: { available: true, version: "2.45.0", rawVersion: "git version 2.45.0" }
    }),
    verifyManagedHooks: async () => ({
      hooksDirectory: "/Users/example/.gforge/hooks",
      checks: [
        {
          status: "PASS",
          label: "hooks-path",
          detail: "core.hooksPath is /Users/example/.gforge/hooks"
        }
      ]
    })
  });

  assert.equal(result.exitCode, 0);
  assert.match(streams.stdout.value, /PASS platform: darwin arm64/);
  assert.match(streams.stdout.value, /PASS git: git version 2\.45\.0/);
  assert.match(streams.stdout.value, /PASS hooks-path:/);
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
    }),
    verifyManagedHooks: async () => ({
      hooksDirectory: "/Users/example/.gforge/hooks",
      checks: []
    })
  });

  assert.equal(result.exitCode, 1);
  assert.match(streams.stdout.value, /FAIL git: git not found/);
});

test("reports a friendly error when a mutating command throws", async () => {
  const streams = createStreams();
  const result = await runCli(["install"], streams, {
    installManagedHooks: async () => {
      throw new Error("EACCES: permission denied, mkdir '/root/.gforge'");
    }
  });

  assert.equal(result.exitCode, 1);
  assert.match(streams.stderr.value, /GForge install failed/);
  assert.match(streams.stderr.value, /permission denied/);
  assert.equal(streams.stdout.value, "");
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
