// Things waiting on the user: approvals for risky actions, and fields the user
// fills in themselves. Drives the toolbar badge and the popup, which is the only
// place a decision can come from.
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const pending = new Map(); // id -> entry
let nextPendingId = 1;

function pendingCounts() {
  let approvals = 0;
  let inputs = 0;
  for (const entry of pending.values()) {
    if (entry.kind === "input") inputs++;
    else approvals++;
  }
  return { approvals, inputs };
}

function hasPendingApproval(tabId) {
  for (const entry of pending.values()) {
    if (entry.kind === "approval" && entry.tabId === tabId) return true;
  }
  return false;
}

function stateChanged() {
  updateBadge();
  // Rejects when the popup isn't open, which is fine.
  browser.runtime.sendMessage({ type: "state-changed" }).catch(() => {});
}

function addPending(fields) {
  const entry = { id: nextPendingId++, created: Date.now(), ...fields };
  const decision = new Promise((resolve) => {
    entry.resolve = resolve;
  });
  pending.set(entry.id, entry);
  stateChanged();
  return { entry, decision };
}

function settlePending(id, decision) {
  const entry = pending.get(id);
  if (!entry) return;
  pending.delete(id);
  clearTimeout(entry.timer);
  entry.resolve(decision);
  stateChanged();
}

// How far the agent may go on each site, set from the popup: "read" (read only),
// "ask" (the default: risky actions wait for approval) or "trusted" (no approvals).
const TRUST_LEVELS = ["read", "ask", "trusted"];

async function siteTrust() {
  const { siteTrust = {}, alwaysAllow = [] } = await browser.storage.local.get(["siteTrust", "alwaysAllow"]);
  // Sites allowed before trust levels existed skipped approval, which is "trusted" now.
  for (const host of alwaysAllow) siteTrust[host] ??= "trusted";
  return siteTrust;
}

async function trustOf(host) {
  return (await siteTrust())[host] ?? "ask";
}

async function setSiteTrust(host, level) {
  if (!host || !TRUST_LEVELS.includes(level)) return;
  const trust = await siteTrust();
  if (level === "ask") delete trust[host];
  else trust[host] = level;
  await browser.storage.local.set({ siteTrust: trust, alwaysAllow: [] });
}

// Fails a call that would change something on a site the user made read-only.
async function assertCanAct(tab) {
  const host = hostOf(tab.url);
  if (await trustOf(host) === "read") {
    throw new Error(`${host} is read-only for the agent (set in the Firefox toolbar popup). ` +
      "Reading works; clicking, typing and running scripts don't. Nothing was done.");
  }
}

async function allowedSites() {
  const trust = await siteTrust();
  return Object.keys(trust).filter((host) => trust[host] === "trusted");
}

async function setSiteAllowed(host, allowed) {
  await setSiteTrust(host, allowed ? "trusted" : "ask");
}

// Resolves to "allowed" (site is on the allow list), "approve", "always", "deny", "timeout" or "closed".
async function askApproval({ tabId, host, title, detail, reason, image }) {
  if ((await allowedSites()).includes(host)) return "allowed";
  const { entry, decision } = addPending({ kind: "approval", tabId, host, title, detail, reason, image });
  entry.timer = setTimeout(() => settlePending(entry.id, "timeout"), APPROVAL_TIMEOUT_MS);
  const result = await decision;
  if (result === "always") await setSiteAllowed(host, true);
  return result;
}

// Called from the blocking webRequest listener for a cross-site write during an action.
async function approveRequest(details, guard) {
  const result = await askApproval({
    tabId: details.tabId,
    host: guard.host,
    title: `${details.method} to another site`,
    detail: `to ${details.url}, from a page on ${guard.host}`,
    reason: guard.reason,
  });
  if (["allowed", "approve", "always"].includes(result)) return {};
  const why = { deny: "denied by the user", timeout: "no answer within 5 minutes", closed: "tab closed" }[result];
  guard.denied.push(`${details.method} ${details.url} (${why})`);
  return { cancel: true };
}

