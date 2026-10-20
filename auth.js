/**
 * Authentication & Authorization Module for KMC Hospital AI Receptionist Dashboard
 * ---------------------------------------------------------------------------------
 * - Uses Node.js built-in 'crypto' (scrypt + timingSafeEqual)
 * - In-memory session store (32-byte tokens, 8h expiry)
 * - Rate limiting: 5 failed attempts per IP+username -> 15 min lockout (429)
 * - Origin vs Host header validation for POST requests (CSRF protection)
 * - Production password strength enforcement
 * - Dynamic Team User Management (Admin creates team members stored in MongoDB)
 */

const crypto = require("crypto");

// Configuration
const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours
const MAX_FAILURES = 5;
const LOCKOUT_MS = 15 * 60 * 1000; // 15 minutes
const COOKIE_NAME = "kmc_session";

// In-memory Stores
const sessions = new Map(); // token -> { username, role, doctorName, expiresAt }
const loginFailures = new Map(); // `${ip}:${username}` -> { count, lockoutUntil }
let userStore = []; // [{ username, salt, hash, role, doctorName, createdAt, isDefaultAdmin }]
let dbUsersCollection = null;

// Dummy salt and hash for timing-safe comparison on unknown usernames
const DUMMY_SALT = crypto.randomBytes(16);
const DUMMY_HASH = crypto.scryptSync("dummy_secret_password_for_timing", DUMMY_SALT, 64);

/**
 * Validates password strength in production
 */
function validatePasswordStrength(username, password) {
  if (process.env.NODE_ENV !== "production") return;
  const weakPasswords = ["admin123", "password", "changeme", "12345678", "adminadmin"];
  if (!password || password.length < 8) {
    throw new Error(
      `[SECURITY] Weak password for user '${username}'. Passwords must be at least 8 characters in production.`
    );
  }
  if (weakPasswords.includes(password.toLowerCase())) {
    throw new Error(
      `[SECURITY] Insecure default/common password detected for user '${username}' in production.`
    );
  }
}

/**
 * Parses DASH_USERS environment variable or sets default admin user
 * Format: user:password:role[:doctor name];user2:...
 */
function initUsers() {
  userStore = [];
  const rawUsers = process.env.DASH_USERS || "admin:Admin@KMC2026:admin";

  const entries = rawUsers.split(";").map((u) => u.trim()).filter(Boolean);

  for (const entry of entries) {
    const parts = entry.split(":");
    if (parts.length < 3) {
      console.warn(`[auth] Skipping invalid user entry: ${entry}`);
      continue;
    }

    const username = parts[0].trim();
    const password = parts[1].trim();
    const role = parts[2].trim().toLowerCase();
    const doctorName = parts[3] ? parts.slice(3).join(":").trim() : null;

    validatePasswordStrength(username, password);

    const salt = crypto.randomBytes(16);
    const hash = crypto.scryptSync(password, salt, 64);

    userStore.push({
      username,
      salt,
      hash,
      role,
      doctorName,
      createdAt: new Date().toISOString(),
      isDefaultAdmin: role === "admin" && username === "admin",
    });
  }

  console.log(`[auth] Initialized ${userStore.length} base dashboard user(s).`);
}

/**
 * Syncs team users from MongoDB collection 'dashboard_users'
 */
async function syncUsersFromDb(collection) {
  if (!collection) return;
  dbUsersCollection = collection;

  try {
    const dbDocs = await collection.find({}).toArray();
    for (const doc of dbDocs) {
      const existing = userStore.find(
        (u) => u.username.toLowerCase() === doc.username.toLowerCase()
      );
      if (!existing && doc.saltHex && doc.hashHex) {
        userStore.push({
          username: doc.username,
          salt: Buffer.from(doc.saltHex, "hex"),
          hash: Buffer.from(doc.hashHex, "hex"),
          role: doc.role,
          doctorName: doc.doctorName || null,
          createdAt: doc.createdAt || new Date().toISOString(),
          isDefaultAdmin: false,
        });
      }
    }
    console.log(`[auth] Synchronized ${userStore.length} total user(s) with MongoDB.`);
  } catch (err) {
    console.warn(`[auth] Error syncing users from DB: ${err.message}`);
  }
}

/**
 * Creates a new team member account (Admin only)
 */
