/* 受け取ったComfyUI画像のキー点検（comfy_png_leak_scan）
 * 解析のコアは FirstCHTools の site/comfy-key-leak/lib.mjs と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルの「ここからコア」〜「ここまでコア」はバイト一致する（どちらも ES module）:
 *   diff <(sed -n '/^\/\/ ===== ここから/,/^\/\/ ===== ここまで/p' site/comfy-key-leak/lib.mjs) <(sed -n '/^\/\/ ===== ここから/,/^\/\/ ===== ここまで/p' comfy-png-leak.mjs)
 *
 * ComfyUI の PNG のチャンクを順に読み、CRC を確かめ、tEXt と非圧縮の iTXt の文字列から APIキーの形（AIza・sk-・sk-ant-・hf_・r8_）を探す。
 * prompt ならノードID・class_type・inputs の名前、workflow だけならノードIDと widgets_values の何番目かを返す。値は先頭4字だけを残して伏せ、元の値は返さない。
 * キーが有効かどうかは確かめない。完全ローカル処理・ネットワーク送信なし。 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { writeOutput } from './fs-safe.mjs';

// ===== ここからコア =====
export const MAX_BYTES = 30 * 1024 * 1024;   // これを超える PNG は読まずに「未検査」
const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
const TEXT_TYPES = ['tEXt', 'iTXt', 'zTXt'];
// 中身に文字列を持たない（キーが入りようのない）既知のチャンク。これ以外の補助チャンクは形だけ探して「未検査」に数える
const BINARY_TYPES = ['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'cHRM', 'gAMA', 'iCCP', 'sBIT', 'sRGB', 'cICP', 'mDCV', 'cLLI', 'bKGD', 'hIST', 'pHYs', 'sPLT', 'tIME', 'acTL', 'fcTL', 'fdAT', 'oFFs', 'pCAL', 'sCAL', 'sTER', 'dSIG', 'gIFg', 'gIFx', 'vpAg', 'iDOT', 'orNT'];

// キーの形。sk-ant- は sk- より先に見る。前に英数字・_・- が続く場合（task- など）は拾わない
export const KINDS = {
  anthropic: { prefix: 'sk-ant-', re: 'sk-ant-[A-Za-z0-9_-]{20,}' },
  openai: { prefix: 'sk-', re: 'sk-[A-Za-z0-9_-]{20,}' },
  google: { prefix: 'AIza', re: 'AIza[A-Za-z0-9_-]{35}' },
  huggingface: { prefix: 'hf_', re: 'hf_[A-Za-z0-9]{30,}' },
  replicate: { prefix: 'r8_', re: 'r8_[A-Za-z0-9]{30,}' },
};
const KIND_ORDER = ['anthropic', 'openai', 'google', 'huggingface', 'replicate'];
function keyRe() {
  return new RegExp('(?<![A-Za-z0-9_-])(?:' + KIND_ORDER.map((k) => '(' + KINDS[k].re + ')').join('|') + ')', 'g');
}

// 各サービスの公式の無効化（削除・作り直し）画面
export const REVOKE = {
  google: [
    { ja: 'Google Cloud コンソールの「認証情報」', en: 'Google Cloud console – Credentials', url: 'https://console.cloud.google.com/apis/credentials' },
    { ja: 'Google AI Studio の API キー', en: 'Google AI Studio – API keys', url: 'https://aistudio.google.com/app/apikey' },
  ],
  openai: [{ ja: 'OpenAI の API keys', en: 'OpenAI – API keys', url: 'https://platform.openai.com/api-keys' }],
  anthropic: [{ ja: 'Anthropic Console の API Keys', en: 'Anthropic Console – API keys', url: 'https://console.anthropic.com/settings/keys' }],
  huggingface: [{ ja: 'Hugging Face の Access Tokens', en: 'Hugging Face – Access tokens', url: 'https://huggingface.co/settings/tokens' }],
  replicate: [{ ja: 'Replicate の API tokens', en: 'Replicate – API tokens', url: 'https://replicate.com/account/api-tokens' }],
};

export const KIND_LABEL = {
  ja: { google: 'Google の API キーの形', openai: 'OpenAI などの API キーの形', anthropic: 'Anthropic の API キーの形', huggingface: 'Hugging Face のトークンの形', replicate: 'Replicate のトークンの形' },
  en: { google: 'Google API key format', openai: 'OpenAI-style API key format', anthropic: 'Anthropic API key format', huggingface: 'Hugging Face token format', replicate: 'Replicate token format' },
};

// ---- CRC-32（PNG の各チャンクの検査値） ----
let CRC_TABLE = null;
export function crc32(bytes, start = 0, end = bytes.length) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(b, i) { return ((b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3]) >>> 0; }
function typeOf(b, i) { return String.fromCharCode(b[i], b[i + 1], b[i + 2], b[i + 3]); }
function latin1(b, s, e) { let o = ''; for (let i = s; i < e; i++) o += String.fromCharCode(b[i]); return o; }
function utf8(b, s, e, fallback) {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b.subarray(s, e)); } catch (_) { return fallback ? latin1(b, s, e) : null; }
}

// 先頭の数バイトで形式を見分ける（PNG でないときの案内に使う）
export function sniff(b) {
  if (b.length >= 8 && SIG.every((v, i) => b[i] === v)) return 'png';
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'jpeg';
  if (b.length >= 12 && latin1(b, 0, 4) === 'RIFF' && latin1(b, 8, 12) === 'WEBP') return 'webp';
  if (b.length >= 6 && /^GIF8[79]a$/.test(latin1(b, 0, 6))) return 'gif';
  if (b.length >= 12 && latin1(b, 4, 8) === 'ftyp') return 'heif';
  return 'other';
}

// チャンクを順に読む。壊れていれば { error } を返す（どこまで読めたかは chunks に残す）
export function readChunks(b) {
  const chunks = [];
  if (sniff(b) !== 'png') return { chunks, error: 'NOT_PNG' };
  let i = 8, sawEnd = false;
  while (i < b.length) {
    if (i + 12 > b.length) return { chunks, error: 'TRUNCATED', at: i };
    const len = u32(b, i), type = typeOf(b, i + 4);
    if (!/^[A-Za-z]{4}$/.test(type)) return { chunks, error: 'BAD_TYPE', at: i };
    if (len > 0x7fffffff || i + 12 + len > b.length) return { chunks, error: 'TRUNCATED', at: i };
    const crc = u32(b, i + 8 + len);
    if (crc32(b, i + 4, i + 8 + len) !== crc) return { chunks, error: 'CRC', at: i, type };
    chunks.push({ type, offset: i, length: len, dataStart: i + 8, dataEnd: i + 8 + len, end: i + 12 + len });
    i += 12 + len;
    if (type === 'IEND') { sawEnd = true; break; }
  }
  if (!chunks.length || chunks[0].type !== 'IHDR') return { chunks, error: 'NO_IHDR' };
  if (!sawEnd) return { chunks, error: 'NO_IEND' };
  return { chunks, error: null, trailing: b.length - i, trailingStart: i };
}

// ---- JSON を、同じ名前の項目も捨てずに読む（値ごとに元の文字列の中の位置を持つ） ----
function parseJsonAst(s) {
  let i = 0, depth = 0;
  const ws = () => { while (i < s.length && (s[i] === ' ' || s[i] === '\t' || s[i] === '\n' || s[i] === '\r')) i++; };
  const fail = () => { throw new Error('json'); };
  function str() {
    const start = i; i++;
    let out = '';
    for (;;) {
      if (i >= s.length) fail();
      const c = s[i];
      if (c === '"') { i++; break; }
      if (c === '\\') {
        const e = s[i + 1];
        if (e === 'u') { const h = s.slice(i + 2, i + 6); if (!/^[0-9a-fA-F]{4}$/.test(h)) fail(); out += String.fromCharCode(parseInt(h, 16)); i += 6; continue; }
        const m = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[e];
        if (m === undefined) fail();
        out += m; i += 2; continue;
      }
      out += c; i++;
    }
    return { t: 'str', v: out, start, end: i };
  }
  function val() {
    ws();
    const c = s[i];
    if (c === '{') {
      if (++depth > 400) fail();
      const node = { t: 'obj', entries: [], start: i }; i++; ws();
      if (s[i] === '}') { i++; depth--; node.end = i; return node; }
      for (;;) {
        ws(); if (s[i] !== '"') fail();
        const k = str(); ws(); if (s[i] !== ':') fail(); i++;
        node.entries.push([k, val()]); ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === '}') { i++; break; }
        fail();
      }
      depth--; node.end = i; return node;
    }
    if (c === '[') {
      if (++depth > 400) fail();
      const node = { t: 'arr', items: [], start: i }; i++; ws();
      if (s[i] === ']') { i++; depth--; node.end = i; return node; }
      for (;;) {
        node.items.push(val()); ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ']') { i++; break; }
        fail();
      }
      depth--; node.end = i; return node;
    }
    if (c === '"') return str();
    const m = /^(?:-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(s.slice(i, i + 400));
    if (!m) fail();
    const start = i; i += m[0].length;
    return { t: 'lit', v: m[0], start, end: i };
  }
  const root = val(); ws();
  if (i !== s.length) fail();
  return root;
}

function scalarOf(node) {
  if (!node) return null;
  if (node.t === 'str') return node.v;
  if (node.t === 'lit') return node.v;
  return null;
}
function entriesNamed(obj, name) { return obj && obj.t === 'obj' ? obj.entries.filter(([k]) => k.v === name).map(([, v]) => v) : []; }

// JSON の形から ComfyUI のどちらの形式かを見分ける（チャンクの名前は書き換えられるので形で見る）
function shapeOf(root) {
  if (!root || root.t !== 'obj') return 'json';
  if (entriesNamed(root, 'nodes').some((v) => v.t === 'arr')) return 'workflow';
  const objs = root.entries.filter(([, v]) => v.t === 'obj');
  if (objs.length && objs.some(([, v]) => entriesNamed(v, 'class_type').length)) return 'prompt';
  return 'json';
}

function maskText(s) { return String(s).replace(keyRe(), (v) => maskValue(v)); }
function seg(s) { s = maskText(s); return s.length > 40 ? s.slice(0, 39) + '…' : s; }

export function maskValue(v) {
  v = String(v);
  return v.slice(0, 4) + '•'.repeat(Math.max(0, Math.min(v.length - 4, 12)));
}

// 文字列の値（と項目名）を辿り、キーの形が見つかったら場所をつけて返す
function walk(root, shape, push) {
  const stack = [];   // { node, key }（key は親の中での名前か番号）
  function visit(node, key, isKey) {
    if (node.t === 'str') { push(node.v, locate(shape, stack, key, isKey), node); return; }
    stack.push({ node, key });
    if (node.t === 'obj') for (const [k, v] of node.entries) { visit(k, k.v, true); visit(v, k.v, false); }
    else if (node.t === 'arr') node.items.forEach((v, n) => visit(v, n, false));
    stack.pop();
  }
  visit(root, null, false);
}

function locate(shape, stack, key, isKey) {
  // stack[0] が根。path は根から見た名前・番号の並び（最後が値の位置）
  const path = stack.slice(1).map((f) => f.key).concat([key]);
  const dupKey = stack.some((f, n) => {
    if (f.node.t !== 'obj') return false;
    const name = n + 1 < stack.length ? stack[n + 1].key : key;
    return typeof name === 'string' && f.node.entries.filter(([k]) => k.v === name).length > 1;
  });
  const loc = { shape, path: path.map((p) => typeof p === 'number' ? p : seg(p)), isKey: !!isKey, dupKey };
  if (shape === 'prompt' && stack.length >= 2 && stack[1].node.t === 'obj') {
    const node = stack[1].node;
    loc.nodeId = seg(path[0]);
    loc.classType = [...new Set(entriesNamed(node, 'class_type').map(scalarOf).filter((v) => v != null).map(seg))];
    if (path[1] === 'inputs' && path.length >= 3 && !(path.length === 3 && isKey)) {
      loc.input = seg(path[2]);
      if (path.length > 3) loc.inputPath = path.slice(3).map((p) => typeof p === 'number' ? p : seg(p));
    } else loc.extra = true;
    return loc;
  }
  if (shape === 'workflow') {
    // いちばん内側の「nodes 配列の要素」をノードとみなす（サブグラフの定義の中のノードも同じ）
    for (let n = stack.length - 1; n >= 2; n--) {
      const arr = stack[n - 1], el = stack[n];
      if (arr.node.t === 'arr' && el.node.t === 'obj' && typeof arr.key === 'string' && arr.key === 'nodes' && n - 1 >= 1 && stack[n - 2].node.t === 'obj') {
        const node = el.node;
        const id = entriesNamed(node, 'id').map(scalarOf).find((v) => v != null);
        loc.nodeId = id == null ? null : seg(id);
        const mode = entriesNamed(node, 'mode').map(scalarOf).find((v) => v != null);
        if (mode === '4') loc.bypassed = true;
        if (mode === '2') loc.muted = true;
        const rest = stack.slice(n + 1).map((f) => f.key).concat([key]);
        if (n >= 3) loc.inSubgraph = stack.slice(1, n - 1).some((f) => f.key === 'subgraphs' || f.key === 'definitions');
        if (rest[0] === 'widgets_values' && rest.length >= 2 && !(rest.length === 2 && isKey)) {
          if (typeof rest[1] === 'number') loc.widgetIndex = rest[1];
          else loc.widgetKey = seg(rest[1]);
          loc.fieldUnknown = true;
        } else { loc.extra = true; loc.rest = rest.map((p) => typeof p === 'number' ? p : seg(p)); }
        return loc;
      }
    }
    loc.extra = true;
    return loc;
  }
  return loc;
}

function scanText(text, chunkInfo, findings) {
  let root = null;
  const t = text.trim();
  if (t[0] === '{' || t[0] === '[') { try { root = parseJsonAst(text); } catch (_) { root = null; } }
  const covered = [];
  const add = (value, kind, loc) => {
    findings.push({ kind, prefix: KINDS[kind].prefix, masked: maskValue(value), length: value.length, chunk: chunkInfo, ...loc });
  };
  const matchAll = (s, cb) => {
    const re = keyRe(); let m;
    while ((m = re.exec(s))) {
      const n = m.slice(1).findIndex((x) => x !== undefined);
      cb(m[0], KIND_ORDER[n], m.index);
    }
  };
  if (root) {
    const shape = shapeOf(root);
    walk(root, shape, (s, loc, node) => {
      covered.push([node.start, node.end]);
      matchAll(s, (v, kind) => add(v, kind, loc));
    });
  }
  // JSON として読めない文字列・文字列の外（書き損じた JSON など）は、文字列全体で探す
  matchAll(text, (v, kind, at) => {
    if (covered.some(([a, b]) => at >= a && at < b)) return;
    add(v, kind, { shape: root ? 'json-outside' : 'text', path: [] });
  });
  return root ? shapeOf(root) : 'text';
}

/** PNG のバイト列を点検する。返り値に元の値は入らない（先頭4字と長さだけ） */
export function scanPng(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const res = { status: 'none', reason: null, format: sniff(b), size: b.length, chunks: [], findings: [], unchecked: [], hasCaBX: false, hasExif: false, canStrip: false, kinds: [], textChunks: 0, trailing: 0 };
  if (b.length > MAX_BYTES) { res.status = 'unchecked'; res.reason = 'TOO_LARGE'; res.unchecked.push({ type: '*', why: 'TOO_LARGE' }); return res; }
  const rc = readChunks(b);
  if (rc.error) {
    res.status = 'failed'; res.reason = rc.error;
    if (rc.type) res.badChunk = rc.type;
    return res;
  }
  for (const c of rc.chunks) {
    const info = { type: c.type, length: c.length, offset: c.offset, checked: true };
    if (c.type === 'tEXt' || c.type === 'iTXt' || c.type === 'zTXt') {
      res.textChunks++;
      const d = b.subarray(c.dataStart, c.dataEnd);
      const z = d.indexOf(0);
      info.keyword = seg(latin1(d, 0, z < 0 ? Math.min(d.length, 79) : z));
      if (z < 0) { info.checked = false; info.why = 'MALFORMED'; }
      else if (c.type === 'zTXt') { info.checked = false; info.why = 'COMPRESSED'; }
      else if (c.type === 'tEXt') {
        const text = utf8(d, z + 1, d.length, true);
        info.shape = scanText(text, { type: c.type, keyword: info.keyword }, res.findings);
      } else {
        // iTXt: keyword \0 圧縮フラグ 圧縮方式 言語タグ \0 翻訳キーワード \0 本文（UTF-8）
        const flag = d[z + 1];
        const l1 = d.indexOf(0, z + 3), l2 = l1 < 0 ? -1 : d.indexOf(0, l1 + 1);
        if (flag === 1) { info.checked = false; info.why = 'COMPRESSED'; }
        else if (flag !== 0 || l2 < 0) { info.checked = false; info.why = 'MALFORMED'; }
        else {
          const text = utf8(d, l2 + 1, d.length, true);
          info.shape = scanText(text, { type: c.type, keyword: info.keyword }, res.findings);
        }
      }
    } else if (!BINARY_TYPES.includes(c.type)) {
      // eXIf・caBX（C2PA）・名前の分からないチャンクは構造を読まない。形だけは探すが、検査したとは言わない
      if (c.type === 'eXIf') res.hasExif = true;
      if (c.type === 'caBX') res.hasCaBX = true;
      info.checked = false; info.why = c.type === 'eXIf' ? 'EXIF' : c.type === 'caBX' ? 'C2PA' : 'UNKNOWN_CHUNK';
      scanText(latin1(b, c.dataStart, c.dataEnd), { type: c.type, keyword: null }, res.findings);
    }
    if (!info.checked) res.unchecked.push({ type: c.type, keyword: info.keyword || null, why: info.why });
    res.chunks.push(info);
  }
  if (rc.trailing > 0) {
    res.trailing = rc.trailing;
    res.unchecked.push({ type: 'IEND+', why: 'TRAILING' });
    scanText(latin1(b, rc.trailingStart, b.length), { type: 'IEND+', keyword: null }, res.findings);
  }
  res.kinds = KIND_ORDER.filter((k) => res.findings.some((f) => f.kind === k));
  res.status = res.findings.length ? 'found' : res.unchecked.length ? 'unchecked' : 'none';
  res.canStrip = !res.hasCaBX && res.textChunks > 0;
  return res;
}

