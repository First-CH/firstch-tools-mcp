// SQLクエリの整形（tools.first-ch.com/sql-format/ と同一ロジック）
//
// 「整形コア」ブロックは site 側の site/sql-format/app.js と同一の実装。
// 2箇所ルール: 片方を直したらもう片方も同じ内容で直す（site側が正本）。
// 使っているのは String/RegExp/Array/Set だけなので、ブラウザ版のコードをそのまま持ってこられる。
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

/* ==================== ここから整形コア（site / MCP で同一） ==================== */

export const SQL_CASE_MODES = ['upper', 'lower', 'preserve'];
export const SQL_INDENT_STYLES = ['2', '4', '8', 'tab'];
export const SQL_COMMA_STYLES = ['trailing', 'leading'];
export const SQL_LOGIC_STYLES = ['leading', 'trailing'];
const SQL_INDENT_TEXT = { 2: '  ', 4: '    ', 8: '        ', tab: '\t' };

// 予約語（大文字化の対象）。型名まで含めるのは CREATE TABLE を貼られたときのため
const SQL_KEYWORDS = new Set((
  'ADD ALL ALTER ANALYZE AND ANY AS ASC BEGIN BETWEEN BY CASCADE CASE CAST CHECK COLLATE COLUMN ' +
  'COMMIT CONFLICT CONSTRAINT CREATE CROSS CUBE CURRENT DATABASE DECLARE DEFAULT DEFERRABLE DELETE ' +
  'DESC DESCRIBE DISTINCT DO DROP ELSE END ESCAPE EXCEPT EXCLUDE EXISTS EXPLAIN FALSE FETCH FILTER ' +
  'FIRST FOLLOWING FOR FOREIGN FROM FULL GRANT GROUP GROUPING HAVING IF IGNORE ILIKE IN INDEX INNER ' +
  'INSERT INTERSECT INTERVAL INTO IS JOIN KEY LAST LATERAL LEFT LIKE LIMIT MATCHED MERGE MINUS ' +
  'NATURAL NEXT NO NOT NOTHING NULL NULLS OFFSET ON ONLY OR ORDER OUTER OVER PARTITION PRECEDING ' +
  'PRIMARY RANGE RECURSIVE REFERENCES REGEXP RENAME REPLACE RESTRICT RETURNING REVOKE RIGHT RLIKE ' +
  'ROLLBACK ROLLUP ROW ROWS SAVEPOINT SELECT SET SETS SHOW SIMILAR SOME TABLE TEMPORARY THEN TIES ' +
  'TO TOP TRANSACTION TRIGGER TRUE TRUNCATE UNBOUNDED UNION UNIQUE UNKNOWN UPDATE USE USING VALUES ' +
  'VIEW WHEN WHERE WHILE WINDOW WITH WITHOUT ' +
  // 型名
  'BIGINT BIGSERIAL BINARY BIT BLOB BOOL BOOLEAN BYTEA CHAR CLOB DATE DATETIME DECIMAL DOUBLE ENUM ' +
  'FLOAT INT INT2 INT4 INT8 INTEGER JSON JSONB MONEY NCHAR NUMERIC NVARCHAR PRECISION REAL SERIAL ' +
  'SMALLINT TEXT TIME TIMESTAMP TIMESTAMPTZ TINYINT UUID VARBINARY VARCHAR XML ZONE'
).split(' '));

// 関数名（大文字化の対象。予約語と重なるものは「関数名の直後の ( の前を空けない」ためにも使う）
const SQL_FUNCTIONS = new Set((
  'ABS ACOS ARRAY_AGG ASCII ASIN ATAN AVG BOOL_AND BOOL_OR CAST CEIL CEILING CHAR_LENGTH ' +
  'CHARACTER_LENGTH COALESCE CONCAT CONCAT_WS COS COUNT CUME_DIST CURRENT_DATE CURRENT_TIME ' +
  'CURRENT_TIMESTAMP CURRENT_USER DATE_ADD DATE_FORMAT DATE_PART DATE_SUB DATE_TRUNC DATEADD ' +
  'DATEDIFF DAY DENSE_RANK EXP EXTRACT FIRST_VALUE FLOOR FORMAT GENERATE_SERIES GETDATE GREATEST ' +
  'GROUP_CONCAT HOUR IFNULL INITCAP INSTR ISNULL JSON_AGG JSON_BUILD_OBJECT JSON_EXTRACT LAG ' +
  'LAST_VALUE LEAD LEAST LEFT LENGTH LN LOG LOWER LPAD LTRIM MAX MD5 MIN MINUTE MOD MONTH NOW ' +
  'NTILE NULLIF NVL PERCENT_RANK PERCENTILE_CONT POSITION POW POWER QUARTER RANDOM RANK ' +
  'REGEXP_REPLACE REPEAT REPLACE REVERSE RIGHT ROUND ROW_NUMBER RPAD RTRIM SECOND SIGN SIN ' +
  'SPLIT_PART SQRT STDDEV STRFTIME STRING_AGG STRPOS SUBSTR SUBSTRING SUM TAN TO_CHAR TO_DATE ' +
  'TO_NUMBER TO_TIMESTAMP TRIM TRUNC UNIX_TIMESTAMP UPPER VARIANCE WEEK YEAR'
).split(' '));

