#!/usr/bin/env node
// MCP server (stdio) exposing Firefox browser tools. Each call is forwarded to
// the extension through the native host's Unix socket.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BridgeClient } from "./bridge-client.js";

const bridge = new BridgeClient();
const server = new McpServer({ name: "firefox", version: "0.6.0" });

const tabId = z.number().int().optional()
  .describe("Tab to act on. Defaults to the active tab of the focused window. Get ids from tabs_context.");
const ref = z.string().optional()
  .describe('Element ref from read_page or find, e.g. "ref_12".');
const reason = z.string().optional()
  .describe("One line on why you're doing this. Shown to the user if the action needs their approval.");

// Actions can wait up to 5 minutes for the user to approve them in the toolbar.
const ACTION_TIMEOUT_MS = 6 * 60 * 1000;
const ACTION_NOTE =
  " Waits up to 5s for the element to be visible, enabled and not under a dialog or spinner. Returns what changed: " +
  "URL, toasts, API calls, elements added or removed, and dialogs or menus that opened (with a ref to read just them). " +
  "Risky buttons (Publish, Delete, Submit, Pay…) and POSTs to another site wait for the user's approval. " +
  'An error saying "Nothing was done" is safe to retry; otherwise read the page first.';

function toContent(result) {
  if (result?.type === "image") {
    return { content: [{ type: "image", data: result.data, mimeType: result.mimeType }] };
  }
  const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
  return { content: [{ type: "text", text }] };
}

function browserTool(name, description, inputSchema = {}, timeoutMs = undefined) {
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      return toContent(await bridge.call(name, args, typeof timeoutMs === "function" ? timeoutMs(args) : timeoutMs));
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  });
}

browserTool("tabs_context",
  "List every open Firefox tab with its tabId, windowId, title, URL and which one is active. Call this first to find the tab to work in.");

browserTool("tabs_create",
  "Open a new tab, optionally at a URL, and wait for it to load. Prefer working in a tab you created rather than one the user is using. " +
  'It goes into a cyan "Agent" tab group so the user can tell it apart.',
  {
    url: z.string().optional().describe("URL to open. A missing scheme defaults to https://."),
    active: z.boolean().optional().describe("Switch to the new tab. Defaults to true."),
    group: z.boolean().optional().describe('Put it in the "Agent" tab group. Defaults to true.'),
  });

browserTool("tabs_close", "Close a tab.", { tabId: z.number().int() });

browserTool("navigate",
  'Load a URL in a tab and wait for it to finish loading. Pass "back", "forward" or "reload" instead of a URL to use history.',
  { tabId, url: z.string().describe('URL, or "back" / "forward" / "reload".') });

const scopeRef = z.string().optional()
  .describe("Read only inside this element (a ref from read_page or find), e.g. a dialog, form or folded region.");
const boxes = z.boolean().optional()
  .describe("Add each element's box in viewport CSS pixels, as @x,y widthxheight, for layout questions.");
const skipNav = z.boolean().optional()
  .describe("Leave out <nav>, <aside> and sidebars (pagination is kept). Their refs are listed so you can read one.");

browserTool("read_page",
  "Read the page as a list of elements with refs you can pass to click, type and form_input. " +
  "Flutter web apps have their accessibility mode switched on automatically so they can be read. " +
  '"interactive" (default) lists headings and controls; "all" adds text and landmarks as an indented tree. ' +
  "On a big page, read an outline first (depth: 2), then the region you need by its ref, and after an action " +
  "re-read only that region.",
  {
    tabId,
    filter: z.enum(["interactive", "all"]).optional(),
    ref: scopeRef,
    depth: z.number().int().min(1).optional().describe(
      "Outline: indent controls under their landmarks, dialogs, lists and tables, and fold anything this many " +
      "containers down into one line with its ref and how many controls it holds."),
    skip_nav: skipNav,
    boxes,
  });

browserTool("get_page_text",
  "Get the visible text of the page (the main/article element if there is one), or of one element. Best for reading content.",
  { tabId, ref: scopeRef, skip_nav: skipNav });

