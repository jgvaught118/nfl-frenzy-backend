// backend/db/index.js
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || '';
const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';

/**
 * Decide if SSL is needed:
 * - Railway & other managed hosts often require SSL and supply "?sslmode=require"
 * - We also enable SSL in production by default, but allow self-signed certs
 */
const needSSL =
  /sslmode=require/i.test(connectionString) ||
  /\b(railway\.app|proxy\.rlwy\.net|amazonaws\.com|neon\.tech|supabase\.co)\b/i.test(connectionString) ||
  process.env.PGSSLMODE === 'require' ||
  isProd;

const pool = new Pool({
  connectionString,
  ssl: needSSL ? { rejectUnauthorized: false } : false,
});

// Helpful logs
pool.on('error', (err) => {
  console.error('[DB] Pool error:', err);
});

// Ping DB on startup so we can see success/failure in logs
(async () => {
  try {
    const r = await pool.query('select now() as now');
    console.log('[DB] Connected. now =', r.rows?.[0]?.now);
  } catch (e) {
    console.error('[DB] Connection test FAILED:', e);
  }
})();

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
