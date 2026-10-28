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
const char* MQTT_SERVER = "broker.hivemq.com";
const int   MQTT_PORT   = 1883;

// Unique device identifier
const char* DEVICE_ID = "ESP32-FIRE-01";

// --- Topic Names (must match backend/server.js) ---
const char* TOPIC_DATA   = "fireguard/demo01/data";
const char* TOPIC_STATUS = "fireguard/demo01/status";

// --- Detection Thresholds (demonstration values only) ---
const float TEMP_WARNING  = 40.0;   // °C
const float TEMP_FIRE     = 60.0;   // °C
const int   SMOKE_WARNING = 2800;   // Raw ADC (≈ medium smoke)
const int   SMOKE_FIRE    = 3500;   // Raw ADC (≈ heavy smoke)

// --- Timing ---
const unsigned long READ_INTERVAL      = 2000;  // ms between sensor reads
const unsigned long RECONNECT_INTERVAL = 5000;  // ms between reconnect attempts (non-blocking)

WiFiClient   wifiClient;
PubSubClient mqttClient(wifiClient);

unsigned long lastRead      = 0;
unsigned long lastWifiRetry = 0;
unsigned long lastMqttRetry = 0;
unsigned long bootTime      = 0;

String currentStatus = "STARTING";

// -------------------------------------------------------
// LCD helper — writes exactly 16 characters on a given row
// so old text is always overwritten cleanly.
// -------------------------------------------------------
void printLCDLine(int row, String text) {
  lcd.setCursor(0, row);
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
  digitalWrite(RED_LED,   LOW);
  digitalWrite(GREEN_LED, LOW);
  noTone(BUZZER_PIN);

  if (status == "SAFE") {
    digitalWrite(GREEN_LED, HIGH);
  } else if (status == "WARNING") {
    digitalWrite(GREEN_LED, HIGH);
    digitalWrite(RED_LED,   HIGH);
  } else if (status == "FIRE") {
    digitalWrite(RED_LED, HIGH);
    tone(BUZZER_PIN, 1000);   // 1 kHz alarm tone
  } else {
    digitalWrite(RED_LED, HIGH);
  }
}

