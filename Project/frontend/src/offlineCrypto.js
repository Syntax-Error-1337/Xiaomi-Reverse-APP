export function b64uDecode(s) {
  const b64 = String(s || "").replace(/-/g, "+").replace(/_/g, "/");
  const pad = b64.length % 4 === 2 ? "==" : b64.length % 4 === 3 ? "=" : "";
  const bin = atob(b64 + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export function extractJwk(bundle) {
  if (!bundle || typeof bundle !== "object") return null;
  return (
    bundle.publicKeyJwk ||
    bundle.publicKey ||
    bundle.jwk ||
    (bundle.keyInfo && (bundle.keyInfo.publicKeyJwk || bundle.keyInfo.publicKey)) ||
    null
  );
}

export function readCachedBundle(storeKey = "pressid-bundle") {
  try {
    const raw = localStorage.getItem(storeKey);
    if (!raw) return { bundle: null, jwk: null, error: "no-bundle" };
    const bundle = JSON.parse(raw);
    const jwk = extractJwk(bundle);
    if (!jwk || !jwk.x) return { bundle, jwk: null, error: "bad-bundle" };
    return { bundle, jwk, error: "" };
  } catch {
    return { bundle: null, jwk: null, error: "bad-bundle" };
  }
}

// Shared offline crypto path: verify a P1.<payload>.<sig> token against a JWK.
// Throws Error with plain message on failure; resolves { ok, payload }.
export async function verifySignature(token, jwk) {
  const t = String(token || "").trim();
  const parts = t.split(".");
  if (parts.length !== 3 || parts[0] !== "P1") {
    throw new Error("Invalid token format. Expected P1.<base64url-payload>.<base64url-signature>.");
  }
  let payloadBytes;
  let sigBytes;
  try {
    payloadBytes = b64uDecode(parts[1]);
    sigBytes = b64uDecode(parts[2]);
  } catch {
    throw new Error("Token contains malformed base64url. Copy the full token from the QR card.");
  }
  let key;
  try {
    key = await crypto.subtle.importKey("jwk", jwk, { name: "Ed25519" }, false, ["verify"]);
  } catch {
    throw new Error("This browser cannot verify Ed25519 (needs a modern Chromium/Safari with WebCrypto Ed25519).");
  }
  const ok = await crypto.subtle.verify({ name: "Ed25519" }, key, sigBytes, payloadBytes);
  let payload = null;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch {
    throw new Error("Signature block decoded but payload is not valid JSON — token is damaged.");
  }
  return { ok, payload };
}
