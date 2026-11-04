#!/usr/bin/env bash
# Packages extension/ into dist/firefox-mcp-<version>.xpi
set -euo pipefail
cd "$(dirname "$0")"

version=$(python3 -c 'import json; print(json.load(open("extension/manifest.json"))["version"])')
out="dist/firefox-mcp-$version.xpi"

mkdir -p dist
rm -f "$out"
(cd extension && zip -qr -X "../$out" . -x '.*')
echo "$out"
