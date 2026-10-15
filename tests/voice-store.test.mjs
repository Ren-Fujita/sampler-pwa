import test from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceStore } from '../js/voice-store.js';

test('tracks polyphony, latest voice and oldest voice across pads', () => {
  const voices = createVoiceStore();
  const first = { time: 1, stopping: false };
  const overlapping = { time: 3, stopping: false };
  const otherPad = { time: 2, stopping: false };
  voices.add(0, first);
  voices.add(0, overlapping);
  voices.add(4, otherPad);
  assert.equal(voices.latestActive(0), overlapping);
  assert.equal(voices.activity().count, 3);
  assert.equal(voices.activity().oldest, first);
  assert.deepEqual([...voices.activity().activePads], [0, 4]);
  first.stopping = true;
  assert.equal(voices.activity().count, 2);
  assert.equal(voices.activity().oldest, otherPad);
});

test('release iteration includes fading voices but active counts exclude them', () => {
  const voices = createVoiceStore();
  const fading = { time: 1, stopping: true };
  const running = { time: 2, stopping: false };
  voices.add(0, fading);
  voices.add(1, running);
  const released = [];
  voices.forEach(voice => released.push(voice), 0);
  assert.deepEqual(released, [fading]);
  assert.equal(voices.hasActive(0), false);
  assert.equal(voices.hasActive(1), true);
  voices.remove(1, running);
  assert.equal(voices.latestActive(1), null);
  voices.clear();
  assert.equal(voices.activity().count, 0);
});
