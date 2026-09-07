// Subscription plans, advert charges, and payment options — admin-configurable.
// Public GET /pricing lets the listings page display current rates (no auth needed).
// Everything under /admin/* is protected by the same x-admin-key header your
// existing admin routes already use (checked against process.env.ADMIN_KEY).

const express = require("express");
const { redis } = require("./redis-client");

const router = express.Router();
const MAX_DESCRIPTION_WORDS = 40;

function requireAdminKey(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== process.env.ADMIN_KEY) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

function wordCount(str) {
  return (str || "").trim().split(/\s+/).filter(Boolean).length;
}

// One-time seed of the three fixed tiers — safe to call more than once,
// only fills in plans that don't exist yet.
async function ensurePlansSeeded() {
  const defaults = {
 free: {
      id: "free",
      name: "Free Slot",
      duration_days: 2,
      adverts_included: 1,
      max_images: 1,
      rate: "",
      description: "Try it free for 2 days — one photo, one advert. First-time advertisers only.",
    },   
onetime: {
      id: "onetime",
      name: "One-Time",
      duration_days: 14,
      adverts_included: 1,
      max_images: 1,
      rate: "",
      description: "A single listing live for 2 weeks.",
    },
    monthly: {
      id: "monthly",
      name: "Monthly",
      duration_days: 30,
      adverts_included: 2,
      max_images: 3,
      rate: "",
      description: "1 month of listing, includes 2 adverts.",
    },
    annual: {
      id: "annual",
      name: "Annual",
      duration_days: 365,
      adverts_included: 5,
      max_images: 5,
      rate: "",
      description: "Full year, up to 5 adverts per month.",
    },
  };
  for (const [id, plan] of Object.entries(defaults)) {
    const exists = await redis.hgetall(`subscription_plans:${id}`);
    if (!exists || !exists.id) {
      await redis.hset(`subscription_plans:${id}`, plan);
      await redis.sadd("subscription_plans:all", id);
    }
  }
}
ensurePlansSeeded();

// ---- Public: pricing for the listings page ----
router.get("/pricing", async (req, res) => {
  const ids = await redis.smembers("subscription_plans:all");
  const plans = await Promise.all(ids.map((id) => redis.hgetall(`subscription_plans:${id}`)));
  const advertCharge = await redis.hgetall("advert_charges:extra");
  const paymentMethods = await redis.smembers("payment_options:enabled");
  const paymentDetails = await redis.hgetall("payment_options:details");
  res.json({
    plans,
    extra_advert_rate: advertCharge?.rate || "",
    payment_methods: paymentMethods,
    payment_details: paymentDetails || {},
  });
});

// ---- Admin: view & edit subscription plans ----
router.get("/admin/subscriptions", requireAdminKey, async (req, res) => {
  const ids = await redis.smembers("subscription_plans:all");
  const plans = await Promise.all(ids.map((id) => redis.hgetall(`subscription_plans:${id}`)));
  res.json({ plans });
});

router.put("/admin/subscriptions/:id", requireAdminKey, async (req, res) => {
  const { id } = req.params;
  const existing = await redis.hgetall(`subscription_plans:${id}`);
  if (!existing || !existing.id) return res.status(404).json({ error: "plan not found" });

  const { rate, duration_days, adverts_included, max_images, description } = req.body;

  if (description && wordCount(description) > MAX_DESCRIPTION_WORDS) {
    return res.status(400).json({ error: `description must be ${MAX_DESCRIPTION_WORDS} words or fewer` });
  }

  const updates = {};
  if (rate !== undefined) updates.rate = String(rate);
  if (duration_days !== undefined) updates.duration_days = String(duration_days);
  if (adverts_included !== undefined) updates.adverts_included = String(adverts_included);
  if (max_images !== undefined) updates.max_images = String(max_images);
  if (description !== undefined) updates.description = description;

  await redis.hset(`subscription_plans:${id}`, updates);
  res.json({ message: "Plan updated" });
});

// ---- Admin: advert charges ----
router.get("/admin/advert-charges", requireAdminKey, async (req, res) => {
  const charge = await redis.hgetall("advert_charges:extra");
  res.json({ extra_advert_rate: charge?.rate || "" });
});

router.put("/admin/advert-charges", requireAdminKey, async (req, res) => {
  const { rate } = req.body;
  if (rate === undefined) return res.status(400).json({ error: "rate is required" });
  await redis.hset("advert_charges:extra", { rate: String(rate) });
  res.json({ message: "Advert charge updated" });
});

// ---- Admin: payment options ----
router.get("/admin/payment-options", requireAdminKey, async (req, res) => {
  const enabled = await redis.smembers("payment_options:enabled");
  const details = await redis.hgetall("payment_options:details");
  res.json({ enabled, details });
});

router.put("/admin/payment-options", requireAdminKey, async (req, res) => {
  const { method, enabled, detail } = req.body;
  if (!method) return res.status(400).json({ error: "method is required" });

  if (enabled) {
    await redis.sadd("payment_options:enabled", method);
  } else {
    await redis.srem("payment_options:enabled", method);
  }
  if (detail !== undefined) {
    await redis.hset("payment_options:details", { [method]: detail });
  }
  res.json({ message: "Payment option updated" });
});

module.exports = { router, requireAdminKey };
