// language: JavaScript (ES Module), file: index.js, runtime: Node.js + FFmpeg
import makeWASocket, {
    useMultiFileAuthState,
    DisconnectReason,
    downloadMediaMessage,
    fetchLatestBaileysVersion,
    prepareWAMessageMedia,
    generateWAMessageFromContent,
    proto,
    Browsers
} from '@whiskeysockets/baileys';
import pino from 'pino';
import ffmpeg from 'fluent-ffmpeg';
import fs from 'fs';
import path from 'path';
import http from 'http';
import readline from 'readline';
import { execFile, spawn } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');
const SCHEDULES_PATH = path.join(__dirname, 'schedules.json');
const CHATS_HISTORY_PATH = path.join(__dirname, 'chats_history.json');
const PANEL_HTML_PATH = path.join(__dirname, 'panel.html');
const SESSION_PATH = path.join(__dirname, 'auth_session');
let activePanelPort = 8080;

const sseClients = new Set();
function broadcastSSE(payload) {
    const msg = `data: ${JSON.stringify(payload)}\n\n`;
    for (const res of sseClients) {
        try {
            res.write(msg);
        } catch (e) {
            sseClients.delete(res);
        }
    }
}

// === PATCH PROTOBUF STATIC ENCODER ===
try {
    const StickerMsg = proto.Message.StickerMessage;
    const AudioMsg = proto.Message.AudioMessage;

    if (StickerMsg && AudioMsg && !StickerMsg._audioPatched) {
        const origFromObject = StickerMsg.fromObject.bind(StickerMsg);
        const origEncode = StickerMsg.encode.bind(StickerMsg);

        StickerMsg.fromObject = function (obj) {
            const msg = origFromObject(obj);
            if (obj && obj.audioMessage) {
                msg.audioMessage = AudioMsg.fromObject(obj.audioMessage);
            }
            return msg;
        };

        StickerMsg.encode = function (message, writer) {
            const w = origEncode(message, writer);
            if (message && message.audioMessage) {
                const audioBytes = AudioMsg.encode(message.audioMessage).finish();
                w.uint32((26 << 3) | 2).bytes(audioBytes);
            }
            return w;
        };

        StickerMsg._audioPatched = true;
        console.log('[INFO] Binary Encoder StickerMessage.audioMessage (Field 26) berhasil di-patch!');
    }
} catch (e) {
    console.log('[WARN] Gagal patch Protobuf:', e.message);
}

// === MANAJEMEN CONFIG.JSON (ADMIN, ALLOWED USERS, MODE) ===
function loadConfig() {
    const defaultConfig = {
        adminOnly: true,
        owners: [],
        allowedUsers: []
    };
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
            return defaultConfig;
        }
        const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return {
            adminOnly: typeof parsed.adminOnly === 'boolean' ? parsed.adminOnly : true,
            owners: Array.isArray(parsed.owners) ? parsed.owners : [],
            allowedUsers: Array.isArray(parsed.allowedUsers) ? parsed.allowedUsers : []
        };
    } catch (err) {
        return defaultConfig;
    }
}

function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
    broadcastSSE({ type: 'user' });
}

let botConfig = loadConfig();

