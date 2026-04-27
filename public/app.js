const $ = (id) => document.getElementById(id);

const els = {
  preset: $('preset'),
  customGrid: $('custom-grid'),
  resolution: $('resolution'),
  fps: $('fps'),
  bitrate: $('bitrate'),
  bitrateValue: $('bitrate-value'),
  videoDevice: $('video-device'),
  audioDevice: $('audio-device'),
  encoder: $('encoder'),
  latency: $('latency-select'),
  streamKey: $('stream-key'),
  rtmpUrl: $('rtmp-url'),
  toggleKey: $('toggle-key'),
  startBtn: $('start-btn'),
  stopBtn: $('stop-btn'),
  refreshBtn: $('refresh-btn'),
  statusBadge: $('stream-status'),
  statusText: $('status-text'),
  timer: $('stream-timer'),
  message: $('message'),
  logBox: $('log-box'),
  logState: $('log-state'),
  previewBadge: $('preview-badge'),
  previewFrame: document.querySelector('.preview-frame'),
  localPreviewVideo: $('local-preview-video'),
  localPreviewLogo: $('local-preview-logo'),
  localPreviewPatient: $('local-preview-patient'),
  previewImage: $('preview-image'),
  previewDeviceText: $('preview-device-text'),
  previewSource: $('preview-source'),
  previewOutput: $('preview-output'),
  previewEncoder: $('preview-encoder'),
  videoIndicator: $('video-indicator'),
  audioIndicator: $('audio-indicator'),
  audioLevel: $('audio-level-fill'),
  audioMeterText: $('audio-meter-text'),
  patientName: $('patient-name'),
  statFps: $('stat-fps'),
  statBitrate: $('stat-bitrate'),
  statSpeed: $('stat-speed'),
  statPreset: $('stat-preset'),
  statOutput: $('stat-output'),
  statTime: $('stat-time'),
  statFrame: $('stat-frame'),
  resolutionBadge: $('resolution-badge'),
  fpsBadge: $('fps-badge'),
  latencyBadge: $('latency-badge'),
  keyToggleCorner: $('key-toggle-corner'),
  panelManual: $('panel-manual'),
  panelOauth: $('panel-oauth'),
  oauthLoginBtn: $('oauth-login-btn'),
  oauthHint: $('oauth-hint'),
  oauthLoginArea: $('oauth-login-area'),
  oauthUserArea: $('oauth-user-area'),
  oauthAvatar: $('oauth-avatar'),
  oauthName: $('oauth-name'),
  oauthEmail: $('oauth-email'),
  oauthLogoutBtn: $('oauth-logout-btn'),
  liveLinkBox: $('live-link-box'),
  liveLinkUrl: $('live-link-url'),
  copyLinkBtn: $('copy-link-btn'),
  modal: $('live-modal'),
  modalClose: $('modal-close'),
  modalCancel: $('modal-cancel'),
  modalConfirm: $('modal-confirm'),
  liveTitle: $('live-title'),
  liveDesc: $('live-desc'),
  patientRequiredModal: $('patient-required-modal'),
  patientModalClose: $('patient-modal-close'),
  patientModalCancel: $('patient-modal-cancel'),
  patientModalConfirm: $('patient-modal-confirm'),
  patientModalInput: $('patient-modal-input'),
  patientModalMessage: $('patient-modal-message'),
  logoFileInput: $('logo-file-input'),
  uploadLogoBtn: $('upload-logo-btn'),
  clearLogoBtn: $('clear-logo-btn'),
  logoPreviewImg: $('logo-preview-img'),
  logoPreviewPlaceholder: $('logo-preview-placeholder'),
};

const presets = {
  consultation: { resolution: '1280x720', fps: '30', bitrate: '2000', label: 'Tư vấn' },
  surgery: { resolution: '1920x1080', fps: '60', bitrate: '5000', label: 'Phẫu thuật' },
};

const encoderLabels = {
  auto: 'Auto GPU',
  h264_nvenc: 'NVIDIA NVENC',
  h264_qsv: 'Intel QSV',
  h264_amf: 'AMD AMF',
  libx264: 'CPU x264',
};

let statusTimer = null;
let saveSettingsTimer = null;
let authMode = 'oauth';
let oauthConfigured = false;
let oauthUser = null;
let lastWatchUrl = '';
let lastRunning = false;
let creatingBroadcast = false;
let meterTimer = null;
let previewTimer = null;
let previewSeq = 0;
let localStream = null;
let localAudioContext = null;
let localAnalyser = null;
let localMeterTimer = null;
let localPreviewStarting = false;

