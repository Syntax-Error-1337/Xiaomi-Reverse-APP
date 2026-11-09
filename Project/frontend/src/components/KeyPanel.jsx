import { useEffect, useState } from "react";
import { api, friendlyError } from "../api";
import { useLang } from "../i18n";
import { useAuth } from "../AuthContext";
import { ErrorBanner } from "./Feedback";
export default function KeyPanel() {
  const { t } = useLang();
  const { user } = useAuth();
  const [info, setInfo] = useState(null);
  const [infoErr, setInfoErr] = useState("");
  const [chain, setChain] = useState(null);
  const [chainErr, setChainErr] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const [bundleMsg, setBundleMsg] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [sinfo, setSinfo] = useState(null);
  const [sbusy, setSbusy] = useState(false);
  const [smsg, setSmsg] = useState("");
  const [serr, setSerr] = useState("");
  const [snew, setSnew] = useState("");
  const [sconfirming, setSconfirming] = useState(false);

  const downloadBundle = async () => {
    setBundleMsg("");
    setBusy(true);
    try {
      const b = await api("/admin/verify-bundle");
      const blob = new Blob([JSON.stringify(b)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = "bundle.json";
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setBundleMsg(t("bundle_saved"));
    } catch (e) {
      setBundleMsg(e?.status === 404 ? t("bundle_missing") : friendlyError(e));
    } finally { setBusy(false); }
  };
  const load = async () => {
    setInfoErr(""); setChainErr("");
    try {
      const r = await api("/admin/key-info");
      setInfo(r?.keyInfo || r?.key_info || r);
    } catch {
      setInfo(null);
      setInfoErr(t("key_unavailable"));
    }
    try {
      const v = await api("/audit/verify");
      setChain(v?.verify || v?.verification || v);
    } catch (e) {
      setChain(null);
      if (e?.status !== 404) setChainErr(e);
    }
  };

  const rotate = async () => {
    setBusy(true); setMsg("");
    try {
      const r = await api("/admin/rotate-keys", { method: "POST" });
      setMsg(JSON.stringify(r?.currentKid || r?.kid || r?.keyId || "rotated"));
      setConfirming(false);
      load();
    } catch (e) {
      setMsg("");
      setInfoErr(e?.status === 404 ? t("key_unavailable") : friendlyError(e));
    } finally { setBusy(false); }
  };

  const loadSecret = async () => {
    try {
      const r = await api("/admin/secret-info");
      setSinfo(r?.secret || r?.secret_info || r);
      setSerr("");
    } catch {
      // 404-safe: older servers lack the endpoint.
      setSinfo(null);
    }
  };

  useEffect(() => { load(); loadSecret(); }, []); // eslint-disable-line
  // Gate-lift reload (cycle 64): initial loads fail 403 under must_change;
  // clear stale states and reload once rotation clears the flag.
  useEffect(() => { if (!user?.mustChange) { setInfoErr(""); setChainErr(""); setSerr(""); load(); loadSecret(); } }, [user?.mustChange]); // eslint-disable-line

  const rotateSecret = async () => {
    setSbusy(true); setSmsg(""); setSerr("");
    try {
      const r = await api("/admin/rotate-secret", { method: "POST", body: { newSecret: snew } });
      setSmsg(String(r?.rotatedAt || t("secret_rotated")));
      setSnew("");
      setSconfirming(false);
      loadSecret();
    } catch (e) {
      if (e?.status === 404) setSerr(t("secret_unavailable"));
      else setSerr(friendlyError(e));
    } finally { setSbusy(false); }
  };

  const kid = info?.currentKid || info?.current_kid || info?.kid || info?.keyId || info?.key_id || "";
  const rotatedAt = info?.rotatedAt || info?.rotated_at || info?.createdAt || "";
  const hasPrev = info?.hasPrev ?? info?.has_prev ?? info?.hasPrevious ?? null;
  const ok = chain?.ok ?? chain?.valid ?? null;
  const count = chain?.entries ?? chain?.count ?? chain?.n ?? null;
  const brokenAt = chain?.brokenAt || chain?.broken_at || chain?.index || "";

  return (
    <section className="no-print">
      <h3>{t("key_title")}</h3>
      {infoErr && !info ? <p className="muted">{infoErr}</p> : (
        <div className="row">
          <span className="muted">{t("key_current")}:</span>
          <code className="mono kid-mono">{kid ? String(kid).slice(0, 12) : "—"}</code>
          {rotatedAt && <span className="muted">{t("key_rotated")}: {new Date(rotatedAt).toLocaleString()}</span>}
          {hasPrev !== null && hasPrev !== undefined && (
            <span className="badge">{t("key_prev")}: {hasPrev ? t("yes") : t("no")}</span>
          )}
        </div>
      )}
      <div className="row" style={{ marginTop: ".6rem" }}>
        {!confirming
          ? <button type="button" className="small" onClick={() => setConfirming(true)}>{t("key_rotate")}</button>
          : (
            <>
              <span>{t("key_confirm")}</span>
              <button type="button" className="small danger" disabled={busy} onClick={rotate}>{busy ? t("key_rotating") : t("key_rotate")}</button>
              <button type="button" className="small" disabled={busy} onClick={() => setConfirming(false)}>{t("clear")}</button>
            </>
          )}
        <button type="button" className="small" disabled={busy} onClick={downloadBundle}>{t("key_download")}</button>
      </div>
      {bundleMsg && <p className="muted mono" role="status">{bundleMsg}</p>}
      {msg && <p className="ok mono" role="status">{msg}</p>}
      <div style={{ marginTop: ".8rem" }}>
        <h4>{t("secret_title")}</h4>
        {sinfo ? (
          <div className="row">
            <span className="badge">{t("secret_prev")}: {sinfo?.hasPrev ? t("yes") : t("no")}</span>
            {sinfo?.rotatedAt && <span className="muted">{t("secret_rotated_at")}: {new Date(sinfo.rotatedAt).toLocaleString()}</span>}
            {sinfo?.source && <span className="muted">{t("secret_source")}: {sinfo.source}</span>}
          </div>
        ) : (
          <p className="muted">{t("secret_unavailable")}</p>
        )}
        <div className="row" style={{ marginTop: ".4rem" }}>
          <input
            type="password"
            autoComplete="new-password"
            placeholder={t("secret_new_placeholder")}
            value={snew}
            onChange={(e) => setSnew(e.target.value)}
            style={{ minWidth: "16rem" }}
          />
          {!sconfirming
            ? <button type="button" className="small" disabled={sbusy || snew.length < 32} onClick={() => setSconfirming(true)}>{t("secret_rotate")}</button>
            : (
              <>
                <span>{t("secret_confirm")}</span>
                <button type="button" className="small danger" disabled={sbusy} onClick={rotateSecret}>{sbusy ? t("secret_rotating") : t("secret_rotate")}</button>
                <button type="button" className="small" disabled={sbusy} onClick={() => setSconfirming(false)}>{t("clear")}</button>
              </>
            )}
        </div>
        {smsg && <p className="ok mono" role="status">{smsg}</p>}
        {serr && <p className="muted" role="status">{serr}</p>}
      </div>
      <div style={{ marginTop: ".6rem" }}>
        {ok === true && <span className="badge badge-ok">{t("chain_ok")}{count != null ? ` · ${count} ${t("chain_entries")}` : ""}</span>}
        {ok === false && <span className="badge badge-bad">{t("chain_broken")}: {String(brokenAt)}</span>}
        {ok === null && chainErr && (chainErr?.status === 429
          ? <ErrorBanner error={chainErr} onRetry={load} />
          : <span className="muted">{friendlyError(chainErr)}</span>)}
      </div>
    </section>
  );
}
