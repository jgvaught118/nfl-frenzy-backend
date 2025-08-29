// backend/routes/adminUsers.js
/**
 * Admin-only user management routes:
 * - List users (filter by status)
 * - Approve / decline pending signups
 * - Activate / deactivate accounts
 * - Promote / demote admin role
 * - Get / Delete user
 *
 * DB expectations (add if missing):
 *
 *   ALTER TABLE users
 *     ADD COLUMN IF NOT EXISTS pending_approval boolean NOT NULL DEFAULT true,
 *     ADD COLUMN IF NOT EXISTS is_active        boolean NOT NULL DEFAULT true;
 *
 * Notes:
 * - Login is blocked in /auth/login when pending_approval = true or is_active = false.
 * - We prevent removing the last active admin, and prevent an admin from deactivating/demoting themself if they'd become the last admin.
 */

const express = require('express');
const router = express.Router();
const pool = require('../db');
const authenticateToken = require('../middleware/authMiddleware');

/** ---- Helpers ---- **/

function shapeUser(u) {
  return {
    id: u.id,
    email: u.email,
    first_name: u.first_name,
    last_name: u.last_name,
    name: u.name,
    is_admin: !!u.is_admin,
    is_active: u.is_active,
    pending_approval: u.pending_approval,
    created_at: u.created_at,
  };
}

async function ensureAdmin(req, res, next) {
  try {
    const userId = req.user?.user_id;
    if (!userId) return res.status(401).json({ error: 'Unauthorized' });

    const q = await pool.query('SELECT is_admin FROM users WHERE id = $1', [userId]);
    if (!q.rows.length || !q.rows[0].is_admin) {
      return res.status(403).json({ error: 'Forbidden: admin only' });
    }
    next();
  } catch (e) {
    console.error('ensureAdmin error:', e);
    res.status(500).json({ error: 'Internal error (admin check)' });
  }
}

async function countActiveAdmins() {
  const r = await pool.query('SELECT COUNT(*)::int AS c FROM users WHERE is_admin = true AND is_active = true');
  return r.rows[0].c || 0;
}

async function getUserById(id) {
  const r = await pool.query('SELECT * FROM users WHERE id = $1', [id]);
  return r.rows[0] || null;
}

/** ---- List / Query ---- **/

/**
 * GET /admin/users
 * Optional query:
 *   - status = "pending" | "active" | "inactive" | "all" (default: "all")
 *   - q = search (email or name ilike)
 */
router.get(
  '/',
  authenticateToken,
  ensureAdmin,
  async (req, res) => {
    try {
      const { status = 'all', q } = req.query;

      const where = [];
      const params = [];

      if (status === 'pending') {
        where.push('pending_approval = true');
      } else if (status === 'active') {
        where.push('pending_approval = false AND is_active = true');
      } else if (status === 'inactive') {
        where.push('pending_approval = false AND is_active = false');
      } else if (status !== 'all') {
        return res.status(400).json({ error: 'Invalid status filter' });
      }

      if (q && String(q).trim()) {
        params.push(`%${String(q).trim()}%`);
        where.push('(email ILIKE $' + params.length + ' OR name ILIKE $' + params.length + ')');
      }

      const sql =
        `SELECT * FROM users` +
        (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
        ` ORDER BY created_at DESC NULLS LAST, id DESC`;

      const rows = (await pool.query(sql, params)).rows.map(shapeUser);
      res.json({ users: rows });
    } catch (err) {
      console.error('GET /admin/users error:', err);
      res.status(500).json({ error: 'Failed to list users' });
    }
  }
);

/**
 * GET /admin/users/pending
 * Convenience listing for pending approvals
 */
router.get(
  '/pending',
  authenticateToken,
  ensureAdmin,
  async (_req, res) => {
    try {
      const r = await pool.query(
        `SELECT * FROM users WHERE pending_approval = true ORDER BY created_at ASC NULLS LAST, id ASC`
      );
      res.json({ users: r.rows.map(shapeUser) });
    } catch (e) {
      console.error('GET /admin/users/pending error:', e);
      res.status(500).json({ error: 'Failed to fetch pending users' });
    }
  }
);

/**
 * GET /admin/users/:id
 */
router.get(
  '/:id',
  authenticateToken,
  ensureAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid user id' });
      const u = await getUserById(id);
      if (!u) return res.status(404).json({ error: 'User not found' });
      res.json({ user: shapeUser(u) });
    } catch (e) {
      console.error('GET /admin/users/:id error:', e);
      res.status(500).json({ error: 'Failed to fetch user' });
    }
  }
);

/** ---- Approvals ---- **/

/**
 * PUT /admin/users/:id/approve
 * - Sets pending_approval=false, is_active=true
 */
router.put(
  '/:id/approve',
  authenticateToken,
  ensureAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid user id' });

      const u = await getUserById(id);
      if (!u) return res.status(404).json({ error: 'User not found' });

      const upd = await pool.query(
        `UPDATE users
            SET pending_approval = false,
                is_active = true
          WHERE id = $1
        RETURNING *`,
        [id]
      );
      res.json({ ok: true, user: shapeUser(upd.rows[0]) });
    } catch (e) {
      console.error('PUT /admin/users/:id/approve error:', e);
      res.status(500).json({ error: 'Failed to approve user' });
    }
  }
);

/**
 * PUT /admin/users/:id/decline
 * - Marks as not pending and inactive (soft-decline)
 *   (You can DELETE instead if you prefer)
 */
