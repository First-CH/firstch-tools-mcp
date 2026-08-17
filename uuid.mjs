// UUID v4 / ULID の一括生成
// （tools.first-ch.com/uuid/ と同一の仕様）
//
// 生成のコア（randomBytes / uuidV4FromBytes / encodeUlidTime / encodeUlidRandom /
// bumpUlidRandom / generateIds / formatIds / decodeUlid）は site 側（site/uuid/app.js）と
// 対になっている。2箇所ルール: 片方を直したらもう片方も同じ内容で直す（site側が正本）。
//
// 乱数は node:crypto の randomBytes（CSPRNG）のみを使う。Math.random は使わない。
// ULIDは同一ミリ秒内で単調増加させる（乱数部を+1する）。これをしないと、一括生成した分が
// 「同じ時刻の中で順不同」になり、ULIDの売りである辞書順＝生成順が崩れる。
import { randomBytes as nodeRandomBytes } from 'node:crypto';

export class UuidError extends Error {}

/** Crockford's Base32。紛らわしい I / L / O / U を除いた32文字（ULIDの表記に使う） */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const MAX_COUNT = 100;
const TIME_LEN = 10; // ULIDのタイムスタンプ部（48bit）
const RAND_LEN = 16; // ULIDのランダム部（80bit）
const MAX_TIME = 281474976710655; // 2^48 - 1

/** 暗号論的乱数をnバイト返す（site側は crypto.getRandomValues） */
function randomBytes(n) {
  return nodeRandomBytes(n);
}

const HEX = [];
for (let i = 0; i < 256; i += 1) HEX.push((i + 0x100).toString(16).slice(1));

/**
 * 16バイトの乱数を RFC 9562 の UUID v4 にする。
 * 7バイト目の上位4bitをバージョン（0100 = 4）、9バイト目の上位2bitをバリアント（10）に固定する。
 * 残りの122bitが乱数。
 */
export function uuidV4FromBytes(bytes) {
  const b = Uint8Array.from(bytes);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = HEX;
  return (
    h[b[0]] + h[b[1]] + h[b[2]] + h[b[3]] + '-' +
    h[b[4]] + h[b[5]] + '-' +
    h[b[6]] + h[b[7]] + '-' +
    h[b[8]] + h[b[9]] + '-' +
    h[b[10]] + h[b[11]] + h[b[12]] + h[b[13]] + h[b[14]] + h[b[15]]
  );
}

/** ミリ秒（UNIX時間）を Crockford Base32 の10文字にする */
export function encodeUlidTime(ms) {
  let t = Math.floor(ms);
  if (!Number.isFinite(t) || t < 0 || t > MAX_TIME) throw new UuidError('ULIDに入れられる時刻の範囲外です（0 〜 2^48-1 ミリ秒）');
  let out = '';
  for (let i = 0; i < TIME_LEN; i += 1) {
    const mod = t % 32;
    out = CROCKFORD[mod] + out;
    t = (t - mod) / 32;
  }
  return out;
}

/** 80bitの乱数を Crockford Base32 の16文字にする */
export function encodeUlidRandom(bytes) {
  let out = '';
  // 256 は 32 の倍数なので、バイトの下位5bitを取っても分布は偏らない
  for (let i = 0; i < RAND_LEN; i += 1) out += CROCKFORD[bytes[i] & 0x1f];
  return out;
}

/**
 * ULIDのランダム部を1つ進める（単調増加）。同じミリ秒内に複数生成するときに使う。
 * 末尾から桁上がりさせ、16文字すべてが 'Z' なら null（そのミリ秒では作り切った）。
 */
export function bumpUlidRandom(rand) {
  const chars = rand.split('');
  for (let i = chars.length - 1; i >= 0; i -= 1) {
    const idx = CROCKFORD.indexOf(chars[i]);
    if (idx < CROCKFORD.length - 1) {
      chars[i] = CROCKFORD[idx + 1];
      return chars.join('');
    }
    chars[i] = CROCKFORD[0];
  }
  return null;
}

/** ULIDの先頭10文字から生成時刻（ミリ秒）を読む。26文字でなければ null */
export function decodeUlid(id) {
  const s = String(id == null ? '' : id).trim().toUpperCase();
  if (s.length !== TIME_LEN + RAND_LEN) return null;
  let ms = 0;
  for (let i = 0; i < TIME_LEN; i += 1) {
    const idx = CROCKFORD.indexOf(s[i]);
    if (idx === -1) return null;
    ms = ms * 32 + idx;
  }
  for (let i = TIME_LEN; i < s.length; i += 1) {
    if (CROCKFORD.indexOf(s[i]) === -1) return null;
  }
  return { time: ms, timePart: s.slice(0, TIME_LEN), randomPart: s.slice(TIME_LEN) };
}

/**
 * IDをcount件生成する。
 * @param {{type?: string, count?: number, time?: number, rand?: (n: number) => Uint8Array}} opts
 * @returns {{type: string, count: number, ids: string[], time: number}}
 */
