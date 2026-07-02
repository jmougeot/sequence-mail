/**
 * Client HTTP minimal vers l'API de Sequence Mail.
 *
 * Le serveur MCP ne touche PAS la base SQLite directement : il appelle l'API
 * Express, ce qui réutilise toute la validation, le scheduler et la logique
 * métier — et permet de viser une instance locale OU la prod déployée.
 *
 * Configuration par variables d'environnement :
 *   SEQUENCE_MAIL_BASE_URL   URL de l'app (défaut http://localhost:3000)
 *   SEQUENCE_MAIL_BASIC_AUTH "user:pass" si l'app est protégée par basic auth
 *                            (cas de la prod derrière Caddy, ex. admin:motdepasse)
 */

export const BASE_URL = (process.env.SEQUENCE_MAIL_BASE_URL ?? "http://localhost:3000").replace(/\/+$/, "");

function authHeaders(): Record<string, string> {
  const basic = process.env.SEQUENCE_MAIL_BASIC_AUTH;
  if (basic && basic.includes(":")) {
    return { Authorization: "Basic " + Buffer.from(basic).toString("base64") };
  }
  return {};
}

type ApiOptions = {
  /** Corps JSON (sérialisé automatiquement, Content-Type application/json). */
  json?: unknown;
  /** Corps CSV brut (Content-Type text/csv) — pour l'import de contacts. */
  csv?: string;
};

/**
 * Appelle l'API et renvoie le JSON décodé. Lève une Error explicite (statut +
 * message d'erreur de l'API) si la réponse n'est pas 2xx, pour que le tool MCP
 * la remonte telle quelle au client.
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
    // Cause la plus fréquente : l'app n'est pas démarrée / mauvaise URL.
    throw new Error(
      `Impossible de joindre Sequence Mail à ${BASE_URL} (${err instanceof Error ? err.message : err}). ` +
        `L'app est-elle démarrée ? Vérifie SEQUENCE_MAIL_BASE_URL.`
    );
  }

  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text; // réponse non-JSON (ex. page HTML d'erreur d'auth)
  }

  if (!res.ok) {
    const detail =
      data && typeof data === "object" && data !== null && "error" in data
        ? (data as { error: unknown }).error
        : typeof data === "string" && data
          ? data.slice(0, 300)
          : res.statusText;
    throw new Error(`HTTP ${res.status} sur ${method} ${path} — ${detail}`);
  }
  return data;
}
