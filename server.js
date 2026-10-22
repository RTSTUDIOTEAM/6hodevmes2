const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = 610;

const dataDir = path.join(__dirname, 'data');
const messagesFilePath = path.join(dataDir, 'messages.json');
const uploadDir = path.join(__dirname, 'public', 'uploads');

if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });

const badWords = [
    'amk', 'aq', 'amq', 'oç', 'oc', 'piç', 'pic', 'sik', 'sikiş', 'yarak', 'yarrak', 
    'göt', 'ibne', 'orospu', 'kahpe', 'yarag', 'sikerim', 'sikem', 'amcık', 'amcik'
];

function containsProfanity(text) {
    if (!text) return false;
    const lowerText = text.toLowerCase();
    return badWords.some(word => {
        const regex = new RegExp(`\\b${word}\\b|${word}`, 'i');
        return regex.test(lowerText);
    });
}

function loadMessages() {
    try {
        if (fs.existsSync(messagesFilePath)) {
            const raw = fs.readFileSync(messagesFilePath, 'utf8');
            return JSON.parse(raw);
        }
    } catch (err) {}
    return [];
}

function saveMessages(messages) {
    try {
        fs.writeFileSync(messagesFilePath, JSON.stringify(messages, null, 2), 'utf8');
    } catch (err) {}
}

function cleanOldMessages() {
    let messages = loadMessages();
    const now = Date.now();
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;

    const filteredMessages = messages.filter(msg => {
        const isFresh = (now - msg.timestamp) <= ONE_DAY_MS;
        if (!isFresh && msg.mediaUrl) {
            const fileDiskPath = path.join(__dirname, 'public', msg.mediaUrl);
            if (fs.existsSync(fileDiskPath)) {
                try { fs.unlinkSync(fileDiskPath); } catch (e) {}
            }
        }
        return isFresh;
    });

    if (filteredMessages.length !== messages.length) {
        saveMessages(filteredMessages);
    }
    return filteredMessages;
}

setInterval(cleanOldMessages, 60 * 1000);

let lastNudgeTime = 0;
const NUDGE_COOLDOWN = 15000;
const userStickerCooldowns = {};

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 50 * 1024 * 1024 }
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

app.post('/api/send', upload.single('media'), (req, res) => {
    let { username, text, isSticker } = req.body;
    const userKey = username ? username.trim() : 'Öğrenci';

    if (isSticker === 'true') {
        const now = Date.now();
        const lastSticker = userStickerCooldowns[userKey] || 0;
        if (now - lastSticker < 3000) {
            return res.status(429).json({ success: false, message: 'Çıkartma göndermek için 3 saniye beklemelisin!' });
        }
        userStickerCooldowns[userKey] = now;
    }

    if (containsProfanity(text) || containsProfanity(userKey)) {
        text = '###';
    }

    let mediaUrl = null;
    let mediaType = null;

    if (req.file) {
        mediaUrl = `/uploads/${req.file.filename}`;
        if (req.file.mimetype.startsWith('video/')) {
            mediaType = 'video';
        } else if (req.file.mimetype.startsWith('image/')) {
            mediaType = 'image';
        }
    }

    const messageData = {
        id: Date.now(),
        timestamp: Date.now(),
        username: userKey !== '' ? userKey : 'Öğrenci',
        text: text ? text.trim() : '',
        isSticker: isSticker === 'true',
        mediaUrl,
        mediaType,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    const currentMessages = cleanOldMessages();
    currentMessages.push(messageData);
    saveMessages(currentMessages);

    io.emit('broadcastMessage', messageData);
    res.json({ success: true });
});

io.on('connection', (socket) => {
    const recentMessages = cleanOldMessages();
    socket.emit('initHistory', recentMessages);

    socket.on('requestNudge', (username) => {
        const now = Date.now();
        if (now - lastNudgeTime >= NUDGE_COOLDOWN) {
            lastNudgeTime = now;
            let senderName = username && username.trim() !== '' ? username.trim() : 'Biri';
            if (containsProfanity(senderName)) senderName = '###';

            const sysMsg = {
                id: Date.now(),
                timestamp: Date.now(),
                isSystem: true,
                text: `💥 ${senderName} herkese Titreşim gönderdi!`,
                time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            };

            const currentMessages = cleanOldMessages();
            currentMessages.push(sysMsg);
            saveMessages(currentMessages);

            io.emit('broadcastMessage', sysMsg);
            io.emit('triggerNudgeEffect', { duration: 15 });
        }
    });
});

server.listen(PORT, () => {
    console.log(`Okul Sınıfı Sunucusu ayakta (Port 610)`);
});
