// JSON ⇄ YAML 相互変換＆構文フォーマッター（tools.first-ch.com/json-yaml/ と同一ロジック）
//
// 「変換コア」ブロックは site 側の site/json-yaml/app.js と同一の実装。
// 2箇所ルール: 片方を直したらもう片方も同じ内容で直す（site側が正本）。
// 使っているのは String / RegExp / Object だけなので、ブラウザ版のコードをそのまま持ってこられる
// （YAMLの解析・生成も自前実装で、js-yaml 等の外部ライブラリには依存しない）。
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

/* ==================== ここから変換コア（site / MCP で同一） ==================== */

// 入れ子の深さの上限（壊れた入力でスタックを食い潰さないための保険）
const JY_MAX_DEPTH = 200;

// 指摘事項の重さ。warn = 出力が意図と変わる可能性あり / info = 知っておくと良い
const JY_NOTE_LEVEL = {
  DUPLICATE_KEY: 'warn',
  NUMBER_PRECISION: 'warn',
  NONFINITE_OUTPUT: 'warn',
  LONE_SURROGATE: 'warn',
  MULTI_DOC: 'info',
  JSON_COMMENT: 'warn',
  JSON_TRAILING_COMMA: 'warn',
  JSON_SINGLE_QUOTE: 'warn',
  JSON_UNQUOTED_KEY: 'warn',
  JSON_RELAXED_NUMBER: 'warn',
  JSON_RAW_CONTROL: 'warn',
  JSON_NONFINITE: 'warn',
  YAML_LEADING_ZERO: 'warn',
  YAML11_BOOL: 'info',
  YAML_TIMESTAMP: 'info',
  YAML_SEXAGESIMAL: 'warn',
  YAML_MERGE_KEY: 'info',
  YAML_BAD_MERGE: 'warn',
  YAML_NONSTRING_KEY: 'warn',
  YAML_DIRECTIVE: 'info',
  YAML_UNKNOWN_TAG: 'warn',
  YAML_BINARY: 'info',
  YAML_ALIAS_EXPANDED: 'info',
};

// YAML 1.1 が真偽値として扱っていた綴り。1.2 では文字列だが、
// 読み込む側のパーサが 1.1 のままだと意味が変わるので指摘する（いわゆる Norway problem）。
const JY_YAML11_BOOL = /^(y|Y|yes|Yes|YES|n|N|no|No|NO|on|On|ON|off|Off|OFF)$/;

// YAML 1.1 の60進数表記。1.2 では文字列だが、PyYAML 等では 12:30 が 750 になる。
const JY_SEXAGESIMAL = /^[-+]?[0-9][0-9_]*(:[0-5]?[0-9])+$/;

/** 指摘事項を種類ごとにまとめて数える入れ物 */
function jyNotes() {
  const list = [];
  const byCode = Object.create(null);
  return {
    list,
    add(code, item, line) {
      let n = byCode[code];
      if (!n) {
        n = { code, level: JY_NOTE_LEVEL[code] || 'warn', count: 0, items: [], lines: [] };
        byCode[code] = n;
        list.push(n);
      }
      n.count += 1;
      if (item !== undefined && item !== null && n.items.length < 6 && n.items.indexOf(item) === -1) n.items.push(item);
      if (line && n.lines.length < 6 && n.lines.indexOf(line) === -1) n.lines.push(line);
      return n;
    },
  };
}

/** 文字列中のインデックスを 1 始まりの行・桁へ */
function jyLineCol(src, index) {
  let line = 1;
  let lastBreak = -1;
  const end = Math.min(index, src.length);
  for (let k = 0; k < end; k++) {
    if (src.charCodeAt(k) === 10) {
      line += 1;
      lastBreak = k;
    }
  }
  return { line, col: end - lastBreak };
}

const jyIsPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * YAML のプレーンスカラーを値へ解決する（YAML 1.2 core schema）。
 * 出力側（formatYaml）でも「引用符なしで書けるか」の判定に使うので、副作用なしの純関数にしてある。
 */
function jyResolveScalar(s) {
  if (s === '' || s === '~' || s === 'null' || s === 'Null' || s === 'NULL') return null;
  if (s === 'true' || s === 'True' || s === 'TRUE') return true;
  if (s === 'false' || s === 'False' || s === 'FALSE') return false;
  if (/^[-+]?[0-9]+$/.test(s)) return Number(s);
  if (/^0o[0-7]+$/.test(s)) return parseInt(s.slice(2), 8);
  if (/^[-+]?0x[0-9a-fA-F]+$/.test(s)) {
    const n = parseInt(s.replace(/^[-+]/, '').slice(2), 16);
    return s.charAt(0) === '-' ? -n : n;
  }
  if (/^[-+]?(\.[0-9]+|[0-9]+(\.[0-9]*)?)([eE][-+]?[0-9]+)?$/.test(s)) return Number(s);
  if (/^[-+]?\.(inf|Inf|INF)$/.test(s)) return s.charAt(0) === '-' ? -Infinity : Infinity;
  if (/^\.(nan|NaN|NAN)$/.test(s)) return NaN;
  return s;
}

/** プレーンスカラーについて出す指摘のコード（値そのものは変えない） */
function jyScalarNotes(s) {
  const out = [];
  if (/^[-+]?0[0-9]+$/.test(s)) out.push('YAML_LEADING_ZERO');
  if (/^[-+]?[0-9]+$/.test(s) && !Number.isSafeInteger(Number(s))) out.push('NUMBER_PRECISION');
  if (JY_YAML11_BOOL.test(s)) out.push('YAML11_BOOL');
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}([Tt ].*)?$/.test(s)) out.push('YAML_TIMESTAMP');
  if (JY_SEXAGESIMAL.test(s)) out.push('YAML_SEXAGESIMAL');
  return out;
}

/* ---------------------------------------------------------------------------
 * JSON パーサ
 *
 * JSON.parse を使わず自前で読むのは、エラーの行・桁をブラウザ差なく取るため。
 * relaxed（既定 true）では tsconfig 系のコメント・末尾カンマ・シングルクォート・
 * 裸のキーも受け取り、「JSONとしては不正」と指摘したうえで変換する。
 * ------------------------------------------------------------------------- */
