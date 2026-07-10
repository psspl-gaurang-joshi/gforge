import assert from "node:assert/strict";
import test from "node:test";

import { compareVersions, isNewer } from "../src/npm-update.js";

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
