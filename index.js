import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import express from 'express';
import session from 'express-session';
import sessionFileStore from 'session-file-store';
import { Server } from 'socket.io';
import { createServer } from 'http';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const FileStore = sessionFileStore(session);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer);

// Session configuration with persistent file store
const sessionMiddleware = session({
    store: new FileStore({ path: './sessions', ttl: 86400 * 7 }), // 7 days
    secret: 'whatsapp-secret-key',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false, 
        maxAge: 7 * 24 * 60 * 60 * 1000, // 7 days
        httpOnly: true 
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(sessionMiddleware);

// Shared session with socket.io
io.engine.use(sessionMiddleware);

const AUTH_CREDENTIALS = {
    email: 'ksangeeth76',
    password: 'Specd@123'
};

const API_KEY = 'wa_secret_123';

// Middleware to check authentication
const isAuthenticated = (req, res, next) => {
    // Check for session first
    if (req.session.loggedIn) {
        return next();
    }
    
    // Check for API key in query or headers
    const providedKey = req.query.apikey || req.headers['x-api-key'];
    if (providedKey === API_KEY) {
        return next();
    }

    // For /send endpoint, return JSON error instead of redirecting
    if (req.path === '/send' || req.path === '/wa-status') {
        return res.status(401).json({ 
            success: false, 
            message: 'Unauthorized. Provide a valid session or apikey parameter.' 
        });
    }

    res.redirect('/login');
};

// Routes
app.get('/login', (req, res) => {
    if (req.session.loggedIn) {
        return res.redirect('/');
    }
    res.sendFile(path.join(__dirname, 'public', 'login.html'));
});

app.post('/login', (req, res) => {
    const { email, password } = req.body;
    if (email === AUTH_CREDENTIALS.email && password === AUTH_CREDENTIALS.password) {
        req.session.loggedIn = true;
        res.json({ success: true });
    } else {
        res.status(401).json({ success: false, message: 'Invalid credentials' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) {
            console.error('Error destroying session:', err);
        }
        res.clearCookie('connect.sid'); // Ensure the session cookie is cleared
        res.redirect('/login');
    });
});

// API endpoint for sending messages via URL
// Format: /send?number=919876543210&message=Hello
app.get('/send', isAuthenticated, async (req, res) => {
    const { number, message } = req.query;

    if (!number || !message) {
        return res.status(400).json({ 
            success: false, 
            message: 'Missing number or message query parameters. Format: /send?number=xxx&message=yyy' 
        });
    }

    if (!sock || connectionStatus !== 'connected') {
        return res.status(503).json({ 
            success: false, 
            message: 'WhatsApp not connected. Please scan the QR code first.' 
        });
    }

    try {
        let cleanNumber = number.replace(/\D/g, '');
        if (!cleanNumber) {
            return res.status(400).json({ success: false, message: 'Invalid phone number' });
        }

        const jid = `${cleanNumber}@s.whatsapp.net`;
        await sock.sendMessage(jid, { text: message });
        
        res.json({ 
            success: true, 
            message: `Message sent to ${cleanNumber}`,
            details: { number: cleanNumber, text: message }
        });
    } catch (err) {
        res.status(500).json({ success: false, message: `Failed to send: ${err.message}` });
    }
});

app.post('/wa-reset', isAuthenticated, (req, res) => {
    console.log('Forced reset requested...');
    connectionStatus = 'disconnected';
    qrCodeData = null;
    linkedNumber = null;
    
    if (sock) {
        sock.logout().catch(() => {});
        sock.end();
    }
    
    const sessionPath = path.join(__dirname, 'auth_info_baileys');
    if (fs.existsSync(sessionPath)) {
        fs.rmSync(sessionPath, { recursive: true, force: true });
        console.log('Session directory cleared.');
    }
    
    io.emit('status', 'disconnected');
    io.emit('qr', null);
    
    setTimeout(() => {
        connectToWhatsApp();
        res.json({ success: true, message: 'WhatsApp connection reset. Generating new QR...' });
    }, 1000);
});

app.get('/wa-status', isAuthenticated, (req, res) => {
    res.json({
        status: connectionStatus,
        qr: qrCodeData,
        linkedNumber: linkedNumber
    });
});

// Protect static files except login
app.get('/', isAuthenticated, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use(express.static('public'));

let sock;
let qrCodeData = null;
let connectionStatus = 'disconnected';
let linkedNumber = null;

async function connectToWhatsApp() {
    console.log('Connecting to WhatsApp...');
    connectionStatus = 'connecting';
    io.emit('status', 'connecting');

    const { state, saveCreds } = await useMultiFileAuthState('auth_info_baileys');

    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
    });

    sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;
        
        if (qr) {
            console.log('--- NEW QR CODE GENERATED ---');
            try {
                qrCodeData = await QRCode.toDataURL(qr);
                connectionStatus = 'scan_qr';
                console.log('QR Code converted to DataURL. Emitting to all clients...');
                io.emit('qr', qrCodeData);
                io.emit('status', 'scan_qr');
            } catch (err) {
                console.error('Error generating QR DataURL:', err);
            }
        }

        if (connection === 'close') {
            const statusCode = (lastDisconnect?.error instanceof Boom)?.output?.statusCode;
            console.log(`Connection closed. Status Code: ${statusCode}`);
            
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            connectionStatus = 'disconnected';
            linkedNumber = null;
            qrCodeData = null;
            io.emit('status', 'disconnected');
            io.emit('qr', null);
            
            if (shouldReconnect) {
                console.log('Reconnecting to WhatsApp...');
                connectToWhatsApp();
            } else {
                console.log('Logged out from WhatsApp. Session cleared.');
                // Clear session files if logged out
                const sessionPath = path.join(__dirname, 'auth_info_baileys');
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                }
                // Restart to show new QR
                setTimeout(connectToWhatsApp, 2000);
            }
        } else if (connection === 'connecting') {
            console.log('Connecting to WhatsApp...');
            connectionStatus = 'connecting';
            io.emit('status', 'connecting');
        } else if (connection === 'open') {
            console.log('✅ WhatsApp Connection Open!');
            connectionStatus = 'connected';
            qrCodeData = null;
            const userJid = sock.user.id;
            linkedNumber = userJid.split(':')[0] || userJid.split('@')[0];
            io.emit('status', 'connected');
            io.emit('linked_number', linkedNumber);
            io.emit('qr', null);
        }
    });

    sock.ev.on('creds.update', saveCreds);
}

