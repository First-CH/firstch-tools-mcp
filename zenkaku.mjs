// 全角⇄半角の変換とテキストの掃除（tools.first-ch.com/zenkaku/ と同一ロジック）
//
// 「変換コア」ブロックは site 側の site/zenkaku/app.js と同一の実装。
// 2箇所ルール: 片方を直したらもう片方も同じ内容で直す（site側が正本）。
// 使っているのは String/RegExp/Map だけなので、ブラウザ版のコードをそのまま持ってこられる。
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

/* ==================== ここから変換コア（site / MCP で同一） ==================== */

// 変換の対象にできる文字種と、各文字種で選べる向き
export const ZK_TARGETS = ['alnum', 'kana', 'symbol', 'space'];
export const ZK_DIRECTIONS = ['keep', 'han', 'zen'];
export const ZK_BLANK = ['keep', 'collapse', 'remove'];

// 半角カタカナブロック（U+FF61〜U+FF9F）と、対応する全角。添字どうしが対応する
export const KANA_HAN = '｡｢｣､･ｦｧｨｩｪｫｬｭｮｯｰｱｲｳｴｵｶｷｸｹｺｻｼｽｾｿﾀﾁﾂﾃﾄﾅﾆﾇﾈﾉﾊﾋﾌﾍﾎﾏﾐﾑﾒﾓﾔﾕﾖﾗﾘﾙﾚﾛﾜﾝﾞﾟ';
export const KANA_ZEN = '。「」、・ヲァィゥェォャュョッーアイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワン゛゜';

// 濁点・半濁点つきの全角カナと、その素の字（半角では2文字に分かれる）
const DAKU_ZEN = 'ガギグゲゴザジズゼゾダヂヅデドバビブベボヴヷヺ';
const DAKU_BASE = 'カキクケコサシスセソタチツテトハヒフヘホウワヲ';
const HANDAKU_ZEN = 'パピプペポ';
const HANDAKU_BASE = 'ハヒフヘホ';

// 濁点として書かれうる3種（半角・全角・結合文字）。macOSのファイル名は結合文字で来ることがある
const MARK_DAKU = '\uFF9E\u309B\u3099';
const MARK_HANDAKU = '\uFF9F\u309C\u309A';

// 半角スペース扱いにする空白（NBSP・欧文の各種スペース）。Wordやブラウザからの貼り付けで混ざる
const SPACE_ODD = '\u00A0\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200A\u202F\u205F';

// 見えない文字（ゼロ幅・BOM・書字方向指示・制御文字）。改行とタブは残す
const INVISIBLE_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u00AD\u200B-\u200F\u2028\u2029\u202A-\u202E\u2060-\u2064\u206A-\u206F\uFEFF]/g;

// 空白として畳んだり削ったりする文字（改行は含めない）
const SPACE_CLASS = '\u0020\u0009\u3000' + SPACE_ODD;
const SPACE_RUN_RE = new RegExp('[' + SPACE_CLASS + ']{2,}', 'g');
const SPACE_EDGE_RE = new RegExp('^[' + SPACE_CLASS + ']+|[' + SPACE_CLASS + ']+$', 'g');
const SPACE_ONLY_RE = new RegExp('^[' + SPACE_CLASS + ']*$');

// 環境依存文字（NEC特殊文字・IBM拡張の代表）。①㈱Ⅲ㍿ など、系によっては化ける字
const PLATFORM_RE = /[Ⅰ-ⅻ①-⑳㈠-㈩㈱㈹㊤-㊩㌃㌍㌔㌘㌢㌣㌦㌧㌫㌶㌻㍉㍊㍍㍑㍗㍻-㍾㎎㎏㎜-㎞㎡㏄㏋㏍]/g;

