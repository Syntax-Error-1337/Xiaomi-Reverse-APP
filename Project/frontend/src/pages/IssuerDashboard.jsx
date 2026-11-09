import { useEffect, useState } from "react";
import { api, friendlyError } from "../api";
import { useAuth } from "../AuthContext";
import PressCard from "../components/PressCard";
import { ErrorBanner, LoadingRow, EmptyRow, Loading } from "../components/Feedback";
import { useLang } from "../i18n";

function cardStatus(c) {
  if (c.status) return c.status.toLowerCase();
  if (c.revoked) return "revoked";
  const vt = c.validTill || c.valid_till;
  if (vt && new Date(vt) < new Date()) return "expired";
  return "active";
}

export default function IssuerDashboard() {
  const { t } = useLang();
  const { user } = useAuth();
  const [holders, setHolders] = useState([]);
  const [cards, setCards] = useState([]);
  const [err, setErr] = useState("");
  const [hmsg, setHmsg] = useState("");
  const [hform, setHform] = useState({ fullName: "", org: "", designation: "", idRef: "", photoHash: "" });
  const [cform, setCform] = useState({ holderId: "", validDays: 365, zones: "", eventName: "", eventEnd: "", replacesId: null });
  const [issued, setIssued] = useState(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [photoMsg, setPhotoMsg] = useState({});
  const [photoBusy, setPhotoBusy] = useState({});
  const [armedRevoke, setArmedRevoke] = useState(null);

  useEffect(() => {
    if (armedRevoke == null) return;
    const id = globalThis.setTimeout(() => setArmedRevoke(null), 5000);
    return () => globalThis.clearTimeout(id);
  }, [armedRevoke]);
  useEffect(() => {
    if (user?.orgName && !hform.org) setHform((f) => ({ ...f, org: user.orgName }));
  }, [user]); // eslint-disable-line

  const load = async () => {
    setLoading(true);
    try { const h = await api("/holders"); setHolders(Array.isArray(h) ? h : h.holders || []); }
    catch (e) { setErr(friendlyError(e)); }
    try { const c = await api("/cards"); setCards(Array.isArray(c) ? c : c.cards || []); }
    catch { /* ignore */ }
    finally { setLoading(false); }
  };
  useEffect(() => { load(); }, []); // eslint-disable-line

  const createHolder = async (e) => {
    e.preventDefault(); setErr(""); setHmsg("");
    const body = { ...hform };
    if (!body.photoHash) delete body.photoHash;
    try {
      const res = await api("/holders", { method: "POST", body });
      const holder = res.holder || res;
      setHmsg(`Holder created${res.username ? ` — login: ${res.username} / ${res.tempPassword}` : ""}`);
      setHform({ fullName: "", org: user?.orgName || "", designation: "", idRef: "", photoHash: "" });
      if (holder?.id) setCform((f) => ({ ...f, holderId: holder.id }));
      load();
    } catch (e2) { setErr(friendlyError(e2)); }
  };

  const startReplace = (card) => {
    const zones = (card.zones || []).join(", ");
    const evEnd = card.eventEnd || card.event_end
      ? new Date(card.eventEnd || card.event_end).toISOString().slice(0, 16)
      : "";
    setCform({
      holderId: String(card.holderId || card.holder_id || ""),
      validDays: 365,
      zones,
      eventName: card.eventName || card.event_name || "",
      eventEnd: evEnd,
      replacesId: card.id,
    });
    setIssued(null);
    setErr("");
    document.querySelector('form [name="card-days"]')?.focus?.();
  };

  const cancelReplace = () => setCform({ holderId: "", validDays: 365, zones: "", eventName: "", eventEnd: "", replacesId: null });

  const issueCard = async (e) => {
    e.preventDefault(); setErr(""); setIssued(null);
    const zones = cform.zones.split(",").map((z) => z.trim()).filter(Boolean);
    const body = { holderId: cform.holderId, validDays: Number(cform.validDays), zones };
    if (cform.eventName.trim()) body.eventName = cform.eventName.trim();
    if (cform.eventEnd) body.eventEnd = new Date(cform.eventEnd).toISOString();
    if (cform.replacesId) body.replacesId = cform.replacesId;
    try {
      const res = await api("/cards", { method: "POST", body });
      setIssued(res);
      setCform({ holderId: "", validDays: 365, zones: "", eventName: "", eventEnd: "", replacesId: null });
      load();
    } catch (e2) { setErr(e2.status === 404 ? friendlyError(e2) : e2); }
  };

  const revoke = async (id) => {
    try { await api(`/cards/${id}/revoke`, { method: "POST", body: { reason: "revoked" } }); setArmedRevoke(null); load(); }
    catch (e) { setErr(friendlyError(e)); }
  };

  const downscaleToDataUrl = (file) => new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const scale = Math.min(1, 480 / Math.max(img.width, img.height));
        const w = Math.max(1, Math.round(img.width * scale));
        const h = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement("canvas");
        canvas.width = w; canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL("image/jpeg", 0.7));
      } catch (e) { URL.revokeObjectURL(url); reject(e); }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error(t("photo_unreadable"))); };
    img.src = url;
  });

  const uploadPhoto = async (holderId, file) => {
    if (!file) return;
    if (!["image/jpeg", "image/png"].includes(file.type)) {
      setPhotoMsg((m) => ({ ...m, [holderId]: t("photo_jpeg_only") }));
      return;
    }
    setPhotoBusy((m) => ({ ...m, [holderId]: true }));
    setPhotoMsg((m) => ({ ...m, [holderId]: "" }));
    try {
      const dataUrl = await downscaleToDataUrl(file);
      if (dataUrl.length > 700 * 1024) {
        setPhotoMsg((m) => ({ ...m, [holderId]: t("photo_oversize") }));
        return;
      }
      const res = await api(`/holders/${holderId}/photo`, { method: "POST", body: { dataUrl } });
      const hash = res?.photoHash || res?.photo_hash || "";
      setPhotoMsg((m) => ({ ...m, [holderId]: hash ? `${t("photo_saved")} · ${String(hash).slice(0, 12)}` : t("photo_saved") }));
      load();
    } catch (e2) {
      setPhotoMsg((m) => ({ ...m, [holderId]: e2?.status === 404 ? t("photo_noserver") : friendlyError(e2) }));
    } finally {
      setPhotoBusy((m) => ({ ...m, [holderId]: false }));
    }
  };

  const holderOf = (card) => card.holder || holders.find((h) => h.id === (card.holderId || card.holder_id));

  const q = query.trim().toLowerCase();
  const matchCard = (c) => {
    if (!q) return true;
    const h = holderOf(c) || {};
    return [c.id, c.holderId || c.holder_id, h.fullName || h.full_name, h.org, h.idRef || h.id_ref, c.eventName || c.event_name]
      .filter(Boolean).map(String).some((v) => v.toLowerCase().includes(q));
  };
  const filtered = cards.filter(matchCard);

  return (
    <div className="page">
      <h2>{t("issuer_title")} — {user?.orgName || user?.username}</h2>
      <ErrorBanner error={err} onRetry={load} />
      {hmsg && <p className="ok">{hmsg}</p>}

      <section>
        <h3>{t("register_holder")}</h3>
        <form className="grid" onSubmit={createHolder}>
          <label>{t("full_name")}<input name="holder-name" placeholder="e.g. A. Sharma…" value={hform.fullName} onChange={(e) => setHform({ ...hform, fullName: e.target.value })} required /></label>
          <label>{t("organisation")}<input name="holder-org" placeholder="e.g. City Times…" value={hform.org} onChange={(e) => setHform({ ...hform, org: e.target.value })} required /></label>
          <label>{t("designation")}<input name="holder-designation" placeholder="e.g. Staff photographer… (optional)" value={hform.designation} onChange={(e) => setHform({ ...hform, designation: e.target.value })} /></label>
          <label>{t("id_ref")}<input name="holder-idref" placeholder="e.g. Aadhaar / employee ID… (optional)" value={hform.idRef} onChange={(e) => setHform({ ...hform, idRef: e.target.value })} /></label>
          <label>{t("photo_hash")}<input name="holder-photohash" className="mono" placeholder="auto-filled after photo upload… (optional)" value={hform.photoHash} onChange={(e) => setHform({ ...hform, photoHash: e.target.value })} /></label>
          <button type="submit">{t("create_holder")}</button>
        </form>
      </section>

      <section>
        <h3>{cform.replacesId ? t("replace_card") : t("issue_card")}</h3>
        {cform.replacesId && (
          <p className="ok" role="status">
            {t("replacing_banner").replace("{id}", cform.replacesId)}{" "}
            <button type="button" className="small" onClick={cancelReplace}>{t("cancel_replace")}</button>
          </p>
        )}
        <form className="grid" onSubmit={issueCard}>
          <label>{t("holder_label")}<select name="card-holder" value={cform.holderId} onChange={(e) => setCform({ ...cform, holderId: e.target.value })} required disabled={!!cform.replacesId}>
            <option value="">{t("holder_pick")}</option>
            {holders.map((h) => <option key={h.id} value={h.id}>{h.fullName || h.full_name} ({h.org})</option>)}
          </select>{cform.replacesId && <span className="hint">{t("holder_locked")}</span>}</label>
          <label>{t("valid_days")}<input name="card-days" type="number" min={1} placeholder="e.g. 365…" value={cform.validDays} onChange={(e) => setCform({ ...cform, validDays: e.target.value })} /></label>
          <label>{t("zones")}<input name="card-zones" placeholder="e.g. north-delhi, central… (optional)" value={cform.zones} onChange={(e) => setCform({ ...cform, zones: e.target.value })} /></label>
          <label>{t("event_name")}<input name="card-event" placeholder="e.g. Protest X… (optional)" value={cform.eventName} onChange={(e) => setCform({ ...cform, eventName: e.target.value })} /></label>
          <label>{t("event_end")}<input name="card-event-end" type="datetime-local" value={cform.eventEnd} onChange={(e) => setCform({ ...cform, eventEnd: e.target.value })} /></label>
          <button type="submit">{cform.replacesId ? t("confirm_replace") : t("issue_card")}</button>
        </form>
      </section>

      {issued && (
        <section className="issue-result">
          <h3>{t("issued")}</h3>
          {(issued.card?.replacesId ?? issued.replacesId) && (
            <p className="hint" role="status">{t("replaced_link").replace("{id}", issued.card?.replacesId ?? issued.replacesId).replace("{new}", issued.card?.id ?? issued.id ?? "")}</p>
          )}
          <p className="mono token">{issued.token}</p>
          <PressCard card={issued.card || issued} holder={holderOf(issued.card || issued)} qr={issued.qrDataUrl || issued.qr_data_url} />
          <button onClick={() => window.print()}>{t("print_card")}</button>
        </section>
      )}

      <section>
        <h3>{t("holders_cards")} ({filtered.length} / {cards.length})</h3>
        <div className="row">
          <input placeholder={t("search_hint")} value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search holders and cards" />
          {query && <button type="button" className="small" onClick={() => setQuery("")}>{t("clear")}</button>}
        </div>
        {loading && <Loading label={t("loading_holders")} />}
        {!loading && (
        <div className="table-wrap"><table>
          <thead><tr><th>{t("th_id")}</th><th>{t("th_holder")}</th><th>{t("th_valid_till")}</th><th>{t("th_event")}</th><th>{t("th_status")}</th><th>{t("th_lineage")}</th><th></th></tr></thead>
          <tbody>
            {filtered.map((c) => {
              const st = cardStatus(c);
              const ev = c.eventName || c.event_name || "";
              const replaces = c.replacesId ?? c.replaces_id ?? null;
              const replacedBy = c.replacedBy ?? c.replaced_by ?? null;
              const terminal = st === "reported" || st === "revoked" || st === "expired";
              return (
                <tr key={c.id}>
                  <td className="mono">{String(c.id).slice(0, 10)}</td>
                  <td>{holderOf(c)?.fullName || holderOf(c)?.full_name || c.holderId || "—"}</td>
                  <td>{c.validTill || c.valid_till ? new Date(c.validTill || c.valid_till).toLocaleDateString() : "—"}</td>
                  <td>{ev ? <span className="note-chip">{ev}</span> : "—"}</td>
                  <td><span className={`badge badge-${st}`}>{st}</span></td>
                  <td>{replaces ? <span className="note-chip">{t("replaces_chip").replace("{id}", replaces)}</span>
                    : replacedBy ? <span className="note-chip">{t("replaced_by_chip").replace("{id}", replacedBy)}</span> : "—"}</td>
                  <td>
                    {terminal && !replacedBy && <button className="small" onClick={() => startReplace(c)}>{t("replace")}</button>}{" "}
                    {st !== "revoked" && st !== "reported" && (armedRevoke === c.id
                      ? <span className="row"><button type="button" className="small danger" onClick={() => revoke(c.id)} onBlur={() => setArmedRevoke(null)}>{t("confirm_revoke_armed").replace("{id}", String(c.id).slice(0, 10))}</button><button type="button" className="small" onClick={() => setArmedRevoke(null)}>{t("cancel")}</button></span>
                      : <button className="small danger" onClick={() => setArmedRevoke(c.id)}>{t("revoke")}</button>)}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && <EmptyRow text={q ? `No holders or cards match "${query}".` : t("empty_cards")} colSpan={7} />}
          </tbody>
        </table></div>
        )}
      </section>
      <section>
        <h3>{t("holder_photos")}</h3>
        <p className="hint">{t("photo_hint")}</p>
        <div className="table-wrap"><table>
          <thead><tr><th>{t("th_holder")}</th><th>{t("th_photo")}</th><th></th></tr></thead>
          <tbody>
            {holders.map((h) => (
              <tr key={h.id}>
                <td>{h.fullName || h.full_name || h.id}</td>
                <td className="mono">{h.photoHash || h.photo_hash ? String(h.photoHash || h.photo_hash).slice(0, 12) : (photoMsg[h.id] || "—")}{photoMsg[h.id] && (h.photoHash || h.photo_hash) ? ` · ${photoMsg[h.id]}` : ""}</td>
                <td>
                  <input type="file" accept="image/jpeg,image/png" aria-label={`${t("upload_photo")} — ${h.fullName || h.id}`} onChange={(e) => { uploadPhoto(h.id, e.target.files?.[0]); e.target.value = ""; }} disabled={!!photoBusy[h.id]} />
                  {photoBusy[h.id] && <span className="muted"> Uploading…</span>}
                </td>
              </tr>
            ))}
            {holders.length === 0 && <EmptyRow text={t("empty_holders")} colSpan={3} />}
          </tbody>
        </table></div>
      </section>
    </div>
  );
}
