import dotenv from 'dotenv';
import express from 'express';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ffmpegStatic from 'ffmpeg-static';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const publicDir = path.join(rootDir, 'public');
const runtimeDir = path.join(rootDir, '.runtime');
const logsDir = path.join(rootDir, 'logs');
const overlayFont = process.env.OVERLAY_FONT || 'C:/Windows/Fonts/arial.ttf';
const defaultLogoPath = path.join(rootDir, 'bvxa.png');
const defaultLogoSourcePath = process.env.LOGO_PATH || (existsSync(defaultLogoPath) ? defaultLogoPath : path.join(publicDir, 'logo.png'));
const logoOverlayPath = path.join(runtimeDir, 'logo-overlay.png');
const settingsPath = path.join(runtimeDir, 'settings.json');
const logoOverlayWidth = Number(process.env.LOGO_WIDTH || 120);
const logoOverlayVersion = 'rgba-v2';

loadEnvironment();

const app = express();
const port = Number(process.env.PORT || 8788);
let ffmpegBin = process.env.FFMPEG_PATH || ffmpegStatic || 'ffmpeg';

const googleClientId = process.env.GOOGLE_CLIENT_ID;
const googleClientSecret = process.env.GOOGLE_CLIENT_SECRET;
const googleRedirectUri = process.env.GOOGLE_REDIRECT_URI || `http://localhost:${port}/auth/callback`;
const tokenPath = path.join(rootDir, '.tokens.json');
const youtubeScopes = [
  'https://www.googleapis.com/auth/youtube',
  'https://www.googleapis.com/auth/userinfo.profile',
  'https://www.googleapis.com/auth/userinfo.email',
];

let googleApi = null;
let oauth2Client = null;
let youtubeClient = null;
let oauthUser = null;
let currentBroadcast = null;

const PRESETS = {
  consultation: { name: 'Tư vấn', width: 1280, height: 720, fps: 30, bitrate: 2000 },
  surgery: { name: 'Phẫu thuật', width: 1920, height: 1080, fps: 60, bitrate: 5000 },
};

const ENCODERS = {
  auto: { label: 'Auto GPU nếu có' },
  h264_nvenc: { label: 'NVIDIA NVENC' },
  h264_qsv: { label: 'Intel Quick Sync' },
  h264_amf: { label: 'AMD AMF' },
  libx264: { label: 'CPU libx264' },
};

let streamProc = null;
let currentConfig = null;
let startedAt = null;
let lastError = '';
let lastLog = '';
let currentLogPath = null;
let currentLogName = null;
let lastStats = {};
let lastPreviewFrame = null;
let lastPreviewAt = null;
let lastAudio = { rmsDb: null, peakDb: null, level: 0, updatedAt: null };
let stoppingStream = false;
let desiredStreaming = false;
let restartingStream = false;
let restartTimer = null;
let restartCount = 0;
let lastRestartReason = '';
let encoderCache = null;
let gpuNameCache = null;
let previewBuffer = Buffer.alloc(0);
let audioBuffer = Buffer.alloc(0);
const videoOptionsCache = new Map();
const maxAutoRestarts = 5;
const FRAME_STALL_MS = 15_000;
const STARTUP_TIMEOUT_MS = 20_000;
const DEVICE_POLL_MS = 3_000;
const CMD_TIMEOUT_MS = 30_000;
const RTMP_RW_TIMEOUT_US = 15_000_000;
const LOG_MAX_BYTES = 100 * 1024 * 1024;

let lastFrameTime = null;
let frameWatchdogInterval = null;
let startupWatchdogTimer = null;
let waitingForDevice = false;
let deviceWatchdogInterval = null;
let devicePollActive = false;
let currentLogSize = 0;

app.use(express.json({ limit: '128kb' }));
app.use(express.static(publicDir));

app.get('/api/devices', async (_req, res) => {
  try {
    const [devices, encoders] = await Promise.all([listDirectShowDevices(), listAvailableEncoders()]);
    res.json({ ok: true, devices, encoders, ffmpeg: ffmpegBin });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/status', (_req, res) => {
  res.json(getStatus());
});

app.get('/api/preview.jpg', (_req, res) => {
  if (!lastPreviewFrame) return res.status(204).end();
  res.set({
    'Content-Type': 'image/jpeg',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    'Pragma': 'no-cache',
    'Expires': '0',
  });
  res.end(lastPreviewFrame);
});

app.get('/overlay-logo.png', async (_req, res) => {
  try {
    const logoPath = await prepareLogoOverlay();
    if (!logoPath) return res.status(404).end();
    res.sendFile(logoPath);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/meter', (_req, res) => {
  res.json({
    running: !!streamProc,
    audio: lastAudio,
    preview: {
      available: !!lastPreviewFrame,
      updatedAt: lastPreviewAt,
    },
  });
});

app.get('/auth/status', (_req, res) => {
  res.json({
    configured: !!oauth2Client,
    authenticated: !!oauthUser,
    user: oauthUser,
    redirectUri: oauth2Client ? googleRedirectUri : null,
  });
});

app.get('/auth/login', (req, res) => {
  if (!oauth2Client) return res.status(500).json({ error: 'OAuth chưa cấu hình. Kiểm tra .env.' });
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: youtubeScopes,
  });
  res.redirect(url);
});

app.get('/auth/callback', async (req, res) => {
  const { code, error } = req.query;
  if (error) return res.status(400).send(`OAuth denied: ${escapeHtml(error)}`);
  if (!code) return res.status(400).send('Missing authorization code');

  try {
    if (!oauth2Client) throw new Error('OAuth chưa cấu hình.');
    const google = await getGoogleApi();
    const { tokens } = await oauth2Client.getToken(String(code));
    oauth2Client.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
    const { data } = await oauth2.userinfo.get();
    oauthUser = { name: data.name, email: data.email, picture: data.picture };
    youtubeClient = google.youtube({ version: 'v3', auth: oauth2Client });
    saveTokens(oauth2Client.credentials);

    res.send(renderOAuthCallbackPage(oauthUser));
  } catch (err) {
    console.error('[OAuth] Callback error:', err.message);
    res.status(500).send(`<p>Lỗi OAuth: ${escapeHtml(err.message)}</p>`);
  }
});

