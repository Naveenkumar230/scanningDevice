const express = require("express");
const fs = require("fs");
const path = require("path");
const { MongoClient } = require("mongodb");

// --------------------------------------------------------------
// CONFIG
// --------------------------------------------------------------
const LOG_DIR = process.env.LOG_DIR ||
    path.join("/home/scanningdevice/sewing_tracker/build", "logs");
const CONTROL_DIR = process.env.CONTROL_DIR ||
    path.join("/home/scanningdevice/sewing_tracker/build", "control");
const PORT = process.env.PORT || 3000;

// REQUIRED: set this via environment variable, never hardcode credentials
// in the file. e.g.:
//   MONGODB_URI="mongodb+srv://user:pass@cluster0.xxxxx.mongodb.net/sewingDashboard?retryWrites=true&w=majority" node server.js
const MONGODB_URI = process.env.MONGODB_URI;
const MONGODB_DB_NAME = process.env.MONGODB_DB_NAME || "sewingDashboard";

// Shared secret the scanning device must send in the X-API-Key header when
// POSTing to /api/ingest. Set the SAME value in DASHBOARD_API_KEY on the
// device. If left unset, /api/ingest accepts unauthenticated requests --
// fine for local testing, NOT fine once this server is public.
const INGEST_API_KEY = process.env.INGEST_API_KEY || "";

if (!MONGODB_URI) {
    console.error("[FATAL] MONGODB_URI is not set. Set it as an environment variable and restart.");
    process.exit(1);
}
if (!INGEST_API_KEY) {
    console.warn("[WARN] INGEST_API_KEY is not set -- /api/ingest is UNAUTHENTICATED. Set this before going public.");
}

const POLL_INTERVAL_MS = 1000;
const DISCOVER_INTERVAL_MS = 5000;

// --------------------------------------------------------------
// MONGODB CONNECTION
// --------------------------------------------------------------
let db;
let eventsCol;      // every parsed row, one document each -- the durable history
let machineStateCol; // per-machine file offset, so restarts don't re-insert duplicates

async function connectMongo() {
    const client = new MongoClient(MONGODB_URI);
    await client.connect();
    db = client.db(MONGODB_DB_NAME);
    eventsCol = db.collection("events");
    machineStateCol = db.collection("machine_state");

    await eventsCol.createIndex({ machineId: 1, timestamp: -1 });
    await eventsCol.createIndex({ operatorCode: 1 });
    await eventsCol.createIndex({ labelNumber: 1 });
    await eventsCol.createIndex({ sessionId: 1 });

    console.log(`[MONGO] Connected to Atlas, database "${MONGODB_DB_NAME}".`);
}

// --------------------------------------------------------------
// IN-MEMORY MODEL (for instant SSE pushes -- hydrated from Mongo on
// startup instead of replaying local CSV files from scratch)
// --------------------------------------------------------------

function freshStore() {
    return {
        sessions: new Map(),
        operatorSessions: new Map(),
        tagScans: new Map(),
        unattributedScans: [],
        duplicateIgnored: [],
        loginConflicts: [],
        activeSessionId: null,
        recentEvents: [],
    };
}

const machines = new Map(); // machineId -> { store, filePath, fileOffset, partialLine }

function normalizeLabel(v) {
    if (!v) return "";
    return v.trim().replace(/^0+(?=\d)/, "").toUpperCase();
}
function normalizeOperatorCode(v) {
    return (v || "").trim().toUpperCase();
}
function parseTimestamp(str) {
    if (!str) return null;
    const d = new Date(str.replace(" ", "T"));
    return isNaN(d.getTime()) ? null : d;
}
function formatDuration(totalSeconds) {
    if (totalSeconds == null || totalSeconds < 0) return "";
    const whole = Math.floor(totalSeconds);
    const hours = Math.floor(whole / 3600);
    const minutes = Math.floor((whole % 3600) / 60);
    const seconds = whole % 60;
    let out = "";
    if (hours > 0) out += hours + "h ";
    out += minutes + "m " + seconds + "s";
    return out;
}
function pushRecentEvent(store, evt) {
    store.recentEvents.unshift(evt);
    if (store.recentEvents.length > 300) store.recentEvents.length = 300;
}
function addTagScan(store, labelNumber, record) {
    const key = normalizeLabel(labelNumber);
    if (!key) return;
    if (!store.tagScans.has(key)) store.tagScans.set(key, []);
    store.tagScans.get(key).push(record);
}