router.put(
  '/:id/decline',
  authenticateToken,
  ensureAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid user id' });

      const u = await getUserById(id);
      if (!u) return res.status(404).json({ error: 'User not found' });

      const upd = await pool.query(
        `UPDATE users
            SET pending_approval = false,
                is_active = false
          WHERE id = $1
        RETURNING *`,
        [id]
      );
      res.json({ ok: true, user: shapeUser(upd.rows[0]) });
    } catch (e) {
      console.error('PUT /admin/users/:id/decline error:', e);
      res.status(500).json({ error: 'Failed to decline user' });
    }
  }
);

/** ---- Activation ---- **/

/**
 * PUT /admin/users/:id/activate
 */
router.put(
  '/:id/activate',
  authenticateToken,
  ensureAdmin,
  async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id)) return res.status(400).json({ error: 'Invalid user id' });

      const u = await getUserById(id);
      if (!u) return res.status(404).json({ error: 'User not found' });

      const upd = await pool.query(
        `UPDATE users
            SET is_active = true,
                pending_approval = false
          WHERE id = $1
        RETURNING *`,
        [id]
      );
      res.json({ ok: true, user: shapeUser(upd.rows[0]) });
    } catch (e) {
      console.error('PUT /admin/users/:id/activate error:', e);
      res.status(500).json({ error: 'Failed to activate user' });
    }
  }
);

/**
 * PUT /admin/users/:id/deactivate
 * - Prevent deactivating yourself if you'd become the last active admin
 */
router.put(
  '/:id/deactivate',
  authenticateToken,
  ensureAdmin,
  async (req, res) => {
    try {
      const targetId = Number(req.params.id);
      if (!Number.isFinite(targetId)) return res.status(400).json({ error: 'Invalid user id' });

      const actingId = req.user.user_id;
      const u = await getUserById(targetId);
      if (!u) return res.status(404).json({ error: 'User not found' });

      if (actingId === targetId && u.is_admin) {
        // self-deactivation as admin: ensure at least one other admin remains
        const admins = await countActiveAdmins();
        if (admins <= 1) {
          return res.status(400).json({ error: 'Cannot deactivate yourself as the last active admin' });
        }
      }

      // If target is an admin, ensure they are not the last active admin
      if (u.is_admin) {
        const admins = await countActiveAdmins();
        if (admins <= 1) {
          return res.status(400).json({ error: 'Cannot deactivate the last active admin' });
        }
      }

      const upd = await pool.query(
        `UPDATE users
            SET is_active = false
          WHERE id = $1
        RETURNING *`,
        [targetId]
      );
      res.json({ ok: true, user: shapeUser(upd.rows[0]) });
    } catch (e) {
      console.error('PUT /admin/users/:id/deactivate error:', e);
      res.status(500).json({ error: 'Failed to deactivate user' });
    }
  }
);

/** ---- Admin Role ---- **/

/**
 * PUT /admin/users/:id/admin-role
 * Body: { is_admin: boolean }
 * - Prevent demoting the last active admin
 * - Prevent self-demote if you'd become no-admin system
 */
router.put(
  '/:id/admin-role',
  authenticateToken,
  ensureAdmin,
  async (req, res) => {
    try {
      const targetId = Number(req.params.id);
      if (!Number.isFinite(targetId)) return res.status(400).json({ error: 'Invalid user id' });

      const { is_admin } = req.body || {};
      if (typeof is_admin !== 'boolean') {
        return res.status(400).json({ error: 'is_admin (boolean) is required' });
      }

      const actingId = req.user.user_id;
      const u = await getUserById(targetId);
      if (!u) return res.status(404).json({ error: 'User not found' });

      if (u.is_admin && !is_admin) {
        // Demoting an admin → ensure at least one other active admin remains
        const admins = await countActiveAdmins();
        if (admins <= 1) {
          return res.status(400).json({ error: 'Cannot demote the last active admin' });
        }
        if (actingId === targetId) {
          // Self-demote allowed only if there is another active admin
          const others = await countActiveAdmins();
          if (others <= 1) {
            return res.status(400).json({ error: 'Cannot demote yourself as the last active admin' });
          }
        }
      }

      const upd = await pool.query(
        `UPDATE users
            SET is_admin = $2
          WHERE id = $1
        RETURNING *`,
        [targetId, is_admin]
      );
      res.json({ ok: true, user: shapeUser(upd.rows[0]) });
    } catch (e) {
      console.error('PUT /admin/users/:id/admin-role error:', e);
      res.status(500).json({ error: 'Failed to update admin role' });
    }
  }
);

/** ---- Delete ---- **/

/**
 * DELETE /admin/users/:id
 * - Optional hard-delete. Protect last active admin.
 */
router.delete(
  '/:id',
  authenticateToken,
  ensureAdmin,
  async (req, res) => {
    try {
      const targetId = Number(req.params.id);
      if (!Number.isFinite(targetId)) return res.status(400).json({ error: 'Invalid user id' });

      const u = await getUserById(targetId);
      if (!u) return res.status(404).json({ error: 'User not found' });

      if (u.is_admin && u.is_active) {
        const admins = await countActiveAdmins();
        if (admins <= 1) {
          return res.status(400).json({ error: 'Cannot delete the last active admin' });
        }
      }

      await pool.query('DELETE FROM users WHERE id = $1', [targetId]);
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE /admin/users/:id error:', e);
      res.status(500).json({ error: 'Failed to delete user' });
    }
  }
);

module.exports = router;
