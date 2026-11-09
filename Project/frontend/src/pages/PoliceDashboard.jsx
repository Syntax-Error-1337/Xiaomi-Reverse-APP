import { useEffect, useRef, useState } from "react";
import { BASE, api, friendlyError } from "../api";
import { ErrorBanner } from "../components/Feedback";
import ScanCamera from "../components/ScanCamera";
import { useLang } from "../i18n";
import { readCachedBundle, verifySignature } from "../offlineCrypto";

const REASON_HELP = {
  INVALID_FORMAT: { what: "Unreadable token — the QR payload could not be decoded.", action: "Ask for a reprint or re-issue; check for a damaged QR." },
  INVALID_SIGNATURE: { what: "Forgery suspected — the cryptographic signature does not check out.", action: "Do not accept. Escalate immediately." },
  CARD_NOT_FOUND: { what: "Unknown card — the card ID is not in the registry.", action: "Treat as unverified; check for counterfeits and escalate." },
  TAMPER_MISMATCH: { what: "Fields altered — the card contents do not match the signature.", action: "Escalate; possible tampering." },
  REVOKED: { what: "Withdrawn — the issuing org revoked this card.", action: "Confiscate or flag per procedure and escalate to a supervisor." },
  STATUS_EXPIRED: { what: "Past validity — the card's validity period has ended.", action: "Do not accept. Direct the holder to renew." },
  OUT_OF_ZONE: { what: "Outside permitted zones — the card is used where it is not authorised.", action: "Verify the assignment; deny entry if zone access is required." },
  UNKNOWN_ZONE: { what: "Officer zone unset.", action: "Informational only; set your zone so future checks enforce geography." },
  EVENT_ACTIVE: { what: "Event duty assignment — informational only.", action: "Informational only; confirm the event name and end date on the card." },
  DUPLICATE_SCAN: { what: "Repeat scan seconds ago.", action: "Informational only; normal at busy gates, but watch for pass-back abuse." },
  FIRST_SCAN_LATE: { what: "First scan long after issue — the card was first scanned well over an hour after it was issued.", action: "Informational only; fresh passes scan within minutes at the gate — a screenshot photographed days later trips this. Confirm the photo matches the holder." },
  SAME_POST_RESCAN: { what: "Same post rescan — this card was scanned at the same post minutes ago; possible pass-back through the crowd.", action: "Hold the holder, check the photo, call supervisor if a second person claims it." },
};

const NOTE_CODES = new Set(["UNKNOWN_ZONE", "DUPLICATE_SCAN", "EVENT_ACTIVE", "FIRST_SCAN_LATE", "SAME_POST_RESCAN"]);
function reasonCode(r) {
  if (typeof r === "string") return r.toUpperCase();
  return String(r?.code || r?.reason || "").toUpperCase();
}

function reasonInfo(code, tr) {
  const fb = REASON_HELP[code];
  if (typeof tr !== "function") {
    return fb || { what: `Raised reason: ${code}.`, action: "Verify manually and escalate if anything looks off." };
  }
  const whatKey = `reason_desc_${code}`;
  const actionKey = `reason_action_${code}`;
  const what = tr(whatKey);
  const action = tr(actionKey);
  return {
    what: what === whatKey ? (fb?.what ?? `Raised reason: ${code}.`) : what,
    action: action === actionKey ? (fb?.action ?? "Verify manually and escalate if anything looks off.") : action,
  };
}

function flagInfo(code, tr) {
  return reasonInfo(String(code || "").toUpperCase(), tr);
}

function fmtTime(v) {
  if (!v) return "—";
  try {
    return new Date(v).toLocaleString();
  } catch {
    return String(v);
  }
}

function relTime(v) {
  if (!v) return "";
  const d = new Date(v).getTime();
  if (Number.isNaN(d)) return "";
  const mins = Math.round((Date.now() - d) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs} h ago`;
  return `${Math.round(hrs / 24)} d ago`;
}

function MapLink({ lat, lng }) {
  if (lat === null || lat === undefined || lng === null || lng === undefined) return "—";
  if (lat === "—" || lng === "—") return "—";
  return (
    <a href={`https://www.openstreetmap.org/?mlat=${lat}&mlon=${lng}`} target="_blank" rel="noreferrer">
      {lat} / {lng} · map
    </a>
  );
}

