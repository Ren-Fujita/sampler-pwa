import test from 'node:test';
import assert from 'node:assert/strict';
import { createAutosave } from '../js/autosave.js';

function environment(write) {
  let database = {};
  let ready = true;
  let revision = 1;
  let errors = 0;
  const schedules = [];
  const writes = [];
  const samples = [{ audio: 'A' }, { audio: 'B' }, { audio: 'C' }];
  const save = createAutosave({
    getDatabase: () => database,
    getSettings: () => ({ revision }),
    getSamples: () => samples,
    isReady: () => ready,
    onError: () => errors++,
    schedule: callback => { schedules.push(callback); return schedules.length; },
    cancel: () => {},
    write: async (db, settings, sounds, changed) => {
      writes.push({ db, settings, sounds, changed });
      await write?.(writes.length);
    }
  });
  return { save, writes, schedules, errors: () => errors, setRevision: value => revision = value,
    setReady: value => ready = value, setDatabase: value => database = value };
}

test('coalesces repeated edits and writes each dirty sound once', async () => {
  const e = environment();
  e.save.mark(1);
  e.save.mark(1);
  e.save.mark(2);
  await e.save.flush();
  assert.equal(e.writes.length, 1);
  assert.deepEqual(e.writes[0].changed, [1, 2]);
  assert.equal(e.save.pending, false);
  assert.equal(e.save.inFlight, false);
});

test('changes made during an active write are committed by a following transaction', async () => {
  let completeFirst;
  const e = environment(index => index === 1 ? new Promise(resolve => completeFirst = resolve) : undefined);
  e.save.mark(0);
  const first = e.save.flush();
  assert.equal(e.save.inFlight, true);
  e.setRevision(2);
  e.save.mark(2);
  const second = e.save.flush();
  completeFirst();
  await Promise.all([first, second]);
  assert.deepEqual(e.writes.map(write => [write.settings.revision, write.changed]), [[1, [0]], [2, [2]]]);
  assert.equal(e.save.pending, false);
});

test('failed writes retain audio changes, notify once and can be retried', async () => {
  let fail = true;
  const e = environment(() => { if (fail)throw Error('quota'); });
  e.save.mark(1);
  await e.save.flush();
  await e.save.flush();
  assert.equal(e.errors(), 1);
  assert.equal(e.save.failed, true);
  assert.equal(e.save.pending, true);
  assert.equal(e.save.hasUnsavedAudio, true);
  fail = false;
  await e.save.flush();
  assert.deepEqual(e.writes.map(write => write.changed), [[1], [1], [1]]);
  assert.equal(e.save.failed, false);
  assert.equal(e.save.pending, false);
});

test('missing storage never discards pending edits', async () => {
  const e = environment();
  e.setDatabase(null);
  e.save.mark(0);
  await e.save.flush();
  assert.equal(e.save.pending, true);
  assert.equal(e.errors(), 1);
  e.setDatabase({ restored: true });
  await e.save.flush();
  assert.deepEqual(e.writes[0].changed, [0]);
  assert.equal(e.save.pending, false);
});

test('restore-time edits wait until the application is ready before scheduling', async () => {
  const e = environment();
  e.setReady(false);
  e.save.mark(0);
  assert.equal(e.schedules.length, 0);
  assert.equal(e.save.pending, true);
  e.setReady(true);
  e.save.mark();
  assert.equal(e.schedules.length, 1);
  await e.save.flush();
  assert.deepEqual(e.writes[0].changed, [0]);
});

test('settings-only saves do not rewrite audio, while backup restore marks every sound', async () => {
  const e = environment();
  e.save.mark();
  assert.equal(e.save.hasUnsavedAudio, false);
  await e.save.flush();
  assert.deepEqual(e.writes[0].changed, []);
  e.save.markAllSounds();
  e.save.mark();
  await e.save.flush();
  assert.deepEqual(e.writes[1].changed, [0, 1, 2]);
});
