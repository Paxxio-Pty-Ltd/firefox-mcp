# Changelog

## 0.6.0 - 04/11/2026

Getting the repository ready to be public.

### Changed
- The extension's id is now `firefox-mcp@paxxio.co.za`. **Run `./install.sh` again and reinstall the `.xpi`**, because the native host only accepts the id it was registered with. Firefox treats it as a new add-on, so trust levels and allowed sites start fresh.
- The README is rewritten for new users: what the bridge is, install and client setup, every tool, reading cheaply, actions, safety, what's recorded, limitations and development.
- The roadmap lists open work and bigger ideas instead of internal notes.
- Example text in tool descriptions no longer names a client project.

### Added
- MIT licence.
- `CONTRIBUTING.md` with the rules for issues and pull requests, including what not to paste.
- `SECURITY.md`: report vulnerabilities privately, and the threat model.
- Issue forms for bug reports and feature requests (blank issues are off), and a pull request template.
- `server/package.json` names the licence, repository and Node version.

## 0.5.3 - 04/11/2026

Fixes from a run across Hacker News, MDN and GitHub.

### Fixed
- Pages built from web components lost content: an element with `display: contents` has no box of its own, so the walk treated it as hidden and skipped everything inside. MDN's whole article was missing from `read_page`. The walk now goes into such elements.
- A plain table, list or table cell in an action's result was named after all the text inside it (100 characters of a Hacker News table for one click). They're now labelled `table`, `list`, `cell` or `row`, and elements that aren't controls show at most 50 characters of their text.
- `find` with `boxes` left the position off plain-text matches.
- `page_fetch` said how long the body was after cutting it, not before. It now reports the full length, e.g. `(cut; 204246 chars in all)`, and no longer mistakes a re-serialized JSON body for a cut one.

## 0.5.2 - 04/11/2026

### Added
- The popup's recent actions show roughly how many tokens each call added to the agent's context, with a running total and a Reset button. Text results count at about 4 characters per token, screenshots by their size (width x height / 750, the usual estimate for images in model context), plus the arguments the agent sent. Hovering a row splits the two. A screenshot of a 1366x683 page is about 1.2k tokens; `read_page` of the same page was 75.
- `screenshot` results carry the image's width and height.

## 0.5.1 - 04/11/2026

Fixes from the first run of 0.5.0 on a real site (a Wikipedia article).

### Fixed
- Outlines of article pages listed every inline link: `read_page({ depth: 2 })` on the Firefox article printed about 700 links (60 KB). Outlines now put each heading's content under it as a section, folded into one line with its size, and fold paragraphs too, so the same read is 4 KB.
- `find` missed a phrase that runs through a link in a paragraph, and showed the paragraph with the link text cut out. Paragraphs, list items and table cells now match and show on all their text, and only the innermost matching block is listed.
- Screenshots, activity thumbnails and GIF frames needed the tab to be the one showing, so a recording made while the user worked in another tab came out empty, and `screenshot` switched the user's tab. They now use Firefox's `tabs.captureTab`, which captures a tab in the background, so `screenshot` no longer switches tabs.
- The ghost cursor stayed at its starting point in a tab that wasn't showing, because hidden tabs run no transitions. It now goes straight to the point there.

### Added
- A heading's ref covers its section: `read_page`, `get_page_text` and `find` with `ref` set to a heading read or search everything up to the next heading of the same or higher level.

## 0.5.0 - 04/11/2026

Reads cost fewer tokens (read an outline, then only the part you need), actions wait for their target and say whether a failure is safe to retry, and the popup can pause, stop and limit the agent.

