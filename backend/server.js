// ============================================================
// FireGuard — Smart Fire Detection and Monitoring System
// Node.js / Express / MQTT / Socket.IO Backend
// ============================================================

require("dotenv").config();

const express    = require("express");
const cors       = require("cors");
const mqtt       = require("mqtt");
const http       = require("http");
const { Server } = require("socket.io");
const nodemailer = require("nodemailer");

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
// Thresholds & Alert Configuration (Adjustable & Persisted in Memory)
// -------------------------------------------------------
const settings = {
  tempWarning:  parseFloat(process.env.DEFAULT_TEMP_WARNING  || "40.0"),
  tempFire:     parseFloat(process.env.DEFAULT_TEMP_FIRE     || "60.0"),
  humWarning:   parseFloat(process.env.DEFAULT_HUM_WARNING   || "80.0"),
  smokeWarning: parseInt(process.env.DEFAULT_SMOKE_WARNING   || "2800", 10),
  smokeFire:    parseInt(process.env.DEFAULT_SMOKE_FIRE      || "3500", 10),
  recipients: {
    userEmail:      (process.env.ALERT_USER_EMAIL      || "").trim(),
    ambulanceEmail: (process.env.ALERT_AMBULANCE_EMAIL || "").trim(),
    fireDeptEmail:  (process.env.ALERT_FIRE_DEPT_EMAIL || "").trim()
  }
};

// -------------------------------------------------------
// Nodemailer / SMTP Email Alert Service
// -------------------------------------------------------
const SMTP_HOST   = (process.env.SMTP_HOST || "").trim();
const SMTP_PORT   = parseInt(process.env.SMTP_PORT || "587", 10);
const SMTP_SECURE = process.env.SMTP_SECURE === "true" || SMTP_PORT === 465;
const SMTP_USER   = (process.env.SMTP_USER || "").trim();
const SMTP_PASS   = (process.env.SMTP_PASS || "").trim();
const ALERT_FROM  = process.env.ALERT_FROM || (SMTP_USER ? `"FireGuard Alert" <${SMTP_USER}>` : '"FireGuard Alert System" <alerts@fireguard.local>');

// Email deduplication & state tracking
let lastAlertState    = "SAFE"; // Tracks previous alert state to detect transition into FIRE
let lastAlertSentTime = 0;
const ALERT_COOLDOWN_MS = 60000; // 60 seconds minimum between repeat alerts while in continuous FIRE

function getTransporter() {
  if (!SMTP_HOST || !SMTP_USER || !SMTP_PASS) {
    return null;
  }
  return nodemailer.createTransport({
    host: SMTP_HOST,
    port: SMTP_PORT,
    secure: SMTP_SECURE,
    auth: {
      user: SMTP_USER,
      pass: SMTP_PASS
    },
    connectionTimeout: 10000,
    greetingTimeout: 5000,
    socketTimeout: 10000
  });
}

/**
 * Handles transition-based fire alarm emails.
 * Only sends when entering FIRE or after cooldown if still in FIRE.
 * Resets state when returning to SAFE.
 */
