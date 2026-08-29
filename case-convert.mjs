// 文字列のケース変換（tools.first-ch.com/case/ と同一ロジック）
//
// 「変換コア」ブロックは site 側の site/case/app.js と同一の実装。
// 2箇所ルール: 片方を直したらもう片方も同じ内容で直す（site側が正本）。
// 使っているのは String/RegExp だけなので、ブラウザ版のコードをそのまま持ってこられる。
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

/* ==================== ここから変換コア（site / MCP で同一） ==================== */

// 出力できるケースの一覧（表示名は呼び出し側で訳す）
export const CASE_FORMATS = ['camel', 'pascal', 'snake', 'constant', 'kebab', 'train', 'dot', 'title', 'sentence', 'lower', 'upper'];

// 形式ごとの見本。UIのボタンとMCPの説明で同じものを使う
export const CASE_EXAMPLES = {
  camel: 'userName',
  pascal: 'UserName',
  snake: 'user_name',
  constant: 'USER_NAME',
  kebab: 'user-name',
  train: 'User-Name',
  dot: 'user.name',
  title: 'User Name',
  sentence: 'User name',
  lower: 'user name',
  upper: 'USER NAME',
};

// 語の分かち書き。大文字の連なり（頭字語）は「大文字＋小文字」が続くときだけ手前で切るので、
// XMLHttpRequest → XML / Http / Request になる（XMLH / ttpRequest にはならない）。
// 最後の枝は「大文字でも小文字でもない文字」＝仮名や漢字のように大小の別を持たない文字の連なり。
const CASE_TOKEN_RE = /\p{Lu}+(?=\p{Lu}\p{Ll})|\p{Lu}?\p{Ll}+|\p{Lu}+|\p{N}+|(?:(?!\p{Lu}|\p{Ll})\p{L})+/gu;
const CASE_SEP_RE = /[^\p{L}\p{N}]+/u;
const DIGITS_RE = /^\p{N}+$/u;

/**
 * 識別子を単語へ割る。記号・空白はすべて区切りとして落とす。
 * @param {string} str
 * @param {object} [opts]
 * @param {boolean} [opts.splitDigits=false] 数字を独立した語として扱う（false なら sha256 は1語）
 */
export function splitWords(str, opts) {
  const splitDigits = Boolean((opts || {}).splitDigits);
  const words = [];
  for (const chunk of String(str).split(CASE_SEP_RE)) {
    if (!chunk) continue;
    const tokens = chunk.match(CASE_TOKEN_RE) || [];
    const merged = [];
    for (const token of tokens) {
      if (!splitDigits && DIGITS_RE.test(token) && merged.length) {
        // 区切りをまたいでいない数字は直前の語へ付ける（sha256 / user2 を割らない）
        merged[merged.length - 1] += token;
        continue;
      }
      merged.push(token);
    }
    // 先頭の数字は付ける相手がいないので、続きが小文字始まりのときだけ後ろへ寄せる
    // （2fa は1語、2FactorAuth は意図的な区切りとみなして割ったまま）
    if (!splitDigits && merged.length > 1 && DIGITS_RE.test(merged[0]) && /^\p{Ll}/u.test(merged[1])) {
      merged[1] = merged[0] + merged[1];
      merged.shift();
    }
    for (const word of merged) words.push(word);
  }
  return words;
}

// 全部が大文字（＋数字）で2文字以上なら頭字語とみなす: ID / URL / HTTP2
export function isAcronym(word) {
  return [...word].length >= 2 && /^\p{Lu}[\p{Lu}\p{N}]*$/u.test(word);
}

// 先頭だけ大文字。サロゲートペアを割らないよう配列にしてから触る
export function capitalize(word) {
  const chars = [...word];
  return chars[0].toUpperCase() + chars.slice(1).join('').toLowerCase();
}

/**
 * 単語列を1つの文字列へ組み立てる。
 * @param {string[]} words
 * @param {string} format CASE_FORMATS のいずれか
 * @param {object} [opts]
 * @param {boolean} [opts.keepAcronyms=false] 頭字語を大文字のまま残す（camel/pascal/train/title/sentence のみ）
 */
export function joinWords(words, format, opts) {
  const keep = Boolean((opts || {}).keepAcronyms);
  const cap = (word) => (keep && isAcronym(word) ? word : capitalize(word));
  const low = (word) => word.toLowerCase();
  const up = (word) => word.toUpperCase();
  switch (format) {
    // camelCase の先頭語は頭字語でも小文字にする（URLParser → urlParser）
    case 'camel': return words.map((w, i) => (i === 0 ? low(w) : cap(w))).join('');
    case 'pascal': return words.map(cap).join('');
    case 'snake': return words.map(low).join('_');
    case 'constant': return words.map(up).join('_');
    case 'kebab': return words.map(low).join('-');
    case 'train': return words.map(cap).join('-');
    case 'dot': return words.map(low).join('.');
    case 'title': return words.map(cap).join(' ');
    case 'sentence': return words.map((w, i) => (i === 0 ? cap(w) : low(w))).join(' ');
    case 'lower': return words.map(low).join(' ');
    case 'upper': return words.map(up).join(' ');
    default: return '';
  }
}

