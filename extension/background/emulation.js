// Phone and tablet views that leave the user's windows alone. The tab moves into
// its own popup window sized so its viewport matches the device, and the tab's
// requests and navigator report the device's user agent. stop_emulation puts the
// tab back where it came from.
const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const IPAD_UA =
  "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const ANDROID_UA = (model) =>
  `Mozilla/5.0 (Linux; Android 14; ${model}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36`;

const DEVICES = {
  "iphone-se": { name: "iPhone SE", width: 375, height: 667, userAgent: IOS_UA, platform: "iPhone" },
  "iphone-14": { name: "iPhone 14", width: 390, height: 844, userAgent: IOS_UA, platform: "iPhone" },
  "iphone-15": { name: "iPhone 15", width: 393, height: 852, userAgent: IOS_UA, platform: "iPhone" },
  "iphone-15-pro-max": { name: "iPhone 15 Pro Max", width: 430, height: 932, userAgent: IOS_UA, platform: "iPhone" },
  "pixel-8": { name: "Pixel 8", width: 412, height: 915, userAgent: ANDROID_UA("Pixel 8"), platform: "Linux armv8l" },
  "galaxy-s23": { name: "Galaxy S23", width: 360, height: 780, userAgent: ANDROID_UA("SM-S911B"), platform: "Linux armv8l" },
  "ipad-mini": { name: "iPad mini", width: 768, height: 1024, userAgent: IPAD_UA, platform: "iPad" },
  "ipad-pro": { name: "iPad Pro 12.9", width: 1024, height: 1366, userAgent: IPAD_UA, platform: "iPad" },
};

const emulatedTabs = new Map(); // tabId -> { label, width, height, userAgent, platform, touch, windowId, home }

function emulationLabel(tabId) {
  return emulatedTabs.get(tabId)?.label;
}

function resolveDevice({ device, width, height, orientation, userAgent, touch }) {
  let spec;
  if (device) {
    spec = DEVICES[device];
    if (!spec) throw new Error(`Unknown device "${device}". Choose one of: ${Object.keys(DEVICES).join(", ")}.`);
  } else {
    if (!width || !height) throw new Error("Give a device, or both width and height.");
    spec = { name: "Custom", width, height, userAgent: undefined, platform: undefined };
  }
  let w = width ?? spec.width;
  let h = height ?? spec.height;
  if (orientation === "landscape" ? w < h : orientation === "portrait" && w > h) [w, h] = [h, w];
  const ua = userAgent ?? spec.userAgent;
  const isTouch = touch ?? Boolean(device);
  return {
    label: `${spec.name} ${w}x${h}`,
    width: w,
    height: h,
    userAgent: ua,
    platform: userAgent ? undefined : spec.platform,
    touch: isTouch,
  };
}