// 1つの構文キーワードとして扱う語の並び（長いものから順に照合する）
const SQL_MULTI = [
  ['LEFT', 'OUTER', 'JOIN'], ['RIGHT', 'OUTER', 'JOIN'], ['FULL', 'OUTER', 'JOIN'],
  ['LEFT', 'SEMI', 'JOIN'], ['ORDER', 'SIBLINGS', 'BY'], ['WITH', 'RECURSIVE'],
  ['GROUP', 'BY'], ['ORDER', 'BY'], ['PARTITION', 'BY'], ['INSERT', 'INTO'], ['DELETE', 'FROM'],
  ['UNION', 'ALL'], ['UNION', 'DISTINCT'], ['EXCEPT', 'ALL'], ['INTERSECT', 'ALL'],
  ['INNER', 'JOIN'], ['LEFT', 'JOIN'], ['RIGHT', 'JOIN'], ['FULL', 'JOIN'], ['CROSS', 'JOIN'],
  ['NATURAL', 'JOIN'], ['STRAIGHT', 'JOIN'], ['CROSS', 'APPLY'], ['OUTER', 'APPLY'],
  ['ON', 'CONFLICT'], ['ON', 'DUPLICATE'], ['FETCH', 'FIRST'], ['FETCH', 'NEXT'],
  ['CREATE', 'TABLE'], ['CREATE', 'VIEW'], ['CREATE', 'INDEX'], ['ALTER', 'TABLE'],
  ['DROP', 'TABLE'], ['TRUNCATE', 'TABLE'],
];

// 行頭に置く句
const SQL_CLAUSES = new Set([
  'WITH', 'WITH RECURSIVE', 'SELECT', 'FROM', 'WHERE', 'GROUP BY', 'HAVING', 'ORDER BY',
  'ORDER SIBLINGS BY', 'LIMIT', 'OFFSET', 'FETCH FIRST', 'FETCH NEXT', 'VALUES', 'SET',
  'RETURNING', 'INSERT INTO', 'UPDATE', 'DELETE FROM', 'ON CONFLICT', 'ON DUPLICATE', 'WINDOW',
  'CREATE TABLE', 'CREATE VIEW', 'CREATE INDEX', 'ALTER TABLE', 'DROP TABLE', 'TRUNCATE TABLE',
]);
// 集合演算（前後を1行空けずに行頭へ置く）
const SQL_SETOPS = new Set([
  'UNION', 'UNION ALL', 'UNION DISTINCT', 'EXCEPT', 'EXCEPT ALL', 'INTERSECT', 'INTERSECT ALL', 'MINUS',
]);
// JOIN の仲間（行頭に置く）
const SQL_JOINS = new Set([
  'JOIN', 'INNER JOIN', 'LEFT JOIN', 'LEFT OUTER JOIN', 'LEFT SEMI JOIN', 'RIGHT JOIN',
  'RIGHT OUTER JOIN', 'FULL JOIN', 'FULL OUTER JOIN', 'CROSS JOIN', 'NATURAL JOIN',
  'STRAIGHT JOIN', 'CROSS APPLY', 'OUTER APPLY',
]);
// 中身を必ず次の行から書く句（1項目1行にするとき）
const SQL_BODY_BREAK = new Set(['SELECT', 'SET', 'VALUES', 'RETURNING', 'WITH', 'WITH RECURSIVE']);
// 条件の AND / OR を折り返す句
const SQL_LOGIC_CLAUSES = new Set(['WHERE', 'HAVING', 'ON', 'ON CONFLICT']);
// 「テーブル名 (列, 列)」のように、識別子と ( の間を空ける句
const SQL_PAREN_AFTER_NAME = new Set(['INSERT INTO', 'CREATE TABLE', 'CREATE VIEW', 'CREATE INDEX', 'ALTER TABLE']);
// SELECT の直後に同じ行へ置く語
const SQL_SELECT_MODIFIERS = new Set(['DISTINCT', 'ALL', 'TOP', 'DISTINCTROW', 'SQL_CALC_FOUND_ROWS']);
// 2文字以上の演算子（長いものから照合する）
const SQL_OPERATORS = ['->>', '#>>', '<=>', '||', '::', '->', '#>', '<=', '>=', '<>', '!=', '&&', ':=', '!<', '!>', '<<', '>>'];

