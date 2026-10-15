import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createBackupCodec } from '../js/backup-codec.js';
import { parseSessionSettings } from '../js/session.js';
import { MAX_BACKUP_RAW_BYTES } from '../js/config.js';

const codec = createBackupCodec({ prepareSettings: parseSessionSettings });
const fixture = name => readFile(new URL('./fixtures/' + name, import.meta.url));
const settings = JSON.parse(await fixture('session.json'));
const pcm = JSON.parse(await fixture('pcm.json'));
const oldBinary = await fixture('before-refactor.sx12');

function assertRestored(restored) {
  assert.deepEqual(restored.settings, parseSessionSettings(settings));
  assert.equal(restored.sounds.length, 120);
  assert.equal(restored.sounds[0].rate, 44100);
  assert.deepEqual(restored.sounds[0].channels.map(channel => Array.from(channel)), pcm);
  assert(restored.sounds.slice(1).every(sound => sound === null));
}

test('reads .sx12 created before the refactor without losing settings or stereo PCM', async () => {
  assertRestored(await codec.readBackup(new Blob([oldBinary])));
});

test('reads legacy JSON/base64 backup files', async () => {
  assertRestored(await codec.readBackup(new Blob([await fixture('legacy-backup.json')])));
});

test('writes exactly the same binary format as the pre-refactor implementation', async () => {
  const samples = Array.from({ length: 120 }, () => ({ audio: null }));
  samples[0].audio = { rate: 44100, channels: pcm.map(values => Float32Array.from(values)) };
  const backup = await codec.createBinaryBackup(settings, samples);
  assert.deepEqual(Buffer.from(await backup.arrayBuffer()), oldBinary);
  assertRestored(await codec.readBackup(backup));
});

test('rejects corrupt settings, corrupt PCM and truncated backups', async () => {
  const damagedMetadata = Buffer.from(oldBinary);
  damagedMetadata[20] ^= 1;
  await assert.rejects(codec.readBackup(new Blob([damagedMetadata])), /設定情報の破損/);
  const damagedPCM = Buffer.from(oldBinary);
  damagedPCM[damagedPCM.length - 1] ^= 1;
  await assert.rejects(codec.readBackup(new Blob([damagedPCM])), /破損|壊れ/);
  await assert.rejects(codec.readBackup(new Blob([oldBinary.subarray(0, oldBinary.length - 4)])), /長さ|壊れ/);
});

test('rejects unsupported formats, invalid sample values and byte-limit overflow', async () => {
  await assert.rejects(codec.readBackup(new Blob(['SX12BIN9'])), /バージョン/);
  const samples = Array.from({ length: 120 }, () => ({ audio: null }));
  samples[0].audio = { rate: 44100, channels: [Float32Array.of(NaN)] };
  await assert.rejects(codec.createBinaryBackup(settings, samples), /壊れ/);
  samples[0].audio.channels = [Float32Array.of(0, .5)];
  await assert.rejects(codec.createBinaryBackup(settings, samples, {
    limits: { rawBytes: 4, metadataBytes: 1024 * 1024, legacyFileBytes: MAX_BACKUP_RAW_BYTES }
  }), /512MiB/);
});
