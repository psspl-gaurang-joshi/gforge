import assert from "node:assert/strict";
import test from "node:test";

import { buildPreCommitHook } from "../src/hooks.js";

test("escapes install-time node path before embedding it in the hook shim", () => {
  const hook = buildPreCommitHook('C:\\Program Files\\node$dir\\`bin`\\node "lts".exe');

  assert.match(hook, /"C:\/Program Files\/node\\\$dir\/\\`bin\\`\/node \\"lts\\"\.exe"/);
  assert.match(hook, /"C:\\\\Program Files\\\\node\\\$dir\\\\\\`bin\\`\\\\node \\"lts\\"\.exe"/);
});
