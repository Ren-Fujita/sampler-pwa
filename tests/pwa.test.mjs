import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { initializePwa } from '../pwa.js';

function eventSource() {
  const listeners = new Map();
  return {
    addEventListener(name, callback) { listeners.set(name, callback); },
    emit(name) { return listeners.get(name)?.(); }
  };
}

async function environment(beforeUpdate, { supported = true, waiting = true } = {}) {
  const elements = new Map(['pwaStatus', 'checkAppUpdate', 'appUpdateLabel', 'appUpdateNote'].map(id => [id, { ...eventSource(), textContent: '', disabled: false }]));
  let reloads = 0;
  const messages = [];
  const active = { postMessage(message, ports) { ports[0].postMessage({ ready: true }); ports[0].close(); } };
  const worker = { postMessage(message) { messages.push(message.type); } };
  const registration = { ...eventSource(), active, waiting: waiting ? worker : null, installing: null, update: async () => {} };
  const serviceWorker = { ...eventSource(), register: async () => registration, ready: Promise.resolve(registration) };
  const old = ['window', 'document', 'navigator'].map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]);
  Object.defineProperty(globalThis, 'window', { configurable: true, value: {
    ...eventSource(), isSecureContext: true, matchMedia: () => ({ matches: false }), location: { reload: () => reloads++ }
  } });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: id => elements.get(id) } });
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { onLine: true, ...(supported ? { serviceWorker } : {}) } });
  await initializePwa({ beforeUpdate });
  await delay(5);
  return {
    elements, serviceWorker, messages, reloads: () => reloads,
    click: () => elements.get('checkAppUpdate').emit('click'),
    restore() {
      for (const [name, descriptor] of old) {
        if (descriptor)Object.defineProperty(globalThis, name, descriptor);
        else delete globalThis[name];
      }
    }
  };
}

test('does not apply a waiting update automatically', async () => {
  const e = await environment(async () => { throw Error('must not be called'); });
  try {
    assert(e.elements.get('pwaStatus').textContent.includes('オフライン準備済み'));
    assert.equal(e.elements.get('appUpdateLabel').textContent, '保存して更新を適用');
    e.serviceWorker.emit('controllerchange');
    assert.deepEqual(e.messages, []);
    assert.equal(e.reloads(), 0);
    await delay(5);
  } finally { e.restore(); }
});

test('keeps the current app open when saving fails', async () => {
  const e = await environment(async () => false);
  try {
    await e.click();
    assert.deepEqual(e.messages, []);
    assert.equal(e.reloads(), 0);
    assert.equal(e.elements.get('checkAppUpdate').disabled, false);
  } finally { e.restore(); }
});

test('saves before applying an explicit update and reloading', async () => {
  let saves = 0;
  const e = await environment(async () => { saves++; return true; });
  try {
    await e.click();
    assert.equal(saves, 1);
    assert.deepEqual(e.messages, ['SKIP_WAITING']);
    e.serviceWorker.emit('controllerchange');
    assert.equal(e.reloads(), 1);
  } finally { e.restore(); }
});

test('ignores a second update click while saving is in progress', async () => {
  let saves = 0;
  let finish;
  const e = await environment(() => { saves++; return new Promise(resolve => finish = resolve); });
  try {
    const first = e.click();
    await e.click();
    assert.equal(saves, 1);
    finish(true);
    await first;
    assert.deepEqual(e.messages, ['SKIP_WAITING']);
  } finally { e.restore(); }
});

test('provides an explanatory status when service workers are unsupported', async () => {
  const e = await environment(async () => true, { supported: false });
  try {
    assert.equal(e.elements.get('checkAppUpdate').disabled, true);
    assert(e.elements.get('pwaStatus').textContent.includes('HTTPS'));
  } finally { e.restore(); }
});
