/* CSV/TSV ⇄ JSON 相互変換（csv_convert）
 * 変換コア（csvParseDelimited / csvParseJson / csvToJson / csvFromJson / csvJsonConvert）は
 * FirstCHTools の site/csv-json/app.js と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルからコアの開始/終了コメントに挟まれた範囲を sed で切り出し
 * （site側は字下げ2文字を落とす・こちらは行頭の export を落とす）、
 * diff が空になることで同期を機械的に確認できる。
 *
 * 使っているのは String/RegExp/JSON だけなので、ブラウザ版のコードをそのまま持ってこられる。
 * 完全ローカル処理・ネットワーク送信なし。 */
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

/* ==================== ここから変換コア（site / MCP で同一） ==================== */

// 区切り文字の呼び名 ⇄ 実体
export const CSV_DELIMS = { comma: ',', tab: '\t', semicolon: ';', pipe: '|' };
export const CSV_DELIM_NAMES = { ',': 'comma', '\t': 'tab', ';': 'semicolon', '|': 'pipe' };

// 数値として読み替えてよい形。先頭の0（0123）や + 記号を弾くのは、
// 数値にすると表記が変わってしまう（電話番号・郵便番号・伝票番号が壊れる）ため。
export const CSV_NUM_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
// 数値に見えるが表記が保てないもの（先頭の0・+付き・桁あふれ）を見つけるための緩い形
export const CSV_NUMISH_RE = /^[+-]?\d[\d.eE+-]*$/;
// 表計算ソフトが数式として解釈しはじめる先頭文字（CSVインジェクション）
export const CSV_FORMULA_RE = /^[=+\-@\t\r]/;

/** 先頭20行を見て区切り文字を推定する。引用符の中は数に入れない */
export function csvDetectDelimiter(text) {
  const head = String(text).replace(/^﻿/, '').split(/\r\n|\n|\r/).slice(0, 20).join('\n');
  const bare = head.replace(/"(?:[^"]|"")*"/g, '');
  const lines = bare.split('\n').filter((l) => l !== '');
  if (!lines.length) return 'comma';
  let best = 'comma';
  let bestScore = 0;
  for (const name of Object.keys(CSV_DELIMS)) {
    const d = CSV_DELIMS[name];
    const counts = lines.map((l) => l.split(d).length - 1);
    if (!counts.length || counts[0] === 0) continue;
    // 「どの行でも同じ個数で並んでいるか」を重く見る（本文にたまたま混ざった記号を選ばない）
    const same = counts.filter((c) => c === counts[0]).length / counts.length;
    const score = counts[0] * (0.2 + same);
    if (score > bestScore) {
      bestScore = score;
      best = name;
    }
  }
  return best;
}

/**
 * 区切りテキストを行×セルへ割る（RFC 4180）。
 * 引用符の中の改行・区切り記号・"" によるエスケープを扱い、
 * 壊れた引用符は文字として読み進めたうえで指摘に残す。
 * @returns {{rows: string[][], quirks: {stray: number[], newlineInCell: number}, error: object|null}}
 */
export function csvParseDelimited(text, delim) {
  const src = String(text);
  const rows = [];
  const stray = [];
  let newlineInCell = 0;
  let row = [];
  let field = '';
  let i = 0;
  let line = 1;
  let col = 1;
  let quoted = false;
  let openLine = 1;
  let openCol = 1;
  let fieldStarted = false; // 引用符を開いてよいのは、そのセルの先頭にいるときだけ

  while (i < src.length) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 2; col += 2; continue; }
        quoted = false;
        i += 1;
        col += 1;
        continue;
      }
      if (ch === '\r' || ch === '\n') {
        // 引用符の中の改行はセルの中身。改行コードはLFへ揃える
        field += '\n';
        i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
        line += 1;
        col = 1;
        newlineInCell += 1;
        continue;
      }
      field += ch;
      i += 1;
      col += 1;
      continue;
    }
    if (ch === '"') {
      if (!fieldStarted) {
        quoted = true;
        fieldStarted = true;
        openLine = line;
        openCol = col;
        i += 1;
        col += 1;
        continue;
      }
      // セルの途中や閉じたあとに出た " は文字として扱う（Excelが書いた壊れた行を読めるように）
      if (stray.indexOf(line) === -1) stray.push(line);
      field += ch;
      i += 1;
      col += 1;
      continue;
    }
    if (ch === delim) {
      row.push(field);
      field = '';
      fieldStarted = false;
      i += 1;
      col += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
      fieldStarted = false;
      i += ch === '\r' && src[i + 1] === '\n' ? 2 : 1;
      line += 1;
      col = 1;
      continue;
    }
    field += ch;
    fieldStarted = true;
    i += 1;
    col += 1;
  }

  if (quoted) {
    return { rows: [], quirks: { stray, newlineInCell }, error: { code: 'UNCLOSED_QUOTE', line: openLine, col: openCol, span: 1 } };
  }
  row.push(field);
  rows.push(row);
  // 末尾の改行が作る空の行は落とす
  if (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop();
  return { rows, quirks: { stray, newlineInCell }, error: null };
}

