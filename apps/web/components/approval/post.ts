// Browser side of the approve / pay / callback routes: POST JSON, read the JSON answer. A redirect
// (the session ended and the proxy sent the request to /login) or a non-JSON answer becomes an error
// the panel can show with a fix.

export type ApiError = { code: string; message: string; fix: string };
export type ApiResult<T> = ({ ok: true } & T) | { ok: false; error: ApiError; next: string | null };

export async function postAction<T>(path: string, body: Record<string, unknown>): Promise<ApiResult<T>> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), redirect: "manual", cache: "no-store" });
  } catch {
    return { ok: false, error: { code: "network", message: "Couldn't reach Haggle.", fix: "Check your connection and try again." }, next: null };
  }
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    return { ok: false, error: { code: "signed_out", message: "Your session ended.", fix: "Sign in again, then retry." }, next: null };
  }
  try {
    return (await res.json()) as ApiResult<T>;
  } catch {
    return { ok: false, error: { code: `http_${res.status}`, message: "Haggle sent an unexpected answer.", fix: "Reload the page and try again." }, next: null };
  }
}

const whole = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });
const cents = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** $995, $12.50 */
export const usd = (n: number) => (Number.isInteger(n) ? whole : cents).format(n);
