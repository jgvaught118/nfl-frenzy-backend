// backend/routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs'); // keep bcryptjs to match your stack
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const pool = require('../db');
const emailSvc = require('../services/email');

const JWT_SECRET = process.env.JWT_SECRET;
const TOKEN_TTL = '12h';
const RESET_TOKEN_BYTES = 32;          // 64 hex chars
const RESET_EXPIRES_HOURS = 2;         // reset link validity

/* --------------------------------- Utils --------------------------------- */

function normalizeEmail(raw = '') {
  return raw.trim().toLowerCase();
}

function signToken(userId) {
  return jwt.sign({ user_id: userId }, JWT_SECRET, { expiresIn: TOKEN_TTL });
}

/**
 * Normalize backend row to a stable shape for the frontend.
 * Handles legacy/variant schemas:
 *  - Some DBs have (approved, deactivated)
 *  - Others have (pending_approval, is_active)
 */
function shapeUser(u = {}) {
  // derive approved
  let approved;
  if (typeof u.approved === 'boolean') {
    approved = u.approved;
  } else if (typeof u.pending_approval === 'boolean') {
    approved = !u.pending_approval;
  } else {
    approved = true;
  }

  // derive deactivated
  let deactivated;
  if (typeof u.deactivated === 'boolean') {
    deactivated = u.deactivated;
  } else if (typeof u.is_active === 'boolean') {
    deactivated = !u.is_active;
  } else {
    deactivated = false;
  }

  // derive pending_approval
  const pending_approval =
    typeof u.pending_approval === 'boolean' ? u.pending_approval : !approved;

  // derive is_active
  let is_active;
  if (typeof u.is_active === 'boolean') {
    is_active = u.is_active;
  } else {
    is_active = approved && !deactivated;
  }

  return {
    id: u.id,
    email: u.email,
    first_name: u.first_name,
    last_name: u.last_name,
    name: u.name,
    is_admin: !!u.is_admin,
    approved,
    deactivated,
    pending_approval,
    is_active,
    created_at: u.created_at,
  };
}

