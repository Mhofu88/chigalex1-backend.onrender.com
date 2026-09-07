const express = require('express');
const cors = require('cors');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());
const { router: subscriptionsRouter } = require("./subscriptions-admin");
const listingsRouter = require("./listings");
const paymentsRouter = require("./payments");
const { router: authRouter } = require("./auth");
const appDevRouter = require("./app-dev-packages");

app.use("/", subscriptionsRouter);
app.use("/listings", listingsRouter);
app.use("/payments", paymentsRouter);
app.use("/auth", authRouter);
app.use("/", appDevRouter);
app.use(express.static(path.join(__dirname, 'public')));
// ════════════════════════════════════════════
// ── REDIS ──
// ════════════════════════════════════════════
let redis = null;
try {
  const { Redis } = require('@upstash/redis');
  redis = Redis.fromEnv();
  console.log('✅ Redis connected');
} catch (e) {
  console.warn('⚠️ Redis not configured — add env vars in Render dashboard');
}

function requireRedis(res) {
  if (!redis) { res.status(503).json({ error: 'Redis not configured' }); return false; }
  return true;
}

// ════════════════════════════════════════════
// ── INPUT VALIDATION HELPERS ──
// ════════════════════════════════════════════
function sanitizeString(str, maxLen = 500) {
  if (typeof str !== 'string') return '';
  return str.trim().slice(0, maxLen).replace(/[<>]/g, '');
}

function isValidUsername(u) {
  return typeof u === 'string' && /^[a-zA-Z0-9_]{1,64}$/.test(u.trim());
}

function isValidEmail(e) {
  if (!e) return true;
  return typeof e === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e.trim()) && e.length <= 254;
}

function validateAdminKey(req, res) {
  if (!process.env.ADMIN_KEY || req.headers['x-admin-key'] !== process.env.ADMIN_KEY) {
    res.status(401).json({ error: 'Unauthorized' });
    return false;
  }
  return true;
}
// ════════════════════════════════════════════
// ── RATE LIMITING ──
// ════════════════════════════════════════════
const rateLimitStore = new Map();

function rateLimit(maxRequests = 20, windowMs = 60_000) {
  return (req, res, next) => {
    const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
    const now = Date.now();
    const entry = rateLimitStore.get(ip);
    if (!entry || now > entry.resetAt) {
      rateLimitStore.set(ip, { count: 1, resetAt: now + windowMs });
      return next();
    }
    entry.count++;
    if (entry.count > maxRequests) {
      return res.status(429).json({ error: 'Too many requests — please slow down.' });
    }
    next();
  };
}

setInterval(() => {
  const now = Date.now();
  for (const [ip, entry] of rateLimitStore) {
    if (now > entry.resetAt) rateLimitStore.delete(ip);
  }
}, 5 * 60_000);

// ════════════════════════════════════════════
// ── ANALYTICS HELPER ──
// ════════════════════════════════════════════
async function trackEvent(event) {
  if (!redis) return;
  try {
    const day = new Date().toISOString().slice(0, 10);
    await redis.incr(`analytics:${day}:${event}`);
    await redis.incr(`analytics:total:${event}`);
  } catch (e) {
    console.warn('Analytics tracking failed:', e.message);
  }
}

// ════════════════════════════════════════════
// ── REDIS HELPERS (FAQ / QUESTIONS) ──
// ════════════════════════════════════════════
async function getFAQs(lang = null) {
  const ids = await redis.zrange('faq:index', 0, -1);
  if (!ids.length) return [];
  const pipeline = redis.pipeline();
  ids.forEach(id => pipeline.hgetall(`faq:${id}`));
  const results = await pipeline.exec();
  const faqs = results.map(r => r).filter(Boolean);
  return lang ? faqs.filter(f => !f.lang || f.lang === lang || f.lang === 'all') : faqs;
}

async function getQuestions(filter = 'all') {
  const key = filter === 'answered' ? 'question:index:answered' : 'question:index:all';
  const ids = await redis.zrange(key, 0, -1, { rev: true });
  if (!ids.length) return [];
  const pipeline = redis.pipeline();
  ids.forEach(id => pipeline.hgetall(`question:${id}`));
  const results = await pipeline.exec();
  return results.filter(Boolean);
  }

// ════════════════════════════════════════════
// ── PRICING CONFIG (DYNAMIC — Redis-backed) ──
// Defaults below are used only if Redis has no value yet.
// ════════════════════════════════════════════
const DEFAULT_PRICING = {
  membership: 0.1,
  advert: 0.3,
  merchant: 0.5,
};

async function getPricing() {
  if (!redis) return DEFAULT_PRICING;
  try {
    const stored = await redis.get('config:pricing');
    if (stored) {
      const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
      return { ...DEFAULT_PRICING, ...parsed };
    }
    return DEFAULT_PRICING;
  } catch (e) {
    console.error('getPricing error:', e);
    return DEFAULT_PRICING;
  }
}

async function setPricing(type, value) {
  if (!redis) throw new Error('Redis not configured');
  const current = await getPricing();
  current[type] = value;
  await redis.set('config:pricing', JSON.stringify(current));
  return current;
  }
// ════════════════════════════════════════════
// ── PRICING ENDPOINTS ──
// ════════════════════════════════════════════

// PUBLIC — used by index.html loadPricing()
app.get('/api/pricing', async (req, res) => {
  try {
    const p = await getPricing();
    res.json({
      membership: p.membership,
      advert: p.advert,
      merchant: p.merchant,
      currency: 'π',
      formatted: {
        membership: `${p.membership}π`,
        advert: `${p.advert}π`,
        merchant: `${p.merchant}π`,
      }
    });
  } catch (e) {
    res.json({
      membership: DEFAULT_PRICING.membership,
      advert: DEFAULT_PRICING.advert,
      merchant: DEFAULT_PRICING.merchant,
      currency: 'π',
    });
  }
});

// ADMIN ONLY — used by admin.html pricing tab
app.post('/admin/update-pricing', async (req, res) => {
  const { admin_username, type, value } = req.body;

  if (!ADMIN_ACCOUNTS.includes((admin_username || '').toLowerCase())) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  const validTypes = ['membership', 'advert', 'merchant'];
  if (!validTypes.includes(type)) {
    return res.status(400).json({ error: 'Invalid pricing type. Must be: membership, advert, or merchant' });
  }


  const numValue = parseFloat(value);
  if (isNaN(numValue) || numValue <= 0) {
    return res.status(400).json({ error: 'Value must be a positive number' });
  }

  if (!requireRedis(res)) return;

  try {
    const updated = await setPricing(type, numValue);
    res.json({
      success: true,
      message: `✅ ${type} price updated to ${numValue}π — live everywhere instantly!`,
      pricing: updated,
    });

} catch (e) {
    console.error('Update pricing error:', e);
    res.status(500).json({ error: 'Failed to update pricing' });
  }
});
// TIER CONFIG — Redis-backed (same pattern as pricing)
async function getTierConfig() {
  if (!redis) return TIER_CONFIG;
  try {
    const stored = await redis.get('config:tiers');
    if (stored) {
      const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
      // Merge with defaults so any missing tiers still work
      return { ...TIER_CONFIG, ...parsed };
    }
    return TIER_CONFIG;
  } catch (e) {
    return TIER_CONFIG;
  }
}

async function setTierConfig(tierName, pi_per_recruit, bonus_on_entry) {
  if (!redis) throw new Error('Redis not configured');
  const current = await getTierConfig();
  if (!current[tierName]) throw new Error(`Unknown tier: ${tierName}`);
  current[tierName] = {
    ...current[tierName],
    pi_per_recruit: parseFloat(pi_per_recruit),
    bonus_on_entry: parseFloat(bonus_on_entry),
  };
  await redis.set('config:tiers', JSON.stringify(current));
  return current;
}

