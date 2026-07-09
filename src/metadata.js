import { readFileSync } from "node:fs";

// Single source of truth: read the version from package.json so `gforge version`
// can never drift from the installed package.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

export const VERSION = pkg.version;