app.post('/auth/logout', async (_req, res) => {
  if (oauth2Client) {
    try { await oauth2Client.revokeCredentials(); } catch {}
    oauth2Client.setCredentials({});
  }
  oauthUser = null;
  youtubeClient = null;
  currentBroadcast = null;
  clearTokens();
  res.json({ ok: true });
});

app.post('/api/create-broadcast', async (req, res) => {
  if (!youtubeClient) return res.status(401).json({ ok: false, error: 'Chưa đăng nhập YouTube OAuth.' });

  const title = String(req.body.title || 'SangLive Stream').trim();
  const description = String(req.body.description || 'Livestream bởi SangLive').trim();
  const privacyStatus = pickString(req.body.privacyStatus, ['public', 'unlisted', 'private'], 'unlisted');
  const latencyPreference = pickString(req.body.latencyPreference, ['normal', 'low', 'ultraLow'], 'low');
  const videoConfig = normalizeVideoConfig(req.body.videoConfig || req.body);

  try {
    const broadcast = await youtubeClient.liveBroadcasts.insert({
      part: 'snippet,status,contentDetails',
      requestBody: {
        snippet: {
          title,
          description,
          scheduledStartTime: new Date().toISOString(),
        },
        status: {
          privacyStatus,
          selfDeclaredMadeForKids: false,
        },
        contentDetails: {
          enableAutoStart: true,
          enableAutoStop: true,
          latencyPreference,
          enableDvr: latencyPreference !== 'ultraLow',
        },
      },
    });

    const liveStream = await youtubeClient.liveStreams.insert({
      part: 'snippet,cdn',
      requestBody: {
        snippet: { title: `${title} - Stream` },
        cdn: {
          ingestionType: 'rtmp',
          frameRate: videoConfig.fps > 30 ? '60fps' : '30fps',
          resolution: getYoutubeResolution(videoConfig.height),
        },
      },
    });

    await youtubeClient.liveBroadcasts.bind({
      id: broadcast.data.id,
      part: 'id,contentDetails',
      streamId: liveStream.data.id,
    });

    const info = liveStream.data.cdn.ingestionInfo || {};
    currentBroadcast = {
      broadcastId: broadcast.data.id,
      streamId: liveStream.data.id,
    };

    res.json({
      ok: true,
      streamKey: info.streamName,
      rtmpUrl: info.ingestionAddress,
      broadcastId: broadcast.data.id,
      watchUrl: `https://www.youtube.com/watch?v=${broadcast.data.id}`,
    });
  } catch (err) {
    console.error('[YouTube] Create broadcast error:', err.response?.data || err.message);
    const message = err.response?.data?.error?.message || err.message;
    res.status(500).json({ ok: false, error: message });
  }
});

app.post('/api/end-broadcast', async (_req, res) => {
  if (!youtubeClient || !currentBroadcast) return res.json({ ok: true });

  try {
    await youtubeClient.liveBroadcasts.transition({
      id: currentBroadcast.broadcastId,
      broadcastStatus: 'complete',
      part: 'id,status',
    });
  } catch (err) {
    console.warn('[YouTube] End broadcast:', err.message);
  }

  currentBroadcast = null;
  res.json({ ok: true });
});

app.get('/api/settings', (_req, res) => {
  try {
    if (!existsSync(settingsPath)) return res.json({ ok: true, settings: {} });
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    res.json({ ok: true, settings });
  } catch {
    res.json({ ok: true, settings: {} });
  }
});

