import { createAutosave } from './autosave.js';
import { createEditTransport } from './edit-transport.js';
import { createVoiceStore } from './voice-store.js';
import { BANKS, KEYS, PAD_COUNT, BANK_COUNT, SLOT_COUNT, MODES, PLAYBACK_FLAGS, POINTER_RELEASE_EVENTS, STORAGE_VERSION, MAX_DURATION, MAX_VOICES, MAX_FILE_BYTES } from './config.js';
import { clamp, createEmptySample, soundName, audioDuration, formatTime, formatPreciseTime, clipDuration } from './sample.js';
import { synth } from './presets.js';
import { createEmptyPatterns, parseSessionSettings } from './session.js';
import { openSessionDatabase, readSession } from './session-storage.js';
import { createBackupCodec, backupYield } from './backup-codec.js';
import { createChain, configurePlaybackSession } from './audio-utils.js';
import { getWavePeaks, drawWavePeaks } from './waveform.js';
import { initializePwa } from '../pwa.js';

// Application state and orchestration. Pure helpers live in adjacent modules.
const $ = id => document.getElementById(id);
let pads = Array.from({ length: SLOT_COUNT }, createEmptySample);
let bank = 0;
let selected = 0;
let master = .75;
let lastVolume = .75;
let uiMode = 'play';
let showPlaybackWaveform = true;

// Preserve legacy fields in v1 snapshots and .sx12 backups.
// The current playback path does not use the sequencer or effects.
let patterns = createEmptyPatterns();
let tempo = 90;
let swing = 0;
let fx = 'off';
let fxValues = [.65, .2, .6];

// Persistence state.
let db = null;
let ready = false;

// Web Audio state and decoded-buffer cache.
let ctx = null;
let chain = null;
const voiceStore = createVoiceStore();
let bufferCache = new WeakMap();
let playEpoch = 0;

// Input and presentation state.
const heldKeys = new Map();
const pointerPads = new Map();
let audioImportTarget = null;
let chooserPending = false;
let panel = null;
let toastTimer;

const slot = () => bank * PAD_COUNT + selected;
const current = () => pads[slot()];
const isBusy = () => document.body.classList.contains('busy');
const canInteract = () => ready && !panel && !isBusy();
function normalizeRanges(){
  for (const p of pads){
    if (!p.audio)continue;
    const gap = 1 / p.audio.channels[0].length;
    p.start = clamp(p.start, 0, 1 - gap);
    p.end = clamp(p.end, p.start + gap, 1)
  }
}
// storage.js
function snapshot(){
  return {
    version: STORAGE_VERSION,
    bank,
    selected,
    tempo,
    swing,
    master,
    showPlaybackWaveform,
    fx,
    fxValues: fxValues.slice(),
    patterns,
    pads: pads.map(({
      audio,
      ...meta
    }) => meta)
  }
}
const autosave = createAutosave({
  getDatabase: () => db,
  getSettings: snapshot,
  getSamples: () => pads,
  isReady: () => ready,
  onError: () => notify('ブラウザの保存領域が利用できません。メニューの「バックアップを保存」で音源を残してください。')
});
const markSave = autosave.mark;
const flushSave = autosave.flush;
const setSaveError = autosave.reportFailure;

async function restore(){
  try{
    db = await openSessionDatabase();
    const { stored, sounds } = await readSession(db);
    if (stored){
      applySettings(stored);
      for (const s of sounds){
        if (Number.isInteger(s.id) && s.id >= 0 && s.id < SLOT_COUNT)pads[s.id].audio = s.audio
      }
    }
    normalizeRanges();
    ready = true;
    renderAll();
    if (!stored)markSave();
  }catch (e){
    ready = true;
    setSaveError();
    renderAll()
  }
}
function prepareSettings(settings) {
  return parseSessionSettings(settings, patterns);
}

function applyPreparedSettings(s, sounds = pads.map(p => p.audio)){
  // All parsing/validation happens before this synchronous state replacement.
  for (let i = 0; i < SLOT_COUNT; i++)pads[i] = { ...createEmptySample(), ...s.pads[i], audio: sounds[i] };
  bank = s.bank;
  selected = s.selected;
  tempo = s.tempo;
  swing = s.swing;
  master = s.master;
  showPlaybackWaveform = s.showPlaybackWaveform;
  fx = s.fx;
  fxValues = s.fxValues;
  patterns = s.patterns;
}
function applySettings(s){
  applyPreparedSettings(prepareSettings(s));
}

// audio.js
const hasActiveVoice = voiceStore.hasActive;
const latestActiveVoice = voiceStore.latestActive;
const getVoiceActivity = voiceStore.activity;

