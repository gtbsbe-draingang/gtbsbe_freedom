// `npm run check:dist`: builds into a temp directory and byte-compares it with dist/.
// Exits 1 and lists the differing paths when the committed dist/ is not what `npm run build` makes.
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { build, defaultOutdir } from "../build.mjs";

function listFiles(dir) {
  const out = new Map();
  const visit = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(current, entry.name);
      if (entry.isDirectory()) visit(full);
      else out.set(relative(dir, full).split(sep).join("/"), full);
    }
  };
  visit(dir);
  return out;
}

const fresh = mkdtempSync(join(tmpdir(), "cqa-check-dist-"));
const problems = [];
try {
  await build({ outdir: fresh });
  const built = listFiles(fresh);
  const committed = listFiles(defaultOutdir);
  for (const [path, file] of built) {
    if (!committed.has(path)) problems.push(`missing from dist/: ${path}`);
    else if (!readFileSync(file).equals(readFileSync(committed.get(path)))) problems.push(`differs: ${path}`);
  }
  for (const path of committed.keys()) {
    if (!built.has(path)) problems.push(`not produced by the build: ${path}`);
  }
} finally {
  rmSync(fresh, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error("dist/ is out of date; run `npm run build` and commit it:");
  for (const problem of problems.sort()) console.error(`  ${problem}`);
  process.exit(1);
}
console.log("dist/ matches a fresh build");
