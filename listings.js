// Listings routes — the core of the promotion/marketplace division.
// New listings start as "pending" and only appear in public browsing
// once a payment is approved (see payments.js).
//
// Images: we don't store image FILES here — Render's disk isn't
// permanent and Redis isn't built for binary data. Instead, the
// frontend uploads images directly to ImgBB and sends us back just
// the resulting URL, which we store as a JSON array on the listing.
// images_allowed starts at 1 when a listing is created, and is raised
// by payments.js once a plan is approved (1/3/5 by default).

const express = require("express");
const { redis } = require("./redis-client");
const { requireAuth } = require("./auth");
const { requireAdminKey } = require("./subscriptions-admin");

const multer = require("multer");
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const router = express.Router();

function parseImages(raw) {
  if (Array.isArray(raw)) return raw;
  try {
    const arr = JSON.parse(raw || "[]");
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

// POST /listings — create a new listing (starts pending, images_allowed = 1)
router.post("/", requireAuth, async (req, res) => {
  const { business_name, category, description, contact } = req.body;
  if (!business_name || !contact) {
    return res.status(400).json({ error: "business_name and contact are required" });
  }
  const id = "l_" + Date.now();
  const listing = {
    id, owner_id: req.user.id, business_name, category: category || "other",
    description: description || "", contact, status: "pending",
    images: "[]", images_allowed: "1", created_at: new Date().toISOString(),
  };
  await redis.hset(`listings:${id}`, listing);
  await redis.sadd("listings:all", id);
  await redis.sadd(`listings:by-owner:${req.user.id}`, id);
  if (category) await redis.sadd(`listings:by-category:${category}`, id);
  res.json({ message: "Listing created", listing });
});
// POST /listings/:id/upload-image — owner uploads a photo file directly;
// the backend forwards it to ImgBB and stores the resulting URL. This keeps
// ImgBB entirely server-side, so a phone whose VPN/ISP blocks api.imgbb.com
// can still add photos — the browser only ever talks to our own domain.
router.post("/:id/upload-image", requireAuth, upload.single("image"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "image file is required" });

  const listing = await redis.hgetall(`listings:${req.params.id}`);
  if (!listing || !listing.id) return res.status(404).json({ error: "listing not found" });
  if (listing.owner_id !== req.user.id) return res.status(403).json({ error: "this is not your listing" });

  const images = parseImages(listing.images);
  const allowed = Number(listing.images_allowed || 0);
  if (images.length >= allowed) {
    return res.status(400).json({ error: `You've used all ${allowed} photo slot(s) on this plan.` });
  }

  const IMGBB_API_KEY = process.env.IMGBB_API_KEY;
  if (!IMGBB_API_KEY) return res.status(500).json({ error: "IMGBB_API_KEY is not set on the server" });

  try {
    const form = new URLSearchParams();
    form.append("image", req.file.buffer.toString("base64"));

    const uploadRes = await fetch(`https://api.imgbb.com/1/upload?key=${IMGBB_API_KEY}`, {
      method: "POST",
      body: form,
    });
    const uploadData = await uploadRes.json();
    if (!uploadData.success) {
      return res.status(502).json({ error: "ImgBB upload failed: " + (uploadData.error?.message || "unknown error") });
    }

    const url = uploadData.data.url;
    images.push(url);
    await redis.hset(`listings:${req.params.id}`, { images: JSON.stringify(images) });

    res.json({ message: "Photo added", url, remaining: allowed - images.length });
  } catch (e) {
    res.status(500).json({ error: "Upload failed: " + e.message });
  }
});