browserTool("find",
  "Find visible elements whose label, text, placeholder or link contains all the given words, and/or that have a role. " +
  "Controls are listed first, then headings, then text. Says how many more matched beyond the limit, so " +
  "limit: 2 tells you whether a match is unique. Returns refs.",
  {
    tabId,
    query: z.string().optional(),
    role: z.string().optional().describe(
      'Only these roles, e.g. "button", "link", "textbox", "checkbox", "heading" or "text", comma-separated. ' +
      '"input" means any text field, "select" any dropdown, "control" anything clickable.'),
    exact: z.boolean().optional().describe("The whole name must equal the query (ignoring case), not just contain its words."),
    ref: z.string().optional().describe("Search only inside this element."),
    limit: z.number().int().optional().describe("Defaults to 25."),
    boxes,
  });

browserTool("click",
  "Click an element by ref, or at viewport coordinates (CSS pixels, as in screenshot). Scrolls the element into view first and waits for any navigation and API calls it starts." +
  ACTION_NOTE,
  {
    tabId,
    ref,
    reason,
    x: z.number().optional(),
    y: z.number().optional(),
    button: z.enum(["left", "right", "middle"]).optional(),
    clickCount: z.number().int().min(1).max(3).optional().describe("2 for a double click."),
    modifiers: z.array(z.enum(["Shift", "Ctrl", "Alt", "Meta"])).optional(),
  },
  ACTION_TIMEOUT_MS);

const clickArgs = {
  tabId,
  ref,
  reason,
  x: z.number().optional(),
  y: z.number().optional(),
  modifiers: z.array(z.enum(["Shift", "Ctrl", "Alt", "Meta"])).optional(),
};

browserTool("double_click", "Double-click an element by ref or coordinates. On text it selects the word." + ACTION_NOTE,
  clickArgs, ACTION_TIMEOUT_MS);

browserTool("triple_click",
  "Triple-click an element by ref or coordinates. Selects all of a text field, or the whole paragraph of text." + ACTION_NOTE,
  clickArgs, ACTION_TIMEOUT_MS);

browserTool("hover", "Move the mouse over an element by ref or coordinates, e.g. to open a hover menu.",
  { tabId, ref, x: z.number().optional(), y: z.number().optional() });

browserTool("type",
  "Type text into a text field or rich-text editor. Uses the ref if given, otherwise the focused element. " +
  "Never use it for secrets such as passwords or API keys; use request_user_input so the user types them." +
  ACTION_NOTE,
  {
    tabId,
    ref,
    text: z.string(),
    clear: z.boolean().optional().describe("Replace the existing content instead of appending."),
    submit: z.boolean().optional().describe("Press Enter afterwards."),
    reason,
  },
  ACTION_TIMEOUT_MS);

browserTool("press_key",
  'Press a key or combination on the focused element (or ref), e.g. "Enter", "Escape", "Tab", "ArrowDown", "Control+a".' +
  ACTION_NOTE,
  { tabId, key: z.string(), ref, reason },
  ACTION_TIMEOUT_MS);

browserTool("form_input",
  "Set a form control's value directly: option text or value for a select, true/false for a checkbox or radio, text for inputs. " +
  "Returns what changed, e.g. validation messages and API calls.",
  { tabId, ref: z.string(), value: z.union([z.string(), z.boolean(), z.number()]) },
  ACTION_TIMEOUT_MS);

browserTool("request_user_input",
  "Ask the user to fill in a field themselves, for secrets you must not see (passwords, API keys, tokens). " +
  'Returns only "filled, N chars", "skipped" or "timed out", never the value. Click Save yourself afterwards.',
  {
    tabId,
    ref: z.string().describe("The text field to fill, from read_page or find."),
    hint: z.string().describe('What to put there, e.g. "Paste the API key from your password manager".'),
    timeout: z.number().int().min(10).max(900).optional().describe("Seconds to wait. Defaults to 300."),
  },
  ({ timeout = 300 }) => (timeout + 30) * 1000);

