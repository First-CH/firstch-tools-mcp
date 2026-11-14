/* メールアドレス候補の読み上げの長さ比べ（email_read_aloud）
 * 読み・拍数・事実のコアは FirstCHTools の site/mail-yomiage/lib.mjs と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルの「ここからコア」〜「ここまでコア」はバイト一致する（どちらも ES module）:
 *   diff <(sed -n '/^\/\/ ===== ここから/,/^\/\/ ===== ここまで/p' site/mail-yomiage/lib.mjs) <(sed -n '/^\/\/ ===== ここから/,/^\/\/ ===== ここまで/p' email-read-aloud.mjs)
 *
 * メールアドレスかドメインの候補（最大5件）ごとに、電話で言うときの読み上げ文と長さ（ja＝カタカナの拍・en＝音節）、
 * 数えられる事実（文字数・記号の種類・同じ文字の連続・数字の桁数・英字と数字の切り替わり）と1文字ずつの表を返す。
 * 言い換えは無線局運用規則 別表第五号の欧文通話表（ITU 無線通信規則 付録14 と同じ語）。
 * 伝わりやすさの順位・おすすめ・見た目の似た文字の判定・実在確認はしない。完全ローカル処理・ネットワーク送信なし。 */

// ===== ここからコア =====
export const MAX_CANDIDATES = 5;
export const MAX_LENGTH = 254;

// 無線局運用規則 別表第五号「通話表」2 欧文通話表（ITU 無線通信規則 付録14 と同じ語）。
// word＝使用する語、pron＝同表の英語式の発音の表示、kana＝画面に添えるカタカナ（表には無い・このページの表記）
export const PHONETIC = {
  a: ['Alfa', 'ALFAH', 'アルファ'], b: ['Bravo', 'BRAHVOH', 'ブラボー'], c: ['Charlie', 'CHARLEE', 'チャーリー'],
  d: ['Delta', 'DELLTAH', 'デルタ'], e: ['Echo', 'ECKOH', 'エコー'], f: ['Foxtrot', 'FOKSTROT', 'フォックストロット'],
  g: ['Golf', 'GOLF', 'ゴルフ'], h: ['Hotel', 'HOHTELL', 'ホテル'], i: ['India', 'INDEEAH', 'インディア'],
  j: ['Juliett', 'JEWLEEETT', 'ジュリエット'], k: ['Kilo', 'KEYLOH', 'キロ'], l: ['Lima', 'LEEMAH', 'リマ'],
  m: ['Mike', 'MIKE', 'マイク'], n: ['November', 'NOVEMBER', 'ノベンバー'], o: ['Oscar', 'OSSCAH', 'オスカー'],
  p: ['Papa', 'PAHPAH', 'パパ'], q: ['Quebec', 'KEHBECK', 'ケベック'], r: ['Romeo', 'ROWMEOH', 'ロメオ'],
  s: ['Sierra', 'SEEAIRRAH', 'シエラ'], t: ['Tango', 'TANGGO', 'タンゴ'], u: ['Uniform', 'YOUNEEFORM', 'ユニフォーム'],
  v: ['Victor', 'VIKTAH', 'ビクター'], w: ['Whiskey', 'WISSKEY', 'ウィスキー'], x: ['X-ray', 'ECKSRAY', 'エックスレイ'],
  y: ['Yankee', 'YANGKEY', 'ヤンキー'], z: ['Zulu', 'ZOOLOO', 'ズールー'],
};
// 同表（2）数字。ja は国内通信の語、en は航空移動業務の語と発音
export const PHONETIC_DIGIT = {
  ja: ['数字のまる', '数字のひと', '数字のに', '数字のさん', '数字のよん', '数字のご', '数字のろく', '数字のなな', '数字のはち', '数字のきゅう'],
  en: [['ZERO', 'ZE-RO'], ['ONE', 'WUN'], ['TWO', 'TOO'], ['THREE', 'TREE'], ['FOUR', 'FOW-er'],
    ['FIVE', 'FIFE'], ['SIX', 'SIX'], ['SEVEN', 'SEV-en'], ['EIGHT', 'AIT'], ['NINE', 'NIN-er']],
};
// 日本語の言い換え例（通話表ではない。利用者が選んだときだけ出す）
export const ALT_JA = {
  a: 'アップル', b: 'ブック', c: 'キャット', d: 'ドッグ', e: 'エッグ', f: 'フラワー', g: 'ゴルフ', h: 'ホテル', i: 'インク',
  j: 'ジャパン', k: 'キング', l: 'レモン', m: 'マウス', n: 'ノート', o: 'オレンジ', p: 'ペン', q: 'クイーン', r: 'ラジオ',
  s: 'スター', t: 'トマト', u: 'ユニフォーム', v: 'ビクトリー', w: 'ワイン', x: 'エックスレイ', y: 'イエロー', z: 'ゼブラ',
};