// POST /listings/:id/images — owner adds an image URL (already uploaded to ImgBB by the frontend)
router.post("/:id/images", requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  const listing = await redis.hgetall(`listings:${req.params.id}`);
  if (!listing || !listing.id) return res.status(404).json({ error: "listing not found" });
  if (listing.owner_id !== req.user.id) return res.status(403).json({ error: "this is not your listing" });

  // Atomic check-and-push via Lua so concurrent uploads can't race past the limit
  const luaScript = `
    local key = KEYS[1]
    local url = ARGV[1]
    local raw = redis.call('HGET', key, 'images')
    local allowed = tonumber(redis.call('HGET', key, 'images_allowed') or '0')
    local images
    if raw and raw ~= '' then
      images = cjson.decode(raw)
    else
      images = {}
    end
    if #images >= allowed then
      return cjson.encode({error = true, allowed = allowed, count = #images})
    end
    table.insert(images, url)
    local newRaw = cjson.encode(images)
    redis.call('HSET', key, 'images', newRaw)
    return cjson.encode({error = false, images = images, allowed = allowed})
  `;

  const result = JSON.parse(
    await redis.eval(luaScript, 1, `listings:${req.params.id}`, url)
  );

  if (result.error) {
    return res.status(400).json({
      error: `Your plan allows ${result.allowed} image(s) — you've already used all of them.`,
    });
  }

  res.json({ message: "Image added", images: result.images, remaining: result.allowed - result.images.length });
});

// GET /listings?category=retail — browse active listings, optionally by category
router.get("/", async (req, res) => {
  const { category } = req.query;
  const ids = category
    ? await redis.smembers(`listings:by-category:${category}`)
    : await redis.smembers("listings:all");

  const listings = await Promise.all(ids.map((id) => redis.hgetall(`listings:${id}`)));
  const active = listings
    .filter((l) => l && l.status === "active")
    .map((l) => ({ ...l, images: parseImages(l.images) }));
  res.json({ listings: active });
});

// GET /listings/mine — the logged-in user's own listings, any status
router.get("/mine", requireAuth, async (req, res) => {
  const ids = await redis.smembers(`listings:by-owner:${req.user.id}`);
  const listings = await Promise.all(ids.map((id) => redis.hgetall(`listings:${id}`)));
  const parsed = listings.filter(Boolean).map((l) => ({ ...l, images: parseImages(l.images) }));
  res.json({ listings: parsed });
});

