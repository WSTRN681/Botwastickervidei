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
import os from 'os';
import path from 'path';
import readline from 'readline';
import { execFile } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SCHEDULES_PATH = path.join(__dirname, 'schedules.json');
const SESSION_PATH = path.join(__dirname, 'auth_session');

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
        console.log('[INFO] Protobuf StickerMessage.audioMessage patched');
    }
} catch (e) {
    console.log('[WARN] Gagal patch Protobuf:', e.message);
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

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const question = (text) => new Promise((resolve) => rl.question(text, resolve));

// === PARSER ARGUMEN STIKER (CROP, DURASI, VOLUME) ===
function parseStickerArgs(argsArray) {
    const validModes = ['tengah', 'center', 'crop', 'atas', 'top', 'bawah', 'bottom', 'kiri', 'left', 'kanan', 'right'];
    let cropMode = 'auto';
    let customSeconds = null;
    let volumeFilter = null;
    let volumeLabel = null;

    for (let i = 0; i < argsArray.length; i++) {
        const arg = argsArray[i].toLowerCase();

        if (validModes.includes(arg)) {
            cropMode = arg;
            continue;
        }

        const durMatch = arg.match(/^(\d+)(s|d|detik)?$/);
        if (durMatch) {
            const val = Number(durMatch[1]);
            if (val >= 1 && val <= 30) {
                customSeconds = val;
                continue;
            }
        }

        if (arg === 'vol' || arg === 'volume') {
            const nextVal = (argsArray[i + 1] || '').toLowerCase();
            const parsedVol = parseVolumeToken(nextVal);
            if (parsedVol) {
                volumeFilter = parsedVol.filter;
                volumeLabel = parsedVol.label;
                i++;
                continue;
            }
        } else if (arg.startsWith('vol')) {
            const parsedVol = parseVolumeToken(arg.slice(3));
            if (parsedVol) {
                volumeFilter = parsedVol.filter;
                volumeLabel = parsedVol.label;
                continue;
            }
        }
    }

    return { cropMode, customSeconds, volumeFilter, volumeLabel };
}

function parseVolumeToken(token) {
    if (!token) return null;
    const dbMatch = token.match(/^([+-]?\d+(?:\.\d+)?)db$/);
    if (dbMatch) {
        const db = Math.max(-30, Math.min(30, Number(dbMatch[1])));
        return { filter: `volume=${db}dB`, label: `${db > 0 ? '+' : ''}${db}dB` };
    }
    const pctMatch = token.match(/^(\d+(?:\.\d+)?)%$/);
    if (pctMatch) {
        const mult = Math.max(0.1, Math.min(10, Number(pctMatch[1]) / 100));
        return { filter: `volume=${mult}`, label: `${Math.round(mult * 100)}%` };
    }
    const multMatch = token.match(/^(\d+(?:\.\d+)?)x?$/);
    if (multMatch) {
        const mult = Math.max(0.1, Math.min(10, Number(multMatch[1])));
        return { filter: `volume=${mult}`, label: `${mult}x` };
    }
    return null;
}

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

    let baseWebp = webpBuffer;
    const exifIndex = webpBuffer.indexOf(Buffer.from('EXIF'));
    if (exifIndex > 12) {
        baseWebp = webpBuffer.subarray(0, exifIndex);
    }

    const chunkFourCC = baseWebp.toString('ascii', 12, 16);
    if (chunkFourCC === 'VP8 ' || chunkFourCC === 'VP8L') {
        const vp8xHeader = Buffer.alloc(18);
        vp8xHeader.write('VP8X', 0, 4, 'ascii');
        vp8xHeader.writeUInt32LE(10, 4);
        vp8xHeader.writeUInt8(chunkFourCC === 'VP8L' ? 0x18 : 0x08, 8);
        vp8xHeader.writeUIntLE(511, 12, 3);
        vp8xHeader.writeUIntLE(511, 15, 3);

        const bodyWithoutRiff = baseWebp.subarray(12);
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

    const updatedWebp = Buffer.from(baseWebp);
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

function renderAudioM4a(inputPath, outputPath, maxSeconds = 30, volumeFilter = null) {
    return new Promise((resolve, reject) => {
        const cmd = ffmpeg(inputPath)
            .noVideo()
            .audioCodec('aac')
            .audioBitrate('64k')
            .audioChannels(1)
            .audioFrequency(44100);

        if (volumeFilter) {
            cmd.audioFilters(volumeFilter);
        }

        cmd.outputOptions(['-t', String(maxSeconds), '-movflags', '+faststart'])
            .toFormat('ipod')
            .save(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err));
    });
}

function renderAudioMp3(inputPath, outputPath, volumeFilter = null) {
    return new Promise((resolve, reject) => {
        const cmd = ffmpeg(inputPath)
            .noVideo()
            .audioCodec('libmp3lame')
            .audioBitrate('128k');

        if (volumeFilter) {
            cmd.audioFilters(volumeFilter);
        }

        cmd.toFormat('mp3')
            .save(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err));
    });
}