init();

async function init() {
  bindEvents();
  await loadBackendSettings();
  restoreSettings();
  applyPresetToUi();
  updatePreviewSummary();
  await Promise.all([loadDevices(), checkOAuthStatus(), loadLogoStatus()]);
  await refreshStatus();
  statusTimer = setInterval(refreshStatus, 1500);
  meterTimer = setInterval(refreshMeter, 100);
  previewTimer = setInterval(refreshPreview, 50);
  startLocalPreview();
}

function bindEvents() {
  els.preset.addEventListener('change', () => {
    applyPresetToUi();
    saveSettings();
    updatePreviewSummary();
  });
  els.bitrate.addEventListener('input', () => {
    els.bitrateValue.textContent = els.bitrate.value;
    markCustom();
    saveSettings();
    updatePreviewSummary();
  });
  els.resolution.addEventListener('change', () => { markCustom(); saveSettings(); updatePreviewSummary(); });
  els.fps.addEventListener('change', () => { markCustom(); saveSettings(); updatePreviewSummary(); });
  els.latency.addEventListener('change', () => { saveSettings(); updateBadges(); });
  els.videoDevice.addEventListener('change', () => { saveSettings(); updatePreviewSummary(); restartLocalPreview(); });
  els.audioDevice.addEventListener('change', () => { saveSettings(); updatePreviewSummary(); restartLocalPreview(); });
  els.encoder.addEventListener('change', () => { saveSettings(); updatePreviewSummary(); });
  els.patientName.addEventListener('input', () => { saveSettings(); updateLocalPatientOverlay(); });
  els.streamKey.addEventListener('input', saveSettings);
  els.rtmpUrl.addEventListener('input', saveSettings);
  els.refreshBtn.addEventListener('click', loadDevices);
  els.startBtn.addEventListener('click', startFlow);
  els.stopBtn.addEventListener('click', stopStream);
  els.toggleKey.addEventListener('click', toggleStreamKeyVisibility);
  els.keyToggleCorner.addEventListener('click', toggleManualKeyPanel);
  els.oauthLoginBtn.addEventListener('click', openOAuthLogin);
  els.oauthLogoutBtn.addEventListener('click', logoutOAuth);
  els.copyLinkBtn.addEventListener('click', copyLiveLink);
  els.modalClose.addEventListener('click', hideModal);
  els.modalCancel.addEventListener('click', hideModal);
  els.modal.addEventListener('click', (event) => { if (event.target === els.modal) hideModal(); });
  els.modalConfirm.addEventListener('click', confirmOAuthStream);
  els.patientModalClose.addEventListener('click', hidePatientRequiredModal);
  els.patientModalCancel.addEventListener('click', hidePatientRequiredModal);
  els.patientRequiredModal.addEventListener('click', (event) => { if (event.target === els.patientRequiredModal) hidePatientRequiredModal(); });
  els.patientModalConfirm.addEventListener('click', confirmPatientRequired);
  els.patientModalInput.addEventListener('keydown', (event) => { if (event.key === 'Enter') confirmPatientRequired(); });
  els.uploadLogoBtn.addEventListener('click', () => els.logoFileInput.click());
  els.logoFileInput.addEventListener('change', handleLogoFileChange);
  els.clearLogoBtn.addEventListener('click', clearLogo);
  window.addEventListener('message', (event) => {
    if (event.data?.type === 'oauth-success') onOAuthSuccess(event.data.user);
  });
}

function applyPresetToUi() {
  const preset = presets[els.preset.value];
  if (!preset) {
    els.customGrid.classList.remove('hidden');
    updateBadges();
    return;
  }

  els.customGrid.classList.add('hidden');
  els.resolution.value = preset.resolution;
  els.fps.value = preset.fps;
  els.bitrate.value = preset.bitrate;
  els.bitrateValue.textContent = preset.bitrate;
  updateBadges();
}

function markCustom() {
  if (els.preset.value === 'custom') return;
  els.preset.value = 'custom';
  els.customGrid.classList.remove('hidden');
}

async function loadDevices() {
  els.refreshBtn.disabled = true;
  showMessage('Đang tải danh sách thiết bị DirectShow...', 'info');
  try {
    const data = await fetchJson('/api/devices');
    if (!data.ok) throw new Error(data.error || 'Không tải được thiết bị');
    fillSelect(els.videoDevice, data.devices.video, 'Không tìm thấy camera', false, true);
    fillSelect(els.audioDevice, data.devices.audio, 'Không tìm thấy microphone', false, true);
    fillEncoders(data.encoders || []);
    restoreSettings();
    applyPresetToUi();
    updatePreviewSummary();
    if (!lastRunning) restartLocalPreview();
    hideMessage();
  } catch (err) {
    showMessage(err.message);
  } finally {
    els.refreshBtn.disabled = false;
  }
}

