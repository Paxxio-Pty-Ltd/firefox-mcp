# Contributing

Thanks for helping. This is a small project maintained alongside other work, so clear reports get fixed fastest.

## Before you open an issue

- Search [existing issues](https://github.com/Paxxio-Pty-Ltd/firefox-mcp/issues), including closed ones.
- Check [Limitations](README.md#limitations) in the README. Synthetic input, iframes and `about:` pages are known
  limits, not bugs.
- Make sure you're on the latest release: the version is in `about:addons` and in the `CHANGELOG.md` heading.
- **Security problems never go in a public issue.** See [SECURITY.md](SECURITY.md).

## Reporting a bug

Use the **Bug report** form. One problem per issue. Include:

1. **Versions:** the extension (`about:addons`), Firefox (Help → About), your OS, Node (`node -v`) and the MCP
   client you use.
2. **The tool call:** the tool name and its arguments, e.g. `read_page({ depth: 2, skip_nav: true })`.
3. **What came back, and what you expected instead.** Paste the text result; trim it if it's long.
4. **A public page that shows it,** if you can find one. Reports against a page we can open get fixed; reports we
   can't reproduce usually stall.
5. **The native host log** if the bridge won't connect: the last 20 lines of `~/.firefox-mcp/native-host.log`.

### Don't paste private data

Tool results, screenshots, network bodies and GIF recordings show whatever was in your browser. Before you attach
anything:

- Remove names, emails, tokens, cookies, `Authorization` headers and customer data.
- Prefer a public page, or a small HTML file that reproduces the problem, over a screenshot of a logged-in app.
- Never attach `native-host.log` unedited if it contains page content.

Issues containing credentials or someone else's personal data are deleted.

## Suggesting a feature

Use the **Feature request** form. Describe what you were trying to do and where the current tools got in the way,
ideally with the calls you made. "Reading X took five calls and a screenshot" is more useful than "add tool Y".
Check [ROADMAP.md](ROADMAP.md) first.

## Pull requests

- Open an issue first for anything bigger than a small fix, so we can agree on the approach.
- Keep each PR to one change, and add a line to the top of `CHANGELOG.md` under a new version heading.
- Match the existing code: plain JavaScript, no build step, no new dependencies in the extension, and comments
  that say why rather than what.
- Say how you tested it. There's no automated suite yet; a headless run against a page that shows the change is
  the bar (see [Development](README.md#development)).
- Tool descriptions are read by models on every call, so keep them short and literal.

## What to expect

Issues are triaged when time allows, usually within a couple of weeks. Bugs with a reproducible public page come
first. Feature requests may be closed if they don't fit the project's scope: driving your own Firefox safely and
cheaply from an MCP client.