/** 場所を1行の文にする（お知らせ文と画面で同じ言い方を使う） */
export function placeText(f, lang = 'ja') {
  const ja = lang !== 'en';
  const ct = f.classType && f.classType.length ? f.classType.join(' / ') : null;
  const node = f.nodeId != null ? (ja ? 'ノードID ' + f.nodeId : 'node ID ' + f.nodeId) : null;
  const p = (arr) => arr.map((x) => typeof x === 'number' ? '[' + x + ']' : x).join(' › ');
  if (f.shape === 'prompt' && node) {
    const head = node + (ct ? (ja ? '（' + ct + '）' : ' (' + ct + ')') : '');
    if (f.input) return head + (ja ? 'の入力欄「' + f.input + '」' : ', input "' + f.input + '"') + (f.inputPath ? ' ' + p(f.inputPath) : '');
    return head + (ja ? 'の inputs の外の項目「' : ', item outside inputs "') + p(f.path.slice(1)) + (ja ? '」' : '"');
  }
  if (f.shape === 'workflow' && node) {
    if (f.widgetIndex != null) return node + (ja ? ' の widgets_values の ' + (f.widgetIndex + 1) + ' 番目' : ', widgets_values item ' + (f.widgetIndex + 1));
    if (f.widgetKey != null) return node + (ja ? ' の widgets_values の「' + f.widgetKey + '」' : ', widgets_values "' + f.widgetKey + '"');
    return node + (ja ? ' の項目「' : ', item "') + p(f.rest || []) + (ja ? '」' : '"');
  }
  const where = f.chunk.keyword ? (ja ? '埋め込みテキスト「' + f.chunk.keyword + '」' : 'embedded text "' + f.chunk.keyword + '"') : (f.chunk.type === 'IEND+' ? (ja ? '画像の終わりの後ろに付いたデータ' : 'data after the end of the image') : (ja ? f.chunk.type + ' チャンク' : f.chunk.type + ' chunk'));
  if (f.path && f.path.length) return where + (ja ? 'の項目「' : ', item "') + p(f.path) + (ja ? '」' : '"');
  return where + (ja ? 'の中' : '');
}

