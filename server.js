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
const { MongoClient, ObjectId } = require("mongodb");
const path = require("path");
const { toEnglishName } = require("./utils/transliterate");

const app = express();

// ---------- Config ----------
const PORT = process.env.PORT || 3001;
const BACKEND_API_URL = process.env.BACKEND_API_URL
  ? process.env.BACKEND_API_URL.replace(/\/+$/, "")
  : null;
const BACKEND_API_KEY = process.env.BACKEND_API_KEY || process.env.DASHBOARD_API_KEY || null;
const MONGODB_URI = process.env.MONGODB_URI;
let DB_NAME = process.env.DB_NAME || "ai_receptionist";
const COLLECTION_NAME = process.env.COLLECTION_NAME || "calllogs";
const DASH_USER = process.env.DASH_USER || "admin";
const DASH_PASS = process.env.DASH_PASS || "changeme";
const WEBHOOK_KEY = process.env.WEBHOOK_KEY;

if (!BACKEND_API_URL && !MONGODB_URI) {
  console.error("Missing BACKEND_API_URL or MONGODB_URI in environment variables.");
  process.exit(1);
}

// ---------- Webhook: Voice platform pushes finished calls here ----------
// Must sit BEFORE Basic Auth so external voice webhooks can POST without auth headers.
app.post("/webhook/call", express.json({ limit: "5mb" }), async (req, res) => {
  if (WEBHOOK_KEY && req.query.key !== WEBHOOK_KEY) {
    return res.status(401).send("Unauthorized: Invalid webhook key");
  }

  try {
    const body = req.body || {};
    const data = body.data || body;
    const collected = (data.analysis && data.analysis.data_collection_results) || {};
    const pick = (k) => (collected[k] && collected[k].value) || "";

    const doc = {
      conversation_id: data.conversation_id || "",
      name: pick("patient_name") || (data.metadata && data.metadata.name) || "",
      phone:
        pick("phone_number") ||
        (data.metadata &&
          data.metadata.phone_call &&
          data.metadata.phone_call.external_number) ||
        "",
      direction:
        (data.metadata &&
          data.metadata.phone_call &&
          data.metadata.phone_call.direction) ||
        "inbound",
      call_time: new Date().toISOString().slice(0, 16).replace("T", " "),
      duration_sec: (data.metadata && data.metadata.call_duration_secs) || 0,
      booked: pick("appointment_booked") || "no",
      appointment_date: pick("appointment_date") || "",
      appointment_time: pick("appointment_time") || "",
      notes: (data.analysis && data.analysis.transcript_summary) || "",
      transcript: Array.isArray(data.transcript)
        ? data.transcript.map((t) => ({
            role: t.role,
            message: t.message || t.text || t.content || "",
            timestamp: t.timestamp || new Date(),
          }))
        : [],
      raw: body,
      createdAt: new Date(),
    };

    if (calllogsCollection) {
      await calllogsCollection.insertOne(doc);
    }
    res.status(200).send("ok");
  } catch (err) {
    console.error("[dashboard] Webhook error:", err);
    res.status(500).send("error");
  }
});

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

// ---------- MongoDB Connection & Fallback ----------
let db;
let calllogsCollection;
let appointmentsCollection;

function cleanPhone(p) {
  if (!p) return "";
  return String(p).replace(/\D/g, "").slice(-10);
}

async function connectDB() {
  if (!MONGODB_URI) return;
  const client = new MongoClient(MONGODB_URI);
  await client.connect();

  // If target DB has fewer records than "test" (common when Mongoose omits DB name and defaults to test)
  let activeDbName = DB_NAME;
  try {
    const targetCount = await client
      .db(activeDbName)
      .collection(COLLECTION_NAME)
      .countDocuments()
      .catch(() => 0);
    const testCount = await client
      .db("test")
      .collection(COLLECTION_NAME)
      .countDocuments()
      .catch(() => 0);
    if (testCount > targetCount) {
      activeDbName = "test";
    }
  } catch (e) {
    // ignore inspection error and use default
  }

  db = client.db(activeDbName);
  calllogsCollection = db.collection(COLLECTION_NAME);
  appointmentsCollection = db.collection("appointments");
  console.log(
    `[dashboard] Connected to MongoDB: ${activeDbName}.${COLLECTION_NAME} & appointments`
  );
}

/**
 * Normalizes a document into the uniform shape expected by index.html
 */