app.post('/api/settings', (req, res) => {
  try {
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(req.body || {}, null, 2), 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.get('/api/logo-status', (_req, res) => {
  const customPath = findCustomLogoPath();
  const hasCustom = !!customPath;
  const hasAny = !!getActiveLogoSourcePath();
  res.json({ hasCustom, hasAny, version: Date.now() });
});

app.post('/api/upload-logo', express.raw({ type: /^image\//, limit: '5mb' }), (req, res) => {
  try {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw new Error('File không hợp lệ.');
    const ct = String(req.headers['content-type'] || '');
    const ext = ct.includes('png') ? '.png' : ct.includes('jpeg') ? '.jpg' : ct.includes('gif') ? '.gif' : ct.includes('webp') ? '.webp' : '.png';
    mkdirSync(runtimeDir, { recursive: true });
    for (const e of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
      try { unlinkSync(path.join(runtimeDir, `custom-logo${e}`)); } catch {}
    }
    writeFileSync(path.join(runtimeDir, `custom-logo${ext}`), req.body);
    invalidateLogoCache();
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.delete('/api/upload-logo', (_req, res) => {
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
    try { unlinkSync(path.join(runtimeDir, `custom-logo${ext}`)); } catch {}
  }
  invalidateLogoCache();
  res.json({ ok: true });
});

app.post('/api/validate-config', async (req, res) => {
  try {
    await normalizeStartConfig({ ...req.body, streamKey: req.body.streamKey || 'validate-only' });
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/start', async (req, res) => {
  if (desiredStreaming || streamProc) {
    return res.status(409).json({ ok: false, error: 'Đang live. Hãy dừng stream trước.' });
  }

  try {
    const config = await normalizeStartConfig(req.body || {});
    desiredStreaming = true;
    restartingStream = false;
    restartCount = 0;
    lastRestartReason = '';
    lastError = '';
    lastLog = '';
    lastStats = {};
    currentConfig = config;
    startedAt = Date.now();
    beginLiveLog(config);
    appendLiveLog('START', {
      ffmpeg: ffmpegBin,
      config: publicConfig(config),
    });

    const args = await startStreamProcess(config, 'initial');
    appendLiveLog('FFMPEG_ARGS', hideStreamKey(args).join(' '));

    res.json({ ok: true, status: getStatus(), argsPreview: hideStreamKey(args) });
  } catch (err) {
    desiredStreaming = false;
    restartingStream = false;
    startedAt = null;
    appendLiveLog('START_FAILED', { error: err.message });
    res.status(400).json({ ok: false, error: err.message });
  }
});

app.post('/api/stop', (_req, res) => {
  stopStream();
  res.json({ ok: true, status: getStatus() });
});

app.get('*', (_req, res) => {
  res.sendFile(path.join(publicDir, 'index.html'));
});

const server = app.listen(port, () => {
  console.log(`[SangLive] running at http://localhost:${port}`);
  console.log(`[SangLive] FFmpeg: ${ffmpegBin}`);
});

await initGoogleAuth();
await preferSystemFfmpegForDirectShow();

function getStatus() {
  const active = desiredStreaming && (!!streamProc || restartingStream || waitingForDevice);
  return {
    running: active,
    backendRunning: !!streamProc,
    restarting: restartingStream,
    waitingForDevice,
    restartCount,
    lastRestartReason,
    startedAt,
    elapsedSeconds: startedAt ? Math.floor((Date.now() - startedAt) / 1000) : 0,
    config: currentConfig ? publicConfig(currentConfig) : null,
    stats: lastStats,
    audio: lastAudio,
    preview: {
      available: !!lastPreviewFrame,
      updatedAt: lastPreviewAt,
    },
    lastError,
    lastLog: lastLog.slice(-4000),
    logFile: currentLogPath,
    logName: currentLogName,
  };
}

async function normalizeStartConfig(body) {
  const preset = PRESETS[body.preset] ? body.preset : 'consultation';
  const base = PRESETS[preset];
  const custom = body.preset === 'custom';
  const width = custom ? pickNumber(body.width, [854, 1280, 1920], base.width) : base.width;
  const height = custom ? pickNumber(body.height, [480, 720, 1080], base.height) : base.height;
  const fps = custom ? pickNumber(body.fps, [25, 30, 50, 60], base.fps) : base.fps;
  const bitrate = custom ? clamp(Number(body.bitrate || base.bitrate), 1000, 12000) : base.bitrate;

  const devices = await listDirectShowDevices();
  const videoDevice = pickDeviceOrFirst(body.videoDevice, devices.video);
  const audioDevice = pickDeviceOrFirst(body.audioDevice, devices.audio);
  const streamKey = String(body.streamKey || '').trim();
  const rtmpUrl = String(body.rtmpUrl || '').trim();
  const requestedEncoder = ENCODERS[body.encoder] ? body.encoder : 'auto';
  const encoder = requestedEncoder === 'auto' ? await chooseAutoEncoder() : requestedEncoder;
  const overlay = normalizeOverlay(body);

  if (!videoDevice) throw new Error('Không tìm thấy camera DirectShow trên máy này.');
  if (!streamKey && !rtmpUrl) throw new Error('Chưa nhập YouTube stream key hoặc RTMP URL.');
  if (!streamKey && /\/live2\/?$/i.test(rtmpUrl)) throw new Error('RTMP URL đang là base URL. Hãy nhập thêm stream key.');
  if (width / height < 1.6 || width / height > 1.9) throw new Error('Độ phân giải không hợp lệ.');

  await assertVideoModeSupported(videoDevice, width, height, fps);

  return {
    preset,
    width,
    height,
    fps,
    bitrate,
    videoDevice,
    audioDevice,
    streamKey,
    rtmpUrl,
    encoder,
    requestedEncoder,
    overlay,
  };
}

function pickDeviceOrFirst(value, devices) {
  const requested = String(value || '').trim();
  if (requested && devices.some(device => device.name === requested)) return requested;
  if (requested && !devices.length) return requested;
  return devices[0]?.name || '';
}

async function buildFfmpegArgs(config) {
  const outputUrl = resolveOutputUrl(config);
  const inputName = config.audioDevice
    ? `video=${config.videoDevice}:audio=${config.audioDevice}`
    : `video=${config.videoDevice}`;
  const hasAudio = !!config.audioDevice;
  const overlayFiles = writeOverlayFiles(config.overlay);
  const preparedLogoPath = await prepareLogoOverlay();
  const logoInputIndex = preparedLogoPath ? (hasAudio ? 1 : 2) : null;
  const overlayFilter = buildOverlayFilter('vbase', 'voverlay', config.width, config.height, overlayFiles, config.overlay, logoInputIndex);
  const videoFilter = `[0:v:0]scale=${config.width}:${config.height}:flags=fast_bilinear,format=yuv420p[vbase];${overlayFilter};[voverlay]format=yuv420p,split=2[vmain][vpreviewraw];[vpreviewraw]fps=20,scale=640:-2:flags=fast_bilinear,format=yuvj420p[vpreview]`;
  const audioFilter = hasAudio
    ? `[0:a:0]asplit=2[amain][ameter]`
    : `[1:a:0]asplit=2[amain][ameter]`;

  const args = [
    '-hide_banner',
    '-nostdin',
    '-loglevel', 'info',
    '-stats',
    '-f', 'dshow',
    '-thread_queue_size', '1024',
    '-rtbufsize', '512M',
    '-video_size', `${config.width}x${config.height}`,
    '-framerate', String(config.fps),
  ];

  if (hasAudio) args.push('-audio_buffer_size', '200');
  args.push('-i', inputName);

  if (!hasAudio) {
    args.push('-f', 'lavfi', '-i', 'anullsrc=channel_layout=stereo:sample_rate=48000');
  }

  if (preparedLogoPath) {
    args.push('-loop', '1', '-i', preparedLogoPath);
  }

  args.push(
    '-filter_complex', `${videoFilter};${audioFilter}`,
    '-map', '[vmain]',
    '-map', '[amain]',
    '-r', String(config.fps),
    '-g', String(config.fps * 2),
    '-keyint_min', String(config.fps * 2),
    '-sc_threshold', '0',
    ...encoderArgs(config.encoder, config.bitrate),
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '48000',
    '-ac', '2',
    '-rw_timeout', String(RTMP_RW_TIMEOUT_US),
    '-f', 'flv',
    outputUrl,
    '-map', '[vpreview]',
    '-an',
    '-c:v', 'mjpeg',
    '-q:v', '5',
    '-f', 'image2pipe',
    'pipe:1',
    '-map', '[ameter]',
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-f', 's16le',
    'pipe:3',
  );

  return args;
}

async function startStreamProcess(config, reason) {
  if (!desiredStreaming) throw new Error('Stream đã dừng.');
  stopFrameWatchdog();
  stopDeviceWatchdog();
  if (startupWatchdogTimer) { clearTimeout(startupWatchdogTimer); startupWatchdogTimer = null; }
  lastFrameTime = null;
  waitingForDevice = false;
  const args = await buildFfmpegArgs(config);
  previewBuffer = Buffer.alloc(0);
  audioBuffer = Buffer.alloc(0);
  lastPreviewFrame = null;
  lastPreviewAt = null;
  lastAudio = { rmsDb: null, peakDb: null, level: 0, updatedAt: null };
  currentConfig = config;
  restartingStream = false;
  if (restartCount > 0) lastError = '';

  console.log(`[SangLive] Starting ${config.width}x${config.height}@${config.fps} ${config.bitrate}kbps encoder=${config.encoder} reason=${reason}`);
  appendLiveLog('SPAWN', { reason, encoder: config.encoder, restartCount });
  streamProc = spawn(ffmpegBin, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
  attachStreamProcessHandlers(streamProc, config);

  startupWatchdogTimer = setTimeout(() => {
    startupWatchdogTimer = null;
    if (!desiredStreaming || !streamProc || lastFrameTime != null) return;
    appendLiveLog('STARTUP_TIMEOUT', { device: config.videoDevice });
    lastRestartReason = 'startup-timeout';
    try { streamProc?.kill('SIGKILL'); } catch {}
  }, STARTUP_TIMEOUT_MS);

  return args;
}

function attachStreamProcessHandlers(proc, config) {
  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString();
    const visibleText = filterFfmpegLogText(maskSensitiveLogText(text));
    if (visibleText) {
      lastLog = trimLog(lastLog + visibleText);
      appendLiveLogRaw(visibleText);
    }
    const stats = parseFfmpegStats(text);
    if (stats) lastStats = { ...lastStats, ...stats };

    if (isRecoverableFfmpegLog(text)) {
      lastRestartReason = getRecoverableReason(text);
    }

    if (/error|fail|invalid|not found|cannot|could not|unsupported/i.test(visibleText) && !isBenignFfmpegLog(visibleText)) {
      lastError = trimLog(visibleText).slice(-1200);
    }
  });

  proc.stdout.on('data', handlePreviewChunk);
  proc.stdio[3]?.on('data', handleAudioChunk);

  proc.on('error', (err) => {
    if (streamProc === proc) streamProc = null;
    lastError = err.message;
    appendLiveLog('PROCESS_ERROR', { error: err.message });
    handleProcessExit(1, config, err.message).catch(e => console.error('[SangLive] handleProcessExit error:', e));
  });

  proc.on('close', (code) => {
    console.log(`[SangLive] FFmpeg exited code=${code}`);
    appendLiveLog('PROCESS_CLOSE', { code, stoppingStream, desiredStreaming, restartCount });
    if (streamProc === proc) streamProc = null;
    handleProcessExit(code, config, lastRestartReason || lastError).catch(e => console.error('[SangLive] handleProcessExit error:', e));
  });
}

async function handleProcessExit(code, config, reasonText = '') {
  if (startupWatchdogTimer) { clearTimeout(startupWatchdogTimer); startupWatchdogTimer = null; }
  stopFrameWatchdog();

  if (stoppingStream || !desiredStreaming) {
    appendLiveLog('STOPPED', { code, reason: 'requested-or-not-desired' });
    stoppingStream = false;
    desiredStreaming = false;
    restartingStream = false;
    waitingForDevice = false;
    startedAt = null;
    stopDeviceWatchdog();
    clearPreviewAndMeter();
    return;
  }

  if (code === 0) {
    appendLiveLog('STOPPED', { code, reason: 'ffmpeg-exit-zero' });
    desiredStreaming = false;
    restartingStream = false;
    waitingForDevice = false;
    startedAt = null;
    stopDeviceWatchdog();
    clearPreviewAndMeter();
    return;
  }

  // Device disconnect path: check if camera is still present
  if (isDeviceDisconnectLog(reasonText)) {
    try {
      videoOptionsCache.delete(config.videoDevice);
      const devices = await listDirectShowDevices();
      if (!devices.video.some(d => d.name === config.videoDevice)) {
        startDeviceWatchdog(config);
        return;
      }
    } catch {}
    // Device still present but stalled — fall through to normal restart
  }

  const nextConfig = getRecoveryConfig(config, reasonText);
  if (!nextConfig || restartCount >= maxAutoRestarts) {
    appendLiveLog('FAILED', { code, reason: reasonText, restartCount, lastError });
    desiredStreaming = false;
    restartingStream = false;
    waitingForDevice = false;
    startedAt = null;
    if (!lastError) lastError = `FFmpeg đã dừng với code ${code}`;
    clearPreviewAndMeter();
    return;
  }

  restartCount += 1;
  restartingStream = true;
  currentConfig = nextConfig;
  lastRestartReason = getRecoverableReason(reasonText) || `FFmpeg exit code ${code}`;
  lastError = `FFmpeg lỗi (${lastRestartReason}). Đang tự khởi động lại (${restartCount}/${maxAutoRestarts}) bằng encoder ${nextConfig.encoder}.`;
  appendLiveLog('RESTART', {
    code,
    reason: lastRestartReason,
    restartCount,
    nextEncoder: nextConfig.encoder,
  });

  if (restartTimer) clearTimeout(restartTimer);
  restartTimer = setTimeout(async () => {
    restartTimer = null;
    try {
      await startStreamProcess(nextConfig, lastRestartReason || 'restart');
    } catch (err) {
      lastError = err.message;
      desiredStreaming = false;
      restartingStream = false;
      startedAt = null;
      clearPreviewAndMeter();
    }
  }, 1200);
}

function startFrameWatchdog(videoDevice) {
  stopFrameWatchdog();
  frameWatchdogInterval = setInterval(() => {
    if (!desiredStreaming || !streamProc || waitingForDevice) return;
    if (lastFrameTime == null) return;
    const stall = Date.now() - lastFrameTime;
    if (stall > FRAME_STALL_MS) {
      appendLiveLog('FRAME_STALL_KILL', { stallMs: stall, device: videoDevice });
      lastRestartReason = 'frame-stall';
      try { streamProc?.kill('SIGKILL'); } catch {}
    }
  }, 5000);
}

function stopFrameWatchdog() {
  if (frameWatchdogInterval) { clearInterval(frameWatchdogInterval); frameWatchdogInterval = null; }
}

function startDeviceWatchdog(config) {
  stopDeviceWatchdog();
  waitingForDevice = true;
  restartingStream = false;
  lastError = `Camera "${config.videoDevice}" bị ngắt kết nối. Đang chờ thiết bị trở lại...`;
  appendLiveLog('DEVICE_WATCHDOG_START', { device: config.videoDevice });

  deviceWatchdogInterval = setInterval(async () => {
    if (!desiredStreaming || !waitingForDevice) { stopDeviceWatchdog(); return; }
    if (devicePollActive) return;
    devicePollActive = true;
    try {
      videoOptionsCache.delete(config.videoDevice);
      const devices = await listDirectShowDevices();
      if (devices.video.some(d => d.name === config.videoDevice)) {
        appendLiveLog('DEVICE_RECONNECTED', { device: config.videoDevice });
        stopDeviceWatchdog();
        waitingForDevice = false;
        lastError = '';
        lastFrameTime = null;
        await startStreamProcess(config, 'device-reconnect');
      }
    } catch (err) {
      appendLiveLog('DEVICE_POLL_ERROR', { error: err.message });
    } finally {
      devicePollActive = false;
    }
  }, DEVICE_POLL_MS);
}

function stopDeviceWatchdog() {
  if (deviceWatchdogInterval) { clearInterval(deviceWatchdogInterval); deviceWatchdogInterval = null; }
  devicePollActive = false;
  waitingForDevice = false;
}

function getRecoveryConfig(config, reasonText) {
  if (!isRecoverableFfmpegLog(reasonText)) return null;
  const fallbackEncoder = getFallbackEncoder(config.encoder);
  return {
    ...config,
    encoder: fallbackEncoder || config.encoder,
    requestedEncoder: config.requestedEncoder === 'auto' ? 'auto' : `${config.requestedEncoder || config.encoder}-fallback`,
  };
}

function getFallbackEncoder(encoder) {
  if (encoder === 'libx264') return null;
  return 'libx264';
}

function encoderArgs(encoder, bitrate) {
  const common = ['-b:v', `${bitrate}k`, '-maxrate', `${Math.round(bitrate * 1.25)}k`, '-bufsize', `${bitrate * 4}k`];
  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p3', '-tune', 'll', '-rc', 'cbr', '-bf', '0', ...common];
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'veryfast', '-look_ahead', '0', '-async_depth', '1', ...common];
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-usage', 'ultralowlatency', '-quality', 'speed', ...common];
    default:
      return ['-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-profile:v', 'high', ...common];
  }
}

async function chooseAutoEncoder() {
  const [available, gpuNames] = await Promise.all([listAvailableEncoders(), getGpuNames()]);
  const gpuText = gpuNames.join(' ');
  if (/nvidia/i.test(gpuText) && available.some(e => e.id === 'h264_nvenc')) return 'h264_nvenc';
  if (/(amd|radeon)/i.test(gpuText) && available.some(e => e.id === 'h264_amf')) return 'h264_amf';
  return 'libx264';
}

async function listAvailableEncoders() {
  if (encoderCache) return encoderCache;
  const output = await runAndCollect(ffmpegBin, ['-hide_banner', '-encoders'], { allowNonZero: true });
  const text = output.stderr + output.stdout;
  const ids = Object.keys(ENCODERS).filter(id => id === 'auto' || text.includes(id));
  if (!ids.includes('libx264')) ids.push('libx264');
  encoderCache = ids.map(id => ({ id, label: ENCODERS[id]?.label || id }));
  return encoderCache;
}

async function listDirectShowDevices() {
  const output = await runAndCollect(ffmpegBin, ['-hide_banner', '-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'], { allowNonZero: true });
  return parseDirectShowDevices(output.stderr + output.stdout);
}

async function preferSystemFfmpegForDirectShow() {
  if (process.env.FFMPEG_PATH) return;
  try {
    const current = await runAndCollect(ffmpegBin, ['-hide_banner', '-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'], { allowNonZero: true });
    const currentText = current.stderr + current.stdout;
    if (hasDirectShowDeviceOutput(currentText)) return;
  } catch {}

  try {
    const system = await runAndCollect('ffmpeg', ['-hide_banner', '-f', 'dshow', '-list_devices', 'true', '-i', 'dummy'], { allowNonZero: true });
    const systemText = system.stderr + system.stdout;
    if (hasDirectShowDeviceOutput(systemText)) {
      ffmpegBin = 'ffmpeg';
      encoderCache = null;
      console.log('[SangLive] Switched to system FFmpeg for DirectShow support');
    }
  } catch {}
}

function parseDirectShowDevices(text) {
  const devices = { video: [], audio: [] };
  let type = null;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (/DirectShow video devices/i.test(line)) { type = 'video'; continue; }
    if (/DirectShow audio devices/i.test(line)) { type = 'audio'; continue; }
    const inline = line.match(/"([^"]+)"\s*\((video|audio)\)/i);
    if (inline) {
      const [, name, inlineType] = inline;
      const deviceType = inlineType.toLowerCase();
      if (!devices[deviceType].some(d => d.name === name)) devices[deviceType].push({ name, label: name });
      continue;
    }
    if (!type || /Alternative name/i.test(line)) continue;
    const match = line.match(/"([^"]+)"/);
    if (!match) continue;
    const name = match[1];
    if (!devices[type].some(d => d.name === name)) devices[type].push({ name, label: name });
  }
  return devices;
}

async function assertVideoModeSupported(videoDevice, width, height, fps) {
  const modes = await listVideoOptions(videoDevice);
  if (!modes.length) return;

  const supported = modes.some(mode => mode.width === width && mode.height === height && fps >= mode.minFps && fps <= mode.maxFps);
  if (supported) return;

  const suggestions = modes
    .filter((mode, index, all) => all.findIndex(item => item.width === mode.width && item.height === mode.height && item.maxFps === mode.maxFps) === index)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height) || b.maxFps - a.maxFps)
    .slice(0, 4)
    .map(mode => `${mode.width}x${mode.height}@${mode.maxFps}`)
    .join(', ');

  throw new Error(`Camera không hỗ trợ ${width}x${height}@${fps}. Mode hỗ trợ: ${suggestions || 'không đọc được danh sách mode'}.`);
}

