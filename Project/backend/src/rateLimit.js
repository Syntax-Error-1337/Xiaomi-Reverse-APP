'use strict';
// Sliding-window in-memory rate limiter factory (no deps).
//
// makeLimiter({ windowMs, max, key }) -> Express middleware.
// - `key(req)` selects the bucket (caller passes user.id + route group).
// - Hits stored in a Map as arrays of timestamps; pruned on each access.
// - On exceed: 429 { error } + Retry-After header (seconds until window slides).
function makeLimiter({ windowMs = 60000, max = 120, key } = {}) {
  const hits = new Map();
  const mw = (req, res, next) => {
    let k;
    try {
      k = key ? key(req) : `${(req.user && req.user.id) || req.ip || 'anon'}`;
    } catch (_) {
      k = 'anon';
    }
    const t = Date.now();
    let arr = hits.get(k);
    if (!arr) { arr = []; hits.set(k, arr); }
    while (arr.length && t - arr[0] >= windowMs) arr.shift();
    if (arr.length >= max) {
      const retryAfter = Math.max(1, Math.ceil((arr[0] + windowMs - t) / 1000));
      res.set('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'Too many requests' });
    }
    arr.push(t);
    next();
  };
  mw.reset = () => hits.clear();
  return mw;
}

module.exports = { makeLimiter };
