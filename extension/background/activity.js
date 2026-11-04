// Recent tool calls, listed in the popup, and the user's Pause and Stop. A paused
// call waits until the user resumes; once stopped, every call fails until they resume.
const MAX_ACTIVITY = 30;
const activity = []; // newest first
let control = "running"; // "running" | "paused" | "stopped"
let resumeWaiters = [];
let nextActivityId = 1;

function setControl(next) {
  if (!["running", "paused", "stopped"].includes(next)) return;
  control = next;
  if (next !== "paused") {
    for (const resolve of resumeWaiters) resolve();
    resumeWaiters = [];
  }
  stateChanged();
}

const STOPPED =
  "Stopped by the user from the Firefox toolbar. Ask them before doing anything else in the browser.";

async function gateCall() {
  while (control === "paused") await new Promise((resolve) => resumeWaiters.push(resolve));
  if (control === "stopped") throw new Error(STOPPED);
}

function brief(text, max = 40) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

// A short line on what a call was given, for the activity list.
function describeParams(method, params) {
  const parts = [];
  if (params.ref) parts.push(params.ref);
  if (params.url) parts.push(brief(params.url, 60));
  if (params.query) parts.push(`"${brief(params.query)}"`);
  if (params.role) parts.push(`role ${params.role}`);
  if (params.key) parts.push(params.key);
  if (method === "type" && params.text != null) parts.push(`"${brief(params.text, 30)}"`);
  if (method === "form_input" && params.value != null) parts.push(`= ${brief(params.value, 30)}`);
  if (params.code) parts.push(brief(params.code, 50));
  if (params.path) parts.push(`${params.method ?? "GET"} ${brief(params.path, 50)}`);
  if (params.steps) parts.push(`${params.steps.length} steps`);
  if (params.device) parts.push(params.device);
  if (params.text != null && method === "wait_for") parts.push(`"${brief(params.text)}"`);
  return parts.join(" ");
}

function logCall(method, params) {
  const entry = {
    id: nextActivityId++, time: Date.now(), tool: method, tabId: params.tabId,
    ref: params.ref, detail: describeParams(method, params), status: "running",
  };
  activity.unshift(entry);
  activity.splice(MAX_ACTIVITY);
  stateChanged();
  return entry;
}

// Rough token counts for what a call puts in the agent's context: about 4 characters
// per token for text, and width x height / 750 for images (after the long
// side is scaled to 1568 px). Estimates, to show which calls are expensive.
const IMAGE_MAX_SIDE = 1568;
let tokensSince = Date.now();
let tokensTotal = 0;

function textTokens(text) {
  return Math.ceil(String(text ?? "").length / 4);
}

function imageTokens(width, height) {
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(width, height));
  return Math.ceil((width * scale * height * scale) / 750);
}

function resultTokens(error, result) {
  if (error) return textTokens(error.message ?? error);
  if (result?.type === "image") return imageTokens(result.width ?? 1280, result.height ?? 800);
  // A GIF goes to a file; the agent only reads the line the MCP server writes about it.
  if (result?.type === "gif") return 40;
  return textTokens(typeof result === "string" ? result : JSON.stringify(result, null, 2));
}

function resetTokens() {
  tokensTotal = 0;
  tokensSince = Date.now();
  stateChanged();
}

function finishCall(entry, error, result, params = {}) {
  entry.status = error ? "failed" : "done";
  const text = error ? error.message ?? String(error) : typeof result === "string" ? result : "";
  entry.outcome = brief(text.split("\n")[0], 160);
  entry.tokens = { result: resultTokens(error, result), args: textTokens(JSON.stringify(params)) };
  tokensTotal += entry.tokens.result + entry.tokens.args;
  stateChanged();
}

// Shows the user which element an earlier call acted on.
async function highlightActivity(id) {
  const entry = activity.find((item) => item.id === id);
  if (!entry) return;
  const tab = entry.tabId != null ? await browser.tabs.get(entry.tabId).catch(() => null) : await getTab();
  if (!tab) return;
  await browser.tabs.update(tab.id, { active: true });
  await browser.windows.update(tab.windowId, { focused: true });
  if (entry.ref) await runAgent(tab, "flashRef", { ref: entry.ref }).catch(() => {});
}

