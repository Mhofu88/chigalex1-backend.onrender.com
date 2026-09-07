// Paynow-based subscription payments: EcoCash and InnBucks (both USD).
// OneMoney is ZWG-only and can't share this USD integration, so it's
// intentionally not supported here.
//
// Reuses the exact same data model as payments.js and subscriptions-admin.js:
//   - subscription_plans:${id}  (id, name, rate, duration_days, adverts_included, max_images, description)
//   - payments:${id}            (id, listing_id, plan, method, ecocash_reference, amount, status, submitted_by, submitted_at)
//   - payments:pending          (set of payment ids awaiting resolution)
//   - listings:${id}            (status, plan, subscription_expiry, adverts_included, adverts_used, images_allowed)
//   - listings:all              (set)
//
// The only new thing here is *how* a payment gets to "approved" — instead of
// the owner submitting an EcoCash reference for manual review, Paynow confirms
// the payment itself via a webhook, and this activates the listing immediately.
// The payment record still shows up in the existing "Pending Listing Payments"
// admin card (via payments:pending) while it's in flight, and Approve/Reject
// there still work as a manual fallback if the webhook is ever missed.

const express = require("express");
const crypto = require("crypto");
const { Paynow } = require("paynow");
const { redis } = require("./redis-client");
const { requireAuth } = require("./auth");

const router = express.Router();

const paynow = new Paynow(process.env.PAYNOW_ID, process.env.PAYNOW_KEY);
paynow.resultUrl = "https://chigalex1-backend.onrender.com/bizapp/paynow-update";
paynow.returnUrl = "https://bizappzw.co.zw/payment-complete";

function parsePrice(rate) {
  const n = parseFloat(String(rate).replace(/[^0-9.]/g, ""));
  return isNaN(n) ? 0 : n;
}

// Implements Paynow's documented inbound hash check: join every value except
// "hash" (URL-decoded, in the order they appear) into one string, append the
// integration key, SHA512 it, uppercase it, compare to the "hash" field.
// Needs the RAW body string, not the parsed object, since order/encoding
// must exactly match what Paynow sent.
function validatePaynowHash(rawBody) {
  const params = new URLSearchParams(rawBody);
  let joined = "";
  let receivedHash = "";
  for (const [key, value] of params.entries()) {
    if (key === "hash") {
      receivedHash = value;
      continue;
    }
    joined += value; // URLSearchParams already URL-decodes values
  }
  const computed = crypto
    .createHash("sha512")
    .update(joined + process.env.PAYNOW_KEY, "utf8")
    .digest("hex")
    .toUpperCase();
  return computed === receivedHash;
}

// Same activation logic as payments.js's /:id/approve — kept identical on
// purpose so a Paynow-confirmed payment and a manually-approved one produce
// the exact same listing state.
async function activateListingFromPayment(payment) {
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

  return expiry.toISOString();
}

// POST /bizapp/subscribe — owner picks a plan + Paynow method, this
// initiates the Paynow payment and creates a pending payment record.
// Body: { listing_id, plan, method, phone }
// method: "ecocash" | "innbucks"
router.post("/bizapp/subscribe", requireAuth, async (req, res) => {
  const { listing_id, plan, method, phone } = req.body;
  if (!listing_id || !plan || !method || !phone) {
    return res.status(400).json({ error: "listing_id, plan, method, and phone are required" });
  }
  if (!["ecocash", "innbucks"].includes(method)) {
    return res.status(400).json({ error: "method must be ecocash or innbucks" });
  }

  const planConfig = await redis.hgetall(`subscription_plans:${plan}`);
  if (!planConfig || !planConfig.id) {
    return res.status(404).json({ error: "unknown plan" });
  }

  const amount = parsePrice(planConfig.rate);
  const id = `pay_${Date.now()}`;

  try {
    // In test mode, Paynow requires authemail to match your Paynow account's
    // own login email — set PAYNOW_TEST_EMAIL on Render to that address.
    // Once live, req.user.email (once your JWT/user record includes one) can
    // take over; for now this fallback covers both cases.
    const authEmail = req.user.email || process.env.PAYNOW_TEST_EMAIL || `${req.user.id}@bizappzw.co.zw`;
    const payment = paynow.createPayment(id, authEmail);
    payment.add(`BizApp ZW ${planConfig.name} listing`, amount);

    const response = await paynow.sendMobile(payment, phone, method);
    if (!response.success) {
      return res.status(400).json({ error: response.error });
    }

    const record = {
      id,
      listing_id,
      plan,
      method,
      ecocash_reference: response.pollUrl, // reusing the existing field name for the poll URL
      amount: String(amount),
      status: "pending_paynow",
      submitted_by: req.user.id,
      submitted_at: new Date().toISOString(),
    };
    await redis.hset(`payments:${id}`, record);
    await redis.sadd("payments:pending", id);

    if (method === "innbucks") {
      return res.json({
        payment_id: id,
        instructions: response.instructions,
        authorizationCode: response.authorizationcode,
        deepLink: `schinn.wbpycode://innbucks.co.zw?pymInnCode=${response.authorizationcode}`,
        qrUrl: `https://chart.googleapis.com/chart?cht=qr&chs=200x200&chl=${response.authorizationcode}`,
        pollUrl: response.pollUrl,
      });
    }

    // ecocash
    res.json({ payment_id: id, instructions: response.instructions, pollUrl: response.pollUrl });
  } catch (err) {
    console.error("Paynow subscribe error:", err);
    res.status(500).json({ error: "payment initiation failed" });
  }
});

// POST /bizapp/paynow-update — Paynow's webhook (resultUrl). Verifies the
// inbound hash before trusting anything in the payload — see
// validatePaynowHash() above. Uses express.text() to get the raw body,
// since hash validation needs the exact wire format, not the parsed object.
router.post(
  "/bizapp/paynow-update",
  express.text({ type: () => true }),
  async (req, res) => {
    try {
      const rawBody = req.body;
      if (!validatePaynowHash(rawBody)) {
        console.warn("Paynow webhook: hash mismatch, rejecting");
        return res.sendStatus(400);
      }

      const status = Object.fromEntries(new URLSearchParams(rawBody));
      if (status.status === "Paid") {
        const payment = await redis.hgetall(`payments:${status.reference}`);
        if (payment && payment.id) {
          await activateListingFromPayment(payment);
        }
      }
      res.sendStatus(200);
    } catch (err) {
      console.error("Paynow webhook error:", err);
      res.sendStatus(500);
    }
  }
);

module.exports = router;
