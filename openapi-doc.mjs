/* OpenAPI → 日本語ドキュメント＆TypeScript型定義（openapi_doc_generate）
 * tools.first-ch.com/openapi-doc-gen/ と同一ロジック。
 * 変換コアの開始コメントから oaFileBase の終わりまでは FirstCHTools の site/openapi-doc-gen/core.js と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。次の diff が空なら同期している
 * （site側は末尾の export { … } を落として字下げ2文字を落とす・こちらは写しの終わりの目印の手前まで）:
 *   S=…/FirstCHTools/site/openapi-doc-gen/core.js
 *   diff <(sed -n '/^  \/\* =* ここから変換コア/,/^export {/p' $S | sed '$d' | sed 's/^  //') \
 *        <(sed -n '/^\/\* =* ここから変換コア/,/^\/\* =* ここまで site/p' openapi-doc.mjs | sed '$d' | sed '$d')
 *
 * YAML・JSON のパーサ（変換コア）は json-yaml.mjs と中身がほぼ同じだが、import せずに写しを持つ。
 * 違いが jyParseYaml の内側の1行（プレーンスカラーの折り返し行が「- 」で始まっても続きの文として読む）で、
 * 変換コアは関数の外から挙動を切り替える口を持たないため、json-yaml.mjs の挙動（json_to_yaml / yaml_to_json は
 * 書き損じとしてエラーにする）を変えずに共有する方法が無い。site 側も同じ理由で core.js に写しを持っている。
 * site 側の CI（tests/openapi-doc-gen.test.mjs）が /json-yaml/ との「1行を除いた一致」を確かめているので、
 * site/openapi-doc-gen/core.js と一致していれば json-yaml.mjs とも1行差で揃う。
 *
 * 外部ライブラリなし。完全ローカル処理・ネットワーク送信なし（別ファイル・URLを指す $ref も読みに行かない）。 */

import { readFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';
import { writeOutput } from './fs-safe.mjs';

// 「ここから変換コア」〜「ここまで変換コア」は /json-yaml/app.js の同じ範囲（YAML・JSON の自前パーサ）を
// 写したもの。向こうを直したらこちらにも写し直す（tests/openapi-doc-gen.test.mjs が一致を確かめる）。
// 違いは1行だけ: プレーンスカラーの折り返し行が「- 」で始まっても続きの文として読む（YAML の仕様どおり）。
// /json-yaml/ は書き損じを黙って通さないためにここをエラーにしているが、実在の仕様書の description
// （GitHub の REST API 仕様など）はこの書き方を普通に使うので、こちらでは読めないと困る。
/* eslint-disable no-unused-vars */

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
      if (splitKey(body)) fail('YAML_VALUE_THEN_BLOCK', L2.n, L2.indent + 1, body.slice(0, 24));
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

/* ==================== OpenAPI → 日本語ドキュメント / TypeScript 型定義 ==================== */

const OA_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'];
const oaOwn = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const oaStr = (v) => (typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : '');

// 1回の生成で schema を辿る回数の上限。YAML のエイリアスは同じ物を共有したまま展開されるため、
// 入れ子にしたエイリアスで出力が指数的に膨らむ入力を途中で止める。
const OA_MAX_VISITS = 20000000;
// 型の式1つの長さの上限（文字数）。共有されたエイリアスは回数より先に文字列の長さで膨らむので、こちらでも止める
const OA_MAX_TYPE_CHARS = 4000000;
function oaTooLarge() {
  const e = new Error('OA_TOO_LARGE');
  e.oa = { code: 'OA_TOO_LARGE' };
  throw e;
}
// インラインの入れ子（$ref を挟まない object の中の object）を型として書き出す深さの上限
const OA_MAX_INLINE_DEPTH = 24;

// 指摘の重さ（warn = 出力が仕様どおりにならない所がある / info = 知っておくと良い）
const OA_NOTE_LEVEL = {
  OA_MULTI_DOC: 'info',
  OA_EXTERNAL_REF: 'warn',
  OA_BROKEN_REF: 'warn',
  OA_DUP_OPERATION_ID: 'warn',
  OA_NO_PATHS: 'info',
  OA_RENAMED_TYPE: 'info',
  OA_VERSION_UNKNOWN: 'warn',
  OA_JSON_RELAXED: 'info',
};

function oaNotes() {
  const list = [];
  const byCode = Object.create(null);
  return {
    list,
    add(code, item) {
      let n = byCode[code];
      if (!n) {
        n = { code, level: OA_NOTE_LEVEL[code] || 'warn', count: 0, items: [] };
        byCode[code] = n;
        list.push(n);
      }
      n.count += 1;
      if (item !== undefined && item !== null && n.items.length < 6 && n.items.indexOf(item) === -1) n.items.push(item);
      return n;
    },
  };
}

/**
 * 文字列を OpenAPI / Swagger の仕様として読む。先頭が { か [ なら JSON、それ以外は YAML。
 * 返り値: { ok, spec, version, kind: 'openapi3'|'swagger2', format, notes } か { ok:false, error, excerpt }
 */
function oaParse(text) {
  const src = typeof text === 'string' ? text : '';
  const N = oaNotes();
  if (src.trim() === '') return { ok: false, error: { code: 'EMPTY_INPUT', line: 1, col: 1 }, notes: [] };
  const head = src.replace(/^﻿/, '').replace(/^\s+/, '').charAt(0);
  const format = head === '{' || head === '[' ? 'json' : 'yaml';
  const parsed = format === 'json' ? jyParseJson(src, { relaxed: true }) : jyParseYaml(src);
  if (!parsed.ok) {
    const e = parsed.error;
    return { ok: false, format, error: e, excerpt: jyExcerpt(src, e.line, e.col, e.found ? String(e.found).length : 1), notes: [] };
  }
  if (format === 'json' && parsed.notes.some((n) => /^JSON_/.test(n.code))) N.add('OA_JSON_RELAXED');
  let spec = parsed.value;
  if (format === 'yaml' && parsed.docs && parsed.docs.length > 1) {
    spec = parsed.docs[0];
    N.add('OA_MULTI_DOC');
  }
  if (!jyIsPlainObject(spec)) return { ok: false, format, error: { code: 'OA_NOT_OBJECT', line: 1, col: 1 }, notes: N.list };
  let kind = null;
  let version = '';
  if (oaOwn(spec, 'openapi')) {
    version = oaStr(spec.openapi);
    kind = 'openapi3';
    if (!/^3\./.test(version)) N.add('OA_VERSION_UNKNOWN', version || '?');
  } else if (oaOwn(spec, 'swagger')) {
    version = oaStr(spec.swagger);
    kind = 'swagger2';
    if (!/^2(\.0)?$/.test(version)) N.add('OA_VERSION_UNKNOWN', version || '?');
  } else {
    return { ok: false, format, error: { code: 'OA_NOT_SPEC', line: 1, col: 1 }, notes: N.list };
  }
  return { ok: true, spec, kind, version, format, notes: N.list };
}

/* ---------------------------------------------------------------------------
 * 仕様の読み取り（Swagger 2.0 も OpenAPI 3 と同じ形の内部モデルへ揃える）
 * ------------------------------------------------------------------------- */

/** JSON Pointer（#/components/schemas/Pet）を辿る。見つからなければ undefined */
function oaPointer(root, ref) {
  if (ref === '#') return root;
  if (ref.slice(0, 2) !== '#/') return undefined;
  let cur = root;
  for (const raw of ref.slice(2).split('/')) {
    let key = raw.replace(/~1/g, '/').replace(/~0/g, '~');
    try { key = decodeURIComponent(key); } catch (e) { /* % を含むキーはそのまま */ }
    if (Array.isArray(cur)) {
      if (!/^(0|[1-9][0-9]*)$/.test(key) || Number(key) >= cur.length) return undefined;
      cur = cur[Number(key)];
    } else if (oaOwn(cur, key)) {
      cur = cur[key];
    } else {
      return undefined;
    }
  }
  return cur;
}

const OA_TS_RESERVED = new Set(('any unknown never object string number boolean symbol bigint void null undefined ' +
  'break case catch class const continue debugger default delete do else enum export extends false finally for ' +
  'function if import in instanceof new return super switch this throw true try typeof var while with ' +
  'implements interface let package private protected public static yield type as await ' +
  'Record Partial Required Readonly Pick Omit Array Object String Number Boolean Date Promise Map Set Blob File Error').split(' '));

/** 名前を TypeScript の型名（PascalCase）へ。英数字以外は区切りとみなす */
function oaPascal(name) {
  const parts = String(name).split(/[^\p{L}\p{N}_$]+/u).filter(Boolean);
  let s = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1)).join('');
  if (s === '') s = 'Schema';
  if (/^\p{N}/u.test(s)) s = '_' + s;
  return s;
}

/** プロパティ名。識別子として書けないものは引用符で囲む */
function oaPropKey(k) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k) ? k : JSON.stringify(k);
}

/**
 * 仕様全体を、ドキュメントと型定義の両方が使う形へ読み替える。
 * @param {object} spec  oaParse が返した spec
 * @param {'openapi3'|'swagger2'} kind
 */
