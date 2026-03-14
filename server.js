// ─── BROTHERS OF ST. HYACINTH — BACKEND SERVER (Postgres) ───────────────────
//
// Stack: Node.js + Express + PostgreSQL (via pg) + JWT auth
//
// API SURFACE:
//   POST   /api/auth/register         — create account
//   POST   /api/auth/login            — log in, receive JWT
//   GET    /api/auth/me               — verify token, return user info
//   DELETE /api/auth/account          — delete own account (password x2)
//   GET    /api/community/users       — all users' lift logs (excluding caller)
//   GET    /api/logs                  — caller's own lift logs
//   POST   /api/logs                  — add a lift log entry
//   DELETE /api/logs/:id              — delete one lift log entry
//   GET    /api/board/messages        — all board messages
//   POST   /api/board/messages        — post a new message
//   POST   /api/board/reactions       — toggle a reaction on a message
//   GET    /api/push/vapid-public-key   — get VAPID public key
//   POST   /api/push/subscribe          — save push subscription
//   DELETE /api/push/subscribe          — remove push subscription
//
// BACKGROUND JOBS:
//   On boot + every 6h: purge orphan Cloudinary assets, then delete oldest
//   messages if Postgres >90% or Cloudinary >90% full (target: 80%)
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const { Pool } = require("pg");
const cloudinary  = require("cloudinary").v2;
const multer      = require("multer");
const streamifier = require("streamifier");
const webpush     = require("web-push");

const app        = express();
const PORT       = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_THIS_IN_ENV";

// ── Cloudinary ────────────────────────────────────────────────────────────────
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// Multer — memory storage (no disk writes; we stream directly to Cloudinary)
const upload = multer({
  storage: multer.memoryStorage(),
  limits:  { fileSize: 100 * 1024 * 1024 }, // 100 MB max
});

// ── Web Push (VAPID) ──────────────────────────────────────────────────────────
// Generate keys once with: node -e "const wp=require('web-push');console.log(wp.generateVAPIDKeys())"
// Then set VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY in Railway environment variables.
if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(
    "mailto:graftonlagarde@protonmail.com",
    process.env.VAPID_PUBLIC_KEY,
    process.env.VAPID_PRIVATE_KEY
  );
}
const POSTGRES_LIMIT_BYTES    = 1 * 1024 * 1024 * 1024; // 1 GB (Railway free tier)
const CLOUDINARY_LIMIT_BYTES  = 25 * 1024 * 1024 * 1024; // 25 GB (Cloudinary free tier)
const CLEANUP_THRESHOLD       = 0.90; // trigger at 90%
const CLEANUP_TARGET          = 0.80; // clean down to 80%

// ── Database ──────────────────────────────────────────────────────────────────
// Railway injects DATABASE_URL automatically when you add a Postgres addon.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const db = {
  query: (sql, params) => pool.query(sql, params),
};

// ── Storage cleanup ───────────────────────────────────────────────────────────

// ── Stream a buffer directly to Cloudinary (no temp files) ───────────────────
function streamUploadToCloudinary(buffer, options) {
  return new Promise((resolve, reject) => {
    const stream = cloudinary.uploader.upload_stream(options, (err, result) => {
      if (err) reject(err);
      else resolve(result);
    });
    streamifier.createReadStream(buffer).pipe(stream);
  });
}

// ── Delete stale pending uploads (abandoned before send) ──────────────────────
async function purgeStaleUploads() {
  try {
    const STALE_MS = 30 * 60 * 1000; // 30 minutes
    const cutoff   = Date.now() - STALE_MS;
    const { rows } = await db.query(
      "SELECT public_id, resource_type FROM pending_uploads WHERE uploaded_at < $1",
      [cutoff]
    );
    if (rows.length === 0) return;
    for (const row of rows) {
      try {
        await cloudinary.uploader.destroy(row.public_id, { resource_type: row.resource_type });
      } catch (e) {
        console.warn(`⚠ Could not delete stale Cloudinary asset ${row.public_id}:`, e.message);
      }
      await db.query("DELETE FROM pending_uploads WHERE public_id = $1", [row.public_id]);
    }
    console.log(`🧹 Purged ${rows.length} stale upload(s).`);
  } catch (err) {
    console.error("purgeStaleUploads error:", err.message);
  }
}

async function deleteCloudinaryAsset(publicId) {
  if (!publicId) return;
  try {
    await cloudinary.uploader.destroy(publicId, { resource_type: "auto" });
  } catch (err) {
    console.warn(`⚠ Cloudinary delete failed for ${publicId}:`, err.message);
  }
}

