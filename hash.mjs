// MD5 / SHA-1 / SHA-256 / SHA-384 / SHA-512 のハッシュ生成と照合
// （tools.first-ch.com/hash/ と同一の仕様）
//
// site 側（site/hash/app.js）はブラウザの Web Crypto でSHA系を計算し、Web Cryptoに無い
// MD5 だけを RFC 1321 のJavaScript実装で持っている。Nodeでは node:crypto が5種類すべてを
// 持っているのでそちらを使う（＝実装は別物）。
// 2箇所ルール: 出力の書式・期待値の読み取り・入力の正規化（改行コード / BOM）は
// site 側と同じ挙動にする。片方を直したらもう片方も直す（site側が正本）。
// どちらの実装も test.mjs / ブラウザ側の検証で RFC の既知テストベクタと突き合わせている。
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { basename } from 'node:path';

export class HashError extends Error {}

export const HASH_ALGOS = ['md5', 'sha1', 'sha256', 'sha384', 'sha512'];
// 既定は site 側の表示と同じ4種（SHA-384 は指定したときだけ）
export const DEFAULT_ALGOS = ['md5', 'sha1', 'sha256', 'sha512'];
const ALGO_LABEL = { md5: 'MD5', sha1: 'SHA-1', sha256: 'SHA-256', sha384: 'SHA-384', sha512: 'SHA-512' };
// node:crypto の名前。site 側の Web Crypto 名（SHA-1 / SHA-256 …）とは綴りが違う
const NODE_NAME = { md5: 'md5', sha1: 'sha1', sha256: 'sha256', sha384: 'sha384', sha512: 'sha512' };
const HEX_LEN = { md5: 32, sha1: 40, sha256: 64, sha384: 96, sha512: 128 };
const FORMATS = ['hex', 'HEX', 'base64', 'base64url'];

// これ以上のファイルは一度にメモリへ載せず、ストリームで流し込む
const STREAM_THRESHOLD = 64 * 1024 * 1024;

/* ==================== 書式・正規化（site/hash/app.js と同じ挙動） ==================== */

/** ダイジェスト（Buffer）を指定の書式の文字列にする */
export function encodeDigest(buf, format) {
  if (format === 'HEX') return buf.toString('hex').toUpperCase();
  if (format === 'base64') return buf.toString('base64');
  // base64url は + / を - _ にし、パディングの = を落とした形（Node 15+ の 'base64url'）
  if (format === 'base64url') return buf.toString('base64url');
  return buf.toString('hex');
}

/**
 * テキストをハッシュ対象のバイト列にする。改行コードとBOMで結果が変わるため明示的に決める。
 * @param {string} text
 * @param {'lf'|'crlf'} [newline='lf']
 * @param {boolean} [bom=false]
 */
export function normalizeText(text, newline = 'lf', bom = false) {
  let s = String(text).replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  if (newline === 'crlf') s = s.replace(/\n/g, '\r\n');
  const body = Buffer.from(s, 'utf8');
  return bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), body]) : body;
}

/**
 * 照合用に渡された文字列から、ハッシュ値らしい部分だけを取り出す。
 * `sha256sum` の出力（`<hash>  <ファイル名>`）・`SHA256 (file) = <hash>`・
 * `sha256:<hash>`・コロン区切りの16進・Base64 をそのまま渡せる。
 * @returns {{value: string, kind: 'hex'|'base64'|'', bits: number}}
 */
