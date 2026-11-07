// The dev server: strict CSP on every response, generated /config.js, dev-only data routes.
// Uses a throw-away data directory with fake files; the real data/dev.json is never read.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const webRoot = fileURLToPath(new URL("../../", import.meta.url));

// The exact policy from Global Constraints. <API_ORIGIN> is left out when the API is same-origin.
const csp = (origin = "") => {
  const o = origin ? ` ${origin}` : "";
  return (
    "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self' data:; " +
    `connect-src 'self'${o}; media-src 'self'${o}; frame-src 'self'; frame-ancestors 'self'; ` +
    "object-src 'none'; base-uri 'none'; form-action 'self'"
  );
};

function startServer(args, env) {
  const child = spawn(process.execPath, [join(webRoot, "tools/serve.mjs"), "--port", "0", ...args], {
    cwd: webRoot,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(() => reject(new Error(`server did not start: ${err}${out}`)), 5000);
    child.stderr.on("data", (chunk) => (err += chunk));
    child.stdout.on("data", (chunk) => {
      out += chunk;
      const match = /^listening (\d+)$/m.exec(out);
      if (match) {
        clearTimeout(timer);
        resolve({ port: Number(match[1]), base: `http://127.0.0.1:${match[1]}`, stop: () => child.kill() });
      }
    });
    child.on("exit", (code) => reject(new Error(`server exited early (${code}): ${err}`)));
  });
}

// A raw request, for paths and headers that fetch() would normalise or refuse.
function raw(port, { path = "/", method = "GET", headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method, headers }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}

const configOf = (text) => {
  const sandbox = { window: {} };
  vm.runInNewContext(text, sandbox);
  // Round-trip through JSON: objects made in the vm context have a different Object.prototype.
  return JSON.parse(JSON.stringify(sandbox.window.CQA_CONFIG));
};