// Applies one parsed row to the in-memory store (fields = 8-element array
// in the same order as the CSV columns). Used when tailing fresh CSV
// lines, when hydrating from Mongo on startup, and when a device POSTs
// an event directly to /api/ingest.
function processRow(store, fields) {
    const [eventType, machineId, operatorCodeRaw, sessionId, tagFull, tagInternalId, tagLabelNumber, timestamp] = fields;
    const operatorCode = normalizeOperatorCode(operatorCodeRaw);

    switch (eventType) {
        case "LOGIN": {
            const sessionObj = {
                sessionId, operatorCode, machineId,
                loginTime: timestamp, logoutTime: null,
                durationSeconds: null, pieceCount: 0, tags: [], status: "active",
            };
            store.sessions.set(sessionId, sessionObj);
            if (!store.operatorSessions.has(operatorCode)) store.operatorSessions.set(operatorCode, []);
            store.operatorSessions.get(operatorCode).push(sessionId);
            store.activeSessionId = sessionId;
            pushRecentEvent(store, { eventType, operatorCode, sessionId, timestamp, machineId });
            break;
        }
        case "LOGOUT": {
            const sessionObj = store.sessions.get(sessionId);
            if (sessionObj) {
                sessionObj.logoutTime = timestamp;
                sessionObj.status = "closed";
                const loginD = parseTimestamp(sessionObj.loginTime);
                const logoutD = parseTimestamp(timestamp);
                if (loginD && logoutD) sessionObj.durationSeconds = Math.max(0, (logoutD - loginD) / 1000);
            }
            if (store.activeSessionId === sessionId) store.activeSessionId = null;
            pushRecentEvent(store, {
                eventType, operatorCode, sessionId, timestamp, machineId,
                pieceCount: sessionObj ? sessionObj.pieceCount : null,
                durationSeconds: sessionObj ? sessionObj.durationSeconds : null,
            });
            break;
        }
        case "SCAN": {
            const sessionObj = store.sessions.get(sessionId);
            const record = { eventType, operatorCode, sessionId, machineId, tagFull, internalId: tagInternalId, labelNumber: tagLabelNumber, timestamp };
            if (sessionObj) {
                sessionObj.pieceCount++;
                sessionObj.tags.push({ labelNumber: tagLabelNumber, internalId: tagInternalId, fullRaw: tagFull, timestamp });
            }
            addTagScan(store, tagLabelNumber, record);
            pushRecentEvent(store, record);
            break;
        }
        case "DUPLICATE_IGNORED": {
            const record = { eventType, operatorCode, sessionId, machineId, tagFull, internalId: tagInternalId, labelNumber: tagLabelNumber, timestamp };
            store.duplicateIgnored.push(record);
            addTagScan(store, tagLabelNumber, record);
            pushRecentEvent(store, record);
            break;
        }
        case "UNATTRIBUTED_SCAN": {
            const record = { eventType, operatorCode: "", sessionId: "", machineId, tagFull, internalId: tagInternalId, labelNumber: tagLabelNumber, timestamp };
            store.unattributedScans.push(record);
            addTagScan(store, tagLabelNumber, record);
            pushRecentEvent(store, record);
            break;
        }
        case "LOGIN_CONFLICT": {
            const record = { eventType, operatorCode, sessionId, machineId, timestamp };
            store.loginConflicts.push(record);
            pushRecentEvent(store, record);
            break;
        }
        default:
            break;
    }
}

function fieldsToMongoDoc(fields) {
    const [eventType, machineId, operatorCodeRaw, sessionId, tagFull, tagInternalId, tagLabelNumber, timestamp] = fields;
    return {
        eventType,
        machineId,
        operatorCode: normalizeOperatorCode(operatorCodeRaw),
        sessionId,
        tagFull: tagFull || "",
        internalId: tagInternalId || "",
        labelNumber: tagLabelNumber || "",
        labelNumberNormalized: normalizeLabel(tagLabelNumber),
        timestamp,
        insertedAt: new Date(),
    };
}

function splitCsvLine(line) {
    return line.split(",");
}

// --------------------------------------------------------------
// HYDRATE FROM MONGO ON STARTUP
// --------------------------------------------------------------
async function hydrateMachineFromMongo(machineId) {
    const store = freshStore();
    const cursor = eventsCol.find({ machineId }).sort({ insertedAt: 1 });
    for await (const doc of cursor) {
        processRow(store, [
            doc.eventType, doc.machineId, doc.operatorCode, doc.sessionId,
            doc.tagFull, doc.internalId, doc.labelNumber, doc.timestamp,
        ]);
    }
    return store;
}