// 1文字の読み。ja は拍（カタカナの数から小書きのャュョァィゥェォを除く）、en は音節を数える
const LETTER_JA = {
  a: 'エー', b: 'ビー', c: 'シー', d: 'ディー', e: 'イー', f: 'エフ', g: 'ジー', h: 'エイチ', i: 'アイ', j: 'ジェー',
  k: 'ケー', l: 'エル', m: 'エム', n: 'エヌ', o: 'オー', p: 'ピー', q: 'キュー', r: 'アール', s: 'エス', t: 'ティー',
  u: 'ユー', v: 'ブイ', w: 'ダブリュー', x: 'エックス', y: 'ワイ', z: 'ゼット',
};
const DIGIT_JA = ['ゼロ', 'イチ', 'ニー', 'サン', 'ヨン', 'ゴー', 'ロク', 'ナナ', 'ハチ', 'キュー'];
const DIGIT_EN = [['zero', 2], ['one', 1], ['two', 1], ['three', 1], ['four', 1], ['five', 1], ['six', 1], ['seven', 2], ['eight', 1], ['nine', 1]];
export const SYMBOLS = {
  '@': { key: 'at', ja: 'アットマーク', en: ['at', 1] },
  '.': { key: 'dot', ja: 'ドット', en: ['dot', 1] },
  '-': { key: 'hyphen', ja: 'ハイフン', en: ['hyphen', 2] },
  '_': { key: 'underscore', ja: 'アンダーバー', en: ['underscore', 3] },
  '+': { key: 'plus', ja: 'プラス', en: ['plus', 1] },
};
// 末尾（最後のドットの後ろ）がこの綴りのときだけ、1字ずつではなく語として読む
const WORDS = { com: { ja: 'コム', en: ['com', 1] }, net: { ja: 'ネット', en: ['net', 1] } };
const SYMBOL_ALT_JA = { '@': 'アットマーク（＠）', '.': 'ドット（点）', '-': 'ハイフン（横棒）', '_': 'アンダーバー（下線）', '+': 'プラス（足す）' };

export class EmailReadAloudError extends Error {
  constructor(code, message) { super(message); this.name = 'EmailReadAloudError'; this.code = code; }
}

/** カタカナの拍の数（小書きのャュョァィゥェォヮは前の字と1拍。ッ・ン・ーは1拍） */
export function countMora(kana) {
  let n = 0;
  for (const ch of String(kana)) {
    if (/[ァ-ヶー]/.test(ch) && !/[ャュョァィゥェォヮ]/.test(ch)) n++;
  }
  return n;
}

function readChar(ch, lang) {
  if (/[a-z]/.test(ch)) {
    return lang === 'en' ? { reading: ch.toUpperCase(), units: ch === 'w' ? 3 : 1 } : { reading: LETTER_JA[ch], units: countMora(LETTER_JA[ch]) };
  }
  if (/[0-9]/.test(ch)) {
    const d = Number(ch);
    return lang === 'en' ? { reading: DIGIT_EN[d][0], units: DIGIT_EN[d][1] } : { reading: DIGIT_JA[d], units: countMora(DIGIT_JA[d]) };
  }
  const s = SYMBOLS[ch];
  return lang === 'en' ? { reading: s.en[0], units: s.en[1] } : { reading: s.ja, units: countMora(s.ja) };
}

