/**
 * Voice Agent Call History Dashboard — server
 * -------------------------------------------
 * Serves:
 *   1. A JSON API at GET /api/calls (polled every 5 seconds)
 *      - Powered by BACKEND_API_URL (Render backend) or direct MongoDB connection
 *   2. The live dashboard page at /
 *
 * Protected with HTTP Basic Auth:
 *   Default: admin / changeme
 */

require("dotenv").config();
const express = require("express");
const { MongoClient } = require("mongodb");
const path = require("path");

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 3001;
const BACKEND_API_URL = process.env.BACKEND_API_URL
  ? process.env.BACKEND_API_URL.replace(/\/+$/, "")
  : null;
const BACKEND_API_KEY = process.env.BACKEND_API_KEY || process.env.DASHBOARD_API_KEY || null;
const MONGODB_URI = process.env.MONGODB_URI;
const DB_NAME = process.env.DB_NAME || "ai_receptionist";
const COLLECTION_NAME = process.env.COLLECTION_NAME || "calllogs";
const DASH_USER = process.env.DASH_USER || "admin";
const DASH_PASS = process.env.DASH_PASS || "changeme";

if (!BACKEND_API_URL && !MONGODB_URI) {
  console.error("Missing BACKEND_API_URL or MONGODB_URI in environment variables.");
  process.exit(1);
}

// ---------- Basic Auth ----------
app.use((req, res, next) => {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  if (scheme === "Basic" && encoded) {
    const [user, pass] = Buffer.from(encoded, "base64").toString().split(":");
    if (user === DASH_USER && pass === DASH_PASS) return next();
  }
  res.set("WWW-Authenticate", 'Basic realm="Voice Agent Dashboard"');
  res.status(401).send("Authentication required. Please enter username and password.");
});

// ---------- Optional Direct MongoDB Connection ----------
let db;
let calllogsCollection;
let appointmentsCollection;

async function connectDB() {
  if (!MONGODB_URI) return;
  const client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db(DB_NAME);
  calllogsCollection = db.collection(COLLECTION_NAME);
  appointmentsCollection = db.collection("appointments");
  console.log(`[dashboard] Connected to MongoDB: ${DB_NAME}.${COLLECTION_NAME} & appointments`);
}

const { toEnglishName } = require("./utils/transliterate");

function cleanPhone(p) {
  if (!p) return "";
  return String(p).replace(/\D/g, "").slice(-10);
}

/**
 * Normalizes a Mongo document into the shape expected by index.html:
 * { id, name, phone, direction, call_time, duration_sec, booked, appointment_date, appointment_time, notes }
 */
function normalize(doc, phoneToPatientName = {}) {
  const appt = doc.appointment || {};
  const isBooked =
    doc.appointmentBooked === true ||
    doc.booked === true ||
    (doc.status === "completed" && !!appt.patientName) ||
    /^(yes|true|1|booked)$/i.test(String(doc.booked || doc.appointment_booked || "").trim());

  let phone =
    (doc.direction === "inbound" ? doc.from : doc.to) ||
    doc.from ||
    doc.to ||
    appt.phone ||
    doc.phone ||
    "—";

  const phoneKey = cleanPhone(phone);
  let rawName =
    appt.patientName ||
    doc.patientName ||
    doc.callerName ||
    phoneToPatientName[phoneKey] ||
    "New Patient";

  let name = toEnglishName(rawName);

  let callTimeStr = "—";
  const rawDate = doc.startedAt || doc.createdAt || doc.call_time;
  if (rawDate) {
    try {
      const d = new Date(rawDate);
      callTimeStr = d.toLocaleString("en-IN", {
        day: "numeric",
        month: "short",
        hour: "2-digit",
        minute: "2-digit",
        hour12: true,
      });
    } catch {
      callTimeStr = String(rawDate);
    }
  }

  let duration = doc.durationSeconds || doc.duration_sec || doc.duration || 0;
  if (!duration && doc.startedAt && doc.endedAt) {
    duration = Math.max(0, Math.round((new Date(doc.endedAt) - new Date(doc.startedAt)) / 1000));
  }

  let timeSlot = "—";
  if (appt.time) {
    timeSlot = appt.doctorName ? `${appt.time} (${appt.doctorName})` : appt.time;
  } else if (doc.appointment_time) {
    timeSlot = doc.appointment_time;
  }

  return {
    id: doc._id ? doc._id.toString() : "",
    name: name,
    phone: phone,
    direction: (doc.direction || "inbound").toLowerCase().startsWith("out") ? "outbound" : "inbound",
    call_time: callTimeStr,
    duration_sec: duration,
    booked: isBooked ? "yes" : "no",
    appointment_date: appt.date || doc.appointment_date || "—",
    appointment_time: timeSlot,
    notes: appt.reason || doc.notes || "",
  };
}

// ---------- API Endpoint ----------
app.get("/api/calls", async (req, res) => {
  // 1. If BACKEND_API_URL is configured, fetch directly from Render backend API
  if (BACKEND_API_URL) {
    try {
      const headers = {};
      if (BACKEND_API_KEY) {
        headers["X-API-Key"] = BACKEND_API_KEY;
      }
      const backendRes = await fetch(`${BACKEND_API_URL}/api/calls`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (backendRes.ok) {
        const data = await backendRes.json();
        return res.json(data);
      }
      const errText = await backendRes.text().catch(() => "");
      console.warn(`[dashboard] Backend API error: ${backendRes.status} ${errText}`);
    } catch (err) {
      console.warn("[dashboard] Could not fetch from BACKEND_API_URL:", err.message);
    }
  }

  // 2. Direct MongoDB fallback
  if (calllogsCollection && appointmentsCollection) {
    try {
      const allAppts = await appointmentsCollection
        .find({}, { projection: { phone: 1, patientName: 1 } })
        .toArray();
      const phoneToPatientName = {};
      for (const a of allAppts) {
        const pKey = cleanPhone(a.phone);
        if (pKey && a.patientName) {
          phoneToPatientName[pKey] = a.patientName;
        }
      }

      const docs = await calllogsCollection
        .aggregate([
          { $sort: { startedAt: -1, createdAt: -1, _id: -1 } },
          { $limit: 200 },
          {
            $lookup: {
              from: "appointments",
              localField: "callSid",
              foreignField: "callSid",
              as: "appointment",
            },
          },
          {
            $unwind: {
              path: "$appointment",
              preserveNullAndEmptyArrays: true,
            },
          },
        ])
        .toArray();

      return res.json(docs.map((doc) => normalize(doc, phoneToPatientName)));
    } catch (err) {
      console.error("[dashboard] Error fetching calls from MongoDB:", err.message);
      return res.status(500).json({ error: "Failed to fetch calls" });
    }
  }

  res.status(502).json({ error: "No data source available" });
});

// ---------- Static Dashboard (index.html at root) ----------
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
app.use(express.static(__dirname));

// ---------- Start Server ----------
async function start() {
  if (MONGODB_URI) {
    try {
      await connectDB();
    } catch (err) {
      console.warn("[dashboard] Warning: Direct MongoDB connection failed, relying on BACKEND_API_URL:", err.message);
    }
  }

  app.listen(PORT, () => {
    console.log(`[dashboard] Dashboard running on port ${PORT}`);
    if (BACKEND_API_URL) {
      console.log(`[dashboard] Linked to Backend API: ${BACKEND_API_URL}`);
    }
    console.log(`[dashboard] Login: username "${DASH_USER}", password "${DASH_PASS}"`);
  });
}

start();