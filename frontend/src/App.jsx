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
// Backend URL — set VITE_BACKEND_URL in frontend/.env for production
// ---------------------------------------------------------------------------
const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL || "http://localhost:5000";

// Maximum chart points retained in the browser (independent of backend)
const MAX_CHART_POINTS = 100;

// ---------------------------------------------------------------------------
// Socket instance (module-level so it survives re-renders)
// ---------------------------------------------------------------------------
const socket = io(BACKEND_URL, { autoConnect: true });

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
  FIRE:             { label: "🔴 FIRE ALARM",        cls: "danger",     dot: "#dc2626" },
  WARNING:          { label: "🟡 WARNING",            cls: "warning",    dot: "#d97706" },
  SAFE:             { label: "🟢 SAFE",               cls: "safe",       dot: "#16a34a" },
  SENSOR_ERROR:     { label: "⚠️ SENSOR ERROR",       cls: "danger",     dot: "#dc2626" },
  WAITING_FOR_DEVICE: { label: "⏳ WAITING FOR DEVICE", cls: "neutral", dot: "#64748b" },
  STARTING:         { label: "⏳ STARTING",            cls: "neutral",    dot: "#64748b" },
  DISCONNECTED:     { label: "🔌 DISCONNECTED",        cls: "neutral",    dot: "#64748b" },
  UNKNOWN:          { label: "❓ UNKNOWN",              cls: "neutral",    dot: "#64748b" },
};

