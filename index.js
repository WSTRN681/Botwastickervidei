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
import readline from 'readline';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = path.join(__dirname, 'config.json');
const SCHEDULES_PATH = path.join(__dirname, 'schedules.json');
const SESSION_PATH = path.join(__dirname, 'auth_session');

// === PATCH PROTOBUF STATIC ENCODER: Suntikkan Field 26 (audioMessage) ke StickerMessage ===
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

// === MANAJEMEN CONFIG.JSON (ADMIN ONLY & OWNER) ===
function loadConfig() {
    const defaultConfig = {
        adminOnly: true,
        owners: []
    };
    try {
        if (!fs.existsSync(CONFIG_PATH)) {
            fs.writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2));
            return defaultConfig;
        }
        const parsed = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
        return {
            adminOnly: typeof parsed.adminOnly === 'boolean' ? parsed.adminOnly : true,
            owners: Array.isArray(parsed.owners) ? parsed.owners : []
        };
    } catch (err) {
        return defaultConfig;
    }
}

function saveConfig(cfg) {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
}

let botConfig = loadConfig();

// === MANAJEMEN SCHEDULES.JSON (PESAN TERJADWAL) ===
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

// === FUNGSI WAKTU REALTIME WIB (Asia/Jakarta, UTC+7) ===
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

    // Mode 1: Hitung mundur relatif (+15m, +2h, +30s)
    const relMatch = clean.match(/^\+(\d+)([smh])$/);
    if (relMatch) {
        const val = Number(relMatch[1]);
        const unit = relMatch[2];
        if (val <= 0) return null;
        const mult = unit === 's' ? 1000 : unit === 'm' ? 60000 : 3600000;
        return now + val * mult;
    }

    // Mode 2: Jam hari ini (HH:mm)
    const timeOnlyMatch = clean.match(/^(\d{1,2}):(\d{2})$/);
    if (timeOnlyMatch) {
        const hh = Number(timeOnlyMatch[1]);
        const mm = Number(timeOnlyMatch[2]);
        if (hh > 23 || mm > 59) return null;

        const p = getWibParts(now);
        const isoStr = `${p.year}-${p.month}-${p.day}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00+07:00`;
        let targetTs = Date.parse(isoStr);
        if (targetTs <= now) {
            targetTs += 24 * 60 * 60 * 1000; // Otomatis besok jika jam hari ini sudah lewat
        }
        return targetTs;
    }

    // Mode 3: Tanggal & Jam spesifik (DD-MM-YYYY HH:mm)
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

// Mesin pengecek jadwal realtime setiap 1 detik
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
                            text:
                                `✅ *Jadwal #${job.id} Selesai*\n` +
                                `Tujuan: ${job.targetLabel}\n` +
                                `Terkirim: *${job.sentCount}/${job.totalCount} pesan*\n` +
                                `Selesai pada: ${sentTime}`
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
                        text: `❌ *Jadwal #${job.id} Gagal*\nTujuan: ${job.targetLabel}\nAlasan: ${err.message}`
                    });
                }
            }
        }
    } finally {
        isSchedulerTickRunning = false;
    }
}, 1000);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// Deteksi durasi sekaligus cek bingkai hitam bawaan pada pertengahan video
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

// Menyuntikkan metadata Exif standar stiker WhatsApp ke WebP (Aman untuk WebP statis & animasi)
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

// Membangun filter potong 1:1 sesuai posisi yang diminta (tengah, atas, bawah, kiri, kanan) atau auto-transparan
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

// Fungsi internal sekali render FFmpeg
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

// Konversi foto/video menjadi WebP dengan Auto-Shrink agar selalu < 900 KB
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

// Ekstrak audio ke AAC/M4A sesuai durasi penuh video
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