function updateMasterVolume(){
  if (chain)chain.master.gain.setTargetAtTime(master, ctx.currentTime, .015)
}
function getAudioContext(){
  if (!ctx || ctx.state === 'closed'){
    const Audio = window.AudioContext || window.webkitAudioContext;
    if (!Audio)throw Error('このブラウザはWeb Audioに対応していません。');
    ctx = new Audio({
      latencyHint: 'interactive'
    });
    chain = createChain(ctx, ctx.destination, master);
    ctx.addEventListener('statechange', renderVoiceLights)
  }
  return ctx
}
async function ensureAudio(){
  configurePlaybackSession();
  const context = getAudioContext();
  if (context.state !== 'running'){
    let timer;
    try{
      await Promise.race([context.resume(), new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error('音を開始できませんでした。メニューの「音声を復旧」を試してください。')), 2500)
      })])
    }finally{
      clearTimeout(timer)
    }
  }
  if (context.state !== 'running')throw Error('音を開始できませんでした。メニューの「音声を復旧」を試してください。');
  return context
}
function resumeAudio(){
  const playing = getVoiceActivity().count > 0;
  if (playing && ctx && ctx.state !== 'running' && ctx.state !== 'closed'){
    configurePlaybackSession();
    ctx.resume().catch (() => {
    })
  }
  renderVoiceLights()
}
async function recoverAudio(){
  if (!ready || isBusy())return;
  const previous = ctx;
  allStop();
  ctx = null;
  chain = null;
  voiceStore.clear();
  bufferCache = new WeakMap();
  try{
    previous?.close?.().catch (() => {
    })
  }catch{
  }
  if (panel)closePanel();
  try{
    await ensureAudio();
    notify(master === 0 ? '音声を準備し直しました。全体音量が0%です。右のVolumeバーを上げてください。': '音声を準備し直しました。再生モードでパッドを押してください。')
  }catch (e){
    notify(e.message)
  }
}
function getBuffer(p){
  if (!p.audio)return null;
  let buffer = bufferCache.get(p.audio);
  if (!buffer){
    buffer = ctx.createBuffer(p.audio.channels.length, p.audio.channels[0].length, p.audio.rate);
    p.audio.channels.forEach((data, ch) => buffer.copyToChannel(data, ch));
    bufferCache.set(p.audio, buffer)
  }
  return buffer
}
function voicePositionSeconds(voice, now = ctx?.currentTime || voice.time){
  const source = voice.source;
  const start = source.loopStart;
  const end = source.loopEnd;
  const offset = voice.offset ?? start;
  const elapsed = Math.max(0, now - voice.time) * source.playbackRate.value;
  const length = end - start;
  return source.loop && length > 0 ? start + (offset - start + elapsed) % length : Math.min(end, offset + elapsed);
}
function releaseVoice(voice){
  if (voice.stopping)return;
  voice.stopping = true;
  try{
    voice.gain.gain.cancelScheduledValues(ctx.currentTime);
    voice.gain.gain.setTargetAtTime(0, ctx.currentTime, .003);
    voice.source.stop(ctx.currentTime + .015)
  }catch{
  }
}
function releaseAllVoices(except = null){
  voiceStore.forEach(voice => {
    if (voice !== except)releaseVoice(voice);
  });
}
function stopVoice(index){
  resetEditTransport(index);
  voiceStore.forEach(releaseVoice, index);
  renderVoiceLights()
}
function trigger(index, audition = false, options = {}){
  const p = pads[index];
  if (!ctx || !p.audio)return;
  const editing = uiMode === 'edit';
  if (editing && index !== slot())return;
  if (editing){
    audition = false;
    releaseAllVoices();
  }
  const t = ctx.currentTime;
  if (!editing && !audition && p.loop && hasActiveVoice(index)){
    stopVoice(index);
    return
  }
  const { count, oldest } = getVoiceActivity();
  if (count >= MAX_VOICES){
    oldest.stopping = true;
    try{
      oldest.source.stop()
    }catch{
    }
  }
  const buffer = getBuffer(p),
  source = ctx.createBufferSource(),
  gain = ctx.createGain();
  source.buffer = buffer;
  source.playbackRate.value = audition ? 1: Math.pow(2, p.pitch / 12);
  source.loop = !editing && !audition && p.loop;
  const start = audition ? 0: p.start * buffer.duration,
  end = audition ? buffer.duration: p.end * buffer.duration,
  offset = clamp(options.offset ?? start, start, Math.max(start, end - 1 / buffer.sampleRate)),
  length = Math.max(1 / buffer.sampleRate, end - offset),
  level = audition ? 1: p.gain;
  source.loopStart = start;
  source.loopEnd = end;
  gain.gain.setValueAtTime(0, t);
  gain.gain.linearRampToValueAtTime(level, t + .002);
  source.connect(gain).connect(chain.input);
  if (!source.loop){
    const stop = t + length / source.playbackRate.value;
    gain.gain.setValueAtTime(level, Math.max(t + .002, stop - .005));
    gain.gain.linearRampToValueAtTime(0, Math.max(t + .003, stop))
  }
  const voice = {
    source,
    gain,
    time: t,
    offset,
    audition,
    level,
    audio: p.audio,
    stopping: false
  };
  voiceStore.add(index, voice);
  if (editing)attachEditVoice(voice);
  source.onended = () => {
    voiceStore.remove(index, voice);
    source.disconnect();
    gain.disconnect();
    finishEditVoice(voice);
    renderVoiceLights()
  };
  if (source.loop)source.start(t, offset);
  else source.start(t, offset, length);
  renderVoiceLights();
}
async function playPad(index, options = {
}){
  if (!ready)return;
  if (uiMode === 'edit')return playEditPreview(index, !!options.toggle);
  const epoch = playEpoch;
  try{
    await ensureAudio();
    if (epoch !== playEpoch)return;
    if (options.toggle && hasActiveVoice(index)){
      stopVoice(index);
      return
    }
    if (!pads[index].audio){
      notify('空のパッドです。取り込みモードで音源を入れてください。');
      return
    }
    if (options.isHeld && pads[index].gate && !options.isHeld())return;
    trigger(index, !!options.audition)
  }catch (e){
    notify(e.message)
  }
}
function allStop(){
  playEpoch++;
  resetEditTransport(slot());
  releaseAllVoices();
  clearPerformanceHolds();
  renderVoiceLights()
}

const editor = createEditTransport({
  selection: { sample: current, slot, mode: () => uiMode, canInteract },
  playback: {
    epoch: () => playEpoch,
    cancelPending: () => { playEpoch++; },
    latestActiveVoice, voicePositionSeconds, releaseVoice, releaseAllVoices,
    hasActiveVoice, stopVoice, trigger, ensureAudio
  },
  view: {
    renderVoiceLights, syncPlaybackDisplay, notify,
    hasWaveform: () => !!playbackWaveDrawing && !playbackWaveFailedVoice
  },
  clearPerformanceHolds
});
const {
  editRange, editSeekEnd, editorTransport, editPositionSeconds,
  resetEditTransport, attachEditVoice, finishEditVoice, leaveEditTransport,
  stopEditingPlayback, enterEditTransport, startEditFromCue, playEditPreview,
  pauseEditPlayback, toggleEditPlayback, canSeekEditPlayback,
  beginEditSeek, setEditCue, finishEditSeek
} = editor;

// files.js
function clearAudioImportTarget(){
  chooserPending = false;
  audioImportTarget = null;
}
function consumeAudioImportTarget(){
  const target = audioImportTarget;
  clearAudioImportTarget();
  return target;
}
function openImport(index){
  if (!canInteract() || chooserPending)return;
  audioImportTarget = index;
  chooserPending = true;
  try{
    $('audioFiles').value = '';
    $('audioFiles').click()
  }catch (e){
    clearAudioImportTarget();
    notify('ファイル選択を開けませんでした。もう一度パッドをタップしてください。\n' + e.message)
  }finally{
    chooserPending = false
  }
}
function audioFromBuffer(b){
  const audio = {
    rate: b.sampleRate,
    channels: Array.from({
      length: Math.min(2, b.numberOfChannels)
    }, (_, i) => b.getChannelData(i).slice())
  };
  if (b.numberOfChannels <= 2)bufferCache.set(audio, b);
  return audio
}
async function importAudio(files, target){
  if (!files.length || !ready)return;
  const file = files[0];
  busy(true);
  try{
    if (file.size > MAX_FILE_BYTES)throw Error('ファイルは200MB以内にしてください。');
    const context = getAudioContext(),
    buffer = await context.decodeAudioData(await file.arrayBuffer());
    if (buffer.duration > MAX_DURATION)throw Error('音源は10分以内にしてください。');
    if (!buffer.length)throw Error('音声データがありません。');
    const replacement = {
      ...createEmptySample(),
      name: file.name.replace(/\.[^.]+$/, '').slice(0, 80) || 'Sample',
      audio: audioFromBuffer(buffer)
    };
    stopVoice(target);
    pads[target] = replacement;
    bank = Math.floor(target / PAD_COUNT);
    selected = target % PAD_COUNT;
    markSave(target);
    renderAll();
    await flushSave();
    notify(BANKS[bank] + '.' + String(selected + 1).padStart(2, '0') + ' に取り込みました。' + (autosave.failed ? '\nメニューからバックアップを保存してください。': '\n次回も自動復元します。'))
  }catch (e){
    notify('取り込めませんでした。元の音源はそのままです。\n' + (e.name === 'EncodingError' ? '対応していない形式、または壊れた音声ファイルです。': e.message))
  }finally{
    busy(false)
  }
}
function download(blob, name){
  const url = URL.createObjectURL(blob),
  a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000)
}