const SQL_WORD_RE = /[A-Za-z0-9_$\u0080-\uffff]/;
const SQL_STRING_PREFIX_RE = /^[ENXBUenxbu]$/;

/**
 * SQL を字句へ分ける。空白は捨て、コメント・文字列・引用符付き識別子はそのまま1トークンにする。
 * @param {string} sql
 * @returns {{tokens: object[], unterminatedString: boolean, unterminatedComment: boolean}}
 */
export function sqlTokenize(sql) {
  const s = String(sql === undefined || sql === null ? '' : sql).replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  const tokens = [];
  let unterminatedString = false;
  let unterminatedComment = false;
  let i = 0;
  const push = (type, value) => {
    tokens.push({ type, value, upper: type === 'word' ? value.toUpperCase() : value, raw: value });
  };
  while (i < s.length) {
    const ch = s[i];
    // 空白
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\f' || ch === '\v') { i += 1; continue; }
    // 行コメント
    if ((ch === '-' && s[i + 1] === '-') || ch === '#') {
      let j = s.indexOf('\n', i);
      if (j === -1) j = s.length;
      push('lineComment', s.slice(i, j));
      i = j;
      continue;
    }
    // ブロックコメント
    if (ch === '/' && s[i + 1] === '*') {
      const j = s.indexOf('*/', i + 2);
      if (j === -1) { unterminatedComment = true; push('blockComment', s.slice(i)); i = s.length; continue; }
      push('blockComment', s.slice(i, j + 2));
      i = j + 2;
      continue;
    }
    // 文字列（E'…' / N'…' のような接頭辞も1つにまとめる）
    if (ch === "'" || (SQL_STRING_PREFIX_RE.test(ch) && s[i + 1] === "'")) {
      const start = i;
      if (ch !== "'") i += 1;
      i += 1;
      let closed = false;
      while (i < s.length) {
        if (s[i] === '\\' && (s[i + 1] === "'" || s[i + 1] === '\\')) { i += 2; continue; }
        if (s[i] === "'") {
          if (s[i + 1] === "'") { i += 2; continue; }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) unterminatedString = true;
      push('string', s.slice(start, i));
      continue;
    }
    // 引用符付き識別子
    if (ch === '"' || ch === '`' || ch === '[') {
      const close = ch === '[' ? ']' : ch;
      const start = i;
      i += 1;
      let closed = false;
      while (i < s.length) {
        if (s[i] === close) {
          if (close !== ']' && s[i + 1] === close) { i += 2; continue; }
          i += 1;
          closed = true;
          break;
        }
        i += 1;
      }
      if (!closed) unterminatedString = true;
      push('quoted', s.slice(start, i));
      continue;
    }
    // ドル引用符（$$…$$ / $tag$…$tag$）とプレースホルダ $1
    if (ch === '$') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(s.slice(i));
      if (m) {
        const tag = m[0];
        const j = s.indexOf(tag, i + tag.length);
        if (j === -1) { unterminatedString = true; push('string', s.slice(i)); i = s.length; continue; }
        push('string', s.slice(i, j + tag.length));
        i = j + tag.length;
        continue;
      }
      const n = /^\$\d+/.exec(s.slice(i));
      if (n) { push('param', n[0]); i += n[0].length; continue; }
    }
    // プレースホルダ
    if (ch === '?') { push('param', '?'); i += 1; continue; }
    if (ch === ':' && s[i + 1] !== ':' && /[A-Za-z_]/.test(s[i + 1] || '')) {
      const n = /^:[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
      push('param', n[0]);
      i += n[0].length;
      continue;
    }
    if (ch === '@' && /[A-Za-z_@]/.test(s[i + 1] || '')) {
      const n = /^@@?[A-Za-z_][A-Za-z0-9_$]*/.exec(s.slice(i));
      push('param', n[0]);
      i += n[0].length;
      continue;
    }
    // 数値
    if (/[0-9]/.test(ch) || (ch === '.' && /[0-9]/.test(s[i + 1] || ''))) {
      const n = /^(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(s.slice(i));
      push('number', n[0]);
      i += n[0].length;
      continue;
    }
    // 語
    if (SQL_WORD_RE.test(ch)) {
      let j = i;
      while (j < s.length && SQL_WORD_RE.test(s[j])) j += 1;
      push('word', s.slice(i, j));
      i = j;
      continue;
    }
    // 演算子・区切り
    const rest = s.slice(i, i + 3);
    const op = SQL_OPERATORS.find((o) => rest.startsWith(o));
    if (op) { push('op', op); i += op.length; continue; }
    push(ch === '(' || ch === ')' || ch === ',' || ch === ';' || ch === '.' ? 'punct' : 'op', ch);
    i += 1;
  }
  return { tokens, unterminatedString, unterminatedComment };
}

/** 「GROUP BY」「LEFT OUTER JOIN」のような語の並びを1トークンへまとめる */
export function sqlMergeKeywords(tokens) {
  const out = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    let merged = null;
    if (t.type === 'word') {
      for (const words of SQL_MULTI) {
        if (words[0] !== t.upper) continue;
        let ok = true;
        for (let k = 1; k < words.length; k += 1) {
          const n = tokens[i + k];
          if (!n || n.type !== 'word' || n.upper !== words[k]) { ok = false; break; }
        }
        if (!ok) continue;
        const parts = tokens.slice(i, i + words.length);
        merged = {
          type: 'word',
          value: words.join(' '),
          upper: words.join(' '),
          raw: parts.map((p) => p.value).join(' '),
        };
        i += words.length - 1;
        break;
      }
    }
    out.push(merged || t);
  }
  return out;
}

/** 指摘は {code, params} で持ち、表示のときに文言へ変える（MCP側と同じ構造） */
function sqlNote(code, params) {
  return { code, params: params || {} };
}

/** 予約語か（「GROUP BY」のようにまとめた語は必ず予約語） */
function sqlIsKeyword(token) {
  return token.type === 'word' && (SQL_KEYWORDS.has(token.upper) || token.upper.indexOf(' ') !== -1);
}

/** 指定された表記へ寄せる（preserve のときは元の綴りを返す） */
function sqlApplyCase(token, mode) {
  if (mode === 'preserve') return token.raw;
  return mode === 'lower' ? token.value.toLowerCase() : token.value.toUpperCase();
}

/** 既定値を埋めたオプション */
export function sqlOptions(opts) {
  const o = opts || {};
  const pick = (v, list, def) => (list.indexOf(v) === -1 ? def : v);
  const bool = (v, def) => (v === undefined || v === null ? def : v === true || v === 'true' || v === 1 || v === '1');
  return {
    keywordCase: pick(o.keywordCase, SQL_CASE_MODES, 'upper'),
    functionCase: pick(o.functionCase, SQL_CASE_MODES, 'upper'),
    indent: pick(String(o.indent === undefined ? '4' : o.indent), SQL_INDENT_STYLES, '4'),
    commaStyle: pick(o.commaStyle, SQL_COMMA_STYLES, 'trailing'),
    logicStyle: pick(o.logicStyle, SQL_LOGIC_STYLES, 'leading'),
    breakColumns: bool(o.breakColumns, true),
    breakLogic: bool(o.breakLogic, true),
    breakOn: bool(o.breakOn, true),
    breakCase: bool(o.breakCase, true),
    breakSubquery: bool(o.breakSubquery, true),
    expandClauses: bool(o.expandClauses, false),
    compact: bool(o.compact, false),
    eol: o.eol === 'crlf' ? 'crlf' : 'lf',
  };
}

/** コメントを飛ばして次の実トークンを返す */
function sqlNextSig(tokens, i) {
  for (let k = i + 1; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t.type !== 'lineComment' && t.type !== 'blockComment') return t;
  }
  return null;
}

