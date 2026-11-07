// `npm run dev`: rebuilds dist/ on every change to src/ or static/ and serves it.
// Accepts the serve.mjs flags (--port, --api, --api-origin).
import { parseArgs } from "node:util";
import { build } from "../build.mjs";
import { startServer } from "./serve.mjs";

const { values } = parseArgs({
  options: {
    port: { type: "string", default: "5173" },
    api: { type: "string", default: "mock" },
    "api-origin": { type: "string" },
  },
});

const watcher = await build({ watch: true });
const server = await startServer({
  port: Number(values.port),
  api: values.api,
  apiOrigin: values["api-origin"] ? new URL(values["api-origin"]).origin : "",
});
console.log(`listening ${server.address().port}`);

const shutdown = async () => {
  server.close();
  await watcher.stop();
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
