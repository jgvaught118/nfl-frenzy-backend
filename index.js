// backend/index.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const app = express();
const PORT = process.env.PORT || 5001;

/* --------------------------------------------------------------------------
 * CORS (multi-origin + wildcard support)
 * Set CORS_ORIGIN env to a comma-separated list, e.g.:
 *   CORS_ORIGIN=https://wacksnflfrenzy.netlify.app,*.netlify.app,http://localhost:5173,http://localhost:4173
 * -------------------------------------------------------------------------- */
const rawAllowed = (process.env.CORS_ORIGIN ||
  "http://localhost:5173,http://localhost:4173")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Help caches/CDNs vary by Origin
app.use((req, res, next) => {
  res.header("Vary", "Origin");
  next();
});

// Accept exact matches and *.netlify.app if present
function isOriginAllowed(origin) {
  // Non-browser tools (curl/health checks) may not send Origin
  if (!origin) return true;

  // Exact match
  if (rawAllowed.includes(origin)) return true;

  // Wildcard for Netlify previews
  try {
    const host = new URL(origin).hostname; // e.g. wacksnflfrenzy.netlify.app
    if (rawAllowed.includes("*.netlify.app") && host.endsWith(".netlify.app")) {
      return true;
    }
  } catch {
    // ignore malformed Origin
  }

  return false;
}

const corsOptions = {
  origin(origin, cb) {
    if (isOriginAllowed(origin)) return cb(null, true);
    console.warn("CORS blocked origin:", origin, "allowed=", rawAllowed);
    cb(new Error("CORS: origin not allowed"));
  },
  credentials: true,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization"],
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
// Ensure preflight is handled explicitly as well
app.options("*", cors(corsOptions));

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

// Auth under BOTH /auth and /users for older frontends
app.use("/auth", authRoutes);
app.use("/users", authRoutes);

// Extra user endpoints (must NOT redefine /login or /signup)
app.use("/users", userRoutes);

// Feature routes
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
    cors_allowed: rawAllowed,
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