async function listVideoOptions(videoDevice) {
  if (videoOptionsCache.has(videoDevice)) return videoOptionsCache.get(videoDevice);
  const output = await runAndCollect(ffmpegBin, ['-hide_banner', '-f', 'dshow', '-list_options', 'true', '-i', `video=${videoDevice}`], { allowNonZero: true });
  const modes = parseVideoOptions(output.stderr + output.stdout);
  videoOptionsCache.set(videoDevice, modes);
  return modes;
}

function parseVideoOptions(text) {
  const modes = [];
  const regex = /(?:pixel_format=\S+|vcodec=\S+)\s+min s=(\d+)x(\d+) fps=([\d.]+) max s=(\d+)x(\d+) fps=([\d.]+)/g;
  for (const match of text.matchAll(regex)) {
    const minWidth = Number(match[1]);
    const minHeight = Number(match[2]);
    const minFps = Number(match[3]);
    const maxWidth = Number(match[4]);
    const maxHeight = Number(match[5]);
    const maxFps = Number(match[6]);
    if (minWidth === maxWidth && minHeight === maxHeight) {
      modes.push({ width: maxWidth, height: maxHeight, minFps, maxFps });
    }
  }
  return modes;
}

function normalizeOverlay(body) {
  return {
    patientName: normalizeOverlayText(body.patientName, 120),
  };
}

