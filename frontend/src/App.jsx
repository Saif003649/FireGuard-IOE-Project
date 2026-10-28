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
// Backend URL — configured in frontend/.env or Vercel settings
// ---------------------------------------------------------------------------
const rawBackendUrl =
  import.meta.env.VITE_BACKEND_URL || "https://fireguard-ioe-project.onrender.com";
const BACKEND_URL = rawBackendUrl.trim().replace(/\/+$/, "").replace(/\/api$/, "");

// Maximum chart points retained in browser memory
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

/**
 * Calculates a dynamic Y-axis domain that expands beyond the highest actual
 * reading and configured thresholds, with sensible padding.
 * Prevents the temperature chart from capping at 28°C.
 */
function getDynamicYDomain(data, dataKey, warningRef, fireRef, defaultMin = 0, defaultMax = 50) {
  if (!data || data.length === 0) {
    let minD = defaultMin;
    let maxD = defaultMax;
    if (typeof warningRef === "number" && !isNaN(warningRef)) {
      maxD = Math.max(maxD, warningRef + 5);
      minD = Math.min(minD, warningRef - 5);
    }
    if (typeof fireRef === "number" && !isNaN(fireRef)) {
      maxD = Math.max(maxD, fireRef + 10);
    }
    return [Math.max(0, Math.floor(minD)), Math.ceil(maxD)];
  }

  const nums = data
    .map((d) => Number(d[dataKey]))
    .filter((v) => !isNaN(v) && v !== null);

  if (nums.length === 0) {
    return [defaultMin, defaultMax];
  }

  let minVal = Math.min(...nums);
  let maxVal = Math.max(...nums);

  if (typeof warningRef === "number" && !isNaN(warningRef)) {
    minVal = Math.min(minVal, warningRef);
    maxVal = Math.max(maxVal, warningRef);
  }
  if (typeof fireRef === "number" && !isNaN(fireRef)) {
    minVal = Math.min(minVal, fireRef);
    maxVal = Math.max(maxVal, fireRef);
  }

  // Ensure minimum range of 15 units or 20% span so the graph breathes
  const span = Math.max(maxVal - minVal, 15);
  const padBottom = Math.max(Math.round(span * 0.1), 2);
  const padTop    = Math.max(Math.round(span * 0.15), 5);

  const calculatedMin = Math.max(0, Math.floor(minVal - padBottom));
  const calculatedMax = Math.ceil(maxVal + padTop);

  return [calculatedMin, calculatedMax];
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

  const yDomain = getDynamicYDomain(data, dataKey, warningRef, fireRef);

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
          domain={yDomain}
          allowDataOverflow={false}
          tick={{ fontSize: 11, fill: "#64748b" }}
          width={52}
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

function AnalysisPanel({
  history,
  settings,
  onSaveSettings,
  saveLoading,
  saveStatus,
  smtpConfigured,
}) {
  const [form, setForm] = useState({
    tempWarning:  settings.tempWarning  || 40,
    tempFire:     settings.tempFire     || 60,
    humWarning:   settings.humWarning   || 80,
    smokeWarning: settings.smokeWarning || 2800,
    smokeFire:    settings.smokeFire    || 3500,
    userEmail:      settings.recipients?.userEmail      || "",
    ambulanceEmail: settings.recipients?.ambulanceEmail || "",
    fireDeptEmail:  settings.recipients?.fireDeptEmail  || "",
  });

  const [validationError, setValidationError] = useState("");

  // Update form if user chooses to reset to active backend settings
  const syncWithSettings = () => {
    setForm({
      tempWarning:  settings.tempWarning  ?? 40,
      tempFire:     settings.tempFire     ?? 60,
      humWarning:   settings.humWarning   ?? 80,
      smokeWarning: settings.smokeWarning ?? 2800,
      smokeFire:    settings.smokeFire    ?? 3500,
      userEmail:      settings.recipients?.userEmail      || "",
      ambulanceEmail: settings.recipients?.ambulanceEmail || "",
      fireDeptEmail:  settings.recipients?.fireDeptEmail  || "",
    });
  };

  const handleChange = (e) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    setValidationError("");

    const tw = parseFloat(form.tempWarning);
    const tf = parseFloat(form.tempFire);
    const hw = parseFloat(form.humWarning);
    const sw = parseInt(form.smokeWarning, 10);
    const sf = parseInt(form.smokeFire, 10);

    if (isNaN(tw) || isNaN(tf) || isNaN(hw) || isNaN(sw) || isNaN(sf)) {
      setValidationError("All threshold fields must contain valid numeric values.");
      return;
    }

    if (tw >= tf) {
      setValidationError("Temperature Warning threshold must be lower than Fire threshold.");
      return;
    }

    if (sw >= sf) {
      setValidationError("Smoke Warning threshold must be lower than Fire threshold.");
      return;
    }

    onSaveSettings({
      tempWarning:  tw,
      tempFire:     tf,
      humWarning:   hw,
      smokeWarning: sw,
      smokeFire:    sf,
      recipients: {
        userEmail:      form.userEmail.trim(),
        ambulanceEmail: form.ambulanceEmail.trim(),
        fireDeptEmail:  form.fireDeptEmail.trim(),
      },
    });
  };

  const handleReset = () => {
    setValidationError("");
    syncWithSettings();
  };

  const tempStats  = calcStats(history, "temperature");
  const humStats   = calcStats(history, "humidity");
  const smokeStats = calcStats(history, "smoke");

  const events = history.filter((r) => r.status === "FIRE" || r.status === "WARNING");
  const fires  = events.filter((r) => r.status === "FIRE");
  const warns  = events.filter((r) => r.status === "WARNING");
  const latest = history[history.length - 1];

  return (
    <section className="panel analysis-panel">
      <h2>Analysis &amp; System Configuration</h2>

      {/* ── Historical Metric Statistics ───────────────────────── */}
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

      {/* ── Adjustable Sensor Thresholds & Emergency Alert Configuration ── */}
      <div className="settings-section">
        <div className="settings-header">
          <div>
            <h3 style={{ margin: "0 0 2px", fontSize: 16, color: "#182337" }}>
              ⚙️ Adjustable Detection Thresholds &amp; Email Alerts
            </h3>
            <p className="muted">
              Thresholds are persisted on the backend and immediately apply to live sensor status, graph reference lines, and email dispatches.
            </p>
          </div>
          <div>
            <span className={`conn-pill ${smtpConfigured ? "conn-pill--on" : "conn-pill--warn"}`}>
              <span className="conn-dot" />
              SMTP Service: {smtpConfigured ? "Configured on Render" : "Env Var Required"}
            </span>
          </div>
        </div>

        <form onSubmit={handleSubmit}>
          <div className="settings-grid">
            {/* Temperature Thresholds */}
            <div className="settings-group">
              <h4>🌡️ Temperature (°C)</h4>
              <div className="settings-row">
                <label className="settings-label" htmlFor="tempWarning">
                  Warning Threshold (°C)
                </label>
                <input
                  id="tempWarning"
                  type="number"
                  step="0.5"
                  name="tempWarning"
                  value={form.tempWarning}
                  onChange={handleChange}
                  className="settings-input"
                  required
                />
              </div>
              <div className="settings-row">
                <label className="settings-label" htmlFor="tempFire">
                  Fire Alarm Threshold (°C)
                </label>
                <input
                  id="tempFire"
                  type="number"
                  step="0.5"
                  name="tempFire"
                  value={form.tempFire}
                  onChange={handleChange}
                  className="settings-input"
                  required
                />
              </div>
            </div>

            {/* Smoke / Gas Thresholds */}
            <div className="settings-group">
              <h4>💨 Smoke / Gas (Raw ADC 0–4095)</h4>
              <div className="settings-row">
                <label className="settings-label" htmlFor="smokeWarning">
                  Smoke Warning (ADC)
                </label>
                <input
                  id="smokeWarning"
                  type="number"
                  step="10"
                  name="smokeWarning"
                  value={form.smokeWarning}
                  onChange={handleChange}
                  className="settings-input"
                  required
                />
              </div>
              <div className="settings-row">
                <label className="settings-label" htmlFor="smokeFire">
                  Smoke Fire Alarm (ADC)
                </label>
                <input
                  id="smokeFire"
                  type="number"
                  step="10"
                  name="smokeFire"
                  value={form.smokeFire}
                  onChange={handleChange}
                  className="settings-input"
                  required
                />
              </div>
            </div>

            {/* Humidity & Emergency Email Recipients */}
            <div className="settings-group">
              <h4>🚨 Emergency Alert Recipients</h4>
              <div className="settings-row">
                <label className="settings-label" htmlFor="userEmail">
                  Registered User Email
                </label>
                <input
                  id="userEmail"
                  type="email"
                  name="userEmail"
                  placeholder="user@example.com"
                  value={form.userEmail}
                  onChange={handleChange}
                  className="settings-input"
                />
              </div>
              <div className="settings-row">
                <label className="settings-label" htmlFor="ambulanceEmail">
                  Ambulance Service Email
                </label>
                <input
                  id="ambulanceEmail"
                  type="email"
                  name="ambulanceEmail"
                  placeholder="ambulance@example.com"
                  value={form.ambulanceEmail}
                  onChange={handleChange}
                  className="settings-input"
                />
              </div>
              <div className="settings-row">
                <label className="settings-label" htmlFor="fireDeptEmail">
                  Fire Department Email
                </label>
                <input
                  id="fireDeptEmail"
                  type="email"
                  name="fireDeptEmail"
                  placeholder="firedept@example.com"
                  value={form.fireDeptEmail}
                  onChange={handleChange}
                  className="settings-input"
                />
              </div>
              <div className="settings-row" style={{ marginTop: 6 }}>
                <label className="settings-label" htmlFor="humWarning">
                  Humidity Warning Threshold (%)
                </label>
                <input
                  id="humWarning"
                  type="number"
                  step="1"
                  name="humWarning"
                  value={form.humWarning}
                  onChange={handleChange}
                  className="settings-input"
                />
              </div>
            </div>
          </div>

          {/* Form Actions & Feedback */}
          <div className="settings-actions">
            <button type="submit" className="btn-primary" disabled={saveLoading}>
              {saveLoading ? "Saving..." : "Save & Apply Settings"}
            </button>
            <button type="button" className="btn-secondary" onClick={handleReset} disabled={saveLoading}>
              Reset Defaults
            </button>

            {validationError && (
              <span className="settings-feedback txt-danger">
                ⚠️ {validationError}
              </span>
            )}
            {saveStatus && (
              <span
                className={`settings-feedback ${
                  saveStatus.type === "success" ? "txt-safe" : "txt-danger"
                }`}
              >
                {saveStatus.type === "success" ? "✅" : "⚠️"} {saveStatus.message}
              </span>
            )}
          </div>
        </form>
      </div>

      <p className="muted disclaimer">
        ⚠️ Thresholds apply to active fire detection logic and email notifications. In production life-safety installations, use certified hardware sensors.
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

  // Adjustable threshold and email alert settings from backend
  const [settings, setSettings] = useState({
    tempWarning:  40,
    tempFire:     60,
    humWarning:   80,
    smokeWarning: 2800,
    smokeFire:    3500,
    recipients: {
      userEmail:      "",
      ambulanceEmail: "",
      fireDeptEmail:  "",
    },
  });
  const [smtpConfigured, setSmtpConfigured] = useState(false);
  const [saveLoading, setSaveLoading]       = useState(false);
  const [saveStatus, setSaveStatus]         = useState(null);

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

  const handleSaveSettings = async (updatedSettings) => {
    setSaveLoading(true);
    setSaveStatus(null);
    try {
      const res = await fetch(`${BACKEND_URL}/api/settings`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(updatedSettings),
      });
      const result = await res.json();
      if (res.ok) {
        setSettings(result.settings);
        setSaveStatus({ type: "success", message: "Settings saved & applied live to backend!" });
      } else {
        setSaveStatus({ type: "error", message: result.error || "Failed to save settings." });
      }
    } catch (err) {
      setSaveStatus({ type: "error", message: `Network error: ${err.message}` });
    } finally {
      setSaveLoading(false);
    }
  };

  useEffect(() => {
    // 1. Fetch initial health, history, and settings from backend
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
        if (health && health.emailAlerts) {
          setSmtpConfigured(Boolean(health.emailAlerts.smtpConfigured));
        }
      })
      .catch(() => {
        // Backend sleeping or spinning up
      });

    fetch(`${BACKEND_URL}/api/settings`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json && json.settings) {
          setSettings(json.settings);
          if (json.smtpConfigured !== undefined) {
            setSmtpConfigured(Boolean(json.smtpConfigured));
          }
        }
      })
      .catch(() => {});

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

    const handleSettingsUpdated = (payload) => {
      if (payload && payload.settings) {
        setSettings(payload.settings);
        if (payload.smtpConfigured !== undefined) {
          setSmtpConfigured(Boolean(payload.smtpConfigured));
        }
      }
    };

    socket.on("connect", handleConnect);
    socket.on("disconnect", handleDisconnect);
    socket.on("sensorData", handleSensorData);
    socket.on("mqttStatus", handleMqttStatus);
    socket.on("deviceStatus", handleDeviceStatus);
    socket.on("settingsUpdated", handleSettingsUpdated);

    return () => {
      socket.off("connect", handleConnect);
      socket.off("disconnect", handleDisconnect);
      socket.off("sensorData", handleSensorData);
      socket.off("mqttStatus", handleMqttStatus);
      socket.off("deviceStatus", handleDeviceStatus);
      socket.off("settingsUpdated", handleSettingsUpdated);
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
              `Cannot reach backend at ${BACKEND_URL}. If Render was asleep on the free tier, it takes 30–50 seconds to boot up.`
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
          detail={`DHT22 temp (Warn: ${settings.tempWarning}°C | Fire: ${settings.tempFire}°C)`}
          highlight={data.temperature !== null && data.temperature >= settings.tempWarning}
          isStale={data.isStale}
        />
        <MetricCard
          title="Humidity"
          value={data.humidity !== null ? fmt(data.humidity) : null}
          unit="%"
          detail={`DHT22 humidity (Warn: ${settings.humWarning}%)`}
          isStale={data.isStale}
        />
        <MetricCard
          title="Smoke / Gas ADC"
          value={data.smoke !== null ? String(data.smoke) : null}
          unit=""
          detail={`MQ-2 raw ADC (Warn: ${settings.smokeWarning} | Fire: ${settings.smokeFire})`}
          highlight={data.smoke !== null && data.smoke >= settings.smokeWarning}
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
          Charts update automatically as MQTT sensor readings arrive. Y-axis dynamically expands with sensor values and configurable thresholds.
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
              warningRef={settings.tempWarning}
              fireRef={settings.tempFire}
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
              warningRef={settings.humWarning}
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
              warningRef={settings.smokeWarning}
              fireRef={settings.smokeFire}
            />
          </div>
        </div>
      </section>

      {/* ── Analysis panel & Adjustable Thresholds ──────────────────── */}
      <AnalysisPanel
        key={`settings-${settings.tempWarning}-${settings.tempFire}-${settings.smokeWarning}-${settings.smokeFire}-${settings.humWarning}`}
        history={history}
        settings={settings}
        onSaveSettings={handleSaveSettings}
        saveLoading={saveLoading}
        saveStatus={saveStatus}
        smtpConfigured={smtpConfigured}
      />

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
          <p><span className="detail-label">Backend Target</span> {BACKEND_URL}</p>
          <p><span className="detail-label">Backend Status</span> {socketConnected ? "Online (Socket.IO)" : "Offline"}</p>
          <p><span className="detail-label">Broker Status</span> {mqttConnected ? "Connected" : "Disconnected"}</p>
          <p><span className="detail-label">Email Service</span> {smtpConfigured ? "🟢 SMTP Ready" : "⚪ SMTP Not Configured"}</p>
          <p><span className="detail-label">Active Thresholds</span> Temp: {settings.tempWarning}°C/{settings.tempFire}°C | Smoke: {settings.smokeWarning}/{settings.smokeFire}</p>
          <p><span className="detail-label">Readings Collected</span> {history.length} samples</p>
        </div>
      </section>

      <footer>
        FireGuard · Smart Fire Detection and Monitoring System · Academic IoT Simulation
      </footer>
    </main>
  );
}
