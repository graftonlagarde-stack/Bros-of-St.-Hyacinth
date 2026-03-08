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
// ─────────────────────────────────────────────────────────────────────────────

require("dotenv").config();
const express  = require("express");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const bcrypt   = require("bcryptjs");
const jwt      = require("jsonwebtoken");
const { Pool } = require("pg");

const app        = express();
const PORT       = process.env.PORT || 4000;
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_THIS_IN_ENV";

// ── Database ──────────────────────────────────────────────────────────────────
// Railway injects DATABASE_URL automatically when you add a Postgres addon.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

const db = {
  query: (sql, params) => pool.query(sql, params),
};

// ── Create tables on first boot ───────────────────────────────────────────────
async function initDb() {
  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id          SERIAL PRIMARY KEY,
      first_name  TEXT NOT NULL,
      last_name   TEXT NOT NULL,
      email       TEXT NOT NULL UNIQUE,
      password    TEXT NOT NULL,
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
  console.warn("⚠  No /public folder found — static assets will not be served.");
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
      user: { id: user.id, firstName: user.first_name, lastName: user.last_name,
              email: user.email, displayName: displayName(user) },
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
      user: { id: user.id, firstName: user.first_name, lastName: user.last_name,
              email: user.email, displayName: displayName(user) },
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
      user: { id: user.id, firstName: user.first_name, lastName: user.last_name,
              email: user.email, displayName: displayName(user) },
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
    if (!exercise || !repCat || weight == null || !date || !ts)
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
    return res.status(201).json(shapeMessage(rows[0], {}));
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
    return res.json({ reactions: reactionsMap[Number(messageId)] || {} });
  } catch (err) {
    console.error("postReaction:", err);
    return res.status(500).json({ error: "Server error." });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────────
initDb()
  .then(() => {
    app.listen(PORT, () => {
      console.log(`✅ Server running on port ${PORT}`);
    });
  })
  .catch(err => {
    console.error("❌ Failed to initialise database:", err);
    process.exit(1);
  });