function oaModel(spec, kind) {
  const N = oaNotes();
  const v2 = kind === 'swagger2';
  let visits = 0;
  const tick = () => {
    visits += 1;
    if (visits > OA_MAX_VISITS) oaTooLarge();
  };

  /** $ref を辿りきった実体を返す（循環・外部参照・壊れた参照は null） */
  function deref(node) {
    let cur = node;
    for (let hop = 0; hop < 32; hop++) {
      if (!jyIsPlainObject(cur) || typeof cur.$ref !== 'string') return cur;
      const ref = cur.$ref;
      if (ref.charAt(0) !== '#') {
        N.add('OA_EXTERNAL_REF', ref);
        return null;
      }
      const next = oaPointer(spec, ref);
      if (next === undefined) {
        N.add('OA_BROKEN_REF', ref);
        return null;
      }
      cur = next;
    }
    return null;
  }

  // 名前の付いたスキーマ（components.schemas / definitions）
  const schemaPrefix = v2 ? '#/definitions/' : '#/components/schemas/';
  const schemaRoot = v2 ? spec.definitions : jyIsPlainObject(spec.components) ? spec.components.schemas : undefined;
  const schemas = [];
  const byRef = new Map();
  const usedTs = new Set();
  if (jyIsPlainObject(schemaRoot)) {
    for (const name of Object.keys(schemaRoot)) {
      // pet → Pet のような書き換えは黙って行い、予約語・重複を避けて名前を変えたときだけ知らせる
      let ts = oaPascal(name);
      const plain = ts;
      if (OA_TS_RESERVED.has(ts)) ts += 'Schema';
      let k = 2;
      const base = ts;
      while (usedTs.has(ts)) ts = base + k++;
      usedTs.add(ts);
      if (ts !== plain) N.add('OA_RENAMED_TYPE', `${name} → ${ts}`);
      const ref = schemaPrefix + name.replace(/~/g, '~0').replace(/\//g, '~1');
      const entry = { name, ts, ref, schema: schemaRoot[name] };
      schemas.push(entry);
      byRef.set(ref, entry);
    }
  }
  /** $ref が名前付きスキーマを指していればその項目（%エンコードされた参照も拾う） */
  function named(ref) {
    if (byRef.has(ref)) return byRef.get(ref);
    if (ref.indexOf('%') !== -1) {
      try { return byRef.get(decodeURIComponent(ref)) || null; } catch (e) { return null; }
    }
    return null;
  }

  const info = jyIsPlainObject(spec.info) ? spec.info : {};

  // サーバー（ベースURL）
  const servers = [];
  if (v2) {
    if (typeof spec.host === 'string' && spec.host) {
      const schemes = Array.isArray(spec.schemes) && spec.schemes.length ? spec.schemes : ['https'];
      for (const s of schemes) servers.push({ url: `${oaStr(s)}://${spec.host}${oaStr(spec.basePath)}`, description: '' });
    } else if (typeof spec.basePath === 'string' && spec.basePath) {
      servers.push({ url: spec.basePath, description: '' });
    }
  } else if (Array.isArray(spec.servers)) {
    for (const s of spec.servers) {
      if (jyIsPlainObject(s) && typeof s.url === 'string') servers.push({ url: s.url, description: oaStr(s.description) });
    }
  }

  // 認証方式
  const security = [];
  const secRoot = v2 ? spec.securityDefinitions : jyIsPlainObject(spec.components) ? spec.components.securitySchemes : undefined;
  if (jyIsPlainObject(secRoot)) {
    for (const name of Object.keys(secRoot)) {
      const s = deref(secRoot[name]);
      if (!jyIsPlainObject(s)) continue;
      security.push({
        name,
        type: oaStr(s.type),
        scheme: oaStr(s.scheme),
        bearerFormat: oaStr(s.bearerFormat),
        in: oaStr(s.in),
        paramName: oaStr(s.name),
        flow: oaStr(s.flow) || (jyIsPlainObject(s.flows) ? Object.keys(s.flows).join(', ') : ''),
        openIdConnectUrl: oaStr(s.openIdConnectUrl),
        description: oaStr(s.description),
      });
    }
  }
  const globalSecurity = Array.isArray(spec.security) ? spec.security : null;
  const secNames = (list) => {
    if (!Array.isArray(list)) return null;
    const out = [];
    for (const req of list) if (jyIsPlainObject(req)) for (const k of Object.keys(req)) if (out.indexOf(k) === -1) out.push(k);
    return out;
  };

  const globalConsumes = Array.isArray(spec.consumes) ? spec.consumes.filter((x) => typeof x === 'string') : [];
  const globalProduces = Array.isArray(spec.produces) ? spec.produces.filter((x) => typeof x === 'string') : [];

  /** Swagger 2.0 の非 body パラメータ（type 等を直に持つ）を schema の形へ */
  function v2ParamSchema(p) {
    if (jyIsPlainObject(p.schema)) return p.schema;
    const s = {};
    for (const k of ['type', 'format', 'items', 'enum', 'default', 'minimum', 'maximum', 'pattern', 'minLength', 'maxLength']) {
      if (oaOwn(p, k)) s[k] = p[k];
    }
    if (s.type === 'file') {
      s.type = 'string';
      s.format = 'binary';
    }
    return s;
  }

  /** パラメータの並び（パス共通 + 操作ごと。同じ name+in は操作側が勝つ） */
  function mergeParams(shared, own) {
    const map = new Map();
    for (const list of [shared, own]) {
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const p = deref(raw);
        if (!jyIsPlainObject(p) || typeof p.name !== 'string') continue;
        map.set(`${oaStr(p.in)}\u0000${p.name}`, p);
      }
    }
    return Array.from(map.values());
  }

  /** media type の例（example → examples の最初 → schema.example の順） */
  function mediaExample(media, schema) {
    if (oaOwn(media, 'example')) return { has: true, value: media.example };
    if (jyIsPlainObject(media.examples)) {
      for (const k of Object.keys(media.examples)) {
        const ex = deref(media.examples[k]);
        if (jyIsPlainObject(ex) && oaOwn(ex, 'value')) return { has: true, value: ex.value };
      }
    }
    const s = deref(schema);
    if (jyIsPlainObject(s) && oaOwn(s, 'example')) return { has: true, value: s.example };
    return { has: false };
  }

  function contentsOf(content) {
    const out = [];
    if (!jyIsPlainObject(content)) return out;
    for (const type of Object.keys(content)) {
      const media = jyIsPlainObject(content[type]) ? content[type] : {};
      const schema = oaOwn(media, 'schema') ? media.schema : null;
      out.push({ type, schema, example: mediaExample(media, schema) });
    }
    return out;
  }

  const operations = [];
  const tagOrder = [];
  const tagInfo = new Map();
  if (Array.isArray(spec.tags)) {
    for (const t of spec.tags) {
      if (jyIsPlainObject(t) && typeof t.name === 'string' && !tagInfo.has(t.name)) {
        tagOrder.push(t.name);
        tagInfo.set(t.name, oaStr(t.description));
      }
    }
  }
  const seenOpIds = new Set();
  const paths = jyIsPlainObject(spec.paths) ? spec.paths : null;
  if (!paths || Object.keys(paths).filter((k) => k.slice(0, 2) !== 'x-').length === 0) N.add('OA_NO_PATHS');
  if (paths) {
    for (const path of Object.keys(paths)) {
      if (path.slice(0, 2) === 'x-') continue;
      const item = deref(paths[path]);
      if (!jyIsPlainObject(item)) continue;
      for (const method of OA_METHODS) {
        if (!jyIsPlainObject(item[method])) continue;
        tick();
        const op = item[method];
        const params = [];
        let body = null;
        const formProps = {};
        const formRequired = [];
        for (const p of mergeParams(item.parameters, op.parameters)) {
          const where = oaStr(p.in);
          if (v2 && where === 'body') {
            const types = Array.isArray(op.consumes) && op.consumes.length ? op.consumes : globalConsumes.length ? globalConsumes : ['application/json'];
            body = {
              required: p.required === true,
              description: oaStr(p.description),
              contents: types.filter((t) => typeof t === 'string').slice(0, 1).map((type) => ({ type, schema: p.schema || null, example: mediaExample({}, p.schema) })),
            };
            continue;
          }
          if (v2 && where === 'formData') {
            formProps[p.name] = Object.assign({}, v2ParamSchema(p), p.description ? { description: oaStr(p.description) } : {});
            if (p.required === true) formRequired.push(p.name);
            continue;
          }
          params.push({
            name: p.name,
            in: where,
            required: p.required === true || where === 'path',
            description: oaStr(p.description),
            deprecated: p.deprecated === true,
            schema: v2 ? v2ParamSchema(p) : jyIsPlainObject(p.schema) ? p.schema : p.content && jyIsPlainObject(p.content) ? (contentsOf(p.content)[0] || {}).schema || null : null,
            example: oaOwn(p, 'example') ? { has: true, value: p.example } : { has: false },
          });
        }
        if (v2 && Object.keys(formProps).length) {
          const consumes = Array.isArray(op.consumes) && op.consumes.length ? op.consumes : globalConsumes;
          const hasFile = Object.keys(formProps).some((k) => formProps[k].format === 'binary');
          const type = consumes.find((t) => /multipart|urlencoded/.test(t)) || (hasFile ? 'multipart/form-data' : 'application/x-www-form-urlencoded');
          const schema = { type: 'object', properties: formProps };
          if (formRequired.length) schema.required = formRequired;
          body = { required: formRequired.length > 0, description: '', contents: [{ type, schema, example: { has: false } }] };
        }
        if (!v2 && oaOwn(op, 'requestBody')) {
          const rb = deref(op.requestBody);
          if (jyIsPlainObject(rb)) body = { required: rb.required === true, description: oaStr(rb.description), contents: contentsOf(rb.content) };
        }

        const responses = [];
        if (jyIsPlainObject(op.responses)) {
          for (const status of Object.keys(op.responses)) {
            if (status.slice(0, 2) === 'x-') continue;
            const r = deref(op.responses[status]);
            if (!jyIsPlainObject(r)) {
              responses.push({ status, description: '', contents: [], headers: [] });
              continue;
            }
            let contents;
            if (v2) {
              contents = [];
              if (oaOwn(r, 'schema')) {
                const produces = Array.isArray(op.produces) && op.produces.length ? op.produces : globalProduces.length ? globalProduces : ['application/json'];
                const type = produces.find((t) => /json/.test(t)) || produces[0];
                let example = { has: false };
                if (jyIsPlainObject(r.examples)) {
                  const k = Object.keys(r.examples).find((t) => /json/.test(t)) || Object.keys(r.examples)[0];
                  if (k !== undefined) example = { has: true, value: r.examples[k] };
                }
                if (!example.has) example = mediaExample({}, r.schema);
                contents.push({ type, schema: r.schema, example });
              }
            } else {
              contents = contentsOf(r.content);
            }
            const headers = [];
            if (jyIsPlainObject(r.headers)) {
              for (const h of Object.keys(r.headers)) {
                const hd = deref(r.headers[h]);
                if (!jyIsPlainObject(hd)) continue;
                headers.push({ name: h, description: oaStr(hd.description), schema: v2 ? v2ParamSchema(hd) : hd.schema || null });
              }
            }
            responses.push({ status, description: oaStr(r.description), contents, headers });
          }
        }

        const operationId = typeof op.operationId === 'string' && op.operationId ? op.operationId : '';
        if (operationId) {
          if (seenOpIds.has(operationId)) N.add('OA_DUP_OPERATION_ID', operationId);
          seenOpIds.add(operationId);
        }
        const tags = Array.isArray(op.tags) ? op.tags.filter((t) => typeof t === 'string') : [];
        for (const t of tags) {
          if (!tagInfo.has(t)) {
            tagOrder.push(t);
            tagInfo.set(t, '');
          }
        }
        const sec = secNames(oaOwn(op, 'security') ? op.security : globalSecurity);
        operations.push({
          method,
          path,
          operationId,
          summary: oaStr(op.summary),
          description: oaStr(op.description),
          tags,
          deprecated: op.deprecated === true,
          params,
          body,
          responses,
          security: sec,
        });
      }
    }
  }

  return {
    kind,
    v2,
    spec,
    title: oaStr(info.title),
    version: oaStr(info.version),
    description: oaStr(info.description),
    servers,
    security,
    globalSecurity: secNames(globalSecurity),
    operations,
    schemas,
    tags: tagOrder.map((name) => ({ name, description: tagInfo.get(name) })),
    notes: N,
    deref,
    named,
    tick,
  };
}