function isValidPoint(s) {
  const r = s?.result;
  if (typeof r === "string") {
    const l = r.toLowerCase();
    return l.includes("valid") && !l.includes("invalid");
  }
  if (typeof s?.valid === "boolean") return s.valid;
  return true;
}

function ScanTrailMap({ points }) {
  const W = 640, H = 360, PAD = 28;
  const pts = (points || []).filter(
    (p) => Number.isFinite(Number(p?.lat)) && Number.isFinite(Number(p?.lng))
  );
  if (pts.length === 0) return <p className="muted">No mappable points (missing coordinates).</p>;
  const lats = pts.map((p) => Number(p.lat));
  const lngs = pts.map((p) => Number(p.lng));
  let minLat = Math.min(...lats), maxLat = Math.max(...lats);
  let minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  if (minLat === maxLat) { minLat -= 0.01; maxLat += 0.01; }
  if (minLng === maxLng) { minLng -= 0.01; maxLng += 0.01; }
  const X = (lng) => PAD + ((Number(lng) - minLng) / (maxLng - minLng)) * (W - 2 * PAD);
  const Y = (lat) => PAD + (1 - (Number(lat) - minLat) / (maxLat - minLat)) * (H - 2 * PAD);
  const xy = pts.map((p) => ({ x: X(p.lng), y: Y(p.lat) }));
  return (
    <svg viewBox={`0 0 ${W} ${H}`} className="scanmap" role="img" aria-label="Scan trail map">
      <rect x={0} y={0} width={W} height={H} className="scanmap-bg" />
      {xy.length > 1 && (
        <polyline points={xy.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(" ")} className="scanmap-line" fill="none" />
      )}
      {xy.map((p, i) => {
        const ok = isValidPoint(pts[i]);
        return (
          <g key={pts[i].id || i}>
            <circle cx={p.x} cy={p.y} r={9} className={ok ? "scanmap-dot-ok" : "scanmap-dot-bad"} />
            <text x={p.x} y={p.y + 4} textAnchor="middle" className="scanmap-num">{i + 1}</text>
            {i === 0 && <text x={p.x + 13} y={p.y - 10} className="scanmap-first">first</text>}
          </g>
        );
      })}
    </svg>
  );
}

function normalizeRows(res) {
  const rows = Array.isArray(res) ? res : res.timeline || res.scans || [];
  return [...rows].sort((a, b) => new Date(a.at || a.createdAt || a.created_at) - new Date(b.at || b.createdAt || b.created_at));
}

const QUEUE_KEY = "pressid-scan-queue";