function renderVideoVolume(inputPath, outputPath, volumeFilter) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .videoCodec('copy')
            .audioCodec('aac')
            .audioBitrate('128k')
            .audioFilters(volumeFilter)
            .outputOptions(['-movflags', '+faststart'])
            .save(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(err));
    });
}

function convertWebpToPng(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .outputOptions(['-vframes', '1'])
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
            console.log(`\n[SUKSES] Bot WhatsApp aktif! Waktu: ${formatWib()}`);
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

        const isOwner =
            Boolean(msg.key.fromMe) ||
            (senderDigits !== '' && (senderDigits === botDigits || senderDigits === botLidDigits));

        const remoteDigits = extractDigits(remoteJid);
        const isSelfChat =
            !isGroup &&
            (remoteDigits === botDigits || remoteDigits === botLidDigits);

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

        // === MENU UTAMA ===
        if (baseCmd === '.menu') {
            let menuText =
                `*BOT SOUND STICKER*\n\n` +
                `*1. Pembuat Stiker:*\n` +
                `• *.s* → Foto/video/stiker jadi stiker (auto transparan)\n` +
                `• *.sa* → Video jadi Sound Sticker bersuara\n` +
                `• *Opsi Potong:* tengah, atas, bawah, kiri, kanan\n` +
                `• *Opsi Durasi:* tambah detik (maks 30s), misal: *.sa 8s*\n` +
                `• *Opsi Volume:* tambah *vol <angka>*, misal: *.sa 10s vol 2*\n\n` +
                `*2. Editor & Konverter Media:*\n` +
                `• *.vol <angka>* → Ubah volume video atau Sound Sticker\n` +
                `  _(Contoh: .vol 2 untuk 200%, .vol 15db untuk +15dB)_\n` +
                `• *.wm Pack | Author* → Ubah watermark nama pack stiker\n` +
                `• *.toimg* → Ubah stiker biasa jadi gambar PNG\n` +
                `• *.tomp3* → Ambil audio MP3 dari video / Sound Sticker`;

            if (isOwner && isSelfChat) {
                menuText +=
                    `\n\n━━━━━━━━━━━━━━━━━━\n` +
                    `👑 *MENU KHUSUS OWNER*\n\n` +
                    `*Pesan Terjadwal & Sistem:*\n` +
                    `• *.jadwal* 0812xxx, 12:30, 1, pesan\n` +
                    `  _(Atau ketik .jadwal saja lalu Edit pesanmu)_\n` +
                    `• *.listjadwal* → Cek antrean & hitung mundur\n` +
                    `• *.stopjadwal* id / all → Hentikan jadwal\n` +
                    `• *.riwayatjadwal* → Catatan terkirim & berhenti\n` +
                    `• *.hapusriwayat* → Bersihkan riwayat jadwal\n` +
                    `• *.jam* → Cek waktu realtime WIB bot\n` +
                    `• *.ping* → Cek kecepatan respons & RAM Termux`;
            }

            await sock.sendMessage(remoteJid, { text: menuText }, { quoted: msg });
            return;
        }

        // === CEK STATUS BOT & RAM (.ping) ===
        if (baseCmd === '.ping') {
            const startTick = Date.now();
            const freeMemMB = Math.round(os.freemem() / 1024 / 1024);
            const totalMemMB = Math.round(os.totalmem() / 1024 / 1024);
            const uptimeSec = Math.floor(process.uptime());
            const upHours = Math.floor(uptimeSec / 3600);
            const upMins = Math.floor((uptimeSec % 3600) / 60);
            const latency = Date.now() - startTick;

            await sock.sendMessage(
                remoteJid,
                {
                    text:
                        `⚡ *Status Bot Termux*\n` +
                        `• Respon: *${latency} ms*\n` +
                        `• Aktif selama: *${upHours} jam ${upMins} menit*\n` +
                        `• RAM Tersisa: *${freeMemMB} MB / ${totalMemMB} MB*`
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

        const stickerObj = msg.message.stickerMessage || quotedMsg?.stickerMessage;
        const hasEmbeddedAudio = Boolean(stickerObj?.audioMessage?.url || stickerObj?.audioMessage?.directPath);

        const { cropMode, customSeconds, volumeFilter, volumeLabel } = parseStickerArgs(parts.slice(1));

        // === PERINTAH .s ===
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
                await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });

                const buffer = await downloadMediaMessage(targetMedia, 'buffer', {});
                fs.writeFileSync(tempIn, buffer);

                const { duration, autoCrop } = await getMediaInfo(tempIn);
                const finalDuration = customSeconds ? Math.min(30, customSeconds) : duration;

                await renderWebp(tempIn, tempWebp, isVideo, finalDuration, cropMode, autoCrop);
                const finalSticker = addStickerExif(fs.readFileSync(tempWebp));

                await sock.sendMessage(remoteJid, { sticker: finalSticker }, { quoted: msg });
                await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
            } catch (err) {
                console.error('Detail Error .s:', err);
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                await sock.sendMessage(remoteJid, { text: `Error .s: ${err.message}` }, { quoted: msg });
            } finally {
                if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn);
                if (fs.existsSync(tempWebp)) fs.unlinkSync(tempWebp);
            }
            return;
        }

        // === PERINTAH .sa (DENGAN DURASI & VOLUME KUSTOM) ===
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
                await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });

                const buffer = await downloadMediaMessage(targetMedia, 'buffer', {});
                fs.writeFileSync(tempIn, buffer);

                const { duration, autoCrop } = await getMediaInfo(tempIn);
                const finalDuration = customSeconds ? Math.min(30, customSeconds) : duration;

                console.log(`[PROSES] .sa mode=${cropMode}, durasi=${finalDuration}s, vol=${volumeLabel || 'normal'}`);

                await renderWebp(tempIn, tempWebp, true, finalDuration, cropMode, autoCrop);
                await renderAudioM4a(tempIn, tempM4a, finalDuration, volumeFilter);

                const rawWebp = fs.readFileSync(tempWebp);
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
                        seconds: finalDuration
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
            } catch (err) {
                console.error('Detail Error .sa:', err);
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                await sock.sendMessage(remoteJid, { text: `Error .sa: ${err.message}` }, { quoted: msg });
            } finally {
                if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn);
                if (fs.existsSync(tempWebp)) fs.unlinkSync(tempWebp);
                if (fs.existsSync(tempM4a)) fs.unlinkSync(tempM4a);
            }
            return;
        }

        // === PERINTAH .vol (UBAH VOLUME VIDEO ATAU SOUND STICKER) ===
        if (baseCmd === '.vol' || baseCmd === '.volume') {
            const rawVolArg = (parts[1] || '').toLowerCase();
            const parsedVol = parseVolumeToken(rawVolArg);

            if (!parsedVol) {
                await sock.sendMessage(
                    remoteJid,
                    { text: '⚠️ Masukkan tingkat volume. Contoh:\n• *.vol 2* (2x lebih keras / 200%)\n• *.vol 15db* (naik +15dB)\n• *.vol 0.5* (kecilkan 50%)' },
                    { quoted: msg }
                );
                return;
            }

            if (!targetMedia || (!isVideo && !hasEmbeddedAudio)) {
                await sock.sendMessage(
                    remoteJid,
                    { text: '⚠️ Balas video atau *Sound Sticker* yang ingin diubah volumenya.' },
                    { quoted: msg }
                );
                return;
            }

            const stamp = Date.now();
            await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });

            if (isSticker && hasEmbeddedAudio) {
                const tempAudioIn = path.join(__dirname, `vol_aud_in_${stamp}.m4a`);
                const tempAudioOut = path.join(__dirname, `vol_aud_out_${stamp}.m4a`);

                try {
                    const stickerBuf = await downloadMediaMessage(targetMedia, 'buffer', {});
                    const audioMediaObj = { key: msg.key, message: { audioMessage: stickerObj.audioMessage } };
                    const audioBuf = await downloadMediaMessage(audioMediaObj, 'buffer', {});
                    fs.writeFileSync(tempAudioIn, audioBuf);

                    const duration = stickerObj.audioMessage.seconds || 10;
                    await renderAudioM4a(tempAudioIn, tempAudioOut, duration, parsedVol.filter);

                    const uploadedSticker = await prepareWAMessageMedia(
                        { sticker: stickerBuf },
                        { upload: sock.waUploadToServer }
                    );

                    const uploadedAudio = await prepareWAMessageMedia(
                        {
                            audio: fs.readFileSync(tempAudioOut),
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
                } catch (err) {
                    await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                    await sock.sendMessage(remoteJid, { text: `Error .vol stiker: ${err.message}` }, { quoted: msg });
                } finally {
                    if (fs.existsSync(tempAudioIn)) fs.unlinkSync(tempAudioIn);
                    if (fs.existsSync(tempAudioOut)) fs.unlinkSync(tempAudioOut);
                }
                return;
            }

            if (isVideo && !isSticker) {
                const tempVidIn = path.join(__dirname, `vol_vid_in_${stamp}.mp4`);
                const tempVidOut = path.join(__dirname, `vol_vid_out_${stamp}.mp4`);

                try {
                    const vidBuf = await downloadMediaMessage(targetMedia, 'buffer', {});
                    fs.writeFileSync(tempVidIn, vidBuf);

                    await renderVideoVolume(tempVidIn, tempVidOut, parsedVol.filter);

                    await sock.sendMessage(
                        remoteJid,
                        {
                            video: fs.readFileSync(tempVidOut),
                            caption: `🔊 Volume diubah ke *${parsedVol.label}*`
                        },
                        { quoted: msg }
                    );
                    await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
                } catch (err) {
                    await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                    await sock.sendMessage(remoteJid, { text: `Error .vol video: ${err.message}` }, { quoted: msg });
                } finally {
                    if (fs.existsSync(tempVidIn)) fs.unlinkSync(tempVidIn);
                    if (fs.existsSync(tempVidOut)) fs.unlinkSync(tempVidOut);
                }
                return;
            }
        }

        // === PERINTAH .wm (UBAH WATERMARK PACK & AUTHOR STIKER) ===
        if (baseCmd === '.wm') {
            if (!isSticker || !targetMedia) {
                await sock.sendMessage(
                    remoteJid,
                    { text: '⚠️ Balas stiker yang ingin diubah namanya.\nContoh: *.wm Koleksi Saya | Budi*' },
                    { quoted: msg }
                );
                return;
            }

            const rawWm = caption.slice(parts[0].length).trim();
            if (!rawWm) {
                await sock.sendMessage(
                    remoteJid,
                    { text: '⚠️ Masukkan nama pack. Contoh: *.wm Nama Pack | Nama Pembuat*' },
                    { quoted: msg }
                );
                return;
            }

            const [packRaw, authorRaw] = rawWm.split('|').map((s) => s.trim());
            const packName = packRaw || 'Sound Stickers';
            const authorName = authorRaw || 'BotWA';

            try {
                await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });
                const stickerBuf = await downloadMediaMessage(targetMedia, 'buffer', {});
                const updatedSticker = addStickerExif(stickerBuf, packName, authorName);

                if (hasEmbeddedAudio) {
                    const audioMediaObj = { key: msg.key, message: { audioMessage: stickerObj.audioMessage } };
                    const audioBuf = await downloadMediaMessage(audioMediaObj, 'buffer', {});

                    const uploadedSticker = await prepareWAMessageMedia(
                        { sticker: updatedSticker },
                        { upload: sock.waUploadToServer }
                    );
                    const uploadedAudio = await prepareWAMessageMedia(
                        {
                            audio: audioBuf,
                            mimetype: 'audio/mp4',
                            ptt: false,
                            seconds: stickerObj.audioMessage.seconds || 10
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
                } else {
                    await sock.sendMessage(remoteJid, { sticker: updatedSticker }, { quoted: msg });
                }

                await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
            } catch (err) {
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                await sock.sendMessage(remoteJid, { text: `Error .wm: ${err.message}` }, { quoted: msg });
            }
            return;
        }

        // === PERINTAH .toimg (STIKER STATIS KE GAMBAR PNG) ===
        if (baseCmd === '.toimg') {
            if (!isSticker || !targetMedia || isVideo) {
                await sock.sendMessage(
                    remoteJid,
                    { text: '⚠️ Balas stiker biasa (tidak bergerak) dengan perintah *.toimg*.' },
                    { quoted: msg }
                );
                return;
            }

            const stamp = Date.now();
            const tempWebp = path.join(__dirname, `toimg_${stamp}.webp`);
            const tempPng = path.join(__dirname, `toimg_${stamp}.png`);

            try {
                await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });
                const buf = await downloadMediaMessage(targetMedia, 'buffer', {});
                fs.writeFileSync(tempWebp, buf);

                await convertWebpToPng(tempWebp, tempPng);
                await sock.sendMessage(remoteJid, { image: fs.readFileSync(tempPng) }, { quoted: msg });
                await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
            } catch (err) {
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                await sock.sendMessage(remoteJid, { text: `Error .toimg: ${err.message}` }, { quoted: msg });
            } finally {
                if (fs.existsSync(tempWebp)) fs.unlinkSync(tempWebp);
                if (fs.existsSync(tempPng)) fs.unlinkSync(tempPng);
            }
            return;
        }

        // === PERINTAH .tomp3 (EKSTRAK AUDIO DARI VIDEO / SOUND STICKER) ===
        if (baseCmd === '.tomp3' || baseCmd === '.toaudio') {
            if (!targetMedia || (!isVideo && !hasEmbeddedAudio)) {
                await sock.sendMessage(
                    remoteJid,
                    { text: '⚠️ Balas video atau *Sound Sticker* untuk diambil audionya.' },
                    { quoted: msg }
                );
                return;
            }

            const stamp = Date.now();
            const tempIn = path.join(__dirname, `tomp3_in_${stamp}.mp4`);
            const tempMp3 = path.join(__dirname, `tomp3_out_${stamp}.mp3`);

            try {
                await sock.sendMessage(remoteJid, { react: { text: '⏳', key: msg.key } });

                let buf;
                if (isSticker && hasEmbeddedAudio) {
                    const audioMediaObj = { key: msg.key, message: { audioMessage: stickerObj.audioMessage } };
                    buf = await downloadMediaMessage(audioMediaObj, 'buffer', {});
                } else {
                    buf = await downloadMediaMessage(targetMedia, 'buffer', {});
                }

                fs.writeFileSync(tempIn, buf);
                await renderAudioMp3(tempIn, tempMp3, volumeFilter);

                await sock.sendMessage(
                    remoteJid,
                    {
                        audio: fs.readFileSync(tempMp3),
                        mimetype: 'audio/mpeg',
                        ptt: false
                    },
                    { quoted: msg }
                );
                await sock.sendMessage(remoteJid, { react: { text: '✅', key: msg.key } });
            } catch (err) {
                await sock.sendMessage(remoteJid, { react: { text: '❌', key: msg.key } });
                await sock.sendMessage(remoteJid, { text: `Error .tomp3: ${err.message}` }, { quoted: msg });
            } finally {
                if (fs.existsSync(tempIn)) fs.unlinkSync(tempIn);
                if (fs.existsSync(tempMp3)) fs.unlinkSync(tempMp3);
            }
            return;
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
