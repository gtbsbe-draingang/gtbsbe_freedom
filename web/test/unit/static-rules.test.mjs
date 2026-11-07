// Static rules that keep the UI embeddable in Microsoft Dynamics 365 (CLAUDE.md, hard rule).
// The scanners are plain functions; the last describe block feeds them known violations so the
// checks cannot pass by scanning nothing.
import { before, after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { transformSync } from "esbuild";

const webRoot = fileURLToPath(new URL("../../", import.meta.url));
const srcDir = join(webRoot, "src");
const stylesDir = join(srcDir, "styles");

function walk(dir) {
  if (!existsSync(dir)) return [];
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out.sort();
}

const rel = (file, base = webRoot) => relative(base, file).split(sep).join("/");

// ---- JavaScript scanners ---------------------------------------------------------------------

// Comments are dropped first (esbuild parses the file), so prose may mention a forbidden API.
function stripJsComments(code) {
  return transformSync(code, { loader: "js", legalComments: "none" }).code;
}

const FORBIDDEN_JS = [
  ["innerHTML", /\binnerHTML\b/],
  ["outerHTML", /\bouterHTML\b/],
  ["insertAdjacentHTML", /\binsertAdjacentHTML\b/],
  ["document.write", /\bdocument\s*\.\s*write(?:ln)?\b/],
  ["eval(", /\beval\s*\(/],
  ["new Function", /\bnew\s+Function\b/],
  ["Function(", /(?<![.\w])Function\s*\(/],
  ['setAttribute("style"', /\.setAttribute\s*\(\s*["'`]style["'`]/i],
  ['setAttribute("on…"', /\.setAttribute\s*\(\s*["'`]on[a-z]+["'`]/i],
  ["inline on…= handler in an HTML string", /<[a-z][^<>]*\son[a-z]+\s*=/i],
  ["inline style= in an HTML string", /<[a-z][^<>]*\sstyle\s*=/i],
  ["javascript: URL", /javascript\s*:/i],
];

const NETWORK_JS = [
  ["fetch(", /\bfetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["sendBeacon", /\bsendBeacon\b/],
  ["new WebSocket", /\bnew\s+WebSocket\b/],
  ["new EventSource", /\bnew\s+EventSource\b/],
];

function scanJs(code, rules) {
  const clean = stripJsComments(code);
  return rules.filter(([, re]) => re.test(clean)).map(([name]) => name);
}

// ---- CSS scanner -----------------------------------------------------------------------------

// Splits one nesting level of CSS into { prelude, body } blocks and body-less statements.
function cssBlocks(css) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  const out = [];
  let depth = 0;
  let quote = null;
  let preludeStart = 0;
  let bodyStart = 0;
  let prelude = "";
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      quote = c;
    } else if (c === "{") {
      if (depth === 0) {
        prelude = clean.slice(preludeStart, i).trim();
        bodyStart = i + 1;
      }
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0) {
        out.push({ prelude, body: clean.slice(bodyStart, i) });
        preludeStart = i + 1;
      }
    } else if (c === ";" && depth === 0) {
      out.push({ prelude: clean.slice(preludeStart, i).trim(), body: null });
      preludeStart = i + 1;
    }
  }
  return out;
}

// Splits a selector list on top-level commas (commas inside :is(), :not(), [attr] stay).
function splitSelectors(list) {
  const out = [];
  let depth = 0;
  let start = 0;
  for (let i = 0; i < list.length; i++) {
    const c = list[i];
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (c === "," && depth === 0) {
      out.push(list.slice(start, i).trim());
      start = i + 1;
    }
  }
  out.push(list.slice(start).trim());
  return out.filter(Boolean);
}

// Returns a list of violations; empty means the stylesheet is scoped.
function cssViolations(css, { allowRoot = false } = {}) {
  const found = [];
  const walkBlocks = (source) => {
    for (const { prelude, body } of cssBlocks(source)) {
      if (body === null) {
        if (!/^@import\b/.test(prelude)) found.push(`statement "${prelude}"`);
      } else if (/^@font-face\b/.test(prelude)) {
        // allowed as is
      } else if (/^@media\b/.test(prelude)) {
        walkBlocks(body);
      } else if (prelude.startsWith("@")) {
        found.push(`at-rule "${prelude}"`);
      } else {
        for (const selector of splitSelectors(prelude)) {
          const scoped = selector.startsWith(".cqa") || selector.startsWith(".cqa-page");
          const root = allowRoot && selector.startsWith(":root");
          if (!scoped && !root) found.push(`selector "${selector}"`);
        }
      }
    }
  };
  walkBlocks(css);
  return found;
}

// ---- HTML scanner ----------------------------------------------------------------------------

const TAG_RE = /<([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^'">])*)>/g;
const ATTR_RE = /(?<=^|[\s"'])([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;

// Inline script, <style>, style= and on…= attributes, javascript: URLs.
function htmlViolations(html) {
  const source = html.replace(/<!--[\s\S]*?-->/g, "");
  const found = [];
  for (const match of source.matchAll(TAG_RE)) {
    const tag = match[1].toLowerCase();
    const attrs = match[2];
    if (tag === "style") found.push("<style> element");
    if (tag === "script") {
      if (!/\ssrc\s*=/i.test(attrs)) {
        found.push("inline <script> without src");
      } else {
        const rest = source.slice(match.index + match[0].length);
        const close = rest.search(/<\/script\s*>/i);
        if (close < 0 || rest.slice(0, close).trim() !== "") found.push("<script src> with an inline body");
      }
    }
    for (const attr of attrs.matchAll(ATTR_RE)) {
      const name = attr[1].toLowerCase();
      const value = attr[2] ?? attr[3] ?? attr[4] ?? "";
      if (name === "style") found.push(`style attribute on <${tag}>`);
      if (/^on[a-z]+$/.test(name)) found.push(`${name} handler on <${tag}>`);
      if (/^\s*javascript\s*:/i.test(value)) found.push(`javascript: URL on <${tag}>`);
    }
  }
  return found;
}

// ---- Tests on the real tree ------------------------------------------------------------------

describe("source rules", () => {
  const jsFiles = walk(srcDir).filter((file) => extname(file) === ".js");

  test("src has no forbidden APIs", () => {
    assert.ok(jsFiles.length > 0, "no src/**/*.js files found");
    const problems = [];
    for (const file of jsFiles) {
      for (const name of scanJs(readFileSync(file, "utf8"), FORBIDDEN_JS)) problems.push(`${rel(file)}: ${name}`);
    }
    assert.deepEqual(problems, []);
  });

  test("fetch only in src/api", () => {
    assert.ok(jsFiles.length > 0, "no src/**/*.js files found");
    const problems = [];
    for (const file of jsFiles) {
      if (rel(file, srcDir).startsWith("api/")) continue;
      for (const name of scanJs(readFileSync(file, "utf8"), NETWORK_JS)) problems.push(`${rel(file)}: ${name}`);
    }
    assert.deepEqual(problems, []);
  });

  test("css is scoped", () => {
    const cssFiles = walk(stylesDir).filter((file) => extname(file) === ".css");
    const names = cssFiles.map((file) => basename(file));
    for (const required of ["index.css", "tokens.css", "base.css"]) {
      assert.ok(names.includes(required), `src/styles/${required} is missing`);
    }
    const problems = [];
    for (const file of cssFiles) {
      const allowRoot = basename(file) === "tokens.css";
      for (const violation of cssViolations(readFileSync(file, "utf8"), { allowRoot })) {
        problems.push(`${rel(file)}: ${violation}`);
      }
    }
    assert.deepEqual(problems, []);
  });
});

describe("built dist", () => {
  let outdir;
  before(() => {
    outdir = mkdtempSync(join(tmpdir(), "cqa-static-rules-"));
    execFileSync(process.execPath, [join(webRoot, "build.mjs"), "--outdir", outdir], { cwd: webRoot, stdio: "pipe" });
  });
  after(() => rmSync(outdir, { recursive: true, force: true }));

  test("dist has only allowed file types", () => {
    const files = walk(outdir);
    assert.ok(files.length > 0, "the build produced no files");
    const allowed = new Set([".html", ".css", ".js", ".svg"]);
    const problems = files.filter((file) => !allowed.has(extname(file))).map((file) => rel(file, outdir));
    assert.deepEqual(problems, []);
    for (const required of ["index.html", "app.js", "app.css", "config.js"]) {
      assert.ok(existsSync(join(outdir, required)), `dist/${required} is missing`);
    }
  });

  test("dist html has no inline script, style or handlers", () => {
    const pages = walk(outdir).filter((file) => extname(file) === ".html");
    assert.ok(pages.length > 0, "dist has no html page");
    const problems = [];
    for (const page of pages) {
      for (const violation of htmlViolations(readFileSync(page, "utf8"))) problems.push(`${rel(page, outdir)}: ${violation}`);
    }
    assert.deepEqual(problems, []);
  });

  test("app.css embeds the font as a data URL", () => {
    const css = readFileSync(join(outdir, "app.css"), "utf8");
    assert.ok(css.includes("url(data:font/woff2;base64,"), "no url(data:font/woff2;base64,…) in app.css");
  });
});

// ---- The scanners must catch what they claim to ----------------------------------------------

describe("scanners catch violations", () => {
  test("forbidden JS APIs", () => {
    const cases = {
      innerHTML: "el.innerHTML = x;",
      outerHTML: "el.outerHTML = x;",
      insertAdjacentHTML: 'el.insertAdjacentHTML("beforeend", x);',
      "document.write": "document.write(x);",
      "eval(": "eval(code);",
      "new Function": 'const f = new Function("return 1");',
      "Function(": 'const f = Function("return 1");',
      'setAttribute("style"': 'el.setAttribute("style", "color: red");',
      'setAttribute("on…"': "el.setAttribute('onclick', 'go()');",
      "inline on…= handler in an HTML string": 'const h = `<button onclick="go()">x</button>`;',
      "inline style= in an HTML string": "const h = '<div style=\"color: red\">x</div>';",
      "javascript: URL": 'a.href = "javascript:void(0)";',
    };
    for (const [name, code] of Object.entries(cases)) {
      assert.ok(scanJs(code, FORBIDDEN_JS).includes(name), `${name} was not detected in: ${code}`);
    }
  });

  test("clean JS passes, including names in comments and look-alikes", () => {
    const code = [
      "// never use innerHTML, eval( or new Function",
      "/* document.write is banned too */",
      "const online = 1, onclickCount = 2;",
      "el.textContent = 'x';",
      "el.style.setProperty('--w', '10px');",
      "const prefetch = 1; const med = evaluate(2);",
    ].join("\n");
    assert.deepEqual(scanJs(code, FORBIDDEN_JS), []);
    assert.deepEqual(scanJs(code, NETWORK_JS), []);
  });

  test("network APIs", () => {
    for (const code of ['fetch("a")', "new XMLHttpRequest()", "navigator.sendBeacon(u)", "new WebSocket(u)", "new EventSource(u)"]) {
      assert.equal(scanJs(code, NETWORK_JS).length, 1, `not detected: ${code}`);
    }
  });

  test("unscoped CSS", () => {
    for (const css of [
      "body { margin: 0 }",
      "html { color: red }",
      ".cqa, button { color: red }",
      "button.cqa { color: red }",
      "@media (max-width: 600px) { body { margin: 0 } }",
      "@keyframes spin { to { opacity: 0 } }",
      ":root { --a: 1 }",
    ]) {
      assert.ok(cssViolations(css).length > 0, `not detected: ${css}`);
    }
    assert.deepEqual(cssViolations(":root { --a: 1 }", { allowRoot: true }), []);
    assert.ok(cssViolations("body { --a: 1 }", { allowRoot: true }).length > 0);
  });

  test("scoped CSS passes", () => {
    const css = `
      /* comment with body { } inside */
      @import "./tokens.css";
      @font-face { font-family: "CoFo Sans"; src: url("../assets/fonts/CoFoSans-VF.woff2") format("woff2"); }
      .cqa { color: red }
      .cqa .num, .cqa-page { content: "a, b { c }" }
      .cqa:is(.a, .b) > p { color: red }
      .cqa.cqa--dark { color: white }
      @media (max-width: 600px) { .cqa .panes { display: block } .cqa .x, .cqa .y { gap: 0 } }
    `;
    assert.deepEqual(cssViolations(css), []);
  });

  test("html violations", () => {
    for (const html of [
      "<script>alert(1)</script>",
      "<script src='a.js'>alert(1)</script>",
      "<style>.a{}</style>",
      '<div style="color: red"></div>',
      '<button onclick="go()">x</button>',
      "<img src=x onerror=boom()>",
      '<a href="javascript:void(0)">x</a>',
    ]) {
      assert.ok(htmlViolations(html).length > 0, `not detected: ${html}`);
    }
  });

  test("clean html passes", () => {
    const html = `<!doctype html><html lang="ru"><head><meta charset="utf-8"><link rel="stylesheet" href="app.css">
      <!-- <script>commented out</script> --></head>
      <body class="cqa-page"><div id="cqa-root" data-autostart data-online="1"></div>
      <script src="config.js"></script><script src="app.js"></script></body></html>`;
    assert.deepEqual(htmlViolations(html), []);
  });
});