async function getOrCreateMachineEntry(machineId, filePath) {
    if (machines.has(machineId)) return machines.get(machineId);

    const store = await hydrateMachineFromMongo(machineId);
    const state = await machineStateCol.findOne({ machineId });
    const entry = {
        store,
        filePath: filePath || null,
        fileOffset: state?.fileOffset || 0,
        partialLine: "",
    };
    machines.set(machineId, entry);
    console.log(`[DASHBOARD] Machine ${machineId} hydrated from Mongo (offset resumes at ${entry.fileOffset}).`);
    return entry;
}

// --------------------------------------------------------------
// FILE DISCOVERY + TAILING -- reads a local CSV if one is mounted next
// to this server (e.g. running on the same Pi, or a synced network
// share). This is optional now: when the dashboard is hosted publicly
// and the device can't share a filesystem with it, /api/ingest (below)
// is the primary path and this loop simply finds nothing to tail, which
// is fine.
// --------------------------------------------------------------

const LOG_FILENAME_PATTERN = /^production_log_(.+)\.csv$/;

function discoverMachineFiles() {
    fs.readdir(LOG_DIR, async (err, entries) => {
        if (err) {
            // Not fatal -- just means no local log directory is mounted here,
            // which is expected when the device pushes over /api/ingest instead.
            return;
        }
        for (const entry of entries) {
            const match = entry.match(LOG_FILENAME_PATTERN);
            if (!match) continue;
            const machineId = match[1];
            if (!machines.has(machineId)) {
                await getOrCreateMachineEntry(machineId, path.join(LOG_DIR, entry));
            }
        }
    });
}

function readNewDataForMachine(machineId, m) {
    if (!m.filePath) return; // this machine only sends data via /api/ingest -- nothing to tail

    fs.stat(m.filePath, (err, stats) => {
        if (err) return;

        if (stats.size < m.fileOffset) {
            m.fileOffset = 0;
            m.partialLine = "";
        }
        if (stats.size === m.fileOffset) return;

        const stream = fs.createReadStream(m.filePath, {
            start: m.fileOffset,
            end: stats.size - 1,
            encoding: "utf8",
        });

        let chunk = "";
        stream.on("data", (d) => { chunk += d; });
        stream.on("error", (e) => console.error(`[LOG READ ERROR][${machineId}]`, e.message));
        stream.on("end", async () => {
            m.fileOffset = stats.size;
            m.partialLine += chunk;
            const lines = m.partialLine.split("\n");
            m.partialLine = lines.pop();

            const docsToInsert = [];
            let changed = false;
            for (const rawLine of lines) {
                const line = rawLine.trim();
                if (!line || line.startsWith("event_type,")) continue;
                const fields = splitCsvLine(line);
                if (fields.length < 8) continue;

                processRow(m.store, fields);
                docsToInsert.push(fieldsToMongoDoc(fields));
                changed = true;
            }

            if (docsToInsert.length > 0) {
                try {
                    await eventsCol.insertMany(docsToInsert, { ordered: true });
                } catch (e) {
                    console.error(`[MONGO INSERT ERROR][${machineId}]`, e.message);
                    return;
                }
            }

            await machineStateCol.updateOne(
                { machineId },
                { $set: { fileOffset: m.fileOffset, lastPolledAt: new Date() } },
                { upsert: true }
            );

            if (changed) broadcastSnapshot();
        });
    });
}

function pollAllMachines() {
    for (const [machineId, m] of machines.entries()) {
        readNewDataForMachine(machineId, m);
    }
}

// ================================================================
// SNAPSHOT / SERIALIZATION
// ================================================================

function serializeSession(session) {
    if (!session) return null;
    return {
        sessionId: session.sessionId,
        operatorCode: session.operatorCode,
        machineId: session.machineId,
        loginTime: session.loginTime,
        logoutTime: session.logoutTime,
        durationSeconds: session.durationSeconds,
        durationFormatted: session.durationSeconds != null ? formatDuration(session.durationSeconds) : null,
        pieceCount: session.pieceCount,
        status: session.status,
        tags: session.tags,
    };
}