// === MANAJEMEN RIWAYAT PERCAKAPAN (chats_history.json) ===
function loadChatsHistory() {
    try {
        if (!fs.existsSync(CHATS_HISTORY_PATH)) {
            fs.writeFileSync(CHATS_HISTORY_PATH, JSON.stringify([], null, 2));
            return [];
        }
        const parsed = JSON.parse(fs.readFileSync(CHATS_HISTORY_PATH, 'utf8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        return [];
    }
}

function saveChatsHistory(list) {
    fs.writeFileSync(CHATS_HISTORY_PATH, JSON.stringify(list, null, 2));
}

let chatLogs = loadChatsHistory();

function recordChat(number, pushName, contextLabel, incomingText, botReplyText) {
    if (!number) return null;
    const entry = {
        id: Date.now() + Math.random(),
        number,
        name: pushName || 'Pengguna WA',
        context: contextLabel,
        time: formatWib(),
        incoming: incomingText || '[Media]',
        reply: botReplyText
    };
    chatLogs.push(entry);
    if (chatLogs.length > 500) {
        chatLogs = chatLogs.slice(-500);
    }
    saveChatsHistory(chatLogs);
    broadcastSSE({ type: 'chat' });
    return entry;
}

function updateChatReply(entry, newReply) {
    if (!entry) return;
    entry.reply = newReply;
    saveChatsHistory(chatLogs);
    broadcastSSE({ type: 'chat' });
}

// === MANAJEMEN SCHEDULES.JSON ===
function loadSchedules() {
    try {
        if (!fs.existsSync(SCHEDULES_PATH)) {
            fs.writeFileSync(SCHEDULES_PATH, JSON.stringify([], null, 2));
            return [];
        }
        const data = JSON.parse(fs.readFileSync(SCHEDULES_PATH, 'utf8'));
        return Array.isArray(data) ? data : [];
    } catch (err) {
        return [];
    }
}

function saveSchedules(list) {
    fs.writeFileSync(SCHEDULES_PATH, JSON.stringify(list, null, 2));
}

let schedules = loadSchedules();
let activeSock = null;
let isSchedulerTickRunning = false;

function normalizePhoneNumber(rawInput) {
    let digits = String(rawInput || '').replace(/[^0-9]/g, '');
    if (!digits) return '';
    if (digits.startsWith('0')) digits = '62' + digits.slice(1);
    return digits;
}

function parseJadwalInput(rawText) {
    const hasFormLabels = /(nomor|nama|waktu|tanggal|waktu\/tanggal|jam|pesan)\s*:/i.test(rawText);

    if (hasFormLabels) {
        const lines = rawText.split(/\r?\n/);
        const data = { nomor: '', waktu: '', jumlah: '1', pesan: '' };
        let currentField = null;
        const messageLines = [];

        for (const line of lines) {
            const trimmed = line.trim();
            if (/^_?keterangan\s*:/i.test(trimmed) || /^•/.test(trimmed)) {
                currentField = null;
                continue;
            }
            if (/^(nomor|nama)\s*:/i.test(trimmed)) {
                currentField = 'nomor';
                data.nomor = trimmed.replace(/^(nomor|nama)\s*:/i, '').trim();
            } else if (/^(waktu|tanggal|waktu\/tanggal|jam)\s*:/i.test(trimmed)) {
                currentField = 'waktu';
                data.waktu = trimmed.replace(/^(waktu|tanggal|waktu\/tanggal|jam)\s*:/i, '').trim();
            } else if (/^jumlah\s*:/i.test(trimmed)) {
                currentField = 'jumlah';
                data.jumlah = trimmed.replace(/^jumlah\s*:/i, '').trim() || '1';
            } else if (/^pesan\s*:/i.test(trimmed)) {
                currentField = 'pesan';
                const firstMsgLine = line.replace(/^\s*pesan\s*:\s*/i, '');
                if (firstMsgLine.trim() !== '') messageLines.push(firstMsgLine);
            } else if (currentField === 'pesan') {
                messageLines.push(line);
            }
        }
        data.pesan = messageLines.join('\n').trim();
        return data;
    }

    const separator = rawText.includes('|') ? '|' : ',';
    const segs = rawText.split(separator).map((s) => s.trim());

    if (segs.length >= 4) {
        return {
            nomor: segs[0] || '',
            waktu: segs[1] || '',
            jumlah: segs[2] || '1',
            pesan: segs.slice(3).join(separator === ',' ? ', ' : ' | ').trim()
        };
    }

    if (segs.length === 3) {
        return { nomor: segs[0] || '', waktu: segs[1] || '', jumlah: '1', pesan: segs[2] || '' };
    }

    return { nomor: '', waktu: '', jumlah: '1', pesan: '' };
}

function getWibParts(timestamp = Date.now()) {
    const dtf = new Intl.DateTimeFormat('en-GB', {
        timeZone: 'Asia/Jakarta',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    });
    const parts = dtf.formatToParts(new Date(timestamp));
    const map = {};
    for (const p of parts) {
        if (p.type !== 'literal') map[p.type] = p.value;
    }
    return map;
}

function formatWib(timestamp = Date.now()) {
    const p = getWibParts(timestamp);
    return `${p.day}-${p.month}-${p.year} ${p.hour}:${p.minute}:${p.second} WIB`;
}

function formatCountdown(ms) {
    if (ms <= 0) return 'Segera diproses...';
    const totalSec = Math.floor(ms / 1000);
    const days = Math.floor(totalSec / 86400);
    const hours = Math.floor((totalSec % 86400) / 3600);
    const mins = Math.floor((totalSec % 3600) / 60);
    const secs = totalSec % 60;
    const chunks = [];
    if (days > 0) chunks.push(`${days} hari`);
    if (hours > 0) chunks.push(`${hours} jam`);
    if (mins > 0) chunks.push(`${mins} menit`);
    if (secs > 0 || chunks.length === 0) chunks.push(`${secs} detik`);
    return chunks.join(' ');
}

function parseScheduleTime(input) {
    const clean = input.trim().toLowerCase();
    const now = Date.now();

    const relMatch = clean.match(/^\+(\d+)([smh])$/);
    if (relMatch) {
        const val = Number(relMatch[1]);
        const unit = relMatch[2];
        if (val <= 0) return null;
        const mult = unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000;
        return now + val * mult;
    }

    const timeOnlyMatch = clean.match(/^(\d{1,2}):(\d{2})$/);
    if (timeOnlyMatch) {
        const hh = Number(timeOnlyMatch[1]);
        const mm = Number(timeOnlyMatch[2]);
        if (hh > 23 || mm > 59) return null;

        const p = getWibParts(now);
        const isoStr = `${p.year}-${p.month}-${p.day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+07:00`;
        let targetTs = Date.parse(isoStr);
        if (targetTs <= now) targetTs += 24 * 60 * 60 * 1000;
        return targetTs;
    }

    const fullMatch = clean.match(/^(\d{1,2})-(\d{1,2})-(\d{4})\s+(\d{1,2}):(\d{2})$/);
    if (fullMatch) {
        const dd = String(fullMatch[1]).padStart(2, '0');
        const mo = String(fullMatch[2]).padStart(2, '0');
        const yyyy = fullMatch[3];
        const hh = String(fullMatch[4]).padStart(2, '0');
        const mm = String(fullMatch[5]).padStart(2, '0');
        if (Number(hh) > 23 || Number(mm) > 59 || Number(mo) > 12 || Number(dd) > 31) return null;

        const isoStr = `${yyyy}-${mo}-${dd}T${hh}:${mm}:00+07:00`;
        const targetTs = Date.parse(isoStr);
        if (Number.isNaN(targetTs) || targetTs <= now) return null;
        return targetTs;
    }

    return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

setInterval(async () => {
    if (!activeSock || isSchedulerTickRunning) return;
    const now = Date.now();
    const dueJobs = schedules.filter((j) => j.status === 'ACTIVE' && j.nextRunAt <= now);
    if (dueJobs.length === 0) return;

    isSchedulerTickRunning = true;
    try {
        for (const job of dueJobs) {
            if (job.status !== 'ACTIVE') continue;
            try {
                await activeSock.sendPresenceUpdate('composing', job.targetJid);
                await sleep(1200);
                await activeSock.sendMessage(job.targetJid, { text: job.message });
                await activeSock.sendPresenceUpdate('paused', job.targetJid);

                job.sentCount += 1;
                const sentTime = formatWib(Date.now());
                job.logs.push(`${sentTime} - Terkirim (${job.sentCount}/${job.totalCount})`);

                if (job.sentCount >= job.totalCount) {
                    job.status = 'COMPLETED';
                    job.completedAt = sentTime;
                    saveSchedules(schedules);
                    if (job.notifyJid) {
                        await activeSock.sendMessage(job.notifyJid, {
                            text: `✅ *Jadwal #${job.id} Selesai*\nNomor: ${job.targetLabel}\nTerkirim: *${job.sentCount}/${job.totalCount} pesan*\nSelesai pada: ${sentTime}`
                        });
                    }
                } else {
                    job.nextRunAt = Date.now() + job.intervalSec * 1000;
                    saveSchedules(schedules);
                }
            } catch (err) {
                job.status = 'FAILED';
                job.logs.push(`${formatWib(Date.now())} - Gagal: ${err.message}`);
                saveSchedules(schedules);
                if (job.notifyJid) {
                    await activeSock.sendMessage(job.notifyJid, {
                        text: `❌ *Jadwal #${job.id} Gagal*\nNomor: ${job.targetLabel}\nAlasan: ${err.message}`
                    });
                }
            }
        }
    } finally {
        isSchedulerTickRunning = false;
    }
}, 1000);

// === WEB SERVER PANEL LOKAL DENGAN AUTO-PORT ===
const panelServer = http.createServer((req, res) => {
    const url = req.url.split('?')[0];

    if (req.method === 'GET' && url === '/') {
        if (fs.existsSync(PANEL_HTML_PATH)) {
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(fs.readFileSync(PANEL_HTML_PATH, 'utf8'));
        } else {
            res.writeHead(404, { 'Content-Type': 'text/plain' });
            res.end('File panel.html tidak ditemukan.');
        }
        return;
    }

    if (req.method === 'GET' && url === '/api/stream') {
        res.writeHead(200, {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive'
        });
        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));
        return;
    }

    if (req.method === 'GET' && url === '/api/state') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(
            JSON.stringify({
                connected: Boolean(activeSock),
                adminOnly: botConfig.adminOnly,
                wibTime: formatWib(),
                activeSchedules: schedules.filter((j) => j.status === 'ACTIVE').length,
                owners: botConfig.owners.map((n) => normalizePhoneNumber(n)),
                allowedUsers: botConfig.allowedUsers.map((n) => normalizePhoneNumber(n)),
                chats: chatLogs
            })
        );
        return;
    }

    if (req.method === 'GET' && url === '/api/code') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8') }));
        return;
    }

    if (req.method === 'POST') {
        let body = '';
        req.on('data', (chunk) => (body += chunk));
        req.on('end', () => {
            try {
                const payload = body ? JSON.parse(body) : {};

                if (url === '/api/toggle-mode') {
                    botConfig.adminOnly = !botConfig.adminOnly;
                    saveConfig(botConfig);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true, adminOnly: botConfig.adminOnly }));
                    return;
                }

                if (url === '/api/clear-chats') {
                    chatLogs = [];
                    saveChatsHistory(chatLogs);
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                    return;
                }

                if (url === '/api/code' && payload.code) {
                    fs.writeFileSync(path.join(__dirname, 'index.js'), payload.code, 'utf8');
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                    return;
                }

                if (url === '/api/restart') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                    panelServer.close();
                    setTimeout(() => {
                        spawn(process.argv[0], process.argv.slice(1), {
                            cwd: __dirname,
                            detached: true,
                            stdio: 'inherit'
                        }).unref();
                        process.exit(0);
                    }, 500);
                    return;
                }

                if (url === '/api/stop') {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ ok: true }));
                    setTimeout(() => process.exit(0), 400);
                    return;
                }
            } catch (err) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: err.message }));
                return;
            }
            res.writeHead(404);
            res.end();
        });
        return;
    }

    res.writeHead(404);
    res.end();
});

