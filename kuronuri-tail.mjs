/* 画像の終端より後ろのデータの点検（kuronuri_tail）
 * 判定のコアは FirstCHTools の site/kuronuri/lib.mjs と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルの「ここからコア」〜「ここまでコア」はバイト一致する（どちらも ES module）:
 *   diff <(sed -n '/^\/\/ ===== ここから/,/^\/\/ ===== ここまで/p' site/kuronuri/lib.mjs) <(sed -n '/^\/\/ ===== ここから/,/^\/\/ ===== ここまで/p' kuronuri-tail.mjs)
 *
 * PNG はチャンクを順に読み CRC を確かめて IEND まで、JPEG はマーカーを順に読んで本体の EOI まで（EXIF の埋め込みサムネイルの FFD9 は終端にしない）を
 * 画像とみなし、その後ろに付いたデータの有無とバイト数を返す。透けの判定・後ろのデータからの復元はしない。完全ローカル処理・ネットワーク送信なし。 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

// ===== ここからコア =====
// 画像の本体の終わり（PNG は IEND の後ろ、JPEG は本体の EOI の後ろ）を決め、その後ろに付いたデータのバイト数を返す。
// 透けの判定はしない。構造を読めない・壊れている（途中で切れた・CRC が合わない・並びが崩れた）ときは status: 'unknown'。
//   status: 'none'（後ろに何もない）/ 'found'（trailing バイトある）/ 'unknown'（解析不能・reason に理由）
export const MAX_BYTES = 50 * 1024 * 1024;

let CRC_TABLE = null;
export function crc32(b, start, end) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const isLetter = (x) => (x >= 65 && x <= 90) || (x >= 97 && x <= 122);

export function sniff(b) {
  if (b.length >= 8 && PNG_SIG.every((x, i) => b[i] === x)) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  return null;
}

// PNG: シグネチャの後ろのチャンクを順に読む（長さ・名前・CRC）。先頭は IHDR、IEND までに IDAT が1つ以上
function pngEnd(b) {
  const n = b.length;
  let i = 8, first = true, sawIdat = false;
  for (;;) {
    if (i + 8 > n) return { reason: 'TRUNCATED', at: i };
    const len = ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0;
    if (len > 0x7fffffff) return { reason: 'BAD_CHUNK', at: i };
    for (let k = 4; k < 8; k++) if (!isLetter(b[i + k])) return { reason: 'BAD_CHUNK', at: i };
    const type = String.fromCharCode(b[i + 4], b[i + 5], b[i + 6], b[i + 7]);
    if (first && type !== 'IHDR') return { reason: 'NO_HEADER', at: i };
    first = false;
    if (i + 12 + len > n) return { reason: 'TRUNCATED', at: i };
    const want = ((b[i + 8 + len] << 24) | (b[i + 9 + len] << 16) | (b[i + 10 + len] << 8) | b[i + 11 + len]) >>> 0;
    if (crc32(b, i + 4, i + 8 + len) !== want) return { reason: 'BAD_CRC', at: i };
    if (type === 'IDAT') sawIdat = true;
    i += 12 + len;
    if (type === 'IEND') return sawIdat ? { end: i } : { reason: 'NO_IMAGE_DATA', at: i };
  }
}

// JPEG: SOI の後ろのマーカーを順に読む。長さを持つセグメントは長さで飛ばすので、APP1（EXIF）の中の
// 埋め込みサムネイルの FFD9 は終端にしない。SOS の後ろの符号化データは FF00（詰め物）と RST0〜7 を飛ばし、
// 次のマーカーまで進む（プログレッシブの複数の SOS も同じ）。本体の EOI は SOF と SOS の後にあるものだけ
function jpegEnd(b) {
  const n = b.length;
  let i = 2, sawSof = false, sawSos = false;
  for (;;) {
    if (i >= n) return { reason: 'TRUNCATED', at: i };
    if (b[i] !== 0xff) return { reason: 'BAD_MARKER', at: i };
    while (i < n && b[i] === 0xff) i++;                     // 詰め物の FF
    if (i >= n) return { reason: 'TRUNCATED', at: i };
    const m = b[i++];
    if (m === 0xd9) return sawSos ? { end: i } : { reason: 'NO_IMAGE_DATA', at: i - 2 };
    if (m === 0x00 || m === 0xd8) return { reason: 'BAD_MARKER', at: i - 2 };
    if ((m >= 0xd0 && m <= 0xd7) || m === 0x01) continue;   // 長さを持たないマーカー
    if (i + 2 > n) return { reason: 'TRUNCATED', at: i };
    const len = (b[i] << 8) | b[i + 1];
    if (len < 2) return { reason: 'BAD_LENGTH', at: i - 2 };
    if (i + len > n) return { reason: 'TRUNCATED', at: i - 2 };
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) sawSof = true;
    i += len;
    if (m !== 0xda) continue;
    if (!sawSof) return { reason: 'BAD_MARKER', at: i - len - 2 };
    sawSos = true;
    // 符号化データ: 次の「FF ＋ 00・RST 以外」まで進む
    for (;;) {
      const j = b.indexOf(0xff, i);
      if (j < 0) return { reason: 'TRUNCATED', at: n };
      let k = j + 1;
      while (k < n && b[k] === 0xff) k++;
      if (k >= n) return { reason: 'TRUNCATED', at: n };
      const x = b[k];
      if (x === 0x00 || (x >= 0xd0 && x <= 0xd7)) { i = k + 1; continue; }
      i = k - 1;
      break;
    }
  }
}

export function inspectTail(input) {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const size = b.length;
  const format = sniff(b);
  if (!format) return { format: null, status: 'unknown', reason: 'NOT_PNG_OR_JPEG', size, end: null, trailing: null };
  const r = format === 'png' ? pngEnd(b) : jpegEnd(b);
  if (r.end == null) return { format, status: 'unknown', reason: r.reason, at: r.at, size, end: null, trailing: null };
  const trailing = size - r.end;
  return { format, status: trailing > 0 ? 'found' : 'none', reason: null, size, end: r.end, trailing };
}
// ===== ここまでコア =====

// ---- MCP の入口 ----
export class KuronuriTailError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

const REASON = {
  ja: { NOT_PNG_OR_JPEG: 'PNG・JPEG ではありません', TRUNCATED: 'ファイルが途中で切れています', BAD_CRC: 'チャンクの検査値（CRC）が合いません', BAD_CHUNK: 'チャンクの並びが崩れています', NO_HEADER: '先頭の情報（IHDR）がありません', NO_IMAGE_DATA: '画像のデータより先に終わりの印があります', BAD_MARKER: 'マーカーの並びが崩れています', BAD_LENGTH: 'セグメントの長さが不正です' },
  en: { NOT_PNG_OR_JPEG: 'not a PNG or JPEG', TRUNCATED: 'the file is cut off', BAD_CRC: 'a chunk CRC does not match', BAD_CHUNK: 'the chunk layout is broken', NO_HEADER: 'the header (IHDR) is missing', NO_IMAGE_DATA: 'the end marker comes before the image data', BAD_MARKER: 'the marker layout is broken', BAD_LENGTH: 'a segment length is invalid' },
};

export async function kuronuriTailTool(opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'ja';
  let bytes, source;
  if (opts.base64) {
    const b64 = String(opts.base64).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64)) throw new KuronuriTailError('INVALID_BASE64', 'base64 is not valid');
    bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    source = 'base64';
  } else if (opts.path) {
    if (!path.isAbsolute(opts.path)) throw new KuronuriTailError('PATH_NOT_ABSOLUTE', 'path must be an absolute path');
    const st = await stat(opts.path).catch(() => null);
    if (!st || !st.isFile()) throw new KuronuriTailError('NOT_FOUND', 'file not found: ' + opts.path);
    if (st.size > MAX_BYTES) throw new KuronuriTailError('TOO_LARGE', 'files over 50 MB are not read');
    bytes = new Uint8Array(await readFile(opts.path));
    source = 'path';
  } else throw new KuronuriTailError('NO_INPUT', 'pass base64 (or an absolute path)');
  if (bytes.length > MAX_BYTES) throw new KuronuriTailError('TOO_LARGE', 'images over 50 MB are not read');
  const r = inspectTail(bytes);
  const endName = r.format === 'png' ? 'IEND' : r.format === 'jpeg' ? 'EOI' : null;
  let summary;
  if (r.status === 'none') summary = lang === 'en' ? 'None: nothing follows the end of the image (' + endName + ').' : 'なし: 画像の終わり（' + endName + '）の後ろには何もありません。';
  else if (r.status === 'found') summary = lang === 'en' ? 'Yes: ' + r.trailing + ' bytes follow the end of the image (' + endName + ').' : 'あり: 画像の終わり（' + endName + '）の後ろに ' + r.trailing + ' バイトのデータが付いています。';
  else summary = lang === 'en' ? 'Could not analyze: ' + REASON.en[r.reason] + '.' : '解析不能: ' + REASON.ja[r.reason] + '。';
  return {
    ok: true, source, format: r.format, status: r.status, hasTrailing: r.status === 'unknown' ? null : r.status === 'found',
    trailingBytes: r.trailing, imageEnd: r.end, size: r.size, reason: r.reason, at: r.at ?? null, summary,
    note: lang === 'en'
      ? 'This only checks for data after the end of the image. It does not judge whether a black-out or marker shows through (check that visually at https://tools.first-ch.com/en/kuronuri/) and does not recover anything from the trailing data.'
      : '画像の終端より後ろのデータだけを調べます。黒塗り・マーカーが透けているかは判定しません（目で確かめるには https://tools.first-ch.com/kuronuri/ ）。後ろのデータからの復元もしません。',
  };
}
