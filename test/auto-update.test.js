import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  QUARANTINE_MS,
  classifyVersionBump,
  describeMajorNotice,
  parseVersion,
  resolveAutoUpdateSettings,
  selectAutoUpdateTarget,
  settingsPath,
  versionAgeMs
} from "../src/scanner.js";
import {
  formatAutoUpdateSettings,
  mergeAutoUpdateSettings,
  runSettingsCommand,
  writeAutoUpdateSettings
} from "../src/settings.js";

const NOW = Date.parse("2026-09-02T00:00:00Z");
const daysAgo = (n) => new Date(NOW - n * 86400000).toISOString();
const hoursAgo = (n) => new Date(NOW - n * 3600000).toISOString();
const ALL_ON = { minor: true, major: true };
const ALL_OFF = { minor: false, major: false };

const pick = (overrides) =>
  selectAutoUpdateTarget({ now: NOW, settings: ALL_ON, versions: [], distTags: {}, time: {}, ...overrides });

test("issue #29: quarantine windows are 48h / 7d / 30d", () => {
  assert.equal(QUARANTINE_MS.patch, 48 * 60 * 60 * 1000);
  assert.equal(QUARANTINE_MS.minor, 7 * 24 * 60 * 60 * 1000);
  assert.equal(QUARANTINE_MS.major, 30 * 24 * 60 * 60 * 1000);
});

test("issue #29: classifies a bump by the literal semver field that moved", () => {
  assert.equal(classifyVersionBump("1.5.2", "1.5.3"), "patch");
  assert.equal(classifyVersionBump("1.5.2", "1.6.0"), "minor");
  assert.equal(classifyVersionBump("1.5.2", "2.0.0"), "major");
  // Pre-1.0 the semantically breaking 0.3.x -> 0.4.0 reads as a minor. That is
  // deliberate and documented; it resolves itself at 1.0.
  assert.equal(classifyVersionBump("0.3.7", "0.3.8"), "patch");
  assert.equal(classifyVersionBump("0.3.7", "0.4.0"), "minor");
  // Not an upgrade, or not a plain release.
  assert.equal(classifyVersionBump("1.5.2", "1.5.2"), null);
  assert.equal(classifyVersionBump("1.5.2", "1.5.1"), null);
  assert.equal(classifyVersionBump("1.5.2", "1.6.0-beta.1"), null);
  assert.equal(classifyVersionBump("1.5.2", "garbage"), null);
});

test("issue #29: a patch waits 48h, and nothing installs before its window elapses", () => {
  const versions = ["1.5.2", "1.5.3"];
  assert.equal(pick({ current: "1.5.2", versions, time: { "1.5.3": hoursAgo(1) } }), null);
  assert.equal(pick({ current: "1.5.2", versions, time: { "1.5.3": hoursAgo(47) } }), null);
  assert.deepEqual(pick({ current: "1.5.2", versions, time: { "1.5.3": hoursAgo(49) } }), {
    version: "1.5.3",
    tier: "patch"
  });
});

test("issue #29: a brand new patch does not stall an older one that has matured", () => {
  // Otherwise a rapid release cadence could keep a machine permanently pinned:
  // every candidate would always be inside its own window.
  const target = pick({
    current: "1.5.1",
    versions: ["1.5.1", "1.5.2", "1.5.3"],
    time: { "1.5.2": daysAgo(10), "1.5.3": hoursAgo(1) }
  });
  assert.deepEqual(target, { version: "1.5.2", tier: "patch" });
});

test("issue #29: minor waits 7 days and honours the user's setting", () => {
  const versions = ["1.5.2", "1.6.0"];
  assert.equal(pick({ current: "1.5.2", versions, time: { "1.6.0": daysAgo(3) } }), null);
  assert.deepEqual(pick({ current: "1.5.2", versions, time: { "1.6.0": daysAgo(10) } }), {
    version: "1.6.0",
    tier: "minor"
  });
  assert.equal(
    pick({ current: "1.5.2", versions, time: { "1.6.0": daysAgo(10) }, settings: ALL_OFF }),
    null
  );
});

test("issue #29: patch installs even when the user disabled auto-update", () => {
  // The one tier that is not disableable - this is where security and critical
  // fixes to GForge itself ship.
  assert.deepEqual(
    pick({ current: "1.5.2", versions: ["1.5.2", "1.5.3"], time: { "1.5.3": daysAgo(3) }, settings: ALL_OFF }),
    { version: "1.5.3", tier: "patch" }
  );
});