function jyParseJson(text, opts) {
  const o = opts || {};
  const relaxed = o.relaxed !== false;
  const src = String(text).replace(/^\uFEFF/, '');
  const N = jyNotes();
  let i = 0;
  let depth = 0;

  const fail = (code, at, found) => {
    const e = new Error(code);
    e.jy = { code, index: at === undefined ? i : at, found };
    throw e;
  };
  const lineOf = (at) => jyLineCol(src, at).line;
  const here = () => (i < src.length ? src.charAt(i) : 'EOF');

  function ws() {
    for (;;) {
      const c = src.charCodeAt(i);
      if (c === 32 || c === 9 || c === 10 || c === 13) {
        i += 1;
        continue;
      }
      if (src.charAt(i) === '/' && (src.charAt(i + 1) === '/' || src.charAt(i + 1) === '*')) {
        if (!relaxed) fail('JSON_COMMENT', i);
        N.add('JSON_COMMENT', null, lineOf(i));
        if (src.charAt(i + 1) === '/') {
          while (i < src.length && src.charAt(i) !== '\n') i += 1;
        } else {
          const end = src.indexOf('*/', i + 2);
          if (end === -1) fail('JSON_UNTERMINATED_COMMENT', i);
          i = end + 2;
        }
        continue;
      }
      return;
    }
  }

  function readString(quote) {
    const start = i;
    i += 1;
    let out = '';
    for (;;) {
      if (i >= src.length) fail('JSON_UNTERMINATED_STRING', start, quote);
      const c = src.charAt(i);
      if (c === quote) {
        i += 1;
        return out;
      }
      if (c === '\\') {
        const e = src.charAt(i + 1);
        if (e === 'u') {
          const hex = src.substr(i + 2, 4);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) fail('JSON_BAD_ESCAPE', i, src.substr(i, 6));
          out += String.fromCharCode(parseInt(hex, 16));
          i += 6;
          continue;
        }
        const simple = { '"': '"', "'": "'", '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (simple[e] === undefined) fail('JSON_BAD_ESCAPE', i, '\\' + (e || ''));
        if (e === "'") {
          if (!relaxed) fail('JSON_BAD_ESCAPE', i, "\\'");
          N.add('JSON_RELAXED_NUMBER', "\\'", lineOf(i));
        }
        out += simple[e];
        i += 2;
        continue;
      }
      const code = src.charCodeAt(i);
      if (code < 0x20) {
        if (!relaxed) fail('JSON_RAW_CONTROL', i, 'U+' + code.toString(16).toUpperCase().padStart(4, '0'));
        N.add('JSON_RAW_CONTROL', 'U+' + code.toString(16).toUpperCase().padStart(4, '0'), lineOf(i));
      }
      out += c;
      i += 1;
    }
  }

  function readLiteral() {
    const start = i;
    while (i < src.length && ',}]: \t\r\n'.indexOf(src.charAt(i)) === -1) {
      if (src.charAt(i) === '/' && (src.charAt(i + 1) === '/' || src.charAt(i + 1) === '*')) break;
      i += 1;
    }
    const tok = src.slice(start, i);
    if (tok === '') fail('JSON_VALUE_EXPECTED', start, here());
    if (tok === 'true') return true;
    if (tok === 'false') return false;
    if (tok === 'null') return null;
    if (/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][-+]?[0-9]+)?$/.test(tok)) {
      const n = Number(tok);
      if (/^-?[0-9]+$/.test(tok) && !Number.isSafeInteger(n)) N.add('NUMBER_PRECISION', tok, lineOf(start));
      return n;
    }
    // JSON としては不正だが読めるもの（+1 / .5 / 1. / 0755 / 0x1F / NaN / Infinity）
    if (/^[-+]?(NaN|Infinity)$/.test(tok)) {
      if (!relaxed) fail('JSON_BAD_TOKEN', start, tok);
      N.add('JSON_NONFINITE', tok, lineOf(start));
      return tok.charAt(0) === '-' ? (tok.indexOf('NaN') !== -1 ? NaN : -Infinity) : tok.indexOf('NaN') !== -1 ? NaN : Infinity;
    }
    if (/^[-+]?(0[xX][0-9a-fA-F]+|[0-9]*\.?[0-9]*([eE][-+]?[0-9]+)?)$/.test(tok) && /[0-9]/.test(tok)) {
      if (!relaxed) fail('JSON_BAD_TOKEN', start, tok);
      N.add('JSON_RELAXED_NUMBER', tok, lineOf(start));
      const n = /^[-+]?0[xX]/.test(tok)
        ? (tok.charAt(0) === '-' ? -1 : 1) * parseInt(tok.replace(/^[-+]/, '').slice(2), 16)
        : Number(tok);
      if (!Number.isFinite(n)) fail('JSON_BAD_TOKEN', start, tok);
      if (Number.isInteger(n) && !Number.isSafeInteger(n)) N.add('NUMBER_PRECISION', tok, lineOf(start));
      return n;
    }
    fail('JSON_BAD_TOKEN', start, tok.length > 24 ? tok.slice(0, 24) + '…' : tok);
    return null;
  }

  function readKey() {
    const c = src.charAt(i);
    if (c === '"') return readString('"');
    if (c === "'") {
      if (!relaxed) fail('JSON_SINGLE_QUOTE', i);
      N.add('JSON_SINGLE_QUOTE', null, lineOf(i));
      return readString("'");
    }
    const m = /^[A-Za-z_$][A-Za-z0-9_$-]*/.exec(src.slice(i));
    if (!m) fail('JSON_KEY_EXPECTED', i, here());
    if (!relaxed) fail('JSON_UNQUOTED_KEY', i, m[0]);
    N.add('JSON_UNQUOTED_KEY', m[0], lineOf(i));
    i += m[0].length;
    return m[0];
  }

  function readObject() {
    depth += 1;
    if (depth > JY_MAX_DEPTH) fail('TOO_DEEP', i);
    i += 1;
    // __proto__ を書き込まれてもプロトタイプ汚染にならないよう、素のオブジェクトは使わない
    const out = Object.create(null);
    ws();
    if (src.charAt(i) === '}') {
      i += 1;
      depth -= 1;
      return out;
    }
    for (;;) {
      ws();
      const at = i;
      const key = readKey();
      ws();
      if (src.charAt(i) !== ':') fail('JSON_COLON_EXPECTED', i, here());
      i += 1;
      const value = readValue();
      if (Object.prototype.hasOwnProperty.call(out, key)) N.add('DUPLICATE_KEY', key, lineOf(at));
      out[key] = value;
      ws();
      if (src.charAt(i) === ',') {
        i += 1;
        ws();
        if (src.charAt(i) === '}') {
          if (!relaxed) fail('JSON_TRAILING_COMMA', i);
          N.add('JSON_TRAILING_COMMA', null, lineOf(i));
          i += 1;
          depth -= 1;
          return out;
        }
        continue;
      }
      if (src.charAt(i) === '}') {
        i += 1;
        depth -= 1;
        return out;
      }
      fail('JSON_COMMA_EXPECTED', i, here());
    }
  }

  function readArray() {
    depth += 1;
    if (depth > JY_MAX_DEPTH) fail('TOO_DEEP', i);
    i += 1;
    const out = [];
    ws();
    if (src.charAt(i) === ']') {
      i += 1;
      depth -= 1;
      return out;
    }
    for (;;) {
      out.push(readValue());
      ws();
      if (src.charAt(i) === ',') {
        i += 1;
        ws();
        if (src.charAt(i) === ']') {
          if (!relaxed) fail('JSON_TRAILING_COMMA', i);
          N.add('JSON_TRAILING_COMMA', null, lineOf(i));
          i += 1;
          depth -= 1;
          return out;
        }
        continue;
      }
      if (src.charAt(i) === ']') {
        i += 1;
        depth -= 1;
        return out;
      }
      fail('JSON_COMMA_EXPECTED', i, here());
    }
  }

  function readValue() {
    ws();
    if (i >= src.length) fail('JSON_UNEXPECTED_END', i);
    const c = src.charAt(i);
    if (c === '{') return readObject();
    if (c === '[') return readArray();
    if (c === '"') return readString('"');
    if (c === "'") {
      if (!relaxed) fail('JSON_SINGLE_QUOTE', i);
      N.add('JSON_SINGLE_QUOTE', null, lineOf(i));
      return readString("'");
    }
    return readLiteral();
  }

  try {
    ws();
    if (i >= src.length) return { ok: false, error: { code: 'EMPTY_INPUT', line: 1, col: 1 }, notes: N.list };
    const value = readValue();
    ws();
    if (i < src.length) fail('JSON_TRAILING_DATA', i, here());
    return { ok: true, value, notes: N.list };
  } catch (e) {
    if (!e.jy) throw e;
    const pos = jyLineCol(src, e.jy.index);
    return {
      ok: false,
      error: { code: e.jy.code, line: pos.line, col: pos.col, found: e.jy.found },
      notes: N.list,
    };
  }
}

/* ---------------------------------------------------------------------------
 * YAML パーサ（インデント方式のブロック構造 + フロー表記）
 *
 * 対応: 複数ドキュメント（--- / ...）・ブロックマップ / シーケンス・フロー表記 [] {}・
 *       引用スカラー（複数行・エスケープ）・ブロックスカラー | > と chomping - + と明示インデント・
 *       アンカー &a / エイリアス *a / マージキー <<・タグ !!str !!int 等・コメント。
 * 非対応: 明示キー "? " と、"!" による独自タグの型付け（エラー / 指摘にして黙って壊さない）。
 * ------------------------------------------------------------------------- */
