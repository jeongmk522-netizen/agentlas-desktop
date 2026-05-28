<p align="center">
  <img src="assets/agentlas-desktop-banner.svg" alt="Agentlas Desktop banner">
</p>

<h1 align="center">Agentlas Desktop</h1>

<p align="center">
  <strong>The open-source control room for your AI agents — on macOS, Windows, and Linux.</strong>
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
  <img alt="Platforms" src="https://img.shields.io/badge/macOS%20%C2%B7%20Windows%20%C2%B7%20Linux-lightgrey">
  <img alt="Runtime" src="https://img.shields.io/badge/runtime-Claude%20%7C%20Codex%20%7C%20Gemini%20%7C%20BYOK-black">
</p>

Connect the AI models you already pay for, import agents over MCP, and run whole
agent teams from one local window — with the org chart and the repo behind every
run in plain view. Your keys and your chat history stay on your machine, never on
someone else's agent platform.

- **Bring your own models.** Claude, Codex, and Gemini (CLI or API key), or
  OpenAI / Anthropic / Google directly. Agentlas never proxies the model call.
- **Import agents over MCP.** Drop in an agent or a whole team — for example a
  package you built on [agentlas.cloud](https://agentlas.cloud) — and run it.
- **See the team, not a black box.** Every agent team renders as an org chart and
  a file tree, so you can see who does what and which repo each run touches.
- **Run and orchestrate locally.** The app supervises the agent processes and
  routes work between roles, all on your disk.
- **Local-first.** Keys in the OS keychain, chats and installed agents in local
  SQLite. Open source, Apache-2.0 — fork it, audit it, ship a variant.

<p align="center">
  <img alt="Agentlas Desktop running a CEO agent" src="docs/screenshot.png" width="960">
</p>

## Download

Get the latest build from the [**Releases page**](https://github.com/jeongmk522-netizen/agentlas-desktop/releases/latest).

| OS | File | Notes |
|----|------|-------|
| macOS (Apple silicon) | `Agentlas-x.y.z-arm64.dmg` | M1 and newer |
| macOS (Intel) | `Agentlas-x.y.z-x64.dmg` | Intel Macs |
| Windows | `Agentlas-Setup-x.y.z.exe` · `Agentlas-x.y.z-portable.exe` | Windows 10/11 (x64) |
| Linux | `Agentlas-x.y.z.AppImage` · `Agentlas-x.y.z.deb` | x64 |

The app updates itself — a "Restart to update" badge appears when a new build is
ready.

### Opening the app the first time

Agentlas Desktop is open source and the builds aren't paid code-signed on every
platform, so your OS may ask you to confirm the first launch. This is normal for
indie/open-source apps and happens only once.

**macOS** — if you see *"Agentlas can't be opened because Apple cannot check it
for malicious software"*, right-click the app in Applications → **Open** →
**Open**. Or, in Terminal:

```bash
xattr -dr com.apple.quarantine /Applications/Agentlas.app
open /Applications/Agentlas.app
```

**Windows** — if SmartScreen shows *"Windows protected your PC"*, click
**More info** → **Run anyway**. The portable `.exe` runs without installing.

**Linux** — make the AppImage executable and run it:

```bash
chmod +x Agentlas-*.AppImage
./Agentlas-*.AppImage
# no FUSE on your distro? run:
./Agentlas-*.AppImage --appimage-extract-and-run
```

(Or install the `.deb`: `sudo dpkg -i Agentlas-*.deb`.)

## Why this exists

Most agent products hide the interesting parts: where prompts live, what tools
can run, where memory is stored, which model is being charged, and who holds the
credentials.

Agentlas Desktop makes that machinery visible. Install an agent, inspect the
workflow, pick Claude Code / Codex / Gemini or your own API key, then run it from
an app that keeps secrets in the OS keychain and the operating state on your disk.

## What makes it different

- **Bring your own runtime.** Claude Code, Codex, Gemini CLI, or BYOK cloud APIs — no middleman model call.
- **Local-first by default.** Chats, teams, projects, automations, and runtime state live in local SQLite.
- **Keychain, not a config file.** API keys and tokens stay in the OS keychain via the Electron main process.
- **MCP-native installs.** Install approved Agentlas bundles from `agentlas.cloud` and run them through local runtime adapters.
- **Cross-platform desktop builds.** Electron Builder produces macOS `.dmg`, Windows installer + portable `.exe`, and Linux AppImage + `.deb`.
- **Auditable updates.** GitHub Releases host the update feed, checksums, and release evidence.

## Build from source

Requirements: Node.js 20+, npm. (macOS also needs Xcode Command Line Tools for the native modules.)

```bash
git clone https://github.com/jeongmk522-netizen/agentlas-desktop.git
cd agentlas-desktop
npm install
npm run dev        # Next.js renderer on :3100 + Electron
```

```bash
npm run typecheck  # TypeScript for electron main + renderer
npm run build      # export renderer + compile electron into dist/
```

Package an installer (unsigned — fine for local use):

```bash
npm run dist:win            # Windows: NSIS installer + portable .exe
npm run dist:linux          # Linux: AppImage + .deb
npm run dist:mac:unsigned   # macOS: unsigned .dmg (no Apple cert needed)
```

Output lands in `release/`. Signed/notarized release builds and the GitHub
Actions pipeline are documented in [`docs/PUBLIC-RELEASE.md`](docs/PUBLIC-RELEASE.md) —
end users don't need any of that.

## Architecture

```text
Agentlas Desktop
├─ electron/          privileged main process
│  ├─ runtime/        Claude Code, Codex, Gemini, BYOK adapters
│  ├─ mcp/            MCP client and installer
│  ├─ marketplace/    agentlas.cloud marketplace source
│  ├─ secrets/        OS keychain vault
│  ├─ store/          SQLite-backed local state
│  └─ updater.ts      electron-updater integration
├─ renderer/          Next.js App Router UI
├─ shared/            typed IPC contracts
├─ scripts/           release, signing, and verification tooling
└─ docs/              architecture and release notes
```

The renderer never gets direct filesystem, keychain, or process-supervision
access — it talks to the main process through a typed preload bridge.

## Security model

- No credentials in Git.
- No API keys written to plaintext local files.
- Renderer code cannot directly read secrets.
- Signing material is git-ignored and injected only during release.
- Auto-update assets are served from GitHub Releases.

Security reports: see [SECURITY.md](SECURITY.md).

## Contributing

Pull requests are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md), run
`npm run typecheck`, and keep public safety in mind: no credentials, no local
logs, no signing material. Windows/Linux testing and packaging feedback is
especially appreciated.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