/* ---------------------------------------------------------------------------
 * schema の読み方（型の表示・例の生成・TypeScript の型）
 * ------------------------------------------------------------------------- */

/** schema.type を配列にそろえる（3.1 の type: [string, "null"] と 3.0 の nullable を同じに扱う） */
function oaTypes(s) {
  let types = Array.isArray(s.type) ? s.type.filter((t) => typeof t === 'string') : typeof s.type === 'string' ? [s.type] : [];
  if (types.length === 0) {
    if (jyIsPlainObject(s.properties) || oaOwn(s, 'additionalProperties')) types = ['object'];
    else if (oaOwn(s, 'items') || Array.isArray(s.prefixItems)) types = ['array'];
  }
  const nullable = s.nullable === true || types.indexOf('null') !== -1;
  return { types: types.filter((t) => t !== 'null'), nullable };
}

/** ドキュメントの表に出す型の表記（例: Pet[] / string(date-time) / integer | null） */
function oaTypeLabel(m, schema, depth) {
  m.tick();
  const d = depth || 0;
  if (schema === true || schema === undefined || schema === null) return 'any';
  if (!jyIsPlainObject(schema)) return 'any';
  if (typeof schema.$ref === 'string') {
    const n = m.named(schema.$ref);
    if (n) return n.name;
    if (d > 8) return 'object';
    const r = m.deref(schema);
    return r ? oaTypeLabel(m, r, d + 1) : 'any';
  }
  if (d > 8) return 'object';
  if (oaOwn(schema, 'const')) return JSON.stringify(schema.const);
  const joinOf = (key, sep) => schema[key].map((x) => oaTypeLabel(m, x, d + 1)).join(sep);
  if (Array.isArray(schema.oneOf) && schema.oneOf.length) return joinOf('oneOf', ' | ');
  if (Array.isArray(schema.anyOf) && schema.anyOf.length) return joinOf('anyOf', ' | ');
  if (Array.isArray(schema.allOf) && schema.allOf.length) return schema.allOf.length === 1 ? oaTypeLabel(m, schema.allOf[0], d + 1) : joinOf('allOf', ' & ');
  const { types, nullable } = oaTypes(schema);
  const labels = types.map((t) => {
    if (t === 'array') {
      return `${oaWrap(oaTypeLabel(m, schema.items, d + 1))}[]`;
    }
    if (typeof schema.format === 'string' && schema.format) return `${t}(${schema.format})`;
    return t;
  });
  let out = labels.length ? labels.join(' | ') : Array.isArray(schema.enum) ? 'enum' : 'any';
  if (nullable) out += ' | null';
  return out;
}

/** 例の値を schema から作る（example → default → enum の先頭 → 型ごとの見本） */
function oaSample(m, schema, depth, stack) {
  m.tick();
  const d = depth || 0;
  const st = stack || [];
  if (!jyIsPlainObject(schema)) return null;
  if (typeof schema.$ref === 'string') {
    if (st.indexOf(schema.$ref) !== -1 || d > 10) return null;
    const r = m.deref(schema);
    return r ? oaSample(m, r, d + 1, st.concat(schema.$ref)) : null;
  }
  if (oaOwn(schema, 'example')) return schema.example;
  if (Array.isArray(schema.examples) && schema.examples.length) return schema.examples[0];
  if (oaOwn(schema, 'const')) return schema.const;
  if (oaOwn(schema, 'default')) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length) return schema.enum[0];
  if (d > 10) return null;
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    let merged = null;
    for (const part of schema.allOf) {
      const v = oaSample(m, part, d + 1, st);
      if (jyIsPlainObject(v)) merged = Object.assign(merged || {}, v);
      else if (merged === null && v !== null) return v;
    }
    if (jyIsPlainObject(schema.properties)) merged = Object.assign(merged || {}, oaSample(m, Object.assign({}, schema, { allOf: undefined }), d + 1, st));
    return merged;
  }
  const alt = Array.isArray(schema.oneOf) && schema.oneOf.length ? schema.oneOf : Array.isArray(schema.anyOf) && schema.anyOf.length ? schema.anyOf : null;
  if (alt) return oaSample(m, alt[0], d + 1, st);
  const { types } = oaTypes(schema);
  const t = types[0];
  if (t === 'object') {
    const out = {};
    if (jyIsPlainObject(schema.properties)) {
      for (const k of Object.keys(schema.properties)) {
        const ps = m.deref(schema.properties[k]);
        if (jyIsPlainObject(ps) && ps.writeOnly === true) continue;
        out[k] = oaSample(m, schema.properties[k], d + 1, st);
      }
    } else if (jyIsPlainObject(schema.additionalProperties)) {
      out.key = oaSample(m, schema.additionalProperties, d + 1, st);
    }
    return out;
  }
  if (t === 'array') {
    if (Array.isArray(schema.prefixItems)) return schema.prefixItems.map((x) => oaSample(m, x, d + 1, st));
    // 要素の例が作れない（循環する $ref など）ときは [null] でなく空の配列にする
    const v = oaSample(m, schema.items, d + 1, st);
    return v === null ? [] : [v];
  }
  if (t === 'integer') return typeof schema.minimum === 'number' ? Math.ceil(schema.minimum) : 0;
  if (t === 'number') return typeof schema.minimum === 'number' ? schema.minimum : 0;
  if (t === 'boolean') return true;
  if (t === 'string') {
    const f = oaStr(schema.format);
    if (f === 'date-time') return '2026-01-01T00:00:00Z';
    if (f === 'date') return '2026-01-01';
    if (f === 'time') return '12:00:00';
    if (f === 'email') return 'user@example.com';
    if (f === 'uuid') return '3fa85f64-5717-4562-b3fc-2c963f66afa6';
    if (f === 'uri' || f === 'url') return 'https://example.com';
    if (f === 'hostname') return 'example.com';
    if (f === 'ipv4') return '192.0.2.1';
    if (f === 'ipv6') return '2001:db8::1';
    if (f === 'byte') return 'U3dhZ2dlcg==';
    if (f === 'binary') return '(binary)';
    if (f === 'password') return '********';
    return 'string';
  }
  return null;
}