test("issue #29: a major only auto-installs when tagged LTS, after 30 days", () => {
  const versions = ["1.5.2", "2.0.0"];

  // No lts tag: never, however old it is. Fail-safe, but it does mean
  // publishing the tag is a release-process obligation.
  assert.equal(pick({ current: "1.5.2", versions, time: { "2.0.0": daysAgo(60) } }), null);

  // Tagged, but still inside the window.
  assert.equal(
    pick({ current: "1.5.2", versions, distTags: { lts: "2.0.0" }, time: { "2.0.0": daysAgo(10) } }),
    null
  );

  // Tagged and matured.
  assert.deepEqual(
    pick({ current: "1.5.2", versions, distTags: { lts: "2.0.0" }, time: { "2.0.0": daysAgo(60) } }),
    { version: "2.0.0", tier: "major" }
  );

  // Disabled by the user.
  assert.equal(
    pick({
      current: "1.5.2",
      versions,
      distTags: { lts: "2.0.0" },
      time: { "2.0.0": daysAgo(60) },
      settings: ALL_OFF
    }),
    null
  );
});

test("issue #29: an eligible LTS major supersedes an eligible patch", () => {
  assert.deepEqual(
    pick({
      current: "1.5.2",
      versions: ["1.5.2", "1.5.3", "2.0.0"],
      distTags: { lts: "2.0.0" },
      time: { "1.5.3": daysAgo(3), "2.0.0": daysAgo(60) }
    }),
    { version: "2.0.0", tier: "major" }
  );
});

test("issue #29: a version with no publish time is never eligible", () => {
  // Quarantine cannot be evaluated without a timestamp, so it fails closed
  // rather than installing something of unknown age.
  assert.equal(pick({ current: "1.5.2", versions: ["1.5.2", "1.5.3"], time: {} }), null);
  assert.equal(versionAgeMs(undefined, NOW), null);
  assert.equal(versionAgeMs("not-a-date", NOW), null);
});

test("issue #29: a clock set behind the registry cannot produce a negative age", () => {
  // Clamped at zero, so skew can only ever make a version look younger (and
  // therefore wait longer) - never old enough to skip its window.
  assert.equal(versionAgeMs(new Date(NOW + 86400000).toISOString(), NOW), 0);
  assert.equal(versionAgeMs(new Date(NOW - 3600000).toISOString(), NOW), 3600000);
});

test("issue #29: GFORGE_AUTO_UPDATE no longer fails open on an unrecognised value", () => {
  // The bug: only 0/false/off/no disabled it, so `disabled`, `never` and `2`
  // all silently kept auto-installing. Anything not clearly affirmative is now
  // treated as off.
  for (const value of ["1", "true", "on", "yes", "YES", "On"]) {
    const resolved = resolveAutoUpdateSettings({ env: { GFORGE_AUTO_UPDATE: value } });
    assert.equal(resolved.minor, true, value);
    assert.equal(resolved.major, true, value);
  }
  for (const value of ["0", "false", "off", "no", "disabled", "never", "2", "garbage"]) {
    const resolved = resolveAutoUpdateSettings({ env: { GFORGE_AUTO_UPDATE: value } });
    assert.equal(resolved.minor, false, value);
    assert.equal(resolved.major, false, value);
  }
});

test("issue #29: settings default to on, and a corrupt file falls back to the default", () => {
  assert.deepEqual(resolveAutoUpdateSettings({}), { minor: true, major: true, source: "default" });
  assert.deepEqual(resolveAutoUpdateSettings({ fileContent: "{not json" }), {
    minor: true,
    major: true,
    source: "default"
  });

  const off = resolveAutoUpdateSettings({ fileContent: JSON.stringify({ autoUpdate: { minor: false, major: false } }) });
  assert.equal(off.minor, false);
  assert.equal(off.major, false);
  assert.equal(off.source, "settings");

  // An env var beats the stored setting, in both directions.
  const envOn = resolveAutoUpdateSettings({
    fileContent: JSON.stringify({ autoUpdate: { minor: false, major: false } }),
    env: { GFORGE_AUTO_UPDATE: "1" }
  });
  assert.equal(envOn.minor, true);
  assert.equal(envOn.source, "env");
});

test("issue #29: a new major always produces a notice, highlighted only when LTS", () => {
  const versions = ["1.5.2", "2.0.0"];

  const lts = describeMajorNotice({ current: "1.5.2", versions, distTags: { lts: "2.0.0" }, settings: ALL_ON });
  assert.equal(lts.highlight, true);
  assert.match(lts.text, /LTS major/);
  // The distinction must survive NO_COLOR / CI / pipes, so it is carried in the
  // wording too, not by colour alone.
  assert.match(lts.text, /^!!/);

  const ltsOff = describeMajorNotice({ current: "1.5.2", versions, distTags: { lts: "2.0.0" }, settings: ALL_OFF });
  assert.equal(ltsOff.highlight, true);
  assert.match(ltsOff.text, /Auto-update is off for majors/);

  const plain = describeMajorNotice({ current: "1.5.2", versions, distTags: {}, settings: ALL_ON });
  assert.equal(plain.highlight, false);
  assert.match(plain.text, /not marked LTS/);
  assert.equal(/^!!/.test(plain.text), false);

  // Nothing to say when there is no newer major.
  assert.equal(describeMajorNotice({ current: "2.0.0", versions, distTags: {}, settings: ALL_ON }), null);
});

