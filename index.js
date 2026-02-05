import { makeWASocket, useMultiFileAuthState, DisconnectReason } from '@whiskeysockets/baileys';
import { Boom } from '@hapi/boom';
import pino from 'pino';
import express from 'express';
import { Server } from 'socket.io';
import { createServer } from 'http';
import QRCode from 'qrcode';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const isVercel = process.env.VERCEL === '1';
const storagePath = isVercel ? '/tmp' : __dirname;

const app = express();
const httpServer = createServer(app);
const io = new Server(httpServer, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const API_KEY = 'wa_secret_123';

// Middleware to check API Key for API endpoints
const checkApiKey = (req, res, next) => {
    const providedKey = req.query.apikey || req.headers['x-api-key'];
    if (providedKey === API_KEY) {
        return next();
    }
    res.status(401).json({ 
        success: false, 
        message: 'Unauthorized. Provide a valid apikey parameter or x-api-key header.' 
    });
};

// Routes
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// API endpoint for sending messages via URL
// Format: /send?number=919876543210&message=Hello
app.get('/send', checkApiKey, async (req, res) => {
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

app.post('/wa-logout', async (req, res) => {
    console.log('User requested WhatsApp logout...');
    try {
        if (sock) {
            await sock.logout().catch(e => console.log('Socket already closed or logout error:', e.message));
            sock.end();
        }
        
        connectionStatus = 'disconnected';
        qrCodeData = null;
        linkedNumber = null;

        // Clear session files
        const authPath = path.join(storagePath, 'auth_info_baileys');
        if (fs.existsSync(authPath)) {
            // Give it a moment to release file handles
            setTimeout(() => {
                try {
                    fs.rmSync(authPath, { recursive: true, force: true });
                    console.log('WhatsApp session cleared successfully.');
                    io.emit('status', 'disconnected');
                    io.emit('qr', null);
                    // Re-initiate connection to get a new QR
                    connectToWhatsApp();
                } catch (err) {
                    console.error('Error deleting session folder:', err);
                }
            }, 1000);
        }

        res.json({ success: true, message: 'Logged out successfully' });
    } catch (err) {
        console.error('Logout error:', err);
        res.status(500).json({ success: false, message: 'Logout failed' });
    }
});

app.post('/wa-reset', (req, res) => {
    console.log('Forced reset requested...');
    connectionStatus = 'disconnected';
    qrCodeData = null;
    linkedNumber = null;
    
    if (sock) {
        sock.logout().catch(() => {});
        sock.end();
    }
    
    const sessionPath = path.join(storagePath, 'auth_info_baileys');
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

app.get('/wa-status', (req, res) => {
    res.json({
        status: connectionStatus,
        qr: qrCodeData,
        linkedNumber: linkedNumber
    });
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

    const authPath = path.join(storagePath, 'auth_info_baileys');
    
    // Check if session exists but is invalid/corrupted
    if (fs.existsSync(authPath)) {
        try {
            const credsFile = path.join(authPath, 'creds.json');
            if (fs.existsSync(credsFile)) {
                const creds = JSON.parse(fs.readFileSync(credsFile, 'utf-8'));
                if (!creds || !creds.noiseKey) {
                    console.log('Corrupted session found. Clearing...');
                    fs.rmSync(authPath, { recursive: true, force: true });
                }
            }
        } catch (e) {
            console.error('Error checking session validity:', e);
            fs.rmSync(authPath, { recursive: true, force: true });
        }
    }

    const { state, saveCreds } = await useMultiFileAuthState(authPath);

    sock = makeWASocket({
        logger: pino({ level: 'silent' }),
        auth: state,
        printQRInTerminal: false,
        mobile: false,
        keepAliveIntervalMs: 30000,
        defaultQueryTimeoutMs: 60000,
        connectTimeoutMs: 60000,
        retryRequestDelayMs: 5000,
        generateHighQualityQR: true,
        patchMessageBeforeSending: (message) => {
            const requiresPatch = !!(
                message.buttonsMessage ||
                message.templateMessage ||
                message.listMessage
            );
            if (requiresPatch) {
                message = {
                    viewOnceMessage: {
                        message: {
                            messageContextInfo: {
                                deviceListMetadata: {},
                                deviceListMetadataVersion: 2
                            },
                            ...message
                        }
                    }
                };
            }
            return message;
        }
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
                const delay = 3000;
                console.log(`Reconnecting to WhatsApp in ${delay/1000}s...`);
                setTimeout(connectToWhatsApp, delay);
            } else {
                console.log('Logged out from WhatsApp. Session cleared.');
                const sessionPath = path.join(storagePath, 'auth_info_baileys');
                if (fs.existsSync(sessionPath)) {
                    fs.rmSync(sessionPath, { recursive: true, force: true });
                }
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
    console.log('User connected to web UI');
    
    socket.on('heartbeat', (data) => {
        // Keep-alive from frontend
    });

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
                const sessionPath = path.join(storagePath, 'auth_info_baileys');
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
