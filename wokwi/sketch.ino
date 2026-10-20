// ============================================================
// FireGuard — Smart Fire Detection and Monitoring System
// ESP32 Arduino Sketch for Wokwi Simulation
//
// IMPORTANT: Thresholds and pin numbers below are for academic
// demonstration only. Do NOT use these values in any real fire
// safety system.
// ============================================================

#include <WiFi.h>
#include <PubSubClient.h>
#include <DHT.h>
#include <LiquidCrystal.h>

// --- Pin Definitions (must match diagram.json connections) ---
#define DHTPIN      4     // DHT22 data line → GPIO 4
#define DHTTYPE     DHT22
#define MQ2_PIN     34    // MQ-2 analog output → GPIO 34 (input-only ADC pin)
#define BUZZER_PIN  5     // Buzzer positive → GPIO 5
#define RED_LED     18    // Red LED anode (via 220Ω) → GPIO 18
#define GREEN_LED   19    // Green LED anode (via 220Ω) → GPIO 19

// LCD: RS=23, E=22, D4=21, D5=17, D6=16, D7=15
LiquidCrystal lcd(23, 22, 21, 17, 16, 15);

DHT dht(DHTPIN, DHTTYPE);

// --- WiFi Configuration ---
// Wokwi-GUEST is the only valid SSID in the Wokwi simulator.
// No password is required.
const char* WIFI_SSID     = "Wokwi-GUEST";
const char* WIFI_PASSWORD = "";

// --- MQTT Configuration ---
// Both the ESP32 and the Node.js backend must use the same broker.
// If this broker is unavailable, change BOTH this file AND backend/server.js
// to the same alternative (e.g., "test.mosquitto.org").
const char* MQTT_SERVER = "broker.hivemq.com";
const int   MQTT_PORT   = 1883;

// Unique device identifier
const char* DEVICE_ID = "ESP32-FIRE-01";

// --- Topic Names (must match backend/server.js) ---
const char* TOPIC_DATA   = "fireguard/demo01/data";
const char* TOPIC_STATUS = "fireguard/demo01/status";

// --- Detection Thresholds (demonstration values only) ---
// TEMP_WARNING: temperature that triggers WARNING state
// TEMP_FIRE:    temperature that triggers FIRE alarm
// SMOKE_WARNING / SMOKE_FIRE: raw ADC values (0–4095) from the MQ-2 pin.
// At Wokwi default 400 ppm the ADC reads ~3800. Thresholds are set
// conservatively so you start in SAFE and can drag the slider to trigger
// WARNING or FIRE during a demo.
const float TEMP_WARNING  = 40.0;   // °C
const float TEMP_FIRE     = 60.0;   // °C
const int   SMOKE_WARNING = 2800;   // Raw ADC (≈ medium smoke)
const int   SMOKE_FIRE    = 3500;   // Raw ADC (≈ heavy smoke)

// --- Timing ---
const unsigned long READ_INTERVAL      = 2000;  // ms between sensor reads
const unsigned long RECONNECT_INTERVAL = 8000;  // ms between reconnect tries
const unsigned long WIFI_TIMEOUT       = 20000; // ms to wait for WiFi

WiFiClient   wifiClient;
PubSubClient mqttClient(wifiClient);

unsigned long lastRead      = 0;
unsigned long lastReconnect = 0;
unsigned long bootTime      = 0;

String currentStatus = "STARTING";

// -------------------------------------------------------
// LCD helper — writes exactly 16 characters on a given row
// so old text is always overwritten cleanly.
// -------------------------------------------------------
void printLCDLine(int row, String text) {
  lcd.setCursor(0, row);
  // Pad or truncate to exactly 16 characters
  text = text.substring(0, min((int)text.length(), 16));
  lcd.print(text);
  for (int i = text.length(); i < 16; i++) {
    lcd.print(' ');
  }
}

// -------------------------------------------------------
// setOutputs — drives LEDs and buzzer based on status.
// noTone() is always called first to ensure the buzzer
// is silent unless the status is FIRE.
// -------------------------------------------------------
void setOutputs(const String& status) {
  // Reset all outputs first
  digitalWrite(RED_LED,   LOW);
  digitalWrite(GREEN_LED, LOW);
  noTone(BUZZER_PIN);   // ← always silence the buzzer first

  if (status == "SAFE") {
    digitalWrite(GREEN_LED, HIGH);

  } else if (status == "WARNING") {
    // Both LEDs on for amber-ish indication; no alarm sound
    digitalWrite(GREEN_LED, HIGH);
    digitalWrite(RED_LED,   HIGH);

  } else if (status == "FIRE") {
    digitalWrite(RED_LED, HIGH);
    tone(BUZZER_PIN, 1000);   // 1 kHz alarm tone

  } else {
    // SENSOR_ERROR, STARTING, DISCONNECTED → red LED only, no buzzer
    digitalWrite(RED_LED, HIGH);
  }
}