/** 1文字ずつの表の1行（文字・読み・通話表の語・日本語の言い換え例） */
function charRow(ch, lang) {
  const r = readChar(ch, lang);
  const row = { ch, reading: r.reading, units: r.units, phonetic: null, alt: null };
  if (/[a-z]/.test(ch)) {
    const p = PHONETIC[ch];
    row.phonetic = { word: p[0], pron: p[1], kana: p[2] };
    row.alt = ALT_JA[ch] + 'の' + ch.toUpperCase();
  } else if (/[0-9]/.test(ch)) {
    const d = Number(ch);
    row.phonetic = lang === 'en' ? { word: PHONETIC_DIGIT.en[d][0], pron: PHONETIC_DIGIT.en[d][1] } : { word: PHONETIC_DIGIT.ja[d] };
  } else {
    row.alt = SYMBOL_ALT_JA[ch];
  }
  return row;
}

/** 入力の1行をそろえる（全角→半角の NFKC・小文字・前後の空白と mailto: を外す） */
export function normalize(line) {
  return String(line == null ? '' : line).normalize('NFKC').trim().replace(/^mailto:/i, '').toLowerCase();
}

/** 複数行の文字列か配列から候補を取り出す（空行は飛ばす・最大5件） */
export function splitCandidates(input) {
  const lines = Array.isArray(input) ? input.map(String) : String(input == null ? '' : input).split(/\r\n|\r|\n/);
  const all = lines.map((s) => s.trim()).filter((s) => s !== '');
  return { list: all.slice(0, MAX_CANDIDATES), dropped: Math.max(0, all.length - MAX_CANDIDATES) };
}

/** 1件を読む。ok=false のときは error（code と chars）だけを返す */
export function analyzeOne(raw, lang = 'ja') {
  const text = normalize(raw);
  const out = { input: String(raw).trim(), text, ok: false };
  if ([...text].length > MAX_LENGTH) { out.error = { code: 'TOO_LONG' }; return out; }
  const bad = [...new Set([...text].filter((ch) => !/[a-z0-9]/.test(ch) && !SYMBOLS[ch]))];
  if (bad.length) { out.error = { code: 'BAD_CHAR', chars: bad }; return out; }
  const ats = (text.match(/@/g) || []).length;
  if (ats > 1) { out.error = { code: 'MULTI_AT' }; return out; }
  const [local, domain] = ats ? text.split('@') : ['', text];
  if ((ats && !local) || !domain) { out.error = { code: 'EMPTY_PART' }; return out; }
  out.ok = true;
  out.kind = ats ? 'email' : 'domain';

  // 語として読む末尾（.com・.net）の位置
  const lastDot = text.lastIndexOf('.');
  const tail = lastDot >= 0 ? text.slice(lastDot + 1) : '';
  const wordAt = lastDot >= 0 && lastDot > text.indexOf('@') && WORDS[tail] ? lastDot + 1 : -1;

  const arr = [...text];
  const chars = arr.map((ch) => charRow(ch, lang));
  const parts = [];       // 読み上げ文の部品（run＝英数字の並び・sym＝記号・word＝語として読む末尾）
  let run = [];
  let units = 0;
  const flush = () => { if (run.length) { parts.push({ type: 'run', items: run }); run = []; } };
  for (let i = 0; i < arr.length; i++) {
    if (i === wordAt) {
      flush();
      const w = WORDS[tail];
      const reading = lang === 'en' ? w.en[0] : w.ja;
      parts.push({ type: 'word', text: reading });
      units += lang === 'en' ? w.en[1] : countMora(w.ja);
      for (const row of chars.slice(i)) row.inWord = reading;
      break;
    }
    const row = chars[i];
    if (SYMBOLS[arr[i]]) { flush(); parts.push({ type: 'sym', text: row.reading }); } else run.push(row.reading);
    units += row.units;
  }
  flush();
  const sepRun = lang === 'en' ? ' ' : '・';
  const sepPart = lang === 'en' ? ', ' : '　';
  out.reading = parts.map((p) => (p.type === 'run' ? p.items.join(sepRun) : p.text)).join(sepPart);
  out.units = units;
  out.chars = chars;
  out.facts = facts(text);
  return out;
}

