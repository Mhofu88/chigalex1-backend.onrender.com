// App Development packages — Starter / Business / Pro.
// These are SEPARATE from subscription_plans (which are for listing/advert
// subscriptions in the marketplace division). These are for your custom
// app-building service itself — the packages shown on the BizApp ZW homepage.
//
// Public GET /app-dev-pricing lets index.html display live prices.
// Admin routes use the same x-admin-key header as the rest of the panel.

const express = require("express");
const { redis } = require("./redis-client");
const { requireAdminKey } = require("./subscriptions-admin");

const router = express.Router();
const MAX_DESCRIPTION_WORDS = 40;

function wordCount(str) {
  return (str || "").trim().split(/\s+/).filter(Boolean).length;
}

// One-time seed — safe to call more than once, only fills missing packages.
async function ensurePackagesSeeded() {
  const defaults = {
    starter: {
      id: "starter",
      name: "Starter",
      tagline: "Get online fast",
      rate: "",
      description: "Simple single-purpose app or landing-page-style app, basic branding.",
    },
    business: {
      id: "business",
      name: "Business",
      tagline: "Run your business from your phone",
      rate: "",
      description: "Multi-feature app with catalog, WhatsApp integration, and basic content updates.",
    },
    pro: {
      id: "pro",
      name: "Pro",
      tagline: "Full custom solution",
      rate: "",
      description: "Custom features, backend/database, and ongoing support.",
    },
  };
  for (const [id, pkg] of Object.entries(defaults)) {
    const exists = await redis.hgetall(`app_dev_packages:${id}`);
    if (!exists || !exists.id) {
      await redis.hset(`app_dev_packages:${id}`, pkg);
      await redis.sadd("app_dev_packages:all", id);
    }
  }
}
ensurePackagesSeeded();

// ---- Public: pricing for index.html ----
router.get("/app-dev-pricing", async (req, res) => {
  const ids = await redis.smembers("app_dev_packages:all");
  const packages = await Promise.all(ids.map((id) => redis.hgetall(`app_dev_packages:${id}`)));
  // Keep a stable Starter/Business/Pro order regardless of Redis's set ordering
  const order = ["starter", "business", "pro"];
  packages.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  res.json({ packages });
});

// ---- Admin: view & edit packages ----
router.get("/admin/app-dev-packages", requireAdminKey, async (req, res) => {
  const ids = await redis.smembers("app_dev_packages:all");
  const packages = await Promise.all(ids.map((id) => redis.hgetall(`app_dev_packages:${id}`)));
  const order = ["starter", "business", "pro"];
  packages.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  res.json({ packages });
});

// PUT /admin/app-dev-packages/:id  { rate, tagline, description }
router.put("/admin/app-dev-packages/:id", requireAdminKey, async (req, res) => {
  const { id } = req.params;
  const existing = await redis.hgetall(`app_dev_packages:${id}`);
  if (!existing || !existing.id) return res.status(404).json({ error: "package not found" });

  const { rate, tagline, description } = req.body;

  if (description && wordCount(description) > MAX_DESCRIPTION_WORDS) {
    return res.status(400).json({ error: `description must be ${MAX_DESCRIPTION_WORDS} words or fewer` });
  }

  const updates = {};
  if (rate !== undefined) updates.rate = String(rate);
  if (tagline !== undefined) updates.tagline = tagline;
  if (description !== undefined) updates.description = description;

  await redis.hset(`app_dev_packages:${id}`, updates);
  res.json({ message: "Package updated" });
});

module.exports = router;
