#!/usr/bin/env bash
# Installs server dependencies, registers the native messaging host with
# Firefox, and builds the extension. Re-run after moving the repo or switching
# Node versions, because the host launcher stores absolute paths.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
NODE="$(command -v node)"
HOST_NAME="firefox_mcp_bridge"
EXTENSION_ID="firefox-mcp@paxxio.co.za"
STATE_DIR="$HOME/.firefox-mcp"

case "$(uname)" in
  Darwin) MANIFEST_DIR="$HOME/Library/Application Support/Mozilla/NativeMessagingHosts" ;;
  *) MANIFEST_DIR="$HOME/.mozilla/native-messaging-hosts" ;;
esac

(cd "$ROOT/server" && npm install --silent)

mkdir -p "$STATE_DIR" "$MANIFEST_DIR"
chmod 700 "$STATE_DIR"

# Firefox starts native hosts with a minimal PATH, so pin the node binary.
cat > "$STATE_DIR/native-host.sh" <<SH
#!/bin/sh
exec "$NODE" "$ROOT/server/src/native-host.js" "\$@"
SH
chmod 755 "$STATE_DIR/native-host.sh"

cat > "$MANIFEST_DIR/$HOST_NAME.json" <<JSON
{
  "name": "$HOST_NAME",
  "description": "Firefox MCP Bridge native host",
  "path": "$STATE_DIR/native-host.sh",
  "type": "stdio",
  "allowed_extensions": ["$EXTENSION_ID"]
}
JSON

xpi="$("$ROOT/build.sh")"

echo "Native host registered: $MANIFEST_DIR/$HOST_NAME.json"
echo "Extension built:        $ROOT/$xpi"
echo "MCP server command:     $NODE $ROOT/server/src/mcp-server.js"