function fillSelect(select, items, emptyLabel, allowEmpty = false, selectFirst = false) {
  const saved = select.value;
  select.innerHTML = '';
  if (allowEmpty) select.append(new Option(emptyLabel, ''));
  if (!items.length && !allowEmpty) select.append(new Option(emptyLabel, ''));
  for (const item of items) select.append(new Option(item.label || item.name, item.name));
  if ([...select.options].some(option => option.value === saved)) select.value = saved;
  else if (selectFirst && items.length) select.value = items[0].name;
}

function fillEncoders(items) {
  const saved = els.encoder.value;
  els.encoder.innerHTML = '';
  const ids = new Set(items.map(item => item.id));
  const ordered = [
    ['auto', 'Auto GPU nếu có'],
    ['h264_nvenc', 'NVIDIA NVENC'],
    ['h264_qsv', 'Intel Quick Sync'],
    ['h264_amf', 'AMD AMF'],
    ['libx264', 'CPU libx264'],
  ];
  for (const [id, label] of ordered) {
    const suffix = id !== 'auto' && !ids.has(id) ? ' (có thể không hỗ trợ)' : '';
    els.encoder.append(new Option(`${label}${suffix}`, id));
  }
  els.encoder.value = [...els.encoder.options].some(option => option.value === saved) ? saved : 'auto';
}

async function checkOAuthStatus() {
  try {
    const data = await fetchJson('/auth/status');
    oauthConfigured = !!data.configured;
    if (!oauthConfigured) {
      els.oauthLoginBtn.disabled = true;
      els.oauthHint.textContent = 'OAuth chưa cấu hình. Thêm GOOGLE_CLIENT_ID và GOOGLE_CLIENT_SECRET vào .env.';
      els.oauthHint.style.color = 'var(--yellow)';
      return;
    }

    els.oauthLoginBtn.disabled = false;
    els.oauthHint.textContent = data.redirectUri ? `Redirect URI: ${data.redirectUri}` : 'Kết nối YouTube để tự động tạo live.';
    els.oauthHint.style.color = 'var(--text-muted)';
    if (data.authenticated && data.user) onOAuthSuccess(data.user, false);
  } catch {
    oauthConfigured = false;
  }
}

function openOAuthLogin() {
  if (!oauthConfigured) {
    showMessage('OAuth chưa cấu hình. Kiểm tra .env.');
    return;
  }
  const width = 520;
  const height = 640;
  const left = Math.max(0, (screen.width - width) / 2);
  const top = Math.max(0, (screen.height - height) / 2);
  window.open('/auth/login', 'OAuth', `width=${width},height=${height},left=${left},top=${top},popup=1`);
}

function onOAuthSuccess(user, persist = true) {
  oauthUser = user;
  els.oauthLoginArea.classList.add('hidden');
  els.oauthUserArea.classList.remove('hidden');
  els.oauthAvatar.src = user.picture || '';
  els.oauthName.textContent = user.name || 'Google User';
  els.oauthEmail.textContent = user.email || '';
  setAuthMode('oauth');
  if (persist) showMessage('Đăng nhập Google thành công.', 'success');
}

async function logoutOAuth() {
  await fetch('/auth/logout', { method: 'POST' }).catch(() => {});
  oauthUser = null;
  els.oauthLoginArea.classList.remove('hidden');
  els.oauthUserArea.classList.add('hidden');
  hideLiveLink();
  showMessage('Đã đăng xuất OAuth.', 'info');
}

function setAuthMode(mode) {
  authMode = mode;
  els.panelManual.classList.toggle('hidden', mode !== 'manual');
  els.keyToggleCorner.classList.toggle('active', mode === 'manual');
  saveSettings();
}

function toggleManualKeyPanel() {
  setAuthMode(authMode === 'manual' ? 'oauth' : 'manual');
}