function jyParseYaml(text) {
  const N = jyNotes();
  const src = String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const lines = src.split('\n').map((raw, k) => {
    const ws = /^[ \t]*/.exec(raw)[0];
    const body = raw.slice(ws.length);
    return { n: k + 1, text: raw, ws, indent: ws.length, body, blank: body === '', comment: body.charAt(0) === '#' };
  });
  const anchors = Object.create(null);
  let p = 0;
  let depth = 0;
  let usedAlias = false;

  const fail = (code, line, col, found) => {
    const e = new Error(code);
    e.jy = { code, line: line || 1, col: col || 1, found };
    throw e;
  };

  // インデントにタブを使うと解釈がパーサ任せになる（YAMLはタブでのインデントを禁じている）。
  // ブロックスカラーの中身は対象外なので、構造として読む行だけで確かめる。
  function checkTab(L) {
    if (L.ws.indexOf('\t') !== -1) fail('TAB_INDENT', L.n, L.ws.indexOf('\t') + 1);
  }

  /** 構造として意味のある次の行まで進める（空行・コメント行は飛ばす） */
  function skip() {
    while (p < lines.length && (lines[p].blank || lines[p].comment)) p += 1;
    if (p >= lines.length) return null;
    checkTab(lines[p]);
    return lines[p];
  }

  const isSeqEntry = (body) => body === '-' || body.slice(0, 2) === '- ' || body.slice(0, 2) === '-\t';
  const isDocStart = (body) => body === '---' || body.slice(0, 4) === '--- ';
  const isDocEnd = (body) => body === '...' || body.slice(0, 4) === '... ';
  // --- と ... はドキュメントの区切り。ただし桁0に書かれたときだけで、字下げされていれば普通の値
  const isBoundary = (L) => L.indent === 0 && (isDocStart(L.body) || isDocEnd(L.body));

  /** 行の内容からコメントを落とす（引用符の中の # と、空白が前に無い # は残す） */
  function stripComment(s) {
    let inS = false;
    let inD = false;
    for (let k = 0; k < s.length; k++) {
      const c = s.charAt(k);
      if (inS) {
        if (c === "'") {
          if (s.charAt(k + 1) === "'") k += 1;
          else inS = false;
        }
        continue;
      }
      if (inD) {
        if (c === '\\') k += 1;
        else if (c === '"') inD = false;
        continue;
      }
      if (c === "'") inS = true;
      else if (c === '"') inD = true;
      else if (c === '#' && (k === 0 || s.charAt(k - 1) === ' ' || s.charAt(k - 1) === '\t')) {
        return s.slice(0, k).replace(/[ \t]+$/, '');
      }
    }
    return s;
  }

  /** 「キー: 」の区切りを探す。引用符とフロー表記の中は無視する */
  function splitKey(s) {
    let inS = false;
    let inD = false;
    let flow = 0;
    for (let k = 0; k < s.length; k++) {
      const c = s.charAt(k);
      if (inS) {
        if (c === "'") {
          if (s.charAt(k + 1) === "'") k += 1;
          else inS = false;
        }
        continue;
      }
      if (inD) {
        if (c === '\\') k += 1;
        else if (c === '"') inD = false;
        continue;
      }
      if (c === "'") inS = true;
      else if (c === '"') inD = true;
      else if (c === '[' || c === '{') flow += 1;
      else if (c === ']' || c === '}') flow -= 1;
      else if (c === '#' && flow === 0 && (k === 0 || s.charAt(k - 1) === ' ')) return null;
      else if (c === ':' && flow === 0) {
        const nx = s.charAt(k + 1);
        if (k + 1 >= s.length || nx === ' ' || nx === '\t') return { key: s.slice(0, k), rest: s.slice(k + 1) };
      }
    }
    return null;
  }

  /** 値の前に付く &アンカー / *エイリアス / !タグ を剥がす */
  function takeProps(s) {
    const props = { anchor: null, alias: null, tag: null };
    let rest = s;
    for (let guard = 0; guard < 4; guard++) {
      const m = /^(?:&([^\s,[\]{}]+)|\*([^\s,[\]{}]+)|(![^\s,[\]{}]*))(?:[ \t]+|$)/.exec(rest);
      if (!m) break;
      if (m[1]) props.anchor = m[1];
      else if (m[2]) props.alias = m[2];
      else props.tag = m[3];
      rest = rest.slice(m[0].length);
      if (props.alias) break;
    }
    return { props, rest };
  }

  /** スカラー文字列をタグ・引用の有無に従って値へ */
  function toScalar(token, props, line, quoted) {
    const tag = props && props.tag;
    if (!tag) {
      if (quoted) return token;
      for (const code of jyScalarNotes(token)) N.add(code, token, line);
      return jyResolveScalar(token);
    }
    switch (tag.replace(/^!!?/, '')) {
      case 'str':
        return token;
      case 'int': {
        const n = /^[-+]?0[xob]/i.test(token) ? jyResolveScalar(token) : parseInt(token, 10);
        if (typeof n !== 'number' || !Number.isFinite(n)) fail('YAML_BAD_TAG_VALUE', line, 1, tag + ' ' + token);
        return n;
      }
      case 'float': {
        const n = Number(token);
        if (!Number.isFinite(n)) fail('YAML_BAD_TAG_VALUE', line, 1, tag + ' ' + token);
        return n;
      }
      case 'bool':
        return /^(true|yes|on|y|1)$/i.test(token);
      case 'null':
        return null;
      case 'binary':
        N.add('YAML_BINARY', null, line);
        return token.replace(/\s+/g, '');
      case 'map':
      case 'seq':
        return quoted ? token : jyResolveScalar(token);
      default:
        N.add('YAML_UNKNOWN_TAG', tag, line);
        return quoted ? token : jyResolveScalar(token);
    }
  }

  const ESCAPES = {
    '0': '\0', a: '\x07', b: '\b', t: '\t', '\t': '\t', n: '\n', v: '\v', f: '\f', r: '\r',
    e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029',
  };

  /** 二重引用符の中のエスケープを1つ読む。読めなければ null */
  function readEscape(s, k) {
    const c = s.charAt(k + 1);
    if (k + 1 >= s.length) return { text: '', next: s.length };  // 行末の \ は行継続
    if (c === 'x' || c === 'u' || c === 'U') {
      const len = c === 'x' ? 2 : c === 'u' ? 4 : 8;
      const hex = s.substr(k + 2, len);
      if (hex.length < len || !/^[0-9a-fA-F]+$/.test(hex)) return null;
      const cp = parseInt(hex, 16);
      if (cp > 0x10ffff) return null;
      return { text: String.fromCodePoint(cp), next: k + 2 + len };
    }
    if (ESCAPES[c] === undefined) return null;
    return { text: ESCAPES[c], next: k + 2 };
  }

  /**
   * 引用符つきスカラーを読む（複数行にまたがってよい）。
   * 戻り値の rest は閉じ引用符より後ろ。p は最後に読んだ行を指す。
   */
  function readQuoted(s) {
    const quote = s.charAt(0);
    const startLine = lines[p].n;
    let cur = s;
    let k = 1;
    let out = '';
    for (;;) {
      while (k < cur.length) {
        const c = cur.charAt(k);
        if (quote === "'") {
          if (c === "'") {
            if (cur.charAt(k + 1) === "'") {
              out += "'";
              k += 2;
              continue;
            }
            return { value: out, rest: cur.slice(k + 1) };
          }
          out += c;
          k += 1;
          continue;
        }
        if (c === '\\') {
          const e = readEscape(cur, k);
          if (e === null) fail('YAML_BAD_ESCAPE', lines[p].n, k + 1, cur.substr(k, 2));
          out += e.text;
          k = e.next;
          continue;
        }
        if (c === '"') return { value: out, rest: cur.slice(k + 1) };
        out += c;
        k += 1;
      }
      // 行末に達した = 折り返し。空行の数だけ改行になり、無ければ空白1つになる
      out = out.replace(/[ \t]+$/, '');
      let breaks = 0;
      for (;;) {
        p += 1;
        if (p >= lines.length) fail('YAML_UNTERMINATED_QUOTE', startLine, 1, quote);
        if (lines[p].blank) {
          breaks += 1;
          continue;
        }
        break;
      }
      out += breaks === 0 ? ' ' : '\n'.repeat(breaks);
      cur = lines[p].body;
      k = 0;
    }
  }

  /** フロー表記 [ … ] / { … } を読む（複数行にまたがってよい） */
  function readFlow(s) {
    const startLine = lines[p].n;
    let text = s;
    let idx = 0;
    let level = 0;
    let inS = false;
    let inD = false;
    for (;;) {
      while (idx < text.length) {
        const c = text.charAt(idx);
        if (inS) {
          if (c === "'") {
            if (text.charAt(idx + 1) === "'") idx += 1;
            else inS = false;
          }
          idx += 1;
          continue;
        }
        if (inD) {
          if (c === '\\') idx += 1;
          else if (c === '"') inD = false;
          idx += 1;
          continue;
        }
        if (c === "'") inS = true;
        else if (c === '"') inD = true;
        else if (c === '[' || c === '{') level += 1;
        else if (c === ']' || c === '}') {
          level -= 1;
          if (level === 0) {
            idx += 1;
            return { value: parseFlow(text.slice(0, idx), startLine), rest: text.slice(idx) };
          }
        }
        idx += 1;
      }
      p += 1;
      if (p >= lines.length) fail('YAML_UNTERMINATED_FLOW', startLine, 1);
      // 引用符の途中でなければ、続きの行のコメントは落としてから連結する
      text += ' ' + (inS || inD ? lines[p].body : stripComment(lines[p].body));
    }
  }

  /** 括弧の対応が取れているフロー表記の文字列を値へ */
  function parseFlow(text, line) {
    let k = 0;
    const ws = () => {
      while (k < text.length && /\s/.test(text.charAt(k))) k += 1;
    };

    function value() {
      ws();
      const c = text.charAt(k);
      if (c === '[') return seq();
      if (c === '{') return map();
      if (c === '"' || c === "'") {
        const saved = p;
        const r = (function () {
          // 1行に収まっているので readQuoted の折り返し処理には入らない
          const sub = text.slice(k);
          const q = readQuotedInline(sub, line);
          k += sub.length - q.rest.length;
          return q.value;
        })();
        p = saved;
        return r;
      }
      const start = k;
      while (k < text.length) {
        const ch = text.charAt(k);
        if (ch === ',' || ch === ']' || ch === '}') break;
        if (ch === ':' && (k + 1 >= text.length || /[\s,\]}]/.test(text.charAt(k + 1)))) break;
        k += 1;
      }
      const tok = text.slice(start, k).trim();
      const t = takeProps(tok);
      if (t.props.alias) {
        if (!(t.props.alias in anchors)) fail('YAML_ALIAS_NOT_FOUND', line, 1, '*' + t.props.alias);
        usedAlias = true;
        return anchors[t.props.alias];
      }
      const v = toScalar(t.rest, t.props, line, false);
      if (t.props.anchor) anchors[t.props.anchor] = v;
      return v;
    }

    function seq() {
      depth += 1;
      if (depth > JY_MAX_DEPTH) fail('TOO_DEEP', line);
      k += 1;
      const arr = [];
      for (;;) {
        ws();
        if (text.charAt(k) === ']') {
          k += 1;
          depth -= 1;
          return arr;
        }
        if (k >= text.length) fail('YAML_UNTERMINATED_FLOW', line, 1);
        const quotedKey = text.charAt(k) === '"' || text.charAt(k) === "'";
        const v = value();
        ws();
        if (text.charAt(k) === ':') {
          // [a: 1] のように括弧なしのペアが書かれた場合
          k += 1;
          const pair = Object.create(null);
          const own = new Set();
          setKey(pair, own, v, value(), line, !quotedKey);
          arr.push(pair);
          ws();
        } else {
          arr.push(v);
        }
        if (text.charAt(k) === ',') {
          k += 1;
          continue;
        }
        if (text.charAt(k) === ']') {
          k += 1;
          depth -= 1;
          return arr;
        }
        fail('YAML_FLOW_SEP', line, 1, text.charAt(k) || 'EOF');
      }
    }

    function map() {
      depth += 1;
      if (depth > JY_MAX_DEPTH) fail('TOO_DEEP', line);
      k += 1;
      const obj = Object.create(null);
      const own = new Set();
      for (;;) {
        ws();
        if (text.charAt(k) === '}') {
          k += 1;
          depth -= 1;
          return obj;
        }
        if (k >= text.length) fail('YAML_UNTERMINATED_FLOW', line, 1);
        const quotedKey = text.charAt(k) === '"' || text.charAt(k) === "'";
        const key = value();
        ws();
        let v = null;
        if (text.charAt(k) === ':') {
          k += 1;
          v = value();
          ws();
        } else if (text.charAt(k) !== ',' && text.charAt(k) !== '}') {
          fail('YAML_FLOW_COLON', line, 1, text.charAt(k) || 'EOF');
        }
        setKey(obj, own, key, v, line, !quotedKey);
        if (text.charAt(k) === ',') {
          k += 1;
          continue;
        }
        if (text.charAt(k) === '}') {
          k += 1;
          depth -= 1;
          return obj;
        }
        fail('YAML_FLOW_SEP', line, 1, text.charAt(k) || 'EOF');
      }
    }

    const out = value();
    ws();
    if (k < text.length) fail('YAML_FLOW_SEP', line, 1, text.charAt(k));
    return out;
  }

  /** 1行に収まっている引用スカラーを読む（フロー表記の中で使う） */
  function readQuotedInline(s, line) {
    const quote = s.charAt(0);
    let out = '';
    for (let k = 1; k < s.length; k++) {
      const c = s.charAt(k);
      if (quote === "'") {
        if (c === "'") {
          if (s.charAt(k + 1) === "'") {
            out += "'";
            k += 1;
            continue;
          }
          return { value: out, rest: s.slice(k + 1) };
        }
        out += c;
        continue;
      }
      if (c === '\\') {
        const e = readEscape(s, k);
        if (e === null) fail('YAML_BAD_ESCAPE', line, k + 1, s.substr(k, 2));
        out += e.text;
        k = e.next - 1;
        continue;
      }
      if (c === '"') return { value: out, rest: s.slice(k + 1) };
      out += c;
    }
    fail('YAML_UNTERMINATED_QUOTE', line, 1, quote);
    return null;
  }

  /** ブロックスカラー（| と >）を読む。s はヘッダ（| や >- など）から始まる */
  function readBlockScalar(s, baseIndent) {
    const style = s.charAt(0);
    let k = 1;
    let chomp = '';
    let explicit = 0;
    while (k < s.length) {
      const c = s.charAt(k);
      if ((c === '+' || c === '-') && !chomp) {
        chomp = c;
        k += 1;
        continue;
      }
      if (c >= '1' && c <= '9' && !explicit) {
        explicit = Number(c);
        k += 1;
        continue;
      }
      break;
    }
    const tail = stripComment(s.slice(k)).trim();
    if (tail !== '') fail('YAML_BLOCK_HEADER', lines[p].n, k + 1, tail);

    p += 1;
    const body = [];
    let contentIndent = explicit ? baseIndent + explicit : 0;
    while (p < lines.length) {
      const L = lines[p];
      if (L.blank) {
        body.push('');
        p += 1;
        continue;
      }
      if (!contentIndent) {
        if (L.indent <= baseIndent) break;
        contentIndent = L.indent;
      } else if (L.indent < contentIndent) {
        // ブロックの中身より浅く、しかし親より深い = インデントの取り違え
        if (L.indent > baseIndent) fail('YAML_BLOCK_INDENT', L.n, L.indent + 1);
        break;
      }
      body.push(L.text.slice(contentIndent));
      p += 1;
    }

    let end = body.length;
    while (end > 0 && body[end - 1] === '') end -= 1;
    const trailingBlanks = body.length - end;
    const content = body.slice(0, end);

    let out;
    if (style === '|') {
      out = content.join('\n');
    } else {
      out = '';
      for (let q = 0; q < content.length; q++) {
        const ln = content[q];
        if (q === 0) {
          out = ln;
          continue;
        }
        const prev = content[q - 1];
        if (ln === '') out += '\n';
        else if (prev === '') out += ln;
        else if (/^[ \t]/.test(ln) || /^[ \t]/.test(prev)) out += '\n' + ln;
        else out += ' ' + ln;
      }
    }
    if (content.length) out += '\n';
    if (chomp === '-') out = out.replace(/\n+$/, '');
    else if (chomp === '+') out += '\n'.repeat(trailingBlanks);
    return out;
  }

  /**
   * マップへキーを入れる（マージキー <<・文字列以外のキー・キーの重複を処理する）。
   * << は引用符なしで書かれたときだけマージ指示になる（'<<' と書けば普通のキー。js-yaml も同じ扱い）。
   */
  function setKey(obj, own, key, value, line, plainKey) {
    if (key === '<<' && plainKey !== false) {
      const sources = Array.isArray(value) ? value : [value];
      for (const s of sources) {
        if (!jyIsPlainObject(s)) {
          N.add('YAML_BAD_MERGE', null, line);
          continue;
        }
        for (const k of Object.keys(s)) if (!own.has(k)) obj[k] = s[k];
      }
      N.add('YAML_MERGE_KEY', null, line);
      return;
    }
    let name;
    if (typeof key === 'string') {
      name = key;
    } else {
      name = key === null ? 'null' : typeof key === 'object' ? jyFormatJson(key, { indent: 0 }) : String(key);
      N.add('YAML_NONSTRING_KEY', name, line);
    }
    if (own.has(name)) N.add('DUPLICATE_KEY', name, line);
    own.add(name);
    obj[name] = value;
  }

  /**
   * 「: の後ろ」または「- の後ろ」に続く値を解釈する。
   * baseIndent より深い行だけを続きとして取り込む。戻るとき p は次の未処理行を指す。
   */
  function parseTrailing(rawRest, baseIndent) {
    const L = lines[p];
    const line = L.n;
    const t = takeProps(rawRest.replace(/^[ \t]+/, ''));
    const props = t.props;
    let s = t.rest;

    if (props.alias) {
      if (stripComment(s).trim() !== '') fail('YAML_ALIAS_TRAILING', line, 1, stripComment(s).trim());
      if (!(props.alias in anchors)) fail('YAML_ALIAS_NOT_FOUND', line, 1, '*' + props.alias);
      usedAlias = true;
      p += 1;
      return anchors[props.alias];
    }

    if (/^[|>]/.test(s)) {
      const v = readBlockScalar(s, baseIndent);
      const out = props.tag ? toScalar(v, props, line, true) : v;
      if (props.anchor) anchors[props.anchor] = out;
      return out;
    }

    if (stripComment(s).trim() === '') {
      // 値は次の行以降にある
      p += 1;
      const child = parseChild(baseIndent);
      if (props.tag && !/^!!?(map|seq)$/.test(props.tag)) N.add('YAML_UNKNOWN_TAG', props.tag, line);
      if (props.anchor) anchors[props.anchor] = child;
      return child;
    }

    if (s.charAt(0) === '"' || s.charAt(0) === "'") {
      const q = readQuoted(s);
      const rest = stripComment(q.rest).trim();
      if (rest !== '') fail('YAML_TRAILING_TEXT', lines[p].n, 1, rest.slice(0, 24));
      p += 1;
      const out = toScalar(q.value, props, line, true);
      if (props.anchor) anchors[props.anchor] = out;
      return out;
    }

    if (s.charAt(0) === '[' || s.charAt(0) === '{') {
      const f = readFlow(s);
      const rest = stripComment(f.rest).trim();
      if (rest !== '') fail('YAML_TRAILING_TEXT', lines[p].n, 1, rest.slice(0, 24));
      p += 1;
      if (props.anchor) anchors[props.anchor] = f.value;
      return f.value;
    }

    // プレーンスカラー。次の行以降へ折り返している場合は空白1つで連結する
    const first = stripComment(s).replace(/[ \t]+$/, '');
    if (/^-([ \t]|$)/.test(first)) fail('YAML_SEQ_INLINE', line, L.text.length - rawRest.length + 1, first.slice(0, 24));
    if (splitKey(first)) fail('YAML_NESTED_COLON', line, L.text.length - rawRest.length + 1, first.slice(0, 24));
    const parts = [first];
    p += 1;
    while (p < lines.length) {
      const L2 = lines[p];
      if (L2.blank || L2.comment) break;
      checkTab(L2);
      if (L2.indent <= baseIndent || isBoundary(L2)) break;
      const body = stripComment(L2.body).replace(/[ \t]+$/, '');
      if (isSeqEntry(L2.body) || splitKey(body)) fail('YAML_VALUE_THEN_BLOCK', L2.n, L2.indent + 1, body.slice(0, 24));
      parts.push(body);
      p += 1;
    }
    const token = parts.join(' ').replace(/[ \t]+$/, '');
    const out = toScalar(token, props, line, false);
    if (props.anchor) anchors[props.anchor] = out;
    return out;
  }

  /** 親より深い行（またはキーと同じ深さのシーケンス）を子ノードとして読む */
  function parseChild(baseIndent) {
    const L = skip();
    if (!L || isBoundary(L)) return null;
    if (L.indent > baseIndent) return parseNode(L.indent);
    // key: の下に同じ深さで - を並べるのは YAML として正しい
    if (L.indent === baseIndent && isSeqEntry(L.body)) return parseSeq(baseIndent);
    return null;
  }

  function parseNode(indent) {
    depth += 1;
    if (depth > JY_MAX_DEPTH) fail('TOO_DEEP', lines[p] ? lines[p].n : 1);
    try {
      const L = skip();
      if (!L || L.indent < indent || isBoundary(L)) return null;
      // 「? key」「: value」の明示キー記法は、JSONに落とせないので受け取らない
      if (/^[?:]([ \t]|$)/.test(L.body)) fail('YAML_EXPLICIT_KEY', L.n, L.indent + 1);
      if (isSeqEntry(L.body)) return parseSeq(indent);
      if (splitKey(L.body)) return parseMap(indent);
      return parseTrailing(L.body, indent - 1);
    } finally {
      depth -= 1;
    }
  }

  function parseMap(indent) {
    const obj = Object.create(null);
    const own = new Set();
    for (;;) {
      const L = skip();
      if (!L || L.indent < indent || isBoundary(L)) break;
      if (L.indent > indent) fail('YAML_BAD_INDENT', L.n, L.indent + 1, stripComment(L.body).slice(0, 24));
      if (isSeqEntry(L.body)) fail('YAML_SEQ_IN_MAP', L.n, L.indent + 1);
      const kv = splitKey(L.body);
      if (!kv) {
        if (/^\?([ \t]|$)/.test(L.body)) fail('YAML_EXPLICIT_KEY', L.n, L.indent + 1);
        fail('YAML_KEY_EXPECTED', L.n, L.indent + 1, stripComment(L.body).trim().slice(0, 24));
      }
      const line = L.n;
      const kt = takeProps(kv.key.trim());
      const rawKey = kt.rest;
      const quotedKey = rawKey.charAt(0) === '"' || rawKey.charAt(0) === "'";
      const key = quotedKey ? readQuotedInline(rawKey, line).value : toScalar(rawKey, kt.props, line, false);
      const value = parseTrailing(kv.rest, indent);
      setKey(obj, own, key, value, line, !quotedKey);
    }
    return obj;
  }

  function parseSeq(indent) {
    const arr = [];
    for (;;) {
      const L = skip();
      if (!L || L.indent < indent || isBoundary(L)) break;
      if (!isSeqEntry(L.body)) {
        // 同じ深さにマップのキーが来たら、呼び出し側（マップ）へ制御を戻す
        if (L.indent === indent) break;
        fail('YAML_BAD_INDENT', L.n, L.indent + 1, stripComment(L.body).slice(0, 24));
      }
      if (L.indent > indent) fail('YAML_BAD_INDENT', L.n, L.indent + 1, stripComment(L.body).slice(0, 24));
      const rest = L.body.slice(1);
      const lead = /^[ \t]*/.exec(rest)[0].length;
      const inner = rest.slice(lead);
      if (stripComment(inner).trim() === '') {
        p += 1;
        // 「-」だけの行の中身は、より深い行だけ。同じ深さの「-」は（親の値ではなく）次の要素なので、
        // key: の下に同じ深さで - を並べられる parseChild は使えない
        const next = skip();
        arr.push(!next || isBoundary(next) || next.indent <= indent ? null : parseNode(next.indent));
        continue;
      }
      // 「- 」に続く中身を、その桁から始まる行として読み直す（- name: a の下に同じ桁で続くキーを拾うため）
      const itemIndent = indent + 1 + lead;
      lines[p] = { ...L, ws: L.text.slice(0, itemIndent), indent: itemIndent, body: inner };
      arr.push(parseNode(itemIndent));
    }
    return arr;
  }

  const docs = [];
  try {
    let guard = 0;
    while (p < lines.length) {
      if ((guard += 1) > lines.length + 16) fail('YAML_INTERNAL', lines[p] ? lines[p].n : 1);
      const L = skip();
      if (!L) break;
      if (L.body.charAt(0) === '%') {
        N.add('YAML_DIRECTIVE', stripComment(L.body).trim(), L.n);
        p += 1;
        continue;
      }
      if (L.indent === 0 && isDocEnd(L.body)) {
        p += 1;
        continue;
      }
      if (L.indent === 0 && isDocStart(L.body)) {
        const rest = L.body.slice(3);
        if (stripComment(rest).trim() === '') {
          p += 1;
          const next = skip();
          docs.push(!next || isBoundary(next) ? null : parseNode(next.indent));
        } else {
          const lead = /^[ \t]*/.exec(rest)[0].length;
          const itemIndent = 3 + lead;
          lines[p] = { ...L, ws: L.text.slice(0, itemIndent), indent: itemIndent, body: rest.slice(lead) };
          docs.push(parseNode(itemIndent));
        }
        continue;
      }
      docs.push(parseNode(L.indent));
    }
  } catch (e) {
    if (!e.jy) throw e;
    return { ok: false, error: e.jy, notes: N.list, docs };
  }

  if (usedAlias) N.add('YAML_ALIAS_EXPANDED');
  if (docs.length > 1) N.add('MULTI_DOC', null, null).count = docs.length;
  return {
    ok: true,
    docs,
    value: docs.length === 0 ? null : docs.length === 1 ? docs[0] : docs,
    notes: N.list,
  };
}

