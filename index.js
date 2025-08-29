// backend/index.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const app = express();
const PORT = process.env.PORT || 5001;

/* --------------------------------------------------------------------------
 * CORS (supports multiple origins via CORS_ORIGIN env)
 * Example .env:
 *   CORS_ORIGIN=http://localhost:5173,http://localhost:4173,https://your.site
 * -------------------------------------------------------------------------- */
const allowedOrigins = (process.env.CORS_ORIGIN ||
  "http://localhost:5173,http://localhost:4173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Helpful in some proxies/CDNs to ensure correct caching behavior
app.use((req, res, next) => {
  res.header("Vary", "Origin");
  next();
});

const corsOptions = {
  origin(origin, cb) {
    // Allow requests without Origin (curl/Postman) and any whitelisted origin
    if (!origin || allowedOrigins.includes(origin)) return cb(null, true);
    return cb(new Error("CORS: origin not allowed"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "DELETE", "PATCH", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204, // for legacy browsers
};

app.use(cors(corsOptions));
// (Optional) If you want to be extra explicit for preflight:
// app.options("*", cors(corsOptions));

/* --------------------------------------------------------------------------
 * Core middleware
 * -------------------------------------------------------------------------- */
app.use(express.json());
app.use(morgan("dev"));

/* --------------------------------------------------------------------------
 * Routes
 * -------------------------------------------------------------------------- */
const authRoutes = require("./routes/auth");            // /auth/login, /auth/signup, /auth/me
const userRoutes = require("./routes/users");           // additional user routes (NOT login/signup)
const pickRoutes = require("./routes/picks");
const gameRoutes = require("./routes/games");
const adminRoutes = require("./routes/admin");
const leaderboardRoutes = require("./routes/leaderboard");
const adminUsersRoutes = require("./routes/adminUsers");
const passwordResetRoutes = require("./routes/passwordReset");
const adminEmailRoutes = require("./routes/adminEmail");

// Expose auth under BOTH /auth and /users for compatibility with older frontend code
app.use("/auth", authRoutes);
app.use("/users", authRoutes);

// Extra user endpoints live here (ensure these do NOT redefine /login or /signup)
app.use("/users", userRoutes);

// App feature routes
app.use("/picks", pickRoutes);
app.use("/games", gameRoutes);
app.use("/admin", adminRoutes);
app.use("/leaderboard", leaderboardRoutes);
app.use("/admin/users", adminUsersRoutes);
app.use("/auth", passwordResetRoutes);
app.use("/admin/email", adminEmailRoutes);

/* --------------------------------------------------------------------------
 * Health / Debug
 * -------------------------------------------------------------------------- */
app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    env: process.env.NODE_ENV || "development",
    time: new Date().toISOString(),
    cors_allowed: allowedOrigins,
  });
});

app.get("/whoami", (req, res) => {
  res.json({
    mounted: {
      auth: true,
      users_auth_alias: true,
      users_extra: true,
      picks: true,
      games: true,
      admin: true,
      leaderboard: true,
      admin_users: true,
      admin_email: true,
    },
    time: new Date().toISOString(),
  });
});

app.get("/", (req, res) => {
  res.send("NFL Frenzy Backend is running.");
});

/* --------------------------------------------------------------------------
 * Start server
 * -------------------------------------------------------------------------- */
app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