function requireJwt(req, res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Missing token' });
    if (!JWT_SECRET) return res.status(500).json({ error: 'Server misconfigured: JWT_SECRET missing' });
    const decoded = jwt.verify(token, JWT_SECRET);
    req.auth = decoded; // { user_id }
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

/* --------------------------------- Signup -------------------------------- */

async function handleSignup(req, res) {
  try {
    if (!JWT_SECRET) {
      return res.status(500).json({ error: 'Server misconfigured: JWT_SECRET missing' });
    }

    let { email, password, first_name, last_name = '', name = '' } = req.body || {};
    email = normalizeEmail(email);

    if (!email || !password || !first_name) {
      return res.status(400).json({ error: 'Email, password, and first name are required' });
    }
    if (password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Email uniqueness
    const existing = await pool.query(
      'SELECT id FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1',
      [email]
    );
    if (existing.rows.length) {
      return res.status(409).json({ error: 'An account with this email already exists' });
    }

    const hashed = await bcrypt.hash(password, 10);
    const displayName =
      (first_name?.trim() || '') +
      (last_name?.trim() ? ` ${last_name.trim()}` : '') ||
      (name?.trim() || null);

    // Prefer modern schema (approved, deactivated). Fallback to legacy.
    try {
      await pool.query(
        `INSERT INTO users (email, password, first_name, last_name, name, is_admin, approved, deactivated)
         VALUES ($1,$2,$3,$4,$5,false,false,false)`,
        [email, hashed, first_name || null, last_name || null, displayName]
      );
    } catch (e) {
      // Legacy schema fallback (no approved/deactivated)
      await pool.query(
        `INSERT INTO users (email, password, first_name, last_name, name, is_admin)
         VALUES ($1,$2,$3,$4,$5,false)`,
        [email, hashed, first_name || null, last_name || null, displayName]
      );
    }

    // New accounts are pending; no token yet.
    return res.status(201).json({
      ok: true,
      status: 'pending',
      pending: true,
      message: 'Account created. An admin must approve your access before you can sign in.'
    });
  } catch (err) {
    console.error('Error during signup:', err);
    return res.status(500).json({ error: 'Server error during signup' });
  }
}

router.post('/signup', handleSignup);
router.post('/register', handleSignup);

/* ---------------------------------- Login --------------------------------- */
/**
 * POST /auth/login
 * Rules:
 *  - If user is deactivated/inactive => 403 { code: "INACTIVE" }
 *  - Else if user is pending approval and not admin => 403 { code: "PENDING_APPROVAL" }
 *  - Else: return token + user
 *
 * NOTE: We check INACTIVE **first** so deactivated accounts don't appear as "pending".
 */
router.post('/login', async (req, res) => {
  try {
    if (!JWT_SECRET) {
      return res.status(500).json({ error: 'Server misconfigured: JWT_SECRET missing' });
    }

    const email = normalizeEmail(req.body?.email);
    const { password } = req.body || {};
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const q = await pool.query('SELECT * FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1', [email]);
    const rawUser = q.rows[0];
    if (!rawUser) return res.status(401).json({ error: 'Invalid email or password' });

    const ok = await bcrypt.compare(password, rawUser.password || '');
    if (!ok) return res.status(401).json({ error: 'Invalid email or password' });

    // Normalize/derive flags for consistent gating logic
    const u = shapeUser(rawUser);

    // Check INACTIVE first
    if (!u.is_active || u.deactivated) {
      return res.status(403).json({
        code: 'INACTIVE',
        error: 'Your account is deactivated. Contact an admin.'
      });
    }

    // Then check pending approval (non-admins)
    if (u.pending_approval && !u.is_admin) {
      return res.status(403).json({
        code: 'PENDING_APPROVAL',
        error: 'Your account is awaiting admin approval.'
      });
    }

    const token = signToken(u.id);
    return res.json({ token, user: u });
  } catch (err) {
    console.error('Error during login:', err);
    return res.status(500).json({ error: 'Server error during login' });
  }
});

/* ----------------------------- Password Reset ----------------------------- */
/**
 * POST /auth/request-reset
 * Body: { email }
 * Always returns 200 with generic message.
 * If user exists: creates a reset token (valid for RESET_EXPIRES_HOURS) and emails it.
 */
router.post('/request-reset', async (req, res) => {
  try {
    const email = normalizeEmail(req.body?.email);
    if (!email) return res.status(200).json({ ok: true, message: 'If that email exists, a reset link has been created.' });

    // Find user
    const uq = await pool.query('SELECT id, email FROM users WHERE LOWER(email)=LOWER($1) LIMIT 1', [email]);
    const user = uq.rows[0];

    // Always respond the same to avoid email enumeration
    const generic = { ok: true, message: 'If that email exists, a reset link has been created.' };

    if (!user) return res.json(generic);

    // Create token + expiry
    const token = crypto.randomBytes(RESET_TOKEN_BYTES).toString('hex');
    const expires_at = new Date(Date.now() + RESET_EXPIRES_HOURS * 60 * 60 * 1000);

    await pool.query(
      `INSERT INTO password_resets (user_id, token, expires_at, used)
       VALUES ($1, $2, $3, false)`,
      [user.id, token, expires_at]
    );

    const result = await emailSvc.sendPasswordResetEmail(user.email, token, RESET_EXPIRES_HOURS);

    // In dev (no SMTP), include the URL for convenience
    const payload = { ...generic };
    if (result.simulated && result.reset_url) payload.dev_reset_url = result.reset_url;

    return res.json(payload);
  } catch (err) {
    console.error('Error in /auth/request-reset:', err);
    // Still return generic to avoid leaking details
    return res.status(200).json({ ok: true, message: 'If that email exists, a reset link has been created.' });
  }
});

/**
 * GET /auth/validate-reset?token=...
 * Returns { ok: true } if token exists, unused, and not expired; 400 otherwise.
 */
router.get('/validate-reset', async (req, res) => {
  try {
    const token = (req.query?.token || '').trim();
    if (!token) return res.status(400).json({ error: 'Missing token' });

    const q = await pool.query(
      `SELECT id FROM password_resets
       WHERE token = $1 AND used = false AND expires_at > NOW()
       LIMIT 1`,
      [token]
    );

    if (!q.rows.length) {
      return res.status(400).json({ error: 'Reset link is invalid or expired' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('Error in /auth/validate-reset:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/**
 * POST /auth/perform-reset
 * Body: { token, new_password }
 * If valid: updates user password and marks the token as used (and optional: retires other tokens for that user).
 */
router.post('/perform-reset', async (req, res) => {
  try {
    const token = (req.body?.token || '').trim();
    const newPassword = req.body?.new_password || '';

    if (!token || !newPassword) {
      return res.status(400).json({ error: 'Token and new password are required' });
    }
    if (newPassword.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters' });
    }

    // Find a valid reset row
    const rq = await pool.query(
      `SELECT pr.id, pr.user_id
         FROM password_resets pr
        WHERE pr.token = $1 AND pr.used = false AND pr.expires_at > NOW()
        LIMIT 1`,
      [token]
    );
    const row = rq.rows[0];
    if (!row) return res.status(400).json({ error: 'Reset link is invalid or expired' });

    // Update password
    const hashed = await bcrypt.hash(newPassword, 10);
    await pool.query(`UPDATE users SET password=$1 WHERE id=$2`, [hashed, row.user_id]);

    // Mark this token as used
    await pool.query(`UPDATE password_resets SET used = true WHERE id = $1`, [row.id]);

    // (Optional) Retire any other outstanding tokens for this user
    await pool.query(
      `UPDATE password_resets SET used = true WHERE user_id = $1 AND used = false`,
      [row.user_id]
    );

    return res.json({ ok: true, message: 'Password updated. You can now sign in with your new password.' });
  } catch (err) {
    console.error('Error in /auth/perform-reset:', err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* ------------------------------------ Me ---------------------------------- */

router.get('/me', requireJwt, async (req, res) => {
  try {
    const { user_id } = req.auth;
    const q = await pool.query('SELECT * FROM users WHERE id=$1', [user_id]);
    const row = q.rows[0];
    if (!row) return res.status(404).json({ error: 'User not found' });
    return res.json({ user: shapeUser(row) });
  } catch (e) {
    console.error('Error in /auth/me:', e);
    return res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
