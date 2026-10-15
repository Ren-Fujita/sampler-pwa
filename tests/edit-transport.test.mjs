import test from 'node:test';
import assert from 'node:assert/strict';
import { createEditTransport } from '../js/edit-transport.js';

function environment(ensureAudio = async () => {}) {
  let index = 0;
  let mode = 'edit';
  let epoch = 0;
  let voice = null;
  const sample = { start: .1, end: .9, gain: 1, audio: { rate: 8000, channels: [new Float32Array(8000)] } };
  const triggers = [];
  const releases = [];
  let editor;
  const playback = {
    epoch: () => epoch,
    cancelPending: () => epoch++,
    ensureAudio,
    latestActiveVoice: () => voice,
    voicePositionSeconds: v => v.position ?? v.offset,
    releaseVoice: v => { v.stopping = true; releases.push(v); },
    releaseAllVoices: except => { if (voice && voice !== except)playback.releaseVoice(voice); },
    hasActiveVoice: () => !!voice && !voice.stopping,
    stopVoice: i => { editor.resetEditTransport(i); if (voice)playback.releaseVoice(voice); },
    trigger(i, audition, options) {
      triggers.push({ index: i, audition, offset: options.offset });
      voice = { offset: options.offset, stopping: false, audition: false, source: { loop: false } };
      editor.attachEditVoice(voice);
    }
  };
  editor = createEditTransport({
    selection: { sample: () => sample, slot: () => index, mode: () => mode, canInteract: () => true },
    playback,
    view: { renderVoiceLights() {}, syncPlaybackDisplay() {}, notify() {}, hasWaveform: () => true },
    clearPerformanceHolds() {}
  });
  return { editor, sample, triggers, releases, voice: () => voice,
    setVoice: v => voice = v, setMode: value => mode = value, setIndex: value => index = value,
    stop: () => epoch++ };
}

test('play/pause/resume retains the cue and ending resets it to the trim start', async () => {
  const e = environment();
  assert.equal(e.editor.editorTransport().position, .1);
  await e.editor.startEditFromCue();
  e.voice().position = .4;
  e.editor.pauseEditPlayback();
  assert.equal(e.editor.editorTransport().state, 'paused');
  assert.equal(e.editor.editorTransport().position, .4);
  await e.editor.startEditFromCue();
  assert.deepEqual(e.triggers.map(trigger => trigger.offset), [.1, .4]);
  e.editor.finishEditVoice(e.voice());
  assert.equal(e.editor.editorTransport().state, 'stopped');
  assert.equal(e.editor.editorTransport().position, .1);
});

test('seeking while stopped clamps to the trim and does not start playback', () => {
  const e = environment();
  assert.equal(e.editor.beginEditSeek(12), true);
  assert.equal(e.editor.seekPointerId, 12);
  e.editor.setEditCue(2);
  assert.equal(e.editor.editorTransport().position, .9 - 1 / 8000);
  e.editor.finishEditSeek();
  assert.equal(e.editor.isSeeking, false);
  assert.equal(e.triggers.length, 0);
  assert.equal(e.editor.editorTransport().state, 'stopped');
});

test('cancelling a seek restores the original cue without playing', () => {
  const e = environment();
  e.editor.beginEditSeek(1);
  e.editor.setEditCue(.6);
  e.editor.finishEditSeek(true);
  assert.equal(e.editor.editorTransport().position, .1);
  assert.equal(e.triggers.length, 0);
});

test('seeking while playing pauses the old voice and resumes from the new cue', async () => {
  const e = environment();
  await e.editor.startEditFromCue();
  e.voice().position = .3;
  e.editor.beginEditSeek(7);
  assert.equal(e.releases.length, 1);
  e.editor.setEditCue(.7);
  await e.editor.finishEditSeek();
  assert.equal(e.triggers.at(-1).offset, .7);
  assert.equal(e.editor.editorTransport().state, 'playing');
});

test('a mode switch cancels a preview waiting for audio permission', async () => {
  let unlock;
  const e = environment(() => new Promise(resolve => unlock = resolve));
  const pending = e.editor.startEditFromCue();
  assert.equal(e.editor.editorTransport().pending, true);
  e.editor.leaveEditTransport();
  e.setMode('play');
  unlock();
  await pending;
  assert.equal(e.triggers.length, 0);
});

test('stop, selection changes and replacing PCM cancel stale pending previews', async () => {
  for (const change of [e => e.stop(), e => e.setIndex(1), e => e.sample.audio = { ...e.sample.audio }]) {
    let unlock;
    const e = environment(() => new Promise(resolve => unlock = resolve));
    const pending = e.editor.startEditFromCue();
    change(e);
    unlock();
    await pending;
    assert.equal(e.triggers.length, 0);
  }
});

test('entering edit mode keeps an eligible voice and converts a loop to one shot', () => {
  const e = environment();
  const original = { offset: .3, stopping: false, audition: false, source: { loop: false } };
  e.setVoice(original);
  e.editor.enterEditTransport();
  assert.equal(e.editor.editorTransport().voice, original);
  assert.equal(e.triggers.length, 0);
  original.source.loop = true;
  e.editor.enterEditTransport();
  assert.equal(e.triggers.length, 1);
  assert.equal(e.triggers[0].offset, .3);
  assert.equal(e.voice().source.loop, false);
});
