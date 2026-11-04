// Runs in the page's own world at document_start so console output and
// uncaught errors are buffered for read_console_messages.
(() => {
  if (window.__fxmcpConsole) return;

  const MAX_ENTRIES = 1000;
  const buffer = [];
  Object.defineProperty(window, "__fxmcpConsole", { value: buffer });

  const format = (value) => {
    if (typeof value === "string") return value;
    if (value instanceof Error) return value.stack || String(value);
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  };

  const push = (level, text) => {
    buffer.push({ level, time: Date.now(), text });
    if (buffer.length > MAX_ENTRIES) buffer.splice(0, buffer.length - MAX_ENTRIES);
  };

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level];
    console[level] = function (...args) {
      push(level, args.map(format).join(" "));
      return original.apply(this, args);
    };
  }

  window.addEventListener("error", (event) => {
    push("error", `Uncaught ${event.message} (${event.filename}:${event.lineno}:${event.colno})`);
  });
  window.addEventListener("unhandledrejection", (event) => {
    push("error", `Unhandled rejection: ${format(event.reason)}`);
  });
})();
