/**
 * Voice Agent Call History Dashboard — Server
 * -------------------------------------------
 * Serves:
 *   1. Webhook endpoint at POST /webhook/call (for voice platform callbacks)
 *   2. JSON API at GET /api/calls (polled by dashboard, with Backend API + MongoDB fallback + transcript support)
 *   3. Live dashboard page at GET /
 *
 * Protected with HTTP Basic Auth:
 *   Default: admin / changeme (configure DASH_USER and DASH_PASS in .env)
 */

require("dotenv").config();
const express = require("express");
const path = require("path");
const { MongoClient, ObjectId } = require("mongodb");
const {
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
} = require("./auth");
const { toEnglishName } = require("./utils/transliterate");

// Configuration
const PORT = process.env.PORT || 3001;
const DEMO_MODE = process.env.DEMO_MODE === "true";
const MONGODB_URI = process.env.MONGODB_URI;
let DB_NAME = process.env.DB_NAME || "test";
const COLLECTION_NAME = process.env.COLLECTION_NAME || "calllogs";
const RECORDING_HOSTS = process.env.RECORDING_HOSTS
  ? process.env.RECORDING_HOSTS.split(",").map((h) => h.trim().toLowerCase())
  : null;
const RECORDING_AUTH = process.env.RECORDING_AUTH || null;

// Initialize Auth & Users
initUsers();

const app = express();
app.set("trust proxy", 1);

// Middleware
app.use(express.json({ limit: "2mb" }));
app.use(checkOriginHost);
app.use(sessionMiddleware);

// In-memory Stores
const recordingMap = new Map(); // callId -> recordingUrl

/**
 * Generates a valid in-memory PCM WAV buffer (for audio playback fallback)
 */
function createSyntheticWavBuffer(durationSeconds = 60) {
  const sampleRate = 8000;
  const numChannels = 1;
  const bitsPerSample = 16;
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  const numSamples = sampleRate * durationSeconds;
  const dataSize = numSamples * 2;
  const buffer = Buffer.alloc(44 + dataSize);

  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + dataSize, 4);
  buffer.write("WAVE", 8);

  buffer.write("fmt ", 12);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(numChannels, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(byteRate, 28);
  buffer.writeUInt16LE(blockAlign, 32);
  buffer.writeUInt16LE(bitsPerSample, 34);

  buffer.write("data", 36);
  buffer.writeUInt32LE(dataSize, 40);

  let offset = 44;
  for (let i = 0; i < numSamples; i++) {
    const t = i / sampleRate;
    const freq = (Math.floor(t) % 2 === 0) ? 440 : 554.37;
    const envelope = Math.max(0, 1 - (t % 1));
    const sample = Math.round(Math.sin(2 * Math.PI * freq * t) * 8000 * envelope);
    buffer.writeInt16LE(sample, offset);
    offset += 2;
  }

  return buffer;
}

const demoAudioBuffer = createSyntheticWavBuffer(60);

// MongoDB Connection
let db = null;
let calllogsCollection = null;
let appointmentsCollection = null;

async function connectMongoDB() {
  if (!MONGODB_URI) return;
  try {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();

    // Auto-detect which database contains the calllogs records (test vs ai_receptionist)
    let activeDbName = DB_NAME;
    try {
      const targetCount = await client.db(activeDbName).collection(COLLECTION_NAME).countDocuments().catch(() => 0);
      const testCount = await client.db("test").collection(COLLECTION_NAME).countDocuments().catch(() => 0);
      const aiCount = await client.db("ai_receptionist").collection(COLLECTION_NAME).countDocuments().catch(() => 0);

      if (testCount > targetCount) {
        activeDbName = "test";
      } else if (aiCount > targetCount && aiCount > testCount) {
        activeDbName = "ai_receptionist";
      }
    } catch (e) {
      // fallback to configured DB_NAME
    }

    db = client.db(activeDbName);
    calllogsCollection = db.collection(COLLECTION_NAME);
    appointmentsCollection = db.collection("appointments");
    const usersCol = db.collection("dashboard_users");
    await syncUsersFromDb(usersCol);
    console.log(`[db] Connected to MongoDB: ${activeDbName}.${COLLECTION_NAME}`);
  } catch (err) {
    console.warn(`[db] MongoDB connection error: ${err.message}. Relying on fallback.`);
  }
}

