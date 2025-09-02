// backend/routes/adminEdit.js
const express = require("express");
const jwt = require("jsonwebtoken");
const pool = require("../db");

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET;

// --- Helpers ---
function getBearerToken(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

async function getAuthedAdmin(req, res) {
  try {
    const token = getBearerToken(req);
    if (!token) return res.status(401).json({ error: "Missing token" });
    if (!JWT_SECRET)
      return res.status(500).json({ error: "Server misconfigured: JWT_SECRET missing" });

    const decoded = jwt.verify(token, JWT_SECRET); // { user_id }
    const { rows } = await pool.query(
      "SELECT id, is_admin FROM users WHERE id=$1 LIMIT 1",
      [decoded.user_id]
    );
    const me = rows[0];
    if (!me || !me.is_admin) return res.status(403).json({ error: "Admin only" });
    return me;
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

function cleanStr(v) {
  if (v == null) return null;
  const s = String(v).trim();
  return s === "" ? null : s;
}

// --- Core handler: update name/email parts ---
async function updateUserHandler(req, res) {
  // AuthZ
  const me = await getAuthedAdmin(req, res);
  if (!me || me.error) return; // response already sent

  const userId = Number(req.params.id);
  if (!Number.isFinite(userId)) {
    return res.status(400).json({ error: "Invalid user id" });
  }

  // Accept partial updates
  let { email, name, first_name, last_name } = req.body || {};
  email = cleanStr(email);
  name = cleanStr(name);
  first_name = cleanStr(first_name);
  last_name = cleanStr(last_name);

  // If email present, basic format + uniqueness
  if (email) {
    const lower = email.toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(lower)) {
      return res.status(400).json({ error: "Invalid email format" });
    }
    const dupe = await pool.query(
      "SELECT id FROM users WHERE LOWER(email)=LOWER($1) AND id<>$2 LIMIT 1",
      [lower, userId]
    );
    if (dupe.rows.length) {
      return res.status(409).json({ error: "Email already in use by another account" });
    }
  }

  // Build dynamic SET clause
  const sets = [];
  const vals = [];
  function set(col, val) {
    sets.push(`${col} = $${sets.length + 1}`);
    vals.push(val);
  }
  if (email !== undefined) set("email", email);
  if (name !== undefined) set("name", name);
  if (first_name !== undefined) set("first_name", first_name);
  if (last_name !== undefined) set("last_name", last_name);

  if (sets.length === 0) {
    return res.status(400).json({ error: "No fields to update" });
  }

  vals.push(userId);
  const sql = `UPDATE users SET ${sets.join(", ")} WHERE id = $${vals.length} RETURNING *`;

  try {
    const { rows } = await pool.query(sql, vals);
    const row = rows[0];
    if (!row) return res.status(404).json({ error: "User not found" });
    return res.json({ ok: true, user: row });
  } catch (err) {
    console.error("adminEdit update error:", err);
    return res.status(500).json({ error: "Failed to update user" });
  }
}

// Route(s)
// New canonical route:
router.put("/users/:id", express.json(), updateUserHandler);
// Alias to match your frontend’s current calls (seen in console logs):
router.put("/quick-edit/users/:id", express.json(), updateUserHandler);

module.exports = router;
