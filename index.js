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
 * - If CORS_ORIGIN is unset, we default to a safe allow-list for localhost.
 * -------------------------------------------------------------------------- */
const defaultAllow = ["http://localhost:5173", "http://localhost:4173"];
const raw = (process.env.CORS_ORIGIN || defaultAllow.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const allowAll = raw.includes("*");

// Make caches vary by origin
app.use((_, res, next) => {
  res.header("Vary", "Origin");
  next();
});

function matchPattern(origin, pattern) {
  // exact
  if (pattern === origin) return true;
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
  if (!origin) return true;          // curl/Postman/no-Origin
  if (allowAll) return true;         // emergency wide-open
  if (raw.some((p) => matchPattern(origin, p) || p === origin)) return true;
  return false;
}

const corsOptions = {
  origin(origin, cb) {
    if (isAllowedOrigin(origin)) return cb(null, true);
    console.warn("CORS blocked origin:", origin, "allowed:", raw);
    cb(new Error("CORS: origin not allowed"));
  },
  credentials: false,                // not using cookies; bearer tokens instead
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  // Let the cors package echo requested headers instead of hard-coding a list
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
const adminRoutes = require("./routes/admin");
const leaderboardRoutes = require("./routes/leaderboard");
const adminUsersRoutes = require("./routes/adminUsers");
const passwordResetRoutes = require("./routes/passwordReset");
const adminEmailRoutes = require("./routes/adminEmail");

app.use("/auth", authRoutes);
app.use("/users", authRoutes);
app.use("/users", userRoutes);
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
    cors_allowed: raw,
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
      admin: true,
      leaderboard: true,
      admin_users: true,
      admin_email: true,
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