/**
 * SQL を整形する。
 * @param {string} sql
 * @param {object} [options]
 * @returns {{text: string, lines: number, statements: number, depth: number, keywords: number,
 *            tokens: number, notes: object[]}}
 */
export function sqlFormat(sql, options) {
  const o = sqlOptions(options);
  const lex = sqlTokenize(sql);
  const toks = sqlMergeKeywords(lex.tokens);
  const indentText = SQL_INDENT_TEXT[o.indent];

  const lines = [];
  let buf = '';
  let bufIndent = 0;
  let pending = -1;   // 次に出すトークンの前で改行する（値はインデント段数）
  let prev = null;    // 直前に出したトークン
  let noSpaceNext = false;

  const flushLine = () => {
    if (buf !== '') { lines.push(indentText.repeat(bufIndent) + buf); buf = ''; }
  };
  /** 改行を予約する（compact のときは何もしない） */
  const brk = (level) => { if (!o.compact) pending = level < 0 ? 0 : level; };

  const needSpace = (tok) => {
    if (noSpaceNext) { noSpaceNext = false; return false; }
    if (buf === '' || !prev) return false;
    if (prev.value === '.' || prev.value === '::') return false;
    if (tok.value === '.' || tok.value === '::') return false;
    if (tok.value === ',' || tok.value === ';' || tok.value === ')') return false;
    if (prev.value === '(') return false;
    if (tok.value === '(') {
      // 関数呼び出しの ( は名前に付ける。INSERT INTO t (a, b) のような列の並びだけは空ける
      if (prev.type === 'word') {
        if (SQL_FUNCTIONS.has(prev.upper)) return false;
        if (SQL_KEYWORDS.has(prev.upper) || prev.upper.indexOf(' ') !== -1) return true;
        return SQL_PAREN_AFTER_NAME.has(top().clause);
      }
      if (prev.type === 'quoted') return SQL_PAREN_AFTER_NAME.has(top().clause);
      if (prev.type === 'param') return false;
      return true;
    }
    return true;
  };

  const emit = (text, tok) => {
    if (pending >= 0) { flushLine(); bufIndent = pending; pending = -1; prev = null; }
    const space = needSpace(tok);
    buf = buf === '' ? text : buf + (space ? ' ' : '') + text;
    prev = tok;
  };

  /** 語トークンを表記ルールに合わせて出す */
  const emitWord = (t) => {
    if (sqlIsKeyword(t)) emit(sqlApplyCase(t, o.keywordCase), t);
    else if (SQL_FUNCTIONS.has(t.upper)) emit(sqlApplyCase(t, o.functionCase), t);
    else emit(t.raw, t);
  };

  const newFrame = (kind, base, open) => ({ kind, base, open, clause: '', body: base + 1 });
  let frames = [newFrame('root', 0, 0)];
  const top = () => frames[frames.length - 1];
  const caseStack = [];
  let betweenDepth = 0;

  const bodyBreak = (clause) => (o.breakColumns && SQL_BODY_BREAK.has(clause)) || (o.expandClauses && SQL_CLAUSES.has(clause));
  const commaBreak = (clause) => bodyBreak(clause) || (o.expandClauses && (clause === 'FROM' || clause === 'GROUP BY' || clause === 'ORDER BY'));

  /* ---- 集計と指摘のための情報 ---- */
  let keywords = 0;
  let depth = 0;
  let statements = 0;
  let openStatement = false;   // 直近の「;」より後に中身があるか
  let openParens = 0;
  let extraClose = 0;
  let selectStar = 0;
  let implicitJoin = 0;
  let params = 0;
  let cased = 0;
  let stmtKind = '';
  let stmtHasWhere = false;
  const noWhere = [];
  const endStatement = () => {
    if (stmtKind && !stmtHasWhere && noWhere.indexOf(stmtKind) === -1) noWhere.push(stmtKind);
    stmtKind = '';
    stmtHasWhere = false;
  };

  for (let i = 0; i < toks.length; i += 1) {
    const t = toks[i];
    const next = sqlNextSig(toks, i);
    const kw = t.type === 'word' ? t.upper : '';
    if (t.type !== 'lineComment' && t.type !== 'blockComment') {
      if (t.value !== ';') openStatement = true;
      if (t.type === 'param') params += 1;
      if (sqlIsKeyword(t) || SQL_FUNCTIONS.has(kw)) {
        keywords += 1;
        if (t.raw !== sqlApplyCase(t, o.keywordCase)) cased += 1;
      }
    }

    /* ---- コメント ---- */
    if (t.type === 'lineComment') {
      emit(t.value, t);
      pending = bufIndent;   // 行コメントの後は必ず改行する（compact でも同じ）
      continue;
    }
    if (t.type === 'blockComment') {
      emit(t.value.indexOf('\n') === -1 ? t.value : t.value, t);
      continue;
    }

    /* ---- 句（行頭に置く） ---- */
    if (t.type === 'word' && (SQL_CLAUSES.has(kw) || SQL_SETOPS.has(kw))) {
      const f = top();
      if (kw === 'UPDATE' || kw === 'DELETE FROM') { endStatement(); stmtKind = kw === 'UPDATE' ? 'UPDATE' : 'DELETE'; }
      if (kw === 'WHERE') stmtHasWhere = true;
      // OVER (PARTITION BY … ORDER BY …) のように括弧の中に入った句は折り返さない
      if (f.kind === 'args') { emitWord(t); continue; }
      brk(f.base);
      emitWord(t);
      if (SQL_SETOPS.has(kw)) { f.clause = ''; f.body = f.base + 1; brk(f.base); continue; }
      f.clause = kw;
      f.body = f.base + 1;
      // SELECT DISTINCT / SELECT TOP 10 は SELECT と同じ行に置く
      if (kw === 'SELECT') {
        while (toks[i + 1] && toks[i + 1].type === 'word' && SQL_SELECT_MODIFIERS.has(toks[i + 1].upper)) {
          i += 1;
          emitWord(toks[i]);
          if (toks[i].upper === 'TOP' && toks[i + 1] && toks[i + 1].type === 'number') { i += 1; emit(toks[i].value, toks[i]); }
        }
        // SELECT * だけは1行のままにする（1文字のために2行使わない）
        const star = toks[i + 1];
        const afterStar = toks[i + 2];
        if (star && star.value === '*' && afterStar && afterStar.type === 'word' && afterStar.upper === 'FROM') {
          i += 1;
          emit('*', star);
          selectStar += 1;
          continue;
        }
      }
      if (bodyBreak(kw)) brk(f.body);
      continue;
    }

    /* ---- JOIN ---- */
    if (t.type === 'word' && SQL_JOINS.has(kw)) {
      const f = top();
      brk(f.base);
      emitWord(t);
      f.clause = 'JOIN';
      f.body = f.base + 1;
      continue;
    }

    /* ---- 結合条件 ---- */
    if (t.type === 'word' && (kw === 'ON' || kw === 'USING') && top().clause === 'JOIN') {
      const f = top();
      if (o.breakOn) brk(f.base + 1);
      emitWord(t);
      f.clause = 'ON';
      f.body = f.base + 1;
      continue;
    }

    /* ---- AND / OR ---- */
    if (t.type === 'word' && (kw === 'AND' || kw === 'OR')) {
      if (kw === 'AND' && betweenDepth > 0) { betweenDepth -= 1; emitWord(t); continue; }
      const f = top();
      if (o.breakLogic && SQL_LOGIC_CLAUSES.has(f.clause)) {
        if (o.logicStyle === 'leading') { brk(f.body); emitWord(t); } else { emitWord(t); brk(f.body); }
      } else {
        emitWord(t);
      }
      continue;
    }
    if (kw === 'BETWEEN') { betweenDepth += 1; emitWord(t); continue; }

    /* ---- CASE 式 ---- */
    if (kw === 'CASE' && o.breakCase) {
      emitWord(t);
      caseStack.push(bufIndent);
      continue;
    }
    if ((kw === 'WHEN' || kw === 'ELSE') && caseStack.length) {
      brk(caseStack[caseStack.length - 1] + 1);
      emitWord(t);
      continue;
    }
    if (kw === 'END' && caseStack.length) {
      brk(caseStack.pop());
      emitWord(t);
      continue;
    }

    /* ---- 括弧 ---- */
    if (t.value === '(' && t.type === 'punct') {
      emit('(', t);
      const sub = o.breakSubquery && !o.compact && next && next.type === 'word'
        && (next.upper === 'SELECT' || next.upper === 'WITH' || next.upper === 'WITH RECURSIVE' || next.upper === 'VALUES');
      const isSub = next && next.type === 'word'
        && (next.upper === 'SELECT' || next.upper === 'WITH' || next.upper === 'WITH RECURSIVE');
      if (sub) {
        frames.push(newFrame('sub', bufIndent + 1, bufIndent));
        brk(bufIndent + 1);
      } else {
        frames.push(newFrame('args', bufIndent, bufIndent));
      }
      frames[frames.length - 1].subquery = isSub;
      if (isSub) {
        // 深さはサブクエリの入れ子の数で数える（関数の括弧は数えない）
        let n = 0;
        for (const f of frames) if (f.subquery) n += 1;
        if (n > depth) depth = n;
      }
      openParens += 1;
      continue;
    }
    if (t.value === ')' && t.type === 'punct') {
      if (frames.length > 1) {
        const f = frames.pop();
        openParens -= 1;
        if (f.kind === 'sub') brk(f.open);
      } else {
        extraClose += 1;
      }
      emit(')', t);
      continue;
    }

    /* ---- カンマ ---- */
    if (t.value === ',' && t.type === 'punct') {
      const f = top();
      if (f.clause === 'FROM' && f.kind !== 'args') implicitJoin += 1;
      if (f.kind === 'args' || !commaBreak(f.clause)) { emit(',', t); continue; }
      if (o.commaStyle === 'leading') { brk(f.body); emit(',', t); } else { emit(',', t); brk(f.body); }
      continue;
    }

    /* ---- 文の区切り ---- */
    if (t.value === ';' && t.type === 'punct') {
      emit(';', t);
      flushLine();
      if (openStatement) statements += 1;
      openStatement = false;
      endStatement();
      frames = [newFrame('root', 0, 0)];
      caseStack.length = 0;
      betweenDepth = 0;
      if (next) lines.push('');
      pending = 0;
      continue;
    }

    /* ---- そのほか ---- */
    if (t.type === 'word') {
      if (kw === 'INSERT INTO') stmtKind = 'INSERT';
      emitWord(t);
      continue;
    }
    if (t.value === '*' && prev && prev.type === 'word' && prev.upper === 'SELECT') selectStar += 1;
    if ((t.value === '-' || t.value === '+') && (!prev || prev.value === '(' || prev.value === ',' || prev.type === 'op'
      || (prev.type === 'word' && SQL_KEYWORDS.has(prev.upper)))) {
      emit(t.value, t);
      noSpaceNext = true;
      continue;
    }
    emit(t.value, t);
  }
  flushLine();
  if (openStatement) statements += 1;
  endStatement();

  while (lines.length && lines[lines.length - 1] === '') lines.pop();
  const text = lines.length ? lines.join('\n') + '\n' : '';

  /* ---- 指摘 ---- */
  const notes = [];
  if (lex.unterminatedString) notes.push(sqlNote('UNTERMINATED_STRING'));
  if (lex.unterminatedComment) notes.push(sqlNote('UNTERMINATED_COMMENT'));
  if (openParens > 0) notes.push(sqlNote('UNBALANCED_OPEN', { count: openParens }));
  if (extraClose > 0) notes.push(sqlNote('UNBALANCED_CLOSE', { count: extraClose }));
  for (const kind of noWhere) notes.push(sqlNote('NO_WHERE', { kind }));
  if (selectStar) notes.push(sqlNote('SELECT_STAR', { count: selectStar }));
  if (implicitJoin) notes.push(sqlNote('IMPLICIT_JOIN', { count: implicitJoin }));
  if (params) notes.push(sqlNote('PLACEHOLDERS', { count: params }));
  if (cased && o.keywordCase !== 'preserve') notes.push(sqlNote('CASED', { count: cased, mode: o.keywordCase }));

  return {
    text: o.eol === 'crlf' ? text.replace(/\n/g, '\r\n') : text,
    lines: lines.length,
    statements,
    depth,
    keywords,
    tokens: toks.length,
    notes,
  };
}

