// ============================================================
// FireGuard — Smart Fire Detection and Monitoring System
// Node.js / Express / MQTT / Socket.IO Backend
// ============================================================

require("dotenv").config();

const express   = require("express");
const cors      = require("cors");
const mqtt      = require("mqtt");
const http      = require("http");
const { Server } = require("socket.io");

// -------------------------------------------------------
// Configuration — override with environment variables
// -------------------------------------------------------
const PORT      = process.env.PORT      || 5000;
const MQTT_URL  = process.env.MQTT_URL  || "mqtt://broker.hivemq.com";
const MAX_HISTORY = parseInt(process.env.MAX_HISTORY || "300", 10);
const FRONTEND_URL = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.replace(/\/+$/, "") : null;

// Topic names — must match sketch.ino exactly
const DATA_TOPIC   = "fireguard/demo01/data";
const STATUS_TOPIC = "fireguard/demo01/status";

// -------------------------------------------------------
// Express + Socket.IO setup
// -------------------------------------------------------
const app    = express();
const server = http.createServer(app);

// Dynamically allow Vercel domains, localhost, or any configured origin
const allowedOriginCheck = (origin, callback) => {
  if (!origin) return callback(null, true);
  if (
    origin.includes("localhost") ||
    origin.includes("127.0.0.1") ||
    origin.endsWith(".vercel.app") ||
    (FRONTEND_URL && origin.startsWith(FRONTEND_URL))
  ) {
    return callback(null, true);
  }
  return callback(null, true);
};

