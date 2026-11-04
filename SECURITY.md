# Security policy

This extension drives a browser that is logged in to your accounts, so security reports matter. Thank you for
making them privately.

## Reporting a vulnerability

**Don't open a public issue.** Use GitHub's private reporting instead: the repository's **Security** tab →
**Report a vulnerability**. Include:

- What an attacker can do, and from where (a web page, another local user, a malicious MCP client).
- Steps or a minimal page that shows it.
- The extension, Firefox and OS versions.

You'll get an acknowledgement within a week. Please give us a reasonable time to ship a fix before disclosing it.

## Supported versions

Only the latest release gets security fixes.

## What's in scope

The threat model, in short:

- **Web pages are untrusted.** A page must not be able to drive the agent's tools, approve its own risky
  actions, press the popup's buttons or the in-page Stop button for the user, read values typed through
  `request_user_input`, or see what the bridge records about other tabs.
- **The bridge is local.** The MCP server talks to the native host over a Unix socket in `~/.firefox-mcp`
  (mode 700 directory). Anything running as your user can already use it; other local users must not.
- **The MCP client is trusted** to call the tools, but not to bypass approvals, trust levels, Pause / Stop or
  secret masking.

Examples of reportable issues: a page forging an approval or a trust-level change, a page reading recorded network
bodies or `Authorization` headers, a secret field's value reaching a tool result or screenshot, `page_fetch` reaching
another site, or the socket being reachable by another user.

## Out of scope

- The `javascript` tool running code in a page: that is what it's for. Use a read-only trust level on sites where it
  matters.
- Anything that needs control of your user account, Firefox profile or the MCP client already.
- Sites ignoring synthetic input, and other [limitations](README.md#limitations).
