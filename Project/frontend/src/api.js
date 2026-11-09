import { t, getLang } from "./i18n";

const BASE = import.meta.env.VITE_API_URL || "http://localhost:4000/api";

function getToken() {
  return localStorage.getItem("pressid_token") || "";
}

function parseRetryAfter(res) {
  try {
    const h = res.headers.get("Retry-After");
    if (h == null) return null;
    const n = parseInt(String(h).trim(), 10);
    if (Number.isFinite(n) && n >= 0) return n;
  } catch { /* ignore */ }
  return null;
}

export async function api(path, { method = "GET", body, auth = true } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (auth && getToken()) headers["Authorization"] = `Bearer ${getToken()}`;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    data = null;
  }
  if (!res.ok) {
    if (res.status === 401) {
      // Expired/revoked JWT: drop the stale session so the next render
      // bounces to /login instead of failing every call.
      try {
        localStorage.removeItem("pressid_token");
        localStorage.removeItem("pressid_user");
      } catch { /* ignore */ }
    }
    const msg = (data && (data.error || data.message)) || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.status = res.status;
    if (res.status === 429) err.retryAfter = parseRetryAfter(res);
    throw err;
  }
  return data;
}

export function friendlyError(err) {
  const status = err?.status;
  const msg = err?.message || t(getLang(), "error_generic");
  if (status === 429 || /too many|rate limit|429/i.test(msg)) {
    const ra = err?.retryAfter;
    if (ra != null) return t(getLang(), "err_rate").replace("{n}", String(ra));
    return t(getLang(), "err_rate_soon");
  }
  return msg;
}

export { BASE };