function normalizeOverlayText(value, maxLength) {
  return String(value || '')
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .slice(0, maxLength);
}

function writeOverlayFiles(overlay) {
  mkdirSync(runtimeDir, { recursive: true });
  const patientPath = path.join(runtimeDir, 'overlay-patient.txt');
  writeFileSync(patientPath, overlay.patientName || ' ', 'utf8');
  return { patientPath };
}

function findCustomLogoPath() {
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp', '.gif']) {
    const p = path.join(runtimeDir, `custom-logo${ext}`);
    if (existsSync(p)) return p;
  }
  return null;
}

function getActiveLogoSourcePath() {
  return findCustomLogoPath() || (existsSync(defaultLogoSourcePath) ? defaultLogoSourcePath : null);
}

function invalidateLogoCache() {
  const markerPath = path.join(runtimeDir, 'logo-overlay.version');
  try { unlinkSync(markerPath); } catch {}
  try { unlinkSync(logoOverlayPath); } catch {}
}

async function prepareLogoOverlay() {
  const activeLogo = getActiveLogoSourcePath();
  if (!activeLogo) return null;
  mkdirSync(runtimeDir, { recursive: true });
  const markerPath = path.join(runtimeDir, 'logo-overlay.version');
  if (existsSync(logoOverlayPath) && existsSync(markerPath) && readFileSync(markerPath, 'utf8') === logoOverlayVersion) {
    return logoOverlayPath;
  }

  await runAndCollect(ffmpegBin, [
    '-hide_banner',
    '-y',
    '-i', activeLogo,
    '-vf', `scale=${logoOverlayWidth}:-1:flags=lanczos,format=rgba`,
    '-frames:v', '1',
    logoOverlayPath,
  ], { allowNonZero: false });

  writeFileSync(markerPath, logoOverlayVersion, 'utf8');

  return logoOverlayPath;
}

