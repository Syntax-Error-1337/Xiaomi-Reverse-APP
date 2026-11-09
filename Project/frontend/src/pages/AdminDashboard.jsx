import { useEffect, useState } from "react";
import { api, BASE, friendlyError } from "../api";
import { useAuth } from "../AuthContext";
import { ErrorBanner, LoadingRow, EmptyRow, Loading } from "../components/Feedback";
import KeyPanel from "../components/KeyPanel";
import ChangePassword from "../components/ChangePassword";
import { useLang } from "../i18n";

function fmtTime(v) {
  if (!v) return "—";
  try {
    return new Date(v).toLocaleString();
  } catch {
    return String(v);
  }
}

export default function AdminDashboard() {
  const { t } = useLang();
  const { user } = useAuth() || {};
  const [users, setUsers] = useState([]);
  const [scans, setScans] = useState([]);
  const [stats, setStats] = useState(null);
  const [audit, setAudit] = useState([]);
  const [err, setErr] = useState("");
  const [form, setForm] = useState({ username: "", password: "", role: "issuer", orgName: "", zone: "" });
  const [msg, setMsg] = useState("");
  const [exportCardId, setExportCardId] = useState("");
  const [exportErr, setExportErr] = useState("");
  const [exportBusy, setExportBusy] = useState(false);
  const [loadingUsers, setLoadingUsers] = useState(true);
  const [loadingScans, setLoadingScans] = useState(true);
  const [loadingStats, setLoadingStats] = useState(true);
  const [loadingAudit, setLoadingAudit] = useState(true);
  const [openOnly, setOpenOnly] = useState(false);
  const [quotaSupported, setQuotaSupported] = useState(true);
  const [triageBusy, setTriageBusy] = useState(null);
  const [quotaEdit, setQuotaEdit] = useState(null); // { id, value }

  const loadUsers = async () => {
    setLoadingUsers(true);
    try {
      const u = await api("/users");
      setUsers(Array.isArray(u) ? u : u.users || []);
    } catch (e) {
      setErr(friendlyError(e));
    } finally {
      setLoadingUsers(false);
    }
  };

  const loadScans = async () => {
    setLoadingScans(true);
    try {
      const s = await api("/scans/recent?limit=50");
      setScans(Array.isArray(s) ? s : s.scans || []);
    } catch {
      try {
        const s = await api("/scans?limit=20");
        setScans(Array.isArray(s) ? s : s.scans || []);
      } catch {
        setScans([]);
      }
    } finally {
      setLoadingScans(false);
    }
  };

  const loadStats = async () => {
    setLoadingStats(true);
    try {
      const s = await api("/stats");
      setStats(s?.stats || s);
    } catch {
      setStats(null);
    } finally {
      setLoadingStats(false);
    }
  };

  const loadAudit = async () => {
    setLoadingAudit(true);
    try {
      const a = await api("/audit?limit=100");
      setAudit(Array.isArray(a) ? a : a.entries || a.audit || []);
    } catch {
      setAudit([]);
    } finally {
      setLoadingAudit(false);
    }
  };

  const load = () => {
    loadUsers();
    loadScans();
    loadStats();
    loadAudit();
  };

  useEffect(() => { load(); }, []); // eslint-disable-line
  // After forced-rotation the gate clears user.mustChange without remounting:
  // the initial gated load failed 403, so clear the stale banner and reload.
  useEffect(() => { if (!user?.mustChange) { setErr(""); load(); } }, [user?.mustChange]); // eslint-disable-line

  const create = async (e) => {
    e.preventDefault();
    setMsg(""); setErr("");
    try {
      await api("/users", { method: "POST", body: form });
      setMsg(`Created ${form.role} "${form.username}"`);
      setForm({ username: "", password: "", role: "issuer", orgName: "", zone: "" });
      loadUsers();
    } catch (e2) { setErr(friendlyError(e2)); }
  };

  const toggle = async (u) => {
    try {
      await api(`/users/${u.id}/active`, { method: "PATCH", body: { active: !u.active } });
      loadUsers();
    } catch (e) { setErr(friendlyError(e)); }
  };

  const saveQuota = async (u) => {
    const raw = quotaEdit?.value ?? "";
    if (raw.trim() === "") { setQuotaEdit(null); return; }
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 0) return;
    try {
      await api(`/users/${u.id}/quota`, { method: "PATCH", body: { quota: n } });
      setQuotaEdit(null);
      loadUsers();
    } catch (e) {
      if (e?.status === 404) { setQuotaSupported(false); setQuotaEdit(null); }
      else setErr(friendlyError(e));
    }
  };

  const exportCsv = async () => {
    if (exportBusy) return;
    setExportErr(""); setExportBusy(true);
    try {
      const token = localStorage.getItem("pressid_token") || "";
      const q = exportCardId.trim() ? `?cardId=${encodeURIComponent(exportCardId.trim())}&format=csv` : "?format=csv";
      const res = await fetch(`${BASE}/scans/export${q}`, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
      });
      if (!res.ok) {
        const err = new Error(res.status === 404 ? "CSV export not available on this server (404)." : `HTTP ${res.status}`);
        err.status = res.status;
        try {
          const h = res.headers.get("Retry-After");
          if (h != null) {
            const n = parseInt(String(h).trim(), 10);
            if (Number.isFinite(n) && n >= 0) err.retryAfter = n;
          }
        } catch { /* ignore */ }
        throw err;
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url; a.download = "scans.csv";
      document.body.appendChild(a); a.click(); a.remove();
      URL.revokeObjectURL(url);
    } catch (e) { setExportErr(e.status === 404 ? e.message : e); }
    finally { setExportBusy(false); }
  };
  const triage = async (scan, state) => {
    setTriageBusy(scan.id);
    setErr("");
    try {
      await api(`/scans/${scan.id}/triage`, { method: "PATCH", body: { state } });
      await Promise.all([loadScans(), loadStats()]);
    } catch (e) { setErr(friendlyError(e)); }
    finally { setTriageBusy(null); }
  };

  const visibleScans = openOnly ? scans.filter((s) => (s.triage || "open") === "open") : scans;

  const tiles = stats
    ? [
        { label: t("stat_users"), value: stats.users },
        { label: t("stat_holders"), value: stats.holders },
        { label: t("stat_active"), value: stats.cardsActive },
        { label: t("stat_revoked"), value: stats.cardsRevoked },
        { label: t("stat_scans_today"), value: stats.scansToday },
        { label: t("stat_alerts"), value: stats.alertsToday },
        { label: t("stat_alerts_open"), value: stats.alertsOpen ?? stats.alertsToday },
      ]
    : [];

  return (
    <div className="page">
      <h2>{t("admin_title")}</h2>
      {user?.mustChange && (
        <p className="must-change-banner" role="alert">
          {t("must_change")} <a href="#change-password">{t("change_password")}</a>
        </p>
      )}
      <ErrorBanner error={err} onRetry={load} />
      {msg && <p className="ok">{msg}</p>}

      {loadingStats && <Loading label={t("loading_stats")} />}
      {!loadingStats && tiles.length > 0 && (
        <section>
          <h3>{t("registry_overview")}</h3>
          <div className="stat-grid">
            {tiles.map((x) => (
              <div className="stat-tile" key={x.label}>
                <div className="stat-value">{x.value ?? "—"}</div>
                <div className="stat-label">{x.label}</div>
              </div>
            ))}
          </div>
        </section>
      )}

      <KeyPanel />

      <section>
        <h3>{t("create_account")}</h3>
        <form className="grid" onSubmit={create}>
          <label>{t("username")}<input name="new-username" autoComplete="username" spellCheck={false} placeholder="e.g. issuer-delhi…" value={form.username} onChange={(e) => setForm({ ...form, username: e.target.value })} required /></label>
          <label>{t("password")}<input name="new-password" autoComplete="new-password" placeholder="min 8 characters…" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} required /></label>
          <label>{t("th_role")}<select name="new-role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="issuer">{t("role_issuer")}</option>
            <option value="police">{t("role_police")}</option>
          </select></label>
          <label>{t("organisation")}<input name="new-org" placeholder="e.g. Delhi Press Club…" value={form.orgName} onChange={(e) => setForm({ ...form, orgName: e.target.value })} /></label>
          <label>{t("zones")}<input name="new-zone" placeholder="e.g. north-delhi… (optional)" value={form.zone} onChange={(e) => setForm({ ...form, zone: e.target.value })} /></label>
          <button type="submit">{t("create_user")}</button>
        </form>
      </section>

      <section>
        <h3>{t("users_title")}</h3>
        <div className="table-wrap"><table>
          <thead><tr><th>{t("th_username")}</th><th>{t("th_role")}</th><th>{t("th_org")}</th>{quotaSupported && <th>{t("th_quota")}</th>}<th>{t("th_active")}</th><th></th></tr></thead>
          <tbody>
            {loadingUsers && <LoadingRow label={t("loading_users")} colSpan={6} />}
            {!loadingUsers && users.map((u) => (
              <tr key={u.id}>
                <td>{u.username}</td><td><span className="badge">{u.role}</span></td><td>{u.orgName || u.org_name || "—"}</td>
                {quotaSupported && <td>{quotaEdit?.id === u.id
                  ? <span className="row"><input className="mono" type="number" min={0} step={1} aria-label={t("edit_quota")} value={quotaEdit.value} onChange={(e) => setQuotaEdit({ id: u.id, value: e.target.value })} onKeyDown={(e) => { if (e.key === "Escape") setQuotaEdit(null); }} style={{ width: "5rem" }} /><button type="button" className="small" onClick={() => saveQuota(u)}>{t("save")}</button><button type="button" className="small" onClick={() => setQuotaEdit(null)}>{t("cancel")}</button></span>
                  : <>{u.quota ?? "—"} <button type="button" className="small" onClick={() => setQuotaEdit({ id: u.id, value: String(u.quota ?? "") })}>{t("edit_quota")}</button></>}</td>}
                <td>{u.active === false ? t("no") : t("yes")}</td>
                <td><button className="small" onClick={() => toggle(u)}>{u.active === false ? t("activate") : t("deactivate")}</button></td>
              </tr>
            ))}
            {!loadingUsers && users.length === 0 && <EmptyRow text={t("empty_users")} colSpan={6} />}
          </tbody>
        </table></div>
      </section>

      <section>
        <h3>{t("export_title")}</h3>
        <div className="row">
          <input className="mono" placeholder="cardId filter (optional)" value={exportCardId} onChange={(e) => setExportCardId(e.target.value)} aria-label="Card ID filter for CSV export" />
          <button type="button" className="small" onClick={exportCsv} disabled={exportBusy}>{exportBusy ? t("exporting") : t("export_csv")}</button>
        </div>
        <ErrorBanner error={exportErr} onRetry={exportErr?.status === 429 ? exportCsv : undefined} />
      </section>

      <section>
        <h3>{t("recent_scans")}</h3>
        <div className="row">
          <label><input type="checkbox" checked={openOnly} onChange={(e) => setOpenOnly(e.target.checked)} /> {t("filter_open_only")}</label>
        </div>
        <div className="table-wrap"><table>
          <thead><tr><th>{t("th_time")}</th><th>{t("th_card")}</th><th>{t("th_holder")}</th><th>{t("th_result")}</th><th>{t("th_flags")}</th><th>{t("th_triage")}</th><th></th></tr></thead>
          <tbody>
            {loadingScans && <LoadingRow label={t("loading_scans")} colSpan={7} />}
            {!loadingScans && visibleScans.slice(0, 50).map((s, i) => {
              const flags = s.flags || s.alerts || [];
              const tri = s.triage || "open";
              const triCls = tri === "resolved" ? "badge-ok" : tri === "acked" ? "badge-ack" : "badge-open";
              const busy = triageBusy === s.id;
              return (
                <tr key={s.id || i}>
                  <td>{fmtTime(s.at || s.createdAt || s.created_at)}</td>
                  <td className="mono">{String(s.cardId || s.card_id || "").slice(0, 12) || "—"}</td>
                  <td>{s.holderName || s.holder?.fullName || s.org || "—"}</td>
                  <td>
                    <span className={`badge ${String(s.result ?? s.valid ?? "").toLowerCase().includes("invalid") || s.valid === false ? "badge-bad" : "badge-ok"}`}>
                      {String(s.result ?? (s.valid === true ? "valid" : s.valid === false ? "invalid" : "—"))}
                    </span>
                  </td>
                  <td>{flags.length > 0 ? flags.map((f) => <span key={String(f)} className="flag">{typeof f === "string" ? f : JSON.stringify(f)}</span>) : "—"}</td>
                  <td><span className={`badge ${triCls}`}>{t(`triage_${tri}`) || tri}</span>{s.triagedBy ? <div className="muted">{s.triagedBy}</div> : null}</td>
                  <td>
                    {tri !== "resolved" && <button type="button" className="small" disabled={busy || !s.id} onClick={() => triage(s, "acked")}>{t("triage_ack")}</button>}{" "}
                    {tri !== "resolved" && <button type="button" className="small" disabled={busy || !s.id} onClick={() => triage(s, "resolved")}>{t("triage_resolve")}</button>}
                  </td>
                </tr>
              );
            })}
            {!loadingScans && visibleScans.length === 0 && <EmptyRow text={t("empty_scans")} colSpan={7} />}
          </tbody>
        </table></div>
      </section>

      <section>
        <h3>{t("audit_title")}</h3>
        <div className="table-wrap"><table>
          <thead><tr><th>{t("th_time")}</th><th>{t("th_actor")}</th><th>{t("th_action")}</th><th>{t("th_detail")}</th></tr></thead>
          <tbody>
            {loadingAudit && <LoadingRow label={t("loading_audit")} colSpan={4} />}
            {!loadingAudit && audit.map((a, i) => (
              <tr key={a.id || i}>
                <td>{fmtTime(a.at || a.createdAt || a.created_at)}</td>
                <td>{a.byUsername || a.by_username || a.actor || "—"}</td>
                <td><span className="badge">{a.action || "—"}</span></td>
                <td>{a.detail || "—"}</td>
              </tr>
            ))}
            {!loadingAudit && audit.length === 0 && <EmptyRow text={t("empty_audit")} colSpan={4} />}
          </tbody>
        </table></div>
      </section>

      <div id="change-password">
        <ChangePassword />
      </div>
    </div>
  );
}