// 変換表を1度だけ組み立てる（半角→全角・全角→半角の両方向）
function buildTables() {
  const zen2han = { alnum: new Map(), kana: new Map(), symbol: new Map(), space: new Map() };
  const han2zen = { alnum: new Map(), kana: new Map(), symbol: new Map(), space: new Map() };

  // 英数字と記号は U+FF01〜U+FF5E がそのまま ASCII の 0x21〜0x7E に対応する（差は 0xFEE0）
  for (let cp = 0xff01; cp <= 0xff5e; cp += 1) {
    const zen = String.fromCharCode(cp);
    const han = String.fromCharCode(cp - 0xfee0);
    const isAlnum = (cp >= 0xff10 && cp <= 0xff19) || (cp >= 0xff21 && cp <= 0xff3a) || (cp >= 0xff41 && cp <= 0xff5a);
    const key = isAlnum ? 'alnum' : 'symbol';
    zen2han[key].set(zen, han);
    han2zen[key].set(han, zen);
  }

  // カタカナ（句読点・カギ括弧・中黒・長音も半角カナブロックにあるのでこの文字種に含める）
  for (let i = 0; i < KANA_ZEN.length; i += 1) {
    zen2han.kana.set(KANA_ZEN[i], KANA_HAN[i]);
    han2zen.kana.set(KANA_HAN[i], KANA_ZEN[i]);
  }
  // 濁点つきは全角1文字 ⇄ 半角2文字
  for (let i = 0; i < DAKU_ZEN.length; i += 1) {
    zen2han.kana.set(DAKU_ZEN[i], zen2han.kana.get(DAKU_BASE[i]) + 'ﾞ');
  }
  for (let i = 0; i < HANDAKU_ZEN.length; i += 1) {
    zen2han.kana.set(HANDAKU_ZEN[i], zen2han.kana.get(HANDAKU_BASE[i]) + 'ﾟ');
  }

  // スペース（全角スペースと、NBSPなど幅の違う欧文スペース）
  zen2han.space.set('\u3000', ' ');
  han2zen.space.set(' ', '\u3000');
  for (const ch of SPACE_ODD) {
    zen2han.space.set(ch, ' ');
    han2zen.space.set(ch, '\u3000');
  }

  // 半角カナ2文字 → 全角1文字を組み立てるための表
  const compose = { daku: new Map(), handaku: new Map() };
  for (let i = 0; i < DAKU_ZEN.length; i += 1) compose.daku.set(DAKU_BASE[i], DAKU_ZEN[i]);
  for (let i = 0; i < HANDAKU_ZEN.length; i += 1) compose.handaku.set(HANDAKU_BASE[i], HANDAKU_ZEN[i]);

  return { zen2han, han2zen, compose };
}

const ZK_TABLE = buildTables();

// 指定を正規化する（未知の値は既定へ倒す）
function normalizeDir(value, fallback) {
  return ZK_DIRECTIONS.indexOf(value) !== -1 ? value : fallback;
}

/**
 * 文字種ごとの指定に従って1文字ずつ変換する。
 * カナだけは半角2文字（ｶ＋ﾞ）と全角1文字（ガ）を行き来するので前後を見る。
 *
 * @param {string} text
 * @param {{alnum:string,kana:string,symbol:string,space:string}} dir 文字種ごとの向き
 * @returns {{text:string, converted:number}} converted は実際に書き換わった文字数
 */
export function convertWidth(text, dir) {
  const { zen2han, han2zen, compose } = ZK_TABLE;
  const chars = [...text];
  const out = [];
  let converted = 0;

  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i];
    let rep;

    if (dir.kana === 'zen') {
      // 半角カナ → 全角。次が濁点なら1文字に合成する（ｶﾞ → ガ）
      const base = han2zen.kana.get(ch) !== undefined ? han2zen.kana.get(ch) : (compose.daku.has(ch) || compose.handaku.has(ch) ? ch : undefined);
      if (base !== undefined) {
        const next = chars[i + 1];
        if (next !== undefined && MARK_DAKU.indexOf(next) !== -1 && compose.daku.has(base)) {
          rep = compose.daku.get(base);
          i += 1;
        } else if (next !== undefined && MARK_HANDAKU.indexOf(next) !== -1 && compose.handaku.has(base)) {
          rep = compose.handaku.get(base);
          i += 1;
        } else if (han2zen.kana.get(ch) !== undefined) {
          rep = base;
        }
      }
    } else if (dir.kana === 'han') {
      rep = zen2han.kana.get(ch);
    }

    if (rep === undefined && dir.alnum !== 'keep') {
      rep = dir.alnum === 'han' ? zen2han.alnum.get(ch) : han2zen.alnum.get(ch);
    }
    if (rep === undefined && dir.symbol !== 'keep') {
      rep = dir.symbol === 'han' ? zen2han.symbol.get(ch) : han2zen.symbol.get(ch);
    }
    if (rep === undefined && dir.space !== 'keep') {
      rep = dir.space === 'han' ? zen2han.space.get(ch) : han2zen.space.get(ch);
    }

    if (rep === undefined) {
      out.push(ch);
    } else {
      if (rep !== ch) converted += 1;
      out.push(rep);
    }
  }

  return { text: out.join(''), converted };
}