// Backup operations and progress presentation.
const { createBinaryBackup, readBackup } = createBackupCodec({ prepareSettings });
function backupProgress(message, done, total) {
  const text = message + ' ' + Math.floor(clamp(done / (total || 1), 0, 1) * 100) + '%';
  if ($('busyOverlay').textContent !== text)busy(true, text);
}
async function runBackupTask(message, failureMessage, operation) {
  if (!ready || isBusy())return;
  busy(true, message);
  try{
    await operation();
  }catch (error){
    notify(failureMessage + error.message);
  }finally{
    busy(false);
  }
}
async function exportProject() {
  return runBackupTask('バックアップを作成中… 0%', 'バックアップを作成できませんでした：', async () => {
    await backupYield();
    await flushSave();
    const blob = await createBinaryBackup(snapshot(), pads, {
      onProgress: (done, total) => backupProgress('バックアップを作成中…', done, total)
    });
    const date = new Date();
    const filename = 'SX12-' + [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(value => String(value).padStart(2, '0')).join('-') + '.sx12';
    download(blob, filename);
    notify('音源と設定入りのバックアップを作成しました。ブラウザの保存先をご確認ください。');
  });
}
async function loadProject(file) {
  if (!file || !ready || isBusy())return;
  if (!confirm('現在の全バンク・音源・設定を、このバックアップで置き換えますか？'))return;
  return runBackupTask('バックアップを検証中… 0%', '復元できませんでした：', async () => {
    const prepared = await readBackup(file, {
      onProgress: (done, total) => backupProgress('バックアップを検証中…', done, total)
    });
    // Neither sound data nor current voices change before every validation succeeds.
    allStop();
    applyPreparedSettings(prepared.settings, prepared.sounds);
    autosave.markAllSounds();
    normalizeRanges();
    bufferCache = new WeakMap();
    updateMasterVolume();
    renderAll();
    busy(true, '復元した音源と設定を自動保存中…');
    markSave();
    await flushSave();
    notify(autosave.failed ? '復元しました。自動保存できないためバックアップも残してください。' : '音源と設定を復元しました。');
  });
}

// controller.js
function setMode(mode) {
  if (!MODES.includes(mode) || !ready || isBusy())return;
  if (mode !== uiMode){
    playEpoch++;
    if (uiMode === 'edit')leaveEditTransport();
    uiMode = mode;
    if (mode === 'edit')enterEditTransport();
  }
  renderMode();
  renderPadDetails();
}
function activateMode(mode) {
  setMode(mode);
  // Resume inside the trusted click/key event, before any async boundary.
  if (mode === 'play' && ready)ensureAudio().catch (e => notify(e.message));
}
function selectPad(i) {
  if (uiMode === 'edit' && i !== selected)stopEditingPlayback();
  selected = i;
  renderPadDetails();
  markSave()
}
function setBank(i) {
  if (uiMode === 'edit' && i !== bank)stopEditingPlayback();
  bank = i;
  renderAll();
  markSave()
}
function activatePad(i) {
  const index = bank * PAD_COUNT + i;
  selectPad(i);
  if (uiMode === 'import')openImport(index);
  else if (uiMode === 'play')playPad(index)
}
function setVolume(value) {
  master = clamp(Number(value), 0, 1);
  if (master > 0)lastVolume = master;
  updateMasterVolume();
  renderVolume();
  markSave()
}
function togglePlaybackWaveform() {
  if (!ready || isBusy())return;
  showPlaybackWaveform = !showPlaybackWaveform;
  playbackWaveFailedVoice = null;
  syncPlaybackDisplay();
  markSave();
}
function updateSample(fn) {
  const index = slot();
  if (!pads[index].audio)return;
  stopVoice(index);
  fn(pads[index]);
  resetEditTransport(index);
  renderPadDetails();
  markSave()
}
function renameSample(name) {
  if (!current().audio)return;
  // Renaming should not stop an active voice, unlike audio-setting edits.
  current().name = name.slice(0, 80);
  // Leave the name input intact while the user is typing.
  renderPadDetails({ includeEditor: false });
  markSave();
}
function setTrim(which, seconds) {
  const p = current(),
  duration = audioDuration(p);
  if (!duration || !Number.isFinite(seconds)) {
    renderEditor();
    return
  }
  const gap = 1 / p.audio.channels[0].length;
  updateSample(sample => {
    if (which === 'start')sample.start = clamp(seconds / duration, 0, sample.end - gap);
    else sample.end = clamp(seconds / duration, sample.start + gap, 1)
  })
}
function deleteCurrent() {
  const index = slot();
  if (!pads[index].audio)return notify('空のパッドです。');
  if (!confirm('「' + soundName(pads[index]) + '」を削除しますか？'))return;
  stopVoice(index);
  pads[index] = createEmptySample();
  markSave(index);
  renderAll();
  if (panel)closePanel();
  notify('音源を削除しました。')
}

// view.js
function notify(message){
  $('toast').textContent = message;
  $('toast').classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => $('toast').classList.add('hidden'), 4500)
}
function busy(on, message = '音源を読み込み中…'){
  $('busyOverlay').textContent = message;
  $('busyOverlay').classList.toggle('hidden', !on);
  document.body.classList.toggle('busy', on)
}
function renderMode(){
  for (const mode of MODES){
    $('device').classList.toggle('mode-' + mode, uiMode === mode);
    const b = $(mode + 'Mode');
    b.classList.toggle('active', uiMode === mode);
    b.setAttribute('aria-selected', String(uiMode === mode));
    b.tabIndex = uiMode === mode ? 0: - 1
  }
  $('workspace').classList.toggle('editing', uiMode === 'edit');
  $('workspace').setAttribute('aria-labelledby', uiMode + 'Mode');
  $('editPanel').classList.toggle('hidden', uiMode !== 'edit');
  $('previewControls').classList.toggle('hidden', uiMode === 'play');
  $('subPad').classList.toggle('hidden', uiMode !== 'import');
  $('pausePreview').classList.toggle('hidden', uiMode !== 'edit');
  const focused = document.activeElement;
  if ((focused === $('subPad') && uiMode !== 'import') || (focused === $('pausePreview') && uiMode !== 'edit'))$(uiMode + 'Mode').focus();
  $('modeHint').textContent = uiMode === 'import' ? 'パッドを押して音源を選択。10分・200MBまで。': uiMode === 'edit' ? 'パッドを選んで編集。再生・一時停止で確認できます。': 'パッドを押して再生します。';
}
function renderBanks(){
  if (!$('banks').children.length)for (let i = 0; i < BANK_COUNT; i++){
    const b = document.createElement('button');
    b.className = 'bank';
    b.textContent = BANKS[i];
    b.onclick = () => setBank(i);
    $('banks').append(b)
  }
  [...$('banks').children].forEach((b, i) => {
    b.classList.toggle('active', bank === i);
    b.setAttribute('aria-pressed', String(bank === i));
    const count = pads.slice(i * PAD_COUNT, i * PAD_COUNT + PAD_COUNT).filter(p => p.audio).length;
    b.setAttribute('aria-label', 'バンク ' + BANKS[i] + '、音源 ' + count + ' 個');
    b.title = 'バンク ' + BANKS[i] + ' · ' + count + '/' + PAD_COUNT
  })
}
function renderPads(){
  if (!$('pads').children.length)for (let i = 0; i < PAD_COUNT; i++){
    const b = document.createElement('button');
    b.className = 'pad';
    b.dataset.pad = String(i);
    b.innerHTML = '<span class="pad-head"><span class="pad-number">' + String(i + 1).padStart(2, '0') + '</span><span class="shortcut">' + KEYS[i].toUpperCase() + '</span></span><span class="pad-name"></span><span class="pad-info"><span class="pad-time"></span><span class="pad-flags"><span class="pad-loop">LOOP</span><span class="pad-gate">GATE</span></span></span><span class="pad-state" aria-hidden="true"></span>';
    bindPerformance(b, () => bank * PAD_COUNT + i, true);
    b.addEventListener('dragover', e => {
      e.preventDefault();
      if (uiMode === 'import' && !panel)b.classList.add('dragging')
    });
    b.addEventListener('dragleave', () => b.classList.remove('dragging'));
    b.addEventListener('drop', e => {
      e.preventDefault();
      b.classList.remove('dragging');
      if (uiMode !== 'import' || !canInteract())return;
      selectPad(i);
      importAudio([...e.dataTransfer.files], bank * PAD_COUNT + i)
    });
    $('pads').append(b)
  }
  [...$('pads').children].forEach((b, i) => {
    const p = pads[bank * PAD_COUNT + i];
    b.classList.toggle('selected', i === selected);
    b.classList.toggle('empty', !p.audio);
    b.querySelector('.pad-name').textContent = p.audio ? soundName(p): '空のパッド';
    b.querySelector('.pad-time').textContent = p.audio ? formatTime(clipDuration(p)): (uiMode === 'import' ? '＋ 取り込み': '—');
    for (const flag of PLAYBACK_FLAGS)b.querySelector('.pad-' + flag).classList.toggle('hidden', uiMode === 'edit' || !p.audio || !p[flag]);
    b.querySelector('.pad-flags').classList.toggle('hidden', uiMode === 'edit' || !p.audio || (!p.loop && !p.gate));
    const action = uiMode === 'import' ? '取り込み': uiMode === 'edit' ? '編集': '再生',
    settings = p.audio ? '、' + formatTime(clipDuration(p)) + (uiMode !== 'edit' && p.loop ? '、LOOP': '') + (uiMode !== 'edit' && p.gate ? '、GATE': ''): '';
    b.title = action + '：' + BANKS[bank] + '.' + (i + 1) + ' ' + soundName(p) + settings;
    b.setAttribute('aria-label', 'パッド ' + (i + 1) + ' ' + (p.audio ? soundName(p): '空') + '、' + action + settings)
  });
}
const PLAYBACK_BUTTON_ICONS = {
  play: 'm8 5 11 7-11 7z',
  pause: 'M6 5h4v14H6zM14 5h4v14h-4z',
  stop: 'M6 6h12v12H6z'
};
function renderPlaybackButton(buttonId, labelId, iconId, label, description, pressed, icon){
  const button = $(buttonId);
  $(labelId).textContent = label;
  button.setAttribute('aria-pressed', String(pressed));
  button.setAttribute('aria-label', description);
  button.title = description;
  $(iconId).setAttribute('d', PLAYBACK_BUTTON_ICONS[icon]);
}
function renderImportPreview(previewing){
  renderPlaybackButton('subPad', 'previewLabel', 'previewIcon', '試聴', previewing ? '試聴を停止' : '試聴', previewing, previewing ? 'stop' : 'play');
}
function renderVoiceLights(){
  const { count, activePads } = getVoiceActivity();
  const running = ctx?.state === 'running',
  previewing = activePads.has(slot()) || (uiMode === 'edit' && editorTransport().pending);
  $('activeCount').textContent = (count && !running ? '待機中 ': '再生中 ') + count;
  [...$('pads').children].forEach((b, i) => b.classList.toggle('playing', running && activePads.has(bank * PAD_COUNT + i)));
  renderImportPreview(previewing);
  syncPlaybackDisplay();
}
function renderSample(){
  const p = current(),
  address = BANKS[bank] + '.' + String(selected + 1).padStart(2, '0'),
  name = p.audio ? soundName(p): '空のパッド',
  info = p.audio ? formatTime(clipDuration(p)) + ' · ' + (p.loop && p.gate ? 'GATE + LOOP': p.loop ? 'LOOP': p.gate ? 'GATE': 'ONE SHOT'): '取り込みモードで音源を選択';
  $('playbackTarget').textContent = address;
  $('playbackReadout').textContent = name;
  $('playbackReadout').title = name;
  $('playbackDuration').textContent = info;
  $('playbackDuration').title = '';
  $('playbackDuration').classList.toggle('is-playing', false);
  if (uiMode === 'edit')renderEditPosition();
  for (const mode of PLAYBACK_FLAGS){
    $(mode).classList.toggle('active', p[mode]);
    $(mode).setAttribute('aria-pressed', String(p[mode]));
    $(mode).disabled = !p.audio;
    $(mode).classList.toggle('hidden', uiMode === 'edit');
  }
}
function renderEditPosition(transport){
  if (uiMode !== 'edit')return;
  transport ??= editorTransport();
  $('playbackDuration').textContent = current().audio ? formatPreciseTime(editPositionSeconds(transport)) : '—';
  $('playbackDuration').classList.toggle('is-playing', transport.state === 'playing' && ctx?.state === 'running');
  $('playbackDuration').title = '元音源上の再生位置';
}
function renderEditTransport(){
  if (uiMode !== 'edit')return;
  const transport = editorTransport();
  renderEditPosition(transport);
  const playing = transport.state === 'playing';
  const label = playing ? '再生を一時停止' : '選択音源を再生';
  renderPlaybackButton('pausePreview', 'pausePreviewLabel', 'pausePreviewIcon', playing ? '一時停止' : '再生', label, playing, playing ? 'pause' : 'play');
  $('pausePreview').disabled = !current().audio || transport.pending || editor.isSeeking;
}
function renderWaveformPreference(){
  $('waveformToggleLabel').textContent = '波形表示：' + (showPlaybackWaveform ? 'オン' : 'オフ');
  $('toggleWaveform').setAttribute('aria-pressed', String(showPlaybackWaveform));
}
function renderEditSeekValue(){
  const seconds = editPositionSeconds();
  $('playbackWaveform').setAttribute('aria-valuenow', String(seconds));
  $('playbackWaveform').setAttribute('aria-valuetext', seconds.toFixed(3) + ' 秒');
}
function renderEditSeekControl(){
  const graph = $('playbackWaveform');
  const seekable = canSeekEditPlayback();
  graph.classList.toggle('is-seekable', seekable);
  graph.classList.toggle('is-seeking', editor.isSeeking);
  graph.setAttribute('role', seekable ? 'slider' : 'img');
  graph.tabIndex = seekable ? 0 : -1;
  graph.title = seekable ? 'タップ・ドラッグで再生位置を移動' : '';
  if (seekable){
    const range = editRange();
    graph.setAttribute('aria-label', soundName(current()) + 'の再生位置');
    graph.setAttribute('aria-orientation', 'horizontal');
    graph.setAttribute('aria-valuemin', String(range.start));
    graph.setAttribute('aria-valuemax', String(editSeekEnd(range)));
    renderEditSeekValue();
  }else{
    for (const name of ['aria-orientation', 'aria-valuemin', 'aria-valuemax', 'aria-valuenow', 'aria-valuetext'])graph.removeAttribute(name);
  }
}
function renderVolume(){
  if (master > 0)lastVolume = master;
  $('volume').value = Math.round(master * 100);
  $('volume').style.setProperty('--fill', master * 100 + '%');
  $('volumeOut').textContent = Math.round(master * 100) + '%';
  $('mute').classList.toggle('muted', master === 0);
  $('mute').setAttribute('aria-pressed', String(master === 0));
  $('mute').setAttribute('aria-label', master === 0 ? 'ミュートを解除': 'ミュート');
  $('speakerWaves').setAttribute('d', master === 0 ? 'M17 9l5 6m0-6-5 6': 'M17 8c3 2 3 6 0 8m3-11c5 4 5 10 0 14')
}
function renderEditor(){
  if (uiMode !== 'edit')return;
  const p = current(),
  duration = audioDuration(p),
  enabled = !!p.audio;
  $('editorSlot').textContent = BANKS[bank] + ' / ' + String(selected + 1).padStart(2, '0');
  $('sampleName').value = enabled ? p.name: '';
  $('sampleFormat').textContent = enabled ? (p.audio.channels.length === 1 ? 'MONO': 'STEREO') + ' / ' + (p.audio.rate / 1000).toFixed(1) + ' kHz': '音源がありません';
  $('editDuration').textContent = enabled ? formatTime(duration): '—';
  $('trimStart').value = (p.start * duration).toFixed(3);
  $('trimEnd').value = (p.end * duration).toFixed(3);
  $('trimStart').max = duration;
  $('trimEnd').max = duration;
  $('startTime').textContent = formatPreciseTime(p.start * duration);
  $('endTime').textContent = formatPreciseTime(p.end * duration);
  $('sampleGain').value = Math.round(p.gain * 100);
  $('sampleGain').style.setProperty('--fill', p.gain / 1.5 * 100 + '%');
  $('sampleGainOut').textContent = Math.round(p.gain * 100) + '%';
  $('pitch').value = p.pitch;
  $('pitch').style.setProperty('--fill', (p.pitch + 24) / 48 * 100 + '%');
  $('pitchOut').textContent = (p.pitch > 0 ? '+': '') + p.pitch + ' st';
  for (const id of ['sampleName', 'trimStart', 'trimEnd', 'sampleGain', 'pitch', 'resetSample', 'editDelete', 'startHandle', 'endHandle'])$(id).disabled = !enabled;
  $('waveEmpty').classList.toggle('hidden', enabled);
  for (const [id, pos] of [['startHandle', p.start], ['endHandle', p.end]]){
    const handle = $(id);
    handle.style.left = 'clamp(7px,' + pos * 100 + '%,calc(100% - 7px))';
    handle.setAttribute('aria-valuemax', String(duration));
    handle.setAttribute('aria-valuenow', String(pos * duration));
    handle.setAttribute('aria-valuetext', (pos * duration).toFixed(3) + ' 秒')
  }
  drawWave();
}
function renderPadDetails({ includeEditor = true } = {}) {
  // Update each part once; individual renderers do not trigger other renderers.
  renderPads();
  renderSample();
  if (includeEditor)renderEditor();
  renderVoiceLights();
  fitPads();
}
function renderAll(){
  renderVolume();
  renderMode();
  renderBanks();
  renderPadDetails();
}
function showPanel(name){
  finishEditSeek(true);
  panel = name;
  $('face').inert = true;
  $('funcPanel').classList.toggle('hidden', name !== 'func');
  $('helpPanel').classList.toggle('hidden', name !== 'help');
  $('func').setAttribute('aria-expanded', 'true');
  $(name === 'func' ? 'closeFunc': 'closeHelp').focus();
  syncPlaybackDisplay();
}
function closePanel(){
  panel = null;
  $('funcPanel').classList.add('hidden');
  $('helpPanel').classList.add('hidden');
  $('face').inert = false;
  $('func').setAttribute('aria-expanded', 'false');
  $('func').focus();
  syncPlaybackDisplay();
}