const io = new Server(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

app.use(cors({
  origin: allowedOriginCheck,
  methods: ["GET", "POST", "OPTIONS"],
  credentials: true
}));
app.use(express.json());

// -------------------------------------------------------
// Application state
// -------------------------------------------------------

/** The most recent validated sensor reading. */
let latestData = {
  device:      "ESP32-FIRE-01",
  temperature: null,
  humidity:    null,
  smoke:       null,
  status:      "WAITING_FOR_DEVICE",
  wifi_rssi:   null,
  uptime:      null,
  lastUpdated: null
};

/**
 * Bounded history array.
 * Oldest readings are discarded when MAX_HISTORY is reached.
 * NOTE: This resets when the backend restarts. Add MongoDB for
 * persistence (see README for optional upgrade instructions).
 */
const sensorHistory = [];

/** Tracks MQTT connection state honestly. */
let mqttConnected   = false;
let mqttBrokerUrl   = MQTT_URL;
let mqttConnectTime = null;

// -------------------------------------------------------
// History helpers
// -------------------------------------------------------
function addToHistory(reading) {
  sensorHistory.push(reading);
  if (sensorHistory.length > MAX_HISTORY) {
    sensorHistory.shift(); // Remove oldest entry
  }
}

// -------------------------------------------------------
// MQTT setup
// -------------------------------------------------------
console.log(`[MQTT] Connecting to ${MQTT_URL} ...`);

const mqttClient = mqtt.connect(MQTT_URL, {
  clientId:        `fireguard-backend-${Math.random().toString(16).slice(2, 8)}`,
  reconnectPeriod: 5000,   // retry every 5 s
  connectTimeout:  15000   // give up after 15 s per attempt
});

mqttClient.on("connect", () => {
  mqttConnected   = true;
  mqttConnectTime = new Date().toISOString();
  console.log(`[MQTT] Connected to ${MQTT_URL}`);

  mqttClient.subscribe([DATA_TOPIC, STATUS_TOPIC], (err) => {
    if (err) {
      console.error("[MQTT] Subscription failed:", err.message);
    } else {
      console.log(`[MQTT] Subscribed to "${DATA_TOPIC}" and "${STATUS_TOPIC}"`);
    }
  });

  // Tell connected dashboards that MQTT came up
  io.emit("mqttStatus", { connected: true, broker: MQTT_URL });
});

mqttClient.on("reconnect", () => {
  console.log("[MQTT] Reconnecting...");
  mqttConnected = false;
  io.emit("mqttStatus", { connected: false, broker: MQTT_URL });
});

mqttClient.on("offline", () => {
  mqttConnected = false;
  console.log("[MQTT] Client offline.");
  io.emit("mqttStatus", { connected: false, broker: MQTT_URL });
});

mqttClient.on("error", (err) => {
  mqttConnected = false;
  console.error("[MQTT] Error:", err.message);
  io.emit("mqttStatus", { connected: false, broker: MQTT_URL, error: err.message });
});

mqttClient.on("close", () => {
  mqttConnected = false;
  console.log("[MQTT] Connection closed.");
});

// -------------------------------------------------------
// Handle incoming MQTT messages
// -------------------------------------------------------
mqttClient.on("message", (topic, message) => {
  const raw = message.toString().trim();
  console.log(`[MQTT] Message on "${topic}": ${raw.substring(0, 120)}`);

  if (topic === DATA_TOPIC) {
    // Validate JSON
    let sensor;
    try {
      sensor = JSON.parse(raw);
    } catch (parseErr) {
      console.error("[MQTT] Malformed JSON, ignoring:", parseErr.message);
      return;
    }

    // Basic field validation
    const t = typeof sensor.temperature === "number" ? sensor.temperature : null;
    const h = typeof sensor.humidity    === "number" ? sensor.humidity    : null;
    const s = typeof sensor.smoke       === "number" ? sensor.smoke       : null;

    if (t === null && h === null && s === null) {
      console.warn("[MQTT] Received payload with no valid numeric sensor fields.");
      return;
    }

    const enriched = {
      device:      sensor.device    || latestData.device,
      temperature: t,
      humidity:    h,
      smoke:       s,
      status:      typeof sensor.status === "string" ? sensor.status : "UNKNOWN",
      wifi_rssi:   typeof sensor.wifi_rssi === "number" ? sensor.wifi_rssi : null,
      uptime:      typeof sensor.uptime    === "number" ? sensor.uptime    : null,
      lastUpdated: new Date().toISOString()
    };

    latestData = enriched;
    addToHistory({ ...enriched });

    // Broadcast to all connected dashboards
    io.emit("sensorData", latestData);
  }

  if (topic === STATUS_TOPIC) {
    // Status messages are plain strings like "ONLINE", "FIRE", "SAFE"
    io.emit("deviceStatus", raw);
    console.log(`[Status] Device reported: ${raw}`);
  }
});

// -------------------------------------------------------
// REST API
// -------------------------------------------------------

/** GET / — Health check */
app.get("/", (req, res) => {
  res.json({
    service:   "FireGuard Backend",
    status:    "running",
    timestamp: new Date().toISOString()
  });
});

/** GET /api/health — Detailed backend and MQTT health */
app.get("/api/health", (req, res) => {
  res.json({
    backend:        "running",
    mqtt: {
      connected:    mqttConnected,
      broker:       mqttBrokerUrl,
      connectedAt:  mqttConnectTime
    },
    historyCount:   sensorHistory.length,
    maxHistory:     MAX_HISTORY,
    latestStatus:   latestData.status,
    timestamp:      new Date().toISOString()
  });
});

/** GET /api/data — Latest sensor reading */
app.get("/api/data", (req, res) => {
  res.json(latestData);
});

/**
 * GET /api/history — Historical readings
 * Query params:
 *   ?limit=N   — return only the last N readings (default: all)
 */
app.get("/api/history", (req, res) => {
  const limitParam = parseInt(req.query.limit, 10);
  const limit = !isNaN(limitParam) && limitParam > 0 ? limitParam : sensorHistory.length;
  const result = sensorHistory.slice(-limit);
  res.json({
    count:    result.length,
    total:    sensorHistory.length,
    readings: result
  });
});

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: "Not found" });
});

// -------------------------------------------------------
// Socket.IO connection
// -------------------------------------------------------
io.on("connection", (socket) => {
  console.log(`[Socket.IO] Dashboard connected: ${socket.id}`);

  // Send current state immediately upon connection
  socket.emit("sensorData",  latestData);
  socket.emit("mqttStatus",  { connected: mqttConnected, broker: MQTT_URL });

  socket.on("disconnect", () => {
    console.log(`[Socket.IO] Dashboard disconnected: ${socket.id}`);
  });
});

// -------------------------------------------------------
// Start server
// -------------------------------------------------------
server.listen(PORT, "0.0.0.0", () => {
  console.log("================================================");
  console.log("  FireGuard Backend");
  console.log(`  Listening on port ${PORT} (0.0.0.0)`);
  console.log(`  MQTT broker  : ${MQTT_URL}`);
  console.log(`  Max history  : ${MAX_HISTORY} readings`);
  if (FRONTEND_URL) {
    console.log(`  CORS allowed : ${FRONTEND_URL}`);
  }
  console.log("================================================");
  console.log("  Endpoints:");
  console.log(`    GET http://localhost:${PORT}/`);
  console.log(`    GET http://localhost:${PORT}/api/health`);
  console.log(`    GET http://localhost:${PORT}/api/data`);
  console.log(`    GET http://localhost:${PORT}/api/history`);
  console.log("================================================");
});