// 行と改行を組にして返す（改行コードを混ぜずに行だけを触れるようにする）
function splitLines(text) {
  const parts = text.split(/(\r\n|\n|\r)/);
  const lines = [];
  for (let i = 0; i < parts.length; i += 2) {
    lines.push({ text: parts[i], eol: parts[i + 1] === undefined ? '' : parts[i + 1] });
  }
  return lines;
}

/**
 * 空白・空行・見えない文字を掃除する。変換のあとに走らせる。
 *
 * @param {string} text
 * @param {object} opts collapseSpaces / trimLines / blankLines / removeInvisible / composeMarks
 */
export function cleanText(text, opts) {
  let t = text;
  let removed = 0;

  if (opts.removeInvisible) {
    const hits = t.match(INVISIBLE_RE);
    if (hits) removed += hits.length;
    t = t.replace(INVISIBLE_RE, '');
  }
  // NFCは濁点の結合文字（か＋U+3099）を1文字へ合成する。削除ではないので removed に数えない
  if (opts.composeMarks) t = t.normalize('NFC');

  const before = [...t].length;

  // 連続する空白は先頭の1文字だけ残す（全角スペースだけの並びは全角のまま残る）
  if (opts.collapseSpaces) t = t.replace(SPACE_RUN_RE, (run) => run[0]);

  if (opts.trimLines || opts.blankLines !== 'keep') {
    const lines = splitLines(t);
    const kept = [];
    let blankRun = 0;
    for (const line of lines) {
      const body = opts.trimLines ? line.text.replace(SPACE_EDGE_RE, '') : line.text;
      const blank = SPACE_ONLY_RE.test(body);
      if (blank && opts.blankLines !== 'keep') {
        blankRun += 1;
        if (opts.blankLines === 'remove' || blankRun > 1) continue;
      } else if (!blank) {
        blankRun = 0;
      }
      kept.push({ text: body, eol: line.eol });
    }
    // 末尾の行だけを削ったときに改行が浮かないよう、残った最後の行の改行はそのままにする
    t = kept.map((line) => line.text + line.eol).join('');
  }

  removed += before - [...t].length;
  return { text: t, removed: removed < 0 ? 0 : removed };
}

// 文字列の中の該当文字を数える（コードポイント単位）
function countMatches(text, re) {
  const hits = text.match(re);
  return hits ? hits.length : 0;
}

const HANKAKU_KANA_RE = /[｡-ﾟ]/g;
const ZEN_SPACE_RE = /\u3000/g;
const COMBINING_RE = /[\u3099\u309A]/g;
const ZEN_ALNUM_RE = /[０-９Ａ-Ｚａ-ｚ]/g;
const HAN_ALNUM_RE = /[0-9A-Za-z]/g;

/**
 * 全角⇄半角の変換とテキストの掃除をまとめて行う。
 *
 * @param {object} opts
 * @param {string} opts.text 変換するテキスト
 * @param {'keep'|'han'|'zen'} [opts.alnum='han'] 英数字の向き
 * @param {'keep'|'han'|'zen'} [opts.kana='zen'] カタカナ（と句読点・カギ括弧・中黒・長音）の向き
 * @param {'keep'|'han'|'zen'} [opts.symbol='han'] 記号の向き
 * @param {'keep'|'han'|'zen'} [opts.space='han'] スペースの向き
 * @param {boolean} [opts.collapseSpaces=false] 連続する空白を1つにまとめる
 * @param {boolean} [opts.trimLines=false] 行頭・行末の空白を削る
 * @param {'keep'|'collapse'|'remove'} [opts.blankLines='keep'] 空行の扱い
 * @param {boolean} [opts.removeInvisible=false] 見えない文字を削る
 * @param {boolean} [opts.composeMarks=false] 結合した濁点・半濁点を合成する（NFC）
 * @returns {{text,input,options,stats,notes}}
 */
