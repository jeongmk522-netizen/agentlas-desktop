#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const desktopRoot = resolve(new URL("..", import.meta.url).pathname);
const args = new Map(
  process.argv.slice(2).map((arg) => {
    const [key, ...rest] = arg.split("=");
    return [key, rest.length ? rest.join("=") : "1"];
  }),
);

const envFile = resolve(desktopRoot, String(args.get("--env-file") || "release/desktop-release.production.env"));
const apply = args.has("--apply");
const service = String(args.get("--service") || "agentlas-web");
const environment = String(args.get("--environment") || "production");

if (!existsSync(envFile)) {
  throw new Error(`Missing release env file: ${envFile}. Run npm run release:mac:verify first.`);
}

const pairs = readFileSync(envFile, "utf8")
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter((line) => line && !line.startsWith("#"))
  .filter((line) => /^AGENTLAS_DESKTOP_[A-Z0-9_]+=/.test(line));

const values = Object.fromEntries(
  pairs.map((line) => {
    const index = line.indexOf("=");
    return [line.slice(0, index), line.slice(index + 1)];
  }),
);

for (const key of [
  "AGENTLAS_DESKTOP_RELEASE_VERIFIED",
  "AGENTLAS_DESKTOP_RELEASE_NOTARIZED",
  "AGENTLAS_DESKTOP_MAC_ARM64_SHA256",
  "AGENTLAS_DESKTOP_MAC_ARM64_SIZE",
  "AGENTLAS_DESKTOP_MAC_X64_SHA256",
  "AGENTLAS_DESKTOP_MAC_X64_SIZE",
]) {
  if (!values[key]) throw new Error(`${envFile} is missing ${key}`);
}
if (values.AGENTLAS_DESKTOP_RELEASE_VERIFIED !== "true" || values.AGENTLAS_DESKTOP_RELEASE_NOTARIZED !== "true") {
  throw new Error("Refusing to apply desktop release env until release is verified and notarized.");
}

const command = [
  "railway",
  "variable",
  "set",
  "--service",
  service,
  "--environment",
  environment,
  ...pairs,
];

if (!apply) {
  console.log(command.map(shellQuote).join(" "));
  console.log("Dry run only. Re-run with --apply after confirming the release is public.");
  process.exit(0);
}

const result = spawnSync(command[0], command.slice(1), {
  cwd: desktopRoot,
  stdio: "inherit",
  env: process.env,
});
if (result.status !== 0) process.exit(result.status || 1);

function shellQuote(value) {
  if (/^[A-Za-z0-9_./:=@,+-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, "'\\''")}'`;
}