async function createTeamMember({ username, password, role, doctorName }) {
  if (!username || !password || !role) {
    throw new Error("Username, password, and role are required.");
  }

  const cleanUsername = username.trim().toLowerCase();
  if (!/^[a-z0-9_.-]{3,30}$/.test(cleanUsername)) {
    throw new Error("Username must be 3-30 characters (letters, numbers, underscores, dots, hyphens).");
  }

  if (password.length < 6) {
    throw new Error("Password must be at least 6 characters long.");
  }

  const validRoles = ["reception", "doctor", "analyst", "admin"];
  const cleanRole = role.trim().toLowerCase();
  if (!validRoles.includes(cleanRole)) {
    throw new Error(`Invalid role. Must be one of: ${validRoles.join(", ")}`);
  }

  // Check if username already exists
  const existing = userStore.find((u) => u.username.toLowerCase() === cleanUsername);
  if (existing) {
    throw new Error(`User with username '${cleanUsername}' already exists.`);
  }

  const cleanDoc = cleanRole === "doctor" ? (doctorName ? doctorName.trim() : "General OPD") : null;
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  const nowIso = new Date().toISOString();

  const userObj = {
    username: cleanUsername,
    salt,
    hash,
    role: cleanRole,
    doctorName: cleanDoc,
    createdAt: nowIso,
    isDefaultAdmin: false,
  };

  userStore.push(userObj);

  // Persist to MongoDB if connected
  if (dbUsersCollection) {
    try {
      await dbUsersCollection.insertOne({
        username: cleanUsername,
        saltHex: salt.toString("hex"),
        hashHex: hash.toString("hex"),
        role: cleanRole,
        doctorName: cleanDoc,
        createdAt: nowIso,
      });
    } catch (dbErr) {
      console.warn(`[auth] Error saving user to MongoDB: ${dbErr.message}`);
    }
  }

  console.log(`[auth] Admin created new team user: '${cleanUsername}' (Role: ${cleanRole})`);
  return {
    username: cleanUsername,
    role: cleanRole,
    doctorName: cleanDoc,
    createdAt: nowIso,
  };
}

/**
 * Deletes a team member account (Admin only)
 */
async function deleteTeamMember(username) {
  const cleanUsername = (username || "").trim().toLowerCase();
  const index = userStore.findIndex((u) => u.username.toLowerCase() === cleanUsername);

  if (index === -1) {
    throw new Error(`User '${cleanUsername}' not found.`);
  }

  if (userStore[index].isDefaultAdmin || cleanUsername === "admin") {
    throw new Error("Cannot delete primary administrator account.");
  }

  userStore.splice(index, 1);

  if (dbUsersCollection) {
    try {
      await dbUsersCollection.deleteOne({ username: cleanUsername });
    } catch (dbErr) {
      console.warn(`[auth] Error deleting user from MongoDB: ${dbErr.message}`);
    }
  }

  // Invalidate any active sessions for the deleted user
  for (const [token, session] of sessions.entries()) {
    if (session.username && session.username.toLowerCase() === cleanUsername) {
      sessions.delete(token);
    }
  }

  console.log(`[auth] Admin deleted user '${cleanUsername}'`);
  return { success: true };
}

/**
 * Helper to parse cookies from req.headers.cookie without external npm dependencies
 */
function parseCookies(req) {
  const cookies = {};
  const header = req.headers.cookie;
  if (!header) return cookies;
  header.split(";").forEach((cookie) => {
    const parts = cookie.split("=");
    const name = parts.shift().trim();
    const val = decodeURIComponent(parts.join("=").trim());
    if (name) cookies[name] = val;
  });
  return cookies;
}

/**
 * Authenticates user credentials with rate-limiting and timing attack prevention
 */
function authenticateUser(username, password, clientIp) {
  const normalizedUser = (username || "").trim().toLowerCase();
  const rateLimitKey = `${clientIp}:${normalizedUser}`;
  const now = Date.now();

  // Check rate limiting / lockout
  const failRecord = loginFailures.get(rateLimitKey);
  if (failRecord && failRecord.lockoutUntil && now < failRecord.lockoutUntil) {
    const remainingMins = Math.ceil((failRecord.lockoutUntil - now) / 60000);
    return {
      success: false,
      status: 429,
      error: `Too many failed login attempts. Locked out for ${remainingMins} more minute(s).`,
    };
  }

  // Find user
  const found = userStore.find(
    (u) => u.username.toLowerCase() === normalizedUser
  );

  let isValid = false;
  if (found) {
    const providedHash = crypto.scryptSync(password || "", found.salt, 64);
    isValid = crypto.timingSafeEqual(providedHash, found.hash);
  } else {
    // Run dummy scrypt computation to match time of valid user check
    const dummyHash = crypto.scryptSync(password || "", DUMMY_SALT, 64);
    crypto.timingSafeEqual(dummyHash, DUMMY_HASH);
    isValid = false;
  }

  if (!isValid) {
    const record = failRecord || { count: 0, lockoutUntil: 0 };
    record.count += 1;
    if (record.count >= MAX_FAILURES) {
      record.lockoutUntil = now + LOCKOUT_MS;
      loginFailures.set(rateLimitKey, record);
      return {
        success: false,
        status: 429,
        error: "Too many failed login attempts. Account locked for 15 minutes.",
      };
    }
    loginFailures.set(rateLimitKey, record);
    return {
      success: false,
      status: 401,
      error: `Invalid username or password. (${MAX_FAILURES - record.count} attempt(s) remaining)`,
    };
  }

  // Login succeeded: reset failure count
  loginFailures.delete(rateLimitKey);

  // Generate 32-byte session token
  const token = crypto.randomBytes(32).toString("hex");
  const sessionData = {
    username: found.username,
    role: found.role,
    doctorName: found.doctorName,
    expiresAt: now + SESSION_TTL_MS,
  };
  sessions.set(token, sessionData);

  return {
    success: true,
    token,
    user: getUserProfile(found),
  };
}