function startPanelServer(port) {
    activePanelPort = port;
    panelServer.listen(port, '0.0.0.0');
}

panelServer.on('listening', () => {
    console.log(`[PANEL] Web Monitor aktif di: http://localhost:${activePanelPort}`);
});

panelServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
        startPanelServer(activePanelPort + 1);
    }
});

startPanelServer(8080);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

function getMediaInfo(inputPath) {
    return new Promise((resolve) => {
        ffmpeg.ffprobe(inputPath, (err, metadata) => {
            const rawDur = metadata?.format?.duration || 10;
            const duration = Math.min(30, Math.max(1, Math.ceil(rawDur)));

            const videoStream = metadata?.streams?.find((s) => s.width && s.height);
            const rotation = Math.abs(Number(videoStream?.tags?.rotate || 0));
            const origW = rotation === 90 || rotation === 270 ? (videoStream?.height || 0) : (videoStream?.width || 0);
            const origH = rotation === 90 || rotation === 270 ? (videoStream?.width || 0) : (videoStream?.height || 0);

            const seekPoint = Math.max(0, (rawDur * 0.5) - 0.5).toFixed(2);

            execFile(
                'ffmpeg',
                ['-ss', seekPoint, '-i', inputPath, '-t', '1.5', '-vf', 'cropdetect=24:2:0', '-f', 'null', '-'],
                (cErr, stdout, stderr) => {
                    const matches = [...(stderr || '').matchAll(/crop=(\d+):(\d+):(\d+):(\d+)/g)];
                    let autoCrop = null;
                    if (matches.length > 0 && origW > 0 && origH > 0) {
                        const last = matches[matches.length - 1];
                        const cw = Number(last[1]);
                        const ch = Number(last[2]);
                        const cx = Number(last[3]);
                        const cy = Number(last[4]);

                        const isValidArea = cw > origW * 0.35 && ch > origH * 0.35;
                        const hasBlackBars = cw < origW * 0.95 || ch < origH * 0.95;

                        if (isValidArea && hasBlackBars) {
                            autoCrop = `crop=${cw}:${ch}:${cx}:${cy}`;
                        }
                    }
                    resolve({ duration, autoCrop });
                }
            );
        });
    });
}

function addStickerExif(webpBuffer, packName = 'Sound Stickers', author = 'BotWA') {
    const jsonMetadata = {
        'sticker-pack-id': 'com.bot.soundsticker.official',
        'sticker-pack-name': packName,
        'sticker-pack-publisher': author,
        'emojis': ['🔊']
    };
    const exifAttr = Buffer.from([
        0x49, 0x49, 0x2a, 0x00, 0x08, 0x00, 0x00, 0x00,
        0x01, 0x00, 0x41, 0x57, 0x07, 0x00, 0x00, 0x00,
        0x00, 0x00, 0x16, 0x00, 0x00, 0x00
    ]);
    const jsonBuffer = Buffer.from(JSON.stringify(jsonMetadata), 'utf8');
    const exifPayload = Buffer.concat([exifAttr, jsonBuffer]);
    exifPayload.writeUIntLE(jsonBuffer.length, 14, 4);

    const exifChunkHeader = Buffer.alloc(8);
    exifChunkHeader.write('EXIF', 0, 4, 'ascii');
    exifChunkHeader.writeUInt32LE(exifPayload.length, 4);
    const exifPad = exifPayload.length % 2 === 1 ? Buffer.from([0x00]) : Buffer.alloc(0);

    const chunkFourCC = webpBuffer.toString('ascii', 12, 16);
    if (chunkFourCC === 'VP8 ' || chunkFourCC === 'VP8L') {
        const vp8xHeader = Buffer.alloc(18);
        vp8xHeader.write('VP8X', 0, 4, 'ascii');
        vp8xHeader.writeUInt32LE(10, 4);
        vp8xHeader.writeUInt8(chunkFourCC === 'VP8L' ? 0x18 : 0x08, 8);
        vp8xHeader.writeUIntLE(511, 12, 3);
        vp8xHeader.writeUIntLE(511, 15, 3);

        const bodyWithoutRiff = webpBuffer.subarray(12);
        const combined = Buffer.concat([
            Buffer.from('RIFF'),
            Buffer.alloc(4),
            Buffer.from('WEBP'),
            vp8xHeader,
            bodyWithoutRiff,
            exifChunkHeader,
            exifPayload,
            exifPad
        ]);
        combined.writeUInt32LE(combined.length - 8, 4);
        return combined;
    }

    const updatedWebp = Buffer.from(webpBuffer);
    if (chunkFourCC === 'VP8X') {
        updatedWebp[20] = updatedWebp[20] | 0x08;
    }

    const combined = Buffer.concat([updatedWebp, exifChunkHeader, exifPayload, exifPad]);
    combined.writeUInt32LE(combined.length - 8, 4);
    return combined;
}

