// Shared Upstash Redis client — same service your Chigalex1 backend already uses.
// Needs these two environment variables set on Render:
//   UPSTASH_REDIS_REST_URL
//   UPSTASH_REDIS_REST_TOKEN

const { Redis } = require("@upstash/redis");

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

module.exports = { redis };
