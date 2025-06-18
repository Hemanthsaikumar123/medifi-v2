const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const passport = require('passport');
const pool = require('../db');

// GET: Signup Page
router.get('/signup', (req, res) => {
  res.render('signup', { message: req.flash('error') });
});

// POST: Signup Form
router.post('/signup', async (req, res) => {
  const { username, email, password } = req.body;
  const hashedPassword = await bcrypt.hash(password, 10);
  try {
    await pool.query(
      'INSERT INTO users (username, email, password) VALUES ($1, $2, $3)',
      [username, email, hashedPassword]
    );
    res.redirect('/login');
  } catch (err) {
    req.flash('error', 'User already exists');
    res.redirect('/signup');
  }
});

// GET: Login Page
router.get('/login', (req, res) => {
  res.render('login', { message: req.flash('error') });
});

// POST: Login
router.post('/login', passport.authenticate('local', {
  successRedirect: '/',
  failureRedirect: '/login',
  failureFlash: true
}));

// GET: Logout
router.get('/logout', (req, res) => {
  req.logout(() => {
    res.redirect('/login');
  });
});

module.exports = router;