describe("dev server", () => {
  let root;
  let dataDir;
  let distDir;
  let mock;
  const audio = Buffer.from("0123456789abcdef");

  before(async () => {
    root = mkdtempSync(join(tmpdir(), "cqa-serve-"));
    dataDir = join(root, "data");
    distDir = join(root, "dist");
    mkdirSync(join(dataDir, "audio"), { recursive: true });
    mkdirSync(distDir);
    writeFileSync(join(dataDir, "dev.json"), '{"fake":true}');
    writeFileSync(join(dataDir, "audio", "x-1.mp3"), audio);
    writeFileSync(join(distDir, "index.html"), "<!doctype html><title>t</title>");
    writeFileSync(join(distDir, "app.js"), "window.x = 1;");
    writeFileSync(join(distDir, "app.css"), ".cqa{}");
    writeFileSync(join(distDir, "config.js"), "window.CQA_CONFIG = { api: 'dist' };");
    mock = await startServer(["--dist", distDir], { CQA_DATA_DIR: dataDir });
  });
  after(() => {
    mock?.stop();
    rmSync(root, { recursive: true, force: true });
  });

  test("sends the exact CSP on every response, errors included", async () => {
    for (const path of ["/", "/app.js", "/config.js", "/data/dev.json", "/data/audio/x-1.mp3", "/missing", "/data/other.json"]) {
      const res = await raw(mock.port, { path });
      assert.equal(res.headers["content-security-policy"], csp(), `CSP on ${path} (${res.status})`);
    }
    const post = await raw(mock.port, { path: "/", method: "POST" });
    assert.equal(post.status, 405);
    assert.equal(post.headers["content-security-policy"], csp());
  });

  test("adds the API origin to connect-src and media-src when given", async () => {
    const server = await startServer(["--dist", distDir, "--api", "http", "--api-origin", "https://api.example.test:8443"], {
      CQA_DATA_DIR: dataDir,
    });
    try {
      const res = await raw(server.port, { path: "/" });
      assert.equal(res.headers["content-security-policy"], csp("https://api.example.test:8443"));
    } finally {
      server.stop();
    }
  });

  test("serves dist at / with web-resource content types", async () => {
    const index = await raw(mock.port, { path: "/" });
    assert.equal(index.status, 200);
    assert.match(index.headers["content-type"], /^text\/html/);
    assert.match(index.body.toString(), /<title>t<\/title>/);
    assert.match((await raw(mock.port, { path: "/app.js" })).headers["content-type"], /^text\/javascript/);
    assert.match((await raw(mock.port, { path: "/app.css?v=1" })).headers["content-type"], /^text\/css/);
    assert.equal((await raw(mock.port, { path: "/nope.html" })).status, 404);
  });

  test("generates /config.js for the mock API, over the dist copy", async () => {
    const res = await raw(mock.port, { path: "/config.js" });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /^text\/javascript/);
    assert.deepEqual(configOf(res.body.toString()), {
      api: "mock",
      apiBase: "api",
      devDataUrl: "data/dev.json",
      devAudioBase: "data/audio/",
      mockModelKey: true,
      mockDelayMs: 250,
      testHooks: true,
    });
  });

  test("generates /config.js for the http API", async () => {
    const same = await startServer(["--dist", distDir, "--api", "http"], { CQA_DATA_DIR: dataDir });
    const cross = await startServer(["--dist", distDir, "--api", "http", "--api-origin", "https://api.example.test:8443/"], {
      CQA_DATA_DIR: dataDir,
    });
    try {
      assert.deepEqual(configOf((await raw(same.port, { path: "/config.js" })).body.toString()), {
        api: "http",
        apiBase: "api",
        testHooks: true,
      });
      assert.deepEqual(configOf((await raw(cross.port, { path: "/config.js" })).body.toString()), {
        api: "http",
        apiBase: "https://api.example.test:8443/api",
        testHooks: true,
      });
    } finally {
      same.stop();
      cross.stop();
    }
  });

  test("serves dev.json from CQA_DATA_DIR, and 404 when it is absent", async () => {
    const res = await raw(mock.port, { path: "/data/dev.json" });
    assert.equal(res.status, 200);
    assert.match(res.headers["content-type"], /^application\/json/);
    assert.equal(res.body.toString(), '{"fake":true}');

    const empty = mkdtempSync(join(root, "empty-"));
    const server = await startServer(["--dist", distDir], { CQA_DATA_DIR: empty });
    try {
      assert.equal((await raw(server.port, { path: "/data/dev.json" })).status, 404);
      assert.equal((await raw(server.port, { path: "/data/audio/x-1.mp3" })).status, 404);
    } finally {
      server.stop();
    }
  });

  test("serves audio with Range support", async () => {
    const full = await raw(mock.port, { path: "/data/audio/x-1.mp3" });
    assert.equal(full.status, 200);
    assert.equal(full.headers["content-type"], "audio/mpeg");
    assert.equal(full.headers["accept-ranges"], "bytes");
    assert.equal(full.headers["content-length"], String(audio.length));
    assert.deepEqual(full.body, audio);

    const part = await raw(mock.port, { path: "/data/audio/x-1.mp3", headers: { Range: "bytes=2-5" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers["content-range"], `bytes 2-5/${audio.length}`);
    assert.equal(part.headers["content-length"], "4");
    assert.equal(part.body.toString(), "2345");

    const open = await raw(mock.port, { path: "/data/audio/x-1.mp3", headers: { Range: "bytes=10-" } });
    assert.equal(open.status, 206);
    assert.equal(open.headers["content-range"], `bytes 10-15/${audio.length}`);
    assert.equal(open.body.toString(), "abcdef");

    const tail = await raw(mock.port, { path: "/data/audio/x-1.mp3", headers: { Range: "bytes=-3" } });
    assert.equal(tail.status, 206);
    assert.equal(tail.body.toString(), "def");

    const clamped = await raw(mock.port, { path: "/data/audio/x-1.mp3", headers: { Range: "bytes=14-99" } });
    assert.equal(clamped.status, 206);
    assert.equal(clamped.body.toString(), "ef");

    const beyond = await raw(mock.port, { path: "/data/audio/x-1.mp3", headers: { Range: "bytes=100-" } });
    assert.equal(beyond.status, 416);
    assert.equal(beyond.headers["content-range"], `bytes */${audio.length}`);

    const head = await raw(mock.port, { path: "/data/audio/x-1.mp3", method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers["content-length"], String(audio.length));
    assert.equal(head.body.length, 0);
  });

  test("refuses path traversal and files outside the data routes", async () => {
    for (const path of [
      "/%2e%2e/data/dev.json",
      "/..%2fdata%2fdev.json",
      "/%2e%2e%2fdata%2fdev.json",
      "/data/audio/..%2fdev.json",
      "/data/audio/%2e%2e/dev.json",
      "/data/audio/x-1.mp3/../../dev.json",
      "/data/audio/notes.txt",
      "/data/audio/",
      "/data/",
      "/data/dev.json/extra",
      "/%00",
    ]) {
      const res = await raw(mock.port, { path });
      assert.ok([400, 404].includes(res.status), `${path} answered ${res.status}`);
      assert.doesNotMatch(res.body.toString(), /fake/, `${path} leaked a file`);
    }
  });

  test("refuses a foreign Host header (DNS rebinding)", async () => {
    const res = await raw(mock.port, { path: "/data/dev.json", headers: { Host: "evil.example" } });
    assert.equal(res.status, 403);
    assert.equal(res.headers["content-security-policy"], csp());
    assert.doesNotMatch(res.body.toString(), /fake/);
    const local = await raw(mock.port, { path: "/data/dev.json", headers: { Host: `localhost:${mock.port}` } });
    assert.equal(local.status, 200);
  });
});
