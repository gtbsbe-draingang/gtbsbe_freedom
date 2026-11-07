// `npm run e2e`: builds the UI into a temp directory (dist/ is left alone, so check:dist stays
// meaningful), serves it with the dev server and the strict CSP, and runs every scenario in
// scenarios/ in headless Chrome. Set CQA_DATA_DIR to the data directory for the mock API.
//   node test/e2e/run.mjs [name-filter]
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "../../build.mjs";
import { startServer } from "../../tools/serve.mjs";
import { runScenarios } from "./harness.mjs";

const scenarioDir = join(dirname(fileURLToPath(import.meta.url)), "scenarios");
const filter = process.argv[2];

async function loadScenarios() {
  const files = readdirSync(scenarioDir).filter((file) => file.endsWith(".mjs")).sort();
  const scenarios = [];
  for (const file of files) {
    const mod = await import(pathToFileURL(join(scenarioDir, file)).href);
    const scenario = mod.default ?? mod;
    const valid =
      typeof scenario.name === "string" &&
      typeof scenario.path === "string" &&
      Array.isArray(scenario.viewports) &&
      scenario.viewports.length > 0 &&
      typeof scenario.run === "function";
    if (!valid) throw new Error(`scenarios/${file} must export { name, path, viewports, run }`);
    if (!filter || scenario.name.includes(filter)) scenarios.push(scenario);
  }
  return scenarios;
}

const outdir = mkdtempSync(join(tmpdir(), "cqa-e2e-"));
let server;
let exitCode = 1;
try {
  const scenarios = await loadScenarios();
  if (scenarios.length === 0) throw new Error(filter ? `no scenario matches "${filter}"` : "no scenarios found");
  await build({ outdir });
  server = await startServer({ port: 0, api: "mock", dist: outdir });
  const baseUrl = `http://127.0.0.1:${server.address().port}/`;

  const { results, cspViolations } = await runScenarios(scenarios, { baseUrl });
  for (const { name, viewport, failures } of results) {
    console.log(`${failures.length === 0 ? "PASS" : "FAIL"}  ${name} @ ${viewport[0]}x${viewport[1]}`);
    for (const failure of failures) console.log(`      - ${failure}`);
  }
  const failed = results.filter((result) => result.failures.length > 0).length;
  console.log(`\n${results.length - failed} passed, ${failed} failed; CSP violations: ${cspViolations}`);
  exitCode = failed === 0 ? 0 : 1;
} catch (error) {
  console.error(error.stack ?? error);
} finally {
  if (server) {
    server.closeAllConnections();
    server.close();
  }
  rmSync(outdir, { recursive: true, force: true });
}
process.exit(exitCode);
