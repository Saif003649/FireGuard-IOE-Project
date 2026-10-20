# FireGuard — Smart Fire Detection and Monitoring System

FireGuard is an IoT-based academic project designed to demonstrate fire-risk monitoring through simulated sensors, an ESP32 microcontroller, MQTT communication, and a real-time web dashboard.

## Project Overview

The system monitors simulated temperature, humidity, and smoke/gas readings. It evaluates sensor values against configurable thresholds and displays the current status through the simulated hardware and dashboard.

## Features

- ESP32-based fire monitoring simulation using Wokwi
- Temperature and humidity monitoring using DHT22
- Smoke/gas sensor monitoring using MQ-2
- Red and green LED indicators and a buzzer alarm
- LCD status display
- MQTT messaging for sensor data
- Node.js and Express backend
- React and Vite web dashboard
- Live sensor updates using Socket.IO
- Historical sensor graphs and analysis, when implemented

## Technology Stack

- **Simulation:** Wokwi
- **Microcontroller:** ESP32
- **Sensors:** DHT22 and MQ-2
- **Communication:** Wi-Fi and MQTT
- **Backend:** Node.js, Express.js
- **Frontend:** React, Vite, CSS
- **Real-time updates:** Socket.IO
- **Charts:** Recharts, if configured

## Project Structure

```text
Fireguard/
├── wokwi/
│   ├── sketch.ino
│   ├── diagram.json
│   └── libraries.txt
├── backend/
│   ├── server.js
│   └── package.json
├── frontend/
│   ├── src/
│   └── package.json
├── .gitignore
└── README.md
```

The actual folder structure may vary slightly.

## Setup

### 1. Wokwi simulation

Open the Wokwi project and start the ESP32 simulation. Configure the required Arduino libraries and verify the simulated sensor readings.

### 2. Backend

Open a terminal in the backend directory:

```bash
npm install
node server.js
```

### 3. Frontend

Open a separate terminal in the frontend directory:

```bash
npm install
npm run dev
```

Open the local URL printed by Vite in your browser.

### 4. MQTT configuration

Ensure the ESP32 sketch and backend use the same MQTT broker, port, and topic names. The public broker requires an internet connection and may not always be available.

## Project Status

This project is under development. Wi-Fi gateway connectivity, MQTT communication, sensor behavior, and graph analytics must be verified in the target environment before the system can be considered fully operational.

## Limitations and Safety

This is an academic simulation and is not a certified fire alarm or life-safety system. Sensor thresholds are for demonstration only. The MQ-2 simulated readings are not calibrated measurements of real-world smoke concentration.

## Future Scope

- Persistent storage of sensor readings
- Improved historical analytics and event logs
- Additional sensor support
- Authentication and device management
- Deployment of the dashboard and backend
- Notifications for simulated fire events

## Author

Developed as an Internet of Engineering (IOE) academic project.

## License

Add an appropriate open-source license if you intend to permit others to reuse or modify this project.