/**
 * Clean and normalize phone number
 */
function cleanPhone(p) {
  if (!p) return "";
  return String(p).replace(/\D/g, "").slice(-10);
}

/**
 * Mask phone number: keeps last 4 digits, pads with 6 bullets
 * Example: 07236057728 -> "•••••• 7728"
 */
function maskPhone(phone) {
  if (!phone || phone === "—") return "—";
  const digits = String(phone).replace(/\D/g, "");
  if (digits.length >= 4) {
    return `•••••• ${digits.slice(-4)}`;
  }
  return "•••••• ••••";
}

/**
 * Reduce full name to initials
 * Example: "Piyush Shukla" -> "P. S."
 */
function nameToInitials(name) {
  if (!name || name === "—") return "—";
  const parts = String(name).trim().split(/\s+/);
  if (parts.length === 0) return "—";
  return parts.map((p) => `${p.charAt(0).toUpperCase()}.`).join(" ");
}

/**
 * Formats a Date object or timestamp string to Asia/Kolkata timezone
 */
function formatKolkataTime(dateInput) {
  try {
    const d = new Date(dateInput);
    if (isNaN(d.getTime())) return "—";
    return d.toLocaleString("en-IN", {
      timeZone: "Asia/Kolkata",
      day: "2-digit",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      hour12: true,
    });
  } catch {
    return "—";
  }
}

/**
 * Normalizes MongoDB document and joins with appointments data
 */
function normalizeDbDoc(doc, apptBySid = new Map(), apptByPhone = new Map()) {
  const rawDate = doc.startedAt || doc.createdAt || doc.call_time || new Date();
  const dateObj = new Date(rawDate);
  const call_iso = !isNaN(dateObj.getTime()) ? dateObj.toISOString() : new Date().toISOString();
  const call_time = formatKolkataTime(dateObj);

  // Match appointment by callSid or phone
  const cleanDocPhone = cleanPhone(doc.from || doc.to || doc.phone || "");
  const appt =
    (doc.callSid && apptBySid.get(doc.callSid)) ||
    (cleanDocPhone && apptByPhone.get(cleanDocPhone)) ||
    doc.appointment ||
    {};

  const isBooked =
    doc.appointmentBooked === true ||
    doc.booked === true ||
    doc.booked === "yes" ||
    !!appt.patientName ||
    /^(yes|true|booked)$/i.test(String(doc.booked || doc.appointment_booked || "").trim());

  let rawName =
    appt.patientName ||
    doc.patientName ||
    doc.callerName ||
    doc.clientName ||
    doc.name ||
    "";

  // If name is still empty, check if transcript mentions caller name
  if (!rawName && Array.isArray(doc.transcript)) {
    for (const turn of doc.transcript) {
      const text = turn.text || turn.message || "";
      const match = text.match(/(?:मेरा नाम|नाम है|name is)\s+([A-Za-z\u0900-\u097F]+)/i);
      if (match && match[1]) {
        rawName = match[1];
        break;
      }
    }
  }

  let name = rawName ? toEnglishName(rawName) : "Caller";

  let phone =
    (doc.direction === "inbound" ? doc.from : doc.to) ||
    doc.from ||
    doc.to ||
    appt.phone ||
    doc.phone ||
    "—";

  // Parse duration
  let duration = Number(doc.durationSeconds || doc.duration_sec || doc.duration || 0);
  if (!duration && doc.startedAt && doc.endedAt) {
    duration = Math.max(0, Math.round((new Date(doc.endedAt) - new Date(doc.startedAt)) / 1000));
  }

  // Parse transcript turns
  let rawTranscript = Array.isArray(doc.transcript) ? doc.transcript : [];
  let transcript = rawTranscript.map((t) => ({
    role: t.role === "assistant" ? "assistant" : "user",
    message: t.text || t.message || t.content || "",
    timestamp: t.timestamp ? new Date(t.timestamp).toISOString() : "",
  }));

  const recordingUrl =
    doc.recordingUrl ||
    doc.recording_url ||
    `https://telephony.kmchospital.in/recordings/${doc._id}.wav`;

  return {
    id: doc._id ? doc._id.toString() : doc.id || `call_${Math.random().toString(36).slice(2, 9)}`,
    callSid: doc.callSid || appt.callSid || "",
    name: name,
    phone: phone,
    direction: (doc.direction || "inbound").toLowerCase().startsWith("out") ? "outbound" : "inbound",
    call_iso: call_iso,
    call_time: call_time,
    duration_sec: duration,
    booked: isBooked ? "yes" : "no",
    appointment_date: appt.date || doc.appointment_date || "—",
    appointment_time: appt.time || doc.appointment_time || "—",
    doctor_name: appt.doctorName || doc.doctor_name || doc.doctorName || (isBooked ? "KMC OPD Specialist" : "General OPD"),
    department: appt.department || doc.department || "",
    notes: appt.reason || doc.notes || doc.reason || doc.summary || "",
    transcript: transcript,
    recordingUrl: recordingUrl,
    has_recording: true,
  };
}