function readQueue() {
  try {
    const raw = localStorage.getItem(QUEUE_KEY);
    const arr = raw ? JSON.parse(raw) : [];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function RiskPanel({ risk, t, hideCodes = [] }) {
  if (!risk || typeof risk !== "object") return null;
  const score = Number(risk.score);
  const level = String(risk.level || "").toLowerCase();
  const drivers = Array.isArray(risk.drivers) ? risk.drivers : [];
  if (!Number.isFinite(score) && !level && drivers.length === 0) return null;
  const badge = level === "high" ? "badge-bad" : level === "watch" ? "badge-warn" : "badge-ok";
  const label = level === "high" ? t("risk_high") : level === "watch" ? t("risk_watch") : t("risk_low");
  return (
    <div className="risk-panel no-print">
      <div className="row">
        <b>{t("risk_score")}: {Number.isFinite(score) ? Math.round(score) : "—"}/100</b>
        {level && <span className={`badge ${badge}`}>{label}</span>}
      </div>
      {Number.isFinite(score) && (
        <div className="risk-bar" role="img" aria-label={`${Math.round(score)}/100`}>
          <div className={`risk-fill risk-${level || "low"}`} style={{ width: `${Math.max(0, Math.min(100, score))}%` }} />
        </div>
      )}
      {drivers.length > 0 && (() => {
        // Dedupe (iteration K): a driver code already shown as a note chip
        // below renders once — hide it here.
        const shown = new Set((hideCodes || []).map((c) => String(c).toUpperCase()));
        const fresh = drivers.filter((d) => !shown.has(String(typeof d === "string" ? d : d.code || d.reason || "").toUpperCase()));
        if (fresh.length === 0) return null;
        return (
        <div className="note-chips">
          {fresh.map((d, i) => {
            const code = String(typeof d === "string" ? d : d.code || d.reason || "");
            const info = reasonInfo(code, t);
            const label = info && info.what && info.what !== code ? `${code} — ${info.what}` : code;
            return <span key={i} className="note-chip" title={info ? info.action || "" : ""}>{label}</span>;
          })}
        </div>
        );
      })()}
    </div>
  );
}

export default function PoliceDashboard() {
  const { t } = useLang();
  const [token, setToken] = useState("");
  const [lat, setLat] = useState("");
  const [lng, setLng] = useState("");
  // Auto-location (iteration E): when on, each verify silently refreshes
  // lat/lng from geolocation before submit. Consent = the toggle itself
  // (persisted); fields stay editable and auto-filled values show inline.
  const [autoLoc, setAutoLoc] = useState(() => {
    try { return localStorage.getItem("pressid-autoloc") !== "off"; } catch { return true; }
  });
  const [locAge, setLocAge] = useState(null);
  const [result, setResult] = useState(null);
  const [provisional, setProvisional] = useState(false);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [cardId, setCardId] = useState("");
  const [history, setHistory] = useState([]);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyErr, setHistoryErr] = useState("");
  const [lookedUp, setLookedUp] = useState(false);
  const [scanKey, setScanKey] = useState(0);
  // Last-verified receipt (iteration L/M): survives the scan-next token clear
  // and stays visible above the form with AND without a verdict, including
  // during the next submit's loading state. Set only on valid verdicts.
  const [receipt, setReceipt] = useState(null);
  const [photoUrl, setPhotoUrl] = useState(null);
  const [queue, setQueue] = useState(readQueue);
  const [online, setOnline] = useState(typeof navigator === "undefined" ? true : navigator.onLine !== false);
  const [flushMsg, setFlushMsg] = useState("");
  const flushingRef = useRef(false);
  const tokenRef = useRef(null);
  const verdictRef = useRef(null);

  const persistQueue = (q) => {
    setQueue(q);
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch { /* ignore */ }
  };

  const doVerifyCall = async (item) => {
    const body = { token: item.token };
    if (item.lat !== "" && item.lat != null) body.lat = Number(item.lat);
    if (item.lng !== "" && item.lng != null) body.lng = Number(item.lng);
    if (item.at) body.at = item.at; // queued offline scan time (server bounds it)
    return api("/verify", { method: "POST", body });
  };

  const flushQueue = async () => {
    if (flushingRef.current) return;
    const q = readQueue();
    if (q.length === 0) return;
    flushingRef.current = true;
    setFlushMsg("");
    let sent = 0;
    let remaining = [...q];
    for (const item of q) {
      try {
        await doVerifyCall(item);
        remaining = remaining.filter((r) => r !== item);
        persistQueue([...remaining]);
        sent += 1;
      } catch (e) {
        if (e?.status === 429) {
          const wait = (e.retryAfter != null ? Number(e.retryAfter) : 5) * 1000;
          await new Promise((r) => window.setTimeout(r, Number.isFinite(wait) ? wait : 5000));
          try {
            await doVerifyCall(item);
            remaining = remaining.filter((r) => r !== item);
            persistQueue([...remaining]);
            sent += 1;
          } catch { break; }
        } else break;
      }
    }
    flushingRef.current = false;
    if (sent > 0) setFlushMsg(t("flushed_count").replace("{n}", String(sent)));
  };

  useEffect(() => {
    const on = () => { setOnline(true); flushQueue(); };
    const off = () => setOnline(false);
    window.addEventListener("online", on);
    window.addEventListener("offline", off);
    if (navigator.onLine !== false) flushQueue();
    return () => { window.removeEventListener("online", on); window.removeEventListener("offline", off); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Hold-to-compare photo: fetch as blob with Bearer (api() is JSON-only), hide on 404.
  useEffect(() => {
    setPhotoUrl((prev) => { if (prev) URL.revokeObjectURL(prev); return null; });
    const holderId = result?.card?.holderId || result?.card?.holder_id || result?.card?.holder?.id;
    if (!holderId) return;
    let cancelled = false;
    let objUrl = null;
    (async () => {
      try {
        const tok = localStorage.getItem("pressid_token") || "";
        const res = await fetch(`${BASE}/holders/${encodeURIComponent(holderId)}/photo`, {
          headers: tok ? { Authorization: `Bearer ${tok}` } : {},
        });
        if (!res.ok) return;
        const blob = await res.blob();
        if (cancelled) return;
        objUrl = URL.createObjectURL(blob);
        setPhotoUrl(objUrl);
      } catch { /* hide on failure */ }
    })();
    return () => { cancelled = true; if (objUrl) URL.revokeObjectURL(objUrl); };
  }, [result]);


  const provisionalCheck = async (raw) => {
    const { jwk, error } = readCachedBundle();
    if (error || !jwk) {
      setErr(t("queue_no_bundle"));
      return;
    }
    try {
      const r = await verifySignature(raw, jwk);
      // Gate the snapshot on a verified signature (iteration P): a forged
      // QR must never render attacker-controlled name/org as trustworthy.
      if (!r.ok) {
        setResult({ valid: false, provisional: true, card: null, reasons: ["INVALID_SIGNATURE"], alerts: [], risk: null });
      } else {
        setResult({ valid: r.ok, provisional: true, card: r.payload ? { id: r.payload.cardId || r.payload.card_id || "", fullName: r.payload.name || "", org: r.payload.org || "", validTill: r.payload.validTill || "", provisionalSnapshot: true, photoHash: null } : null, reasons: [], alerts: [], risk: null });
      }
      setProvisional(true);
    } catch (e) { setErr(e.message || "Verification failed."); }
  };

  const submitToken = async (raw) => {
    if (busy) return;
    setErr(""); setResult(null); setProvisional(false); setBusy(true); setFlushMsg("");
    const clean = String(raw || "").trim();
    try {
      const coords = await resolveCoords();
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        persistQueue([...readQueue(), { token: clean, lat: coords.lat, lng: coords.lng, at: new Date().toISOString() }]);
        // No setErr here (iteration T): the persistent queue banner above is
        // the confirmation — provisionalCheck's own errors (e.g. no bundle)
        // must not clobber, nor be clobbered by, a redundant message.
        await provisionalCheck(clean);
        return;
      }
      const body = { token: clean };
      if (coords.lat !== "") body.lat = Number(coords.lat);
      if (coords.lng !== "") body.lng = Number(coords.lng);
      const res = await api("/verify", { method: "POST", body });
      setResult(res);
      setScanKey((k) => k + 1);
      verdictRef.current?.scrollIntoView?.({ block: "nearest" });
      // Scan-next flow (iteration K): only a VALID verdict clears the
      // credential + refocuses for the next holder. Invalid verdicts and
      // errors keep the token so the officer can retry / inspect it.
      if (res && res.valid) {
        const rc = res.card || {};
        setReceipt({
          at: new Date().toISOString(),
          cardId: rc.id || "",
          name: rc.fullName || rc.holder?.fullName || "",
          org: rc.org || rc.holder?.org || "",
          score: res.risk?.score,
        });
        setToken("");
        tokenRef.current?.focus?.();
      }
    } catch (e2) { setErr(e2); }
    finally { setBusy(false); }
  };

  const onCameraDecode = (raw) => {
    setToken(String(raw || ""));
    submitToken(raw);
  };

  const lookup = async (e) => {
    e.preventDefault(); setHistoryErr(""); setHistoryLoading(true); setLookedUp(true);
    const id = cardId.trim();
    try {
      try {
        const res = await api(`/scans/${encodeURIComponent(id)}/timeline`);
        setHistory(normalizeRows(res));
      } catch (err1) {
        if (err1?.status !== 404) throw err1;
        const res = await api(`/scans?cardId=${encodeURIComponent(id)}`);
        setHistory(normalizeRows(res));
      }
    } catch (e2) { setHistoryErr(friendlyError(e2)); setHistory([]); }
    finally { setHistoryLoading(false); }
  };
  const useMyLocation = () => {
    if (!("geolocation" in navigator)) { setErr(t("geo_unavailable")); return; }
    // Same 900ms race as auto-location (iteration O): weak GPS must not
    // leave the fields hanging with no feedback.
    let done = false;
    const timer = window.setTimeout(() => {
      if (done) return; done = true;
      setLocStale(true); setErr(t("geo_timeout"));
    }, 900);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        if (done) return; done = true;
        window.clearTimeout(timer);
        setLat(String(pos.coords.latitude)); setLng(String(pos.coords.longitude));
        setLocAge(Date.now()); setLocStale(false); setErr("");
      },
      (e) => {
        if (done) return; done = true;
        window.clearTimeout(timer);
        if (e && e.code === 1) setErr(t("geo_denied"));
        else if (e && e.code === 3) setErr(t("geo_timeout"));
        else setErr(t("geo_unavailable"));
      },
      { timeout: 8000, maximumAge: 60000 },
    );
  };
  // Resolve fresh coords when auto-location is on. Never blocks the scan:
  // GPS races a 900ms timer, loser falls back to last-known/manual fields
  // with a stale hint. A background refresh keeps improving coords for the
  // NEXT scan (iteration N — was: up to 8s stall per verify on weak GPS).
  const [locStale, setLocStale] = useState(false);
  const resolveCoords = () => new Promise((resolve) => {
    if (!autoLoc || !("geolocation" in navigator)) return resolve({ lat, lng, stale: false });
    let done = false;
    const finish = (la, ln, stale) => {
      if (done) return; done = true;
      if (la !== null) { setLat(la); setLng(ln); setLocAge(Date.now()); }
      setLocStale(stale);
      resolve({ lat: la ?? lat, lng: ln ?? lng, stale });
    };
    window.setTimeout(() => finish(null, null, true), 900);
    try {
      navigator.geolocation.getCurrentPosition(
        (pos) => finish(String(pos.coords.latitude), String(pos.coords.longitude), false),
        () => finish(null, null, true),
        { timeout: 8000, maximumAge: 60000 },
      );
    } catch { finish(null, null, true); }
  });

  const scans = result?.lastScans || result?.last_scans || [];
  const alerts = result?.alerts || result?.flags || [];
  const card = result?.card || null;
  const rawReasons = result?.reasons || [];
  const noteReasons = rawReasons.filter((r) => NOTE_CODES.has(reasonCode(r)));
  const blockerReasons = rawReasons.filter((r) => !NOTE_CODES.has(reasonCode(r)));

  return (
    <div className="page">
      <h2>{t("checkpoint")}</h2>
      <ErrorBanner error={err} onRetry={err?.status === 429 ? () => submitToken(token) : undefined} />

      {!online && (
        <p className="must-change-banner no-print" role="status">
          {t("queued_banner").replace("{n}", String(queue.length))} · {t("queue_offline")}
          {queue.length > 0 && <button type="button" className="small" onClick={flushQueue}>{t("flush_queue")}</button>}
        </p>
      )}
      {online && queue.length > 0 && (
        <p className="must-change-banner no-print" role="status">
          {t("queued_banner").replace("{n}", String(queue.length))}
          <button type="button" className="small" onClick={flushQueue}>{t("flush_queue")}</button>
          {flushMsg && <span className="hint">{flushMsg}</span>}
        </p>
      )}
      {online && queue.length === 0 && flushMsg && (
        <p className="ok no-print" role="status">{flushMsg}</p>
      )}

      <section>
        <h3>{t("verify_credential")}</h3>
        {receipt && (
          <p className="ok no-print" role="status" data-testid="last-verified">
            {t("last_verified")}: <b>{receipt.name || `#${receipt.cardId}`}</b>
            {receipt.org ? ` · ${receipt.org}` : ""}
            {Number.isFinite(receipt.score) ? ` · ${Math.round(receipt.score)}/100` : ""}
          </p>
        )}
        <ScanCamera t={t} onDecode={onCameraDecode} scanKey={scanKey} />
        <form onSubmit={(e) => { e.preventDefault(); submitToken(token); }}>
          <label htmlFor="verify-token">{t("token_label")}</label>
            <textarea ref={tokenRef} id="verify-token" name="token" autoComplete="off" spellCheck={false} rows={3} className="mono" value={token} onChange={(e) => setToken(e.target.value)} required />
          <div className="row">
            <label><input type="checkbox" checked={autoLoc} onChange={(e) => { const v = e.target.checked; setAutoLoc(v); try { localStorage.setItem("pressid-autoloc", v ? "on" : "off"); } catch { /* ignore */ } }} /> {t("auto_location")}</label>
            {locAge && autoLoc && !locStale && <span className="hint">{t("loc_fresh").replace("{s}", String(Math.max(0, Math.round((Date.now() - locAge) / 1000))))}</span>}
            {locStale && autoLoc && <span className="hint">{t("loc_stale")}</span>}
          </div>
          <details className="no-print">
            <summary>{t("adjust_location")}</summary>
          <div className="row">
            <label>{t("lat_label")}<input name="lat" inputMode="decimal" placeholder="e.g. 28.61…" value={lat} onChange={(e) => setLat(e.target.value)} /></label>
            <label>{t("lng_label")}<input name="lng" inputMode="decimal" placeholder="e.g. 77.20…" value={lng} onChange={(e) => setLng(e.target.value)} /></label>
            <button type="button" className="small" onClick={useMyLocation}>{t("use_location")}</button>
          </div>
          </details>
          <button type="submit" disabled={busy}>{busy ? t("verifying") : t("verify")}</button>
        </form>
      </section>

      {result && (
        <section ref={verdictRef} className={`verdict ${result.valid && !result.provisional && !provisional ? "valid" : result.valid ? "" : "invalid"}`}>
          <div className="verdict-top">
            {(result.provisional || provisional) && result.valid ? (
              <>
                <div className="verdict-big" style={{ color: "var(--warning, #b7791f)" }}>{t("sig_ok_unknown")}</div>
                <span className="badge badge-warn">{t("provisional")}</span>
              </>
            ) : (
              <>
                <div className={`verdict-big ${result.valid ? "ok-text" : "bad-text"}`}>{result.valid ? t("valid") : t("invalid")}</div>
                <span className={`badge ${result.valid ? "badge-ok" : "badge-bad"}`}>
                  {result.valid ? t("accept") : t("do_not_accept")}
                </span>
                {(provisional || result.provisional) && <span className="badge badge-warn">{t("provisional")}</span>}
              </>
            )}
          </div>
          <RiskPanel risk={result.risk} t={t} hideCodes={noteReasons.map(reasonCode)} />
          <p className="hint">
            {(result.provisional || provisional) && result.valid
              ? t("provisional_hint")
              : result.valid ? t("verdict_valid_hint") : t("verdict_invalid_hint")}
          </p>
          {noteReasons.length > 0 && (
            <div className="note-chips">
              {noteReasons.map((r, i) => {
                const code = reasonCode(r);
                const info = reasonInfo(code, t);
                if (code === "EVENT_ACTIVE") {
                  const nm = card?.eventName || card?.event_name || "";
                  const ed = card?.eventEnd || card?.event_end || "";
                  const label = t("event_duty_until")
                    .replace("{name}", nm || "—")
                    .replace("{date}", ed ? new Date(ed).toLocaleDateString() : "—");
                  return <span key={i} className="note-chip note-chip-info" title={info.what}>{label}</span>;
                }
                return <span key={i} className="note-chip" title={info.what}>{code}</span>;
              })}
            </div>
          )}
          {blockerReasons.length > 0 && (
            <div className="alerts">
              {blockerReasons.map((r, i) => {
                const code = reasonCode(r);
                const info = reasonInfo(code, t);
                return (
                  <div key={i} className="alert">
                    <div className="alert-code">{code}</div>
                    <div className="alert-what">{info.what}</div>
                    <div className="alert-action">{t("suggested_action")}: {info.action}</div>
                  </div>
                );
              })}
            </div>
          )}
          {alerts.length > 0 && (() => {
            // Dedupe: a code already shown as a reason chip/alert above
            // renders once (iteration J) — one informational flag must not
            // look like multiple incidents.
            const shown = new Set([...rawReasons.map(reasonCode), ...blockerReasons.map(reasonCode)]);
            const fresh = alerts.filter((a) => {
              const code = typeof a === "string" ? a.toUpperCase() : String(a.code || a.flag || "").toUpperCase();
              return code && !shown.has(code);
            });
            if (fresh.length === 0) return null;
            return (
            <div className="alerts">
              {fresh.map((a, i) => {
                const code = typeof a === "string" ? a.toUpperCase() : String(a.code || a.flag || "").toUpperCase() || JSON.stringify(a);
                const info = flagInfo(code, t);
                return (
                  <div key={i} className="alert">
                    <div className="alert-code">{code}</div>
                    <div className="alert-what">{info.what}</div>
                    <div className="alert-action">{t("suggested_action")}: {info.action}</div>
                  </div>
                );
              })}
            </div>
            );
          })()}
          {card && (
            <div className="holder-box">
              <h4>{t("holder_title")}</h4>
              <p><b>{card.fullName || card.holder?.fullName || card.holder?.full_name || "—"}</b> · {card.org || card.holder?.org || ""} · {card.designation || card.holder?.designation || ""}</p>
              <p className="mono">card {String(card.id || "").slice(0, 16)}</p>
              {card.provisionalSnapshot && <p className="hint">{t("provisional_snapshot")}</p>}
              {photoUrl && (
                <figure className="photo-compare no-print">
                  <img src={photoUrl} alt="card holder" className="photo-compare-img" />
                  <figcaption className="hint">{t("photo_compare_hint")}</figcaption>
                </figure>
              )}
              <p role="status">
                <span className={`badge ${card.hasPhoto ?? (card.photoHash ? true : false) ? "badge-ok" : "badge-bad"}`}>
                  {card.hasPhoto ?? (card.photoHash ? true : false) ? t("photo_on_file") : t("photo_missing")}
                </span>
                {(card.holderCheckedIn ?? false) && (
                  <span className="badge badge-ok">{t("checked_in")}</span>
                )}
              </p>
            </div>
          )}
          {scans.length > 0 && (
            <>
              <h4>{t("last_scans")} {Math.min(scans.length, 5)}</h4>
              <div className="table-wrap"><table>
                <thead><tr><th>{t("th_time")}</th><th>{t("lat_lng")}</th><th>{t("th_result")}</th><th>{t("th_flags")}</th></tr></thead>
                <tbody>
                  {scans.slice(0, 5).map((s, i) => {
                    const fl = s.flags || s.alerts || [];
                    return (
                    <tr key={s.id || i}>
                      <td>{fmtTime(s.at || s.createdAt || s.created_at || s.time)}</td>
                      <td>{s.lat ?? "—"} / {s.lng ?? "—"}</td>
                      <td><span className="badge">{String(s.result ?? (s.valid === true ? "valid" : s.valid === false ? "invalid" : "—"))}</span></td>
                      <td>{fl.length > 0 ? fl.map((f, j) => <span key={j} className="flag">{typeof f === "string" ? f : JSON.stringify(f)}</span>) : "—"}</td>
                    </tr>
                    );
                  })}
                </tbody>
              </table></div>
            </>
          )}
        </section>
      )}

      <section>
        <h3>{t("scan_history")}</h3>
        <form className="row" onSubmit={lookup}>
          <input className="mono" placeholder="cardId" value={cardId} onChange={(e) => setCardId(e.target.value)} required />
          <button type="submit" className="small" disabled={historyLoading}>{historyLoading ? t("looking_up") : t("lookup")}</button>
        </form>
        <ErrorBanner error={historyErr} />
        {historyLoading && <p className="muted">{t("loading_timeline")}</p>}
        {!historyLoading && lookedUp && history.length === 0 && !historyErr && (
          <p className="muted">{t("no_scans_card")}</p>
        )}
        {history.length > 0 && (
          <>
            <ScanTrailMap points={history} />
            <ol className="timeline">
              {history.map((s, i) => {
                const ts = s.at || s.createdAt || s.created_at;
                const flags = s.flags || [];
                return (
                  <li key={s.id || i} className="timeline-item">
                    <div className="timeline-time">#{i + 1} · {fmtTime(ts)} <span className="muted">({relTime(ts)})</span></div>
                    <div><MapLink lat={s.lat} lng={s.lng} /></div>
                    <div><span className="badge">{String(s.result ?? (s.valid === true ? "valid" : s.valid === false ? "invalid" : "—"))}</span></div>
                    {(s.officerZone || s.officer_zone) && <div><span className="note-chip">{t("checked_by_zone").replace("{zone}", s.officerZone || s.officer_zone)}</span></div>}
                    {s.byUsername && <div className="muted">by {s.byUsername}</div>}
                    {flags.length > 0 && (
                      <div>{flags.map((f, j) => <span key={j} className="flag">{typeof f === "string" ? f : JSON.stringify(f)}</span>)}</div>
                    )}
                  </li>
                );
              })}
            </ol>
          </>
        )}
      </section>
    </div>
  );
}