// waveform.js
function drawWave(){
  if (uiMode !== 'edit')return;
  const canvas = $('wave'),
  rect = canvas.getBoundingClientRect();
  if (rect.width < 1)return;
  const ratio = Math.min(window.devicePixelRatio || 1, 2),
  width = Math.round(rect.width * ratio),
  height = Math.round(rect.height * ratio);
  canvas.width = width;
  canvas.height = height;
  const g = canvas.getContext('2d');
  g.clearRect(0, 0, width, height);
  g.strokeStyle = '#26313e';
  g.lineWidth = 1;
  for (let i = 1; i < 8; i++){
    g.beginPath();
    g.moveTo(i * width / 8, 0);
    g.lineTo(i * width / 8, height);
    g.stroke()
  }
  g.beginPath();
  g.moveTo(0, height / 2);
  g.lineTo(width, height / 2);
  g.stroke();
  const p = current();
  if (!p.audio)return;
  const peaks = getWavePeaks(p.audio, width);
  drawWavePeaks(g, peaks, width, height, {
    start: p.start,
    end: p.end,
    level: p.gain,
    activeColor: '#93c8de',
    inactiveColor: '#485768'
  });
  g.fillStyle = '#080b1050';
  g.fillRect(0, 0, width * p.start, height);
  g.fillRect(width * p.end, 0, width * (1 - p.end), height)
}