/* ==================== ここまで整形コア ==================== */

export class SqlFormatError extends Error {}

// 指摘の文面（site側は同じ code を日英の T テーブルで出し分けている）
const NOTE_TEXT = {
  UNTERMINATED_STRING: () => '引用符が閉じていません。以降がすべて文字列として読まれているため、結果がずれている可能性があります。',
  UNTERMINATED_COMMENT: () => '/* ブロックコメント */ が閉じていません。以降がすべてコメントとして扱われています。',
  UNBALANCED_OPEN: (p) => `閉じていない「(」が ${p.count} 個あります。そこから先のインデントは推測になっています。`,
  UNBALANCED_CLOSE: (p) => `対応する「(」の無い「)」が ${p.count} 個あります。`,
  NO_WHERE: (p) => `${p.kind} に WHERE がありません。テーブルの全行が対象になります。`,
  SELECT_STAR: (p) => `SELECT * を ${p.count} 箇所で使っています。必要な列を並べて書くと、テーブルの列が増えても結果が変わりません。`,
  IMPLICIT_JOIN: (p) => `FROM 句にテーブルを ${p.count + 1} 個カンマで並べています（暗黙の結合）。INNER JOIN … ON と書くと結合条件が目に見えます。`,
  PLACEHOLDERS: (p) => `プレースホルダを ${p.count} 個見つけました（? / :name / $1）。値を文字列連結せずプレースホルダのまま渡すことがSQLインジェクション対策そのものです。`,
  CASED: (p) => `予約語 ${p.count} 語を${p.mode === 'lower' ? '小' : '大'}文字にしました。`,
};

