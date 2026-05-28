<p align="center">
  <img src="assets/agentlas-desktop-banner.svg" alt="Agentlas Desktop banner">
</p>

<h1 align="center">Agentlas Desktop</h1>

<p align="center">
  <strong>The open-source control room for running a local AI company on your Mac.</strong>
</p>

<p align="center">
  <a href="https://agentlas.cloud">agentlas.cloud</a>
  ·
  <a href="https://agentlas.cloud/desktop">Desktop page</a>
  ·
  <a href="https://github.com/jeongmk522-netizen/agentlas-desktop/releases/latest">Releases</a>
</p>

<p align="center">
  <a href="https://github.com/jeongmk522-netizen/agentlas-desktop/releases/latest">
    <img alt="Latest release" src="https://img.shields.io/github/v/release/jeongmk522-netizen/agentlas-desktop?include_prereleases&label=download&color=blue">
  </a>
  <a href="LICENSE">
    <img alt="License: Apache 2.0" src="https://img.shields.io/badge/license-Apache%202.0-green">
  </a>
  <img alt="Platform" src="https://img.shields.io/badge/platform-macOS%2012%2B-lightgrey">
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Claude%20Code%20%7C%20Codex%20%7C%20Gemini%20%7C%20BYOK-black">
</p>

Agentlas Desktop is a launcher for AI agents: a local Mac app where you install expert teams, connect the AI runtime you already pay for, and run serious work without handing your keys or chat history to another hosted agent platform.

It is built for people who want agents to feel less like demos and more like infrastructure: local storage, Keychain secrets, MCP marketplace installs, runtime adapters, signed macOS releases, and an update loop you can audit end to end.

<p align="center">
  <img alt="Agentlas Desktop running a CEO agent for an ecommerce operator" src="docs/screenshot.png" width="960">
</p>

## Why This Exists

Most agent products hide the interesting parts: where prompts live, what tools can run, where memory is stored, which model is being charged, and who holds the credentials.

Agentlas Desktop makes that machinery visible. Install an agent, inspect the workflow, choose Claude Code, Codex, Gemini, or your own API key, then run it from a Mac app that stores secrets in the macOS Keychain and keeps the operating state on your disk.

## What Makes It Different

- **Bring your own runtime.** Use Claude Code, Codex, Gemini CLI, or BYOK cloud APIs. Agentlas does not need to proxy the model call.
- **Local-first by default.** Chats, firms, projects, automations, and runtime state are stored locally with SQLite.
- **Keychain, not a config file.** API keys and auth tokens stay in macOS Keychain through the Electron main process.
- **MCP-native agent installs.** The marketplace can install approved Agentlas bundles from `agentlas.cloud` and run them through local runtime adapters.
- **Real desktop distribution.** Electron Builder produces signed, notarized macOS DMGs for Apple Silicon and Intel.
- **Auditable updates.** GitHub Releases host the update feed, `latest-mac.yml`, blockmaps, checksums, and release evidence.

## Quick Start

Requirements:

- macOS 12 Monterey or newer
- Node.js 20+
- npm
- Xcode Command Line Tools

```bash
git clone https://github.com/jeongmk522-netizen/agentlas-desktop.git
cd agentlas-desktop
npm install
npm run dev
```

`npm run dev` starts the Next.js renderer on `localhost:3100` and launches Electron against it. Renderer changes hot reload. Main-process changes require restarting the dev command.

## Build And Check

```bash
npm run typecheck
npm run build
```

`typecheck` runs TypeScript for both Electron and the renderer. `build` exports the renderer and compiles the Electron main process into `dist/`.

## Release Loop

For public macOS releases you need an Apple Developer ID Application certificate and notarization credentials.

```bash
# Set CSC_LINK, CSC_KEY_PASSWORD, APPLE_ID,
# APPLE_APP_SPECIFIC_PASSWORD, and APPLE_TEAM_ID in your shell.
AGENTLAS_PUBLIC_RELEASE=1 npm run package:mac
npm run release:mac:publish
```

The release script verifies both DMGs with `hdiutil`, `stapler`, and `spctl`, writes `desktop-release-verification.json`, publishes GitHub Release assets, and lets Electron auto-update consume the release feed.

## Architecture

```text
Agentlas Desktop
├─ electron/          privileged main process
│  ├─ runtime/        Claude Code, Codex, Gemini, BYOK adapters
│  ├─ mcp/            MCP client and installer
│  ├─ marketplace/    agentlas.cloud marketplace source
│  ├─ secrets/        macOS Keychain vault
│  ├─ store/          SQLite-backed local state
│  └─ updater.ts      electron-updater integration
├─ renderer/          Next.js App Router UI
├─ shared/            typed IPC contracts
├─ scripts/           release, signing, and verification tooling
└─ docs/              architecture and public release notes
```

The renderer never gets direct filesystem, Keychain, or process-supervision access. It talks to the Electron main process through the typed preload bridge.

## Security Model

- No credentials in Git.
- No API keys written to plaintext local files.
- Renderer code cannot directly read secrets.
- Signing material is ignored by Git and injected only during release.
- Auto-update assets are served from GitHub Releases and validated through the macOS signing and notarization chain.

Security reports: see [SECURITY.md](SECURITY.md).

## Contributing

Pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), run `npm run typecheck`, and keep public safety in mind: no credentials, no local logs, no signing material.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