function getRosterForStore(store) {
    const rows = [];
    for (const [operatorCode, sessionIds] of store.operatorSessions.entries()) {
        const sessions = sessionIds.map((id) => store.sessions.get(id)).filter(Boolean);
        if (sessions.length === 0) continue;
        const totalPieces = sessions.reduce((sum, s) => sum + s.pieceCount, 0);
        const isActive = store.activeSessionId != null &&
            store.sessions.get(store.activeSessionId)?.operatorCode === operatorCode;
        const mostRecent = [...sessions].sort((a, b) => (a.loginTime < b.loginTime ? 1 : -1))[0];
        rows.push({
            operatorCode, isActive,
            sessionCount: sessions.length,
            totalPieces,
            lastLoginTime: mostRecent.loginTime,
            lastLogoutTime: mostRecent.logoutTime,
            machineId: mostRecent.machineId,
        });
    }
    rows.sort((a, b) => {
        if (a.isActive !== b.isActive) return b.isActive - a.isActive;
        return a.lastLoginTime < b.lastLoginTime ? 1 : -1;
    });
    return rows;
}

function computeStatsForStore(store) {
    let totalSessions = 0, totalPieces = 0;
    for (const s of store.sessions.values()) {
        totalSessions++;
        totalPieces += s.pieceCount;
    }
    return { totalOperators: store.operatorSessions.size, totalSessions, totalPieces };
}

function getSnapshot() {
    const machineSnapshots = {};
    let combinedRoster = [], combinedRecent = [];
    let combinedStats = { totalOperators: 0, totalSessions: 0, totalPieces: 0 };
    let anyActiveSession = null;

    for (const [machineId, m] of machines.entries()) {
        const activeSession = m.store.activeSessionId ? m.store.sessions.get(m.store.activeSessionId) : null;
        const roster = getRosterForStore(m.store);
        const stats = computeStatsForStore(m.store);

        machineSnapshots[machineId] = {
            machineId,
            activeSession: serializeSession(activeSession),
            roster,
            recentEvents: m.store.recentEvents.slice(0, 40),
            stats,
        };

        combinedRoster = combinedRoster.concat(roster);
        combinedRecent = combinedRecent.concat(m.store.recentEvents.slice(0, 40));
        combinedStats.totalOperators += stats.totalOperators;
        combinedStats.totalSessions += stats.totalSessions;
        combinedStats.totalPieces += stats.totalPieces;
        if (activeSession) anyActiveSession = serializeSession(activeSession);
    }

    combinedRecent.sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));

    return {
        activeSession: anyActiveSession,
        roster: combinedRoster,
        recentEvents: combinedRecent.slice(0, 40),
        stats: combinedStats,
        machines: machineSnapshots,
        machineCount: machines.size,
    };
}

// ================================================================
// SEARCH -- backed by Mongo queries directly
// ================================================================

const OPERATOR_CODE_PATTERN = /^BF\d{5}$/i;

async function searchOperator(codeRaw) {
    const code = normalizeOperatorCode(codeRaw);
    const docs = await eventsCol.find({ operatorCode: code, eventType: { $in: ["LOGIN", "LOGOUT", "SCAN"] } })
        .sort({ timestamp: -1 }).toArray();
    if (docs.length === 0) return null;

    const sessionsMap = new Map();
    for (const doc of docs) {
        if (!sessionsMap.has(doc.sessionId)) {
            sessionsMap.set(doc.sessionId, {
                sessionId: doc.sessionId, operatorCode: code, machineId: doc.machineId,
                loginTime: null, logoutTime: null, durationSeconds: null,
                pieceCount: 0, tags: [], status: "active",
            });
        }
        const s = sessionsMap.get(doc.sessionId);
        if (doc.eventType === "LOGIN") s.loginTime = doc.timestamp;
        if (doc.eventType === "LOGOUT") {
            s.logoutTime = doc.timestamp;
            s.status = "closed";
            const loginD = parseTimestamp(s.loginTime), logoutD = parseTimestamp(doc.timestamp);
            if (loginD && logoutD) s.durationSeconds = Math.max(0, (logoutD - loginD) / 1000);
        }
        if (doc.eventType === "SCAN") {
            s.pieceCount++;
            s.tags.push({ labelNumber: doc.labelNumber, internalId: doc.internalId, fullRaw: doc.tagFull, timestamp: doc.timestamp });
        }
    }

    const sessions = [...sessionsMap.values()]
        .map((s) => ({ ...s, durationFormatted: s.durationSeconds != null ? formatDuration(s.durationSeconds) : null }))
        .sort((a, b) => (a.loginTime < b.loginTime ? 1 : -1));

    const isCurrentlyActive = sessions.some((s) => s.status === "active");
    const totals = sessions.reduce((acc, s) => {
        acc.totalPieces += s.pieceCount;
        if (s.durationSeconds != null) acc.totalDurationSeconds += s.durationSeconds;
        return acc;
    }, { totalPieces: 0, totalDurationSeconds: 0 });

    return {
        type: "operator",
        operatorCode: code,
        isCurrentlyActive,
        sessionCount: sessions.length,
        totals: {
            totalPieces: totals.totalPieces,
            totalDurationSeconds: totals.totalDurationSeconds,
            totalDurationFormatted: formatDuration(totals.totalDurationSeconds),
        },
        sessions,
    };
}

