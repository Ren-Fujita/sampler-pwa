import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const markup = await readFile(new URL('index.html', root), 'utf8');
const inputMarkup = markup.match(/<input\b[^>]*id="volume"[^>]*>/)[0];
const rangeStep = inputMarkup.match(/\bstep="([^"]+)"/)[1];

async function environment() {
  const elements = new Map();
  function element(id) {
    if (!elements.has(id)) {
      let value = '';
      const attributes = new Map(), properties = new Map(), classes = new Set();
      elements.set(id, {
        get value() { return value; },
        set value(next) {
          const number = Number(next);
          value = String(id === 'volume' && rangeStep !== 'any'
            ? Math.round(number / Number(rangeStep)) * Number(rangeStep) : next);
        },
        textContent: '', attributes, properties,
        setAttribute: (name, next) => attributes.set(name, String(next)),
        style: { setProperty: (name, next) => properties.set(name, next) },
        classList: { toggle(name, enabled) { enabled ? classes.add(name) : classes.delete(name); } },
        addEventListener() {}
      });
    }
    return elements.get(id);
  }
  const context = vm.createContext({ document: { getElementById: element },
    setTimeout, clearTimeout, Blob, TextEncoder, TextDecoder, atob });
  const modules = new Map();
  const entry = new URL('js/app.js', root).href;
  function getModule(url) {
    if (!modules.has(url)) {
      let source = readFileSync(new URL(url), 'utf8');
      if (url === entry) {
        const startup = 'initializeSampler();\ninitializePwa({ beforeUpdate: prepareAppUpdate });';
        assert(source.includes(startup));
        // Exercise the actual application handlers without starting browser APIs.
        source = source.replace(startup, `
          export { renderVolume, bindPlaybackControls, snapshot, applySettings };
          export const setVolume = masterVolume.set;
          export function useTestAudio(context, gain) {
            ctx = context;
            chain = { master: { gain } };
          }
        `);
      }
      modules.set(url, new vm.SourceTextModule(source, { context, identifier: url }));
    }
    return modules.get(url);
  }
  const app = await getModule(entry);
  await app.link((specifier, from) => getModule(new URL(specifier, from.identifier).href));
  await app.evaluate();
  const calls = [];
  const clock = { currentTime: 12.5 };
  app.namespace.useTestAudio(clock, {
    setValueAtTime: (...args) => calls.push(args),
    setTargetAtTime() { throw Error('volume must not introduce a ramp'); }
  });
  app.namespace.bindPlaybackControls();
  app.namespace.renderVolume();
  function input(percent) {
    element('volume').value = percent;
    element('volume').oninput({ target: element('volume') });
  }
  function key(key, modifiers = {}) {
    let prevented = false;
    element('volume').onkeydown({ key, ...modifiers, preventDefault: () => prevented = true });
    return prevented;
  }
  return { app: app.namespace, element, input, key, calls, clock };
}

test('fractional dragging does not snap to displayed whole percentages', async () => {
  const e = await environment();
  assert.equal(rangeStep, 'any');
  for (const percent of [12.1, 12.2, 12.3, 12.6]) {
    e.input(percent);
    assert(Math.abs(e.app.snapshot().master - percent / 100) < 1e-12);
    assert(Math.abs(Number(e.element('volume').value) - percent) < 1e-10);
    assert.equal(e.element('volumeOut').textContent, Math.round(percent) + '%');
  }
});

test('the display and spoken value cover every whole percentage from 0 to 100', async () => {
  const e = await environment();
  for (let percent = 0; percent <= 100; percent++) {
    e.input(percent);
    const label = percent + '%';
    assert.equal(e.element('volumeOut').textContent, label);
    assert.equal(e.element('volume').attributes.get('aria-valuetext'), label);
  }
});

test('volume reaches the audio parameter at the current time without a ramp or extra wait', async () => {
  const e = await environment();
  for (const percent of [25.2, 87.3, 0, 100]) {
    e.clock.currentTime += .001;
    e.input(percent);
    assert.deepEqual(e.calls.at(-1), [percent / 100, e.clock.currentTime]);
  }
  assert.equal(e.calls.length, 4);
});

test('mute restores the exact fractional volume on unmute', async () => {
  const e = await environment();
  e.input(38.27);
  e.element('mute').onclick();
  assert.equal(e.app.snapshot().master, 0);
  assert.equal(e.element('volumeOut').textContent, '0%');
  assert.equal(e.element('mute').attributes.get('aria-pressed'), 'true');
  e.element('mute').onclick();
  assert(Math.abs(e.app.snapshot().master - .3827) < 1e-12);
  assert.equal(e.element('volumeOut').textContent, '38%');
  assert.equal(e.element('mute').attributes.get('aria-pressed'), 'false');
});

test('keyboard changes whole percentages, supports endpoints and leaves Tab alone', async () => {
  const e = await environment();
  e.input(75.3);
  for (const [key, expected] of [['ArrowUp', 76], ['ArrowDown', 75], ['ArrowRight', 76],
    ['ArrowLeft', 75], ['PageUp', 85], ['PageDown', 75], ['Home', 0], ['ArrowDown', 0],
    ['End', 100], ['ArrowUp', 100]]) {
    assert.equal(e.key(key), true);
    assert.equal(e.element('volumeOut').textContent, expected + '%');
  }
  assert.equal(e.key('Tab'), false);
  assert.equal(e.key('ArrowDown', { ctrlKey: true }), false);
  assert.equal(e.app.snapshot().master, 1);
});

test('saved and restored volume keeps its fractional precision', async () => {
  const first = await environment();
  first.input(63.479);
  const saved = JSON.parse(JSON.stringify(first.app.snapshot()));
  const second = await environment();
  second.app.applySettings(saved);
  second.app.renderVolume();
  assert.equal(second.app.snapshot().master, saved.master);
  assert(Math.abs(Number(second.element('volume').value) - 63.479) < 1e-10);
  assert.equal(second.element('volumeOut').textContent, '63%');
});

test('invalid input does not poison the audio gain and out-of-range values are bounded', async () => {
  const e = await environment();
  e.app.setVolume(NaN);
  e.app.setVolume(Infinity);
  assert.equal(e.app.snapshot().master, .75);
  assert.equal(e.calls.length, 0);
  e.app.setVolume(-1);
  assert.equal(e.app.snapshot().master, 0);
  e.app.setVolume(2);
  assert.equal(e.app.snapshot().master, 1);
});