/** 上限つきの JSON 整形（共有されたエイリアスで巨大になる例を途中で切る） */
function oaJson(value, limit) {
  const max = limit || 20000;
  let out = '';
  let cut = false;
  (function w(v, ind) {
    if (cut) return;
    if (out.length > max) {
      cut = true;
      return;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) {
        out += '[]';
        return;
      }
      out += '[\n';
      v.forEach((x, k) => {
        out += ind + '  ';
        w(x, ind + '  ');
        if (k < v.length - 1) out += ',';
        out += '\n';
      });
      out += ind + ']';
      return;
    }
    if (jyIsPlainObject(v)) {
      const keys = Object.keys(v).filter((k) => v[k] !== undefined);
      if (keys.length === 0) {
        out += '{}';
        return;
      }
      out += '{\n';
      keys.forEach((k, n) => {
        out += ind + '  ' + JSON.stringify(k) + ': ';
        w(v[k], ind + '  ');
        if (n < keys.length - 1) out += ',';
        out += '\n';
      });
      out += ind + '}';
      return;
    }
    if (typeof v === 'number') {
      out += Number.isFinite(v) ? String(v) : 'null';
      return;
    }
    if (v === undefined) {
      out += 'null';
      return;
    }
    out += JSON.stringify(v);
  })(value, '');
  return cut ? out.slice(0, max) + '\n…' : out;
}

/** TypeScript のリテラル型 */
function oaLiteral(v) {
  if (v === null) return 'null';
  if (typeof v === 'string') return JSON.stringify(v);
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : 'number';
  if (typeof v === 'boolean') return String(v);
  return 'unknown';
}

