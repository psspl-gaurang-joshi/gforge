import assert from "node:assert/strict";
import test from "node:test";

import { getRepoGitDir, getSystemHooksPath } from "../src/git-config.js";

test("getSystemHooksPath returns the configured value", async () => {
  const execFile = async (cmd, args) => {
    assert.equal(cmd, "git");
    assert.deepEqual(args, ["config", "--system", "--get", "core.hooksPath"]);
    return { stdout: "/etc/gforge-org-hooks\n" };
  };

  assert.equal(await getSystemHooksPath(execFile), "/etc/gforge-org-hooks");
});

test("getSystemHooksPath returns null when nothing is set at system scope", async () => {
  const execFile = async () => {
    const error = new Error("key not found");
    error.code = 1;
    throw error;
  };

  assert.equal(await getSystemHooksPath(execFile), null);
});

test("getSystemHooksPath returns null when there is no system gitconfig file at all", async () => {
  // Verified directly against a real git binary: --get exits 1 in this case
  // too (unlike --list, which fails differently) — same code path as "key
  // not set", not a special case.
  const execFile = async () => {
    const error = new Error("unable to read config file '/etc/gitconfig': No such file or directory");
    error.code = 1;
    throw error;
  };

  assert.equal(await getSystemHooksPath(execFile), null);
});

test("getSystemHooksPath rethrows a genuinely unexpected error", async () => {
  const execFile = async () => {
    const error = new Error("git not found");
    error.code = "ENOENT";
    throw error;
  };

  await assert.rejects(() => getSystemHooksPath(execFile), { code: "ENOENT" });
});

test("getRepoGitDir returns the resolved directory inside a repository", async () => {
  const execFile = async (cmd, args) => {
    assert.equal(cmd, "git");
    assert.deepEqual(args, ["rev-parse", "--git-dir"]);
    return { stdout: ".git\n" };
  };

  assert.equal(await getRepoGitDir(execFile), ".git");
});

test("getRepoGitDir returns null (never throws) outside a git repository", async () => {
  const execFile = async () => {
    const error = new Error("fatal: not a git repository (or any of the parent directories): .git");
    error.code = 128;
    throw error;
  };

  assert.equal(await getRepoGitDir(execFile), null);
});

test("getRepoGitDir returns null for any other failure too (best-effort, never fatal)", async () => {
  const execFile = async () => {
    throw new Error("git not found");
  };

  assert.equal(await getRepoGitDir(execFile), null);
});