// -------------------------------------------------------
// connectWiFi — friendly connection handler.
// In setup (blockingWait=true), waits up to 10s for initial IP.
// In loop (blockingWait=false), initiates connection without delay.
// -------------------------------------------------------
void connectWiFi(bool blockingWait = false) {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.println("[WiFi] Connecting to Wokwi-GUEST...");
  WiFi.disconnect(true);
  delay(100);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD, 6);  // channel 6 for Wokwi simulation

  if (blockingWait) {
    printLCDLine(0, "Connecting WiFi");
    printLCDLine(1, "Please wait...");

    unsigned long start = millis();
    while (WiFi.status() != WL_CONNECTED && (millis() - start < 10000)) {
      delay(300);
      Serial.print('.');
    }
    Serial.println();
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.print("[WiFi] Connected successfully! IP: ");
    Serial.println(WiFi.localIP());
  } else {
    Serial.println("[WiFi] Not yet connected (will retry in background).");
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
// connectMQTT — attempts one non-blocking connection with
// a guaranteed unique client ID to prevent broker collisions.
// -------------------------------------------------------
void connectMQTT() {
  if (WiFi.status() != WL_CONNECTED) return;
  if (mqttClient.connected())        return;

  // Build a unique client ID on each connection attempt
  String clientId = "FireGuard-ESP32-";
  clientId += String(random(100000, 999999), HEX);
  clientId += String(millis() % 10000);

  Serial.print("[MQTT] Connecting to ");
  Serial.print(MQTT_SERVER);
  Serial.print(":");
  Serial.print(MQTT_PORT);
  Serial.print(" as ");
  Serial.println(clientId);

  // Connect with Last Will & Testament (LWT) set to OFFLINE on status topic
  bool ok = mqttClient.connect(
    clientId.c_str(),
    TOPIC_STATUS,   // will topic
    0,              // will QoS
    true,           // will retain
    "OFFLINE"       // last-will message
  );

  if (ok) {
    Serial.println("[MQTT] Connected successfully to HiveMQ broker!");
    // Publish ONLINE status with retain flag so backend receives it immediately
    bool pubOk = mqttClient.publish(TOPIC_STATUS, "ONLINE", true);
    if (pubOk) {
      Serial.println("[MQTT] Announced status: ONLINE on " + String(TOPIC_STATUS));
    }
  } else {
    int state = mqttClient.state();
    Serial.print("[MQTT] Connection failed! Error code: ");
    Serial.print(state);
    switch (state) {
      case -4: Serial.println(" (MQTT_CONNECTION_TIMEOUT — Broker did not respond in time)"); break;
      case -3: Serial.println(" (MQTT_CONNECTION_LOST — Network connection broken)"); break;
      case -2: Serial.println(" (MQTT_CONNECT_FAILED — Network connect failed or duplicate client ID)"); break;
      case -1: Serial.println(" (MQTT_DISCONNECTED — Client disconnected)"); break;
      case 1:  Serial.println(" (MQTT_CONNECT_BAD_PROTOCOL — Broker does not support requested protocol version)"); break;
      case 2:  Serial.println(" (MQTT_CONNECT_BAD_CLIENT_ID — Broker rejected client ID)"); break;
      case 3:  Serial.println(" (MQTT_CONNECT_UNAVAILABLE — Server unavailable)"); break;
      case 4:  Serial.println(" (MQTT_CONNECT_BAD_CREDENTIALS — Bad username/password)"); break;
      case 5:  Serial.println(" (MQTT_CONNECT_UNAUTHORIZED — Client not authorized)"); break;
      default: Serial.println(" (Unknown error)"); break;
    }
  }
}

// -------------------------------------------------------
// publishData — builds valid JSON and publishes sensor
// telemetry and status. Handles failures safely without crashing.
// -------------------------------------------------------
void publishData(float temperature, float humidity, int smoke) {
  if (!mqttClient.connected()) {
    Serial.println("[MQTT] Cannot publish — not connected to broker.");
    return;
  }

  unsigned long uptimeSec = (millis() - bootTime) / 1000;

  // Build JSON sensor data payload manually
  String json = "{";
  json += "\"device\":\"" + String(DEVICE_ID) + "\",";
  json += "\"temperature\":" + String(temperature, 1) + ",";
  json += "\"humidity\":"    + String(humidity, 1)    + ",";
  json += "\"smoke\":"       + String(smoke)           + ",";
  json += "\"status\":\""    + currentStatus           + "\",";
  json += "\"wifi_rssi\":"   + String(WiFi.RSSI())     + ",";
  json += "\"uptime\":"      + String(uptimeSec);
  json += "}";

  // Publish sensor JSON to fireguard/demo01/data
  bool dataSent = mqttClient.publish(TOPIC_DATA, json.c_str());

  // Publish status to fireguard/demo01/status
  bool statusSent = mqttClient.publish(TOPIC_STATUS, currentStatus.c_str());

  if (dataSent && statusSent) {
    Serial.print("[MQTT] Successfully published data (");
    Serial.print(json.length());
    Serial.print(" bytes) & status to broker: ");
    Serial.println(json);
  } else {
    Serial.print("[MQTT] Publish failed! dataSent=");
    Serial.print(dataSent ? "OK" : "FAIL");
    Serial.print(", statusSent=");
    Serial.println(statusSent ? "OK" : "FAIL");
  }
}

// ============================================================
// setup
// ============================================================
void setup() {
  Serial.begin(115200);
  randomSeed(micros());
  bootTime = millis();

  // Output pin setup
  pinMode(BUZZER_PIN, OUTPUT);
  pinMode(RED_LED,    OUTPUT);
  pinMode(GREEN_LED,  OUTPUT);

  // Ensure clean initial state
  noTone(BUZZER_PIN);
  digitalWrite(RED_LED,   LOW);
  digitalWrite(GREEN_LED, LOW);

  // Initialize DHT22
  dht.begin();

  // Initialize LCD (16 columns, 2 rows)
  lcd.begin(16, 2);
  printLCDLine(0, "FIREGUARD v1.0");
  printLCDLine(1, "Starting...");
  delay(1000);

  Serial.println("================================================");
  Serial.println("  FireGuard — Smart Fire Detection System");
  Serial.println("  ESP32 Wokwi Simulation");
  Serial.println("================================================");
  Serial.print("  MQTT broker : "); Serial.println(MQTT_SERVER);
  Serial.print("  MQTT port   : "); Serial.println(MQTT_PORT);
  Serial.print("  Data topic  : "); Serial.println(TOPIC_DATA);
  Serial.print("  Status topic: "); Serial.println(TOPIC_STATUS);
  Serial.println("================================================");

  // Initial Wi-Fi connection
  connectWiFi(true);

  // Configure MQTT client parameters
  mqttClient.setServer(MQTT_SERVER, MQTT_PORT);
  mqttClient.setCallback(mqttCallback);
  mqttClient.setBufferSize(512);
  mqttClient.setKeepAlive(15);
  mqttClient.setSocketTimeout(5);

  if (WiFi.status() == WL_CONNECTED) {
    connectMQTT();
  }

  currentStatus = "STARTING";
  setOutputs(currentStatus);
  printLCDLine(0, "FIREGUARD");
  printLCDLine(1, "System Ready");
}

// ============================================================
// loop
// ============================================================
void loop() {
  unsigned long now = millis();

  // 1. Non-blocking Wi-Fi reconnect (every 5 seconds if disconnected)
  if (WiFi.status() != WL_CONNECTED) {
    if (now - lastWifiRetry >= RECONNECT_INTERVAL) {
      lastWifiRetry = now;
      Serial.println("[WiFi] Disconnected — attempting reconnect in background...");
      connectWiFi(false);
    }
  } else {
    // 2. Non-blocking MQTT reconnect (only when Wi-Fi is connected and client is disconnected)
    if (!mqttClient.connected()) {
      if (now - lastMqttRetry >= RECONNECT_INTERVAL) {
        lastMqttRetry = now;
        Serial.println("[MQTT] Disconnected from broker — attempting reconnect...");
        connectMQTT();
      }
    } else {
      // 3. Keep MQTT connection alive and process packets
      mqttClient.loop();
    }
  }

  // 4. Sensor sampling interval (every 2 seconds)
  if (now - lastRead < READ_INTERVAL) {
    return;
  }
  lastRead = now;

  // Read DHT22 temperature and humidity
  float temperature = dht.readTemperature();
  float humidity    = dht.readHumidity();

  // Read MQ-2 gas/smoke sensor (GPIO 34 ADC: 0–4095)
  int smoke = analogRead(MQ2_PIN);

  // Check DHT22 sensor health
  if (isnan(temperature) || isnan(humidity)) {
    currentStatus = "SENSOR_ERROR";
    setOutputs(currentStatus);
    printLCDLine(0, "SENSOR_ERROR");
    printLCDLine(1, "Check DHT22");

    Serial.println("[Sensor] Error: DHT22 read failed (NaN). Skipping publish.");

    if (mqttClient.connected()) {
      mqttClient.publish(TOPIC_STATUS, currentStatus.c_str());
    }
    return;
  }

  // Determine fire safety status based on sensor thresholds
  if (temperature >= TEMP_FIRE || smoke >= SMOKE_FIRE) {
    currentStatus = "FIRE";
  } else if (temperature >= TEMP_WARNING || smoke >= SMOKE_WARNING) {
    currentStatus = "WARNING";
  } else {
    currentStatus = "SAFE";
  }

  // Update physical outputs (LEDs and buzzer)
  setOutputs(currentStatus);

  // Update LCD display
  printLCDLine(0, "ST:" + currentStatus);
  String line2 = "T:";
  line2 += String(temperature, 1);
  line2 += "C S:";
  line2 += String(smoke);
  printLCDLine(1, line2);

  // Serial log
  Serial.print("[Sensor] T=");
  Serial.print(temperature, 1);
  Serial.print("°C | H=");
  Serial.print(humidity, 1);
  Serial.print("% | Smoke=");
  Serial.print(smoke);
  Serial.print(" | Status=");
  Serial.println(currentStatus);

  // Publish sensor telemetry to MQTT if connected
  publishData(temperature, humidity, smoke);
}
