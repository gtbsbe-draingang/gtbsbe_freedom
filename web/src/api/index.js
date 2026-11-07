// The adapter factory. The rest of the app gets its API from here and never imports an adapter
// directly, so "http" and "mock" stay interchangeable.
import { createHttpApi } from "./http.js";
import { createMockApi } from "./mock/index.js";

/**
 * @param {{api: "http", apiBase: string, role: () => "controller" | "reviewer", fetchImpl?: typeof fetch, timeoutMs?: number}
 *   | {api: "mock", role?: () => "controller" | "reviewer", devDataUrl?: string, devAudioBase?: string, mockModelKey?: boolean,
 *      mockDelayMs?: number, mockFault?: Record<string, string>, storage?: Storage | null}} options
 *   The mock's options are documented on createMockApi.
 */
export function createApi(options = {}) {
  const { api, ...rest } = options ?? {};
  if (api === "http") return createHttpApi(rest);
  if (api === "mock") return createMockApi(rest);
  throw new Error(`createApi: unsupported api ${JSON.stringify(api)} (use "http" or "mock")`);
}
