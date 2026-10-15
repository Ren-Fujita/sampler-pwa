import { clamp, audioDuration } from './sample.js';

export function createEditTransport({ selection, playback, view, clearPerformanceHolds }) {
  // Transient editor transport. PCM, pad settings and saved snapshots remain unchanged.
  let editTransport = null;
  let editActionVersion = 0;
  let editSeek = null;

  function editRange(p = selection.sample()){
    const duration = audioDuration(p);
    return { start: p.start * duration, end: p.end * duration, duration };
  }
  function editSeekEnd(range){
    // Playback cannot start at the exclusive trim end: retain one source frame.
    return Math.max(range.start, range.end - 1 / selection.sample().audio.rate);
  }
  function editorTransport(){
    const p = selection.sample();
    if (!editTransport || editTransport.index !== selection.slot() || editTransport.audio !== p.audio){
      editTransport = { index: selection.slot(), audio: p.audio, position: editRange(p).start, state: 'stopped', voice: null, pending: false };
    }
    return editTransport;
  }
  function editPositionSeconds(transport = editorTransport()){
    return transport.voice && !transport.voice.stopping ? playback.voicePositionSeconds(transport.voice) : transport.position;
  }
  function resetEditTransport(index){
    if (editTransport?.index !== index)return;
    leaveEditTransport();
  }
  function attachEditVoice(voice){
    const transport = editorTransport();
    transport.voice = voice;
    transport.position = voice.offset;
    transport.state = 'playing';
    transport.pending = false;
  }
  function finishEditVoice(voice){
    if (!voice.stopping && editTransport?.voice === voice){
      editTransport.voice = null;
      editTransport.state = 'stopped';
      editTransport.position = editRange().start;
    }
  }
  function leaveEditTransport(){
    editActionVersion++;
    editSeek = null;
    editTransport = null;
  }
  function stopEditingPlayback(){
    playback.cancelPending();
    leaveEditTransport();
    playback.releaseAllVoices();
    clearPerformanceHolds();
  }
  function enterEditTransport(){
    const latest = playback.latestActiveVoice(selection.slot());
    const position = latest ? playback.voicePositionSeconds(latest) : editRange().start;
    // Drop held performance gestures: editor preview is controlled by taps.
    clearPerformanceHolds();
    leaveEditTransport();
    playback.releaseAllVoices(latest);
    if (!latest)return;
    const range = editRange();
    const inside = position >= range.start && position < range.end;
    if (!latest.audition && !latest.source.loop && inside){
      attachEditVoice(latest);
    }else{
      playback.releaseVoice(latest);
      playback.trigger(selection.slot(), false, { offset: inside ? position : range.start });
    }
  }
  async function startEditFromCue(){
    if (!selection.canInteract() || selection.mode() !== 'edit' || !selection.sample().audio || editSeek)return;
    const transport = editorTransport();
    const index = selection.slot();
    const audio = selection.sample().audio;
    const position = transport.position;
    const version = ++editActionVersion;
    const epoch = playback.epoch();
    transport.pending = true;
    view.renderVoiceLights();
    try{
      // Keep resume inside the original trusted tap, including on iPhone.
      await playback.ensureAudio();
      if (version !== editActionVersion || epoch !== playback.epoch() || selection.mode() !== 'edit' || selection.slot() !== index || selection.sample().audio !== audio)return;
      playback.trigger(index, false, { offset: position });
    }catch (e){
      if (version === editActionVersion)view.notify(e.message);
    }finally{
      if (version === editActionVersion){
        transport.pending = false;
        view.renderVoiceLights();
      }
    }
  }
  function playEditPreview(index, toggle){
    if (index !== selection.slot() || selection.mode() !== 'edit' || !selection.canInteract() || editSeek)return;
    const transport = editorTransport();
    if (toggle && (playback.hasActiveVoice(index) || transport.pending)){
      playback.stopVoice(index);
      return;
    }
    return startEditFromCue();
  }
  function pauseEditPlayback(){
    const transport = editorTransport();
    if (!transport.voice || transport.voice.stopping)return;
    const voice = transport.voice;
    transport.position = playback.voicePositionSeconds(voice);
    transport.voice = null;
    transport.state = 'paused';
    editActionVersion++;
    playback.releaseVoice(voice);
    view.renderVoiceLights();
  }
  function toggleEditPlayback(){
    if (!selection.canInteract() || selection.mode() !== 'edit' || !selection.sample().audio || editSeek)return;
    const transport = editorTransport();
    if (transport.pending)return;
    if (transport.state === 'playing')pauseEditPlayback();
    else return startEditFromCue();
  }
  function canSeekEditPlayback(){
    return selection.mode() === 'edit' && selection.canInteract() && !!selection.sample().audio && !editorTransport().pending && view.hasWaveform();
  }
  function beginEditSeek(pointerId){
    if (!canSeekEditPlayback() || editSeek)return false;
    const transport = editorTransport();
    const position = editPositionSeconds(transport);
    const state = transport.state;
    editActionVersion++;
    // Capture the prior state first: dragging pauses sound until the gesture ends.
    if (state === 'playing')pauseEditPlayback();
    editSeek = { pointerId, transport, index: selection.slot(), audio: selection.sample().audio, position, state };
    view.syncPlaybackDisplay();
    return true;
  }
  function setEditCue(seconds){
    if (!editSeek || !Number.isFinite(seconds))return;
    const transport = editorTransport();
    if (transport !== editSeek.transport)return;
    const range = editRange();
    transport.position = clamp(seconds, range.start, editSeekEnd(range));
    view.syncPlaybackDisplay();
  }
  function finishEditSeek(cancelled = false){
    const seek = editSeek;
    editSeek = null;
    if (!seek || selection.mode() !== 'edit' || selection.slot() !== seek.index || selection.sample().audio !== seek.audio || editTransport !== seek.transport)return;
    const transport = seek.transport;
    if (cancelled)transport.position = seek.position;
    transport.state = seek.state === 'playing' ? 'paused' : seek.state;
    if (seek.state === 'playing')return startEditFromCue();
    view.syncPlaybackDisplay();
  }


  return {
    editRange,
    editSeekEnd,
    editorTransport,
    editPositionSeconds,
    resetEditTransport,
    attachEditVoice,
    finishEditVoice,
    leaveEditTransport,
    stopEditingPlayback,
    enterEditTransport,
    startEditFromCue,
    playEditPreview,
    pauseEditPlayback,
    toggleEditPlayback,
    canSeekEditPlayback,
    beginEditSeek,
    setEditCue,
    finishEditSeek,
    get isSeeking() { return !!editSeek; },
    get seekPointerId() { return editSeek?.pointerId; }
  };
}
