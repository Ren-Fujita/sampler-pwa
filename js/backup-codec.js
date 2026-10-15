import { MAX_BACKUP_RAW_BYTES, MAX_BACKUP_FILE_BYTES, MAX_DURATION, SLOT_COUNT } from './config.js';

export const backupYield = () => new Promise(resolve => setTimeout(resolve, 0));

export function createBackupCodec({ prepareSettings }) {
  const BACKUP_VERSION = 2;
  const BACKUP_MAGIC = 'SX12BIN2';
  const BACKUP_HEADER_BYTES = 16;
  const BACKUP_CHUNK_BYTES = 1024 * 1024;
  const BACKUP_LIMITS = Object.freeze({
    rawBytes: MAX_BACKUP_RAW_BYTES,
    metadataBytes: 1024 * 1024,
    legacyFileBytes: MAX_BACKUP_FILE_BYTES
  });
  const BACKUP_LITTLE_ENDIAN = new Uint8Array(new Uint32Array([0x01020304]).buffer)[0] === 4;
  const backupCRC32Table = Uint32Array.from({ length: 256 }, (_, value) => {
    for (let bit = 0; bit < 8; bit++)value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1;
    return value >>> 0;
  });

  function updateBackupCRC32(crc, bytes) {
    const table = backupCRC32Table;
    for (let index = 0; index < bytes.length; index++)crc = table[(crc ^ bytes[index]) & 255] ^ crc >>> 8;
    return crc >>> 0;
  }
  function backupCRC32(bytes) {
    return (updateBackupCRC32(0xffffffff, bytes) ^ 0xffffffff) >>> 0;
  }
  function validateBackupAudio(audio) {
    if (!audio || !Number.isFinite(audio.rate) || audio.rate < 8000 || audio.rate > 192000 ||
        !Array.isArray(audio.channels) || audio.channels.length < 1 || audio.channels.length > 2){
      throw Error('音源データが壊れています。');
    }
    const frames = audio.channels[0]?.length;
    if (!Number.isSafeInteger(frames) || frames < 1 || frames / audio.rate > MAX_DURATION ||
        audio.channels.some(channel => !(channel instanceof Float32Array) || channel.length !== frames)){
      throw Error('音源データが壊れています。');
    }
    return frames;
  }
  function validateBackupValues(samples, start = 0, end = samples.length) {
    for (let index = start; index < end; index++){
      const value = samples[index];
      if (!Number.isFinite(value) || Math.abs(value) > 20)throw Error('音源データが壊れています。');
    }
  }
  function backupChannelBytes(channel, start, frames, littleEndian = BACKUP_LITTLE_ENDIAN) {
    if (littleEndian)return new Uint8Array(channel.buffer, channel.byteOffset + start * 4, frames * 4);
    const bytes = new Uint8Array(frames * 4);
    const view = new DataView(bytes.buffer);
    for (let index = 0; index < frames; index++)view.setFloat32(index * 4, channel[start + index], true);
    return bytes;
  }
  function copyBackupFloats(bytes, target, start, littleEndian = BACKUP_LITTLE_ENDIAN) {
    if (littleEndian && bytes.byteOffset % 4 === 0){
      target.set(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4), start);
    }else{
      const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
      for (let index = 0; index < bytes.byteLength / 4; index++)target[start + index] = view.getFloat32(index * 4, true);
    }
  }

  function* backupChunks(byteLength) {
    for (let offset = 0; offset < byteLength; offset += BACKUP_CHUNK_BYTES){
      yield { offset, length: Math.min(BACKUP_CHUNK_BYTES, byteLength - offset) };
    }
  }
  async function encodeBackupChannel(channel, offset, parts, onChunk) {
    const descriptor = { offset, byteLength: channel.byteLength, crc32: 0 };
    let crc = 0xffffffff;
    for (const chunk of backupChunks(channel.byteLength)){
      const start = chunk.offset / 4;
      const frames = chunk.length / 4;
      validateBackupValues(channel, start, start + frames);
      const bytes = backupChannelBytes(channel, start, frames);
      crc = updateBackupCRC32(crc, bytes);
      // Keep immutable, bounded Blob pieces; no whole-audio temporary buffer.
      parts.push(new Blob([bytes]));
      onChunk(chunk.length);
      await backupYield();
    }
    descriptor.crc32 = (crc ^ 0xffffffff) >>> 0;
    return descriptor;
  }
  async function decodeBackupChannel(frames, readChunk, onChunk, expectedCRC) {
    const channel = new Float32Array(frames);
    let crc = 0xffffffff;
    for (const chunk of backupChunks(channel.byteLength)){
      const bytes = await readChunk(chunk.offset, chunk.length);
      if (bytes.byteLength !== chunk.length)throw Error('バックアップが途中で切れているか、読み込めません。');
      if (expectedCRC !== undefined)crc = updateBackupCRC32(crc, bytes);
      copyBackupFloats(bytes, channel, chunk.offset / 4);
      validateBackupValues(channel, chunk.offset / 4, (chunk.offset + chunk.length) / 4);
      onChunk(chunk.length, chunk.offset + chunk.length);
      await backupYield();
    }
    if (expectedCRC !== undefined && ((crc ^ 0xffffffff) >>> 0) !== expectedCRC)throw Error('音声データの破損を検出しました。');
    return channel;
  }

  async function createBinaryBackup(session, samples, { limits = BACKUP_LIMITS, onProgress = () => {} } = {}) {
    const settings = prepareSettings(session);
    if (!Array.isArray(samples) || samples.length !== SLOT_COUNT)throw Error('パッド情報が壊れています。');
    let total = 0;
    for (const sample of samples){
      if (!sample.audio)continue;
      const frames = validateBackupAudio(sample.audio);
      total += frames * 4 * sample.audio.channels.length;
      if (total > limits.rawBytes)throw Error('展開済み音声の合計が512MiBを超えています。音源を減らしてから保存してください。');
    }
    const parts = [];
    const sounds = [];
    let offset = 0;
    for (const sample of samples){
      if (!sample.audio){ sounds.push(null); continue; }
      const audio = sample.audio;
      const sound = { rate: audio.rate, frames: audio.channels[0].length, channels: [] };
      for (const channel of audio.channels){
        const descriptor = await encodeBackupChannel(channel, offset, parts, length => {
          offset += length;
          onProgress(offset, total);
        });
        sound.channels.push(descriptor);
      }
      sounds.push(sound);
    }
    const metadata = new TextEncoder().encode(JSON.stringify({ backupVersion: BACKUP_VERSION, session: settings, sounds }));
    if (metadata.byteLength > limits.metadataBytes)throw Error('バックアップの設定情報が大きすぎます。');
    const header = new Uint8Array(BACKUP_HEADER_BYTES);
    header.set(new TextEncoder().encode(BACKUP_MAGIC));
    const view = new DataView(header.buffer);
    view.setUint32(8, metadata.byteLength, true);
    view.setUint32(12, backupCRC32(metadata), true);
    onProgress(total || 1, total || 1);
    return new Blob([header, metadata, ...parts], { type: 'application/octet-stream' });
  }

  async function readBackupBytes(file, start, length) {
    const bytes = new Uint8Array(await file.slice(start, start + length).arrayBuffer());
    if (bytes.byteLength !== length)throw Error('バックアップが途中で切れているか、読み込めません。');
    return bytes;
  }
  function validateBinarySounds(sounds, payloadBytes, limits) {
    if (!Array.isArray(sounds) || sounds.length !== SLOT_COUNT)throw Error('音源情報が壊れています。');
    let offset = 0;
    for (const sound of sounds){
      if (sound === null)continue;
      if (!sound || !Number.isFinite(sound.rate) || sound.rate < 8000 || sound.rate > 192000 ||
          !Number.isSafeInteger(sound.frames) || sound.frames < 1 || sound.frames / sound.rate > MAX_DURATION ||
          !Array.isArray(sound.channels) || sound.channels.length < 1 || sound.channels.length > 2){
        throw Error('音源情報が壊れています。');
      }
      for (const channel of sound.channels){
        if (!channel || !Number.isSafeInteger(channel.offset) || channel.offset !== offset ||
            !Number.isSafeInteger(channel.byteLength) || channel.byteLength !== sound.frames * 4 ||
            !Number.isInteger(channel.crc32) || channel.crc32 < 0 || channel.crc32 > 0xffffffff){
          throw Error('音声データの位置・長さ・検査情報が壊れています。');
        }
        offset += channel.byteLength;
        if (offset > limits.rawBytes)throw Error('展開済み音声の合計が512MiBを超えています。');
      }
    }
    if (offset !== payloadBytes)throw Error('音声データの長さが一致しません。');
    return offset;
  }
  async function readBinaryBackup(file, { limits, onProgress }) {
    if (file.size > limits.rawBytes + limits.metadataBytes + BACKUP_HEADER_BYTES)throw Error('バックアップが大きすぎます。');
    const header = await readBackupBytes(file, 0, BACKUP_HEADER_BYTES);
    const view = new DataView(header.buffer);
    const metadataLength = view.getUint32(8, true);
    if (!metadataLength || metadataLength > limits.metadataBytes || metadataLength > file.size - BACKUP_HEADER_BYTES){
      throw Error('バックアップの設定情報が大きすぎるか壊れています。');
    }
    const metadata = await readBackupBytes(file, BACKUP_HEADER_BYTES, metadataLength);
    if (backupCRC32(metadata) !== view.getUint32(12, true))throw Error('設定情報の破損を検出しました。');
    const manifest = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(metadata));
    if (manifest.backupVersion !== BACKUP_VERSION)throw Error('このバックアップのバージョンには対応していません。');
    const settings = prepareSettings(manifest.session);
    const payloadStart = BACKUP_HEADER_BYTES + metadataLength;
    const total = validateBinarySounds(manifest.sounds, file.size - payloadStart, limits);
    const sounds = [];
    let processed = 0;
    for (const sound of manifest.sounds){
      if (sound === null){ sounds.push(null); continue; }
      const channels = [];
      for (const descriptor of sound.channels){
        const channel = await decodeBackupChannel(sound.frames,
          (offset, length) => readBackupBytes(file, payloadStart + descriptor.offset + offset, length),
          length => { processed += length; onProgress(processed, total); },
          descriptor.crc32);
        channels.push(channel);
      }
      sounds.push({ rate: sound.rate, channels });
    }
    onProgress(total || 1, total || 1);
    return { settings, sounds };
  }
  async function readLegacyBackup(file, { limits, onProgress }) {
    if (file.size > limits.legacyFileBytes)throw Error('旧形式のバックアップが大きすぎます。');
    const data = JSON.parse(await file.text());
    const settings = prepareSettings(data);
    if (!Array.isArray(data.sounds) || data.sounds.length !== SLOT_COUNT)throw Error('SX12のバックアップではありません。');
    const sounds = [];
    let total = 0;
    for (let index = 0; index < SLOT_COUNT; index++){
      const sound = data.sounds[index];
      data.sounds[index] = null;
      if (sound === null){ sounds.push(null); onProgress(index + 1, SLOT_COUNT); continue; }
      if (!sound || !Number.isFinite(sound.rate) || sound.rate < 8000 || sound.rate > 192000 ||
          !Array.isArray(sound.channels) || sound.channels.length < 1 || sound.channels.length > 2){
        throw Error('音源データが壊れています。');
      }
      let frames;
      const channels = [];
      for (const [channelIndex, encoded] of sound.channels.entries()){
        if (typeof encoded !== 'string' || encoded.length > limits.legacyFileBytes)throw Error('音源データが壊れています。');
        const raw = atob(encoded);
        total += raw.length;
        if (total > limits.rawBytes || !raw.length || raw.length % 4)throw Error('音源データが大きすぎるか壊れています。');
        const count = raw.length / 4;
        if (count / sound.rate > MAX_DURATION || (frames !== undefined && frames !== count))throw Error('音源データが壊れています。');
        frames = count;
        const channel = await decodeBackupChannel(frames,
          (offset, length) => Uint8Array.from(raw.slice(offset, offset + length), character => character.charCodeAt(0)),
          (_, end) => onProgress(index + (channelIndex + end / raw.length) / sound.channels.length, SLOT_COUNT));
        channels.push(channel);
      }
      sounds.push({ rate: sound.rate, channels });
      onProgress(index + 1, SLOT_COUNT);
    }
    return { settings, sounds };
  }
  async function readBackup(file, { limits = BACKUP_LIMITS, onProgress = () => {} } = {}) {
    const maximumFile = Math.max(limits.legacyFileBytes, limits.rawBytes + limits.metadataBytes + BACKUP_HEADER_BYTES);
    if (!Number.isSafeInteger(file.size) || file.size < 1 || file.size > maximumFile)throw Error('バックアップが大きすぎるか壊れています。');
    const prefix = await readBackupBytes(file, 0, Math.min(8, file.size));
    const magic = String.fromCharCode(...prefix);
    if (magic === BACKUP_MAGIC)return readBinaryBackup(file, { limits, onProgress });
    if (magic.startsWith('SX12BIN'))throw Error('このバックアップのバージョンには対応していません。');
    return readLegacyBackup(file, { limits, onProgress });
  }


  return { createBinaryBackup, readBackup };
}
