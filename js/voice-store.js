// Keep voice ownership/order separate from Web Audio and canvas presentation.
export function createVoiceStore() {
  const groups = new Map();

  function add(index, voice) {
    if (!groups.has(index))groups.set(index, new Set());
    groups.get(index).add(voice);
  }

  function remove(index, voice) {
    groups.get(index)?.delete(voice);
  }

  function* active(index) {
    for (const voice of groups.get(index) || [])if (!voice.stopping)yield voice;
  }

  function hasActive(index) {
    for (const voice of active(index))return true;
    return false;
  }

  function latestActive(index) {
    let latest = null;
    for (const voice of active(index))latest = voice;
    return latest;
  }

  function activity() {
    let count = 0;
    let oldest = null;
    const activePads = new Set();
    for (const index of groups.keys()) {
      for (const voice of active(index)) {
        count++;
        activePads.add(index);
        if (!oldest || voice.time < oldest.time)oldest = voice;
      }
    }
    return { count, oldest, activePads };
  }

  function forEach(callback, index) {
    if (index !== undefined) {
      for (const voice of groups.get(index) || [])callback(voice);
      return;
    }
    for (const group of groups.values())for (const voice of group)callback(voice);
  }

  return { add, remove, hasActive, latestActive, activity, forEach, clear: () => groups.clear() };
}
