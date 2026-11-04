import net from "node:net";
import { SOCKET_PATH } from "./paths.js";

const NOT_CONNECTED =
  "Firefox isn't connected. Open Firefox with the Firefox MCP Bridge extension installed " +
  "(its toolbar icon tooltip shows the connection state). If it says the native host isn't running, run install.sh.";

// Talks to the native host over its Unix socket. Reconnects lazily, so the MCP
// server can start before Firefox does.
export class BridgeClient {
  #socket = null;
  #connecting = null;
  #buffer = "";
  #pending = new Map();
  #nextId = 1;

  #connect() {
    if (this.#socket) return Promise.resolve();
    this.#connecting ??= new Promise((resolve, reject) => {
      const socket = net.createConnection(SOCKET_PATH);
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        this.#socket = socket;
        resolve();
      });
      socket.on("error", () => {
        if (this.#socket !== socket) reject(new Error(NOT_CONNECTED));
      });
      socket.on("data", (chunk) => this.#onData(chunk));
      socket.on("close", () => {
        if (this.#socket === socket) this.#socket = null;
        for (const { reject: fail } of this.#pending.values()) {
          fail(new Error("Lost the connection to Firefox. Was it closed?"));
        }
        this.#pending.clear();
      });
    }).finally(() => {
      this.#connecting = null;
    });
    return this.#connecting;
  }

  #onData(chunk) {
    this.#buffer += chunk;
    let newline;
    while ((newline = this.#buffer.indexOf("\n")) >= 0) {
      const line = this.#buffer.slice(0, newline);
      this.#buffer = this.#buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const message = JSON.parse(line);
      const entry = this.#pending.get(message.id);
      if (!entry) continue;
      this.#pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error));
      else entry.resolve(message.result);
    }
  }

  async call(method, params = {}, timeoutMs = 60000) {
    await this.#connect();
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`Firefox didn't answer ${method} within ${timeoutMs / 1000}s.`));
      }, timeoutMs);
      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
      this.#socket.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }
}