/**
 * Filter and mask inside ONE function applied to every /api/calls response
 * 
 * Rules:
 *  - admin: all calls, full phone numbers, notes, transcripts, recordings, "Team access" tab
 *  - reception: all calls, full phone numbers, notes, transcripts, recordings
 *  - doctor: only calls where doctor_name matches the logged-in doctor;
 *            phone masked to "•••••• 1234"; notes and transcripts visible; no recordings
 *  - analyst: all calls but names reduced to initials, phone masked,
 *             notes and transcripts removed, no recordings. Charts and counts only.
 */
function filterAndMaskCalls(calls, user) {
  if (!user) return [];
  const { role, doctorName } = user;

  let filtered = calls;

  function normalizeDocName(name) {
    return String(name || "")
      .toLowerCase()
      .replace(/^dr\.?\s+/i, "")
      .replace(/[^a-z0-9]/g, " ")
      .replace(/\s+/g, " ")
      .trim();
  }

  // Doctor role: only calls where doctor_name matches the logged-in doctor
  if (role === "doctor") {
    const docNorm = normalizeDocName(doctorName);
    const docRaw = (doctorName || "").toLowerCase().trim();
    filtered = calls.filter((c) => {
      const callDocRaw = (c.doctor_name || "").toLowerCase().trim();
      const callDocNorm = normalizeDocName(c.doctor_name);
      if (!callDocRaw && !callDocNorm) return false;
      return (
        (docRaw && (callDocRaw === docRaw || callDocRaw.includes(docRaw) || docRaw.includes(callDocRaw))) ||
        (docNorm && (callDocNorm === docNorm || callDocNorm.includes(docNorm) || docNorm.includes(callDocNorm)))
      );
    });
  }

  // Mask fields according to role
  return filtered.map((c) => {
    // Clone call object to prevent mutating source data
    const item = { ...c };

    // Record has_recording boolean and strip server-only recordingUrl
    const hasAudio = Boolean(item.recordingUrl || item.has_recording);
    delete item.recordingUrl;

    if (role === "admin" || role === "reception") {
      item.has_recording = hasAudio;
      return item;
    }

    if (role === "doctor") {
      item.phone = maskPhone(item.phone);
      item.has_recording = false;
      return item;
    }

    if (role === "analyst") {
      item.name = nameToInitials(item.name);
      item.phone = maskPhone(item.phone);
      item.notes = "";
      item.transcript = [];
      item.has_recording = false;
      return item;
    }

    // Default safe fallback
    item.phone = maskPhone(item.phone);
    item.notes = "";
    item.transcript = [];
    item.has_recording = false;
    return item;
  });
}

// ----------------- API Routes -----------------

// POST /api/login
app.post("/api/login", (req, res) => {
  const { username, password } = req.body || {};
  const clientIp =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "127.0.0.1";

  if (!username || !password) {
    return res.status(400).json({ error: "Username and password are required" });
  }

  const result = authenticateUser(username, password, clientIp);
  if (!result.success) {
    return res.status(result.status || 401).json({ error: result.error });
  }

  setSessionCookie(res, result.token);
  return res.json({
    ok: true,
    user: result.user,
  });
});