export function zenkakuConvert(opts) {
  const o = opts || {};
  const input = typeof o.text === 'string' ? o.text : '';
  const options = {
    alnum: normalizeDir(o.alnum, 'han'),
    kana: normalizeDir(o.kana, 'zen'),
    symbol: normalizeDir(o.symbol, 'han'),
    space: normalizeDir(o.space, 'han'),
    collapseSpaces: Boolean(o.collapseSpaces),
    trimLines: Boolean(o.trimLines),
    blankLines: ZK_BLANK.indexOf(o.blankLines) !== -1 ? o.blankLines : 'keep',
    removeInvisible: Boolean(o.removeInvisible),
    composeMarks: Boolean(o.composeMarks),
  };

  const width = convertWidth(input, options);
  const cleaned = cleanText(width.text, options);
  const text = cleaned.text;

  const notes = [];
  if (!input) {
    notes.push({ code: 'NOTHING' });
  } else if (text === input) {
    notes.push({ code: 'UNCHANGED' });
  }

  // 出力に残っていて、後の工程で困りやすいものを指摘する
  const hankakuKana = countMatches(text, HANKAKU_KANA_RE);
  if (hankakuKana) notes.push({ code: 'HANKAKU_KANA', count: hankakuKana });

  const zenSpace = countMatches(text, ZEN_SPACE_RE);
  if (zenSpace) notes.push({ code: 'ZEN_SPACE', count: zenSpace });

  const invisible = countMatches(text, INVISIBLE_RE);
  if (invisible) notes.push({ code: 'INVISIBLE', count: invisible });

  const combining = countMatches(text, COMBINING_RE);
  if (combining) notes.push({ code: 'COMBINING', count: combining });

  // 波ダッシュ（U+301C）と全角チルダ（U+FF5E）は見た目が近く、環境によって化ける
  const wave = countMatches(text, /[〜～]/g);
  if (wave) notes.push({ code: 'WAVE', count: wave });

  const platform = countMatches(text, PLATFORM_RE);
  if (platform) notes.push({ code: 'PLATFORM', count: platform });

  // 変換しなかった文字種で全角と半角が混じっているなら、表記ゆれとして知らせる
  if (options.alnum === 'keep' && countMatches(text, ZEN_ALNUM_RE) && countMatches(text, HAN_ALNUM_RE)) {
    notes.push({ code: 'MIXED_ALNUM' });
  }

  const lines = splitLines(text);
  // 末尾が改行で終わるとき、最後の空要素は行として数えない
  const lineCount = lines.length && lines[lines.length - 1].text === '' && lines[lines.length - 1].eol === ''
    ? lines.length - 1
    : lines.length;

  return {
    text,
    input,
    options,
    stats: {
      converted: width.converted,
      removed: cleaned.removed,
      chars_in: [...input].length,
      chars_out: [...text].length,
      lines: lineCount,
      hankaku_kana: hankakuKana,
      zen_space: zenSpace,
    },
    notes,
  };
}

// プリセット（画面のボタンとMCPの preset で同じ指定になる）
export const ZK_PRESETS = {
  ja: { alnum: 'han', kana: 'zen', symbol: 'han', space: 'han' },
  han: { alnum: 'han', kana: 'han', symbol: 'han', space: 'han' },
  zen: { alnum: 'zen', kana: 'zen', symbol: 'zen', space: 'zen' },
  csv: {
    alnum: 'han',
    kana: 'zen',
    symbol: 'han',
    space: 'han',
    collapseSpaces: true,
    trimLines: true,
    removeInvisible: true,
    composeMarks: true,
  },
};

/* ==================== ここまで変換コア ==================== */

