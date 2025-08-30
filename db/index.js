// backend/db/index.js
const { Pool } = require('pg');

const connectionString = process.env.DATABASE_URL || '';
const isProd = process.env.NODE_ENV === 'production';

// Require SSL on managed DBs (Railway/Neon/Supabase/etc) or when PGSSLMODE=require
const needSSL =
  /\b(railway\.app|proxy\.rlwy\.net|amazonaws\.com|neon\.tech|supabase\.co)\b/i.test(connectionString) ||
  process.env.PGSSLMODE === 'require' ||
  isProd;

const pool = new Pool({
  connectionString,
  ssl: needSSL ? { rejectUnauthorized: false } : false,
});

module.exports = {
  query: (text, params) => pool.query(text, params),
  pool,
};