// playback-waveform.js
const PLAYBACK_DISPLAY_INTERVAL = 1000 / 30;
let playbackDisplayFrame = null;
let playbackDisplayLastFrame = null;
let playbackWaveDrawing = null;
let playbackWaveFailedVoice = null;
function shouldShowPlaybackWaveform(){
  return uiMode === 'edit' || showPlaybackWaveform;
}

function playbackWavePosition(voice, now) {
  return clamp(voicePositionSeconds(voice, now) / voice.source.buffer.duration, 0, 1);
}

function pausePlaybackDisplay() {
  if (playbackDisplayFrame !== null)window.cancelAnimationFrame?.(playbackDisplayFrame);
  playbackDisplayFrame = null;
  playbackDisplayLastFrame = null;
}

function setPlaybackGraphState(state) {
  const graph = $('playbackWaveform');
  graph.classList.toggle('hidden', state === 'hidden');
  graph.classList.toggle('is-idle', state === 'idle');
  if (state === 'idle')graph.setAttribute('aria-label', '再生待機中の空の波形グラフ');
  if (state !== 'playing'){
    playbackWaveDrawing = null;
  }
}

function failPlaybackWaveform(voice) {
  // A canvas/animation failure must never stop or restart audio.
  playbackWaveFailedVoice = voice;
  setPlaybackGraphState('idle');
}