// Serialised into the page on every navigation, so it must not use anything outside itself.
// Runs either in the page's own world, or as a content script, where the page's objects
// are reached through wrappedJSObject and functions handed to it go through exportFunction.
function applyDeviceOverrides({ userAgent, platform, touch }) {
  const page = window.wrappedJSObject ?? window;
  const expose = typeof exportFunction === "function" ? (fn) => exportFunction(fn, window) : (fn) => fn;
  if (page.__fxmcpDevice) return;
  page.__fxmcpDevice = true;
  const define = (name, value) => {
    try {
      Object.defineProperty(page.Navigator.prototype, name, { get: expose(() => value), configurable: true });
    } catch {}
  };
  if (userAgent && navigator.userAgent !== userAgent) {
    define("userAgent", userAgent);
    define("appVersion", userAgent.replace(/^Mozilla\//, ""));
  }
  if (platform) define("platform", platform);
  if (!touch) return;
  define("maxTouchPoints", 5);
  if (!("ontouchstart" in page)) page.ontouchstart = null;
  // CSS media queries keep the desktop pointer, but scripts asking matchMedia get the
  // touch answer: swapping each pointer/hover feature for its opposite inverts the result.
  const swaps = { coarse: "fine", fine: "coarse", none: "hover", hover: "none" };
  const realMatchMedia = page.matchMedia;
  page.matchMedia = expose((query) =>
    realMatchMedia.call(page, String(query).replace(
      /\(\s*(any-pointer|pointer|any-hover|hover)\s*:\s*(coarse|fine|none|hover)\s*\)/gi,
      (match, feature, value) => {
        const isPointer = /pointer/i.test(feature);
        // pointer: none and hover: fine/coarse aren't swaps; leave them alone.
        if (isPointer !== ["coarse", "fine"].includes(value.toLowerCase())) return match;
        return `(${feature}: ${swaps[value.toLowerCase()]})`;
      }
    )));
}

// Firefox reports the User-Agent header we set as navigator.userAgent, so a content script
// registered for every page can tell an emulated tab by its user agent and apply the
// overrides before the page's own scripts run. Re-registered whenever emulation changes.
let overrideScript = null;
let overrideSync = Promise.resolve();

function syncOverrideScript() {
  overrideSync = overrideSync.then(async () => {
    await overrideScript?.unregister().catch(() => {});
    overrideScript = null;
    const byAgent = {};
    for (const { userAgent, platform, touch } of emulatedTabs.values()) {
      if (userAgent) byAgent[userAgent] = { userAgent, platform, touch };
    }
    if (!Object.keys(byAgent).length) return;
    overrideScript = await browser.contentScripts.register({
      matches: ["<all_urls>"],
      allFrames: true,
      matchAboutBlank: true,
      runAt: "document_start",
      js: [{
        code: `(() => { const settings = ${JSON.stringify(byAgent)}[navigator.userAgent]; ` +
          `if (settings) (${applyDeviceOverrides})(settings); })();`,
      }],
    });
  });
  return overrideSync;
}

// For overrides the content script can't key on (no user agent change), and for a page
// that loaded before emulation started. Runs after the page's first scripts.
async function injectOverrides(tabId, frameIds) {
  const state = emulatedTabs.get(tabId);
  if (!state) return;
  const { userAgent, platform, touch } = state;
  if (!userAgent && !platform && !touch) return;
  await browser.scripting.executeScript({
    target: frameIds ? { tabId, frameIds } : { tabId, allFrames: true },
    world: "MAIN",
    injectImmediately: true,
    func: applyDeviceOverrides,
    args: [{ userAgent, platform, touch }],
  }).catch(() => {});
}

// Popup windows are sized from the outside, so resize until the tab's content area matches.
async function fitViewport(windowId, tabId, width, height) {
  for (let attempt = 0; attempt < 4; attempt++) {
    const tab = await browser.tabs.get(tabId);
    const dw = width - tab.width;
    const dh = height - tab.height;
    if (!dw && !dh) return tab;
    const win = await browser.windows.get(windowId);
    await browser.windows.update(windowId, { width: win.width + dw, height: win.height + dh });
    await sleep(150);
  }
  return browser.tabs.get(tabId);
}

// Serialised and run in the page. Finds what makes the page wider than the viewport:
// the outermost elements that stick out while their parent doesn't, and aren't clipped by it.
function measureLayout() {
  const doc = document.documentElement;
  const viewport = doc.clientWidth;
  const culprits = [];
  if (doc.scrollWidth > viewport) {
    const clips = (el) => el && /hidden|clip|auto|scroll/.test(getComputedStyle(el).overflowX);
    for (const el of document.body?.querySelectorAll("*") ?? []) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.right <= viewport + 1) continue;
      const parent = el.parentElement;
      if (parent && parent !== document.body && parent.getBoundingClientRect().right > viewport + 1) continue;
      let clipped = false;
      for (let up = parent; up && up !== document.body; up = up.parentElement) {
        if (clips(up) && up.getBoundingClientRect().right <= viewport + 1) {
          clipped = true;
          break;
        }
      }
      if (clipped) continue;
      const id = el.id ? `#${el.id}` : "";
      const classes = [...el.classList].slice(0, 3).map((c) => `.${c}`).join("");
      const text = (el.innerText || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 40);
      culprits.push(`<${el.tagName.toLowerCase()}${id}${classes}> right edge at ${Math.round(rect.right)}px` +
        `${text ? ` "${text}"` : ""}`);
      if (culprits.length >= 8) break;
    }
  }
  return {
    viewport: `${innerWidth}x${innerHeight}`,
    layoutWidth: viewport,
    scrollWidth: doc.scrollWidth,
    devicePixelRatio,
    userAgent: navigator.userAgent,
    culprits,
  };
}

async function describeLayout(tab) {
  let layout;
  try {
    [{ result: layout }] = await browser.scripting.executeScript({ target: { tabId: tab.id }, func: measureLayout });
  } catch {
    return `Viewport: ${tab.width}x${tab.height} (can't measure this page's layout).`;
  }
  const lines = [`Viewport: ${layout.viewport} CSS px, devicePixelRatio ${layout.devicePixelRatio}.`];
  if (layout.scrollWidth > layout.layoutWidth) {
    lines.push(`Horizontal overflow: the page is ${layout.scrollWidth}px wide in a ${layout.layoutWidth}px viewport. Sticking out:`);
    lines.push(...layout.culprits.map((c) => `- ${c}`));
  } else {
    lines.push("No horizontal overflow.");
  }
  return lines.join("\n");
}

