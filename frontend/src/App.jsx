import { useEffect, useRef, useState, useCallback } from "react";
import { io } from "socket.io-client";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
} from "recharts";
import "./index.css";

// ---------------------------------------------------------------------------
// Backend URL — set VITE_BACKEND_URL in frontend/.env or Vercel settings
// ---------------------------------------------------------------------------
const rawBackendUrl =
  import.meta.env.VITE_BACKEND_URL || "https://fireguard-backend.onrender.com";
const BACKEND_URL = rawBackendUrl.trim().replace(/\/+$/, "").replace(/\/api$/, "");

// Maximum chart points retained in the browser (independent of backend)
const MAX_CHART_POINTS = 100;

// ---------------------------------------------------------------------------
// Socket instance (module-level so it survives re-renders)
// ---------------------------------------------------------------------------

const socket = io(BACKEND_URL, {
  transports: ["websocket", "polling"],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function fmt(val, decimals = 1) {
  if (val === null || val === undefined) return "--";
  const n = Number(val);
  return isNaN(n) ? "--" : n.toFixed(decimals);
}

function fmtTime(isoString) {
  if (!isoString) return "--";
  try {
    return new Date(isoString).toLocaleTimeString();
  } catch {
    return "--";
  }
}

function fmtDateTime(isoString) {
  if (!isoString) return "No data received yet";
  try {
    return new Date(isoString).toLocaleString();
  } catch {
    return "--";
  }
}

function calcStats(arr, key) {
  const values = arr
    .map((r) => r[key])
    .filter((v) => v !== null && v !== undefined && !isNaN(Number(v)))
    .map(Number);
  if (values.length === 0) return { min: null, max: null, avg: null };
  const min = Math.min(...values);
  const max = Math.max(...values);
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  return { min, max, avg };
}

// ---------------------------------------------------------------------------
// Status colour mapping
// ---------------------------------------------------------------------------
const STATUS_CONFIG = {
  FIRE:               { label: "🔴 FIRE ALARM",          cls: "danger",     dot: "#dc2626" },
  WARNING:            { label: "🟡 WARNING",              cls: "warning",    dot: "#d97706" },
  SAFE:               { label: "🟢 SAFE",                 cls: "safe",       dot: "#16a34a" },
  SENSOR_ERROR:       { label: "⚠️ SENSOR ERROR",         cls: "danger",     dot: "#dc2626" },
  WAITING_FOR_DEVICE: { label: "⏳ WAITING FOR DEVICE",   cls: "neutral",    dot: "#64748b" },
  STARTING:           { label: "⏳ STARTING",              cls: "neutral",    dot: "#64748b" },
  DISCONNECTED:       { label: "🔌 DISCONNECTED",          cls: "neutral",    dot: "#64748b" },
  UNKNOWN:            { label: "❓ UNKNOWN",                cls: "neutral",    dot: "#64748b" },
};

function getStatusCfg(status, isStale) {
  if (isStale) {
    return { label: "⚠️ STALE TELEMETRY", cls: "warning", dot: "#d97706" };
  }
  return STATUS_CONFIG[status] || STATUS_CONFIG.UNKNOWN;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MetricCard({ title, value, unit, detail, highlight, isStale }) {
  return (
    <article className={`card${highlight ? " card--highlight" : ""}`}>
      <p className="card-title">{title}</p>
      <strong className="card-value">
        {value === null || value === undefined ? "--" : value}
        {value !== null && value !== undefined && unit ? (
          <span className="card-unit"> {unit}</span>
        ) : null}
      </strong>
      <p className="muted">
        {isStale ? "⚠️ Telemetry is stale" : detail}
      </p>
    </article>
  );
}

function EmptyChart({ message }) {
  return (
    <div className="chart-empty">
      <p>{message}</p>
    </div>
  );
}

function SensorChart({ data, dataKey, color, label, unit, warningRef, fireRef }) {
  if (!data || data.length === 0) {
    return <EmptyChart message={`No ${label} history yet — start the Wokwi simulation.`} />;
  }

  const formatTick = (val) => {
    if (!val) return "";
    try {
      return new Date(val).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    } catch { return ""; }
  };

  return (
    <ResponsiveContainer width="100%" height={220}>
      <LineChart data={data} margin={{ top: 8, right: 16, left: 0, bottom: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
        <XAxis
          dataKey="lastUpdated"
          tickFormatter={formatTick}
          tick={{ fontSize: 11, fill: "#64748b" }}
          interval="preserveStartEnd"
          minTickGap={60}
        />
        <YAxis
          tick={{ fontSize: 11, fill: "#64748b" }}
          width={48}
          tickFormatter={(v) => `${fmt(v, 0)}${unit}`}
        />
        <Tooltip
          labelFormatter={(l) => fmtTime(l)}
          formatter={(v) => [`${fmt(v)} ${unit}`, label]}
          contentStyle={{ fontSize: 13 }}
        />
        {warningRef !== undefined && (
          <ReferenceLine
            y={warningRef}
            stroke="#d97706"
            strokeDasharray="4 4"
            label={{ value: "WARN", fill: "#d97706", fontSize: 11 }}
          />
        )}
        {fireRef !== undefined && (
          <ReferenceLine
            y={fireRef}
            stroke="#dc2626"
            strokeDasharray="4 4"
            label={{ value: "FIRE", fill: "#dc2626", fontSize: 11 }}
          />
        )}
        <Line
          type="monotone"
          dataKey={dataKey}
          stroke={color}
          strokeWidth={2}
          dot={false}
          activeDot={{ r: 4 }}
          isAnimationActive={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function AnalysisPanel({ history }) {
  if (history.length === 0) {
    return (
      <section className="panel analysis-panel">
        <h2>Analysis</h2>
        <p className="muted">No history available yet. Start the Wokwi simulation to collect readings.</p>
      </section>
    );
  }

  const tempStats  = calcStats(history, "temperature");
  const humStats   = calcStats(history, "humidity");
  const smokeStats = calcStats(history, "smoke");

  const events = history.filter((r) => r.status === "FIRE" || r.status === "WARNING");
  const fires   = events.filter((r) => r.status === "FIRE");
  const warns   = events.filter((r) => r.status === "WARNING");

  const latest = history[history.length - 1];

  return (
    <section className="panel analysis-panel">
      <h2>Analysis</h2>

      <div className="analysis-grid">
        <div className="analysis-col">
          <h3>Temperature (°C)</h3>
          <p>Min: <strong>{fmt(tempStats.min)}</strong></p>
          <p>Max: <strong>{fmt(tempStats.max)}</strong></p>
          <p>Avg: <strong>{fmt(tempStats.avg)}</strong></p>
        </div>
        <div className="analysis-col">
          <h3>Humidity (%)</h3>
          <p>Min: <strong>{fmt(humStats.min)}</strong></p>
          <p>Max: <strong>{fmt(humStats.max)}</strong></p>
          <p>Avg: <strong>{fmt(humStats.avg)}</strong></p>
        </div>
        <div className="analysis-col">
          <h3>Smoke ADC</h3>
          <p>Min: <strong>{fmt(smokeStats.min, 0)}</strong></p>
          <p>Max: <strong>{fmt(smokeStats.max, 0)}</strong></p>
          <p>Avg: <strong>{fmt(smokeStats.avg, 0)}</strong></p>
        </div>
        <div className="analysis-col">
          <h3>Events</h3>
          <p>Readings: <strong>{history.length}</strong></p>
          <p>Warnings: <strong className="txt-warning">{warns.length}</strong></p>
          <p>Fires: <strong className="txt-danger">{fires.length}</strong></p>
        </div>
      </div>

      <p className="muted" style={{ marginTop: 12 }}>
        Last reading: {fmtDateTime(latest?.lastUpdated)}
      </p>
      <p className="muted disclaimer">
        ⚠️ Thresholds are demonstration values only. Not suitable for real fire safety systems.
      </p>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Main App
// ---------------------------------------------------------------------------
export default function App() {
  const [data, setData] = useState({
    device:                  "ESP32-FIRE-01",
    temperature:             null,
    humidity:                null,
    smoke:                   null,
    status:                  "WAITING_FOR_DEVICE",
    wifi_rssi:               null,
    uptime:                  null,
    lastUpdated:             null,
    deviceOnline:            false,
    isStale:                 false,
    secondsSinceLastReading: null,
  });

  const [history, setHistory]                 = useState([]);
  const [socketConnected, setSocketConnected] = useState(false);
  const [mqttConnected, setMqttConnected]     = useState(false);
  const [mqttBroker, setMqttBroker]           = useState("broker.hivemq.com");
  const [mqttError, setMqttError]             = useState(null);

  // Keep history ref for appending without stale closures
  const historyRef = useRef([]);

  const appendHistory = useCallback((reading) => {
    if (!reading || (reading.temperature === null && reading.humidity === null && reading.smoke === null)) {
      return;
    }
    historyRef.current = [...historyRef.current, { ...reading }];
    if (historyRef.current.length > MAX_CHART_POINTS) {
      historyRef.current = historyRef.current.slice(-MAX_CHART_POINTS);
    }
    setHistory([...historyRef.current]);
  }, []);

  useEffect(() => {
    // 1. Fetch initial health and history from backend
    fetch(`${BACKEND_URL}/api/health`)
      .then((res) => (res.ok ? res.json() : null))
      .then((health) => {
        if (health && health.mqtt) {
          setMqttConnected(Boolean(health.mqtt.connected));
          if (health.mqtt.broker) {
            setMqttBroker(health.mqtt.broker.replace(/^[a-z]+:\/\//, ""));
          }
          if (health.mqtt.lastError) {
            setMqttError(health.mqtt.lastError);
          }
        }
      })
      .catch(() => {
        // Backend sleeping or spinning up
      });

    fetch(`${BACKEND_URL}/api/history?limit=${MAX_CHART_POINTS}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json && Array.isArray(json.readings) && json.readings.length > 0) {
          historyRef.current = json.readings.slice(-MAX_CHART_POINTS);
          setHistory([...historyRef.current]);
          const latest = json.readings[json.readings.length - 1];
          if (latest) {
            setData((prev) => ({ ...prev, ...latest }));
          }
        }
      })
      .catch(() => {
        // Backend will deliver history via Socket.IO
      });

    // 2. Socket.IO event listeners
    const handleConnect = () => {
      setSocketConnected(true);
    };

    const handleDisconnect = () => {
      setSocketConnected(false);
      setMqttConnected(false);
    };

    const handleSensorData = (incoming) => {
      setData((prev) => ({ ...prev, ...incoming }));
      appendHistory(incoming);
    };

    const handleMqttStatus = (payload) => {
      setMqttConnected(Boolean(payload.connected));
      if (payload.broker) {
        setMqttBroker(payload.broker.replace(/^[a-z]+:\/\//, ""));
      }
      setMqttError(payload.error || null);
    };

    const handleDeviceStatus = (payload) => {
      setData((prev) => ({
        ...prev,
        deviceOnline: Boolean(payload.online),
        isStale: Boolean(payload.isStale),
        status: payload.status || prev.status,
      }));
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("sensorData", handleSensorData);
    socket.on("mqttStatus", handleMqttStatus);
    socket.on("deviceStatus", handleDeviceStatus);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("sensorData", handleSensorData);
      socket.off("mqttStatus", handleMqttStatus);
      socket.off("deviceStatus", handleDeviceStatus);
    };
  }, [appendHistory]);

  const isFire    = data.status === "FIRE";
  const isWarning = data.status === "WARNING";
  const isError   = data.status === "SENSOR_ERROR";
  const isSafe    = data.status === "SAFE";
  const statusCfg = getStatusCfg(data.status, data.isStale);

  return (
    <main className={`dashboard${isFire && !data.isStale ? " dashboard--fire" : ""}`}>
      {/* ── Topbar Header ────────────────────────────────────────────── */}
      <header className="topbar">
        <div>
          <p className="eyebrow">INTERNET OF THINGS PROJECT</p>
          <h1>
            <span className="fire-icon">🔥</span> FireGuard
          </h1>
          <p className="subtitle">Smart Fire Detection &amp; Monitoring System</p>
        </div>

        <div className="header-right">
          {/* Main system status badge */}
          <span className={`status-badge status-badge--${statusCfg.cls}`}>
            {statusCfg.label}
          </span>

          {/* Three decoupled connection indicators */}
          <div className="conn-indicators">
            {/* 1. Backend Service Indicator */}
            <span className={`conn-pill ${socketConnected ? "conn-pill--on" : "conn-pill--off"}`}>
              <span className="conn-dot" />
              Backend: {socketConnected ? "Online" : "Connecting..."}
            </span>

            {/* 2. MQTT Broker Indicator */}
            <span className={`conn-pill ${mqttConnected ? "conn-pill--on" : "conn-pill--danger"}`}>
              <span className="conn-dot" />
              Broker: {mqttConnected ? "Connected" : "Disconnected"}
            </span>

            {/* 3. ESP32 Simulation Device Indicator */}
            <span className={`conn-pill ${
              !socketConnected || !mqttConnected ? "conn-pill--off" :
              data.deviceOnline && !data.isStale ? "conn-pill--on" :
              data.isStale ? "conn-pill--warn" :
              "conn-pill--off"
            }`}>
              <span className="conn-dot" />
              ESP32: {
                !socketConnected ? "Waiting on backend" :
                !mqttConnected ? "Broker offline" :
                data.deviceOnline && !data.isStale ? "Live Streaming" :
                data.isStale ? `Stale (${data.secondsSinceLastReading || ">15"}s)` :
                data.lastUpdated ? "Offline" :
                "Waiting for simulation"
              }
            </span>
          </div>

          <p className="broker-label">
            MQTT Broker: {mqttBroker}
            {mqttError && !mqttConnected ? ` (${mqttError})` : ""}
          </p>
        </div>
      </header>

      {/* ── Device info strip ──────────────────────────────────────── */}
      <div className="device-strip">
        <span>Device: <strong>{data.device || "ESP32-FIRE-01"}</strong></span>
        <span>Last reading: <strong>{fmtDateTime(data.lastUpdated)}</strong></span>
        <span>
          Data state: <strong className={data.isStale ? "txt-warning" : data.deviceOnline ? "txt-safe" : "muted"}>
            {data.isStale ? `STALE (${data.secondsSinceLastReading || ">15"}s ago)` : data.deviceOnline ? "LIVE STREAMING" : "WAITING FOR FIRST MESSAGE"}
          </strong>
        </span>
        {data.wifi_rssi !== null && (
          <span>Wi-Fi RSSI: <strong>{data.wifi_rssi} dBm</strong></span>
        )}
        {data.uptime !== null && (
          <span>Uptime: <strong>{data.uptime}s</strong></span>
        )}
      </div>

      {/* ── Alert panel (Decoupled system diagnostics) ──────────────── */}
      <section className={`panel alert-panel alert-panel--${
        !socketConnected ? "neutral" :
        !mqttConnected ? "danger" :
        data.isStale ? "warning" :
        statusCfg.cls
      }`}>
        <div className="alert-dot-wrap">
          <span
            className={`big-dot${isFire && !data.isStale ? " big-dot--pulse" : ""}`}
            style={{
              background: !socketConnected ? "#94a3b8" :
                          !mqttConnected ? "#ef4444" :
                          data.isStale ? "#f59e0b" :
                          statusCfg.dot
            }}
          />
        </div>
        <div>
          <h2 className="alert-heading">
            {!socketConnected && "🔌 Backend Server Disconnected"}
            {socketConnected && !mqttConnected && "⚠️ MQTT Broker Disconnected"}
            {socketConnected && mqttConnected && !data.lastUpdated && "⏳ Waiting for ESP32 Simulation"}
            {socketConnected && mqttConnected && data.isStale && "⚠️ Stale Sensor Telemetry"}
            {socketConnected && mqttConnected && !data.isStale && isFire && "🔴 Fire Alarm Condition Detected!"}
            {socketConnected && mqttConnected && !data.isStale && isWarning && "🟡 Warning — Threshold Exceeded"}
            {socketConnected && mqttConnected && !data.isStale && isError && "⚠️ Sensor Error — Check DHT22 Connection"}
            {socketConnected && mqttConnected && !data.isStale && isSafe && "🟢 System Safe — Normal Conditions"}
          </h2>
          <p className="muted">
            {!socketConnected && (
              "Cannot reach Render backend. If Render was asleep on the free tier, it takes 30–50 seconds to boot up."
            )}
            {socketConnected && !mqttConnected && (
              `Backend is online, but disconnected from MQTT broker (${mqttBroker}). The backend is automatically reconnecting.`
            )}
            {socketConnected && mqttConnected && !data.lastUpdated && (
              "Backend and MQTT broker are connected. Start the Wokwi ESP32 simulation to begin receiving live readings."
            )}
            {socketConnected && mqttConnected && data.isStale && (
              `Last sensor reading was received ${data.secondsSinceLastReading ? data.secondsSinceLastReading + " seconds" : "over 15s"} ago. Check if Wokwi simulation was paused or stopped.`
            )}
            {socketConnected && mqttConnected && !data.isStale && data.lastUpdated && (
              `Live streaming active. Reading timestamp: ${fmtDateTime(data.lastUpdated)}.`
            )}
          </p>
        </div>
      </section>

      {/* ── Metric cards ───────────────────────────────────────────── */}
      <section className="cards">
        <MetricCard
          title="Temperature"
          value={data.temperature !== null ? fmt(data.temperature) : null}
          unit="°C"
          detail="DHT22 temperature sensor"
          highlight={data.temperature >= 40}
          isStale={data.isStale}
        />
        <MetricCard
          title="Humidity"
          value={data.humidity !== null ? fmt(data.humidity) : null}
          unit="%"
          detail="DHT22 relative humidity"
          isStale={data.isStale}
        />
        <MetricCard
          title="Smoke / Gas ADC"
          value={data.smoke !== null ? String(data.smoke) : null}
          unit=""
          detail="MQ-2 raw ADC (0–4095)"
          highlight={data.smoke >= 2800}
          isStale={data.isStale}
        />
        <MetricCard
          title="Wi-Fi Signal"
          value={data.wifi_rssi !== null ? String(data.wifi_rssi) : null}
          unit="dBm"
          detail="ESP32 signal strength"
          isStale={data.isStale}
        />
      </section>

      {/* ── Charts ─────────────────────────────────────────────────── */}
      <section className="charts-section">
        <h2>Live History Charts</h2>
        <p className="muted chart-note">
          Charts update automatically as MQTT sensor readings arrive.
          Showing up to {MAX_CHART_POINTS} most recent readings.
          {history.length === 0 && " Start the Wokwi simulation to collect real data."}
        </p>

        <div className="charts-grid">
          <div className="chart-card">
            <h3>Temperature (°C)</h3>
            <SensorChart
              data={history}
              dataKey="temperature"
              color="#ef4444"
              label="Temperature"
              unit="°C"
              warningRef={40}
              fireRef={60}
            />
          </div>

          <div className="chart-card">
            <h3>Humidity (%)</h3>
            <SensorChart
              data={history}
              dataKey="humidity"
              color="#3b82f6"
              label="Humidity"
              unit="%"
            />
          </div>

          <div className="chart-card chart-card--full">
            <h3>Smoke / Gas ADC Reading</h3>
            <SensorChart
              data={history}
              dataKey="smoke"
              color="#f59e0b"
              label="Smoke ADC"
              unit=""
              warningRef={2800}
              fireRef={3500}
            />
          </div>
        </div>
      </section>

      {/* ── Analysis panel ─────────────────────────────────────────── */}
      <AnalysisPanel history={history} />

      {/* ── System information ─────────────────────────────────────── */}
      <section className="panel details">
        <h2>System Information</h2>
        <div className="details-grid">
          <p><span className="detail-label">Device ID</span> ESP32-FIRE-01</p>
          <p><span className="detail-label">Hardware Transport</span> MQTT over TCP (Port 1883)</p>
          <p><span className="detail-label">Dashboard Transport</span> Socket.IO &amp; REST</p>
          <p><span className="detail-label">Data Source</span> Wokwi ESP32 simulation</p>
          <p><span className="detail-label">MQTT Broker</span> {mqttBroker}</p>
          <p><span className="detail-label">Data Topic</span> fireguard/demo01/data</p>
          <p><span className="detail-label">Status Topic</span> fireguard/demo01/status</p>
          <p><span className="detail-label">Backend Status</span> {socketConnected ? "Online (Socket.IO)" : "Offline"}</p>
          <p><span className="detail-label">Broker Status</span> {mqttConnected ? "Connected" : "Disconnected"}</p>
          <p><span className="detail-label">Readings Collected</span> {history.length} samples</p>
        </div>
      </section>

      <footer>
        FireGuard · Smart Fire Detection and Monitoring System · Academic IoT Simulation
      </footer>
    </main>
  );
}