// 指摘事項のコード → 文。site側は同じコードを日英それぞれの文へ訳している
const NOTE_TEXT = {
  ja: {
    NOTHING: () => '変換する文字がありませんでした。',
    UNCHANGED: () => '変更はありません（指定した条件では直すところがありませんでした）。',
    HANKAKU_KANA: (n) => `半角カタカナが ${n} 文字残っています。印刷物や古いシステムでは化けることがあります（kana="zen" で全角へ寄せられます）。`,
    ZEN_SPACE: (n) => `全角スペース（U+3000）が ${n} 個残っています。表計算のセルでは見えず、検索や突合が空振りする原因になります。`,
    INVISIBLE: (n) => `見えない文字が ${n} 個あります（ゼロ幅スペース・BOM・制御文字）。removeInvisible=true で取り除けます。`,
    COMBINING: (n) => `濁点・半濁点が結合文字として ${n} 個入っています（「ガ」が「カ」＋濁点の2文字）。composeMarks=true で1文字にまとめられます。`,
    WAVE: (n) => `波ダッシュ・全角チルダ（〜 U+301C / ～ U+FF5E）が ${n} 文字あります。見た目はほぼ同じですが別の文字で、環境によっては一方が文字化けします（自動では変換しません）。`,
    PLATFORM: (n) => `環境依存文字が ${n} 文字あります（① ㈱ Ⅲ など）。Shift_JISや古いシステムでは化けることがあります（自動では変換しません）。`,
    MIXED_ALNUM: () => '結果に全角と半角の英数字が混在しています。alnum を han か zen に指定すると表記が揃います。',
    TRUNCATED: (n) => `本文が長いため、text には先頭 ${n} 文字だけを入れています（全文が必要なときは outputPath を指定してください）。`,
  },
  en: {
    NOTHING: () => 'There was nothing to convert.',
    UNCHANGED: () => 'Nothing changed: the text already matches every setting given.',
    HANKAKU_KANA: (n) => `${n} half-width katakana character(s) remain. They break in many systems and in printed output (kana="zen" folds them to full-width).`,
    ZEN_SPACE: (n) => `${n} ideographic space(s) (U+3000) remain. They are invisible in a spreadsheet cell and a common cause of failed lookups.`,
    INVISIBLE: (n) => `${n} invisible character(s) found (zero-width, BOM or control codes). Pass removeInvisible=true to strip them.`,
    COMBINING: (n) => `${n} combining voiced mark(s) found: the dakuten is a separate character, so "ガ" is really "カ" plus a mark. Pass composeMarks=true to join them.`,
    WAVE: (n) => `${n} wave dash / fullwidth tilde character(s) (〜 U+301C, ～ U+FF5E) found. The two look almost identical but are different characters, and one of them garbles on some systems (never rewritten automatically).`,
    PLATFORM: (n) => `${n} platform-dependent character(s) found (① ㈱ Ⅲ and the like). They may not survive Shift_JIS or an older system (never rewritten automatically).`,
    MIXED_ALNUM: () => 'Both full-width and half-width letters or digits appear in the result. Set alnum to han or zen to make it consistent.',
    TRUNCATED: (n) => `Only the first ${n} characters are returned in text (pass outputPath when you need the whole thing).`,
  },
};

// 返す本文の上限。これを超えたら切り詰めて TRUNCATED を足す（outputPath 指定時は全文をファイルへ書く）
const MAX_TEXT = 200000;

export class ZenkakuError extends Error {}

function pickDirection(value, name) {
  if (value === undefined) return undefined;
  if (ZK_DIRECTIONS.indexOf(value) === -1) {
    throw new ZenkakuError(`${name} は ${ZK_DIRECTIONS.join(' / ')} のいずれか: ${value}`);
  }
  return value;
}

