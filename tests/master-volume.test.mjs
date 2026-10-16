import test from 'node:test';
import assert from 'node:assert/strict';
import { createMasterVolume } from '../js/master-volume.js';

function environment() {
  const calls = [];
  const node = () => ({ setAttribute() {}, style: { setProperty() {} }, classList: { toggle() {} } });
  const elements = { input: node(), output: node(), mute: node(), waves: node() };
  const volume = createMasterVolume({
    getElements() { calls.push('render'); return elements; },
    applyGain: value => calls.push(['gain', value]),
    onChange: () => calls.push('save')
  });
  return { volume, calls, elements };
}

test('restoring a setting has no audio, view or save effects until requested', () => {
  const e = environment();
  assert.equal(e.volume.restore(.63479), true);
  assert.equal(e.volume.value, .63479);
  assert.deepEqual(e.calls, []);
  e.volume.applyToAudio();
  e.volume.render();
  assert.deepEqual(e.calls, [['gain', .63479], 'render']);
  assert.equal(e.elements.output.textContent, '63%');
});

test('each user adjustment writes audio, renders and requests one save in that order', () => {
  const e = environment();
  e.volume.set(.3827);
  assert.deepEqual(e.calls, [['gain', .3827], 'render', 'save']);
  e.calls.length = 0;
  e.volume.render();
  e.volume.render();
  assert.deepEqual(e.calls, ['render', 'render'], 'redrawing must not write gain or save');
});

test('restoring zero retains the last audible level; invalid values leave it intact', () => {
  const e = environment();
  e.volume.restore(.3827);
  e.volume.restore(0);
  assert.equal(e.volume.restore(NaN), false);
  assert.equal(e.volume.restore(Infinity), false);
  assert.equal(e.volume.value, 0);
  e.volume.toggleMute();
  assert.equal(e.volume.value, .3827);
  e.volume.toggleMute();
  assert.equal(e.volume.value, 0);
});

test('a newly muted session uses the default unmute level and instances share no state', () => {
  const first = environment();
  const second = environment();
  first.volume.restore(0);
  second.volume.set(.1245);
  first.volume.toggleMute();
  assert.equal(first.volume.value, .75);
  assert.equal(second.volume.value, .1245);
});
