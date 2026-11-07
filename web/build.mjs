// Builds the UI into plain static files: app.js, app.css (font inlined as a data URL) and static/*.
//   node build.mjs [--outdir <dir>] [--watch]
import * as esbuild from "esbuild";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, watch as watchFs } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

export const webRoot = dirname(fileURLToPath(import.meta.url));
export const defaultOutdir = join(webRoot, "dist");
const staticDir = join(webRoot, "static");

// absWorkingDir pins the relative path comments esbuild writes into the bundles, so the output
// does not depend on where the build is started.
const buildOptions = (outdir) => ({
  absWorkingDir: webRoot,
  entryPoints: [
    { in: "src/main.js", out: "app" },
    { in: "src/styles/index.css", out: "app" },
  ],
  outdir,
  bundle: true,
  format: "iife",
  target: "es2020",
  sourcemap: false,
  legalComments: "none",
  loader: { ".woff2": "dataurl" },
  logLevel: "warning",
});

// The output directory is emptied before a build, but only when that cannot destroy anything
// else: the default dist/, a directory that does not exist yet, or an empty one.
function prepareOutdir(outdir) {
  if (outdir === defaultOutdir) {
    rmSync(outdir, { recursive: true, force: true });
  } else if (existsSync(outdir) && readdirSync(outdir).length > 0) {
    throw new Error(`refusing to build into a non-empty directory: ${outdir}`);
  }
  mkdirSync(outdir, { recursive: true });
}

function copyStatic(outdir) {
  if (existsSync(staticDir)) cpSync(staticDir, outdir, { recursive: true });
}

// Returns { stop() } so a watcher can be shut down; without `watch` the build is already done.
export async function build({ outdir = defaultOutdir, watch = false } = {}) {
  outdir = resolve(outdir);
  prepareOutdir(outdir);
  copyStatic(outdir);
  if (!watch) {
    await esbuild.build(buildOptions(outdir));
    return { stop() {} };
  }
  const context = await esbuild.context(buildOptions(outdir));
  // A compile error in the first build is already printed; keep watching so a fix is picked up.
  await context.rebuild().catch(() => {});
  await context.watch();
  const staticWatcher = existsSync(staticDir) ? watchFs(staticDir, { recursive: true }, () => copyStatic(outdir)) : null;
  return {
    async stop() {
      staticWatcher?.close();
      await context.dispose();
    },
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { values } = parseArgs({
    options: { outdir: { type: "string" }, watch: { type: "boolean", default: false } },
  });
  try {
    await build({ outdir: values.outdir ?? defaultOutdir, watch: values.watch });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  if (!values.watch) console.log(`built ${values.outdir ? resolve(values.outdir) : "dist"}`);
}
