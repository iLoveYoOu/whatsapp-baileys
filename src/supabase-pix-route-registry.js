const crypto = require('crypto');
const axios = require('axios');
const { normalizeSlug, tokenHash } = require('./pix-route-registry');

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function encryptionKey(value) {
  const raw = String(value || '');
  if (!raw) throw new Error('DESTINATION_KEY_REQUIRED');
  try {
    const decoded = Buffer.from(raw, 'base64');
    if (decoded.length === 32) return decoded;
  } catch (_) {}
  if (/^[a-f0-9]{64}$/i.test(raw)) return Buffer.from(raw, 'hex');
  throw new Error('DESTINATION_KEY_INVALID');
}

function encryptDestination(destination, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(String(destination), 'utf8'), cipher.final()]);
  return { ciphertext: `\\x${ciphertext.toString('hex')}`, iv: `\\x${iv.toString('hex')}`, tag: `\\x${cipher.getAuthTag().toString('hex')}` };
}

function bytea(value) {
  const raw = String(value || '');
  if (!/^\\x[0-9a-f]*$/i.test(raw)) throw new Error('DESTINATION_DATA_INVALID');
  return Buffer.from(raw.slice(2), 'hex');
}

function decryptDestination(row, key) {
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, bytea(row.destination_iv));
  decipher.setAuthTag(bytea(row.destination_tag));
  return Buffer.concat([
    decipher.update(bytea(row.destination_ciphertext)),
    decipher.final()
  ]).toString('utf8');
}

