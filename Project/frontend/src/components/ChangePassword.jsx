import { useState } from "react";
import { api, friendlyError } from "../api";
import { useAuth } from "../AuthContext";
import { useLang } from "../i18n";

export default function ChangePassword() {
  const { t } = useLang();
  const { setMustChange } = useAuth() || {};
  const [oldPw, setOldPw] = useState("");
  const [nw, setNw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    setMsg(""); setErr("");
    if (nw !== confirm) { setErr(t("pw_mismatch")); return; }
    setBusy(true);
    try {
      await api("/auth/change-password", {
        method: "POST",
        body: { oldPassword: oldPw, newPassword: nw },
      });
      setMsg(t("pw_saved"));
      setOldPw(""); setNw(""); setConfirm("");
      try { setMustChange?.(false); } catch { /* ignore */ }
    } catch (e2) {
      setErr(e2?.status === 404 ? "Password change not available on this server (404)." : friendlyError(e2));
    } finally { setBusy(false); }
  };

  return (
    <section className="no-print">
      <h3>{t("change_password")}</h3>
      <form className="grid" onSubmit={submit}>
        <label>{t("old_password")}<input type="password" autoComplete="current-password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} required /></label>
        <label>{t("new_password")}<input type="password" autoComplete="new-password" value={nw} onChange={(e) => setNw(e.target.value)} required /></label>
        <label>{t("confirm_password")}<input type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} required /></label>
        <button type="submit" disabled={busy}>{busy ? t("saving") : t("save")}</button>
      </form>
      {msg && <p className="ok" role="status">{msg}</p>}
      {err && <p className="error" role="alert">{err}</p>}
    </section>
  );
}