app.post('/admin/update-tier', async (req, res) => {
  const { admin_username, tier, pi_per_recruit, bonus_on_entry } = req.body;
  if (!ADMIN_ACCOUNTS.includes((admin_username || '').toLowerCase())) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  const validTiers = ['starter', 'bronze', 'silver', 'gold', 'diamond'];
  if (!validTiers.includes(tier)) {
    return res.status(400).json({ error: 'Invalid tier name' });
  }
  if (isNaN(parseFloat(pi_per_recruit)) || isNaN(parseFloat(bonus_on_entry))) {
    return res.status(400).json({ error: 'pi_per_recruit and bonus_on_entry must be numbers' });
  }
  if (!requireRedis(res)) return;
  try {
    const updated = await setTierConfig(tier, pi_per_recruit, bonus_on_entry);
    res.json({
      success: true,
      message: `✅ ${tier} tier updated — ${pi_per_recruit}π/recruit · ${bonus_on_entry}π entry bonus. Live immediately!`,
      tiers: updated,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
// Also update calculateTier() to use Redis config — add this helper:
async function calculateTierAsync(recruits) {
  const config = await getTierConfig();
  const tiers = Object.values(config).sort((a, b) => b.min_recruits - a.min_recruits);
  for (const tier of tiers) {
    if (recruits >= tier.min_recruits) return tier;
  }
  return null;
}
// Note: Use calculateTierAsync() in record-recruit and dashboard routes
// instead of the synchronous calculateTier() once this is deployed.


// ════════════════════════════════════════════
// ── AMBASSADOR / TIER CONFIG & HELPERS ──
  
// ════════════════════════════════════════════
// ── AMBASSADOR / TIER CONFIG & HELPERS ──
// ════════════════════════════════════════════
const ADMIN_ACCOUNTS = ['chigalex1', 'admin2', 'dorisyin', 'chigodop'];

const TIER_CONFIG = {
  starter: {
    name: 'Starter', emoji: '🌱',
    min_recruits: 1, max_recruits: 4,
    pi_per_recruit: 0.005, bonus_on_entry: 0.01,
    color: '#00D4AA',
  },
  bronze: {
    name: 'Bronze', emoji: '🥉',
    min_recruits: 5, max_recruits: 9,
    pi_per_recruit: 0.01, bonus_on_entry: 0.05,
    color: '#CD7F32',
  },
  silver: {
    name: 'Silver', emoji: '🥈',
    min_recruits: 10, max_recruits: 19,
    pi_per_recruit: 0.02, bonus_on_entry: 0.1,
    color: '#C0C0C0',
  },
  gold: {
    name: 'Gold', emoji: '🏅',
    min_recruits: 20, max_recruits: 49,
    pi_per_recruit: 0.05, bonus_on_entry: 0.25,
    color: '#F5C518',
  },
  diamond: {
    name: 'Diamond', emoji: '⭐',
    min_recruits: 50, max_recruits: Infinity,
    pi_per_recruit: 0.1, bonus_on_entry: 1.0,
    color: '#9B59B6',
  }
};

function getPeriodKey() {
  const now = new Date();
  const month = `${now.getFullYear()}-${String(now.getMonth()+1).padStart(2,'0')}`;
  const week = `${now.getFullYear()}-W${String(Math.ceil(now.getDate()/7)).padStart(2,'0')}`;
  return { month, week };
}

function calculateTier(recruits) {
  if (recruits >= 50) return TIER_CONFIG.diamond;
  if (recruits >= 20) return TIER_CONFIG.gold;
  if (recruits >= 10) return TIER_CONFIG.silver;
  if (recruits >= 5)  return TIER_CONFIG.bronze;
  if (recruits >= 1)  return TIER_CONFIG.starter;
  return null;
}

function calculateTotalPiEarned(recruitHistory) {
  let total = 0;
  let currentTier = null;
  recruitHistory.forEach((recruit, index) => {
    const recruitNumber = index + 1;
    const tier = calculateTier(recruitNumber);
    if (!tier) return;
    total += tier.pi_per_recruit;
    if (!currentTier || currentTier.name !== tier.name) {
      total += tier.bonus_on_entry;
      currentTier = tier;
    }
  });
  return parseFloat(total.toFixed(4));
}

function buildRewardBreakdown(recruits) {
  const breakdown = [];
  let runningTotal = 0;
  Object.values(TIER_CONFIG).forEach(tier => {
    const recruitsInTier = Math.min(
      Math.max(0, recruits - tier.min_recruits + 1),
      tier.max_recruits - tier.min_recruits + 1
    );
    if (recruitsInTier > 0) {
      const tierEarnings = (recruitsInTier * tier.pi_per_recruit) + tier.bonus_on_entry;
      runningTotal += tierEarnings;
      breakdown.push({
        tier: tier.name,
        emoji: tier.emoji,
        recruits_in_tier: recruitsInTier,
        per_recruit: tier.pi_per_recruit,
        entry_bonus: tier.bonus_on_entry,
        tier_total: parseFloat(tierEarnings.toFixed(4)),
        running_total: parseFloat(runningTotal.toFixed(4)),
      });
    }
  });
  return breakdown;
}

async function notifyAmbassador(pi_username, message) {
  if (!redis) return;
  try {
    const notifKey = `notifications:${pi_username}`;
    let notifs = [];
    const existing = await redis.get(notifKey);
    if (existing) notifs = JSON.parse(existing);
    notifs.unshift({ message, timestamp: new Date().toISOString(), read: false });
    if (notifs.length > 50) notifs = notifs.slice(0, 50);
    await redis.set(notifKey, JSON.stringify(notifs));
    console.log(`📲 Notification queued for @${pi_username}: ${message}`);
  } catch(e) {
    console.error('Notification error:', e);
  }
}

async function getAllAmbassadors() {
  if (!redis) return [];
  try {
    const keys = await redis.keys('ambassador:*');
    if (!keys || keys.length === 0) return [];
    const ambassadors = [];
    for (const key of keys) {
      try {
        const data = await redis.get(key);
        if (data) {
          const amb = typeof data === 'string' ? JSON.parse(data) : data;
          ambassadors.push(amb);
        }
      } catch(e) {
        // Skip keys with wrong type (Hash records from old referral system)
        console.warn(`Skipping key ${key} — wrong Redis type:`, e.message);
      }
    }
    return ambassadors;
  } catch(e) {
    console.error('Redis getAllAmbassadors error:', e);
    return [];
  }
}

// Helper: treat admin accounts as always "paid" for AI access
function OWNER_USERNAMES_INCLUDE(username) {
  return ADMIN_ACCOUNTS.includes((username || '').toLowerCase());
}
// ════════════════════════════════════════════
// ── HEALTH CHECK ──
// ════════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    app: 'Chigalex1 – Africa Pi Network Education Hub',
    referral: 'chigalex1',
    redis: redis ? 'connected' : 'not configured'
  });
});

app.get('/api', (req, res) => {
  res.json({ message: 'Chigalex1 Backend Online ✅', referral: 'chigalex1' });
});

// ════════════════════════════════════════════
// ── PI DOMAIN VALIDATION KEY ──
// ════════════════════════════════════════════
app.get('/validation-key.txt', (req, res) => {
  res.type('text/plain');
  res.send('66fd2fe77f7974921d81546a3e9e70af5d70ab6de3068f474775154713c90bfae119028b5541e88f5857fc36f04b102cb5edde4341012fd42834d145dd39e2bf');
});

// ════════════════════════════════════════════
// ── PRIVACY POLICY ──
// ════════════════════════════════════════════
app.get('/privacy', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Privacy Policy – Chigalex1</title>
<style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;background:#0D0A1A;color:#F0EBF8;padding:40px 20px;max-width:800px;margin:0 auto;line-height:1.75;}h1{font-size:1.8rem;font-weight:800;color:#F5C518;margin-bottom:6px;}.sub{color:#9B59B6;font-size:.9rem;margin-bottom:32px;}h2{font-size:1.1rem;font-weight:700;color:#00D4AA;margin:28px 0 10px;}p{color:#B8A8D8;font-size:.93rem;margin-bottom:12px;}ul{color:#B8A8D8;font-size:.93rem;padding-left:20px;margin-bottom:12px;}ul li{margin-bottom:6px;}.pi{color:#F5C518;font-weight:700;}.warn{color:#FF7043;}a{color:#9B59B6;}.back{display:inline-block;margin-top:32px;background:linear-gradient(135deg,#7B2D8B,#9B59B6);color:#fff;padding:10px 22px;border-radius:100px;text-decoration:none;font-weight:700;font-size:.9rem;}.logo{font-size:2rem;margin-bottom:8px;}</style>
</head><body>
<div class="logo">π</div>
<h1>Privacy Policy</h1>
<p class="sub">Chigalex1 – Africa Pi Network Education Hub · Last updated: May 2026</p>
<h2>1. Who We Are</h2>
<p><strong class="pi">Chigalex1</strong> is an independent educational platform and community DApp created to help pioneers and businesses across Africa register on Pi Network, complete KYC and KYB verification, and list on Map of Pi. Chigalex1 is operated under the Africa Pi GCV Industry Alliance and is <span class="warn">not affiliated with Pi Network or SocialChain Inc.</span></p>
<h2>2. Information We Collect</h2>
<ul>
<li><strong>Pi Username</strong> — collected when you authenticate via Pi Network login.</li>
<li><strong>Payment Transaction ID (txid)</strong> — collected to confirm your membership payment.</li>
<li><strong>Name and Email (optional)</strong> — collected only if you submit a question.</li>
<li><strong>Questions submitted</strong> — stored so the administrator can publish answers.</li>
</ul>
<p>We do <strong>not</strong> collect passwords, passphrases, national ID information, or sensitive financial data.</p>
<h2>3. Data Storage</h2>
<p>All data is stored securely using Upstash Redis with encryption in transit and at rest.</p>
<h2>4. Pi Network Authentication</h2>
<p>Chigalex1 uses the official Pi Network SDK. We only receive your Pi username and payment confirmation — we never receive or store your passphrase or private keys.</p>
<p><strong class="warn">Never share your 24-word Pi passphrase with anyone — including Chigalex1.</strong></p>
<h2>5. Your Rights</h2>
<p>You may request deletion of your data by submitting a question with the subject "Data Deletion Request". We will process it within 30 days.</p>
<h2>6. Contact</h2>
<p>For privacy concerns, contact us through the Chigalex1 Ask the Administrator feature at <a href="/">chigalex1-backend.onrender.com</a>.</p>
<a href="/" class="back">← Back to Chigalex1</a>
</body></html>`);
});

// ════════════════════════════════════════════
// ── TERMS OF SERVICE ──
// ════════════════════════════════════════════
app.get('/terms', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width, initial-scale=1.0"/>
<title>Terms of Service – Chigalex1</title>
<style>*{box-sizing:border-box;margin:0;padding:0;}body{font-family:Arial,sans-serif;background:#0D0A1A;color:#F0EBF8;padding:40px 20px;max-width:800px;margin:0 auto;line-height:1.75;}h1{font-size:1.8rem;font-weight:800;color:#F5C518;margin-bottom:6px;}.sub{color:#9B59B6;font-size:.9rem;margin-bottom:32px;}h2{font-size:1.1rem;font-weight:700;color:#00D4AA;margin:28px 0 10px;}p{color:#B8A8D8;font-size:.93rem;margin-bottom:12px;}ul{color:#B8A8D8;font-size:.93rem;padding-left:20px;margin-bottom:12px;}ul li{margin-bottom:6px;}.pi{color:#F5C518;font-weight:700;}.warn{color:#FF7043;}a{color:#9B59B6;}.back{display:inline-block;margin-top:32px;background:linear-gradient(135deg,#7B2D8B,#9B59B6);color:#fff;padding:10px 22px;border-radius:100px;text-decoration:none;font-weight:700;font-size:.9rem;}.logo{font-size:2rem;margin-bottom:8px;}.highlight{background:rgba(245,197,24,0.1);border:1px solid rgba(245,197,24,0.3);border-radius:10px;padding:14px 18px;margin:16px 0;}</style>
</head><body>
<div class="logo">π</div>
<h1>Terms of Service</h1>
<p class="sub">Chigalex1 – Africa Pi Network Education Hub · Last updated: May 2026</p>
<div class="highlight"><p style="color:#F5C518;font-weight:700;">Important Notice</p><p>Chigalex1 is an <strong>independent community educational platform</strong> and is not affiliated with, endorsed by, or officially connected to Pi Network or SocialChain Inc.</p></div>
<h2>1. Acceptance of Terms</h2>
<p>By using Chigalex1, you agree to be bound by these Terms. If you do not agree, please do not use the App.</p>
<h2>2. Description of Service</h2>
<p><strong class="pi">Chigalex1</strong> provides step-by-step training on Pi Network registration, KYC, KYB, Map of Pi, and Pi security across all 54 African countries in 25 languages.</p>
<h2>3. Membership Fee</h2>
<p>Access requires a <strong>one-time fee of 0.01 Pi (0.01π)</strong>. This is a community app access fee and is <span class="warn">NOT a charge by Pi Network or SocialChain Inc.</span></p>
<h2>4. Security Warning</h2>
<p><strong class="warn">Chigalex1 will NEVER ask for your 24-word Pi passphrase.</strong> Anyone who does is attempting fraud.</p>
<h2>5. Disclaimer of Affiliation</h2>
<p>Chigalex1 is <span class="warn">NOT affiliated with Pi Network or SocialChain Inc.</span> All Pi Network trademarks belong to their respective owners.</p>
<h2>6. Contact</h2>
<p>Submit questions at <a href="/">chigalex1-backend.onrender.com</a></p>
<a href="/" class="back">← Back to Chigalex1</a>
</body></html>`);
});