async function loadImage(dataUrl) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return image;
}

// The part of a screenshot around `rect`, scaled to at most `maxWidth`, with an
// optional outline on the element itself. Null when the element is off the picture.
function cropImage(image, rect, { padX = 80, padY = 48, maxWidth = 640, outline = null } = {}) {
  const x = Math.max(0, Math.floor(rect.x - padX));
  const y = Math.max(0, Math.floor(rect.y - padY));
  const width = Math.min(image.width - x, Math.ceil(rect.width + padX * 2));
  const height = Math.min(image.height - y, Math.ceil(rect.height + padY * 2));
  if (width <= 0 || height <= 0) return null;
  const scale = Math.min(1, maxWidth / width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(width * scale);
  canvas.height = Math.round(height * scale);
  const context = canvas.getContext("2d");
  context.drawImage(image, x, y, width, height, 0, 0, canvas.width, canvas.height);
  if (outline) {
    context.strokeStyle = outline;
    context.lineWidth = 3;
    context.strokeRect((rect.x - x - 3) * scale, (rect.y - y - 3) * scale, (rect.width + 6) * scale, (rect.height + 6) * scale);
  }
  return canvas.toDataURL("image/jpeg", 0.85);
}

// A picture of the element being approved, with some context around it and an
// outline on the element itself.
async function cropTarget(tab, rect) {
  if (!rect) return null;
  try {
    const image = await loadImage(await captureTab(tab, { format: "png", scale: 1 }));
    return cropImage(image, rect, { outline: "#ff8a00" });
  } catch (error) {
    console.warn("Could not capture the approval preview", error);
    return null;
  }
}

async function popupState() {
  const entries = [...pending.values()].map(({ resolve, timer, ...entry }) => entry);
  return {
    connected, clientCount, pending: entries, trust: await siteTrust(),
    activity: activity.map(({ resolve, ...entry }) => entry), control,
    tokens: { total: tokensTotal, since: tokensSince },
  };
}

async function showPendingTab(id) {
  const entry = pending.get(id);
  if (!entry) return;
  const tab = await browser.tabs.update(entry.tabId, { active: true });
  await browser.windows.update(tab.windowId, { focused: true });
}

async function skipInput(id) {
  const entry = pending.get(id);
  if (entry?.kind !== "input") return;
  try {
    await browser.scripting.executeScript({
      target: { tabId: entry.tabId },
      func: () => window.__fxmcp?.call("cancelInput"),
    });
  } finally {
    settlePending(id, "skip");
  }
}

browser.runtime.onMessage.addListener((message, sender) => {
  // Decisions only count from the extension's own popup page. Firefox sets sender.url,
  // so a web page (or a content script running in one) can't pass this check.
  if (!sender.url?.startsWith(browser.runtime.getURL("popup/"))) return undefined;
  switch (message.type) {
    case "popup:state":
      return popupState();
    case "popup:decide":
      if (["approve", "always", "deny"].includes(message.decision) && pending.get(message.id)?.kind === "approval") {
        settlePending(message.id, message.decision);
      }
      return Promise.resolve(true);
    case "popup:skip-input":
      return skipInput(message.id).then(() => true);
    case "popup:show":
      return showPendingTab(message.id).then(() => true);
    case "popup:set-trust":
      return setSiteTrust(message.host, message.level).then(() => {
        stateChanged();
        return true;
      });
    case "popup:control":
      setControl(message.state);
      return Promise.resolve(true);
    case "popup:reset-tokens":
      resetTokens();
      return Promise.resolve(true);
    case "popup:highlight":
      return highlightActivity(message.id).then(() => true);
    default:
      return undefined;
  }
});

// A closed tab can't be acted on, so nothing waiting on it goes ahead.
browser.tabs.onRemoved.addListener((tabId) => {
  for (const entry of [...pending.values()]) {
    if (entry.tabId === tabId) settlePending(entry.id, "closed");
  }
});
