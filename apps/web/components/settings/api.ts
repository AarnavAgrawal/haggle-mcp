// Browser side of /api/settings*: JSON in and out. A redirect (the session ended) or a non-JSON answer
// becomes an error the page can show with a fix.

export type SettingsApiError = { code: string; message: string; fix: string };
export type SettingsApiResult<T> = ({ ok: true } & T) | { ok: false; error: SettingsApiError; fields?: Record<string, string> };

export async function settingsApi<T>(path: string, body: Record<string, unknown>): Promise<SettingsApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual", cache: "no-store" });
  } catch {
    return { ok: false, error: { code: "network", message: "Couldn't reach Haggle.", fix: "Check your connection and try again." } };
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    return { ok: false, error: { code: "signed_out", message: "Your session ended.", fix: "Sign in again, then retry." } };
  }
  try {
    return (await res.json()) as SettingsApiResult<T>;
  } catch {
    return { ok: false, error: { code: `http_${res.status}`, message: "Haggle sent an unexpected answer.", fix: "Reload the page and try again." } };
  }
}