function editWaveDisplay(){
  const transport = editorTransport();
  if (transport.voice && !transport.voice.stopping)return transport.voice;
  const p = current();
  const range = editRange(p);
  // A lightweight descriptor draws a stopped waveform without creating Web Audio.
  if (!transport.display){
    transport.display = {
      audio: p.audio, level: p.gain,
      duration: range.duration, start: range.start, end: range.end
    };
  }
  return transport.display;
}

function playbackWaveData(display){
  if (!display.source)return display;
  return {
    audio: display.audio, level: display.level,
    duration: display.source.buffer.duration,
    start: display.source.loopStart, end: display.source.loopEnd
  };
}

function drawPlaybackWaveform(voice) {
  const canvas = $('playbackWave');
  const rect = $('playbackWaveform').getBoundingClientRect();
  if (rect.width < 1 || rect.height < 1)return false;
  const ratio = Math.min(window.devicePixelRatio || 1, 2);
  const width = Math.max(1, Math.round(rect.width * ratio));
  const height = Math.max(1, Math.round(rect.height * ratio));
  const data = playbackWaveData(voice);
  const start = data.start / data.duration;
  const end = data.end / data.duration;
  const level = data.level;
  const previous = playbackWaveDrawing;
  if (!previous || previous.audio !== voice.audio || previous.width !== width || previous.height !== height || previous.start !== start || previous.end !== end || previous.level !== level){
    const graphics = canvas.getContext('2d');
    if (!graphics)throw Error('Canvas is unavailable');
    canvas.width = width;
    canvas.height = height;
    const peaks = getWavePeaks(voice.audio, width);
    graphics.clearRect(0, 0, width, height);
    graphics.strokeStyle = '#2b3c4c';
    graphics.lineWidth = 1;
    graphics.beginPath();
    graphics.moveTo(0, height / 2);
    graphics.lineTo(width, height / 2);
    graphics.stroke();
    drawWavePeaks(graphics, peaks, width, height, {
      start,
      end,
      level,
      activeColor: '#94d1e8',
      inactiveColor: '#48596a',
      pixelOffset: .5
    });
    if (start > 0 || end < 1){
      graphics.fillStyle = '#8098ab';
      if (start > 0)graphics.fillRect(Math.round(start * width), 0, 1, height);
      if (end < 1)graphics.fillRect(Math.min(width - 1, Math.round(end * width)), 0, 1, height);
    }
    playbackWaveDrawing = { audio: voice.audio, width, height, start, end, level };
  }
  playbackWaveDrawing.voice = voice;
  playbackWaveDrawing.cssWidth = rect.width;
  const address = BANKS[bank] + '.' + String(selected + 1).padStart(2, '0');
  $('playbackWaveform').setAttribute('aria-label', address + '「' + soundName(current()) + '」の全体波形と再生位置');
  return true;
}

function updatePlaybackPlayhead(voice) {
  const position = uiMode === 'edit' ? editPositionSeconds() / audioDuration(current()) : playbackWavePosition(voice, ctx.currentTime);
  const pixels = position * Math.max(0, playbackWaveDrawing.cssWidth - 2);
  $('playbackPlayhead').style.transform = 'translateX(' + pixels.toFixed(2) + 'px)';
  if (uiMode === 'edit')renderEditSeekValue();
}

function canAnimatePlaybackDisplay(voice) {
  return !!voice && ctx?.state === 'running' && !document.hidden && !panel && (uiMode === 'edit' || (showPlaybackWaveform && !!playbackWaveDrawing && !playbackWaveFailedVoice));
}

function queuePlaybackDisplayFrame() {
  if (playbackDisplayFrame === null && typeof window.requestAnimationFrame === 'function'){
    playbackDisplayFrame = window.requestAnimationFrame(animatePlaybackDisplay);
  }
}

function animatePlaybackDisplay(timestamp) {
  playbackDisplayFrame = null;
  const voice = latestActiveVoice(slot());
  if (!canAnimatePlaybackDisplay(voice)){
    syncPlaybackDisplay();
    return;
  }
  if (playbackDisplayLastFrame === null || timestamp - playbackDisplayLastFrame + .01 >= PLAYBACK_DISPLAY_INTERVAL){
    renderEditPosition();
    try{
      if (shouldShowPlaybackWaveform() && playbackWaveDrawing?.voice === voice && voice !== playbackWaveFailedVoice){
        updatePlaybackPlayhead(voice);
      }
    }catch{
      failPlaybackWaveform(voice);
    }
    playbackDisplayLastFrame = timestamp;
  }
  if (canAnimatePlaybackDisplay(voice))queuePlaybackDisplayFrame();
}

function renderPlaybackGraph(display){
  if (!shouldShowPlaybackWaveform()){
    playbackWaveFailedVoice = null;
    setPlaybackGraphState('hidden');
  }else if (!display){
    playbackWaveFailedVoice = null;
    setPlaybackGraphState('idle');
  }else if (display === playbackWaveFailedVoice){
    setPlaybackGraphState('idle');
  }else{
    playbackWaveFailedVoice = null;
    try{
      setPlaybackGraphState('playing');
      if (drawPlaybackWaveform(display)){
        updatePlaybackPlayhead(display);
      }else setPlaybackGraphState('idle');
    }catch{
      failPlaybackWaveform(display);
    }
  }
}

function syncPlaybackDisplay() {
  renderEditTransport();
  renderWaveformPreference();
  const voice = latestActiveVoice(slot());
  const editing = uiMode === 'edit' && !!current().audio;
  const display = editing ? editWaveDisplay() : ctx?.state === 'running' ? voice : null;
  if (document.hidden || panel){
    pausePlaybackDisplay();
    return;
  }
  renderPlaybackGraph(display);
  renderEditSeekControl();
  if (canAnimatePlaybackDisplay(voice))queuePlaybackDisplayFrame();
  else pausePlaybackDisplay();
}

