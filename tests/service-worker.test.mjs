import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const root = new URL('../', import.meta.url);
const source = await readFile(new URL('sw.js', root), 'utf8');
const runtimeFiles = ['index.html', 'styles.css', 'pwa.js', 'manifest.webmanifest',
  'js/app.js', 'js/config.js', 'js/sample.js', 'js/presets.js', 'js/session.js',
  'js/session-storage.js', 'js/backup-codec.js', 'js/audio-utils.js',
  'js/waveform.js', 'js/autosave.js', 'js/edit-transport.js', 'js/voice-store.js',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/icon-maskable-512.png'];

function environment(scope, brokenFile) {
  const events = {};
  const stores = new Map();
  let online = true, skips = 0;
  const caches = {
    async open(name) {
      if (!stores.has(name))stores.set(name, new Map());
      return {
        put: async (url, response) => stores.get(name).set(url, response),
        match: async url => stores.get(name).get(url)
      };
    },
    keys: async () => [...stores.keys()],
    delete: async name => stores.delete(name)
  };
  const self = { registration: { scope }, clients: { claim: async () => {} },
    skipWaiting: async () => skips++, addEventListener: (name, callback) => events[name] = callback };
  const fetch = async request => {
    if (!online)throw Error('offline');
    const relative = request.url.slice(scope.length);
    const body = await readFile(new URL(relative, root));
    const type = relative.endsWith('.html') ? 'text/html' : relative.endsWith('.css') ? 'text/css'
      : relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.png') ? 'image/png' : 'application/manifest+json';
    return { body, ok: relative !== brokenFile, redirected: false, headers: { get: () => type } };
  };
  vm.runInNewContext(source, { self, caches, fetch, Request, URL, Set });
  async function lifetime(name, data = {}) {
    let result;
    events[name]({ ...data, waitUntil: promise => result = promise });
    await result;
  }
  async function get(url, mode = 'cors', method = 'GET') {
    let result;
    events.fetch({ request: { url, method, mode }, respondWith: promise => result = promise });
    return result ? await result : undefined;
  }
  return { stores, lifetime, get, offline: () => online = false, skips: () => skips };
}

for (const scope of ['https://sampler.example/', 'https://sampler.example/sampler-pwa/']) {
  test('all runtime modules and CSS work offline at ' + scope, async () => {
    const e = environment(scope);
    const oldCache = 'sx12-app-shell-' + encodeURIComponent(new URL(scope).pathname) + '-v2';
    e.stores.set(oldCache, new Map());
    e.stores.set('other-app-cache', new Map());
    await e.lifetime('install');
    assert.equal(e.skips(), 0, 'installation must not reload an open performance');
    await e.lifetime('activate');
    assert(!e.stores.has(oldCache));
    assert(e.stores.has('other-app-cache'));
    e.offline();
    for (const file of runtimeFiles) {
      const response = await e.get(scope + file);
      assert(response, 'missing precached dependency: ' + file);
      assert.deepEqual(response.body, await readFile(new URL(file, root)));
    }
    assert(await e.get(scope + '?source=home', 'navigate'));
    assert.equal(await e.get(scope + 'user-audio.wav'), undefined);
    assert.equal(await e.get('https://another.example/index.html'), undefined);
    assert.equal(await e.get(scope, 'cors', 'POST'), undefined);
    let ready;
    await e.lifetime('message', { data: { type: 'CHECK_OFFLINE' }, ports: [{ postMessage: message => ready = message.ready }] });
    assert.equal(ready, true);
    await e.lifetime('message', { data: { type: 'SKIP_WAITING' } });
    assert.equal(e.skips(), 1);
  });
}

test('a missing module prevents partial installation of a broken app', async () => {
  const e = environment('https://sampler.example/', 'js/app.js');
  await assert.rejects(e.lifetime('install'), /App shell unavailable/);
  assert.equal(e.stores.size, 0);
});
