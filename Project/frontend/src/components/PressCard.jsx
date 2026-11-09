export default function PressCard({ card, holder, qr, id = "print-card" }) {
  const h = holder || card?.holder || {};
  const name = h.fullName || h.full_name || card?.holder?.fullName || card?.fullName || card?.full_name || "—";
  const org = h.org || card?.holder?.org || card?.org || "—";
  const role = h.designation || card?.holder?.designation || card?.designation || "—";
  const validTill = card?.validTill || card?.valid_till || card?.expiresAt || "";
  const eventName = card?.eventName || card?.event_name || "";
  const eventEnd = card?.eventEnd || card?.event_end || "";
  return (
    <div className="presscard" id={id}>
      <div className="pc-head">
        <span className="pc-emblem">◈</span>
        <div>
          <div className="pc-title">PRESS</div>
          <div className="pc-sub">Official Credential · PressID Registry</div>
        </div>
      </div>
      <div className="pc-body">
        <div className="pc-photo">{h.photoHash ? "◉" : "✎"}</div>
        <div className="pc-fields">
          <div className="pc-name">{name}</div>
          <div className="pc-row"><span>Org</span><b>{org}</b></div>
          <div className="pc-row"><span>Role</span><b>{role}</b></div>
          <div className="pc-row"><span>Card&nbsp;ID</span><b className="mono">{String(card?.id ?? "").slice(0, 12) || "—"}</b></div>
          <div className="pc-row"><span>Valid till</span><b>{validTill ? new Date(validTill).toLocaleDateString() : "—"}</b></div>
          {eventName && <div className="pc-row"><span>Event</span><b>{eventName}{eventEnd ? ` · till ${new Date(eventEnd).toLocaleDateString()}` : ""}</b></div>}
        </div>
        {qr && <img className="pc-qr" src={qr} alt="credential QR" />}
      </div>
      <div className="pc-foot">
        <span>Verify at PressID checkpoint</span>
        <span className="pc-stripe" />
      </div>
    </div>
  );
}