// 1件ぶんの変換（前後の空白は落とさずそのまま返す側で足す）
export function convertToken(token, format, opts) {
  const words = splitWords(token, opts);
  return words.length ? joinWords(words, format, opts) : token;
}

/**
 * 入力がどの形式で書かれているかを推定する。
 * 「その形式へ変換した結果が入力と一致するか」で判定するので、分かち書きの規則と必ず揃う。
 * 候補が複数残る（user のような1語）ときは 'ambiguous' を返す。
 */
export function detectCase(str, opts) {
  const s = String(str).trim();
  if (!s) return 'empty';
  const words = splitWords(s, opts);
  if (!words.length) return 'unknown';
  // 頭字語を残した書き方（XMLHttpRequest）も同じ形式とみなす
  const matches = CASE_FORMATS.filter(
    (f) => joinWords(words, f, opts) === s || joinWords(words, f, { keepAcronyms: true }) === s,
  );
  if (!matches.length) return 'mixed';
  if (matches.length > 1) return words.length === 1 ? 'ambiguous' : matches[0];
  return matches[0];
}

// 行をセルへ割るときの区切り。タブがあればタブ、無ければカンマ（CSVヘッダー向け）
function pickDelimiter(line) {
  return line.indexOf('\t') !== -1 ? '\t' : ',';
}

/**
 * テキストをまとめて変換する。
 *
 * @param {object} opts
 * @param {string} opts.text 変換するテキスト
 * @param {string} [opts.format='camel'] 変換先（CASE_FORMATS）
 * @param {'lines'|'items'|'whole'} [opts.scope='lines'] 1行1件 / 行内をカンマ・タブで分ける / 全体で1件
 * @param {boolean} [opts.splitDigits=false] 数字を独立した語として扱う
 * @param {boolean} [opts.keepAcronyms=false] 頭字語を大文字のまま残す
 * @returns {{format,scope,text,items,stats,notes}}
 */
export function caseConvert(opts) {
  const o = opts || {};
  const format = CASE_FORMATS.indexOf(o.format) !== -1 ? o.format : 'camel';
  const scope = o.scope === 'items' || o.scope === 'whole' ? o.scope : 'lines';
  const input = typeof o.text === 'string' ? o.text : '';
  const items = [];
  let caseless = 0;
  let acronym = 0;

  // 前後の空白を保ったまま中身だけ変換する（表の列やインデントを崩さないため）
  const cell = (raw) => {
    const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(raw);
    const body = m[2];
    if (!body || !/[\p{L}\p{N}]/u.test(body)) return raw;
    const words = splitWords(body, o);
    const out = joinWords(words, format, o);
    // 大小の別を持たない文字（仮名・漢字など）は変換しても変わらないので件数だけ数える
    if (words.some((w) => /\p{L}/u.test(w) && w.toLowerCase() === w.toUpperCase())) caseless += 1;
    if (!o.keepAcronyms && words.some(isAcronym)) acronym += 1;
    items.push({ input: body, output: out, detected: detectCase(body, o), words: words.length });
    return m[1] + out + m[3];
  };

  let text;
  if (scope === 'whole') {
    text = cell(input);
  } else {
    // 改行そのものを残したいので、キャプチャ付きの split で区切りごと配列に入れる
    const parts = input.split(/(\r\n|\n|\r)/);
    text = parts
      .map((part, i) => {
        if (i % 2 === 1) return part; // 改行はそのまま
        if (scope !== 'items') return cell(part);
        const delim = pickDelimiter(part);
        return part.split(delim).map(cell).join(delim);
      })
      .join('');
  }

  const changed = items.filter((it) => it.input !== it.output).length;
  const seen = new Map();
  const duplicates = [];
  for (const it of items) {
    const n = (seen.get(it.output) || 0) + 1;
    seen.set(it.output, n);
    if (n === 2) duplicates.push(it.output);
  }
  const leadingDigit = items.filter((it) => /^\p{N}/u.test(it.output)).length;

  // 推定した元の形式は最頻値を採る（1行ずつばらばらなら mixed が多数になる）
  const tally = new Map();
  for (const it of items) tally.set(it.detected, (tally.get(it.detected) || 0) + 1);
  let detected = items.length ? 'unknown' : 'empty';
  let best = 0;
  for (const [key, n] of tally) {
    if (n > best) {
      best = n;
      detected = key;
    }
  }

  const notes = [];
  if (!items.length) notes.push({ code: 'NOTHING' });
  if (duplicates.length) notes.push({ code: 'DUPLICATE', count: duplicates.length, items: duplicates.slice(0, 8) });
  if (leadingDigit) notes.push({ code: 'LEADING_DIGIT', count: leadingDigit });
  if (caseless) notes.push({ code: 'CASELESS', count: caseless });
  if (acronym) notes.push({ code: 'ACRONYM', count: acronym });
  if (items.length && changed === 0) notes.push({ code: 'UNCHANGED' });

  return {
    format,
    scope,
    text,
    items,
    stats: {
      items: items.length,
      changed,
      unchanged: items.length - changed,
      detected,
      words: items.reduce((sum, it) => sum + it.words, 0),
      duplicates: duplicates.length,
    },
    notes,
  };
}