function normalize(doc, phoneToPatientName = {}) {
  const appt = doc.appointment || {};
  const isBooked =
    doc.appointmentBooked === true ||
    doc.booked === true ||
    (doc.status === "completed" && !!appt.patientName) ||
    /^(yes|true|1|booked)$/i.test(
      String(doc.booked || doc.appointment_booked || "").trim()
    );

  let phone =
    (doc.direction === "inbound" ? doc.from : doc.to) ||
    doc.from ||
    doc.to ||
    appt.phone ||
    doc.phone ||
    doc.phone_number ||
    "—";

  const phoneKey = cleanPhone(phone);
  let rawName =
    appt.patientName ||
    doc.patientName ||
    doc.name ||
    doc.callerName ||
    doc.caller_name ||
    phoneToPatientName[phoneKey] ||
    "New Patient";

  let name = toEnglishName(rawName);

  let callTimeStr = "—";
  const rawDate = doc.startedAt || doc.createdAt || doc.call_time || doc.timestamp;
  if (rawDate) {
    try {
      const d = new Date(rawDate);
      if (!isNaN(d.getTime())) {
        callTimeStr = d.toLocaleString("en-IN", {
          day: "numeric",
          month: "short",
          hour: "2-digit",
          minute: "2-digit",
          hour12: true,
        });
      } else {
        callTimeStr = String(rawDate);
      }
    } catch {
      callTimeStr = String(rawDate);
    }
  }

  let duration =
    doc.durationSeconds || doc.duration_sec || doc.duration || 0;
  if (!duration && doc.startedAt && doc.endedAt) {
    duration = Math.max(
      0,
      Math.round((new Date(doc.endedAt) - new Date(doc.startedAt)) / 1000)
    );
  }

  let timeSlot = "—";
  let extractedVenue = appt.doctorName || doc.doctorName || "";
  let rawTime = appt.time || doc.appointment_time || doc.time_slot || "";
  if (rawTime) {
    const vMatch = rawTime.match(/^([^(]+)(?:\(([^)]+)\))?/);
    if (vMatch) {
      timeSlot = vMatch[1].trim();
      if (vMatch[2] && !extractedVenue) {
        extractedVenue = vMatch[2].trim();
      }
    } else {
      timeSlot = rawTime.trim();
    }
  }

  let rawTurns = Array.isArray(doc.transcript) ? doc.transcript : [];
  let transcript = rawTurns.map((t) => ({
    role: t.role || "user",
    message: t.message || t.text || t.content || "",
    timestamp: t.timestamp || "",
  }));

  return {
    id: doc._id ? doc._id.toString() : doc.id || "",
    callSid: doc.callSid || appt.callSid || "",
    status: doc.status || "completed",
    name: name,
    phone: phone,
    direction: (doc.direction || doc.call_direction || "inbound")
      .toLowerCase()
      .startsWith("out")
      ? "outbound"
      : "inbound",
    call_time: callTimeStr,
    duration_sec: duration,
    booked: isBooked ? "yes" : "no",
    appointment_date: appt.date || doc.appointment_date || "—",
    appointment_time: timeSlot,
    doctor_name: extractedVenue || appt.doctorName || doc.doctorName || "",
    department: appt.department || doc.department || "",
    notes: appt.reason || doc.notes || doc.summary || "",
    transcript: transcript,
  };
}

// ---------- API Endpoint ----------
app.get("/api/calls", async (req, res) => {
  // 1. If BACKEND_API_URL is configured, fetch live records from Render backend API
  if (BACKEND_API_URL) {
    try {
      const headers = {};
      if (BACKEND_API_KEY) {
        headers["X-API-Key"] = BACKEND_API_KEY;
      }
      const backendRes = await fetch(`${BACKEND_API_URL}/api/calls`, {
        headers,
        signal: AbortSignal.timeout(6000),
      });

      if (backendRes.ok) {
        const data = await backendRes.json();

        // Strip parenthetical venue/doctor name from appointment_time and save to doctor_name
        if (Array.isArray(data)) {
          data.forEach((item) => {
            if (item.appointment_time && item.appointment_time !== "—") {
              const vMatch = item.appointment_time.match(/^([^(]+)(?:\(([^)]+)\))?/);
              if (vMatch) {
                item.appointment_time = vMatch[1].trim();
                if (vMatch[2] && !item.doctor_name) {
                  item.doctor_name = vMatch[2].trim();
                }
              }
            }
          });
        }

        // Enrich with transcripts from MongoDB if backend API records don't have them
        if (calllogsCollection && Array.isArray(data) && data.length > 0) {
          try {
            const ids = data
              .map((d) => {
                try {
                  return new ObjectId(d.id);
                } catch {
                  return null;
                }
              })
              .filter(Boolean);

            if (ids.length > 0) {
              const logs = await calllogsCollection
                .find(
                  { _id: { $in: ids } },
                  { projection: { _id: 1, callSid: 1, status: 1, transcript: 1, notes: 1 } }
                )
                .toArray();

              const logMap = new Map(logs.map((l) => [l._id.toString(), l]));

              data.forEach((item) => {
                const matched = logMap.get(item.id);
                if (matched) {
                  if ((!item.transcript || item.transcript.length === 0) && matched.transcript) {
                    item.transcript = matched.transcript.map((t) => ({
                      role: t.role,
                      message: t.message || t.text || t.content || "",
                      timestamp: t.timestamp,
                    }));
                  }
                  if (!item.notes && matched.notes) {
                    item.notes = matched.notes;
                  }
                  if (!item.callSid && matched.callSid) {
                    item.callSid = matched.callSid;
                  }
                  if (!item.status && matched.status) {
                    item.status = matched.status;
                  }
                }
              });
            }
          } catch (enrichErr) {
            // non-fatal enrichment error
          }
        }

        return res.json(data);
      }

      const errText = await backendRes.text().catch(() => "");
      console.warn(`[dashboard] Backend API error: ${backendRes.status} ${errText}`);
    } catch (err) {
      console.warn("[dashboard] Could not fetch from BACKEND_API_URL:", err.message);
    }
  }

  // 2. Direct MongoDB fallback
  if (calllogsCollection) {
    try {
      let phoneToPatientName = {};
      if (appointmentsCollection) {
        try {
          const allAppts = await appointmentsCollection
            .find({}, { projection: { phone: 1, patientName: 1 } })
            .toArray();
          for (const a of allAppts) {
            const pKey = cleanPhone(a.phone);
            if (pKey && a.patientName) {
              phoneToPatientName[pKey] = a.patientName;
            }
          }
        } catch {
          // ignore appointments collection error
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
      console.warn(
        "[dashboard] Direct MongoDB connection failed, relying on BACKEND_API_URL fallback:",
        err.message
      );
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