const noteMessage = (n) => (NOTE_TEXT[n.code] ? NOTE_TEXT[n.code](n.params || {}) : n.code);

/**
 * 1行のSQLを読みやすく整形する（site側の /sql-format/ と同一ロジック）。
 *
 * @param {object} opts
 * @param {string} [opts.text]        対象のSQL（path と排他）
 * @param {string} [opts.path]        対象ファイルの絶対パス（UTF-8として読む）
 * @param {string} [opts.outputPath]  結果を書き出す絶対パス（指定すると text は返さない）
 * @param {'upper'|'lower'|'preserve'} [opts.keywordCase='upper'] 予約語の表記
 * @param {'upper'|'lower'|'preserve'} [opts.functionCase='upper'] 関数名の表記
 * @param {'2'|'4'|'8'|'tab'} [opts.indent='4'] インデントの幅
 * @param {'trailing'|'leading'} [opts.commaStyle='trailing'] カンマの位置
 * @param {'leading'|'trailing'} [opts.logicStyle='leading'] AND / OR の位置
 * @param {boolean} [opts.breakColumns=true]  SELECT の列などを1行ずつに分けるか
 * @param {boolean} [opts.breakLogic=true]    AND / OR で折り返すか
 * @param {boolean} [opts.breakOn=true]       JOIN の ON を改行するか
 * @param {boolean} [opts.breakCase=true]     CASE 式を展開するか
 * @param {boolean} [opts.breakSubquery=true] サブクエリを字下げして展開するか
 * @param {boolean} [opts.expandClauses=false] 句の中身も次の行から書くか
 * @param {boolean} [opts.compact=false]      改行を畳んで1行にまとめるか
 * @param {'lf'|'crlf'} [opts.eol='lf']       出力の改行コード
 * @returns {Promise<object>}
 */
