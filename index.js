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
        owners: [] // Masukkan nomor WA tambahan jika memakai 2 nomor, contoh: ["6281234567890"]
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

// Menyuntikkan metadata Exif standar stiker WhatsApp ke WebP
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

    const combined = Buffer.concat([webpBuffer, exifChunkHeader, exifPayload, exifPad]);
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

// Fungsi internal sekali render FFmpeg (Anti-blank untuk gambar statis & optimal untuk video)
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
                  '-vf', `${vf},format=rgba`,
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
            isPairingActive = false;
            if (pairingTimeout) clearInterval(pairingTimeout);
            try { rl.close(); } catch (e) {}
            console.log(`\n[SUKSES] Bot WhatsApp aktif! Mode saat ini: ${botConfig.adminOnly ? 'ADMIN ONLY (Khusus Owner)' : 'PUBLIC'}`);
        }
        if (connection === 'close') {
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

        const parts = caption.trim().toLowerCase().split(/\s+/);
        const baseCmd = parts[0] || '';

        // === PERINTAH SAKLAR MODE (MUTLAK HANYA UNTUK OWNER) ===
        if (baseCmd === '.adminonly' || baseCmd === '.self') {
            if (!isOwner) return;
            botConfig.adminOnly = true;
            saveConfig(botConfig);
            await sock.sendMessage(
                remoteJid,
                { text: '🔒 *Mode Admin Only Aktif*\nSekarang hanya kamu (Owner) yang dapat menggunakan perintah bot di grup maupun chat pribadi.' },
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
                { text: '🌐 *Mode Public Aktif*\nSekarang semua member dapat menggunakan perintah stiker bot.' },
                { quoted: msg }
            );
            return;
        }

        // === GERBANG FILTER AKSES: Abaikan total jika Admin Only aktif & pengirim bukan Owner ===
        if (botConfig.adminOnly && !isOwner) {
            return;
        }

        const validModes = ['tengah', 'center', 'crop', 'atas', 'top', 'bawah', 'bottom', 'kiri', 'left', 'kanan', 'right'];
        const cropMode = validModes.includes(parts[1]) ? parts[1] : 'auto';

        if (baseCmd === '.menu') {
            const statusText = botConfig.adminOnly ? '🔒 Admin Only (Khusus Owner)' : '🌐 Public (Semua Member)';
            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        `*Menu Bot Sound Sticker*\n` +
                        `Status Akses: *${statusText}*\n\n` +
                        `1. *.s* → Stiker Biasa (Auto Transparan)\n` +
                        `2. *.sa* → Sound Sticker (Auto Transparan, hingga 30 detik)\n\n` +
                        `*Mode Potong 1:1 (Fullscreen):*\n` +
                        `• *.sa tengah* / *.s tengah* → Potong 1:1 tengah\n` +
                        `• *.sa atas* / *.s atas* → Potong 1:1 atas\n` +
                        `• *.sa bawah* / *.s bawah* → Potong 1:1 bawah\n` +
                        `• *.sa kiri* / *.sa kanan* → Potong 1:1 kiri/kanan\n\n` +
                        `*Kontrol Owner:*\n` +
                        `• *.adminonly* → Kunci bot hanya untuk kamu\n` +
                        `• *.public* → Izinkan semua orang memakai bot`
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

        // Perintah .s (Stiker Biasa + Dukungan Reply Stiker + Mode Potong 1:1 + Reaksi ⏳ / ✅ / ❌)
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
                console.log(`[PROSES] Membuat stiker .s (mode: ${cropMode})...`);
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
