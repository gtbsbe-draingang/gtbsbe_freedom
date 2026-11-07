// Runs scenarios in headless Chrome against a served build.
//
// A scenario is a module exporting { name, path, viewports: [[w, h], ...], run(page) }. For every
// viewport the harness opens `path`, calls run(page), then fails the run on any CSP violation,
// console error, uncaught exception or horizontal page overflow. Page-origin storage is cleared
// before each run, so scenarios never depend on order.
import { launch } from "./cdp.mjs";

const SCENARIO_TIMEOUT_MS = 30000;

// Runs before any page script, in every frame. Violations land in window.__csp.
const CSP_COLLECTOR = `
  window.__csp = [];
  document.addEventListener("securitypolicyviolation", (e) => {
    window.__csp.push({ directive: e.violatedDirective, blocked: e.blockedURI, source: e.sourceFile, line: e.lineNumber });
  }, true);
`;

const quote = (value) => JSON.stringify(value);

function describeRemote(arg) {
  if (arg.value !== undefined) return typeof arg.value === "string" ? arg.value : JSON.stringify(arg.value);
  return arg.description ?? arg.type;
}

function makePage(cdp, baseUrl, viewport) {
  const find = (selector, what) =>
    `(() => { const el = document.querySelector(${quote(selector)}); if (!el) throw new Error(${quote(`${what}: no element matches ${selector}`)}); return el; })()`;

  return {
    viewport,
    sleep: cdp.sleep,
    async goto(path) {
      await cdp.goto(new URL(path, baseUrl).href);
    },
    async waitFor(selector, ms = 3000) {
      const deadline = Date.now() + ms;
      for (;;) {
        if (await cdp.evaluate(`document.querySelector(${quote(selector)}) !== null`)) return;
        if (Date.now() >= deadline) throw new Error(`timed out after ${ms} ms waiting for ${selector}`);
        await cdp.sleep(25);
      }
    },
    // A real mouse click at the centre of the element; fails if something else covers that point.
    async click(selector) {
      const target = await cdp.evaluate(`(() => {
        const el = ${find(selector, "click")};
        el.scrollIntoView({ block: "center", inline: "center" });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2;
        const y = r.top + r.height / 2;
        const hit = document.elementFromPoint(x, y);
        return { x, y, empty: r.width === 0 || r.height === 0, covered: !hit || !(el === hit || el.contains(hit)),
                 by: hit ? hit.tagName.toLowerCase() + (hit.getAttribute("class") ? "." + hit.getAttribute("class").trim().split(/\\s+/).join(".") : "") : null };
      })()`);
      if (target.empty) throw new Error(`click: ${selector} has no size`);
      if (target.covered) throw new Error(`click: ${selector} is covered by ${target.by}`);
      const at = { x: target.x, y: target.y, button: "left", clickCount: 1 };
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: target.x, y: target.y });
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", ...at });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", ...at });
    },
    // Focuses the element and inserts the text at the caret (input and textarea events fire).
    async type(selector, text) {
      await cdp.evaluate(`(() => {
        const el = ${find(selector, "type")};
        el.focus();
        if (document.activeElement !== el) throw new Error(${quote(`type: ${selector} cannot take focus`)});
      })()`);
      await cdp.send("Input.insertText", { text });
    },
    async text(selector) {
      return cdp.evaluate(`${find(selector, "text")}.textContent`);
    },
    async count(selector) {
      return cdp.evaluate(`document.querySelectorAll(${quote(selector)}).length`);
    },
    // Evaluates a JavaScript expression in the page (promises are awaited).
    async eval(expression) {
      return cdp.evaluate(expression);
    },
    async scrollState(selector) {
      return cdp.evaluate(`(() => {
        const el = ${find(selector, "scrollState")};
        const { scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth } = el;
        return { scrollTop, scrollLeft, scrollHeight, scrollWidth, clientHeight, clientWidth };
      })()`);
    },
  };
}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// Returns { results: [{ name, viewport, failures }], cspViolations }.
export async function runScenarios(scenarios, { baseUrl }) {
  const first = scenarios[0]?.viewports?.[0] ?? [1280, 800];
  const cdp = await launch({ width: first[0], height: first[1] });
  const origin = new URL(baseUrl).origin;
  const results = [];
  let cspViolations = 0;

  let consoleErrors = [];
  let exceptions = [];
  try {
    await cdp.send("Runtime.enable");
    await cdp.send("Log.enable");
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: CSP_COLLECTOR });
    cdp.on("Runtime.consoleAPICalled", (e) => {
      if (e.type === "error") consoleErrors.push(`console.error: ${e.args.map(describeRemote).join(" ")}`);
    });
    // Browser-side errors that never reach console.error: failed loads, CSP refusals.
    cdp.on("Log.entryAdded", ({ entry }) => {
      if (entry.level === "error") consoleErrors.push(`${entry.source}: ${entry.text}${entry.url ? ` (${entry.url})` : ""}`);
    });
    cdp.on("Runtime.exceptionThrown", ({ exceptionDetails: d }) => {
      exceptions.push(d.exception?.description ?? d.text);
    });

    for (const scenario of scenarios) {
      for (const viewport of scenario.viewports) {
        const [width, height] = viewport;
        const failures = [];

        await cdp.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
        await cdp.goto("about:blank");
        await cdp.send("Storage.clearDataForOrigin", { origin, storageTypes: "all" });
        consoleErrors = [];
        exceptions = [];

        const page = makePage(cdp, baseUrl, viewport);
        try {
          await withTimeout(
            (async () => {
              await page.goto(scenario.path);
              await scenario.run(page);
            })(),
            SCENARIO_TIMEOUT_MS,
            `scenario timed out after ${SCENARIO_TIMEOUT_MS} ms`,
          );
        } catch (error) {
          failures.push(`scenario: ${error.stack?.split("\n").slice(0, 4).join("\n      ") ?? error}`);
        }

        // These evaluations also flush the events queued before them.
        try {
          const csp = await cdp.evaluate("window.__csp ?? []");
          cspViolations += csp.length;
          for (const v of csp) failures.push(`CSP violation: ${v.directive} blocked ${v.blocked || "inline"} (${v.source}:${v.line})`);
          const overflow = await cdp.evaluate(
            "({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth })",
          );
          if (overflow.scrollWidth > overflow.innerWidth) {
            failures.push(`horizontal overflow: scrollWidth ${overflow.scrollWidth} > innerWidth ${overflow.innerWidth}`);
          }
        } catch (error) {
          failures.push(`page checks: ${error.message}`);
        }
        for (const message of new Set(consoleErrors)) failures.push(message);
        for (const message of new Set(exceptions)) failures.push(`uncaught exception: ${message}`);

        results.push({ name: scenario.name, viewport, failures });
      }
    }
  } finally {
    await cdp.close();
  }
  return { results, cspViolations };
}