async function searchTag(labelRaw) {
    const key = normalizeLabel(labelRaw);
    const scans = await eventsCol.find({ labelNumberNormalized: key }).sort({ timestamp: -1 }).toArray();
    if (scans.length === 0) return null;

    return {
        type: "tag",
        labelNumber: labelRaw.trim(),
        internalId: scans[0].internalId,
        totalAcceptedScans: scans.filter((s) => s.eventType === "SCAN").length,
        totalDuplicatesIgnored: scans.filter((s) => s.eventType === "DUPLICATE_IGNORED").length,
        totalUnattributed: scans.filter((s) => s.eventType === "UNATTRIBUTED_SCAN").length,
        scans: scans.map((s) => ({
            eventType: s.eventType, operatorCode: s.operatorCode, timestamp: s.timestamp, machineId: s.machineId,
        })),
    };
}

async function fuzzySearch(qRaw) {
    const q = qRaw.trim();
    if (!q) return { type: "empty", results: [] };
    const regex = new RegExp(q, "i");

    const operatorDocs = await eventsCol.distinct("operatorCode", { operatorCode: regex });
    const tagDocs = await eventsCol.distinct("labelNumber", { labelNumber: regex });

    const operatorMatches = operatorDocs.filter(Boolean).map((code) => ({ kind: "operator", value: code }));
    const tagMatches = tagDocs.filter(Boolean).map((label) => ({ kind: "tag", value: label }));
    return { type: "fuzzy", results: [...operatorMatches, ...tagMatches].slice(0, 20) };
}

// ================================================================
// SSE
// ================================================================
const sseClients = new Set();
function broadcastSnapshot() {
    const payload = `data: ${JSON.stringify(getSnapshot())}\n\n`;
    for (const res of sseClients) res.write(payload);
}

// ================================================================
// EXPRESS APP
// ================================================================
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

app.get("/api/snapshot", (req, res) => res.json(getSnapshot()));

