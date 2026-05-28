# Agentlas Desktop Public macOS Release

Public downloads stay closed until both DMGs are Developer ID signed, Apple notarized, and Gatekeeper accepted.

## 1. Create The Apple Certificate

Required certificate type: **Developer ID Application**.

Current local certificates like `Apple Development`, `Apple Distribution`, or `iPhone Developer` are not enough for public `.dmg` distribution outside the Mac App Store.

1. Create the CSR:

```bash
npm run release:csr -- --email=you@example.com
```

2. Open Apple Developer > Certificates, Identifiers & Profiles > Certificates.
3. Create a new certificate.
4. Choose `Developer ID Application`.
5. Upload `release-signing/agentlas-developer-id.csr`.
6. Download the `.cer` file.
7. Convert it to a `.p12` for electron-builder:

```bash
npm run release:p12 -- --cer=/path/to/developerID_application.cer
```

The `.p12` and private key stay in ignored `release-signing/`.

If you prefer Keychain Access:

1. Keychain Access > Certificate Assistant > Request a Certificate From a Certificate Authority.
2. Save the CSR to disk.
5. Download the `.cer` file and double-click it to import into the login keychain.
6. Confirm the identity exists:

```bash
security find-identity -v -p codesigning | grep "Developer ID Application"
```

## 2. Create Notarization Credentials

Create an app-specific password for the Apple ID used by the developer team, then set these environment variables in your shell:

```bash
APPLE_ID
APPLE_APP_SPECIFIC_PASSWORD
APPLE_TEAM_ID
GH_TOKEN
```

## 3. Local End-To-End Release

```bash
npm run release:readiness
AGENTLAS_PUBLIC_RELEASE=1 npm run package:mac
npm run release:mac:verify
npm run release:mac:publish
npm run release:web-env -- --apply
```

The last command writes the verified release metadata to Railway production so:

- `GET /api/desktop/latest` returns `ready:true`.
- `GET /api/desktop/download?arch=arm64|x64` redirects to GitHub Release DMGs.

## 4. GitHub Actions Release

There are two release workflows, by design:

1. **`.github/workflows/release.yml` (active, default).** Cross-platform matrix
   (macOS + Windows + Linux), **unsigned**, uses only the built-in `GITHUB_TOKEN`.
   This is what populates the public Releases page — no Apple/Windows certificates
   or org secrets required. Trigger it by pushing a tag:

   ```bash
   # bump package.json "version" to match, then:
   git tag v0.0.3 && git push origin v0.0.3
   ```

   Artifacts uploaded to the release: `Agentlas-<v>-arm64.dmg`, `Agentlas-<v>-x64.dmg`,
   `Agentlas-Setup-<v>.exe`, `Agentlas-<v>-portable.exe`, `Agentlas-<v>.AppImage`,
   `Agentlas-<v>.deb`, plus the `latest*.yml` auto-update feeds.

2. **Signed + notarized macOS (optional upgrade).** The template is
   `docs/release.workflow.yml`. Install it as `.github/workflows/release-signed-mac.yml`
   only from an account or token with GitHub `workflow` permission, once the Apple
   certificate secrets below are configured. Until then, the unsigned workflow above
   is the public path and macOS users follow the one-time Gatekeeper step in the README.

Required GitHub secrets for the **signed macOS** workflow on `jeongmk522-netizen/agentlas-desktop`:

- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`
- `MAC_DEVELOPER_ID_CERTIFICATE`
- `MAC_DEVELOPER_ID_CERTIFICATE_PASSWORD`
- `AGENTLAS_DESKTOP_RELEASE_TOKEN`
- `RAILWAY_TOKEN`
- `RAILWAY_PROJECT_ID`

`MAC_DEVELOPER_ID_CERTIFICATE` must be a base64-encoded `.p12` containing the `Developer ID Application` certificate and its private key.

If you used `release:csr` and `release:p12`, set certificate secrets directly:

```bash
npm run release:p12 -- --cer=/path/to/developerID_application.cer --set-github-secrets
```

If you used Keychain Access, create it from a Mac that has the identity:

```bash
P12_PASSWORD="$(openssl rand -base64 24)"
security export \
  -k "$HOME/Library/Keychains/login.keychain-db" \
  -t identities \
  -f pkcs12 \
  -o /tmp/agentlas-developer-id.p12 \
  -P "$P12_PASSWORD" \
  -c "Developer ID Application"
base64 -i /tmp/agentlas-developer-id.p12 | gh secret set MAC_DEVELOPER_ID_CERTIFICATE -R jeongmk522-netizen/agentlas-desktop -b-
printf "%s" "$P12_PASSWORD" | gh secret set MAC_DEVELOPER_ID_CERTIFICATE_PASSWORD -R jeongmk522-netizen/agentlas-desktop -b-
rm -f /tmp/agentlas-developer-id.p12
```

Then set the remaining secrets and run:

```bash
gh workflow run release.yml \
  -R jeongmk522-netizen/agentlas-desktop \
  -f version=0.0.3 \
  -f tag=v0.0.3 \
  -f draft=false \
  -f apply_web_env=true
```

## 5. Verification

After release:

```bash
curl https://agentlas.cloud/api/desktop/latest
curl -I "https://agentlas.cloud/api/desktop/download?arch=arm64"
npm run qa:committee -- --all --web-base=https://agentlas.cloud
```

The 25-persona gate must report `releaseUnanimous: true`.
