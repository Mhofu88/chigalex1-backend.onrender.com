/**
 * merchant-directory.js — Chigalex1 Merchant Directory Backend
 *
 * Add these routes to your server.js by requiring this file:
 *   const merchantRoutes = require('./merchant-directory');
 *   merchantRoutes(app, redis, rateLimit, sanitizeString, isValidUsername, validateAdminKey, trackEvent);
 *
 * Or simply copy the route blocks directly into your server.js
 */

module.exports = function(app, redis, rateLimit, sanitizeString, isValidUsername, validateAdminKey, trackEvent) {

  const VALID_CATS = ['food','retail','services','tech','health','transport','education','other'];

  // ════════════════════════════════════════════
  // ── GET ALL MERCHANTS (public, paginated) ──
  // ════════════════════════════════════════════
  app.get('/merchants', rateLimit(30, 60_000), async (req, res) => {
    if (!redis) return res.json({ merchants: [] });

    const cat     = sanitizeString(req.query.cat    || '', 20);
    const country = sanitizeString(req.query.country|| '', 64);
    const search  = sanitizeString(req.query.q      || '', 100).toLowerCase();
    const page    = Math.max(0, parseInt(req.query.page  || '0', 10));
    const limit   = Math.min(50, parseInt(req.query.limit|| '20', 10));

    try {
      // Get all approved merchant IDs newest first
      const ids = await redis.zrange('merchant:index:approved', 0, -1, { rev: true });
      if (!ids.length) return res.json({ merchants: [], total: 0, page, limit });

      // Batch fetch
      const pipeline = redis.pipeline();
      ids.forEach(id => pipeline.hgetall(`merchant:${id}`));
      const all = (await pipeline.exec()).filter(Boolean);

      // Filter
      let filtered = all.filter(m => {
        if (cat     && m.cat     !== cat)                        return false;
        if (country && !m.country.toLowerCase().includes(country.toLowerCase())) return false;
        if (search  && !`${m.name} ${m.desc} ${m.city} ${m.country}`.toLowerCase().includes(search)) return false;
        return true;
      });

      const total = filtered.length;
      const merchants = filtered.slice(page * limit, page * limit + limit).map(m => ({
        id:       m.id,
        name:     m.name,
        cat:      m.cat,
        country:  m.country,
        city:     m.city,
        desc:     m.desc,
        contact:  m.contact,
        pi:       m.pi,
        mapUrl:   m.mapUrl   || '',
        icon:     m.icon     || '🏪',
        verified: m.verified === 'true',
        addedAt:  m.addedAt,
      }));

      await trackEvent('merchant_list_view');
      res.json({ merchants, total, page, limit });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════
  // ── SUBMIT MERCHANT APPLICATION ──
  // Pioneer submits application. Pending until
  // admin approves (after verifying 1π payment).
  // ════════════════════════════════════════════
  app.post('/merchants/apply', rateLimit(5, 60_000), async (req, res) => {
    if (!redis) return res.status(503).json({ error: 'Redis not configured' });

    const name    = sanitizeString(req.body.name    || '', 100);
    const cat     = sanitizeString(req.body.cat     || 'other', 20);
    const country = sanitizeString(req.body.country || '', 64);
    const city    = sanitizeString(req.body.city    || '', 64);
    const desc    = sanitizeString(req.body.desc    || '', 500);
    const contact = sanitizeString(req.body.contact || '', 100);
    const pi      = sanitizeString(req.body.pi      || '', 64);
    const mapUrl  = sanitizeString(req.body.mapUrl  || '', 200);
    const icon    = sanitizeString(req.body.icon    || '🏪', 10);
    const paymentId = sanitizeString(req.body.paymentId || '', 128);
    const txid    = sanitizeString(req.body.txid    || '', 128);

    if (!name || !country || !desc || !pi) {
      return res.status(400).json({ error: 'name, country, desc and pi username are required' });
    }
    if (!VALID_CATS.includes(cat)) {
      return res.status(400).json({ error: 'Invalid category' });
    }

    try {
      const id = Date.now();
      const record = {
        id: String(id),
        name, cat, country, city, desc, contact, pi, mapUrl, icon,
        paymentId, txid,
        status:   'pending',
        verified: 'false',
        addedAt:  new Date().toISOString(),
      };

      await redis.hset(`merchant:${id}`, record);
      // Add to pending index for admin review
      await redis.zadd('merchant:index:pending', { score: id, member: String(id) });

      await trackEvent('merchant_application');
      console.log(`🏪 New merchant application: ${name} from ${country}`);
      res.json({ success: true, id: String(id), status: 'pending' });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════
  // ── ADMIN: VIEW PENDING APPLICATIONS ──
  // ════════════════════════════════════════════
  app.get('/admin/merchants/pending', async (req, res) => {
    if (!validateAdminKey(req, res)) return;
    if (!redis) return res.json({ merchants: [] });

    try {
      const ids = await redis.zrange('merchant:index:pending', 0, -1, { rev: true });
      if (!ids.length) return res.json({ merchants: [], count: 0 });

      const pipeline = redis.pipeline();
      ids.forEach(id => pipeline.hgetall(`merchant:${id}`));
      const merchants = (await pipeline.exec()).filter(Boolean);
      res.json({ merchants, count: merchants.length });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════
  // ── ADMIN: APPROVE MERCHANT ──
  // After verifying 1π payment was received
  // ════════════════════════════════════════════
  app.post('/admin/merchants/approve', async (req, res) => {
    if (!validateAdminKey(req, res)) return;
    if (!redis) return res.status(503).json({ error: 'Redis not configured' });

    const id       = sanitizeString(String(req.body.id || ''), 20);
    const verified = req.body.verified === true || req.body.verified === 'true';

    if (!id) return res.status(400).json({ error: 'id required' });

    try {
      const existing = await redis.hgetall(`merchant:${id}`);
      if (!existing) return res.status(404).json({ error: 'Merchant not found' });

      await redis.hset(`merchant:${id}`, {
        ...existing,
        status:    'approved',
        verified:  verified ? 'true' : 'false',
        approvedAt: new Date().toISOString(),
      });

      // Move from pending to approved index
      await redis.zrem('merchant:index:pending', id);
      await redis.zadd('merchant:index:approved', { score: parseInt(id), member: id });

      await trackEvent('merchant_approved');
      res.json({ success: true, id, verified });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════
  // ── ADMIN: REJECT / REMOVE MERCHANT ──
  // ════════════════════════════════════════════
  app.delete('/admin/merchants/:id', async (req, res) => {
    if (!validateAdminKey(req, res)) return;
    if (!redis) return res.status(503).json({ error: 'Redis not configured' });

    const id = sanitizeString(req.params.id, 20);
    try {
      await redis.del(`merchant:${id}`);
      await redis.zrem('merchant:index:pending', id);
      await redis.zrem('merchant:index:approved', id);
      res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════
  // ── ADMIN: GET ALL APPROVED MERCHANTS ──
  // ════════════════════════════════════════════
  app.get('/admin/merchants', async (req, res) => {
    if (!validateAdminKey(req, res)) return;
    if (!redis) return res.json({ merchants: [] });

    try {
      const pendingIds  = await redis.zrange('merchant:index:pending',  0, -1, { rev: true });
      const approvedIds = await redis.zrange('merchant:index:approved', 0, -1, { rev: true });
      const allIds = [...new Set([...approvedIds, ...pendingIds])];

      if (!allIds.length) return res.json({ merchants: [], pending: 0, approved: 0 });

      const pipeline = redis.pipeline();
      allIds.forEach(id => pipeline.hgetall(`merchant:${id}`));
      const merchants = (await pipeline.exec()).filter(Boolean);

      res.json({
        merchants,
        pending:  pendingIds.length,
        approved: approvedIds.length,
      });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════
  // ── ADMIN: TOGGLE VERIFIED BADGE ──
  // ════════════════════════════════════════════
  app.patch('/admin/merchants/:id/verify', async (req, res) => {
    if (!validateAdminKey(req, res)) return;
    if (!redis) return res.status(503).json({ error: 'Redis not configured' });

    const id = sanitizeString(req.params.id, 20);
    try {
      const existing = await redis.hgetall(`merchant:${id}`);
      if (!existing) return res.status(404).json({ error: 'Merchant not found' });
      const newVerified = existing.verified !== 'true';
      await redis.hset(`merchant:${id}`, { ...existing, verified: String(newVerified) });
      res.json({ success: true, id, verified: newVerified });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  console.log('✅ Merchant directory routes loaded');
};

