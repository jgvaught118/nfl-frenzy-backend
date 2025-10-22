// backend/index.js
require("dotenv").config();

const express = require("express");
const cors = require("cors");
const morgan = require("morgan");

const app = express();
const PORT = process.env.PORT || 5001;

/* --------------------------------------------------------------------------
 * CORS — robust & flexible
 * -------------------------------------------------------------------------- */
const defaultAllow = ["http://localhost:5173", "http://localhost:4173"];
const rawAllowed = (process.env.CORS_ORIGIN || defaultAllow.join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
const allowAll = rawAllowed.includes("*");

app.set("trust proxy", true);               // Railway/Netlify front proxies
app.use((_, res, next) => {                 // help caches vary by Origin
  res.header("Vary", "Origin");
  next();
});

function matchPattern(origin, pattern) {
  if (!origin || !pattern) return false;
  if (pattern === origin) return true; // exact
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
  if (!origin) return true;                // curl/Postman/no Origin
  if (allowAll) return true;
  if (rawAllowed.some((p) => p === origin || matchPattern(origin, p))) return true;
  return false;
}
const corsOptions = {
  origin(origin, cb) {
    if (isAllowedOrigin(origin)) return cb(null, true);
    console.warn("CORS blocked:", origin, "allowed:", rawAllowed);
    cb(new Error("CORS: origin not allowed"));
  },
  credentials: false,
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
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

// Public games router (unauthenticated read-only)
const publicGamesRouter = require("./routes/publicGames");

// Health first (cheap)
app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    env: process.env.NODE_ENV || "development",
    time: new Date().toISOString(),
    cors_allowed: rawAllowed,
    cors_allowAll: allowAll,
  });
});

// Auth (mounted both /auth and /users for legacy compatibility)
app.use("/auth", authRoutes);
app.use("/users", authRoutes);

// Extra user endpoints (NOT login/signup)
app.use("/users", userRoutes);

// Feature routes
app.use("/picks", pickRoutes);
app.use("/games", gameRoutes);
app.use("/games", highlightsRoutes);

// Public read-only API for frontend display (odds/scores)
app.use("/public", publicGamesRouter);

// Admin routes
app.use("/admin", adminRoutes);
app.use("/admin", adminEditRoutes);      // PUT /admin/users/:id + quick-edit
app.use("/admin/users", adminUsersRoutes);
app.use("/admin/email", adminEmailRoutes);
app.use("/admin/scores", scoresRoutes);

// Leaderboard & password reset
app.use("/leaderboard", leaderboardRoutes);
app.use("/auth", passwordResetRoutes);

// Root
app.get("/", (_, res) => {
  res.send("NFL Frenzy Backend is running.");
});

/* --------------------------------------------------------------------------
 * Fallbacks & error handling
 * -------------------------------------------------------------------------- */
app.use((req, res) => {
  res.status(404).json({ error: "Not found", path: req.originalUrl });
});

app.use((err, req, res, _next) => {
  console.error("Unhandled error:", err);
  res.status(500).json({ error: "Server error" });
});

app.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
