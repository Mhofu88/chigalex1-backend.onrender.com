// Manual EcoCash payment flow:
//   1. Business owner sends EcoCash payment to your number (shown in the frontend).
//   2. Owner submits the EcoCash reference number via POST /payments/submit.
//   3. You (admin) review it in the Chigalex1 Admin Panel and approve — this
//      activates the listing using the matching plan's duration/advert allowance.
//
// Customer-facing routes (submit) use the JWT login from auth.js.
// Admin-facing routes (pending/approve/reject) use the same x-admin-key
// header your existing admin panel already sends — imported from subscriptions-admin.js
// so there's only one place that checks it.

const express = require("express");
const { redis } = require("./redis-client");
const { requireAuth } = require("./auth");
const { requireAdminKey } = require("./subscriptions-admin");

const router = express.Router();

// POST /payments/submit — owner submits proof of EcoCash payment
router.post("/submit", requireAuth, async (req, res) => {
  const { listing_id, plan, ecocash_reference, amount } = req.body;
  if (!listing_id || !plan || !ecocash_reference) {
    return res.status(400).json({ error: "listing_id, plan, and ecocash_reference are required" });
  }

  const id = `pay_${Date.now()}`;
  const payment = {
    id,
    listing_id,
    plan, // "onetime" | "monthly" | "annual"
    method: "ecocash",
    ecocash_reference,
    amount: amount || "",
    status: "pending_review",
    submitted_by: req.user.id,
    submitted_at: new Date().toISOString(),
  };

  await redis.hset(`payments:${id}`, payment);
  await redis.sadd("payments:pending", id);

  res.json({ message: "Payment submitted — you'll be notified once it's approved", payment });
});

// GET /payments/pending — admin: see everything awaiting review
router.get("/pending", requireAdminKey, async (req, res) => {
  const ids = await redis.smembers("payments:pending");
  const payments = await Promise.all(ids.map((id) => redis.hgetall(`payments:${id}`)));
  res.json({ payments });
});

// POST /payments/:id/approve — admin: approve and activate the listing
// using the plan's configured duration and advert allowance.
router.post("/:id/approve", requireAdminKey, async (req, res) => {
  const payment = await redis.hgetall(`payments:${req.params.id}`);
  if (!payment || !payment.id) return res.status(404).json({ error: "payment not found" });

  const planConfig = await redis.hgetall(`subscription_plans:${payment.plan}`);
  const durationDays = planConfig?.duration_days ? Number(planConfig.duration_days) : 30;
  const advertsIncluded = planConfig?.adverts_included ? Number(planConfig.adverts_included) : 1;
  const maxImages = planConfig?.max_images ? Number(planConfig.max_images) : 1;

  const expiry = new Date();
  expiry.setDate(expiry.getDate() + durationDays);

  await redis.hset(`listings:${payment.listing_id}`, {
    status: "active",
    plan: payment.plan,
    subscription_expiry: expiry.toISOString(),
    adverts_included: String(advertsIncluded),
    adverts_used: "0",
    images_allowed: String(maxImages),
  });
  await redis.sadd("listings:all", payment.listing_id);
  await redis.hset(`payments:${payment.id}`, { status: "approved" });
  await redis.srem("payments:pending", payment.id);

  res.json({ message: "Listing activated", subscription_expiry: expiry.toISOString() });
});

// POST /payments/:id/reject — admin: reject a submitted payment
router.post("/:id/reject", requireAdminKey, async (req, res) => {
  await redis.hset(`payments:${req.params.id}`, { status: "rejected" });
  await redis.srem("payments:pending", req.params.id);
  res.json({ message: "Payment rejected" });
});

module.exports = router;
