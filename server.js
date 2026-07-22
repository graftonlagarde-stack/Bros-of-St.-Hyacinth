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
const express   = require("express");
const cors      = require("cors");
const rateLimit = require("express-rate-limit");
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
      "SELECT media_public_id, media_extra FROM messages WHERE media_public_id IS NOT NULL OR media_extra IS NOT NULL"
    );
    const knownIds = new Set();
    for (const row of rows) {
      if (row.media_public_id) knownIds.add(row.media_public_id);
      if (row.media_extra) {
        for (const m of JSON.parse(row.media_extra)) {
          if (m.publicId) knownIds.add(m.publicId);
        }
      }
    }
    // Also protect avatar public IDs
    const { rows: avatarRows } = await db.query("SELECT avatar_public_id FROM users WHERE avatar_public_id IS NOT NULL");
    for (const row of avatarRows) knownIds.add(row.avatar_public_id);
    let orphanCount = 0;
    // Cloudinary requires separate calls per resource_type — "auto" is not valid for listing
    for (const resourceType of ["image", "video", "raw"]) {
      let nextCursor = null;
      do {
        const params = { max_results: 500, resource_type: resourceType };
        if (nextCursor) params.next_cursor = nextCursor;
        const result = await cloudinary.api.resources(params);
        for (const asset of result.resources) {
          if (asset.public_id.startsWith("bible-audio/")) continue;
          if (!knownIds.has(asset.public_id)) {
            try {
              await cloudinary.uploader.destroy(asset.public_id, { resource_type: resourceType });
              orphanCount++;
            } catch (e) {
              console.warn(`⚠ Could not delete orphan ${asset.public_id}:`, e.message);
            }
          }
        }
        nextCursor = result.next_cursor;
      } while (nextCursor);
    }
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
      avatar_url        TEXT,
      avatar_public_id  TEXT,
      email_verified    BOOLEAN NOT NULL DEFAULT false,
      created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    -- Add email_verified to existing deployments
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified BOOLEAN NOT NULL DEFAULT false;

    CREATE TABLE IF NOT EXISTS email_verifications (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token      TEXT NOT NULL UNIQUE,
      expires_at BIGINT NOT NULL
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

    CREATE TABLE IF NOT EXISTS meetings (
      id              SERIAL PRIMARY KEY,
      title           TEXT NOT NULL,
      created_by      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scheduled_at    BIGINT NOT NULL,
      daily_room_name TEXT NOT NULL,
      daily_room_url  TEXT NOT NULL,
      active_participants INTEGER NOT NULL DEFAULT 0,
      join_count      INTEGER NOT NULL DEFAULT 0,
      created_at      BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS meeting_invitees (
      id                SERIAL PRIMARY KEY,
      meeting_id        INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
      user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      status            TEXT NOT NULL DEFAULT 'invited',
      notified_reminder BOOLEAN NOT NULL DEFAULT FALSE,
      UNIQUE(meeting_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS workout_sessions (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      date       TEXT NOT NULL,
      created_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      UNIQUE(user_id, date)
    );

    CREATE TABLE IF NOT EXISTS session_sets (
      id               SERIAL PRIMARY KEY,
      session_id       INTEGER NOT NULL REFERENCES workout_sessions(id) ON DELETE CASCADE,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      exercise         TEXT NOT NULL,
      set_type         TEXT NOT NULL, -- 'weighted' | 'bodyweight' | 'duration'
      weight           NUMERIC,
      reps             INTEGER,
      duration_seconds INTEGER,
      migrated         BOOLEAN NOT NULL DEFAULT FALSE,
      created_at       BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT
    );

    CREATE TABLE IF NOT EXISTS personal_records (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      exercise   TEXT NOT NULL,
      value      NUMERIC NOT NULL,
      updated_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      UNIQUE(user_id, exercise)
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
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      type    TEXT NOT NULL DEFAULT 'global-chat',
      count   INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (user_id, type)
    );
  `);
  // Migrate any existing single-column rows to the new schema
  await db.query(`
    ALTER TABLE unread_counts ADD COLUMN IF NOT EXISTS type TEXT NOT NULL DEFAULT 'global-chat';
  `);
  // Fix primary key — old table had PK on (user_id) only, needs (user_id, type)
  // Drop the old PK and add the composite one if it doesn't already exist
  await db.query(`
    DO $$
    BEGIN
      -- Drop old single-column primary key if it exists
      IF EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conname = 'unread_counts_pkey'
          AND contype = 'p'
          AND array_length(conkey, 1) = 1
      ) THEN
        ALTER TABLE unread_counts DROP CONSTRAINT unread_counts_pkey;
        ALTER TABLE unread_counts ADD PRIMARY KEY (user_id, type);
      END IF;
    END$$;
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS password_resets (
      id         SERIAL PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      token      TEXT NOT NULL UNIQUE,
      expires_at BIGINT NOT NULL
    );
  `);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'user';`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_url TEXT;`);
  await db.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS join_count INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE meetings ADD COLUMN IF NOT EXISTS active_participants INTEGER NOT NULL DEFAULT 0;`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS avatar_public_id TEXT;`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_alias_name TEXT;`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_alias_avatar_url TEXT;`);
  await db.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS chat_alias_avatar_public_id TEXT;`);
  await db.query(`ALTER TABLE session_sets ADD COLUMN IF NOT EXISTS migrated BOOLEAN NOT NULL DEFAULT FALSE;`);

  // Step 1: Mark all pre-launch session_sets as migrated (catches any rows from broken migrations)
  await db.query(`
    UPDATE session_sets SET migrated = TRUE
    WHERE migrated = FALSE AND created_at < 1748131200000
  `);

  // Step 2 removed — deduplication was incorrectly deleting legitimate rep-category
  // entries from the old system (one entry per rep_cat per day was correct behavior).
  // True duplicates (same exercise, same rep_cat, same date) are handled by the
  // migration guard in Step 3 which only runs once.

  // Step 3: Seed personal_records and session_sets from lift_logs.
  // Re-seeds session_sets every startup but uses INSERT ... ON CONFLICT DO NOTHING
  // to avoid creating duplicates. personal_records uses GREATEST to keep best value.
  const BODYWEIGHT_EXERCISES = ["Pull-up", "Push-up", "Dips"];
  const { rows: legacyLogs } = await db.query("SELECT * FROM lift_logs ORDER BY ts ASC");
  for (const log of legacyLogs) {
    const isBodyweight = BODYWEIGHT_EXERCISES.includes(log.exercise);
    let prValue;
    if (isBodyweight) {
      prValue = Number(log.weight);
    } else {
      const reps = Number(log.rep_cat) || 1;
      const w    = Number(log.weight);
      prValue = reps === 1 ? w : Math.round(w * (1 + reps / 30));
    }
    await db.query(`
      INSERT INTO personal_records (user_id, exercise, value, updated_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, exercise) DO UPDATE
        SET value = GREATEST(personal_records.value, $3),
            updated_at = CASE WHEN $3 > personal_records.value THEN $4 ELSE personal_records.updated_at END
    `, [log.user_id, log.exercise, prValue, Number(log.ts)]);
    const { rows: sessRows } = await db.query(`
      INSERT INTO workout_sessions (user_id, date, created_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, date) DO UPDATE SET date = EXCLUDED.date
      RETURNING id
    `, [log.user_id, log.date, Number(log.ts)]);
    const sessionId = sessRows[0].id;
    // Only insert if this exact rep_cat entry doesn't already exist
    await db.query(`
      INSERT INTO session_sets (session_id, user_id, exercise, set_type, weight, reps, duration_seconds, migrated, created_at)
      SELECT $1, $2, $3, $4, $5, $6, NULL, TRUE, $7
      WHERE NOT EXISTS (
        SELECT 1 FROM session_sets
        WHERE session_id = $1 AND exercise = $3 AND migrated = TRUE
          AND reps = $6
          AND (weight = $5 OR ($5 IS NULL AND weight IS NULL))
      )
    `, [
      sessionId, log.user_id, log.exercise,
      isBodyweight ? "bodyweight" : "weighted",
      isBodyweight ? null : Number(log.weight),
      isBodyweight ? Number(log.weight) : Number(log.rep_cat),
      Number(log.ts),
    ]);
  }
  await db.query(`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS media_extra TEXT;
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS chapters (
      id          SERIAL PRIMARY KEY,
      name        TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL DEFAULT '',
      created_at  BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      active      BOOLEAN NOT NULL DEFAULT true
    );
  `);
  await db.query(`
    CREATE TABLE IF NOT EXISTS chapter_memberships (
      id           SERIAL PRIMARY KEY,
      chapter_id   INTEGER NOT NULL REFERENCES chapters(id) ON DELETE CASCADE,
      user_id      INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role         TEXT NOT NULL DEFAULT 'member',
      status       TEXT NOT NULL DEFAULT 'pending',
      requested_at BIGINT NOT NULL DEFAULT (EXTRACT(EPOCH FROM NOW()) * 1000)::BIGINT,
      resolved_at  BIGINT,
      UNIQUE(user_id)
    );
  `);
  await db.query(`
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS chapter_id INTEGER REFERENCES chapters(id) ON DELETE SET NULL;
  `);
  // Retroactively hard-delete any chapters that were previously only deactivated
  await db.query(`DELETE FROM chapters WHERE active = false;`);

  // Ensure the arch-admin account always has the correct role
  await db.query(`
    UPDATE users SET role = 'arch_admin'
    WHERE LOWER(email) = LOWER('graftonlagarde@protonmail.com');
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS rule_sections (
      id      TEXT PRIMARY KEY,  -- e.g. 'introduction'
      content TEXT NOT NULL DEFAULT ''
    );
  `);
  // Seed default empty rows for each section
  const sections = ['introduction','guiding_principles','exercise_plan','prayer','discipline','monastic_habit'];
  for (const id of sections) {
    await db.query(
      "INSERT INTO rule_sections (id, content) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING",
      [id, '']
    );
  }
  console.log("✅ Database tables ready.");
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(cors({ origin: true, credentials: true }));
app.use(express.json({ limit: "2mb" }));

// Trust Railway's proxy so rate limiting uses the real client IP
app.set("trust proxy", 1);

// Rate limiter for auth routes — 10 attempts per 15 minutes per IP
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: { error: "Too many attempts. Please try again in 15 minutes." },
  standardHeaders: true,
  legacyHeaders: false,
});

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
  avatarUrl:   u.avatar_url || null,
  chatAliasName:      u.chat_alias_name || null,
  chatAliasAvatarUrl: u.chat_alias_avatar_url || null,
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
const shapeMessage = (row, reactionsMap, includeUserId = false) => ({
  id:        Number(row.id),
  ...(includeUserId ? { userId: Number(row.user_id) } : {}),
  author:    row.chapter_id ? row.author : (row.chat_alias_name || row.author),
  avatarUrl: row.chapter_id ? (row.avatar_url || null) : (row.chat_alias_avatar_url || row.avatar_url || null),
  text:      row.text,
  chapterId: row.chapter_id ? Number(row.chapter_id) : null,
  media:     row.media_url ? {
    dataUrl:  row.media_url,
    type:     row.media_type,
    bytes:    row.media_bytes,
    publicId: row.media_public_id,
    isVideo:  (row.media_type || "").startsWith("video/"),
  } : null,
  mediaExtra: row.media_extra ? JSON.parse(row.media_extra) : [],
  isSystem:  row.is_system,
  reactions: reactionsMap[Number(row.id)] || {},
});