// GET /admin/all — every listing regardless of status, for cleanup/management.
// Scans keys directly rather than an index, so this catches listings
// created before this feature existed too.
router.get("/admin/all", requireAdminKey, async (req, res) => {
  const keys = await redis.keys("listings:l_*");
  const ids = keys.map((k) => k.replace("listings:", ""));
  const listings = await Promise.all(ids.map((id) => redis.hgetall(`listings:${id}`)));
  const parsed = listings.filter((l) => l && l.id).map((l) => ({ ...l, images: parseImages(l.images) }));
  res.json({ listings: parsed });
});
// PUT /listings/:id/activate — admin: directly activate a listing on a
// given plan, without a submitted payment (for manual/test approvals).
router.put("/:id/activate", requireAdminKey, async (req, res) => {
  const { plan } = req.body;
  if (!plan) return res.status(400).json({ error: "plan is required" });

  const listing = await redis.hgetall(`listings:${req.params.id}`);
  if (!listing || !listing.id) return res.status(404).json({ error: "listing not found" });

  const planConfig = await redis.hgetall(`subscription_plans:${plan}`);
  const durationDays = planConfig?.duration_days ? Number(planConfig.duration_days) : 30;
  const advertsIncluded = planConfig?.adverts_included ? Number(planConfig.adverts_included) : 1;
  const maxImages = planConfig?.max_images ? Number(planConfig.max_images) : 1;

  const expiry = new Date();
  expiry.setDate(expiry.getDate() + durationDays);

  await redis.hset(`listings:${req.params.id}`, {
    status: "active",
    plan,
    subscription_expiry: expiry.toISOString(),
    adverts_included: String(advertsIncluded),
    adverts_used: "0",
    images_allowed: String(maxImages),
  });
  res.json({ message: "Listing activated", subscription_expiry: expiry.toISOString() });
});
// POST /listings/:id/claim-free — owner claims their one-time free trial slot.
// Each account gets exactly one free activation, ever — enforced server-side.
router.post("/:id/claim-free", requireAuth, async (req, res) => {
  const listing = await redis.hgetall(`listings:${req.params.id}`);
  if (!listing || !listing.id) return res.status(404).json({ error: "listing not found" });
  if (listing.owner_id !== req.user.id) return res.status(403).json({ error: "this is not your listing" });

  const alreadyUsed = await redis.sismember("free_slot:used", req.user.id);
  if (alreadyUsed) {
    return res.status(400).json({ error: "You've already used your free slot — choose a paid plan to activate this listing." });
  }

  const planConfig = await redis.hgetall("subscription_plans:free");
  const durationDays = planConfig?.duration_days ? Number(planConfig.duration_days) : 2;
  const advertsIncluded = planConfig?.adverts_included ? Number(planConfig.adverts_included) : 1;
  const maxImages = planConfig?.max_images ? Number(planConfig.max_images) : 1;

  const expiry = new Date();
  expiry.setDate(expiry.getDate() + durationDays);

  await redis.hset(`listings:${req.params.id}`, {
    status: "active",
    plan: "free",
    subscription_expiry: expiry.toISOString(),
    adverts_included: String(advertsIncluded),
    adverts_used: "0",
    images_allowed: String(maxImages),
  });
  await redis.sadd("free_slot:used", req.user.id);

  res.json({ message: "Free slot activated! Your listing is live for 2 days.", subscription_expiry: expiry.toISOString() });
});
// GET /listings/:id — view a single listing
router.get("/:id", async (req, res) => {
  const listing = await redis.hgetall(`listings:${req.params.id}`);
  if (!listing || !listing.id) return res.status(404).json({ error: "listing not found" });
  res.json({ listing: { ...listing, images: parseImages(listing.images) } });
});
// PUT /listings/:id — owner edits their own listing
router.put("/:id", requireAuth, async (req, res) => {
  const listing = await redis.hgetall(`listings:${req.params.id}`);
  if (!listing || !listing.id) return res.status(404).json({ error: "listing not found" });
  if (listing.owner_id !== req.user.id) return res.status(403).json({ error: "this is not your listing" });

  const { business_name, description, contact } = req.body;
  const updates = {};
  if (business_name) updates.business_name = business_name;
  if (description) updates.description = description;
  if (contact) updates.contact = contact;

  await redis.hset(`listings:${req.params.id}`, updates);
  res.json({ message: "Listing updated" });
});

// DELETE /listings/:id — admin-only, fully removes a listing (used for test/junk cleanup)
router.delete("/:id", requireAdminKey, async (req, res) => {
  const listing = await redis.hgetall(`listings:${req.params.id}`);
  if (!listing || !listing.id) return res.status(404).json({ error: "listing not found" });

  await redis.del(`listings:${req.params.id}`);
  await redis.srem("listings:all", req.params.id);
  await redis.srem("listings:everything", req.params.id);
  if (listing.category) await redis.srem(`listings:by-category:${listing.category}`, req.params.id);
  if (listing.owner_id) await redis.srem(`listings:by-owner:${listing.owner_id}`, req.params.id);

  res.json({ message: "Listing deleted" });
});

// DELETE /listings/:id/images — owner removes one image by URL, freeing up a slot
router.delete("/:id/images", requireAuth, async (req, res) => {
  const { url } = req.body;
  if (!url) return res.status(400).json({ error: "url is required" });

  const listing = await redis.hgetall(`listings:${req.params.id}`);
  if (!listing || !listing.id) return res.status(404).json({ error: "listing not found" });
  if (listing.owner_id !== req.user.id) return res.status(403).json({ error: "this is not your listing" });

  const images = parseImages(listing.images).filter((img) => img !== url);
  await redis.hset(`listings:${req.params.id}`, { images: JSON.stringify(images) });

  res.json({ message: "Image removed", images });
});

module.exports = router;