async function purgeOrphanCloudinaryAssets() {
  try {
    const { rows } = await db.query(
      "SELECT media_public_id FROM messages WHERE media_public_id IS NOT NULL"
    );
    const knownIds = new Set(rows.map(r => r.media_public_id));
    let nextCursor = null;
    let orphanCount = 0;
    do {
      const params = { max_results: 500, resource_type: "auto" };
      if (nextCursor) params.next_cursor = nextCursor;
      const result = await cloudinary.api.resources(params);
      for (const asset of result.resources) {
        if (!knownIds.has(asset.public_id)) {
          await cloudinary.uploader.destroy(asset.public_id, { resource_type: "auto" });
          orphanCount++;
        }
      }
      nextCursor = result.next_cursor;
    } while (nextCursor);
    if (orphanCount > 0) console.log(`🧹 Purged ${orphanCount} orphan Cloudinary assets.`);
  } catch (err) {
    console.error("purgeOrphanCloudinaryAssets error:", err.message);
  }
}

async function getStorageUsage() {
  let pgBytes = 0;
  try {
    const { rows } = await db.query("SELECT pg_database_size(current_database()) AS size");
    pgBytes = Number(rows[0].size);
  } catch (err) {
    console.error("Could not read Postgres size:", err.message);
  }
  let cloudinaryBytes = 0;
  try {
    const usage = await cloudinary.api.usage();
    cloudinaryBytes = usage.storage.usage;
  } catch (err) {
    console.error("Could not read Cloudinary usage:", err.message);
  }
  return {
    pg:         { bytes: pgBytes,         limit: POSTGRES_LIMIT_BYTES,  pct: pgBytes / POSTGRES_LIMIT_BYTES },
    cloudinary: { bytes: cloudinaryBytes, limit: CLOUDINARY_LIMIT_BYTES, pct: cloudinaryBytes / CLOUDINARY_LIMIT_BYTES },
  };
}

async function runStorageCleanup() {
  try {
    const usage = await getStorageUsage();
    console.log(`📊 Storage — Postgres: ${(usage.pg.pct*100).toFixed(1)}% | Cloudinary: ${(usage.cloudinary.pct*100).toFixed(1)}%`);
    if (usage.pg.pct < CLEANUP_THRESHOLD && usage.cloudinary.pct < CLEANUP_THRESHOLD) return;
    console.log("⚠ Storage threshold exceeded — beginning cleanup…");
    let freed = 0;
    // First: delete oldest media messages (frees both Cloudinary and Postgres)
    while (true) {
      const u = await getStorageUsage();
      if (u.pg.pct < CLEANUP_TARGET && u.cloudinary.pct < CLEANUP_TARGET) break;
      const { rows } = await db.query(
        "SELECT id, media_public_id FROM messages WHERE media_public_id IS NOT NULL ORDER BY ts ASC LIMIT 10"
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        await deleteCloudinaryAsset(row.media_public_id);
        await db.query("DELETE FROM messages WHERE id = $1", [row.id]);
        freed++;
      }
    }
    // Second: delete oldest text-only messages if Postgres still too full
    while (true) {
      const u = await getStorageUsage();
      if (u.pg.pct < CLEANUP_TARGET) break;
      const { rows } = await db.query(
        "SELECT id FROM messages WHERE media_public_id IS NULL ORDER BY ts ASC LIMIT 20"
      );
      if (rows.length === 0) break;
      for (const row of rows) {
        await db.query("DELETE FROM messages WHERE id = $1", [row.id]);
        freed++;
      }
    }
    if (freed > 0) console.log(`✅ Cleanup complete — deleted ${freed} messages.`);
  } catch (err) {
    console.error("runStorageCleanup error:", err.message);
  }
}