/** キーの持ち主へのお知らせ文。値・ファイル名は入れない。欠陥や責任を言い切らない */
export function buildNotice(res, lang = 'ja', opts = {}) {
  const ja = lang !== 'en';
  if (!res || res.status !== 'found') return '';
  const lines = [], seen = new Set();
  for (const f of res.findings) {
    const src = f.shape === 'prompt' ? 'prompt' : f.shape === 'workflow' ? 'workflow' + (f.bypassed ? (ja ? '・迂回中のノード' : ', bypassed node') : f.muted ? (ja ? '・無効のノード' : ', muted node') : '') : null;
    const l = '・' + placeText(f, lang) + (src ? (ja ? '（' + src + '）' : ' (' + src + ')') : '') + (ja ? ': ' : ': ') + KIND_LABEL[ja ? 'ja' : 'en'][f.kind] + (ja ? '（' + f.prefix + ' で始まる）' : ' (starts with ' + f.prefix + ')');
    const line = ja ? l : l.replace(/^・/, '- ');
    if (!seen.has(line)) { seen.add(line); lines.push(line); }
  }
  const url = opts.url === false ? null : (opts.url || (ja ? 'https://tools.first-ch.com/comfy-key-leak/' : 'https://tools.first-ch.com/en/comfy-key-leak/'));
  if (ja) {
    return ['お知らせです。受け取った画像（PNG）の埋め込みデータに、APIキー形式の文字列がありました。', ...lines,
      '値そのものはこの連絡には書いていません。有効かどうかと、書き込まれた原因は確認していません。',
      '心当たりのあるキーでしたら、発行元の管理画面で状態をご確認ください。']
      .concat(url ? ['（確認には ' + url + ' を使いました。画像はブラウザの外へ送っていません）'] : []).join('\n');
  }
  return ['A quick heads-up: the embedded data of an image (PNG) I received contains strings in an API key format.', ...lines,
    'I have not included the values here. I have not checked whether they are valid, or how they got written into the image.',
    'If you recognise the key, you may want to check its status in the provider’s dashboard.']
    .concat(url ? ['(Checked with ' + url + ' — the image was not sent anywhere.)'] : []).join('\n');
}