io.on('connection', (socket) => {
    const session = socket.request.session;
    
    if (!session || !session.loggedIn) {
        socket.disconnect();
        return;
    }

    console.log('Authenticated user connected to web UI');
    
    socket.emit('status', connectionStatus === 'connected' ? 'connected' : (qrCodeData ? 'scan_qr' : 'connecting'));
    if (qrCodeData) {
        console.log('Emitting existing QR code to new socket connection');
        socket.emit('qr', qrCodeData);
    }
    if (linkedNumber) {
        socket.emit('linked_number', linkedNumber);
    }

    socket.on('send_message', async (data) => {
        const { number, message } = data;
        if (!sock || connectionStatus !== 'connected') {
            socket.emit('error', 'WhatsApp not connected');
            return;
        }

        try {
            let cleanNumber = number.replace(/\D/g, '');
            if (!cleanNumber) {
                socket.emit('error', 'Invalid phone number');
                return;
            }
            const jid = `${cleanNumber}@s.whatsapp.net`;
            await sock.sendMessage(jid, { text: message });
            socket.emit('success', `Message sent to ${number}`);
        } catch (err) {
            socket.emit('error', `Failed to send: ${err.message}`);
        }
    });

    socket.on('wa_logout', async () => {
        if (sock) {
            try {
                console.log('Initiating WhatsApp logout...');
                
                // 1. Try standard logout
                try {
                    await sock.logout();
                } catch (e) {
                    console.log('Standard logout notice: already logged out or failed');
                }
                
                // 2. Force close connection
                sock.ev.removeAllListeners('connection.update');
                sock.ev.removeAllListeners('creds.update');
                sock.end();
                sock = null;
                
                // 3. Reset local state
                connectionStatus = 'disconnected';
                linkedNumber = null;
                qrCodeData = null;
                io.emit('status', 'disconnected');
                io.emit('linked_number', null);
                io.emit('qr', null);
                
                // 4. Wipe session files
                const sessionPath = path.join(__dirname, 'auth_info_baileys');
                if (fs.existsSync(sessionPath)) {
                    // Try multiple times to delete if busy
                    for (let i = 0; i < 3; i++) {
                        try {
                            fs.rmSync(sessionPath, { recursive: true, force: true });
                            console.log('Session directory cleared successfully');
                            break;
                        } catch (e) {
                            console.log(`Retry ${i+1} clearing session...`);
                            await new Promise(r => setTimeout(r, 500));
                        }
                    }
                }

            } catch (err) {
                console.error('Critical error during WA logout:', err);
                socket.emit('error', 'Failed to fully disconnect WhatsApp');
            } finally {
                // 5. Restart connection after a short delay regardless of success/fail
                // This ensures the system doesn't stay in a broken state
                setTimeout(() => {
                    console.log('Restarting WhatsApp connection...');
                    connectToWhatsApp();
                }, 1500);
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
httpServer.listen(PORT, () => {
    console.log(`🚀 Server running on http://localhost:${PORT}`);
    connectToWhatsApp();
});