app.get("/api/events", (req, res) => {
    res.set({ "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    res.flushHeaders();
    res.write(`data: ${JSON.stringify(getSnapshot())}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
});

app.get("/api/machines", (req, res) => res.json({ machines: [...machines.keys()] }));

app.get("/api/roster", (req, res) => res.json({ roster: getSnapshot().roster }));

app.get("/api/operator/:code", async (req, res) => {
    try {
        const result = await searchOperator(req.params.code);
        if (!result) return res.status(404).json({ error: "No sessions found for that operator code." });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: "Database error." });
    }
});

app.get("/api/tag/:label", async (req, res) => {
    try {
        const result = await searchTag(req.params.label);
        if (!result) return res.status(404).json({ error: "No scans found for that tag label." });
        res.json(result);
    } catch (e) {
        res.status(500).json({ error: "Database error." });
    }
});

app.get("/api/search", async (req, res) => {
    try {
        const q = (req.query.q || "").toString();
        if (!q.trim()) return res.json({ type: "empty" });

        if (OPERATOR_CODE_PATTERN.test(q.trim())) {
            const result = await searchOperator(q);
            if (result) return res.json(result);
        }
        const tagResult = await searchTag(q);
        if (tagResult) return res.json(tagResult);

        const operatorResult = await searchOperator(q);
        if (operatorResult) return res.json(operatorResult);

        return res.json(await fuzzySearch(q));
    } catch (e) {
        res.status(500).json({ error: "Database error." });
    }
});

// ================================================================
// INGEST -- receives events pushed directly over HTTP from the
// scanning device (main.cpp's postEventAsync). This is the primary
// data path once the dashboard is hosted publicly, since the device's
// local CSV log lives on hardware this server can't read a filesystem
// from.
// ================================================================

app.post("/api/ingest", async (req, res) => {
    if (INGEST_API_KEY) {
        const provided = req.header("X-API-Key") || "";
        if (provided !== INGEST_API_KEY) {
            return res.status(401).json({ error: "Invalid or missing API key." });
        }
    }

    const b = req.body || {};
    const eventType = (b.eventType || "").toString();
    const machineId = (b.machineId || "").toString();
    if (!eventType || !machineId) {
        return res.status(400).json({ error: "eventType and machineId are required." });
    }

    const fields = [
        eventType,
        machineId,
        (b.operatorCode || "").toString(),
        (b.sessionId || "").toString(),
        (b.tagFull || "").toString(),
        (b.internalId || "").toString(),
        (b.labelNumber || "").toString(),
        (b.timestamp || new Date().toISOString().replace("T", " ").slice(0, 19)).toString(),
    ];

    try {
        const entry = await getOrCreateMachineEntry(machineId, null);
        processRow(entry.store, fields);
        await eventsCol.insertOne(fieldsToMongoDoc(fields));
        broadcastSnapshot();
        res.json({ ok: true });
    } catch (e) {
        console.error("[INGEST ERROR]", e.message);
        res.status(500).json({ error: "Could not store event." });
    }
});

// ================================================================
// PAIRING / ADMIN -- unchanged, still file-based handshake with
// station_scanner
// ================================================================

function readControlFile(filename) {
    const filePath = path.join(CONTROL_DIR, filename);
    try {
        const text = fs.readFileSync(filePath, "utf8");
        const out = {};
        for (const line of text.split("\n")) {
            const eq = line.indexOf("=");
            if (eq === -1) continue;
            out[line.slice(0, eq)] = line.slice(eq + 1);
        }
        return out;
    } catch {
        return null;
    }
}
function writeControlFile(filename, fields) {
    fs.mkdirSync(CONTROL_DIR, { recursive: true });
    const filePath = path.join(CONTROL_DIR, filename);
    const text = Object.entries(fields).map(([k, v]) => `${k}=${v}`).join("\n") + "\n";
    fs.writeFileSync(filePath, text);
}

app.get("/api/pairing/status", (req, res) => {
    const status = readControlFile("pairing_status.txt");
    if (!status) return res.json({ paired: false, machineId: "", knownYet: false });
    res.json({ paired: status.paired === "true", machineId: status.machine_id || "", knownYet: true });
});

app.post("/api/pairing/request", (req, res) => {
    const { machineId, password } = req.body || {};
    if (!machineId || !machineId.trim()) return res.status(400).json({ error: "machineId is required." });
    writeControlFile("pairing_request.txt", { machine_id: machineId.trim(), password: password || "" });
    res.json({ submitted: true });
});

app.post("/api/admin/request", (req, res) => {
    const { action, password, newValue } = req.body || {};
    const validActions = ["change_id", "delete_pairing", "change_password"];
    if (!validActions.includes(action)) return res.status(400).json({ error: "Invalid action." });
    if (!password) return res.status(400).json({ error: "password is required." });
    writeControlFile("admin_request.txt", { action, password, new_value: newValue || "" });
    res.json({ submitted: true });
});

app.get("/api/admin/result", (req, res) => {
    const result = readControlFile("admin_result.txt");
    if (!result) return res.json({ pending: true });
    try { fs.unlinkSync(path.join(CONTROL_DIR, "admin_result.txt")); } catch {}
    res.json({ pending: false, result: result.result, message: result.message || "" });
});

// ================================================================
// STARTUP
// ================================================================
async function start() {
    await connectMongo();

    setInterval(discoverMachineFiles, DISCOVER_INTERVAL_MS);
    setInterval(pollAllMachines, POLL_INTERVAL_MS);
    discoverMachineFiles();
    setTimeout(pollAllMachines, 250);

    app.listen(PORT, () => {
        console.log(`[DASHBOARD] Listening on http://0.0.0.0:${PORT}`);
        console.log(`[DASHBOARD] Watching log directory (optional): ${LOG_DIR}`);
        console.log(`[DASHBOARD] Data store: MongoDB Atlas ("${MONGODB_DB_NAME}")`);
    });
}

start().catch((err) => {
    console.error("[FATAL] Failed to start:", err);
    process.exit(1);
});