async function checkAndSendFireAlert(sensorReading, currentStatus) {
  // 1. Reset state on return to SAFE
  if (currentStatus === "SAFE") {
    if (lastAlertState === "FIRE") {
      console.log("[Email Alert] Conditions returned to SAFE. Resetting fire alert trigger.");
    }
    lastAlertState = "SAFE";
    return;
  }

  // 2. Only trigger on FIRE status
  if (currentStatus === "FIRE") {
    const isTransition = (lastAlertState !== "FIRE");
    const now = Date.now();
    const isCooldownElapsed = (now - lastAlertSentTime > ALERT_COOLDOWN_MS);

    if (!isTransition && !isCooldownElapsed) {
      // Deduplicated — already in FIRE and cooldown still active
      return;
    }

    lastAlertState = "FIRE";
    lastAlertSentTime = now;

    // Collect configured recipients
    const recipients = [];
    if (settings.recipients.userEmail)      recipients.push(settings.recipients.userEmail);
    if (settings.recipients.ambulanceEmail) recipients.push(settings.recipients.ambulanceEmail);
    if (settings.recipients.fireDeptEmail)  recipients.push(settings.recipients.fireDeptEmail);

    if (recipients.length === 0) {
      console.warn("[Email Alert] FIRE detected, but no recipient email addresses are configured in settings or environment.");
      return;
    }

    const transporter = getTransporter();
    if (!transporter) {
      console.warn("[Email Alert] FIRE detected, but SMTP is not configured (SMTP_HOST, SMTP_USER, SMTP_PASS required). Skipping email dispatch.");
      return;
    }

    const timeStr = new Date(sensorReading.lastUpdated || now).toLocaleString();
    const mailOptions = {
      from: ALERT_FROM,
      to: recipients.join(", "),
      subject: `🚨 [CRITICAL ALERT] Fire Alarm Detected by FireGuard (${sensorReading.device})`,
      text: `EMERGENCY ALERT: Fire Alarm Detected!\n\n` +
            `Device ID: ${sensorReading.device}\n` +
            `Status: ${currentStatus}\n` +
            `Temperature: ${sensorReading.temperature !== null ? sensorReading.temperature + ' °C' : 'N/A'}\n` +
            `Humidity: ${sensorReading.humidity !== null ? sensorReading.humidity + ' %' : 'N/A'}\n` +
            `Smoke Level (ADC): ${sensorReading.smoke !== null ? sensorReading.smoke : 'N/A'}\n` +
            `Timestamp: ${timeStr}\n\n` +
            `Emergency contacts notified: User, Ambulance Service, Fire Department.`,
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; border: 2px solid #dc2626; border-radius: 8px; overflow: hidden;">
          <div style="background-color: #dc2626; color: #ffffff; padding: 18px 24px; text-align: center;">
            <h1 style="margin: 0; font-size: 24px;">🚨 FIRE ALARM DETECTED</h1>
            <p style="margin: 4px 0 0; font-size: 14px;">FireGuard Smart Fire Detection System</p>
          </div>
          <div style="padding: 24px; background-color: #ffffff; color: #1e293b;">
            <p style="font-size: 16px; font-weight: bold; color: #b91c1c; margin-top: 0;">
              Critical fire event detected! Immediate action required.
            </p>
            <table style="width: 100%; border-collapse: collapse; margin: 18px 0; font-size: 14px;">
              <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 10px 0; font-weight: bold; color: #64748b;">Device ID:</td>
                <td style="padding: 10px 0; font-weight: bold;">${sensorReading.device}</td>
              </tr>
              <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 10px 0; font-weight: bold; color: #64748b;">Status:</td>
                <td style="padding: 10px 0;"><span style="background: #fee2e2; color: #991b1b; padding: 4px 10px; border-radius: 999px; font-weight: bold;">${currentStatus}</span></td>
              </tr>
              <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 10px 0; font-weight: bold; color: #64748b;">Temperature:</td>
                <td style="padding: 10px 0; font-weight: bold; color: #dc2626;">${sensorReading.temperature !== null ? sensorReading.temperature + ' °C' : 'N/A'}</td>
              </tr>
              <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 10px 0; font-weight: bold; color: #64748b;">Humidity:</td>
                <td style="padding: 10px 0;">${sensorReading.humidity !== null ? sensorReading.humidity + ' %' : 'N/A'}</td>
              </tr>
              <tr style="border-bottom: 1px solid #e2e8f0;">
                <td style="padding: 10px 0; font-weight: bold; color: #64748b;">Smoke ADC:</td>
                <td style="padding: 10px 0; font-weight: bold; color: #dc2626;">${sensorReading.smoke !== null ? sensorReading.smoke : 'N/A'}</td>
              </tr>
              <tr>
                <td style="padding: 10px 0; font-weight: bold; color: #64748b;">Timestamp:</td>
                <td style="padding: 10px 0;">${timeStr}</td>
              </tr>
            </table>
            <p style="font-size: 13px; color: #64748b; margin-bottom: 0;">
              This automated alert was dispatched to: Registered User, Ambulance Service, and Fire Department.
            </p>
          </div>
        </div>
      `
    };

    console.log(`[Email Alert] Sending fire alarm emails to: ${recipients.join(", ")}`);
    transporter.sendMail(mailOptions, (err, info) => {
      if (err) {
        console.error(`[Email Alert Error] Failed to send email alert: ${err.message}`);
      } else {
        console.log(`[Email Alert] Fire alert email dispatched successfully! (ID: ${info.messageId})`);
      }
    });
  }
}

/**
 * Dynamically computes status based on adjustable thresholds.
 */
function evaluateStatus(temp, hum, smoke, reportedStatus) {
  if (reportedStatus === "SENSOR_ERROR") return "SENSOR_ERROR";

  const isFire = (temp !== null && temp >= settings.tempFire) ||
                 (smoke !== null && smoke >= settings.smokeFire);
  if (isFire) return "FIRE";

  const isWarning = (temp !== null && temp >= settings.tempWarning) ||
                    (smoke !== null && smoke >= settings.smokeWarning) ||
                    (hum !== null && hum >= settings.humWarning);
  if (isWarning) return "WARNING";

  return "SAFE";
}

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
  return callback(null, false);
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

    // Apply configured thresholds to determine live status consistently
    const statusVal = evaluateStatus(temp, hum, smoke, sensor.status);

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

    // Trigger transition-based email alerts if FIRE status is detected
    checkAndSendFireAlert(enriched, statusVal);
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

/** GET /api/health — Full telemetry (backend, broker, device status, email status) */
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
    emailAlerts: {
      smtpConfigured: Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS),
      lastAlertState: lastAlertState,
      lastAlertSentAt: lastAlertSentTime ? new Date(lastAlertSentTime).toISOString() : null,
      recipientsConfigured: {
        user: Boolean(settings.recipients.userEmail),
        ambulance: Boolean(settings.recipients.ambulanceEmail),
        fireDept: Boolean(settings.recipients.fireDeptEmail)
      }
    },
    settings: {
      tempWarning:  settings.tempWarning,
      tempFire:     settings.tempFire,
      humWarning:   settings.humWarning,
      smokeWarning: settings.smokeWarning,
      smokeFire:    settings.smokeFire
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

/** GET /api/settings — Retrieve current thresholds and recipient emails */
app.get("/api/settings", (req, res) => {
  res.json({
    settings: {
      tempWarning:  settings.tempWarning,
      tempFire:     settings.tempFire,
      humWarning:   settings.humWarning,
      smokeWarning: settings.smokeWarning,
      smokeFire:    settings.smokeFire,
      recipients: {
        userEmail:      settings.recipients.userEmail,
        ambulanceEmail: settings.recipients.ambulanceEmail,
        fireDeptEmail:  settings.recipients.fireDeptEmail
      }
    },
    smtpConfigured: Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS)
  });
});

/** POST /api/settings — Update thresholds and recipient emails */
app.post("/api/settings", (req, res) => {
  const body = req.body || {};
  const errors = [];

  const tempWarn  = parseFloat(body.tempWarning);
  const tempFire  = parseFloat(body.tempFire);
  const humWarn   = parseFloat(body.humWarning);
  const smokeWarn = parseInt(body.smokeWarning, 10);
  const smokeFire = parseInt(body.smokeFire, 10);

  if (!isNaN(tempWarn) && !isNaN(tempFire)) {
    if (tempWarn >= tempFire) {
      errors.push("Temperature Warning threshold must be lower than Fire threshold.");
    } else {
      settings.tempWarning = tempWarn;
      settings.tempFire    = tempFire;
    }
  }

  if (!isNaN(humWarn)) {
    settings.humWarning = humWarn;
  }

  if (!isNaN(smokeWarn) && !isNaN(smokeFire)) {
    if (smokeWarn >= smokeFire) {
      errors.push("Smoke Warning threshold must be lower than Fire threshold.");
    } else {
      settings.smokeWarning = smokeWarn;
      settings.smokeFire    = smokeFire;
    }
  }

  if (body.recipients && typeof body.recipients === "object") {
    if (typeof body.recipients.userEmail === "string") {
      settings.recipients.userEmail = body.recipients.userEmail.trim();
    }
    if (typeof body.recipients.ambulanceEmail === "string") {
      settings.recipients.ambulanceEmail = body.recipients.ambulanceEmail.trim();
    }
    if (typeof body.recipients.fireDeptEmail === "string") {
      settings.recipients.fireDeptEmail = body.recipients.fireDeptEmail.trim();
    }
  }

  io.emit("settingsUpdated", {
    settings,
    smtpConfigured: Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS)
  });

  if (errors.length > 0) {
    return res.status(400).json({ error: errors.join(" "), settings });
  }

  console.log(`[Settings] Updated: Temp(${settings.tempWarning}/${settings.tempFire}°C), Smoke(${settings.smokeWarning}/${settings.smokeFire}), HumWarn(${settings.humWarning}%)`);
  return res.json({ success: true, settings });
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

  socket.emit("settingsUpdated", {
    settings,
    smtpConfigured: Boolean(SMTP_HOST && SMTP_USER && SMTP_PASS)
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
  console.log(`  SMTP Status  : ${SMTP_HOST && SMTP_USER && SMTP_PASS ? "Configured (" + SMTP_HOST + ")" : "Not configured"}`);
  if (FRONTEND_URL) {
    console.log(`  CORS allowed : ${FRONTEND_URL}`);
  }
  console.log("================================================");
  console.log("  Endpoints:");
  console.log(`    GET http://localhost:${PORT}/`);
  console.log(`    GET http://localhost:${PORT}/api/health`);
  console.log(`    GET http://localhost:${PORT}/api/data`);
  console.log(`    GET http://localhost:${PORT}/api/history`);
  console.log(`    GET http://localhost:${PORT}/api/settings`);
  console.log(`    POST http://localhost:${PORT}/api/settings`);
  console.log("================================================");
});