// Stop pressed on the in-page "driving this tab" pill. Only the bridge's content
// script can send this; scripts on the page itself have no access to runtime messaging.
browser.runtime.onMessage.addListener((message, sender) => {
  if (message?.type !== "page:stop" || !sender.tab) return undefined;
  setControl("stopped");
  return Promise.resolve(true);
});

// ---- Pictures of what the agent did: popup thumbnails and the GIF recorder ----

// Tools whose effect shows on the page, so a picture after them is worth taking.
const VISUAL_TOOLS = new Set([
  "click", "double_click", "triple_click", "type", "press_key", "form_input", "hover", "scroll",
  "navigate", "batch", "emulate_device", "stop_emulation",
]);
const MAX_FRAMES = 150;
let recording = null; // { tabId, frames: [{ dataUrl, label }], skipped }

function isRecording() {
  return recording != null;
}

// After a call: a frame for the recording, and a thumbnail of the element it used.
// Works on background tabs too, so the user can keep using another one.
async function afterCall(entry, method, params, failed) {
  if (!VISUAL_TOOLS.has(method)) return;
  const tab = await getTab(params.tabId).catch(() => null);
  if (!tab) return;
  const recordingThis = recording?.tabId === tab.id;
  if (!recordingThis && !entry.ref) return;
  const rect = entry.ref ? await runAgent(tab, "rectOf", { ref: entry.ref }).catch(() => null) : null;
  if (!recordingThis && !rect) return;
  let dataUrl;
  try {
    dataUrl = await captureTab(tab, { format: "jpeg", quality: 80, scale: 1 }, { keepFlash: true });
  } catch (error) {
    if (recordingThis) recording.skipped++;
    throw error;
  }
  if (recordingThis && recording.frames.length < MAX_FRAMES) {
    const label = entry.outcome || `${entry.tool} ${entry.detail}`;
    recording.frames.push({ dataUrl, label: failed ? `Failed: ${label}` : label });
  }
  if (rect) {
    entry.thumb = cropImage(await loadImage(dataUrl), rect, { padX: 24, padY: 16, maxWidth: 160, outline: null });
    stateChanged();
  }
}

async function gifStart({ tabId }) {
  const tab = await getTab(tabId);
  recording = { tabId: tab.id, frames: [], skipped: 0 };
  const dataUrl = await captureTab(tab, { format: "jpeg", quality: 80, scale: 1 });
  recording.frames.push({ dataUrl, label: `Start: ${tab.title}` });
  return `Recording tab ${tab.id}. A frame is taken after each action, even while another tab is showing. ` +
    "Call gif_save to finish and save the GIF.";
}

const CAPTION_HEIGHT = 28;

function bytesToBase64(bytes) {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

// Turns the recorded frames into an animated GIF, each with a caption of the action.
async function gifSave({ max_width: maxWidth = 960, frame_seconds: frameSeconds = 1.2 }) {
  if (!recording) throw new Error("Nothing is being recorded. Call gif_start first.");
  const { frames, skipped } = recording;
  recording = null;
  if (!frames.length) {
    throw new Error("No frames were taken during the recording. Nothing was saved.");
  }
  const images = await Promise.all(frames.map((frame) => loadImage(frame.dataUrl)));
  const scale = Math.min(1, maxWidth / images[0].width);
  const width = Math.round(images[0].width * scale);
  const shotHeight = Math.round(images[0].height * scale);
  const height = shotHeight + CAPTION_HEIGHT;
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const delay = Math.round(frameSeconds * 100);

  const encoded = images.map((image, i) => {
    context.fillStyle = "#1f1d2b";
    context.fillRect(0, 0, width, height);
    context.drawImage(image, 0, 0, width, shotHeight);
    context.fillStyle = "#f4f4f6";
    context.font = "14px system-ui, sans-serif";
    let caption = `${i + 1}/${images.length}  ${frames[i].label}`;
    while (caption.length > 4 && context.measureText(caption).width > width - 20) caption = `${caption.slice(0, -2)}…`;
    context.fillText(caption, 10, shotHeight + 19);
    const rgba = context.getImageData(0, 0, width, height).data;
    return { rgba, delay: i === images.length - 1 ? delay * 2 : delay };
  });
  const bytes = encodeGif(encoded, width, height);
  return { type: "gif", data: bytesToBase64(bytes), frames: images.length, width, height, bytes: bytes.length, skipped };
}
