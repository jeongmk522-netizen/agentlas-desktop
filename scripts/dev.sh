#!/usr/bin/env bash
# 한 번 호출로 dev — npm run dev의 alias.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR/.."
exec npm run dev
