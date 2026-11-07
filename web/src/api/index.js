// The adapter factory. The rest of the app gets its API from here and never imports an adapter
// directly, so "http" and "mock" stay interchangeable.
import { createHttpApi } from "./http.js";

/**
 * @param {{api: "http", apiBase: string, role: () => "controller" | "reviewer", fetchImpl?: typeof fetch, timeoutMs?: number}} options
 */
export function createApi(options = {}) {
  const { api, ...rest } = options ?? {};
  if (api === "http") return createHttpApi(rest);
  throw new Error(`createApi: unsupported api ${JSON.stringify(api)} (only "http" is available so far)`);
}
