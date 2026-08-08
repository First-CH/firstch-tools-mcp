// Base64 / Data URI 変換（tools.first-ch.com/base64/ と同一ロジック）
//
// 「変換コア」ブロックは site 側の site/base64/app.js と同一の実装。
// 2箇所ルール: 片方を直したらもう片方も同じ内容で直す（site側が正本）。
// btoa / atob / TextEncoder / TextDecoder は Node 18+ にグローバルで存在するため、
// ブラウザ版のコードをそのまま持ってこられる（環境差で結果がずれない）。
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

/* ==================== ここから変換コア（site/base64/app.js と同一） ==================== */

const STD_B64 = /^[A-Za-z0-9+/]*$/;

/* ---- Base64 ---- */

// バイト列 → 標準Base64（RFC 4648 §4・パディングあり）
export function bytesToBase64(bytes) {
  let bin = '';
  // String.fromCharCode の引数個数上限（環境依存）に当たらないよう分割して連結する
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(bin);
}

// Base64 → バイト列。標準/URLセーフ、改行・空白混じり、パディング欠けをすべて受け付ける
// （貼り付け元がメール・JSON・シェル出力のどれでも通るようにするため）。
export function base64ToBytes(input) {
  let s = String(input).replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/');
  s = s.replace(/=+$/, '');
  if (!STD_B64.test(s)) throw new RangeError('BAD_CHAR');
  if (s.length % 4 === 1) throw new RangeError('BAD_LENGTH');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

// 標準Base64を、URLセーフ（-_・パディング無し）／指定桁での改行（MIMEは76桁）へ整形する
export function formatBase64(b64, opts) {
  const { urlSafe = false, wrap = 0 } = opts || {};
  let out = b64;
  if (urlSafe) out = out.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (wrap > 0) out = (out.match(new RegExp('.{1,' + wrap + '}', 'g')) || []).join('\n');
  return out;
}

/* ---- Data URI ---- */

// パーセントエンコードをバイト単位で解く（%XX が非UTF-8のバイトでも壊れないように）
export function percentDecode(str) {
  const src = new TextEncoder().encode(str);
  const out = [];
  for (let i = 0; i < src.length; i++) {
    if (src[i] === 0x25 && i + 2 < src.length) {
      const hex = String.fromCharCode(src[i + 1], src[i + 2]);
      if (/^[0-9a-f]{2}$/i.test(hex)) {
        out.push(parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    out.push(src[i]);
  }
  return new Uint8Array(out);
}

// data:[<mediatype>][;charset=…][;base64],<data> を分解する。data URI でなければ null
export function parseDataUri(input) {
  const m = /^\s*data:([^,]*),([\s\S]*)$/i.exec(String(input));
  if (!m) return null;
  const params = m[1].split(';').filter(Boolean);
  const isBase64 = params.some((p) => p.trim().toLowerCase() === 'base64');
  const mimeType = params.length && params[0].includes('/') ? params[0].trim().toLowerCase() : 'text/plain';
  const cs = params.find((p) => p.trim().toLowerCase().startsWith('charset='));
  return {
    mimeType,
    charset: cs ? cs.trim().slice(8) : '',
    isBase64,
    bytes: isBase64 ? base64ToBytes(m[2]) : percentDecode(m[2].replace(/\s+/g, '')),
  };
}

export const buildDataUri = (bytes, mimeType) =>
  'data:' + (mimeType || 'application/octet-stream') + ';base64,' + bytesToBase64(bytes);

// SVGはbase64（必ず約1.33倍になる）より、パーセントエンコードのまま埋め込む方が小さい。
// HTML属性にも CSS url("…") にもそのまま貼れるよう、& " < > # % 空白・非ASCIIは必ず退避する。
export function svgPercentDataUri(svgText) {
  let s = String(svgText)
    .replace(/^﻿/, '')
    .replace(/<\?xml[\s\S]*?\?>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/[\t\n\r]+/g, ' ')
    .replace(/ {2,}/g, ' ')
    .trim();
  // タグ間の空白は詰めたいが、<text>/<tspan> がある場合は語間の空白が描画に効くので触らない
  if (!/<(text|tspan)\b/i.test(s)) s = s.replace(/>\s+</g, '><');
  // 属性の "…" を '…' に寄せると %22 が消えて短くなる。元に ' が無いときだけ（値を壊さないため）
  if (!s.includes("'")) s = s.replace(/"/g, "'");
  // encodeURIComponent は A-Za-z0-9 -_.!~*'() 以外をすべて %XX にする。
  // そのうちURIにそのまま書ける記号だけ戻して短くする（& " < > # % と空白は戻さない）。
  const encoded = encodeURIComponent(s)
    .replace(/%3A/gi, ':')
    .replace(/%2F/gi, '/')
    .replace(/%2C/gi, ',')
    .replace(/%3B/gi, ';')
    .replace(/%3D/gi, '=')
    .replace(/%40/gi, '@')
    .replace(/%2B/gi, '+')
    .replace(/%24/gi, '$')
    .replace(/%3F/gi, '?');
  return 'data:image/svg+xml,' + encoded;
}

/* ---- 種類の判定 ---- */

const MAGIC = [
  { mime: 'image/png', test: (b) => b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 },
  { mime: 'image/jpeg', test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { mime: 'image/gif', test: (b) => b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38 },
  {
    mime: 'image/webp',
    test: (b) => b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50,
  },
  { mime: 'image/x-icon', test: (b) => b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00 },
  { mime: 'application/pdf', test: (b) => b[0] === 0x25 && b[1] === 0x50 && b[2] === 0x44 && b[3] === 0x46 },
  { mime: 'font/woff2', test: (b) => b[0] === 0x77 && b[1] === 0x4f && b[2] === 0x46 && b[3] === 0x32 },
  { mime: 'font/woff', test: (b) => b[0] === 0x77 && b[1] === 0x4f && b[2] === 0x46 && b[3] === 0x46 },
  { mime: 'application/zip', test: (b) => b[0] === 0x50 && b[1] === 0x4b },
];

const EXT_BY_MIME = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/x-icon': 'ico',
  'application/pdf': 'pdf',
  'application/zip': 'zip',
  'application/json': 'json',
  'font/woff': 'woff',
  'font/woff2': 'woff2',
  'text/plain': 'txt',
  'text/html': 'html',
  'text/css': 'css',
  'text/csv': 'csv',
};

// UTF-8として読めればその文字列を、読めなければ null を返す
export function decodeUtf8(bytes) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (e) {
    return null;
  }
}

// マジックナンバー → SVG/テキスト判定 の順で中身から種類を推定する
export function sniffType(bytes) {
  for (const m of MAGIC) {
    if (bytes.length >= 12 && m.test(bytes)) return { mimeType: m.mime, text: null };
  }
  const text = decodeUtf8(bytes);
  if (text === null) return { mimeType: 'application/octet-stream', text: null };
  if (/^\s*(<\?xml[\s\S]*?\?>\s*)?(<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) {
    return { mimeType: 'image/svg+xml', text };
  }
  return { mimeType: 'text/plain', text };
}

export const extForMime = (mime) => EXT_BY_MIME[String(mime).toLowerCase()] || 'bin';

/* ---- 貼り付け用スニペット ---- */

export function buildSnippets(uri, opts) {
  const { width = 0, height = 0, mimeType = '' } = opts || {};
  if (!/^image\//i.test(mimeType)) return null;
  const size = width && height ? ` width="${width}" height="${height}"` : '';
  return {
    html: `<img src="${uri}"${size} alt="" decoding="async">`,
    css: '.icon {\n'
      + `  background-image: url("${uri}");\n`
      + '  background-repeat: no-repeat;\n'
      + '  background-size: contain;\n'
      + (width && height ? `  width: ${width}px;\n  height: ${height}px;\n` : '')
      + '}',
  };
}

/* ==================== ここまで変換コア ==================== */

// SVGのルート要素から width/height を読む。Web版は <img> の naturalWidth で測るが、
// Node には描画エンジンが無いため、属性（無ければ viewBox）から取る。
// 数値でない指定（100% など）は「不明」として 0 を返し、スニペットから寸法属性を落とす。
function svgSize(svgText) {
  const root = /<svg\b[^>]*>/i.exec(svgText);
  if (!root) return { width: 0, height: 0 };
  const attr = (name) => {
    const m = new RegExp(`\\b${name}\\s*=\\s*("[^"]*"|'[^']*'|[^\\s/>]+)`, 'i').exec(root[0]);
    if (!m) return 0;
    // 値の全体が数値（+ 任意の px）のときだけ採る。100% や 2em は「不明」として 0 を返す
    const v = m[1].replace(/^["']|["']$/g, '').trim();
    return /^[0-9.]+(px)?$/i.test(v) ? Math.round(parseFloat(v)) : 0;
  };
  const width = attr('width');
  const height = attr('height');
  if (width && height) return { width, height };
  const vb = /\bviewBox\s*=\s*["']([^"']+)["']/i.exec(root[0]);
  if (vb) {
    const n = vb[1].trim().split(/[\s,]+/).map(Number);
    if (n.length === 4 && n.every((v) => Number.isFinite(v))) {
      return { width: Math.round(n[2]), height: Math.round(n[3]) };
    }
  }
  return { width: 0, height: 0 };
}

const fmtBytes = (n) => (n >= 1048576 ? (n / 1048576).toFixed(2) + ' MB' : n >= 1024 ? (n / 1024).toFixed(1) + ' KB' : n + ' B');

export class Base64Error extends Error {}

const explain = (e) => {
  if (e instanceof RangeError && e.message === 'BAD_CHAR') {
    return 'Base64として読めません（A-Z a-z 0-9 + / - _ = 以外の文字が含まれています）';
  }
  if (e instanceof RangeError && e.message === 'BAD_LENGTH') {
    return 'Base64として読めません（長さが1文字ずれています。Base64本体の長さは 4n+1 になりません）';
  }
  return `Base64として読めません（${e.message}）`;
};

/**
 * テキスト/ファイルを Base64・data URI へ変換する（mode='encode'）か、
 * Base64・data URI を元のバイト列へ戻す（mode='decode'）。
 *
 * @param {object} opts
 * @param {'encode'|'decode'} [opts.mode='encode']
 * @param {string} [opts.text]        encode: 対象テキスト（UTF-8として符号化する）
 * @param {string} [opts.path]        encode: 対象ファイルの絶対パス（text と排他）
 * @param {string} [opts.base64]      decode: Base64本体または data URI 全体
 * @param {string} [opts.outputPath]  decode: 復元したバイト列を書き出す絶対パス
 * @param {boolean}[opts.urlSafe]     encode: URLセーフ（-_・パディング無し）にする
 * @param {number} [opts.wrap]        encode: n桁ごとに改行（MIMEは76）
 * @param {boolean}[opts.dataUri]     encode: data URI も返す（path 指定時は常に返す）
 * @param {string} [opts.mimeType]    encode: data URI のMIMEタイプ（未指定なら中身から判定）
 * @param {boolean}[opts.snippets]    encode: HTML/CSS スニペットも返す（画像のみ）
 */
export async function base64Convert(opts = {}) {
  const mode = opts.mode || 'encode';
  if (mode !== 'encode' && mode !== 'decode') throw new Base64Error(`mode は encode か decode: ${opts.mode}`);

  if (mode === 'decode') {
    const src = opts.base64;
    if (typeof src !== 'string' || !src.trim()) throw new Base64Error('decode には base64（Base64本体または data URI）が必要です');
    let bytes;
    let declared = '';
    try {
      const parsed = parseDataUri(src);
      if (parsed) {
        bytes = parsed.bytes;
        declared = parsed.mimeType;
      } else {
        bytes = base64ToBytes(src);
      }
    } catch (e) {
      throw new Base64Error(explain(e));
    }
    const sniffed = sniffType(bytes);
    // data URI が名乗る種類より、中身から分かる種類を優先する（宣言のずれたコピペを拾わないため）
    const mimeType = !declared || declared === 'text/plain' ? sniffed.mimeType : declared;
    const result = {
      mode: 'decode',
      mime_type: mimeType,
      declared_mime_type: declared || null,
      bytes: bytes.length,
      size_human: fmtBytes(bytes.length),
      is_text: sniffed.text !== null,
      text: sniffed.text,
      base64: bytesToBase64(bytes),
      suggested_extension: extForMime(mimeType),
    };
    if (opts.outputPath) {
      await writeFile(opts.outputPath, bytes);
      result.output = opts.outputPath;
      // ファイルに書けたなら base64 は重複した重い情報でしかない
      delete result.base64;
    }
    return result;
  }

  /* ---- encode ---- */
  const hasText = typeof opts.text === 'string';
  if (hasText === Boolean(opts.path)) throw new Base64Error('encode には text か path のどちらか一方を渡してください');

  let bytes;
  let name = null;
  if (hasText) {
    bytes = new TextEncoder().encode(opts.text);
  } else {
    bytes = new Uint8Array(await readFile(opts.path));
    name = basename(opts.path);
  }

  const sniffed = sniffType(bytes);
  // テキストで渡されても中身がSVGなら画像として扱う（SVGソースを貼って data URI を作る用途が多いため）
  const mimeType = opts.mimeType
    || (hasText && sniffed.mimeType === 'text/plain' ? 'text/plain;charset=utf-8' : sniffed.mimeType);
  const raw = bytesToBase64(bytes);
  const wrap = Number(opts.wrap) > 0 ? Math.floor(Number(opts.wrap)) : 0;
  const base64 = formatBase64(raw, { urlSafe: Boolean(opts.urlSafe), wrap });

  const result = {
    mode: 'encode',
    source: name ? { path: opts.path, name } : { type: 'text' },
    mime_type: mimeType,
    bytes: bytes.length,
    size_human: fmtBytes(bytes.length),
    base64,
    base64_length: base64.length,
    url_safe: Boolean(opts.urlSafe),
    wrap: wrap || null,
    growth: bytes.length ? `+${Math.round((raw.length / bytes.length - 1) * 100)}%` : '+0%',
  };

  // data URI は「ファイルを読んだとき」と「明示的に要求されたとき」に返す
  if (opts.dataUri || !hasText) {
    const isSvg = mimeType === 'image/svg+xml' && sniffed.text !== null;
    const base64Uri = 'data:' + mimeType + ';base64,' + raw;
    const percentUri = isSvg ? svgPercentDataUri(sniffed.text) : '';
    // SVGはbase64（必ず約1.33倍）よりパーセントエンコードの方が小さいので、短い方を既定にする
    const uri = percentUri && percentUri.length <= base64Uri.length ? percentUri : base64Uri;
    result.data_uri = uri;
    result.data_uri_length = uri.length;
    if (percentUri) {
      result.data_uri_base64 = base64Uri;
      result.data_uri_percent = percentUri;
      result.data_uri_encoding = uri === percentUri ? 'percent' : 'base64';
    }
    if (opts.snippets) {
      const size = isSvg ? svgSize(sniffed.text) : { width: 0, height: 0 };
      const snippets = buildSnippets(uri, { ...size, mimeType });
      if (snippets) result.snippets = snippets;
      // 寸法が読めなかった画像は、レイアウトシフト対策の width/height を補えないことを伝える
      if (snippets && !size.width) result.snippets_note = 'width/height は読み取れなかったため省略しました（レイアウトシフト対策として手動で追記してください）';
    }
    if (bytes.length > 10240) {
      result.warning = '10 KBを超えています。大きなファイルの埋め込みはHTML/CSSのキャッシュを妨げ初回表示も遅くなるため、通常のファイル参照を推奨します。';
    }
  }
  return result;
}