export function parseExpected(input) {
  const raw = String(input == null ? '' : input).trim();
  if (!raw) return { value: '', kind: '', bits: 0 };
  let s = raw.split('\n')[0].trim();
  const bsd = s.match(/^[A-Za-z0-9-]+\s*\([^)]*\)\s*=\s*(\S+)\s*$/);
  if (bsd) s = bsd[1];
  s = s.replace(/^(?:md5|sha-?1|sha-?256|sha-?384|sha-?512)\s*[:=]\s*/i, '').trim();
  const compact = s.replace(/[\s:-]/g, '');
  if (/^[0-9a-fA-F]+$/.test(compact) && compact.length % 2 === 0 && compact.length >= 16) {
    return { value: compact.toLowerCase(), kind: 'hex', bits: compact.length * 4 };
  }
  const head = s.split(/[\s*]+/)[0] || '';
  if (/^[0-9a-fA-F]+$/.test(head) && head.length % 2 === 0 && head.length >= 16) {
    return { value: head.toLowerCase(), kind: 'hex', bits: head.length * 4 };
  }
  if (/^[A-Za-z0-9+/_-]+={0,2}$/.test(head) && head.length >= 16) {
    const norm = head.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
    return { value: norm, kind: 'base64', bits: Math.floor((norm.length * 6) / 8) * 8 };
  }
  return { value: head || s, kind: '', bits: 0 };
}

/** 期待値とダイジェストが一致するか。書式（16進・大文字・base64・base64url）は問わない */
export function digestMatches(buf, expected) {
  if (!expected.value) return false;
  if (expected.kind === 'hex') return buf.toString('hex') === expected.value;
  if (expected.kind === 'base64') return buf.toString('base64').replace(/=+$/, '') === expected.value;
  return false;
}

/* ==================== 計算 ==================== */

/**
 * バイト列（Buffer）のハッシュを計算する。
 * @param {Buffer} buf
 * @param {string[]} algos
 * @returns {Object<string, Buffer>}
 */
export function hashBuffer(buf, algos = DEFAULT_ALGOS) {
  const out = {};
  for (const algo of algos) out[algo] = createHash(NODE_NAME[algo]).update(buf).digest();
  return out;
}

/**
 * ファイルをストリームで読みながら、複数のハッシュを1パスで同時に計算する。
 * 大きなファイルをメモリへ載せないため。
 * @param {string} path
 * @param {string[]} algos
 * @returns {Promise<Object<string, Buffer>>}
 */
export function hashFileStream(path, algos = DEFAULT_ALGOS) {
  return new Promise((resolve, reject) => {
    const hashes = algos.map((algo) => [algo, createHash(NODE_NAME[algo])]);
    const stream = createReadStream(path);
    stream.on('error', reject);
    stream.on('data', (chunk) => {
      for (const [, h] of hashes) h.update(chunk);
    });
    stream.on('end', () => {
      const out = {};
      for (const [algo, h] of hashes) out[algo] = h.digest();
      resolve(out);
    });
  });
}

/**
 * テキストまたはファイルのハッシュ値を算出し、期待値との照合結果を返す。
 *
 * @param {object} opts
 * @param {string} [opts.text]        対象テキスト（path と排他）
 * @param {string} [opts.path]        対象ファイルの絶対パス（text と排他）
 * @param {string[]} [opts.algorithms] md5 / sha1 / sha256 / sha384 / sha512（既定は sha384 以外の4種）
 * @param {'hex'|'HEX'|'base64'|'base64url'} [opts.format='hex'] 出力の書式
 * @param {'lf'|'crlf'} [opts.newline='lf'] text の改行コード（ファイルには影響しない）
 * @param {boolean} [opts.bom=false]  text の先頭にUTF-8のBOMを付ける（ファイルには影響しない）
 * @param {string} [opts.expected]    照合するハッシュ値（コマンドの出力をそのまま渡せる）
 */
