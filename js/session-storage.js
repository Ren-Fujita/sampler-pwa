import { STORAGE_NAME, STORAGE_VERSION } from './config.js';

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transactionComplete(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}

export function openSessionDatabase() {
  const request = indexedDB.open(STORAGE_NAME, STORAGE_VERSION);
  request.onupgradeneeded = () => {
    request.result.createObjectStore('session');
    request.result.createObjectStore('sounds', { keyPath: 'id' });
  };
  return requestResult(request);
}

export async function readSession(database) {
  const transaction = database.transaction(['session', 'sounds'], 'readonly');
  const [stored, sounds] = await Promise.all([
    requestResult(transaction.objectStore('session').get('current')),
    requestResult(transaction.objectStore('sounds').getAll())
  ]);
  return { stored, sounds };
}

export function writeSession(database, settings, samples, changedIndices) {
  const transaction = database.transaction(['session', 'sounds'], 'readwrite');
  transaction.objectStore('session').put(settings, 'current');
  for (const index of changedIndices) {
    transaction.objectStore('sounds').put({ id: index, audio: samples[index].audio });
  }
  return transactionComplete(transaction);
}