/* ---------------------------------------------------------------------------
 * JSON 出力
 * ------------------------------------------------------------------------- */

/**
 * 値をJSON文字列へ。JSON.stringify と違い、キーの並べ替え・非ASCIIのエスケープ・
 * インデント文字（タブ / 1行）を選べる。NaN と Infinity は JSON に無いので null にする。
 *
 * @param {*} value
 * @param {object} [opts]
 * @param {number|'tab'} [opts.indent=2] 0 なら改行なしの1行
 * @param {boolean} [opts.sortKeys=false]
 * @param {boolean} [opts.ascii=false]   非ASCII文字を \uXXXX にする
 */
function jyFormatJson(value, opts) {
  const o = opts || {};
  const tab = o.indent === 'tab';
  const width = tab ? 1 : o.indent === undefined ? 2 : Number(o.indent) || 0;
  const pad = tab ? '\t' : ' '.repeat(width);
  const oneLine = !tab && width === 0;
  const nl = oneLine ? '' : '\n';
  const sortKeys = Boolean(o.sortKeys);
  const ascii = Boolean(o.ascii);

  const hex4 = (n) => '\\u' + n.toString(16).toLowerCase().padStart(4, '0');

  function str(s) {
    let out = '"';
    for (let k = 0; k < s.length; k++) {
      const c = s.charAt(k);
      const cp = s.charCodeAt(k);
      if (c === '"') out += '\\"';
      else if (c === '\\') out += '\\\\';
      else if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else if (cp === 8) out += '\\b';
      else if (cp === 12) out += '\\f';
      else if (cp < 0x20 || cp === 0x7f) out += hex4(cp);
      else if (ascii && cp > 0x7e) out += hex4(cp);
      else out += c;
    }
    return out + '"';
  }

  function scalar(v) {
    if (v === null || v === undefined) return 'null';
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'null';
    return str(String(v));
  }

  function write(v, level) {
    if (Array.isArray(v)) {
      if (!v.length) return '[]';
      const ind = oneLine ? '' : pad.repeat(level + 1);
      const close = oneLine ? '' : pad.repeat(level);
      const items = v.map((item) => ind + write(item, level + 1));
      return '[' + nl + items.join(',' + nl) + nl + close + ']';
    }
    if (jyIsPlainObject(v)) {
      const keys = sortKeys ? Object.keys(v).sort() : Object.keys(v);
      if (!keys.length) return '{}';
      const ind = oneLine ? '' : pad.repeat(level + 1);
      const close = oneLine ? '' : pad.repeat(level);
      const items = keys.map((k) => ind + str(k) + (oneLine ? ':' : ': ') + write(v[k], level + 1));
      return '{' + nl + items.join(',' + nl) + nl + close + '}';
    }
    return scalar(v);
  }

  return write(value, 0);
}

