// Auth routes: register, login, and the requireAuth middleware
// used by listings.js and payments.js to protect routes.
//
// Env vars needed on Render:
//   JWT_SECRET  (any long random string — keep it secret)

const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { redis } = require("./redis-client");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || "change-this-secret";

// POST /auth/register
// pi_username is optional — leaving it blank marks the user as a general (non-pioneer) user.
router.post("/register", async (req, res) => {
  const { username, phone, password, pi_username } = req.body;
  if (!username || !phone || !password) {
    return res.status(400).json({ error: "username, phone, and password are required" });
  }

  const existingId = await redis.get(`users:by-username:${username}`);
  if (existingId) {
    return res.status(409).json({ error: "that username is already taken" });
  }

  const id = `u_${Date.now()}`;
  const password_hash = await bcrypt.hash(password, 10);
  const user = {
    id,
    username,
    phone,
    pi_username: pi_username || "",
    is_pioneer: pi_username ? "true" : "false",
    password_hash,
    created_at: new Date().toISOString(),
  };

  await redis.hset(`users:${id}`, user);
  await redis.set(`users:by-username:${username}`, id);

  const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, user: { id, username, is_pioneer: user.is_pioneer } });
});

// POST /auth/login
router.post("/login", async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password are required" });
  }

  const id = await redis.get(`users:by-username:${username}`);
  if (!id) return res.status(401).json({ error: "invalid username or password" });

  const user = await redis.hgetall(`users:${id}`);
  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) return res.status(401).json({ error: "invalid username or password" });

  const token = jwt.sign({ id, username }, JWT_SECRET, { expiresIn: "30d" });
  res.json({ token, user: { id, username, is_pioneer: user.is_pioneer } });
});

// Middleware — protects any route that requires a logged-in user.
// Usage: router.post('/something', requireAuth, handler)
function requireAuth(req, res, next) {
  const header = req.headers.authorization || "";
  const token = header.replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "missing login token" });

  try {
    req.user = jwt.verify(token, JWT_SECRET); // { id, username }
    next();
  } catch {
    res.status(401).json({ error: "invalid or expired login token" });
  }
}

module.exports = { router, requireAuth };