/**
 * Returns permissions profile for a user
 */
function getUserProfile(user) {
  const role = user.role;
  return {
    username: user.username,
    role: role,
    label:
      role === "admin"
        ? "Hospital Administrator"
        : role === "reception"
        ? "Front Desk Receptionist"
        : role === "doctor"
        ? `Doctor (${user.doctorName || "Physician"})`
        : "Healthcare Analyst",
    doctor: user.doctorName || null,
    can: {
      phone: role === "admin" || role === "reception",
      name: role !== "analyst",
      notes: role !== "analyst",
      transcript: role !== "analyst",
      recording: role === "admin" || role === "reception",
      team: role === "admin",
    },
  };
}

/**
 * Clears a session token
 */
function destroySession(token) {
  if (token) {
    sessions.delete(token);
  }
}

/**
 * Express Middleware: rejects POST requests if Origin host differs from Host header
 */
function checkOriginHost(req, res, next) {
  if (req.method === "POST" || req.method === "DELETE") {
    const origin = req.headers.origin;
    if (origin) {
      try {
        const originUrl = new URL(origin);
        const hostHeader = req.headers.host;
        if (originUrl.host !== hostHeader) {
          console.warn(
            `[auth] CSRF rejected: Origin ${originUrl.host} !== Host ${hostHeader}`
          );
          return res.status(403).json({ error: "Origin host mismatch (CSRF protection)" });
        }
      } catch (err) {
        return res.status(403).json({ error: "Invalid Origin header" });
      }
    }
  }
  next();
}

/**
 * Express Middleware: loads user from session cookie
 */
function sessionMiddleware(req, res, next) {
  const cookies = parseCookies(req);
  const token = cookies[COOKIE_NAME];

  if (token && sessions.has(token)) {
    const sess = sessions.get(token);
    if (Date.now() < sess.expiresAt) {
      req.user = sess;
      req.sessionToken = token;
      return next();
    } else {
      sessions.delete(token);
    }
  }

  req.user = null;
  req.sessionToken = null;
  next();
}

/**
 * Express Middleware: requires authenticated session
 */
function requireAuth(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized: Please log in" });
  }
  next();
}

/**
 * Express Middleware: requires admin role
 */
function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: "Unauthorized: Please log in" });
  }
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "Forbidden: Admin access required" });
  }
  next();
}

/**
 * Sets session cookie on response
 */
function setSessionCookie(res, token) {
  const isProd = process.env.NODE_ENV === "production";
  const maxAge = Math.floor(SESSION_TTL_MS / 1000);
  const cookieParts = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    `Max-Age=${maxAge}`,
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (isProd) {
    cookieParts.push("Secure");
  }
  res.setHeader("Set-Cookie", cookieParts.join("; "));
}

/**
 * Clears session cookie
 */
function clearSessionCookie(res) {
  const isProd = process.env.NODE_ENV === "production";
  const cookieParts = [
    `${COOKIE_NAME}=`,
    "Path=/",
    "Max-Age=0",
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (isProd) {
    cookieParts.push("Secure");
  }
  res.setHeader("Set-Cookie", cookieParts.join("; "));
}

/**
 * Returns sanitized list of team members (Admin only)
 */
function getTeamList() {
  return userStore.map((u) => ({
    username: u.username,
    role: u.role,
    doctorName: u.doctorName,
    createdAt: u.createdAt || null,
    isDefaultAdmin: !!u.isDefaultAdmin,
  }));
}

module.exports = {
  initUsers,
  syncUsersFromDb,
  createTeamMember,
  deleteTeamMember,
  authenticateUser,
  getUserProfile,
  destroySession,
  checkOriginHost,
  sessionMiddleware,
  requireAuth,
  requireAdmin,
  setSessionCookie,
  clearSessionCookie,
  getTeamList,
  COOKIE_NAME,
};
