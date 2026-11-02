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
let onlineCount = 0;

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});

const upload = multer({ 
    storage: storage,
    limits: { fileSize: 20 * 1024 * 1024 }
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
    let originalName = null;

    if (req.file) {
        mediaUrl = `/uploads/${req.file.filename}`;
        originalName = req.file.originalname;
        const mime = req.file.mimetype || '';
        const ext = path.extname(req.file.originalname).toLowerCase();
        const size = req.file.size || 0;

        if (mime.startsWith('video/')) {
            mediaType = 'video';
            if (size > 10 * 1024 * 1024) {
                try { fs.unlinkSync(req.file.path); } catch (e) {}
                return res.status(400).json({ success: false, message: 'Video en fazla 10 MB olabilir!' });
            }
        } else if (mime.startsWith('image/')) {
            mediaType = 'image';
        } else if (mime.startsWith('audio/') || ['.mp3', '.ogg', '.wav', '.wma', '.m4a', '.aac', '.flac', '.opus', '.webm'].includes(ext)) {
            mediaType = 'audio';
            if (size > 7 * 1024 * 1024) {
                try { fs.unlinkSync(req.file.path); } catch (e) {}
                return res.status(400).json({ success: false, message: 'Ses dosyası en fazla 7 MB olabilir!' });
            }
        } else if (mime === 'application/pdf' || ext === '.pdf') {
            mediaType = 'pdf';
            if (size > 15 * 1024 * 1024) {
                try { fs.unlinkSync(req.file.path); } catch (e) {}
                return res.status(400).json({ success: false, message: 'PDF en fazla 15 MB olabilir!' });
            }
        } else {
            mediaType = 'file';
            if (size > 20 * 1024 * 1024) {
                try { fs.unlinkSync(req.file.path); } catch (e) {}
                return res.status(400).json({ success: false, message: 'Dosya en fazla 20 MB olabilir!' });
            }
        }
    }

    const messageData = {
        id: Date.now() + Math.floor(Math.random() * 1000),
        timestamp: Date.now(),
        username: userKey !== '' ? userKey : 'Öğrenci',
        text: text ? text.trim() : '',
        isSticker: isSticker === 'true',
        mediaUrl,
        mediaType,
        originalName,
        edited: false,
        time: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };

    const currentMessages = cleanOldMessages();
    currentMessages.push(messageData);
    saveMessages(currentMessages);

    io.emit('broadcastMessage', messageData);
    res.json({ success: true, id: messageData.id });
});

// Mesaj silme
app.post('/api/delete', (req, res) => {
    const { id, username } = req.body;
    if (!id || !username) return res.status(400).json({ success: false, message: 'Eksik bilgi' });

    let messages = loadMessages();
    const idx = messages.findIndex(m => m.id == id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'Mesaj bulunamadı' });

    const msg = messages[idx];
    if (msg.username !== username.trim()) {
        return res.status(403).json({ success: false, message: 'Sadece kendi mesajını silebilirsin' });
    }

    // Medya dosyasını da sil
    if (msg.mediaUrl) {
        const fileDiskPath = path.join(__dirname, 'public', msg.mediaUrl);
        if (fs.existsSync(fileDiskPath)) {
            try { fs.unlinkSync(fileDiskPath); } catch (e) {}
        }
    }

    messages.splice(idx, 1);
    saveMessages(messages);
    io.emit('messageDeleted', { id: msg.id });
    res.json({ success: true });
});

// Mesaj düzenleme
app.post('/api/edit', (req, res) => {
    let { id, username, text } = req.body;
    if (!id || !username || text === undefined) {
        return res.status(400).json({ success: false, message: 'Eksik bilgi' });
    }

    text = (text || '').trim();
    if (containsProfanity(text)) text = '###';

    let messages = loadMessages();
    const idx = messages.findIndex(m => m.id == id);
    if (idx === -1) return res.status(404).json({ success: false, message: 'Mesaj bulunamadı' });

    const msg = messages[idx];
    if (msg.username !== username.trim()) {
        return res.status(403).json({ success: false, message: 'Sadece kendi mesajını düzenleyebilirsin' });
    }
    if (msg.isSticker || msg.isSystem) {
        return res.status(400).json({ success: false, message: 'Bu mesaj düzenlenemez' });
    }

    msg.text = text;
    msg.edited = true;
    messages[idx] = msg;
    saveMessages(messages);

    io.emit('messageEdited', { id: msg.id, text: msg.text, edited: true });
    res.json({ success: true });
});

io.on('connection', (socket) => {
    onlineCount++;
    io.emit('onlineCount', onlineCount);

    const recentMessages = cleanOldMessages();
    socket.emit('initHistory', recentMessages);

    socket.on('requestNudge', (username) => {
        const now = Date.now();
        if (now - lastNudgeTime >= NUDGE_COOLDOWN) {
            lastNudgeTime = now;
            let senderName = username && username.trim() !== '' ? username.trim() : 'Biri';
            if (containsProfanity(senderName)) senderName = '###';

            const sysMsg = {
                id: Date.now() + Math.floor(Math.random() * 1000),
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

    socket.on('typing', (username) => {
        const name = username && username.trim() ? username.trim() : null;
        if (name && !containsProfanity(name)) {
            socket.broadcast.emit('userTyping', name);
        }
    });

    socket.on('stopTyping', () => {
        socket.broadcast.emit('userStopTyping');
    });

    socket.on('disconnect', () => {
        onlineCount = Math.max(0, onlineCount - 1);
        io.emit('onlineCount', onlineCount);
    });
});

server.listen(PORT, () => {
    console.log(`Okul Sınıfı Sunucusu ayakta (Port 610)`);
});
