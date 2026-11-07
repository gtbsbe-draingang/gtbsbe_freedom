// The one error type every adapter throws. `code` is the server's error code (for example
// "model_key_missing") or one of the client-side codes "network", "timeout" and "bad_response".
// `message` is for logs and developers; the UI maps `code` to a Russian string with t().

export const CLIENT_CODES = Object.freeze(["network", "timeout", "bad_response"]);

export class ApiError extends Error {
  /**
   * @param {string} code
   * @param {string} message
   * @param {{status?: number | null, retryable?: boolean, cause?: unknown}} [options]
   *   `retryable` defaults to true for "network", "timeout" and any 5xx status, false otherwise.
   */
  constructor(code, message, { status = null, retryable, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "ApiError";
    this.code = code;
    this.status = status;
    this.retryable = retryable ?? (code === "network" || code === "timeout" || (status !== null && status >= 500));
  }
}
