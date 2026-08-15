const crypto = require('crypto');

const ROUTE_STATES = new Set(['active', 'paused', 'retired']);
const DEVICE_STATES = new Set(['active', 'revoked', 'pending_rebind']);

function normalizeSlug(value) {
  const slug = String(value || '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,39}$/.test(slug)) throw new Error('INVALID_ROUTE_SLUG');
  return slug;
}

function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('base64url');
}

function tokenHash(value, pepper) {
  return crypto.createHmac('sha256', pepper).update(String(value || '')).digest('hex');
}

function safeEqualHex(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left || '') || !/^[a-f0-9]{64}$/i.test(right || '')) return false;
  return crypto.timingSafeEqual(Buffer.from(left, 'hex'), Buffer.from(right, 'hex'));
}

class PixRouteRegistry {
  constructor(options = {}) {
    if (!options.pepper || String(options.pepper).length < 32) throw new Error('ROUTE_PEPPER_REQUIRED');
    this.pepper = String(options.pepper);
    this.now = options.now || (() => Date.now());
    this.routes = new Map();
    this.enrollments = new Map();
    this.devices = new Map();
    this.events = new Map();
    this.audit = [];
  }

  createRoute({ slug, publicName, destinationRef, legacyAlias = null }) {
    slug = normalizeSlug(slug);
    if (this.routes.has(slug)) throw new Error('ROUTE_ALREADY_EXISTS');
    if (!String(publicName || '').trim()) throw new Error('INVALID_PUBLIC_NAME');
    if (!String(destinationRef || '').trim()) throw new Error('DESTINATION_REQUIRED');
    const route = {
      id: crypto.randomUUID(), slug, publicName: String(publicName).trim(),
      destinationRef: String(destinationRef).trim(), legacyAlias, state: 'active',
      createdAt: new Date(this.now()).toISOString()
    };
    this.routes.set(slug, route);
    this.record('route.created', 'route', route.id);
    return { ...route, destinationRef: undefined };
  }

  setRouteState(slug, state) {
    slug = normalizeSlug(slug);
    if (!ROUTE_STATES.has(state)) throw new Error('INVALID_ROUTE_STATE');
    const route = this.routes.get(slug);
    if (!route) throw new Error('ROUTE_NOT_FOUND');
    route.state = state;
    this.record(`route.${state}`, 'route', route.id);
    return { id: route.id, slug, state };
  }

  setRouteDestination(slug, destinationRef) {
    slug = normalizeSlug(slug);
    if (!String(destinationRef || '').trim()) throw new Error('DESTINATION_REQUIRED');
    const route = this.routes.get(slug);
    if (!route) throw new Error('ROUTE_NOT_FOUND');
    route.destinationRef = String(destinationRef).trim();
    this.record('route.destination_updated', 'route', route.id);
    return { id: route.id, slug };
  }

  issueEnrollment(slug, { ttlMs = 15 * 60_000, maxUses = 1 } = {}) {
    const route = this.routes.get(normalizeSlug(slug));
    if (!route || route.state !== 'active') throw new Error('ROUTE_NOT_ACTIVE');
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60_000) throw new Error('INVALID_TTL');
    if (!Number.isSafeInteger(maxUses) || maxUses < 1 || maxUses > 10) throw new Error('INVALID_MAX_USES');
    const id = crypto.randomUUID();
    const code = randomToken(24);
    this.enrollments.set(id, {
      id, routeId: route.id, codeHash: tokenHash(code, this.pepper), maxUses, used: 0,
      expiresAt: this.now() + ttlMs, state: 'active'
    });
    this.record('enrollment.created', 'enrollment', id);
    return { id, code, expiresAt: new Date(this.now() + ttlMs).toISOString(), maxUses };
  }

  enrollDevice({ code, installationId, appVersion }) {
    const wanted = tokenHash(code, this.pepper);
    const enrollment = [...this.enrollments.values()].find(item => safeEqualHex(item.codeHash, wanted));
    if (!enrollment || enrollment.state !== 'active') throw new Error('ENROLLMENT_INVALID');
    if (this.now() >= enrollment.expiresAt) { enrollment.state = 'expired'; throw new Error('ENROLLMENT_EXPIRED'); }
    if (enrollment.used >= enrollment.maxUses) { enrollment.state = 'consumed'; throw new Error('ENROLLMENT_LIMIT_REACHED'); }
    const route = [...this.routes.values()].find(item => item.id === enrollment.routeId);
    if (!route || route.state !== 'active') throw new Error('ROUTE_NOT_ACTIVE');
    const id = crypto.randomUUID();
    const secret = randomToken(32);
    this.devices.set(id, {
      id, routeId: route.id, installationHash: tokenHash(installationId, this.pepper),
      credentialHash: tokenHash(secret, this.pepper), state: 'active', appVersion: String(appVersion || ''),
      createdAt: new Date(this.now()).toISOString()
    });
    enrollment.used += 1;
    if (enrollment.used >= enrollment.maxUses) enrollment.state = 'consumed';
    this.record('device.enrolled', 'device', id);
    return { deviceId: id, credential: `${id}.${secret}`, routeId: route.id, publicRouteName: route.publicName };
  }

  authenticateDevice(credential) {
    const [id, secret, extra] = String(credential || '').split('.');
    if (!id || !secret || extra) throw new Error('DEVICE_UNAUTHORIZED');
    const device = this.devices.get(id);
    const supplied = tokenHash(secret, this.pepper);
    if (!device || device.state !== 'active' || !safeEqualHex(device.credentialHash, supplied)) throw new Error('DEVICE_UNAUTHORIZED');
    return device;
  }

  acceptEvent({ credential, eventId, payload }) {
    const device = this.authenticateDevice(credential);
    const route = [...this.routes.values()].find(item => item.id === device.routeId);
    if (!route || route.state !== 'active') throw new Error('ROUTE_PAUSED');
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(String(eventId || ''))) throw new Error('INVALID_EVENT_ID');
    const key = `${device.id}:${eventId}`;
    if (this.events.has(key)) return { ...this.events.get(key), duplicate: true };
    const event = {
      id: crypto.randomUUID(), eventId, deviceId: device.id, routeId: route.id,
      destinationRef: route.destinationRef, payload, acceptedAt: new Date(this.now()).toISOString(),
      delivered: false, deliveredAt: null, duplicate: false
    };
    this.events.set(key, event);
    this.record('event.accepted', 'event', event.id);
    return event;
  }

  markDelivered(eventId) {
    const event = [...this.events.values()].find(item => item.id === eventId);
    if (!event) throw new Error('EVENT_NOT_FOUND');
    event.delivered = true;
    event.deliveredAt = new Date(this.now()).toISOString();
    this.record('event.delivered', 'event', event.id);
    return event;
  }

  revokeDevice(id) {
    const device = this.devices.get(id);
    if (!device || !DEVICE_STATES.has(device.state)) throw new Error('DEVICE_NOT_FOUND');
    device.state = 'revoked';
    this.record('device.revoked', 'device', id);
  }

  record(action, entityType, entityId) {
    this.audit.unshift({ action, entityType, entityId, at: new Date(this.now()).toISOString() });
  }
}

module.exports = { PixRouteRegistry, normalizeSlug, tokenHash };