// -------------------------------------------------------
// connectWiFi — non-blocking friendly version.
// Blocks for up to WIFI_TIMEOUT ms on first call,
// then returns immediately if already connected.
// -------------------------------------------------------
void connectWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.println("[WiFi] Connecting to Wokwi-GUEST...");
  printLCDLine(0, "Connecting WiFi");
  printLCDLine(1, "Please wait...");

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD, 6);  // channel 6 for Wokwi

  unsigned long start = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - start < WIFI_TIMEOUT) {
    delay(500);
    Serial.print('.');
  }
  Serial.println();

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[WiFi] Connected. IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("[WiFi] Connection failed after timeout.");
    Serial.print("[WiFi] Status code: ");
    Serial.println(WiFi.status());
    Serial.println("[WiFi] NOTE: In Wokwi, 'IoT Gateway failed' means the");
    Serial.println("[WiFi]       Wokwi gateway is busy/unavailable — this is");
    Serial.println("[WiFi]       a Wokwi infrastructure issue, not a code bug.");
    Serial.println("[WiFi]       Try restarting the simulation.");
  }
}

// -------------------------------------------------------
// MQTT incoming message callback
// -------------------------------------------------------
void mqttCallback(char* topic, byte* payload, unsigned int length) {
  String message;
  message.reserve(length);
  for (unsigned int i = 0; i < length; i++) {
    message += (char)payload[i];
  }
  Serial.print("[MQTT] Received on ");
  Serial.print(topic);
  Serial.print(": ");
  Serial.println(message);
}

// -------------------------------------------------------
// connectMQTT — attempts one connection only; caller
// is responsible for rate-limiting via lastReconnect.
// -------------------------------------------------------
void connectMQTT() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (mqttClient.connected())        return;

  // Build a unique client ID using part of the chip MAC
  String clientId = "FireGuard-";
  clientId += String(DEVICE_ID);
  clientId += "-";
  clientId += String((uint32_t)(ESP.getEfuseMac() & 0xFFFFFF), HEX);

  Serial.print("[MQTT] Connecting to ");
  Serial.print(MQTT_SERVER);
  Serial.print(":");
  Serial.print(MQTT_PORT);
  Serial.print(" as ");
  Serial.println(clientId);

  bool ok = mqttClient.connect(
    clientId.c_str(),
    nullptr,        // username (none for public broker)
    nullptr,        // password
    TOPIC_STATUS,   // will topic
    0,              // will QoS
    true,           // will retain
    "OFFLINE"       // last-will message
  );

  if (ok) {
    Serial.println("[MQTT] Connected.");
    // Announce online status with retain so the backend sees it on reconnect
    mqttClient.publish(TOPIC_STATUS, "ONLINE", true);
  } else {
    Serial.print("[MQTT] Connection failed. State code: ");
    Serial.println(mqttClient.state());
    // State codes:
    // -4 = timeout,  -3 = connection refused (server unavailable)
    // -2 = connection lost, -1 = disconnected, 0 = connected
    // 1 = bad protocol, 2 = bad client ID, 3 = server unavailable
    // 4 = bad credentials, 5 = not authorized
    Serial.println("[MQTT] Check that broker.hivemq.com is reachable from Wokwi.");
  }
}

// -------------------------------------------------------
// publishData — builds a valid JSON payload and publishes.
// A second read of humidity is avoided; the value is
// passed in from loop() where both reads already happened.
// -------------------------------------------------------
void publishData(float temperature, float humidity, int smoke) {
  if (!mqttClient.connected()) {
    Serial.println("[MQTT] Cannot publish — not connected.");
    return;
  }

  unsigned long uptimeSec = (millis() - bootTime) / 1000;

  // Build JSON manually (no ArduinoJson dependency needed)
  String json = "{";
  json += "\"device\":\"" + String(DEVICE_ID) + "\",";
  json += "\"temperature\":" + String(temperature, 1) + ",";
  json += "\"humidity\":"    + String(humidity, 1)    + ",";
  json += "\"smoke\":"       + String(smoke)           + ",";
  json += "\"status\":\""    + currentStatus           + "\",";
  json += "\"wifi_rssi\":"   + String(WiFi.RSSI())     + ",";
  json += "\"uptime\":"      + String(uptimeSec);
  json += "}";

  bool dataSent   = mqttClient.publish(TOPIC_DATA,   json.c_str());
  bool statusSent = mqttClient.publish(TOPIC_STATUS, currentStatus.c_str());

  if (dataSent && statusSent) {
    Serial.print("[MQTT] Published: ");
    Serial.println(json);
  } else {
    Serial.println("[MQTT] Publish failed — check buffer size or connection.");
  }
}

