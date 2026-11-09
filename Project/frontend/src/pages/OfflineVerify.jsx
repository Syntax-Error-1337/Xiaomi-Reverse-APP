import { useState } from "react";
import { extractJwk, verifySignature } from "../offlineCrypto";

const STORE_KEY = "pressid-bundle";

export default function OfflineVerify() {
  const [bundleInfo, setBundleInfo] = useState(() => {
    try {
      const raw = localStorage.getItem(STORE_KEY);
      if (!raw) return null;
      const b = JSON.parse(raw);
      const jwk = extractJwk(b);
      if (!jwk) return null;
      return { kid: b.kid || b.currentKid || "", hasKey: true };
    } catch {
      return null;
    }
  });
  const [bundleErr, setBundleErr] = useState("");
  const [token, setToken] = useState("");
  const [result, setResult] = useState(null);
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  const onBundleFile = async (e) => {
    setBundleErr("");
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    try {
      const text = await f.text();
      const b = JSON.parse(text);
      const jwk = extractJwk(b);
      if (!jwk || jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) {
        throw new Error("bad-bundle");
      }
      localStorage.setItem(STORE_KEY, JSON.stringify(b));
      setBundleInfo({ kid: b.kid || b.currentKid || "", hasKey: true });
    } catch {
      setBundleErr(
        "That file is not a valid verify bundle. Download bundle.json from the admin key panel while online, then upload it here."
      );
    }
    e.target.value = "";
  };

  const clearBundle = () => {
    localStorage.removeItem(STORE_KEY);
    setBundleInfo(null);
    setResult(null);
  };

  const verify = async () => {
    setErr("");
    setResult(null);
    const t = token.trim();
    if (!t) {
      setErr("Paste a token first (format P1.<payload>.<signature>).");
      return;
    }
    let raw;
    try {
      raw = localStorage.getItem(STORE_KEY);
      if (!raw) throw new Error("no-bundle");
    } catch {
      setErr("No verify bundle cached. Upload bundle.json first (ask an admin to download it while online).");
      return;
    }
    let jwk;
    try {
      jwk = extractJwk(JSON.parse(raw));
      if (!jwk || !jwk.x) throw new Error("bad-bundle");
    } catch {
      setErr("Cached bundle is corrupt. Re-upload bundle.json.");
      return;
    }
    setBusy(true);
    try {
      const r = await verifySignature(t, jwk);
      setResult(r);
    } catch (e) {
      setErr(e.message || "Verification failed.");
    } finally {
      setBusy(false);
    }
  };

  // Gate payload rows on a verified signature (iteration Q): a forged QR
  // must never render attacker-controlled name/org as a credential table.
  const rows = result && result.ok && result.payload ? Object.entries(result.payload) : [];

  return (
    <div className="center-wrap">
      <div className="login-card" style={{ maxWidth: "640px" }}>
        <h1>Offline verify</h1>
        <p className="muted">
          Works in airplane mode once a verify bundle is cached. Checks the Ed25519 signature only.
        </p>

        <h2>1. Verify bundle</h2>
        {bundleInfo ? (
          <p>
            <span className="badge badge-ok">bundle cached</span>
            {bundleInfo.kid && <span className="muted"> · kid {String(bundleInfo.kid).slice(0, 12)}</span>}{" "}
            <button type="button" className="small ghost" onClick={clearBundle}>Replace</button>
          </p>
        ) : (
          <p className="muted">No bundle cached yet.</p>
        )}
        <label htmlFor="offline-bundle">Upload bundle.json</label>
        <input id="offline-bundle" type="file" accept="application/json,.json" onChange={onBundleFile} />
        {bundleErr && <p className="error" role="alert">{bundleErr}</p>}

        <h2 style={{ marginTop: "1rem" }}>2. Paste token</h2>
        <label htmlFor="offline-token">Card token</label>
        <textarea
          id="offline-token"
          rows={4}
          className="mono"
          style={{ width: "100%" }}
          placeholder="P1.eyJ2IjoxLC…"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          spellCheck={false}
        />
        <div className="row" style={{ marginTop: ".5rem" }}>
          <button type="button" onClick={verify} disabled={busy || !bundleInfo}>
            {busy ? "Verifying…" : "Verify signature"}
          </button>
        </div>
        {err && <p className="error" role="alert">{err}</p>}

        {result && (
          <div style={{ marginTop: "1rem" }} role="status">
            {result.ok
              ? <p className="ok">OK — signature valid.</p>
              : <p className="error">FAIL — signature invalid. Token is forged or damaged.</p>}
            {rows.length > 0 && (
              <table>
                <tbody>
                  {rows.map(([k, v]) => (
                    <tr key={k}><th scope="row">{k}</th><td className="mono">{String(v)}</td></tr>
                  ))}
                </tbody>
              </table>
            )}
            <p className="error" style={{ marginTop: ".75rem" }}>
              Warning: signature only — confirm revocation and expiry online before trusting this card.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