export function generateIds(opts) {
  const o = opts || {};
  const type = o.type === 'ulid' ? 'ulid' : 'uuid';
  const count = Math.min(Math.max(Math.floor(Number(o.count) || 1), 1), MAX_COUNT);
  const rand = o.rand || randomBytes;
  const time = o.time === undefined || o.time === null ? Date.now() : Math.floor(Number(o.time));
  const ids = [];
  if (type === 'uuid') {
    // 1件ずつ乱数を取るより、まとめて取ったほうが速い（100件でも16KB未満）
    const bulk = rand(16 * count);
    for (let i = 0; i < count; i += 1) ids.push(uuidV4FromBytes(bulk.subarray(i * 16, i * 16 + 16)));
    return { type, count, ids, time };
  }
  const timePart = encodeUlidTime(time);
  let randomPart = encodeUlidRandom(rand(RAND_LEN));
  ids.push(timePart + randomPart);
  for (let i = 1; i < count; i += 1) {
    // 同じミリ秒なので乱数部を+1する（辞書順＝生成順を保つ）
    const next = bumpUlidRandom(randomPart);
    randomPart = next === null ? encodeUlidRandom(rand(RAND_LEN)) : next;
    ids.push(timePart + randomPart);
  }
  return { type, count, ids, time };
}

export const FORMATS = ['plain', 'json', 'csv', 'quoted'];

/**
 * 生成したIDを表記オプションと出力形式に合わせて1つの文字列にする。
 * @param {string[]} ids
 * @param {{format?: string, uppercase?: boolean, hyphens?: boolean, braces?: boolean, type?: string}} opts
 */
export function formatIds(ids, opts) {
  const o = opts || {};
  const type = o.type === 'ulid' ? 'ulid' : 'uuid';
  const format = FORMATS.indexOf(o.format) === -1 ? 'plain' : o.format;
  // UUIDの既定は小文字（RFC 9562）、ULIDの既定は大文字（Crockford Base32）
  const upper = o.uppercase === undefined ? type === 'ulid' : !!o.uppercase;
  const list = ids.map((id) => {
    let s = upper ? id.toUpperCase() : id.toLowerCase();
    if (type === 'uuid') {
      if (o.hyphens === false) s = s.replace(/-/g, '');
      if (o.braces) s = '{' + s + '}';
    }
    return s;
  });
  if (format === 'json') return JSON.stringify(list, null, 2);
  if (format === 'csv') return list.join(',');
  if (format === 'quoted') return list.map((s) => '"' + s + '"').join(',\n');
  return list.join('\n');
}

/* ==================== MCPツールの入口 ==================== */

/** ISO8601文字列・ミリ秒の数値・秒の数値のいずれでも受け取れるようにする */
function parseTime(value) {
  if (value === undefined || value === null || value === '') return Date.now();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new UuidError('timestamp が数値として読めません');
    // 10桁までなら秒とみなす（JWTなどの慣習に合わせる）
    return value < 1e11 ? Math.floor(value * 1000) : Math.floor(value);
  }
  const s = String(value).trim();
  if (/^\d+$/.test(s)) return parseTime(Number(s));
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) throw new UuidError(`timestamp を日時として読めません: ${s}`);
  return ms;
}

/**
 * uuid_generate ツール本体。
 * @param {{type?: string, count?: number, format?: string, uppercase?: boolean,
 *   hyphens?: boolean, braces?: boolean, timestamp?: string|number}} opts
 */
export function uuidGenerate(opts = {}) {
  const rawType = String(opts.type == null ? 'uuid' : opts.type).trim().toLowerCase();
  const type = rawType === 'ulid' ? 'ulid'
    : (rawType === '' || rawType === 'uuid' || rawType === 'uuid4' || rawType === 'v4' || rawType === 'uuid_v4') ? 'uuid'
      : null;
  if (type === null) throw new UuidError(`type は uuid か ulid を指定してください（受け取った値: ${opts.type}）`);

  const rawCount = opts.count === undefined || opts.count === null ? 1 : Number(opts.count);
  if (!Number.isFinite(rawCount) || Math.floor(rawCount) !== rawCount) throw new UuidError('count は整数で指定してください');
  if (rawCount < 1 || rawCount > MAX_COUNT) throw new UuidError(`count は 1〜${MAX_COUNT} で指定してください（受け取った値: ${opts.count}）`);

  const format = opts.format === undefined || opts.format === null || opts.format === '' ? 'plain' : String(opts.format);
  if (FORMATS.indexOf(format) === -1) throw new UuidError(`format は ${FORMATS.join(' / ')} のいずれかを指定してください（受け取った値: ${opts.format}）`);

  if (opts.timestamp !== undefined && opts.timestamp !== null && type !== 'ulid') {
    throw new UuidError('timestamp は ULID のときだけ指定できます（UUID v4 に時刻は入りません）');
  }
  const time = type === 'ulid' ? parseTime(opts.timestamp) : Date.now();

  const res = generateIds({ type, count: rawCount, time });
  const fmtOpts = {
    type,
    format,
    uppercase: opts.uppercase,
    hyphens: opts.hyphens,
    braces: opts.braces,
  };
  const text = formatIds(res.ids, fmtOpts);
  const ids = formatIds(res.ids, Object.assign({}, fmtOpts, { format: 'plain' })).split('\n');

  const out = {
    type,
    count: res.count,
    format,
    ids,
    text,
    length: ids[0].length,
    duplicates: res.count - new Set(ids).size,
    local_only: true,
  };
  if (type === 'ulid') {
    const d = decodeUlid(res.ids[0]);
    out.timestamp = {
      unix_ms: d.time,
      iso: new Date(d.time).toISOString(),
      encoded: d.timePart,
    };
    out.monotonic = true;
    out.note = '同一ミリ秒内はランダム部を+1して単調増加させているため、辞書順が生成順と一致します。';
  } else {
    out.version = 4;
    out.variant = 'RFC 9562 (10xx)';
    out.random_bits = 122;
    out.note = '乱数は node:crypto の randomBytes（CSPRNG）です。Math.random は使いません。';
  }
  return out;
}
