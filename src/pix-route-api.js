const crypto = require('crypto');
const express = require('express');

function bearer(req) {
  const match = String(req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return match ? match[1] : '';
}

function deviceCredential(req) {
  const match = String(req.headers.authorization || '').match(/^Device\s+(.+)$/i);
  return match ? match[1] : '';
}

function safeTokenEqual(left, right) {
  const a = crypto.createHash('sha256').update(String(left || '')).digest();
  const b = crypto.createHash('sha256').update(String(right || '')).digest();
  return crypto.timingSafeEqual(a, b) && Boolean(left) && Boolean(right);
}

function verifyPassword(password, encoded) {
  const parts = String(encoded || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2-sha256') return false;
  const iterations = Number(parts[1]);
  if (!Number.isSafeInteger(iterations) || iterations < 100000 || iterations > 2000000) return false;
  try {
    const expected = Buffer.from(parts[3], 'hex');
    const actual = crypto.pbkdf2Sync(String(password || ''), Buffer.from(parts[2], 'hex'), iterations, expected.length, 'sha256');
    return expected.length >= 32 && crypto.timingSafeEqual(actual, expected);
  } catch (_) { return false; }
}

function sessionToken(username, secret, now = Date.now(), ttlMs = 8 * 60 * 60_000) {
  const payload = Buffer.from(JSON.stringify({ sub: username, exp: now + ttlMs })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifySession(token, secret, now = Date.now()) {
  const [payload, signature, extra] = String(token || '').split('.');
  if (!payload || !signature || extra) return false;
  const wanted = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  if (!safeTokenEqual(signature, wanted)) return false;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    return typeof data.sub === 'string' && Number.isFinite(data.exp) && now < data.exp;
  } catch (_) { return false; }
}

function errorStatus(code) {
  if (/UNAUTHORIZED/.test(code)) return 401;
  if (/NOT_FOUND/.test(code)) return 404;
  if (/ALREADY_EXISTS|DUPLICATE/.test(code)) return 409;
  if (/PAUSED|NOT_ACTIVE|REVOKED/.test(code)) return 423;
  if (/ENROLLMENT/.test(code)) return 400;
  return 400;
}

function sanitizePayload(body) {
  const eventId = String(body?.eventId || body?.id || '').trim();
  const titulo = String(body?.titulo || body?.title || '').trim().slice(0, 160);
  const texto = String(body?.texto || body?.message || '').trim().slice(0, 2000);
  if (!titulo && !texto) throw new Error('EMPTY_EVENT');
  return { eventId, payload: { titulo, texto } };
}

function createRateLimiter({ windowMs = 60_000, max = 60, now = () => Date.now() } = {}) {
  const buckets = new Map();
  return function rateLimit(key) {
    const bucketKey = String(key || 'unknown');
    const current = now();
    let bucket = buckets.get(bucketKey);
    if (!bucket || current >= bucket.resetAt) {
      bucket = { count: 0, resetAt: current + windowMs };
      buckets.set(bucketKey, bucket);
    }
    bucket.count += 1;
    return {
      allowed: bucket.count <= max,
      remaining: Math.max(0, max - bucket.count),
      retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - current) / 1000))
    };
  };
}