function getStatusCfg(status) {
  return STATUS_CONFIG[status] || STATUS_CONFIG.UNKNOWN;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function MetricCard({ title, value, unit, detail, highlight }) {
  return (
    <article className={`card${highlight ? " card--highlight" : ""}`}>
      <p className="card-title">{title}</p>
      <strong className="card-value">
        {value === null || value === undefined ? "--" : value}
        {value !== null && value !== undefined && unit ? (
          <span className="card-unit"> {unit}</span>
        ) : null}
      </strong>
      <p className="muted">{detail}</p>
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
    return <EmptyChart message={`No ${label} history yet — start the simulation.`} />;
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
    device:      "ESP32-FIRE-01",
    temperature: null,
    humidity:    null,
    smoke:       null,
    status:      "WAITING_FOR_DEVICE",
    wifi_rssi:   null,
    uptime:      null,
    lastUpdated: null,
  });

  const [history, setHistory]         = useState([]);
  const [socketConnected, setSocketConnected] = useState(false);
  const [mqttConnected,   setMqttConnected]   = useState(false);
  const [mqttBroker,      setMqttBroker]      = useState("--");

  // Keep history ref for appending without stale closures
  const historyRef = useRef([]);

  const appendHistory = useCallback((reading) => {
    historyRef.current = [...historyRef.current, { ...reading }];
    if (historyRef.current.length > MAX_CHART_POINTS) {
      historyRef.current = historyRef.current.slice(-MAX_CHART_POINTS);
    }
    setHistory([...historyRef.current]);
  }, []);

  useEffect(() => {
    // Socket.IO events
    socket.on("connect",    () => setSocketConnected(true));
    socket.on("disconnect", () => {
      setSocketConnected(false);
      setMqttConnected(false);
    });

    socket.on("sensorData", (incoming) => {
      setData(incoming);
      appendHistory(incoming);
    });

    socket.on("mqttStatus", ({ connected, broker }) => {
      setMqttConnected(connected);
      if (broker) setMqttBroker(broker.replace("mqtt://", ""));
    });

    return () => {
      socket.off("connect");
      socket.off("disconnect");
      socket.off("sensorData");
      socket.off("mqttStatus");
    };
  }, [appendHistory]);

  const statusCfg = getStatusCfg(data.status);
  const isFire    = data.status === "FIRE";
  const isWarning = data.status === "WARNING";
  const isError   = data.status === "SENSOR_ERROR";
  const isSafe    = data.status === "SAFE";

  return (
    <main className={`dashboard${isFire ? " dashboard--fire" : ""}`}>
      {/* ── Header ─────────────────────────────────────────────────── */}
      <header className="topbar">
        <div>
          <p className="eyebrow">INTERNET OF THINGS PROJECT</p>
          <h1>
            <span className="fire-icon">🔥</span> FireGuard
          </h1>
          <p className="subtitle">Smart Fire Detection &amp; Monitoring System</p>
        </div>

        <div className="header-right">
          {/* Status badge */}
          <span className={`status-badge status-badge--${statusCfg.cls}`}>
            {statusCfg.label}
          </span>

          {/* Connection indicators */}
          <div className="conn-indicators">
            <span className={`conn-pill ${socketConnected ? "conn-pill--on" : "conn-pill--off"}`}>
              <span className="conn-dot" />
              Backend {socketConnected ? "connected" : "disconnected"}
            </span>
            <span className={`conn-pill ${mqttConnected ? "conn-pill--on" : "conn-pill--off"}`}>
              <span className="conn-dot" />
              MQTT {mqttConnected ? "connected" : "disconnected"}
            </span>
          </div>

          {mqttBroker !== "--" && (
            <p className="broker-label">Broker: {mqttBroker}</p>
          )}
        </div>
      </header>

      {/* ── Device info strip ──────────────────────────────────────── */}
      <div className="device-strip">
        <span>Device: <strong>{data.device || "ESP32-FIRE-01"}</strong></span>
        <span>Last reading: <strong>{fmtDateTime(data.lastUpdated)}</strong></span>
        {data.wifi_rssi !== null && (
          <span>Wi-Fi RSSI: <strong>{data.wifi_rssi} dBm</strong></span>
        )}
        {data.uptime !== null && (
          <span>Uptime: <strong>{data.uptime}s</strong></span>
        )}
      </div>

      {/* ── Alert panel ────────────────────────────────────────────── */}
      <section className={`panel alert-panel alert-panel--${statusCfg.cls}`}>
        <div className="alert-dot-wrap">
          <span
            className={`big-dot${isFire ? " big-dot--pulse" : ""}`}
            style={{ background: statusCfg.dot }}
          />
        </div>
        <div>
          <h2 className="alert-heading">
            {isFire    && "🔴 Fire alarm condition detected!"}
            {isWarning && "🟡 Warning — threshold exceeded"}
            {isError   && "⚠️ Sensor error — check DHT22 connection"}
            {isSafe    && "🟢 System safe — normal conditions"}
            {!isFire && !isWarning && !isError && !isSafe &&
              `${data.status.replaceAll("_", " ")} — waiting for device`}
          </h2>
          <p className="muted">
            {!socketConnected
              ? "Not connected to backend. Is the Node.js server running?"
              : !mqttConnected
              ? "Backend running but MQTT broker not connected yet."
              : data.lastUpdated
              ? `Readings are live. Last update: ${fmtDateTime(data.lastUpdated)}`
              : "Backend connected — waiting for first reading from ESP32."}
          </p>
        </div>
      </section>

      {/* ── Metric cards ───────────────────────────────────────────── */}
      <section className="cards">
        <MetricCard
          title="Temperature"
          value={data.temperature !== null ? fmt(data.temperature) : null}
          unit="°C"
          detail="DHT22 sensor"
          highlight={data.temperature >= 40}
        />
        <MetricCard
          title="Humidity"
          value={data.humidity !== null ? fmt(data.humidity) : null}
          unit="%"
          detail="Relative humidity"
        />
        <MetricCard
          title="Smoke / Gas ADC"
          value={data.smoke !== null ? String(data.smoke) : null}
          unit=""
          detail="MQ-2 raw ADC (0–4095)"
          highlight={data.smoke >= 2800}
        />
        <MetricCard
          title="Wi-Fi Signal"
          value={data.wifi_rssi !== null ? String(data.wifi_rssi) : null}
          unit="dBm"
          detail="ESP32 signal strength"
        />
      </section>

      {/* ── Charts ─────────────────────────────────────────────────── */}
      <section className="charts-section">
        <h2>Live History Charts</h2>
        <p className="muted chart-note">
          Charts update automatically when new readings arrive from MQTT.
          Showing up to {MAX_CHART_POINTS} most recent readings.
          {history.length === 0 && " Start the Wokwi simulation to begin collecting data."}
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
          <p><span className="detail-label">Transport</span> MQTT over TCP</p>
          <p><span className="detail-label">Real-time</span> Socket.IO</p>
          <p><span className="detail-label">Data source</span> Wokwi simulation</p>
          <p><span className="detail-label">MQTT broker</span> {mqttBroker}</p>
          <p><span className="detail-label">Data topic</span> fireguard/demo01/data</p>
          <p><span className="detail-label">Status topic</span> fireguard/demo01/status</p>
          <p><span className="detail-label">Readings</span> {history.length} collected</p>
        </div>
      </section>

      <footer>
        FireGuard · Academic simulation only · Data resets on backend restart
      </footer>
    </main>
  );
}