function buildOverlayFilter(inputLabel, outputLabel, width, height, files, overlay, logoInputIndex) {
  const scale = width / 1280;
  const patientFont = Math.max(16, Math.round(21 * scale));
  const logoX = Math.max(14, Math.round(24 * scale));
  const logoY = Math.max(10, Math.round(18 * scale));
  const bottomY = `h-th-${Math.max(8, Math.round(14 * scale))}`;
  const boxBorder = Math.max(4, Math.round(6 * scale));
  const filters = [];
  if (overlay.patientName) {
    filters.push(`drawtext=fontfile='${escapeFilterPath(overlayFont)}':textfile='${escapeFilterPath(files.patientPath)}':fontcolor=white:fontsize=${patientFont}:x=(w-text_w)/2:y=${bottomY}:box=1:boxcolor=black@0.48:boxborderw=${boxBorder}`);
  }

  const textOutput = logoInputIndex == null ? outputLabel : 'vtext';
  const textFilter = `[${inputLabel}]${filters.length ? filters.join(',') : 'null'}[${textOutput}]`;
  if (logoInputIndex == null) return textFilter;
  return `${textFilter};[${logoInputIndex}:v]format=rgba[vlogo];[${textOutput}][vlogo]overlay=${logoX}:${logoY}:format=auto:alpha=straight[${outputLabel}]`;
}

function escapeFilterPath(filePath) {
  return filePath.replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'");
}

function isBenignFfmpegLog(text) {
  return /Fontconfig error: Cannot load default config file/i.test(text)
    || /deprecated pixel format used/i.test(text)
    || isBenignFfmpegNoise(text);
}

function isBenignFfmpegNoise(text) {
  return /unable to decode APP fields/i.test(String(text || ''))
    || /Last message repeated \d+ times/i.test(String(text || ''));
}

function filterFfmpegLogText(text) {
  return String(text || '')
    .replace(/\r(?=\[mjpeg\b)/g, '\n')
    .replace(/\r(?=\s*Last message repeated\b)/g, '\n')
    .split(/\n/)
    .filter(line => !isBenignFfmpegNoise(line))
    .join('\n');
}

function isRecoverableFfmpegLog(text) {
  const s = String(text || '');
  return /Invalid FrameType|Error submitting video frame to the encoder|Error while filtering|too full or near too full|real-time buffer/i.test(s)
    || /Connection (refused|reset|timed? ?out)|Broken pipe|Network (unreachable|is down)/i.test(s)
    || /RTMP_Send|Failed to update header|rtmp.*connection/i.test(s)
    || /^(frame-stall|startup-timeout)$/.test(s);
}

function isDeviceDisconnectLog(text) {
  const s = String(text || '');
  return /^(frame-stall|startup-timeout)$/.test(s)
    || /Cannot open (video|audio) device|device.*not available|dshow.*fail|Error reading from.*capture/i.test(s)
    || /Input\/output error/i.test(s);
}

function getRecoverableReason(text) {
  const value = String(text || '');
  if (/Invalid FrameType|Error submitting video frame to the encoder/i.test(value)) return 'encoder hardware lỗi frame';
  if (/too full or near too full|real-time buffer/i.test(value)) return 'buffer camera/mic bị đầy';
  if (/Error while filtering/i.test(value)) return 'FFmpeg filter/encoder lỗi';
  if (/Connection (refused|reset|timed? ?out)|Broken pipe|Network (unreachable|is down)/i.test(value)) return 'mạng bị gián đoạn';
  if (/RTMP_Send|Failed to update header|rtmp.*connection/i.test(value)) return 'RTMP kết nối lỗi';
  if (value === 'frame-stall') return 'stream bị đứng hình (không có frame)';
  if (value === 'startup-timeout') return 'camera không phản hồi khi khởi động';
  return value ? value.slice(-180) : '';
}

function hasDirectShowDeviceOutput(text) {
  return /DirectShow .* devices/i.test(text) || /"[^"]+"\s*\((video|audio)\)/i.test(text);
}

