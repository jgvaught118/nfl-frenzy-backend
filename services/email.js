// backend/services/email.js
// Modes supported via env: "sendgrid", "smtp", "console"
// Exports: isConfigured, renderBase, send, sendMail, sendPasswordResetEmail,
//          sendBroadcastEmail, buildResetUrl, isSmtpConfigured.

let nodemailer = null;
try { nodemailer = require("nodemailer"); } catch {}

let sgMail = null;
try { sgMail = require("@sendgrid/mail"); } catch {}

const {
  EMAIL_MODE = "",                 // sendgrid | smtp | console
  SENDGRID_API_KEY = "",
  SMTP_HOST = "",
  SMTP_PORT = "587",
  SMTP_USER = "",
  SMTP_PASS = "",
  FROM_EMAIL = 'NFL Frenzy <no-reply@nflfrenzy.local>', // MUST be verified in SendGrid when EMAIL_MODE=sendgrid
  REPLY_TO_EMAIL = "",            // optional
  APP_ORIGIN = "http://localhost:5173",
} = process.env;

/* ------------------------------ Utilities ------------------------------ */

function isSmtpConfigured() {
  return Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS && nodemailer);
}

function isSendgridConfigured() {
  return Boolean(SENDGRID_API_KEY && sgMail);
}

function isConfigured() {
  const mode = EMAIL_MODE.toLowerCase();
  if (mode === "console") return true;
  if (mode === "sendgrid") return isSendgridConfigured();
  if (mode === "smtp") return isSmtpConfigured();
  // default fallback: try SMTP, else console
  return isSmtpConfigured() || true;
}

function getTransporter() {
  if (!isSmtpConfigured()) return null;
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: parseInt(SMTP_PORT, 10),
    secure: parseInt(SMTP_PORT, 10) === 465,
    auth: { user: SMTP_USER, pass: SMTP_PASS },
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 30000,
  });
}

function escapeHtml(str = "") {
  return String(str)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
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
    <div class="footer">Sent by NFL Frenzy</div>
  </div>
</body>
</html>`;
}

/* ------------------------------ Send helpers ---------------------------- */

async function sendViaConsole({ to, subject, html, text }) {
  /* eslint-disable no-console */
  console.log("──────────────── EMAIL (console) ────────────────");
  console.log("To:   ", to);
  console.log("From: ", FROM_EMAIL);
  if (REPLY_TO_EMAIL) console.log("Reply-To:", REPLY_TO_EMAIL);
  console.log("Subj: ", subject);
  if (text) console.log("--- TEXT ---\n", text);
  if (html) console.log("--- HTML ---\n", html);
  console.log("─────────────────────────────────────────────────");
  return { mode: "console", to, subject };
}

async function sendViaSMTP({ to, subject, html, text }) {
  const tx = getTransporter();
  if (!tx) throw new Error("SMTP not configured");
  const info = await tx.sendMail({
    from: FROM_EMAIL,
    to,
    subject,
    text,
    html,
    ...(REPLY_TO_EMAIL ? { replyTo: REPLY_TO_EMAIL } : {}),
  });
  return {
    mode: "smtp",
    messageId: info.messageId,
    accepted: info.accepted,
    rejected: info.rejected,
    response: info.response,
  };
}

async function sendViaSendgrid({ to, subject, html, text }) {
  if (!isSendgridConfigured()) throw new Error("SENDGRID_API_KEY missing or @sendgrid/mail not installed");
  sgMail.setApiKey(SENDGRID_API_KEY);
  const msg = {
    to,
    from: FROM_EMAIL, // must be a verified sender in SendGrid
    subject,
    text,
    html,
    ...(REPLY_TO_EMAIL ? { replyTo: REPLY_TO_EMAIL } : {}),
  };
  const [resp] = await sgMail.send(msg);
  return { mode: "sendgrid", statusCode: resp.statusCode };
}

/* ------------------------------ Core send ------------------------------ */

async function send(opts) {
  const mode = (EMAIL_MODE || "").toLowerCase();
  try {
    if (mode === "sendgrid") return await sendViaSendgrid(opts);
    if (mode === "smtp")     return await sendViaSMTP(opts);
    if (mode === "console")  return await sendViaConsole(opts);

    // Fallback: try SMTP first, else console
    if (isSmtpConfigured()) return await sendViaSMTP(opts);
    return await sendViaConsole(opts);
  } catch (err) {
    // Surface a helpful message to route handlers
    console.error("Email send failed:", err);
    if (mode === "sendgrid") {
      throw new Error("SendGrid send failed. Check SENDGRID_API_KEY and verified FROM_EMAIL.");
    }
    if (mode === "smtp") {
      throw new Error("SMTP send failed. Check SMTP_* settings and provider firewall rules.");
    }
    throw err;
  }
}

// Back-compat alias
async function sendMail(opts) {
  return send(opts);
}

/* --------------------------- Higher-level APIs -------------------------- */

// Keep your current reset URL shape to match frontend logic
function buildResetUrl(token) {
  // Your app currently expects `/?mode=reset&token=...`
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

  const result = await send({ to, subject, html, text });
  // Helpful for debugging / dev
  return { ...result, reset_url: url };
}

async function sendBroadcastEmail(recipients, subject, { html, text }) {
  const list = Array.isArray(recipients) ? recipients.filter(Boolean) : [];
  const mode = (EMAIL_MODE || (isSmtpConfigured() ? "smtp" : "console")) || "console";
  if (!list.length) return { ok: true, sent: 0, mode };

  let sent = 0;
  for (const to of list) {
    try {
      await send({ to, subject, html, text });
      sent += 1;
    } catch (err) {
      console.error("[broadcast] failed to", to, err?.message || err);
    }
  }
  return { ok: true, sent, mode };
}

/* -------------------------------- Exports -------------------------------- */

module.exports = {
  isConfigured,
  renderBase,
  send,
  isSmtpConfigured,
  sendMail,
  sendPasswordResetEmail,
  sendBroadcastEmail,
  buildResetUrl,
};
