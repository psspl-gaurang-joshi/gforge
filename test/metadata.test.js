import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { VERSION } from "../src/metadata.js";

test("VERSION is sourced from package.json and cannot drift", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(VERSION, pkg.version);
});