/* ==================== ここまで変換コア ==================== */

// 形式の呼び名（site側の FORMAT_NAMES と同じ）
const FORMAT_NAMES = {
  camel: 'camelCase',
  pascal: 'PascalCase',
  snake: 'snake_case',
  constant: 'CONSTANT_CASE',
  kebab: 'kebab-case',
  train: 'Train-Case',
  dot: 'dot.case',
  title: 'Title Case',
  sentence: 'Sentence case',
  lower: 'lower case',
  upper: 'UPPER CASE',
};

// 形式ごとの主な使いどころ（listFormats で返す。site側の「どの形式を使うか」タブと同じ内容）
const FORMAT_USES = {
  camel: { ja: 'JavaScript・Java・Swift の変数と関数、JSONのキー', en: 'Variables and functions in JavaScript, Java and Swift; JSON keys' },
  pascal: { ja: 'クラス名・型名、React / Vue のコンポーネント名、C# の公開メンバー', en: 'Class and type names, React / Vue components, public members in C#' },
  snake: { ja: 'Python・Ruby・PHP の変数と関数、SQLのテーブル名と列名', en: 'Variables and functions in Python, Ruby and PHP; SQL tables and columns' },
  constant: { ja: '定数、環境変数（.env）、Makefile の変数', en: 'Constants, environment variables (.env), Makefile variables' },
  kebab: { ja: 'URLのパス、CSSのクラス名、HTMLの属性、npmパッケージ名、ファイル名', en: 'URL paths, CSS classes, HTML attributes, npm package names, file names' },
  train: { ja: 'HTTPヘッダー名（Content-Type / X-Request-Id）', en: 'HTTP header names (Content-Type / X-Request-Id)' },
  dot: { ja: '設定キー（application.properties）、名前空間、ログのフィールド名', en: 'Configuration keys (application.properties), namespaces, log field names' },
  title: { ja: '見出し、表の列見出し、UIのラベル', en: 'Headings, table column headers, UI labels' },
  sentence: { ja: '本文、説明文、フォームのラベル', en: 'Body copy, descriptions, form labels' },
  lower: { ja: '検索用の正規化、タグ', en: 'Normalising for search, tags' },
  upper: { ja: '見出しの強調、印刷物の項目名', en: 'Emphasised headings, printed field names' },
};

// 指摘事項のコード → 文。site側は同じコードを日英それぞれの文へ訳している
const NOTE_TEXT = {
  ja: {
    NOTHING: () => '変換できる文字がありませんでした。',
    DUPLICATE: (n, items) => `変換後に同じ名前になる組が ${n} 件あります: ${items.join(' / ')} — CSVのヘッダーや列名では衝突します。`,
    LEADING_DIGIT: (n) => `結果のうち ${n} 件が数字で始まります。多くの言語では識別子を数字で始められません。`,
    CASELESS: (n) => `大文字・小文字の区別を持たない文字（日本語など）を含む項目が ${n} 件あります。そのまま出力しています。`,
    ACRONYM: (n) => `連続する大文字（ID・URL・XMLなど）を含む項目が ${n} 件あります。既定では Id / Url / Xml へ畳みます（keepAcronyms=true で残せます）。`,
    UNCHANGED: () => 'すべての項目がすでにこの形式でした（変更はありません）。',
    TRUNCATED: (n) => `項目が多いため、items には先頭 ${n} 件だけを入れています（text は全件を変換済みです）。`,
  },
  en: {
    NOTHING: () => 'There was nothing to convert.',
    DUPLICATE: (n, items) => `${n} name(s) end up identical after conversion: ${items.join(' / ')} — CSV headers and column names will collide.`,
    LEADING_DIGIT: (n) => `${n} result(s) start with a digit. Most languages do not allow an identifier to start with a number.`,
    CASELESS: (n) => `${n} item(s) contain characters that have no upper/lower case (Japanese, for example). They are passed through unchanged.`,
    ACRONYM: (n) => `${n} item(s) contain a run of capitals (ID, URL, XML…), which is folded to Id / Url / Xml by default (keepAcronyms=true keeps them).`,
    UNCHANGED: () => 'Every item was already written in this case, so nothing changed.',
    TRUNCATED: (n) => `Only the first ${n} items are listed in items (text holds the full conversion).`,
  },
};

