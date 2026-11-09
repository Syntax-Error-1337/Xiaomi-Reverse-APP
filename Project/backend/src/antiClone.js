'use strict';

function haversineKm(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// reason checks: status/expiry/revocation
function statusReasons(cardRow, nowMs) {
  const reasons = [];
  if (!cardRow) {
    reasons.push('CARD_NOT_FOUND');
    return reasons;
  }
  if (cardRow.status === 'revoked') reasons.push('REVOKED');
  else if (cardRow.status === 'reported') reasons.push('CARD_REPORTED');
  else if (cardRow.status === 'expired') reasons.push('STATUS_EXPIRED');
  else if (cardRow.status !== 'active') reasons.push('STATUS_' + String(cardRow.status).toUpperCase());
  // date-expiry on any status (incl. active) → STATUS_EXPIRED; Set dedups the status==='expired' case
  if (new Date(cardRow.valid_till).getTime() <= nowMs) reasons.push('STATUS_EXPIRED');
  return [...new Set(reasons)];
}

// flags from last 20 scans (including the just-logged one)
function cloneFlags(scans) {
  const flags = [];
  const geo = scans.filter((s) => typeof s.lat === 'number' && typeof s.lng === 'number' && s.at);
  // consecutive pairs by time
  const sorted = [...geo].sort((a, b) => new Date(a.at) - new Date(b.at));
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    const dtH = (new Date(b.at) - new Date(a.at)) / 3600000;
    const d = haversineKm(a.lat, a.lng, b.lat, b.lng);
    if (dtH > 0 && d / dtH > 500) {
      flags.push('IMPOSSIBLE_TRAVEL');
      break;
    }
  }
  // SIMULTANEOUS_FAR: any pair within 10 min, >50km
  outer: for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      const dtMin = Math.abs(new Date(sorted[j].at) - new Date(sorted[i].at)) / 60000;
      if (dtMin <= 10) {
        const d = haversineKm(sorted[i].lat, sorted[i].lng, sorted[j].lat, sorted[j].lng);
        if (d > 50) {
          flags.push('SIMULTANEOUS_FAR');
          break outer;
        }
      }
    }
  }
  // VELOCITY_BURST: >10 scans in 30 min
  const times = scans.map((s) => new Date(s.at).getTime()).sort((a, b) => a - b);
  for (let i = 0; i < times.length; i++) {
    let count = 0;
    for (let j = i; j < times.length; j++) {
      if (times[j] - times[i] <= 30 * 60000) count++;
      else break;
    }
    if (count > 10) {
      flags.push('VELOCITY_BURST');
      break;
    }
  }
  return flags;
}

module.exports = { haversineKm, statusReasons, cloneFlags };