class SupabasePixRouteRegistry {
  constructor({ url, serviceRoleKey, pepper, destinationKey, http } = {}) {
    if (!/^https:\/\/.+/.test(String(url || ''))) throw new Error('SUPABASE_URL_REQUIRED');
    if (!serviceRoleKey) throw new Error('SUPABASE_SERVICE_ROLE_REQUIRED');
    if (!pepper || String(pepper).length < 32) throw new Error('ROUTE_PEPPER_REQUIRED');
    this.pepper = String(pepper);
    this.key = encryptionKey(destinationKey);
    this.http = http || axios.create({
      baseURL: `${String(url).replace(/\/$/, '')}/rest/v1`, timeout: 15000,
      headers: { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}`, 'Content-Type': 'application/json' }
    });
  }

  async rows(path, options = {}) {
    try { return (await this.http.request({ url: path, ...options })).data; }
    catch (error) {
      const code = error.response?.data?.code;
      if (code === '23505') throw new Error('ROUTE_ALREADY_EXISTS');
      throw new Error('PERSISTENCE_UNAVAILABLE');
    }
  }

  async createRoute({ slug, publicName, destinationRef, legacyAlias = null }) {
    slug = normalizeSlug(slug);
    if (!String(publicName || '').trim()) throw new Error('INVALID_PUBLIC_NAME');
    if (!String(destinationRef || '').trim()) throw new Error('DESTINATION_REQUIRED');
    const encrypted = encryptDestination(destinationRef, this.key);
    const [route] = await this.rows('/artauto_pix_routes', {
      method: 'post', headers: { Prefer: 'return=representation' }, data: {
        slug, public_name: String(publicName).trim(), legacy_alias: legacyAlias,
        destination_ciphertext: encrypted.ciphertext, destination_iv: encrypted.iv,
        destination_tag: encrypted.tag
      }
    });
    return { id: route.id, slug: route.slug, publicName: route.public_name, state: route.status, createdAt: route.created_at };
  }

  async setRouteState(slug, state) {
    slug = normalizeSlug(slug);
    if (!['active', 'paused', 'retired'].includes(state)) throw new Error('INVALID_ROUTE_STATE');
    const rows = await this.rows(`/artauto_pix_routes?slug=eq.${encodeURIComponent(slug)}`, {
      method: 'patch', headers: { Prefer: 'return=representation' }, data: { status: state, updated_at: new Date().toISOString() }
    });
    if (!rows.length) throw new Error('ROUTE_NOT_FOUND');
    return { id: rows[0].id, slug, state };
  }

  async setRouteDestination(slug, destinationRef) {
    slug = normalizeSlug(slug);
    if (!String(destinationRef || '').trim()) throw new Error('DESTINATION_REQUIRED');
    const encrypted = encryptDestination(destinationRef, this.key);
    const rows = await this.rows(`/artauto_pix_routes?slug=eq.${encodeURIComponent(slug)}`, {
      method: 'patch', headers: { Prefer: 'return=representation' }, data: {
        destination_ciphertext: encrypted.ciphertext, destination_iv: encrypted.iv,
        destination_tag: encrypted.tag, updated_at: new Date().toISOString()
      }
    });
    if (!rows.length) throw new Error('ROUTE_NOT_FOUND');
    return { id: rows[0].id, slug };
  }

  async issueEnrollment(slug, { ttlMs = 15 * 60_000, maxUses = 1 } = {}) {
    slug = normalizeSlug(slug);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 86_400_000) throw new Error('INVALID_TTL');
    if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 10) throw new Error('INVALID_MAX_USES');
    const routes = await this.rows(`/artauto_pix_routes?slug=eq.${encodeURIComponent(slug)}&status=eq.active&select=id`);
    if (!routes.length) throw new Error('ROUTE_NOT_ACTIVE');
    const code = randomToken(24);
    const expiresAt = new Date(Date.now() + ttlMs).toISOString();
    const [item] = await this.rows('/artauto_pix_enrollment_codes', {
      method: 'post', headers: { Prefer: 'return=representation' },
      data: { route_id: routes[0].id, code_hash: tokenHash(code, this.pepper), max_uses: maxUses, expires_at: expiresAt }
    });
    return { id: item.id, code, expiresAt, maxUses };
  }

  async enrollDevice({ code, installationId, appVersion }) {
    const secret = randomToken(32);
    const data = await this.rows('/rpc/artauto_pix_enroll_device', { method: 'post', data: {
      p_code_hash: tokenHash(code, this.pepper), p_installation_hash: tokenHash(installationId, this.pepper),
      p_credential_hash: tokenHash(secret, this.pepper), p_credential_hint: secret.slice(-6), p_app_version: String(appVersion || '')
    }});
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('ENROLLMENT_INVALID');
    return { deviceId: row.device_id, credential: `${row.device_id}.${secret}`, routeId: row.route_id, publicRouteName: row.public_route_name };
  }

  async authenticateDevice(credential) {
    const [id, secret, extra] = String(credential || '').split('.');
    if (!id || !secret || extra) throw new Error('DEVICE_UNAUTHORIZED');
    const rows = await this.rows(`/artauto_pix_devices?id=eq.${encodeURIComponent(id)}&status=eq.active&credential_hash=eq.${tokenHash(secret, this.pepper)}&select=id,route_id,status,app_version`);
    if (!rows.length) throw new Error('DEVICE_UNAUTHORIZED');
    return { id: rows[0].id, routeId: rows[0].route_id, state: rows[0].status, appVersion: rows[0].app_version };
  }

  async acceptEvent({ credential, eventId, payload }) {
    const device = await this.authenticateDevice(credential);
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(eventId || ''))) throw new Error('INVALID_EVENT_ID');
    const data = await this.rows('/rpc/artauto_pix_accept_event', { method: 'post', data: {
      p_device_id: device.id, p_external_event_id: eventId, p_safe_payload: payload
    }});
    const row = Array.isArray(data) ? data[0] : data;
    if (!row) throw new Error('ROUTE_PAUSED');
    return { id: row.event_id, eventId, deviceId: device.id, routeId: row.route_id,
      destinationRef: decryptDestination(row, this.key), payload, delivered: row.status === 'delivered',
      deliveredAt: row.delivered_at, duplicate: row.duplicate };
  }

  async markDelivered(eventId) {
    await this.rows(`/artauto_pix_events?id=eq.${encodeURIComponent(eventId)}`, {
      method: 'patch', headers: { Prefer: 'return=minimal' }, data: { status: 'delivered', delivered_at: new Date().toISOString() }
    });
  }

  async revokeDevice(id) {
    const rows = await this.rows(`/artauto_pix_devices?id=eq.${encodeURIComponent(id)}`, {
      method: 'patch', headers: { Prefer: 'return=representation' }, data: { status: 'revoked', revoked_at: new Date().toISOString() }
    });
    if (!rows.length) throw new Error('DEVICE_NOT_FOUND');
  }
}

module.exports = { SupabasePixRouteRegistry, encryptionKey, encryptDestination, decryptDestination };