const MAX_ITEMS = 200;      // items 配列に載せる上限（text は常に全件変換する）
const MAX_ALL_FORMATS = 20; // allFormats で全形式を展開する上限

export class CaseConvertError extends Error {}

/**
 * テキスト（または UTF-8 のテキストファイル）の識別子を、指定したケースへ変換する。
 *
 * @param {object} opts
 * @param {string} [opts.text]        変換するテキスト（path と排他）
 * @param {string} [opts.path]        変換するファイルの絶対パス（UTF-8として読む）
 * @param {string} [opts.outputPath]  結果を書き出す絶対パス（指定すると text は返さない）
 * @param {string} [opts.format='camel'] 変換先（camel/pascal/snake/constant/kebab/train/dot/title/sentence/lower/upper）
 * @param {'lines'|'items'|'whole'} [opts.scope='lines'] 1行1件 / 行内をカンマ・タブで分ける / 全体で1件
 * @param {boolean} [opts.splitDigits=false] 数字を独立した語として扱う（sha256 → sha_256）
 * @param {boolean} [opts.keepAcronyms=false] 頭字語を大文字のまま残す（parseXMLData）
 * @param {boolean} [opts.allFormats=false] 各項目を全形式へ展開して返す
 * @param {boolean} [opts.listFormats=false] 変換せず、形式の一覧と使いどころだけを返す
 * @param {'ja'|'en'} [opts.lang='ja'] 指摘事項の言語
 */
export async function caseConvertTool(opts = {}) {
  const lang = opts.lang || 'ja';
  if (lang !== 'ja' && lang !== 'en') throw new CaseConvertError(`lang は ja か en: ${opts.lang}`);

  if (opts.listFormats) {
    return {
      count: CASE_FORMATS.length,
      formats: CASE_FORMATS.map((id) => ({
        id,
        name: FORMAT_NAMES[id],
        example: CASE_EXAMPLES[id],
        used_for: FORMAT_USES[id][lang],
      })),
    };
  }

  const format = opts.format === undefined ? 'camel' : opts.format;
  if (CASE_FORMATS.indexOf(format) === -1) {
    throw new CaseConvertError(`format は ${CASE_FORMATS.join(' / ')} のいずれか: ${opts.format}`);
  }
  const scope = opts.scope === undefined ? 'lines' : opts.scope;
  if (['lines', 'items', 'whole'].indexOf(scope) === -1) {
    throw new CaseConvertError(`scope は lines / items / whole のいずれか: ${opts.scope}`);
  }
  const hasText = typeof opts.text === 'string';
  if (hasText === Boolean(opts.path)) throw new CaseConvertError('text か path のどちらか一方を渡してください');

  const input = hasText ? opts.text : await readFile(opts.path, 'utf8');
  const r = caseConvert({
    text: input,
    format,
    scope,
    splitDigits: Boolean(opts.splitDigits),
    keepAcronyms: Boolean(opts.keepAcronyms),
  });

  const notes = r.notes.slice();
  const shown = r.items.slice(0, MAX_ITEMS);
  if (r.items.length > shown.length) notes.push({ code: 'TRUNCATED', count: shown.length });

  const items = shown.map((it, i) => {
    const entry = {
      input: it.input,
      output: it.output,
      detected: it.detected,
      words: it.words,
    };
    if (opts.allFormats && i < MAX_ALL_FORMATS) {
      const words = splitWords(it.input, { splitDigits: Boolean(opts.splitDigits) });
      entry.all = {};
      for (const key of CASE_FORMATS) {
        entry.all[key] = joinWords(words, key, { keepAcronyms: Boolean(opts.keepAcronyms) });
      }
    }
    return entry;
  });

  const result = {
    format,
    format_name: FORMAT_NAMES[format],
    scope,
    source: hasText ? { type: 'text' } : { path: opts.path, name: basename(opts.path) },
    text: r.text,
    items,
    stats: r.stats,
    options: {
      split_digits: Boolean(opts.splitDigits),
      keep_acronyms: Boolean(opts.keepAcronyms),
    },
    notes: notes.map((n) => ({
      code: n.code,
      message: NOTE_TEXT[lang][n.code] ? NOTE_TEXT[lang][n.code](n.count, n.items || []) : n.code,
    })),
  };
  if (opts.outputPath) {
    await writeFile(opts.outputPath, r.text, 'utf8');
    result.output = opts.outputPath;
    // ファイルに書けたなら本文は重複した重い情報でしかない
    delete result.text;
  }
  return result;
}