/** JSDoc の1ブロック（説明・形式・既定値・非推奨） */
function oaDoc(s, ind) {
  if (!jyIsPlainObject(s)) return '';
  const lines = [];
  const desc = oaStr(s.description).trim() || oaStr(s.title).trim();
  if (desc) for (const l of desc.split(/\r?\n/)) lines.push(l.replace(/\s+$/, ''));
  if (typeof s.format === 'string' && s.format) lines.push(`@format ${s.format}`);
  if (oaOwn(s, 'default') && (s.default === null || typeof s.default !== 'object')) lines.push(`@default ${JSON.stringify(s.default)}`);
  if (s.deprecated === true) lines.push('@deprecated');
  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  if (lines.length === 0) return '';
  const safe = lines.map((l) => l.replace(/\*\//g, '*\\/'));
  if (safe.length === 1) return `${ind}/** ${safe[0]} */\n`;
  return `${ind}/**\n${safe.map((l) => (l ? `${ind} * ${l}` : `${ind} *`)).join('\n')}\n${ind} */\n`;
}

/** 型の式の一番外側に | か & があるか（{ } [ ] ( ) < > と引用符の中は見ない） */
function oaTopLevelOp(t) {
  let depth = 0;
  let q = '';
  for (let k = 0; k < t.length; k++) {
    const c = t.charAt(k);
    if (q) {
      if (c === '\\') k += 1;
      else if (c === q) q = '';
      continue;
    }
    if (c === '"' || c === "'") q = c;
    else if (c === '{' || c === '[' || c === '(' || c === '<') depth += 1;
    else if (c === '}' || c === ']' || c === ')' || c === '>') depth -= 1;
    else if (depth === 0 && (c === '|' || c === '&')) return true;
  }
  return false;
}
const oaWrap = (t) => (oaTopLevelOp(t) ? `(${t})` : t);

/** schema → TypeScript の型の式 */
function oaTs(m, schema, ind, depth) {
  const t = oaTsExpr(m, schema, ind, depth);
  if (t.length > OA_MAX_TYPE_CHARS) oaTooLarge();
  return t;
}

function oaTsExpr(m, schema, ind, depth) {
  m.tick();
  const d = depth || 0;
  if (schema === false) return 'never';
  if (!jyIsPlainObject(schema)) return 'unknown';
  if (typeof schema.$ref === 'string') {
    const n = m.named(schema.$ref);
    if (n) return n.ts;
    if (schema.$ref.charAt(0) !== '#') return 'unknown';
    if (d > OA_MAX_INLINE_DEPTH) return 'unknown';
    const r = m.deref(schema);
    return r === null ? 'unknown' : oaTs(m, r, ind, d + 1);
  }
  if (d > OA_MAX_INLINE_DEPTH) return 'unknown';
  const { types, nullable } = oaTypes(schema);
  const withNull = (t) => (nullable && t !== 'unknown' && !/(^|\| )null$/.test(t) ? `${t} | null` : t);
  if (oaOwn(schema, 'const')) return withNull(oaLiteral(schema.const));
  if (Array.isArray(schema.enum) && schema.enum.length) {
    const lits = [];
    for (const v of schema.enum) {
      const l = oaLiteral(v);
      if (lits.indexOf(l) === -1) lits.push(l);
    }
    return withNull(lits.join(' | '));
  }
  const comp = (list, sep) => {
    const parts = [];
    for (const x of list) {
      const t = oaTs(m, x, ind, d + 1);
      if (parts.indexOf(t) === -1) parts.push(t);
    }
    return parts.length === 1 ? parts[0] : parts.map(oaWrap).join(sep);
  };
  const hasProps = jyIsPlainObject(schema.properties) || oaOwn(schema, 'additionalProperties');
  if (Array.isArray(schema.allOf) && schema.allOf.length) {
    const parts = schema.allOf.map((x) => oaWrap(oaTs(m, x, ind, d + 1)));
    if (hasProps) parts.push(oaObject(m, schema, ind, d + 1));
    return withNull(parts.length === 1 ? parts[0] : parts.join(' & '));
  }
  const alt = Array.isArray(schema.oneOf) && schema.oneOf.length ? schema.oneOf : Array.isArray(schema.anyOf) && schema.anyOf.length ? schema.anyOf : null;
  if (alt) {
    const u = comp(alt, ' | ');
    return withNull(hasProps ? `${oaWrap(u)} & ${oaObject(m, schema, ind, d + 1)}` : u);
  }
  if (types.length === 0) return nullable && (schema.type === 'null' || Array.isArray(schema.type)) ? 'null' : 'unknown';
  const out = types.map((t) => {
    if (t === 'string') return schema.format === 'binary' ? 'Blob' : 'string';
    if (t === 'integer' || t === 'number') return 'number';
    if (t === 'boolean') return 'boolean';
    if (t === 'array') {
      if (Array.isArray(schema.prefixItems)) return `[${schema.prefixItems.map((x) => oaTs(m, x, ind, d + 1)).join(', ')}]`;
      return `${oaWrap(oaTs(m, schema.items, ind, d + 1))}[]`;
    }
    if (t === 'object') return oaObject(m, schema, ind, d + 1);
    return 'unknown';
  });
  const uniq = out.filter((t, k) => out.indexOf(t) === k);
  return withNull(uniq.join(' | '));
}

/** object の型リテラル（{ … }）。中身が無ければ Record */
function oaObject(m, schema, ind, depth) {
  const props = jyIsPlainObject(schema.properties) ? schema.properties : null;
  const addl = schema.additionalProperties;
  const keys = props ? Object.keys(props) : [];
  if (keys.length === 0) {
    if (addl === false) return 'Record<string, never>';
    if (jyIsPlainObject(addl) && Object.keys(addl).length) return `Record<string, ${oaTs(m, addl, ind, depth + 1)}>`;
    return 'Record<string, unknown>';
  }
  return `{\n${oaObjectBody(m, schema, ind + '  ', depth)}${ind}}`;
}

/** object の中身の行（interface の本体にも使う） */
function oaObjectBody(m, schema, ind, depth) {
  const props = jyIsPlainObject(schema.properties) ? schema.properties : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  let out = '';
  for (const k of Object.keys(props)) {
    m.tick();
    const ps = props[k];
    // $ref だけのプロパティは参照先の型に説明があるので、ここでは自分の横に書かれた説明だけを付ける
    const doc = oaDoc(jyIsPlainObject(ps) ? ps : {}, ind);
    const shown = jyIsPlainObject(ps) && typeof ps.$ref === 'string' ? Object.assign({}, m.deref(ps) || {}, ps) : ps;
    const ro = jyIsPlainObject(shown) && shown.readOnly === true ? 'readonly ' : '';
    const opt = required.indexOf(k) === -1 ? '?' : '';
    out += `${doc}${ind}${ro}${oaPropKey(k)}${opt}: ${oaTs(m, ps, ind, depth + 1)};\n`;
    if (out.length > OA_MAX_TYPE_CHARS) oaTooLarge();
  }
  const addl = schema.additionalProperties;
  if (addl === true || jyIsPlainObject(addl)) out += `${ind}[key: string]: unknown;\n`;
  return out;
}

/** 名前付きスキーマ1件の宣言（interface か type） */
function oaDeclare(m, entry) {
  const s = entry.schema;
  const doc = oaDoc(jyIsPlainObject(s) ? s : {}, '');
  if (jyIsPlainObject(s) && typeof s.$ref !== 'string') {
    const { types, nullable } = oaTypes(s);
    const plainObject = types.length === 1 && types[0] === 'object' && !nullable && jyIsPlainObject(s.properties) && Object.keys(s.properties).length &&
      !s.allOf && !s.oneOf && !s.anyOf && !s.enum && !oaOwn(s, 'const');
    if (plainObject) return `${doc}export interface ${entry.ts} {\n${oaObjectBody(m, s, '  ', 0)}}\n`;
  }
  return `${doc}export type ${entry.ts} = ${oaTs(m, s, '', 0)};\n`;
}

/** 操作の型名の土台（operationId があればそれ、無ければ メソッド＋パス） */
function oaOpBase(op) {
  if (op.operationId) return oaPascal(op.operationId);
  const segs = op.path.split('/').filter(Boolean).map((seg) => {
    const m = /^\{(.+)\}$/.exec(seg);
    return m ? 'By' + oaPascal(m[1]) : oaPascal(seg);
  });
  return oaPascal(op.method) + (segs.join('') || 'Root');
}

/** content の中から型に使う1件（JSON系を優先） */
function oaPickContent(contents) {
  if (!contents || contents.length === 0) return null;
  return contents.find((c) => /json/i.test(c.type)) || contents[0];
}

/**
 * TypeScript の型定義ファイル（.ts）を作る。
 * @param {object} m  oaModel の返り値
 * @param {object} [opts]
 * @param {boolean} [opts.operations=true] エンドポイントごとの引数・レスポンスの型も出す
 */
function oaTypeScript(m, opts) {
  const o = opts || {};
  const withOps = o.operations !== false;
  const head = [
    '/**',
    ` * ${(m.title || 'API').replace(/\*\//g, '*\\/')}${m.version ? ` v${m.version.replace(/\*\//g, '*\\/')}` : ''}`,
    ` * Generated from ${m.v2 ? 'Swagger' : 'OpenAPI'} ${m.v2 ? oaStr(m.spec.swagger) : oaStr(m.spec.openapi)} by First CH Tools (https://tools.first-ch.com/openapi-doc-gen/).`,
    ' */',
    '',
  ];
  const blocks = [];
  for (const e of m.schemas) blocks.push(oaDeclare(m, e));
  if (withOps && m.operations.length) {
    const used = new Set(m.schemas.map((e) => e.ts));
    for (const op of m.operations) {
      let base = oaOpBase(op);
      const want = (b) => ['Params', 'RequestBody', 'Response'].some((suf) => used.has(b + suf));
      let k = 2;
      const b0 = base;
      while (want(base)) base = b0 + k++;
      const title = `${op.method.toUpperCase()} ${op.path}${op.summary ? ` — ${op.summary}` : ''}`.replace(/\*\//g, '*\\/').replace(/\s*\n\s*/g, ' ');
      const parts = [];
      const groups = ['path', 'query', 'header', 'cookie'];
      const lines = [];
      for (const g of groups) {
        const ps = op.params.filter((p) => p.in === g);
        if (!ps.length) continue;
        const req = ps.some((p) => p.required);
        let inner = '';
        for (const p of ps) {
          const sch = m.deref(p.schema);
          inner += oaDoc(Object.assign({}, jyIsPlainObject(sch) ? sch : {}, { description: p.description, deprecated: p.deprecated }), '    ');
          inner += `    ${oaPropKey(p.name)}${p.required ? '' : '?'}: ${oaTs(m, p.schema, '    ', 0)};\n`;
        }
        lines.push(`  ${g}${req ? '' : '?'}: {\n${inner}  };\n`);
      }
      if (lines.length) {
        parts.push(`export interface ${base}Params {\n${lines.join('')}}\n`);
        used.add(base + 'Params');
      }
      const body = op.body ? oaPickContent(op.body.contents) : null;
      if (body) {
        parts.push(`/** ${body.type}${op.body.required ? '' : ' (optional)'} */\nexport type ${base}RequestBody = ${oaTs(m, body.schema, '', 0)};\n`);
        used.add(base + 'RequestBody');
      }
      const ok = op.responses.filter((r) => /^2/.test(r.status));
      if (ok.length) {
        const ts = [];
        for (const r of ok) {
          const c = oaPickContent(r.contents);
          const t = c ? oaTs(m, c.schema, '', 0) : 'void';
          if (ts.indexOf(t) === -1) ts.push(t);
        }
        parts.push(`/** ${ok.map((r) => r.status).join(', ')} */\nexport type ${base}Response = ${ts.length === 1 ? ts[0] : ts.map(oaWrap).join(' | ')};\n`);
        used.add(base + 'Response');
      }
      if (parts.length) blocks.push(`/* ${title} */\n` + parts.join('\n'));
    }
  }
  if (blocks.length === 0) blocks.push('export {};\n');
  return head.join('\n') + blocks.join('\n');
}

/* ---------------------------------------------------------------------------
 * Markdown ドキュメント
 * ------------------------------------------------------------------------- */

const OA_MD_TEXT = {
  ja: {
    docTitle: (t) => `${t} API リファレンス`,
    generated: (k, v) => `${k} ${v} の仕様書から生成`,
    apiVersion: 'APIのバージョン',
    servers: 'ベースURL',
    toc: 'エンドポイント一覧',
    method: 'メソッド',
    path: 'パス',
    summary: '概要',
    auth: '認証',
    authName: '名前',
    authType: '方式',
    authDetail: '詳細',
    endpoints: 'エンドポイント',
    other: 'その他',
    opId: 'operationId',
    deprecated: '非推奨',
    deprecatedNote: '> **非推奨**: このエンドポイントは廃止予定です。',
    authNeeded: '必要な認証',
    noAuth: 'なし',
    params: 'パラメータ',
    name: '名前',
    where: '場所',
    type: '型',
    required: '必須',
    desc: '説明',
    yes: '○',
    no: '',
    inLabel: { path: 'パス', query: 'クエリ', header: 'ヘッダー', cookie: 'Cookie' },
    body: 'リクエストボディ',
    bodyRequired: '（必須）',
    responses: 'レスポンス',
    status: 'ステータス',
    contentType: 'Content-Type',
    example: '例',
    autoExample: '（スキーマから自動生成）',
    requestExample: 'リクエストの例',
    responseExample: (s) => `${s} の例`,
    headers: 'レスポンスヘッダー',
    schemas: 'スキーマ',
    property: 'プロパティ',
    values: (v) => `値: ${v}`,
    defaultVal: (v) => `既定値: ${v}`,
    schemaIs: (c) => `型: ${c}`,
    none: '（なし）',
    noEndpoints: '（エンドポイントはありません）',
    readOnly: '読み取り専用',
    writeOnly: '書き込み専用',
  },
  en: {
    docTitle: (t) => `${t} API Reference`,
    generated: (k, v) => `Generated from ${/^[AEIOU]/.test(k) ? 'an' : 'a'} ${k} ${v} specification`,
    apiVersion: 'API version',
    servers: 'Base URL',
    toc: 'Endpoints',
    method: 'Method',
    path: 'Path',
    summary: 'Summary',
    auth: 'Authentication',
    authName: 'Name',
    authType: 'Type',
    authDetail: 'Details',
    endpoints: 'Endpoints',
    other: 'Other',
    opId: 'operationId',
    deprecated: 'Deprecated',
    deprecatedNote: '> **Deprecated**: this endpoint is scheduled for removal.',
    authNeeded: 'Authentication',
    noAuth: 'None',
    params: 'Parameters',
    name: 'Name',
    where: 'In',
    type: 'Type',
    required: 'Required',
    desc: 'Description',
    yes: 'Yes',
    no: '',
    inLabel: { path: 'path', query: 'query', header: 'header', cookie: 'cookie' },
    body: 'Request body',
    bodyRequired: ' (required)',
    responses: 'Responses',
    status: 'Status',
    contentType: 'Content-Type',
    example: 'Example',
    autoExample: ' (generated from the schema)',
    requestExample: 'Example request',
    responseExample: (s) => `Example ${s}`,
    headers: 'Response headers',
    schemas: 'Schemas',
    property: 'Property',
    values: (v) => `Values: ${v}`,
    defaultVal: (v) => `Default: ${v}`,
    schemaIs: (c) => `Type: ${c}`,
    none: '(none)',
    noEndpoints: '(no endpoints)',
    readOnly: 'read-only',
    writeOnly: 'write-only',
  },
};

/** Markdown の表のセル（| と改行を逃がす） */
function oaCell(s) {
  return String(s).replace(/\r\n?/g, '\n').trim().replace(/\|/g, '\\|').replace(/\n+/g, '<br>');
}
/** インラインコード（中にバッククォートがあれば囲みを長くする） */
function oaCode(s) {
  const str = String(s);
  const runs = str.match(/`+/g) || [];
  const n = runs.reduce((a, r) => Math.max(a, r.length), 0) + 1;
  const fence = '`'.repeat(n);
  const pad = /^`|`$/.test(str) ? ' ' : '';
  return `${fence}${pad}${str}${pad}${fence}`;
}
/** 表のセルに置くインラインコード。GFM はコードの中の | でもセルを割るので \| にする */
function oaTc(s) {
  return oaCode(String(s).replace(/\s*[\r\n]+\s*/g, ' ')).replace(/\|/g, '\\|');
}
/** コードブロック（中の ``` より長い囲みにする） */
function oaFence(body, lang) {
  const runs = String(body).match(/`{3,}/g) || [];
  const n = Math.max(3, runs.reduce((a, r) => Math.max(a, r.length + 1), 0));
  const f = '`'.repeat(n);
  return `${f}${lang || ''}\n${body}\n${f}`;
}

/** schema の説明列（説明・列挙値・既定値・読み取り専用） */
function oaSchemaDesc(m, schema, t, extra) {
  const s = jyIsPlainObject(schema) && typeof schema.$ref === 'string' ? Object.assign({}, m.deref(schema) || {}, schema) : schema;
  const bits = [];
  if (extra) bits.push(extra);
  if (jyIsPlainObject(s)) {
    if (oaStr(s.description).trim()) bits.push(oaStr(s.description).trim());
    if (Array.isArray(s.enum) && s.enum.length) bits.push(t.values(s.enum.slice(0, 30).map((v) => oaCode(JSON.stringify(v))).join(', ') + (s.enum.length > 30 ? ' …' : '')));
    if (oaOwn(s, 'default') && (s.default === null || typeof s.default !== 'object')) bits.push(t.defaultVal(oaCode(JSON.stringify(s.default))));
    if (s.readOnly === true) bits.push(t.readOnly);
    if (s.writeOnly === true) bits.push(t.writeOnly);
    if (s.deprecated === true) bits.push(t.deprecated);
  }
  return bits.join(' / ');
}

/** object schema のプロパティを表の行に（$ref の先も1段だけ開く） */
function oaPropRows(m, schema, t) {
  const s = m.deref(schema);
  if (!jyIsPlainObject(s)) return [];
  // allOf は並び順どおりに重ね、最後に自分の properties を載せる
  const props = {};
  let required = [];
  for (const part of (Array.isArray(s.allOf) ? s.allOf.map((x) => m.deref(x)) : []).concat([s])) {
    if (!jyIsPlainObject(part)) continue;
    if (jyIsPlainObject(part.properties)) Object.assign(props, part.properties);
    if (Array.isArray(part.required)) required = required.concat(part.required);
  }
  return Object.keys(props).map((k) => {
    m.tick();
    return `| ${oaTc(k)} | ${oaTc(oaTypeLabel(m, props[k]))} | ${required.indexOf(k) !== -1 ? t.yes : t.no} | ${oaCell(oaSchemaDesc(m, props[k], t))} |`;
  });
}

/**
 * 日本語（または英語）の Markdown ドキュメントを作る。
 * @param {object} m  oaModel の返り値
 * @param {object} [opts]
 * @param {'ja'|'en'} [opts.lang='ja']
 * @param {boolean} [opts.examples=true] 例が書かれていないレスポンスにスキーマから例を作る
 * @param {boolean} [opts.schemas=true]  スキーマの節を付ける
 */
function oaMarkdown(m, opts) {
  const o = opts || {};
  const lang = o.lang === 'en' ? 'en' : 'ja';
  const t = OA_MD_TEXT[lang];
  const genExamples = o.examples !== false;
  const out = [];
  const title = (m.title || 'API').replace(/\s+/g, ' ').trim();
  out.push(`# ${t.docTitle(title)}`, '');
  const meta = [];
  if (m.version) meta.push(`${t.apiVersion}: ${oaCode(m.version)}`);
  meta.push(t.generated(m.v2 ? 'Swagger' : 'OpenAPI', m.v2 ? oaStr(m.spec.swagger) : oaStr(m.spec.openapi)));
  out.push(meta.join(' / '), '');
  if (m.description.trim()) out.push(m.description.trim(), '');
  if (m.servers.length) {
    out.push(`## ${t.servers}`, '');
    for (const s of m.servers) out.push(`- ${oaCode(s.url)}${s.description ? ` — ${s.description.replace(/\s*\n\s*/g, ' ')}` : ''}`);
    out.push('');
  }

  out.push(`## ${t.toc}`, '');
  if (m.operations.length) {
    out.push(`| ${t.method} | ${t.path} | ${t.summary} |`, '| --- | --- | --- |');
    for (const op of m.operations) {
      out.push(`| ${op.method.toUpperCase()} | ${oaTc(op.path)} | ${oaCell((op.summary || op.operationId || '') + (op.deprecated ? `（${t.deprecated}）` : ''))} |`);
    }
  } else {
    out.push(t.noEndpoints);
  }
  out.push('');

  if (m.security.length) {
    out.push(`## ${t.auth}`, '');
    out.push(`| ${t.authName} | ${t.authType} | ${t.authDetail} |`, '| --- | --- | --- |');
    for (const s of m.security) {
      const detail = [];
      if (s.type === 'apiKey') detail.push(`${s.in}: ${oaCode(s.paramName)}`);
      if (s.scheme) detail.push(`scheme: ${s.scheme}`);
      if (s.bearerFormat) detail.push(`bearerFormat: ${s.bearerFormat}`);
      if (s.flow) detail.push(`flow: ${s.flow}`);
      if (s.openIdConnectUrl) detail.push(s.openIdConnectUrl);
      if (s.description) detail.push(s.description);
      out.push(`| ${oaTc(s.name)} | ${oaCell(s.type)} | ${oaCell(detail.join(' / '))} |`);
    }
    out.push('');
  }

  // タグごとにまとめる（タグが1つも無ければまとめない）
  const anyTag = m.operations.some((op) => op.tags.length);
  const groups = [];
  if (anyTag) {
    for (const tag of m.tags) {
      const ops = m.operations.filter((op) => op.tags[0] === tag.name);
      if (ops.length) groups.push({ name: tag.name, description: tag.description, ops });
    }
    const rest = m.operations.filter((op) => op.tags.length === 0);
    if (rest.length) groups.push({ name: t.other, description: '', ops: rest });
  } else if (m.operations.length) {
    groups.push({ name: null, ops: m.operations });
  }
  if (groups.length) out.push(`## ${t.endpoints}`, '');
  const h = anyTag ? '####' : '###';
  for (const g of groups) {
    if (g.name !== null) {
      out.push(`### ${g.name}`, '');
      if (g.description && g.description.trim()) out.push(g.description.trim(), '');
    }
    for (const op of g.ops) {
      m.tick();
      out.push(`${h} ${op.method.toUpperCase()} ${op.path}${op.summary ? ` — ${op.summary.replace(/\s*\n\s*/g, ' ')}` : ''}`, '');
      if (op.deprecated) out.push(t.deprecatedNote, '');
      if (op.description.trim()) out.push(op.description.trim(), '');
      const facts = [];
      if (op.operationId) facts.push(`- ${t.opId}: ${oaCode(op.operationId)}`);
      if (op.security !== null && m.security.length) facts.push(`- ${t.authNeeded}: ${op.security.length ? op.security.map(oaCode).join(', ') : t.noAuth}`);
      if (facts.length) out.push(...facts, '');

      if (op.params.length) {
        out.push(`**${t.params}**`, '');
        out.push(`| ${t.name} | ${t.where} | ${t.type} | ${t.required} | ${t.desc} |`, '| --- | --- | --- | --- | --- |');
        for (const p of op.params) {
          const extra = p.example.has ? `${t.example}: ${oaCode(JSON.stringify(p.example.value))}` : '';
          const desc = [oaSchemaDesc(m, Object.assign({}, jyIsPlainObject(p.schema) ? p.schema : {}, p.description ? { description: p.description } : {}, p.deprecated ? { deprecated: true } : {}), t), extra].filter(Boolean).join(' / ');
          out.push(`| ${oaTc(p.name)} | ${t.inLabel[p.in] || oaCell(p.in)} | ${oaTc(oaTypeLabel(m, p.schema))} | ${p.required ? t.yes : t.no} | ${oaCell(desc)} |`);
        }
        out.push('');
      }

      if (op.body) {
        out.push(`**${t.body}**${op.body.required ? t.bodyRequired : ''}`, '');
        if (op.body.description.trim()) out.push(op.body.description.trim(), '');
        for (const c of op.body.contents) {
          out.push(`- ${t.contentType}: ${oaCode(c.type)} / ${t.schemaIs(oaCode(oaTypeLabel(m, c.schema)))}`);
        }
        out.push('');
        const main = oaPickContent(op.body.contents);
        if (main) {
          const rows = oaPropRows(m, main.schema, t);
          if (rows.length) out.push(`| ${t.property} | ${t.type} | ${t.required} | ${t.desc} |`, '| --- | --- | --- | --- |', ...rows, '');
          const ex = main.example.has ? main.example.value : genExamples && main.schema ? oaSample(m, main.schema) : undefined;
          if (ex !== undefined && ex !== null) {
            out.push(`${t.requestExample}${main.example.has ? '' : t.autoExample}:`, '');
            out.push(oaFence(typeof ex === 'string' && !/json/i.test(main.type) ? ex : oaJson(ex), typeof ex === 'string' && !/json/i.test(main.type) ? '' : 'json'), '');
          }
        }
      }

      if (op.responses.length) {
        out.push(`**${t.responses}**`, '');
        out.push(`| ${t.status} | ${t.desc} | ${t.contentType} | ${t.type} |`, '| --- | --- | --- | --- |');
        for (const r of op.responses) {
          const cs = r.contents.length ? r.contents : [null];
          cs.forEach((c, k) => {
            out.push(`| ${k === 0 ? oaTc(r.status) : ''} | ${k === 0 ? oaCell(r.description) : ''} | ${c ? oaTc(c.type) : ''} | ${c && c.schema ? oaTc(oaTypeLabel(m, c.schema)) : ''} |`);
          });
        }
        out.push('');
        for (const r of op.responses) {
          if (r.headers.length) {
            out.push(`${t.headers}（${r.status}）:`, '');
            for (const hd of r.headers) out.push(`- ${oaCode(hd.name)}${hd.schema ? ` (${oaTypeLabel(m, hd.schema)})` : ''}${hd.description ? ` — ${hd.description.replace(/\s*\n\s*/g, ' ')}` : ''}`);
            out.push('');
          }
          const c = oaPickContent(r.contents);
          if (!c) continue;
          const ex = c.example.has ? c.example.value : genExamples && c.schema ? oaSample(m, c.schema) : undefined;
          if (ex === undefined || ex === null) continue;
          const raw = typeof ex === 'string' && !/json/i.test(c.type);
          out.push(`${t.responseExample(r.status)}${c.example.has ? '' : t.autoExample}:`, '');
          out.push(oaFence(raw ? ex : oaJson(ex), raw ? '' : 'json'), '');
        }
      }
    }
  }

  if (o.schemas !== false && m.schemas.length) {
    out.push(`## ${t.schemas}`, '');
    for (const e of m.schemas) {
      m.tick();
      out.push(`### ${e.name}`, '');
      const s = m.deref(e.schema);
      if (jyIsPlainObject(s) && oaStr(s.description).trim()) out.push(oaStr(s.description).trim(), '');
      const rows = oaPropRows(m, e.schema, t);
      if (rows.length) {
        out.push(`| ${t.property} | ${t.type} | ${t.required} | ${t.desc} |`, '| --- | --- | --- | --- |', ...rows, '');
      } else {
        const extra = oaSchemaDesc(m, Object.assign({}, jyIsPlainObject(s) ? s : {}, { description: '' }), t);
        out.push(t.schemaIs(oaCode(oaTypeLabel(m, e.schema, 1))) + (extra ? ` / ${extra}` : ''), '');
      }
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\s+$/, '') + '\n';
}

/**
 * 入口: 仕様の文字列から Markdown と TypeScript をまとめて作る。
 * @param {object} opts
 * @param {string} opts.text           OpenAPI / Swagger の JSON か YAML
 * @param {'ja'|'en'} [opts.lang='ja'] ドキュメントの言語
 * @param {boolean} [opts.examples=true]
 * @param {boolean} [opts.operations=true]
 */
function oaGenerate(opts) {
  const o = opts || {};
  const parsed = oaParse(o.text);
  if (!parsed.ok) return parsed;
  try {
    const m = oaModel(parsed.spec, parsed.kind);
    const markdown = oaMarkdown(m, o);
    const typescript = oaTypeScript(m, o);
    const notes = parsed.notes.concat(m.notes.list);
    return {
      ok: true,
      kind: parsed.kind,
      format: parsed.format,
      specVersion: parsed.version,
      title: m.title,
      version: m.version,
      endpoints: m.operations.length,
      schemas: m.schemas.length,
      markdown,
      typescript,
      notes,
    };
  } catch (e) {
    if (e && e.oa) return { ok: false, error: { code: e.oa.code, line: 1, col: 1 }, notes: [] };
    if (e instanceof RangeError) return { ok: false, error: { code: 'OA_TOO_LARGE', line: 1, col: 1 }, notes: [] };
    throw e;
  }
}

/** ダウンロードのファイル名の土台（タイトルの文字と数字。無ければ openapi） */
function oaFileBase(title) {
  const s = String(title || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  return s || 'openapi';
}


/* ==================== ここまで site/openapi-doc-gen/core.js の写し ==================== */

/* ---------------------------------------------------------------------------
 * MCPの入口
 * 文言は site/openapi-doc-gen/app.js の ERR_JA / ERR_EN / NOTE_JA / NOTE_EN と同じ
 * ------------------------------------------------------------------------- */

const ERR_JA = {
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
  TAB_INDENT: () => 'インデントにタブが使われています。YAMLはタブでの字下げを認めていないので、半角スペースに置き換えてください。',
  YAML_BAD_INDENT: (e) => `インデントが揃っていません（${e.found}）。同じ階層の行は桁を合わせてください。`,
  YAML_SEQ_IN_MAP: () => 'キーが並ぶ位置に「- 」があります。マップとシーケンスは同じ階層に混ぜられません。',
  YAML_KEY_EXPECTED: (e) => `「キー: 値」の形になっていません（${e.found}）。値の後ろには : が必要です。`,
  YAML_EXPLICIT_KEY: () => '「? キー」という明示キーの書き方には対応していません。通常の「キー: 値」に書き換えてください。',
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
  OA_NOT_OBJECT: () => '仕様書の一番上が「キー: 値」の並び（オブジェクト）になっていません。',
  OA_NOT_SPEC: () => '「openapi:」または「swagger:」のキーが見つかりません。OpenAPI 3.x / Swagger 2.0 の仕様書を入れてください。',
  OA_TOO_LARGE: () => '出力が大きくなりすぎるため生成を止めました（YAMLのエイリアスを何重にも入れ子にした仕様書など）。',
};

const ERR_EN = {
  EMPTY_INPUT: () => 'The input is empty.',
  TOO_DEEP: () => 'Nesting is too deep (200 levels maximum).',
  JSON_UNEXPECTED_END: () => 'The input ends unexpectedly — check for a missing closing bracket.',
  JSON_TRAILING_DATA: (e) => `Extra characters after the JSON value (${e.found}). A JSON document holds exactly one value.`,
  JSON_VALUE_EXPECTED: (e) => `Expected a value here, found ${e.found}.`,
  JSON_KEY_EXPECTED: (e) => `Expected a key here, found ${e.found}. Keys must be wrapped in "…".`,
  JSON_COLON_EXPECTED: (e) => `Expected ":" after the key, found ${e.found}.`,
  JSON_COMMA_EXPECTED: (e) => `Expected "," or a closing bracket, found ${e.found}.`,
  JSON_UNTERMINATED_STRING: (e) => `This string is never closed with ${e.found}.`,
  JSON_UNTERMINATED_COMMENT: () => 'A /* comment is never closed with */.',
  JSON_BAD_ESCAPE: (e) => `Invalid escape sequence inside the string (${e.found}).`,
  JSON_BAD_TOKEN: (e) => `Not a valid JSON value (${e.found}). Wrap strings in "…".`,
  JSON_RAW_CONTROL: (e) => `A raw control character (${e.found}) is inside a string. Write it as \\n or \\t instead.`,
  TAB_INDENT: () => 'A tab is used for indentation. YAML forbids tabs for indenting — replace them with spaces.',
  YAML_BAD_INDENT: (e) => `Indentation does not line up (${e.found}). Keys at the same level need the same column.`,
  YAML_SEQ_IN_MAP: () => 'A "- " item appears where mapping keys are listed. A block cannot be both a mapping and a sequence.',
  YAML_KEY_EXPECTED: (e) => `This is not a "key: value" line (${e.found}). A colon is required after the key.`,
  YAML_EXPLICIT_KEY: () => 'Explicit "? key" notation is not supported. Rewrite it as a normal "key: value" line.',
  YAML_VALUE_THEN_BLOCK: (e) => `A more deeply indented line follows a line that already has a value (${e.found}). Remove the value above, or outdent this line.`,
  YAML_NESTED_COLON: (e) => `Two "key: value" pairs on one line (${e.found}). Wrap the value in "…" if it must contain ": ".`,
  YAML_SEQ_INLINE: (e) => `Sequence items start on the following line (${e.found}). To keep it on one line use the [a, b] form.`,
  YAML_UNTERMINATED_QUOTE: (e) => `This ${e.found} quote is never closed.`,
  YAML_BAD_ESCAPE: (e) => `Invalid escape sequence inside "…" (${e.found}).`,
  YAML_UNTERMINATED_FLOW: () => 'A "[" or "{" is never closed.',
  YAML_FLOW_SEP: (e) => `Invalid separator inside [ ] or { } (${e.found}). Items are separated by commas.`,
  YAML_FLOW_COLON: (e) => `Missing ":" after a key inside { } (${e.found}).`,
  YAML_ALIAS_NOT_FOUND: (e) => `No such anchor to reference (${e.found}). Values starting with "*", such as *.js, must be quoted.`,
  YAML_ALIAS_TRAILING: (e) => `Extra characters after the alias (${e.found}).`,
  YAML_TRAILING_TEXT: (e) => `Extra characters after the quoted value or [ ] { } (${e.found}).`,
  YAML_BLOCK_HEADER: (e) => `Cannot read the block scalar header (${e.found}). Only chomping (- +) and an indent digit (1-9) are allowed.`,
  YAML_BLOCK_INDENT: () => 'The body of a | or > block is not indented consistently — no line may be shallower than the first one.',
  YAML_BAD_TAG_VALUE: (e) => `The value does not match the tag type (${e.found}).`,
  YAML_INTERNAL: () => 'Parsing stopped making progress. Try simplifying the input.',
  OA_NOT_OBJECT: () => 'The top level of the specification is not a mapping of "key: value" pairs.',
  OA_NOT_SPEC: () => 'No "openapi:" or "swagger:" key was found. Please provide an OpenAPI 3.x or Swagger 2.0 specification.',
  OA_TOO_LARGE: () => 'Generation was stopped because the output grew too large (for example, YAML aliases nested many times over).',
};

const listJa = (n) => n.items.join('、');
const listEn = (n) => n.items.join(', ');
const NOTE_JA = {
  OA_MULTI_DOC: () => 'YAMLに複数のドキュメント（---）があるため、最初の1つだけを読みました。',
  OA_EXTERNAL_REF: (n) => `別ファイル・URLを指す $ref は読みに行きません（${listJa(n)}）。その部分の型は unknown になっています。1ファイルにまとめた仕様書を入れてください。`,
  OA_BROKEN_REF: (n) => `参照先が見つからない $ref があります（${listJa(n)}）。その部分の型は unknown になっています。`,
  OA_DUP_OPERATION_ID: (n) => `operationId が重複しています（${listJa(n)}）。型の名前は末尾に番号を付けて分けました。`,
  OA_NO_PATHS: () => 'paths にエンドポイントがありません。スキーマだけを出力しました。',
  OA_RENAMED_TYPE: (n) => `TypeScriptの予約語・組み込みの型と重なる、または重複する名前を付け替えました（${listJa(n)}）。`,
  OA_VERSION_UNKNOWN: (n) => `想定していないバージョン（${listJa(n)}）です。読める範囲で生成しました。`,
  OA_JSON_RELAXED: () => 'JSONとしては不正な書き方（コメント・末尾のカンマなど）がありましたが、読み取って続けました。',
};

const NOTE_EN = {
  OA_MULTI_DOC: () => 'The YAML holds several documents (---); only the first one was read.',
  OA_EXTERNAL_REF: (n) => `$ref values pointing to other files or URLs are not fetched (${listEn(n)}). Those parts are typed as unknown — use a bundled, single-file specification.`,
  OA_BROKEN_REF: (n) => `Some $ref targets could not be found (${listEn(n)}). Those parts are typed as unknown.`,
  OA_DUP_OPERATION_ID: (n) => `Duplicate operationId (${listEn(n)}). The type names were told apart with a number suffix.`,
  OA_NO_PATHS: () => 'There are no endpoints under paths; only the schemas were written.',
  OA_RENAMED_TYPE: (n) => `Names that clash with TypeScript keywords or built-in types, or with each other, were renamed (${listEn(n)}).`,
  OA_VERSION_UNKNOWN: (n) => `Unexpected version (${listEn(n)}). Output was generated from what could be read.`,
  OA_JSON_RELAXED: () => 'The JSON contained things JSON does not allow (comments, trailing commas, …); they were accepted and reading continued.',
};

const TEXT = { ja: { err: ERR_JA, note: NOTE_JA }, en: { err: ERR_EN, note: NOTE_EN } };

// site 側がファイルとして読み込む上限（20MB）と同じ
const MAX_BYTES = 20 * 1024 * 1024;

export class OpenApiDocToolError extends Error {}

/**
 * OpenAPI 3.x / Swagger 2.0 の仕様書（YAML か JSON）から、日本語（または英語）の Markdown ドキュメントと
 * TypeScript の型定義を作る。
 *
 * @param {object} opts
 * @param {string} [opts.spec]       仕様書の本文（path と排他）
 * @param {string} [opts.path]       仕様書ファイルの絶対パス（UTF-8 として読む）
 * @param {'ja'|'en'} [opts.lang]    ドキュメント・指摘・エラーの言語（既定 ja）
 * @param {boolean} [opts.examples]  例が書かれていないレスポンスにスキーマから例を作る（既定 true）
 * @param {boolean} [opts.operations] エンドポイントごとの引数・レスポンスの型も出す（既定 true）
 * @param {'both'|'markdown'|'typescript'} [opts.output] 返す（書き出す）もの（既定 both）
 * @param {string} [opts.outputDir]  書き出し先ディレクトリ（絶対パス）。<タイトル>.md / <タイトル>.ts を置き、本文は返さない
 * @param {boolean} [opts.overwrite]
 */
export async function openApiDocGenerateTool(opts = {}) {
  const o = opts || {};
  const lang = o.lang === undefined ? 'ja' : o.lang;
  if (lang !== 'ja' && lang !== 'en') throw new OpenApiDocToolError(`lang は ja か en: ${o.lang}`);
  const output = o.output === undefined ? 'both' : o.output;
  if (['both', 'markdown', 'typescript'].indexOf(output) === -1) {
    throw new OpenApiDocToolError(`output は both / markdown / typescript のどれかです: ${o.output}`);
  }
  const hasSpec = typeof o.spec === 'string';
  const hasPath = typeof o.path === 'string' && o.path.trim() !== '';
  if (hasSpec === hasPath) throw new OpenApiDocToolError('spec か path のどちらか一方を指定してください');
  if (hasPath && !isAbsolute(o.path)) throw new OpenApiDocToolError('path は絶対パスで指定してください');
  if (o.outputDir !== undefined && (typeof o.outputDir !== 'string' || !isAbsolute(o.outputDir))) {
    throw new OpenApiDocToolError('outputDir は絶対パスで指定してください');
  }

  let text;
  if (hasSpec) {
    text = o.spec;
  } else {
    const buf = await readFile(o.path);
    if (buf.length > MAX_BYTES) throw new OpenApiDocToolError(`${MAX_BYTES / 1024 / 1024}MBを超えるファイルは読み込みません: ${o.path}`);
    text = buf.toString('utf8');
  }
  if (Buffer.byteLength(text, 'utf8') > MAX_BYTES) throw new OpenApiDocToolError(`仕様書は ${MAX_BYTES / 1024 / 1024}MB まで`);

  const T = TEXT[lang];
  let r;
  try {
    r = oaGenerate({ text, lang, examples: o.examples !== false, operations: o.operations !== false });
  } catch (e) {
    // site 側と同じく、想定外の例外（スタックの食い潰しなど）もエラーとして返す
    r = { ok: false, error: { code: e instanceof RangeError ? 'OA_TOO_LARGE' : 'YAML_INTERNAL', line: 1, col: 1 } };
  }
  if (!r.ok) {
    const e = r.error;
    const fn = T.err[e.code];
    const err = { code: e.code, message: fn ? fn(e) : e.code };
    if (r.excerpt) {
      err.line = e.line;
      err.col = e.col;
      err.excerpt = r.excerpt;
    }
    return { ok: false, error: err };
  }

  const base = oaFileBase(r.title);
  const result = {
    ok: true,
    kind: r.kind,
    format: r.format,
    spec_version: r.specVersion,
    title: r.title,
    version: r.version,
    endpoints: r.endpoints,
    schemas: r.schemas,
    file_names: { markdown: `${base}.md`, typescript: `${base}.ts` },
  };
  if (output !== 'typescript') result.markdown = r.markdown;
  if (output !== 'markdown') result.typescript = r.typescript;
  result.notes = r.notes.map((n) => {
    const fn = T.note[n.code];
    const out = { code: n.code, level: n.level, count: n.count, message: fn ? fn(n) : n.code };
    if (n.items.length) out.items = n.items;
    return out;
  });

  if (o.outputDir) {
    const written = {};
    if (output !== 'typescript') {
      written.markdown = join(o.outputDir, `${base}.md`);
      await writeOutput(written.markdown, r.markdown, { overwrite: o.overwrite });
    }
    if (output !== 'markdown') {
      written.typescript = join(o.outputDir, `${base}.ts`);
      await writeOutput(written.typescript, r.typescript, { overwrite: o.overwrite });
    }
    result.output = written;
    // ファイルに書けたなら本文は重複した重い情報でしかない
    delete result.markdown;
    delete result.typescript;
  }
  return result;
}

export {
  jyParseJson, jyParseYaml, jyExcerpt,
  oaParse, oaModel, oaMarkdown, oaTypeScript, oaGenerate, oaFileBase, oaPascal, oaSample, oaTs, oaTypeLabel,
};