function buildScaleFilter(size, cropMode, autoCrop) {
    let filterChain = [];

    if (cropMode === 'auto' && autoCrop) {
        filterChain.push(autoCrop);
    }

    switch (cropMode) {
        case 'tengah':
        case 'center':
        case 'crop':
            filterChain.push(`crop=min(iw\\,ih):min(iw\\,ih):(iw-min(iw\\,ih))/2:(ih-min(iw\\,ih))/2`);
            filterChain.push(`format=yuva420p,scale=${size}:${size}:flags=lanczos`);
            break;
        case 'atas':
        case 'top':
            filterChain.push(`crop=min(iw\\,ih):min(iw\\,ih):(iw-min(iw\\,ih))/2:0`);
            filterChain.push(`format=yuva420p,scale=${size}:${size}:flags=lanczos`);
            break;
        case 'bawah':
        case 'bottom':
            filterChain.push(`crop=min(iw\\,ih):min(iw\\,ih):(iw-min(iw\\,ih))/2:ih-min(iw\\,ih)`);
            filterChain.push(`format=yuva420p,scale=${size}:${size}:flags=lanczos`);
            break;
        case 'kiri':
        case 'left':
            filterChain.push(`crop=min(iw\\,ih):min(iw\\,ih):0:(ih-min(iw\\,ih))/2`);
            filterChain.push(`format=yuva420p,scale=${size}:${size}:flags=lanczos`);
            break;
        case 'kanan':
        case 'right':
            filterChain.push(`crop=min(iw\\,ih):min(iw\\,ih):iw-min(iw\\,ih):(ih-min(iw\\,ih))/2`);
            filterChain.push(`format=yuva420p,scale=${size}:${size}:flags=lanczos`);
            break;
        default:
            filterChain.push(
                `format=yuva420p,scale=${size}:${size}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${size}:${size}:(ow-iw)/2:(oh-ih)/2:color=0x00000000`
            );
            break;
    }

    return filterChain.join(',');
}

function runFfmpegWebp(inputPath, outputPath, isVideo, maxSeconds, size, fps, quality, cropMode, autoCrop) {
    return new Promise((resolve, reject) => {
        const vf = buildScaleFilter(size, cropMode, autoCrop);

        const args = isVideo
            ? [
                  '-vf', `${vf},fps=${fps}`,
                  '-loop', '0',
                  '-t', String(maxSeconds),
                  '-quality', String(quality),
                  '-compression_level', '4',
                  '-an',
                  '-fps_mode', 'passthrough'
              ]
            : [
                  '-vf', vf,
                  '-vframes', '1',
                  '-quality', '85'
              ];

        ffmpeg(inputPath)
            .outputOptions(args)
            .toFormat('webp')
            .save(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err));
    });
}

async function renderWebp(inputPath, outputPath, isVideo = false, maxSeconds = 10, cropMode = 'auto', autoCrop = null) {
    if (!isVideo) {
        return runFfmpegWebp(inputPath, outputPath, false, 1, 512, 1, 85, cropMode, autoCrop);
    }

    const presets = [
        { size: 512, fps: maxSeconds > 10 ? 10 : 12, quality: 75 },
        { size: 384, fps: 9, quality: 60 },
        { size: 320, fps: 8, quality: 50 },
        { size: 256, fps: 7, quality: 45 }
    ];

    for (const preset of presets) {
        await runFfmpegWebp(inputPath, outputPath, true, maxSeconds, preset.size, preset.fps, preset.quality, cropMode, autoCrop);
        const sizeKB = fs.statSync(outputPath).size / 1024;
        console.log(`[CHECK] Mode:${cropMode} | ${preset.size}px @${preset.fps}fps Q${preset.quality} -> ${Math.round(sizeKB)} KB`);
        if (sizeKB <= 900) {
            return outputPath;
        }
    }
    return outputPath;
}

function renderAudioM4a(inputPath, outputPath, maxSeconds = 30) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .noVideo()
            .audioCodec('aac')
            .audioBitrate('64k')
            .audioChannels(1)
            .audioFrequency(44100)
            .outputOptions(['-t', String(maxSeconds), '-movflags', '+faststart'])
            .toFormat('ipod')
            .save(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err));
    });
}

function extractDigits(jid = '') {
    return jid.split('@')[0].split(':')[0].replace(/[^0-9]/g, '');
}