export async function sqlFormatTool(opts = {}) {
  const hasText = typeof opts.text === 'string';
  if (hasText === Boolean(opts.path)) throw new SqlFormatError('text か path のどちらか一方を渡してください');

  // 画面側（URLパラメータ）は不正値を既定へ落とすが、MCPでは黙って別の設定で返さない
  const check = (name, value, allowed) => {
    if (value === undefined || value === null) return;
    if (allowed.indexOf(String(value)) === -1) {
      throw new SqlFormatError(`${name} は ${allowed.join(' / ')} のいずれかを指定してください（受け取った値: ${value}）`);
    }
  };
  check('keywordCase', opts.keywordCase, SQL_CASE_MODES);
  check('functionCase', opts.functionCase, SQL_CASE_MODES);
  check('indent', opts.indent, SQL_INDENT_STYLES);
  check('commaStyle', opts.commaStyle, SQL_COMMA_STYLES);
  check('logicStyle', opts.logicStyle, SQL_LOGIC_STYLES);
  check('eol', opts.eol, ['lf', 'crlf']);

  const source = hasText ? opts.text : await readFile(opts.path, 'utf8');
  if (String(source).trim() === '') throw new SqlFormatError('整形するSQLが空です');
  const o = sqlOptions(opts);
  const r = sqlFormat(source, o);

  const result = {
    source: hasText ? { type: 'text' } : { path: opts.path, name: basename(opts.path) },
    text: r.text,
    lines: r.lines,
    statements: r.statements,
    subquery_depth: r.depth,
    keywords: r.keywords,
    tokens: r.tokens,
    options: {
      keyword_case: o.keywordCase,
      function_case: o.functionCase,
      indent: o.indent,
      comma_style: o.commaStyle,
      logic_style: o.logicStyle,
      break_columns: o.breakColumns,
      break_logic: o.breakLogic,
      break_on: o.breakOn,
      break_case: o.breakCase,
      break_subquery: o.breakSubquery,
      expand_clauses: o.expandClauses,
      compact: o.compact,
      eol: o.eol,
    },
    notes: r.notes.map((n) => ({ code: n.code, message: noteMessage(n) })),
  };
  if (opts.outputPath) {
    await writeFile(opts.outputPath, r.text, 'utf8');
    result.output = opts.outputPath;
    // ファイルに書けたなら本文は重複した重い情報でしかない
    delete result.text;
  }
  return result;
}