test("issue #29: parseVersion accepts only plain releases", () => {
  assert.deepEqual(parseVersion("1.5.2"), [1, 5, 2]);
  assert.deepEqual(parseVersion(" 0.3.7 "), [0, 3, 7]);
  for (const bad of ["1.5", "1.5.2-beta.1", "v1.5.2", "1.5.2+build", "", null, undefined, "latest"]) {
    assert.equal(parseVersion(bad), null, String(bad));
  }
});

test("issue #29: settings live outside state.json so an update cannot wipe them", () => {
  // installManagedHooks rewrites state.json on every update; a preference
  // stored there would be destroyed by the very auto-update it governs.
  const path = settingsPath("/home/example");
  assert.match(path, /\.gforge[/\\]settings\.json$/);
  assert.equal(path.includes("state.json"), false);
});

test("issue #29: writing a setting preserves unrelated keys already on disk", () => {
  const existing = JSON.stringify({ somethingElse: 42, autoUpdate: { minor: false } });
  const merged = mergeAutoUpdateSettings(existing, { major: false });

  assert.equal(merged.somethingElse, 42);
  assert.deepEqual(merged.autoUpdate, { minor: false, major: false });
  // A corrupt file is replaced rather than throwing.
  assert.deepEqual(mergeAutoUpdateSettings("{not json", { minor: false }), { autoUpdate: { minor: false } });
});

test("issue #29: gforge settings --no-autoupdate persists and reports the state", async () => {
  const home = await mkdtemp(join(tmpdir(), "gforge-settings-"));
  const streams = createStreams();

  const result = await runSettingsCommand(["settings", "--no-autoupdate"], streams, { home, env: {} });

  assert.equal(result.exitCode, 0);
  assert.match(streams.out(), /auto-update disabled for minor and major/);
  // The report must say plainly that patch is unaffected, or people will assume
  // the flag covered everything.
  assert.match(streams.out(), /Patch updates still install automatically/);
  assert.match(streams.out(), /auto-update \(minor\)\s+off/);
  assert.match(streams.out(), /auto-update \(patch\)\s+on\s+always/);

  const onDisk = JSON.parse(await readFile(settingsPath(home), "utf8"));
  assert.deepEqual(onDisk.autoUpdate, { minor: false, major: false });
});

test("issue #29: gforge settings warns when the env var overrides the stored value", async () => {
  const home = await mkdtemp(join(tmpdir(), "gforge-settings-"));
  await writeAutoUpdateSettings({ minor: true, major: true }, home);

  const streams = createStreams();
  const result = await runSettingsCommand(["settings"], streams, { home, env: { GFORGE_AUTO_UPDATE: "0" } });

  assert.equal(result.exitCode, 0);
  // Without this the user re-enables auto-update, sees no effect, and has no
  // way to tell why.
  assert.match(streams.out(), /GFORGE_AUTO_UPDATE is set in the environment/);
  assert.match(streams.out(), /source: env/);
});

test("issue #29: contradictory or unknown settings flags fail rather than guessing", async () => {
  const home = await mkdtemp(join(tmpdir(), "gforge-settings-"));

  const both = createStreams();
  assert.equal((await runSettingsCommand(["settings", "--autoupdate", "--no-autoupdate"], both, { home })).exitCode, 1);
  assert.match(both.err(), /cannot be combined/);

  const bogus = createStreams();
  assert.equal((await runSettingsCommand(["settings", "--bogus"], bogus, { home })).exitCode, 1);
  assert.match(bogus.err(), /unknown option/);
});

test("issue #29: the settings report names the tier rules so they are discoverable", () => {
  const output = formatAutoUpdateSettings({ minor: true, major: true, source: "default" }, "/h/.gforge/settings.json");
  assert.match(output, /7-day quarantine/);
  assert.match(output, /30-day quarantine, and only when tagged LTS/);
  assert.match(output, /security and critical fixes ship here/);
});

function createStreams() {
  let out = "";
  let err = "";
  return {
    stdout: { write: (s) => { out += s; } },
    stderr: { write: (s) => { err += s; } },
    out: () => out,
    err: () => err
  };
}
