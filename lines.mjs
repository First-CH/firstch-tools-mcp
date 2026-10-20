/* テキスト行操作（lines_process）
 * 行操作コア（processLines / makeCompare / shuffle / PRESETS ほか）は
 * FirstCHTools の site/lines/app.js と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルからコアの開始/終了コメントに挟まれた範囲を sed で切り出し
 * （site側は字下げ2文字を落とす・こちらは行頭の export を落とす）、
 * diff が空になることで同期を機械的に確認できる。
 *
 * 適用順は固定: トリム → 空行 → 重複 → 並べ替え → 接頭/接尾辞 → 行番号（各1回）。
 * 並べ替えの照合は Intl.Collator('ja')（Node の ICU）。シャッフルは seed があれば再現可能な
 * 疑似乱数、無ければ crypto.getRandomValues。完全ローカル処理・ネットワーク送信なし。 */

import { readFile } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { writeOutput } from './fs-safe.mjs';

/* ==================== ここから行操作コア ==================== */

export const DEDUPE_MODES = ['first', 'unique', 'dupes'];
export const SORT_MODES = ['none', 'asc', 'desc', 'reverse', 'shuffle'];
export const SEPARATORS = { dot: '. ', paren: ') ', colon: ': ', bracket: ') ', tab: '\t', space: ' ' };

// 前後トリムで削る空白（半角・全角スペース・タブ・NBSPと欧文の各種スペース）。改行は含めない
export const SPACE_CLASS = ' \u0009　  -   ';
export const EDGE_RE = new RegExp('^[' + SPACE_CLASS + ']+|[' + SPACE_CLASS + ']+$', 'g');
export const BLANK_RE = new RegExp('^[' + SPACE_CLASS + ']*$');

// 「数値だけの行」。符号・桁区切りのカンマ・小数に対応し、全角数字は半角へ読み替えてから判定する
export const NUMBER_RE = /^[+\-−]?(?:\d{1,3}(?:,\d{3})+|\d+)?(?:\.\d+)?$/;

// 並べ替えの比較。数値の認識は数字の連なりを数として見る（item2 < item10）
export const COLLATOR_NUM = new Intl.Collator('ja', { numeric: true });
export const COLLATOR_TXT = new Intl.Collator('ja', { numeric: false });

// 改行コードは入力の最初の1つに揃える（CRLFのファイルを整形してもLFが混ざらない）
export function detectEol(text) {
  const m = text.match(/\r\n|\n|\r/);
  return m ? m[0] : '\n';
}

// 行へ分ける。末尾が改行で終わる入力の最後の空要素は行として数えない
export function splitLines(text) {
  if (text === '') return { lines: [], trailing: false };
  const lines = text.split(/\r\n|\n|\r/);
  const trailing = lines.length > 1 && lines[lines.length - 1] === '';
  if (trailing) lines.pop();
  return { lines, trailing };
}

export function toHalfDigits(s) {
  return s.replace(/[０-９．，－＋]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0));
}

// 数値として読める行なら数を返し、読めなければ null
export function asNumber(line) {
  const s = toHalfDigits(line.replace(EDGE_RE, ''));
  if (s === '' || !/\d/.test(s) || !NUMBER_RE.test(s)) return null;
  const n = Number(s.replace(/,/g, '').replace('−', '-'));
  return Number.isFinite(n) ? n : null;
}

export function makeCompare(numeric) {
  const coll = numeric ? COLLATOR_NUM : COLLATOR_TXT;
  return (a, b) => {
    if (numeric) {
      const na = asNumber(a);
      const nb = asNumber(b);
      // 数値どうしは値で比べる（-10 < -3 < 1.25 < 1.5）。数値の行は文字の行より前に置く
      if (na !== null && nb !== null && na !== nb) return na - nb;
      if (na !== null && nb === null) return -1;
      if (na === null && nb !== null) return 1;
    }
    const c = coll.compare(a, b);
    if (c) return c;
    // 照合順序で同順位になる字（あ/ア・a/A など）は文字コード順で決め、入力の順番に左右されないようにする
    return a < b ? -1 : a > b ? 1 : 0;
  };
}

