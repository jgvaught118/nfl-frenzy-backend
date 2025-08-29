// middleware/isAdmin.js
const pool = require('../db');

const isAdmin = async (req, res, next) => {
  try {
    const userId = req.header('x-user-id');

    console.log('🔍 Incoming x-user-id header:', userId); // 👈 Debug line

    if (!userId) {
      return res.status(401).json({ error: 'Missing user ID' });
    }

    const result = await pool.query(
      'SELECT is_admin FROM users WHERE id = $1',
      [userId]
    );

    console.log('🔍 User record found:', result.rows[0]); // 👈 Debug line

    if (result.rows.length === 0 || !result.rows[0].is_admin) {
      return res.status(403).json({ error: 'Access denied. Admins only.' });
    }

    next();
  } catch (error) {
    console.error('Error in isAdmin middleware:', error);
    res.status(500).json({ error: 'Server error in admin check' });
  }
};

module.exports = isAdmin;
