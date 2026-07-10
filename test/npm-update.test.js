import assert from "node:assert/strict";
import test from "node:test";

import { compareVersions, isNewer, performSelfUpgrade } from "../src/npm-update.js";

test("compareVersions orders semver numerically", () => {
  assert.equal(compareVersions("0.3.0", "0.2.4"), 1);
  assert.equal(compareVersions("0.2.4", "0.3.0"), -1);
  assert.equal(compareVersions("1.0.0", "0.9.9"), 1);
  assert.equal(compareVersions("0.2.10", "0.2.9"), 1); // numeric, not lexical
  assert.equal(compareVersions("0.2.4", "0.2.4"), 0);
});

test("isNewer is true only for strictly greater versions", () => {
  assert.equal(isNewer("0.3.0", "0.2.4"), true);
  assert.equal(isNewer("0.2.4", "0.2.4"), false);
  assert.equal(isNewer("0.2.3", "0.2.4"), false);
});

test("performSelfUpgrade installs the constant gforge@latest, never an interpolated version", async () => {
  const calls = [];
  const result = await performSelfUpgrade("update", "9.9.9", {
    spawnSync: (cmd, args) => {
      calls.push({ cmd, args });
      return { status: 0 };
    },
    // npm root -g returns nothing -> no re-exec, just the install step
    execFile: async () => ({ stdout: "" })
  });

  assert.equal(result.ok, true);
  const install = calls.find((c) => c.args && c.args[0] === "install");
  assert.deepEqual(install.args, ["install", "-g", "gforge@latest"]);
  // The registry-derived version must never appear in any spawned command.
  assert.equal(JSON.stringify(calls).includes("9.9.9"), false);
});

test("performSelfUpgrade refuses a version that is not plain semver (no command injection)", async () => {
  let spawned = false;
  const result = await performSelfUpgrade("update", "1.0.0 && rm -rf /", {
    spawnSync: () => {
      spawned = true;
      return { status: 0 };
    }
  });

  assert.equal(result.ok, false);
  assert.equal(spawned, false);
});