/* ---------------------------------------------------------------------------
 * YAML 出力
 * ------------------------------------------------------------------------- */

const JY_CONTROL_RE = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\uFEFF]/;

/** 引用符なし（プレーン）で書ける文字列かどうか */
function jyPlainSafe(s) {
  if (s === '') return false;
  if (/^[ \t]|[ \t]$/.test(s)) return false;                       // 前後の空白は失われる
  if (/[\n\r]/.test(s) || JY_CONTROL_RE.test(s)) return false;     // 改行・制御文字
  if (/: /.test(s) || /:$/.test(s)) return false;                  // マップの区切りに見える
  if (JY_SEXAGESIMAL.test(s)) return false;                        // 12:30 が 750 に化けるパーサがある
  if (/ #/.test(s)) return false;                                  // コメントの始まりに見える
  if (/^[-?:]([ \t]|$)/.test(s)) return false;                     // 指示子＋空白
  if (/^[,[\]{}#&*!|>'"%@`]/.test(s)) return false;                // 先頭に置けない記号
  if (s === '---' || s === '...') return false;                     // ドキュメントの区切りに見える
  if (typeof jyResolveScalar(s) !== 'string') return false;        // 数値・真偽値・null に化ける
  if (JY_YAML11_BOOL.test(s)) return false;                        // YAML 1.1 のパーサで真偽値に化ける
  if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}([Tt ].*)?$/.test(s)) return false; // 日付に化ける
  return true;
}

/**
 * 値をYAML文字列へ。
 *
 * @param {*} value
 * @param {object} [opts]
 * @param {number} [opts.indent=2]       ネスト1段あたりの空白数（1-8）
 * @param {boolean}[opts.block=true]     改行を含む文字列をブロックスカラー（|）で書く
 * @param {boolean}[opts.sortKeys=false] キーを名前順に並べる
 * @param {boolean}[opts.docStart=false] 先頭に --- を付ける
 * @param {'auto'|'single'|'double'} [opts.quote='auto'] 引用符の付け方
 * @param {'null'|'tilde'|'empty'} [opts.nullStyle='null'] null の書き方
 */
function jyFormatYaml(value, opts) {
  const o = opts || {};
  const step = Math.max(1, Math.min(8, Number(o.indent) || 2));
  const pad = ' '.repeat(step);
  const quote = o.quote === 'single' || o.quote === 'double' ? o.quote : 'auto';
  const block = o.block !== false;
  const sortKeys = Boolean(o.sortKeys);
  const nullText = o.nullStyle === 'tilde' ? '~' : o.nullStyle === 'empty' ? '' : 'null';

  function dq(s) {
    let out = '"';
    for (let k = 0; k < s.length; k++) {
      const c = s.charAt(k);
      const cp = s.charCodeAt(k);
      if (c === '"') out += '\\"';
      else if (c === '\\') out += '\\\\';
      else if (c === '\n') out += '\\n';
      else if (c === '\r') out += '\\r';
      else if (c === '\t') out += '\\t';
      else if (cp < 0x20 || cp === 0x7f) out += '\\x' + cp.toString(16).toUpperCase().padStart(2, '0');
      else if (cp >= 0x80 && cp <= 0x9f) out += '\\u' + cp.toString(16).toUpperCase().padStart(4, '0');
      else out += c;
    }
    return out + '"';
  }

  function quoted(s) {
    if (quote === 'double') return dq(s);
    if (/[\n\r]/.test(s) || JY_CONTROL_RE.test(s)) return dq(s);
    return "'" + s.replace(/'/g, "''") + "'";
  }

  /** ブロックスカラー（|）で安全に書ける文字列かどうか */
  function blockSafe(s) {
    if (!block || s.indexOf('\n') === -1) return false;
    if (JY_CONTROL_RE.test(s) || s.indexOf('\r') !== -1) return false;
    if (/^[ \t]/.test(s)) return false;        // 1行目の字下げは復元できない
    if (/[ \t]$/m.test(s)) return false;       // 行末の空白は復元できない
    if (/\n{2,}$/.test(s)) return false;       // 末尾の空行は次の行と紛れる
    if (/^\s*$/.test(s)) return false;
    return true;
  }

  function scalarText(v) {
    if (v === null || v === undefined) return nullText;
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    if (typeof v === 'number') {
      if (Number.isNaN(v)) return '.nan';
      if (v === Infinity) return '.inf';
      if (v === -Infinity) return '-.inf';
      return String(v);
    }
    const s = String(v);
    if (quote === 'auto' && jyPlainSafe(s)) return s;
    return quoted(s);
  }

  function keyText(k) {
    // << を素で書くとマージ指示になるので、データとしてのキーなら必ず引用符で囲む
    if (k === '<<') return quoted(k);
    if (quote === 'auto' && jyPlainSafe(k) && k.indexOf('#') === -1) return k;
    return quoted(k);
  }

  const out = [];

  /** head は "key:" か "-"。値の形に応じて1行で書くか、下へ続けるかを決める */
  function writeEntry(head, v, level, isSeq) {
    const ind = pad.repeat(level);
    if (Array.isArray(v)) {
      if (!v.length) {
        out.push(ind + head + ' []');
        return;
      }
      if (isSeq) {
        pushCompact(ind, v, true);
        return;
      }
      out.push(ind + head);
      writeSeq(v, level + 1);
      return;
    }
    if (jyIsPlainObject(v)) {
      const keys = Object.keys(v);
      if (!keys.length) {
        out.push(ind + head + ' {}');
        return;
      }
      if (isSeq) {
        pushCompact(ind, v, false);
        return;
      }
      out.push(ind + head);
      writeMap(v, level + 1);
      return;
    }
    if (typeof v === 'string' && blockSafe(v)) {
      // 末尾に改行が無ければ |- 、1つだけなら |（余分な改行を足さない・削らない）
      out.push(ind + head + ' ' + (/\n$/.test(v) ? '|' : '|-'));
      const body = v.replace(/\n$/, '').split('\n');
      const inner = ind + pad;
      for (const ln of body) out.push(ln === '' ? '' : inner + ln);
      return;
    }
    const text = scalarText(v);
    if (text !== '') {
      out.push(ind + head + ' ' + text);
      return;
    }
    // null を空欄で書く設定でも、シーケンスの「- 」だけの行は次の行との切れ目が
    // 読み手にもパーサにも曖昧になるので、要素のときは必ず null と書く
    out.push(isSeq ? ind + head + ' null' : ind + head);
  }

  /** 「- 」に続けて入れ子を書く（- name: a のコンパクト記法） */
  function pushCompact(ind, v, isArray) {
    const sub = [];
    const saved = out.length;
    if (isArray) writeSeq(v, 0);
    else writeMap(v, 0);
    for (let k = saved; k < out.length; k++) sub.push(out[k]);
    out.length = saved;
    out.push(ind + '- ' + sub[0]);
    for (let k = 1; k < sub.length; k++) out.push(sub[k] === '' ? '' : ind + '  ' + sub[k]);
  }

  function writeMap(obj, level) {
    const keys = sortKeys ? Object.keys(obj).sort() : Object.keys(obj);
    for (const k of keys) writeEntry(keyText(k) + ':', obj[k], level, false);
  }

  function writeSeq(arr, level) {
    for (const v of arr) writeEntry('-', v, level, true);
  }

  if (o.docStart) out.push('---');
  if (Array.isArray(value)) {
    if (!value.length) out.push('[]');
    else writeSeq(value, 0);
  } else if (jyIsPlainObject(value)) {
    if (!Object.keys(value).length) out.push('{}');
    else writeMap(value, 0);
  } else if (typeof value === 'string' && blockSafe(value)) {
    out.push(/\n$/.test(value) ? '|' : '|-');
    for (const ln of value.replace(/\n$/, '').split('\n')) out.push(ln === '' ? '' : pad + ln);
  } else {
    out.push(scalarText(value));
  }
  return out.join('\n') + '\n';
}

/* ---------------------------------------------------------------------------
 * 統計・エラー位置の抜き出し・変換の入口
 * ------------------------------------------------------------------------- */

const jyByteLength = (s) => (typeof TextEncoder === 'function' ? new TextEncoder().encode(s).length : Buffer.byteLength(s, 'utf8'));

/** 変換結果の規模を数える（キー数・最大の入れ子の深さなど） */
function jyStats(value) {
  const s = { nodes: 0, keys: 0, objects: 0, arrays: 0, scalars: 0, max_depth: 0, non_finite: 0 };
  (function walk(v, d) {
    s.nodes += 1;
    if (d > s.max_depth) s.max_depth = d;
    if (Array.isArray(v)) {
      s.arrays += 1;
      for (const item of v) walk(item, d + 1);
      return;
    }
    if (jyIsPlainObject(v)) {
      s.objects += 1;
      const keys = Object.keys(v);
      s.keys += keys.length;
      for (const k of keys) walk(v[k], d + 1);
      return;
    }
    s.scalars += 1;
    if (typeof v === 'number' && !Number.isFinite(v)) s.non_finite += 1;
  })(value, 1);
  return s;
}

/** エラー行の前後を切り出す（画面ではこれをそのままハイライト表示に使う） */
function jyExcerpt(text, line, col, span) {
  const all = String(text).replace(/\r\n?/g, '\n').split('\n');
  if (all.length > 1 && all[all.length - 1] === '') all.pop();   // 末尾の改行が作る空行は数えない
  const from = Math.max(1, line - 2);
  const to = Math.min(all.length, line + 2);
  const rows = [];
  for (let n = from; n <= to; n++) {
    rows.push({ line: n, text: all[n - 1] === undefined ? '' : all[n - 1], error: n === line });
  }
  return { rows, line, col, span: span || 1 };
}

/**
 * JSON ⇄ YAML の変換1回分。整形（json→json / yaml→yaml）も同じ入口で扱う。
 *
 * @param {object} opts
 * @param {'json2yaml'|'yaml2json'|'json2json'|'yaml2yaml'} [opts.direction='json2yaml']
 * @param {string} opts.text
 * @param {boolean}[opts.relaxed=true] JSON入力でコメント・末尾カンマ等を受け取る
 * 出力オプションは jyFormatYaml / jyFormatJson と共通。
 */
function jyConvert(opts) {
  const o = opts || {};
  const allowed = ['json2yaml', 'yaml2json', 'json2json', 'yaml2yaml'];
  const direction = allowed.indexOf(o.direction) === -1 ? 'json2yaml' : o.direction;
  const from = direction.slice(0, 4);
  const to = direction.slice(5);
  const text = typeof o.text === 'string' ? o.text : '';

  if (text.trim() === '') {
    return { ok: true, direction, from, to, empty: true, output: '', notes: [], stats: null, documents: 0 };
  }

  const parsed = from === 'json' ? jyParseJson(text, o) : jyParseYaml(text);
  if (!parsed.ok) {
    return {
      ok: false,
      direction,
      from,
      to,
      error: parsed.error,
      excerpt: jyExcerpt(text, parsed.error.line, parsed.error.col, parsed.error.found ? String(parsed.error.found).length : 1),
      notes: parsed.notes,
    };
  }

  const value = parsed.value;
  const stats = jyStats(value);
  const notes = parsed.notes.slice();
  if (to === 'json' && stats.non_finite > 0) {
    notes.push({ code: 'NONFINITE_OUTPUT', level: 'warn', count: stats.non_finite, items: [], lines: [] });
  }
  const output = to === 'yaml' ? jyFormatYaml(value, o) : jyFormatJson(value, o) + '\n';

  return {
    ok: true,
    direction,
    from,
    to,
    output,
    value,
    documents: from === 'yaml' ? parsed.docs.length : 1,
    input_bytes: jyByteLength(text),
    output_bytes: jyByteLength(output),
    input_lines: text.replace(/\n$/, '').split('\n').length,
    output_lines: output.replace(/\n$/, '').split('\n').length,
    stats,
    notes,
  };
}

/* ==================== ここまで変換コア ==================== */

/* ---------------------------------------------------------------------------
 * MCPの入口
 * ------------------------------------------------------------------------- */

// 構文エラーの説明（サイト側は同じコードを日英で出し分けている。ここは日本語のみ）
const ERROR_TEXT = {
  EMPTY_INPUT: () => '入力が空です。',
  TOO_DEEP: () => '入れ子が深すぎます（200段まで）。',
  JSON_UNEXPECTED_END: () => '入力が途中で終わっています。閉じ括弧が足りていないか確認してください。',
  JSON_TRAILING_DATA: (e) => `JSONの値の後ろに余分な文字があります（${e.found}）。JSONに書けるのは1つの値だけです。`,
  JSON_VALUE_EXPECTED: (e) => `値が必要な位置に ${e.found} があります。`,
  JSON_KEY_EXPECTED: (e) => `キーが必要な位置に ${e.found} があります。キーは "…" で囲みます。`,
  JSON_COLON_EXPECTED: (e) => `キーの後ろに : が必要です（見つかったのは ${e.found}）。`,
  JSON_COMMA_EXPECTED: (e) => `区切りの , か閉じ括弧が必要です（見つかったのは ${e.found}）。`,
  JSON_UNTERMINATED_STRING: (e) => `文字列が ${e.found} で閉じられていません。`,
  JSON_UNTERMINATED_COMMENT: () => 'コメント /* が */ で閉じられていません。',
  JSON_BAD_ESCAPE: (e) => `文字列の中で使えないエスケープです（${e.found}）。`,
  JSON_BAD_TOKEN: (e) => `JSONの値として読めません（${e.found}）。文字列なら "…" で囲んでください。`,
  JSON_RAW_CONTROL: (e) => `文字列の中に生の制御文字（${e.found}）があります。\\n や \\t のように書いてください。`,
  JSON_TRAILING_COMMA: () => '最後の要素の後ろにカンマがあります。JSONでは書けません。',
  JSON_SINGLE_QUOTE: () => "JSONの文字列は ' ではなく \" で囲みます。",
  JSON_UNQUOTED_KEY: (e) => `キーを "…" で囲んでください（${e.found}）。`,
  JSON_COMMENT: () => 'JSONにコメントは書けません。',
  TAB_INDENT: () => 'インデントにタブが使われています。YAMLはタブでの字下げを認めていないので、半角スペースに置き換えてください。',
  YAML_BAD_INDENT: (e) => `インデントが揃っていません（${e.found}）。同じ階層の行は桁を合わせてください。`,
  YAML_SEQ_IN_MAP: () => 'キーが並ぶ位置に「- 」があります。マップとシーケンスは同じ階層に混ぜられません。',
  YAML_KEY_EXPECTED: (e) => `「キー: 値」の形になっていません（${e.found}）。値の後ろには : が必要です。`,
  YAML_EXPLICIT_KEY: () => '「? キー」という明示キーの書き方には対応していません（JSONのキーは文字列だけなので、通常の「キー: 値」に書き換えてください）。',
  YAML_VALUE_THEN_BLOCK: (e) => `値を書いた行の下に、より深い行が続いています（${e.found}）。上の行の値を消すか、この行のインデントを浅くしてください。`,
  YAML_NESTED_COLON: (e) => `1行に「キー: 値」が2つあります（${e.found}）。値に「: 」を含めるなら "…" で囲んでください。`,
  YAML_SEQ_INLINE: (e) => `「- 」で始まる要素は次の行から書きます（${e.found}）。1行に収めるなら [a, b] の形にしてください。`,
  YAML_UNTERMINATED_QUOTE: (e) => `引用符 ${e.found} が閉じられていません。`,
  YAML_BAD_ESCAPE: (e) => `"…" の中で使えないエスケープです（${e.found}）。`,
  YAML_UNTERMINATED_FLOW: () => '[ または { が閉じられていません。',
  YAML_FLOW_SEP: (e) => `[ ] { } の中の区切りが不正です（${e.found}）。要素は , で区切ります。`,
  YAML_FLOW_COLON: (e) => `{ } の中でキーの後ろに : がありません（${e.found}）。`,
  YAML_ALIAS_NOT_FOUND: (e) => `参照先のアンカーがありません（${e.found}）。*.js のように * で始まる値は "…" で囲んでください。`,
  YAML_ALIAS_TRAILING: (e) => `エイリアスの後ろに余分な文字があります（${e.found}）。`,
  YAML_TRAILING_TEXT: (e) => `引用符や [ ] { } の後ろに余分な文字があります（${e.found}）。`,
  YAML_BLOCK_HEADER: (e) => `ブロックスカラー（| や >）の指定が読めません（${e.found}）。書けるのは chomping（- +）とインデント（1-9）だけです。`,
  YAML_BLOCK_INDENT: () => '| や > の中身のインデントが揃っていません。最初の行より浅い行は書けません。',
  YAML_BAD_TAG_VALUE: (e) => `タグの型に合わない値です（${e.found}）。`,
  YAML_INTERNAL: () => '解析が進まなくなりました。書き方を単純にしてお試しください。',
};

// 指摘事項（構文としては通るが、読み替えで意味が変わりうるもの）の説明
const NOTE_TEXT = {
  DUPLICATE_KEY: (n) => `同じキーが重なっています（${n.items.join(' / ')}）。最後に書いた値だけが残ります。`,
  NUMBER_PRECISION: (n) => `${n.items.join(' / ')} は倍精度小数で正確に表せない大きさです。桁が落ちるので、IDなら "…" で囲んで文字列にしてください。`,
  NONFINITE_OUTPUT: (n) => `.inf / .nan はJSONに無い値なので null にしました（${n.count}件）。`,
  MULTI_DOC: (n) => `--- で区切られた${n.count}個のドキュメントを、JSONの配列1つにまとめました。`,
  JSON_COMMENT: (n) => `コメントが${n.count}箇所あります。JSONの仕様には無いので、読み飛ばして変換しました（YAMLにはコメントを書けます）。`,
  JSON_TRAILING_COMMA: (n) => `最後の要素の後ろのカンマが${n.count}箇所あります。JSONとしては不正なので、無いものとして解釈しました。`,
  JSON_SINGLE_QUOTE: (n) => `シングルクォートの文字列が${n.count}箇所あります。JSONでは " を使います。`,
  JSON_UNQUOTED_KEY: (n) => `引用符の無いキーがあります（${n.items.join(' / ')}）。JSONでは "…" で囲みます。`,
  JSON_RELAXED_NUMBER: (n) => `JSONの数値としては不正な書き方です（${n.items.join(' / ')}）。読める形に解釈しました。`,
  JSON_RAW_CONTROL: (n) => `文字列の中に生の制御文字があります（${n.items.join(' / ')}）。`,
  JSON_NONFINITE: (n) => `NaN / Infinity はJSONに無い値です（${n.items.join(' / ')}）。`,
  YAML_LEADING_ZERO: (n) => `${n.items.join(' / ')} は先頭の0を無視した10進の数値になります。パーミッションや電話番号なら "…" で囲んで文字列にしてください。`,
  YAML11_BOOL: (n) => `${n.items.join(' / ')} はYAML 1.2では文字列ですが、YAML 1.1のパーサ（PyYAMLなど）では真偽値になります。文字列として渡すなら "…" で囲むと安全です。`,
  YAML_TIMESTAMP: (n) => `${n.items.join(' / ')} は日付に見えます。ここでは文字列にしていますが、日時型として読むパーサもあります。`,
  YAML_SEXAGESIMAL: (n) => `${n.items.join(' / ')} はYAML 1.1のパーサでは60進数の整数として読まれます（12:30 → 750）。時刻なら "…" で囲んでください。`,
  YAML_MERGE_KEY: (n) => `マージキー << を${n.count}箇所で展開しました。JSONにマージの仕組みは無いので、展開後の内容を書き出します。`,
  YAML_BAD_MERGE: (n) => `<< の参照先がマップではないため、マージできませんでした（${n.count}箇所）。`,
  YAML_NONSTRING_KEY: (n) => `文字列でないキー（${n.items.join(' / ')}）を文字列にしました。JSONのキーは文字列だけです。`,
  YAML_DIRECTIVE: (n) => `ディレクティブ（${n.items.join(' / ')}）は読み飛ばしました。`,
  YAML_UNKNOWN_TAG: (n) => `知らないタグ（${n.items.join(' / ')}）は無視して、値をそのまま使いました。`,
  YAML_BINARY: (n) => `!!binary はBase64の文字列のまま渡しました（${n.count}箇所）。`,
  YAML_ALIAS_EXPANDED: () => 'エイリアス（*名前）を展開しました。JSONに参照の仕組みは無いので、同じ内容が複製されます。',
};

export class JsonYamlError extends Error {}

/** エラーの位置を、行番号つきの抜き出しと ^ で示す文字列にする */
function excerptText(excerpt) {
  if (!excerpt) return '';
  const width = String(excerpt.rows[excerpt.rows.length - 1].line).length;
  const out = [];
  for (const row of excerpt.rows) {
    const shown = row.text.replace(/\t/g, '→   ');
    out.push(`  ${String(row.line).padStart(width, ' ')} | ${shown}`);
    if (row.error) {
      const before = row.text.slice(0, Math.max(0, excerpt.col - 1)).replace(/\t/g, '→   ');
      out.push(`  ${' '.repeat(width)} | ${' '.repeat(before.length)}^`);
    }
  }
  return out.join('\n');
}

/**
 * JSON ⇄ YAML の変換1回分（MCPの入口の中身）。
 * 構文エラーは JsonYamlError として投げる（行・桁・原因・抜き出しをメッセージに含める）。
 */
async function convert(direction, opts) {
  const o = opts || {};
  const hasText = typeof o.text === 'string';
  if (hasText === Boolean(o.path)) throw new JsonYamlError('text か path のどちらか一方を渡してください');
  if (o.indent !== undefined && o.indent !== 'tab' && !(Number.isInteger(Number(o.indent)) && Number(o.indent) >= 0 && Number(o.indent) <= 8)) {
    throw new JsonYamlError(`indent は 0-8 の整数か "tab": ${o.indent}`);
  }
  if (o.quote && ['auto', 'single', 'double'].indexOf(o.quote) === -1) {
    throw new JsonYamlError(`quote は auto / single / double: ${o.quote}`);
  }
  if (o.nullStyle && ['null', 'tilde', 'empty'].indexOf(o.nullStyle) === -1) {
    throw new JsonYamlError(`nullStyle は null / tilde / empty: ${o.nullStyle}`);
  }

  const input = hasText ? o.text : await readFile(o.path, 'utf8');
  const r = jyConvert({ ...o, direction, text: input });

  if (!r.ok) {
    const fn = ERROR_TEXT[r.error.code];
    const where = `${r.error.line}行 ${r.error.col}桁`;
    const what = fn ? fn(r.error) : r.error.code;
    const body = excerptText(r.excerpt);
    throw new JsonYamlError(
      `${r.from === 'json' ? 'JSON' : 'YAML'}の構文エラー（${r.error.code}）: ${where}: ${what}${body ? '\n' + body : ''}`,
    );
  }

  const result = {
    direction: r.direction,
    from: r.from,
    to: r.to,
    source: hasText ? { type: 'text' } : { path: o.path, name: basename(o.path) },
    empty: Boolean(r.empty),
    text: r.output,
    input_bytes: r.empty ? 0 : r.input_bytes,
    output_bytes: r.empty ? 0 : r.output_bytes,
    input_lines: r.empty ? 0 : r.input_lines,
    output_lines: r.empty ? 0 : r.output_lines,
    documents: r.documents,
    stats: r.stats,
    options: r.to === 'yaml'
      ? {
        indent: Number(o.indent) || 2,
        quote: o.quote || 'auto',
        null_style: o.nullStyle || 'null',
        block: o.block !== false,
        sort_keys: Boolean(o.sortKeys),
        doc_start: Boolean(o.docStart),
      }
      : {
        indent: o.indent === undefined ? 2 : o.indent === 'tab' ? 'tab' : Number(o.indent),
        sort_keys: Boolean(o.sortKeys),
        ascii: Boolean(o.ascii),
      },
    notes: (r.notes || []).map((n) => ({
      code: n.code,
      level: n.level,
      count: n.count,
      lines: n.lines,
      message: NOTE_TEXT[n.code] ? NOTE_TEXT[n.code](n) : n.code,
    })),
  };

  if (o.outputPath) {
    await writeFile(o.outputPath, r.output, 'utf8');
    result.output = o.outputPath;
    // ファイルに書けたなら本文は重複した重い情報でしかない
    delete result.text;
  }
  return result;
}

/**
 * JSON（またはUTF-8のJSONファイル）をYAMLへ変換して整形する。
 *
 * @param {object} opts
 * @param {string} [opts.text]        変換するJSON（path と排他）
 * @param {string} [opts.path]        変換するJSONファイルの絶対パス（text と排他）
 * @param {string} [opts.outputPath]  結果を書き出す絶対パス（指定すると text は返さない）
 * @param {number} [opts.indent=2]    YAMLのインデント幅（1-8）
 * @param {'auto'|'single'|'double'} [opts.quote='auto'] 引用符の付け方
 * @param {'null'|'tilde'|'empty'} [opts.nullStyle='null'] null の書き方
 * @param {boolean}[opts.block=true]  改行を含む文字列をブロックスカラー（|）で書く
 * @param {boolean}[opts.sortKeys=false] キーを名前順に並べる
 * @param {boolean}[opts.docStart=false] 先頭に --- を付ける
 * @param {boolean}[opts.relaxed=true] コメント・末尾カンマ等を含むJSONも読む
 */
export function jsonToYaml(opts = {}) {
  return convert('json2yaml', opts);
}

/**
 * YAML（またはUTF-8のYAMLファイル）をJSONへ変換する。構文チェックにも使える。
 *
 * @param {object} opts
 * @param {string} [opts.text]        変換するYAML（path と排他）
 * @param {string} [opts.path]        変換するYAMLファイルの絶対パス（text と排他）
 * @param {string} [opts.outputPath]  結果を書き出す絶対パス（指定すると text は返さない）
 * @param {number|'tab'} [opts.indent=2] JSONのインデント（0 で1行にまとめる）
 * @param {boolean}[opts.sortKeys=false] キーを名前順に並べる
 * @param {boolean}[opts.ascii=false] 非ASCII文字を \\uXXXX にする
 */
export function yamlToJson(opts = {}) {
  return convert('yaml2json', opts);
}

/** JSONをJSONのまま整形する（インデントの付け替え・キーの並べ替え） */
export function formatJsonFile(opts = {}) {
  return convert('json2json', opts);
}

/** YAMLをYAMLのまま整形する（インデント・引用符の正規化） */
export function formatYamlFile(opts = {}) {
  return convert('yaml2yaml', opts);
}

export {
  jyParseJson as parseJson,
  jyParseYaml as parseYaml,
  jyFormatJson as formatJson,
  jyFormatYaml as formatYaml,
  jyConvert as jsonYamlConvert,
  jyResolveScalar as resolveYamlScalar,
  jyPlainSafe as yamlPlainSafe,
};
