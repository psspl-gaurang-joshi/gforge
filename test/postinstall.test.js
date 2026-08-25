import assert from "node:assert/strict";
import test from "node:test";

import { shouldRunPostinstall } from "../scripts/postinstall.js";

test("issue #38: a plain local install (no -g) never touches global git config", () => {
  // This is the exact bug: gforge as a local project dependency, or pulled in
  // transitively by some unrelated package, must not run the global install.
  assert.equal(shouldRunPostinstall({}), false);
  assert.equal(shouldRunPostinstall({ npm_config_global: "false" }), false);
  assert.equal(shouldRunPostinstall({ npm_config_global: undefined }), false);
});

test("runs on an actual global install with no other skip conditions", () => {
  assert.equal(shouldRunPostinstall({ npm_config_global: "true" }), true);
});

test("still skips a global install in CI", () => {
  assert.equal(shouldRunPostinstall({ npm_config_global: "true", CI: "true" }), false);
});

test("still honors the explicit GFORGE_SKIP_POSTINSTALL escape hatch on a global install", () => {
  assert.equal(shouldRunPostinstall({ npm_config_global: "true", GFORGE_SKIP_POSTINSTALL: "1" }), false);
});

test("only the literal npm-set string \"true\" counts as global (fails closed)", () => {
  // Anything else - a stray truthy-looking value, wrong casing, etc. - must
  // not be treated as a global install.
  assert.equal(shouldRunPostinstall({ npm_config_global: "1" }), false);
  assert.equal(shouldRunPostinstall({ npm_config_global: "TRUE" }), false);
});