// input.js
// Clear gesture ownership without stopping audio, e.g. when entering the editor.
function clearPerformanceHolds(){
  heldKeys.clear();
  pointerPads.clear();
}
function releaseHeldInput(held, id) {
  const index = held.get(id);
  held.delete(id);
  if (index !== undefined && uiMode !== 'edit' && pads[index].gate)stopVoice(index);
}
function releaseHeldInputs(held) {
  for (const id of held.keys())releaseHeldInput(held, id);
}
function releasePointer(e) {
  releaseHeldInput(pointerPads, e.pointerId);
}
function bindPerformance(button, getIndex, isPad) {
  let deferredTap = null;
  button.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !canInteract() || (!isPad && uiMode !== 'import'))return;
    deferredTap = null;
    // File pickers and the first touch audio unlock must run from a completed tap.
    if (isPad && uiMode === 'import')return;
    const index = getIndex();
    if ((e.pointerType === 'touch' || e.pointerType === 'pen') && ctx?.state !== 'running' && (!isPad || uiMode === 'play')) {
      deferredTap = {
        index,
        pointerId: e.pointerId
      };
      return
    }
    e.preventDefault();
    button.focus({
      preventScroll: true
    });
    if (isPad) {
      selectPad(index % PAD_COUNT);
      if (uiMode === 'edit')return
    }
    try{
      button.setPointerCapture?.(e.pointerId)
    }catch{
    }
    pointerPads.set(e.pointerId, index);
    playPad(index, {
      audition: !isPad && uiMode === 'import',
      toggle: !isPad,
      isHeld: () => pointerPads.has(e.pointerId)
    });
  });
  for (const name of POINTER_RELEASE_EVENTS)button.addEventListener(name, releasePointer);
  button.addEventListener('pointercancel', () => {
    deferredTap = null
  });
  button.addEventListener('click', e => {
    if (!canInteract() || (!isPad && uiMode !== 'import'))return;
    if (isPad && uiMode === 'import') {
      deferredTap = null;
      activatePad(getIndex() % PAD_COUNT);
      return
    }
    const deferred = deferredTap;
    deferredTap = null;
    if (!deferred && (e.detail !== 0 || ['touch', 'pen', 'mouse'].includes(e.pointerType)))return;
    const index = deferred?.index ?? getIndex();
    if (isPad)selectPad(index % PAD_COUNT);
    if (isPad && uiMode === 'edit')return;
    const audition = !isPad && uiMode === 'import';
    if (deferred && pads[index].gate && !audition) {
      ensureAudio().then(() => notify('音を有効にしました。もう一度パッドを押している間、再生します。')).catch (e => notify(e.message));
      return
    }
    playPad(index, {
      audition,
      toggle: !isPad
    });
  });
}
// Shared key mapping; callers supply the bounds for trim handles or playback cues.
function keyboardPositionSeconds(e, position, start, end){
  const step = e.shiftKey ? .1 : .01;
  if (['ArrowLeft', 'ArrowDown'].includes(e.key))return position - step;
  if (['ArrowRight', 'ArrowUp'].includes(e.key))return position + step;
  if (e.key === 'Home')return start;
  if (e.key === 'End')return end;
  return null;
}
function bindTrim(id, which) {
  const handle = $(id);
  let drag = null;
  handle.addEventListener('pointerdown', e => {
    if (handle.disabled)return;
    e.preventDefault();
    handle.focus({
      preventScroll: true
    });
    handle.setPointerCapture(e.pointerId);
    drag = e.pointerId;
    move(e)
  });
  function move(e) {
    if (drag !== e.pointerId)return;
    const rect = $('waveZone').getBoundingClientRect(),
    duration = audioDuration(current());
    setTrim(which, clamp((e.clientX - rect.left) / rect.width, 0, 1) * duration)
  }
  handle.addEventListener('pointermove', move);
  for (const event of POINTER_RELEASE_EVENTS)handle.addEventListener(event, () => {
    drag = null
  });
  handle.addEventListener('keydown', e => {
    const p = current(),
    duration = audioDuration(p);
    const position = (which === 'start' ? p.start: p.end) * duration;
    const seconds = keyboardPositionSeconds(e, position, 0, duration);
    if (seconds === null)return;
    e.preventDefault();
    e.stopPropagation();
    setTrim(which, seconds)
  })
}
function bindPlaybackSeek(){
  const graph = $('playbackWaveform');
  function move(e){
    if (editor.seekPointerId !== e.pointerId)return;
    const rect = graph.getBoundingClientRect();
    if (rect.width > 0){
      const position = clamp((e.clientX - rect.left) / Math.max(1, rect.width - 2), 0, 1);
      setEditCue(position * audioDuration(current()));
    }
  }
  graph.addEventListener('pointerdown', e => {
    if (e.button !== 0 || !beginEditSeek(e.pointerId))return;
    e.preventDefault();
    graph.focus({ preventScroll: true });
    try{ graph.setPointerCapture(e.pointerId); }catch{}
    move(e);
  });
  graph.addEventListener('pointermove', move);
  graph.addEventListener('pointerup', e => {
    if (editor.seekPointerId !== e.pointerId)return;
    move(e);
    finishEditSeek();
  });
  for (const name of ['pointercancel', 'lostpointercapture'])graph.addEventListener(name, e => {
    if (editor.seekPointerId === e.pointerId)finishEditSeek(true);
  });
  graph.addEventListener('keydown', e => {
    if (!canSeekEditPlayback())return;
    const range = editRange();
    const seconds = keyboardPositionSeconds(e, editPositionSeconds(), range.start, range.end);
    if (seconds === null)return;
    e.preventDefault();
    e.stopPropagation();
    if (beginEditSeek('keyboard')){
      setEditCue(seconds);
      finishEditSeek();
    }
  });
}
function padShortcutAction(e){
  const key = e.key.toLowerCase();
  const isPad = e.target.classList.contains('pad');
  let local = KEYS.indexOf(key);
  let preview = false;
  if (key === ' '){
    // Other buttons keep their native Space activation, including editor playback.
    if (e.target.tagName === 'BUTTON' && !isPad && e.target.id !== 'subPad')return null;
    local = isPad ? Number(e.target.dataset.pad) : selected;
    preview = uiMode === 'edit' || e.target.id === 'subPad' || e.target.tagName !== 'BUTTON';
  }else if (key === 'enter' && isPad)local = Number(e.target.dataset.pad);
  else if (key === 'enter' && e.target.id === 'subPad'){
    local = selected;
    preview = true;
  }
  return local < 0 || (preview && uiMode === 'play') ? null : { key, local, preview };
}
function bindKeyboardEvents() {
  document.addEventListener('dragover', e => e.preventDefault());
  document.addEventListener('drop', e => e.preventDefault());
  window.addEventListener('keydown', e => {
    if (panel) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closePanel();
        return
      }
      if (e.key === 'Tab') {
        const visible = $(panel === 'func' ? 'funcPanel': 'helpPanel'),
        items = [...visible.querySelectorAll('button,a[href]')],
        first = items[0],
        last = items.at( - 1);
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus()
        }else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus()
        }
      }
      return
    }
    if (e.key === 'Escape') {
      allStop();
      return
    }
    if (!ready || isBusy() || e.ctrlKey || e.metaKey || e.altKey || ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.target.tagName) || e.target.getAttribute('role') === 'slider')return;
    if (e.repeat)return;
    const action = padShortcutAction(e);
    if (!action)return;
    const { key, local, preview } = action;
    e.preventDefault();
    const index = bank * PAD_COUNT + local;
    selectPad(local);
    if (uiMode === 'import' && !preview) {
      openImport(index);
      return
    }
    if (uiMode === 'edit'){
      if (preview)toggleEditPlayback();
      return;
    }
    heldKeys.set(key, index);
    playPad(index, {
      audition: preview && uiMode === 'import',
      toggle: preview,
      isHeld: () => heldKeys.has(key)
    });
  });
  window.addEventListener('keyup', e => {
    releaseHeldInput(heldKeys, e.key.toLowerCase());
  });
  window.addEventListener('pointerup', releasePointer);
  window.addEventListener('pointercancel', releasePointer);
  window.addEventListener('blur', () => {
    finishEditSeek(true);
    releaseHeldInputs(heldKeys);
    releaseHeldInputs(pointerPads);
  });
}