// Ekstrak nomor bersih dari JID/LID WhatsApp
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

    sock.ev.on('messages.upsert', async ({ messages, type }) => {
        if (type !== 'notify') return;
        const msg = messages[0];
        if (!msg.message) return;

        const remoteJid = msg.key.remoteJid;
        if (remoteJid === 'status@broadcast') return;

        // === IDENTIFIKASI OWNER / ADMIN ===
        const isGroup = remoteJid.endsWith('@g.us');
        const rawSender = isGroup ? (msg.key.participant || '') : remoteJid;
        const senderDigits = extractDigits(rawSender);
        const botDigits = extractDigits(sock.user?.id || '');
        const botLidDigits = extractDigits(sock.user?.lid || '');

        const cleanOwners = botConfig.owners.map((n) => n.replace(/[^0-9]/g, ''));
        const isOwner =
            Boolean(msg.key.fromMe) ||
            (senderDigits !== '' && (senderDigits === botDigits || senderDigits === botLidDigits || cleanOwners.includes(senderDigits)));

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

        // === PERINTAH SAKLAR MODE (MUTLAK HANYA UNTUK OWNER) ===
        if (baseCmd === '.adminonly' || baseCmd === '.self') {
            if (!isOwner) return;
            botConfig.adminOnly = true;
            saveConfig(botConfig);
            await sock.sendMessage(
                remoteJid,
                { text: '🔒 *Mode Admin Only Aktif*\nHanya kamu (Owner) yang dapat menggunakan perintah bot.' },
                { quoted: msg }
            );
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
            return;
        }

        // === FITUR PESAN TERJADWAL (KHUSUS OWNER) ===
        if (baseCmd === '.jam') {
            if (!isOwner) return;
            const activeCount = schedules.filter((j) => j.status === 'ACTIVE').length;
            await sock.sendMessage(
                remoteJid,
                { text: `🕒 *Waktu Realtime Bot:*\n${formatWib()}\nAntrean jadwal aktif: *${activeCount}*` },
                { quoted: msg }
            );
            return;
        }

        if (baseCmd === '.jadwal') {
            if (!isOwner) return;
            const rawArgs = caption.slice(parts[0].length).trim();
            const segs = rawArgs.split('|').map((s) => s.trim());

            if (segs.length < 4 || !segs[0] || !segs[1] || !segs[2] || !segs[3]) {
                await sock.sendMessage(
                    remoteJid,
                    {
                        text:
                            `⚠️ *Format salah!*\n` +
                            `Gunakan: *.jadwal nomor | waktu | jumlah | pesan*\n\n` +
                            `Contoh:\n` +
                            `• *.jadwal 6281234567890 | 20:30 | 1 | Halo!*\n` +
                            `• *.jadwal 6281234567890 | +15m | 3:10 | Rapat mulai!*\n` +
                            `• *.jadwal sini | 27-11-2026 07:00 | 1 | Pagi semua!*`
                    },
                    { quoted: msg }
                );
                return;
            }

            const [targetInput, timeInput, countInput, ...msgRest] = segs;
            const messageText = msgRest.join(' | ');

            // Validasi Waktu
            const targetTs = parseScheduleTime(timeInput);
            if (!targetTs) {
                await sock.sendMessage(
                    remoteJid,
                    {
                        text:
                            `❌ *Format waktu tidak valid atau sudah terlewat!*\n` +
                            `Gunakan salah satu format berikut:\n` +
                            `• *20:30* (jam WIB hari ini/besok)\n` +
                            `• *27-11-2026 07:00* (tanggal & jam WIB)\n` +
                            `• *+15m* / *+2h* (hitung mundur menit/jam)`
                    },
                    { quoted: msg }
                );
                return;
            }

            // Validasi Jumlah & Jeda (contoh: "3" -> 3 pesan jeda 5d, atau "3:60" -> 3 pesan jeda 60d)
            const countMatch = countInput.match(/^(\d+)(?::(\d+))?$/);
            if (!countMatch) {
                await sock.sendMessage(
                    remoteJid,
                    { text: '❌ *Format jumlah salah!* Contoh: *1*, *3* (jeda 5 detik), atau *3:60* (3 pesan, jeda 60 detik).' },
                    { quoted: msg }
                );
                return;
            }

            const totalCount = Number(countMatch[1]);
            const intervalSec = countMatch[2] ? Number(countMatch[2]) : 5;

            if (totalCount < 1 || totalCount > 15) {
                await sock.sendMessage(
                    remoteJid,
                    { text: '❌ Jumlah pesan per jadwal harus antara *1 sampai 15 pesan* demi keamanan akun.' },
                    { quoted: msg }
                );
                return;
            }

            if (intervalSec < 3) {
                await sock.sendMessage(
                    remoteJid,
                    { text: '❌ Jeda antar-pesan minimal *3 detik* (contoh: *3:5*) agar tidak terdeteksi spam.' },
                    { quoted: msg }
                );
                return;
            }

            // Validasi Nomor Tujuan
            let targetJid = '';
            let targetLabel = '';

            if (targetInput.toLowerCase() === 'sini' || targetInput.toLowerCase() === 'here') {
                targetJid = remoteJid;
                targetLabel = isGroup ? 'Grup Ini' : 'Chat Ini';
            } else {
                let cleanNum = targetInput.replace(/[^0-9]/g, '');
                if (cleanNum.startsWith('08')) {
                    cleanNum = '62' + cleanNum.slice(1);
                }
                if (cleanNum.length < 9) {
                    await sock.sendMessage(remoteJid, { text: '❌ Nomor tujuan tidak valid. Gunakan awalan 62 atau 08.' }, { quoted: msg });
                    return;
                }

                try {
                    const [waCheck] = await sock.onWhatsApp(cleanNum);
                    if (!waCheck || !waCheck.exists) {
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
                message: messageText,
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
                        `📅 *Jadwal #${newJob.id} Tersimpan!*\n` +
                        `• Tujuan: *${targetLabel}*\n` +
                        `• Waktu Kirim: *${scheduledText}*\n` +
                        `• Hitung Mundur: *${sisaWaktu}*\n` +
                        `• Jumlah: *${totalCount} pesan* (jeda ${intervalSec} detik)\n` +
                        `• Isi: _"${messageText}"_\n\n` +
                        `Ketik *.listjadwal* untuk cek hitung mundur atau *.stopjadwal ${newJob.id}* untuk batal.`
                },
                { quoted: msg }
            );
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
                await sock.sendMessage(
                    remoteJid,
                    { text: `🛑 *${activeJobs.length} jadwal aktif* berhasil dihentikan.` },
                    { quoted: msg }
                );
                return;
            }

            const targetId = Number(arg);
            const job = schedules.find((j) => j.id === targetId && j.status === 'ACTIVE');
            if (!job) {
                await sock.sendMessage(
                    remoteJid,
                    { text: `❌ Jadwal aktif *#${arg}* tidak ditemukan. Cek ID di *.listjadwal*.` },
                    { quoted: msg }
                );
                return;
            }

            job.status = 'STOPPED';
            job.logs.push(`${formatWib()} - Dihentikan manual (${job.sentCount}/${job.totalCount})`);
            saveSchedules(schedules);

            await sock.sendMessage(
                remoteJid,
                { text: `🛑 *Jadwal #${job.id}* (${job.targetLabel}) berhasil dihentikan pada progres *${job.sentCount}/${job.totalCount}*.` },
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
                { text: `📜 *Riwayat 10 Jadwal Terakhir*\n\n${lines.join('\n\n')}\n\n_Ketik .hapusriwayat untuk membersihkan riwayat._` },
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
            await sock.sendMessage(
                remoteJid,
                { text: `🗑️ *${deleted} riwayat jadwal* berhasil dibersihkan.` },
                { quoted: msg }
            );
            return;
        }

        // === GERBANG FILTER AKSES: Abaikan total jika Admin Only aktif & pengirim bukan Owner ===
        if (botConfig.adminOnly && !isOwner) {
            return;
        }

        const cropArg = (parts[1] || '').toLowerCase();
        const validModes = ['tengah', 'center', 'crop', 'atas', 'top', 'bawah', 'bottom', 'kiri', 'left', 'kanan', 'right'];
        const cropMode = validModes.includes(cropArg) ? cropArg : 'auto';

        if (baseCmd === '.menu') {
            const statusText = botConfig.adminOnly ? '🔒 Admin Only' : '🌐 Public';
            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        `*BOT SOUND STICKER & SCHEDULER*\n` +
                        `Akses: *${statusText}*\n\n` +
                        `*1. Stiker & Sound Sticker*\n` +
                        `• *.s* / *.sa* → Stiker foto/video (auto transparan)\n` +
                        `• *.s tengah* / *.sa tengah* → Potong 1:1 (tengah/atas/bawah/kiri/kanan)\n\n` +
                        `*2. Pesan Terjadwal (Owner)*\n` +
                        `• *.jadwal* nomor | waktu | jumlah | pesan\n` +
                        `  _Waktu: 20:30 / 27-11-2026 07:00 / +15m_\n` +
                        `  _Jumlah: 3 (jeda 5d) atau 3:60 (jeda 60d)_\n` +
                        `• *.listjadwal* → Cek antrean & hitung mundur\n` +
                        `• *.stopjadwal* id / all → Hentikan jadwal\n` +
                        `• *.riwayatjadwal* → Catatan terkirim & berhenti\n` +
                        `• *.jam* → Cek waktu realtime WIB bot\n\n` +
                        `*3. Kontrol Akses (Owner)*\n` +
                        `• *.adminonly* / *.public* → Kunci atau buka akses bot`
                },
                { quoted: msg }
            );
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

        // Perintah .s (Stiker Biasa Foto/Video + Dukungan Reply Stiker + Mode Potong 1:1 + Reaksi ⏳ / ✅ / ❌)
        if (baseCmd === '.s') {
            if (!targetMedia) {
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
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
                console.log('[SELESAI] Stiker .s terkirim!');
            } catch (err) {
                console.error('Detail Error .s:', err);
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                await sock.sendMessage(remoteJid, { text: `Error .s: ${err.message}` }, { quoted: msg });
            } finally {
                if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn);
                if (fs.existsSync(tempWebp)) fs.unlinkSync(tempWebp);
            }
        }

        // Perintah .sa (Sound Sticker + Dukungan Mode Potong 1:1 & Transparansi + Reaksi ⏳ / ✅ / ❌)
        if (baseCmd === '.sa') {
            if (!targetMedia || !isVideo || isSticker) {
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
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
                console.log('[SELESAI] Sound Sticker berhasil terkirim!');
            } catch (err) {
                console.error('Detail Error .sa:', err);
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                await sock.sendMessage(remoteJid, { text: `Error .sa: ${err.message}` }, { quoted: msg });
            } finally {
                if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn);
                if (fs.existsSync(tempWebp)) fs.unlinkSync(tempWebp);
                if (fs.existsSync(tempM4a)) fs.unlinkSync(tempM4a);
            }
        }
    });
}

startBot();