function createPixRouteRouter({ registry, adminToken, adminUsername, adminPasswordHash, sessionSecret, deliver }) {
  if (!registry) throw new Error('ROUTE_REGISTRY_REQUIRED');
  if (!adminToken || String(adminToken).length < 32) throw new Error('ADMIN_TOKEN_REQUIRED');
  if (typeof deliver !== 'function') throw new Error('DELIVERY_ADAPTER_REQUIRED');
  const router = express.Router();
  const adminLimit = createRateLimiter({ max: 30 });
  const enrollmentLimit = createRateLimiter({ max: 10 });
  const eventLimit = createRateLimiter({ max: 120 });
  const loginLimit = createRateLimiter({ max: 5, windowMs: 15 * 60_000 });

  function limited(check, key, res) {
    const result = check(key);
    res.set('X-RateLimit-Remaining', String(result.remaining));
    if (result.allowed) return false;
    res.set('Retry-After', String(result.retryAfterSeconds));
    res.status(429).json({ ok: false, code: 'RATE_LIMITED' });
    return true;
  }

  function admin(req, res, next) {
    if (limited(adminLimit, req.ip, res)) return;
    const supplied = bearer(req);
    if (!safeTokenEqual(supplied, adminToken) && !verifySession(supplied, sessionSecret)) {
      return res.status(401).json({ ok: false, code: 'ADMIN_UNAUTHORIZED' });
    }
    next();
  }

  router.post('/admin-sessions', (req, res) => {
    if (limited(loginLimit, req.ip, res)) return;
    const validConfig = String(adminUsername || '').length > 0
      && String(adminPasswordHash || '').length > 0 && String(sessionSecret || '').length >= 32;
    const validUser = safeTokenEqual(String(req.body?.username || ''), String(adminUsername || ''));
    if (!validConfig || !validUser || !verifyPassword(req.body?.password, adminPasswordHash)) {
      return res.status(401).json({ ok: false, code: 'ADMIN_LOGIN_INVALID' });
    }
    res.status(201).json({ ok: true, session: {
      token: sessionToken(adminUsername, sessionSecret), expiresInSeconds: 8 * 60 * 60
    }});
  });

  router.post('/admin/routes', admin, async (req, res) => {
    try {
      const route = await registry.createRoute(req.body || {});
      res.status(201).json({ ok: true, route });
    } catch (error) {
      res.status(errorStatus(error.message)).json({ ok: false, code: error.message });
    }
  });

  router.patch('/admin/routes/:slug/state', admin, async (req, res) => {
    try {
      const route = await registry.setRouteState(req.params.slug, String(req.body?.state || ''));
      res.json({ ok: true, route });
    } catch (error) {
      res.status(errorStatus(error.message)).json({ ok: false, code: error.message });
    }
  });

  router.post('/admin/routes/:slug/enrollment-codes', admin, async (req, res) => {
    try {
      const enrollment = await registry.issueEnrollment(req.params.slug, req.body || {});
      res.status(201).json({ ok: true, enrollment });
    } catch (error) {
      res.status(errorStatus(error.message)).json({ ok: false, code: error.message });
    }
  });

  router.post('/admin/devices/:id/revoke', admin, async (req, res) => {
    try {
      await registry.revokeDevice(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      res.status(errorStatus(error.message)).json({ ok: false, code: error.message });
    }
  });

  router.post('/device-enrollments', async (req, res) => {
    if (limited(enrollmentLimit, req.ip, res)) return;
    try {
      const device = await registry.enrollDevice({
        code: req.body?.enrollmentCode,
        installationId: req.body?.installationId,
        appVersion: req.body?.appVersion
      });
      res.status(201).json({ ok: true, device });
    } catch (error) {
      res.status(errorStatus(error.message)).json({ ok: false, code: error.message });
    }
  });

  router.get('/device-status', async (req, res) => {
    try {
      const device = await registry.authenticateDevice(deviceCredential(req));
      res.json({ ok: true, device: { id: device.id, state: device.state, appVersion: device.appVersion } });
    } catch (error) {
      res.status(401).json({ ok: false, code: 'DEVICE_UNAUTHORIZED' });
    }
  });

  router.post('/pix-events', async (req, res) => {
    const credential = deviceCredential(req);
    if (limited(eventLimit, `${req.ip}:${credential.slice(0, 48)}`, res)) return;
    try {
      const input = sanitizePayload(req.body);
      const event = await registry.acceptEvent({
        credential, eventId: input.eventId, payload: input.payload
      });
      if (!event.delivered) {
        await deliver(event);
        await registry.markDelivered(event.id);
      }
      res.status(event.duplicate ? 200 : 202).json({
        ok: true, eventId: event.eventId, duplicate: event.duplicate,
        deliveryStatus: 'delivered'
      });
    } catch (error) {
      const code = String(error.message || 'INTERNAL_ERROR');
      const status = code === 'DELIVERY_UNAVAILABLE' ? 503 : errorStatus(code);
      res.status(status).json({ ok: false, code });
    }
  });

  return router;
}

module.exports = { createPixRouteRouter, safeTokenEqual, sanitizePayload, createRateLimiter,
  verifyPassword, sessionToken, verifySession };
