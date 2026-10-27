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
// Configuration & Helpers
// -------------------------------------------------------
const PORT         = process.env.PORT || 5000;
const MAX_HISTORY  = parseInt(process.env.MAX_HISTORY || "300", 10);
const FRONTEND_URL = process.env.FRONTEND_URL ? process.env.FRONTEND_URL.trim().replace(/\/+$/, "") : null;

// Topic names — must match sketch.ino exactly
const DATA_TOPIC   = "fireguard/demo01/data";
const STATUS_TOPIC = "fireguard/demo01/status";

// Time before sensor data is flagged as STALE (ESP32 transmits every 2 seconds)
const STALE_THRESHOLD_MS = 15000; // 15 seconds

/**
 * Normalizes user-supplied MQTT URLs from environment variables.
 * Handles missing protocol, extra quotes, whitespace, and port defaults.
 */
function normalizeMqttUrl(rawUrl) {
  let url = (rawUrl || "mqtt://broker.hivemq.com").trim();
  url = url.replace(/^["']+|["']+$/g, "").trim();

  // If protocol is missing (e.g., "broker.hivemq.com" or "broker.hivemq.com:1883")
  if (!url.includes("://")) {
    url = `mqtt://${url}`;
  }
  return url;
}

const RAW_MQTT_URL = process.env.MQTT_URL || "mqtt://broker.hivemq.com";
const MQTT_URL     = normalizeMqttUrl(RAW_MQTT_URL);

// -------------------------------------------------------
// Express + Socket.IO setup
// -------------------------------------------------------
const app    = express();
const server = http.createServer(app);

// Dynamically allow Vercel domains, localhost, or any configured origin
const allowedOriginCheck = (origin, callback) => {
  // Allow requests with no Origin header (server-to-server, curl, health checks)
  if (!origin) return callback(null, true);
  if (
    origin.includes("localhost") ||
    origin.includes("127.0.0.1") ||
    origin.endsWith(".vercel.app") ||
    (FRONTEND_URL && origin.startsWith(FRONTEND_URL))
  ) {
    return callback(null, true);
  }
  console.warn(`[CORS] Blocked request from origin: ${origin}`);
  return callback(new Error("CORS: origin not allowed"), false);
};

const io = new Server(server, {
  cors: {
    origin: allowedOriginCheck,
    methods: ["GET", "POST"],
    credentials: true
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

/** The most recent sensor reading. */
let latestData = {
  device:       "ESP32-FIRE-01",
  temperature:  null,
  humidity:     null,
  smoke:        null,
  status:       "WAITING_FOR_DEVICE",
  wifi_rssi:    null,
  uptime:       null,
  lastUpdated:  null
};

/** Bounded in-memory history array. */
const sensorHistory = [];

/** MQTT connection telemetry. */
let mqttConnected   = false;
let mqttLastError   = null;
let mqttConnectTime = null;

/** Device presence and freshness telemetry. */
let lastDevicePing  = null;
let deviceOnline    = false;

function addToHistory(reading) {
  sensorHistory.push(reading);
  if (sensorHistory.length > MAX_HISTORY) {
    sensorHistory.shift();
  }
}

/**
 * Returns current sensor reading enriched with real-time freshness telemetry.
 */
function getEnrichedData() {
  const now = Date.now();
  const isStale = lastDevicePing ? (now - lastDevicePing > STALE_THRESHOLD_MS) : true;
  const isOnline = Boolean(deviceOnline && !isStale);

  return {
    ...latestData,
    deviceOnline: isOnline,
    isStale: isStale && latestData.lastUpdated !== null,
    secondsSinceLastReading: lastDevicePing ? Math.round((now - lastDevicePing) / 1000) : null
  };
}

// -------------------------------------------------------
// MQTT client setup & lifecycle handlers
// -------------------------------------------------------
console.log(`[MQTT] Initializing client connection to: ${MQTT_URL}`);

const mqttClient = mqtt.connect(MQTT_URL, {
  clientId:        `fireguard-backend-${Math.random().toString(16).slice(2, 8)}`,
  clean:           true,
  reconnectPeriod: 4000,   // retry every 4 seconds on disconnect
  connectTimeout:  15000,  // 15 seconds per connection attempt
  keepalive:       30,
  family:          4       // Force IPv4 lookup for cloud container stability
});

mqttClient.on("connect", () => {
  mqttConnected   = true;
  mqttLastError   = null;
  mqttConnectTime = new Date().toISOString();
  console.log(`[MQTT] Successfully connected to broker: ${MQTT_URL}`);

 
mqttClient.subscribe("fireguard/demo01/#", { qos: 0 }, (err, granted) => {
  if (err) {
    console.error("[MQTT SUBSCRIBE ERROR]", err.message);
  } else {
    console.log("[MQTT SUBSCRIBED] fireguard/demo01/#");
    granted.forEach((g) => {
      console.log(`[MQTT TOPIC] ${g.topic} (QoS ${g.qos})`);
    });
  }
});


  io.emit("mqttStatus", {
    connected:   true,
    broker:      MQTT_URL,
    status:      "connected",
    error:       null,
    connectedAt: mqttConnectTime
  });
});

mqttClient.on("reconnect", () => {
  console.log(`[MQTT] Attempting reconnection to broker: ${MQTT_URL} ...`);
  mqttConnected = false;
  io.emit("mqttStatus", {
    connected: false,
    broker:    MQTT_URL,
    status:    "reconnecting",
    error:     mqttLastError
  });
});

mqttClient.on("offline", () => {
  mqttConnected = false;
  console.warn(`[MQTT] Client went offline from broker: ${MQTT_URL}`);
  io.emit("mqttStatus", {
    connected: false,
    broker:    MQTT_URL,
    status:    "offline",
    error:     mqttLastError
  });
});

mqttClient.on("error", (err) => {
  mqttConnected = false;
  mqttLastError = err ? (err.message || String(err)) : "Unknown MQTT error";
  console.error(`[MQTT] Connection error on ${MQTT_URL}:`, mqttLastError);
  io.emit("mqttStatus", {
    connected: false,
    broker:    MQTT_URL,
    status:    "error",
    error:     mqttLastError
  });
});

mqttClient.on("close", () => {
  if (mqttConnected) {
    console.log(`[MQTT] Broker connection closed.`);
  }
  mqttConnected = false;
});

// -------------------------------------------------------
// Incoming MQTT message dispatcher & validator
// -------------------------------------------------------
mqttClient.on("message", (topic, message) => {
  const raw = message.toString().trim();
  console.log(`[MQTT RECEIVED] Topic: ${topic} | Message: ${raw}`);

  // 1. Device status topic
  if (topic === STATUS_TOPIC || topic.endsWith("/status")) {
    lastDevicePing = Date.now();
    console.log(`[Status Topic] Received: "${raw}"`);

    if (raw === "ONLINE") {
      deviceOnline = true;
    } else if (raw === "OFFLINE") {
      deviceOnline = false;
    } else {
      // Direct state message like "SAFE", "WARNING", "FIRE", "SENSOR_ERROR"
      deviceOnline = true;
      latestData.status = raw;
    }

    const enriched = getEnrichedData();
    io.emit("deviceStatus", {
      online:    enriched.deviceOnline,
      rawStatus: raw,
      status:    latestData.status,
      lastSeen:  new Date(lastDevicePing).toISOString()
    });
    io.emit("sensorData", enriched);
    return;
  }

  // 2. Sensor data topic
  if (topic === DATA_TOPIC || topic.endsWith("/data")) {
    let sensor;
    try {
      sensor = JSON.parse(raw);
    } catch (parseErr) {
      console.error(`[MQTT] Malformed JSON on "${topic}":`, parseErr.message, "Payload:", raw);
      return;
    }

    // Validate sensor numbers
    const temp  = (typeof sensor.temperature === "number" && !isNaN(sensor.temperature)) ? sensor.temperature : null;
    const hum   = (typeof sensor.humidity === "number" && !isNaN(sensor.humidity)) ? sensor.humidity : null;
    const smoke = (typeof sensor.smoke === "number" && !isNaN(sensor.smoke)) ? Math.round(sensor.smoke) : null;

    if (temp === null && hum === null && smoke === null) {
      console.warn(`[MQTT] Payload ignored — no valid numeric sensor fields:`, raw);
      return;
    }

    lastDevicePing = Date.now();
    deviceOnline   = true;

    const statusVal = (typeof sensor.status === "string" && sensor.status.trim().length > 0)
      ? sensor.status.trim()
      : (latestData.status || "UNKNOWN");

    const enriched = {
      device:       typeof sensor.device === "string" ? sensor.device : latestData.device,
      temperature:  temp,
      humidity:     hum,
      smoke:        smoke,
      status:       statusVal,
      wifi_rssi:    (typeof sensor.wifi_rssi === "number" && !isNaN(sensor.wifi_rssi)) ? sensor.wifi_rssi : null,
      uptime:       (typeof sensor.uptime === "number" && !isNaN(sensor.uptime)) ? sensor.uptime : null,
      deviceOnline: true,
      lastUpdated:  new Date().toISOString()
    };

    latestData = enriched;
    addToHistory({ ...enriched });

    const clientPayload = getEnrichedData();
    io.emit("sensorData", clientPayload);
    console.log(`[Sensor Data] ${enriched.device}: T=${temp}°C, H=${hum}%, Smoke=${smoke}, Status=${statusVal}`);
  }
});

// Periodic heartbeat: detect device silence and mark data as stale
setInterval(() => {
  if (lastDevicePing && (Date.now() - lastDevicePing > STALE_THRESHOLD_MS) && deviceOnline) {
    deviceOnline = false;
    const staleData = getEnrichedData();
    io.emit("sensorData", staleData);
    io.emit("deviceStatus", {
      online:   false,
      status:   latestData.status,
      isStale:  true,
      lastSeen: new Date(lastDevicePing).toISOString()
    });
    console.log(`[Heartbeat] Device inactive for >${STALE_THRESHOLD_MS / 1000}s. Marked as STALE/OFFLINE.`);
  }
}, 5000);

// -------------------------------------------------------
// REST API Endpoints
// -------------------------------------------------------

/** GET / — Root service check */
app.get("/", (req, res) => {
  res.json({
    service:   "FireGuard Backend",
    status:    "running",
    timestamp: new Date().toISOString()
  });
});

/** GET /api/health — Full telemetry (backend, broker, device status) */
app.get("/api/health", (req, res) => {
  const enriched = getEnrichedData();
  res.json({
    backend: "running",
    mqtt: {
      connected:   mqttConnected,
      broker:      MQTT_URL,
      connectedAt: mqttConnectTime,
      lastError:   mqttLastError
    },
    device: {
      id:                      latestData.device,
      online:                  enriched.deviceOnline,
      isStale:                 enriched.isStale,
      secondsSinceLastReading: enriched.secondsSinceLastReading,
      lastSeen:                lastDevicePing ? new Date(lastDevicePing).toISOString() : null,
      currentStatus:           latestData.status
    },
    historyCount: sensorHistory.length,
    maxHistory:   MAX_HISTORY,
    timestamp:    new Date().toISOString()
  });
});

/** GET /api/data — Latest received sensor reading */
app.get("/api/data", (req, res) => {
  res.json(getEnrichedData());
});

/** GET /api/history — Historical readings with ?limit=N support */
app.get("/api/history", (req, res) => {
  const limitParam = parseInt(req.query.limit, 10);
  const limit = (!isNaN(limitParam) && limitParam > 0) ? limitParam : sensorHistory.length;
  const result = sensorHistory.slice(-limit);
  res.json({
    count:    result.length,
    total:    sensorHistory.length,
    readings: result
  });
});

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: "Endpoint not found" });
});

// -------------------------------------------------------
// Socket.IO lifecycle
// -------------------------------------------------------
io.on("connection", (socket) => {
  console.log(`[Socket.IO] Client connected: ${socket.id}`);

  // Send current telemetry immediately upon connection
  socket.emit("mqttStatus", {
    connected:   mqttConnected,
    broker:      MQTT_URL,
    status:      mqttConnected ? "connected" : "disconnected",
    error:       mqttLastError,
    connectedAt: mqttConnectTime
  });

  const enriched = getEnrichedData();
  socket.emit("sensorData", enriched);

  socket.emit("deviceStatus", {
    online:   enriched.deviceOnline,
    status:   latestData.status,
    isStale:  enriched.isStale,
    lastSeen: lastDevicePing ? new Date(lastDevicePing).toISOString() : null
  });

  socket.on("disconnect", () => {
    console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
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
  console.log(`  Data topic   : ${DATA_TOPIC}`);
  console.log(`  Status topic : ${STATUS_TOPIC}`);
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
