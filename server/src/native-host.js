#!/usr/bin/env node
// Started by Firefox through native messaging. Relays tool calls between MCP
// servers (newline-delimited JSON over a Unix socket) and the extension
// (length-prefixed JSON over stdin/stdout). stdout belongs to Firefox, so all
// diagnostics go to the log file.
import fs from "node:fs";
import net from "node:net";
import { LOG_PATH, SOCKET_PATH, STATE_DIR } from "./paths.js";

fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });

function log(...parts) {
  fs.appendFileSync(LOG_PATH, `${new Date().toISOString()} [${process.pid}] ${parts.join(" ")}\n`);
}

function sendToFirefox(message) {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length);
  process.stdout.write(Buffer.concat([header, body]));
}

const clients = new Set();
const pending = new Map(); // Firefox-side id -> { socket, id }
let nextId = 1;
let socketInode = null;

function announceClients() {
  sendToFirefox({ type: "clients", count: clients.size });
}

function fromFirefox(message) {
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (!entry.socket.destroyed) {
    entry.socket.write(`${JSON.stringify({ id: entry.id, result: message.result, error: message.error })}\n`);
  }
}

let stdinBuffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  stdinBuffer = Buffer.concat([stdinBuffer, chunk]);
  while (stdinBuffer.length >= 4) {
    const length = stdinBuffer.readUInt32LE(0);
    if (stdinBuffer.length < 4 + length) break;
    const body = stdinBuffer.subarray(4, 4 + length).toString("utf8");
    stdinBuffer = stdinBuffer.subarray(4 + length);
    try {
      fromFirefox(JSON.parse(body));
    } catch (error) {
      log("Bad message from Firefox:", error.message);
    }
  }
});
process.stdin.on("end", shutdown);

const server = net.createServer((socket) => {
  clients.add(socket);
  announceClients();
  log(`client connected (${clients.size} total)`);

  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        const request = JSON.parse(line);
        const id = nextId++;
        pending.set(id, { socket, id: request.id });
        sendToFirefox({ id, method: request.method, params: request.params });
      } catch (error) {
        log("Bad request from client:", error.message);
      }
    }
  });
  socket.on("close", () => {
    clients.delete(socket);
    for (const [id, entry] of pending) if (entry.socket === socket) pending.delete(id);
    announceClients();
    log(`client disconnected (${clients.size} left)`);
  });
  socket.on("error", (error) => log("client socket error:", error.message));
});

// A host left behind by a crashed Firefox would hold a stale socket file.
try {
  fs.unlinkSync(SOCKET_PATH);
} catch {}

server.on("error", (error) => {
  log("socket server error:", error.message);
  process.exit(1);
});

server.listen(SOCKET_PATH, () => {
  fs.chmodSync(SOCKET_PATH, 0o600);
  socketInode = fs.statSync(SOCKET_PATH).ino;
  log("listening on", SOCKET_PATH);
  sendToFirefox({ type: "hello" });
});

function shutdown() {
  log("shutting down");
  server.close();
  try {
    // Only remove the socket if it is still ours and not a newer host's.
    if (fs.statSync(SOCKET_PATH).ino === socketInode) fs.unlinkSync(SOCKET_PATH);
  } catch {}
  process.exit(0);
}

process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
process.on("uncaughtException", (error) => log("uncaught:", error.stack));
