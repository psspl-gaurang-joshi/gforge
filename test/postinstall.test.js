import assert from "node:assert/strict";
import test from "node:test";

import { describeExistingHooksPath, shouldRunPostinstall } from "../scripts/postinstall.js";

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

test("issue #41: describeExistingHooksPath respects an existing global value", () => {
  const existing = describeExistingHooksPath("/opt/husky/hooks", null, "/home/u/.gforge/hooks");
  assert.match(existing, /global core\.hooksPath is already set \(\/opt\/husky\/hooks\)/);
});

test("issue #41: describeExistingHooksPath also respects a system-level value with no global set", () => {
  // The actual bug: nothing at global scope, so the old check saw "nothing
  // configured" and proceeded - but writing a global value now would
  // outrank and silently shadow the system-mandated one.
  const existing = describeExistingHooksPath(null, "/etc/gforge-org-hooks", "/home/u/.gforge/hooks");
  assert.match(existing, /system-level core\.hooksPath is already set \(\/etc\/gforge-org-hooks\)/);
});

test("issue #41: a global value takes precedence over a system value in the message (matches git's real precedence)", () => {
  const existing = describeExistingHooksPath("/opt/husky/hooks", "/etc/gforge-org-hooks", "/home/u/.gforge/hooks");
  assert.match(existing, /global core\.hooksPath/);
});

test("issue #41: proceeds when nothing is configured, or GForge's own path is already active at either scope", () => {
  assert.equal(describeExistingHooksPath(null, null, "/home/u/.gforge/hooks"), null);
  assert.equal(describeExistingHooksPath("/home/u/.gforge/hooks", null, "/home/u/.gforge/hooks"), null);
  // GForge's own path already active at system scope too must not block a
  // (re-)install that would just set the same value at global scope.
  assert.equal(describeExistingHooksPath(null, "/home/u/.gforge/hooks", "/home/u/.gforge/hooks"), null);
});
