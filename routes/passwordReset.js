// backend/routes/passwordReset.js
const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const pool = require('../db');

const FRONTEND_BASE_URL = process.env.FRONTEND_BASE_URL || 'http://localhost:5173';
const RESET_TOKEN_TTL_HOURS = parseInt(process.env.RESET_TOKEN_TTL_HOURS || '2', 10);

// Helper to build a reset URL the frontend can handle.
// You can later point this to a dedicated page like /reset?token=...
function buildResetUrl(token) {
  // If you add a dedicated ResetPassword page later, change this path accordingly.
  return `${FRONTEND_BASE_URL}/?mode=reset&token=${encodeURIComponent(token)}`;
}

/**
 * POST /auth/request-reset
 * Body: { email }
 * Always returns 200 to avoid email enumeration.
 * In dev, includes dev_reset_url if a user exists.
 */
router.post('/request-reset', async (req, res) => {
  try {
    const rawEmail = (req.body?.email || '').trim().toLowerCase();
    if (!rawEmail) {
      // Still return 200; don't leak info
      return res.json({ ok: true, message: 'If that email exists, a reset link has been created.' });
    }

    const u = await pool.query('SELECT id, email FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1', [rawEmail]);
    const user = u.rows[0];

    // Always respond OK to prevent enumeration
    if (!user) {
      return res.json({ ok: true, message: 'If that email exists, a reset link has been created.' });
    }

    // Create token
    const token = crypto.randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + RESET_TOKEN_TTL_HOURS * 3600 * 1000);

    // Optionally invalidate old unused tokens for this user (cleanup)
    await pool.query(
      'UPDATE password_resets SET used=true WHERE user_id=$1 AND used=false AND expires_at > NOW()',
      [user.id]
    );

    // Insert new reset row
    await pool.query(
      `INSERT INTO password_resets (user_id, token, expires_at, used)
       VALUES ($1, $2, $3, false)`,
      [user.id, token, expiresAt]
    );

    const url = buildResetUrl(token);

    // In dev, return the URL so you can click it; in prod you’d email it
    console.log('[password-reset] dev reset URL:', url);

    return res.json({
      ok: true,
      message: 'If that email exists, a reset link has been created.',
      dev_reset_url: url
    });
  } catch (err) {
    console.error('request-reset error:', err);
    return res.status(500).json({ error: 'Failed to create reset link' });
  }
});

/**
 * POST /auth/perform-reset
 * Body: { token, new_password }
 */
router.post('/perform-reset', async (req, res) => {
  try {
    const { token, new_password } = req.body || {};
    if (!token || !new_password) {
      return res.status(400).json({ error: 'Missing token or new password' });
    }
    if (new_password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Find valid reset row
    const r = await pool.query(
      `SELECT id, user_id
         FROM password_resets
        WHERE token = $1
          AND used = false
          AND expires_at > NOW()
        LIMIT 1`,
      [token]
    );
    const row = r.rows[0];
    if (!row) {
      return res.status(400).json({ error: 'Reset link is invalid or expired' });
    }

    // Update user password
    const hashed = await bcrypt.hash(new_password, 10);
    await pool.query('UPDATE users SET password=$1 WHERE id=$2', [hashed, row.user_id]);

    // Mark token as used
    await pool.query('UPDATE password_resets SET used=true WHERE id=$1', [row.id]);

    // (Optional) Log out other sessions — not implemented here, but you can rotate JWT secrets per-user if needed.

    return res.json({ ok: true, message: 'Password updated. You can now sign in with your new password.' });
  } catch (err) {
    console.error('perform-reset error:', err);
    return res.status(500).json({ error: 'Failed to reset password' });
  }
});

module.exports = router;