/** 列名を経路へ割る。a.b → ['a','b']、a[0].b / a.0.b → ['a',0,'b'] */
export function csvParsePath(key) {
  const out = [];
  for (const seg of String(key).replace(/\[(\d+)\]/g, '.$1').split('.')) {
    if (seg === '') continue;
    out.push(/^\d+$/.test(seg) ? Number(seg) : seg);
  }
  return out.length ? out : [String(key)];
}

/** 経路に沿って値を置く。数字の区間は配列になる。置けなければ false を返す */
export function csvSetPath(target, path, value) {
  let node = target;
  for (let i = 0; i < path.length - 1; i += 1) {
    const seg = path[i];
    const nextIsIndex = typeof path[i + 1] === 'number';
    const cur = node[seg];
    if (cur === undefined || cur === null) {
      node[seg] = nextIsIndex ? [] : {};
    } else if (typeof cur !== 'object') {
      return false; // 同じ名前がスカラーで埋まっている（a と a.b が両方ある）
    }
    node = node[seg];
  }
  const last = path[path.length - 1];
  if (node[last] !== undefined && typeof node[last] === 'object' && node[last] !== null) return false;
  node[last] = value;
  return true;
}

/** セル1つを値へ読み替える。読み替えないときは文字列のまま */
export function csvInferValue(raw, opts) {
  const s = opts.trim ? raw.trim() : raw;
  if (s === '') return opts.emptyNull ? null : '';
  if (!opts.types) return s;
  const lower = s.toLowerCase();
  if (lower === 'true') return true;
  if (lower === 'false') return false;
  if (lower === 'null') return null;
  // 「数値にして文字列へ戻したとき元通りか」で判定する。
  // これだけで 0123・+1・1e999・9007199254740993 のような復元できない値を弾ける。
  if (CSV_NUM_RE.test(s)) {
    const num = Number(s);
    if (Number.isFinite(num) && String(num) === s) return num;
  }
  return s;
}

/** 値の入れ子の深さ */
export function csvDepth(value) {
  if (value === null || typeof value !== 'object') return 0;
  let max = 0;
  for (const key of Object.keys(value)) {
    const d = csvDepth(value[key]);
    if (d > max) max = d;
  }
  return max + 1;
}

/** JSONの値をCSVのセル1つへ平らにする。nest=true なら a.b / a.0 の列へ割る */
export function csvFlatten(value, prefix, out, nest, note) {
  if (value === null || value === undefined) {
    out.push([prefix, '']);
    return;
  }
  if (typeof value !== 'object') {
    out.push([prefix, typeof value === 'string' ? value : String(value)]);
    return;
  }
  const keys = Array.isArray(value) ? value.map((_, i) => i) : Object.keys(value);
  if (!nest || !keys.length) {
    // 展開しない指定・空の {} と [] は、意味を落とさないようJSONの文字列として1セルに入れる
    out.push([prefix, JSON.stringify(value)]);
    if (keys.length) note.stringified += 1;
    return;
  }
  if (Array.isArray(value)) note.arrays += 1;
  for (const key of keys) {
    csvFlatten(value[key], prefix === '' ? String(key) : prefix + '.' + key, out, nest, note);
  }
}