async function startFlow() {
  hideMessage();
  if (!els.videoDevice.value) {
    showMessage('Vui lòng chọn camera DirectShow.');
    return;
  }

  if (!getPatientTitle()) {
    showPatientRequiredModal();
    return;
  }

  if (authMode === 'oauth') {
    if (!oauthUser) {
      showMessage('Vui lòng đăng nhập Google OAuth trước.');
      return;
    }
    try {
      await validateConfig();
    } catch (err) {
      showMessage(err.message);
      return;
    }
    showModal();
    return;
  }

  const key = els.streamKey.value.trim();
  const rtmpUrl = els.rtmpUrl.value.trim();
  if (!key && !rtmpUrl) {
    showMessage('Vui lòng nhập YouTube Stream Key hoặc RTMP URL.');
    return;
  }
  await startStream({ streamKey: key, rtmpUrl });
}

async function validateConfig() {
  const body = {
    ...getVideoConfig(),
    videoDevice: els.videoDevice.value,
    audioDevice: els.audioDevice.value,
    encoder: els.encoder.value,
    patientName: els.patientName.value.trim(),
  };
  const data = await fetchJson('/api/validate-config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!data.ok) throw new Error(data.error || 'Cấu hình camera không hợp lệ.');
}

function showModal() {
  els.liveTitle.value = getPatientTitle();
  els.liveDesc.value = 'Livestream bởi XAlive Lite';
  els.modal.classList.remove('hidden');
  els.modalConfirm.disabled = false;
  els.modalConfirm.textContent = 'Tạo live và stream';
  setTimeout(() => els.liveTitle.focus(), 0);
}

function hideModal() {
  if (!creatingBroadcast) els.modal.classList.add('hidden');
}

async function confirmOAuthStream() {
  creatingBroadcast = true;
  els.modalConfirm.disabled = true;
  els.modalConfirm.textContent = 'Đang tạo live...';
  showMessage('Đang tạo YouTube Live bằng OAuth...', 'info');

  try {
    const body = {
      title: els.liveTitle.value.trim() || getPatientTitle(),
      description: els.liveDesc.value.trim(),
      privacyStatus: document.querySelector('input[name="privacy"]:checked')?.value || 'unlisted',
      latencyPreference: els.latency.value,
      videoConfig: getVideoConfig(),
    };
    const data = await fetchJson('/api/create-broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!data.ok) throw new Error(data.error || 'Không tạo được YouTube Live');

    hideLiveLink();
    if (data.watchUrl) showLiveLink(data.watchUrl);
    els.modal.classList.add('hidden');
    await startStream({ streamKey: data.streamKey, rtmpUrl: data.rtmpUrl });
  } catch (err) {
    showMessage(err.message);
  } finally {
    creatingBroadcast = false;
    els.modalConfirm.disabled = false;
    els.modalConfirm.textContent = 'Tạo live và stream';
  }
}

function showPatientRequiredModal() {
  els.patientModalInput.value = els.patientName.value.trim();
  els.patientModalMessage.textContent = 'Thiếu Tên bệnh nhân và chẩn đoán';
  els.patientModalMessage.classList.remove('hidden', 'info', 'success');
  els.patientRequiredModal.classList.remove('hidden');
  setTimeout(() => els.patientModalInput.focus(), 0);
}

function hidePatientRequiredModal() {
  els.patientRequiredModal.classList.add('hidden');
  els.patientModalMessage.classList.add('hidden');
  els.patientModalMessage.textContent = '';
}

function confirmPatientRequired() {
  const value = els.patientModalInput.value.trim();
  if (!value) {
    els.patientModalMessage.textContent = 'Thiếu Tên bệnh nhân và chẩn đoán';
    els.patientModalMessage.classList.remove('hidden', 'info', 'success');
    return;
  }
  els.patientName.value = value;
  saveSettings();
  updateLocalPatientOverlay();
  hidePatientRequiredModal();
  startFlow();
}

function getPatientTitle() {
  return els.patientName.value.trim();
}

async function startStream(credentials) {
  els.startBtn.disabled = true;
  try {
    await stopLocalPreview();
    const body = {
      ...getVideoConfig(),
      videoDevice: els.videoDevice.value,
      audioDevice: els.audioDevice.value,
      encoder: els.encoder.value,
      patientName: els.patientName.value.trim(),
      streamKey: credentials.streamKey || '',
      rtmpUrl: credentials.rtmpUrl || '',
    };
    const data = await fetchJson('/api/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!data.ok) throw new Error(data.error || 'Không start được FFmpeg');
    saveSettings();
    showMessage('FFmpeg đã bắt đầu đẩy luồng lên YouTube.', 'success');
    await refreshStatus();
  } catch (err) {
    if (!lastRunning) startLocalPreview();
    if (authMode === 'oauth') fetch('/api/end-broadcast', { method: 'POST' }).catch(() => {});
    showMessage(err.message);
  } finally {
    els.startBtn.disabled = false;
  }
}

async function stopStream() {
  els.stopBtn.disabled = true;
  await fetch('/api/stop', { method: 'POST' }).catch(() => {});
  if (authMode === 'oauth') await fetch('/api/end-broadcast', { method: 'POST' }).catch(() => {});
  await refreshStatus();
}

async function refreshStatus() {
  try {
    const data = await fetchJson('/api/status');
    renderStatus(data);
  } catch (err) {
    showMessage(err.message);
  }
}

function renderStatus(data) {
  const running = !!data.running;
  const restarting = !!data.restarting;
  const waitingForDevice = !!data.waitingForDevice;
  const wasRunning = lastRunning;
  els.statusBadge.className = 'status-badge';
  els.statusBadge.classList.add(running ? (waitingForDevice ? 'status-error' : 'status-live') : (data.lastError ? 'status-error' : 'status-idle'));
  els.statusText.textContent = running
    ? (waitingForDevice ? 'Chờ camera...' : (restarting ? 'Đang nối lại' : 'Đang live'))
    : (data.lastError ? 'Có lỗi' : 'Sẵn sàng');
  els.timer.textContent = running ? formatDuration(data.elapsedSeconds) : '00:00:00';
  els.timer.classList.toggle('active', running);
  els.previewBadge.textContent = running ? 'ĐANG LIVE' : 'XEM TRƯỚC';
  els.previewBadge.classList.toggle('is-live', running);
  els.logState.textContent = running ? (waitingForDevice ? 'waiting-for-device' : (restarting ? 'restarting' : 'running')) : 'idle';

  els.startBtn.classList.toggle('hidden', running);
  els.stopBtn.classList.toggle('hidden', !running);
  els.stopBtn.disabled = !running;
  setControlsEnabled(!running);

  const cfg = data.config || {};
  const stats = data.stats || {};
  els.statPreset.textContent = cfg.preset || els.preset.value || '--';
  els.statOutput.textContent = cfg.width ? `${cfg.width}x${cfg.height}@${cfg.fps}` : '--';
  els.statTime.textContent = running ? formatDuration(data.elapsedSeconds) : '00:00:00';
  els.statFrame.textContent = stats.frame != null ? String(stats.frame) : '--';
  els.statFps.textContent = stats.fps != null ? `${Math.round(stats.fps)} fps` : '-- fps';
  els.statBitrate.textContent = stats.bitrate != null ? `${Math.round(stats.bitrate)} kbps` : (cfg.bitrate ? `${cfg.bitrate} kbps` : '-- kbps');
  els.statSpeed.textContent = stats.speed != null ? `${stats.speed}x` : '-- tốc độ';
  els.statFps.classList.toggle('active', stats.fps != null);
  els.statBitrate.classList.toggle('active', stats.bitrate != null || !!cfg.bitrate);
  els.statSpeed.classList.toggle('active', stats.speed != null);
  els.logBox.textContent = data.lastLog || '';
  renderMeter(data.audio || { level: 0 });
  renderPreviewAvailability(data.preview?.available && running);

  if (!running) renderMeter({ level: 0 });
  if (data.lastError && (!running || restarting || waitingForDevice)) showMessage(data.lastError, (restarting || waitingForDevice) ? 'info' : 'error');
  else if (wasRunning && !running) showMessage('Stream đã dừng.', 'info');
  lastRunning = running;
  if (wasRunning && !running) startLocalPreview();
  updatePreviewSummary(cfg);
}

function setControlsEnabled(enabled) {
  for (const el of [els.preset, els.resolution, els.fps, els.bitrate, els.videoDevice, els.audioDevice, els.encoder, els.patientName, els.latency, els.streamKey, els.rtmpUrl, els.refreshBtn, els.keyToggleCorner, els.uploadLogoBtn, els.clearLogoBtn, els.logoFileInput]) {
    el.disabled = !enabled;
  }
}

function getVideoConfig() {
  const [width, height] = els.resolution.value.split('x').map(Number);
  return {
    preset: els.preset.value,
    width,
    height,
    fps: Number(els.fps.value),
    bitrate: Number(els.bitrate.value),
  };
}

function updatePreviewSummary(statusConfig = null) {
  const cfg = statusConfig?.width ? statusConfig : getVideoConfig();
  const videoName = els.videoDevice.value || '--';
  const audioName = els.audioDevice.value;
  els.previewSource.textContent = videoName;
  els.previewOutput.textContent = `${cfg.width}x${cfg.height}@${cfg.fps}`;
  els.previewEncoder.textContent = encoderLabels[els.encoder.value] || els.encoder.value;
  els.previewDeviceText.textContent = videoName === '--'
    ? 'Chọn camera DirectShow trong sidebar phải để FFmpeg đọc trực tiếp từ Windows.'
    : `Nguồn đang chọn: ${videoName}${audioName ? ` + ${audioName}` : ' + silence audio'}.`;
  els.videoIndicator.classList.toggle('active', !!els.videoDevice.value);
  els.audioIndicator.classList.toggle('active', !!els.audioDevice.value);
  updateBadges();
}

async function refreshMeter() {
  if (!lastRunning) return;
  try {
    const data = await fetchJson('/api/meter');
    renderMeter(data.audio || { level: 0 });
    renderPreviewAvailability(data.preview?.available && data.running);
  } catch {}
}

function renderMeter(audio) {
  const level = Math.max(0, Math.min(1, Number(audio.level || 0)));
  els.audioLevel.style.width = `${Math.round(level * 100)}%`;
  if (audio.peakDb == null && audio.rmsDb == null) {
    els.audioMeterText.textContent = 'Level: -- dB';
    return;
  }
  const peak = audio.peakDb == null ? '--' : `${audio.peakDb.toFixed(1)} dB`;
  const rms = audio.rmsDb == null ? '--' : `${audio.rmsDb.toFixed(1)} dB`;
  els.audioMeterText.textContent = `Peak: ${peak} | RMS: ${rms}`;
}

function refreshPreview() {
  if (!lastRunning) return;
  els.previewImage.src = `/api/preview.jpg?seq=${++previewSeq}`;
}

function renderPreviewAvailability(available) {
  els.previewFrame?.classList.toggle('has-preview', !!available);
  els.previewImage.classList.toggle('hidden', !available);
  if (!available && !lastRunning) els.previewImage.removeAttribute('src');
}

async function startLocalPreview() {
  if (!navigator.mediaDevices?.getUserMedia) return;
  if (lastRunning || localPreviewStarting || !els.videoDevice.value) return;
  localPreviewStarting = true;
  try {
    await stopLocalPreview();
    const constraints = await buildLocalMediaConstraints();
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
    els.localPreviewVideo.srcObject = localStream;
    els.localPreviewVideo.classList.remove('hidden');
    els.localPreviewLogo.classList.remove('hidden');
    updateLocalPatientOverlay();
    els.previewFrame?.classList.add('has-local-preview');
    els.previewImage.classList.add('hidden');
    els.previewImage.removeAttribute('src');
    startLocalMeter(localStream);
  } catch (err) {
    console.warn('[Preview] Browser preview failed:', err.message);
    stopLocalPreview();
  } finally {
    localPreviewStarting = false;
  }
}

async function stopLocalPreview() {
  if (localMeterTimer) clearInterval(localMeterTimer);
  localMeterTimer = null;
  if (localAudioContext) {
    try { await localAudioContext.close(); } catch {}
  }
  localAudioContext = null;
  localAnalyser = null;
  if (localStream) {
    for (const track of localStream.getTracks()) track.stop();
  }
  localStream = null;
  els.localPreviewVideo.srcObject = null;
  els.localPreviewVideo.classList.add('hidden');
  els.localPreviewLogo.classList.add('hidden');
  els.localPreviewPatient.classList.add('hidden');
  els.previewFrame?.classList.remove('has-local-preview');
}

function restartLocalPreview() {
  if (lastRunning) return;
  stopLocalPreview().then(() => startLocalPreview()).catch(() => {});
}

async function buildLocalMediaConstraints() {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const videoId = findBrowserDeviceId(devices, 'videoinput', els.videoDevice.value);
  const audioId = els.audioDevice.value ? findBrowserDeviceId(devices, 'audioinput', els.audioDevice.value) : null;
  const video = {
    width: { ideal: getVideoConfig().width },
    height: { ideal: getVideoConfig().height },
    frameRate: { ideal: Math.min(getVideoConfig().fps, 30) },
  };
  if (videoId) video.deviceId = { exact: videoId };
  const audio = els.audioDevice.value ? (audioId ? { deviceId: { exact: audioId } } : true) : false;
  return {
    video,
    audio,
  };
}

function findBrowserDeviceId(devices, kind, directShowName) {
  const target = normalizeDeviceName(directShowName);
  if (!target) return '';
  const sameKind = devices.filter(device => device.kind === kind);
  const exact = sameKind.find(device => normalizeDeviceName(device.label) === target);
  if (exact) return exact.deviceId;
  const partial = sameKind.find(device => {
    const label = normalizeDeviceName(device.label);
    return label && (label.includes(target) || target.includes(label));
  });
  return partial?.deviceId || '';
}

function normalizeDeviceName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function startLocalMeter(stream) {
  const audioTracks = stream.getAudioTracks();
  if (!audioTracks.length) {
    renderMeter({ level: 0 });
    return;
  }
  localAudioContext = new AudioContext();
  const source = localAudioContext.createMediaStreamSource(new MediaStream(audioTracks));
  localAnalyser = localAudioContext.createAnalyser();
  localAnalyser.fftSize = 1024;
  source.connect(localAnalyser);
  const buffer = new Float32Array(localAnalyser.fftSize);
  localMeterTimer = setInterval(() => {
    localAnalyser.getFloatTimeDomainData(buffer);
    let peak = 0;
    let sumSquares = 0;
    for (const sample of buffer) {
      const abs = Math.abs(sample);
      if (abs > peak) peak = abs;
      sumSquares += sample * sample;
    }
    const rms = Math.sqrt(sumSquares / buffer.length);
    renderMeter({
      peakDb: amplitudeToDb(peak),
      rmsDb: amplitudeToDb(rms),
      level: dbToLevel(amplitudeToDb(peak)),
    });
  }, 100);
}

function updateLocalPatientOverlay() {
  const value = els.patientName.value.trim();
  els.localPreviewPatient.textContent = value;
  els.localPreviewPatient.classList.toggle('hidden', !value || !localStream || lastRunning);
}

function amplitudeToDb(value) {
  if (!Number.isFinite(value) || value <= 0.000001) return -60;
  return Math.max(-60, Math.min(0, 20 * Math.log10(value)));
}

function dbToLevel(db) {
  if (!Number.isFinite(db)) return 0;
  return Math.max(0, Math.min(1, (db + 60) / 60));
}

function updateBadges() {
  const [width, height] = els.resolution.value.split('x');
  els.resolutionBadge.textContent = `${Number(height)}p`;
  els.fpsBadge.textContent = `${els.fps.value}fps`;
  const latency = els.latency.value;
  els.latencyBadge.dataset.latency = latency;
  els.latencyBadge.textContent = latency === 'ultraLow' ? 'Ultra Low' : latency[0].toUpperCase() + latency.slice(1);
  els.bitrateValue.textContent = els.bitrate.value;
  void width;
}

function toggleStreamKeyVisibility() {
  const visible = els.streamKey.type === 'text';
  els.streamKey.type = visible ? 'password' : 'text';
  els.toggleKey.textContent = visible ? 'Hiện' : 'Ẩn';
}

function showLiveLink(url) {
  lastWatchUrl = url;
  els.liveLinkBox.classList.remove('hidden');
  els.liveLinkUrl.href = url;
  els.liveLinkUrl.textContent = url.replace('https://www.youtube.com/watch?v=', 'youtu.be/');
}

function hideLiveLink() {
  lastWatchUrl = '';
  els.liveLinkBox.classList.add('hidden');
  els.liveLinkUrl.href = '#';
  els.liveLinkUrl.textContent = '';
}

async function copyLiveLink() {
  if (!lastWatchUrl) return;
  try {
    await navigator.clipboard.writeText(lastWatchUrl);
    showMessage('Đã copy link live.', 'success');
  } catch {
    showMessage('Không copy được link.');
  }
}

function getSettingsObj() {
  return {
    preset: els.preset.value,
    resolution: els.resolution.value,
    fps: els.fps.value,
    bitrate: els.bitrate.value,
    videoDevice: els.videoDevice.value,
    audioDevice: els.audioDevice.value,
    encoder: els.encoder.value,
    patientName: els.patientName.value,
    latency: els.latency.value,
    streamKey: els.streamKey.value,
    rtmpUrl: els.rtmpUrl.value,
    authMode: authMode === 'manual' ? 'manual' : 'oauth',
  };
}

function saveSettings() {
  const obj = getSettingsObj();
  localStorage.setItem('xalive-lite-settings', JSON.stringify(obj));
  if (saveSettingsTimer) clearTimeout(saveSettingsTimer);
  saveSettingsTimer = setTimeout(() => {
    saveSettingsTimer = null;
    fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(obj),
    }).catch(() => {});
  }, 600);
}

async function loadBackendSettings() {
  try {
    const data = await fetchJson('/api/settings');
    if (data.ok && data.settings && Object.keys(data.settings).length) {
      localStorage.setItem('xalive-lite-settings', JSON.stringify(data.settings));
    }
  } catch {}
}

function restoreSettings() {
  let settings = {};
  try { settings = JSON.parse(localStorage.getItem('xalive-lite-settings') || '{}'); } catch {}
  if (settings.preset && [...els.preset.options].some(option => option.value === settings.preset)) els.preset.value = settings.preset;
  if (settings.resolution && [...els.resolution.options].some(option => option.value === settings.resolution)) els.resolution.value = settings.resolution;
  if (settings.fps && [...els.fps.options].some(option => option.value === settings.fps)) els.fps.value = settings.fps;
  if (settings.bitrate) { els.bitrate.value = settings.bitrate; els.bitrateValue.textContent = settings.bitrate; }
  if (settings.videoDevice && [...els.videoDevice.options].some(option => option.value === settings.videoDevice)) els.videoDevice.value = settings.videoDevice;
  if (settings.audioDevice && [...els.audioDevice.options].some(option => option.value === settings.audioDevice)) els.audioDevice.value = settings.audioDevice;
  if (settings.encoder && [...els.encoder.options].some(option => option.value === settings.encoder)) els.encoder.value = settings.encoder;
  if (settings.patientName) els.patientName.value = settings.patientName;
  if (settings.latency && [...els.latency.options].some(option => option.value === settings.latency)) els.latency.value = settings.latency;
  if (settings.streamKey) els.streamKey.value = settings.streamKey;
  if (settings.rtmpUrl) els.rtmpUrl.value = settings.rtmpUrl;
  setAuthMode(settings.authMode === 'manual' ? 'manual' : 'oauth');
}

async function loadLogoStatus() {
  try {
    const data = await fetchJson('/api/logo-status');
    renderLogoStatus(data);
  } catch {}
}

function renderLogoStatus({ hasCustom, hasAny, version }) {
  if (hasAny) {
    els.logoPreviewImg.src = `/overlay-logo.png?v=${version}`;
    els.logoPreviewImg.classList.remove('hidden');
    els.logoPreviewPlaceholder.classList.add('hidden');
  } else {
    els.logoPreviewImg.classList.add('hidden');
    els.logoPreviewPlaceholder.classList.remove('hidden');
  }
  els.clearLogoBtn.classList.toggle('hidden', !hasCustom);
}

async function handleLogoFileChange() {
  const file = els.logoFileInput.files?.[0];
  els.logoFileInput.value = '';
  if (!file) return;
  if (!file.type.startsWith('image/')) { showMessage('Chỉ hỗ trợ file ảnh (PNG, JPG, GIF, WEBP).'); return; }
  if (file.size > 5 * 1024 * 1024) { showMessage('File quá lớn. Tối đa 5MB.'); return; }
  els.uploadLogoBtn.disabled = true;
  showMessage('Đang tải logo lên...', 'info');
  try {
    const buffer = await file.arrayBuffer();
    const res = await fetch('/api/upload-logo', {
      method: 'POST',
      headers: { 'Content-Type': file.type },
      body: buffer,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Upload thất bại');
    await loadLogoStatus();
    hideMessage();
  } catch (err) {
    showMessage(err.message);
  } finally {
    els.uploadLogoBtn.disabled = false;
  }
}

async function clearLogo() {
  try {
    await fetch('/api/upload-logo', { method: 'DELETE' });
    await loadLogoStatus();
  } catch {}
}

function showMessage(text, type = 'error') {
  els.message.textContent = text;
  els.message.classList.remove('hidden', 'info', 'success');
  if (type === 'info') els.message.classList.add('info');
  if (type === 'success') els.message.classList.add('success');
}

function hideMessage() {
  els.message.classList.add('hidden');
  els.message.textContent = '';
}

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || data.message || `HTTP ${res.status}`);
  return data;
}

function formatDuration(total) {
  const seconds = Number(total || 0);
  const h = Math.floor(seconds / 3600).toString().padStart(2, '0');
  const m = Math.floor((seconds % 3600) / 60).toString().padStart(2, '0');
  const s = Math.floor(seconds % 60).toString().padStart(2, '0');
  return `${h}:${m}:${s}`;
}

window.addEventListener('beforeunload', () => {
  if (statusTimer) clearInterval(statusTimer);
  if (meterTimer) clearInterval(meterTimer);
  if (previewTimer) clearInterval(previewTimer);
  if (localMeterTimer) clearInterval(localMeterTimer);
  if (localStream) {
    for (const track of localStream.getTracks()) track.stop();
  }
});