const EMULATION_TOOLS = {
  async emulate_device({ tabId, device, width, height, orientation, userAgent, touch, reload = true }) {
    const tab = await getTab(tabId);
    const spec = resolveDevice({ device, width, height, orientation, userAgent, touch });
    let state = emulatedTabs.get(tab.id);
    if (!state) {
      const home = { windowId: tab.windowId, index: tab.index, active: tab.active };
      const win = await browser.windows.create({ tabId: tab.id, type: "popup", width: spec.width, height: spec.height + 80 });
      state = { windowId: win.id, home };
    }
    Object.assign(state, spec);
    emulatedTabs.set(tab.id, state);
    await syncOverrideScript();

    const fitted = await fitViewport(state.windowId, tab.id, spec.width, spec.height);
    if (reload) {
      await browser.tabs.reload(tab.id);
      await waitForLoad(tab.id);
    } else {
      await injectOverrides(tab.id);
    }

    const lines = [`Emulating ${spec.label} in its own window (windowId ${state.windowId}). Tab ${tab.id} keeps its id.`];
    if (fitted.width !== spec.width || fitted.height !== spec.height) {
      lines.push(`Firefox only allowed a ${fitted.width}x${fitted.height} viewport for this window.`);
    }
    lines.push(spec.userAgent ? `User agent: ${spec.userAgent}` : "User agent: unchanged.");
    if (spec.touch) lines.push("Touch: navigator.maxTouchPoints and matchMedia report touch; CSS media queries still see a mouse.");
    if (!reload) lines.push("Not reloaded, so the server and scripts that already ran saw the old user agent.");
    lines.push(await describeLayout(await browser.tabs.get(tab.id)));
    lines.push("Call stop_emulation to put the tab back in its window.");
    return lines.join("\n");
  },

  async stop_emulation({ tabId, reload = true }) {
    const tab = await getTab(tabId);
    const state = emulatedTabs.get(tab.id);
    if (!state) return `Tab ${tab.id} isn't being emulated.`;
    emulatedTabs.delete(tab.id);
    await syncOverrideScript();

    let homeId = state.home.windowId;
    const homeExists = await browser.windows.get(homeId).then(() => true, () => false);
    if (homeExists) {
      await browser.tabs.move(tab.id, { windowId: homeId, index: state.home.index });
    } else {
      // The tab was alone in its window, which closed when the tab left.
      const win = await browser.windows.create({ tabId: tab.id, type: "normal" });
      homeId = win.id;
    }
    if (state.home.active) await browser.tabs.update(tab.id, { active: true });
    // The popup closes by itself once its only tab has left; this covers the case where it didn't.
    await browser.windows.remove(state.windowId).catch(() => {});
    if (reload && (state.userAgent || state.touch)) {
      await browser.tabs.reload(tab.id);
      await waitForLoad(tab.id);
    }
    return `Stopped emulating ${state.label}. Tab ${tab.id} is back in window ${homeId}.`;
  },

  async viewport_check({ tabId }) {
    const tab = await getTab(tabId);
    const label = emulationLabel(tab.id);
    return `${label ? `Emulating ${label}.` : "Not emulating a device."}\n${await describeLayout(tab)}`;
  },
};

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const userAgent = emulatedTabs.get(details.tabId)?.userAgent;
    if (!userAgent) return undefined;
    const headers = details.requestHeaders.filter((h) => h.name.toLowerCase() !== "user-agent");
    headers.push({ name: "User-Agent", value: userAgent });
    return { requestHeaders: headers };
  },
  { urls: ["<all_urls>"] },
  ["blocking", "requestHeaders"]
);
browser.webNavigation.onCommitted.addListener((details) => {
  if (emulatedTabs.has(details.tabId)) injectOverrides(details.tabId, [details.frameId]);
});
browser.tabs.onRemoved.addListener((tabId) => {
  if (emulatedTabs.delete(tabId)) syncOverrideScript();
});
// Closing the device window closes its tab, but a tab dragged out of it is no longer emulated.
browser.tabs.onAttached.addListener((tabId, { newWindowId }) => {
  const state = emulatedTabs.get(tabId);
  if (state && state.windowId !== newWindowId) {
    emulatedTabs.delete(tabId);
    syncOverrideScript();
  }
});