/** tEXt・iTXt・zTXt を抜いたコピー。caBX 付き・壊れた PNG は書き換えない */
export function stripTextChunks(bytes) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (b.length > MAX_BYTES) throw Object.assign(new Error('too large'), { code: 'TOO_LARGE' });
  const rc = readChunks(b);
  if (rc.error) throw Object.assign(new Error('broken png'), { code: 'BROKEN' });
  if (rc.chunks.some((c) => c.type === 'caBX')) throw Object.assign(new Error('has caBX (C2PA)'), { code: 'HAS_CABX' });
  const keep = rc.chunks.filter((c) => !TEXT_TYPES.includes(c.type));
  const removed = rc.chunks.filter((c) => TEXT_TYPES.includes(c.type)).map((c) => c.type);
  let n = 8; for (const c of keep) n += c.end - c.offset;
  const out = new Uint8Array(n);
  out.set(b.subarray(0, 8), 0);
  let o = 8; for (const c of keep) { out.set(b.subarray(c.offset, c.end), o); o += c.end - c.offset; }
  return { bytes: out, removed, kept: keep.length, droppedTrailing: rc.trailing || 0 };
}

/** 書き出したコピーを読み直し、文字のチャンクが無いことと、残したチャンクが元とバイト単位で同じことを確かめる */
export function verifyStripped(orig, out) {
  const a = readChunks(orig instanceof Uint8Array ? orig : new Uint8Array(orig));
  const b = readChunks(out instanceof Uint8Array ? out : new Uint8Array(out));
  const r = { ok: false, readable: !b.error, textLeft: 0, kept: 0, sameBytes: false };
  if (a.error || b.error) return r;
  r.textLeft = b.chunks.filter((c) => TEXT_TYPES.includes(c.type)).length;
  const ka = a.chunks.filter((c) => !TEXT_TYPES.includes(c.type));
  const A = orig instanceof Uint8Array ? orig : new Uint8Array(orig), B = out instanceof Uint8Array ? out : new Uint8Array(out);
  r.kept = b.chunks.length;
  r.sameBytes = ka.length === b.chunks.length && ka.every((c, n) => {
    const d = b.chunks[n], len = c.end - c.offset;
    if (d.end - d.offset !== len) return false;
    for (let k = 0; k < len; k++) if (A[c.offset + k] !== B[d.offset + k]) return false;
    return true;
  });
  r.ok = r.textLeft === 0 && r.sameBytes;
  return r;
}
// ===== ここまでコア =====

