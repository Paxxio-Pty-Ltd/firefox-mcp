// Connects to the native host, which relays tool calls from MCP servers.
const HOST_NAME = "firefox_mcp_bridge";

let port = null;
let connected = false;
let retryDelay = 1000;
let clientCount = 0;

// Approvals (amber, with a count) and fields waiting for the user (yellow dot)
// take over the badge, since they need the user's attention.
function updateBadge() {
  const { approvals, inputs } = pendingCounts();
  let text = "";
  let color = "#2ac3a2";
  let title = "MCP bridge: native host not running (run install.sh)";
  if (connected && clientCount > 0) {
    text = "ON";
    title = `MCP bridge: ${clientCount} client${clientCount === 1 ? "" : "s"} connected`;
  } else if (connected) {
    title = "MCP bridge: ready, no clients connected";
  }
  if (control !== "running") {
    text = control === "paused" ? "II" : "■";
    color = control === "paused" ? "#6b6878" : "#d93d3d";
    title = control === "paused"
      ? "MCP bridge: paused. The agent's calls wait until you resume."
      : "MCP bridge: stopped. The agent's calls fail until you resume.";
  }
  if (approvals) {
    text = String(approvals);
    color = "#ff8a00";
    title = `MCP bridge: ${approvals} action${approvals === 1 ? "" : "s"} waiting for your approval. Click to review.`;
  } else if (inputs) {
    text = "•";
    color = "#ffc400";
    title = "MCP bridge: a field is waiting for you to fill it in. Click to see it.";
  }
  browser.browserAction.setBadgeText({ text });
  browser.browserAction.setBadgeBackgroundColor({ color });
  browser.browserAction.setBadgeTextColor({ color: approvals || inputs ? "#1b1a22" : "#ffffff" });
  browser.browserAction.setTitle({ title });
}

function send(message) {
  try {
    port?.postMessage(message);
  } catch (error) {
    console.warn("Could not reply to native host", error);
  }
}

async function handleMessage(message) {
  if (message.type === "hello") {
    retryDelay = 1000;
    clientCount = 0;
    connected = true;
    updateBadge();
    return;
  }
  if (message.type === "clients") {
    clientCount = message.count;
    updateBadge();
    return;
  }
  if (message.id == null) return;

  const params = message.params ?? {};
  const entry = logCall(message.method, params);
  try {
    await gateCall();
    const tool = TOOLS[message.method];
    if (!tool) throw new Error(`Unknown tool: ${message.method}`);
    const result = await tool(params);
    finishCall(entry, null, result, params);
    await picture(entry, message.method, params, false);
    send({ id: message.id, result });
  } catch (error) {
    finishCall(entry, error, undefined, params);
    await picture(entry, message.method, params, true);
    send({ id: message.id, error: error?.message ?? String(error) });
  }
}

// A recording needs its frame before the agent's next action, so it waits for it.
// A thumbnail alone doesn't hold up the reply.
async function picture(entry, method, params, failed) {
  const taking = afterCall(entry, method, params, failed).catch((error) => console.warn("No picture taken", error));
  if (isRecording()) await taking;
}

function connect() {
  port = browser.runtime.connectNative(HOST_NAME);
  port.onMessage.addListener(handleMessage);
  port.onDisconnect.addListener((disconnected) => {
    console.warn("Native host disconnected:", disconnected.error?.message);
    port = null;
    connected = false;
    updateBadge();
    setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30000);
  });
}

updateBadge();
connect();
