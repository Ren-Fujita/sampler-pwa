import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createEmptySample, audioDuration, clipDuration, formatTime, formatPreciseTime } from '../js/sample.js';
import { synth } from '../js/presets.js';
import { parseSessionSettings, createEmptyPatterns } from '../js/session.js';
import { getWavePeaks } from '../js/waveform.js';

const fixture = async name => JSON.parse(await readFile(new URL('./fixtures/' + name, import.meta.url), 'utf8'));

test('all twelve factory sounds are byte-identical to the old implementation', async () => {
  const references = await fixture('presets.json');
  for (const [index, expected] of references.entries()) {
    const sample = synth(index);
    const pcm = sample.audio.channels[0];
    assert.deepEqual({ name: sample.name, rate: sample.audio.rate, frames: pcm.length,
      sha256: createHash('sha256').update(Buffer.from(pcm.buffer)).digest('hex') }, expected);
  }
});

test('sample duration accounts for trim and pitch without altering PCM', () => {
  const sample = { ...createEmptySample(), start: .25, end: .75, pitch: 12,
    audio: { rate: 8000, channels: [new Float32Array(16000)] } };
  assert.equal(audioDuration(sample), 2);
  assert.equal(clipDuration(sample), .5);
  assert.equal(formatTime(65), '1:05');
  assert.equal(formatTime(.5), '0.50 s');
  assert.equal(formatPreciseTime(.5), '0.500 s');
});

test('normalizes legacy settings and preserves the caller-provided legacy patterns', async () => {
  const session = await fixture('session.json');
  const fallback = createEmptyPatterns();
  fallback[2][3][4] = true;
  delete session.patterns;
  Object.assign(session, { bank: 999, selected: -1, master: 999 });
  Object.assign(session.pads[0], { start: -.5, end: 2, pitch: -100, gain: 10 });
  const parsed = parseSessionSettings(session, fallback);
  assert.equal(parsed.bank, 9);
  assert.equal(parsed.selected, 0);
  assert.equal(parsed.master, 1);
  assert.equal(parsed.pads[0].start, 0);
  assert.equal(parsed.pads[0].end, 1);
  assert.equal(parsed.pads[0].pitch, -24);
  assert.equal(parsed.pads[0].gain, 1.5);
  assert.equal(parsed.patterns, fallback);
  assert.throws(() => parseSessionSettings({ ...session, pads: [] }), /形式/);
});

test('waveform extrema include both stereo channels', () => {
  const audio = { rate: 8000, channels: [Float32Array.of(-.5, .25, -.125, .75), Float32Array.of(-.75, .5, -.25, 1)] };
  assert.deepEqual(Array.from(getWavePeaks(audio, 2)), [-.75, .5, -.25, 1]);
});
