import { useCallback, useEffect, useRef, useState } from "react";
import { useLang } from "../i18n";
import { friendlyError } from "../api";

export function useCountdown() {
  const [remaining, setRemaining] = useState(0);
  const start = useCallback((n) => {
    const v = Number(n);
    setRemaining(Number.isFinite(v) && v > 0 ? Math.floor(v) : 0);
  }, []);
  useEffect(() => {
    if (remaining <= 0) return undefined;
    const id = globalThis.setInterval(() => setRemaining((r) => Math.max(0, r - 1)), 1000);
    return () => globalThis.clearInterval(id);
  }, [remaining > 0]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => setRemaining(0), []);
  return { remaining, start };
}

function fmtCountdown(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0));
  if (v >= 60) return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, "0")}`;
  return `${v}s`;
}

export function ErrorBanner({ error, onRetry }) {
  const { t } = useLang();
  const { remaining, start } = useCountdown();
  const ref = useRef(null);
  const retryAfter = typeof error === "object" && error ? error?.retryAfter ?? null : null;
  const key = typeof error === "object" && error ? `${error?.status}:${retryAfter}` : null;
  useEffect(() => {
    if (key && key !== ref.current) {
      ref.current = key;
      start(retryAfter);
    }
    if (!key) ref.current = null;
  }, [key, retryAfter, start]);
  if (!error) return null;
  const msg = typeof error === "string" ? error : friendlyError(error);
  const limited = retryAfter != null;
  const counting = limited && remaining > 0;
  return (
    <p className="error" role="alert">
      {msg}
      {limited && (
        <span className="rate-chip" style={{ marginLeft: ".6rem" }}>
          {counting ? fmtCountdown(remaining) : t("retry")}
        </span>
      )}
      {onRetry && (
        <button type="button" className="small ghost-dark" onClick={onRetry} disabled={counting} style={{ marginLeft: ".6rem" }}>
          {t("retry")}
        </button>
      )}
    </p>
  );
}

export function LoadingRow({ label = "Loading…", colSpan = 4 }) {
  return (
    <tr>
      <td colSpan={colSpan} className="muted">
        {label}
      </td>
    </tr>
  );
}

export function EmptyRow({ text = "Nothing here yet.", colSpan = 4 }) {
  return (
    <tr>
      <td colSpan={colSpan} className="muted">
        {text}
      </td>
    </tr>
  );
}

export function Loading({ label = "Loading…" }) {
  return <p className="muted">{label}</p>;
}