// layout.js
function fitPads(){
  const grid = $('pads'),
  height = grid.clientHeight || grid.getBoundingClientRect().height;
  if (!height)return;
  const style = window.getComputedStyle?.(grid),
  frame = parseFloat(style?.getPropertyValue('--pad-frame-space')) || 46,
  rowHeight = (height - frame) / 3;
  grid.dataset.density = rowHeight >= 100 ? 'full': rowHeight >= 58 ? 'compact': rowHeight >= 40 ? 'short': rowHeight >= 24 ? 'minimal': 'micro';
  grid.style.setProperty('--pad-number-size', Math.max(8, Math.min(12, Math.floor(rowHeight - 4))) + 'px')
}
function fitViewport(){
  const viewport = window.visualViewport,
  width = viewport?.width || window.innerWidth,
  height = viewport?.height || window.innerHeight;
  if (!width || !height)return;
  const style = document.documentElement.style;
  style.setProperty('--viewport-width', width + 'px');
  style.setProperty('--viewport-height', height + 'px');
  style.setProperty('--viewport-top', (viewport?.offsetTop || 0) + 'px');
  style.setProperty('--viewport-left', (viewport?.offsetLeft || 0) + 'px');
  $('device').classList.toggle('compact', height <= 620);
  $('device').classList.toggle('landscape', height <= 540 && width >= 640);
  $('device').classList.toggle('short-portrait', height < 480 && width < 640);
  fitPads();
  syncPlaybackDisplay();
}
function bindLayoutEvents(){
  window.addEventListener('resize', fitViewport);
  if (window.visualViewport){
    window.visualViewport.addEventListener('resize', fitViewport);
    window.visualViewport.addEventListener('scroll', fitViewport)
  }
  if (window.ResizeObserver){
    const layoutObserver = new ResizeObserver(() => {
      drawWave();
      fitPads();
      syncPlaybackDisplay();
    });
    layoutObserver.observe($('waveZone'));
    layoutObserver.observe($('pads'));
    layoutObserver.observe($('headerDisplay'));
  }
}

// events.js
function bindModeControls() {
  for (const mode of MODES) {
    $(mode + 'Mode').onclick = () => activateMode(mode);
    $(mode + 'Mode').addEventListener('keydown', event => {
      let index = MODES.indexOf(mode);
      if (event.key === 'ArrowRight') index = (index + 1) % MODES.length;
      else if (event.key === 'ArrowLeft') index = (index + MODES.length - 1) % MODES.length;
      else if (event.key === 'Home') index = 0;
      else if (event.key === 'End') index = MODES.length - 1;
      else return;
      event.preventDefault();
      const nextMode = MODES[index];
      activateMode(nextMode);
      $(nextMode + 'Mode').focus();
    });
  }
}
function bindPlaybackControls() {
  $('volume').oninput = e => setVolume(Number(e.target.value) / 100);
  $('mute').onclick = () => setVolume(master === 0 ? lastVolume: 0);
  for (const flag of PLAYBACK_FLAGS)$(flag).onclick = () => updateSample(p => {
    p[flag] = !p[flag]
  });
  $('stopAll').onclick = allStop;
  bindPerformance($('subPad'), slot, false);
  $('pausePreview').onclick = toggleEditPlayback;
}
function bindImportControls() {
  $('audioFiles').onchange = e => {
    const files = [...e.target.files],
    target = consumeAudioImportTarget();
    e.target.value = '';
    if (files.length && target !== null)importAudio(files, target)
  };
  $('audioFiles').addEventListener('cancel', clearAudioImportTarget);
}
function bindEditorControls() {
  $('sampleName').oninput = e => {
    renameSample(e.target.value)
  };
  $('sampleName').onchange = e => {
    if (current().audio && !e.target.value.trim()) {
      renameSample('Sample');
      e.target.value = 'Sample'
    }
  };
  $('trimStart').onchange = e => setTrim('start', Number(e.target.value));
  $('trimEnd').onchange = e => setTrim('end', Number(e.target.value));
  $('sampleGain').oninput = e => updateSample(p => {
    p.gain = Number(e.target.value) / 100
  });
  $('pitch').oninput = e => updateSample(p => {
    p.pitch = Number(e.target.value)
  });
  $('resetSample').onclick = () => updateSample(p => {
    p.start = 0;
    p.end = 1;
    p.pitch = 0;
    p.gain = 1
  });
  $('editDelete').onclick = deleteCurrent;
  bindTrim('startHandle', 'start');
  bindTrim('endHandle', 'end');
  bindPlaybackSeek();
}
function bindMenuControls() {
  $('toggleWaveform').onclick = togglePlaybackWaveform;
  $('func').onclick = () => showPanel('func');
  $('closeFunc').onclick = closePanel;
  $('helpButton').onclick = () => showPanel('help');
  $('installApp').onclick = () => { showPanel('help'); $('helpPanel').scrollTop = 0; };
  $('closeHelp').onclick = () => showPanel('func');
  $('recoverAudio').onclick = recoverAudio;
  $('exportProject').onclick = exportProject;
  $('loadProject').onclick = () => {
    if (!ready || isBusy())return;
    $('projectFile').value = '';
    $('projectFile').click();
  };
  $('projectFile').onchange = e => {
    const file = e.target.files[0];
    e.target.value = '';
    if (file) {
      closePanel();
      loadProject(file)
    }
  };
}
function saveBeforePageHide(){
  finishEditSeek(true);
  pausePlaybackDisplay();
  flushSave();
}
function bindLifecycleEvents() {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden)saveBeforePageHide();
    else resumeAudio()
  });
  window.addEventListener('pagehide', saveBeforePageHide);
  window.addEventListener('focus', resumeAudio);
  window.addEventListener('pageshow', resumeAudio);
  window.addEventListener('beforeunload', e => {
    if (autosave.inFlight || autosave.hasUnsavedAudio) {
      e.preventDefault();
      e.returnValue = ''
    }
  });
}
function bindUIEvents() {
  bindModeControls();
  bindPlaybackControls();
  bindImportControls();
  bindEditorControls();
  bindMenuControls();
  bindKeyboardEvents();
  bindLifecycleEvents();
}

// init.js
function initializeSampler(){
  for (let i = 0; i < PAD_COUNT; i++)pads[i] = synth(i);
  bindUIEvents();
  fitViewport();
  bindLayoutEvents();
  renderAll();
  busy(true, '保存した音源を復元中…');
  restore().finally(() => {
    lastVolume = master > 0 ? master: .75;
    renderVolume();
    busy(false)
  });
}
// Used only after the user chooses to apply an available app update.
async function prepareAppUpdate() {
  if (!ready || isBusy())return false;
  await flushSave();
  if (autosave.inFlight || autosave.pending){
    notify('音源と設定を保存できないため更新を中止しました。バックアップを保存してください。');
    return false;
  }
  allStop();
  return true;
}
initializeSampler();
initializePwa({ beforeUpdate: prepareAppUpdate });