// ---- MCP の入口 ----
export class ComfyPngLeakError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

export async function comfyPngLeakTool(opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'ja';
  let bytes = null, size = 0, source;
  if (opts.path) {
    if (!path.isAbsolute(opts.path)) throw new ComfyPngLeakError('PATH_NOT_ABSOLUTE', 'path must be an absolute path');
    const st = await stat(opts.path).catch(() => null);
    if (!st || !st.isFile()) throw new ComfyPngLeakError('NOT_FOUND', 'file not found: ' + opts.path);
    size = st.size; source = 'path';
    if (size <= MAX_BYTES) bytes = new Uint8Array(await readFile(opts.path));
  } else if (opts.base64) {
    const b64 = String(opts.base64).replace(/^data:[^,]*,/, '').replace(/\s+/g, '');
    if (!/^[A-Za-z0-9+/_-]*={0,2}$/.test(b64)) throw new ComfyPngLeakError('INVALID_BASE64', 'base64 is not valid');
    bytes = new Uint8Array(Buffer.from(b64, 'base64'));
    size = bytes.length; source = 'base64';
  } else throw new ComfyPngLeakError('NO_INPUT', 'pass path (absolute) or base64');

  // 大きいファイルは読まずに「未検査」（ページと同じ）
  const res = bytes ? scanPng(bytes) : { status: 'unchecked', reason: 'TOO_LARGE', format: null, size, chunks: [], findings: [], unchecked: [{ type: '*', why: 'TOO_LARGE' }], hasCaBX: false, hasExif: false, canStrip: false, kinds: [], textChunks: 0, trailing: 0 };
  const out = {
    ok: true, source, status: res.status, reason: res.reason, format: res.format, size,
    findings: res.findings.map((f) => ({ ...f, place: placeText(f, lang), kindLabel: KIND_LABEL[lang][f.kind] })),
    kinds: res.kinds,
    revoke: res.kinds.map((k) => ({ kind: k, links: REVOKE[k].map((r) => ({ label: r[lang], url: r.url })) })),
    unchecked: res.unchecked, chunks: res.chunks, hasCaBX: res.hasCaBX, hasExif: res.hasExif, canStrip: res.canStrip,
    notice: buildNotice(res, lang, { url: opts.includeUrl === false ? false : undefined }),
    caution: res.status === 'found'
      ? (lang === 'en' ? 'If the image has already been posted or delivered and the key is in use, deleting the image is not enough; disable the key in the provider dashboard. Validity was not checked.'
        : '投稿・納品済みで、実際に使っているキーなら、画像を消すだけでは対処できません。発行元の画面でキーを無効にしてください。キーが有効かどうかは確かめていません。')
      : null,
  };
  if (opts.outPath) {
    if (!path.isAbsolute(opts.outPath)) throw new ComfyPngLeakError('PATH_NOT_ABSOLUTE', 'outPath must be an absolute path');
    if (opts.path && path.resolve(opts.outPath) === path.resolve(opts.path)) throw new ComfyPngLeakError('SAME_FILE', 'outPath must differ from path (the original is never overwritten)');
    if (!bytes) throw new ComfyPngLeakError('TOO_LARGE', 'files over 30 MB are not rewritten');
    if (res.status === 'failed') throw new ComfyPngLeakError('BROKEN', 'damaged or non-PNG files are not rewritten');
    if (res.hasCaBX) throw new ComfyPngLeakError('HAS_CABX', 'PNGs with caBX (C2PA) are not rewritten');
    const s = stripTextChunks(bytes);
    const v = verifyStripped(bytes, s.bytes);
    if (!v.ok) throw new ComfyPngLeakError('VERIFY_FAILED', 'the stripped copy did not pass the re-check; nothing was written');
    await writeOutput(opts.outPath, s.bytes, { overwrite: opts.overwrite === true });
    const again = scanPng(s.bytes);
    out.stripped = { outPath: opts.outPath, removed: s.removed, kept: s.kept, droppedTrailingBytes: s.droppedTrailing, verify: v, remainingFindings: again.findings.length, exifKept: again.hasExif };
  }
  return out;
}

