import os from "node:os";
import path from "node:path";

// FIREFOX_MCP_STATE_DIR lets a second Firefox (e.g. a test profile) run its own
// bridge without taking over the everyday one's socket.
export const STATE_DIR = process.env.FIREFOX_MCP_STATE_DIR || path.join(os.homedir(), ".firefox-mcp");
export const SOCKET_PATH = path.join(STATE_DIR, "bridge.sock");
export const LOG_PATH = path.join(STATE_DIR, "native-host.log");