/** セルを区切りテキストの1項目へ書く（RFC 4180 の引用規則） */
export function csvQuoteCell(s, delim, quoteAll) {
  const need = quoteAll
    || s.indexOf(delim) !== -1
    || s.indexOf('"') !== -1
    || /[\r\n]/.test(s)
    || /^\s|\s$/.test(s);
  return need ? '"' + s.replace(/"/g, '""') + '"' : s;
}

/* ---- JSONの読み取り（行・桁つき。ブラウザ差のあるメッセージに頼らない） ---- */

export function csvJsonError(code, line, col, found) {
  return { code, line, col, span: 1, found: found === undefined ? '' : found };
}

/**
 * JSONを読む。仕様どおりの厳密な読み取りで、失敗したときは行と桁を返す。
 * @returns {{ok: true, value: *, duplicates: string[]}|{ok: false, error: object}}
 */
export function csvParseJson(text) {
  const src = String(text);
  let i = 0;
  let line = 1;
  let col = 1;
  const duplicates = [];

  const fail = (code, found) => {
    const err = csvJsonError(code, line, col, found);
    throw err;
  };
  const step = (n) => {
    for (let k = 0; k < n; k += 1) {
      if (src[i] === '\n') { line += 1; col = 1; } else { col += 1; }
      i += 1;
    }
  };
  const ws = () => {
    while (i < src.length && (src[i] === ' ' || src[i] === '\t' || src[i] === '\n' || src[i] === '\r')) step(1);
  };
  const readString = () => {
    step(1); // 開きの "
    let out = '';
    while (true) {
      if (i >= src.length) fail('UNEXPECTED_END');
      const ch = src[i];
      if (ch === '"') { step(1); return out; }
      if (ch === '\n' || ch === '\r') fail('NEWLINE_IN_STRING');
      if (ch === '\\') {
        const esc = src[i + 1];
        if (esc === undefined) fail('UNEXPECTED_END');
        if ('"\\/'.indexOf(esc) !== -1) { out += esc; step(2); continue; }
        if (esc === 'b') { out += '\b'; step(2); continue; }
        if (esc === 'f') { out += '\f'; step(2); continue; }
        if (esc === 'n') { out += '\n'; step(2); continue; }
        if (esc === 'r') { out += '\r'; step(2); continue; }
        if (esc === 't') { out += '\t'; step(2); continue; }
        if (esc === 'u') {
          const hex = src.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('BAD_ESCAPE', '\\u' + hex);
          out += String.fromCharCode(parseInt(hex, 16));
          step(6);
          continue;
        }
        fail('BAD_ESCAPE', '\\' + esc);
      }
      out += ch;
      step(1);
    }
  };
  const readValue = () => {
    ws();
    if (i >= src.length) fail('UNEXPECTED_END');
    const ch = src[i];
    if (ch === '{') {
      step(1);
      const obj = {};
      ws();
      if (src[i] === '}') { step(1); return obj; }
      while (true) {
        ws();
        if (src[i] !== '"') fail('EXPECTED_KEY', src[i]);
        const key = readString();
        if (Object.prototype.hasOwnProperty.call(obj, key) && duplicates.indexOf(key) === -1) duplicates.push(key);
        ws();
        if (src[i] !== ':') fail('EXPECTED_COLON', src[i]);
        step(1);
        obj[key] = readValue();
        ws();
        if (src[i] === ',') { step(1); continue; }
        if (src[i] === '}') { step(1); return obj; }
        fail(i >= src.length ? 'UNEXPECTED_END' : 'EXPECTED_COMMA', src[i]);
      }
    }
    if (ch === '[') {
      step(1);
      const arr = [];
      ws();
      if (src[i] === ']') { step(1); return arr; }
      while (true) {
        arr.push(readValue());
        ws();
        if (src[i] === ',') { step(1); continue; }
        if (src[i] === ']') { step(1); return arr; }
        fail(i >= src.length ? 'UNEXPECTED_END' : 'EXPECTED_COMMA', src[i]);
      }
    }
    if (ch === '"') return readString();
    if (src.startsWith('true', i)) { step(4); return true; }
    if (src.startsWith('false', i)) { step(5); return false; }
    if (src.startsWith('null', i)) { step(4); return null; }
    const num = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?/.exec(src.slice(i));
    if (num) {
      const value = Number(num[0]);
      step(num[0].length);
      return value;
    }
    fail('UNEXPECTED_CHAR', ch);
    return null;
  };

  try {
    const value = readValue();
    ws();
    if (i < src.length) fail('TRAILING_TEXT', src[i]);
    return { ok: true, value, duplicates };
  } catch (e) {
    if (e && e.code) return { ok: false, error: e };
    throw e;
  }
}

/** 1行1JSON（JSON Lines / NDJSON）として読めるか試す */
export function csvParseJsonLines(text) {
  const lines = String(text).split(/\r\n|\n|\r/).map((l) => l.trim()).filter((l) => l !== '');
  if (lines.length < 2 || !lines.every((l) => l.startsWith('{') || l.startsWith('['))) return null;
  const rows = [];
  for (const l of lines) {
    const r = csvParseJson(l);
    if (!r.ok) return null;
    rows.push(r.value);
  }
  return rows;
}

/** エラーの前後2行を抜き出す（画面で ^ を立てるため） */
export function csvExcerpt(text, error) {
  if (!error) return null;
  const lines = String(text).split(/\r\n|\n|\r/);
  const from = Math.max(1, error.line - 2);
  const to = Math.min(lines.length, error.line + 2);
  const rows = [];
  for (let n = from; n <= to; n += 1) rows.push({ line: n, text: lines[n - 1] || '', error: n === error.line });
  return { rows, col: error.col, span: error.span || 1 };
}

/* ---- 変換の本体 ---- */

/**
 * CSV/TSV → JSON
 * @param {string} text
 * @param {object} o delimiter/header/nest/types/trim/emptyNull/skipEmpty/indent
 */
export function csvToJson(text, o) {
  const notes = [];
  const raw = String(text);
  const hadBom = raw.charCodeAt(0) === 0xfeff;
  const body = hadBom ? raw.slice(1) : raw;
  if (hadBom) notes.push({ code: 'BOM', level: 'info' });
  if (/\r\n/.test(body)) notes.push({ code: 'CRLF', level: 'info' });

  const auto = !o.delimiter || o.delimiter === 'auto';
  const name = auto ? csvDetectDelimiter(body) : o.delimiter;
  const delim = CSV_DELIMS[name] || ',';
  if (auto) notes.push({ code: 'DELIM_AUTO', level: 'info', delimiter: name });

  const parsed = csvParseDelimited(body, delim);
  if (parsed.error) return { ok: false, error: parsed.error, notes, excerpt: csvExcerpt(body, parsed.error) };

  let rows = parsed.rows;
  if (o.skipEmpty !== false) rows = rows.filter((r) => r.some((c) => c.trim() !== ''));
  if (!rows.length) return { ok: true, empty: true, notes, delimiter: name };

  if (parsed.quirks.stray.length) {
    notes.push({ code: 'STRAY_QUOTE', level: 'warn', count: parsed.quirks.stray.length, lines: parsed.quirks.stray.slice(0, 6) });
  }
  if (parsed.quirks.newlineInCell) notes.push({ code: 'NEWLINE_IN_CELL', level: 'info', count: parsed.quirks.newlineInCell });

  const width = Math.max.apply(null, rows.map((r) => r.length));
  let headers = null;
  let dataRows = rows;
  if (o.header !== false) {
    headers = rows[0].map((h) => (o.trim === false ? h : h.trim()));
    dataRows = rows.slice(1);
    const seen = {};
    const dups = [];
    let blank = 0;
    headers = headers.map((h, idx) => {
      let key = h;
      if (key === '') {
        blank += 1;
        key = 'column' + (idx + 1);
      }
      if (Object.prototype.hasOwnProperty.call(seen, key)) {
        if (dups.indexOf(key) === -1) dups.push(key);
        seen[key] += 1;
        key = key + '_' + seen[key];
      } else {
        seen[key] = 1;
      }
      return key;
    });
    if (dups.length) notes.push({ code: 'DUP_HEADER', level: 'warn', count: dups.length, items: dups.slice(0, 6) });
    if (blank) notes.push({ code: 'EMPTY_HEADER', level: 'warn', count: blank });
    // 見出しが1行しか無い＝データが0件
    if (!dataRows.length) notes.push({ code: 'HEADER_ONLY', level: 'info' });
  } else {
    notes.push({ code: 'NO_HEADER', level: 'info' });
  }

  const ragged = [];
  const expect = headers ? headers.length : width;
  dataRows.forEach((r, idx) => {
    if (r.length !== expect) ragged.push(idx + (o.header !== false ? 2 : 1));
  });
  if (ragged.length) notes.push({ code: 'RAGGED', level: 'warn', count: ragged.length, lines: ragged.slice(0, 6), expect });

  let bigNumbers = 0;
  let keptText = 0;
  let formulas = 0;
  const conflicts = [];
  const out = [];

  for (const r of dataRows) {
    let obj;
    if (headers) {
      obj = {};
      for (let c = 0; c < headers.length; c += 1) {
        const cell = r[c] === undefined ? '' : r[c];
        if (CSV_FORMULA_RE.test(cell)) formulas += 1;
        if (o.types !== false && cell !== '' && CSV_NUM_RE.test(cell) && String(Number(cell)) !== cell) bigNumbers += 1;
        else if (o.types !== false && cell !== '' && !CSV_NUM_RE.test(cell) && CSV_NUMISH_RE.test(cell)) keptText += 1;
        const value = csvInferValue(cell, o);
        const nested = o.nest !== false && (headers[c].indexOf('.') !== -1 || /\[\d+\]/.test(headers[c]));
        if (nested) {
          if (!csvSetPath(obj, csvParsePath(headers[c]), value)) {
            if (conflicts.indexOf(headers[c]) === -1) conflicts.push(headers[c]);
            obj[headers[c]] = value;
          }
        } else {
          obj[headers[c]] = value;
        }
      }
    } else {
      obj = r.map((cell) => {
        if (CSV_FORMULA_RE.test(cell)) formulas += 1;
        return csvInferValue(cell, o);
      });
    }
    out.push(obj);
  }

  if (conflicts.length) notes.push({ code: 'NEST_CONFLICT', level: 'warn', count: conflicts.length, items: conflicts.slice(0, 6) });
  if (bigNumbers) notes.push({ code: 'BIG_NUMBER', level: 'warn', count: bigNumbers });
  if (keptText) notes.push({ code: 'KEPT_TEXT', level: 'info', count: keptText });
  if (formulas) notes.push({ code: 'FORMULA', level: 'warn', count: formulas });

  const indent = o.indent === 'tab' ? '\t' : Number(o.indent === undefined ? 2 : o.indent);
  const output = JSON.stringify(out, null, indent) + '\n';
  let depth = 0;
  for (const obj of out) {
    const d = csvDepth(obj);
    if (d > depth) depth = d;
  }

  return {
    ok: true,
    output,
    json: out,
    delimiter: name,
    columns: headers || [],
    notes,
    stats: { rows: out.length, columns: expect, cells: out.length * expect, depth },
  };
}

/**
 * JSON → CSV/TSV
 * @param {string} text
 * @param {object} o delimiter/header/nest/newline/quoteAll/bom
 */
export function csvFromJson(text, o) {
  const notes = [];
  const src = String(text);
  const trimmed = src.trim();
  if (trimmed === '') return { ok: true, empty: true, notes };

  let data;
  const jsonl = csvParseJsonLines(trimmed);
  if (jsonl) {
    data = jsonl;
    notes.push({ code: 'JSONL', level: 'info', count: jsonl.length });
  } else {
    const parsed = csvParseJson(trimmed);
    if (!parsed.ok) return { ok: false, error: parsed.error, notes, excerpt: csvExcerpt(src, parsed.error) };
    data = parsed.value;
    if (parsed.duplicates.length) {
      notes.push({ code: 'DUP_KEY', level: 'warn', count: parsed.duplicates.length, items: parsed.duplicates.slice(0, 6) });
    }
  }

  if (!Array.isArray(data)) {
    // 配列でない＝1件のオブジェクト、または { data: [...] } のような包み
    if (data && typeof data === 'object') {
      const keys = Object.keys(data);
      const wrapped = keys.filter((k) => Array.isArray(data[k]));
      if (wrapped.length === 1 && keys.length <= 3) {
        notes.push({ code: 'UNWRAPPED', level: 'info', key: wrapped[0] });
        data = data[wrapped[0]];
      } else {
        notes.push({ code: 'NOT_ARRAY', level: 'info' });
        data = [data];
      }
    } else {
      notes.push({ code: 'NOT_ARRAY', level: 'info' });
      data = [data];
    }
  }
  if (!data.length) return { ok: true, empty: true, notes };

  const nest = o.nest !== false;
  const flatNote = { stringified: 0, arrays: 0 };
  const columns = [];
  const rowMaps = [];
  let scalarRows = 0;

  for (const item of data) {
    const pairs = [];
    if (item === null || typeof item !== 'object') {
      scalarRows += 1;
      pairs.push(['value', item === null ? '' : String(item)]);
    } else if (Array.isArray(item)) {
      item.forEach((v, idx) => csvFlatten(v, String(idx + 1), pairs, nest, flatNote));
    } else {
      for (const key of Object.keys(item)) csvFlatten(item[key], key, pairs, nest, flatNote);
    }
    const map = {};
    for (const [key, value] of pairs) {
      map[key] = value;
      if (columns.indexOf(key) === -1) columns.push(key);
    }
    rowMaps.push(map);
  }

  const missing = rowMaps.filter((m) => Object.keys(m).length !== columns.length).length;
  if (missing) notes.push({ code: 'MIXED_KEYS', level: 'warn', count: missing, columns: columns.length });
  if (flatNote.stringified) notes.push({ code: 'STRINGIFIED', level: 'info', count: flatNote.stringified });
  if (scalarRows) notes.push({ code: 'SCALAR_ROWS', level: 'info', count: scalarRows });

  const name = !o.delimiter || o.delimiter === 'auto' ? 'comma' : o.delimiter;
  const delim = CSV_DELIMS[name] || ',';
  const nl = o.newline === 'crlf' ? '\r\n' : '\n';
  const quoteAll = Boolean(o.quoteAll);
  const lines = [];
  if (o.header !== false) lines.push(columns.map((c) => csvQuoteCell(c, delim, quoteAll)).join(delim));
  let formulas = 0;
  let multiline = 0;
  for (const map of rowMaps) {
    const cells = columns.map((c) => {
      const v = map[c] === undefined ? '' : map[c];
      if (CSV_FORMULA_RE.test(v)) formulas += 1;
      if (/[\r\n]/.test(v)) multiline += 1;
      return csvQuoteCell(v, delim, quoteAll);
    });
    lines.push(cells.join(delim));
  }
  if (formulas) notes.push({ code: 'FORMULA', level: 'warn', count: formulas });
  if (multiline) notes.push({ code: 'NEWLINE_IN_CELL', level: 'info', count: multiline });

  const output = (o.bom ? '﻿' : '') + lines.join(nl) + nl;
  let depth = 0;
  for (const item of data) {
    const d = csvDepth(item);
    if (d > depth) depth = d;
  }

  return {
    ok: true,
    output,
    delimiter: name,
    columns,
    notes,
    stats: { rows: rowMaps.length, columns: columns.length, cells: rowMaps.length * columns.length, depth },
  };
}

/**
 * CSV/TSV ⇄ JSON の相互変換。
 *
 * @param {object} opts
 * @param {'csv2json'|'json2csv'} opts.direction 変換の向き
 * @param {string} opts.text 入力
 * @param {'auto'|'comma'|'tab'|'semicolon'|'pipe'} [opts.delimiter='auto'] 区切り文字（json2csv では auto=カンマ）
 * @param {boolean} [opts.header=true] 1行目を見出しとして扱う／書き出す
 * @param {boolean} [opts.nest=true] a.b 列 ⇄ 入れ子オブジェクト
 * @param {boolean} [opts.types=true] true/false/null と数値を読み替える（csv2json）
 * @param {boolean} [opts.trim=true] セル前後の空白を落とす（csv2json）
 * @param {boolean} [opts.emptyNull=false] 空のセルを null にする（csv2json）
 * @param {number|'tab'} [opts.indent=2] JSONのインデント（csv2json）
 * @param {'lf'|'crlf'} [opts.newline='lf'] 改行コード（json2csv）
 * @param {boolean} [opts.quoteAll=false] すべてのセルを引用符で囲む（json2csv）
 * @param {boolean} [opts.bom=false] 先頭にBOMを付ける（json2csv・Excel向け）
 */
export function csvJsonConvert(opts) {
  const o = opts || {};
  const text = typeof o.text === 'string' ? o.text : '';
  const settings = {
    delimiter: o.delimiter || 'auto',
    header: o.header !== false,
    nest: o.nest !== false,
    types: o.types !== false,
    trim: o.trim !== false,
    emptyNull: Boolean(o.emptyNull),
    skipEmpty: o.skipEmpty !== false,
    indent: o.indent === undefined ? 2 : o.indent,
    newline: o.newline === 'crlf' ? 'crlf' : 'lf',
    quoteAll: Boolean(o.quoteAll),
    bom: Boolean(o.bom),
  };
  if (text.trim() === '') return { ok: true, empty: true, notes: [], settings, input_bytes: 0, output_bytes: 0 };

  const r = o.direction === 'json2csv' ? csvFromJson(text, settings) : csvToJson(text, settings);
  r.direction = o.direction === 'json2csv' ? 'json2csv' : 'csv2json';
  r.settings = settings;
  r.input_bytes = csvByteLength(text);
  r.output_bytes = r.output ? csvByteLength(r.output) : 0;
  if (!r.notes) r.notes = [];
  return r;
}

/** UTF-8としてのバイト数 */
export function csvByteLength(s) {
  let bytes = 0;
  for (const ch of String(s)) {
    const code = ch.codePointAt(0);
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
  }
  return bytes;
}

/* ==================== ここまで変換コア ==================== */

/* ---- ここから下はMCP側だけの層（入出力・文言）。site側の app.js には UI 用の同じ文言表がある ---- */

export class CsvConvertError extends Error {}

const DELIM_JA = { comma: 'カンマ', tab: 'タブ', semicolon: 'セミコロン', pipe: 'パイプ' };
const DELIM_EN = { comma: 'comma', tab: 'tab', semicolon: 'semicolon', pipe: 'pipe' };

const ERR_JA = {
  UNCLOSED_QUOTE: () => '引用符 " が閉じられていません。ここから後ろがすべて1つのセルとして読まれています。セルの中の " は "" と2つ重ねて書きます。',
  UNEXPECTED_END: () => 'JSONが途中で終わっています。閉じ括弧か引用符が足りません。',
  NEWLINE_IN_STRING: () => '文字列の途中で改行しています。JSONの文字列に生の改行は書けないので \\n と書きます。',
  BAD_ESCAPE: (e) => `使えないエスケープです（${e.found}）。JSONで書けるのは \\" \\\\ \\/ \\b \\f \\n \\r \\t と \\u に続く16進4桁だけです。`,
  EXPECTED_KEY: (e) => `オブジェクトのキーが要ります（${e.found ? '見つかったのは ' + e.found : '入力がここで終わっています'}）。キーは必ず " で囲みます。`,
  EXPECTED_COLON: () => 'キーの後ろにコロン : が要ります。',
  EXPECTED_COMMA: (e) => `区切りのカンマか閉じ括弧が要ります（${e.found ? '見つかったのは ' + e.found : '入力がここで終わっています'}）。最後の要素の後ろにカンマは書けません。`,
  UNEXPECTED_CHAR: (e) => `値として読めない文字です（${e.found}）。文字列は " で囲み、true / false / null は小文字で書きます。`,
  TRAILING_TEXT: (e) => `JSONの終わりの後ろに文字が残っています（${e.found}）。1行1件のJSON Lines として渡すこともできます。`,
};

const ERR_EN = {
  UNCLOSED_QUOTE: () => 'A quotation mark is never closed, so everything after it is being read as one cell. Write a literal " as "" inside a quoted cell.',
  UNEXPECTED_END: () => 'The JSON ends early — a closing bracket or quote is missing.',
  NEWLINE_IN_STRING: () => 'A string contains a raw line break. JSON strings must write it as \\n.',
  BAD_ESCAPE: (e) => `Unsupported escape (${e.found}). JSON allows \\" \\\\ \\/ \\b \\f \\n \\r \\t and \\u followed by four hex digits.`,
  EXPECTED_KEY: (e) => `An object key is expected here${e.found ? ` (found ${e.found})` : ' (the input ends here)'}. Keys must be quoted with ".`,
  EXPECTED_COLON: () => 'A colon : is expected after the key.',
  EXPECTED_COMMA: (e) => `A comma or a closing bracket is expected${e.found ? ` (found ${e.found})` : ' (the input ends here)'}. A trailing comma after the last element is not valid JSON.`,
  UNEXPECTED_CHAR: (e) => `This character cannot start a value (${e.found}). Strings need double quotes, and true / false / null are lower case.`,
  TRAILING_TEXT: (e) => `There is text after the end of the JSON value (${e.found}). You can also paste JSON Lines — one object per line.`,
};

const NOTE_JA = {
  BOM: () => '先頭にBOMが付いていました（Excelが書いたCSVによくあります）。読み取り時に取り除いています。',
  CRLF: () => '改行コードはCRLF（Windows）です。JSONへの変換では影響しません。',
  DELIM_AUTO: (n) => `区切り文字は${DELIM_JA[n.delimiter]}と判定しました。ずれている場合は delimiter で固定できます。`,
  STRAY_QUOTE: (n) => `セルの途中に閉じられていない引用符があります（${n.count}行）。文字として読み進めましたが、書き出した側が壊れている可能性があります。`,
  NEWLINE_IN_CELL: (n) => `セルの中に改行を含む値が ${n.count} 件あります。引用符で囲んで保持しています。`,
  DUP_HEADER: (n) => `見出しに同じ列名が ${n.count} 組あります: ${n.items.join(' / ')} — 後ろの列は ${n.items[0]}_2 のように連番を付けて区別しました。`,
  EMPTY_HEADER: (n) => `見出しが空の列が ${n.count} 列あります。column1 のような仮の名前を付けています。`,
  HEADER_ONLY: () => '見出し行だけでデータ行がありません。結果は空の配列になります。',
  NO_HEADER: () => '見出し行なしとして読んだので、各行は配列（値の並び）になります。',
  RAGGED: (n) => `列数が見出しと合わない行が ${n.count} 行あります（見出しは ${n.expect} 列）。足りない分は空、多い分は捨てています。`,
  NEST_CONFLICT: (n) => `入れ子にできない列名が ${n.count} 件あります: ${n.items.join(' / ')} — 同じ名前がすでに値で埋まっているため、その列は平らなキーのままにしました。`,
  BIG_NUMBER: (n) => `数値として正確に表せない値が ${n.count} 件あります（2の53乗を超える整数など）。桁落ちを避けるため文字列のまま残しました。`,
  KEPT_TEXT: (n) => `数字に見えるが表記が変わってしまう値が ${n.count} 件あります（0123・+1・090-1234-5678 など）。文字列のまま残しました。`,
  FORMULA: (n) => `=・+・-・@ で始まるセルが ${n.count} 件あります。表計算ソフトが数式として実行することがあるため、外部から受け取ったCSVでは中身を確認してください。`,
  JSONL: (n) => `1行1JSON（JSON Lines）として ${n.count} 件読み取りました。`,
  DUP_KEY: (n) => `同じキーが重複しているオブジェクトがあります: ${n.items.join(' / ')} — 後に書いた値が勝ちます。`,
  UNWRAPPED: (n) => `配列を包んでいるキー「${n.key}」の中身を表にしました。`,
  NOT_ARRAY: () => '配列ではなかったので、1件のデータとして1行に書き出しました。',
  MIXED_KEYS: (n) => `キーの並びが他と違うオブジェクトが ${n.count} 件あります。全体で ${n.columns} 列に揃え、無い項目は空にしました。`,
  STRINGIFIED: (n) => `入れ子の値 ${n.count} 件を、JSONの文字列としてセルに入れました。nest=true にすると列へ割れます。`,
  SCALAR_ROWS: (n) => `オブジェクトでない要素が ${n.count} 件あります。value 列に入れました。`,
};

const NOTE_EN = {
  BOM: () => 'The input started with a BOM (common in CSV written by Excel). It was removed while reading.',
  CRLF: () => 'Line endings are CRLF (Windows). This does not affect the JSON output.',
  DELIM_AUTO: (n) => `Detected the ${DELIM_EN[n.delimiter]} as the delimiter. Set delimiter explicitly if that is wrong.`,
  STRAY_QUOTE: (n) => `A quotation mark appears in the middle of a cell on ${n.count} line(s). It was read as a literal character, but whatever produced this file may be broken.`,
  NEWLINE_IN_CELL: (n) => `${n.count} value(s) contain a line break. They are kept, wrapped in quotes.`,
  DUP_HEADER: (n) => `${n.count} header name(s) appear more than once: ${n.items.join(' / ')} — later columns were numbered (${n.items[0]}_2) to keep them apart.`,
  EMPTY_HEADER: (n) => `${n.count} column(s) have an empty header. They were named column1, column2 and so on.`,
  HEADER_ONLY: () => 'There is a header row but no data rows, so the result is an empty array.',
  NO_HEADER: () => 'Read without a header row, so every row becomes an array of values.',
  RAGGED: (n) => `${n.count} row(s) do not have the same number of columns as the header (${n.expect}). Missing cells are empty; extra cells are dropped.`,
  NEST_CONFLICT: (n) => `${n.count} column(s) could not be nested: ${n.items.join(' / ')} — the same name already holds a value, so they were kept as flat keys.`,
  BIG_NUMBER: (n) => `${n.count} value(s) cannot be represented exactly as a number (integers beyond 2^53, for example). They were kept as strings so no digits are lost.`,
  KEPT_TEXT: (n) => `${n.count} value(s) look numeric but would change if converted (0123, +1, 090-1234-5678). They were kept as strings.`,
  FORMULA: (n) => `${n.count} cell(s) start with =, +, - or @. Spreadsheets may execute those as formulas, so check them when the CSV came from outside.`,
  JSONL: (n) => `Read ${n.count} records as JSON Lines (one object per line).`,
  DUP_KEY: (n) => `Some objects repeat the same key: ${n.items.join(' / ')} — the last one wins.`,
  UNWRAPPED: (n) => `Used the array inside the wrapper key “${n.key}” as the table.`,
  NOT_ARRAY: () => 'The value was not an array, so it was written as a single row.',
  MIXED_KEYS: (n) => `${n.count} object(s) have a different set of keys. The table was squared off to ${n.columns} columns and missing values are empty.`,
  STRINGIFIED: (n) => `${n.count} nested value(s) were written into a single cell as JSON text. Set nest=true to split them into columns.`,
  SCALAR_ROWS: (n) => `${n.count} element(s) are not objects. They were placed in a “value” column.`,
};

/** 向きを指定されなかったときの推定。JSONは [ か { で始まる */
export function csvGuessDirection(text) {
  const head = String(text).replace(/^﻿/, '').trim();
  return head.startsWith('[') || head.startsWith('{') ? 'json2csv' : 'csv2json';
}

/**
 * MCPツール csv_convert の本体。text / path を受け取り、変換結果と指摘事項を返す。
 * 変換そのものは csvJsonConvert（site版と同一のコア）に任せ、ここは入出力と文言だけを持つ。
 */
export async function csvConvertTool(opts = {}) {
  const o = opts || {};
  const lang = o.lang === undefined ? 'ja' : o.lang;
  if (lang !== 'ja' && lang !== 'en') throw new CsvConvertError(`lang は ja か en: ${o.lang}`);

  const hasText = typeof o.text === 'string';
  if (hasText === Boolean(o.path)) throw new CsvConvertError('text か path のどちらか一方を渡してください');

  if (o.delimiter !== undefined && o.delimiter !== 'auto' && !CSV_DELIMS[o.delimiter]) {
    throw new CsvConvertError(`delimiter は auto / ${Object.keys(CSV_DELIMS).join(' / ')} のいずれか: ${o.delimiter}`);
  }
  if (o.indent !== undefined && o.indent !== 'tab' && !(Number.isInteger(o.indent) && o.indent >= 0 && o.indent <= 8)) {
    throw new CsvConvertError(`indent は 0-8 の整数か "tab": ${o.indent}`);
  }
  if (o.newline !== undefined && o.newline !== 'lf' && o.newline !== 'crlf') {
    throw new CsvConvertError(`newline は lf か crlf: ${o.newline}`);
  }
  if (o.direction !== undefined && ['auto', 'csv2json', 'json2csv'].indexOf(o.direction) === -1) {
    throw new CsvConvertError(`direction は auto / csv2json / json2csv のいずれか: ${o.direction}`);
  }

  const input = hasText ? o.text : await readFile(o.path, 'utf8');
  const guessed = !o.direction || o.direction === 'auto';
  const direction = guessed ? csvGuessDirection(input) : o.direction;

  const r = csvJsonConvert({
    direction,
    text: input,
    delimiter: o.delimiter,
    header: o.header,
    nest: o.nest,
    types: o.types,
    trim: o.trim,
    emptyNull: o.emptyNull,
    indent: o.indent,
    newline: o.newline,
    quoteAll: o.quoteAll,
    bom: o.bom,
  });

  const source = hasText ? { type: 'text' } : { path: o.path, name: basename(o.path) };

  if (r.ok === false) {
    const table = lang === 'en' ? ERR_EN : ERR_JA;
    const e = r.error;
    const message = table[e.code] ? table[e.code](e) : e.code;
    // 入力が壊れているのは「呼び出し方の誤り」ではないので、例外ではなく結果として返す。
    // 行・桁・前後の抜粋がそのまま直しどころになる。
    return {
      ok: false,
      direction,
      direction_guessed: guessed,
      source,
      error: { code: e.code, message, line: e.line, column: e.col, found: e.found },
      excerpt: r.excerpt,
      notes: renderNotes(r.notes, lang),
    };
  }

  const result = {
    ok: true,
    direction,
    direction_guessed: guessed,
    source,
    settings: r.settings,
    notes: renderNotes(r.notes, lang),
  };
  if (r.empty) {
    result.empty = true;
    return result;
  }
  result.delimiter = r.delimiter;
  result.columns = r.columns;
  result.stats = r.stats;
  result.input_bytes = r.input_bytes;
  result.output_bytes = r.output_bytes;

  if (o.outputPath) {
    await writeFile(o.outputPath, r.output, 'utf8');
    result.output_path = o.outputPath;
    // ファイルへ書けたなら本文は重複した重い情報でしかない
  } else {
    result.output = r.output;
  }
  return result;
}

function renderNotes(notes, lang) {
  const table = lang === 'en' ? NOTE_EN : NOTE_JA;
  return (notes || []).map((n) => ({
    code: n.code,
    level: n.level || 'info',
    message: table[n.code] ? table[n.code](n) : n.code,
  }));
}
