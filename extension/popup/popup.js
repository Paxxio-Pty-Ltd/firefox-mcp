// Toolbar popup: connection state, Pause / Stop, actions waiting for approval,
// fields waiting for the user, what the agent may do on this site, and its recent
// actions. Decisions are sent to the background script.

const TRUST_LABELS = { read: "Read only", ask: "Ask before risky actions", trusted: "Everything, no approvals" };

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

function button(label, className, onClick) {
  const node = element("button", className, label);
  node.addEventListener("click", async () => {
    node.disabled = true;
    await onClick();
    await render();
  });
  return node;
}

function send(message) {
  return browser.runtime.sendMessage(message);
}

function approvalCard(entry) {
  const card = element("section", "card");
  if (entry.image) {
    const image = element("img");
    image.src = entry.image;
    image.alt = "The element the agent wants to act on";
    card.append(image);
  }
  card.append(element("div", "title", entry.title));
  card.append(element("div", "meta", entry.detail ?? `on ${entry.host}`));
  card.append(element("div", "reason", entry.reason ? `Why: ${entry.reason}` : "No reason given."));
  const buttons = element("div", "buttons");
  buttons.append(
    button("Approve", "approve", () => send({ type: "popup:decide", id: entry.id, decision: "approve" })),
    button("Deny", "deny", () => send({ type: "popup:decide", id: entry.id, decision: "deny" })),
    button(`Always allow on ${entry.host}`, "", () => send({ type: "popup:decide", id: entry.id, decision: "always" })),
  );
  card.append(buttons);
  return card;
}

function inputCard(entry) {
  const card = element("section", "card input");
  card.append(element("div", "title", "A field is waiting for you to fill it in"));
  card.append(element("div", "meta", `on ${entry.host}`));
  if (entry.reason) card.append(element("div", "reason", entry.reason));
  const buttons = element("div", "buttons");
  buttons.append(
    button("Show field", "approve", async () => {
      await send({ type: "popup:show", id: entry.id });
      window.close();
    }),
    button("Skip", "", () => send({ type: "popup:skip-input", id: entry.id })),
  );
  card.append(buttons);
  return card;
}

async function render() {
  const state = await send({ type: "popup:state" });

  const dot = document.getElementById("status-dot");
  dot.classList.toggle("on", state.connected && state.clientCount > 0);
  document.getElementById("status").textContent = !state.connected
    ? "Native host not running (run install.sh)"
    : state.clientCount > 0
      ? `${state.clientCount} client${state.clientCount === 1 ? "" : "s"} connected`
      : "Ready, no clients connected";

  const list = document.getElementById("pending");
  list.replaceChildren(...state.pending.map((entry) => entry.kind === "input" ? inputCard(entry) : approvalCard(entry)));
  document.getElementById("empty").hidden = state.pending.length > 0;

  renderControls(state.control);
  await renderThisSite(state.trust);
  renderActivity(state.activity, state.tokens);

  const configured = Object.entries(state.trust).sort(([a], [b]) => a.localeCompare(b));
  document.getElementById("sites").hidden = configured.length === 0;
  document.getElementById("site-list").replaceChildren(...configured.map(([host, level]) => {
    const item = element("li");
    item.append(
      element("span", "", host),
      element("span", "meta", TRUST_LABELS[level]),
      button("Reset", "", () => send({ type: "popup:set-trust", host, level: "ask" })),
    );
    return item;
  }));
}

function renderControls(control) {
  const controls = document.getElementById("controls");
  const note = document.getElementById("control-note");
  if (control === "running") {
    controls.replaceChildren(
      button("Pause", "", () => send({ type: "popup:control", state: "paused" })),
      button("Stop", "deny", () => send({ type: "popup:control", state: "stopped" })),
    );
    note.hidden = true;
    return;
  }
  controls.replaceChildren(button("Resume", "approve", () => send({ type: "popup:control", state: "running" })));
  note.hidden = false;
  note.textContent = control === "paused"
    ? "Paused: the agent's next call waits until you resume."
    : "Stopped: the agent's calls fail until you resume.";
}

async function renderThisSite(trust) {
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  let host = "";
  try {
    host = /^https?:$/.test(new URL(tab?.url).protocol) ? new URL(tab.url).hostname : "";
  } catch {
    // about: and other pages without a host
  }
  const section = document.getElementById("this-site");
  section.hidden = !host;
  if (!host) return;
  document.getElementById("site-host").textContent = host;
  const select = document.getElementById("trust");
  select.value = trust[host] ?? "ask";
  select.onchange = () => send({ type: "popup:set-trust", host, level: select.value });
}

function formatTokens(n) {
  return n < 1000 ? `${n}` : n < 100000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
}

function renderActivity(activity, tokens) {
  const section = document.getElementById("activity");
  section.hidden = activity.length === 0;
  const total = document.getElementById("token-total");
  const since = new Date(tokens.since).toTimeString().slice(0, 5);
  total.replaceChildren(
    element("span", "", `· ~${formatTokens(tokens.total)} tokens since ${since}`),
    button("Reset", "small", () => send({ type: "popup:reset-tokens" })),
  );
  // The total sits in the list's summary; pressing Reset shouldn't also fold the list.
  total.onclick = (event) => event.preventDefault();
  total.title = "Estimated tokens the agent's calls added to its context: results at about 4 characters " +
    "per token, screenshots by their size, plus the arguments it sent.";
  document.getElementById("activity-list").replaceChildren(...activity.map((entry) => {
    const item = element("li", entry.status);
    const time = new Date(entry.time).toTimeString().slice(0, 8);
    item.append(
      element("span", "time", time),
      element("span", "tool", entry.tool),
      element("span", "detail", entry.detail),
      element("span", "tokens", entry.tokens ? `~${formatTokens(entry.tokens.result + entry.tokens.args)}` : ""),
    );
    if (entry.thumb) {
      const image = element("img", "thumb");
      image.src = entry.thumb;
      image.alt = `The element ${entry.tool} acted on`;
      item.append(image);
    }
    const cost = entry.tokens
      ? `\n~${entry.tokens.result} tokens returned, ~${entry.tokens.args} sent as arguments` : "";
    if (entry.outcome || cost) item.title = `${entry.outcome ?? ""}${cost}`.trim();
    if (entry.ref) {
      item.classList.add("link");
      item.addEventListener("click", async () => {
        await send({ type: "popup:highlight", id: entry.id });
        window.close();
      });
    }
    return item;
  }));
}

browser.runtime.onMessage.addListener((message) => {
  if (message.type === "state-changed") render();
});

render();
