'use strict';
(() => {
  const status = document.getElementById('pwaStatus');
  const updateButton = document.getElementById('checkAppUpdate');
  const updateLabel = document.getElementById('appUpdateLabel');
  const updateNote = document.getElementById('appUpdateNote');
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  let registration;
  let offlineReady = false;
  let applyingUpdate = false;
  let updateInFlight = false;

  function renderStatus() {
    if (!registration)return;
    status.textContent = offlineReady
      ? (navigator.onLine ? 'オフライン準備済み' : 'オフラインで利用中') + (standalone() ? ' · ホーム画面のアプリ' : ' · ホーム画面に追加できます')
      : 'オフライン起動の準備中… オンラインのままお待ちください。';
  }
  function renderUpdate() {
    const waiting = registration?.waiting;
    updateLabel.textContent = waiting ? '保存して更新を適用' : 'アプリの更新を確認';
    updateNote.textContent = waiting ? '音源と設定を保存して再起動します（再生は停止）' : '再生を続けたまま確認できます';
  }
  async function requestPersistentStorage() {
    if (!standalone() || !navigator.storage?.persist)return;
    try {
      if (!await navigator.storage.persisted())await navigator.storage.persist();
    } catch { /* The sampler's existing save-error and backup controls remain available. */ }
  }
  async function inspectOfflineCache() {
    const worker = registration?.active;
    if (!worker)return;
    offlineReady = await new Promise(resolve => {
      const channel = new MessageChannel();
      const timer = setTimeout(() => { channel.port1.close(); resolve(false); }, 4000);
      channel.port1.onmessage = event => {
        clearTimeout(timer);
        channel.port1.close();
        resolve(event.data?.ready === true);
      };
      worker.postMessage({ type: 'CHECK_OFFLINE' }, [channel.port2]);
    });
    renderStatus();
  }
  function observeInstallingWorker() {
    const worker = registration.installing;
    if (!worker)return;
    worker.addEventListener('statechange', () => {
      if (worker.state === 'installed')renderUpdate();
      if (worker.state === 'activated')inspectOfflineCache();
      if (worker.state === 'redundant' && !offlineReady)status.textContent = 'オフライン準備に失敗しました。通信を確認してページを開き直してください。';
    });
  }
  updateButton.addEventListener('click', async () => {
    if (!registration || updateInFlight)return;
    updateInFlight = true;
    updateButton.disabled = true;
    try {
      if (registration.waiting) {
        const prepared = await window.samplerBeforeUpdate?.();
        if (!prepared)return;
        applyingUpdate = true;
        updateNote.textContent = '更新を適用しています…';
        registration.waiting.postMessage({ type: 'SKIP_WAITING' });
        return;
      }
      updateNote.textContent = '更新を確認しています…';
      await registration.update();
      renderUpdate();
      if (!registration.waiting)updateNote.textContent = registration.installing ? '新しいバージョンを準備しています…' : '最新のバージョンです';
      await inspectOfflineCache();
    } catch {
      updateNote.textContent = '通信を確認して、もう一度お試しください。';
    } finally {
      updateInFlight = false;
      updateButton.disabled = false;
    }
  });
  if (!('serviceWorker' in navigator) || !window.isSecureContext) {
    status.textContent = 'PWAのインストールとオフライン起動には、SafariでHTTPSのURLを開いてください。';
    updateButton.disabled = true;
    return;
  }
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (applyingUpdate)window.location.reload();
    else inspectOfflineCache();
  });
  window.addEventListener('online', () => { renderStatus(); registration?.update().catch(() => {}); });
  window.addEventListener('offline', renderStatus);
  window.addEventListener('pageshow', requestPersistentStorage);
  window.addEventListener('appinstalled', () => { renderStatus(); requestPersistentStorage(); });
  (async () => {
    try {
      registration = await navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' });
      registration.addEventListener('updatefound', observeInstallingWorker);
      observeInstallingWorker();
      renderUpdate();
      renderStatus();
      navigator.serviceWorker.ready.then(inspectOfflineCache).catch(() => {});
      await requestPersistentStorage();
    } catch {
      status.textContent = 'オフライン起動を準備できませんでした。HTTPSのURLと通信状態を確認し、ページを開き直してください。';
      updateButton.disabled = true;
    }
  })();
})();
