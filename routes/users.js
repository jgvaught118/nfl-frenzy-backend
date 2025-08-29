const express = require('express');
const router = express.Router();
const db = require('../db');
const bcrypt = require('bcryptjs');

// POST /users - Create a new user
router.post('/', async (req, res) => {
  const { name, email, password } = req.body;

  try {
    const hashedPassword = await bcrypt.hash(password, 10);

    const result = await db.query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING *',
      [name, email, hashedPassword]
    );

    const { password: _, ...userWithoutPassword } = result.rows[0];
    res.status(201).json(userWithoutPassword);
  } catch (err) {
    console.error('❌ Error creating user:', err);
    res.status(500).json({ error: 'User could not be created' });
  }
});

// POST /users/login - Authenticate user
router.post('/login', async (req, res) => {
  const { email, password } = req.body;
  console.log('🔐 Login attempt for:', email);

  try {
    const result = await db.query('SELECT * FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      console.log('❌ No user found for email');
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const user = result.rows[0];
    console.log('✅ User found:', user.email);

    const isMatch = await bcrypt.compare(password, user.password);
    console.log('🔍 Password match result:', isMatch);

    if (!isMatch) {
      console.log('❌ Password does not match');
      return res.status(401).json({ message: 'Invalid email or password' });
    }

    const { password: _, ...userWithoutPassword } = user;
    res.json({ user: userWithoutPassword });
  } catch (err) {
    console.error('🔥 Login error:', err);
    res.status(500).json({ message: 'Server error during login' });
  }
});

// GET /users/test - Simple test route
router.get('/test', (req, res) => {
  res.send('✅ Users route is working!');
});

module.exports = router;