let cachedPhoneNumber = '';
let isPairingActive = false;
let pairingTimeout = null;

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(SESSION_PATH);
    const { version } = await fetchLatestBaileysVersion();

    if (!state.creds.registered && !cachedPhoneNumber) {
        console.log('\n=== MODE PAIRING CODE AKTIF ===');
        const rawNumber = await question('Masukkan nomor WA bot (awalan 62, contoh 6281234567890): ');
        cachedPhoneNumber = rawNumber.replace(/[^0-9]/g, '');
    }

    const sock = makeWASocket({
        version,
        auth: state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Chrome'),
        printQRInTerminal: false,
        connectTimeoutMs: 60000,
        defaultQueryTimeoutMs: 60000,
        keepAliveIntervalMs: 10000
    });

    if (!sock.authState.creds.registered && !isPairingActive) {
        isPairingActive = true;
        setTimeout(async () => {
            try {
                let code = await sock.requestPairingCode(cachedPhoneNumber);
                code = code?.match(/.{1,4}/g)?.join('-') || code;
                console.log(`\nKODE PAIRING: ${code} (Berlaku 60 detik)\n`);

                let sisaDetik = 60;
                pairingTimeout = setInterval(() => {
                    sisaDetik -= 10;
                    if (sisaDetik > 0 && !sock.authState.creds.registered) {
                        console.log(`Sisa waktu pairing: ${sisaDetik} detik...`);
                    } else {
                        clearInterval(pairingTimeout);
                        if (!sock.authState.creds.registered) {
                            isPairingActive = false;
                            startBot();
                        }
                    }
                }, 10000);
            } catch (err) {
                isPairingActive = false;
                setTimeout(() => startBot(), 3000);
            }
        }, 3000);
    }

    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', (update) => {
        const { connection, lastDisconnect } = update;
        if (connection === 'open') {
            activeSock = sock;
            isPairingActive = false;
            if (pairingTimeout) clearInterval(pairingTimeout);
            try { rl.close(); } catch (e) {}
            console.log(`\n[SUKSES] Bot WhatsApp aktif! Mode: ${botConfig.adminOnly ? 'ADMIN ONLY' : 'PUBLIC'} | Waktu: ${formatWib()}`);
        }
        if (connection === 'close') {
            activeSock = null;
            const statusCode = lastDisconnect?.error?.output?.statusCode;
            const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
            if (isPairingActive && statusCode !== DisconnectReason.restartRequired) return;
            if (shouldReconnect) startBot();
        }
    });

    async function handleIncomingMessage(msg, isEdited = false) {
        if (!msg || !msg.message) return;

        const remoteJid = msg.key?.remoteJid;
        if (!remoteJid || remoteJid === 'status@broadcast') return;

        const isGroup = remoteJid.endsWith('@g.us');
        const botDigits = extractDigits(sock.user?.id || '');
        const botLidDigits = extractDigits(sock.user?.lid || '');

        const rawCandidate = isGroup
            ? (msg.key.participantPn || msg.key.participant || '')
            : (msg.key.senderPn || remoteJid);

        let senderDigits = extractDigits(rawCandidate);
        if (msg.key.fromMe && botDigits) {
            senderDigits = botDigits;
        }

        const cleanOwners = botConfig.owners.map((n) => normalizePhoneNumber(n));
        const cleanAllowedUsers = botConfig.allowedUsers.map((n) => normalizePhoneNumber(n));

        const isOwner =
            Boolean(msg.key.fromMe) ||
            (senderDigits !== '' && (senderDigits === botDigits || senderDigits === botLidDigits || cleanOwners.includes(senderDigits)));

        const isAllowedUser = isOwner || (senderDigits !== '' && cleanAllowedUsers.includes(senderDigits));

        const remoteDigits = extractDigits(remoteJid);
        const isSelfChat =
            !isGroup &&
            (remoteDigits === botDigits || remoteDigits === botLidDigits || cleanOwners.includes(remoteDigits));

        const messageType = Object.keys(msg.message)[0];
        const quotedMsg = msg.message.extendedTextMessage?.contextInfo?.quotedMessage;
        const quotedType = quotedMsg ? Object.keys(quotedMsg)[0] : null;

        const caption =
            msg.message.conversation ||
            msg.message.extendedTextMessage?.text ||
            msg.message.imageMessage?.caption ||
            msg.message.videoMessage?.caption ||
            '';

        const parts = caption.trim().split(/\s+/);
        const baseCmd = (parts[0] || '').toLowerCase();

        // === CATAT RIWAYAT PERCAKAPAN UNTUK WEB MONITOR ===
        let chatEntry = null;
        if (senderDigits && !isEdited) {
            const isCommandOrPrivate = !isGroup || caption.trim().startsWith('.');
            if (isCommandOrPrivate) {
                const contextLabel = isGroup ? 'Grup' : isSelfChat ? 'Self-Chat' : 'Chat Pribadi';
                const initialStatus = (botConfig.adminOnly && !isAllowedUser)
                    ? '[Diabaikan: Belum terdaftar di .add]'
                    : 'Diproses oleh bot';
                chatEntry = recordChat(
                    senderDigits,
                    msg.pushName || (isOwner ? 'Admin / Owner' : 'Pengguna WA'),
                    contextLabel,
                    caption.trim() || `[${messageType}]`,
                    initialStatus
                );
            }
        }

        // === PERINTAH MANAJEMEN PENGGUNA & ADMIN MANUAL (.add, .del, .listuser) ===
        if (baseCmd === '.add') {
            if (!isOwner) return;

            const arg1 = (parts[1] || '').toLowerCase();
            const isAddingAdmin = arg1 === 'admin' || arg1 === 'owner';
            const rawNumInput = isAddingAdmin ? parts.slice(2).join('') : parts.slice(1).join('');

            let targetNum = normalizePhoneNumber(rawNumInput);
            if (!targetNum) {
                const quotedParticipant = msg.message.extendedTextMessage?.contextInfo?.participant;
                if (quotedParticipant) {
                    targetNum = normalizePhoneNumber(extractDigits(quotedParticipant));
                }
            }

            if (!targetNum || targetNum.length < 9) {
                await sock.sendMessage(
                    remoteJid,
                    {
                        text:
                            `⚠️ *Format salah!*\n` +
                            `• Tambah Pengguna: *.add 0812xxx* (atau +62 812-xxx)\n` +
                            `• Tambah Admin: *.add admin 0812xxx*\n` +
                            `• _(Bisa juga dengan me-reply pesan orangnya lalu ketik .add)_`
                    },
                    { quoted: msg }
                );
                return;
            }

            if (isAddingAdmin) {
                if (!cleanOwners.includes(targetNum)) botConfig.owners.push(targetNum);
                if (!cleanAllowedUsers.includes(targetNum)) botConfig.allowedUsers.push(targetNum);
                saveConfig(botConfig);
                await sock.sendMessage(
                    remoteJid,
                    { text: `👑 Nomor *+${targetNum}* berhasil ditambahkan sebagai *Admin/Owner* secara permanen.` },
                    { quoted: msg }
                );
                updateChatReply(chatEntry, `Menambahkan Admin +${targetNum}`);
            } else {
                if (cleanAllowedUsers.includes(targetNum)) {
                    await sock.sendMessage(
                        remoteJid,
                        { text: `ℹ️ Nomor *+${targetNum}* sudah terdaftar di daftar pengguna.` },
                        { quoted: msg }
                    );
                    return;
                }
                botConfig.allowedUsers.push(targetNum);
                saveConfig(botConfig);
                await sock.sendMessage(
                    remoteJid,
                    { text: `✅ Nomor *+${targetNum}* berhasil ditambahkan ke daftar pengguna permanen.` },
                    { quoted: msg }
                );
                updateChatReply(chatEntry, `Menambahkan Pengguna +${targetNum}`);
            }
            return;
        }

        if (baseCmd === '.del' || baseCmd === '.hapus') {
            if (!isOwner) return;
            let targetNum = normalizePhoneNumber(parts.slice(1).join(''));
            if (!targetNum) {
                const quotedParticipant = msg.message.extendedTextMessage?.contextInfo?.participant;
                if (quotedParticipant) {
                    targetNum = normalizePhoneNumber(extractDigits(quotedParticipant));
                }
            }

            if (!targetNum) {
                await sock.sendMessage(
                    remoteJid,
                    { text: '⚠️ Masukkan nomor yang ingin dihapus. Contoh: *.del 0812xxx*' },
                    { quoted: msg }
                );
                return;
            }

            const beforeOwner = botConfig.owners.length;
            const beforeUser = botConfig.allowedUsers.length;
            botConfig.owners = botConfig.owners.filter((n) => normalizePhoneNumber(n) !== targetNum);
            botConfig.allowedUsers = botConfig.allowedUsers.filter((n) => normalizePhoneNumber(n) !== targetNum);

            if (botConfig.owners.length === beforeOwner && botConfig.allowedUsers.length === beforeUser) {
                await sock.sendMessage(
                    remoteJid,
                    { text: `❌ Nomor *+${targetNum}* tidak ditemukan di daftar Admin maupun Pengguna.` },
                    { quoted: msg }
                );
                return;
            }

            saveConfig(botConfig);
            await sock.sendMessage(
                remoteJid,
                { text: `🗑️ Nomor *+${targetNum}* berhasil dihapus dari daftar Admin & Pengguna.` },
                { quoted: msg }
            );
            updateChatReply(chatEntry, `Menghapus nomor +${targetNum}`);
            return;
        }

        if (baseCmd === '.listuser') {
            if (!isOwner) return;
            const adminsText =
                botConfig.owners.length > 0
                    ? botConfig.owners.map((n, i) => `${i + 1}. +${normalizePhoneNumber(n)}`).join('\n')
                    : '_Belum ada admin tambahan_';

            const usersText =
                botConfig.allowedUsers.length > 0
                    ? botConfig.allowedUsers.map((n, i) => `${i + 1}. +${normalizePhoneNumber(n)}`).join('\n')
                    : '_Belum ada pengguna terdaftar_';

            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        `👥 *DAFTAR AKSES BOT (PERMANEN)*\n` +
                        `Mode Saat Ini: *${botConfig.adminOnly ? '🔒 Admin Only (Khusus Daftar Ini)' : '🌐 Public'}*\n\n` +
                        `👑 *Admin / Owner:*\n${adminsText}\n\n` +
                        `✅ *Pengguna Terdaftar (.add):*\n${usersText}`
                },
                { quoted: msg }
            );
            updateChatReply(chatEntry, 'Menampilkan .listuser');
            return;
        }

        // === PERINTAH SAKLAR MODE ===
        if (baseCmd === '.adminonly' || baseCmd === '.self') {
            if (!isOwner) return;
            botConfig.adminOnly = true;
            saveConfig(botConfig);
            await sock.sendMessage(
                remoteJid,
                { text: '🔒 *Mode Admin Only Aktif*\nHanya Admin dan nomor yang terdaftar di *.add* yang dapat memakai bot.' },
                { quoted: msg }
            );
            updateChatReply(chatEntry, 'Mengaktifkan Mode Admin Only');
            return;
        }

        if (baseCmd === '.public' || baseCmd === '.alluser') {
            if (!isOwner) return;
            botConfig.adminOnly = false;
            saveConfig(botConfig);
            await sock.sendMessage(
                remoteJid,
                { text: '🌐 *Mode Public Aktif*\nSemua member sekarang dapat menggunakan perintah stiker bot.' },
                { quoted: msg }
            );
            updateChatReply(chatEntry, 'Mengaktifkan Mode Public');
            return;
        }

        // === FITUR PESAN TERJADWAL ===
        if (baseCmd === '.jam') {
            if (!isOwner) return;
            const activeCount = schedules.filter((j) => j.status === 'ACTIVE').length;
            await sock.sendMessage(
                remoteJid,
                { text: `🕒 *Waktu Realtime Bot:*\n${formatWib()}\nAntrean jadwal aktif: *${activeCount}*` },
                { quoted: msg }
            );
            updateChatReply(chatEntry, `Cek jam (${formatWib()})`);
            return;
        }

        if (baseCmd === '.jadwal') {
            if (!isOwner) return;
            const rawBody = caption.slice(parts[0].length).trim();

            if (!rawBody) {
                await sock.sendMessage(
                    remoteJid,
                    {
                        text:
                            `.jadwal\n` +
                            `Nomor: \n` +
                            `Waktu: \n` +
                            `Jumlah: \n` +
                            `Pesan: \n\n` +
                            `_Keterangan:_\n` +
                            `• _Nomor: +62 812-xxx / 0812xxx / sini_\n` +
                            `• _Waktu: 12:30 / 27-11-2026 07:00 / +15m_\n` +
                            `• _Jumlah: 1 (default) atau 3:10 (3 pesan, jeda 10d)_\n` +
                            `• _Cara pakai: Salin templat di atas lalu Edit pesan ".jadwal"-mu, atau ketik sebaris: .jadwal 0812xxx, 12:30, 1, Pesan_`
                    },
                    { quoted: msg }
                );
                updateChatReply(chatEntry, 'Mengirim templat formulir .jadwal');
                return;
            }

            await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });
            const form = parseJadwalInput(rawBody);

            if (!form.nomor || !form.waktu || !form.pesan) {
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                await sock.sendMessage(
                    remoteJid,
                    { text: `⚠️ *Formulir belum lengkap!*\nPastikan mengisi *Nomor:*, *Waktu:*, dan *Pesan:*.\nKetik *.jadwal* tanpa teks untuk templat kosong.` },
                    { quoted: msg }
                );
                updateChatReply(chatEntry, 'Gagal .jadwal: Formulir belum lengkap');
                return;
            }

            const targetTs = parseScheduleTime(form.waktu);
            if (!targetTs) {
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                await sock.sendMessage(
                    remoteJid,
                    { text: `❌ *Format Waktu tidak valid atau sudah lewat!*\nGunakan: *12:30*, *27-11-2026 07:00*, atau *+15m* / *+2h*` },
                    { quoted: msg }
                );
                return;
            }

            const countMatch = form.jumlah.match(/^(\d+)(?::(\d+))?$/);
            if (!countMatch) {
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                await sock.sendMessage(
                    remoteJid,
                    { text: '❌ *Format Jumlah salah!* Contoh: *1*, *3* (jeda 5 detik), atau *3:60*.' },
                    { quoted: msg }
                );
                return;
            }

            const totalCount = Number(countMatch[1]);
            const intervalSec = countMatch[2] ? Number(countMatch[2]) : 5;

            if (totalCount < 1 || totalCount > 15 || intervalSec < 3) {
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                await sock.sendMessage(
                    remoteJid,
                    { text: '❌ Jumlah harus *1–15 pesan* dan jeda minimal *3 detik*.' },
                    { quoted: msg }
                );
                return;
            }

            let targetJid = '';
            let targetLabel = '';

            if (form.nomor.toLowerCase() === 'sini' || form.nomor.toLowerCase() === 'here') {
                targetJid = remoteJid;
                targetLabel = isGroup ? 'Grup Ini' : 'Chat Ini';
            } else {
                const cleanNum = normalizePhoneNumber(form.nomor);
                if (cleanNum.length < 9) {
                    await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                    await sock.sendMessage(remoteJid, { text: '❌ *Nomor:* tidak valid.' }, { quoted: msg });
                    return;
                }

                try {
                    const [waCheck] = await sock.onWhatsApp(cleanNum);
                    if (!waCheck || !waCheck.exists) {
                        await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                        await sock.sendMessage(
                            remoteJid,
                            { text: `❌ Nomor *${cleanNum}* tidak terdaftar di WhatsApp.` },
                            { quoted: msg }
                        );
                        return;
                    }
                    targetJid = waCheck.jid;
                    targetLabel = cleanNum;
                } catch (err) {
                    targetJid = `${cleanNum}@s.whatsapp.net`;
                    targetLabel = cleanNum;
                }
            }

            const nextId = schedules.length > 0 ? Math.max(...schedules.map((s) => s.id)) + 1 : 1;
            const ownerNotifyJid = botDigits ? `${botDigits}@s.whatsapp.net` : remoteJid;
            const scheduledText = formatWib(targetTs);

            const newJob = {
                id: nextId,
                targetJid,
                targetLabel,
                notifyJid: ownerNotifyJid,
                message: form.pesan,
                createdAt: formatWib(Date.now()),
                scheduledAt: targetTs,
                nextRunAt: targetTs,
                scheduledText,
                totalCount,
                sentCount: 0,
                intervalSec,
                status: 'ACTIVE',
                logs: []
            };

            schedules.push(newJob);
            saveSchedules(schedules);

            const sisaWaktu = formatCountdown(targetTs - Date.now());
            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        `📅 *Jadwal #${newJob.id} Aktif!*${isEdited ? ' _(dari edit pesan)_' : ''}\n\n` +
                        `Nomor: *${targetLabel}*\n` +
                        `Waktu: *${scheduledText}*\n` +
                        `Hitung Mundur: *${sisaWaktu}*\n` +
                        `Jumlah: *${totalCount} pesan* (jeda ${intervalSec} detik)\n` +
                        `Pesan: _"${form.pesan}"_\n\n` +
                        `Ketik *.listjadwal* untuk cek hitung mundur atau *.stopjadwal ${newJob.id}* untuk batal.`
                },
                { quoted: msg }
            );
            await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
            updateChatReply(chatEntry, `Jadwal #${newJob.id} dibuat untuk ${targetLabel} (${scheduledText})`);
            return;
        }

        if (baseCmd === '.listjadwal') {
            if (!isOwner) return;
            const activeJobs = schedules.filter((j) => j.status === 'ACTIVE');
            if (activeJobs.length === 0) {
                await sock.sendMessage(
                    remoteJid,
                    { text: `📭 Tidak ada jadwal aktif saat ini.\nWaktu sekarang: *${formatWib()}*` },
                    { quoted: msg }
                );
                return;
            }

            const now = Date.now();
            const lines = activeJobs.map((j) => {
                const remain = formatCountdown(j.nextRunAt - now);
                return (
                    `*#${j.id}* → *${j.targetLabel}*\n` +
                    `   Waktu: ${j.scheduledText}\n` +
                    `   Sisa Waktu: *${remain}*\n` +
                    `   Progres: ${j.sentCount}/${j.totalCount} pesan (jeda ${j.intervalSec}d)`
                );
            });

            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        `⏳ *Antrean Jadwal Aktif (${activeJobs.length})*\n` +
                        `Realtime: ${formatWib(now)}\n\n` +
                        lines.join('\n\n') +
                        `\n\n_Ketik .stopjadwal <id> untuk menghentikan._`
                },
                { quoted: msg }
            );
            return;
        }

        if (baseCmd === '.stopjadwal') {
            if (!isOwner) return;
            const arg = (parts[1] || '').replace('#', '').toLowerCase();
            if (!arg) {
                await sock.sendMessage(
                    remoteJid,
                    { text: '⚠️ Masukkan ID jadwal atau *all*.\nContoh: *.stopjadwal 1* atau *.stopjadwal all*' },
                    { quoted: msg }
                );
                return;
            }

            if (arg === 'all') {
                const activeJobs = schedules.filter((j) => j.status === 'ACTIVE');
                if (activeJobs.length === 0) {
                    await sock.sendMessage(remoteJid, { text: '📭 Tidak ada jadwal aktif untuk dihentikan.' }, { quoted: msg });
                    return;
                }
                const stopTime = formatWib();
                for (const j of activeJobs) {
                    j.status = 'STOPPED';
                    j.logs.push(`${stopTime} - Dihentikan manual (${j.sentCount}/${j.totalCount})`);
                }
                saveSchedules(schedules);
                await sock.sendMessage(remoteJid, { text: `🛑 *${activeJobs.length} jadwal aktif* berhasil dihentikan.` }, { quoted: msg });
                return;
            }

            const targetId = Number(arg);
            const job = schedules.find((j) => j.id === targetId && j.status === 'ACTIVE');
            if (!job) {
                await sock.sendMessage(remoteJid, { text: `❌ Jadwal aktif *#${arg}* tidak ditemukan.` }, { quoted: msg });
                return;
            }

            job.status = 'STOPPED';
            job.logs.push(`${formatWib()} - Dihentikan manual (${job.sentCount}/${job.totalCount})`);
            saveSchedules(schedules);
            await sock.sendMessage(
                remoteJid,
                { text: `🛑 *Jadwal #${job.id}* (${job.targetLabel}) dihentikan pada progres *${job.sentCount}/${job.totalCount}*.` },
                { quoted: msg }
            );
            return;
        }

        if (baseCmd === '.riwayatjadwal') {
            if (!isOwner) return;
            const pastJobs = schedules.filter((j) => j.status !== 'ACTIVE').slice(-10).reverse();
            if (pastJobs.length === 0) {
                await sock.sendMessage(remoteJid, { text: '📭 Belum ada riwayat pesan terjadwal.' }, { quoted: msg });
                return;
            }

            const lines = pastJobs.map((j) => {
                const icon = j.status === 'COMPLETED' ? '✅' : j.status === 'STOPPED' ? '🛑' : '❌';
                const lastLog = j.logs[j.logs.length - 1] || j.scheduledText;
                return `${icon} *#${j.id}* → ${j.targetLabel} (${j.sentCount}/${j.totalCount})\n   ${lastLog}`;
            });

            await sock.sendMessage(
                remoteJid,
                { text: `📜 *Riwayat 10 Jadwal Terakhir*\n\n${lines.join('\n\n')}\n\n_Ketik .hapusriwayat untuk membersihkan._` },
                { quoted: msg }
            );
            return;
        }

        if (baseCmd === '.hapusriwayat') {
            if (!isOwner) return;
            const before = schedules.length;
            schedules = schedules.filter((j) => j.status === 'ACTIVE');
            saveSchedules(schedules);
            const deleted = before - schedules.length;
            await sock.sendMessage(remoteJid, { text: `🗑️ *${deleted} riwayat jadwal* dibersihkan.` }, { quoted: msg });
            return;
        }

        if (isEdited) return;

        // === GERBANG FILTER AKSES ===
        if (botConfig.adminOnly && !isAllowedUser) {
            return;
        }

        const cropArg = (parts[1] || '').toLowerCase();
        const validModes = ['tengah', 'center', 'crop', 'atas', 'top', 'bawah', 'bottom', 'kiri', 'left', 'kanan', 'right'];
        const cropMode = validModes.includes(cropArg) ? cropArg : 'auto';

        // === MENU DINAMIS ===
        if (baseCmd === '.menu') {
            let menuText =
                `*BOT SOUND STICKER*\n\n` +
                `*Perintah Stiker:*\n` +
                `• *.s* → Ubah foto/video/stiker jadi stiker (auto transparan)\n` +
                `• *.sa* → Ubah video jadi Sound Sticker bersuara\n` +
                `• *.s tengah* / *.sa tengah* → Potong 1:1 penuh\n` +
                `  _(Opsi arah: tengah, atas, bawah, kiri, kanan)_`;

            if (isOwner && isSelfChat) {
                const statusText = botConfig.adminOnly ? '🔒 Admin Only' : '🌐 Public';
                menuText +=
                    `\n\n━━━━━━━━━━━━━━━━━━\n` +
                    `👑 *MENU KHUSUS ADMIN* (${statusText})\n` +
                    `🌐 Web Monitor: *http://localhost:${activePanelPort}*\n\n` +
                    `*1. Manajemen Pengguna (.add):*\n` +
                    `• *.add* 0812xxx → Tambah pengguna permanen\n` +
                    `• *.add admin* 0812xxx → Tambah admin permanen\n` +
                    `• *.del* 0812xxx → Hapus pengguna/admin\n` +
                    `• *.listuser* → Lihat daftar admin & pengguna\n\n` +
                    `*2. Pesan Terjadwal:*\n` +
                    `• *.jadwal* 0812xxx, 12:30, 1, pesan\n` +
                    `  _(Atau ketik .jadwal saja lalu Edit pesanmu)_\n` +
                    `• *.listjadwal* → Cek antrean & hitung mundur\n` +
                    `• *.stopjadwal* id / all → Hentikan jadwal\n` +
                    `• *.riwayatjadwal* → Catatan terkirim & berhenti\n` +
                    `• *.jam* → Cek waktu realtime WIB bot\n\n` +
                    `*3. Kontrol Akses Bot:*\n` +
                    `• *.adminonly* / *.public* → Kunci atau buka akses bot`;
            }

            await sock.sendMessage(remoteJid, { text: menuText }, { quoted: msg });
            updateChatReply(chatEntry, 'Mengirim daftar .menu');
            return;
        }

        const isValidMedia = (t) => ['imageMessage', 'videoMessage', 'stickerMessage'].includes(t);
        const targetMedia = isValidMedia(messageType)
            ? msg
            : isValidMedia(quotedType)
            ? { key: msg.key, message: quotedMsg }
            : null;

        const isSticker = messageType === 'stickerMessage' || quotedType === 'stickerMessage';
        const isVideo =
            messageType === 'videoMessage' ||
            quotedType === 'videoMessage' ||
            Boolean(msg.message.stickerMessage?.isAnimated || quotedMsg?.stickerMessage?.isAnimated);

        // Perintah .s
        if (baseCmd === '.s') {
            if (!targetMedia) {
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                updateChatReply(chatEntry, 'Gagal .s: Tidak ada media dilampirkan');
                return;
            }

            const stamp = Date.now();
            const ext = isSticker ? 'webp' : isVideo ? 'mp4' : 'jpg';
            const tempIn = path.join(__dirname, `in_${stamp}.${ext}`);
            const tempWebp = path.join(__dirname, `out_${stamp}.webp`);

            try {
                console.log(`[PROSES] Membuat stiker .s (mode: ${cropMode}, video: ${isVideo})...`);
                await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });

                const buffer = await downloadMediaMessage(targetMedia, 'buffer', {});
                fs.writeFileSync(tempIn, buffer);

                const { duration, autoCrop } = await getMediaInfo(tempIn);
                await renderWebp(tempIn, tempWebp, isVideo, duration, cropMode, autoCrop);
                const finalSticker = addStickerExif(fs.readFileSync(tempWebp));

                await sock.sendMessage(remoteJid, { sticker: finalSticker }, { quoted: msg });
                await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                updateChatReply(chatEntry, `Berhasil membuat stiker (.s ${cropMode})`);
                console.log('[SELESAI] Stiker .s terkirim!');
            } catch (err) {
                console.error('Detail Error .s:', err);
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                await sock.sendMessage(remoteJid, { text: `Error .s: ${err.message}` }, { quoted: msg });
                updateChatReply(chatEntry, `Error .s: ${err.message}`);
            } finally {
                if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn);
                if (fs.existsSync(tempWebp)) fs.unlinkSync(tempWebp);
            }
        }

        // Perintah .sa
        if (baseCmd === '.sa') {
            if (!targetMedia || !isVideo || isSticker) {
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                updateChatReply(chatEntry, 'Gagal .sa: Wajib melampirkan video');
                return;
            }

            const stamp = Date.now();
            const tempIn = path.join(__dirname, `sa_in_${stamp}.mp4`);
            const tempWebp = path.join(__dirname, `sa_out_${stamp}.webp`);
            const tempM4a = path.join(__dirname, `sa_aud_${stamp}.m4a`);

            try {
                console.log(`[PROSES] Mengunduh video untuk .sa (mode: ${cropMode})...`);
                await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });

                const buffer = await downloadMediaMessage(targetMedia, 'buffer', {});
                fs.writeFileSync(tempIn, buffer);

                const { duration, autoCrop } = await getMediaInfo(tempIn);
                console.log(`[PROSES] Render .sa mode=${cropMode}, durasi=${duration}s...`);

                await renderWebp(tempIn, tempWebp, true, duration, cropMode, autoCrop);
                await renderAudioM4a(tempIn, tempM4a, duration);

                const rawWebp = fs.readFileSync(tempWebp);
                const sizeKB = Math.round(rawWebp.length / 1024);
                console.log(`[INFO] Ukuran akhir WebP: ${sizeKB} KB`);

                const stickerBuffer = addStickerExif(rawWebp, 'Sound Stickers', 'BotWA');
                const audioBuffer = fs.readFileSync(tempM4a);

                const uploadedSticker = await prepareWAMessageMedia(
                    { sticker: stickerBuffer },
                    { upload: sock.waUploadToServer }
                );

                const uploadedAudio = await prepareWAMessageMedia(
                    {
                        audio: audioBuffer,
                        mimetype: 'audio/mp4',
                        ptt: false,
                        seconds: duration
                    },
                    { upload: sock.waUploadToServer }
                );

                uploadedSticker.stickerMessage.audioMessage = uploadedAudio.audioMessage;

                const waMsg = generateWAMessageFromContent(
                    remoteJid,
                    { stickerMessage: uploadedSticker.stickerMessage },
                    { userJid: sock.user.id, quoted: msg }
                );

                await sock.relayMessage(remoteJid, waMsg.message, { messageId: waMsg.key.id });
                await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                updateChatReply(chatEntry, `Berhasil membuat Sound Sticker (.sa ${cropMode})`);
                console.log('[SELESAI] Sound Sticker berhasil terkirim!');
            } catch (err) {
                console.error('Detail Error .sa:', err);
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                await sock.sendMessage(remoteJid, { text: `Error .sa: ${err.message}` }, { quoted: msg });
                updateChatReply(chatEntry, `Error .sa: ${err.message}`);
            } finally {
                if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn);
                if (fs.existsSync(tempWebp)) fs.unlinkSync(tempWebp);
                if (fs.existsSync(tempM4a)) fs.unlinkSync(tempM4a);
            }
        }
    }

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        await handleIncomingMessage(messages[0], false);
    });

    sock.ev.on('messages.update', async (updates) => {
        for (const { key, update } of updates) {
            const editedContent =
                update?.message?.editedMessage?.message ||
                update?.message?.protocolMessage?.editedMessage;

            if (editedContent) {
                await handleIncomingMessage({ key, message: editedContent }, true);
            }
        }
    });
}

startBot();
