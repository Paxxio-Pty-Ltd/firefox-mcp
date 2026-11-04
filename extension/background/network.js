// Keeps a rolling log of each tab's network requests for read_network_requests,
// tracks requests still in flight so actions can wait for the API calls they
// start, and holds cross-site writes made during an action for the user's approval.
const MAX_REQUESTS_PER_TAB = 500;
const requestsByTab = new Map();
const inFlight = new Map(); // requestId -> request
const guardedTabs = new Map(); // tabId -> guard, while an action runs in that tab
// Tabs the agent has worked in. Only their API calls have bodies and auth headers kept,
// so the user's other browsing is never recorded.
const agentTabs = new Set();
const bodies = new Map(); // requestId -> response body that arrived before the request was recorded
const authByTab = new Map(); // tabId -> Map(origin -> Authorization header of its latest API call)

const MAX_BODY_BYTES = 64 * 1024;
const MAX_SENT_BYTES = 8 * 1024;

const WRITE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
// Fire-and-forget telemetry; asking about every analytics beacon would bury real requests.
const UNGUARDED_TYPES = new Set(["beacon", "ping", "csp_report"]);

// Registrable domain, roughly: api.example.com and admin.example.com are one site,
// and so are a.example.co.za and b.example.co.za.
function siteOf(url) {
  let host;
  try {
    host = new URL(url).hostname;
  } catch {
    return "";
  }
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host;
  const parts = host.split(".");
  const secondLevel = parts.length >= 3 && parts.at(-1).length === 2 &&
    /^(co|com|org|net|gov|ac|edu)$/.test(parts.at(-2));
  return parts.slice(secondLevel ? -3 : -2).join(".");
}

function recordRequest(details, extra) {
  const started = inFlight.get(details.requestId);
  inFlight.delete(details.requestId);
  if (details.tabId < 0) return;
  let list = requestsByTab.get(details.tabId);
  if (!list) {
    list = [];
    requestsByTab.set(details.tabId, list);
  }
  const contentType = details.responseHeaders?.find((h) => h.name.toLowerCase() === "content-type")?.value;
  const body = bodies.get(details.requestId);
  bodies.delete(details.requestId);
  list.push({
    requestId: details.requestId,
    ...(started?.sent && { sent: started.sent }),
    ...(contentType && { contentType }),
    ...(body && { body }),
    start: started?.start ?? details.timeStamp,
    time: details.timeStamp,
    method: details.method,
    url: details.url,
    type: details.type,
    ...extra,
  });
  if (list.length > MAX_REQUESTS_PER_TAB) list.splice(0, list.length - MAX_REQUESTS_PER_TAB);
}

// What a request sent: form fields or the start of its raw body as text.
function sentBody(requestBody) {
  if (!requestBody) return undefined;
  if (requestBody.formData) return new URLSearchParams(Object.entries(requestBody.formData).flatMap(
    ([key, values]) => values.map((value) => [key, value]))).toString();
  const bytes = requestBody.raw?.[0]?.bytes;
  if (!bytes) return undefined;
  const text = new TextDecoder().decode(bytes.slice(0, MAX_SENT_BYTES));
  return bytes.byteLength > MAX_SENT_BYTES ? `${text}…` : text;
}

// Copies an API response's body as it streams past, without holding it up.
function captureBody(requestId, tabId) {
  let filter;
  try {
    filter = browser.webRequest.filterResponseData(requestId);
  } catch {
    return;
  }
  const decoder = new TextDecoder();
  let text = "";
  let size = 0;
  let truncated = false;
  filter.ondata = (event) => {
    filter.write(event.data);
    const room = MAX_BODY_BYTES - size;
    if (room <= 0) {
      truncated = true;
      return;
    }
    const chunk = event.data.byteLength > room ? event.data.slice(0, room) : event.data;
    text += decoder.decode(chunk, { stream: true });
    size += chunk.byteLength;
    if (chunk !== event.data) truncated = true;
  };
  const finish = () => {
    const body = truncated ? `${text}…(cut at ${MAX_BODY_BYTES / 1024} KB)` : text;
    const record = (requestsByTab.get(tabId) ?? []).findLast((r) => r.requestId === requestId);
    if (record) record.body = body;
    else bodies.set(requestId, body);
    // Bodies whose request never got recorded (the tab closed) shouldn't pile up.
    if (bodies.size > 200) bodies.delete(bodies.keys().next().value);
  };
  filter.onstop = () => {
    filter.close();
    finish();
  };
  filter.onerror = finish;
}

