#!/usr/bin/env bash

set -euo pipefail

# Simple helper to show or bump the package version.
# Usage:
#   ./scripts/bump-version.sh            # show current version
#   ./scripts/bump-version.sh patch      # bump patch
#   ./scripts/bump-version.sh minor      # bump minor
#   ./scripts/bump-version.sh major      # bump major
#   ./scripts/bump-version.sh 1.2.3      # set an explicit version

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

if [[ "${1:-}" =~ ^(-h|--help)$ ]]; then
  sed -n '5,12p' "${BASH_SOURCE[0]}"
  exit 0
fi

current_version="$(node -p "require('./package.json').version")"
target="${1:-}"

if [[ -z "$target" ]]; then
  echo "Current version: ${current_version}"
  echo "Pass patch|minor|major or a semver value to bump."
  exit 0
fi

npm version "${target}" --no-git-tag-version
echo "Version updated: ${current_version} -> $(node -p \"require('./package.json').version\")"
