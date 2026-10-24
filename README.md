# FireGuard — Smart Fire Detection and Monitoring System

> **College IoT & Web Project** · ESP32 + DHT22 + MQ-2 (Wokwi) · Node.js / Express / Socket.IO (Render) · React / Vite / Recharts (Vercel) · HiveMQ Public MQTT Broker

---

## 1. System Architecture

```text
 ┌────────────────────────────────────────────────────────┐
 │                   ESP32 in Wokwi                       │
 │  - Reads DHT22 (temp, humidity) & MQ-2 (smoke)         │
 │  - Updates 1602 LCD, LEDs, and Buzzer locally          │
 │  - Connects to "Wokwi-GUEST" Wi-Fi                     │
 └──────────────────────────┬─────────────────────────────┘
                            │ MQTT over TCP (Port 1883)
                            ▼
 ┌────────────────────────────────────────────────────────┐
 │            Public MQTT Broker (HiveMQ)                 │
 │  - Host: broker.hivemq.com:1883                        │
 │  - Data Topic: fireguard/demo01/data                   │
 │  - Status Topic: fireguard/demo01/status               │
 └──────────────────────────┬─────────────────────────────┘
                            │ MQTT.js (TCP: 1883 or WS: 8000)
                            ▼
 ┌────────────────────────────────────────────────────────┐
 │               Node.js Backend (Render)                 │
 │  - Subscribes to FireGuard MQTT topics                 │
 │  - Validates and enriches sensor readings              │
 │  - Tracks MQTT connection & ESP32 data freshness       │
 │  - Serves REST API: /api/health, /api/data, /history   │
 └──────────────────────────┬─────────────────────────────┘
                            │ Socket.IO (WebSockets / Polling) & HTTP
                            ▼
 ┌────────────────────────────────────────────────────────┐
 │               React Frontend (Vercel)                  │
 │  - Decoupled indicators: Backend, Broker, ESP32        │
 │  - Real-time metric cards (Temp, Humidity, Smoke, Wi-Fi)│
 │  - Live Recharts history (with Warning & Fire thresholds│
 │  - Analysis panel (Min, Max, Avg, Event Counters)      │
 └────────────────────────────────────────────────────────┘
```

---

## 2. Root Cause Analysis: Why "MQTT Disconnected" Happened & How It Is Fixed

| Problem Identified | Root Cause | Fix Implemented |
| :--- | :--- | :--- |
| **Ambiguous Disconnection Status** | The frontend previously combined all statuses into a single indicator. If the Render backend was asleep or starting up, the frontend reported "MQTT Disconnected" even when the broker was fine. | **Decoupled Indicators**: The dashboard now independently reports: (1) **Backend: Online/Offline**, (2) **Broker: Connected/Disconnected**, and (3) **ESP32: Live/Stale/Waiting**. |
| **MQTT URL Formatting on Render** | If `MQTT_URL` was entered in Render without `mqtt://` (e.g. `broker.hivemq.com`), MQTT.js threw `Error: Missing protocol` and aborted connection attempts. | Added `normalizeMqttUrl()` to sanitize any environment variable, strip outer quotes, add default protocol, and enforce IPv4 DNS resolution for cloud containers. |
| **Duplicate Client IDs on HiveMQ** | Wokwi ESP32 simulations use a static mock MAC address. HiveMQ drops connections if two clients share the same ID (`MQTT error -2`). | Wokwi sketch now creates a unique random client ID on boot: `FireGuard-ESP32-[random]-[timestamp]`. |
| **Aggressive Socket Timeout** | A 3-second socket timeout was previously set in the sketch. Wokwi's virtual gateway tunnels packets over WebSockets, taking 3–5 seconds to complete TCP handshakes. | Removed the 3-second constraint; PubSubClient now uses standard 15-second socket timeout. |
| **Missing Device Freshness Tracking** | The backend previously never updated status when the ESP32 stopped sending data. A stale 20-minute-old reading would continue displaying as "LIVE". | Added a 15-second heartbeat monitor in `server.js`. If no messages arrive for 15s, data is marked as `isStale: true` and the dashboard alerts the user. |

---

## 3. Deployment Configuration

### A. Render (Backend Service)