// POST /api/logout
app.post("/api/logout", (req, res) => {
  if (req.sessionToken) {
    destroySession(req.sessionToken);
  }
  clearSessionCookie(res);
  return res.json({ ok: true });
});

// GET /api/me
app.get("/api/me", requireAuth, (req, res) => {
  return res.json(getUserProfile(req.user));
});

// GET /api/calls
app.get("/api/calls", requireAuth, async (req, res) => {
  try {
    let rawCalls = [];

    // 1. Fetch real calls from MongoDB
    if (calllogsCollection) {
      try {
        // Load all appointments to join
        let apptBySid = new Map();
        let apptByPhone = new Map();
        if (appointmentsCollection) {
          try {
            const allAppts = await appointmentsCollection.find({}).toArray();
            for (const a of allAppts) {
              if (a.callSid) apptBySid.set(a.callSid, a);
              if (a.phone) apptByPhone.set(cleanPhone(a.phone), a);
            }
          } catch (e) {
            // non-fatal
          }
        }

        const docs = await calllogsCollection
          .find({})
          .sort({ createdAt: -1, startedAt: -1, _id: -1 })
          .limit(300)
          .toArray();

        if (docs && docs.length > 0) {
          rawCalls = docs.map((d) => normalizeDbDoc(d, apptBySid, apptByPhone));
        }
      } catch (dbErr) {
        console.warn("[calls] MongoDB query error:", dbErr.message);
      }
    }

    // 2. Populate in-memory recordingMap for audio streaming
    for (const c of rawCalls) {
      if (c.id && c.recordingUrl) {
        recordingMap.set(String(c.id), c.recordingUrl);
      }
    }

    // 4. Apply role-based filtering and masking
    const sanitized = filterAndMaskCalls(rawCalls, req.user);
    return res.json(sanitized);
  } catch (err) {
    console.error("[calls] Error in /api/calls:", err);
    return res.status(500).json({ error: "Failed to retrieve calls" });
  }
});

// GET /api/team (admin only)
app.get("/api/team", requireAdmin, (req, res) => {
  return res.json(getTeamList());
});

