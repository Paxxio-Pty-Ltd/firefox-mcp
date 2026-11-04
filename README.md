# Firefox MCP Bridge

Let an MCP client read and drive **your own Firefox**: the browser you're already logged in to. It opens tabs,
reads pages, clicks, types, fills forms, calls the page's API, takes screenshots and records runs, while you keep
control of what it's allowed to do.

- **Cheap to read.** Pages come back as short text lines with refs, not screenshots. An outline of a long article
  is about 4 KB, and you then read only the section you need.
- **Careful with actions.** Every action waits for its target, reports what changed (URL, toasts, API calls,
  dialogs), and says whether a failure is safe to retry.
- **You stay in charge.** Risky buttons wait for your approval, each site can be read-only, and Pause / Stop are
  one click away in the toolbar and on the page.
- **No network port.** The MCP server reaches Firefox through a Unix socket only your user can open.

Works on macOS and Linux with Firefox 142 or later.

## Contents

- [How it works](#how-it-works)
- [Install](#install)
- [Connect your MCP client](#connect-your-mcp-client)
- [Tools](#tools)
- [Reading pages cheaply](#reading-pages-cheaply)
- [Acting on a page](#acting-on-a-page)
- [Safety and control](#safety-and-control)
- [Seeing what the agent does](#seeing-what-the-agent-does)
- [Phone and tablet views](#phone-and-tablet-views)
- [Flutter web apps](#flutter-web-apps)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Contributing, security and licence](#contributing-security-and-licence)

## How it works

```
MCP client ──stdio──> server/src/mcp-server.js
                            │  Unix socket (~/.firefox-mcp/bridge.sock)
                            ▼
                      server/src/native-host.js   (started by Firefox)
                            │  native messaging (stdin/stdout)
                            ▼
                      extension/  (background script + in-page agent)
```

- Firefox starts the native host when the extension loads and stops it when Firefox quits.
- Each MCP client launches its own `mcp-server.js`. Several can be connected at once.
- No network port is opened. The only way in is the socket in `~/.firefox-mcp`, a directory only your user can open.

## Install

You need **Node 18+** and **Firefox Developer Edition, Nightly or ESR**. Regular Firefox only installs signed
add-ons, and this one isn't signed yet (see [ROADMAP.md](ROADMAP.md)).

```sh
git clone https://github.com/Paxxio-Pty-Ltd/firefox-mcp.git
cd firefox-mcp
./install.sh
```

`install.sh` installs the server's dependencies, registers the native host with Firefox, builds
`dist/firefox-mcp-<version>.xpi`, and prints the command your MCP client should run.

Then, in Firefox:

1. Open `about:config` and set `xpinstall.signatures.required` to `false`.
2. Open `about:addons`, click the gear icon, choose **Install Add-on From File…** and pick the `.xpi`.
3. Accept the permissions it asks for.

The toolbar icon shows **ON** while a client is connected; its tooltip explains the state when it isn't.

Re-run `./install.sh` after moving the repository or changing Node version, because the host launcher stores
absolute paths. To update, `git pull`, run `./install.sh` again and install the new `.xpi` over the old one.

## Connect your MCP client

Any MCP client that can launch a stdio server works. Add the command `install.sh` printed, for example:

```json
{
  "mcpServers": {
    "firefox": {
      "command": "node",
      "args": ["/path/to/firefox-mcp/server/src/mcp-server.js"]
    }
  }
}
```

Use the absolute path to `node` that `install.sh` printed if your client starts servers with a minimal `PATH`.

## Tools

| Tool | What it does |
| --- | --- |
| `tabs_context` | List open tabs with ids, titles, URLs, when each was last used and whether you or the agent opened it |
| `tabs_create` / `tabs_close` | Open or close a tab. Agent tabs go into a cyan **Agent** tab group |
| `navigate` | Load a URL, or `back` / `forward` / `reload` |
| `read_page` | Headings and controls with refs (`interactive`), or a full indented tree (`all`). `depth` gives a folded outline, `ref` reads one region or section, `skip_nav` drops sidebars, `boxes` adds positions |
| `find` | Find visible elements by text, label, placeholder or link, filtered by `role`, `exact` or `ref`. Controls come first |
| `get_page_text` | Readable text of the page, of one element, or of a heading's section |
| `click` / `double_click` / `triple_click` / `hover` | By ref or viewport coordinates. Clicks report what changed and what text got selected |
| `type` / `press_key` | Text input and keys (Enter submits forms, Tab moves focus) |
| `form_input` | Set selects, checkboxes, radios and inputs directly |
| `batch` | Several actions in one call, with one report of what changed |
| `wait_for` | Wait for text to appear or go, a selector to show, a ref to change state, or API calls to finish |
| `request_user_input` | Ask you to fill a field yourself (passwords, keys). The agent only learns `filled, N chars` or `skipped` |
| `scroll` | Page or inner scroll area, or scroll a ref into view |
| `screenshot` | JPEG of a tab's visible area, without switching to it. Password and secret fields are blacked out |
| `javascript` | Run code in the page and return the result |
| `page_fetch` | Call the web app's own API from the page, with its cookies and `Authorization` header |
| `read_console_messages` | Console output and uncaught errors since the page loaded |
| `read_network_requests` | Recent requests with status, optionally with what API calls sent and got back |
| `emulate_device` / `stop_emulation` | View a tab as a phone or tablet in its own window, then put it back |
| `viewport_check` | Viewport size and any horizontal overflow, naming the elements causing it |
| `resize_window` | Resize a window (every tab in it) |
| `wait` | Pause for up to 30 seconds |
| `gif_start` / `gif_save` | Record a tab as an animated GIF, a captioned frame per action, saved to a file |

## Reading pages cheaply

Every element the agent can use gets a ref, such as `[ref_8] button "Save"`, which the action tools take.

A full `read_page` of a busy page lists every sidebar link and table button. Read an outline first and open only
the region you need:

```
read_page({ depth: 2, skip_nav: true })
→ [ref_12] main
    [ref_13] heading h2 "Invoices"
    [ref_14] form "Filters" (folded: 3 controls, starts "Search Status Apply")
    [ref_18] table (folded: 40 controls, starts "No Client INV-1 Alpha…")
  (Skipped navigation: [ref_4] complementary. Read one by passing its ref.)

read_page({ ref: "ref_14" })                                   → only the filter form
find({ query: "edit", role: "button", ref: "ref_18", limit: 2 }) → is the match unique?
```

- **Articles and docs** fold by heading: `[ref_23] heading h2 "Security" (folded: 38 controls, starts "…")`. A
  heading's ref covers its section, so `read_page`, `get_page_text` and `find` with that ref read or search just
  that section.
- **`find`** lists controls first, then headings, then text, and says how many matches it left out
  (`…and 3 more`). Paragraphs, list items and table cells match on all their text, links included.
- **Every read starts with what's on screen**, such as `On screen: error "Email is invalid"`, so a result banner
  doesn't need a screenshot.
- **Re-rendered elements** (React, Angular) keep their refs: a ref is found again by its role, name and the
  landmark around it, but only when exactly one element matches, and never for one of several identical buttons.
- **A read that hits its size limit** lists the regions it didn't reach, with refs.
- **Screenshots are expensive.** A 1600×1000 screenshot costs roughly 2,000 tokens; an outline of the same page is
  usually a few hundred. Use screenshots for questions that are really about looks.

## Acting on a page

Before an action, `click`, `type`, `hover` and `form_input` wait up to 5 seconds for their element to be visible,
enabled and not under a dialog, backdrop or spinner. If it never gets there, they fail without acting and name
what's in the way.

After an action they wait up to 3 seconds for the navigation and API calls it started, then report what changed:

```
Clicked [ref_8] button "Save" at (29, 265).
What changed:
- Message: "Settings saved"
- API: PUT /api/settings → 200
- Opened: [ref_31] dialog "Confirm" "Really publish?" with [ref_32] button "Publish"
```

The report covers URL changes, toasts and alerts, API calls with their status, dialogs and menus that opened (with
a ref to read just them), elements added or removed, and state changes such as `aria-invalid` or `disabled`.

Errors say whether a retry is safe: one raised before anything reached the page ends with **"Nothing was done."**;
any other says the action may have gone through, so the agent reads the page before trying again.

`batch` runs several steps in one call, such as filling a form and pressing Save, and stops at the first failure.
`wait_for` replaces fixed sleeps: it waits for text, a selector, a ref's state or quiet network, and keeps waiting
across page loads.

## Safety and control

### Approvals

Before pressing a button whose name contains Publish, Delete, Remove, Submit, Pay, Purchase, Buy, Checkout, Place
order, Send, Transfer, Deploy, Revoke, Destroy or Terminate (by click, or Enter / Space), the action pauses. The same
happens if the page sends a POST, PUT, PATCH or DELETE to another site while an action runs ("another site" means a
different registrable domain, so `admin.example.com` calling `api.example.com` doesn't count), and for `page_fetch`
calls other than GET.

While it waits, the toolbar badge turns amber with a count and the element gets an amber outline. Click the toolbar
icon to see a picture of the element, the action, the agent's reason (the optional `reason` argument) and
**Approve**, **Deny** or **Always allow on this site**. Denying, or no answer within 5 minutes, fails the call.
Decisions only come from the popup: neither the page nor the agent can press its buttons.

### Trust levels, Pause and Stop

The toolbar popup sets what the agent may do on the current site:

- **Read only**: reading works; clicking, typing, `javascript` and writing `page_fetch` calls fail.
- **Ask before risky actions** (the default): approvals as above.
- **Everything, no approvals.**

**Pause** makes the agent's next call wait until you press **Resume**; **Stop** makes every call fail until you
resume. While the agent works in a tab, a small pill in its corner says "The agent is driving this tab" with its
own **Stop** button. The pill hides after 8 quiet seconds and never appears in screenshots.

### Secrets and recorded data

`request_user_input` outlines a field with the agent's hint and waits for you to fill it and click **Done** or
**Skip**. The agent gets back only `filled, 36 chars`, `skipped` or `timed out`. Afterwards the value shows as `••••`
in reads and is blacked out in screenshots, as password fields always are.

For tabs the agent has used, the extension keeps in memory the bodies of recent API calls (up to 64 KB each) and the
latest `Authorization` header per API origin, for `read_network_requests` and `page_fetch`. Keys that look like
passwords, tokens or API keys are shown as `••••`. Other tabs are never recorded, and nothing is written to disk.

The `javascript` tool can read anything on a page, including fields. Set sites where that matters to **Read only**.

## Seeing what the agent does

- **Recent actions** in the popup lists the last 30 calls with their arguments, failures in red, a thumbnail of the
  element for calls that used a ref, and roughly how many tokens each added to the agent's context (about 4
  characters per token for text, width × height / 750 for screenshots), with a running total. Clicking an entry
  outlines its element on the page.
- The element being acted on gets a brief green outline labelled with the action, and a ghost cursor glides to
  where a click or hover lands.
- Tabs the agent opens go into a cyan **Agent** tab group. They keep your logins.
- `gif_start` and `gif_save` record a tab as an animated GIF, one captioned frame per action, even while you work in
  another tab. `gif_save` writes the file (by default to `~/Downloads`) and returns its path.

## Phone and tablet views

`emulate_device` moves the tab into its own small window instead of resizing yours:

```
emulate_device({ tabId: 12, device: "iphone-14" })
→ Emulating iPhone 14 390x844 in its own window (windowId 40). Tab 12 keeps its id.
  Viewport: 390x844 CSS px, devicePixelRatio 2.
  Horizontal overflow: the page is 520px wide in a 390px viewport. Sticking out:
  - <div#banner.wide> right edge at 520px "Too wide banner"
```

- The viewport is the device's real CSS width, so media queries, `innerWidth` and screenshots match a phone.
- Presets set a mobile user agent on requests and `navigator`, and report touch support to scripts before the
  page's own scripts run.
- Pass `width` and `height` for any size, `orientation: "landscape"` to turn it, and call again to switch.
- `stop_emulation` moves the tab back and reloads it as a desktop browser.

It can't fake CSS `pointer` / `hover` media queries or the device pixel ratio, and clicks are mouse events, not
touches; Firefox doesn't let extensions change those.

## Flutter web apps

Flutter draws to a canvas. The first `read_page` or `find` on a Flutter page switches on the app's accessibility
mode, which builds a hidden element tree; after that refs, `click`, `type` and `scroll` work as usual.

## Limitations

- **Input is synthetic.** Firefox gives extensions no way to send real OS-level input, so clicks and keys are DOM
  events. They work on most sites, including React and other framework apps, but native file pickers, some
  anti-bot checks, clipboard actions and some lazily loaded widgets (such as Wikipedia's search suggestions while
  the window isn't focused) ignore them.
- **Top frame only.** Content inside iframes isn't read or controlled yet.
- **Shadow DOM text.** `read_page` and `find` see into shadow roots, but `get_page_text` doesn't yet, so code
  blocks drawn by web components can be missing from it.
- **Restricted pages.** Firefox blocks extensions on `about:` pages, `addons.mozilla.org` and other built-in pages.
- `javascript` runs in the page's own context, so a page whose Content Security Policy blocks `eval` rejects it.
- Console capture starts when a page loads; pages open before the extension was installed need a reload.
- macOS and Linux only for now.

## Troubleshooting

- **"Firefox isn't connected"**: Firefox isn't running, the extension isn't installed, or `install.sh` hasn't been
  run. Check the toolbar icon's tooltip.
- **Native host log**: `~/.firefox-mcp/native-host.log`.
- **Extension log**: `about:debugging#/runtime/this-firefox` → Firefox MCP Bridge → **Inspect**.
- **It stopped working after a Node upgrade or moving the folder**: run `./install.sh` again.
- **The add-on vanished after an update**: the permission prompt was probably closed. Install the `.xpi` again and
  accept it.

## Development

```
extension/
  background/   tools, network capture, approvals, activity log, GIF encoder, native messaging
  content/      agent.js: the in-page reader and input, injected on demand
  page/         console capture, run in the page's own world
  popup/        toolbar popup
server/src/     MCP server, native host, socket client
```

There's no build step: `build.sh` zips `extension/` into `dist/`.

To test without touching your everyday Firefox, give a second Firefox and the MCP server their own state directory
(Unix socket paths are limited to about 100 characters, so keep it short):

```sh
FIREFOX_MCP_STATE_DIR=~/.firefox-mcp-test npx web-ext run --source-dir extension --arg=--headless
FIREFOX_MCP_STATE_DIR=~/.firefox-mcp-test node server/src/mcp-server.js
```

The native host inherits the variable from Firefox, so the test bridge gets its own socket. Approvals and the
popup's buttons can't be tested headless, because only a real click decides them.

## Contributing, security and licence

- Read [CONTRIBUTING.md](CONTRIBUTING.md) before opening an issue or pull request. It says what to include and what
  not to paste.
- Report security problems privately, as described in [SECURITY.md](SECURITY.md).
- Planned work is in [ROADMAP.md](ROADMAP.md); changes are in [CHANGELOG.md](CHANGELOG.md).
- MIT licensed. See [LICENSE](LICENSE).