/** 数えられる事実（読み方に依らない）。文字数・記号の種類・同じ文字の連続・数字の桁数・英字と数字の切り替わり */
export function facts(text) {
  const arr = [...text];
  const symbols = { hyphen: 0, underscore: 0, dot: 0, plus: 0 };
  for (const ch of arr) {
    if (ch === '-') symbols.hyphen++;
    else if (ch === '_') symbols.underscore++;
    else if (ch === '.') symbols.dot++;
    else if (ch === '+') symbols.plus++;
  }
  const repeats = [];
  for (let i = 0; i < arr.length;) {
    let j = i + 1;
    while (j < arr.length && arr[j] === arr[i]) j++;
    if (j - i >= 2) repeats.push({ ch: arr[i], length: j - i, at: i });
    i = j;
  }
  // 英字と数字の切り替わり: 記号を飛ばして、隣り合う英数字の種類が変わった回数
  let switches = 0;
  let prev = '';
  for (const ch of arr) {
    const k = /[a-z]/.test(ch) ? 'a' : /[0-9]/.test(ch) ? 'd' : '';
    if (!k) continue;
    if (prev && k !== prev) switches++;
    prev = k;
  }
  return {
    length: arr.length,
    symbols,
    symbolCount: symbols.hyphen + symbols.underscore + symbols.dot + symbols.plus,
    repeats,
    digits: arr.filter((ch) => /[0-9]/.test(ch)).length,
    switches,
  };
}

/** 伏せ字: 区切り（@ . - _ +）で分けた各まとまりの先頭1字だけ残し、残りを • にする */
export function mask(text) {
  return String(text).replace(/[a-z0-9]+/g, (m) => m[0] + '•'.repeat(m.length - 1));
}

/** 候補の一覧を読む。並びは拍（en は音節）の短い順・同じなら入力順。読めない候補は後ろ */
export function analyze(input, opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'ja';
  const { list, dropped } = splitCandidates(input);
  const items = list.map((raw, i) => Object.assign({ label: String.fromCharCode(65 + i), index: i }, analyzeOne(raw, lang)));
  const sorted = items.slice().sort((a, b) => (a.ok === b.ok ? (a.ok ? a.units - b.units : 0) || a.index - b.index : a.ok ? -1 : 1));
  return { lang, unit: lang === 'en' ? 'syllables' : 'mora', items: sorted, dropped };
}

/** 比べカードの1行の文（例「候補A 18拍・記号0」） */
export function cardLine(item, lang = 'ja', opts = {}) {
  const name = opts.show ? item.text : opts.masked ? mask(item.text) : '';
  if (lang === 'en') return 'Option ' + item.label + (name ? ' (' + name + ')' : '') + ': ' + item.units + ' syllable' + (item.units === 1 ? '' : 's') + ', ' + item.facts.symbolCount + ' symbol' + (item.facts.symbolCount === 1 ? '' : 's');
  return '候補' + item.label + (name ? '（' + name + '）' : ' ') + item.units + '拍・記号' + item.facts.symbolCount;
}

/** 比べカードの文（読めた候補を拍の短い順に「／」でつなぐ） */
export function cardText(result, opts = {}) {
  const lang = result.lang;
  return result.items.filter((x) => x.ok).map((x) => cardLine(x, lang, opts)).join(lang === 'en' ? ' / ' : '／');
}
// ===== ここまでコア =====

// ---- MCP の入口 ----
export function emailReadAloudTool(opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'ja';
  const input = opts.candidates;
  if (!Array.isArray(input) && typeof input !== 'string') throw new EmailReadAloudError('NO_INPUT', 'candidates must be an array of strings (or a newline-separated string)');
  const r = analyze(input, { lang });
  if (!r.items.length) throw new EmailReadAloudError('NO_INPUT', 'no candidates (empty lines are skipped)');
  const includeChars = opts.includeChars !== false;
  const items = r.items.map((x) => {
    const base = { label: x.label, index: x.index, input: x.input, ok: x.ok };
    if (!x.ok) return { ...base, error: x.error };
    const o = { ...base, text: x.text, kind: x.kind, reading: x.reading, units: x.units, unit: r.unit, facts: x.facts };
    if (includeChars) o.chars = x.chars;
    return o;
  });
  return {
    lang,
    unit: r.unit,
    order: 'units ascending, then input order (not a ranking)',
    items,
    dropped: r.dropped,
    card: cardText(r, { masked: true }),
    phoneticSource: lang === 'en'
      ? "Japan's Radio Station Operation Rules, Appended Table 5 (same words as the international phonetic alphabet). https://laws.e-gov.go.jp/law/325M50080000017"
      : '無線局運用規則 別表第五号「通話表」2 欧文通話表（数字は同表の国内通信の語）。https://laws.e-gov.go.jp/law/325M50080000017',
  };
}
