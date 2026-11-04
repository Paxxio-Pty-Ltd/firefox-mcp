// Tool implementations, called by bridge.js with params from the MCP server.

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Agent-opened tabs go into a coloured "Agent" tab group in their window. A group
// (unlike a container) keeps the user's logins. Best effort: it needs tab groups.
const agentGroups = new Map(); // windowId -> groupId

async function addToAgentGroup(tab) {
  if (!browser.tabs.group || !browser.tabGroups) return;
  try {
    const known = agentGroups.get(tab.windowId);
    const exists = known != null && await browser.tabGroups.get(known).then(() => true, () => false);
    if (exists) {
      await browser.tabs.group({ groupId: known, tabIds: [tab.id] });
      return;
    }
    const groupId = await browser.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
    await browser.tabGroups.update(groupId, { title: "Agent", color: "cyan" });
    agentGroups.set(tab.windowId, groupId);
  } catch (error) {
    console.warn("Could not put the tab in the Agent group", error);
  }
}

// Tabs the agent opened with tabs_create, so tabs_context can tell them from the user's.
const agentOpened = new Set();
browser.tabs.onRemoved.addListener((tabId) => agentOpened.delete(tabId));

function ago(ms) {
  const seconds = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

function tabInfo(tab) {
  return {
    tabId: tab.id,
    windowId: tab.windowId,
    active: tab.active,
    title: tab.title,
    url: tab.url,
    status: tab.status,
    ...(tab.lastAccessed && { lastUsed: ago(tab.lastAccessed) }),
    openedBy: agentOpened.has(tab.id) ? "agent" : "user",
    ...([...agentGroups.values()].includes(tab.groupId) && { group: "Agent" }),
    ...(emulationLabel(tab.id) && { emulating: emulationLabel(tab.id) }),
  };
}

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
}

function normalizeUrl(url) {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^(about|data|javascript):/i.test(url)) return url;
  const local = /^(localhost|127\.|0\.0\.0\.0|\[::1\])/i.test(url);
  return `${local ? "http" : "https"}://${url}`;
}

async function getTab(tabId) {
  let tab;
  if (tabId == null) {
    [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab) throw new Error("No active tab found.");
  } else {
    tab = await browser.tabs.get(tabId);
  }
  agentTabs.add(tab.id);
  return tab;
}

async function waitForLoad(tabId, timeout = 15000) {
  const start = Date.now();
  let sawLoading = false;
  while (Date.now() - start < timeout) {
    const tab = await browser.tabs.get(tabId);
    if (tab.status === "loading") sawLoading = true;
    else if (sawLoading || Date.now() - start > 800) return tab;
    await sleep(150);
  }
  return browser.tabs.get(tabId);
}

// After an action, give the page a moment, wait out any navigation it started,
// then wait for the API calls it fired (and any approval they're held for).
async function settle(tabId, since) {
  await sleep(300);
  const tab = await browser.tabs.get(tabId);
  if (tab.status === "loading") await waitForLoad(tabId, 10000);
  const deadline = Date.now() + 3000;
  let waited = false;
  while ((pendingApiCalls(tabId, since) && Date.now() < deadline) || hasPendingApproval(tabId)) {
    waited = true;
    await sleep(100);
  }
  // Let the page render the responses.
  if (waited) await sleep(200);
}

async function execute(tab, options) {
  try {
    return await browser.scripting.executeScript({ target: { tabId: tab.id }, ...options });
  } catch (error) {
    throw new Error(
      `Can't run on this page (${tab.url}): ${error.message}. ` +
      "Firefox blocks extensions on about: pages, addons.mozilla.org and some other built-in pages. Nothing was done."
    );
  }
}

async function runAgent(tab, method, args = {}) {
  const [{ result: loaded }] = await execute(tab, { func: () => Boolean(window.__fxmcp) });
  if (!loaded) await execute(tab, { files: ["/content/agent.js"] });
  const [{ result }] = await execute(tab, {
    func: (name, params) => window.__fxmcp.call(name, params),
    args: [method, args],
  });
  if (!result) throw new Error("The page returned no result.");
  if (!result.ok) throw new Error(result.error);
  return result.value;
}

