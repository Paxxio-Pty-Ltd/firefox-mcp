# Roadmap

What's planned, roughly in order. Each item says what goes wrong today and what would fix it. Suggestions are
welcome as feature requests (see [CONTRIBUTING.md](CONTRIBUTING.md)); shipped items move to the
[changelog](CHANGELOG.md).

## Installing

- [ ] **Signed builds.** Regular Firefox only installs signed add-ons, so today you need Developer Edition, Nightly
  or ESR with signature checks off. Sign each release as an unlisted add-on through addons.mozilla.org and attach
  the `.xpi` to a GitHub release.
- [ ] **Windows.** The native host listens on a Unix socket and `install.sh` writes macOS / Linux paths. Windows
  needs a named pipe and a registry entry for the native host.

## Reading

- [ ] **Shadow DOM in `get_page_text`.** `read_page` and `find` see into shadow roots, but page text uses
  `innerText`, which doesn't, so code blocks drawn by web components (MDN's, for one) go missing.
- [ ] **Iframes.** Only the top frame is read and controlled. Embedded editors, payment forms and older admin pages
  live in frames.

## Acting

- [ ] **Lazily loaded widgets.** Some widgets load their code on the first trusted focus or click and ignore
  synthetic input until then (Wikipedia's search suggestions while the window isn't focused). Detect a widget that
  didn't react and say so, instead of reporting "nothing changed".

## Quality

- [ ] **Automated tests.** Every change is tested by hand in a headless Firefox. A suite of local fixture pages
  driven through the real bridge would catch regressions in reads, refs and change reports.

## Big ideas

Larger features that build on what's already here. Each one needs a design issue before work starts.

- [ ] **Diff reads.** `read_page({ since: "last" })` returns only what changed since the previous read of that
  region: added, removed and changed lines, with refs. After an action the agent re-reads in a few lines instead of
  a few hundred, which is the biggest token saving left.
- [ ] **Turn a run into a test.** Record the agent's actions, waits and checks, and export them as a replayable
  script, either a Playwright test or a JSON flow the bridge can re-run, so a task done once in your browser becomes
  a regression check.
- [ ] **Run reports.** One self-contained HTML file per run: every call with its arguments, result, token estimate,
  thumbnail and timing, plus the GIF. Something to attach to a ticket or send to a client instead of describing what
  happened.
- [ ] **Site maps that persist.** Remember the outline of each page an agent has visited (routes, landmarks, forms
  and their fields) per site, so the next session starts knowing where "Settings → API keys" is, rather than
  exploring again.
- [ ] **File uploads.** Fill `<input type="file">` from a path the user allows, by building the file in the page
  through `DataTransfer`, which works where a synthetic click on a native file picker doesn't.
- [ ] **Take the wheel.** A popup button that pauses the agent and lets you do a step yourself (log in, solve a
  CAPTCHA, pick a file), then hand back with a note the agent reads, instead of the agent failing or guessing.
- [ ] **Token budgets.** Let a client set a budget per call or per session. Reads over budget come back as an outline
  automatically, screenshots are scaled down, and the popup warns when a session is running hot.
- [ ] **Accessibility and quality checks.** The reader already works out roles and names, so `audit_page` can list
  unlabelled controls, buttons with no name, missing headings, broken focus order and Core Web Vitals, with refs to
  each problem.
- [ ] **Mock an API response.** For testing edge cases in your own app: answer the next matching request with a
  given status and body (an empty list, a 500, a slow response). Off by default, only on sites set to
  **Everything**, and always shown in the popup.
- [ ] **Several agents at once.** Each MCP client gets its own tab group colour, its own cursor label and its own
  line in the activity list, so two agents working in the same browser stay distinguishable and can't act in each
  other's tabs.
- [ ] **Watch live.** A small live preview of the tab being driven, inside the popup, so you can follow an agent
  working in a background tab without switching to it.

## Ideas considered and not taken

- **Refs that survive across sessions:** refs live in the page, so a reload already
  makes them unknown, and that's reported clearly.
- **Headless versus headed input:** Firefox gives extensions only synthetic input either way.
- **Containers for agent tabs:** they would separate the agent's cookies from your logins. A tab group marks the
  tabs instead.