async function getGpuNames() {
  if (gpuNameCache) return gpuNameCache;
  try {
    const output = await runAndCollect('powershell', [
      '-NoProfile',
      '-Command',
      'Get-CimInstance Win32_VideoController | Select-Object -ExpandProperty Name',
    ], { allowNonZero: true });
    gpuNameCache = (output.stdout || '').split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  } catch {
    gpuNameCache = [];
  }
  return gpuNameCache;
}

function runAndCollect(cmd, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;

    const ms = options.timeout ?? CMD_TIMEOUT_MS;
    const timer = ms > 0 ? setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch {}
      reject(new Error(`Timeout sau ${ms}ms: ${cmd}`));
    }, ms) : null;

    child.stdout.on('data', d => { stdout += d.toString(); });
    child.stderr.on('data', d => { stderr += d.toString(); });
    child.on('error', (err) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (code !== 0 && !options.allowNonZero) {
        reject(new Error(stderr || `Command failed: ${cmd} ${args.join(' ')}`));
      } else {
        resolve({ code, stdout, stderr });
      }
    });
  });
}

function parseFfmpegStats(text) {
  const frame = lastMatchNumber(text, /frame=\s*(\d+)/g);
  const fps = lastMatchNumber(text, /fps=\s*([\d.]+)/g);
  const bitrate = lastMatchNumber(text, /bitrate=\s*([\d.]+)kbits/g);
  const speed = lastMatchNumber(text, /speed=\s*([\d.]+)x/g);
  const time = lastMatch(text, /time=\s*([\d:.]+)/g);
  if (frame == null && fps == null && bitrate == null && speed == null && !time) return null;
  return { frame, fps, bitrate, speed, time };
}