function agentTool(method) {
  return async ({ tabId, ...args }) => runAgent(await getTab(tabId), method, args);
}

function shortUrl(url, pageUrl) {
  try {
    const target = new URL(url);
    const path = target.pathname + target.search;
    const shown = path.length > 90 ? `${path.slice(0, 89)}…` : path;
    return target.origin === new URL(pageUrl).origin ? shown : `${target.host}${shown}`;
  } catch {
    return url;
  }
}

async function pageChanges(tab) {
  try {
    // Doesn't inject the agent: after a navigation there is nothing to compare.
    const [{ result }] = await execute(tab, { func: () => window.__fxmcp?.call("changes") ?? null });
    return result?.ok ? result.value : null;
  } catch {
    return null;
  }
}

const MAX_API_LINES = 5;

async function describeChanges(before, since, method) {
  const tab = await browser.tabs.get(before.id).catch(() => null);
  if (!tab) return "What changed: the tab was closed.";
  const lines = [];
  if (tab.url !== before.url) lines.push(`URL: ${before.url} → ${tab.url}`);
  const page = await pageChanges(tab);
  for (const message of page?.messages ?? []) lines.push(`Message: ${message}`);
  const calls = apiCallsSince(tab.id, since);
  for (const r of calls.slice(0, MAX_API_LINES)) {
    lines.push(`API: ${r.method} ${shortUrl(r.url, tab.url)} → ${r.error ?? r.status}`);
  }
  if (calls.length > MAX_API_LINES) lines.push(`API: …and ${calls.length - MAX_API_LINES} more (see read_network_requests)`);
  const running = pendingApiCalls(tab.id, since);
  if (running) lines.push(`API: ${running} still running`);
  lines.push(...(page?.lines ?? []));

  if (lines.length) return `What changed:\n${lines.map((line) => `- ${line}`).join("\n")}`;
  // Typing changes a field's value, which isn't worth reporting on its own.
  if (method === "type" || method === "setValue") return "";
  return "What changed: nothing seen (same URL, no API calls, no page changes).";
}

const ACTIVATING_KEY = /(^|\+)(Enter|Space| )$/;

// Pressing something like Publish or Delete waits for the user's approval first.
async function checkApproval(tab, method, args, reason) {
  const keyboard = method === "pressKey" ? ACTIVATING_KEY.test(args.key) : method === "type" && args.submit;
  if (method !== "click" && !keyboard) return;
  const key = method === "type" ? "Enter" : args.key;
  const risk = await runAgent(tab, "assessRisk", { method, ref: args.ref, x: args.x, y: args.y, key });
  if (!risk) return;
  const host = hostOf(tab.url);
  if ((await allowedSites()).includes(host)) return;

  const image = await cropTarget(tab, risk.rect);
  await runAgent(tab, "showApprovalHint").catch(() => {});
  let result;
  try {
    result = await askApproval({ tabId: tab.id, host, title: risk.action, detail: `on ${tab.url}`, reason, image });
  } finally {
    await runAgent(tab, "clearOverlay").catch(() => {});
  }
  if (result === "timeout") {
    throw new Error(`Nobody approved this within ${APPROVAL_TIMEOUT_MS / 60000} minutes, so it wasn't done: ${risk.action}. ` +
      "The user approves from the Firefox toolbar icon; ask them before trying again.");
  }
  if (result === "closed") throw new Error(`The tab was closed before the user decided, so it wasn't done: ${risk.action}.`);
  if (result === "deny") {
    throw new Error(`The user denied this, so it wasn't done: ${risk.action}. Don't retry it without asking them.`);
  }
}

const NOTHING_SENT = /Nothing was done|wasn't done/;

// Whether a failed action may have reached the page, so the agent knows if a retry
// could press something twice.
function retryAdvice(message) {
  return NOTHING_SENT.test(message) ? message : `${message}\nIt may have gone through: read the page before trying again.`;
}