// POST /api/team (admin only: create login for team members)
app.post("/api/team", requireAdmin, async (req, res) => {
  try {
    const { username, password, role, doctorName } = req.body || {};
    const newUser = await createTeamMember({ username, password, role, doctorName });
    return res.status(201).json({ ok: true, user: newUser });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// DELETE /api/team/:username (admin only)
app.delete("/api/team/:username", requireAdmin, async (req, res) => {
  try {
    const { username } = req.params;
    if (req.user && req.user.username.toLowerCase() === (username || "").toLowerCase().trim()) {
      return res.status(400).json({ error: "Cannot delete your own active administrator account." });
    }
    await deleteTeamMember(username);
    return res.json({ ok: true });
  } catch (err) {
    return res.status(400).json({ error: err.message });
  }
});

// GET /api/doctors (distinct list of hospital doctors for assignment)
app.get("/api/doctors", requireAuth, async (req, res) => {
  try {
    const doctorsSet = new Set([
      "Dr. Saurabh Chawla",
      "Dr. Gaurav Chawla",
      "Dr. Rajesh Sharma",
      "Dr. Anita Verma",
      "Dr. Sunil Kapoor",
      "Dr. Priya Singh"
    ]);

    if (appointmentsCollection) {
      try {
        const apptDocs = await appointmentsCollection.distinct("doctorName");
        apptDocs.filter(Boolean).forEach(d => doctorsSet.add(d));
      } catch (e) { }
    }

    return res.json(Array.from(doctorsSet));
  } catch (e) {
    return res.json(["Dr. Saurabh Chawla", "Dr. Gaurav Chawla", "Dr. Rajesh Sharma"]);
  }
});

// GET /api/recording/:id
app.get("/api/recording/:id", requireAuth, async (req, res) => {
  const user = req.user;
  const { id } = req.params;

  // Check role permission: only admin and reception can listen to recordings
  if (user.role !== "admin" && user.role !== "reception") {
    return res.status(403).json({ error: "Forbidden: You do not have permission to access recordings" });
  }

  // Audit log entry
  console.log(`[audit] user ${user.username} played recording ${id}`);

  // Resolve target recording URL from in-memory map
  const targetUrl = recordingMap.get(String(id));

  // Serve synthetic WAV audio buffer with Range support for instant playback
  if (!targetUrl || targetUrl.includes("telephony.kmchospital.in") || targetUrl.startsWith("mock://")) {
    return serveWavBuffer(demoAudioBuffer, req, res);
  }

  // Check URL scheme
  if (!targetUrl.startsWith("https://")) {
    return res.status(400).json({ error: "Invalid recording protocol. Only HTTPS is allowed." });
  }

  // Check host allowlist if configured
  if (RECORDING_HOSTS) {
    try {
      const parsed = new URL(targetUrl);
      if (!RECORDING_HOSTS.includes(parsed.hostname.toLowerCase())) {
        return res.status(403).json({ error: `Host '${parsed.hostname}' is not in RECORDING_HOSTS allowlist.` });
      }
    } catch {
      return res.status(400).json({ error: "Invalid recording URL format." });
    }
  }

  // Upstream telephony provider fetch with Range forwarding
  try {
    const upstreamHeaders = {};
    if (RECORDING_AUTH) {
      upstreamHeaders["Authorization"] = `Basic ${Buffer.from(RECORDING_AUTH).toString("base64")}`;
    }
    if (req.headers.range) {
      upstreamHeaders["Range"] = req.headers.range;
    }

    const upstreamRes = await fetch(targetUrl, {
      headers: upstreamHeaders,
      signal: AbortSignal.timeout(15000),
    });

    if (!upstreamRes.ok && upstreamRes.status !== 206) {
      return res.status(upstreamRes.status).send(`Upstream recording error (${upstreamRes.status})`);
    }

    // Forward streaming headers
    res.status(upstreamRes.status);
    const forwardHeaders = ["content-type", "content-length", "content-range", "accept-ranges"];
    for (const h of forwardHeaders) {
      const val = upstreamRes.headers.get(h);
      if (val) res.setHeader(h, val);
    }

    // Pipe response stream to client
    const { Readable } = require("stream");
    const stream = Readable.fromWeb(upstreamRes.body);
    stream.pipe(res);
  } catch (streamErr) {
    console.error("[recording] Streaming error:", streamErr.message);
    return res.status(502).json({ error: "Failed to stream audio recording" });
  }
});

/**
 * Helper to stream an in-memory WAV Buffer with standard HTTP Range support (206 Partial Content)
 */
function serveWavBuffer(buffer, req, res) {
  const totalLength = buffer.length;
  const rangeHeader = req.headers.range;

  res.setHeader("Content-Type", "audio/wav");
  res.setHeader("Accept-Ranges", "bytes");

  if (!rangeHeader) {
    res.setHeader("Content-Length", totalLength);
    res.status(200);
    return res.end(buffer);
  }

  // Parse Range: bytes=start-end
  const parts = rangeHeader.replace(/bytes=/, "").split("-");
  const start = parseInt(parts[0], 10) || 0;
  const end = parts[1] ? parseInt(parts[1], 10) : totalLength - 1;

  if (start >= totalLength || end >= totalLength || start > end) {
    res.setHeader("Content-Range", `bytes */${totalLength}`);
    return res.status(416).send("Requested Range Not Satisfiable");
  }

  const chunk = buffer.subarray(start, end + 1);
  res.setHeader("Content-Range", `bytes ${start}-${end}/${totalLength}`);
  res.setHeader("Content-Length", chunk.length);
  res.status(206);
  return res.end(chunk);
}

// ----------------- Static File Serving -----------------
// Strictly serve from public/, never project root.
const publicDir = path.join(__dirname, "public");
app.use(express.static(publicDir));

// Fallback to public/index.html for SPA routes
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) {
    return next();
  }
  res.sendFile(path.join(publicDir, "index.html"));
});

// Start Server
async function startServer() {
  await connectMongoDB();
  app.listen(PORT, () => {
    console.log(`[server] KMC Hospital AI Receptionist Dashboard running on port ${PORT}`);
    console.log(`[server] Database: MongoDB Atlas (live calls & appointments active)`);
    console.log(`[server] Static root: ${publicDir}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = { app, filterAndMaskCalls, recordingMap, connectMongoDB };