// ── Create tables on first boot ───────────────────────────────────────────────
async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      first_name  TEXT NOT NULL,
      last_name   TEXT NOT NULL,
      email       TEXT NOT NULL UNIQUE,
      password    TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'user',
      created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS lift_logs (
      id          SERIAL PRIMARY KEY,
      user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      exercise    TEXT NOT NULL,
      rep_cat     INTEGER NOT NULL,
      weight      NUMERIC NOT NULL,
      date        TEXT NOT NULL,
      ts          BIGINT NOT NULL,
      created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS messages (
      id               SERIAL PRIMARY KEY,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      author           TEXT NOT NULL,
      ts               BIGINT NOT NULL,
      text             TEXT NOT NULL DEFAULT '',
      media_url        TEXT,
      media_type       TEXT,
      media_bytes      INTEGER DEFAULT 0,
      media_public_id  TEXT,
      is_system        BOOLEAN NOT NULL DEFAULT FALSE,
      created_at       BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS reactions (
      message_id  INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      emoji       TEXT NOT NULL,
      username    TEXT NOT NULL,
      PRIMARY KEY (message_id, emoji, username)
    );

    CREATE TABLE IF NOT EXISTS pending_uploads (
      id            SERIAL PRIMARY KEY,
      public_id     TEXT NOT NULL UNIQUE,
      resource_type TEXT NOT NULL DEFAULT 'image',
      user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      uploaded_at   BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint   TEXT NOT NULL UNIQUE,
      p256dh     TEXT NOT NULL,
      auth       TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS unread_counts (
      user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      count   INTEGER NOT NULL DEFAULT 0
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token      TEXT NOT NULL UNIQUE,
      expires_at BIGINT NOT NULL
    );
  `);
  await db.query(`
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';
  `);

  // Ensure the arch-admin account always has the correct role
  await db.query(`
    UPDATE users SET role = 'arch_admin'
    WHERE LOWER(email) = LOWER('graftonlagarde@protonmail.com');
  `);

  console.log("✅ Database tables ready.");
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

// Serve /public folder (FBX models, audio files, etc.)
const publicDir = path.join(__dirname, "public");
if (fs.existsSync(publicDir)) {
  app.use(express.static(publicDir));
} else {
  console.warn("No /public folder found — static assets will not be served.");
}

// Serve React build folder
const buildDir = path.join(__dirname, "build");
if (fs.existsSync(buildDir)) {
  app.use(express.static(buildDir));
} else {
  console.warn("No /build folder found — run npm run build to generate it.");
}

// ── Auth helpers ───────────────────────────────────────────────────────────────
const signToken = (userId) =>
  jwt.sign({ sub: userId }, JWT_SECRET, { expiresIn: "90d" });

const requireAuth = (req, res, next) => {
  const header = req.headers.authorization || "";
  const token  = header.startsWith("Bearer ") ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: "Not authenticated" });
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

const displayName = (u) => `${u.first_name} ${u.last_name}`;
const shapeUser = (u) => ({
  id:          Number(u.id),
  firstName:   u.first_name,
  lastName:    u.last_name,
  email:       u.email,
  displayName: displayName(u),
  role:        u.role,
});

// Middleware: require arch_admin or admin role
const requireAdmin = async (req, res, next) => {
  try {
    const { rows } = await db.query("SELECT role FROM users WHERE id = $1", [req.userId]);
    const user = rows[0];
    if (!user || (user.role !== 'arch_admin' && user.role !== 'admin'))
      return res.status(403).json({ error: "Forbidden." });
    req.userRole = user.role;
    next();
  } catch (err) {
    return res.status(500).json({ error: "Server error." });
  }
};

// ── Helper: load reactions for an array of message ids ────────────────────────
async function loadReactions(messageIds) {
  if (!messageIds.length) return {};
  const placeholders = messageIds.map((_, i) => `$${i + 1}`).join(", ");
  const { rows } = await db.query(
    `SELECT message_id, emoji, username FROM reactions WHERE message_id IN (${placeholders})`,
    messageIds
  );
  const map = {};
  for (const r of rows) {
    if (!map[r.message_id]) map[r.message_id] = {};
    if (!map[r.message_id][r.emoji]) map[r.message_id][r.emoji] = [];
    map[r.message_id][r.emoji].push(r.username);
  }
  return map;
}

// ── Helper: shape a message row for the client ────────────────────────────────
const shapeMessage = (row, reactionsMap) => ({
  id:        Number(row.id),
  author:    row.author,
  ts:        Number(row.ts),
  text:      row.text,
  media:     row.media_url ? {
    dataUrl:  row.media_url,
    type:     row.media_type,
    bytes:    row.media_bytes,
    publicId: row.media_public_id,
    isVideo:  (row.media_type || "").startsWith("video/"),
  } : null,
  isSystem:  row.is_system,
  reactions: reactionsMap[Number(row.id)] || {},
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.post("/api/auth/register", async (req, res) => {
  try {
    const { firstName, lastName, email, password } = req.body;
    if (!firstName?.trim() || !lastName?.trim() || !email?.trim() || !password)
      return res.status(400).json({ error: "All fields are required." });
    if (password.length < 8)
      return res.status(400).json({ error: "Password must be at least 8 characters." });

    const existing = await db.query("SELECT id FROM users WHERE LOWER(email) = LOWER($1)", [email.trim()]);
    if (existing.rows.length)
      return res.status(409).json({ error: "An account with that email already exists." });

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await db.query(
      "INSERT INTO users (first_name, last_name, email, password) VALUES ($1,$2,$3,$4) RETURNING *",
      [firstName.trim(), lastName.trim(), email.trim().toLowerCase(), hash]
    );
    const user  = rows[0];
    const token = signToken(user.id);
    return res.status(201).json({
      token,
      user: shapeUser(user),
    });
  } catch (err) {
    console.error("register:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/auth/login", async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password)
      return res.status(400).json({ error: "Email and password are required." });

    const { rows } = await db.query(
      "SELECT * FROM users WHERE LOWER(email) = LOWER($1)", [email.trim()]
    );
    const user = rows[0];
    if (!user) return res.status(401).json({ error: "Incorrect email or password." });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Incorrect email or password." });

    const token = signToken(user.id);
    return res.json({
      token,
      user: shapeUser(user),
    });
  } catch (err) {
    console.error("login:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query("SELECT * FROM users WHERE id = $1", [req.userId]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: "User not found." });
    return res.json({
      user: shapeUser(user),
    });
  } catch (err) {
    console.error("me:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

app.delete("/api/auth/account", requireAuth, async (req, res) => {
  try {
    const { password, passwordConfirm } = req.body;
    if (!password || password !== passwordConfirm)
      return res.status(400).json({ error: "Passwords do not match." });

    const { rows } = await db.query("SELECT * FROM users WHERE id = $1", [req.userId]);
    const user = rows[0];
    if (!user) return res.status(404).json({ error: "User not found." });

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.status(401).json({ error: "Incorrect password." });

    await db.query("DELETE FROM users WHERE id = $1", [req.userId]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("deleteAccount:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

// POST /api/auth/forgot-password — send a reset link via Resend API (no SMTP needed)
// Required env var: RESEND_API_KEY (from resend.com)
app.post("/api/auth/forgot-password", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required." });
  try {
    const { rows } = await db.query("SELECT id FROM users WHERE LOWER(email) = LOWER($1)", [email]);
    // Always return 200 — don't reveal whether email exists
    if (!rows.length) return res.json({ ok: true });
    const userId = rows[0].id;

    // Generate a secure random token, expires in 1 hour
    const token     = require("crypto").randomBytes(32).toString("hex");
    const expiresAt = Date.now() + 60 * 60 * 1000;

    // Delete any existing reset token for this user, then insert fresh one
    await db.query("DELETE FROM password_resets WHERE user_id = $1", [userId]);
    await db.query(
      "INSERT INTO password_resets (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [userId, token, expiresAt]
    );

    const appUrl   = process.env.APP_URL || "https://bros-of-st-hyacinth.vercel.app";
    const resetUrl = `${appUrl}?reset=${token}`;

    if (!process.env.RESEND_API_KEY) {
      console.warn("forgot-password: RESEND_API_KEY not set — reset URL:", resetUrl);
      return res.status(500).json({ error: "Email sending is not configured on this server." });
    }

    // Send via Resend REST API — no SMTP, no extra packages
    try {
      const mailRes = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
          "Content-Type":  "application/json",
        },
        body: JSON.stringify({
          from:    process.env.RESEND_FROM || "Bros of St. Hyacinth <onboarding@resend.dev>",
          to:      [email],
          subject: "Password Reset — Bros of St. Hyacinth",
          text:    `You requested a password reset. Click the link below to set a new password (expires in 1 hour):\n\n${resetUrl}\n\nIf you did not request this, you can safely ignore this email.`,
          html:    `<p>You requested a password reset.</p>
                    <p>Click the link below to set a new password (expires in 1 hour):</p>
                    <p><a href="${resetUrl}">${resetUrl}</a></p>
                    <p>If you did not request this, you can safely ignore this email.</p>`,
        }),
      });
      if (!mailRes.ok) {
        const errBody = await mailRes.text();
        console.error("forgot-password Resend error:", mailRes.status, errBody);
        return res.status(500).json({ error: "Failed to send reset email." });
      }
    } catch (mailErr) {
      console.error("forgot-password mail error:", mailErr.message);
      return res.status(500).json({ error: "Failed to send reset email." });
    }

    return res.json({ ok: true });
  } catch (err) {
    console.error("forgot-password:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

// POST /api/auth/reset-password — validate token and update password
app.post("/api/auth/reset-password", async (req, res) => {
  const { token, password } = req.body;
  if (!token || !password) return res.status(400).json({ error: "Token and password are required." });
  if (password.length < 8)  return res.status(400).json({ error: "Password must be at least 8 characters." });
  try {
    const { rows } = await db.query(
      "SELECT user_id, expires_at FROM password_resets WHERE token = $1",
      [token]
    );
    if (!rows.length)               return res.status(400).json({ error: "Invalid or expired reset link." });
    if (Date.now() > rows[0].expires_at) {
      await db.query("DELETE FROM password_resets WHERE token = $1", [token]);
      return res.status(400).json({ error: "Reset link has expired. Please request a new one." });
    }
    const hashed = await bcrypt.hash(password, 12);
    await db.query("UPDATE users SET password = $1 WHERE id = $2", [hashed, rows[0].user_id]);
    await db.query("DELETE FROM password_resets WHERE token = $1", [token]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("reset-password:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// LIFT LOG ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.get("/api/logs", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT * FROM lift_logs WHERE user_id = $1 ORDER BY ts ASC", [req.userId]
    );
    return res.json(rows.map(r => ({
      id:       Number(r.id),
      exercise: r.exercise,
      repCat:   r.rep_cat,
      weight:   Number(r.weight),
      date:     r.date,
      ts:       Number(r.ts),
    })));
  } catch (err) {
    console.error("getLogs:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/logs", requireAuth, async (req, res) => {
  try {
    const { exercise, repCat, weight, date, ts } = req.body;
    if (!exercise || repCat == null || weight == null || !date || !ts)
      return res.status(400).json({ error: "Missing required fields." });

    const { rows } = await db.query(
      "INSERT INTO lift_logs (user_id, exercise, rep_cat, weight, date, ts) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id",
      [req.userId, exercise, repCat, weight, date, ts]
    );
    return res.status(201).json({ id: Number(rows[0].id) });
  } catch (err) {
    console.error("addLog:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

app.delete("/api/logs/:id", requireAuth, async (req, res) => {
  try {
    const { rowCount } = await db.query(
      "DELETE FROM lift_logs WHERE id = $1 AND user_id = $2", [req.params.id, req.userId]
    );
    if (rowCount === 0) return res.status(404).json({ error: "Log not found." });
    return res.json({ ok: true });
  } catch (err) {
    console.error("deleteLog:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

app.get("/api/community/users", requireAuth, async (req, res) => {
  try {
    const { rows: users } = await db.query(
      "SELECT * FROM users WHERE id != $1", [req.userId]
    );
    const result = await Promise.all(users.map(async (u) => {
      const { rows: logs } = await db.query(
        "SELECT exercise, rep_cat, weight, ts FROM lift_logs WHERE user_id = $1 ORDER BY ts ASC",
        [u.id]
      );
      const shaped = {};
      for (const l of logs) {
        if (!shaped[l.exercise]) shaped[l.exercise] = {};
        const key = String(l.rep_cat);
        if (!shaped[l.exercise][key]) shaped[l.exercise][key] = [];
        shaped[l.exercise][key].push({ weight: Number(l.weight), ts: Number(l.ts) });
      }
      return { name: displayName(u), logs: shaped };
    }));
    return res.json(result);
  } catch (err) {
    console.error("communityUsers:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// UPLOAD ROUTE — proxies file to Cloudinary, tracks public_id in pending_uploads
// ═════════════════════════════════════════════════════════════════════════════

app.post("/api/upload", requireAuth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided." });

    const mime          = req.file.mimetype;
    const isVideoOrAudio = mime.startsWith("video/") || mime.startsWith("audio/");
    const resourceType  = isVideoOrAudio ? "video" : "image"; // Cloudinary uses "video" for audio too

    const result = await streamUploadToCloudinary(req.file.buffer, {
      resource_type: resourceType,
      folder:        "bros-of-st-hyacinth",
    });

    // Record as pending — will be removed when the message is actually sent
    await db.query(
      "INSERT INTO pending_uploads (public_id, resource_type, user_id) VALUES ($1,$2,$3) ON CONFLICT (public_id) DO NOTHING",
      [result.public_id, resourceType, req.userId]
    );

    return res.json({
      url:      result.secure_url,
      publicId: result.public_id,
      bytes:    result.bytes ?? 0,
    });
  } catch (err) {
    console.error("upload:", err);
    return res.status(500).json({ error: "Upload failed: " + err.message });
  }
});

// ── Push notification helper ───────────────────────────────────────────────────
// Increment unread count for a user and return the new total
async function incrementUnread(userId) {
  const { rows } = await db.query(`
    INSERT INTO unread_counts (user_id, count) VALUES ($1, 1)
    ON CONFLICT (user_id) DO UPDATE SET count = unread_counts.count + 1
    RETURNING count
  `, [userId]);
  return rows[0]?.count ?? 1;
}

async function sendPushToUser(userId, payload) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  try {
    // Increment unread count and attach to payload so service worker can set badge
    const badge = await incrementUnread(userId);
    const fullPayload = { ...payload, badge };

    const { rows } = await db.query(
      "SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1",
      [userId]
    );
    for (const sub of rows) {
      try {
        await webpush.sendNotification(
          { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
          JSON.stringify(fullPayload)
        );
      } catch (err) {
        // 410 Gone = subscription expired/revoked — remove it
        if (err.statusCode === 410 || err.statusCode === 404) {
          await db.query("DELETE FROM push_subscriptions WHERE endpoint = $1", [sub.endpoint]);
        } else {
          console.warn(`Push failed for user ${userId}:`, err.message);
        }
      }
    }
  } catch (err) {
    console.error("sendPushToUser error:", err.message);
  }
}

// ═════════════════════════════════════════════════════════════════════════════
// LINK PREVIEW ROUTE
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/link-preview?url=... — fetches rich preview data for any URL.
// Strategy:
//   1. Try oEmbed (YouTube, Vimeo, Twitter/X support it natively — returns title+thumbnail)
//   2. Fall back to scraping Open Graph / Twitter Card meta tags from the HTML
app.get("/api/link-preview", requireAuth, async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: "url is required" });
  let parsed;
  try { parsed = new URL(url); } catch { return res.status(400).json({ error: "Invalid URL" }); }

  const domain = parsed.hostname.replace(/^www\./, "");
  const signal = AbortSignal.timeout(7000);
  const browserUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

  // ── Step 1: oEmbed ─────────────────────────────────────────────────────────
  // These providers expose a JSON endpoint with title, author, thumbnail — no scraping needed.
  const oEmbedEndpoint = (() => {
    const enc = encodeURIComponent(url);
    if (/youtube\.com|youtu\.be/.test(parsed.hostname))
      return `https://www.youtube.com/oembed?url=${enc}&format=json`;
    if (/vimeo\.com/.test(parsed.hostname))
      return `https://vimeo.com/api/oembed.json?url=${enc}`;
    if (/twitter\.com|x\.com/.test(parsed.hostname))
      return `https://publish.twitter.com/oembed?url=${enc}&omit_script=true`;
    if (/reddit\.com/.test(parsed.hostname))
      return `https://www.reddit.com/oembed?url=${enc}`;
    return null;
  })();

  if (oEmbedEndpoint) {
    try {
      const r = await fetch(oEmbedEndpoint, {
        headers: { "User-Agent": browserUA },
        signal,
        redirect: "follow",
      });
      if (r.ok) {
        const d = await r.json();
        // oEmbed gives us: title, author_name, thumbnail_url, provider_name
        if (d.title) {
          return res.json({
            title:       d.title,
            description: d.author_name ? `By ${d.author_name}` : null,
            image:       d.thumbnail_url || null,
            siteName:    d.provider_name || null,
            domain,
            url,
          });
        }
      }
    } catch (_) { /* fall through to OG scrape */ }
  }

  // ── Step 2: OG / Twitter Card scrape ──────────────────────────────────────
  // Extract every <meta> tag as a raw string so multi-line tags work (YouTube,
  // Instagram etc. put property= and content= on separate lines).
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": browserUA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.5",
      },
      signal,
      redirect: "follow",
    });
    const buf  = await r.arrayBuffer();
    const html = new TextDecoder().decode(buf.slice(0, 262144));

    const metaTags = [];
    const metaRe   = /<meta[\s\S]*?>/gi;
    let m;
    while ((m = metaRe.exec(html)) !== null) metaTags.push(m[0]);

    const getAttr = (tag, attr) => {
      const rx = new RegExp(`\\b${attr}\\s*=\\s*(?:"([^"]*?)"|'([^']*?)'|([^\\s/>]+))`, "i");
      const x  = rx.exec(tag);
      return x ? (x[1] ?? x[2] ?? x[3] ?? "").trim() : null;
    };
    const getMeta = (...names) => {
      for (const name of names) {
        const lc = name.toLowerCase();
        for (const tag of metaTags) {
          const prop = (getAttr(tag, "property") || getAttr(tag, "name") || "").toLowerCase();
          if (prop === lc) { const v = getAttr(tag, "content"); if (v) return v; }
        }
      }
      return null;
    };

    const titleMatch = html.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i);
    const rawTitle   = titleMatch ? titleMatch[1].replace(/\s+/g, " ").trim() : null;

    const title       = getMeta("og:title", "twitter:title") || rawTitle;
    const description = getMeta("og:description", "twitter:description", "description");
    const image       = getMeta("og:image", "og:image:url", "twitter:image", "twitter:image:src");
    const siteName    = getMeta("og:site_name");

    if (!title && !description && !image)
      return res.status(422).json({ error: "No preview data found" });
    return res.json({ title: title || domain, description, image, siteName, domain, url });
  } catch (err) {
    return res.status(502).json({ error: "Could not fetch preview: " + err.message });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// PUSH SUBSCRIPTION ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/push/vapid-public-key — returns the public VAPID key for the client
app.get("/api/push/vapid-public-key", (req, res) => {
  if (!process.env.VAPID_PUBLIC_KEY)
    return res.status(503).json({ error: "Push notifications not configured." });
  res.json({ key: process.env.VAPID_PUBLIC_KEY });
});

// POST /api/push/subscribe — save a push subscription for the authenticated user
app.post("/api/push/subscribe", requireAuth, async (req, res) => {
  try {
    const { endpoint, keys } = req.body;
    if (!endpoint || !keys?.p256dh || !keys?.auth)
      return res.status(400).json({ error: "Invalid subscription object." });
    await db.query(`
      INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (endpoint) DO UPDATE SET user_id=$1, p256dh=$3, auth=$4
    `, [req.userId, endpoint, keys.p256dh, keys.auth]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("push/subscribe:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

// DELETE /api/push/subscribe — remove push subscription for the authenticated user
app.delete("/api/push/subscribe", requireAuth, async (req, res) => {
  try {
    const { endpoint } = req.body;
    if (endpoint) {
      await db.query("DELETE FROM push_subscriptions WHERE user_id=$1 AND endpoint=$2",
        [req.userId, endpoint]);
    } else {
      await db.query("DELETE FROM push_subscriptions WHERE user_id=$1", [req.userId]);
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("push/unsubscribe:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

// POST /api/badge/clear — user has viewed the chat; reset their unread count to 0
app.post("/api/badge/clear", requireAuth, async (req, res) => {
  try {
    await db.query(
      "INSERT INTO unread_counts (user_id, count) VALUES ($1, 0) ON CONFLICT (user_id) DO UPDATE SET count = 0",
      [req.userId]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("badge/clear:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// BOARD ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.get("/api/board/messages", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query("SELECT * FROM messages ORDER BY ts ASC");
    const ids = rows.map(r => Number(r.id));
    const reactionsMap = await loadReactions(ids);
    return res.json(rows.map(r => shapeMessage(r, reactionsMap)));
  } catch (err) {
    console.error("getMessages:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/board/messages", requireAuth, async (req, res) => {
  try {
    const { rows: userRows } = await db.query("SELECT * FROM users WHERE id = $1", [req.userId]);
    const user = userRows[0];
    if (!user) return res.status(404).json({ error: "User not found." });

    const { text, media } = req.body;
    if (!text?.trim() && !media)
      return res.status(400).json({ error: "Message cannot be empty." });

    const ts = Date.now();
    const { rows } = await db.query(`
      INSERT INTO messages
        (user_id, author, ts, text, media_url, media_type, media_bytes, media_public_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [req.userId, displayName(user), ts, text?.trim() || "",
       media?.dataUrl || null, media?.type || null,
       media?.bytes || 0, media?.publicId || null]
    );

    // Remove from pending — it's now a real message
    if (media?.publicId) {
      await db.query("DELETE FROM pending_uploads WHERE public_id = $1", [media.publicId]);
    }

    // Push notification — notify all OTHER users that a new message arrived
    const newMsg = shapeMessage(rows[0], {});
    const { rows: allUsers } = await db.query(
      "SELECT DISTINCT user_id FROM push_subscriptions WHERE user_id != $1",
      [req.userId]
    );
    const senderName = displayName(user);
    const pushBody = text?.trim()
      ? `${senderName}: ${text.trim().slice(0, 80)}`
      : `${senderName} sent a file`;
    for (const u of allUsers) {
      sendPushToUser(u.user_id, {
        title: "Bros of St. Hyacinth",
        body:  pushBody,
        tag:   "bsh-message",
        url:   "/",
      });
    }

    return res.status(201).json(newMsg);
  } catch (err) {
    console.error("postMessage:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/board/reactions", requireAuth, async (req, res) => {
  try {
    const { rows: userRows } = await db.query("SELECT * FROM users WHERE id = $1", [req.userId]);
    const user = userRows[0];
    if (!user) return res.status(404).json({ error: "User not found." });

    const { messageId, emoji } = req.body;
    if (!messageId) return res.status(400).json({ error: "messageId is required." });

    const name = displayName(user);
    await db.query(
      "DELETE FROM reactions WHERE message_id = $1 AND username = $2",
      [messageId, name]
    );
    if (emoji !== null && emoji !== undefined) {
      await db.query(
        "INSERT INTO reactions (message_id, emoji, username) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING",
        [messageId, emoji, name]
      );
    }
    const reactionsMap = await loadReactions([Number(messageId)]);

    // Push notification — notify the message author if someone else reacted
    if (emoji !== null && emoji !== undefined) {
      const { rows: msgRows } = await db.query(
        "SELECT user_id FROM messages WHERE id = $1", [messageId]
      );
      const authorUserId = msgRows[0]?.user_id;
      if (authorUserId && authorUserId !== req.userId) {
        sendPushToUser(authorUserId, {
          title: "Bros of St. Hyacinth",
          body:  `${name} reacted ${emoji} to your message`,
          tag:   "bsh-reaction",
          url:   "/",
        });
      }
    }

    return res.json({ reactions: reactionsMap[Number(messageId)] || {} });
  } catch (err) {
    console.error("postReaction:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// ADMIN ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/admin/users — list all users (arch_admin and admin only)
app.get("/api/admin/users", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query("SELECT * FROM users ORDER BY created_at ASC");
    return res.json(rows.map(shapeUser));
  } catch (err) {
    console.error("adminGetUsers:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

// DELETE /api/admin/users/:id — delete a user (arch_admin can delete anyone non-arch_admin; admin can delete non-admin/non-arch_admin)
app.delete("/api/admin/users/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows } = await db.query("SELECT * FROM users WHERE id = $1", [req.params.id]);
    const target = rows[0];
    if (!target) return res.status(404).json({ error: "User not found." });

    // Cannot delete yourself
    if (Number(req.params.id) === req.userId)
      return res.status(400).json({ error: "You cannot delete your own account from the admin panel." });

    // arch_admin can delete anyone except other arch_admins
    if (target.role === 'arch_admin')
      return res.status(403).json({ error: "Cannot delete an arch-admin." });

    // admin can only delete regular users
    if (req.userRole === 'admin' && target.role === 'admin')
      return res.status(403).json({ error: "Admins cannot delete other admins." });

    await db.query("DELETE FROM users WHERE id = $1", [req.params.id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("adminDeleteUser:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

// POST /api/admin/users/:id/role — promote/demote a user (arch_admin only)
app.post("/api/admin/users/:id/role", requireAuth, async (req, res) => {
  try {
    // Only arch_admin can change roles
    const { rows: selfRows } = await db.query("SELECT role FROM users WHERE id = $1", [req.userId]);
    if (!selfRows[0] || selfRows[0].role !== 'arch_admin')
      return res.status(403).json({ error: "Only the arch-admin can change roles." });

    const { role } = req.body;
    if (!['user', 'admin'].includes(role))
      return res.status(400).json({ error: "Role must be 'user' or 'admin'." });

    const { rows } = await db.query("SELECT * FROM users WHERE id = $1", [req.params.id]);
    const target = rows[0];
    if (!target) return res.status(404).json({ error: "User not found." });
    if (target.role === 'arch_admin')
      return res.status(403).json({ error: "Cannot change the arch-admin's role." });

    const { rows: updated } = await db.query(
      "UPDATE users SET role = $1 WHERE id = $2 RETURNING *",
      [role, req.params.id]
    );
    return res.json({ user: shapeUser(updated[0]) });
  } catch (err) {
    console.error("adminSetRole:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

// Catch-all: serve React app for any non-API route
app.get("*", (req, res) => {
  const index = path.join(__dirname, "build", "index.html");
  if (fs.existsSync(index)) {
    res.sendFile(index);
  } else {
    res.status(404).send("App not built yet. Run npm run build.");
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
    });
    // Run cleanup on boot, then every 6 hours
    purgeOrphanCloudinaryAssets().then(() => runStorageCleanup());
    setInterval(() => {
      purgeOrphanCloudinaryAssets().then(() => runStorageCleanup());
    }, 6 * 60 * 60 * 1000);

    // Purge abandoned uploads every 15 minutes
    purgeStaleUploads();
    setInterval(purgeStaleUploads, 15 * 60 * 1000);
  })
  .catch(err => {
    console.error("❌ Failed to initialise database:", err);
    process.exit(1);
  });