browserTool("scroll",
  "Scroll the page (or the scrollable area under the given point / viewport centre) by screens, or scroll an element into view by ref. " +
  "Falls back to mouse-wheel events for canvas apps such as Flutter web.",
  {
    tabId,
    direction: z.enum(["up", "down", "left", "right"]).optional(),
    amount: z.number().optional().describe("Screens to scroll. Defaults to 1."),
    ref,
    x: z.number().optional().describe("Scroll the area under this viewport point instead of the centre."),
    y: z.number().optional(),
  });

browserTool("screenshot",
  "Take a screenshot of the tab's visible area, without switching to it. Image pixels equal the CSS pixels used by click x/y.",
  { tabId });

browserTool("javascript",
  "Run JavaScript in the page and return the result as text. An expression is returned directly; for multiple statements use `return`. Promises are awaited.",
  { tabId, code: z.string() });

browserTool("page_fetch",
  "Call the web app's own API from the page, with its cookies and the Authorization header of its latest API call. " +
  "Paths are resolved against the origin the app's API calls go to. Only the page's own site. Anything but GET waits " +
  "for the user's approval. Passwords and tokens in the response are hidden.",
  {
    tabId,
    path: z.string().describe('e.g. "/api/invoices?page=1", or a full URL on the same site.'),
    method: z.string().optional().describe("Defaults to GET."),
    body: z.union([z.string(), z.record(z.any()), z.array(z.any())]).optional().describe("An object is sent as JSON."),
    headers: z.record(z.string()).optional(),
    reason,
    max_chars: z.number().int().optional().describe("Longest body to return. Defaults to 20000."),
  },
  ACTION_TIMEOUT_MS);

browserTool("read_console_messages",
  "Read console output and uncaught errors captured since the page loaded.",
  {
    tabId,
    pattern: z.string().optional().describe("Only messages containing this text."),
    onlyErrors: z.boolean().optional(),
    clear: z.boolean().optional().describe("Empty the buffer after reading."),
    limit: z.number().int().optional(),
  });

browserTool("read_network_requests",
  "List the tab's recent network requests with method, status and type, and optionally what API calls sent and got back.",
  {
    tabId,
    pattern: z.string().optional().describe("Only URLs containing this text."),
    onlyErrors: z.boolean().optional().describe("Only failed requests and HTTP 4xx/5xx."),
    clear: z.boolean().optional(),
    limit: z.number().int().optional(),
    bodies: z.boolean().optional().describe(
      "Include request and response bodies of API calls, with passwords and tokens hidden. Only kept for tabs the agent has used."),
    body_chars: z.number().int().optional().describe("Longest body to show per request. Defaults to 2000."),
  });

browserTool("emulate_device",
  "View a tab as a phone or tablet in its own window sized to the device, with its user agent, leaving the user's " +
  "windows alone. The tab keeps its id and logins. Returns the viewport and any horizontal overflow. " +
  "Call again to switch device, stop_emulation when done. Prefer it over resize_window.",
  {
    tabId,
    device: z.enum(["iphone-se", "iphone-14", "iphone-15", "iphone-15-pro-max", "pixel-8", "galaxy-s23", "ipad-mini", "ipad-pro"])
      .optional().describe("Preset. Omit to give width and height yourself."),
    width: z.number().int().min(200).max(2000).optional().describe("Viewport width in CSS px. Overrides the preset's."),
    height: z.number().int().min(200).max(2000).optional().describe("Viewport height in CSS px. Overrides the preset's."),
    orientation: z.enum(["portrait", "landscape"]).optional(),
    userAgent: z.string().optional().describe("Custom user agent. Presets supply one; a custom size keeps Firefox's."),
    touch: z.boolean().optional().describe("Report touch support to scripts. Defaults to true for presets."),
    reload: z.boolean().optional().describe("Reload so the new user agent applies everywhere. Defaults to true."),
  });

browserTool("stop_emulation",
  "Stop emulating a device: the tab goes back to the window and position it came from, and reloads with the normal user agent.",
  { tabId, reload: z.boolean().optional().describe("Reload with the normal user agent. Defaults to true.") });

browserTool("viewport_check",
  "Report the tab's viewport size, devicePixelRatio, device emulation, and whether the page overflows horizontally, " +
  "naming the elements that stick out. Use after navigating while emulating a phone, instead of judging from a screenshot.",
  { tabId });