### Added
- `read_page` takes `depth` for an outline. Controls are indented under their landmarks, dialogs, forms, lists and tables, and anything that many containers down is folded into one line with its ref, how many controls it holds and how it starts, e.g. `[ref_21] table (folded: 2 controls, starts "No Client INV-1 Alpha…")`.
- `read_page` and `get_page_text` take `ref` to read only inside one element, such as a dialog, a form or a folded region.
- `read_page` and `get_page_text` take `skip_nav` to leave out `<nav>`, `<aside>` and sidebars. Pagination is kept. The skipped regions are listed with their refs.
- `find` takes `role` (comma-separated, with `input`, `select`, `toggle` and `control` as shorthands), `exact` for a whole-name match, and `ref` to search inside one element. `query` is optional when `role` is given.
- `find` ranks controls first, then headings, then text, and says how many matches were left out (`…and 3 more`), so `limit: 2` shows whether a match is unique. When the role filter matches nothing, it shows matches with other roles, or the roles that are on the page.
- A ref whose element the page re-rendered is found again by its role, name, id, test id and the landmark or dialog around it. This only happens when exactly one element matches and it had no identical twin when it was read. The result says so. Otherwise the call fails without doing anything.
- `click`, `type`, `hover` and `form_input` wait up to 5 seconds for a ref's element to be visible, enabled and not under a dialog, backdrop or spinner. If it doesn't get there, they fail without acting and name what's in the way, e.g. `covered by [ref_11] div in <div.backdrop>`.
- `wait_for` waits until text appears or goes away, a CSS selector shows, a ref becomes visible / hidden / gone / enabled / contains a value, or API calls finish. It keeps waiting across page loads and says where the text appeared.
- `batch` runs several actions in one call (click, double_click, triple_click, type, press_key, form_input, hover, scroll, wait, wait_for) with one report of what changed at the end. It stops at the first failure and says which steps didn't run.
- `double_click` and `triple_click`. A triple click selects all of a text field or the whole paragraph, and a double click selects the word under the pointer, as real clicks do. `click` reports what got selected.
- `page_fetch` calls the web app's own API from the page, with its cookies and the Authorization header of its latest API call, resolved against the origin its API calls go to. It only calls the page's own site, and anything but GET waits for the user's approval.
- `read_network_requests` takes `bodies` to show what API calls sent and got back (up to 64 KB each, `body_chars` shown). Only tabs the agent has used are recorded, and passwords, tokens and keys are replaced with `••••`.
- Reads start with an `On screen:` line listing alerts, toasts and validation errors that are showing, marked error / success / warning, so a result banner needs no screenshot.
- When an action opens a dialog, menu, dropdown or popover, the change report gives its ref, so `read_page({ ref })` can read just that.
- A read that hits its size limit lists the regions it didn't reach, with refs.
- `tabs_context` shows when each tab was last used and whether the agent or the user opened it.
- Typed values show line breaks as `⏎`, and `type` says how many lines went in.
- The element being clicked or typed into gets a brief outline labelled with the action, and clicks and hovers show a ghost cursor gliding to the point. Both are removed before screenshots.
- A small "The agent is driving this tab" pill in the bottom-left corner while the agent works in a tab, with a **Stop** button that stops the agent like the popup's. It goes away after 8 quiet seconds and never shows in screenshots.
- Tabs the agent opens with `tabs_create` go into a cyan "Agent" tab group, which keeps the user's logins (a container wouldn't). `group: false` opts out, and `tabs_context` marks grouped tabs.
- `read_page` and `find` take `boxes` to add each element's box in viewport pixels (`@x,y widthxheight`), for layout questions without a screenshot.
- `gif_start` and `gif_save` record a tab as an animated GIF: one frame after each action while the tab is showing, with the action's outline, the cursor and a caption of what it did. `gif_save` writes the file (by default to `~/Downloads`) and returns its path. The encoder is built in, with a fixed palette of colours plus a grey ramp.
- Popup: **Pause** (the agent's calls wait) and **Stop** (they fail until you resume). The badge shows `II` or `■` meanwhile.
- Popup: what the agent may do on the current site: read only, ask before risky actions (the default), or everything without approvals. On a read-only site, clicking, typing, `javascript` and writing `page_fetch` calls fail.
- Popup: the agent's last 30 calls with their time and result, failures marked in red, and a thumbnail of the element for calls that used a ref. Clicking one outlines that element on the page.

### Changed
- A ref from before a reload or navigation now says so, instead of saying the element is gone.
- Errors raised before anything reached the page end with "Nothing was done.", and any other action error adds "It may have gone through: read the page before trying again", so a Submit isn't pressed twice.
- "Sites that skip approval" in the popup became "Site settings", and those sites are now "Everything, no approvals".
- `emulate_device`, `request_user_input` and the action tools have shorter descriptions.
- The extension needs the `tabGroups` permission.
- `filter: "all"` also shows lists and tables as containers, and drops landmarks with nothing visible inside.
- Lists, tables, menus, tab lists and toolbars are no longer named after all of their text.
- When `read_page` hits its line limit, it suggests reading an outline and then one region.

## 0.4.0 - 27/10/2026

### Added
- `emulate_device` shows a tab at phone or tablet size without touching the user's windows. The tab moves into its own popup window whose viewport is exactly the device's size, so media queries see the real width. Its requests and `navigator.userAgent` report the device, and scripts see touch support (`maxTouchPoints`, `ontouchstart`, and `matchMedia` for `pointer` / `hover`) before the page's own scripts run. Presets: `iphone-se`, `iphone-14`, `iphone-15`, `iphone-15-pro-max`, `pixel-8`, `galaxy-s23`, `ipad-mini`, `ipad-pro`, or any width and height, in portrait or landscape. The tab keeps its id and logins, so every other tool works on it.
- `stop_emulation` moves the tab back to its window and position and reloads it with the normal user agent.
- `viewport_check` reports the viewport size, devicePixelRatio and any horizontal overflow, naming the elements that stick out (elements inside their own scroll area don't count). `emulate_device` includes the same report.
- `tabs_context` shows which tabs are being emulated.

### Changed
- `resize_window` says it resizes every tab in the window and points to `emulate_device`.
- The extension needs the `webNavigation` permission.
- `.gitignore` also covers built `.xpi` files, logs, `.env` files, local tooling state and editor files.

## 0.3.0 - 20/10/2026

### Added
- `click`, `type`, `press_key` and `form_input` report what changed: URL, toasts and alerts, API calls with their status, dialogs, elements added or removed near the target, and state changes such as `aria-invalid`. They wait up to 3 seconds for the API calls they start before reporting.
- `request_user_input` lets the user type a secret into a field. The field is outlined with the agent's hint, the toolbar icon gets a yellow dot, and only `filled, N chars` / `skipped` / `timed out` comes back. The value is masked in `read_page` afterwards.
- Approval before risky actions: pressing a button such as Publish, Delete, Submit or Pay, or a POST / PUT / PATCH / DELETE to another site during an action, waits for the user. The badge turns amber with a count, and the toolbar popup shows a picture of the element, the action, the agent's reason, and Approve / Deny / Always allow on this site.
- Optional `reason` argument on `click`, `type` and `press_key`, shown on the approval card.
- Toolbar popup with the connection state, pending approvals and fields, and the list of always-allowed sites.
- `ROADMAP.md`: a checklist of improvements found while using the bridge on real admin work.

### Changed
- Screenshots black out password fields and fields the user filled through `request_user_input`.
- Unlabelled fields and toggles get names: `aria-labelledby` comes before `aria-label`, Angular Material `<mat-label>` names its field, and otherwise the text beside the control in the same row is used. `find "api base url"` now finds the input, not only the label.
- Text fields, selects and comboboxes are no longer named after their own content (that's their value).

## 0.2.0 - 12/10/2026

### Added
- Flutter web support. `read_page` and `find` switch on Flutter's accessibility mode automatically, so canvas-rendered apps list their headings, buttons and fields with refs.
- `scroll` falls back to mouse-wheel events when nothing in the DOM scrolls, which canvas apps such as Flutter need. It also takes an `x`/`y` point to scroll the area under it.
- `FIREFOX_MCP_STATE_DIR` to run a second Firefox (e.g. a test profile) with its own bridge socket.

### Fixed
- `type` into Flutter text fields: the field is tapped first so the app accepts the text instead of discarding it.
- Element names no longer include CSS from inline `<style>` tags.
- Clicks on elements outside the viewport now say so instead of reporting off-screen coordinates as if they were real.
- The native host exits if it can't open its socket, instead of hanging.

## 0.1.0 - 12/10/2026

### Added
- Firefox extension (MV2, persistent background) that runs browser tools on request: tabs, navigation, page reading with element refs, find, click, hover, type, key presses, form input, scrolling, screenshots, JavaScript, console capture, network log and window resizing.
- Native messaging host that relays calls between the extension and local MCP servers over a user-only Unix socket, supporting several clients at once.
- Stdio MCP server exposing the 19 tools.
- `install.sh` to register the native host and build the extension, and `build.sh` to package the `.xpi`.
- Toolbar badge showing whether a client is connected.