// シード付きの疑似乱数（同じシードなら同じ並びになる。URLの seed で再現できる）。
// 32ビットの種から作れる並びは高々 2^32 通りなので、13行以上では全順列を出せない＝抽選には使わない
export function mulberry32(seed) {
  let t = seed >>> 0;
  return () => {
    t = (t + 0x6d2b79f5) >>> 0;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r = (r + Math.imul(r ^ (r >>> 7), 61 | r)) ^ r;
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

// 0 以上 n 未満の整数を返す関数を作る。seed があれば再現用の疑似乱数、無ければ
// words()（32ビットの乱数語を順に返す）から棄却法で偏りなく引く
export function makeRandInt(seed, words) {
  if (Number.isFinite(seed)) {
    const rand = mulberry32(seed);
    return (n) => Math.floor(rand() * n);
  }
  return (n) => {
    // 2^32 を n で割り切れる範囲だけを使う（余りの端数を捨てて剰余の偏りを消す）
    const limit = 4294967296 - (4294967296 % n);
    for (;;) {
      const w = words();
      if (w < limit) return w % n;
    }
  };
}

// Fisher–Yates。randInt が一様なら n! 通りの並びが等確率で出る
export function shuffle(lines, randInt) {
  const out = lines.slice();
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = randInt(i + 1);
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

// crypto.getRandomValues の乱数語を貯めておき、同じ順で読み直せる源。
// 他のチェックを切り替えても並びが変わらないよう、reset() するまで同じ語を返す
export function makeCryptoPool() {
  const pool = [];
  let pos = 0;
  const words = () => {
    if (pos >= pool.length) {
      const a = new Uint32Array(256);
      crypto.getRandomValues(a);
      for (let k = 0; k < a.length; k += 1) pool.push(a[k]);
    }
    return pool[pos++];
  };
  words.rewind = () => { pos = 0; };
  words.reset = () => { pool.length = 0; pos = 0; };
  return words;
}

// 「ほとんど同じ」行を探す。完全一致では別の行だが、キーを変えると重なる組の数を返す
export function nearGroups(lines, keyOf) {
  const exact = new Map();
  for (const line of lines) {
    const k = keyOf(line);
    if (!exact.has(k)) exact.set(k, new Set());
    exact.get(k).add(line);
  }
  let groups = 0;
  for (const set of exact.values()) if (set.size > 1) groups += 1;
  return groups;
}

/**
 * 行単位の操作をまとめて適用する。
 *
 * @param {object} opts
 * @param {string} opts.text 対象テキスト
 * @param {boolean} [opts.trim] 各行の前後の空白を削る
 * @param {boolean} [opts.removeBlank] 空行（空白だけの行を含む）を削る
 * @param {boolean} [opts.dedupe] 重複行を削る
 * @param {'first'|'unique'|'dupes'} [opts.dedupeMode='first'] 最初の1行を残す / 重複した行は1行も残さない / 重複した行だけを1行ずつ出す
 * @param {boolean} [opts.ignoreCase] 重複の判定で大文字・小文字を区別しない
 * @param {'none'|'asc'|'desc'|'reverse'|'shuffle'} [opts.sort='none']
 * @param {boolean} [opts.numeric=true] 並べ替えで数値を認識する
 * @param {number} [opts.seed] シャッフルのシード（再現用。指定すると抽選向けの一様性は失われる）
 * @param {function(): number} [opts.words] シャッフル用の32ビット乱数語の源（seed 未指定時。省略時は crypto.getRandomValues）
 * @param {boolean} [opts.affix] 接頭辞・接尾辞を付ける
 * @param {string} [opts.prefix] @param {string} [opts.suffix]
 * @param {boolean} [opts.number] 行番号を付ける
 * @param {number} [opts.start=1] 最初の番号
 * @param {string} [opts.sep='dot'] 番号の後ろの区切り（SEPARATORS のキー）
 * @param {boolean} [opts.pad] 番号の桁をゼロで揃える
 */
export function processLines(opts) {
  const o = opts || {};
  const input = typeof o.text === 'string' ? o.text : '';
  const eol = detectEol(input);
  const split = splitLines(input);
  let lines = split.lines;
  const stats = { lines_in: lines.length, trimmed: 0, blank_removed: 0, dup_removed: 0 };
  const notes = [];

  // ① 前後トリム
  if (o.trim) {
    lines = lines.map((line) => {
      const t = line.replace(EDGE_RE, '');
      if (t !== line) stats.trimmed += 1;
      return t;
    });
  }

  // ② 空行
  if (o.removeBlank) {
    const kept = lines.filter((line) => !BLANK_RE.test(line));
    stats.blank_removed = lines.length - kept.length;
    lines = kept;
  }

  // ③ 重複。数え上げは設定にかかわらず行い、どの行が何回出てきたかを返す
  const keyOf = o.ignoreCase ? (s) => s.toLowerCase() : (s) => s;
  const counts = new Map();
  const firstSeen = new Map();
  for (const line of lines) {
    const k = keyOf(line);
    counts.set(k, (counts.get(k) || 0) + 1);
    if (!firstSeen.has(k)) firstSeen.set(k, line);
  }
  const duplicates = [];
  for (const [k, n] of counts) if (n > 1) duplicates.push({ line: firstSeen.get(k), count: n });
  duplicates.sort((a, b) => b.count - a.count);

  if (o.dedupe) {
    const mode = DEDUPE_MODES.indexOf(o.dedupeMode) !== -1 ? o.dedupeMode : 'first';
    const seen = new Set();
    const kept = [];
    for (const line of lines) {
      const k = keyOf(line);
      const n = counts.get(k);
      if (mode === 'unique') {
        if (n === 1) kept.push(line);
      } else if (!seen.has(k)) {
        seen.add(k);
        if (mode === 'first' || n > 1) kept.push(line);
      }
    }
    stats.dup_removed = lines.length - kept.length;
    lines = kept;
  }

  // 完全一致では別の行だが、設定を変えると重複になる組を知らせる（消したつもりで残る事故の手がかり）
  if (lines.length > 1) {
    if (!o.trim) {
      const g = nearGroups(lines, (s) => keyOf(s.replace(EDGE_RE, '')));
      if (g) notes.push({ code: 'NEAR_SPACE', count: g });
    }
    if (!o.ignoreCase) {
      const g = nearGroups(lines, (s) => s.toLowerCase());
      if (g) notes.push({ code: 'NEAR_CASE', count: g });
    }
    const g = nearGroups(lines, (s) => keyOf(s.normalize('NFKC')));
    if (g) notes.push({ code: 'NEAR_WIDTH', count: g });
  }

  // ④ 並べ替え
  const sort = SORT_MODES.indexOf(o.sort) !== -1 ? o.sort : 'none';
  if (sort === 'asc' || sort === 'desc') {
    const cmp = makeCompare(o.numeric !== false);
    lines = lines.slice().sort(sort === 'asc' ? cmp : (a, b) => cmp(b, a));
  } else if (sort === 'reverse') {
    lines = lines.slice().reverse();
  } else if (sort === 'shuffle') {
    let words = o.words;
    if (!Number.isFinite(o.seed) && typeof words !== 'function') {
      words = makeCryptoPool();
    }
    lines = shuffle(lines, makeRandInt(o.seed, words));
  }

  // ⑤ 接頭辞・接尾辞
  if (o.affix && (o.prefix || o.suffix)) {
    const pre = o.prefix || '';
    const suf = o.suffix || '';
    lines = lines.map((line) => pre + line + suf);
  }

  // ⑥ 行番号（接頭辞の外側に付ける）
  if (o.number && lines.length) {
    const start = Number.isFinite(o.start) ? Math.trunc(o.start) : 1;
    const sep = Object.prototype.hasOwnProperty.call(SEPARATORS, o.sep) ? o.sep : 'dot';
    const width = o.pad ? Math.max(String(start).length, String(start + lines.length - 1).length) : 0;
    lines = lines.map((line, i) => {
      const n = start + i;
      const digits = width && n >= 0 ? String(n).padStart(width, '0') : String(n);
      return (sep === 'bracket' ? '(' + digits : digits) + SEPARATORS[sep] + line;
    });
  }

  const text = lines.join(eol) + (split.trailing && lines.length ? eol : '');
  stats.lines_out = lines.length;
  if (!input) notes.unshift({ code: 'NOTHING' });
  return { text, stats, duplicates, notes, eol };
}

// プリセット（押すと触れていない項目も既定へ戻すので、必ず同じ結果になる）
export const PRESETS = {
  uniqsort: { trim: true, removeBlank: true, dedupe: true, sort: 'asc' },
  clean: { trim: true, removeBlank: true },
  numbered: { trim: true, removeBlank: true, number: true, sep: 'dot' },
  mdlist: { trim: true, removeBlank: true, affix: true, prefix: '- ' },
  shuffle: { trim: true, removeBlank: true, sort: 'shuffle' },
};

/* ==================== ここまで行操作コア ==================== */

/* ==================== ここからツールのラッパー（MCP のみ） ==================== */

export class LinesToolError extends Error {}

const MAX_DUPLICATES = 100;
const MAX_BYTES = 20 * 1024 * 1024;

// 指摘事項。site側の文言（T）と同じ内容で、画面の操作名を引数名に置き換えている
const NOTE_TEXT = {
  ja: {
    NOTHING: () => '処理する行がありません。1行に1項目ずつのテキストを渡してください。',
    DUPS: (n) => `2回以上出てくる行が ${n.kinds} 種類あります（余分な行は計 ${n.extra} 行）。duplicates に多い順に入っています。`,
    NEAR_SPACE: (n) => `前後の空白だけが違う行が ${n.count} 組あります。trim=true にすると重複として扱われます。`,
    NEAR_CASE: (n) => `大文字・小文字だけが違う行が ${n.count} 組あります。ignoreCase=true で重複として扱えます。`,
    NEAR_WIDTH: (n) => `全角・半角だけが違う行が ${n.count} 組あります（Ａ と A、ｶ と カ など）。先に zenkaku_convert で揃えてください。`,
    RANDOM: () => 'seed を渡していないので、暗号学的乱数で並べました（呼ぶたびに並びが変わります）。再現したいときは seed を渡してください。',
    SEEDED: () => 'seed から作る並びは高々 2^32 通りです。抽選など公平さが要る用途では seed を渡さないでください。',
  },
  en: {
    NOTHING: () => 'Nothing to process — pass text with one item per line.',
    DUPS: (n) => `${n.kinds} line(s) appear more than once (${n.extra} extra cop${n.extra === 1 ? 'y' : 'ies'} in total). They are listed in duplicates, most frequent first.`,
    NEAR_SPACE: (n) => `${n.count} group(s) of lines differ only in leading or trailing spaces. Pass trim=true and they will count as duplicates.`,
    NEAR_CASE: (n) => `${n.count} group(s) of lines differ only in upper / lower case. Pass ignoreCase=true to treat them as duplicates.`,
    NEAR_WIDTH: (n) => `${n.count} group(s) of lines differ only in full-width / half-width characters (Ａ vs A, ｶ vs カ). Normalise them with zenkaku_convert first.`,
    RANDOM: () => 'No seed was given, so the lines were shuffled with cryptographic randomness (the order changes on every call). Pass seed to reproduce an order.',
    SEEDED: () => 'A seed can produce at most 2^32 orders. Leave seed out when the shuffle must be fair (a draw, for example).',
  },
};

const EOL_NAMES = { '\n': 'LF', '\r\n': 'CRLF', '\r': 'CR' };

/**
 * 行の一覧を整える（重複削除・並べ替え・シャッフル・行番号・空行除去・トリム・接頭/接尾辞）。
 * preset を渡すと site のプリセットボタンと同じ設定から始め、個別の引数で上書きする。
 *
 * @param {object} opts
 * @param {string} [opts.text] 対象テキスト（path と排他）
 * @param {string} [opts.path] 対象ファイルの絶対パス（UTF-8）
 * @param {string} [opts.outputPath] 結果を書き出す絶対パス（指定すると本文は返さない）
 * @param {'uniqsort'|'clean'|'numbered'|'mdlist'|'shuffle'} [opts.preset]
 * 他の引数は processLines と同じ（affix は prefix/suffix を渡せば自動で有効）。
 * @param {'ja'|'en'} [opts.lang='ja']
 */
export async function linesProcessTool(opts = {}) {
  const lang = opts.lang || 'ja';
  if (lang !== 'ja' && lang !== 'en') throw new LinesToolError(`lang は ja か en: ${opts.lang}`);
  const hasText = opts.text !== undefined;
  if (hasText && opts.path !== undefined) throw new LinesToolError('text と path は同時に渡せません');
  if (!hasText && opts.path === undefined) throw new LinesToolError('text か path を渡してください');
  let text;
  if (hasText) {
    if (typeof opts.text !== 'string') throw new LinesToolError('text は文字列で渡してください');
    text = opts.text;
  } else {
    if (!isAbsolute(String(opts.path))) throw new LinesToolError('path は絶対パスで指定してください');
    const buf = await readFile(opts.path);
    if (buf.length > MAX_BYTES) throw new LinesToolError(`ファイルが大きすぎます（${MAX_BYTES / 1024 / 1024}MB まで）: ${buf.length} bytes`);
    text = buf.toString('utf8').replace(/^﻿/, '');
  }
  if (hasText && Buffer.byteLength(text) > MAX_BYTES) throw new LinesToolError(`text が大きすぎます（${MAX_BYTES / 1024 / 1024}MB まで）`);

  if (opts.preset !== undefined && !Object.prototype.hasOwnProperty.call(PRESETS, opts.preset)) {
    throw new LinesToolError(`preset は ${Object.keys(PRESETS).join(' / ')} のどれか: ${opts.preset}`);
  }
  if (opts.dedupeMode !== undefined && DEDUPE_MODES.indexOf(opts.dedupeMode) === -1) {
    throw new LinesToolError(`dedupeMode は ${DEDUPE_MODES.join(' / ')} のどれか: ${opts.dedupeMode}`);
  }
  if (opts.sort !== undefined && SORT_MODES.indexOf(opts.sort) === -1) {
    throw new LinesToolError(`sort は ${SORT_MODES.join(' / ')} のどれか: ${opts.sort}`);
  }
  if (opts.sep !== undefined && !Object.prototype.hasOwnProperty.call(SEPARATORS, opts.sep)) {
    throw new LinesToolError(`sep は ${Object.keys(SEPARATORS).join(' / ')} のどれか: ${opts.sep}`);
  }
  if (opts.seed !== undefined && !(Number.isInteger(opts.seed) && opts.seed >= 0 && opts.seed <= 4294967295)) {
    throw new LinesToolError(`seed は 0〜4294967295 の整数: ${opts.seed}`);
  }
  if (opts.start !== undefined && !(Number.isInteger(opts.start) && Math.abs(opts.start) <= 1e9)) {
    throw new LinesToolError(`start は整数（±10億まで）: ${opts.start}`);
  }

  // site のプリセットは押すと触れていない項目も既定へ戻す。その上に個別の引数を重ねる（URLパラメータと同じ順）
  const o = { ...(opts.preset ? PRESETS[opts.preset] : {}) };
  for (const k of ['trim', 'removeBlank', 'dedupe', 'dedupeMode', 'ignoreCase', 'sort', 'numeric', 'seed', 'number', 'start', 'sep', 'pad']) {
    if (opts[k] !== undefined) o[k] = opts[k];
  }
  if (opts.dedupeMode !== undefined && opts.dedupe === undefined) o.dedupe = true;
  if (opts.prefix !== undefined || opts.suffix !== undefined) {
    o.affix = true;
    o.prefix = opts.prefix === undefined ? '' : String(opts.prefix);
    o.suffix = opts.suffix === undefined ? '' : String(opts.suffix);
  }

  const r = processLines({ ...o, text });
  const notes = r.notes.slice();
  if (r.duplicates.length) {
    const extra = r.duplicates.reduce((s, d) => s + d.count - 1, 0);
    notes.splice(notes[0] && notes[0].code === 'NOTHING' ? 1 : 0, 0, { code: 'DUPS', kinds: r.duplicates.length, extra });
  }
  if (o.sort === 'shuffle') notes.push({ code: Number.isFinite(o.seed) ? 'SEEDED' : 'RANDOM' });

  const result = {
    source: hasText ? { type: 'text' } : { path: opts.path, name: basename(opts.path) },
    text: r.text,
    stats: r.stats,
    eol: EOL_NAMES[r.eol],
    duplicates: r.duplicates.slice(0, MAX_DUPLICATES),
    ...(r.duplicates.length > MAX_DUPLICATES ? { duplicates_total: r.duplicates.length } : {}),
    options: {
      trim: Boolean(o.trim),
      removeBlank: Boolean(o.removeBlank),
      dedupe: Boolean(o.dedupe),
      ...(o.dedupe ? { dedupeMode: o.dedupeMode || 'first' } : {}),
      ignoreCase: Boolean(o.ignoreCase),
      sort: o.sort || 'none',
      ...(o.sort === 'asc' || o.sort === 'desc' ? { numeric: o.numeric !== false } : {}),
      ...(o.sort === 'shuffle' && Number.isFinite(o.seed) ? { seed: o.seed } : {}),
      ...(o.affix ? { prefix: o.prefix || '', suffix: o.suffix || '' } : {}),
      number: Boolean(o.number),
      ...(o.number ? { start: Number.isFinite(o.start) ? o.start : 1, sep: o.sep || 'dot', pad: Boolean(o.pad) } : {}),
    },
    notes: notes.map((n) => ({ code: n.code, message: NOTE_TEXT[lang][n.code](n), ...(n.count !== undefined ? { count: n.count } : {}) })),
  };
  if (opts.outputPath) {
    if (!isAbsolute(opts.outputPath)) throw new LinesToolError('outputPath は絶対パスで指定してください');
    await writeOutput(opts.outputPath, r.text, { overwrite: opts.overwrite });
    result.output = opts.outputPath;
    delete result.text;
  }
  return result;
}
