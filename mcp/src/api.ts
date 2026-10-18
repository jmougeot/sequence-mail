/**
 * Minimal HTTP client for the Sequence Mail API.
 *
 * The MCP server never touches the SQLite database: it calls the Express API,
 * reusing all validation, the scheduler and business logic, so it can target a
 * local instance OR a deployed one.
 *
 * Environment:
 *   SEQUENCE_MAIL_BASE_URL   app URL (default http://localhost:3000)
 *   SEQUENCE_MAIL_BASIC_AUTH "user:pass" if the app is behind basic auth
 *                            (e.g. production behind Caddy)
 *   SEQUENCE_MAIL_PUBLIC_URL app URL as seen from a browser, for links given to
 *                            the user (Google OAuth, extension). Default:
 *                            SEQUENCE_MAIL_BASE_URL. Set it when the MCP reaches
 *                            the app over an internal network (docker:
 *                            http://sequence-app:3000).
 */

export const BASE_URL = (process.env.SEQUENCE_MAIL_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");
export const PUBLIC_URL = (process.env.SEQUENCE_MAIL_PUBLIC_URL || BASE_URL).replace(/\/+$/, "");

/** Non-2xx API response: keeps status and decoded body (e.g. rendered_body of a 400). */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: unknown
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function authHeaders(): Record<string, string> {
  const basic = process.env.SEQUENCE_MAIL_BASIC_AUTH;
  if (basic && basic.includes(":")) {
    return { Authorization: "Basic " + Buffer.from(basic).toString("base64") };
  }
  return {};
}

type ApiOptions = {
  /** JSON body (serialized, Content-Type application/json). */
  json?: unknown;
  /** Raw CSV body (Content-Type text/csv), for contact imports. */
  csv?: string;
};

/**
 * Calls the API and returns the decoded JSON. Throws an ApiError (status + API
 * error message) on non-2xx, so the tool passes it through to the client.
 */
export async function api(method: string, path: string, opts: ApiOptions = {}): Promise<unknown> {
  const headers: Record<string, string> = { ...authHeaders() };
  let body: string | undefined;
  if (opts.csv !== undefined) {
    headers["Content-Type"] = "text/csv";
    body = opts.csv;
  } else if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.json);
  }

  let res: Response;
  try {
    res = await fetch(`${BASE_URL}${path}`, { method, headers, body });
  } catch (err) {
    // Most common cause: app not running / wrong URL.
    throw new Error(
      `Cannot reach Sequence Mail at ${BASE_URL} (${err instanceof Error ? err.message : err}). ` +
        `Is the app running? Check SEQUENCE_MAIL_BASE_URL.`
    );
  }

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text; // non-JSON response (e.g. auth error HTML page)
  }

  if (!res.ok) {
    const detail =
      data && typeof data === "object" && data !== null && "error" in data
        ? (data as { error: unknown }).error
        : typeof data === "string" && data
          ? data.slice(0, 300)
          : res.statusText;
    throw new ApiError(`HTTP ${res.status} on ${method} ${path} — ${detail}`, res.status, data);
  }
  return data;
}
