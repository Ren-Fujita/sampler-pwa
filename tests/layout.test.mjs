import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayout } from '../js/layout.js';

function eventSource() {
  const events = new Map();
  return { events, addEventListener: (name, listener) => events.set(name, listener) };
}

function environment() {
  const css = new Map(), padCss = new Map(), classes = new Set(), effects = [], observed = [];
  const grid = { clientHeight: 346, dataset: {}, getBoundingClientRect: () => ({ height: 346 }),
    style: { setProperty: (key, value) => padCss.set(key, value) } };
  const device = { classList: { toggle(key, enabled) { enabled ? classes.add(key) : classes.delete(key); } } };
  const elements = { pads: grid, device, waveZone: {}, headerDisplay: {} };
  let resizeObserved;
  const browser = {
    ...eventSource(), innerWidth: 390, innerHeight: 844,
    visualViewport: { ...eventSource(), width: 390, height: 800, offsetTop: 12, offsetLeft: 3 },
    getComputedStyle: () => ({ getPropertyValue: () => '46' }),
    ResizeObserver: class {
      constructor(callback) { resizeObserved = callback; }
      observe(element) { observed.push(element); }
    }
  };
  const layout = createLayout({ getWindow: () => browser,
    getDocument: () => ({ documentElement: { style: { setProperty: (key, value) => css.set(key, value) } } }),
    getElement: id => elements[id], drawWave: () => effects.push('wave'),
    syncPlaybackDisplay: () => effects.push('playback') });
  return { layout, browser, elements, css, padCss, classes, effects, observed,
    resizeObserved: () => resizeObserved() };
}

test('uses the visual viewport size and offsets and refreshes the playback display', () => {
  const e = environment();
  e.layout.fitViewport();
  assert.deepEqual(Object.fromEntries(e.css), { '--viewport-width': '390px', '--viewport-height': '800px',
    '--viewport-top': '12px', '--viewport-left': '3px' });
  assert.equal(e.elements.pads.dataset.density, 'full');
  assert.deepEqual(e.effects, ['playback']);
});

test('adapts compact, landscape and short portrait classes without leaving stale ones', () => {
  const e = environment();
  delete e.browser.visualViewport;
  Object.assign(e.browser, { innerWidth: 844, innerHeight: 390 });
  e.layout.fitViewport();
  assert.deepEqual([...e.classes].sort(), ['compact', 'landscape']);
  Object.assign(e.browser, { innerWidth: 390, innerHeight: 470 });
  e.layout.fitViewport();
  assert.deepEqual([...e.classes].sort(), ['compact', 'short-portrait']);
  e.browser.innerHeight = 844;
  e.layout.fitViewport();
  assert.deepEqual([...e.classes], []);
});

test('pad density follows available height and hidden layouts do not overwrite sizing', () => {
  const e = environment();
  for (const [rowHeight, density] of [[100, 'full'], [58, 'compact'], [40, 'short'], [24, 'minimal'], [10, 'micro']]) {
    e.elements.pads.clientHeight = rowHeight * 3 + 46;
    e.layout.fitPads();
    assert.equal(e.elements.pads.dataset.density, density);
  }
  assert.equal(e.padCss.get('--pad-number-size'), '8px');
  e.elements.pads.clientHeight = 0;
  e.elements.pads.getBoundingClientRect = () => ({ height: 0 });
  e.layout.fitPads();
  assert.equal(e.elements.pads.dataset.density, 'micro');
  e.browser.innerWidth = 0;
  delete e.browser.visualViewport;
  e.layout.fitViewport();
  assert.deepEqual(e.effects, []);
});

test('resize and viewport events refresh layout and observers redraw in the existing order', () => {
  const e = environment();
  e.layout.bind();
  assert.deepEqual(e.observed, [e.elements.waveZone, e.elements.pads, e.elements.headerDisplay]);
  e.browser.events.get('resize')();
  e.browser.visualViewport.events.get('resize')();
  e.browser.visualViewport.events.get('scroll')();
  assert.deepEqual(e.effects, ['playback', 'playback', 'playback']);
  e.effects.length = 0;
  e.resizeObserved();
  assert.deepEqual(e.effects, ['wave', 'playback']);
});

test('resize handling also works when visualViewport and ResizeObserver are absent', () => {
  const e = environment();
  delete e.browser.visualViewport;
  delete e.browser.ResizeObserver;
  e.layout.bind();
  e.browser.events.get('resize')();
  assert.equal(e.css.get('--viewport-height'), '844px');
  assert.equal(e.css.get('--viewport-top'), '0px');
  assert.deepEqual(e.effects, ['playback']);
});
