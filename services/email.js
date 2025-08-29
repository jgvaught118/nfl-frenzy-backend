// backend/services/email.js
// Email helper: supports "console" mode for dev and SMTP for prod.
// Exports: isConfigured, renderBase, send, sendMail, sendPasswordResetEmail,
//          sendBroadcastEmail, buildResetUrl, isSmtpConfigured.

let nodemailer = null;
try {
  nodemailer = require("nodemailer");
} catch {
  // ok if not installed; console mode still works
}

const {
  EMAIL_MODE = "",           // "console" to force console mode
  SMTP_HOST = "",
  SMTP_PORT = "587",
  SMTP_USER = "",
  SMTP_PASS = "",
  FROM_EMAIL = 'NFL Frenzy <no-reply@nflfrenzy.local>',
  APP_ORIGIN = "http://localhost:5173",
} = process.env;

/* ------------------------------ Utilities ------------------------------ */

function isSmtpConfigured() {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS && nodemailer);
}

function isConfigured() {
  if (EMAIL_MODE.toLowerCase() === "console") return true;
  return isSmtpConfigured();
}

function getTransporter() {
  if (!isSmtpConfigured()) return null;
  // Create lazily; nodemailer can reuse connection pooling internally.
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT, 10),
    secure: parseInt(SMTP_PORT, 10) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
  });
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderBase({ title = "NFL Frenzy", bodyHtml = "" } = {}) {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="x-apple-disable-message-reformatting" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    body { margin:0; padding:0; background:#f6f7f9; font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif; color:#111827; }
    .container { max-width:640px; margin:24px auto; background:#ffffff; border:1px solid #e5e7eb; border-radius:12px; overflow:hidden; }
    .header { padding:16px 20px; border-bottom:1px solid #f0f2f5; font-size:16px; font-weight:700; }
    .content { padding:20px; line-height:1.6; font-size:15px; }
    .footer { padding:14px 20px; font-size:12px; color:#6b7280; border-top:1px solid #f0f2f5; }
    p { margin:0 0 12px 0; }
    a { color:#2563eb; text-decoration:underline; }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">${escapeHtml(title)}</div>
    <div class="content">
      ${bodyHtml}
    </div>
    <div class="footer">
      Sent by NFL Frenzy
    </div>
  </div>
</body>
</html>`;
}

/* ------------------------------ Core send ------------------------------ */

async function send({ to, subject, html, text }) {
  const consoleMode = EMAIL_MODE.toLowerCase() === "console" || !isSmtpConfigured();

  if (consoleMode) {
    console.log("──────────────────────────────");
    console.log("[EMAIL:console] To:    ", to);
    console.log("[EMAIL:console] From:  ", FROM_EMAIL);
    console.log("[EMAIL:console] Subj:  ", subject);
    if (text) console.log("[EMAIL:console] Text:\n", text);
    if (html) console.log("[EMAIL:console] HTML:\n", html);
    console.log("──────────────────────────────");
    return { mode: "console", to, subject };
  }

  const transporter = getTransporter();
  const info = await transporter.sendMail({
    from: FROM_EMAIL,
    to,
    subject,
    text,
    html,
  });

  return {
    mode: "smtp",
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    response: info.response,
  };
}

// Back-compat alias for older code paths
async function sendMail(opts) {
  return send(opts);
}

/* --------------------------- Higher-level APIs -------------------------- */

function buildResetUrl(token) {
  return `${APP_ORIGIN}/?mode=reset&token=${encodeURIComponent(token)}`;
}

async function sendPasswordResetEmail(to, token, expiresHours = 2) {
  const url = buildResetUrl(token);
  const subject = "Reset your NFL Frenzy password";
  const text = [
    "You (or someone else) requested a password reset for your NFL Frenzy account.",
    `Reset link: ${url}`,
    `This link will expire in ${expiresHours} hour(s).`,
    "",
    "If you didn't request this, you can ignore this email.",
  ].join("\n");

  const bodyHtml = `
    <p>You (or someone else) requested a password reset for your NFL Frenzy account.</p>
    <p>
      <a href="${url}" style="display:inline-block;background:#0ea5e9;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none;">
        Reset Password
      </a>
    </p>
    <p style="font-size:14px;color:#555;">This link will expire in ${expiresHours} hour(s).</p>
    <p style="font-size:13px;color:#666;">If you didn't request this, you can safely ignore this email.</p>
  `;

  const html = renderBase({ title: subject, bodyHtml });
  return send({ to, subject, html, text });
}

async function sendBroadcastEmail(recipients, subject, { html, text }) {
  const list = Array.isArray(recipients) ? recipients.filter(Boolean) : [];
  if (!list.length) return { ok: true, sent: 0, mode: isConfigured() ? (EMAIL_MODE || "smtp") : "console" };

  let sent = 0;
  for (const to of list) {
    try {
      await send({ to, subject, html, text });
      sent += 1;
    } catch (err) {
      console.error("[broadcast] failed to", to, err?.message || err);
    }
  }
  return { ok: true, sent, mode: EMAIL_MODE || (isSmtpConfigured() ? "smtp" : "console") };
}

/* -------------------------------- Exports -------------------------------- */

module.exports = {
  // expected by routes/adminEmail.js
  isConfigured,
  renderBase,
  send,

  // keep your earlier helpers too
  isSmtpConfigured,
  sendMail,
  sendPasswordResetEmail,
  sendBroadcastEmail,
  buildResetUrl,
};