// ═════════════════════════════════════════════════════════════════════════════
// AUTH ROUTES
// ═════════════════════════════════════════════════════════════════════════════

app.post("/api/auth/register", authLimiter, async (req, res) => {
  try {
    const { firstName, lastName, email, password, turnstileToken } = req.body;
    if (!firstName?.trim() || !lastName?.trim() || !email?.trim() || !password)
      return res.status(400).json({ error: "All fields are required." });
    if (password.length < 8)
      return res.status(400).json({ error: "Password must be at least 8 characters." });

    // Verify Turnstile token
    if (!turnstileToken)
      return res.status(400).json({ error: "Please complete the CAPTCHA." });
    if (process.env.TURNSTILE_SECRET_KEY) {
      const tsRes = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: process.env.TURNSTILE_SECRET_KEY,
          response: turnstileToken,
        }),
      });
      const tsData = await tsRes.json();
      if (!tsData.success)
        return res.status(400).json({ error: "CAPTCHA verification failed. Please try again." });
    }

    const existing = await db.query("SELECT id FROM users WHERE LOWER(email) = LOWER($1)", [email.trim()]);
    if (existing.rows.length)
      return res.status(409).json({ error: "An account with that email already exists." });

    const hash = await bcrypt.hash(password, 12);
    const { rows } = await db.query(
      "INSERT INTO users (first_name, last_name, email, password, email_verified) VALUES ($1,$2,$3,$4,false) RETURNING *",
      [firstName.trim(), lastName.trim(), email.trim().toLowerCase(), hash]
    );
    const user = rows[0];

    // Generate verification token, expires in 24 hours
    const token     = require("crypto").randomBytes(32).toString("hex");
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    await db.query("DELETE FROM email_verifications WHERE user_id = $1", [user.id]);
    await db.query(
      "INSERT INTO email_verifications (user_id, token, expires_at) VALUES ($1, $2, $3)",
      [user.id, token, expiresAt]
    );

    const appUrl    = process.env.APP_URL || "https://bros-of-st-hyacinth.vercel.app";
    const verifyUrl = `${appUrl}?verify=${token}`;

    if (process.env.RESEND_API_KEY) {
      try {
        await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${process.env.RESEND_API_KEY}`,
            "Content-Type":  "application/json",
          },
          body: JSON.stringify({
            from:    process.env.RESEND_FROM || "Bros of St. Hyacinth <onboarding@resend.dev>",
            to:      [email.trim()],
            subject: "Verify your email — Bros of St. Hyacinth",
            text:    `Welcome to Bros of St. Hyacinth, ${firstName.trim()}!\n\nPlease verify your email address by clicking the link below (expires in 24 hours):\n\n${verifyUrl}\n\nIf you did not create this account, you can safely ignore this email.`,
            html:    `<p>Welcome to Bros of St. Hyacinth, ${firstName.trim()}!</p>
                      <p>Please verify your email address by clicking the link below (expires in 24 hours):</p>
                      <p><a href="${verifyUrl}">${verifyUrl}</a></p>
                      <p>If you did not create this account, you can safely ignore this email.</p>`,
          }),
        });
      } catch (mailErr) {
        console.error("register: email send error:", mailErr.message);
      }
    } else {
      console.warn("register: RESEND_API_KEY not set — verify URL:", verifyUrl);
    }

    return res.status(201).json({ pending: true, email: email.trim().toLowerCase() });
  } catch (err) {
    console.error("register:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

app.get("/api/auth/verify-email", async (req, res) => {
  const { token } = req.query;
  if (!token) return res.status(400).json({ error: "Token is required." });
  try {
    const { rows } = await db.query(
      "SELECT user_id, expires_at FROM email_verifications WHERE token = $1", [token]
    );
    if (!rows.length) return res.status(400).json({ error: "Invalid or expired verification link." });
    if (Date.now() > rows[0].expires_at) {
      await db.query("DELETE FROM email_verifications WHERE token = $1", [token]);
      return res.status(400).json({ error: "This verification link has expired. Please register again." });
    }
    const userId = rows[0].user_id;
    await db.query("UPDATE users SET email_verified = true WHERE id = $1", [userId]);
    await db.query("DELETE FROM email_verifications WHERE token = $1", [token]);
    const { rows: userRows } = await db.query("SELECT * FROM users WHERE id = $1", [userId]);
    const user = userRows[0];
    const jwt  = signToken(user.id);
    return res.json({ token: jwt, user: shapeUser(user) });
  } catch (err) {
    console.error("verify-email:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/auth/resend-verification", async (req, res) => {
  const { email } = req.body;
  if (!email) return res.status(400).json({ error: "Email is required." });
  try {
    const { rows } = await db.query(
      "SELECT id, first_name, email_verified FROM users WHERE LOWER(email) = LOWER($1)", [email]
    );
    if (!rows.length || rows[0].email_verified) return res.json({ ok: true }); // silent
    const userId = rows[0].id;
    const token     = require("crypto").randomBytes(32).toString("hex");
    const expiresAt = Date.now() + 24 * 60 * 60 * 1000;
    await db.query("DELETE FROM email_verifications WHERE user_id = $1", [userId]);
    await db.query("INSERT INTO email_verifications (user_id, token, expires_at) VALUES ($1,$2,$3)", [userId, token, expiresAt]);
    const appUrl    = process.env.APP_URL || "https://bros-of-st-hyacinth.vercel.app";
    const verifyUrl = `${appUrl}?verify=${token}`;
    if (process.env.RESEND_API_KEY) {
      await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { "Authorization": `Bearer ${process.env.RESEND_API_KEY}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from:    process.env.RESEND_FROM || "Bros of St. Hyacinth <onboarding@resend.dev>",
          to:      [email],
          subject: "Verify your email — Bros of St. Hyacinth",
          text:    `Here is your new verification link (expires in 24 hours):\n\n${verifyUrl}`,
          html:    `<p>Here is your new verification link (expires in 24 hours):</p><p><a href="${verifyUrl}">${verifyUrl}</a></p>`,
        }),
      });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error("resend-verification:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

app.post("/api/auth/login", authLimiter, async (req, res) => {
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

    if (!user.email_verified)
      return res.status(403).json({ error: "Please verify your email before logging in.", unverified: true, email: user.email });

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
app.post("/api/auth/forgot-password", authLimiter, async (req, res) => {
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

// ═════════════════════════════════════════════════════════════════════════════
// WORKOUT ROUTES (new session-based system)
// ═════════════════════════════════════════════════════════════════════════════

const BODYWEIGHT_EXERCISES_SET = new Set(["Pull-up", "Push-up", "Dips"]);
const DURATION_EXERCISES_SET   = new Set(["Plank"]);

function computePrValue(exercise, setType, weight, reps, durationSeconds) {
  if (setType === "duration")   return durationSeconds;
  if (setType === "bodyweight") return reps;
  // weighted: Epley estimated 1RM
  const r = reps || 1;
  return r === 1 ? weight : Math.round(weight * (1 + r / 30));
}

async function updatePrIfBetter(userId, exercise, prValue) {
  const { rows } = await db.query(
    "SELECT value FROM personal_records WHERE user_id = $1 AND exercise = $2",
    [userId, exercise]
  );
  const existing = rows[0] ? Number(rows[0].value) : null;
  if (existing === null || prValue > existing) {
    await db.query(`
      INSERT INTO personal_records (user_id, exercise, value, updated_at)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (user_id, exercise) DO UPDATE SET value = $3, updated_at = $4
    `, [userId, exercise, prValue, Date.now()]);
    return true; // new PR
  }
  return false;
}

// GET /api/workout/session/today — get or create today's session with all sets
app.get("/api/workout/session/today", requireAuth, async (req, res) => {
  try {
    const today = new Date().toLocaleDateString("en-US", { month:"short", day:"numeric" });
    const { rows: sessRows } = await db.query(`
      INSERT INTO workout_sessions (user_id, date, created_at)
      VALUES ($1, $2, $3)
      ON CONFLICT (user_id, date) DO UPDATE SET date = EXCLUDED.date
      RETURNING *
    `, [req.userId, today, Date.now()]);
    const session = sessRows[0];
    const { rows: sets } = await db.query(
      "SELECT * FROM session_sets WHERE session_id = $1 AND migrated = FALSE ORDER BY created_at ASC",
      [session.id]
    );
    res.json({ session, sets: sets.map(shapeSet) });
  } catch (err) {
    console.error("GET /api/workout/session/today:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/workout/session/:sessionId/sets — add a set
app.post("/api/workout/session/:sessionId/sets", requireAuth, async (req, res) => {
  try {
    const { exercise, setType, weight, reps, durationSeconds } = req.body;
    if (!exercise || !setType) return res.status(400).json({ error: "exercise and setType required" });
    const { rows } = await db.query(`
      INSERT INTO session_sets (session_id, user_id, exercise, set_type, weight, reps, duration_seconds, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING *
    `, [
      req.params.sessionId, req.userId, exercise, setType,
      weight ?? null, reps ?? null, durationSeconds ?? null, Date.now(),
    ]);
    const set = shapeSet(rows[0]);
    // Check if this is a new PR
    const prValue = computePrValue(exercise, setType, weight, reps, durationSeconds);
    const isNewPr = await updatePrIfBetter(req.userId, exercise, prValue);
    res.json({ set, isNewPr, prValue });
  } catch (err) {
    console.error("POST /api/workout/session/:id/sets:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/workout/sets/:setId — delete a set and recompute PR
app.delete("/api/workout/sets/:setId", requireAuth, async (req, res) => {
  try {
    // Get the set before deleting so we know the exercise
    const { rows: setRows } = await db.query(
      "SELECT * FROM session_sets WHERE id = $1 AND user_id = $2",
      [req.params.setId, req.userId]
    );
    if (setRows.length === 0) return res.status(404).json({ error: "Set not found" });
    const deletedSet = setRows[0];

    await db.query(
      "DELETE FROM session_sets WHERE id = $1 AND user_id = $2",
      [req.params.setId, req.userId]
    );

    // Recompute PR for this exercise from all remaining non-migrated sets
    const { rows: remaining } = await db.query(
      "SELECT set_type, weight, reps, duration_seconds FROM session_sets WHERE user_id = $1 AND exercise = $2 AND migrated = FALSE",
      [req.userId, deletedSet.exercise]
    );

    if (remaining.length === 0) {
      // Also check personal_records seeded from lift_logs (legacy PRs still valid)
      // Just delete the PR entry if no real sets remain
      await db.query(
        "DELETE FROM personal_records WHERE user_id = $1 AND exercise = $2",
        [req.userId, deletedSet.exercise]
      );
    } else {
      // Find the best PR value among remaining sets
      let bestPr = 0;
      for (const s of remaining) {
        const v = computePrValue(deletedSet.exercise, s.set_type, Number(s.weight), Number(s.reps), Number(s.duration_seconds));
        if (v > bestPr) bestPr = v;
      }
      await db.query(
        "UPDATE personal_records SET value = $1, updated_at = $2 WHERE user_id = $3 AND exercise = $4",
        [bestPr, Date.now(), req.userId, deletedSet.exercise]
      );
    }

    res.json({ ok: true, exercise: deletedSet.exercise });
  } catch (err) {
    console.error("DELETE /api/workout/sets/:setId:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/workout/history — past sessions with sets for progress charts
app.get("/api/workout/history", requireAuth, async (req, res) => {
  try {
    const { rows: sessions } = await db.query(
      "SELECT * FROM workout_sessions WHERE user_id = $1 ORDER BY created_at ASC",
      [req.userId]
    );
    const { rows: sets } = await db.query(
      "SELECT * FROM session_sets WHERE user_id = $1 ORDER BY created_at ASC",
      [req.userId]
    );
    const setsBySession = {};
    for (const s of sets) {
      if (!setsBySession[s.session_id]) setsBySession[s.session_id] = [];
      setsBySession[s.session_id].push(shapeSet(s));
    }
    res.json(sessions.map(s => ({ ...s, sets: setsBySession[s.id] || [] })));
  } catch (err) {
    console.error("GET /api/workout/history:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/workout/prs — current user's personal records
app.get("/api/workout/prs", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT exercise, value, updated_at FROM personal_records WHERE user_id = $1",
      [req.userId]
    );
    res.json(rows.map(r => ({ exercise: r.exercise, value: Number(r.value), updatedAt: Number(r.updated_at) })));
  } catch (err) {
    console.error("GET /api/workout/prs:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/community/prs — all users' PRs for top charts
app.get("/api/community/prs", requireAuth, async (req, res) => {
  try {
    const { rows: users } = await db.query("SELECT * FROM users WHERE id != $1", [req.userId]);
    const result = await Promise.all(users.map(async (u) => {
      const { rows: prs } = await db.query(
        "SELECT exercise, value FROM personal_records WHERE user_id = $1",
        [u.id]
      );
      const prMap = {};
      for (const pr of prs) prMap[pr.exercise] = Number(pr.value);
      return { name: displayName(u), avatarUrl: u.avatar_url || null, prs: prMap };
    }));
    res.json(result);
  } catch (err) {
    console.error("GET /api/community/prs:", err);
    res.status(500).json({ error: "Server error" });
  }
});

function shapeSet(row) {
  return {
    id:              Number(row.id),
    sessionId:       Number(row.session_id),
    exercise:        row.exercise,
    setType:         row.set_type,
    weight:          row.weight != null ? Number(row.weight) : null,
    reps:            row.reps != null ? Number(row.reps) : null,
    durationSeconds: row.duration_seconds != null ? Number(row.duration_seconds) : null,
    migrated:        row.migrated === true || row.migrated === 'true',
    createdAt:       Number(row.created_at),
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// UPLOAD ROUTE — proxies file to Cloudinary, tracks public_id in pending_uploads
// ─── AVATAR ROUTES ────────────────────────────────────────────────────────────
// POST /api/profile/avatar — upload a profile picture
app.post("/api/profile/avatar", requireAuth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided." });
    // Delete old avatar from Cloudinary if exists
    const { rows: userRows } = await db.query("SELECT avatar_public_id FROM users WHERE id = $1", [req.userId]);
    if (userRows[0]?.avatar_public_id) {
      await cloudinary.uploader.destroy(userRows[0].avatar_public_id).catch(() => {});
    }
    // Upload new avatar to Cloudinary
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "avatars", resource_type: "image", transformation: [{ width: 600, height: 600, crop: "fill", gravity: "face" }] },
        (err, res) => err ? reject(err) : resolve(res)
      );
      stream.end(req.file.buffer);
    });
    await db.query(
      "UPDATE users SET avatar_url = $1, avatar_public_id = $2 WHERE id = $3",
      [result.secure_url, result.public_id, req.userId]
    );
    res.json({ avatarUrl: result.secure_url });
  } catch (err) {
    console.error("POST /api/profile/avatar:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// DELETE /api/profile/avatar — remove profile picture
app.delete("/api/profile/avatar", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query("SELECT avatar_public_id FROM users WHERE id = $1", [req.userId]);
    if (rows[0]?.avatar_public_id) {
      await cloudinary.uploader.destroy(rows[0].avatar_public_id).catch(() => {});
    }
    await db.query("UPDATE users SET avatar_url = NULL, avatar_public_id = NULL WHERE id = $1", [req.userId]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/profile/avatar:", err);
    res.status(500).json({ error: "Server error." });
  }
});
// ─── CHAT ALIAS ──────────────────────────────────────────────────────────────

// GET /api/profile/chat-alias — get current user's chat alias
app.get("/api/profile/chat-alias", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT chat_alias_name, chat_alias_avatar_url FROM users WHERE id = $1",
      [req.userId]
    );
    res.json({
      chatAliasName:      rows[0]?.chat_alias_name || null,
      chatAliasAvatarUrl: rows[0]?.chat_alias_avatar_url || null,
    });
  } catch (err) {
    console.error("GET /api/profile/chat-alias:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// PUT /api/profile/chat-alias — set or clear alias name
app.put("/api/profile/chat-alias", requireAuth, async (req, res) => {
  try {
    const name = req.body.name?.trim() || null;
    await db.query(
      "UPDATE users SET chat_alias_name = $1 WHERE id = $2",
      [name, req.userId]
    );
    res.json({ chatAliasName: name });
  } catch (err) {
    console.error("PUT /api/profile/chat-alias:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// POST /api/profile/chat-alias/avatar — upload chat alias photo
app.post("/api/profile/chat-alias/avatar", requireAuth, upload.single("file"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No file provided." });
    const { rows } = await db.query("SELECT chat_alias_avatar_public_id FROM users WHERE id = $1", [req.userId]);
    if (rows[0]?.chat_alias_avatar_public_id) {
      await cloudinary.uploader.destroy(rows[0].chat_alias_avatar_public_id).catch(() => {});
    }
    const result = await new Promise((resolve, reject) => {
      const stream = cloudinary.uploader.upload_stream(
        { folder: "chat-aliases", resource_type: "image", transformation: [{ width: 600, height: 600, crop: "fill", gravity: "face" }] },
        (err, res) => err ? reject(err) : resolve(res)
      );
      stream.end(req.file.buffer);
    });
    await db.query(
      "UPDATE users SET chat_alias_avatar_url = $1, chat_alias_avatar_public_id = $2 WHERE id = $3",
      [result.secure_url, result.public_id, req.userId]
    );
    res.json({ chatAliasAvatarUrl: result.secure_url });
  } catch (err) {
    console.error("POST /api/profile/chat-alias/avatar:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// DELETE /api/profile/chat-alias/avatar — remove alias photo
app.delete("/api/profile/chat-alias/avatar", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query("SELECT chat_alias_avatar_public_id FROM users WHERE id = $1", [req.userId]);
    if (rows[0]?.chat_alias_avatar_public_id) {
      await cloudinary.uploader.destroy(rows[0].chat_alias_avatar_public_id).catch(() => {});
    }
    await db.query(
      "UPDATE users SET chat_alias_avatar_url = NULL, chat_alias_avatar_public_id = NULL WHERE id = $1",
      [req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/profile/chat-alias/avatar:", err);
    res.status(500).json({ error: "Server error." });
  }
});

// ─────────────────────────────────────────────────────────────────────────────

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
// Increment unread count for a user by type and return the new total for that type
async function incrementUnread(userId, type = "global-chat") {
  const { rows } = await db.query(`
    INSERT INTO unread_counts (user_id, type, count) VALUES ($1, $2, 1)
    ON CONFLICT (user_id, type) DO UPDATE SET count = unread_counts.count + 1
    RETURNING count
  `, [userId, type]);
  return rows[0]?.count ?? 1;
}

async function sendPushToUser(userId, payload) {
  if (!process.env.VAPID_PUBLIC_KEY || !process.env.VAPID_PRIVATE_KEY) return;
  try {
    const type = payload.notifType || "global-chat";
    const badge = await incrementUnread(userId, type);
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
        if (err.statusCode >= 400) {
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

// POST /api/badge/clear — reset unread counts for one or more notification types
app.post("/api/badge/clear", requireAuth, async (req, res) => {
  try {
    const types = Array.isArray(req.body.types) ? req.body.types : ["global-chat"];
    for (const type of types) {
      await db.query(
        "INSERT INTO unread_counts (user_id, type, count) VALUES ($1, $2, 0) ON CONFLICT (user_id, type) DO UPDATE SET count = 0",
        [req.userId, type]
      );
    }
    // Clear the app icon badge only if all known types are now zero
    const { rows } = await db.query(
      "SELECT COALESCE(SUM(count), 0) AS total FROM unread_counts WHERE user_id = $1",
      [req.userId]
    );
    return res.json({ ok: true, totalRemaining: Number(rows[0]?.total ?? 0) });
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
    const since = req.query.since ? Number(req.query.since) : null;
    const { rows } = since
      ? await db.query(`SELECT m.*, u.avatar_url, u.chat_alias_avatar_url, u.chat_alias_name FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.chapter_id IS NULL AND m.ts > $1 ORDER BY m.ts ASC`, [since])
      : await db.query(`SELECT m.*, u.avatar_url, u.chat_alias_avatar_url, u.chat_alias_name FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.chapter_id IS NULL ORDER BY m.ts ASC`);
    const ids = rows.map(r => Number(r.id));
    const reactionsMap = ids.length > 0 ? await loadReactions(ids) : {};
    const isArchAdmin = req.userRole === "arch_admin";
    return res.json(rows.map(r => shapeMessage(r, reactionsMap, isArchAdmin)));
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

    const { text, media, mediaExtra } = req.body;
    if (!text?.trim() && !media)
      return res.status(400).json({ error: "Message cannot be empty." });

    const extraItems = Array.isArray(mediaExtra) && mediaExtra.length > 0 ? mediaExtra : null;
    const ts = Date.now();
    // Global chat uses alias name if set; chapter chat always uses real name
    const authorName = (!req.body.chapterId && user.chat_alias_name) ? user.chat_alias_name : displayName(user);
    const { rows } = await db.query(`
      INSERT INTO messages
        (user_id, author, ts, text, media_url, media_type, media_bytes, media_public_id, media_extra)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [req.userId, authorName, ts, text?.trim() || "",
       media?.dataUrl || null, media?.type || null,
       media?.bytes || 0, media?.publicId || null,
       extraItems ? JSON.stringify(extraItems) : null]
    );

    // Remove from pending — it's now a real message
    if (media?.publicId) {
      await db.query("DELETE FROM pending_uploads WHERE public_id = $1", [media.publicId]);
    }
    if (extraItems) {
      for (const m of extraItems) {
        if (m.publicId) await db.query("DELETE FROM pending_uploads WHERE public_id = $1", [m.publicId]);
      }
    }

    // Re-fetch with JOIN to include alias avatar in immediate response
    const { rows: msgRows } = await db.query(
      `SELECT m.*, u.avatar_url, u.chat_alias_avatar_url, u.chat_alias_name FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.id = $1`,
      [rows[0].id]
    );
    const newMsg = shapeMessage(msgRows[0], {}, req.userRole === "arch_admin");
    // Push notification — notify all OTHER users that a new message arrived
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
        notifType: "global-chat",
      });
    }

    return res.status(201).json(newMsg);
  } catch (err) {
    console.error("postMessage:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

// DELETE /api/board/messages/:id — arch_admin always; chapter admin for chapter messages
app.delete("/api/board/messages/:id", requireAuth, async (req, res) => {
  try {
    const { rows: userRows } = await db.query("SELECT role FROM users WHERE id = $1", [req.userId]);
    const role = userRows[0]?.role;
    if (!role) return res.status(403).json({ error: "Forbidden" });
    const { id } = req.params;
    const { rows } = await db.query("SELECT media_public_id, media_extra, chapter_id FROM messages WHERE id = $1", [id]);
    if (!rows[0]) return res.status(404).json({ error: "Not found" });
    const msg = rows[0];
    // Arch-admin can delete anything
    if (role !== "arch_admin") {
      // Chapter admin can only delete messages in their own chapter
      if (!msg.chapter_id) return res.status(403).json({ error: "Forbidden" });
      const { rows: cmRows } = await db.query(
        "SELECT id FROM chapter_memberships WHERE user_id = $1 AND chapter_id = $2 AND role = 'admin' AND status = 'approved'",
        [req.userId, msg.chapter_id]
      );
      if (!cmRows[0]) return res.status(403).json({ error: "Forbidden" });
    }
    if (msg.media_public_id) {
      try { await cloudinary.uploader.destroy(msg.media_public_id, { resource_type: "auto" }); } catch (_) {}
    }
    if (msg.media_extra) {
      const extras = JSON.parse(msg.media_extra);
      for (const m of extras) {
        if (m.publicId) {
          try { await cloudinary.uploader.destroy(m.publicId, { resource_type: "auto" }); } catch (_) {}
        }
      }
    }
    await db.query("DELETE FROM messages WHERE id = $1", [id]);
    return res.json({ ok: true });
  } catch (err) {
    console.error("deleteMessage:", err);
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
          notifType: "reaction",
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

// GET /api/users — all users (any authenticated user, for meeting invites etc.)
app.get("/api/users", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT id, first_name, last_name, email, avatar_url FROM users ORDER BY first_name ASC",
      []
    );
    res.json(rows.map(u => ({
      id:          Number(u.id),
      displayName: `${u.first_name} ${u.last_name}`,
      email:       u.email,
      avatarUrl:   u.avatar_url || null,
    })));
  } catch (err) {
    console.error("GET /api/users:", err);
    res.status(500).json({ error: "Server error" });
  }
});

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

// ═════════════════════════════════════════════════════════════════════════════
// RULE ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// GET /api/rule — returns all section content
app.get("/api/rule", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query("SELECT id, content FROM rule_sections ORDER BY id");
    const data = {};
    rows.forEach(r => { data[r.id] = r.content; });
    return res.json(data);
  } catch (err) {
    console.error("rule GET:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// PUT /api/rule/:section — arch_admin only, saves HTML content for a section
app.put("/api/rule/:section", requireAuth, async (req, res) => {
  try {
    const { rows: userRows } = await db.query("SELECT role FROM users WHERE id = $1", [req.userId]);
    if (!userRows[0] || userRows[0].role !== "arch_admin")
      return res.status(403).json({ error: "Forbidden" });
    const { section } = req.params;
    const { content } = req.body;
    if (typeof content !== "string") return res.status(400).json({ error: "content required" });
    await db.query(
      "INSERT INTO rule_sections (id, content) VALUES ($1, $2) ON CONFLICT (id) DO UPDATE SET content = $2",
      [section, content]
    );
    return res.json({ ok: true });
  } catch (err) {
    console.error("rule PUT:", err);
    return res.status(500).json({ error: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// CHAPTER ROUTES
// ═════════════════════════════════════════════════════════════════════════════

// Helper: get chapter membership for a user
async function getUserMembership(userId) {
  const { rows } = await db.query(`
    SELECT cm.*, c.name AS chapter_name, c.description, c.active
    FROM chapter_memberships cm
    JOIN chapters c ON c.id = cm.chapter_id
    WHERE cm.user_id = $1
  `, [userId]);
  return rows[0] || null;
}

// Helper: check if user is chapter admin for a given chapter
async function isChapterAdmin(userId, chapterId) {
  const { rows } = await db.query(
    "SELECT id FROM chapter_memberships WHERE user_id = $1 AND chapter_id = $2 AND role = 'admin' AND status = 'approved'",
    [userId, chapterId]
  );
  return rows.length > 0;
}

// GET /api/chapters — list all active chapters with member count and admin name
app.get("/api/chapters", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT
        c.id, c.name, c.description, c.created_at, c.active,
        COUNT(cm.id) FILTER (WHERE cm.status = 'approved') AS member_count,
        MAX(u.first_name || ' ' || u.last_name) FILTER (WHERE cm.role = 'admin' AND cm.status = 'approved') AS admin_name
      FROM chapters c
      LEFT JOIN chapter_memberships cm ON cm.chapter_id = c.id
      LEFT JOIN users u ON u.id = cm.user_id
      WHERE c.active = true
      GROUP BY c.id
      ORDER BY c.name ASC
    `);
    res.json(rows);
  } catch (err) {
    console.error("GET /api/chapters:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/chapters — create a chapter (arch-admin only)
app.post("/api/chapters", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows: roleRows } = await db.query("SELECT role FROM users WHERE id = $1", [req.userId]);
    if (roleRows[0]?.role !== "arch_admin") return res.status(403).json({ error: "Arch-admin only." });
    const { name, description } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: "Chapter name is required." });
    const { rows } = await db.query(
      "INSERT INTO chapters (name, description) VALUES ($1, $2) RETURNING *",
      [name.trim(), description?.trim() || ""]
    );
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "A chapter with that name already exists." });
    console.error("POST /api/chapters:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PATCH /api/chapters/:id — edit chapter name/description (arch-admin only)
app.patch("/api/chapters/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows: roleRows } = await db.query("SELECT role FROM users WHERE id = $1", [req.userId]);
    if (roleRows[0]?.role !== "arch_admin") return res.status(403).json({ error: "Arch-admin only." });
    const { name, description } = req.body;
    if (name !== undefined && !name.trim()) return res.status(400).json({ error: "Chapter name cannot be empty." });
    const { rows } = await db.query(
      `UPDATE chapters SET
        name        = CASE WHEN $1::text IS NOT NULL THEN $1 ELSE name END,
        description = CASE WHEN $2::text IS NOT NULL THEN $2 ELSE description END
       WHERE id = $3 RETURNING *`,
      [name?.trim() ?? null, description?.trim() ?? null, req.params.id]
    );
    if (!rows[0]) return res.status(404).json({ error: "Chapter not found." });
    res.json(rows[0]);
  } catch (err) {
    if (err.code === "23505") return res.status(400).json({ error: "A chapter with that name already exists." });
    console.error("PATCH /api/chapters/:id:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/chapters/:id — permanently delete a chapter (arch-admin only)
app.delete("/api/chapters/:id", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows: roleRows } = await db.query("SELECT role FROM users WHERE id = $1", [req.userId]);
    if (roleRows[0]?.role !== "arch_admin") return res.status(403).json({ error: "Arch-admin only." });
    // Hard delete — memberships cascade, messages.chapter_id set to null
    const { rowCount } = await db.query("DELETE FROM chapters WHERE id = $1", [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: "Chapter not found." });
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/chapters/:id:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/chapters/:id/admin — assign chapter admin (arch-admin only)
app.post("/api/chapters/:id/admin", requireAuth, requireAdmin, async (req, res) => {
  try {
    const { rows: roleRows } = await db.query("SELECT role FROM users WHERE id = $1", [req.userId]);
    if (roleRows[0]?.role !== "arch_admin") return res.status(403).json({ error: "Arch-admin only." });
    const { userId } = req.body;
    if (!userId) return res.status(400).json({ error: "userId required." });
    const chapterId = Number(req.params.id);
    // Demote any existing admin in this chapter
    await db.query(
      "UPDATE chapter_memberships SET role = 'member' WHERE chapter_id = $1 AND role = 'admin'",
      [chapterId]
    );
    // Upsert the new admin as approved member with admin role
    await db.query(`
      INSERT INTO chapter_memberships (chapter_id, user_id, role, status, resolved_at)
      VALUES ($1, $2, 'admin', 'approved', $3)
      ON CONFLICT (user_id) DO UPDATE SET chapter_id = $1, role = 'admin', status = 'approved', resolved_at = $3
    `, [chapterId, userId, Date.now()]);
    // Notify the new admin
    sendPushToUser(Number(userId), {
      title: "Chapter Admin",
      body: "You have been appointed as a chapter admin.",
      notifType: "chapter-membership",
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/chapters/:id/admin:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/chapters/my — get current user's membership
app.get("/api/chapters/my", requireAuth, async (req, res) => {
  try {
    const membership = await getUserMembership(req.userId);
    if (!membership) return res.json(null);
    // Also return chapter members if approved
    let members = [];
    if (membership.status === "approved") {
      const { rows } = await db.query(`
        SELECT u.id, u.first_name, u.last_name, cm.role, cm.requested_at
        FROM chapter_memberships cm
        JOIN users u ON u.id = cm.user_id
        WHERE cm.chapter_id = $1 AND cm.status = 'approved'
        ORDER BY cm.role DESC, u.first_name ASC
      `, [membership.chapter_id]);
      members = rows.map(r => ({
        id: Number(r.id),
        displayName: `${r.first_name} ${r.last_name}`,
        role: r.role,
      }));
    }
    res.json({ ...membership, members });
  } catch (err) {
    console.error("GET /api/chapters/my:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/chapters/:id/join — request to join a chapter
app.post("/api/chapters/:id/join", requireAuth, async (req, res) => {
  try {
    const chapterId = Number(req.params.id);
    // Check chapter exists and is active
    const { rows: cRows } = await db.query("SELECT * FROM chapters WHERE id = $1 AND active = true", [chapterId]);
    if (!cRows[0]) return res.status(404).json({ error: "Chapter not found." });
    // Check user doesn't already have a membership
    const existing = await getUserMembership(req.userId);
    if (existing) return res.status(400).json({ error: "You already belong to or have a pending request for a chapter." });
    await db.query(
      "INSERT INTO chapter_memberships (chapter_id, user_id) VALUES ($1, $2)",
      [chapterId, req.userId]
    );
    // Notify chapter admin
    const { rows: adminRows } = await db.query(`
      SELECT cm.user_id FROM chapter_memberships cm
      WHERE cm.chapter_id = $1 AND cm.role = 'admin' AND cm.status = 'approved'
    `, [chapterId]);
    const { rows: userRows } = await db.query("SELECT first_name, last_name FROM users WHERE id = $1", [req.userId]);
    const name = userRows[0] ? `${userRows[0].first_name} ${userRows[0].last_name}` : "A user";
    for (const a of adminRows) {
      sendPushToUser(a.user_id, {
        title: "New Join Request",
        body: `${name} has requested to join your chapter.`,
        notifType: "chapter-membership",
      });
    }
    // Also notify arch-admin if no chapter admin exists
    if (adminRows.length === 0) {
      const { rows: aaRows } = await db.query("SELECT id FROM users WHERE role = 'arch_admin'");
      for (const aa of aaRows) {
        sendPushToUser(aa.id, {
          title: "New Join Request",
          body: `${name} requested to join ${cRows[0].name} (no admin assigned).`,
          notifType: "chapter-membership",
        });
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("POST /api/chapters/:id/join:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/chapters/:id/requests — list pending requests (chapter admin or arch-admin)
app.get("/api/chapters/:id/requests", requireAuth, async (req, res) => {
  try {
    const chapterId = Number(req.params.id);
    const { rows: roleRows } = await db.query("SELECT role FROM users WHERE id = $1", [req.userId]);
    const isArchAdmin = roleRows[0]?.role === "arch_admin";
    const isAdmin = isArchAdmin || await isChapterAdmin(req.userId, chapterId);
    if (!isAdmin) return res.status(403).json({ error: "Forbidden." });
    const { rows } = await db.query(`
      SELECT cm.id, cm.user_id, cm.requested_at, u.first_name, u.last_name, u.email
      FROM chapter_memberships cm
      JOIN users u ON u.id = cm.user_id
      WHERE cm.chapter_id = $1 AND cm.status = 'pending'
      ORDER BY cm.requested_at ASC
    `, [chapterId]);
    res.json(rows.map(r => ({
      id: Number(r.id),
      userId: Number(r.user_id),
      displayName: `${r.first_name} ${r.last_name}`,
      email: r.email,
      requestedAt: Number(r.requested_at),
    })));
  } catch (err) {
    console.error("GET /api/chapters/:id/requests:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PATCH /api/chapters/:id/requests/:userId — approve or reject (chapter admin or arch-admin)
app.patch("/api/chapters/:id/requests/:userId", requireAuth, async (req, res) => {
  try {
    const chapterId = Number(req.params.id);
    const targetUserId = Number(req.params.userId);
    const { action } = req.body; // 'approve' or 'reject'
    if (!["approve", "reject"].includes(action)) return res.status(400).json({ error: "action must be approve or reject." });
    const { rows: roleRows } = await db.query("SELECT role FROM users WHERE id = $1", [req.userId]);
    const isArchAdmin = roleRows[0]?.role === "arch_admin";
    const isAdmin = isArchAdmin || await isChapterAdmin(req.userId, chapterId);
    if (!isAdmin) return res.status(403).json({ error: "Forbidden." });
    const status = action === "approve" ? "approved" : "rejected";
    const { rows } = await db.query(`
      UPDATE chapter_memberships SET status = $1, resolved_at = $2
      WHERE chapter_id = $3 AND user_id = $4 AND status = 'pending'
      RETURNING *
    `, [status, Date.now(), chapterId, targetUserId]);
    if (!rows[0]) return res.status(404).json({ error: "Request not found." });
    // Notify the user
    const { rows: cRows } = await db.query("SELECT name FROM chapters WHERE id = $1", [chapterId]);
    sendPushToUser(targetUserId, {
      title: action === "approve" ? "Request Approved" : "Request Rejected",
      body: action === "approve"
        ? `You have been approved to join ${cRows[0]?.name}.`
        : `Your request to join ${cRows[0]?.name} was not approved.`,
      notifType: "chapter-membership",
    });
    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /api/chapters/:id/requests/:userId:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/chapters/:id/members/:userId — remove a member (chapter admin or arch-admin)
app.delete("/api/chapters/:id/members/:userId", requireAuth, async (req, res) => {
  try {
    const chapterId = Number(req.params.id);
    const targetUserId = Number(req.params.userId);
    const { rows: roleRows } = await db.query("SELECT role FROM users WHERE id = $1", [req.userId]);
    const isArchAdmin = roleRows[0]?.role === "arch_admin";
    const isAdmin = isArchAdmin || await isChapterAdmin(req.userId, chapterId);
    if (!isAdmin) return res.status(403).json({ error: "Forbidden." });
    await db.query(
      "DELETE FROM chapter_memberships WHERE chapter_id = $1 AND user_id = $2",
      [chapterId, targetUserId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/chapters/:id/members/:userId:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/chapters/:id/leave — leave a chapter
app.delete("/api/chapters/:id/leave", requireAuth, async (req, res) => {
  try {
    const chapterId = Number(req.params.id);
    // Don't allow chapter admin to leave without succession
    const { rows: cmRows } = await db.query(
      "SELECT role FROM chapter_memberships WHERE chapter_id = $1 AND user_id = $2",
      [chapterId, req.userId]
    );
    if (cmRows[0]?.role === "admin") {
      return res.status(400).json({ error: "Chapter admins cannot leave without first transferring admin to another member. Contact the arch-admin." });
    }
    await db.query(
      "DELETE FROM chapter_memberships WHERE chapter_id = $1 AND user_id = $2",
      [chapterId, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/chapters/:id/leave:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/chapters/:id/community-users — lift logs for chapter members (same shape as /api/community/users)
app.get("/api/chapters/:id/community-users", requireAuth, async (req, res) => {
  try {
    const chapterId = Number(req.params.id);
    // Must be approved member or arch-admin
    const { rows: roleRows } = await db.query("SELECT role FROM users WHERE id = $1", [req.userId]);
    const isArchAdmin = roleRows[0]?.role === "arch_admin";
    if (!isArchAdmin) {
      const { rows: cmRows } = await db.query(
        "SELECT id FROM chapter_memberships WHERE chapter_id = $1 AND user_id = $2 AND status = 'approved'",
        [chapterId, req.userId]
      );
      if (!cmRows[0]) return res.status(403).json({ error: "Forbidden." });
    }
    const { rows: users } = await db.query(`
      SELECT u.* FROM users u
      JOIN chapter_memberships cm ON cm.user_id = u.id
      WHERE cm.chapter_id = $1 AND cm.status = 'approved' AND u.id != $2
    `, [chapterId, req.userId]);
    const result = await Promise.all(users.map(async (u) => {
      const { rows: prs } = await db.query(
        "SELECT exercise, value FROM personal_records WHERE user_id = $1",
        [u.id]
      );
      const prMap = {};
      for (const pr of prs) prMap[pr.exercise] = Number(pr.value);
      return { name: displayName(u), avatarUrl: u.avatar_url || null, prs: prMap };
    }));
    return res.json(result);
  } catch (err) {
    console.error("GET /api/chapters/:id/community-users:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/chapters/:id/stats — workout leaderboard for chapter members
app.get("/api/chapters/:id/stats", requireAuth, async (req, res) => {
  try {
    const chapterId = Number(req.params.id);
    // Must be approved member or arch-admin
    const { rows: roleRows } = await db.query("SELECT role FROM users WHERE id = $1", [req.userId]);
    const isArchAdmin = roleRows[0]?.role === "arch_admin";
    if (!isArchAdmin) {
      const { rows: cmRows } = await db.query(
        "SELECT id FROM chapter_memberships WHERE chapter_id = $1 AND user_id = $2 AND status = 'approved'",
        [chapterId, req.userId]
      );
      if (!cmRows[0]) return res.status(403).json({ error: "Forbidden." });
    }
    const { rows } = await db.query(`
      SELECT
        u.id, u.first_name, u.last_name,
        COUNT(ll.id) AS total_lifts,
        MAX(ll.weight) AS max_weight,
        COUNT(DISTINCT ll.date) AS days_logged
      FROM chapter_memberships cm
      JOIN users u ON u.id = cm.user_id
      LEFT JOIN lift_logs ll ON ll.user_id = u.id
      WHERE cm.chapter_id = $1 AND cm.status = 'approved'
      GROUP BY u.id
      ORDER BY total_lifts DESC, days_logged DESC
    `, [chapterId]);
    res.json(rows.map(r => ({
      id: Number(r.id),
      displayName: `${r.first_name} ${r.last_name}`,
      totalLifts: Number(r.total_lifts),
      maxWeight: Number(r.max_weight) || 0,
      daysLogged: Number(r.days_logged),
    })));
  } catch (err) {
    console.error("GET /api/chapters/:id/stats:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/chapters/:id/messages — chapter-scoped chat messages
app.get("/api/chapters/:id/messages", requireAuth, async (req, res) => {
  try {
    const chapterId = Number(req.params.id);
    // Must be approved member or arch-admin
    const { rows: roleRows } = await db.query("SELECT role FROM users WHERE id = $1", [req.userId]);
    const isArchAdmin = roleRows[0]?.role === "arch_admin";
    if (!isArchAdmin) {
      const { rows: cmRows } = await db.query(
        "SELECT id FROM chapter_memberships WHERE chapter_id = $1 AND user_id = $2 AND status = 'approved'",
        [chapterId, req.userId]
      );
      if (!cmRows[0]) return res.status(403).json({ error: "Forbidden." });
    }
    const since = req.query.since ? Number(req.query.since) : null;
    const { rows } = since
      ? await db.query(`SELECT m.*, u.avatar_url FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.chapter_id = $1 AND m.ts > $2 ORDER BY m.ts DESC`, [chapterId, since])
      : await db.query(`SELECT m.*, u.avatar_url FROM messages m LEFT JOIN users u ON u.id = m.user_id WHERE m.chapter_id = $1 ORDER BY m.ts DESC LIMIT 200`, [chapterId]);
    const reactionsMap = await loadReactions(rows.map(r => r.id));
    res.json(rows.map(r => shapeMessage(r, reactionsMap)));
  } catch (err) {
    console.error("GET /api/chapters/:id/messages:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/chapters/:id/messages — post to chapter chat
app.post("/api/chapters/:id/messages", requireAuth, async (req, res) => {
  try {
    const chapterId = Number(req.params.id);
    // Must be approved member or arch-admin
    const { rows: userRows } = await db.query("SELECT * FROM users WHERE id = $1", [req.userId]);
    const user = userRows[0];
    if (!user) return res.status(401).json({ error: "User not found." });
    const isArchAdmin = user.role === "arch_admin";
    if (!isArchAdmin) {
      const { rows: cmRows } = await db.query(
        "SELECT id FROM chapter_memberships WHERE chapter_id = $1 AND user_id = $2 AND status = 'approved'",
        [chapterId, req.userId]
      );
      if (!cmRows[0]) return res.status(403).json({ error: "Forbidden." });
    }
    const { text, media, mediaExtra } = req.body;
    if (!text?.trim() && !media) return res.status(400).json({ error: "Message cannot be empty." });
    const extraItems = Array.isArray(mediaExtra) && mediaExtra.length > 0 ? mediaExtra : null;
    const ts = Date.now();
    const { rows } = await db.query(`
      INSERT INTO messages
        (user_id, author, ts, text, media_url, media_type, media_bytes, media_public_id, media_extra, chapter_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [req.userId, displayName(user), ts, text?.trim() || "",
       media?.dataUrl || null, media?.type || null,
       media?.bytes || 0, media?.publicId || null,
       extraItems ? JSON.stringify(extraItems) : null, chapterId]
    );
    if (media?.publicId) await db.query("DELETE FROM pending_uploads WHERE public_id = $1", [media.publicId]);
    if (extraItems) {
      for (const m of extraItems) {
        if (m.publicId) await db.query("DELETE FROM pending_uploads WHERE public_id = $1", [m.publicId]);
      }
    }
    const newMsg = shapeMessage(rows[0], {});
    // Notify chapter members
    const { rows: members } = await db.query(
      "SELECT user_id FROM chapter_memberships WHERE chapter_id = $1 AND status = 'approved' AND user_id != $2",
      [chapterId, req.userId]
    );
    for (const m of members) {
      sendPushToUser(m.user_id, {
        title: displayName(user),
        body: text?.trim() || "Sent an attachment",
        tag: `chapter-${chapterId}`,
        notifType: "chapter-chat",
      });
    }
    res.json(newMsg);
  } catch (err) {
    console.error("POST /api/chapters/:id/messages:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// ═════════════════════════════════════════════════════════════════════════════
// MEET ROUTES
// ═════════════════════════════════════════════════════════════════════════════

const DAILY_API = "https://api.daily.co/v1";

async function dailyRequest(method, path, body) {
  const res = await fetch(`${DAILY_API}${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${process.env.DAILY_API_KEY}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw new Error(`Daily API error: ${res.status} ${await res.text()}`);
  return res.json();
}

// POST /api/meetings — create a meeting
app.post("/api/meetings", requireAuth, async (req, res) => {
  try {
    const { title, scheduledAt, inviteeIds } = req.body;
    if (!title || !scheduledAt || !Array.isArray(inviteeIds)) {
      return res.status(400).json({ error: "title, scheduledAt, and inviteeIds required" });
    }
    // Create Daily room — falls back to placeholder if key not configured
    let roomName, roomUrl;
    if (process.env.DAILY_API_KEY) {
      const expiry = Math.floor((scheduledAt + 3600000) / 1000);
      const room = await dailyRequest("POST", "/rooms", {
        properties: {
          exp:               expiry,
          enable_prejoin_ui: false,
          start_video_off:   true,
          start_audio_off:   false,
          enable_chat:       false,
        },
      });
      roomName = room.name;
      roomUrl  = room.url;
    } else {
      // Fallback: generate a unique room name without Daily
      roomName = `bshm-${Date.now()}-${Math.random().toString(36).slice(2,7)}`;
      roomUrl  = `https://meet.daily.co/${roomName}`;
    }
    // Insert meeting
    const { rows } = await db.query(`
      INSERT INTO meetings (title, created_by, scheduled_at, daily_room_name, daily_room_url)
      VALUES ($1, $2, $3, $4, $5) RETURNING *
    `, [title, req.userId, scheduledAt, roomName, roomUrl]);
    const meeting = rows[0];
    // Insert invitees (deduplicated, exclude creator)
    const ids = [...new Set(inviteeIds.filter(id => id !== req.userId))];
    for (const uid of ids) {
      await db.query(
        "INSERT INTO meeting_invitees (meeting_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
        [meeting.id, uid]
      );
    }
    // Also add creator as participant (status = accepted)
    await db.query(
      "INSERT INTO meeting_invitees (meeting_id, user_id, status) VALUES ($1, $2, 'accepted') ON CONFLICT DO NOTHING",
      [meeting.id, req.userId]
    );
    // Send push notifications to invitees
    const { rows: creator } = await db.query("SELECT * FROM users WHERE id = $1", [req.userId]);
    const creatorName = displayName(creator[0]);
    const dateStr = new Date(scheduledAt).toLocaleString("en-US", {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit"
    });
    for (const uid of ids) {
      sendPushToUser(uid, {
        title: "Meeting Invitation",
        body:  `${creatorName} invited you to "${title}" on ${dateStr}`,
        tag:   `meeting-invite-${meeting.id}`,
        url:   "/",
        notifType: "meeting",
      });
    }
    res.json({ meeting: shapeMeeting(meeting) });
  } catch (err) {
    console.error("POST /api/meetings:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// GET /api/meetings — all meetings user is involved in
app.get("/api/meetings", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(`
      SELECT m.*, u.first_name, u.last_name,
        (SELECT json_agg(json_build_object(
          'userId', mi2.user_id, 'status', mi2.status,
          'name', u2.first_name || ' ' || u2.last_name,
          'avatarUrl', u2.avatar_url
        ))
        FROM meeting_invitees mi2
        JOIN users u2 ON u2.id = mi2.user_id
        WHERE mi2.meeting_id = m.id
        ) AS invitees,
        mi.status AS my_status
      FROM meetings m
      JOIN users u ON u.id = m.created_by
      JOIN meeting_invitees mi ON mi.meeting_id = m.id AND mi.user_id = $1
      WHERE m.scheduled_at > $2
      ORDER BY m.scheduled_at ASC
    `, [req.userId, Date.now() - 3600000]); // include meetings up to 1hr past
    res.json(rows.map(r => shapeMeeting(r)));
  } catch (err) {
    console.error("GET /api/meetings:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// PATCH /api/meetings/:id/rsvp — accept or decline
app.patch("/api/meetings/:id/rsvp", requireAuth, async (req, res) => {
  try {
    const { status } = req.body;
    if (!["accepted", "declined"].includes(status)) return res.status(400).json({ error: "Invalid status" });
    await db.query(
      "UPDATE meeting_invitees SET status = $1 WHERE meeting_id = $2 AND user_id = $3",
      [status, req.params.id, req.userId]
    );
    res.json({ ok: true });
  } catch (err) {
    console.error("PATCH /api/meetings/:id/rsvp:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// DELETE /api/meetings/:id — cancel (creator only)
app.delete("/api/meetings/:id", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query("SELECT * FROM meetings WHERE id = $1 AND created_by = $2", [req.params.id, req.userId]);
    if (!rows[0]) return res.status(403).json({ error: "Not found or not authorized" });
    const meeting = rows[0];
    // Delete Daily room
    dailyRequest("DELETE", `/rooms/${meeting.daily_room_name}`).catch(() => {});
    // Notify invitees
    const { rows: invitees } = await db.query(
      "SELECT user_id FROM meeting_invitees WHERE meeting_id = $1 AND user_id != $2",
      [req.params.id, req.userId]
    );
    for (const inv of invitees) {
      sendPushToUser(inv.user_id, {
        title: "Meeting Cancelled",
        body:  `"${meeting.title}" has been cancelled`,
        tag:   `meeting-cancel-${meeting.id}`,
        url:   "/",
        notifType: "meeting",
      });
    }
    await db.query("DELETE FROM meetings WHERE id = $1", [req.params.id]);
    res.json({ ok: true });
  } catch (err) {
    console.error("DELETE /api/meetings/:id:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/meetings/:id/leave — called when a user leaves the call
// Decrements active_participants and deletes meeting if conditions 3a-3c are met
app.post("/api/meetings/:id/leave", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      "UPDATE meetings SET active_participants = GREATEST(0, active_participants - 1) WHERE id = $1 RETURNING *",
      [req.params.id]
    );
    if (!rows[0]) return res.json({ ok: true, deleted: false });
    const m = rows[0];
    const pastScheduled  = Date.now() >= Number(m.scheduled_at);
    const multipleJoined = Number(m.join_count) > 1;
    const allLeft        = Number(m.active_participants) === 0;
    if (pastScheduled && multipleJoined && allLeft) {
      dailyRequest("DELETE", `/rooms/${m.daily_room_name}`).catch(() => {});
      await db.query("DELETE FROM meetings WHERE id = $1", [m.id]);
      return res.json({ ok: true, deleted: true });
    }
    res.json({ ok: true, deleted: false });
  } catch (err) {
    console.error("POST /api/meetings/:id/leave:", err);
    res.status(500).json({ error: "Server error" });
  }
});

// POST /api/meetings/:id/token — get a Daily meeting token for the current user
app.post("/api/meetings/:id/token", requireAuth, async (req, res) => {
  try {
    const { rows } = await db.query(
      "SELECT m.* FROM meetings m JOIN meeting_invitees mi ON mi.meeting_id = m.id WHERE m.id = $1 AND mi.user_id = $2",
      [req.params.id, req.userId]
    );
    if (!rows[0]) return res.status(403).json({ error: "Not invited" });
    const meeting = rows[0];
    const { rows: userRows } = await db.query("SELECT * FROM users WHERE id = $1", [req.userId]);
    const user = userRows[0];

    // If Daily not configured, return null token — client shows helpful message
    if (!process.env.DAILY_API_KEY) {
      return res.json({ token: null, roomUrl: meeting.daily_room_url, roomName: meeting.daily_room_name });
    }

    // If this meeting was created before Daily was configured, the room doesn't
    // exist on Daily yet — create it now on the fly
    let roomName = meeting.daily_room_name;
    if (roomName.startsWith("bshm-") && roomName.length > 20) {
      // This is a fallback name — create a real Daily room with this name
      try {
        await dailyRequest("POST", "/rooms", {
          name: roomName,
          properties: {
            exp:               Math.floor((Number(meeting.scheduled_at) + 3600000) / 1000),
            enable_prejoin_ui: false,
            start_video_off:   true,
            start_audio_off:   false,
            enable_chat:       false,
          },
        });
      } catch (e) {
        // Room may already exist — that's fine
        if (!e.message.includes("already")) console.warn("Room creation on join:", e.message);
      }
    }

    const result = await dailyRequest("POST", "/meeting-tokens", {
      properties: {
        room_name:  roomName,
        user_name:  displayName(user),
        user_id:    String(req.userId),
        exp:        Math.floor((Number(meeting.scheduled_at) + 3600000) / 1000),
      },
    });
    res.json({ token: result.token, roomUrl: meeting.daily_room_url, roomName });
    // Track join stats
    await db.query(
      "UPDATE meetings SET join_count = join_count + 1, active_participants = active_participants + 1 WHERE id = $1",
      [req.params.id]
    );
  } catch (err) {
    console.error("POST /api/meetings/:id/token:", err.message, err.stack);
    res.status(500).json({ error: err.message || "Server error" });
  }
});

function shapeMeeting(row) {
  return {
    id:           Number(row.id),
    title:        row.title,
    createdBy:    Number(row.created_by),
    creatorName:  row.first_name && row.last_name ? `${row.first_name} ${row.last_name}` : null,
    scheduledAt:  Number(row.scheduled_at),
    roomName:     row.daily_room_name,
    roomUrl:      row.daily_room_url,
    invitees:     row.invitees || [],
    myStatus:     row.my_status || "invited",
  };
}

// ─── Reminder + cleanup job — runs every 60 seconds ─────────────────────────
setInterval(async () => {
  try {
    // Send 15-minute reminders
    const now = Date.now();
    const windowStart = now + 14 * 60 * 1000;
    const windowEnd   = now + 16 * 60 * 1000;
    const { rows: upcoming } = await db.query(`
      SELECT m.title, m.scheduled_at, mi.user_id, mi.meeting_id
      FROM meetings m
      JOIN meeting_invitees mi ON mi.meeting_id = m.id
      WHERE m.scheduled_at BETWEEN $1 AND $2
        AND mi.notified_reminder = FALSE
        AND mi.status != 'declined'
    `, [windowStart, windowEnd]);
    for (const row of upcoming) {
      sendPushToUser(row.user_id, {
        title: "Meeting Starting Soon",
        body:  `"${row.title}" starts in 15 minutes`,
        tag:   `meeting-reminder-${row.meeting_id}`,
        url:   "/",
        notifType: "meeting",
      });
      await db.query(
        "UPDATE meeting_invitees SET notified_reminder = TRUE WHERE meeting_id = $1 AND user_id = $2",
        [row.meeting_id, row.user_id]
      );
    }
    // Clean up expired meetings (Daily room expired = scheduled_at + 2 hours)
    const expiryCutoff = now - 2 * 60 * 60 * 1000;
    const { rows: expired } = await db.query(
      "SELECT id, daily_room_name FROM meetings WHERE scheduled_at < $1 AND join_count > 1",
      [expiryCutoff]
    );
    for (const m of expired) {
      dailyRequest("DELETE", `/rooms/${m.daily_room_name}`).catch(() => {});
      await db.query("DELETE FROM meetings WHERE id = $1", [m.id]);
    }
  } catch (err) {
    console.error("Reminder job error:", err.message);
  }
}, 60000);

// ═════════════════════════════════════════════════════════════════════════════
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