// ---- 見本（架空のキー）とテスト用の PNG を作る。キーの形の文字列はソースに直接書かない（実在のキーと見分けにくい並びを残さない） ----
export function fakeKey(kind, tag = 'EXAMPLE') {
  const pre = { google: ['AI', 'za'], openai: ['s', 'k-', 'proj-'], anthropic: ['s', 'k-ant-', 'api03-'], huggingface: ['h', 'f_'], replicate: ['r', '8_'] }[kind].join('');
  const body = ('FAKE0' + tag + '0NOT0A0REAL0KEY').replace(/[^A-Za-z0-9]/g, '0');
  const n = { google: 35, openai: 40, anthropic: 40, huggingface: 34, replicate: 37 }[kind];
  return pre + (body + '0'.repeat(n)).slice(0, n);
}

function chunk(type, data) {
  const out = new Uint8Array(12 + data.length);
  const len = data.length;
  out[0] = len >>> 24; out[1] = (len >>> 16) & 255; out[2] = (len >>> 8) & 255; out[3] = len & 255;
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const c = crc32(out, 4, 8 + len);
  out[8 + len] = c >>> 24; out[9 + len] = (c >>> 16) & 255; out[10 + len] = (c >>> 8) & 255; out[11 + len] = c & 255;
  return out;
}
export function textChunk(keyword, text, type = 'tEXt') {
  const enc = new TextEncoder();
  const k = enc.encode(keyword), t = type === 'tEXt' ? Uint8Array.from(String(text), (ch) => ch.charCodeAt(0) & 255) : enc.encode(text);
  if (type === 'tEXt') return chunk('tEXt', concat([k, [0], t]));
  return chunk('iTXt', concat([k, [0, 0, 0, 0, 0], t]));   // 非圧縮・言語タグと翻訳キーワードは空
}
export function rawChunk(type, data) { return chunk(type, data instanceof Uint8Array ? data : Uint8Array.from(data)); }
function concat(parts) {
  let n = 0; for (const p of parts) n += p.length;
  const out = new Uint8Array(n); let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

// 無圧縮の deflate（stored ブロック）で RGB の画像を PNG にする。extra は IDAT の前に入れるチャンク
export function makePng(w, h, pixel, extra = []) {
  const raw = new Uint8Array((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) { const [r, g, bl] = pixel(x, y); const o = y * (w * 3 + 1) + 1 + x * 3; raw[o] = r; raw[o + 1] = g; raw[o + 2] = bl; }
  }
  const blocks = [];
  for (let i = 0; i < raw.length; i += 65535) {
    const part = raw.subarray(i, Math.min(raw.length, i + 65535)), last = i + 65535 >= raw.length ? 1 : 0;
    blocks.push(Uint8Array.of(last, part.length & 255, part.length >>> 8, ~part.length & 255, (~part.length >>> 8) & 255), part);
  }
  let a = 1, b2 = 0;
  for (let i = 0; i < raw.length; i++) { a = (a + raw[i]) % 65521; b2 = (b2 + a) % 65521; }
  const adler = ((b2 << 16) | a) >>> 0;
  const z = concat([[0x78, 0x01], ...blocks, [adler >>> 24, (adler >>> 16) & 255, (adler >>> 8) & 255, adler & 255]]);
  const ihdr = Uint8Array.of(w >>> 24, (w >>> 16) & 255, (w >>> 8) & 255, w & 255, h >>> 24, (h >>> 16) & 255, (h >>> 8) & 255, h & 255, 8, 2, 0, 0, 0);
  return concat([Uint8Array.from(SIG), chunk('IHDR', ihdr), ...extra, chunk('IDAT', z), chunk('IEND', new Uint8Array(0))]);
}

// 見本の画像: 夕方の空と山（ComfyUI の出力を想定した架空の1枚）。prompt と workflow に架空のキーを入れる
export function samplePrompt() {
  return {
    '3': { inputs: { seed: 42, steps: 20, cfg: 7, sampler_name: 'euler', scheduler: 'normal', denoise: 1, model: ['4', 0], positive: ['6', 0], negative: ['7', 0], latent_image: ['5', 0] }, class_type: 'KSampler', _meta: { title: 'KSampler' } },
    '4': { inputs: { ckpt_name: 'example_model.safetensors' }, class_type: 'CheckpointLoaderSimple', _meta: { title: 'Load Checkpoint' } },
    '6': { inputs: { text: 'sunset over mountains, soft light', clip: ['4', 1] }, class_type: 'CLIPTextEncode', _meta: { title: 'Prompt' } },
    '12': { inputs: { prompt: 'refine the sky', model: 'example-pro', api_key: fakeKey('google', 'SAMPLE') }, class_type: 'ExampleGeminiPrompt', _meta: { title: '空の仕上げ' } },
    '9': { inputs: { filename_prefix: 'ComfyUI', images: ['8', 0] }, class_type: 'SaveImage', _meta: { title: 'Save Image' } },
  };
}
export function sampleWorkflow() {
  return {
    last_node_id: 15, last_link_id: 9,
    nodes: [
      { id: 3, type: 'KSampler', mode: 0, widgets_values: [42, 'fixed', 20, 7, 'euler', 'normal', 1] },
      { id: 4, type: 'CheckpointLoaderSimple', mode: 0, widgets_values: ['example_model.safetensors'] },
      { id: 12, type: 'ExampleGeminiPrompt', title: '空の仕上げ', mode: 0, widgets_values: ['refine the sky', 'example-pro', fakeKey('google', 'SAMPLE')] },
      { id: 15, type: 'ExampleUpscaleAPI', title: 'アップスケール（今回は使わない）', mode: 4, widgets_values: [2, fakeKey('replicate', 'SAMPLE')] },
      { id: 9, type: 'SaveImage', mode: 0, widgets_values: ['ComfyUI'] },
    ],
    links: [], groups: [], config: {}, extra: {}, version: 0.4,
  };
}
// ComfyUI（Python の json.dumps）と同じく ASCII の外の文字は \uXXXX にする（tEXt は Latin-1）
export function asciiJson(v) { return JSON.stringify(v).replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')); }
export function makeSamplePng(w = 360, h = 240) {
  const px = (x, y) => {
    const t = y / h;
    let r = 250 - 70 * t, g = 170 - 90 * t, b = 120 + 40 * t;
    const sx = x - w * 0.68, sy = y - h * 0.5, d = Math.sqrt(sx * sx + sy * sy);
    if (d < h * 0.14) { r = 255; g = 226; b = 170; }
    const m1 = h * 0.62 + Math.sin(x / w * 7) * h * 0.08 + Math.sin(x / w * 17) * h * 0.03;
    const m2 = h * 0.78 + Math.sin(x / w * 5 + 1) * h * 0.06;
    if (y > m1) { r = 92; g = 70; b = 96; }
    if (y > m2) { r = 52; g = 44; b = 66; }
    return [Math.round(r), Math.round(g), Math.round(b)];
  };
  return makePng(w, h, px, [textChunk('prompt', asciiJson(samplePrompt())), textChunk('workflow', asciiJson(sampleWorkflow()))]);
}