// One action: the site's trust level, approval for risky ones, the action, and a
// wait for what it set off. Returns the agent's answer, when it started, and any
// cross-site writes the user refused.
async function performAction(tab, method, args, reason, continueWatch = false) {
  await assertCanAct(tab);
  await checkApproval(tab, method, args, reason);
  const since = Date.now();
  const guard = guardTab(tab, reason);
  try {
    const value = await runAgent(tab, method, { ...args, continueWatch });
    await settle(tab.id, since);
    return { value, since, denied: guard.denied };
  } catch (error) {
    throw new Error(retryAdvice(error.message));
  } finally {
    releaseTab(tab.id, guard);
  }
}

// Actions report what they changed, and risky ones wait for the user's approval first.
function actionTool(method, fixed = {}) {
  return async ({ tabId, reason, ...args }) => {
    const tab = await getTab(tabId);
    const { value, since, denied } = await performAction(tab, method, { ...args, ...fixed }, reason);
    const changes = await describeChanges(tab, since, method);
    const result = changes ? `${value}\n${changes}` : value;
    if (denied.length) {
      throw new Error(`${result}\nCancelled because it wasn't approved: ${denied.join("; ")}.`);
    }
    return result;
  };
}

// Tools a batch step can be, and the page action each runs.
const BATCH_ACTIONS = {
  click: ["click"], double_click: ["click", { clickCount: 2 }], triple_click: ["click", { clickCount: 3 }],
  type: ["type"], press_key: ["pressKey"], form_input: ["setValue"], hover: ["hover"], scroll: ["scroll"],
};
const BATCH_TOOLS = [...Object.keys(BATCH_ACTIONS), "wait", "wait_for"];

async function runBatchStep(tab, { tool, args = {} }, index) {
  if (tool === "wait") {
    const seconds = Math.min(30, Math.max(0, Number(args.seconds ?? 1)));
    await sleep(seconds * 1000);
    return `Waited ${seconds}s.`;
  }
  if (tool === "wait_for") return TOOLS.wait_for({ ...args, tabId: tab.id });
  const [method, fixed = {}] = BATCH_ACTIONS[tool];
  const { tabId, reason, ...rest } = args;
  const { value, denied } = await performAction(tab, method, { ...rest, ...fixed }, reason, index > 0);
  if (denied.length) throw new Error(`${value}\nCancelled because it wasn't approved: ${denied.join("; ")}.`);
  return value;
}