export async function hashGenerate(opts = {}) {
  const hasText = typeof opts.text === 'string';
  if (hasText === Boolean(opts.path)) throw new HashError('text か path のどちらか一方を渡してください');

  const algos = opts.algorithms && opts.algorithms.length ? opts.algorithms : DEFAULT_ALGOS;
  for (const algo of algos) {
    if (HASH_ALGOS.indexOf(algo) === -1) {
      throw new HashError(`algorithms は ${HASH_ALGOS.join(' / ')} のいずれか: ${algo}`);
    }
  }
  const format = opts.format || 'hex';
  if (FORMATS.indexOf(format) === -1) throw new HashError(`format は ${FORMATS.join(' / ')}: ${opts.format}`);
  const newline = opts.newline || 'lf';
  if (newline !== 'lf' && newline !== 'crlf') throw new HashError(`newline は lf か crlf: ${opts.newline}`);

  // 重複は落としつつ、指定された順序は保つ
  const list = algos.filter((a, i) => algos.indexOf(a) === i);

  let digests;
  let source;
  let size;
  if (hasText) {
    const buf = normalizeText(opts.text, newline, Boolean(opts.bom));
    size = buf.length;
    digests = hashBuffer(buf, list);
    source = { type: 'text', bytes: size, newline, bom: Boolean(opts.bom), encoding: 'utf-8' };
  } else {
    const info = await stat(opts.path);
    if (!info.isFile()) throw new HashError(`ファイルではありません: ${opts.path}`);
    size = info.size;
    // 大きなファイルは1パスのストリームで流す（全体をメモリへ載せない）
    digests = size > STREAM_THRESHOLD
      ? await hashFileStream(opts.path, list)
      : hashBuffer(await readFile(opts.path), list);
    source = { type: 'file', path: opts.path, name: basename(opts.path), bytes: size };
  }

  const expected = parseExpected(opts.expected);
  const hashes = {};
  let matched = null;
  for (const algo of list) {
    hashes[algo] = encodeDigest(digests[algo], format);
    if (digestMatches(digests[algo], expected)) matched = algo;
  }

  const notes = [];
  if (list.indexOf('md5') !== -1 || list.indexOf('sha1') !== -1) {
    notes.push(
      'MD5 と SHA-1 は衝突耐性が破られており、異なる2つの入力から同じ値を作れます。'
      + '偶発的な破損の検出には使えますが、署名・改ざん検知には使わないでください（新規は SHA-256 以上）。',
    );
  }
  notes.push(
    'ハッシュ値そのものはパスワードの保存方法ではありません。'
    + 'パスワードにはソルト付きで意図的に遅いアルゴリズム（bcrypt / scrypt / Argon2）を使います。',
  );
  if (hasText && newline === 'crlf') {
    notes.push('改行を CRLF として計算しています。LF の同じ文章とは全く違う値になります。');
  }
  if (hasText && opts.bom) {
    notes.push('先頭に UTF-8 の BOM（EF BB BF）を付けて計算しています。BOM無しの同じ文章とは値が変わります。');
  }

  const result = {
    source,
    format,
    algorithms: list,
    hashes,
    notes,
  };

  if (expected.value) {
    // 桁数が同じアルゴリズムだけを「照合の対象」とみなす（違う長さの値は無関係）
    const target = list.find((algo) => (expected.kind === 'hex'
      ? expected.value.length === HEX_LEN[algo]
      : expected.kind === 'base64' && expected.bits === digests[algo].length * 8));
    result.verification = {
      expected: expected.value,
      expected_format: expected.kind || 'unrecognized',
      matched: Boolean(matched),
      algorithm: matched || target || null,
    };
    if (matched) {
      result.verification.message = `貼り付けた値は ${ALGO_LABEL[matched]} のハッシュ値と一致しました（データは同一です）。`;
    } else if (target) {
      result.verification.message = `期待値は ${ALGO_LABEL[target]} の桁数ですが一致しません。`
        + 'データが異なるか、改行コード・BOM・末尾の改行など入力の作り方が違います。';
    } else if (!expected.kind) {
      result.verification.message = '期待値を16進・Base64のハッシュ値として読み取れませんでした。';
    } else {
      result.verification.message = '算出したどのハッシュ値とも桁数が一致しませんでした'
        + '（algorithms に対象のアルゴリズムを含めているか確認してください）。';
    }
  }

  return result;
}
