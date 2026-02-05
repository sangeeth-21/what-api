# WhatsApp API Gateway (waaha)

A modern, glassmorphic WhatsApp message sender application built with Node.js and the Baileys library. Connect your device via QR code and send messages through a simple URL-based API.

## 🚀 Features

- **Modern Glass UI**: Beautiful responsive dashboard with Dark/Light mode.
- **QR Device Linking**: Easy connection via WhatsApp's standard "Link a Device" feature.
- **URL-based API**: Send messages programmatically via GET requests.
- **Secure Access**: Login protection and API Key authentication for external tools.
- **Real-time Status**: Live connection status and QR updates via Socket.io.
- **Postman Ready**: Easy integration with external tools and automated workflows.

## 🛠 Installation

### Prerequisites

- [Node.js](https://nodejs.org/) (v16.x or higher recommended)
- [npm](https://www.npmjs.com/) (usually comes with Node.js)

### Setup

1. **Clone the repository** (if you haven't already):
   ```bash
   git clone https://github.com/sangeeth-21/what-api.git
   cd waaha
   ```

2. **Install dependencies**:
   ```bash
   npm install
   ```

## 🏃 Running the App

1. **Start the server**:
   ```bash
   npm start
   ```

2. **Access the application**:
   Open your browser and navigate to:
   `http://localhost:3000`

3. **Login**:
   - **Username**: `ksangeeth76`
   - **Password**: `Specd@123`

4. **Link WhatsApp**:
   - Once logged in, you will see a QR code (if not connected).
   - Open WhatsApp on your phone.
   - Go to **Linked Devices** > **Link a Device**.
   - Scan the QR code shown in the browser.

## 📡 API Usage

### 1. Send Message (GET)
Use this endpoint to send a message to any WhatsApp number.

**Endpoint:**
`GET /send?number=PHONE&message=TEXT`

**Parameters:**
- `number`: The recipient's phone number with country code (e.g., `919876543210`).
- `message`: The text message to send.

### 2. Authentication for API
For external tools like Postman or curl, you must provide the API Key:

**Via Query String:**
`GET /send?number=PHONE&message=TEXT&apikey=wa_secret_123`

**Via Header:**
`x-api-key: wa_secret_123`

## ⚙️ Project Structure

- `index.js`: Main backend logic (Express, Socket.io, Baileys).
- `public/`: Frontend static files.
  - `index.html`: Main dashboard and documentation.
  - `login.html`: Secure login page.
- `auth_info_baileys/`: Stores WhatsApp session data (keep this private).
- `sessions/`: Stores browser session data.

## 🤝 Contributing

Feel free to fork this repository and submit pull requests for any features or bug fixes.

---
Built with ❤️ by [sangeeth-21](https://github.com/sangeeth-21)