// ════════════════════════════════════════════
// ── MEMBERSHIP ROUTES ──
// ════════════════════════════════════════════
app.get('/check-membership', rateLimit(30, 60_000), async (req, res) => {
  const username = sanitizeString(req.query.username, 64);
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username' });
  if (!redis) return res.json({ username, paid: false, status: 'free' });
  try {
    const [status, paidAt, country, lang] = await Promise.all([
      redis.get(`member:${username}:status`),
      redis.get(`member:${username}:paidAt`),
      redis.get(`member:${username}:country`),
      redis.get(`member:${username}:lang`),
    ]);
    await trackEvent('check_membership');
    res.json({ username, paid: status === 'paid', status: status || 'free', paidAt, country, lang });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/approve-payment', rateLimit(10, 60_000), async (req, res) => {
  const { paymentId } = req.body;
  if (!paymentId || typeof paymentId !== 'string') return res.status(400).json({ error: 'paymentId required' });
  try {
    const response = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}/approve`, {
      method: 'POST',
      headers: { 'Authorization': `Key ${process.env.PI_API_KEY || ''}`, 'Content-Type': 'application/json' }
    });
    const data = await response.json();
    console.log('✅ Payment approved:', paymentId);
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/complete-payment', rateLimit(10, 60_000), async (req, res) => {
  const paymentId = sanitizeString(req.body.paymentId, 128);
  const txid = sanitizeString(req.body.txid, 128);
  const username = sanitizeString(req.body.username, 64);
  const country = sanitizeString(req.body.country || '', 64);
  const lang = sanitizeString(req.body.lang || 'en', 10);
  if (!paymentId || !txid || !isValidUsername(username)) {
    return res.status(400).json({ error: 'paymentId, txid and valid username required' });
  }
  try {
    const response = await fetch(`https://api.minepi.com/v2/payments/${encodeURIComponent(paymentId)}/complete`, {
      method: 'POST',
      headers: { 'Authorization': `Key ${process.env.PI_API_KEY || ''}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ txid })
    });
    const data = await response.json();
    console.log('✅ Payment completed:', username, txid);
    if (redis) {
      const now = new Date().toISOString();
      await Promise.all([
        redis.set(`member:${username}:status`, 'paid'),
        redis.set(`member:${username}:txid`, txid),
        redis.set(`member:${username}:paidAt`, now),
        redis.set(`member:${username}:country`, country),
        redis.set(`member:${username}:lang`, lang),
        redis.zadd('member:index', { score: Date.now(), member: username }),
      ]);
      await trackEvent('new_member');
      sendPiNotification(username, '🎉 Welcome to Chigalex1! Your membership is confirmed. Start your Pi training now.').catch(() => {});
    }
    res.json({ success: true, username, status: 'paid' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════
// ── USER PROFILE ──
// ════════════════════════════════════════════
app.get('/profile/:username', rateLimit(30, 60_000), async (req, res) => {
  const username = sanitizeString(req.params.username, 64);
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username' });
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });
  try {
    const [status, paidAt, txid, country, lang, progress] = await Promise.all([
      redis.get(`member:${username}:status`),
      redis.get(`member:${username}:paidAt`),
      redis.get(`member:${username}:txid`),
      redis.get(`member:${username}:country`),
      redis.get(`member:${username}:lang`),
      redis.hgetall(`member:${username}:progress`),
    ]);
    if (!status) return res.status(404).json({ error: 'User not found' });
    await trackEvent('profile_view');
    res.json({ username, status: status || 'free', paid: status === 'paid', paidAt, txid, country, lang, progress: progress || {} });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.patch('/profile/:username', rateLimit(10, 60_000), async (req, res) => {
  const username = sanitizeString(req.params.username, 64);
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username' });
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });
  const updates = {};
  if (req.body.country) updates.country = sanitizeString(req.body.country, 64);
  if (req.body.lang) updates.lang = sanitizeString(req.body.lang, 10);
  if (!Object.keys(updates).length) return res.status(400).json({ error: 'No valid fields to update' });
  try {
    await Promise.all(Object.entries(updates).map(([k, v]) => redis.set(`member:${username}:${k}`, v)));
    res.json({ success: true, username, ...updates });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/profile/:username/progress', rateLimit(60, 60_000), async (req, res) => {
  const username = sanitizeString(req.params.username, 64);
  const step = sanitizeString(req.body.step || '', 64);
  if (!isValidUsername(username) || !step) return res.status(400).json({ error: 'username and step required' });
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });
  try {
    await redis.hset(`member:${username}:progress`, { [step]: new Date().toISOString() });
    await trackEvent('progress_update');
    res.json({ success: true, username, step });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════
// ── PI NOTIFICATIONS ──
// ════════════════════════════════════════════
async function sendPiNotification(username, message) {
  if (!process.env.PI_API_KEY) return;
  const res = await fetch('https://api.minepi.com/v2/me/notifications', {
    method: 'POST',
    headers: { 'Authorization': `Key ${process.env.PI_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid: username, message }),
  });
  return res.json();
}

