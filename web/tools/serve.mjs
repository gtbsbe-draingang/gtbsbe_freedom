// Dev server for the built UI. Development only; the shipped UI is the static files in dist/.
//   node tools/serve.mjs [--port <n>] [--api mock|http] [--api-origin <origin>] [--dist <dir>]
//
// - serves dist/ at /, with a strict Content-Security-Policy on every response;
// - serves a generated /config.js that reflects --api (the committed static/config.js is the
//   default for a backend that serves dist/ itself);
// - serves the DEV data for the mock API: /data/dev.json and /data/audio/<file>.mp3 (with Range),
//   read from $CQA_DATA_DIR (default: <repo root>/data). That data is real customer data, so the
//   server listens on 127.0.0.1 only and refuses requests whose Host header is not local.
import { createReadStream, statSync } from "node:fs";
import http from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

const webRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const defaultDataDir = join(dirname(webRoot), "data");

const CONTENT_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".mp3": "audio/mpeg",
};

// The policy from Global Constraints; <API_ORIGIN> is left out when the API is same-origin.
export function buildCsp(apiOrigin) {
  const origin = apiOrigin ? ` ${apiOrigin}` : "";
  return [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self'",
    "img-src 'self' data:",
    "font-src 'self' data:",
    `connect-src 'self'${origin}`,
    `media-src 'self'${origin}`,
    "frame-src 'self'",
    "frame-ancestors 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self'",
  ].join("; ");
}

export function buildConfig({ api, apiOrigin }) {
  if (api !== "mock" && api !== "http") throw new Error(`api must be "mock" or "http", got "${api}"`);
  if (api === "mock") {
    return {
      api: "mock",
      apiBase: "api",
      devDataUrl: "data/dev.json",
      devAudioBase: "data/audio/",
      mockModelKey: true,
      mockDelayMs: 250,
      testHooks: true,
    };
  }
  return { api: "http", apiBase: apiOrigin ? `${apiOrigin}/api` : "api", testHooks: true };
}

function parseRange(header, size) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || (match[1] === "" && match[2] === "")) return null;
  let start;
  let end;
  if (match[1] === "") {
    const suffix = Number(match[2]);
    if (suffix === 0) return { unsatisfiable: true };
    start = Math.max(size - suffix, 0);
    end = size - 1;
  } else {
    start = Number(match[1]);
    end = match[2] === "" ? size - 1 : Math.min(Number(match[2]), size - 1);
  }
  if (start >= size || start > end) return { unsatisfiable: true };
  return { start, end };
}

function sendFile(req, res, file, { ranges = false } = {}) {
  let stat;
  try {
    stat = statSync(file);
  } catch {
    return notFound(res);
  }
  if (!stat.isFile()) return notFound(res);
  res.setHeader("Content-Type", CONTENT_TYPES[extname(file)] ?? "application/octet-stream");
  let start = 0;
  let end = stat.size - 1;
  let status = 200;
  if (ranges) {
    res.setHeader("Accept-Ranges", "bytes");
    const header = req.headers.range;
    const range = header ? parseRange(header, stat.size) : null;
    if (range?.unsatisfiable) {
      res.statusCode = 416;
      res.setHeader("Content-Range", `bytes */${stat.size}`);
      return res.end();
    }
    if (range) {
      ({ start, end } = range);
      status = 206;
      res.setHeader("Content-Range", `bytes ${start}-${end}/${stat.size}`);
    }
  }
  res.statusCode = status;
  res.setHeader("Content-Length", stat.size === 0 ? 0 : end - start + 1);
  if (req.method === "HEAD" || stat.size === 0) return res.end();
  const stream = createReadStream(file, { start, end });
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  stream.pipe(res);
}

function notFound(res, status = 404) {
  res.statusCode = status;
  res.setHeader("Content-Type", "text/plain; charset=utf-8");
  res.end(status === 404 ? "not found" : "refused");
}

// Maps a URL path to a file inside `root`; null if it would leave `root` or is malformed.
function insideRoot(root, urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const file = resolve(root, `.${decoded.endsWith("/") ? `${decoded}index.html` : decoded}`);
  if (file !== root && !file.startsWith(root + sep)) return null;
  return file;
}

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/i;

// $CQA_DATA_DIR overrides the data directory (default: <repo root>/data).
export const resolveDataDir = () => (process.env.CQA_DATA_DIR ? resolve(process.env.CQA_DATA_DIR) : defaultDataDir);

export function startServer({ port = 0, api = "mock", apiOrigin = "", dist = join(webRoot, "dist"), dataDir = resolveDataDir() } = {}) {
  const csp = buildCsp(apiOrigin);
  const configJs = `window.CQA_CONFIG = ${JSON.stringify(buildConfig({ api, apiOrigin }))};\n`;
  const distRoot = resolve(dist);
  const dataRoot = resolve(dataDir);

  const server = http.createServer((req, res) => {
    res.setHeader("Content-Security-Policy", csp);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Cache-Control", "no-store");

    if (!LOCAL_HOST.test(req.headers.host ?? "")) return notFound(res, 403);
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      return notFound(res, 405);
    }

    const pathname = (req.url ?? "/").split("?")[0].split("#")[0];

    if (pathname === "/config.js") {
      res.setHeader("Content-Type", CONTENT_TYPES[".js"]);
      return res.end(req.method === "HEAD" ? undefined : configJs);
    }
    if (pathname === "/data/dev.json") return sendFile(req, res, join(dataRoot, "dev.json"));
    if (pathname.startsWith("/data/")) {
      const match = /^\/data\/audio\/([A-Za-z0-9._-]+\.mp3)$/.exec(pathname);
      return match ? sendFile(req, res, join(dataRoot, "audio", match[1]), { ranges: true }) : notFound(res);
    }

    const file = insideRoot(distRoot, pathname);
    if (!file) return notFound(res);
    return sendFile(req, res, file);
  });

  return new Promise((resolveStart, reject) => {
    server.once("error", reject);
    // Loopback only: the data routes serve real customer dialogues and recordings.
    server.listen(port, "127.0.0.1", () => resolveStart(server));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: {
      port: { type: "string", default: "5173" },
      api: { type: "string", default: "mock" },
      "api-origin": { type: "string" },
      dist: { type: "string" },
    },
  });
  const fail = (message) => {
    console.error(message);
    process.exit(2);
  };
  if (values.api !== "mock" && values.api !== "http") fail('--api must be "mock" or "http"');
  const port = Number(values.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) fail("--port must be an integer from 0 to 65535");
  let apiOrigin = "";
  if (values["api-origin"]) {
    try {
      const url = new URL(values["api-origin"]);
      if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("protocol");
      apiOrigin = url.origin;
    } catch {
      fail("--api-origin must be an http(s) origin such as https://api.example.com");
    }
  }
  const server = await startServer({ port, api: values.api, apiOrigin, dist: values.dist ? resolve(values.dist) : undefined });
  console.log(`listening ${server.address().port}`);
}
