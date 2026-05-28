#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const desktopRoot = resolve(new URL("..", import.meta.url).pathname);
const repoRoot = resolve(desktopRoot, "..");

const desktopPkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
const currentVersion = String(desktopPkg.version || "0.0.0");

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || desktopRoot,
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
    env: process.env,
  });
  return {
    ok: result.status === 0,
    status: result.status,
    output: [result.stdout, result.stderr].filter(Boolean).join("\n").trim(),
  };
}

function hasEnv(name) {
  return Boolean(String(process.env[name] || "").trim());
}

function ghSecrets(repo) {
  const result = run("gh", ["secret", "list", "-R", repo], { cwd: repoRoot });
  if (!result.ok) return { ok: false, names: [], error: result.output };
  return {
    ok: true,
    names: result.output
      .split(/\r?\n/)
      .map((line) => line.trim().split(/\s+/)[0])
      .filter(Boolean),
  };
}

const identities = run("security", ["find-identity", "-v", "-p", "codesigning"]);
const developerIdIdentities = identities.output
  .split(/\r?\n/)
  .filter((line) => /Developer ID Application:/i.test(line));
const ghAuth = run("gh", ["auth", "status", "-h", "github.com"], { cwd: repoRoot });

const env = {
  APPLE_ID: hasEnv("APPLE_ID"),
  APPLE_APP_SPECIFIC_PASSWORD: hasEnv("APPLE_APP_SPECIFIC_PASSWORD"),
  APPLE_TEAM_ID: hasEnv("APPLE_TEAM_ID"),
  CSC_LINK: hasEnv("CSC_LINK"),
  CSC_KEY_PASSWORD: hasEnv("CSC_KEY_PASSWORD"),
  GH_TOKEN: hasEnv("GH_TOKEN") || hasEnv("GITHUB_TOKEN"),
  GH_AUTH_LOGIN: ghAuth.ok,
};

const agentlasSecrets = ghSecrets("jeongmk522-netizen/agentlas-desktop");
const requiredWorkflowSecrets = [
  "APPLE_ID",
  "APPLE_APP_SPECIFIC_PASSWORD",
  "APPLE_TEAM_ID",
  "MAC_DEVELOPER_ID_CERTIFICATE",
  "MAC_DEVELOPER_ID_CERTIFICATE_PASSWORD",
  "AGENTLAS_DESKTOP_RELEASE_TOKEN",
  "RAILWAY_TOKEN",
  "RAILWAY_PROJECT_ID",
];

const releaseVerification = join(desktopRoot, "release", "desktop-release-verification.json");
const verification = existsSync(releaseVerification)
  ? JSON.parse(readFileSync(releaseVerification, "utf8"))
  : null;

const missingWorkflowSecrets = agentlasSecrets.ok
  ? requiredWorkflowSecrets.filter((name) => !agentlasSecrets.names.includes(name))
  : requiredWorkflowSecrets;

const localReady =
  (developerIdIdentities.length > 0 || (env.CSC_LINK && env.CSC_KEY_PASSWORD)) &&
  env.APPLE_ID &&
  env.APPLE_APP_SPECIFIC_PASSWORD &&
  env.APPLE_TEAM_ID &&
  (env.GH_TOKEN || env.GH_AUTH_LOGIN);
const workflowReady = agentlasSecrets.ok && missingWorkflowSecrets.length === 0;

console.log(JSON.stringify({
  local: {
    ready: localReady,
    developerIdApplicationIdentities: developerIdIdentities.map((line) => line.replace(/^\s*\d+\)\s*/, "")),
    env,
    nextCommand: localReady
      ? "AGENTLAS_PUBLIC_RELEASE=1 npm run package:mac && npm run release:mac:publish && npm run release:web-env -- --apply"
      : "Create/import a Developer ID Application certificate, then export APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID.",
  },
  githubActions: {
    ready: workflowReady,
    repo: "jeongmk522-netizen/agentlas-desktop",
    missingSecrets: missingWorkflowSecrets,
    nextCommand: workflowReady
      ? `gh workflow run release.yml -R jeongmk522-netizen/agentlas-desktop -f version=${currentVersion} -f tag=v${currentVersion} -f draft=false -f apply_web_env=true`
      : "Set the missing GitHub Actions secrets, then run the desktop release workflow.",
  },
  currentReleaseVerification: verification
    ? {
        ready: verification.ready,
        failures: verification.failures,
        artifacts: verification.artifacts?.map((artifact) => ({
          arch: artifact.arch,
          sha256: artifact.sha256,
          sizeBytes: artifact.sizeBytes,
          notarized: artifact.notarized,
          gatekeeperAccepted: artifact.gatekeeperAccepted,
        })),
      }
    : null,
}, null, 2));

if (!localReady && !workflowReady) process.exit(1);