const SECRET_KEY = /pass(word|wd)?|secret|token|api[-_]?key|otp|^pin$|authorization|cookie/i;

// Hides passwords, tokens and keys in a body before the agent sees it.
function redact(text) {
  if (!text) return text;
  const hide = (value) => {
    if (Array.isArray(value)) return value.map(hide);
    if (value && typeof value === "object") {
      return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, SECRET_KEY.test(key) ? "••••" : hide(inner)]));
    }
    return value;
  };
  try {
    return JSON.stringify(hide(JSON.parse(text)));
  } catch {
    // Form data or other text: hide the values of secret-looking keys.
    return text.replace(/(["']?([\w-]+)["']?\s*[:=]\s*)("[^"]*"|[^&,\s}]+)/g,
      (match, prefix, key) => (SECRET_KEY.test(key) ? `${prefix}••••` : match));
  }
}

function isTextual(contentType = "") {
  return /json|text|xml|javascript|x-www-form-urlencoded/i.test(contentType);
}

// The Authorization header the page used for its latest API call to this origin.
function authFor(tabId, origin) {
  return authByTab.get(tabId)?.get(origin);
}

// Where the page's API lives: the origin of its most recent API call on the same
// site, falling back to the page's own origin.
function apiOrigin(tab) {
  const site = siteOf(tab.url);
  const calls = (requestsByTab.get(tab.id) ?? []).filter((r) => r.type === "xmlhttprequest" && siteOf(r.url) === site);
  const withAuth = calls.findLast((r) => authFor(tab.id, new URL(r.url).origin));
  const latest = withAuth ?? calls.at(-1);
  return new URL(latest?.url ?? tab.url).origin;
}

function isApiCall(request) {
  if (request.type === "xmlhttprequest") return true;
  return request.type === "main_frame" && (request.method !== "GET" || request.error || request.status >= 400);
}

function apiCallsSince(tabId, since) {
  return (requestsByTab.get(tabId) ?? []).filter((r) => r.start >= since && isApiCall(r));
}

function pendingApiCalls(tabId, since) {
  let count = 0;
  for (const r of inFlight.values()) {
    if (r.tabId === tabId && r.start >= since && r.type === "xmlhttprequest") count++;
  }
  return count;
}

function guardTab(tab, reason) {
  const guard = { site: siteOf(tab.url), host: hostOf(tab.url), reason, denied: [] };
  guardedTabs.set(tab.id, guard);
  return guard;
}

function releaseTab(tabId, guard) {
  if (guardedTabs.get(tabId) === guard) guardedTabs.delete(tabId);
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (details.tabId < 0) return undefined;
    const watched = agentTabs.has(details.tabId) && details.type === "xmlhttprequest";
    inFlight.set(details.requestId, {
      tabId: details.tabId, start: details.timeStamp, type: details.type, method: details.method, url: details.url,
      ...(watched && { sent: sentBody(details.requestBody) }),
    });
    if (watched) captureBody(details.requestId, details.tabId);
    const guard = guardedTabs.get(details.tabId);
    if (!guard || !WRITE_METHODS.has(details.method) || UNGUARDED_TYPES.has(details.type)) return undefined;
    if (siteOf(details.url) === guard.site) return undefined;
    return approveRequest(details, guard);
  },
  { urls: ["<all_urls>"] },
  ["blocking", "requestBody"]
);
browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    if (!agentTabs.has(details.tabId) || details.type !== "xmlhttprequest") return;
    const auth = details.requestHeaders?.find((h) => h.name.toLowerCase() === "authorization")?.value;
    if (!auth) return;
    if (!authByTab.has(details.tabId)) authByTab.set(details.tabId, new Map());
    authByTab.get(details.tabId).set(new URL(details.url).origin, auth);
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"]
);
browser.webRequest.onCompleted.addListener(
  (details) => recordRequest(details, { status: details.statusCode, fromCache: details.fromCache }),
  { urls: ["<all_urls>"] },
  ["responseHeaders"]
);
browser.webRequest.onErrorOccurred.addListener(
  (details) => recordRequest(details, { error: details.error }),
  { urls: ["<all_urls>"] }
);
browser.tabs.onRemoved.addListener((tabId) => {
  requestsByTab.delete(tabId);
  agentTabs.delete(tabId);
  authByTab.delete(tabId);
  for (const [id, r] of inFlight) if (r.tabId === tabId) inFlight.delete(id);
});