function dbToLevel(db) {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

function handlePreviewChunk(chunk) {
  previewBuffer = Buffer.concat([previewBuffer, chunk]);

  while (previewBuffer.length > 4) {
    const start = previewBuffer.indexOf(Buffer.from([0xff, 0xd8]));
    if (start < 0) {
      previewBuffer = previewBuffer.subarray(Math.max(0, previewBuffer.length - 1));
      return;
    }

    if (start > 0) previewBuffer = previewBuffer.subarray(start);
    const end = previewBuffer.indexOf(Buffer.from([0xff, 0xd9]), 2);
    if (end < 0) {
      if (previewBuffer.length > 2_000_000) previewBuffer = previewBuffer.subarray(0, 2);
      return;
    }

    lastPreviewFrame = Buffer.from(previewBuffer.subarray(0, end + 2));
    lastPreviewAt = Date.now();
    previewBuffer = previewBuffer.subarray(end + 2);

    if (lastFrameTime == null) {
      if (startupWatchdogTimer) { clearTimeout(startupWatchdogTimer); startupWatchdogTimer = null; }
      startFrameWatchdog(currentConfig?.videoDevice);
    }
    lastFrameTime = Date.now();
  }
}

function handleAudioChunk(chunk) {
  audioBuffer = Buffer.concat([audioBuffer, chunk]);
  const sampleBytes = 2;
  const targetSamples = 1600;
  const targetBytes = targetSamples * sampleBytes;

  while (audioBuffer.length >= targetBytes) {
    const window = audioBuffer.subarray(0, targetBytes);
    audioBuffer = audioBuffer.subarray(targetBytes);

    let peak = 0;
    let sumSquares = 0;
    for (let offset = 0; offset < window.length; offset += sampleBytes) {
      const sample = window.readInt16LE(offset) / 32768;
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
      sumSquares += sample * sample;
    }

    const rms = Math.sqrt(sumSquares / targetSamples);
    const peakDb = amplitudeToDb(peak);
    const rmsDb = amplitudeToDb(rms);
    lastAudio = {
      rmsDb,
      peakDb,
      level: dbToLevel(peakDb),
      updatedAt: Date.now(),
    };
  }

  if (audioBuffer.length > targetBytes * 4) audioBuffer = audioBuffer.subarray(-targetBytes);
}

function amplitudeToDb(value) {
  if (!Number.isFinite(value) || value <= 0.000001) return -60;
  return Math.max(-60, Math.min(0, 20 * Math.log10(value)));
}

function lastMatchNumber(text, regex) {
  const value = lastMatch(text, regex);
  if (value == null) return null;
  if (/^-?inf$/i.test(value)) return -Infinity;
  if (/^nan$/i.test(value)) return NaN;
  return Number(value);
}

function lastMatch(text, regex) {
  let found = null;
  for (const match of text.matchAll(regex)) found = match[1];
  return found;
}

function stopStream() {
  appendLiveLog('STOP_REQUEST', { hadProcess: !!streamProc, restartCount });
  desiredStreaming = false;
  restartingStream = false;
  waitingForDevice = false;
  stopFrameWatchdog();
  stopDeviceWatchdog();
  if (startupWatchdogTimer) { clearTimeout(startupWatchdogTimer); startupWatchdogTimer = null; }
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  videoOptionsCache.clear();
  if (!streamProc) return;
  const proc = streamProc;
  stoppingStream = true;
  streamProc = null;
  startedAt = null;
  currentConfig = null;
  lastStats = {};
  lastLog = '';
  clearPreviewAndMeter();
  try { proc.kill('SIGTERM'); } catch {}
  setTimeout(() => {
    try { if (!proc.killed) proc.kill('SIGKILL'); } catch {}
  }, 2500);
}

function clearPreviewAndMeter() {
  lastAudio = { rmsDb: null, peakDb: null, level: 0, updatedAt: null };
  lastPreviewFrame = null;
  lastPreviewAt = null;
  previewBuffer = Buffer.alloc(0);
  audioBuffer = Buffer.alloc(0);
}

function beginLiveLog(config) {
  mkdirSync(logsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const safeDevice = sanitizeFilePart(config.videoDevice || 'camera');
  currentLogName = `live-${stamp}-${safeDevice}.log`;
  currentLogPath = path.join(logsDir, currentLogName);
  currentLogSize = 0;
  writeFileSync(currentLogPath, '', 'utf8');
}

function appendLiveLog(event, payload = '') {
  if (!currentLogPath) return;
  const line = `[${new Date().toISOString()}] ${event}${payload === '' ? '' : ` ${formatLogPayload(payload)}`}\n`;
  try {
    appendFileSync(currentLogPath, line, 'utf8');
  } catch (err) {
    console.warn('[Log] Failed to append live log:', err.message);
  }
}

function appendLiveLogRaw(text) {
  if (!currentLogPath || !text) return;
  if (currentLogSize > LOG_MAX_BYTES) return;
  try {
    appendFileSync(currentLogPath, text, 'utf8');
    currentLogSize += Buffer.byteLength(text, 'utf8');
  } catch (err) {
    console.warn('[Log] Failed to append FFmpeg log:', err.message);
  }
}

function formatLogPayload(payload) {
  if (typeof payload === 'string') return payload;
  return JSON.stringify(payload, null, 2).replace(/\n/g, ' ');
}

function sanitizeFilePart(value) {
  return String(value || '')
    .replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'live';
}

function pickNumber(value, allowed, fallback) {
  const n = Number(value);
  return allowed.includes(n) ? n : fallback;
}

function clamp(n, min, max) {
  if (!Number.isFinite(n)) return min;
  return Math.max(min, Math.min(max, Math.round(n)));
}

function trimLog(text) {
  return String(text || '').slice(-8000);
}

function publicConfig(config) {
  if (!config) return null;
  return {
    preset: config.preset,
    width: config.width,
    height: config.height,
    fps: config.fps,
    bitrate: config.bitrate,
    videoDevice: config.videoDevice,
    audioDevice: config.audioDevice,
    encoder: config.encoder,
    requestedEncoder: config.requestedEncoder,
    overlay: config.overlay,
  };
}

function hideStreamKey(args) {
  return args.map(arg => maskSensitiveLogText(arg));
}

function maskSensitiveLogText(value) {
  return String(value || '')
    .replace(/(rtmps?:\/\/[^\s'"<>]+\/live2\/)[^\s'"<>]+/gi, '$1***')
    .replace(/(live2\/)[^\s'"<>]+/gi, '$1***');
}

function loadEnvironment() {
  dotenv.config({ path: path.join(rootDir, '.env') });
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET) return;

  const referenceEnv = path.resolve(rootDir, '..', 'sanglive', '.env');
  if (existsSync(referenceEnv)) dotenv.config({ path: referenceEnv, override: false });
}

async function initGoogleAuth() {
  if (!googleClientId || !googleClientSecret) {
    console.log('[OAuth] No Google credentials found. OAuth disabled.');
    return;
  }

  try {
    const google = await getGoogleApi();
    oauth2Client = new google.auth.OAuth2(googleClientId, googleClientSecret, googleRedirectUri);
    oauth2Client.on('tokens', (newTokens) => {
      const credentials = { ...oauth2Client.credentials, ...newTokens };
      oauth2Client.setCredentials(credentials);
      saveTokens(credentials);
    });

    const saved = loadTokens();
    if (saved?.tokens?.refresh_token) {
      oauth2Client.setCredentials(saved.tokens);
      oauthUser = saved.user || null;
      youtubeClient = google.youtube({ version: 'v3', auth: oauth2Client });
      console.log(`[OAuth] Restored session: ${oauthUser?.email || 'unknown'}`);
    }

    console.log('[OAuth] Google OAuth configured');
    console.log(`[OAuth] Redirect URI: ${googleRedirectUri}`);
  } catch (err) {
    oauth2Client = null;
    youtubeClient = null;
    console.warn('[OAuth] Failed to initialize:', err.message);
  }
}

async function getGoogleApi() {
  if (googleApi) return googleApi;
  const mod = await import('googleapis');
  googleApi = mod.google;
  return googleApi;
}

function saveTokens(tokens) {
  try {
    writeFileSync(tokenPath, JSON.stringify({ tokens, user: oauthUser }, null, 2));
  } catch (err) {
    console.warn('[OAuth] Failed to save tokens:', err.message);
  }
}

function loadTokens() {
  try {
    if (!existsSync(tokenPath)) return null;
    return JSON.parse(readFileSync(tokenPath, 'utf8'));
  } catch {
    return null;
  }
}

function clearTokens() {
  try {
    if (existsSync(tokenPath)) unlinkSync(tokenPath);
  } catch (err) {
    console.warn('[OAuth] Failed to clear tokens:', err.message);
  }
}

function normalizeVideoConfig(body) {
  const preset = PRESETS[body.preset] ? body.preset : 'consultation';
  const base = PRESETS[preset];
  const custom = body.preset === 'custom';
  const width = custom ? pickNumber(body.width, [854, 1280, 1920], base.width) : base.width;
  const height = custom ? pickNumber(body.height, [480, 720, 1080], base.height) : base.height;
  const fps = custom ? pickNumber(body.fps, [25, 30, 50, 60], base.fps) : base.fps;
  const bitrate = custom ? clamp(Number(body.bitrate || base.bitrate), 1000, 12000) : base.bitrate;
  return { preset, width, height, fps, bitrate };
}

function getYoutubeResolution(height) {
  if (height >= 1080) return '1080p';
  if (height >= 720) return '720p';
  if (height >= 480) return '480p';
  return '360p';
}

function pickString(value, allowed, fallback) {
  return allowed.includes(value) ? value : fallback;
}

function resolveOutputUrl(config) {
  if (!config.rtmpUrl) return `rtmps://a.rtmp.youtube.com/live2/${config.streamKey}`;
  const trimmed = String(config.rtmpUrl).trim().replace(/\/+$/, '');
  if (config.streamKey && /\/live2$/i.test(trimmed)) return `${trimmed}/${config.streamKey}`;
  return trimmed;
}

function renderOAuthCallbackPage(user) {
  const safeUser = JSON.stringify(user).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="vi">
<head><meta charset="utf-8"><title>OAuth</title></head>
<body style="margin:0;background:#08080e;color:#e8e8f4;font-family:Arial,sans-serif;display:grid;place-items:center;min-height:100vh">
  <p>Đăng nhập thành công. Đang đóng cửa sổ...</p>
  <script>
    if (window.opener) window.opener.postMessage({ type: 'oauth-success', user: ${safeUser} }, '*');
    setTimeout(() => window.close(), 900);
  </script>
</body>
</html>`;
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function shutdown() {
  stopStream();
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
