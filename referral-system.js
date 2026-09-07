/**
 * referral-system.js — Chigalex1 Ambassador Referral Tracking
 *
 * HOW IT WORKS:
 * 1. Ambassador shares their unique link:
 *    chigalex1-backend.onrender.com?ref=AMBASSADORNAME
 *
 * 2. Visitor lands on the page → ref code stored in browser
 *
 * 3. When visitor pays 1π → their membership is tagged with
 *    the ambassador's ref code
 *
 * 4. Admin can see exactly which ambassador brought which member
 *    and how many referrals each ambassador has
 *
 * ADD TO server.js before app.listen:
 *   require('./referral-system')(app, redis, rateLimit, sanitizeString, isValidUsername, validateAdminKey, trackEvent);
 */

module.exports = function(app, redis, rateLimit, sanitizeString, isValidUsername, validateAdminKey, trackEvent) {

  // ════════════════════════════════════════════
  // ── TRACK A REFERRAL CLICK ──
  // Called when someone visits with ?ref=code
  // ════════════════════════════════════════════
  app.post('/referral/click', rateLimit(20, 60_000), async (req, res) => {
    const refCode = sanitizeString(req.body.refCode || '', 64).toLowerCase();
    if (!refCode) return res.status(400).json({ error: 'refCode required' });
    if (!redis) return res.json({ success: true });

    try {
      const day = new Date().toISOString().slice(0, 10);
      await Promise.all([
        redis.incr(`referral:${refCode}:clicks`),
        redis.incr(`referral:${refCode}:clicks:${day}`),
        redis.incr(`referral:total:clicks`),
        // Record this referral code exists
        redis.sadd('referral:codes', refCode),
      ]);
      await trackEvent('referral_click');
      res.json({ success: true });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════
  // ── RECORD A REFERRAL CONVERSION ──
  // Called when a referred user completes payment
  // ════════════════════════════════════════════
  app.post('/referral/convert', rateLimit(10, 60_000), async (req, res) => {
    const refCode  = sanitizeString(req.body.refCode  || '', 64).toLowerCase();
    const username = sanitizeString(req.body.username || '', 64);
    if (!refCode || !isValidUsername(username)) {
      return res.status(400).json({ error: 'refCode and username required' });
    }
    if (!redis) return res.json({ success: true });

    try {
      const now = new Date().toISOString();
      const day = now.slice(0, 10);

      await Promise.all([
        // Increment conversion counters
        redis.incr(`referral:${refCode}:conversions`),
        redis.incr(`referral:${refCode}:conversions:${day}`),
        redis.incr(`referral:total:conversions`),
        // Tag the member with who referred them
        redis.set(`member:${username}:referredBy`, refCode),
        redis.set(`member:${username}:referredAt`, now),
        // Add to ambassador's member list (sorted set by timestamp)
        redis.zadd(`referral:${refCode}:members`, { score: Date.now(), member: username }),
        // Record code in global index
        redis.sadd('referral:codes', refCode),
      ]);

      await trackEvent('referral_conversion');
      console.log(`✅ Referral conversion: ${username} referred by ${refCode}`);
      res.json({ success: true, refCode, username });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════
  // ── GET REFERRAL STATS FOR ONE AMBASSADOR ──
  // ════════════════════════════════════════════
  app.get('/referral/stats/:refCode', rateLimit(20, 60_000), async (req, res) => {
    const refCode = sanitizeString(req.params.refCode || '', 64).toLowerCase();
    if (!refCode) return res.status(400).json({ error: 'refCode required' });
    if (!redis) return res.json({ clicks: 0, conversions: 0, members: [] });

    try {
      const [clicks, conversions, memberIds] = await Promise.all([
        redis.get(`referral:${refCode}:clicks`),
        redis.get(`referral:${refCode}:conversions`),
        redis.zrange(`referral:${refCode}:members`, 0, -1, { rev: true }),
      ]);

      // Get member details
      let members = [];
      if (memberIds.length) {
        const pipeline = redis.pipeline();
        memberIds.forEach(u => {
          pipeline.get(`member:${u}:paidAt`);
          pipeline.get(`member:${u}:country`);
          pipeline.get(`referral:${refCode}:members`);
        });
        members = memberIds.map((u, i) => ({ username: u }));

        // Get paidAt for each member
        const pipeline2 = redis.pipeline();
        memberIds.forEach(u => {
          pipeline2.get(`member:${u}:paidAt`);
          pipeline2.get(`member:${u}:country`);
        });
        const details = await pipeline2.exec();
        members = memberIds.map((u, i) => ({
          username: u,
          paidAt: details[i * 2],
          country: details[i * 2 + 1],
        }));
      }

      res.json({
        refCode,
        clicks:      parseInt(clicks || '0', 10),
        conversions: parseInt(conversions || '0', 10),
        conversionRate: clicks > 0 ? ((conversions / clicks) * 100).toFixed(1) + '%' : '0%',
        members,
      });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════
  // ── ADMIN: GET ALL AMBASSADOR STATS ──
  // ════════════════════════════════════════════
  app.get('/admin/referrals', async (req, res) => {
    if (!validateAdminKey(req, res)) return;
    if (!redis) return res.json({ ambassadors: [], totals: {} });

    try {
      const codes = await redis.smembers('referral:codes');
      if (!codes.length) return res.json({ ambassadors: [], totals: { clicks: 0, conversions: 0 } });

      const pipeline = redis.pipeline();
      codes.forEach(code => {
        pipeline.get(`referral:${code}:clicks`);
        pipeline.get(`referral:${code}:conversions`);
        pipeline.zcard(`referral:${code}:members`);
      });
      const results = await pipeline.exec();

      const ambassadors = codes.map((code, i) => ({
        refCode:      code,
        clicks:       parseInt(results[i * 3]     || '0', 10),
        conversions:  parseInt(results[i * 3 + 1] || '0', 10),
        memberCount:  parseInt(results[i * 3 + 2] || '0', 10),
        conversionRate: results[i * 3] > 0
          ? ((results[i * 3 + 1] / results[i * 3]) * 100).toFixed(1) + '%'
          : '0%',
      })).sort((a, b) => b.conversions - a.conversions); // Sort by most conversions

      const totals = {
        clicks:      ambassadors.reduce((s, a) => s + a.clicks, 0),
        conversions: ambassadors.reduce((s, a) => s + a.conversions, 0),
        ambassadors: ambassadors.length,
      };

      res.json({ ambassadors, totals });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════
  // ── ADMIN: REGISTER AN AMBASSADOR ──
  // ════════════════════════════════════════════
  app.post('/admin/referrals/register', async (req, res) => {
    if (!validateAdminKey(req, res)) return;
    if (!redis) return res.status(503).json({ error: 'Redis not configured' });

    const refCode  = sanitizeString(req.body.refCode  || '', 64).toLowerCase();
    const name     = sanitizeString(req.body.name     || '', 100);
    const country  = sanitizeString(req.body.country  || '', 64);
    const piUser   = sanitizeString(req.body.piUser   || '', 64);

    if (!refCode || !name) return res.status(400).json({ error: 'refCode and name required' });

    try {
      await redis.hset(`ambassador:${refCode}`, {
        refCode, name, country, piUser,
        registeredAt: new Date().toISOString(),
        status: 'active',
      });
      await redis.sadd('referral:codes', refCode);
      res.json({ success: true, refCode, shareLink: `https://chigalex1-backend.onrender.com?ref=${refCode}` });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  // ════════════════════════════════════════════
  // ── ADMIN: GET ALL AMBASSADORS ──
  // ════════════════════════════════════════════
  app.get('/admin/ambassadors', async (req, res) => {
    if (!validateAdminKey(req, res)) return;
    if (!redis) return res.json({ ambassadors: [] });

    try {
      const codes = await redis.smembers('referral:codes');
      if (!codes.length) return res.json({ ambassadors: [] });

      const pipeline = redis.pipeline();
      codes.forEach(code => pipeline.hgetall(`ambassador:${code}`));
      const profiles = (await pipeline.exec()).filter(Boolean);

      // Get conversion stats for each
      const pipeline2 = redis.pipeline();
      codes.forEach(code => {
        pipeline2.get(`referral:${code}:clicks`);
        pipeline2.get(`referral:${code}:conversions`);
      });
      const stats = await pipeline2.exec();

      const ambassadors = profiles.map((p, i) => ({
        ...p,
        clicks:      parseInt(stats[i * 2]     || '0', 10),
        conversions: parseInt(stats[i * 2 + 1] || '0', 10),
        shareLink:   `https://chigalex1-backend.onrender.com?ref=${p.refCode}`,
      })).sort((a, b) => b.conversions - a.conversions);

      res.json({ ambassadors });
    } catch(e) { res.status(500).json({ error: e.message }); }
  });

  console.log('✅ Referral system routes loaded');
};
