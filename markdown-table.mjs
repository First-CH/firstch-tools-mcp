// Markdown テーブル整形・CSV/TSV 変換（tools.first-ch.com/markdown-table/ と同一ロジック）
//
// 「変換コア」ブロックは site 側の site/markdown-table/app.js と同一の実装。
// 2箇所ルール: 片方を直したらもう片方も同じ内容で直す（site側が正本）。
// 使っているのは String/RegExp/Array だけなので、ブラウザ版のコードをそのまま持ってこられる。
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

/* ==================== ここから変換コア（site / MCP で同一） ==================== */

export const MT_IN_FORMATS = ['auto', 'tsv', 'csv', 'ssv', 'markdown'];
export const MT_OUT_FORMATS = ['markdown', 'csv', 'tsv', 'ssv', 'html', 'json'];
export const MT_ALIGNS = ['none', 'left', 'center', 'right'];
export const MT_HEADER_MODES = ['first', 'none', 'auto'];
export const MT_DELIMS = { tsv: '\t', csv: ',', ssv: ';', markdown: '|' };
const MT_MIN_DASH = 3;        // 区切り行のハイフンの最小本数
const MT_DETECT_LINES = 50;   // 区切り文字の自動判定に見る行数

// 見た目の桁を2つ使う文字（East Asian Wide / Fullwidth）。等幅フォントでの桁揃えに使う
const MT_WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60],
  [0xffe0, 0xffe6], [0x1b000, 0x1b001], [0x1f200, 0x1f251], [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];

// 数値とみなす書き方（桁区切り・通貨記号・単位まで含めて右寄せの判定に使う）
const MT_NUM_RE = /^[+-]?[¥$€£]?\s*(\d+|\d{1,3}(,\d{3})+)(\.\d+)?\s*(%|％|円|px|pt|em|rem|kg|g|km|m)?$/;

/** その符号位置が占める桁数（結合文字と異体字セレクタは0桁） */
function mtCharWidth(cp) {
  if (cp === 0x200b || cp === 0xfeff || cp === 0xfe0f || cp === 0xfe0e) return 0;
  if (cp >= 0x0300 && cp <= 0x036f) return 0;
  if (cp >= 0x200c && cp <= 0x200f) return 0;
  for (const r of MT_WIDE_RANGES) {
    if (cp >= r[0] && cp <= r[1]) return 2;
  }
  return 1;
}

/**
 * 文字列の表示幅。eastAsian が真なら全角を2桁で数える。
 * 偽のときは符号位置の数（サロゲートペアを2つと数えない）。
 */
export function mtWidth(s, eastAsian) {
  const str = String(s === undefined || s === null ? '' : s);
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    w += eastAsian ? mtCharWidth(cp) : (mtCharWidth(cp) === 0 ? 0 : 1);
  }
  return w;
}

/** 改行コードをLFへ揃え、先頭のBOMを落とす */
function mtNormalizeEol(text) {
  return String(text === undefined || text === null ? '' : text).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
}

/**
 * 区切り文字で1つの表に読む（RFC 4180 の引用符に対応）。
 * "" は " 1文字、引用符の中の区切り文字・改行はセルの一部として扱う。
 */
export function mtParseDelimited(text, delim) {
  const s = mtNormalizeEol(text);
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  let sawQuote = false;
  let unterminated = false;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"') {
        if (s[i + 1] === '"') { cell += '"'; i += 1; continue; }
        quoted = false;
        continue;
      }
      cell += ch;
      continue;
    }
    if (ch === '"' && cell === '') { quoted = true; sawQuote = true; continue; }
    if (ch === delim) { row.push(cell); cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    cell += ch;
  }
  if (quoted) unterminated = true;
  row.push(cell);
  rows.push(row);
  // 末尾の空行（最後の改行の後ろ）は表の行として数えない
  while (rows.length > 1 && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return { rows, quoted: sawQuote, unterminated };
}

/** 区切り行（|---|:--:| など）か */
export function mtIsSeparatorRow(line) {
  const t = String(line).trim();
  if (!t || t.indexOf('-') === -1) return false;
  return /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(t);
}