browserTool("resize_window", "Resize the browser window containing the tab. This changes every tab in that window; to see a page at phone size, use emulate_device.",
  { tabId, width: z.number().int(), height: z.number().int() });

browserTool("wait_for",
  "Wait until the page shows something instead of sleeping: text appears or goes away, a CSS selector shows, a ref " +
  "becomes visible / hidden / gone / enabled / contains a value, or API calls finish. All given conditions must hold. " +
  "Keeps waiting across page loads. Says where the text appeared.",
  {
    tabId,
    text: z.string().optional().describe("Wait for this text to show (ignoring case)."),
    text_gone: z.string().optional().describe("Wait for this text to go away, e.g. \"Loading\"."),
    selector: z.string().optional(),
    ref: z.string().optional(),
    state: z.enum(["visible", "hidden", "gone", "enabled", "value"]).optional().describe("For ref. Defaults to visible."),
    value: z.string().optional().describe('For state "value": the text the field should contain.'),
    network_idle: z.boolean().optional().describe("Also wait until no API calls have been running for 0.5s."),
    timeout: z.number().min(1).max(120).optional().describe("Seconds. Defaults to 10."),
  },
  ({ timeout = 10 }) => (timeout + 15) * 1000);

browserTool("batch",
  "Run several actions in one call, in order, with one report of what changed at the end. Saves a round trip per " +
  "step, e.g. filling a form and pressing Save. Steps are click, double_click, triple_click, type, press_key, " +
  "form_input, hover, scroll, wait and wait_for, each with that tool's arguments (tabId comes from the batch). " +
  "Stops at the first failure and says which steps didn't run.",
  {
    tabId,
    steps: z.array(z.object({
      tool: z.enum(["click", "double_click", "triple_click", "type", "press_key", "form_input", "hover", "scroll", "wait", "wait_for"]),
      args: z.record(z.any()).optional(),
    })).min(1).max(50),
    stop_on_error: z.boolean().optional().describe("Defaults to true."),
  },
  ACTION_TIMEOUT_MS * 2);

browserTool("gif_start",
  "Start recording a tab as an animated GIF, e.g. to show a client a run. A frame is taken after each action, with " +
  "the action's outline and a caption, even while the user is in another tab. Finish with gif_save.",
  { tabId });

server.registerTool("gif_save",
  {
    description: "Stop recording and save the GIF to a file. Returns its path, frame count and size.",
    inputSchema: {
      path: z.string().optional().describe("Where to save it. Defaults to ~/Downloads/firefox-mcp-<date>-<time>.gif."),
      max_width: z.number().int().min(320).max(1920).optional().describe("Frame width in pixels. Defaults to 960."),
      frame_seconds: z.number().min(0.2).max(10).optional().describe("How long each frame shows. Defaults to 1.2."),
    },
  },
  async ({ path: target, ...args }) => {
    try {
      const gif = await bridge.call("gif_save", args, 120000);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
      const file = path.resolve((target ?? path.join(os.homedir(), "Downloads", `firefox-mcp-${stamp}.gif`))
        .replace(/^~(?=$|\/)/, os.homedir()));
      await fs.mkdir(path.dirname(file), { recursive: true });
      await fs.writeFile(file, Buffer.from(gif.data, "base64"));
      const skipped = gif.skipped ? ` ${gif.skipped} actions had no frame because the tab couldn't be captured.` : "";
      return {
        content: [{
          type: "text",
          text: `Saved ${file}: ${gif.frames} frames, ${gif.width}x${gif.height}, ${Math.round(gif.bytes / 1024)} KB.${skipped}`,
        }],
      };
    } catch (error) {
      return { isError: true, content: [{ type: "text", text: error.message }] };
    }
  });

server.registerTool("wait",
  {
    description: "Wait for a number of seconds, e.g. for a page to finish an animation or background load.",
    inputSchema: { seconds: z.number().min(0).max(30) },
  },
  async ({ seconds }) => {
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    return { content: [{ type: "text", text: `Waited ${seconds}s.` }] };
  });

await server.connect(new StdioServerTransport());