1. Connect your repository to [Render](https://dashboard.render.com).
2. Choose **Web Service**.
3. **Root Directory:** `backend`
4. **Build Command:** `npm install`
5. **Start Command:** `node server.js`
6. **Environment Variables:**
   - `MQTT_URL`: `mqtt://broker.hivemq.com` *(or `ws://broker.hivemq.com:8000/mqtt` if outbound TCP port 1883 is restricted)*
   - `FRONTEND_URL`: `https://your-fireguard-app.vercel.app` *(your deployed Vercel domain, without trailing slash)*
   - *(Note: Render sets and assigns `PORT` automatically)*

### B. Vercel (Frontend Project)

1. Import your repository into [Vercel](https://vercel.com).
2. **Root Directory:** `frontend`
3. **Framework Preset:** `Vite`
4. **Build Command:** `npm run build`
5. **Output Directory:** `dist`
6. **Environment Variables:**
   - `VITE_BACKEND_URL`: `https://your-fireguard-backend.onrender.com` *(your deployed Render service URL, without trailing slash)*
7. **Important:** Whenever you add or update `VITE_BACKEND_URL`, go to **Deployments** → click the three dots on the latest deployment → click **Redeploy** so Vite injects the variable into the build bundle.

---

## 4. Local Development Instructions

Open two separate terminals on your Windows computer:

### Terminal 1: Backend
```cmd
cd "D:\Project\MIni Project\IOE_Project\Fireguard\backend"
npm install
node server.js
```
Expected output:
```text
================================================
  FireGuard Backend
  Listening on port 5000 (0.0.0.0)
  MQTT broker  : mqtt://broker.hivemq.com
  Data topic   : fireguard/demo01/data
  Status topic : fireguard/demo01/status
================================================
[MQTT] Successfully connected to broker: mqtt://broker.hivemq.com
[MQTT] Subscribed to FireGuard topics:
   - Topic: "fireguard/demo01/data" (QoS 0)
   - Topic: "fireguard/demo01/status" (QoS 0)
```

### Terminal 2: Frontend
```cmd
cd "D:\Project\MIni Project\IOE_Project\Fireguard\frontend"
npm install
npm run dev
```
Open **http://localhost:5173** in your web browser.

---

## 5. Running the Simulation in Wokwi

1. Open your Wokwi project at [wokwi.com/projects/478127007271741441](https://wokwi.com/projects/478127007271741441) (or paste the code from [`wokwi/sketch.ino`](file:///D:/Project/MIni%20Project/IOE_Project/Fireguard/wokwi/sketch.ino) and [`wokwi/diagram.json`](file:///D:/Project/MIni%20Project/IOE_Project/Fireguard/wokwi/diagram.json)).
2. In the **Library Manager** tab, verify the 4 libraries:
   - `DHT sensor library`
   - `Adafruit Unified Sensor`
   - `PubSubClient`
   - `LiquidCrystal`
3. Click the green **▶ Start Simulation** button.
4. Watch the Serial Monitor:
   ```text
   [WiFi] Connecting to Wokwi-GUEST...
   [WiFi] Connected! IP: 10.0.x.x
   [MQTT] Connecting to broker.hivemq.com:1883 as FireGuard-ESP32-xxxx
   [MQTT] Connected successfully!
   [MQTT] Published: {"device":"ESP32-FIRE-01","temperature":28.0,"humidity":55.0,"smoke":820,"status":"SAFE",...}
   ```
5. Check your dashboard (Vercel or localhost):
   - **Backend:** Online 🟢
   - **Broker:** Connected 🟢
   - **ESP32:** Live Streaming 🟢
   - The temperature, humidity, and smoke charts will update in real time every 2 seconds.

---

## 6. College Presentation Demonstration Script

| State | Action in Wokwi Simulator | Hardware Response | Web Dashboard Behavior |
| :--- | :--- | :--- | :--- |
| **SAFE** | Default initial values (28°C, 100 ppm MQ-2) | Green LED ON, Red LED OFF, Buzzer SILENT, LCD: `ST:SAFE` | Green status badge, normal alert banner, metric cards show ~28°C and ~820 ADC smoke. |
| **WARNING** | Click DHT22 → drag temperature slider to **45°C** (40°C–60°C). | Green LED ON, Red LED ON, Buzzer SILENT, LCD: `ST:WARNING` | Yellow warning banner, temperature chart reflects increase and crosses amber dashed threshold line. |
| **FIRE ALARM** | Click DHT22 → drag temperature to **65°C** (or MQ-2 ppm to **450**). | Red LED ON, Green LED OFF, **Buzzer sounds continuous 1 kHz tone**, LCD: `ST:FIRE` | Red alert banner with pulsing dot, light red background tint, Fire event counter increments. |
| **ALARM RESET** | Drag temperature and smoke sliders back to normal (<40°C, 100 ppm). | Buzzer **immediately silences**, Green LED turns back ON. | Dashboard returns to green **SAFE** status. |
| **STALE DATA DEMO** | Pause the Wokwi simulation. | Simulation stops. | After 15 seconds, the ESP32 indicator changes to **Stale (>15s)** and the dashboard warns that readings are no longer live. |
| **SENSOR ERROR** | In Wokwi diagram editor, disconnect the DHT22 `D4` wire. | Red LED ON, Buzzer SILENT, LCD: `SENSOR_ERROR Check DHT22` | Dashboard shows SENSOR ERROR banner and will **not** report safe. |

---

## 7. Troubleshooting & Verification Endpoints

- **Backend Health Check:**
  - Visit `https://your-backend.onrender.com/api/health`
  - Returns JSON with `backend: "running"`, `mqtt.connected: true`, and `device.online` status.
- **Latest Sensor Reading:**
  - Visit `https://your-backend.onrender.com/api/data`
- **Render Free Tier Cold Start:**
  - If inactive for 15 minutes, Render free instances sleep. When you open the dashboard, the backend pill will show **Connecting...** for 30–50 seconds while the server spins up.
- **Wokwi "IoT Gateway failed":**
  - This is an external Wokwi browser proxy message. The updated ESP32 sketch handles this safely: local sensor monitoring, buzzer, and LCD continue functioning even if internet access is interrupted. To reconnect, stop and restart the simulation.
