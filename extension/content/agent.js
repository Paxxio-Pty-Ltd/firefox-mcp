// Injected into the page's isolated content-script world on demand. Builds a
// readable view of the page with stable element refs and performs input.
(() => {
  if (window.__fxmcp) return;

  const MAX_LINES = 1500;
  const MAX_CHARS = 50000;

  // ---- Element refs -------------------------------------------------------

  // ref -> { el: WeakRef, identity }. The identity (role, name, id, test id and the
  // landmark or dialog around it) lets a ref find its element again after the page
  // re-renders it, as long as exactly one element still matches.
  const refs = new Map();
  const elementRefs = new WeakMap();
  // Fields the user filled through request_user_input; their values are never echoed.
  const secretFields = new WeakSet();
  // Refs found again since the last result, mentioned once in the next one.
  const refound = new Set();
  // While a read runs: identity key -> refs printed with it, to spot identical twins.
  let tally = null;
  let nextRef = 1;

  function refFor(el) {
    let ref = elementRefs.get(el);
    if (!ref) {
      ref = `ref_${nextRef++}`;
      elementRefs.set(el, ref);
      refs.set(ref, { el: new WeakRef(el), identity: identityOf(el) });
    }
    if (tally) {
      const key = refs.get(ref).identity.key;
      if (!tally.has(key)) tally.set(key, new Set());
      tally.get(key).add(ref);
    }
    return ref;
  }

  // Runs a read and marks refs that had an identical twin in it: those can't be found
  // again. The mark sticks, because a later read may show only one of the pair.
  function countingTwins(read) {
    tally = new Map();
    try {
      return read();
    } finally {
      for (const set of tally.values()) {
        if (set.size > 1) for (const ref of set) refs.get(ref).identity.twin = true;
      }
      tally = null;
    }
  }

  const SCOPE_SELECTOR = "dialog, nav, main, aside, header, footer, form, [role=dialog], [role=alertdialog], " +
    "[role=navigation], [role=main], [role=complementary], [role=region], [role=form], [role=search], " +
    "mat-dialog-container";

  function scopeOf(el) {
    const scope = el.parentElement?.closest(SCOPE_SELECTOR);
    return scope ? `${roleOf(scope) ?? scope.localName} ${nameOf(scope)}`.trim() : "";
  }

  function testIdOf(el) {
    return el.getAttribute("data-testid") ?? el.getAttribute("data-test") ?? el.getAttribute("data-cy") ?? "";
  }

  // The name a ref is matched by. Never a field's value, which changes as the user types.
  function identityName(el, role) {
    return role ? nameOf(el, role) : ownText(el) || clean(el.getAttribute("aria-label") ?? "");
  }

  function identityOf(el) {
    const role = roleOf(el);
    const identity = {
      role, tag: el.localName, name: identityName(el, role),
      id: el.id, testId: testIdOf(el), scope: scopeOf(el), twin: false,
    };
    identity.key = JSON.stringify([role ?? identity.tag, identity.name, identity.id, identity.testId, identity.scope]);
    return identity;
  }

  // The live element that matches a stale ref's identity, or why there isn't exactly one.
  function refind(identity) {
    if (!identity.name && !identity.id && !identity.testId) return { why: "it had no name to find it by" };
    if (identity.twin) return { why: "another element looked exactly like it, so they can't be told apart" };
    let matches = [];
    for (const el of visibleElements(document.documentElement)) {
      const role = roleOf(el);
      if (role !== identity.role || (!role && el.localName !== identity.tag)) continue;
      if (identityName(el, role) === identity.name) matches.push(el);
    }
    for (const [field, read] of [["id", (el) => el.id], ["testId", testIdOf], ["scope", scopeOf]]) {
      if (matches.length <= 1) break;
      if (field !== "scope" && !identity[field]) continue;
      const narrowed = matches.filter((el) => read(el) === identity[field]);
      if (narrowed.length) matches = narrowed;
    }
    if (matches.length === 1) return { el: matches[0] };
    return { why: matches.length ? `${matches.length} elements now look like it` : "nothing on the page matches it now" };
  }

  function byRef(ref) {
    const entry = refs.get(ref);
    if (!entry) {
      throw new Error(`${ref} isn't a ref on this page (it may have reloaded or navigated since). ` +
        "Call read_page or find for fresh refs. Nothing was done.");
    }
    const old = entry.el.deref();
    if (old?.isConnected) return old;
    const { el, why } = refind(entry.identity);
    if (!el) throw new Error(`Element ${ref} is gone: ${why}. Call read_page or find again for fresh refs. Nothing was done.`);
    entry.el = new WeakRef(el);
    if (!elementRefs.has(el)) elementRefs.set(el, ref);
    if (old && secretFields.has(old)) secretFields.add(el);
    refound.add(ref);
    return el;
  }

  function tryRef(ref) {
    try {
      return byRef(ref);
    } catch {
      return null;
    }
  }

  // ---- Roles, names, visibility ------------------------------------------

  const SKIP_TAGS = new Set(["script", "style", "noscript", "template", "head", "meta", "link", "svg", "fxmcp-overlay"]);
  // Canvas-rendering hosts (Flutter web): never elements themselves, only containers.
  const CANVAS_HOSTS = new Set(["flutter-view", "flt-glass-pane", "flt-scene-host", "flt-semantics-host", "canvas"]);
  const INTERACTIVE_ROLES = new Set([
    "button", "link", "checkbox", "radio", "textbox", "searchbox", "combobox", "listbox",
    "option", "slider", "spinbutton", "switch", "tab", "menuitem", "menuitemcheckbox",
    "menuitemradio", "treeitem",
  ]);
  const LEAF_ROLES = new Set([
    "button", "checkbox", "radio", "textbox", "searchbox", "combobox", "slider",
    "spinbutton", "switch", "option", "menuitem", "tab",
  ]);
  const LANDMARKS = {
    nav: "navigation", main: "main", header: "banner", footer: "contentinfo",
    aside: "complementary", form: "form", dialog: "dialog",
  };
  const LANDMARK_ROLES = new Set([...Object.values(LANDMARKS), "region", "alertdialog", "alert", "search"]);
  // Groups shown as containers in an outline, besides landmarks. Like landmarks, their
  // text content is not their name.
  const CONTAINER_ROLES = new Set([
    "table", "grid", "treegrid", "list", "menu", "menubar", "tablist", "tabpanel", "tree", "toolbar",
    "radiogroup", "feed", "paragraph", "blockquote", "figure",
  ]);
  // Prose blocks, folded in outlines so an article's inline links don't list one by one.
  const PROSE_ROLES = { p: "paragraph", blockquote: "blockquote", figure: "figure" };
  // Blocks of text that find matches as a whole, so a phrase running through a link still matches.
  const TEXT_BLOCKS = new Set(["p", "li", "td", "th", "dd", "dt", "blockquote", "figcaption", "caption", "label", "pre"]);
  // What skip_nav leaves out. Pagination is kept: it's how you reach the rest of a list.
  const NAV_SELECTOR = "nav, aside, [role=navigation], [role=complementary], mat-sidenav";
  // Words people use for a role in find, mapped to the roles they mean.
  const FIELD_KINDS = ["textbox", "searchbox", "combobox", "spinbutton"];
  const ROLE_ALIASES = {
    input: FIELD_KINDS, field: FIELD_KINDS, textfield: FIELD_KINDS, textarea: ["textbox"],
    select: ["combobox", "listbox"], dropdown: ["combobox", "listbox"],
    toggle: ["checkbox", "switch"], control: ["clickable", ...INTERACTIVE_ROLES],
  };
  const INTERACTIVE_SELECTOR =
    "a[href], button, input, select, textarea, summary, [role], [tabindex], [contenteditable], [onclick]";
  // Roles whose text content is their value rather than their name.
  const FIELD_ROLES = new Set(["textbox", "searchbox", "combobox", "spinbutton", "slider", "listbox"]);
  const TOGGLE_ROLES = new Set(["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"]);
  // Controls own their text, so it can't name a neighbouring field.
  const CONTROL_SELECTOR = "a[href], button, input, select, textarea, [contenteditable], " +
    "[role=button], [role=link], [role=checkbox], [role=radio], [role=switch], [role=textbox], " +
    "[role=combobox], [role=slider], [role=tab], [role=option], [role=menuitem]";

  function inputRole(el) {
    switch (el.type) {
      case "hidden": return null;
      case "checkbox": return "checkbox";
      case "radio": return "radio";
      case "range": return "slider";
      case "number": return "spinbutton";
      case "search": return "searchbox";
      case "button": case "submit": case "reset": case "image": return "button";
      default: return "textbox";
    }
  }

  function roleOf(el) {
    const explicit = el.getAttribute("role")?.trim().split(/\s+/)[0];
    if (explicit) return explicit;
    const tag = el.localName;
    if (tag === "a") return el.hasAttribute("href") ? "link" : null;
    if (tag === "button" || tag === "summary") return "button";
    if (tag === "input") return inputRole(el);
    if (tag === "select") return el.multiple || el.size > 1 ? "listbox" : "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "option") return "option";
    if (tag === "img") return "img";
    if (/^h[1-6]$/.test(tag)) return "heading";
    if (isEditableHost(el)) return "textbox";
    return LANDMARKS[tag] ?? null;
  }

  function isEditableHost(el) {
    return ["", "true", "plaintext-only"].includes(el.getAttribute("contenteditable"));
  }

  function clean(text, max = 100) {
    const t = (text ?? "").replace(/\s+/g, " ").trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
  }

  function textOf(el) {
    let text = "";
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) => SKIP_TAGS.has(node.parentElement?.localName)
        ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    while (walker.nextNode()) text += walker.currentNode.textContent;
    return text;
  }

  // Same order a screen reader uses: aria-labelledby, aria-label, <label>, content,
  // placeholder. Unlabelled fields and toggles then fall back to nearby text.
  function nameOf(el, role = roleOf(el)) {
    const labelledBy = el.getAttribute("aria-labelledby");
    if (labelledBy) {
      const root = el.getRootNode();
      const text = clean(labelledBy.split(/\s+/)
        .map((id) => (root.getElementById?.(id) ?? document.getElementById(id))?.textContent ?? "").join(" "));
      if (text) return text;
    }
    const aria = el.getAttribute("aria-label");
    if (aria?.trim()) return clean(aria);
    // Landmarks and containers wrap whole sections, so their text content is not a name.
    if (LANDMARK_ROLES.has(role) || CONTAINER_ROLES.has(role)) return "";
    if (el.labels?.length) {
      const text = clean([...el.labels].map((label) => label.textContent).join(" "));
      if (text) return text;
    }
    if (FIELD_ROLES.has(role)) {
      const text = formFieldLabel(el);
      if (text) return text;
    }
    if (el.localName === "img") return clean(el.alt || el.title);
    if (el.localName === "input" && ["button", "submit", "reset"].includes(el.type)) return clean(el.value);
    if (!FIELD_ROLES.has(role)) {
      const text = clean(textOf(el));
      if (text) return text;
    }
    const hint = clean(el.getAttribute("placeholder") || el.title || "");
    if (hint) return hint;
    return FIELD_ROLES.has(role) || TOGGLE_ROLES.has(role) ? contextLabel(el, role) : "";
  }

  // Angular Material and similar wrap a field in a container whose label isn't tied to it.
  function formFieldLabel(el) {
    const field = el.closest("mat-form-field, .mat-mdc-form-field, .mat-form-field, .form-group, .form-field");
    if (!field) return "";
    const fields = field.querySelectorAll("input:not([type=hidden]), select, textarea, [role=combobox], [role=textbox]");
    if (fields.length !== 1) return "";
    const label = field.querySelector("mat-label, label, .mat-mdc-floating-label");
    return label ? clean(textOf(label)).replace(/\s*\*$/, "") : "";
  }

  // The text beside a field in the same row, or the nearest heading above it.
  function contextLabel(el, role) {
    let container = el;
    for (let depth = 0; depth < 6; depth++) {
      container = container.parentElement;
      if (!container || container === document.body || LANDMARK_ROLES.has(roleOf(container))) break;
      const text = adjacentText(container, el, role);
      if (text) return text;
    }
    return "";
  }

  // Closest text before `el` inside `container` (checkboxes and radios prefer the
  // text after them), skipping text that belongs to other controls.
  function adjacentText(container, el, role) {
    const lookAfter = TOGGLE_ROLES.has(role);
    let before = null;
    let after = null;
    let passed = false;
    let done = false;
    const visit = (node) => {
      if (done) return;
      if (node === el) {
        passed = true;
        done = !lookAfter;
        return;
      }
      if (node.nodeType === Node.TEXT_NODE) {
        if (!node.textContent.trim()) return;
        if (passed) {
          after = node;
          done = true;
        } else {
          before = node;
        }
        return;
      }
      if (node.nodeType !== Node.ELEMENT_NODE || SKIP_TAGS.has(node.localName)) return;
      if (!isShown(node)) return;
      if (node.matches(CONTROL_SELECTOR) && !node.contains(el)) {
        if (passed) done = true;
        else before = null;
        return;
      }
      for (const child of node.childNodes) visit(child);
    };
    visit(container);

    const node = role === "switch" ? before ?? after : after ?? before;
    if (!node) return "";
    const parent = node.parentElement;
    const block = parent !== container && !parent.querySelector(CONTROL_SELECTOR) ? textOf(parent) : node.textContent;
    return clean(block, 80);
  }

  // Whether anything in an element's subtree can show. display: contents (common on web
  // components) gives an element no box, so checkVisibility says false, but its children
  // still render, so the walk has to go into it.
  function isShown(el) {
    return el.checkVisibility({ checkVisibilityCSS: true }) || getComputedStyle(el).display === "contents";
  }

  function isVisible(el) {
    if (!el.checkVisibility({ checkVisibilityCSS: true })) return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isInteractive(el, role) {
    if (INTERACTIVE_ROLES.has(role)) return true;
    if (el.hasAttribute("onclick")) return true;
    const tabindex = el.getAttribute("tabindex");
    if (tabindex !== null && Number(tabindex) >= 0) return true;
    // Catches div/span "buttons" wired up by frameworks without any markup hint.
    return getComputedStyle(el).cursor === "pointer" &&
      !!el.parentElement && getComputedStyle(el.parentElement).cursor !== "pointer";
  }

  // Set while a read was asked for element boxes.
  let withBoxes = false;

  function boxOf(el) {
    const rect = el.getBoundingClientRect();
    if (!rect.width && !rect.height) return "";
    return ` @${Math.round(rect.left)},${Math.round(rect.top)} ${Math.round(rect.width)}x${Math.round(rect.height)}`;
  }

  const TABLE_PARTS = { td: "cell", th: "columnheader", tr: "row", thead: "rowgroup", tbody: "rowgroup", tfoot: "rowgroup" };

  function describe(el, role = roleOf(el)) {
    // A plain table or list is labelled as one, not named after all the text inside it.
    role ??= containerRole(el, null) ?? TABLE_PARTS[el.localName] ?? null;
    let line = `[${refFor(el)}] ${role ?? el.localName}`;
    if (role === "heading" && /^h[1-6]$/.test(el.localName)) line += ` ${el.localName}`;
    let name = nameOf(el, role);
    // Something that isn't a control (a cell, a div hit by coordinates) only needs a hint of its text.
    if (name && !roleOf(el) && !isInteractive(el, null)) name = clean(name, 50);
    if (name) line += ` ${JSON.stringify(name)}`;

    const extras = [];
    if (el.localName === "select") {
      extras.push(`value=${JSON.stringify(clean(el.selectedOptions[0]?.textContent ?? "", 60))}`);
    } else if (["textbox", "searchbox", "slider", "spinbutton", "combobox"].includes(role)) {
      const value = "value" in el ? el.value : el.textContent;
      const secret = el.type === "password" || secretFields.has(el);
      // ⏎ marks line breaks, so a multi-line value visibly went in intact.
      if (value) extras.push(`value=${JSON.stringify(secret ? "••••" : clean(value.replace(/\r?\n/g, "⏎"), 60))}`);
      const placeholder = el.getAttribute("placeholder");
      if (placeholder && placeholder !== name) extras.push(`placeholder=${JSON.stringify(clean(placeholder, 60))}`);
    }
    if (["checkbox", "radio", "switch", "menuitemcheckbox", "menuitemradio"].includes(role)) {
      extras.push(`checked=${"checked" in el ? el.checked : el.getAttribute("aria-checked") === "true"}`);
    }
    if (el.getAttribute("aria-selected") === "true") extras.push("selected");
    if (el.hasAttribute("aria-expanded")) extras.push(`expanded=${el.getAttribute("aria-expanded")}`);
    if (el.disabled || el.getAttribute("aria-disabled") === "true") extras.push("disabled");
    if (role === "link") {
      const href = el.getAttribute("href");
      if (href && !href.startsWith("javascript:")) extras.push(`href=${clean(href, 80)}`);
    }
    if (extras.length) line += ` (${extras.join(", ")})`;
    if (withBoxes) line += boxOf(el);
    return line;
  }

  // ---- Tree walking ------------------------------------------------------

  function* childrenOf(el) {
    yield* el.children;
    const shadow = el.openOrClosedShadowRoot;
    if (shadow) yield* shadow.children;
  }

  function ownText(el) {
    let text = "";
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) text += node.textContent;
    }
    return clean(text, 300);
  }

  function containerRole(el, role) {
    if (LANDMARK_ROLES.has(role) || CONTAINER_ROLES.has(role)) return role;
    if (role) return null;
    if (el.localName === "table") return "table";
    if (el.localName === "ul" || el.localName === "ol") return "list";
    return null;
  }

  function isNavigation(el) {
    return el.matches(NAV_SELECTOR) && !/pag/i.test(el.getAttribute("aria-label") ?? "");
  }

  function plural(n, word) {
    return `${n} ${word}${n === 1 ? "" : "s"}`;
  }

  // One line standing in for a folded subtree: how much is in it and how it starts,
  // so the agent can tell whether to read it by ref. Empty when there's nothing the
  // current mode would have printed.
  // `el` is one element, or the list of elements that make up a heading's section.
  function foldedSummary(el, mode) {
    const roots = (Array.isArray(el) ? el : [el])
      .filter((root) => !SKIP_TAGS.has(root.localName) && isShown(root));
    let controls = 0;
    let headings = 0;
    for (const root of roots) {
      for (const inner of Array.isArray(el) ? [root, ...visibleElements(root)] : visibleElements(root)) {
        const role = roleOf(inner);
        if (role === "heading") headings++;
        else if (isInteractive(inner, role) && isVisible(inner)) controls++;
      }
    }
    const text = clean(roots.map((root) => root.innerText ?? textOf(root)).join(" "), 100000);
    if (!controls && !headings && (mode !== "all" || !text)) return "";
    const counts = [plural(controls, "control")];
    if (headings) counts.push(plural(headings, "heading"));
    if (mode === "all") counts.push(plural(text ? text.split(" ").length : 0, "word"));
    return `(folded: ${counts.join(", ")}${text ? `, starts ${JSON.stringify(clean(text, 50))}` : ""})`;
  }

  function headingRank(el) {
    if (/^h[1-6]$/.test(el.localName)) return Number(el.localName[1]);
    if (el.getAttribute?.("role") === "heading") return Number(el.getAttribute("aria-level")) || 2;
    return 0;
  }

  // The heading an element is, or wraps with little else (Wikipedia's div.mw-heading
  // around an h2 and its edit link), with its rank.
  function headingOf(el) {
    const own = headingRank(el);
    if (own) return { heading: el, rank: own };
    const first = el.firstElementChild;
    if (!first || el.children.length > 3) return null;
    const rank = headingRank(first);
    if (!rank || clean(textOf(el)).length > clean(textOf(first)).length + 40) return null;
    return { heading: first, rank };
  }

  // What a heading heads: the siblings after it (or after its wrapper) up to the next
  // heading of the same or higher rank. Null when `el` isn't a heading.
  function sectionOf(el) {
    const rank = headingRank(el);
    if (!rank) return null;
    let anchor = el;
    while (anchor.parentElement && headingOf(anchor.parentElement)?.heading === el) anchor = anchor.parentElement;
    const nodes = [];
    for (let sibling = anchor.nextElementSibling; sibling; sibling = sibling.nextElementSibling) {
      const next = headingOf(sibling);
      if (next && next.rank <= rank) break;
      nodes.push(sibling);
    }
    return nodes;
  }

  // Elements a ref covers: a heading covers its section, anything else itself.
  function scopeOfRef(el) {
    const section = sectionOf(el);
    return section ? [el, ...section] : [el];
  }

  function* visibleIn(roots) {
    for (const root of roots) {
      if (roots.length > 1) {
        if (SKIP_TAGS.has(root.localName) || !isShown(root)) continue;
        yield root;
      }
      yield* visibleElements(root);
    }
  }

  // Walks sibling nodes. Structured reads put what follows a heading under it, as its
  // section, and fold the section when it sits `maxDepth` down.
  function walkNodes(nodes, depth, lines, opts) {
    if (!opts.structured) {
      for (const node of nodes) walk(node, depth, lines, opts);
      return;
    }
    for (let i = 0; i < nodes.length; i++) {
      const found = headingOf(nodes[i]);
      if (!found || !isShown(nodes[i])) {
        walk(nodes[i], depth, lines, opts);
        continue;
      }
      let end = i + 1;
      while (end < nodes.length && !(headingOf(nodes[end])?.rank <= found.rank)) end++;
      walkSection(found.heading, nodes.slice(i + 1, end), depth, lines, opts);
      i = end - 1;
    }
  }

  function walkSection(heading, body, depth, lines, opts) {
    if (readFull(lines, opts)) return;
    lines.push("  ".repeat(depth) + describe(heading, "heading"));
    noteLine(lines, opts, heading);
    if (!body.length) return;
    if (depth + 1 >= opts.maxDepth) {
      const summary = foldedSummary(body, opts.mode);
      if (summary) lines[lines.length - 1] += ` ${summary}`;
      return;
    }
    walkNodes(body, depth + 1, lines, opts);
  }

  // Prints the visible page into `lines`. Structured reads (filter "all", or any depth)
  // indent controls under their landmarks, dialogs, lists and tables, and fold whatever
  // sits `maxDepth` containers down into one summary line. Flat reads list controls only.
  // Leaves room under MAX_CHARS for the header and the note on what wasn't read.
  const WALK_CHARS = MAX_CHARS - 4000;

  function readFull(lines, opts) {
    return lines.length >= MAX_LINES || opts.chars >= WALK_CHARS;
  }

  function noteLine(lines, opts, el) {
    opts.last = el;
    opts.chars += lines[lines.length - 1].length + 1;
  }

  function walk(el, depth, lines, opts) {
    if (readFull(lines, opts) || SKIP_TAGS.has(el.localName)) return;
    if (!isShown(el)) return;
    if (opts.skipNav && el !== opts.root && isNavigation(el)) {
      opts.skipped.push(describe(el, roleOf(el) ?? "navigation"));
      return;
    }

    if (CANVAS_HOSTS.has(el.localName)) {
      walkNodes([...childrenOf(el)], depth, lines, opts);
      return;
    }

    const { mode, structured } = opts;
    const role = roleOf(el);
    const indent = structured ? "  ".repeat(depth) : "";
    const interactive = isInteractive(el, role);
    const container = structured && !interactive
      ? containerRole(el, role) ?? (opts.maxDepth !== Infinity ? PROSE_ROLES[el.localName] ?? null : null)
      : null;

    if (container) {
      const start = lines.length;
      lines.push(indent + describe(el, container));
      noteLine(lines, opts, el);
      if (depth + 1 >= opts.maxDepth) {
        const summary = foldedSummary(el, mode);
        if (summary) lines[start] += ` ${summary}`;
        else lines.pop();
        return;
      }
      walkNodes([...childrenOf(el)], depth + 1, lines, opts);
      // Nothing worth printing inside: drop the container line too.
      if (lines.length === start + 1) lines.pop();
      return;
    }

    let emitted = false;
    if (interactive || role === "heading" || (mode === "all" && role === "img" && nameOf(el))) {
      if (isVisible(el)) {
        lines.push(indent + describe(el, role));
        noteLine(lines, opts, el);
        emitted = true;
      }
      if (interactive && LEAF_ROLES.has(role)) return;
      if (role === "heading") return;
      if (emitted && structured && depth + 1 >= opts.maxDepth) {
        const summary = foldedSummary(el, mode);
        if (summary) lines[lines.length - 1] += ` ${summary}`;
        return;
      }
    } else if (mode === "all" && ownText(el)) {
      // Plain text block: print it whole unless it contains controls worth listing.
      if (!el.querySelector(INTERACTIVE_SELECTOR)) {
        lines.push(`${indent}text ${JSON.stringify(clean(textOf(el), 300))}${withBoxes ? boxOf(el) : ""}`);
        noteLine(lines, opts, el);
        return;
      }
      lines.push(`${indent}text ${JSON.stringify(ownText(el))}${withBoxes ? boxOf(el) : ""}`);
      noteLine(lines, opts, el);
    } else if (mode === "all" && !role && el.getAttribute("aria-label")?.trim()) {
      // Flutter semantics labels static text with aria-label rather than text nodes.
      lines.push(`${indent}text ${JSON.stringify(clean(el.getAttribute("aria-label"), 300))}${withBoxes ? boxOf(el) : ""}`);
      noteLine(lines, opts, el);
    }

    walkNodes([...childrenOf(el)], emitted ? depth + 1 : depth, lines, opts);
  }

  function pageHeader() {
    const maxScroll = Math.max(0, document.documentElement.scrollHeight - innerHeight);
    const messages = visibleMessages();
    return [
      `Title: ${document.title}`,
      `URL: ${location.href}`,
      `Viewport: ${innerWidth}x${innerHeight}, scrolled ${Math.round(scrollY)} of ${maxScroll}px`,
      ...(messages.length ? [`On screen: ${messages.join("; ")}`] : []),
      "",
    ].join("\n");
  }

  // Alerts, toasts and validation errors showing now, marked error / success / warning
  // where the page says which, so reading a result banner doesn't need a screenshot.
  function visibleMessages() {
    const shown = [];
    for (const el of document.querySelectorAll(MESSAGE_SELECTOR)) {
      if (shown.length >= 5) break;
      if (el.closest("fxmcp-overlay") || !isVisible(el)) continue;
      const text = clean(el.innerText, 150);
      if (!text || shown.some((m) => m.text.includes(text) || text.includes(m.text))) continue;
      const hint = `${el.className} ${el.getAttribute("role") ?? ""} ${el.localName}`.toLowerCase();
      const tone = /error|danger|invalid|fail/.test(hint) ? "error"
        : /success|saved/.test(hint) ? "success"
        : /warn/.test(hint) ? "warning"
        : roleOf(el) ?? "message";
      shown.push({ text, line: `${tone} ${JSON.stringify(text)}` });
    }
    return shown.map((m) => m.line);
  }

  const REGION_SELECTOR = "nav, main, aside, header, footer, form, dialog, section, table, ul, ol, [role]";

  // Containers after the last printed element, for a read that hit its line limit.
  function unreachedRegions(opts) {
    const regions = [];
    if (!opts.last) return regions;
    const scope = opts.root === document.documentElement ? document : opts.root;
    for (const el of scope.querySelectorAll(REGION_SELECTOR)) {
      if (regions.length >= 10) break;
      if (!(opts.last.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      if (regions.some((region) => region.el.contains(el))) continue;
      if (!containerRole(el, roleOf(el)) || (opts.skipNav && isNavigation(el))) continue;
      if (!isShown(el)) continue;
      const summary = foldedSummary(el, opts.mode);
      if (summary) regions.push({ el, line: `${describe(el, containerRole(el, roleOf(el)))} ${summary}` });
    }
    return regions.map((region) => region.line);
  }

  function truncate(text) {
    return text.length > MAX_CHARS
      ? `${text.slice(0, MAX_CHARS)}\n…(truncated; use find to locate specific elements)`
      : text;
  }

  function* visibleElements(root) {
    for (const el of childrenOf(root)) {
      if (SKIP_TAGS.has(el.localName) || !isShown(el)) continue;
      yield el;
      yield* visibleElements(el);
    }
  }

  // ---- Geometry & input helpers ------------------------------------------

  function deepElementFromPoint(x, y) {
    let el = document.elementFromPoint(x, y);
    while (el?.openOrClosedShadowRoot) {
      const inner = el.openOrClosedShadowRoot.elementFromPoint(x, y);
      if (!inner || inner === el) break;
      el = inner;
    }
    return el;
  }

  function deepActiveElement() {
    let el = document.activeElement;
    while (el?.openOrClosedShadowRoot?.activeElement) el = el.openOrClosedShadowRoot.activeElement;
    return el;
  }

  function composedContains(ancestor, node) {
    for (let n = node; n; n = n.parentNode ?? n.host) {
      if (n === ancestor) return true;
    }
    return false;
  }

  function centerOf(el) {
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  }

  const BLOCKER_SELECTOR = "dialog[open], [role=dialog], [role=alertdialog], mat-dialog-container, .modal.show, " +
    ".cdk-overlay-backdrop, [class*=backdrop], [class*=overlay], [class*=spinner], [class*=loading], " +
    "[class*=loader], [aria-busy=true]";
  const ACTIONABLE_WAIT_MS = 5000;

  function isDisabled(el) {
    return el.disabled === true || el.getAttribute("aria-disabled") === "true" || !!el.closest("fieldset:disabled");
  }

  // What stops `el` being acted on now, or null. Something on top only counts when it
  // belongs to another layer (a dialog, backdrop or spinner): a styled label over its
  // own checkbox doesn't, since events go straight to the element.
  function obstacle(el, pointer) {
    if (!isVisible(el)) return { kind: "hidden" };
    if (isDisabled(el)) return { kind: "disabled" };
    if (!pointer) return null;
    const point = centerOf(el);
    if (point.x < 0 || point.y < 0 || point.x > innerWidth || point.y > innerHeight) return null;
    const hit = deepElementFromPoint(point.x, point.y);
    if (!hit || isOurs(hit) || composedContains(el, hit) || composedContains(hit, el)) return null;
    const layer = hit.closest(BLOCKER_SELECTOR);
    return layer && !composedContains(layer, el) ? { kind: "covered", hit, layer } : null;
  }

  function layerLabel(layer) {
    const cls = [...layer.classList].find((name) => /backdrop|overlay|spinner|loading|loader|dialog|modal/i.test(name));
    return `<${layer.localName}${cls ? `.${cls}` : ""}>`;
  }

  // Waits up to 5 s for a ref's element to be visible, enabled and not under a dialog,
  // backdrop or spinner. Fails without doing anything if it doesn't get there.
  async function whenActionable(ref, { pointer = true } = {}) {
    const deadline = Date.now() + ACTIONABLE_WAIT_MS;
    for (;;) {
      const el = byRef(ref);
      const problem = obstacle(el, pointer);
      if (!problem) return el;
      if (Date.now() >= deadline) {
        const waited = `(waited ${ACTIONABLE_WAIT_MS / 1000}s). Nothing was done.`;
        if (problem.kind === "hidden") throw new Error(`${describe(el)} isn't visible ${waited}`);
        if (problem.kind === "disabled") throw new Error(`${describe(el)} is disabled ${waited}`);
        throw new Error(`${describe(el)} is covered by ${describe(problem.hit)} in ${layerLabel(problem.layer)} ` +
          `(waited ${ACTIONABLE_WAIT_MS / 1000}s). Close or wait out whatever is on top first. Nothing was done.`);
      }
      await sleep(100);
    }
  }

  // A brief outline on the element being acted on, so the user sees what the agent does.
  let flashHost = null;
  // Where the ghost cursor was left, so the next pointer action glides from there.
  let lastPointer = null;

  const CURSOR_SVG = '<svg width="22" height="22" viewBox="0 0 22 22"><path d="M3 2l14 8-6.5 1.6L8 18z" ' +
    'fill="#2ac3a2" stroke="#10201c" stroke-width="1.4" stroke-linejoin="round"/></svg>';

  // `point`, for pointer actions, is where the ghost cursor glides to.
  function flash(el, label, point = null) {
    hideFlash();
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const host = document.createElement("fxmcp-overlay");
    host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483646; pointer-events: none;";
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>
      .box { position: fixed; box-sizing: border-box; border: 2px solid #2ac3a2; border-radius: 4px;
        animation: fade 900ms ease-out forwards; }
      .tag { position: absolute; left: -2px; top: -20px; padding: 1px 6px; border-radius: 3px; background: #2ac3a2;
        color: #10201c; font: 600 11px/16px system-ui, sans-serif; }
      @keyframes fade { 0%, 60% { opacity: 1; } 100% { opacity: 0; } }
      .cursor { position: fixed; width: 22px; height: 22px; margin: -2px 0 0 -3px;
        transition: left 300ms ease-out, top 300ms ease-out; animation: fade 900ms ease-out forwards; }
    </style><div class="box"><span class="tag"></span></div><div class="cursor" hidden>${CURSOR_SVG}</div>`;
    Object.assign(root.querySelector(".box").style, {
      left: `${rect.left - 3}px`, top: `${rect.top - 3}px`, width: `${rect.width + 6}px`, height: `${rect.height + 6}px`,
    });
    root.querySelector(".tag").textContent = label;
    document.documentElement.append(host);
    if (point && point.x >= 0 && point.y >= 0 && point.x <= innerWidth && point.y <= innerHeight) {
      const cursor = root.querySelector(".cursor");
      // A hidden tab runs no transitions, so the cursor would stay at its start: put it on the point.
      const from = document.visibilityState === "visible" ? lastPointer ?? { x: point.x - 60, y: point.y - 60 } : point;
      cursor.hidden = false;
      Object.assign(cursor.style, { left: `${from.x}px`, top: `${from.y}px` });
      cursor.getBoundingClientRect(); // lay out the start so the move animates
      Object.assign(cursor.style, { left: `${point.x}px`, top: `${point.y}px` });
      lastPointer = { x: point.x, y: point.y };
    }
    flashHost = host;
    setTimeout(() => {
      if (flashHost === host) hideFlash();
    }, 900);
  }

  function hideFlash() {
    flashHost?.remove();
    flashHost = null;
  }

  // A small pill in the corner while the agent works in this tab, with a Stop button.
  // It goes away after a quiet spell and is hidden from screenshots.
  const DRIVING_QUIET_MS = 8000;
  let driving = null;

  function showDriving() {
    if (!driving?.host.isConnected) {
      const host = document.createElement("fxmcp-overlay");
      host.style.cssText = "all: initial; position: fixed; left: 12px; bottom: 12px; z-index: 2147483646;";
      const root = host.attachShadow({ mode: "closed" });
      root.innerHTML = `<style>
        .pill { display: flex; align-items: center; gap: 8px; padding: 4px 6px 4px 10px; border-radius: 999px;
          background: #1f1d2b; color: #f4f4f6; font: 12px/18px system-ui, sans-serif;
          box-shadow: 0 4px 14px rgba(0, 0, 0, .3); opacity: .92; }
        .dot { width: 8px; height: 8px; border-radius: 50%; background: #2ac3a2; }
        button { font: inherit; padding: 0 8px; border-radius: 999px; border: 1px solid #d93d3d; background: transparent;
          color: #ff8a8a; cursor: pointer; }
      </style><div class="pill"><span class="dot"></span>The agent is driving this tab<button>Stop</button></div>`;
      root.querySelector("button").addEventListener("click", (event) => {
        // Only a real click from the user; the page can't press it for them.
        if (!event.isTrusted) return;
        browser.runtime.sendMessage({ type: "page:stop" }).catch(() => {});
        hideDriving();
      });
      document.documentElement.append(host);
      driving = { host, timer: 0 };
    }
    clearTimeout(driving.timer);
    driving.timer = setTimeout(hideDriving, DRIVING_QUIET_MS);
  }

  function hideDriving() {
    if (!driving) return;
    clearTimeout(driving.timer);
    driving.host.remove();
    driving = null;
  }

  // The bridge's own overlays never count as something covering the page.
  function isOurs(node) {
    for (let n = node; n; n = n.parentNode ?? n.host) {
      if (n.localName === "fxmcp-overlay") return true;
    }
    return false;
  }

  // Synthetic clicks don't select text, so a double or triple click does it by hand:
  // a word or a whole field / paragraph, like a real one.
  function selectLikeClicks(target, point, count) {
    if (isTextField(target)) {
      if (count >= 3) target.select();
      return;
    }
    const selection = getSelection();
    if (count >= 3) {
      const block = target.closest("p, li, td, th, h1, h2, h3, h4, h5, h6, blockquote, pre, dd, dt, label, div") ?? target;
      const range = document.createRange();
      range.selectNodeContents(block);
      selection.removeAllRanges();
      selection.addRange(range);
      return;
    }
    const caret = document.caretPositionFromPoint?.(point.x, point.y);
    if (!caret || caret.offsetNode.nodeType !== Node.TEXT_NODE) return;
    const text = caret.offsetNode.textContent;
    let start = caret.offset;
    let end = caret.offset;
    while (start > 0 && /\w/.test(text[start - 1])) start--;
    while (end < text.length && /\w/.test(text[end])) end++;
    if (start === end) return;
    const range = document.createRange();
    range.setStart(caret.offsetNode, start);
    range.setEnd(caret.offsetNode, end);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  function resolveTarget({ ref, x, y }) {
    if (ref) {
      const el = byRef(ref);
      const point = centerOf(el);
      const hit = deepElementFromPoint(point.x, point.y);
      const covered = hit && !isOurs(hit) && !composedContains(el, hit) && !composedContains(hit, el);
      const offscreen = point.x < 0 || point.y < 0 || point.x > innerWidth || point.y > innerHeight;
      let warning = "";
      if (offscreen) warning = " Its box is outside the viewport (normal for Flutter's accessibility layer), so the events went straight to it.";
      else if (covered) warning = ` Note: another element is on top of it (${describe(hit)}).`;
      return { el, target: hit && composedContains(el, hit) ? hit : el, point, warning };
    }
    if (x == null || y == null) throw new Error("Pass either ref or both x and y. Nothing was done.");
    const hit = deepElementFromPoint(x, y);
    if (!hit) throw new Error(`Nothing at (${x}, ${y}). Coordinates are CSS pixels within the viewport. Nothing was done.`);
    return { el: hit, target: hit, point: { x, y }, warning: "" };
  }

  function modifierInit(modifiers = []) {
    const has = (...names) => modifiers.some((m) => names.includes(m.toLowerCase()));
    return {
      ctrlKey: has("ctrl", "control"),
      shiftKey: has("shift"),
      altKey: has("alt", "option"),
      metaKey: has("meta", "cmd", "command"),
    };
  }

  function fireMouse(type, target, point, extra) {
    const init = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: point.x, clientY: point.y,
      screenX: point.x + window.mozInnerScreenX, screenY: point.y + window.mozInnerScreenY,
      ...extra,
    };
    const Ctor = type.startsWith("pointer") ? PointerEvent : MouseEvent;
    if (Ctor === PointerEvent) Object.assign(init, { pointerId: 1, pointerType: "mouse", isPrimary: true });
    return target.dispatchEvent(new Ctor(type, init));
  }

  function hoverAt(target, point, mods) {
    for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) {
      fireMouse(type, target, point, { ...mods, bubbles: !type.endsWith("enter") });
    }
  }

  function setNativeValue(el, value) {
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
      : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(proto, "value").set.call(el, value);
    el.dispatchEvent(new Event("input", { bubbles: true, composed: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function isTextField(el) {
    return el instanceof HTMLTextAreaElement ||
      (el instanceof HTMLInputElement && inputRole(el) && ["textbox", "searchbox", "spinbutton"].includes(inputRole(el)));
  }

  function moveFocus(from, step) {
    const focusable = [...document.querySelectorAll(
      "a[href], button, input, select, textarea, summary, [tabindex], [contenteditable]"
    )].filter((el) => !el.disabled && el.getAttribute("tabindex") !== "-1" && isVisible(el));
    if (focusable.length === 0) return;
    const index = focusable.indexOf(from);
    focusable[(index + step + focusable.length) % focusable.length].focus();
  }

  const KEY_CODES = {
    Enter: "Enter", Tab: "Tab", Escape: "Escape", Backspace: "Backspace", Delete: "Delete",
    ArrowUp: "ArrowUp", ArrowDown: "ArrowDown", ArrowLeft: "ArrowLeft", ArrowRight: "ArrowRight",
    Home: "Home", End: "End", PageUp: "PageUp", PageDown: "PageDown", " ": "Space",
  };

  function codeFor(key) {
    if (KEY_CODES[key]) return KEY_CODES[key];
    if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
    if (/^[0-9]$/.test(key)) return `Digit${key}`;
    return key;
  }

  // Synthetic key events don't trigger browser defaults, so do the common ones by hand.
  function keyDefault(target, key, mods) {
    const editable = isTextField(target) || target.isContentEditable;
    if ((mods.ctrlKey || mods.metaKey) && key.toLowerCase() === "a") {
      if (isTextField(target)) target.select();
      else document.execCommand("selectAll");
      return;
    }
    if (mods.ctrlKey || mods.metaKey || mods.altKey) return;

    if (key === "Enter") {
      if (target instanceof HTMLTextAreaElement) document.execCommand("insertText", false, "\n");
      else if (target.isContentEditable) document.execCommand("insertParagraph");
      else if (target instanceof HTMLInputElement && target.form) target.form.requestSubmit();
      else if (target.matches?.("a[href], button, [role=button], summary")) target.click();
      return;
    }
    if (key === "Tab") return moveFocus(target, mods.shiftKey ? -1 : 1);
    if (!editable) {
      if (key === " " && target.matches?.("button, [role=button], input[type=checkbox], input[type=radio], summary")) {
        target.click();
        return;
      }
      const scrollBy = { PageDown: 0.85, " ": 0.85, PageUp: -0.85, ArrowDown: 0.1, ArrowUp: -0.1 }[key];
      if (scrollBy) window.scrollBy({ top: scrollBy * innerHeight * (mods.shiftKey && key === " " ? -1 : 1), behavior: "instant" });
      if (key === "Home") window.scrollTo({ top: 0, behavior: "instant" });
      if (key === "End") window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" });
      return;
    }
    if (key === "Backspace") document.execCommand("delete");
    else if (key === "Delete") document.execCommand("forwardDelete");
    else if (key.length === 1) document.execCommand("insertText", false, key);
  }

  function scrollContainerAt(x, y, horizontal) {
    let el = deepElementFromPoint(x, y);
    while (el && el !== document.documentElement && el !== document.body) {
      const style = getComputedStyle(el);
      const overflow = horizontal ? style.overflowX : style.overflowY;
      const scrollable = horizontal ? el.scrollWidth > el.clientWidth : el.scrollHeight > el.clientHeight;
      if (/(auto|scroll|overlay)/.test(overflow) && scrollable) return el;
      el = el.parentElement ?? el.getRootNode().host;
    }
    return document.scrollingElement;
  }

  // ---- Flutter web ------------------------------------------------------

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  function deepQuery(selector) {
    const found = document.querySelector(selector);
    if (found) return found;
    for (const host of document.querySelectorAll("flutter-view, flt-glass-pane")) {
      const inner = host.openOrClosedShadowRoot?.querySelector(selector);
      if (inner) return inner;
    }
    return null;
  }

  // Flutter draws to a canvas and only builds a DOM tree once accessibility is
  // switched on via its hidden "Enable accessibility" placeholder.
  async function ensureFlutterSemantics() {
    const placeholder = deepQuery("flt-semantics-placeholder");
    if (!placeholder) return "";
    const point = { x: 0, y: 0 };
    for (const type of ["pointerdown", "mousedown", "pointerup", "mouseup", "click"]) {
      fireMouse(type, placeholder, point, { button: 0, buttons: type.endsWith("down") ? 1 : 0 });
    }
    for (let waited = 0; waited < 3000; waited += 100) {
      if (deepQuery("flt-semantics")) break;
      await sleep(100);
    }
    await sleep(200);
    return deepQuery("flt-semantics")
      ? "(Flutter app: switched on its accessibility mode so it can be read and controlled.)\n"
      : "(Flutter app: tried to switch on accessibility mode, but no semantics appeared. Use screenshot and x/y clicks.)\n";
  }

  function insideFlutter(el) {
    for (let n = el; n; n = n.parentNode ?? n.host) {
      if (n.localName === "flutter-view" || n.localName?.startsWith("flt-")) return true;
    }
    return false;
  }

  function fireWheel(target, point, deltaX, deltaY) {
    // Several smaller ticks, like a real wheel; canvas apps ignore one huge jump less often.
    const ticks = 5;
    for (let i = 0; i < ticks; i++) {
      target.dispatchEvent(new WheelEvent("wheel", {
        bubbles: true, cancelable: true, composed: true, view: window,
        clientX: point.x, clientY: point.y,
        screenX: point.x + window.mozInnerScreenX, screenY: point.y + window.mozInnerScreenY,
        deltaX: deltaX / ticks, deltaY: deltaY / ticks, deltaMode: WheelEvent.DOM_DELTA_PIXEL,
      }));
    }
  }

  // ---- Change tracking: what an action did --------------------------------

  const MESSAGE_SELECTOR = [
    "[role=alert]", "[role=status]", "[aria-live]:not([aria-live=off])", "output",
    "mat-snack-bar-container", ".mat-mdc-snack-bar-container", "mat-error", ".mat-mdc-form-field-error",
    ".toast", ".ngx-toastr", ".Toastify__toast", ".swal2-popup", ".notification", ".alert",
    ".invalid-feedback", ".error-message",
  ].join(", ");
  const DIALOG_SELECTOR = "dialog[open], [role=dialog], [role=alertdialog], mat-dialog-container, " +
    ".mat-mdc-dialog-container, .modal.show";
  // Dialogs plus menus, dropdowns and popovers: things an action opens on top of the page.
  const OVERLAY_SELECTOR = `${DIALOG_SELECTOR}, [role=menu], [role=listbox], .cdk-overlay-pane, :popover-open, ` +
    ".dropdown-menu.show";
  const STATE_ATTRIBUTES = ["aria-invalid", "aria-expanded", "aria-checked", "aria-selected", "aria-disabled", "disabled"];
  const WATCH_LIMIT_MS = 30000;
  let watch = null;

  function startWatch(target) {
    stopWatch();
    const state = { target, added: new Set(), removed: [], attributes: new Map() };
    const observer = new MutationObserver((records) => recordMutations(state, records));
    observer.observe(document.documentElement, {
      subtree: true, childList: true, characterData: true,
      attributes: true, attributeOldValue: true, attributeFilter: STATE_ATTRIBUTES,
    });
    // Nobody may ever collect this watch (e.g. the action failed), so don't observe forever.
    watch = { observer, state, timer: setTimeout(stopWatch, WATCH_LIMIT_MS) };
  }

  function stopWatch() {
    if (!watch) return;
    watch.observer.disconnect();
    clearTimeout(watch.timer);
    watch = null;
  }

  function recordMutations(state, records) {
    for (const record of records) {
      // <head> holds the tab title and metadata, not anything shown on the page.
      if (document.head?.contains(record.target)) continue;
      if (record.type === "attributes") {
        let old = state.attributes.get(record.target);
        if (!old) state.attributes.set(record.target, old = new Map());
        if (!old.has(record.attributeName)) old.set(record.attributeName, record.oldValue);
        continue;
      }
      if (record.type === "characterData") {
        if (record.target.parentElement) state.added.add(record.target.parentElement);
        continue;
      }
      for (const node of record.addedNodes) {
        const el = node.nodeType === Node.ELEMENT_NODE ? node : node.parentElement;
        if (el) state.added.add(el);
      }
      for (const node of record.removedNodes) {
        // Added and removed again within the action (spinners, ripples): no net change.
        if (state.added.delete(node)) continue;
        if (node.nodeType === Node.TEXT_NODE) state.added.add(record.target);
        const text = node.nodeType === Node.ELEMENT_NODE ? textOf(node)
          : node.nodeType === Node.TEXT_NODE ? node.textContent : "";
        if (text.trim()) state.removed.push(clean(text, 120));
      }
    }
  }

  // Ancestor steps between two elements, to list changes near the target first.
  function treeDistance(a, b) {
    if (!a?.isConnected || !b) return 0;
    const depthOf = new Map();
    let depth = 0;
    for (let n = a; n; n = n.parentElement) depthOf.set(n, depth++);
    depth = 0;
    for (let n = b; n; n = n.parentElement, depth++) {
      if (depthOf.has(n)) return depthOf.get(n) + depth;
    }
    return Infinity;
  }

  function changeLine(el, overlay) {
    if (isInteractive(el, roleOf(el))) return describe(el);
    const controls = [...el.querySelectorAll(INTERACTIVE_SELECTOR)]
      .filter((control) => isInteractive(control, roleOf(control)) && isVisible(control))
      .slice(0, 4)
      .map((control) => describe(control));
    // An overlay gets a ref, so the next read can be just that overlay.
    const kind = roleOf(el) ?? (el.matches(DIALOG_SELECTOR) ? "dialog" : "overlay");
    let line = overlay ? `${describe(el, kind)} ${JSON.stringify(clean(el.innerText, 150))}`
      : `${roleOf(el) ?? "text"} ${JSON.stringify(clean(el.innerText, 150))}`;
    if (controls.length) line += ` with ${controls.join(", ")}`;
    return line;
  }

  function summarizeChanges() {
    if (!watch) return null;
    const { state, observer } = watch;
    recordMutations(state, observer.takeRecords());
    stopWatch();
    const { target, added, removed, attributes } = state;
    const editing = target && (isTextField(target) || target.isContentEditable);

    // Keep the outermost changed elements that are still on the page and show text or controls.
    const candidates = [...added].filter((el) => el.isConnected && !SKIP_TAGS.has(el.localName) &&
      !(editing && composedContains(target, el)));
    const candidateSet = new Set(candidates);
    const roots = candidates.filter((el) => {
      for (let p = el.parentElement; p; p = p.parentElement) if (candidateSet.has(p)) return false;
      return isShown(el);
    });

    const messages = [];
    const others = [];
    const seen = new Set();
    for (const el of roots) {
      const message = el.closest(MESSAGE_SELECTOR) ?? el.querySelector(MESSAGE_SELECTOR);
      if (message) {
        const text = clean(message.innerText, 200);
        if (text && !seen.has(text)) {
          seen.add(text);
          const role = roleOf(message);
          messages.push(`${role ? `${role} ` : ""}${JSON.stringify(text)}`);
        }
        continue;
      }
      const dialog = el.closest(OVERLAY_SELECTOR) ?? el.querySelector(OVERLAY_SELECTOR);
      const shown = dialog ?? el;
      const text = clean(shown.innerText, 150);
      if (!text && !shown.querySelector(INTERACTIVE_SELECTOR)) continue;
      if (seen.has(text)) continue;
      seen.add(text);
      others.push({ line: changeLine(shown, !!dialog), dialog: !!dialog, distance: treeDistance(target, shown) });
    }
    others.sort((a, b) => b.dialog - a.dialog || a.distance - b.distance);

    const states = [];
    for (const [el, old] of attributes) {
      if (!el.isConnected || !isVisible(el)) continue;
      for (const [name, before] of old) {
        const now = el.getAttribute(name);
        if (now === before) continue;
        const show = (value) => value === null ? "unset" : value === "" ? "set" : value;
        states.push(`${describe(el)}: ${name} ${show(before)} → ${show(now)}`);
      }
    }

    const gone = [...new Set(removed)].filter((text) => !seen.has(text));
    const lines = [
      ...others.slice(0, 6).map(({ line, dialog }) => `${dialog ? "Opened" : "Added"}: ${line}`),
      ...(others.length > 6 ? [`Added: …and ${others.length - 6} more`] : []),
      ...states.slice(0, 5).map((line) => `State: ${line}`),
      ...gone.slice(0, 3).map((text) => `Removed: ${JSON.stringify(text)}`),
    ];
    return { messages: messages.slice(0, 4), lines };
  }

  // ---- Overlay: highlights shown to the user ------------------------------

  const OVERLAY_TONES = { input: "#ffc400", approval: "#ff8a00" };
  const OVERLAY_CSS = `
    .frame { position: fixed; box-sizing: border-box; border: 3px solid var(--tone); border-radius: 6px;
      animation: pulse 1.1s ease-in-out infinite; }
    @keyframes pulse {
      0%, 100% { box-shadow: 0 0 0 0 color-mix(in srgb, var(--tone) 70%, transparent); }
      50% { box-shadow: 0 0 0 10px transparent; }
    }
    .card { position: fixed; box-sizing: border-box; max-width: min(380px, calc(100vw - 16px));
      padding: 10px 12px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--tone) 55%, transparent);
      background: #1f1d2b; color: #f4f4f6; font: 13px/1.45 system-ui, sans-serif;
      box-shadow: 0 8px 28px rgba(0, 0, 0, .35); pointer-events: auto; }
    .title { font-weight: 600; color: var(--tone); }
    .text { white-space: pre-wrap; overflow-wrap: anywhere; }
    .buttons { display: flex; gap: 8px; margin-top: 8px; }
    .buttons:empty { display: none; }
    button { font: inherit; padding: 4px 12px; border-radius: 5px; border: 1px solid #55526a;
      background: transparent; color: inherit; cursor: pointer; }
    button.primary { background: var(--tone); border-color: var(--tone); color: #1b1a22; font-weight: 600; }
  `;
  let overlay = null;
  let masks = null;

  function hideOverlay() {
    overlay?.remove();
    overlay = null;
  }

  // Outlines `el` with a pulsing border and a card. The card lives in a closed shadow
  // root and only acts on trusted (real user) clicks, so neither the page nor a
  // synthetic click from the agent can press its buttons.
  function showOverlay(el, { tone, title, text, buttons = [] }) {
    hideOverlay();
    const host = document.createElement("fxmcp-overlay");
    host.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
    host.style.setProperty("--tone", OVERLAY_TONES[tone]);
    const root = host.attachShadow({ mode: "closed" });
    root.innerHTML = `<style>${OVERLAY_CSS}</style><div class="frame"></div>` +
      '<div class="card"><div class="title"></div><div class="text"></div><div class="buttons"></div></div>';
    const frame = root.querySelector(".frame");
    const card = root.querySelector(".card");
    root.querySelector(".title").textContent = title;
    root.querySelector(".text").textContent = text ?? "";
    for (const { label, primary, onClick } of buttons) {
      const button = document.createElement("button");
      button.textContent = label;
      if (primary) button.className = "primary";
      button.addEventListener("click", (event) => {
        if (event.isTrusted) onClick();
      });
      root.querySelector(".buttons").append(button);
    }
    document.documentElement.append(host);

    let frameId = 0;
    const place = () => {
      const rect = el.getBoundingClientRect();
      Object.assign(frame.style, {
        left: `${rect.left - 4}px`, top: `${rect.top - 4}px`,
        width: `${rect.width + 8}px`, height: `${rect.height + 8}px`,
      });
      const above = rect.top - card.offsetHeight - 12;
      const top = above >= 8 ? above : rect.bottom + 12;
      card.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - card.offsetWidth - 8))}px`;
      card.style.top = `${Math.max(8, Math.min(top, innerHeight - card.offsetHeight - 8))}px`;
      frameId = requestAnimationFrame(place);
    };
    place();
    overlay = {
      remove() {
        cancelAnimationFrame(frameId);
        host.remove();
      },
    };
  }

  // ---- Risky actions ------------------------------------------------------

  const RISKY_WORDS =
    /\b(publish|delete|remove|submit|pay|purchase|buy|checkout|check out|place order|send|transfer|deploy|revoke|destroy|terminate)\b/i;
  const CLICKABLE = "button, a[href], summary, input[type=submit], input[type=button], " +
    "[role=button], [role=link], [role=menuitem], [role=tab]";
  let riskTarget = null;
  let inputRequest = null;

  // Where some text is showing, as " in [ref_N] …", for wait_for's answer.
  function placeOfText(text) {
    const needle = text.toLowerCase();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (!walker.currentNode.textContent.toLowerCase().includes(needle) || !parent || !isVisible(parent)) continue;
      const role = roleOf(parent);
      return ` in ${role || isInteractive(parent, role) ? describe(parent, role)
        : `[${refFor(parent)}] text ${JSON.stringify(clean(parent.innerText, 100))}`}`;
    }
    return "";
  }

  // ---- Handlers ----------------------------------------------------------

  // innerText of `el` without its navigation and sidebars, which are listed in `skipped`.
  function textWithoutNav(el, skipped) {
    if (el.localName !== "body" && isNavigation(el)) {
      skipped.push(describe(el, roleOf(el) ?? "navigation"));
      return "";
    }
    if (![...el.querySelectorAll(NAV_SELECTOR)].some(isNavigation)) return el.innerText ?? "";
    const parts = [];
    for (const node of el.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) parts.push(node.textContent.trim());
      else if (node.nodeType === Node.ELEMENT_NODE && !SKIP_TAGS.has(node.localName) &&
          isShown(node)) {
        parts.push(textWithoutNav(node, skipped).trim());
      }
    }
    return parts.filter(Boolean).join("\n");
  }

  function skippedNote(skipped) {
    return skipped.length
      ? `\n(Skipped navigation: ${skipped.join(", ")}. Read one by passing its ref.)`
      : "";
  }

  // The scope a read starts from: a ref's element, or the whole page.
  function scopeHeader(ref, root, lines) {
    if (!ref || lines[0]?.trimStart().startsWith(`[${ref}]`)) return "";
    return `Inside ${scopeLabel(root)}:\n`;
  }

  // A ref's element as a short label: plain elements by tag, not by all the text inside.
  function scopeLabel(el) {
    const role = roleOf(el);
    const kind = containerRole(el, role) ?? role;
    return kind ? describe(el, kind) : `[${refFor(el)}] ${el.localName}`;
  }

  // The kind find filters on: the role, "clickable" for unmarked controls, "text" otherwise.
  function findKind(role, interactive) {
    return role ?? (interactive ? "clickable" : "text");
  }

  function roleFilter(role) {
    const wanted = new Set();
    for (const word of role.toLowerCase().split(/[\s,|]+/).filter(Boolean)) {
      for (const kind of ROLE_ALIASES[word] ?? [word]) wanted.add(kind);
    }
    return wanted;
  }

  function rolesPresent(root) {
    const counts = new Map();
    for (const el of visibleElements(root)) {
      const role = roleOf(el);
      const interactive = isInteractive(el, role);
      if ((!role && !interactive) || !isVisible(el)) continue;
      const kind = findKind(role, interactive);
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    return [...counts].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([kind, n]) => `${kind} (${n})`).join(", ");
  }

  const MAX_FIND_MATCHES = 500;

  const handlers = {
    async readPage(args) {
      withBoxes = !!args.boxes;
      try {
        return await handlers.readPageWith(args);
      } finally {
        withBoxes = false;
      }
    },

    async find(args) {
      withBoxes = !!args.boxes;
      try {
        return await handlers.findWith(args);
      } finally {
        withBoxes = false;
      }
    },

    async readPageWith({ filter = "interactive", ref, depth, skip_nav: skipNav = false }) {
      const flutterNote = await ensureFlutterSemantics();
      const root = ref ? byRef(ref) : document.documentElement;
      const mode = filter === "all" ? "all" : "interactive";
      const opts = {
        mode, root, skipNav, skipped: [], chars: 0,
        structured: mode === "all" || depth != null,
        maxDepth: depth ?? Infinity,
      };
      const lines = [];
      const section = ref ? sectionOf(root) : null;
      if (section) {
        // A heading's ref reads its section; depth then counts from the heading.
        if (depth != null) opts.maxDepth = depth + 1;
        countingTwins(() => walkSection(root, section, 0, lines, opts));
      } else {
        countingTwins(() => walk(root, 0, lines, opts));
      }
      let limit = "";
      if (readFull(lines, opts)) {
        const unreached = unreachedRegions(opts);
        limit = "\n…(size limit reached. " + (unreached.length
          ? `Not read yet:\n${unreached.join("\n")}\nRead one by its ref.)`
          : "Read an outline with depth: 2, then one region at a time by its ref.)");
      }
      const body = lines.join("\n") || "(no matching elements)";
      return truncate(pageHeader() + flutterNote + scopeHeader(ref, root, lines) + body + skippedNote(opts.skipped) + limit);
    },

    pageText({ ref, skip_nav: skipNav = false }) {
      const root = ref ? byRef(ref) : document.querySelector("main, article, [role=main]") ?? document.body;
      const skipped = [];
      const roots = ref ? scopeOfRef(root) : [root];
      const raw = roots.map((node) => (skipNav ? textWithoutNav(node, skipped) : node.innerText ?? textOf(node))).join("\n");
      const text = raw.replace(/\n{3,}/g, "\n\n").trim();
      return truncate(pageHeader() + (ref ? `Inside ${scopeLabel(root)}:\n` : "") + text + skippedNote(skipped));
    },

    async findWith({ query = "", role, exact = false, ref, limit = 25 }) {
      await ensureFlutterSemantics();
      const wanted = clean(query, 1000).toLowerCase();
      const kinds = role ? roleFilter(role) : null;
      if (!wanted && !kinds) throw new Error("Pass a query, a role, or both.");
      const root = ref ? byRef(ref) : document.documentElement;
      const terms = wanted.split(" ").filter(Boolean);
      const matches = [];
      // Matches that fit the query but not the role, shown when nothing fits both.
      const otherRoles = [];

      for (const el of ref ? visibleIn(scopeOfRef(root)) : visibleElements(root)) {
        if (CANVAS_HOSTS.has(el.localName)) continue;
        const elRole = roleOf(el);
        const interactive = isInteractive(el, elRole);
        const kind = findKind(elRole, interactive);
        if (!wanted && !kinds.has(kind)) continue;
        // A text block matches on all its text, links included; other elements on their own text.
        const fullText = interactive || elRole === "heading" ? nameOf(el, elRole)
          : TEXT_BLOCKS.has(el.localName) ? clean(el.innerText ?? textOf(el), 100000)
          : ownText(el) || clean(el.getAttribute("aria-label") ?? "");
        const text = clean(fullText, 300);
        if (kind === "text" && !text) continue;
        if (wanted) {
          if (!text) continue;
          const hit = exact
            ? fullText.toLowerCase() === wanted
            : terms.every((term) => `${fullText} ${el.getAttribute("placeholder") ?? ""} ${el.getAttribute("href") ?? ""}`
              .toLowerCase().includes(term));
          if (!hit) continue;
        }
        if (!isVisible(el)) continue;
        // Controls first, then headings, then other roles, then plain text.
        const match = { el, role: elRole, text, rank: interactive ? 0 : elRole === "heading" ? 1 : elRole ? 2 : 3 };
        if (!kinds || kinds.has(kind)) matches.push(match);
        else if (otherRoles.length < 5) otherRoles.push(match);
        if (matches.length >= MAX_FIND_MATCHES) break;
      }

      // A list item holding a matching paragraph would repeat it: keep the innermost text match.
      const textMatches = matches.filter((m) => m.rank === 3);
      for (const m of textMatches) {
        if (textMatches.some((other) => other !== m && m.el.contains(other.el))) matches.splice(matches.indexOf(m), 1);
      }

      const where = ref ? ` inside ${ref}` : "";
      const line = ({ el, role: elRole, text }) =>
        elRole || isInteractive(el, elRole) ? describe(el, elRole)
          : `[${refFor(el)}] text ${JSON.stringify(text)}${withBoxes ? boxOf(el) : ""}`;
      if (!matches.length) {
        const what = wanted ? `"${query}"` : "anything";
        if (!kinds) return `Nothing visible matches ${what}${where}.`;
        if (otherRoles.length) {
          return `Nothing with role ${role} matches ${what}${where}. With other roles:\n` +
            countingTwins(() => otherRoles.map(line)).join("\n");
        }
        return `Nothing with role ${role} matches ${what}${where}. Roles here: ${rolesPresent(root) || "none"}.`;
      }
      matches.sort((a, b) => a.rank - b.rank);
      const lines = countingTwins(() => matches.slice(0, limit).map(line));
      // A shown match whose twin fell past the limit can't be found again either.
      const sameAs = (m) => `${m.role}|${m.text}`;
      const seen = new Map();
      for (const m of matches) seen.set(sameAs(m), (seen.get(sameAs(m)) ?? 0) + 1);
      for (const m of matches.slice(0, limit)) {
        if (seen.get(sameAs(m)) > 1) refs.get(elementRefs.get(m.el)).identity.twin = true;
      }
      if (matches.length > limit) {
        const more = matches.length >= MAX_FIND_MATCHES ? `${MAX_FIND_MATCHES - limit}+` : matches.length - limit;
        lines.push(`…and ${more} more. Narrow it with role, exact or ref.`);
      }
      return lines.join("\n");
    },

    async click({ ref, x, y, button = "left", clickCount = 1, modifiers }) {
      if (ref) await whenActionable(ref);
      const { el, target, point, warning } = resolveTarget({ ref, x, y });
      flash(el, clickCount === 3 ? "triple-click" : clickCount === 2 ? "double-click" : "click", point);
      const mods = modifierInit(modifiers);
      const buttonIndex = { left: 0, middle: 1, right: 2 }[button] ?? 0;
      const buttonsMask = [1, 4, 2][buttonIndex];

      hoverAt(target, point, mods);
      for (let i = 1; i <= clickCount; i++) {
        const base = { ...mods, button: buttonIndex, detail: i };
        fireMouse("pointerdown", target, point, { ...base, buttons: buttonsMask });
        const proceed = fireMouse("mousedown", target, point, { ...base, buttons: buttonsMask });
        if (proceed) {
          target.closest?.("input, textarea, select, button, a[href], [tabindex], [contenteditable]")
            ?.focus({ preventScroll: true });
        }
        fireMouse("pointerup", target, point, { ...base, buttons: 0 });
        fireMouse("mouseup", target, point, { ...base, buttons: 0 });
        if (buttonIndex === 2) fireMouse("contextmenu", target, point, base);
        else if (buttonIndex === 0) fireMouse("click", target, point, base);
        else fireMouse("auxclick", target, point, base);
      }
      if (clickCount >= 2 && buttonIndex === 0) fireMouse("dblclick", target, point, { ...mods, detail: 2 });
      if (clickCount >= 2 && buttonIndex === 0) selectLikeClicks(target, point, clickCount);

      const what = clickCount === 3 ? "Triple-clicked" : clickCount === 2 ? "Double-clicked"
        : button === "right" ? "Right-clicked" : "Clicked";
      const fieldSelection = isTextField(target) ? target.value.slice(target.selectionStart ?? 0, target.selectionEnd ?? 0) : null;
      const selected = clickCount >= 2 ? clean(fieldSelection ?? String(getSelection()), 80) : "";
      return `${what} ${describe(el)} at (${Math.round(point.x)}, ${Math.round(point.y)}).${warning}` +
        (selected ? ` Selected ${JSON.stringify(selected)}.` : "");
    },

    async hover({ ref, x, y }) {
      if (ref) await whenActionable(ref);
      const { el, target, point, warning } = resolveTarget({ ref, x, y });
      flash(el, "hover", point);
      hoverAt(target, point, {});
      return `Hovering ${describe(el)}.${warning}`;
    },

    async type({ ref, text, clear = false, submit = false }) {
      let el = ref ? await whenActionable(ref) : deepActiveElement();
      if (!el || el === document.body) throw new Error("No element is focused. Pass a ref to type into. Nothing was done.");

      // Flutter (and some custom widgets) only wire up the real input once the field
      // is tapped; text set before that is thrown away. Tap it and wait for the app.
      const flutterField = insideFlutter(el);
      if (flutterField || (!isTextField(el) && !el.isContentEditable)) {
        await handlers.click({ ref: ref ?? refFor(el) });
        await sleep(flutterField ? 400 : 200);
        const active = deepActiveElement();
        if (active && (isTextField(active) || active.isContentEditable)) el = active;
      }
      el.focus();
      flash(el, "type");

      if (isTextField(el)) {
        const expected = clear ? text : el.value + text;
        if (clear) el.select();
        else {
          try {
            el.setSelectionRange(el.value.length, el.value.length);
          } catch {
            // email/number inputs don't support selection ranges
          }
        }
        // execCommand fires the same input events as real typing, which frameworks rely on.
        const inserted = document.execCommand("insertText", false, text);
        if (!inserted || el.value !== expected) setNativeValue(el, expected);
      } else if (el.isContentEditable) {
        const selection = getSelection();
        const range = document.createRange();
        range.selectNodeContents(el);
        if (!clear) range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
        document.execCommand("insertText", false, text);
      } else {
        throw new Error(`${describe(el)} is not a text field.`);
      }

      if (submit) handlers.pressKey({ key: "Enter" });
      const lineCount = text.split("\n").length;
      const lines = lineCount > 1 ? ` (${lineCount} lines)` : "";
      return `Typed${lines} into ${describe(el)}${submit ? " and pressed Enter" : ""}.`;
    },

    pressKey({ key, ref }) {
      const parts = key.split("+");
      let main = parts.pop() || "+";
      if (main === "Space") main = " ";
      if (main === "Esc") main = "Escape";
      const mods = modifierInit(parts);
      const target = ref ? byRef(ref) : deepActiveElement() ?? document.body;
      if (ref) target.focus();

      const init = { key: main, code: codeFor(main), bubbles: true, cancelable: true, composed: true, ...mods };
      const proceed = target.dispatchEvent(new KeyboardEvent("keydown", init));
      if (proceed && (main.length === 1 || main === "Enter") && !mods.ctrlKey && !mods.metaKey) {
        target.dispatchEvent(new KeyboardEvent("keypress", init));
      }
      if (proceed) keyDefault(target, main, mods);
      target.dispatchEvent(new KeyboardEvent("keyup", init));
      return `Pressed ${key} on ${describe(target)}.`;
    },

    async setValue({ ref, value }) {
      const el = await whenActionable(ref, { pointer: false });
      el.scrollIntoView({ block: "center", behavior: "instant" });
      flash(el, "set");

      if (el instanceof HTMLSelectElement) {
        const wanted = String(value).toLowerCase();
        const option = [...el.options].find((o) => o.value.toLowerCase() === wanted) ??
          [...el.options].find((o) => clean(o.textContent).toLowerCase() === wanted) ??
          [...el.options].find((o) => clean(o.textContent).toLowerCase().includes(wanted));
        if (!option) {
          const choices = [...el.options].map((o) => clean(o.textContent, 40)).join(", ");
          throw new Error(`No option matches "${value}". Options: ${choices}. Nothing was done.`);
        }
        setNativeValue(el, option.value);
        return `Selected "${clean(option.textContent)}" in ${describe(el)}.`;
      }

      if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
        const want = value === true || ["true", "on", "yes", "1", "checked"].includes(String(value).toLowerCase());
        if (el.checked !== want) el.click();
        return `Set ${describe(el)}.`;
      }

      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
        el.focus();
        setNativeValue(el, String(value));
        return `Set ${describe(el)}.`;
      }

      if (el.isContentEditable) return handlers.type({ ref, text: String(value), clear: true });
      throw new Error(`${describe(el)} is not a form field. Use click or type instead. Nothing was done.`);
    },

    scroll({ direction = "down", amount = 1, ref, x, y }) {
      if (ref) {
        byRef(ref).scrollIntoView({ block: "center", behavior: "instant" });
        return `Scrolled ${ref} into view.`;
      }
      const horizontal = direction === "left" || direction === "right";
      const sign = direction === "up" || direction === "left" ? -1 : 1;
      const point = x != null && y != null ? { x, y } : { x: innerWidth / 2, y: innerHeight / 2 };
      const container = scrollContainerAt(point.x, point.y, horizontal);
      const step = (horizontal ? container.clientWidth : container.clientHeight) * 0.85 * amount * sign;
      const before = horizontal ? container.scrollLeft : container.scrollTop;
      container.scrollBy({ left: horizontal ? step : 0, top: horizontal ? 0 : step, behavior: "instant" });
      const after = horizontal ? container.scrollLeft : container.scrollTop;

      if (after === before) {
        // Nothing scrollable in the DOM: canvas apps (Flutter, maps, editors) scroll on wheel events.
        const target = deepElementFromPoint(point.x, point.y) ?? document.body;
        fireWheel(target, point, horizontal ? step : 0, horizontal ? 0 : step);
        return `Sent ${Math.abs(Math.round(step))}px of mouse-wheel ${direction} at (${Math.round(point.x)}, ${Math.round(point.y)}) ` +
          "because the page has no native scroll there (canvas app or already at the end). Take a screenshot to confirm it moved.";
      }

      if (container === document.scrollingElement) {
        const max = Math.max(0, container.scrollHeight - innerHeight);
        return `Scrolled ${direction}. Page is at ${Math.round(scrollY)} of ${max}px.`;
      }
      return `Scrolled ${direction} inside ${describe(container)}. Position ${Math.round(container.scrollTop)} of ${container.scrollHeight - container.clientHeight}px.`;
    },

    changes() {
      return summarizeChanges();
    },

    // A ref's box in viewport pixels, for cropping a thumbnail; null if it's gone.
    rectOf({ ref }) {
      const el = tryRef(ref);
      if (!el || !isVisible(el)) return null;
      const rect = el.getBoundingClientRect();
      return { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
    },

    // Outlines a ref's element for the user, from the popup's activity list.
    flashRef({ ref }) {
      const el = byRef(ref);
      el.scrollIntoView({ block: "center", behavior: "instant" });
      flash(el, ref);
      return "";
    },

    // One check for wait_for, which polls it from the background so a navigation
    // in between doesn't end the wait. Reports which conditions hold and which don't.
    waitCheck({ text, text_gone: textGone, selector, ref, state = "visible", value }) {
      const met = [];
      const unmet = [];
      const pageText = text != null || textGone != null ? (document.body?.innerText ?? "").toLowerCase() : "";
      if (text != null) {
        if (pageText.includes(text.toLowerCase())) met.push(`"${text}" appeared${placeOfText(text)}`);
        else unmet.push(`text "${text}" to appear`);
      }
      if (textGone != null) {
        if (pageText.includes(textGone.toLowerCase())) unmet.push(`text "${textGone}" to go away`);
        else met.push(`"${textGone}" is gone`);
      }
      if (selector) {
        const el = deepQuery(selector);
        if (el && isVisible(el)) met.push(`${selector} is showing: ${describe(el)}`);
        else unmet.push(`${selector} to show`);
      }
      if (ref) {
        const entry = refs.get(ref);
        const live = entry?.el.deref();
        const present = live?.isConnected && isVisible(live);
        if (!entry && !["gone", "hidden"].includes(state)) {
          throw new Error(`${ref} isn't a ref on this page (it may have reloaded or navigated since). Call read_page or find for fresh refs.`);
        }
        if (state === "gone" || state === "hidden") {
          if (present) unmet.push(`${ref} to ${state === "gone" ? "go away" : "hide"}`);
          else met.push(`${ref} is ${state}`);
        } else {
          const el = present ? live : tryRef(ref);
          const ok = !!el && isVisible(el) && (
            state === "enabled" ? !isDisabled(el)
              : state === "value" ? String("value" in el ? el.value : el.textContent).toLowerCase()
                .includes(String(value ?? "").toLowerCase())
              : true);
          const want = state === "value" ? `to contain "${value}"` : `to be ${state}`;
          if (ok) met.push(state === "value" ? `${ref} contains "${secretFields.has(el) ? "••••" : value}"` : `${ref} is ${state}`);
          else unmet.push(`${ref} ${want}`);
        }
      }
      return { done: unmet.length === 0, met, unmet };
    },

    // Whether an action would press a button such as Publish or Delete. Returns null
    // when it's safe, otherwise what to show the user when asking for approval.
    assessRisk({ method, ref, x, y, key = "Enter" }) {
      let control;
      if (method === "click") {
        const { el } = resolveTarget({ ref, x, y });
        control = el.closest?.(CLICKABLE) ?? el;
      } else {
        const target = ref ? byRef(ref) : deepActiveElement();
        if (!target) return null;
        if (target.matches(CLICKABLE)) control = target;
        // Enter in a field submits its form, which presses the form's submit button.
        else if (/enter$/i.test(key) && target.form) {
          control = target.form.querySelector("button[type=submit], button:not([type]), input[type=submit]");
        }
        if (!control) return null;
        control.scrollIntoView({ block: "center", behavior: "instant" });
      }
      const name = nameOf(control);
      if (!RISKY_WORDS.test(name)) return null;
      riskTarget = control;
      const rect = control.getBoundingClientRect();
      const what = `${roleOf(control) ?? control.localName} ${JSON.stringify(name)}`;
      return {
        action: method === "click" ? `Click ${what}` : `Press ${key} to activate ${what}`,
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      };
    },

    showApprovalHint() {
      if (!riskTarget?.isConnected) return "";
      showOverlay(riskTarget, {
        tone: "approval",
        title: "Waiting for your approval",
        text: "Click the amber badge on the toolbar to approve or deny this.",
      });
      return "";
    },

    clearOverlay() {
      hideOverlay();
      riskTarget = null;
      return "";
    },

    // Lets the user type a secret into a field. Only the outcome and length come back.
    async requestInput({ ref, hint, timeoutMs = 300000 }) {
      const el = byRef(ref);
      if (!isTextField(el) && !el.isContentEditable) throw new Error(`${describe(el)} is not a text field.`);
      inputRequest?.resolve("skip");
      el.scrollIntoView({ block: "center", behavior: "instant" });
      secretFields.add(el);

      let timer;
      const outcome = await new Promise((resolve) => {
        inputRequest = { resolve };
        timer = setTimeout(() => resolve("timeout"), timeoutMs);
        showOverlay(el, {
          tone: "input",
          title: "The agent needs you to fill this in",
          text: hint,
          buttons: [
            { label: "Done", primary: true, onClick: () => resolve("done") },
            { label: "Skip", onClick: () => resolve("skip") },
          ],
        });
        el.focus();
      });
      clearTimeout(timer);
      inputRequest = null;
      hideOverlay();

      const length = isTextField(el) ? el.value.length : el.innerText.trim().length;
      if (outcome === "timeout") {
        return `timed out after ${Math.round(timeoutMs / 1000)}s` + (length ? ` (the field holds ${length} chars)` : "");
      }
      if (outcome === "skip") return "skipped";
      return length ? `filled, ${length} chars` : "skipped (the field was left empty)";
    },

    cancelInput() {
      inputRequest?.resolve("skip");
      return "";
    },

    // Blacks out password fields and user-filled secrets until unmaskSecrets, so a
    // screenshot can't show them. Waits for the boxes to be painted.
    async maskSecrets({ keepFlash = false } = {}) {
      handlers.unmaskSecrets();
      const hadOverlay = (!!flashHost && !keepFlash) || !!driving;
      if (!keepFlash) hideFlash();
      hideDriving();
      const fields = [...document.querySelectorAll("input[type=password]")];
      for (const entry of refs.values()) {
        const field = entry.el.deref();
        if (field && secretFields.has(field)) fields.push(field);
      }
      const boxes = fields.filter((el) => el.isConnected && isVisible(el)).map((el) => {
        const rect = el.getBoundingClientRect();
        const box = document.createElement("div");
        box.style.cssText = `position: fixed; left: ${rect.left}px; top: ${rect.top}px; width: ${rect.width}px; ` +
          `height: ${rect.height}px; background: #000; border-radius: 3px;`;
        return box;
      });
      // A hidden tab gets no animation frames, but tabs.captureTab paints it afresh anyway.
      const painted = () => document.visibilityState === "visible"
        ? new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        : Promise.resolve();
      if (!boxes.length) {
        if (hadOverlay) await painted();
        return 0;
      }
      masks = document.createElement("fxmcp-overlay");
      masks.style.cssText = "all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none;";
      masks.attachShadow({ mode: "closed" }).append(...boxes);
      document.documentElement.append(masks);
      await painted();
      return boxes.length;
    },

    unmaskSecrets() {
      masks?.remove();
      masks = null;
      return "";
    },
  };

  // Actions whose effect on the page is reported back.
  const WATCHED = new Set(["click", "type", "pressKey", "setValue"]);
  // Calls the agent makes itself (not the bridge's own housekeeping), which show the pill.
  const AGENT_CALLS = new Set([...WATCHED, "readPage", "pageText", "find", "hover", "scroll", "requestInput"]);

  function watchTarget({ ref, x, y }) {
    if (ref) return tryRef(ref);
    if (x != null && y != null) return deepElementFromPoint(x, y);
    return deepActiveElement();
  }

  window.__fxmcp = {
    async call(method, args) {
      try {
        const handler = handlers[method];
        if (!handler) throw new Error(`Unknown page action: ${method}`);
        // A batch keeps one watch across its steps, so the report covers all of them.
        if (WATCHED.has(method) && !(args?.continueWatch && watch)) startWatch(watchTarget(args ?? {}));
        if (AGENT_CALLS.has(method)) showDriving();
        let value = await handler(args ?? {});
        if (typeof value === "string" && refound.size) {
          const list = [...refound].join(", ");
          value += `\n(${list} had been re-rendered by the page; found ${refound.size > 1 ? "them" : "it"} again by role and name.)`;
          refound.clear();
        }
        return { ok: true, value };
      } catch (error) {
        return { ok: false, error: error?.message ?? String(error) };
      }
    },
  };
})();