/**
 * テキスト（または UTF-8 のテキストファイル）の全角⇄半角を揃え、空白まわりを掃除する。
 *
 * @param {object} opts
 * @param {string} [opts.text]        変換するテキスト（path と排他）
 * @param {string} [opts.path]        変換するファイルの絶対パス（UTF-8として読む）
 * @param {string} [opts.outputPath]  結果を書き出す絶対パス（指定すると本文は返さない）
 * @param {'ja'|'csv'|'han'|'zen'} [opts.preset] よく使う組み合わせ（個別指定で上書きできる）
 * @param {'keep'|'han'|'zen'} [opts.alnum]  英数字の向き（既定 'han'）
 * @param {'keep'|'han'|'zen'} [opts.kana]   カタカナと句読点・カギ括弧・中黒・長音の向き（既定 'zen'）
 * @param {'keep'|'han'|'zen'} [opts.symbol] 記号の向き（既定 'han'）
 * @param {'keep'|'han'|'zen'} [opts.space]  スペースの向き（既定 'han'）
 * @param {boolean} [opts.collapseSpaces=false] 連続する空白を1つにまとめる
 * @param {boolean} [opts.trimLines=false]      行頭・行末の空白を削る
 * @param {'keep'|'collapse'|'remove'} [opts.blankLines='keep'] 空行の扱い
 * @param {boolean} [opts.removeInvisible=false] 見えない文字を削る
 * @param {boolean} [opts.composeMarks=false]    結合した濁点・半濁点を合成する（NFC）
 * @param {boolean} [opts.inspect=false] 変換せず、何が入っているかの指摘だけを返す
 * @param {'ja'|'en'} [opts.lang='ja'] 指摘事項の言語
 */
export async function zenkakuConvertTool(opts = {}) {
  const lang = opts.lang || 'ja';
  if (lang !== 'ja' && lang !== 'en') throw new ZenkakuError(`lang は ja か en: ${opts.lang}`);

  if (opts.preset !== undefined && !Object.prototype.hasOwnProperty.call(ZK_PRESETS, opts.preset)) {
    throw new ZenkakuError(`preset は ${Object.keys(ZK_PRESETS).join(' / ')} のいずれか: ${opts.preset}`);
  }
  const preset = opts.preset ? ZK_PRESETS[opts.preset] : {};

  const blankLines = opts.blankLines === undefined ? (preset.blankLines || 'keep') : opts.blankLines;
  if (ZK_BLANK.indexOf(blankLines) === -1) {
    throw new ZenkakuError(`blankLines は ${ZK_BLANK.join(' / ')} のいずれか: ${opts.blankLines}`);
  }

  const hasText = typeof opts.text === 'string';
  if (hasText === Boolean(opts.path)) throw new ZenkakuError('text か path のどちらか一方を渡してください');

  const flag = (name) => (opts[name] === undefined ? Boolean(preset[name]) : Boolean(opts[name]));
  const dir = (name, fallback) => {
    const given = pickDirection(opts[name], name);
    if (given !== undefined) return given;
    return preset[name] !== undefined ? preset[name] : fallback;
  };

  // inspect は「何も変えずに中身を見る」モード。指摘だけが欲しいときに使う
  const request = opts.inspect
    ? { alnum: 'keep', kana: 'keep', symbol: 'keep', space: 'keep', blankLines: 'keep' }
    : {
      alnum: dir('alnum', 'han'),
      kana: dir('kana', 'zen'),
      symbol: dir('symbol', 'han'),
      space: dir('space', 'han'),
      collapseSpaces: flag('collapseSpaces'),
      trimLines: flag('trimLines'),
      blankLines,
      removeInvisible: flag('removeInvisible'),
      composeMarks: flag('composeMarks'),
    };

  const input = hasText ? opts.text : await readFile(opts.path, 'utf8');
  const r = zenkakuConvert({ ...request, text: input });

  const notes = r.notes.slice();
  const result = {
    source: hasText ? { type: 'text' } : { path: opts.path, name: basename(opts.path) },
    options: r.options,
    stats: r.stats,
  };
  if (opts.preset) result.preset = opts.preset;

  if (opts.inspect) {
    result.inspect = true;
    // 何も変えない指定なので「変更はありません」は情報にならない
    const i = notes.findIndex((n) => n.code === 'UNCHANGED');
    if (i !== -1) notes.splice(i, 1);
  } else if (opts.outputPath) {
    await writeFile(opts.outputPath, r.text, 'utf8');
    result.output = opts.outputPath;
  } else if ([...r.text].length > MAX_TEXT) {
    result.text = [...r.text].slice(0, MAX_TEXT).join('');
    notes.push({ code: 'TRUNCATED', count: MAX_TEXT });
  } else {
    result.text = r.text;
  }

  result.notes = notes.map((n) => ({
    code: n.code,
    message: NOTE_TEXT[lang][n.code] ? NOTE_TEXT[lang][n.code](n.count) : n.code,
  }));
  return result;
}
