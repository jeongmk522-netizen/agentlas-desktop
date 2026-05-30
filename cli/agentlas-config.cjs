"use strict";
/*
 * CLI preferences (separate from the app's SQLite/keychain) — first-run onboarding result.
 * Stored at <userData>/cli-prefs.json: { onboarded, lang, runtime, permission }.
 */
const fs = require("node:fs");
const path = require("node:path");

function prefsPath(userDataDir) {
  return path.join(userDataDir, "cli-prefs.json");
}
function loadPrefs(userDataDir) {
  try {
    return JSON.parse(fs.readFileSync(prefsPath(userDataDir), "utf8")) || {};
  } catch {
    return {};
  }
}
function savePrefs(userDataDir, prefs) {
  try {
    fs.mkdirSync(userDataDir, { recursive: true });
    fs.writeFileSync(prefsPath(userDataDir), JSON.stringify(prefs, null, 2), "utf8");
    return true;
  } catch {
    return false;
  }
}

module.exports = { prefsPath, loadPrefs, savePrefs };
