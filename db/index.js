// backend/db/index.js
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || '';
const isProd = (process.env.NODE_ENV || '').toLowerCase() === 'production';

/**
 * Railway / managed DBs need SSL, but the cert is self-signed.
 * Force SSL and disable cert verification only when we detect a managed host
 * or sslmode=require, or in production as a fallback.
 */
const needSSL =
  /sslmode=require/i.test(connectionString) ||
  /\b(railway\.app|proxy\.rlwy\.net|amazonaws\.com|neon\.tech|supabase\.co)\b/i.test(connectionString) ||
  isProd;

// As an additional guardrail for managed DBs, disable Node TLS verification
// ONLY when we decided SSL is needed (i.e., managed environments).
if (needSSL) {
  // NOTE: This affects only this process.
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const pool = new Pool({
  connectionString,
  // Explicitly request SSL and tell pg not to verify the chain
  ssl: needSSL ? { require: true, rejectUnauthorized: false } : false,
});

// Helpful logs
pool.on('error', (err) => {
  console.error('[DB] Pool error:', err);
});

// Ping DB on startup so logs show whether we are connected
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