/** Markdownの1行をセルへ分ける（\| はセルの中の | として扱う） */
export function mtSplitMarkdownRow(line) {
  let t = String(line).trim();
  if (t.startsWith('|')) t = t.slice(1);
  if (t.endsWith('|') && !t.endsWith('\\|')) t = t.slice(0, -1);
  const cells = [];
  let cur = '';
  for (let i = 0; i < t.length; i += 1) {
    const ch = t[i];
    if (ch === '\\' && t[i + 1] === '|') { cur += '|'; i += 1; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells.map((c) => c.trim());
}

/** セル内の <br> を改行へ戻す（Markdown→CSV で1セル1行に復元するため） */
function mtUnbr(s) {
  return String(s).replace(/<br\s*\/?>/gi, '\n');
}

/** Markdownの表を読む。区切り行のコロンから列ごとの配置も取る */
export function mtParseMarkdown(text) {
  const lines = mtNormalizeEol(text).split('\n');
  const rows = [];
  let aligns = null;
  let sepAt = -1;
  for (const line of lines) {
    if (line.trim() === '') continue;
    if (aligns === null && rows.length > 0 && mtIsSeparatorRow(line)) {
      aligns = mtSplitMarkdownRow(line).map((c) => {
        const left = c.startsWith(':');
        const right = c.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        if (left) return 'left';
        return 'none';
      });
      sepAt = rows.length;
      continue;
    }
    if (line.indexOf('|') === -1) continue; // 表の外の行（見出しや本文）は捨てる
    rows.push(mtSplitMarkdownRow(line).map(mtUnbr));
  }
  return { rows, aligns, separatorAt: sepAt };
}

/** 1行を区切り文字で割ったときの列数 */
function mtFieldCount(line, delim) {
  return mtParseDelimited(line, delim).rows[0].length;
}

/**
 * 入力の形式を当てる。
 * 区切り行のあるパイプ表ならMarkdown、それ以外はタブ→カンマ→セミコロンの順に
 * 「同じ列数の行がいちばん揃うもの」を採る。
 */
export function mtDetect(text) {
  const s = mtNormalizeEol(text);
  const lines = s.split('\n').filter((l) => l.trim() !== '');
  if (!lines.length) return { format: 'tsv', delimiter: '\t', columns: 0, confident: false };
  const piped = lines.filter((l) => l.indexOf('|') !== -1).length;
  if (piped >= 2 && lines.some(mtIsSeparatorRow)) {
    return { format: 'markdown', delimiter: '|', columns: 0, confident: true };
  }
  const head = lines.slice(0, MT_DETECT_LINES);
  let best = null;
  for (const format of ['tsv', 'csv', 'ssv']) {
    const delim = MT_DELIMS[format];
    const counts = head.map((l) => mtFieldCount(l, delim));
    const freq = new Map();
    for (const c of counts) freq.set(c, (freq.get(c) || 0) + 1);
    let columns = 1;
    let hits = 0;
    for (const [c, n] of freq) {
      if (n > hits || (n === hits && c > columns)) { columns = c; hits = n; }
    }
    if (columns < 2) continue;
    const score = hits / counts.length;
    if (!best || score > best.score + 1e-9 || (Math.abs(score - best.score) < 1e-9 && columns > best.columns)) {
      best = { format, delimiter: delim, columns, score, confident: true };
    }
  }
  // 区切りが見つからないときは1列のTSVとして扱う（貼り直しの手掛かりは呼び出し側で出す）
  return best || { format: 'tsv', delimiter: '\t', columns: 1, confident: false };
}

/**
 * 入力を2次元配列へ。format='auto' なら自動判定する。
 * 返り値の source には判定結果（形式・区切り文字）が入る。
 */
export function mtParse(text, format) {
  const want = MT_IN_FORMATS.indexOf(format) === -1 ? 'auto' : format;
  const detected = mtDetect(text);
  const use = want === 'auto' ? detected.format : want;
  if (use === 'markdown') {
    const md = mtParseMarkdown(text);
    return {
      rows: md.rows,
      aligns: md.aligns,
      source: { format: 'markdown', delimiter: '|', detected: want === 'auto', quoted: false, unterminated: false },
      separatorAt: md.separatorAt,
    };
  }
  const r = mtParseDelimited(text, MT_DELIMS[use]);
  return {
    rows: r.rows,
    aligns: null,
    source: { format: use, delimiter: MT_DELIMS[use], detected: want === 'auto', quoted: r.quoted, unterminated: r.unterminated },
    separatorAt: -1,
  };
}

/** 行と列を入れ替える */
export function mtTranspose(rows) {
  const cols = rows.reduce((m, r) => Math.max(m, r.length), 0);
  const out = [];
  for (let c = 0; c < cols; c += 1) {
    const row = [];
    for (let r = 0; r < rows.length; r += 1) row.push(rows[r][c] === undefined ? '' : rows[r][c]);
    out.push(row);
  }
  return out;
}

/**
 * 表を長方形に整える（空行を捨て、短い行に空セルを足し、必要なら転置する）。
 * ragged には列数が足りずに補った行の数が入る。
 */
export function mtNormalize(rows, opts) {
  const o = opts || {};
  let out = rows.map((r) => r.map((c) => {
    const s = mtNormalizeEol(c);
    return o.trim === false ? s : s.trim();
  }));
  if (o.skipEmpty !== false) out = out.filter((r) => r.some((c) => c !== ''));
  const cols0 = out.reduce((m, r) => Math.max(m, r.length), 0);
  let ragged = 0;
  out = out.map((r) => {
    if (r.length >= cols0) return r;
    ragged += 1;
    return r.concat(new Array(cols0 - r.length).fill(''));
  });
  if (o.transpose) out = mtTranspose(out);
  const columns = out.reduce((m, r) => Math.max(m, r.length), 0);
  return { rows: out, columns, ragged };
}

/** 数値だけが並ぶ列か（右寄せの自動判定に使う） */
export function mtIsNumeric(s) {
  const t = String(s).trim();
  return t !== '' && MT_NUM_RE.test(t);
}

/**
 * 列ごとの配置を決める。指定のない（'none'）列だけ、数値列なら右寄せへ倒す。
 * body には見出しを除いた行を渡す。
 */
export function mtAutoAligns(body, aligns, autoNumber) {
  const out = aligns.slice();
  if (!autoNumber) return out;
  for (let c = 0; c < out.length; c += 1) {
    if (out[c] !== 'none') continue;
    let seen = 0;
    let ok = true;
    for (const row of body) {
      const v = row[c] === undefined ? '' : row[c];
      if (v === '') continue;
      seen += 1;
      if (!mtIsNumeric(v)) { ok = false; break; }
    }
    if (ok && seen > 0) out[c] = 'right';
  }
  return out;
}

/** Markdownのセルとして安全な1行の文字列にする */
function mtEscapeCell(s, opts) {
  const o = opts || {};
  let t = mtNormalizeEol(s);
  if (o.escapePipes !== false) t = t.replace(/\|/g, '\\|');
  t = t.replace(/\n/g, o.multiline === 'space' ? ' ' : '<br>');
  return t;
}

/** 表示幅 w まで、配置に合わせて空白を足す */
function mtPad(text, w, align, eastAsian) {
  const pad = w - mtWidth(text, eastAsian);
  if (pad <= 0) return text;
  if (align === 'right') return ' '.repeat(pad) + text;
  if (align === 'center') {
    const l = Math.floor(pad / 2);
    return ' '.repeat(l) + text + ' '.repeat(pad - l);
  }
  return text + ' '.repeat(pad);
}

/** 区切り行の1セル（幅 w・配置 align）。w<=0 なら桁を揃えない短い形 */
function mtSeparatorCell(w, align) {
  if (w <= 0) {
    if (align === 'center') return ':' + '-'.repeat(MT_MIN_DASH) + ':';
    if (align === 'right') return '-'.repeat(MT_MIN_DASH) + ':';
    if (align === 'left') return ':' + '-'.repeat(MT_MIN_DASH);
    return '-'.repeat(MT_MIN_DASH);
  }
  const width = Math.max(w, MT_MIN_DASH);
  if (align === 'center') return ':' + '-'.repeat(width - 2) + ':';
  if (align === 'right') return '-'.repeat(width - 1) + ':';
  if (align === 'left') return ':' + '-'.repeat(width - 1);
  return '-'.repeat(width);
}

/**
 * Markdownの表を組み立てる。
 * header は見出し行（配列）、body は残りの行。pad=true で桁を揃える。
 */
export function mtBuildMarkdown(header, body, aligns, opts) {
  const o = opts || {};
  const eastAsian = o.eastAsian !== false;
  const cols = aligns.length;
  const esc = (row) => {
    const r = [];
    for (let c = 0; c < cols; c += 1) r.push(mtEscapeCell(row[c] === undefined ? '' : row[c], o));
    return r;
  };
  const head = esc(header);
  const rows = body.map(esc);
  const widths = [];
  for (let c = 0; c < cols; c += 1) {
    if (!o.pad) { widths.push(0); continue; }
    let w = MT_MIN_DASH;
    w = Math.max(w, mtWidth(head[c], eastAsian));
    for (const r of rows) w = Math.max(w, mtWidth(r[c], eastAsian));
    // コロンを2つ置く中央揃えは3桁だと線が1本になるので下限を上げる
    if (aligns[c] === 'center') w = Math.max(w, MT_MIN_DASH + 2);
    widths.push(w);
  }
  const line = (cells) => '| ' + cells.join(' | ') + ' |';
  const out = [];
  out.push(line(head.map((c, i) => (o.pad ? mtPad(c, widths[i], aligns[i], eastAsian) : c))));
  out.push(line(aligns.map((a, i) => mtSeparatorCell(widths[i], a))));
  for (const r of rows) {
    out.push(line(r.map((c, i) => (o.pad ? mtPad(c, widths[i], aligns[i], eastAsian) : c))));
  }
  return out.join('\n') + '\n';
}

/** 区切り文字・引用符・改行を含むセルを引用符で囲む（RFC 4180） */
export function mtQuote(v, delim) {
  const s = String(v === undefined || v === null ? '' : v);
  if (s === '') return s;
  if (s.indexOf(delim) !== -1 || s.indexOf('"') !== -1 || /[\n\r]/.test(s) || /^\s|\s$/.test(s)) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

/** CSV / TSV / セミコロン区切りを組み立てる */
export function mtBuildDelimited(rows, delim, eol) {
  const nl = eol === 'crlf' ? '\r\n' : '\n';
  return rows.map((r) => r.map((c) => mtQuote(c, delim)).join(delim)).join(nl) + nl;
}

/** HTMLの特殊文字を実体参照へ */
function mtEscapeHtml(s) {
  return String(s === undefined || s === null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** <table> を組み立てる（見出しが空の配列なら thead を出さない） */
export function mtBuildHtml(header, body, aligns, opts) {
  const o = opts || {};
  const cell = (tag, v, align) => {
    const style = align && align !== 'none' ? ` style="text-align:${align}"` : '';
    const text = mtEscapeHtml(v).replace(/\n/g, '<br>');
    return `      <${tag}${style}>${text}</${tag}>`;
  };
  const out = ['<table>'];
  if (header && header.length) {
    out.push('  <thead>', '    <tr>');
    for (let c = 0; c < aligns.length; c += 1) out.push(cell('th', header[c], aligns[c]));
    out.push('    </tr>', '  </thead>');
  }
  out.push('  <tbody>');
  for (const row of body) {
    out.push('    <tr>');
    for (let c = 0; c < aligns.length; c += 1) out.push(cell('td', row[c], aligns[c]));
    out.push('    </tr>');
  }
  out.push('  </tbody>', '</table>');
  return out.join('\n') + (o.eol === 'crlf' ? '\r\n' : '\n');
}

/** JSON（見出しがあればオブジェクトの配列・無ければ配列の配列） */
export function mtBuildJson(header, body, useHeader) {
  if (!useHeader) return JSON.stringify(body, null, 2) + '\n';
  const keys = [];
  const seen = new Map();
  for (let c = 0; c < header.length; c += 1) {
    let k = String(header[c] === undefined ? '' : header[c]).trim() || 'col' + (c + 1);
    if (seen.has(k)) {
      const n = seen.get(k) + 1;
      seen.set(k, n);
      k = k + '_' + n;
    } else {
      seen.set(k, 1);
    }
    keys.push(k);
  }
  const out = body.map((row) => {
    const o = {};
    for (let c = 0; c < keys.length; c += 1) o[keys[c]] = row[c] === undefined ? '' : row[c];
    return o;
  });
  return JSON.stringify(out, null, 2) + '\n';
}

/* ==================== ここまで変換コア ==================== */

export class MarkdownTableError extends Error {}

// 指摘の文面（site側は同じ code を日英の T テーブルで出し分けている）
const NOTE_TEXT = {
  DETECTED: (p) => `${p.format}として読みました（1行あたり ${p.columns} 列）。`,
  NO_DELIMITER: () => 'タブ・カンマ・セミコロンのいずれも見つからず、1行が1セルになりました。別の区切り文字なら from で指定してください。',
  RAGGED: (p) => `セルの数が足りない行が ${p.count} 行ありました。いちばん長い行に合わせて ${p.columns} 列になるよう空セルを補いました。`,
  QUOTED: () => '引用符で囲まれたセルを外して読みました（"" は " 1文字として扱っています）。',
  UNTERMINATED: () => '引用符が閉じられていません。以降をすべて1つのセルとして読みました（元データに余分な " が無いか確かめてください）。',
  NO_HEADER_MD: () => '元のMarkdownに区切り行（|---|）が無かったので、1行目を見出しとして読みました。',
  PIPES: (p) => `セルの中の「|」を ${p.count} 個エスケープしました（\\| ＝表が壊れないようにするため）。`,
  NEWLINES: (p) => `セルの中の改行を ${p.count} 個 ${p.how} に置き換えました。Markdownの表はセル内に生の改行を書けません。`,
  WIDE: () => '全角文字を2桁として数えて桁を揃えました。等幅フォントでは縦線が揃います（プロポーショナルフォントでは揃いません）。',
  WIDE_OFF: () => '全角文字がありますが1桁として数えています。等幅フォントでは縦線が揃わないので eastAsian=true を指定してください。',
  NUMERIC: (p) => `数値だけが並ぶ列を ${p.count} 列見つけたので右寄せ（---:）にしました。`,
  HTML_IN_CELL: (p) => `HTMLタグを含むセルが ${p.count} 個あります。GFMではタグとして解釈されます。`,
  EMPTY_HEADER: (p) => `見出しのセルが ${p.count} 個空です。GFMの表は見出し行を省けないため、空のまま残しています。`,
  DUP_HEADER: (p) => `見出しが重複しています: ${p.items.join(' / ')}。表としては成立しますが、後から列を指す手がかりが無くなります。`,
  ONE_ROW: () => '行が1つしかないため、見出しだけの表になりました。',
};

const mtNote = (code, params) => ({ code, message: NOTE_TEXT[code] ? NOTE_TEXT[code](params || {}) : code });

const FORMAT_TEXT = {
  tsv: 'TSV（タブ区切り）',
  csv: 'CSV（カンマ区切り）',
  ssv: 'セミコロン区切り',
  markdown: 'Markdownの表',
};

/**
 * TSV / CSV / Markdown の表を読み取り、Markdown・CSV・TSV・HTML・JSON へ変換する。
 *
 * @param {object} opts
 * @param {string} [opts.text]        対象テキスト（path と排他）
 * @param {string} [opts.path]        対象ファイルの絶対パス（UTF-8として読む）
 * @param {string} [opts.outputPath]  結果を書き出す絶対パス（指定すると text は返さない）
 * @param {'auto'|'tsv'|'csv'|'ssv'|'markdown'} [opts.from='auto'] 入力の形式
 * @param {'markdown'|'csv'|'tsv'|'ssv'|'html'|'json'} [opts.to='markdown'] 出力の形式
 * @param {'first'|'auto'|'none'} [opts.header='first'] 1行目の扱い
 * @param {'auto'|'none'|'left'|'center'|'right'} [opts.align='auto'] 全列の配置
 * @param {string[]} [opts.aligns]    列ごとの配置（align より優先）
 * @param {boolean} [opts.pad=true]   桁を揃えるか（Markdown出力のみ）
 * @param {boolean} [opts.eastAsian=true] 全角を2桁として数えるか
 * @param {boolean} [opts.autoNumber=true] 数値だけの列を右寄せにするか
 * @param {boolean} [opts.trim=true]  セルの前後の空白を削るか
 * @param {boolean} [opts.skipEmpty=true] 空行を飛ばすか
 * @param {boolean} [opts.transpose=false] 行と列を入れ替えるか
 * @param {'br'|'space'} [opts.multiline='br'] セル内の改行の書き方
 * @param {'lf'|'crlf'} [opts.eol='lf'] 出力の改行コード
 */
export async function markdownTable(opts = {}) {
  const hasText = typeof opts.text === 'string';
  if (hasText === Boolean(opts.path)) throw new MarkdownTableError('text か path のどちらか一方を渡してください');

  const from = opts.from === undefined || opts.from === null ? 'auto' : String(opts.from);
  if (MT_IN_FORMATS.indexOf(from) === -1) throw new MarkdownTableError(`from は ${MT_IN_FORMATS.join(' / ')} のいずれか: ${opts.from}`);
  const to = opts.to === undefined || opts.to === null ? 'markdown' : String(opts.to);
  if (MT_OUT_FORMATS.indexOf(to) === -1) throw new MarkdownTableError(`to は ${MT_OUT_FORMATS.join(' / ')} のいずれか: ${opts.to}`);
  const headerMode = opts.header === undefined || opts.header === null ? 'first' : String(opts.header);
  if (MT_HEADER_MODES.indexOf(headerMode) === -1) throw new MarkdownTableError(`header は ${MT_HEADER_MODES.join(' / ')} のいずれか: ${opts.header}`);
  const align = opts.align === undefined || opts.align === null ? 'auto' : String(opts.align);
  if (MT_ALIGNS.concat(['auto']).indexOf(align) === -1) throw new MarkdownTableError(`align は auto / ${MT_ALIGNS.join(' / ')} のいずれか: ${opts.align}`);
  if (opts.aligns !== undefined && !Array.isArray(opts.aligns)) throw new MarkdownTableError('aligns は配置の配列で渡してください');
  if (Array.isArray(opts.aligns)) {
    for (const a of opts.aligns) {
      if (a !== '' && a !== null && a !== undefined && MT_ALIGNS.indexOf(String(a)) === -1) {
        throw new MarkdownTableError(`aligns の要素は ${MT_ALIGNS.join(' / ')} のいずれか: ${a}`);
      }
    }
  }

  const input = hasText ? opts.text : await readFile(opts.path, 'utf8');
  const pad = opts.pad !== false;
  const eastAsian = opts.eastAsian !== false;
  const autoNumber = opts.autoNumber !== false;
  const multiline = opts.multiline === 'space' ? 'space' : 'br';
  const eol = opts.eol === 'crlf' ? 'crlf' : 'lf';

  const parsed = mtParse(input, from);
  const norm = mtNormalize(parsed.rows, {
    trim: opts.trim !== false,
    skipEmpty: opts.skipEmpty !== false,
    transpose: opts.transpose === true,
  });
  const rows = norm.rows;
  const columns = norm.columns;
  if (!rows.length || columns === 0) throw new MarkdownTableError('表として読める行がありませんでした（入力が空です）');

  const useHeader = headerMode !== 'none';
  let header;
  let body;
  if (headerMode === 'first') {
    header = rows[0];
    body = rows.slice(1);
  } else if (headerMode === 'auto') {
    header = [];
    for (let c = 0; c < columns; c += 1) header.push('col' + (c + 1));
    body = rows;
  } else {
    header = new Array(columns).fill('');
    body = rows;
  }

  // 配置: 元のMarkdownの指定 → align → aligns（列ごと）→ 数値列の自動右寄せ
  let aligns = new Array(columns).fill(align === 'auto' ? 'none' : align);
  if (align === 'auto' && parsed.aligns && opts.transpose !== true) {
    for (let c = 0; c < columns; c += 1) {
      if (parsed.aligns[c]) aligns[c] = parsed.aligns[c];
    }
  }
  const beforeAuto = aligns.slice();
  aligns = mtAutoAligns(body, aligns, autoNumber);
  let numericCols = 0;
  for (let c = 0; c < columns; c += 1) if (aligns[c] !== beforeAuto[c]) numericCols += 1;
  if (Array.isArray(opts.aligns)) {
    for (let c = 0; c < columns; c += 1) {
      const a = opts.aligns[c];
      if (a) aligns[c] = String(a);
    }
  }

  const buildOpts = { pad, eastAsian, multiline, escapePipes: true };
  let text = '';
  if (to === 'markdown') {
    text = mtBuildMarkdown(header, body, aligns, buildOpts);
  } else if (to === 'html') {
    text = mtBuildHtml(useHeader ? header : null, body, aligns, {});
  } else if (to === 'json') {
    text = mtBuildJson(header, body, useHeader);
  } else {
    // 区切り形式はセル内の改行を引用符の中にそのまま持つので、改行コードは組み立て側で決める
    const all = useHeader ? [header].concat(body) : body;
    text = mtBuildDelimited(all, MT_DELIMS[to], eol);
  }
  // Markdown / HTML / JSON はセル内に生の改行を残さないため、まとめて置換して構わない
  if (eol === 'crlf' && to !== 'csv' && to !== 'tsv' && to !== 'ssv') text = text.replace(/\n/g, '\r\n');

  /* ---- 指摘 ---- */
  const notes = [];
  if (parsed.source.detected) {
    if (parsed.source.format !== 'markdown' && columns === 1 && opts.transpose !== true) {
      notes.push(mtNote('NO_DELIMITER'));
    } else {
      notes.push(mtNote('DETECTED', { format: FORMAT_TEXT[parsed.source.format], columns }));
    }
  }
  if (parsed.source.unterminated) notes.push(mtNote('UNTERMINATED'));
  if (parsed.source.quoted) notes.push(mtNote('QUOTED'));
  if (parsed.source.format === 'markdown' && parsed.separatorAt === -1) notes.push(mtNote('NO_HEADER_MD'));
  if (norm.ragged) notes.push(mtNote('RAGGED', { count: norm.ragged, columns }));

  let pipes = 0;
  let breaks = 0;
  let wide = false;
  let htmlCells = 0;
  for (const row of rows) {
    for (const cell of row) {
      if (cell.indexOf('|') !== -1) pipes += 1;
      if (cell.indexOf('\n') !== -1) breaks += 1;
      if (!wide && mtWidth(cell, true) !== mtWidth(cell, false)) wide = true;
      if (/<[a-z][^>]*>/i.test(cell)) htmlCells += 1;
    }
  }
  if (to === 'markdown') {
    if (pipes) notes.push(mtNote('PIPES', { count: pipes }));
    if (breaks) notes.push(mtNote('NEWLINES', { count: breaks, how: multiline === 'br' ? '<br>' : '半角スペース' }));
    if (numericCols) notes.push(mtNote('NUMERIC', { count: numericCols }));
    if (wide && pad) notes.push(mtNote(eastAsian ? 'WIDE' : 'WIDE_OFF'));
    if (htmlCells) notes.push(mtNote('HTML_IN_CELL', { count: htmlCells }));
  }
  if (headerMode === 'first') {
    const empties = header.filter((h) => String(h).trim() === '').length;
    if (empties) notes.push(mtNote('EMPTY_HEADER', { count: empties }));
    const seen = new Map();
    const dups = [];
    for (const h of header) {
      const k = String(h).trim();
      if (!k) continue;
      if (seen.has(k)) { if (dups.indexOf(k) === -1) dups.push(k); } else seen.set(k, 1);
    }
    if (dups.length) notes.push(mtNote('DUP_HEADER', { items: dups }));
    if (!body.length) notes.push(mtNote('ONE_ROW'));
  }

  const result = {
    format: to,
    source: Object.assign(
      hasText ? { type: 'text' } : { path: opts.path, name: basename(opts.path) },
      { format: parsed.source.format, delimiter: parsed.source.delimiter, detected: parsed.source.detected },
    ),
    text,
    rows: rows.length,
    columns,
    cells: rows.length * columns,
    body_rows: body.length,
    header: useHeader ? header : null,
    aligns,
    options: {
      header: headerMode,
      align,
      pad,
      east_asian: eastAsian,
      auto_number: autoNumber,
      transpose: opts.transpose === true,
      multiline,
      eol,
    },
    notes,
  };
  if (opts.outputPath) {
    await writeFile(opts.outputPath, text, 'utf8');
    result.output = opts.outputPath;
    // ファイルに書けたなら本文は重複した重い情報でしかない
    delete result.text;
  }
  return result;
}
