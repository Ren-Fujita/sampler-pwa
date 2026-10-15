const COPY = Object.freeze({
  check: 'アプリの更新を確認',
  apply: '保存して更新を適用',
  checkNote: '再生を続けたまま確認できます',
  applyNote: '音源と設定を保存して再起動します（再生は停止）',
  preparing: 'オフライン起動の準備中… オンラインのままお待ちください。',
  unavailable: 'PWAのインストールとオフライン起動には、SafariでHTTPSのURLを開いてください。',
  installFailed: 'オフライン準備に失敗しました。通信を確認してページを開き直してください。',
  registerFailed: 'オフライン起動を準備できませんでした。HTTPSのURLと通信状態を確認し、ページを開き直してください。'
});
const OFFLINE_CHECK_TIMEOUT = 4000;

function isStandalone() {
  return window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
}

async function requestPersistentStorage() {
  if (!isStandalone() || !navigator.storage?.persist)return;
  try {
    if (!await navigator.storage.persisted())await navigator.storage.persist();
  } catch { /* IndexedDB failures are reported by the sampler's save controls. */ }
}

function hasOfflineShell(worker) {
  if (!worker)return Promise.resolve(false);
  return new Promise(resolve => {
    const channel = new MessageChannel();
    function finish(ready) {
      clearTimeout(timer);
      channel.port1.close();
      resolve(ready);
    }
    const timer = setTimeout(() => finish(false), OFFLINE_CHECK_TIMEOUT);
    channel.port1.onmessage = event => finish(event.data?.ready === true);
    try {
      worker.postMessage({ type: 'CHECK_OFFLINE' }, [channel.port2]);
    } catch {
      finish(false);
    }
  });
}

// The sampler supplies its save/stop operation; no application globals are exposed.
export function initializePwa({ beforeUpdate }) {
  const ui = {
    status: document.getElementById('pwaStatus'),
    button: document.getElementById('checkAppUpdate'),
    label: document.getElementById('appUpdateLabel'),
    note: document.getElementById('appUpdateNote')
  };
  let registration;
  let offlineReady = false;
  let applyingUpdate = false;
  let updateInFlight = false;

  function renderStatus() {
    if (!registration)return;
    const connection = navigator.onLine ? 'オフライン準備済み' : 'オフラインで利用中';
    const launch = isStandalone() ? ' · ホーム画面のアプリ' : ' · ホーム画面に追加できます';
    ui.status.textContent = offlineReady ? connection + launch : COPY.preparing;
  }

  function renderUpdate() {
    const waiting = !!registration?.waiting;
    ui.label.textContent = waiting ? COPY.apply : COPY.check;
    ui.note.textContent = waiting ? COPY.applyNote : COPY.checkNote;
  }

  async function inspectOfflineCache() {
    if (!registration?.active)return;
    offlineReady = await hasOfflineShell(registration.active);
    renderStatus();
  }

  function observeInstallingWorker() {
    const worker = registration.installing;
    if (!worker)return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed')renderUpdate();
      if (worker.state === 'activated')inspectOfflineCache();
      if (worker.state === 'redundant' && !offlineReady)ui.status.textContent = COPY.installFailed;
    });
  }

  async function applyWaitingUpdate(worker) {
    if (!await beforeUpdate())return;
    applyingUpdate = true;
    ui.note.textContent = '更新を適用しています…';
    worker.postMessage({ type: 'SKIP_WAITING' });
  }

  async function checkForUpdate() {
    ui.note.textContent = '更新を確認しています…';
    await registration.update();
    renderUpdate();
    if (!registration.waiting) {
      ui.note.textContent = registration.installing ? '新しいバージョンを準備しています…' : '最新のバージョンです';
    }
    await inspectOfflineCache();
  }

  async function handleUpdateClick() {
    if (!registration || updateInFlight)return;
    updateInFlight = true;
    ui.button.disabled = true;
    try {
      const worker = registration.waiting;
      if (worker)await applyWaitingUpdate(worker);
      else await checkForUpdate();
    } catch {
      applyingUpdate = false;
      ui.note.textContent = '通信を確認して、もう一度お試しください。';
    } finally {
      updateInFlight = false;
      ui.button.disabled = false;
    }
  }

  function bindLifecycleEvents() {
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (applyingUpdate)window.location.reload();
      else inspectOfflineCache();
    });
    window.addEventListener('online', () => {
      renderStatus();
      registration?.update().catch(() => {});
    });
    window.addEventListener('offline', renderStatus);
    window.addEventListener('pageshow', requestPersistentStorage);
    window.addEventListener('appinstalled', () => {
      renderStatus();
      requestPersistentStorage();
    });
  }

  async function registerWorker() {
    try {
      registration = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
      registration.addEventListener('updatefound', observeInstallingWorker);
      observeInstallingWorker();
      renderUpdate();
      renderStatus();
      navigator.serviceWorker.ready.then(inspectOfflineCache).catch(() => {});
      await requestPersistentStorage();
    } catch {
      ui.status.textContent = COPY.registerFailed;
      ui.button.disabled = true;
    }
  }

  ui.button.addEventListener('click', handleUpdateClick);
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    ui.status.textContent = COPY.unavailable;
    ui.button.disabled = true;
    return Promise.resolve();
  }
  bindLifecycleEvents();
  return registerWorker();
}
