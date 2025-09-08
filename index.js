// backend/index.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const app = express();
const PORT = process.env.PORT || 5001;

/* --------------------------------------------------------------------------
 * CORS — robust & flexible
 * - CORS_ORIGIN can be:
 *     "*"                           => allow all origins
 *     "https://site,*.netlify.app"  => CSV list, supports wildcard prefixes
 * - If CORS_ORIGIN is unset, we default to localhost.
 * -------------------------------------------------------------------------- */
const defaultAllow = ["http://localhost:5173", "http://localhost:4173"];
const rawAllowed = (process.env.CORS_ORIGIN || defaultAllow.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowAll = rawAllowed.includes("*");

// Ensure caches vary by origin
app.use((_, res, next) => {
  res.header("Vary", "Origin");
  next();
});

function matchPattern(origin, pattern) {
  if (!origin || !pattern) return false;
  if (pattern === origin) return true; // exact

  // wildcard like *.netlify.app
  if (pattern.startsWith("*.")) {
    try {
      const host = new URL(origin).hostname;
      const suffix = pattern.slice(1); // ".netlify.app"
      return host.endsWith(suffix);
    } catch {
      return false;
    }
  }
  return false;
}

function isAllowedOrigin(origin) {
  if (!origin) return true;             // curl/Postman/no-Origin
  if (allowAll) return true;            // wide-open (temporary)
  if (rawAllowed.some((p) => p === origin || matchPattern(origin, p))) return true;
  return false;
}

const corsOptions = {
  origin(origin, cb) {
    if (isAllowedOrigin(origin)) return cb(null, true);
    console.warn("CORS blocked:", origin, "allowed:", rawAllowed);
    cb(new Error("CORS: origin not allowed"));
  },
  credentials: false, // using Bearer tokens, not cookies
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  // Let cors echo requested headers
  allowedHeaders: undefined,
  optionsSuccessStatus: 204,
};

app.use(cors(corsOptions));
app.options("*", cors(corsOptions));

/* --------------------------------------------------------------------------
 * Core middleware
 * -------------------------------------------------------------------------- */
app.use(express.json());
app.use(morgan("dev"));

/* --------------------------------------------------------------------------
 * Routes
 * -------------------------------------------------------------------------- */
const authRoutes = require("./routes/auth");
const userRoutes = require("./routes/users");
const pickRoutes = require("./routes/picks");
const gameRoutes = require("./routes/games");
const highlightsRoutes = require("./routes/highlights");

const adminRoutes = require("./routes/admin");
const adminUsersRoutes = require("./routes/adminUsers");
const adminEditRoutes = require("./routes/adminEdit");

const leaderboardRoutes = require("./routes/leaderboard");
const passwordResetRoutes = require("./routes/passwordReset");
const adminEmailRoutes = require("./routes/adminEmail");
const scoresRoutes = require("./routes/scores");
const adminScoresRoutes = require("./routes/adminScores");

// Auth (mounted both /auth and /users for legacy compatibility)
app.use("/auth", authRoutes);
app.use("/users", authRoutes);

// Extra user endpoints (NOT login/signup)
app.use("/users", userRoutes);

// Feature routes
app.use("/picks", pickRoutes);
app.use("/games", gameRoutes);
app.use("/games", highlightsRoutes);

// Admin routes
app.use("/admin", adminRoutes);
app.use("/admin", adminEditRoutes);      // PUT /admin/users/:id + /admin/quick-edit/users/:id
app.use("/admin/users", adminUsersRoutes);
app.use("/admin/email", adminEmailRoutes);
app.use("/admin/scores", scoresRoutes);

// Leaderboard & password reset
app.use("/leaderboard", leaderboardRoutes);
app.use("/auth", passwordResetRoutes);

/* --------------------------------------------------------------------------
 * Health / Debug
 * -------------------------------------------------------------------------- */
app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    env: process.env.NODE_ENV || "development",
    time: new Date().toISOString(),
    cors_allowed: rawAllowed,
    cors_allowAll: allowAll,
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
      highlights: true,
      admin: true,
      admin_edit: true,
      admin_users: true,
      admin_email: true,
      leaderboard: true,
    },
    time: new Date().toISOString(),
  });
});

app.get("/", (_, res) => {
  res.send("NFL Frenzy Backend is running.");
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
