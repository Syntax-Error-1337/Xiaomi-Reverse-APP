import { useEffect, useState } from "react";
import { api, friendlyError } from "../api";
import { useAuth } from "../AuthContext";
import PressCard from "../components/PressCard";
import ChangePassword from "../components/ChangePassword";
import { ErrorBanner, Loading } from "../components/Feedback";
import { useLang } from "../i18n";

export default function PressDashboard() {
  const { t } = useLang();
  const { user } = useAuth() || {};
  const [cards, setCards] = useState([]);
  const [scans, setScans] = useState([]);
  const [err, setErr] = useState("");
  const [scanErr, setScanErr] = useState("");
  const [selected, setSelected] = useState(null);
  const [qr, setQr] = useState("");
  const [token, setToken] = useState("");
  const [loading, setLoading] = useState(true);
  const [opening, setOpening] = useState(false);
  const [copied, setCopied] = useState("");
  const [reportBusy, setReportBusy] = useState(null);
  const [reportedMsg, setReportedMsg] = useState("");
  const [armedReport, setArmedReport] = useState(null);

  useEffect(() => {
    if (armedReport == null) return;
    const id = globalThis.setTimeout(() => setArmedReport(null), 5000);
    return () => globalThis.clearTimeout(id);
  }, [armedReport]);
  const [checkBusy, setCheckBusy] = useState(false);
  const [deviceAt, setDeviceAt] = useState(() => { try { return localStorage.getItem("pressid-device-at") || ""; } catch { return ""; } });

  const load = async () => {
    setLoading(true);
    setErr("");
    try {
      const c = await api("/cards");
      setCards(Array.isArray(c) ? c : c.cards || []);
      try {
        const s = await api("/me/scans");
        setScans(Array.isArray(s) ? s : s.scans || []);
        setScanErr("");
      } catch (e) { setScanErr(friendlyError(e)); }
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { load(); }, []);
  // After forced-rotation the gate clears user.mustChange without remounting:
  // the initial gated load failed 403, so clear stale banners and reload.
  useEffect(() => { if (!user?.mustChange) { setErr(""); setScanErr(""); load(); } }, [user?.mustChange]);

  const open = async (c) => {
    setSelected(c); setQr(""); setToken(""); setOpening(true); setCopied("");
    try {
      const full = await api(`/cards/${c.id}`);
      const card = full.card || full;
      setSelected(card);
      setQr(full.qrDataUrl || full.qr_data_url || c.qrDataUrl || "");
      setToken(full.token || card.token || "");
    } catch (e) { setErr(friendlyError(e)); }
    finally { setOpening(false); }
  };

  const copyToken = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(t("copied"));
    } catch {
      // fallback: select the textarea content
      try {
        const el = document.getElementById("press-token");
        if (el) { el.focus(); el.select(); document.execCommand("copy"); setCopied(t("copied")); }
        else setCopied(t("copy_failed"));
      } catch { setCopied(t("copy_failed")); }
    }
  };

  const status = (c) => {
    if (c.status) return c.status;
    if (c.revoked) return "revoked";
    const vt = c.validTill || c.valid_till;
    if (vt && new Date(vt) < new Date()) return "expired";
    return "active";
  };

  const frozen = (c) => ["reported", "revoked"].includes(status(c));

  const reportLoss = async (c) => {
    setReportBusy(c.id); setReportedMsg("");
    try {
      await api("/me/report-loss", { method: "POST", body: { cardId: c.id } });
      setReportedMsg(t("loss_reported"));
      setArmedReport(null);
      await load();
    } catch (e) { setErr(friendlyError(e)); }
    finally { setReportBusy(null); }
  };
  const checkIn = async () => {
    setCheckBusy(true); setErr("");
    try {
      let deviceId = "";
      try { deviceId = localStorage.getItem("pressid-device") || ""; } catch { deviceId = ""; }
      if (!deviceId) {
        deviceId = (typeof crypto !== "undefined" && crypto.randomUUID)
          ? crypto.randomUUID()
          : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
        try { localStorage.setItem("pressid-device", deviceId); } catch { /* ignore */ }
      }
      const r = await api("/me/check-in", { method: "POST", body: { deviceId } });
      const at = r.deviceAt || new Date().toISOString();
      setDeviceAt(at);
      try { localStorage.setItem("pressid-device-at", at); } catch { /* ignore */ }
      await load();
    } catch (e) { setErr(friendlyError(e)); }
    finally { setCheckBusy(false); }
  };

  const osm = (s) => (typeof s.lat === "number" && typeof s.lng === "number"
    ? `https://www.openstreetmap.org/?mlat=${s.lat}&mlon=${s.lng}#map=14/${s.lat}/${s.lng}` : null);
  // Forced rotation: until the temp password is changed, the backend blocks
  // every press endpoint except login + change-password — show only the form.
  if (user?.mustChange) {
    return (
      <div className="page">
        <h2>{t("my_creds")}</h2>
        <p className="must-change-banner" role="alert">
          {t("must_change")} <a href="#change-password">{t("change_password")}</a>
        </p>
        <div id="change-password">
          <ChangePassword />
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <h2>{t("my_creds")}</h2>
      {user?.mustChange && (
        <p className="must-change-banner" role="alert">
          {t("must_change")} <a href="#change-password">{t("change_password")}</a>
        </p>
      )}
      <ErrorBanner error={err} onRetry={load} />
      {loading && <Loading label={t("loading_creds")} />}
      {!loading && cards.length === 0 && <p className="muted">{t("empty_mine")}</p>}
      <div className="card-grid">
        {cards.map((c) => (
          <div key={c.id} className="mini-card">
            <button type="button" className="mini-card" onClick={() => open(c)}>
              <span className={`dot ${status(c)}`} />
              <span className="mono">{String(c.id).slice(0, 10)}</span>
              <span>{status(c)}</span>
            </button>
            {!frozen(c) && (armedReport === c.id
              ? <span className="row"><button type="button" className="small danger" disabled={reportBusy === c.id} onClick={() => reportLoss(c)} onBlur={() => setArmedReport(null)}>{reportBusy === c.id ? t("reporting") : t("confirm_report_armed").replace("{id}", String(c.id).slice(0, 10))}</button><button type="button" className="small" onClick={() => setArmedReport(null)}>{t("cancel")}</button></span>
              : <button type="button" className="small danger" disabled={reportBusy === c.id} onClick={() => setArmedReport(c.id)}>{t("report_loss")}</button>)}
          </div>
        ))}
      </div>
      {reportedMsg && <p className="muted" role="status">{reportedMsg}</p>}
      <section>
        <h3>{t("check_in_title")}</h3>
        <p className="muted">{t("check_in_hint")}</p>
        <div className="row">
          <button type="button" className="small" disabled={checkBusy} onClick={checkIn}>{checkBusy ? t("checking_in") : t("check_in_button")}</button>
          {deviceAt && <span className="muted" role="status">{t("checked_in_since").replace("{date}", new Date(deviceAt).toLocaleString())}</span>}
        </div>
      </section>
      <section>
        <h3>{t("my_scans")}</h3>
        <p className="muted">{t("my_scans_hint")}</p>
        {scanErr && <p className="muted">{scanErr}</p>}
        {!scanErr && scans.length === 0 && <p className="muted">{t("no_scans_mine")}</p>}
        {scans.length > 0 && (
          <div className="table-wrap"><table>
            <thead><tr><th>{t("th_time")}</th><th>{t("th_card")}</th><th>{t("th_result")}</th><th>{t("th_flags")}</th><th>{t("th_post")}</th><th>{t("th_map")}</th></tr></thead>
            <tbody>
              {scans.map((s, i) => (
                <tr key={s.at + "-" + s.cardId + "-" + i}>
                  <td>{s.at ? new Date(s.at).toLocaleString() : "—"}</td>
                  <td className="mono">{String(s.cardId).slice(0, 10)}</td>
                  <td>{s.result}</td>
                  <td>{(s.flags || []).length ? (s.flags || []).map((f) => <span key={f} className="flag">{f}</span>) : "—"}</td>
                  <td>{s.officerZone || s.officer_zone ? t("checked_by_zone").replace("{zone}", s.officerZone || s.officer_zone) : "—"}</td>
                  <td>{osm(s) ? <a href={osm(s)} target="_blank" rel="noreferrer">OSM</a> : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table></div>
        )}
      </section>
      {selected && (
        <section>
          <h3>{t("credential")}</h3>
          <p>{t("status_label")}: <b>{status(selected)}</b></p>
          {opening && <p className="muted">{t("loading_credential")}</p>}
          <PressCard card={selected} holder={selected.holder} qr={qr} />
          {qr && (
            <div className="qr-large no-print">
              <h4>{t("qr_title")}</h4>
              <img src={qr} alt="Card QR code large" className="qr-big" />
            </div>
          )}
          {token && (
            <div className="no-print">
              <h4>{t("token_title")}</h4>
              <textarea id="press-token" readOnly rows={3} className="mono" value={token} onFocus={(e) => e.target.select()} style={{ width: "100%" }} />
              <div className="row">
                <button type="button" className="small" onClick={copyToken}>{t("copy_token")}</button>
                {copied && <span className="muted" role="status">{copied}</span>}
              </div>
            </div>
          )}
          <div className="row"><button onClick={() => window.print()}>{t("print_card")}</button></div>
        </section>
      )}
      <div id="change-password">
        <ChangePassword />
      </div>
    </div>
  );
}
