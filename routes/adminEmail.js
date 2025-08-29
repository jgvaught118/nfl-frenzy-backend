// backend/routes/adminEmail.js
const express = require("express");
const router = express.Router();
const jwt = require("jsonwebtoken");
const pool = require("../db");
const emailSvc = require("../services/email");

// Optional: use your auth middleware if available
let authenticateToken;
try {
  authenticateToken = require("../middleware/authMiddleware");
} catch {
  authenticateToken = null;
}

const JWT_SECRET = process.env.JWT_SECRET;

/* ----------------------------- Auth helpers ------------------------------ */
function readBearer(req) {
  const h = req.headers.authorization || "";
  return h.startsWith("Bearer ") ? h.slice(7) : null;
}

/** Ensure we have req.user.user_id; if not, verify the bearer token here. */
function ensureJwt(req, res, next) {
  if (req.user?.user_id) return next();
  try {
    const token = readBearer(req);
    if (!token) return res.status(401).json({ error: "Missing token" });
    if (!JWT_SECRET) {
      return res.status(500).json({ error: "Server misconfigured: JWT_SECRET missing" });
    }
    const decoded = jwt.verify(token, JWT_SECRET); // { user_id }
    req.user = { ...(req.user || {}), user_id: decoded.user_id };
    next();
  } catch {
    return res.status(401).json({ error: "Invalid token" });
  }
}

/** Ensure caller is admin */
async function ensureAdmin(req, res, next) {
  try {
    const uid = req.user?.user_id;
    if (!uid) return res.status(401).json({ error: "Unauthorized" });

    const r = await pool.query(
      "SELECT id, email, is_admin FROM users WHERE id=$1",
      [uid]
    );
    const u = r.rows[0];
    if (!u?.is_admin) {
      return res.status(403).json({ error: "Forbidden: admin only" });
    }
    req.admin = u; // { id, email, is_admin }
    next();
  } catch (e) {
    console.error("ensureAdmin error:", e);
    res.status(500).json({ error: "Internal error (admin check)" });
  }
}