// ============================================================
// setup
// ============================================================
void setup() {
  Serial.begin(115200);
  bootTime = millis();

  // Output pin setup
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(RED_LED,    OUTPUT);
  pinMode(GREEN_LED,  OUTPUT);

  // Ensure clean initial state — buzzer silent, both LEDs off
  noTone(BUZZER_PIN);
  digitalWrite(RED_LED,   LOW);
  digitalWrite(GREEN_LED, LOW);

  // DHT22
  dht.begin();

  // LCD — 16 columns, 2 rows
  lcd.begin(16, 2);
  printLCDLine(0, "FIREGUARD v1.0");
  printLCDLine(1, "Starting...");
  delay(1500);

  Serial.println("================================================");
  Serial.println("  FireGuard — Smart Fire Detection System");
  Serial.println("  ESP32 Wokwi Simulation");
  Serial.println("================================================");
  Serial.print("  MQTT broker : "); Serial.println(MQTT_SERVER);
  Serial.print("  Data topic  : "); Serial.println(TOPIC_DATA);
  Serial.print("  Status topic: "); Serial.println(TOPIC_STATUS);
  Serial.println("================================================");

  connectWiFi();

  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);

  if (WiFi.status() == WL_CONNECTED) {
    connectMQTT();
  }

  currentStatus = "STARTING";
  setOutputs(currentStatus);
  printLCDLine(0, "FIREGUARD");
  printLCDLine(1, "Waiting...");
}

// ============================================================
// loop
// ============================================================
void loop() {
  // --- WiFi reconnect (rate-limited) ---
  if (WiFi.status() != WL_CONNECTED &&
      millis() - lastReconnect >= RECONNECT_INTERVAL) {
    lastReconnect = millis();
    Serial.println("[WiFi] Disconnected — attempting reconnect...");
    connectWiFi();
  }

  // --- MQTT reconnect (rate-limited, only when WiFi is up) ---
  if (WiFi.status() == WL_CONNECTED &&
      !mqttClient.connected() &&
      millis() - lastReconnect >= RECONNECT_INTERVAL) {
    lastReconnect = millis();
    connectMQTT();
  }

  // Keep MQTT alive (handles incoming messages, pings, etc.)
  mqttClient.loop();

  // --- Sensor read interval ---
  if (millis() - lastRead < READ_INTERVAL) {
    return;  // Not yet time to read
  }
  lastRead = millis();

  // --- Read DHT22 ---
  float temperature = dht.readTemperature();
  float humidity    = dht.readHumidity();

  // --- Read MQ-2 (raw ADC, 0–4095 on ESP32) ---
  int smoke = analogRead(MQ2_PIN);

  // --- Handle DHT22 read failure ---
  if (isnan(temperature) || isnan(humidity)) {
    currentStatus = "SENSOR_ERROR";
    setOutputs(currentStatus);
    printLCDLine(0, "SENSOR_ERROR");
    printLCDLine(1, "Check DHT22");

    Serial.println("[Sensor] DHT22 read failed — NaN returned.");

    if (mqttClient.connected()) {
      mqttClient.publish(TOPIC_STATUS, currentStatus.c_str());
    }
    return;  // Skip the rest of this cycle; do NOT report SAFE
  }

  // --- Determine status from real sensor values ---
  // Thresholds are demonstration values. Do not use in production.
  if (temperature >= TEMP_FIRE || smoke >= SMOKE_FIRE) {
    currentStatus = "FIRE";
  } else if (temperature >= TEMP_WARNING || smoke >= SMOKE_WARNING) {
    currentStatus = "WARNING";
  } else {
    currentStatus = "SAFE";
  }

  // --- Update LEDs and buzzer ---
  setOutputs(currentStatus);

  // --- Update LCD ---
  printLCDLine(0, "ST:" + currentStatus);
  String line2 = "T:";
  line2 += String(temperature, 1);
  line2 += "C S:";
  line2 += String(smoke);
  printLCDLine(1, line2);

  // --- Serial output ---
  Serial.print("[Sensor] T=");
  Serial.print(temperature, 1);
  Serial.print("°C  H=");
  Serial.print(humidity, 1);
  Serial.print("%  Smoke=");
  Serial.print(smoke);
  Serial.print("  Status=");
  Serial.println(currentStatus);

  // --- Publish to MQTT ---
  publishData(temperature, humidity, smoke);
}