app.post('/admin/notify', async (req, res) => {
  if (!validateAdminKey(req, res)) return;
  const username = sanitizeString(req.body.username || '', 64);
  const message = sanitizeString(req.body.message || '', 500);
  if (!isValidUsername(username) || !message) return res.status(400).json({ error: 'username and message required' });
  try {
    const data = await sendPiNotification(username, message);
    await trackEvent('notification_sent');
    res.json({ success: true, data });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════
// ── ANALYTICS ──
// ════════════════════════════════════════════
app.get('/admin/analytics', async (req, res) => {
  if (!validateAdminKey(req, res)) return;
  if (!redis) return res.json({ error: 'Redis not configured' });
  try {
    const days = Array.from({ length: 7 }, (_, i) => {
      const d = new Date(); d.setDate(d.getDate() - i); return d.toISOString().slice(0, 10);
    });
    const events = ['new_member', 'check_membership', 'profile_view', 'question_submitted', 'progress_update', 'notification_sent'];
    const pipeline = redis.pipeline();
    days.forEach(day => events.forEach(e => pipeline.get(`analytics:${day}:${e}`)));
    events.forEach(e => pipeline.get(`analytics:total:${e}`));
    const results = await pipeline.exec();
    const daily = {};
    days.forEach((day, di) => {
      daily[day] = {};
      events.forEach((e, ei) => { daily[day][e] = parseInt(results[di * events.length + ei] || '0', 10); });
    });
    const totals = {};
    events.forEach((e, i) => { totals[e] = parseInt(results[days.length * events.length + i] || '0', 10); });
    const memberCount = await redis.zcard('member:index');
    res.json({ totals, daily, memberCount });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════
// ── MULTI-LANGUAGE CONTENT ──
// ════════════════════════════════════════════
app.get('/content/:slug', rateLimit(60, 60_000), async (req, res) => {
  const slug = sanitizeString(req.params.slug, 64);
  const lang = sanitizeString(req.query.lang || 'en', 10);
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });
  try {
    let content = await redis.hgetall(`content:${lang}:${slug}`);
    if (!content || !content.body) content = await redis.hgetall(`content:en:${slug}`);
    if (!content || !content.body) return res.status(404).json({ error: 'Content not found' });
    await trackEvent('content_view');
    res.json({ slug, lang: content.lang || lang, ...content });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/content', async (req, res) => {
  if (!validateAdminKey(req, res)) return;
  if (!requireRedis(res)) return;
  const slug = sanitizeString(req.body.slug || '', 64);
  const lang = sanitizeString(req.body.lang || 'en', 10);
  const title = sanitizeString(req.body.title || '', 200);
  const body = sanitizeString(req.body.body || '', 5000);
  if (!slug || !title || !body) return res.status(400).json({ error: 'slug, title, and body required' });
  try {
    await redis.hset(`content:${lang}:${slug}`, { slug, lang, title, body, updatedAt: new Date().toISOString() });
    await redis.sadd(`content:index:${lang}`, slug);
    res.json({ success: true, slug, lang });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/content', async (req, res) => {
  if (!validateAdminKey(req, res)) return;
  if (!redis) return res.json({ content: [] });
  const lang = sanitizeString(req.query.lang || 'en', 10);
  try {
    const slugs = await redis.smembers(`content:index:${lang}`);
    if (!slugs.length) return res.json({ content: [] });
    const pipeline = redis.pipeline();
    slugs.forEach(slug => pipeline.hgetall(`content:${lang}:${slug}`));
    const results = await pipeline.exec();
    res.json({ content: results.filter(Boolean) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════
// ── FAQ ROUTES ──
// ════════════════════════════════════════════
app.get('/faqs', rateLimit(30, 60_000), async (req, res) => {
  if (!redis) return res.json({ faqs: [] });
  const lang = sanitizeString(req.query.lang || '', 10);
  try {
    const faqs = await getFAQs(lang || null);
    res.json({ faqs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/faqs', async (req, res) => {
  if (!validateAdminKey(req, res)) return;
  if (!requireRedis(res)) return;
  const question = sanitizeString(req.body.question || '', 500);
  const answer = sanitizeString(req.body.answer || '', 2000);
  const lang = sanitizeString(req.body.lang || 'en', 10);
  if (!question || !answer) return res.status(400).json({ error: 'question and answer required' });
  try {
    const id = Date.now();
    const faq = { id: String(id), question, answer, lang, addedAt: new Date().toISOString() };
    await redis.hset(`faq:${id}`, faq);
    await redis.zadd('faq:index', { score: id, member: String(id) });
    res.json({ success: true, faq });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/faqs/:id', async (req, res) => {
  if (!validateAdminKey(req, res)) return;
  if (!requireRedis(res)) return;
  const id = sanitizeString(req.params.id, 20);
  try {
    await redis.del(`faq:${id}`);
    await redis.zrem('faq:index', id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════
// ── QUESTION ROUTES ──
// ════════════════════════════════════════════
app.post('/questions', rateLimit(5, 60_000), async (req, res) => {
  if (!redis) return res.json({ success: true, note: 'Redis not configured' });
  const name = sanitizeString(req.body.name || 'Anonymous', 100);
  const email = sanitizeString(req.body.email || '', 254);
  const question = sanitizeString(req.body.question || '', 1000);
  if (!question) return res.status(400).json({ error: 'question is required' });
  if (!isValidEmail(email)) return res.status(400).json({ error: 'Invalid email address' });
  try {
    const id = Date.now();
    const record = { id: String(id), name, email, question, status: 'pending', askedAt: new Date().toISOString() };
    await redis.hset(`question:${id}`, record);
    await redis.zadd('question:index:all', { score: id, member: String(id) });
    await trackEvent('question_submitted');
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/questions/answered', rateLimit(30, 60_000), async (req, res) => {
  if (!redis) return res.json({ questions: [] });
  try {
    const questions = await getQuestions('answered');
    res.json({ questions: questions.map(({ email, ...q }) => q) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/questions', async (req, res) => {
  if (!validateAdminKey(req, res)) return;
  if (!redis) return res.json({ questions: [] });
  try {
    const filter = req.query.filter || 'all';
    const questions = await getQuestions(filter);
    res.json({ questions });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/questions/answer', async (req, res) => {
  if (!validateAdminKey(req, res)) return;
  if (!requireRedis(res)) return;
  const id = sanitizeString(String(req.body.id || ''), 20);
  const answer = sanitizeString(req.body.answer || '', 2000);
  if (!id || !answer) return res.status(400).json({ error: 'id and answer required' });
  try {
    const existing = await redis.hgetall(`question:${id}`);
    if (!existing) return res.status(404).json({ error: 'Question not found' });
    await redis.hset(`question:${id}`, { ...existing, answer, status: 'answered', answeredAt: new Date().toISOString() });
    await redis.zadd('question:index:answered', { score: parseInt(id), member: id });
    if (req.body.notify !== false && existing.username) {
      sendPiNotification(existing.username, `📚 Your question has been answered on Chigalex1!`).catch(() => {});
    }
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════
// ── ADMIN: MEMBERS ──
// ════════════════════════════════════════════
app.get('/admin/members', async (req, res) => {
  if (!validateAdminKey(req, res)) return;
  if (!redis) return res.json({ count: 0, members: [] });
  try {
    const page = Math.max(0, parseInt(req.query.page || '0', 10));
    const limit = Math.min(100, parseInt(req.query.limit || '50', 10));
    const start = page * limit;
    const end = start + limit - 1;
    const usernames = await redis.zrange('member:index', start, end, { rev: true });
    const total = await redis.zcard('member:index');
    if (!usernames.length) return res.json({ count: total, members: [], page, limit });
    const pipeline = redis.pipeline();
    usernames.forEach(u => {
      pipeline.get(`member:${u}:status`);
      pipeline.get(`member:${u}:paidAt`);
      pipeline.get(`member:${u}:country`);
      pipeline.get(`member:${u}:lang`);
    });
    const results = await pipeline.exec();
    const members = usernames.map((u, i) => ({
      username: u,
      status: results[i * 4] || 'free',
      paidAt: results[i * 4 + 1],
      country: results[i * 4 + 2],
      lang: results[i * 4 + 3],
    }));
    res.json({ count: total, members, page, limit });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/set-membership', async (req, res) => {
  if (!validateAdminKey(req, res)) return;
  if (!requireRedis(res)) return;
  const username = sanitizeString(req.body.username || '', 64);
  const status = req.body.status === 'free' ? 'free' : 'paid';
  if (!isValidUsername(username)) return res.status(400).json({ error: 'Invalid username' });
  try {
    await redis.set(`member:${username}:status`, status);
    if (status === 'paid') await redis.zadd('member:index', { score: Date.now(), member: username });
    res.json({ success: true, username, status });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════
// ── ADVERTS ──
// ════════════════════════════════════════════
app.post('/adverts/apply', rateLimit(3, 60_000), async (req, res) => {
  if (!redis) return res.json({ success: true });
  const title = sanitizeString(req.body.title || '', 100);
  const desc = sanitizeString(req.body.desc || '', 200);
  const pi = sanitizeString(req.body.pi || '', 64);
  if (!title || !desc || !pi) return res.status(400).json({ error: 'title, desc and pi required' });
  const id = Date.now();
  try {
    await redis.hset(`advert:${id}`, {
      id: String(id), title, desc, pi,
      country: sanitizeString(req.body.country || '', 64),
      contact: sanitizeString(req.body.contact || '', 100),
      link: sanitizeString(req.body.link || '', 200),
      icon: sanitizeString(req.body.icon || '📣', 10),
      status: 'pending', submittedAt: new Date().toISOString()
    });
    await redis.zadd('advert:index:pending', { score: id, member: String(id) });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/admin/adverts/pending', async (req, res) => {
  if (!validateAdminKey(req, res)) return;
  if (!redis) return res.json({ adverts: [] });
  try {
    const ids = await redis.zrange('advert:index:pending', 0, -1, { rev: true });
    if (!ids.length) return res.json({ adverts: [], count: 0 });
    const pipeline = redis.pipeline();
    ids.forEach(id => pipeline.hgetall(`advert:${id}`));
    const adverts = (await pipeline.exec()).filter(Boolean);
    res.json({ adverts, count: adverts.length });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/admin/adverts/approve', async (req, res) => {
  if (!validateAdminKey(req, res)) return;
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });
  const id = sanitizeString(String(req.body.id || ''), 20);
  if (!id) return res.status(400).json({ error: 'id required' });
  try {
    const existing = await redis.hgetall(`advert:${id}`);
    if (!existing) return res.status(404).json({ error: 'Advert not found' });
    await redis.hset(`advert:${id}`, { ...existing, status: 'approved', approvedAt: new Date().toISOString() });
    await redis.zrem('advert:index:pending', id);
    await redis.zadd('advert:index:approved', { score: parseInt(id), member: id });
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/admin/adverts/:id', async (req, res) => {
  if (!validateAdminKey(req, res)) return;
  if (!redis) return res.status(503).json({ error: 'Redis not configured' });
  const id = sanitizeString(req.params.id, 20);
  try {
    await redis.del(`advert:${id}`);
    await redis.zrem('advert:index:pending', id);
    await redis.zrem('advert:index:approved', id);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════
// ── AI CHATBOT — FREE TIER (TEASER) ──
// ════════════════════════════════════════════
app.post('/ai/chat/free', rateLimit(20, 60_000), async (req, res) => {
  const message = sanitizeString(req.body.message || '', 500);
  const history = (req.body.history || []).slice(-6).map(h => ({
    role: h.role === 'user' ? 'user' : 'assistant',
    content: sanitizeString(h.content || '', 500)
  }));
  if (!message) return res.status(400).json({ error: 'message required' });

  const FREE_SYSTEM_PROMPT = `You are Chigalex1 AI — a Pi Network assistant for Africa.

IMPORTANT RULES FOR FREE TIER:
- Give PARTIAL answers only — maximum 3 sentences
- Never give step-by-step instructions or detailed guides
- Never reveal specific document requirements, fees, or technical steps
- Always end EVERY response with a membership call-to-action
- Be warm, helpful in tone, but deliberately incomplete in content
- You can confirm facts exist but not explain them fully
- Respond in whatever language the pioneer is writing in

TOPICS YOU CAN PARTIALLY ANSWER:
- What Pi Network is (general only)
- That KYC exists and is important (no steps)
- That GCV = $314,159 per Pi (no strategy)
- That Map of Pi exists (no how-to)
- That PiDEX exists (no usage guide)
- That Pi Launchpad exists (no participation guide)
- General encouragement to join Pi

ALWAYS END WITH (translate to their language):
"🔒 For the complete step-by-step guide, unlock full Chigalex1 membership — just a small one-time Pi fee. Message @chigalex1 on Pi Network to learn more!"

NEVER:
- Give complete how-to guides
- List specific steps
- Reveal exact document requirements
- Explain full GCV strategy
- Give full PiDEX or Launchpad walkthrough`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 200,
        system: FREE_SYSTEM_PROMPT,
        messages: [...history, { role: 'user', content: message }]
      })
    });
    const data = await response.json();
    const reply = data.content?.[0]?.text || 'Please try again.';
    res.json({ reply, tier: 'free' });
  } catch (err) {
    console.error('Free AI error:', err);
    res.status(500).json({
      reply: 'I am having trouble connecting right now. Please try again shortly.',
      tier: 'free'
    });
  }
});

// ════════════════════════════════════════════
// ── AI CHATBOT — PAID TIER (FULL EXPERT) ──
// ════════════════════════════════════════════
app.post('/ai/chat', rateLimit(20, 60_000), async (req, res) => {
  const message = sanitizeString(req.body.message || '', 500);
  const username = sanitizeString(req.body.username || '', 64);
  const history = (req.body.history || []).slice(-20).map(h => ({
    role: h.role === 'user' ? 'user' : 'assistant',
    content: sanitizeString(h.content || '', 500)
  }));
  if (!message) return res.status(400).json({ error: 'message required' });

  // Verify paid membership
  let isPaidMember = false;
  if (username && redis) {
    try {
      const status = await redis.get(`member:${username}:status`);
      isPaidMember = status === 'paid' || OWNER_USERNAMES_INCLUDE(username);
    } catch (e) {
      console.error('Redis membership check error:', e);
    }
  }

  if (!isPaidMember) {
    return res.status(403).json({
      reply: '🔒 This is a members-only feature. Unlock full Chigalex1 access with a small one-time Pi fee to chat with the full AI expert. Message @chigalex1 on Pi Network!',
      tier: 'free',
      upgrade: true
    });
  }

  const PAID_SYSTEM_PROMPT = `You are Chigalex1 AI — the expert Pi Network guide for Africa, created by Alexander (Chigalex1), Vice Chair of the Africa Pi GCV Industry Alliance.

YOUR EXPERTISE:
- Complete Pi Network knowledge: Registration, KYC, KYB, Security, Map of Pi
- GCV ($314,159 per 1π) — strategy, implementation, business adoption
- PiDEX — how to use Pi's decentralized exchange safely
- Pi Launchpad Testnet — staking, committing, participating in token launches
- Africa-specific guidance for all 54 nations
- KYC documents accepted in every African country
- Business Pi adoption strategies (GCV Phase 1 through Phase 5)
- Scam identification and security best practices

LANGUAGE:
- Detect and respond in the pioneer's language automatically
- Supported: English, Shona, Ndebele, isiZulu, isiXhosa, Afrikaans, Sesotho,
  Setswana, Chichewa, Português, Kiswahili, Amharic, Kinyarwanda, Luganda,
  Somali, Hausa, Yoruba, Igbo, Twi, Wolof, Français, Arabic, Tamazight,
  Lingala, Kikongo
- If unsure of language, respond in English but ask which language they prefer

YOUR PERSONALITY:
- Warm, encouraging, patient — many pioneers are new to crypto
- Use simple everyday analogies (markets, farming, community savings)
- Never talk down to pioneers — treat everyone as capable
- Celebrate pioneer milestones and progress
- Africa-proud — emphasize Africa's leadership in Pi adoption

RESPONSE STYLE:
- Give COMPLETE, detailed, step-by-step answers
- Use numbered steps for processes
- Use emojis to make content friendly and scannable
- Always provide context for WHY each step matters
- Include warnings where scams are common
- End with encouragement and next steps

IMPORTANT FACTS TO ALWAYS GET RIGHT:
- GCV = $314,159 per 1π (encoded in Pi blockchain)
- Chigalex1 membership = ${(await getPricing()).membership}π one-time fee
- Referral code = chigalex1
- Pi Browser required for Pi apps
- KYC required before Pi Wallet activation
- KYB required before business can accept Pi
- Map of Pi = mapofpi.com
- PiDEX launched March 12 2026
- Pi Launchpad launched Testnet March 2026
- SLICE is the second Launchpad test token
- Staking ≠ Committing (must do BOTH to earn Launchpad tokens)
- Pi Core Team: support@minepi.com

NEVER:
- Recommend buying Pi on external exchanges
- Give financial advice or price predictions beyond GCV
- Share anyone's private information
- Claim to be human`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY || '',
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 1000,
        system: PAID_SYSTEM_PROMPT,
        messages: [...history, { role: 'user', content: message }]
      })
    });
    const data = await response.json();
    const reply = data.content?.[0]?.text || 'Please try again.';
    res.json({ reply, tier: 'paid' });
  } catch (err) {
    console.error('Paid AI error:', err);
    res.status(500).json({
      reply: 'I am having trouble connecting right now. Please try again shortly.',
      tier: 'paid'
    });
  }
});

// ════════════════════════════════════════════
// ── MERCHANT DIRECTORY MODULE ──
// ════════════════════════════════════════════
require('./merchant-directory')(app, redis, rateLimit, sanitizeString, isValidUsername, validateAdminKey, trackEvent);

// ════════════════════════════════════════════
// ── REFERRAL SYSTEM MODULE ──
// ════════════════════════════════════════════
require('./referral-system')(app, redis, rateLimit, sanitizeString, isValidUsername, validateAdminKey, trackEvent);

// ════════════════════════════════════════════
// ── AMBASSADOR PROGRAM ──
// ════════════════════════════════════════════

// 1. APPLY
app.post('/ambassador/apply', async (req, res) => {
  if (!requireRedis(res)) return;
  const { name, country, pi_username, phone, lang, why, biz, timestamp } = req.body;
  if (!name || !country || !pi_username || !why) {
    return res.status(400).json({ error: 'Missing required fields' });
  }
  try {
    const { month } = getPeriodKey();
    const applicationKey = `ambassador_application:${pi_username}`;
    const application = {
      name, country, pi_username,
      phone: phone || '',
      lang: lang || 'en',
      why,
      biz: biz || '',
      timestamp: timestamp || new Date().toISOString(),
      status: 'pending',
      applied_month: month,
    };
    await redis.set(applicationKey, JSON.stringify(application));

const logKey = 'ambassador_applications_log';
    let log = [];
    try {
      const existing = await redis.get(logKey);
      if (existing) {
        log = typeof existing === 'string' ? JSON.parse(existing) : existing;
      }
    } catch(e) {
      // Wrong type — wipe and start fresh
      try { await redis.del(logKey); } catch(e2) {}
      log = [];
    }
    log.unshift({ pi_username, name, country, timestamp: application.timestamp });
    if (log.length > 200) log = log.slice(0, 200);
    await redis.set(logKey, JSON.stringify(log));

    res.json({ success: true, message: 'Application received! We will review and contact you via Pi Network within 48 hours.' });
  } catch(err) {
    console.error('Ambassador apply error:', err);
    res.status(500).json({ error: 'Failed to save application' });
  }
});

// 2. APPROVE
app.post('/ambassador/approve', async (req, res) => {
  if (!requireRedis(res)) return;
  const { admin_username, pi_username } = req.body;
  if (!ADMIN_ACCOUNTS.includes((admin_username || '').toLowerCase())) {
    return res.status(403).json({ error: 'Admin access required' });
  }
try {
    const appKey = `ambassador_application:${pi_username}`;
    const appData = await redis.get(appKey);
    if (!appData) return res.status(404).json({ error: 'Application not found' });

    const application = JSON.parse(appData);
    const { month } = getPeriodKey();

    const ambassador = {
      ...application,
      approved: true,
      approved_by: admin_username,
      approved_date: new Date().toISOString(),
      recruits: 0,
      recruits_month: 0,
      recruits_week: 0,
      pi_rewarded: 0,
      pi_paid: 0,
      joined_month: month,
      status: 'active',
    };

    await redis.set(`ambassador:${pi_username}`, JSON.stringify(ambassador));
    await redis.set(`member:${pi_username}:status`, 'paid');
    await redis.zadd('member:index', { score: Date.now(), member: pi_username });

    res.json({ success: true, message: `✅ ${pi_username} approved as ambassador and granted free membership!` });
  } catch(err) {
    console.error('Approve error:', err);
    res.status(500).json({ error: 'Failed to approve ambassador' });
  }
});

app.post('/ambassador/force-create', async (req, res) => {
  if (!requireRedis(res)) return;
  const { admin_username, pi_username, name, country, phone, why } = req.body;

  if (!ADMIN_ACCOUNTS.includes((admin_username || '').toLowerCase())) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  if (!pi_username) {
    return res.status(400).json({ error: 'pi_username required' });
  }

const pi_username_clean = pi_username.toLowerCase().trim();

  try {
    // Check if already exists as ambassador
    const existing = await redis.get(`ambassador:${pi_username_clean}`);
    if (existing) {
      return res.json({ success: true, message: `@${pi_username_clean} is already an ambassador.`, already_existed: true });
    }

    const { month } = getPeriodKey();

    const ambassador = {
      name: name || pi_username_clean,
      country: country || 'Unknown',
      pi_username_clean   ,
      phone: phone || '',
      lang: 'en',
      why: why || 'Added directly by admin',
      biz: '',
      timestamp: new Date().toISOString(),
      approved: true,
      approved_by: admin_username,
      approved_date: new Date().toISOString(),
      recruits: 0,
      recruits_month: 0,
      recruits_week: 0,
      pi_rewarded: 0,
      pi_paid: 0,
      joined_month: month,
      status: 'active',
      force_created: true,
    };

    await redis.set(`ambassador:${pi_username_clean}`, JSON.stringify(ambassador));
    await redis.set(`member:${pi_username_clean}:status`, 'paid');
    await redis.zadd('member:index', { score: Date.now(), member: pi_username_clean });

    res.json({
      success: true,
      message: `✅ @${pi_username_clean} force-created as ambassador and granted free membership!`,
      ambassador
    });
  } catch (err) {
    console.error('Force create error:', err);
    res.status(500).json({ error: 'Failed to force-create ambassador' });
  }
});

// ════════════════════════════════════════════════════════════════
// ONE-TIME FIX: Delete a corrupted ambassador record so it can be
// rebuilt cleanly with Force-Create.
//
// This is admin-only, additive (doesn't touch any existing route),
// and only deletes the SPECIFIC key you pass in — nothing else.
//
// Add this to server.js, right after the /ambassador/force-create
// route.
// ════════════════════════════════════════════════════════════════

app.post('/ambassador/admin/delete-broken-record', async (req, res) => {
  if (!requireRedis(res)) return;
  const { admin_username, pi_username } = req.body;

  if (!ADMIN_ACCOUNTS.includes((admin_username || '').toLowerCase())) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  if (!pi_username) {
    return res.status(400).json({ error: 'pi_username required' });
  }

  try {
    // Try both common casings to be thorough, since Redis keys are
    // case-sensitive and the corrupted record could exist under
    // either form.
    const variants = [
      pi_username,
      pi_username.toLowerCase(),
      pi_username.charAt(0).toUpperCase() + pi_username.slice(1).toLowerCase(),
    ];
    const uniqueVariants = [...new Set(variants)];

const deleted = [];
    for (const variant of uniqueVariants) {
      const key = `ambassador:${variant}`;
      try {
        const delResult = await redis.del(key);
        if (delResult > 0) deleted.push(key);
      } catch(e) {
        // Key exists but wrong type — force delete anyway
        deleted.push(key + ' (force-deleted)');
      }
   }

    res.json({
      success: true,
      message: deleted.length > 0
        ? `✅ Deleted ${deleted.length} record(s): ${deleted.join(', ')}. You can now Force-Create @${pi_username} cleanly.`
        : `No ambassador record found for any casing of "${pi_username}". Nothing to delete.`,
      deleted_keys: deleted,
    });
  } catch (err) {
    console.error('Delete broken record error:', err);
    res.status(500).json({ error: 'Failed to delete record' });
  }
});

/*
═══════════════════════════════════════════════════════════════
HOW TO USE — STEP BY STEP FOR PETER
═══════════════════════════════════════════════════════════════
1. Add this route to server.js (after force-create route)
2. Deploy
3. Call this ONE TIME via the admin panel or a direct request:

   POST https://chigalex1-backend.onrender.com/ambassador/admin/delete-broken-record
   Body: {
     "admin_username": "chigalex1",
     "pi_username": "anointedp1"
   }

   This checks for and deletes "ambassador:anointedp1",
   "ambassador:Anointedp1" — whichever casing exists — clearing
   out the corrupted record.

4. Then go back to admin.html → Force-Create Ambassador → fill in
   Peter's details again → submit. This rebuilds a clean record.

5. Verify by visiting:
   https://chigalex1-backend.onrender.com/ambassador/profile/anointedp1
   It should now return his data instead of "Failed to load profile".

6. Check the leaderboard:
   https://chigalex1-backend.onrender.com/ambassador/leaderboard?period=all
   Peter should now appear in the ambassadors array.
═══════════════════════════════════════════════════════════════
*/


// 3. RECORD RECRUIT (with automatic tier tracking)
app.post('/ambassador/record-recruit', async (req, res) => {
  if (!requireRedis(res)) return;
  const { admin_username, ambassador_username, business_name, country, notes, business_type } = req.body;

  if (!ADMIN_ACCOUNTS.includes((admin_username || '').toLowerCase())) {
    return res.status(403).json({ error: 'Admin access required' });
  }

  try {
    const ambKey = `ambassador:${ambassador_username}`;
    const ambData = await redis.get(ambKey);
    if (!ambData) return res.status(404).json({ error: 'Ambassador not found' });

    const amb = JSON.parse(ambData);
    const { month, week } = getPeriodKey();

    const oldTier = calculateTier(amb.recruits || 0);

    amb.recruits = (amb.recruits || 0) + 1;
    amb.recruits_month = (amb.recruits_month || 0) + 1;
    amb.recruits_week = (amb.recruits_week || 0) + 1;

    const newTier = calculateTier(amb.recruits);
    const tierChanged = !oldTier || oldTier.name !== newTier.name;

    let piEarned = newTier.pi_per_recruit;
    if (tierChanged) piEarned += newTier.bonus_on_entry;
    amb.pi_rewarded = parseFloat(((amb.pi_rewarded || 0) + piEarned).toFixed(4));

    if (tierChanged) {
      if (!amb.tier_history) amb.tier_history = [];
      amb.tier_history.push({
        from: oldTier ? oldTier.name : 'None',
        to: newTier.name,
        date: new Date().toISOString(),
        recruits: amb.recruits,
      });
      await notifyAmbassador(
        ambassador_username,
        `🎉 CONGRATULATIONS @${ambassador_username}! You've been promoted to ${newTier.emoji} ${newTier.name} tier! You earned a ${newTier.bonus_on_entry}π bonus! Keep onboarding businesses across ${amb.country}! 🌍`
      );
    } else {
      await notifyAmbassador(
        ambassador_username,
        `✅ Recruit #${amb.recruits} recorded! Business: ${business_name || 'New Business'} · ${amb.country}. Total Pi earned: ${amb.pi_rewarded}π · Tier: ${newTier.emoji} ${newTier.name}`
      );
    }

    const historyKey = `ambassador_history:${ambassador_username}`;
    let history = [];
    try {
      const existing = await redis.get(historyKey);
      if (existing) history = JSON.parse(existing);
    } catch(e) {}

    history.unshift({
      business_name: business_name || 'Unknown Business',
      business_type: business_type || 'General',
      country: country || amb.country,
      notes: notes || '',
      recorded_by: admin_username,
      date: new Date().toISOString(),
      month, week,
      recruit_number: amb.recruits,
      tier_at_time: newTier.name,
      pi_earned: parseFloat(piEarned.toFixed(4)),
    });
    if (history.length > 1000) history = history.slice(0, 1000);
    await redis.set(historyKey, JSON.stringify(history));

    await redis.set(ambKey, JSON.stringify(amb));

    const response = {
      success: true,
      ambassador: ambassador_username,
      country: amb.country,
      total_recruits: amb.recruits,
      recruits_month: amb.recruits_month,
      current_tier: newTier,
      tier_changed: tierChanged,
      old_tier: oldTier?.name || 'None',
      new_tier: newTier.name,
      pi_earned_this: parseFloat(piEarned.toFixed(4)),
      pi_total_earned: amb.pi_rewarded,
      pi_pending_payout: parseFloat((amb.pi_rewarded - (amb.pi_paid || 0)).toFixed(4)),
    };

    if (tierChanged) {
      response.message = `🎉 TIER UP! @${ambassador_username} promoted to ${newTier.emoji} ${newTier.name}! Bonus: ${newTier.bonus_on_entry}π · Total earned: ${amb.pi_rewarded}π`;
      response.celebration = true;
    } else {
      response.message = `✅ Recruit #${amb.recruits} recorded for @${ambassador_username} · ${newTier.emoji} ${newTier.name} · Pi earned: ${piEarned}π · Total: ${amb.pi_rewarded}π`;
    }

    const nextTierConfig = Object.values(TIER_CONFIG).find(t => t.min_recruits > amb.recruits);
    if (nextTierConfig) {
      response.next_tier = {
        name: nextTierConfig.name,
        emoji: nextTierConfig.emoji,
        remaining: nextTierConfig.min_recruits - amb.recruits,
        bonus: nextTierConfig.bonus_on_entry,
      };
    }

    res.json(response);
  } catch(err) {
    console.error('Record recruit error:', err);
    res.status(500).json({ error: 'Failed to record recruit' });
  }
});
// 4. LEADERBOARD
app.get('/ambassador/leaderboard', async (req, res) => {
  const period = req.query.period || 'all';
  try {
    const allAmbs = await getAllAmbassadors();
    const sorted = allAmbs
      .filter(a => a.approved === true)
      .sort((a, b) => {
        const recruitsA = period === 'month' ? (a.recruits_month || 0) : period === 'week' ? (a.recruits_week || 0) : (a.recruits || 0);
        const recruitsB = period === 'month' ? (b.recruits_month || 0) : period === 'week' ? (b.recruits_week || 0) : (b.recruits || 0);
        return recruitsB - recruitsA;
      })
      .map(a => ({
        pi_username: a.pi_username,
        name: a.name,
        country: a.country,
        recruits: period === 'month' ? (a.recruits_month || 0) : period === 'week' ? (a.recruits_week || 0) : (a.recruits || 0),
        tier: calculateTier(a.recruits || 0) || TIER_CONFIG.starter,
        joined_month: a.joined_month || '',
        pi_rewarded: a.pi_rewarded || 0,
      }));

    const stats = {
      total_ambassadors: sorted.length,
      total_recruits: sorted.reduce((sum, a) => sum + a.recruits, 0),
      total_countries: new Set(sorted.map(a => a.country)).size,
      total_pi_rewarded: allAmbs.reduce((sum, a) => sum + (a.pi_rewarded || 0), 0).toFixed(2),
    };

    res.json({ ambassadors: sorted, stats, period });
  } catch(err) {
    console.error('Leaderboard error:', err);
    res.status(500).json({ ambassadors: [], stats: {}, error: 'Failed to load' });
  }
});

// 5. PROFILE
app.get('/ambassador/profile/:username', async (req, res) => {
  if (!requireRedis(res)) return;
  const { username } = req.params;
  try {
    const ambData = await redis.get(`ambassador:${username}`);
    if (!ambData) return res.status(404).json({ error: 'Ambassador not found' });

    const amb = JSON.parse(ambData);
    const tier = calculateTier(amb.recruits || 0) || TIER_CONFIG.starter;
    const nextConfig = Object.values(TIER_CONFIG).find(t => t.min_recruits > (amb.recruits || 0));

    let history = [];
    try {
      const histData = await redis.get(`ambassador_history:${username}`);
      if (histData) history = JSON.parse(histData);
    } catch(e) {}

    res.json({
      pi_username: amb.pi_username,
      name: amb.name,
      country: amb.country,
      approved_date: amb.approved_date,
      joined_month: amb.joined_month,
      recruits: amb.recruits || 0,
      recruits_month: amb.recruits_month || 0,
      recruits_week: amb.recruits_week || 0,
      pi_rewarded: amb.pi_rewarded || 0,
      tier: tier,
      next_tier: nextConfig ? {
        threshold: nextConfig.min_recruits,
        remaining: nextConfig.min_recruits - (amb.recruits || 0)
      } : null,
      recent_recruits: history.slice(0, 10),
    });
  } catch(err) {
    console.error('Profile error:', err);
    res.status(500).json({ error: 'Failed to load profile' });
  }
});

// 6. TIER CONFIG (PUBLIC)
app.get('/ambassador/tiers', (req, res) => {
  res.json({
    tiers: Object.values(TIER_CONFIG),
    currency: 'π',
    note: 'Rewards are distributed manually by admin via Pi Network payment'
  });
});

// 7. DASHBOARD
app.get('/ambassador/dashboard/:username', async (req, res) => {
  if (!requireRedis(res)) return;
  const { username } = req.params;
  try {
    const ambData = await redis.get(`ambassador:${username}`);
    if (!ambData) {
      return res.status(404).json({ error: 'Ambassador not found. Apply at landing.html!' });
    }

    const amb = JSON.parse(ambData);
    if (!amb.approved) {
      return res.json({
        status: 'pending',
        message: 'Your application is under review. We will contact you via Pi Network within 48 hours.',
        pi_username: username,
      });
    }

    let history = [];
    try {
      const histData = await redis.get(`ambassador_history:${username}`);
      if (histData) history = JSON.parse(histData);
    } catch(e) {}

    const currentTier = calculateTier(amb.recruits || 0) || TIER_CONFIG.starter;
    const totalPi = calculateTotalPiEarned(history);
    const breakdown = buildRewardBreakdown(amb.recruits || 0);

    let nextTierInfo = null;
    if (currentTier.name !== 'Diamond') {
      const nextConfig = Object.values(TIER_CONFIG).find(t => t.min_recruits > (amb.recruits || 0));
      if (nextConfig) {
        nextTierInfo = {
          name: nextConfig.name,
          emoji: nextConfig.emoji,
          needed: nextConfig.min_recruits,
          remaining: nextConfig.min_recruits - (amb.recruits || 0),
          bonus_on_reach: nextConfig.bonus_on_entry,
        };
      }
    }

    let notifications = [];
    try {
      const notifData = await redis.get(`notifications:${username}`);
      if (notifData) notifications = JSON.parse(notifData).filter(n => !n.read);
    } catch(e) {}

    res.json({
      status: 'active',
      pi_username: amb.pi_username,
      name: amb.name,
      country: amb.country,
      joined_month: amb.joined_month,
      approved_date: amb.approved_date,
      recruits: amb.recruits || 0,
      recruits_month: amb.recruits_month || 0,
      recruits_week: amb.recruits_week || 0,
      current_tier: currentTier,
      next_tier: nextTierInfo,
      is_diamond: currentTier.name === 'Diamond',
      pi_earned: totalPi,
      pi_paid: amb.pi_paid || 0,
      pi_pending: parseFloat((totalPi - (amb.pi_paid || 0)).toFixed(4)),
      reward_breakdown: breakdown,
      recent_recruits: history.slice(0, 5),
      total_recruits_recorded: history.length,
      unread_notifications: notifications.slice(0, 5),
      notification_count: notifications.length,
    });
  } catch(err) {
    console.error('Dashboard error:', err);
    res.status(500).json({ error: 'Failed to load dashboard' });
  }
});

// 8. RECORD PAYOUT
app.post('/ambassador/record-payout', async (req, res) => {
  if (!requireRedis(res)) return;
  const { admin_username, ambassador_username, amount, txid, notes } = req.body;
  if (!ADMIN_ACCOUNTS.includes((admin_username || '').toLowerCase())) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const ambKey = `ambassador:${ambassador_username}`;
    const ambData = await redis.get(ambKey);
    if (!ambData) return res.status(404).json({ error: 'Ambassador not found' });

    const amb = JSON.parse(ambData);
    const paidAmount = parseFloat(amount) || 0;
    amb.pi_paid = parseFloat(((amb.pi_paid || 0) + paidAmount).toFixed(4));
    amb.last_payout = {
      amount: paidAmount, txid: txid || '', notes: notes || '',
      date: new Date().toISOString(), paid_by: admin_username,
    };
    if (!amb.payout_history) amb.payout_history = [];
    amb.payout_history.unshift(amb.last_payout);

    await redis.set(ambKey, JSON.stringify(amb));

    await notifyAmbassador(
      ambassador_username,
      `💰 Pi reward received! ${paidAmount}π has been sent to your Pi Wallet. Thank you for growing Pi adoption in ${amb.country}! 🌍 Keep onboarding — your next rewards are accumulating! 🚀`
    );

    const pending = parseFloat((amb.pi_rewarded - amb.pi_paid).toFixed(4));

    res.json({
      success: true,
      ambassador: ambassador_username,
      amount_paid: paidAmount,
      total_paid: amb.pi_paid,
      total_earned: amb.pi_rewarded,
      pending_balance: pending,
      message: `✅ ${paidAmount}π payout recorded for @${ambassador_username}. Pending balance: ${pending}π`,
    });
  } catch(err) {
    console.error('Payout error:', err);
    res.status(500).json({ error: 'Failed to record payout' });
  }
});

// 9. NOTIFICATIONS
app.get('/ambassador/notifications/:username', async (req, res) => {
  if (!requireRedis(res)) return;
  const { username } = req.params;
  try {
    const notifData = await redis.get(`notifications:${username}`);
    const notifs = notifData ? JSON.parse(notifData) : [];
    const updated = notifs.map(n => ({ ...n, read: true }));
    await redis.set(`notifications:${username}`, JSON.stringify(updated));
    res.json({ notifications: notifs, unread_count: notifs.filter(n => !n.read).length });
  } catch(err) {
    res.status(500).json({ error: 'Failed to load notifications' });
  }
});

// 10. ADMIN: APPLICATIONS
app.get('/ambassador/admin/applications', async (req, res) => {
  if (!requireRedis(res)) return;
  const admin = req.query.admin;
  if (!ADMIN_ACCOUNTS.includes((admin || '').toLowerCase())) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const logData = await redis.get('ambassador_applications_log');
    const log = logData ? JSON.parse(logData) : [];
    const applications = [];
    for (const entry of log.slice(0, 50)) {
      try {
        const appData = await redis.get(`ambassador_application:${entry.pi_username}`);
        if (appData) {
          const application = JSON.parse(appData);
          const ambData = await redis.get(`ambassador:${entry.pi_username}`);
          application.already_approved = !!ambData;
          applications.push(application);
        }
      } catch(e) {}
    }
res.json({ applications, total: applications.length });
  } catch(err) {
    console.error('Applications error:', err);
    res.status(500).json({ error: 'Failed to load applications' });
  }
});

// SCAN ALL APPLICATIONS — finds applications even if log is broken
app.get('/ambassador/admin/scan-applications', async (req, res) => {
  if (!requireRedis(res)) return;
  const admin = req.query.admin;
  if (!ADMIN_ACCOUNTS.includes((admin || '').toLowerCase())) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    // Scan Redis directly for all application keys
    const keys = await redis.keys('ambassador_application:*');
    const applications = [];
    for (const key of keys) {
      try {
        const data = await redis.get(key);
        if (data) {
          const app = typeof data === 'string' ? JSON.parse(data) : data;
          const ambData = await redis.get(`ambassador:${app.pi_username}`);
          app.already_approved = !!ambData;
          applications.push(app);
        }
      } catch(e) {}
    }
    // Sort newest first
    applications.sort((a, b) => 
      new Date(b.timestamp) - new Date(a.timestamp)
    );
    res.json({ applications, total: applications.length });
  } catch(err) {
    res.status(500).json({ error: 'Failed to scan applications' });
  }
});

// 11. ADMIN: RESET PERIOD
app.post('/ambassador/admin/reset-period', async (req, res) => {
  if (!requireRedis(res)) return;
  const { admin_username, period } = req.body;
  if (!ADMIN_ACCOUNTS.includes((admin_username || '').toLowerCase())) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const allAmbs = await getAllAmbassadors();
    let updated = 0;
    for (const amb of allAmbs) {
      if (period === 'week') {
        amb.recruits_week = 0;
      } else if (period === 'month') {
        amb.recruits_month = 0;
        amb.recruits_week = 0;
      }
      await redis.set(`ambassador:${amb.pi_username}`, JSON.stringify(amb));
      updated++;
    }
    res.json({ success: true, message: `Reset ${period} counts for ${updated} ambassadors` });
  } catch(err) {
    console.error('Reset error:', err);
    res.status(500).json({ error: 'Failed to reset' });
  }
});

// 12. ADMIN: REWARDS SUMMARY
app.get('/ambassador/admin/rewards-summary', async (req, res) => {
  const admin = req.query.admin;
  if (!ADMIN_ACCOUNTS.includes((admin || '').toLowerCase())) {
    return res.status(403).json({ error: 'Admin access required' });
  }
  try {
    const allAmbs = await getAllAmbassadors();
    const approved = allAmbs.filter(a => a.approved);

    const summary = {
      total_ambassadors: approved.length,
      total_recruits: approved.reduce((s, a) => s + (a.recruits || 0), 0),
      total_pi_earned: approved.reduce((s, a) => s + (a.pi_rewarded || 0), 0).toFixed(4),
      total_pi_paid: approved.reduce((s, a) => s + (a.pi_paid || 0), 0).toFixed(4),
      total_pi_pending: approved.reduce((s, a) => s + ((a.pi_rewarded || 0) - (a.pi_paid || 0)), 0).toFixed(4),
      by_tier: {
        diamond: approved.filter(a => (a.recruits || 0) >= 50).length,
        gold: approved.filter(a => (a.recruits || 0) >= 20 && (a.recruits || 0) < 50).length,
        silver: approved.filter(a => (a.recruits || 0) >= 10 && (a.recruits || 0) < 20).length,
        bronze: approved.filter(a => (a.recruits || 0) >= 5 && (a.recruits || 0) < 10).length,
        starter: approved.filter(a => (a.recruits || 0) >= 1 && (a.recruits || 0) < 5).length,
      },
countries: [...new Set(approved.map(a => a.country))].sort(),
      pending_payouts: approved
        .filter(a => ((a.pi_rewarded || 0) - (a.pi_paid || 0)) > 0)
        .map(a => ({
          pi_username: a.pi_username,
          country: a.country,
          tier: calculateTier(a.recruits || 0)?.name,
          pending: parseFloat(((a.pi_rewarded || 0) - (a.pi_paid || 0)).toFixed(4)),
        }))
        .sort((a, b) => b.pending - a.pending),
    };

    res.json(summary);
  } catch(err) {
    console.error('Rewards summary error:', err);
    res.status(500).json({ error: 'Failed to load summary' });
  }
});

// ════════════════════════════════════════════
// ── CATCH-ALL — MUST BE LAST ──
// ════════════════════════════════════════════
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ════════════════════════════════════════════
// ── START SERVER ──
// ════════════════════════════════════════════
app.listen(PORT, () => {
  console.log(`🚀 Chigalex1 running on port ${PORT}`);
  console.log(`   Health:     http://localhost:${PORT}/health`);
  console.log(`   AI Chat:    http://localhost:${PORT}/ai/chat`);
  console.log(`   Pricing:    http://localhost:${PORT}/api/pricing`);
  console.log(`   Validation: http://localhost:${PORT}/validation-key.txt`);
  console.log(`   Privacy:    http://localhost:${PORT}/privacy`);
  console.log(`   Terms:      http://localhost:${PORT}/terms`);
});

