import { writeSession } from './session-storage.js';

export function createAutosave({
  getDatabase,
  getSettings,
  getSamples,
  isReady,
  onError,
  write = writeSession,
  delayMs = 220,
  schedule = setTimeout,
  cancel = clearTimeout
}) {
  let timer = null;
  let savePromise = null;
  let needsSave = false;
  let inFlight = false;
  let failed = false;
  const dirtySounds = new Set();

  function reportFailure() {
    const first = !failed;
    failed = true;
    if (first)onError();
  }

  function mark(index) {
    if (index !== undefined)dirtySounds.add(index);
    needsSave = true;
    if (!isReady())return;
    cancel(timer);
    timer = schedule(flush, delayMs);
  }

  function markAllSounds() {
    for (let index = 0; index < getSamples().length; index++)dirtySounds.add(index);
  }

  async function flush() {
    if (savePromise) {
      await savePromise;
      if (needsSave && !failed)return flush();
      return;
    }
    const database = getDatabase();
    if (!database) {
      if (isReady())reportFailure();
      return;
    }
    if (!needsSave)return;
    inFlight = true;
    needsSave = false;
    const changed = [...dirtySounds];
    dirtySounds.clear();
    savePromise = (async () => {
      try {
        await write(database, getSettings(), getSamples(), changed);
        failed = false;
      } catch {
        changed.forEach(index => dirtySounds.add(index));
        needsSave = true;
        reportFailure();
      } finally {
        inFlight = false;
      }
    })();
    await savePromise;
    savePromise = null;
    if (needsSave && !failed)return flush();
  }

  return {
    mark, markAllSounds, flush, reportFailure,
    get inFlight() { return inFlight; },
    get pending() { return needsSave || dirtySounds.size > 0; },
    get hasUnsavedAudio() { return dirtySounds.size > 0; },
    get failed() { return failed; }
  };
}