/* ------------------------------- Utilities ------------------------------- */
function esc(s = "") {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderBodyHtml(body = "") {
  return String(body)
    .split(/\r?\n/)
    .map(
      (line) =>
        `<p style="margin:0 0 12px 0; line-height:1.5;">${esc(line)}</p>`
    )
    .join("");
}

/**
 * Audience WHERE builder using only columns present in your schema:
 *   - approved (boolean, default TRUE)
 *   - deactivated (boolean, default FALSE)
 *
 * Buckets:
 *   active   = approved=true AND deactivated=false
 *   pending  = approved=false
 *   inactive = deactivated=true
 *   admins   = is_admin=true
 *   all      = everyone
 */
function audienceWhere(audience, q) {
  const params = [];
  let where = "TRUE";

  const approvedTrue = "COALESCE(approved, TRUE) = TRUE";
  const approvedFalse = "COALESCE(approved, FALSE) = FALSE";
  const deactivatedFalse = "COALESCE(deactivated, FALSE) = FALSE";
  const deactivatedTrue = "COALESCE(deactivated, FALSE) = TRUE";

  switch ((audience || "all").toLowerCase()) {
    case "active":
      where = `${approvedTrue} AND ${deactivatedFalse}`;
      break;
    case "pending":
      where = `${approvedFalse}`;
      break;
    case "inactive":
      where = `${deactivatedTrue}`;
      break;
    case "admins":
      where = "is_admin = TRUE";
      break;
    case "all":
    default:
      where = "TRUE";
  }

  if (q && q.trim()) {
    params.push(`%${q.trim().toLowerCase()}%`);
    const idx = params.length; // same index reused for each LIKE
    where = `(${where}) AND (
      LOWER(email) LIKE $${idx}
      OR LOWER(COALESCE(name,'')) LIKE $${idx}
      OR LOWER(COALESCE(first_name,'')) LIKE $${idx}
      OR LOWER(COALESCE(last_name,'')) LIKE $${idx}
    )`;
  }

  return { where, params };
}

/** Fetch recipients from DB or custom list */
async function listRecipients({ audience = "all", emails, q }) {
  if ((audience || "").toLowerCase() === "custom") {
    return [
      ...new Set(
        (emails || [])
          .map((e) => (e || "").trim().toLowerCase())
          .filter(Boolean)
    )];
  }

  const { where, params } = audienceWhere(audience, q);
  const sql = `SELECT email FROM users WHERE ${where}`;
  const r = await pool.query(sql, params);
  return [
    ...new Set(
      r.rows
        .map((row) => (row.email || "").trim().toLowerCase())
        .filter(Boolean)
    ),
  ];
}

/* ----------------------------- Route guards ------------------------------ */
// Use external middleware if present; otherwise fall back to our local JWT check.
const guard = authenticateToken
  ? [authenticateToken, ensureJwt, ensureAdmin]
  : [ensureJwt, ensureAdmin];

/* --------------------------------- Probes -------------------------------- */
router.get("/config", ...guard, (req, res) => {
  const transport =
    process.env.BREVO_API_KEY ? "brevo"
      : process.env.SMTP_HOST ? "smtp"
      : "dev";
  res.json({
    ok: true,
    email_configured: emailSvc.isConfigured(),
    transport,
    from: process.env.MAIL_FROM || "",
  });
});

/** GET /admin/email/recipients?audience=active&q=jack */
router.get("/recipients", ...guard, async (req, res) => {
  try {
    const { audience = "all", q = "" } = req.query;
    const recipients = await listRecipients({ audience, q });
    res.json({
      ok: true,
      audience,
      q,
      count: recipients.length,
      sample: recipients.slice(0, 10),
    });
  } catch (e) {
    console.error("recipients probe error:", e);
    res.status(500).json({ error: "Failed to list recipients" });
  }
});

/* --------------------------------- Preview -------------------------------- */
router.post("/preview", ...guard, async (req, res) => {
  try {
    const { subject, body, audience = "all", emails, q } = req.body || {};
    if (!subject || !body)
      return res.status(400).json({ error: "subject and body are required" });

    const recipients = await listRecipients({ audience, emails, q });
    const html = emailSvc.renderBase({
      title: esc(subject),
      bodyHtml: renderBodyHtml(body),
    });

    res.json({
      ok: true,
      recipients_count: recipients.length,
      sample: recipients.slice(0, 10),
      preview_html: html,
      email_configured: emailSvc.isConfigured(),
    });
  } catch (e) {
    console.error("adminEmail.preview error:", e);
    res.status(500).json({ error: "Failed to build preview" });
  }
});

/* ---------------------------------- Test ---------------------------------- */
router.post("/test", ...guard, async (req, res) => {
  try {
    const { to, subject = "Test from NFL Frenzy", body = "This is a test." } =
      req.body || {};
    const dest = (to && String(to).trim()) || req.admin?.email;
    if (!dest) return res.status(400).json({ error: "No destination email" });

    const html = emailSvc.renderBase({
      title: esc(subject),
      bodyHtml: renderBodyHtml(body),
    });

    const result = await emailSvc.send({
      to: dest,
      subject,
      html,
      text: body,
    });

    res.json({
      ok: true,
      sent_to: dest,
      email_configured: emailSvc.isConfigured(),
      result,
    });
  } catch (e) {
    console.error("adminEmail.test error:", e);
    res.status(500).json({ error: "Failed to send test email" });
  }
});

/* -------------------------------- Broadcast ------------------------------- */
router.post("/broadcast", ...guard, async (req, res) => {
  try {
    const {
      subject,
      body,
      audience = "all",
      emails,
      q,
      dryRun = false,
    } = req.body || {};
    if (!subject || !body)
      return res.status(400).json({ error: "subject and body are required" });

    const recipients = await listRecipients({ audience, emails, q });
    const html = emailSvc.renderBase({
      title: esc(subject),
      bodyHtml: renderBodyHtml(body),
    });

    if (dryRun) {
      return res.json({
        ok: true,
        dryRun: true,
        recipients_count: recipients.length,
        sample: recipients.slice(0, 10),
        email_configured: emailSvc.isConfigured(),
      });
    }

    let sent = 0;
    for (const to of recipients) {
      try {
        await emailSvc.send({ to, subject, html, text: body });
        sent += 1;
      } catch (err) {
        console.error("Send failed to", to, err?.message || err);
      }
    }

    res.json({
      ok: true,
      audience,
      recipients_count: recipients.length,
      sent_count: sent,
      email_configured: emailSvc.isConfigured(),
    });
  } catch (e) {
    console.error("adminEmail.broadcast error:", e);
    res.status(500).json({ error: "Failed to send broadcast" });
  }
});

module.exports = router;