// Polls until every wait_for condition holds. Page checks run through the agent,
// which is injected again after a navigation, so a wait can span page loads.
async function waitFor({ tabId, timeout = 10, network_idle: networkIdle = false, ...conditions }) {
  const tab = await getTab(tabId);
  const checksPage = ["text", "text_gone", "selector", "ref"].some((key) => conditions[key] != null);
  if (!checksPage && !networkIdle) throw new Error("Give text, text_gone, selector, ref or network_idle to wait for.");
  const start = Date.now();
  const deadline = start + timeout * 1000;
  let page = { done: !checksPage, met: [], unmet: [] };
  let quietSince = null;
  for (;;) {
    if (checksPage) {
      try {
        page = await runAgent(tab, "waitCheck", conditions);
      } catch (error) {
        // A ref from before a navigation can't come back; anything else is the page loading.
        if (/isn't a ref on this page/.test(error.message)) throw error;
        page = { ...page, done: false };
      }
    }
    let quiet = true;
    if (networkIdle) {
      const current = await browser.tabs.get(tab.id).catch(() => null);
      if (!current) throw new Error("The tab was closed while waiting.");
      const busy = pendingApiCalls(tab.id, 0) > 0 || current.status === "loading";
      quietSince = busy ? null : quietSince ?? Date.now();
      quiet = quietSince != null && Date.now() - quietSince >= 500;
    }
    const seconds = ((Date.now() - start) / 1000).toFixed(1);
    if (page.done && quiet) {
      return `Waited ${seconds}s: ${[...page.met, ...(networkIdle ? ["no API calls running"] : [])].join("; ")}.`;
    }
    if (Date.now() >= deadline) {
      const missing = [...page.unmet];
      if (networkIdle && !quiet) missing.push(`API calls to finish (${pendingApiCalls(tab.id, 0)} running)`);
      throw new Error(`Timed out after ${timeout}s waiting for ${missing.join(", ")}.` +
        (page.met.length ? ` Already true: ${page.met.join("; ")}.` : ""));
    }
    await sleep(250);
  }
}

// Runs in the page's own world, so the request carries its cookies and looks like the app's own.
// Sends back at most `maxChars` (plus room for redaction to work on JSON) and the real length.
async function fetchInPage(url, init, maxChars) {
  try {
    const response = await fetch(url, { ...init, credentials: "include" });
    const text = await response.text();
    return {
      ok: true, status: response.status, statusText: response.statusText,
      contentType: response.headers.get("content-type") ?? "",
      text: text.slice(0, Math.max(maxChars * 4, 200000)),
      length: text.length,
    };
  } catch (error) {
    return { ok: false, error: String(error) };
  }
}

// `length` is the body's real length when `text` is only the start of it.
function formatBody(text, contentType, max, length = text?.length ?? 0) {
  if (!text) return "(empty)";
  if (contentType && !isTextual(contentType)) return `(${contentType}, not shown)`;
  const shown = redact(text);
  const sourceCut = length > text.length;
  if (shown.length <= max && !sourceCut) return shown;
  return `${shown.slice(0, max)}…(cut; ${sourceCut ? length : shown.length} chars in all)`;
}

// Serialised and run in the page's own world, so it must not use anything outside itself.
async function runInPage(code) {
  const AsyncFunction = (async () => {}).constructor;
  let fn;
  try {
    fn = new AsyncFunction(`return (${code}\n)`);
  } catch {
    try {
      fn = new AsyncFunction(code);
    } catch (error) {
      return { ok: false, error: String(error) };
    }
  }
  try {
    const value = await fn();
    let text;
    try {
      text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
    } catch {
      text = String(value);
    }
    if (text === undefined) text = String(value);
    return { ok: true, value: text.length > 50000 ? `${text.slice(0, 50000)}\n…(truncated)` : text };
  } catch (error) {
    return { ok: false, error: error?.stack || String(error) };
  }
}

// Captures the visible part of a tab with password fields and user-filled secrets
// blacked out. Pages the agent can't run on (about: and the like) have neither.
// Firefox's tabs.captureTab renders a tab even when it isn't the one showing, so the
// user can keep working in another tab. `keepFlash` leaves the outline of the last
// action in, for thumbnails and recordings.
async function captureTab(tab, options, { keepFlash = false } = {}) {
  const masked = await runAgent(tab, "maskSecrets", { keepFlash }).catch(() => 0);
  try {
    if (browser.tabs.captureTab) return await browser.tabs.captureTab(tab.id, options);
    return await browser.tabs.captureVisibleTab(tab.windowId, options);
  } finally {
    if (masked) await runAgent(tab, "unmaskSecrets").catch(() => {});
  }
}

function formatTime(ms) {
  return new Date(ms).toTimeString().slice(0, 8);
}

const TOOLS = {
  async tabs_context() {
    const [tabs, focused] = await Promise.all([
      browser.tabs.query({}),
      browser.windows.getLastFocused(),
    ]);
    return { focusedWindowId: focused.id, tabs: tabs.map(tabInfo) };
  },

  async tabs_create({ url, active = true, group = true }) {
    const tab = await browser.tabs.create({ url: url ? normalizeUrl(url) : undefined, active });
    agentOpened.add(tab.id);
    agentTabs.add(tab.id);
    if (group) await addToAgentGroup(tab);
    return tabInfo(url ? await waitForLoad(tab.id) : tab);
  },

  async tabs_close({ tabId }) {
    await browser.tabs.remove(tabId);
    return `Closed tab ${tabId}.`;
  },

  async navigate({ tabId, url }) {
    const tab = await getTab(tabId);
    if (url === "back") await browser.tabs.goBack(tab.id);
    else if (url === "forward") await browser.tabs.goForward(tab.id);
    else if (url === "reload") await browser.tabs.reload(tab.id);
    else {
      try {
        await browser.tabs.update(tab.id, { url: normalizeUrl(url) });
      } catch (error) {
        throw new Error(`${error.message}. Firefox doesn't let extensions open about:, chrome: or file: URLs.`);
      }
    }
    return tabInfo(await waitForLoad(tab.id));
  },

  read_page: agentTool("readPage"),
  get_page_text: agentTool("pageText"),
  find: agentTool("find"),
  click: actionTool("click"),
  double_click: actionTool("click", { clickCount: 2 }),
  triple_click: actionTool("click", { clickCount: 3 }),
  hover: agentTool("hover"),
  type: actionTool("type"),
  press_key: actionTool("pressKey"),
  form_input: actionTool("setValue"),
  scroll: agentTool("scroll"),

  async request_user_input({ tabId, ref, hint, timeout = 300 }) {
    const tab = await getTab(tabId);
    if (!tab.active) await browser.tabs.update(tab.id, { active: true });
    const { entry } = addPending({ kind: "input", tabId: tab.id, host: hostOf(tab.url), title: "Fill in a field yourself", reason: hint });
    try {
      return await runAgent(tab, "requestInput", { ref, hint, timeoutMs: timeout * 1000 });
    } catch (error) {
      const now = await browser.tabs.get(tab.id).catch(() => null);
      if (!now) return "skipped (the tab was closed)";
      if (now.url !== tab.url) return "skipped (the page navigated away)";
      throw error;
    } finally {
      settlePending(entry.id, "done");
    }
  },

  async screenshot({ tabId }) {
    const tab = await getTab(tabId);
    // scale: 1 gives CSS pixels, so screenshot coordinates match click coordinates.
    const dataUrl = await captureTab(tab, { format: "jpeg", quality: 80, scale: 1 });
    const { width, height } = await loadImage(dataUrl);
    return { type: "image", mimeType: "image/jpeg", data: dataUrl.slice(dataUrl.indexOf(",") + 1), width, height };
  },

  wait_for: waitFor,
  gif_start: gifStart,
  gif_save: gifSave,

  async batch({ tabId, steps, stop_on_error: stopOnError = true }) {
    const unknown = steps.find((step) => !BATCH_TOOLS.includes(step.tool));
    if (unknown) {
      throw new Error(`A batch step can't be "${unknown.tool}". Use: ${BATCH_TOOLS.join(", ")}. Nothing was done.`);
    }
    const tab = await getTab(tabId);
    const start = Date.now();
    const lines = [];
    let failed = false;
    for (const [index, step] of steps.entries()) {
      try {
        lines.push(`${index + 1}. ${await runBatchStep(tab, step, index)}`);
      } catch (error) {
        failed = true;
        lines.push(`${index + 1}. ${step.tool} failed: ${error.message}`);
        if (stopOnError) {
          const rest = steps.length - index - 1;
          if (rest === 1) lines.push(`Step ${steps.length} wasn't run.`);
          else if (rest > 1) lines.push(`Steps ${index + 2} to ${steps.length} weren't run.`);
          break;
        }
      }
    }
    const changes = await describeChanges(tab, start, "batch");
    const text = [...lines, changes].filter(Boolean).join("\n");
    if (failed) throw new Error(text);
    return text;
  },

  async page_fetch({ tabId, path, method = "GET", body, headers = {}, reason, max_chars: maxChars = 20000 }) {
    const tab = await getTab(tabId);
    method = method.toUpperCase();
    const url = new URL(path, apiOrigin(tab)).href;
    if (siteOf(url) !== siteOf(tab.url)) {
      throw new Error(`page_fetch only calls the page's own site (${siteOf(tab.url)}), not ${new URL(url).host}. Nothing was done.`);
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      await assertCanAct(tab);
      const host = hostOf(tab.url);
      const result = await askApproval({
        tabId: tab.id, host, title: `${method} ${shortUrl(url, tab.url)}`,
        detail: `page_fetch on ${tab.url}${body != null ? ` with ${String(typeof body === "string" ? body : JSON.stringify(body)).slice(0, 200)}` : ""}`,
        reason,
      });
      if (!["allowed", "approve", "always"].includes(result)) {
        throw new Error(`The user didn't approve ${method} ${shortUrl(url, tab.url)} (${result}), so it wasn't done.`);
      }
    }
    const sendHeaders = { ...headers };
    const hasHeader = (name) => Object.keys(sendHeaders).some((key) => key.toLowerCase() === name);
    const auth = authFor(tab.id, new URL(url).origin);
    const addedAuth = !!auth && !hasHeader("authorization");
    if (addedAuth) sendHeaders.Authorization = auth;
    let sendBody = body;
    if (body != null && typeof body !== "string") {
      sendBody = JSON.stringify(body);
      if (!hasHeader("content-type")) sendHeaders["Content-Type"] = "application/json";
    }
    const [{ result }] = await execute(tab, {
      world: "MAIN",
      func: fetchInPage,
      args: [url, { method, headers: sendHeaders, ...(sendBody != null && { body: sendBody }) }, maxChars],
    });
    if (!result.ok) throw new Error(`${method} ${url} failed: ${result.error}`);
    const authNote = addedAuth ? " (with the page's Authorization header)" : "";
    return `${method} ${shortUrl(url, tab.url)} → ${result.status} ${result.statusText}${authNote}\n` +
      `${result.contentType}\n\n${formatBody(result.text, result.contentType, maxChars, result.length)}`;
  },

  async javascript({ tabId, code }) {
    const tab = await getTab(tabId);
    await assertCanAct(tab);
    const [{ result }] = await execute(tab, { world: "MAIN", func: runInPage, args: [code] });
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },

  async read_console_messages({ tabId, pattern, onlyErrors = false, clear = false, limit = 100 }) {
    const tab = await getTab(tabId);
    const [{ result }] = await execute(tab, {
      world: "MAIN",
      func: (clearAfter) => {
        const buffer = window.__fxmcpConsole;
        if (!buffer) return null;
        const copy = buffer.slice();
        if (clearAfter) buffer.length = 0;
        return copy;
      },
      args: [clear],
    });
    if (!result) {
      return "Console capture isn't running on this page yet. Reload the page and try again.";
    }
    const needle = pattern?.toLowerCase();
    const entries = result
      .filter((entry) => !onlyErrors || entry.level === "error")
      .filter((entry) => !needle || entry.text.toLowerCase().includes(needle))
      .slice(-limit);
    if (entries.length === 0) return "No matching console messages.";
    return entries.map((e) => `[${formatTime(e.time)}] ${e.level}: ${e.text}`).join("\n");
  },

  async read_network_requests({ tabId, pattern, onlyErrors = false, clear = false, limit = 100, bodies: withBodies = false, body_chars: bodyChars = 2000 }) {
    const tab = await getTab(tabId);
    const all = requestsByTab.get(tab.id) ?? [];
    const needle = pattern?.toLowerCase();
    const entries = all
      .filter((r) => !onlyErrors || r.error || r.status >= 400)
      .filter((r) => !needle || r.url.toLowerCase().includes(needle))
      .slice(-limit);
    if (clear) requestsByTab.delete(tab.id);
    if (entries.length === 0) return "No matching network requests.";
    return entries
      .map((r) => {
        let line = `[${formatTime(r.time)}] ${r.method} ${r.error ?? r.status} ${r.type} ${r.url}`;
        if (withBodies && r.sent) line += `\n  sent: ${formatBody(r.sent, "", bodyChars)}`;
        if (withBodies && r.body != null) line += `\n  got: ${formatBody(r.body, r.contentType, bodyChars)}`;
        else if (withBodies && r.type === "xmlhttprequest") line += "\n  got: (not captured: the agent wasn't using this tab yet)";
        return line;
      })
      .join("\n");
  },

  async resize_window({ tabId, width, height }) {
    const tab = await getTab(tabId);
    const win = await browser.windows.update(tab.windowId, { width, height, state: "normal" });
    return `Window resized to ${win.width}x${win.height}.`;
  },

  ...EMULATION_TOOLS,
};
