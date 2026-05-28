#!/usr/bin/env bash
set -euo pipefail

project_dir="$(pwd)"
local_release="${TMPDIR:-/tmp}/agentlas-desktop-release-$$"
cleaner_pid=""
dmg_signing_keychain=""
dmg_signing_identity=""
original_keychains=()
stable_repo="${AGENTLAS_DESKTOP_GITHUB_REPO:-jeongmk522-netizen/agentlas-desktop}"

cleanup_appledouble() {
  for target in "$@"; do
    if [[ -e "$target" ]]; then
      find "$target" -name '._*' -delete 2>/dev/null || true
      /usr/bin/dot_clean -m "$target" 2>/dev/null || true
    fi
  done
}

cleanup() {
  if [[ -n "$cleaner_pid" ]]; then
    kill "$cleaner_pid" 2>/dev/null || true
    wait "$cleaner_pid" 2>/dev/null || true
  fi
  if [[ -n "${dmg_signing_keychain:-}" ]]; then
    security delete-keychain "$dmg_signing_keychain" >/dev/null 2>&1 || true
  fi
  if (( ${#original_keychains[@]} > 0 )); then
    security list-keychains -d user -s "${original_keychains[@]}" >/dev/null 2>&1 || true
  fi
  rm -rf "$local_release"
}
trap cleanup EXIT

read_keychains() {
  security list-keychains -d user | sed -E 's/^ *"?([^"]+)"?$/\1/'
}

prepare_dmg_signing_identity() {
  if [[ -n "${AGENTLAS_DMG_SIGN_IDENTITY:-}" ]]; then
    dmg_signing_identity="$AGENTLAS_DMG_SIGN_IDENTITY"
    return 0
  fi

  dmg_signing_identity="$(security find-identity -v -p codesigning | awk '/Developer ID Application/ {print $2; exit}')"
  if [[ -n "$dmg_signing_identity" ]]; then
    return 0
  fi

  if [[ -z "${CSC_LINK:-}" || -z "${CSC_KEY_PASSWORD:-}" ]]; then
    echo "Missing Developer ID Application identity. Set CSC_LINK/CSC_KEY_PASSWORD or AGENTLAS_DMG_SIGN_IDENTITY." >&2
    return 1
  fi

  dmg_signing_keychain="${TMPDIR:-/tmp}/agentlas-dmg-sign-$$.keychain-db"
  local keychain_password
  keychain_password="$(openssl rand -hex 24)"

  security create-keychain -p "$keychain_password" "$dmg_signing_keychain"
  security unlock-keychain -p "$keychain_password" "$dmg_signing_keychain"
  security set-keychain-settings -lut 21600 "$dmg_signing_keychain"
  security import "$CSC_LINK" -k "$dmg_signing_keychain" -A -P "$CSC_KEY_PASSWORD" >/dev/null
  security set-key-partition-list -S apple-tool:,apple:,codesign: -s -k "$keychain_password" "$dmg_signing_keychain" >/dev/null

  original_keychains=()
  while IFS= read -r keychain; do
    original_keychains+=("$keychain")
  done < <(read_keychains)
  security list-keychains -d user -s "$dmg_signing_keychain" "${original_keychains[@]}"

  dmg_signing_identity="$(security find-identity -p codesigning "$dmg_signing_keychain" | awk '/Developer ID Application/ {print $2; exit}')"
  if [[ -z "$dmg_signing_identity" ]]; then
    echo "Could not find Developer ID Application identity in CSC_LINK." >&2
    return 1
  fi
}

sign_dmg() {
  local dmg_path="$1"
  codesign --force --timestamp --sign "$dmg_signing_identity" "$dmg_path"
  codesign --verify --verbose=4 "$dmg_path"
}

notarize_dmg() {
  local dmg_path="$1"
  local profile="${AGENTLAS_NOTARY_PROFILE:-agentlas-notary}"

  if xcrun notarytool history --keychain-profile "$profile" >/dev/null 2>&1; then
    xcrun notarytool submit "$dmg_path" --keychain-profile "$profile" --wait
  elif [[ -n "${APPLE_ID:-}" && -n "${APPLE_APP_SPECIFIC_PASSWORD:-}" && -n "${APPLE_TEAM_ID:-}" ]]; then
    xcrun notarytool submit "$dmg_path" \
      --apple-id "$APPLE_ID" \
      --password "$APPLE_APP_SPECIFIC_PASSWORD" \
      --team-id "$APPLE_TEAM_ID" \
      --wait
  else
    echo "Missing notarization credentials for $dmg_path." >&2
    echo "Set AGENTLAS_NOTARY_PROFILE or APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID." >&2
    return 1
  fi

  xcrun stapler staple "$dmg_path"
  xcrun stapler validate "$dmg_path"
}

cleanup_appledouble "$project_dir/dist" "$project_dir/release"
npm run build
rm -rf "$project_dir/release" "$local_release"
mkdir -p "$local_release"
cleanup_appledouble "$project_dir/dist"

while true; do
  cleanup_appledouble "$project_dir/dist" "$project_dir/release" "$local_release"
  sleep 0.05
done &
cleaner_pid=$!

COPYFILE_DISABLE=1 electron-builder \
  --mac --arm64 --x64 \
  --config electron-builder.mac-stable.yml \
  --config.directories.output="$local_release"

rm -rf "$project_dir/release"
mkdir -p "$project_dir/release"
COPYFILE_DISABLE=1 ditto "$local_release" "$project_dir/release"
cleanup_appledouble "$project_dir/release"

if [[ "${AGENTLAS_PUBLIC_RELEASE:-0}" == "1" ]]; then
  prepare_dmg_signing_identity
  while IFS= read -r dmg_path; do
    sign_dmg "$dmg_path"
    notarize_dmg "$dmg_path"
  done < <(find "$project_dir/release" -maxdepth 1 -type f -name 'Agentlas-*.dmg' | sort)
  node scripts/verify-mac-release.mjs --write-env "--repo=${stable_repo}"
else
  node scripts/verify-mac-release.mjs --write-env --allow-unnotarized "--repo=${stable_repo}"
fi
