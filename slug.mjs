/* URLスラッグ生成（slug_generate）
 * 生成コア（kanaToRomaji / slugTokens / slugGenerate）は
 * FirstCHTools の site/slug/app.js と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルからコアの開始/終了コメントに挟まれた範囲を sed で切り出し
 * （site側は字下げ2文字を落とす・こちらは行頭の export を落とす）、
 * diff が空になることで同期を機械的に確認できる。
 *
 * 漢字の読みは推定しない（形態素解析の辞書を積まない）。読みは呼び出し側が reading で渡す。
 * 完全ローカル処理・ネットワーク送信なし。 */

/* ==================== ここからスラッグ生成コア（site / MCP で同一） ==================== */

// 区切り文字。kebab が WordPress の既定（sanitize_title もハイフンでつなぐ）
export const SLUG_SEPARATORS = { kebab: '-', snake: '_' };

// 長音の書き方。omit＝とうきょう→tokyo（パスポート・駅名標の書き方）、keep＝toukyou
export const SLUG_LONG_VOWELS = ['omit', 'keep'];

// かな1文字 → ヘボン式。カタカナはひらがなへ寄せてから引く
export const KANA_SINGLE = {
  'あ': 'a', 'い': 'i', 'う': 'u', 'え': 'e', 'お': 'o',
  'か': 'ka', 'き': 'ki', 'く': 'ku', 'け': 'ke', 'こ': 'ko',
  'が': 'ga', 'ぎ': 'gi', 'ぐ': 'gu', 'げ': 'ge', 'ご': 'go',
  'さ': 'sa', 'し': 'shi', 'す': 'su', 'せ': 'se', 'そ': 'so',
  'ざ': 'za', 'じ': 'ji', 'ず': 'zu', 'ぜ': 'ze', 'ぞ': 'zo',
  'た': 'ta', 'ち': 'chi', 'つ': 'tsu', 'て': 'te', 'と': 'to',
  'だ': 'da', 'ぢ': 'ji', 'づ': 'zu', 'で': 'de', 'ど': 'do',
  'な': 'na', 'に': 'ni', 'ぬ': 'nu', 'ね': 'ne', 'の': 'no',
  'は': 'ha', 'ひ': 'hi', 'ふ': 'fu', 'へ': 'he', 'ほ': 'ho',
  'ば': 'ba', 'び': 'bi', 'ぶ': 'bu', 'べ': 'be', 'ぼ': 'bo',
  'ぱ': 'pa', 'ぴ': 'pi', 'ぷ': 'pu', 'ぺ': 'pe', 'ぽ': 'po',
  'ま': 'ma', 'み': 'mi', 'む': 'mu', 'め': 'me', 'も': 'mo',
  'や': 'ya', 'ゆ': 'yu', 'よ': 'yo',
  'ら': 'ra', 'り': 'ri', 'る': 'ru', 'れ': 're', 'ろ': 'ro',
  'わ': 'wa', 'ゐ': 'i', 'ゑ': 'e', 'を': 'o', 'ん': 'n',
  'ぁ': 'a', 'ぃ': 'i', 'ぅ': 'u', 'ぇ': 'e', 'ぉ': 'o',
  'ゃ': 'ya', 'ゅ': 'yu', 'ょ': 'yo', 'ゎ': 'wa',
  'ゔ': 'vu', 'ゕ': 'ka', 'ゖ': 'ke',
};

// 2文字で1音になる組（拗音と外来音）
export const KANA_PAIRS = (() => {
  const pairs = {};
  // イ段＋ゃゅょ: きゃ kya / しゃ sha / ちゃ cha / じゃ ja
  const yoon = {
    'き': 'ky', 'ぎ': 'gy', 'し': 'sh', 'じ': 'j', 'ち': 'ch', 'ぢ': 'j', 'に': 'ny',
    'ひ': 'hy', 'び': 'by', 'ぴ': 'py', 'み': 'my', 'り': 'ry',
  };
  for (const k of Object.keys(yoon)) {
    pairs[k + 'ゃ'] = yoon[k] + 'a';
    pairs[k + 'ゅ'] = yoon[k] + 'u';
    pairs[k + 'ょ'] = yoon[k] + 'o';
  }
  const extra = {
    'しぇ': 'she', 'じぇ': 'je', 'ちぇ': 'che', 'いぇ': 'ye',
    'ふぁ': 'fa', 'ふぃ': 'fi', 'ふぇ': 'fe', 'ふぉ': 'fo', 'ふゅ': 'fyu',
    'てぃ': 'ti', 'でぃ': 'di', 'てゅ': 'tyu', 'でゅ': 'dyu', 'とぅ': 'tu', 'どぅ': 'du',
    'うぃ': 'wi', 'うぇ': 'we', 'うぉ': 'wo',
    'ゔぁ': 'va', 'ゔぃ': 'vi', 'ゔぇ': 've', 'ゔぉ': 'vo', 'ゔゅ': 'vyu',
    'つぁ': 'tsa', 'つぃ': 'tsi', 'つぇ': 'tse', 'つぉ': 'tso',
    'くぁ': 'kwa', 'くぃ': 'kwi', 'くぇ': 'kwe', 'くぉ': 'kwo', 'ぐぁ': 'gwa',
    'すぃ': 'si', 'ずぃ': 'zi',
  };
  for (const k of Object.keys(extra)) pairs[k] = extra[k];
  return pairs;
})();

// ヷヸヹヺ はひらがなに対応する字が無いので、先に ゔ＋小書きへ開く
const KATA_WIDE_V = { 'ヷ': 'ゔぁ', 'ヸ': 'ゔぃ', 'ヹ': 'ゔぇ', 'ヺ': 'ゔぉ' };

// ラテン文字のうち、NFD で分解しても ASCII にならないもの
const LATIN_FOLD = { 'ß': 'ss', 'æ': 'ae', 'Æ': 'AE', 'ø': 'o', 'Ø': 'O', 'œ': 'oe', 'Œ': 'OE', 'đ': 'd', 'Đ': 'D', 'ł': 'l', 'Ł': 'L', 'ı': 'i', 'þ': 'th', 'Þ': 'TH', 'ð': 'd', 'Ð': 'D' };

const isHira = (c) => (c >= 'ぁ' && c <= 'ゖ') || c === 'ゝ' || c === 'ゞ';
const isKata = (c) => (c >= 'ァ' && c <= 'ヺ') || c === 'ヽ' || c === 'ヾ';

/**
 * かなの並びをヘボン式ローマ字にする（小文字・区切りなし）。
 * っ は次の子音を重ね（ch の前は t）、ー と長音は longVowel に従う。
 * @param {string} kana ひらがな・カタカナ（ー を含んでよい）
 * @param {'omit'|'keep'} [longVowel='omit']
 */
export function kanaToRomaji(kana, longVowel) {
  const keep = longVowel === 'keep';
  let hira = '';
  for (const ch of String(kana)) {
    if (KATA_WIDE_V[ch]) hira += KATA_WIDE_V[ch];
    else if (ch >= 'ァ' && ch <= 'ヶ') hira += String.fromCharCode(ch.charCodeAt(0) - 0x60);
    else hira += ch;
  }
  const chars = [...hira];
  const units = [];
  for (let i = 0; i < chars.length; i += 1) {
    const pair = chars[i] + (chars[i + 1] || '');
    if (KANA_PAIRS[pair]) {
      units.push({ k: pair, r: KANA_PAIRS[pair] });
      i += 1;
    } else if (chars[i] === 'っ' || chars[i] === 'ー') {
      units.push({ k: chars[i], r: '' });
    } else if (KANA_SINGLE[chars[i]] !== undefined) {
      units.push({ k: chars[i], r: KANA_SINGLE[chars[i]] });
    }
  }
  let out = '';
  let geminate = false;
  let lastVowel = '';
  for (const u of units) {
    if (u.k === 'っ') {
      geminate = true;
      continue;
    }
    if (u.k === 'ー') {
      // 長音記号: 書くなら直前の母音を重ねる（らーめん → raamen）。省くなら何も足さない
      if (keep && lastVowel) out += lastVowel;
      geminate = false;
      continue;
    }
    // 省く書き方では「おう・おお・うう」を1字にする（とうきょう → tokyo、おおさか → osaka）。
    // え段＋い（えい）とあ段・い段の重なりは残す（パスポートのヘボン式と同じ扱い）
    if (!keep && !geminate && ((u.k === 'う' && (lastVowel === 'o' || lastVowel === 'u')) || (u.k === 'お' && lastVowel === 'o'))) {
      continue;
    }
    let r = u.r;
    if (geminate) {
      // 促音: 次の子音を重ねる。ch の前だけは t（まっちゃ → matcha）。母音の前や末尾では消える
      if (/^[bcdfghjkmpqrstvwyz]/.test(r)) r = (r.startsWith('ch') ? 't' : r[0]) + r;
      geminate = false;
    }
    out += r;
    lastVowel = /[aiueo]$/.test(r) ? r.slice(-1) : '';
  }
  return out;
}

/**
 * 文字列を語に割る。区切りになるのは空白・記号・漢字・その他の文字と、
 * かな ⇄ 英数字の切り替わり（splitKatakana なら ひらがな ⇄ カタカナ の切り替わりも）。
 * @returns {{words: {type:'kana'|'alnum', text:string}[], kanji: string[], other: string[]}}
 */
export function slugTokens(src, splitKatakana) {
  const s = String(src).normalize('NFKC');
  const words = [];
  const kanji = [];
  const other = [];
  let cur = null;
  const flush = () => {
    if (cur && cur.text) words.push({ type: cur.type, text: cur.text });
    cur = null;
  };
  const addKana = (ch, script) => {
    if (!cur || cur.type !== 'kana' || (splitKatakana && cur.script !== script)) {
      flush();
      cur = { type: 'kana', script, text: '' };
    }
    cur.text += ch;
    cur.last = ch;
  };
  for (let ch of s) {
    // 踊り字（ゝゞヽヾ）は直前のかなに開く。ゞ・ヾ は濁らせる
    if (ch === 'ゝ' || ch === 'ゞ' || ch === 'ヽ' || ch === 'ヾ') {
      if (!cur || cur.type !== 'kana' || !cur.last || cur.last === 'ー') {
        flush();
        continue;
      }
      const base = cur.last.normalize('NFD')[0];
      const voiced = (base + '゙').normalize('NFC');
      ch = ch === 'ゞ' || ch === 'ヾ' ? (voiced.length === 1 ? voiced : base) : base;
      addKana(ch, cur.script);
      continue;
    }
    if (ch === 'ー') {
      // 長音記号は直前がかなのときだけ語の一部（単独の「ーー」は飾りの線とみなす）
      if (cur && cur.type === 'kana') addKana(ch, cur.script);
      else flush();
      continue;
    }
    if (isHira(ch)) {
      addKana(ch, 'hira');
      continue;
    }
    if (isKata(ch) && ch !== '・') {
      addKana(ch, 'kata');
      continue;
    }
    // ラテン文字は ASCII へ畳む（é → e、ß → ss）
    if (/\p{Script=Latin}/u.test(ch) && !/[A-Za-z]/.test(ch)) {
      ch = LATIN_FOLD[ch] || ch.normalize('NFD').replace(/\p{M}/gu, '');
    }
    if (/^[A-Za-z0-9]+$/.test(ch)) {
      if (!cur || cur.type !== 'alnum') {
        flush();
        cur = { type: 'alnum', text: '' };
      }
      cur.text += ch;
      continue;
    }
    // 英単語の中のアポストロフィは区切らずに落とす（Don't → dont）
    if (/^['’‘ʼ]$/.test(ch) && cur && cur.type === 'alnum') continue;
    flush();
    if (/[\p{Script=Han}々〆〇]/u.test(ch)) {
      if (kanji.indexOf(ch) === -1) kanji.push(ch);
    } else if (/\p{L}/u.test(ch)) {
      if (other.indexOf(ch) === -1) other.push(ch);
    }
  }
  flush();
  return { words, kanji, other };
}

/**
 * タイトル（または読み）からURLスラッグを作る。
 *
 * @param {object} opts
 * @param {string} opts.title タイトル
 * @param {string} [opts.reading] 読み。空でなければタイトルの代わりにこちらから作る（漢字をかなに直したもの）
 * @param {'kebab'|'snake'} [opts.separator='kebab']
 * @param {'omit'|'keep'} [opts.longVowel='omit']
 * @param {boolean} [opts.splitKatakana=true] ひらがなとカタカナの境目でも区切る
 * @param {number} [opts.maxLength=0] 上限の文字数（0＝無制限）。語の切れ目で切る
 * @returns {{slug,source,separator,longVowel,romaji,words,length,kanji,other,notes}}
 */
export function slugGenerate(opts) {
  const o = opts || {};
  const separator = o.separator === 'snake' ? 'snake' : 'kebab';
  const longVowel = o.longVowel === 'keep' ? 'keep' : 'omit';
  const splitKatakana = o.splitKatakana !== false;
  const maxLength = Number.isInteger(o.maxLength) && o.maxLength > 0 ? o.maxLength : 0;
  const title = typeof o.title === 'string' ? o.title : '';
  const reading = typeof o.reading === 'string' ? o.reading : '';
  const useReading = reading.trim() !== '';
  const src = useReading ? reading : title;
  const sep = SLUG_SEPARATORS[separator];

  const t = slugTokens(src, splitKatakana);
  const words = t.words
    .map((w) => ({ input: w.text, type: w.type, output: w.type === 'kana' ? kanaToRomaji(w.text, longVowel) : w.text.toLowerCase() }))
    .filter((w) => w.output);
  const parts = words.map((w) => w.output);
  const full = parts.join(sep);

  let slug = full;
  if (maxLength && full.length > maxLength) {
    // 語の途中では切らない。1語目だけで上限を超えるときに限り、語の中で切る
    slug = '';
    for (const p of parts) {
      const next = slug ? slug + sep + p : p;
      if (next.length > maxLength) break;
      slug = next;
    }
    if (!slug) slug = parts[0].slice(0, maxLength);
  }

  const notes = [];
  if (!src.trim()) notes.push({ code: 'EMPTY' });
  else if (!slug) notes.push({ code: 'NO_SLUG' });
  if (t.kanji.length) notes.push({ code: 'KANJI', items: t.kanji.slice(0, 12), count: t.kanji.length });
  if (t.other.length) notes.push({ code: 'OTHER', items: t.other.slice(0, 12), count: t.other.length });
  if (slug !== full) notes.push({ code: 'TRUNCATED', from: full.length, to: slug.length });
  if (/^[0-9]+$/.test(slug)) notes.push({ code: 'NUMERIC' });
  if (slug.length > 60 && slug === full) notes.push({ code: 'LONG', length: slug.length });

  return {
    slug,
    source: useReading ? 'reading' : 'title',
    separator,
    longVowel,
    romaji: parts.join(' '),
    words,
    length: slug.length,
    kanji: t.kanji,
    other: t.other,
    notes,
  };
}

/* ==================== ここまでスラッグ生成コア ==================== */

// 指摘事項のコード → 文。site側は同じコードを日英それぞれの文へ訳している
const NOTE_TEXT = {
  ja: {
    EMPTY: () => 'タイトルも読みも空です。',
    NO_SLUG: () => 'ローマ字にできる文字がありません。reading にかなで読みを渡してください。',
    KANJI: (n) => `漢字はスラッグに入れていません（${n.items.join(' ')}）。reading にかなで読みを渡してください。`,
    OTHER: (n) => `かな・英数字以外の文字は省いています（${n.items.join(' ')}）。`,
    TRUNCATED: (n) => `${n.from}文字を語の切れ目で${n.to}文字に縮めました。`,
    NUMERIC: () => '数字だけのスラッグは、パーマリンク設定によっては日付アーカイブ（/2026/ など）と衝突するため、WordPress が末尾に -2 を付けて保存することがあります。',
    LONG: (n) => `${n.length}文字はURLとしては長めです。助詞（no・wo・ni など）や飾りの語を reading から外すと短くなります。`,
    DUPLICATE: (n) => `同じスラッグになる項目があります: ${n.items.join(' / ')}（WordPress では2件目以降に -2 などが付きます）。`,
  },
  en: {
    EMPTY: () => 'Both the title and the reading are empty.',
    NO_SLUG: () => 'Nothing can be turned into letters. Pass the reading in kana as reading.',
    KANJI: (n) => `Kanji are left out of the slug (${n.items.join(' ')}). Pass the reading in kana as reading.`,
    OTHER: (n) => `Characters other than kana and Latin letters are left out (${n.items.join(' ')}).`,
    TRUNCATED: (n) => `Shortened from ${n.from} to ${n.to} characters at a word boundary.`,
    NUMERIC: () => 'A slug made only of digits can clash with date archives (/2026/) depending on the permalink settings, and WordPress may save it with -2 appended.',
    LONG: (n) => `${n.length} characters is long for a URL. Dropping particles (no, wo, ni…) and filler words from reading shortens it.`,
    DUPLICATE: (n) => `Some items produce the same slug: ${n.items.join(' / ')} (WordPress appends -2 and so on to the later ones).`,
  },
};

const MAX_ITEMS = 1000;

export class SlugToolError extends Error {}

function noteMessages(notes, lang) {
  return notes.map((n) => {
    const out = { code: n.code, message: NOTE_TEXT[lang][n.code] ? NOTE_TEXT[lang][n.code](n) : n.code };
    if (n.items) out.items = n.items;
    return out;
  });
}

// 1件ぶんの結果。区切り × 長音の4通りも添える（site の「ほかの書き方」と同じ）
function one(item, o, lang) {
  const r = slugGenerate({ ...o, title: item.title, reading: item.reading });
  const variants = {};
  for (const separator of Object.keys(SLUG_SEPARATORS)) {
    for (const longVowel of SLUG_LONG_VOWELS) {
      variants[`${separator}_${longVowel}`] = slugGenerate({ ...o, title: item.title, reading: item.reading, separator, longVowel }).slug;
    }
  }
  return {
    title: item.title,
    ...(item.reading ? { reading: item.reading } : {}),
    slug: r.slug,
    length: r.length,
    source: r.source,
    romaji: r.romaji,
    words: r.words.map((w) => ({ input: w.input, output: w.output })),
    skipped: { kanji: r.kanji, other: r.other },
    variants,
    notes: noteMessages(r.notes, lang),
  };
}

/**
 * 日本語タイトル（または読み）から URL スラッグを作る。
 *
 * @param {object} opts
 * @param {string} [opts.title]   タイトル（items と排他）
 * @param {string} [opts.reading] 読み。空でなければタイトルの代わりにこちらから作る
 * @param {{title?:string, reading?:string}[]} [opts.items] まとめて作る（1000件まで）
 * @param {'kebab'|'snake'} [opts.separator='kebab']
 * @param {'omit'|'keep'} [opts.longVowel='omit']
 * @param {boolean} [opts.splitKatakana=true]
 * @param {number} [opts.maxLength=0] 0＝無制限
 * @param {'ja'|'en'} [opts.lang='ja']
 */
export async function slugGenerateTool(opts = {}) {
  const lang = opts.lang || 'ja';
  if (lang !== 'ja' && lang !== 'en') throw new SlugToolError(`lang は ja か en: ${opts.lang}`);
  const separator = opts.separator === undefined ? 'kebab' : opts.separator;
  if (!SLUG_SEPARATORS[separator]) throw new SlugToolError(`separator は kebab か snake: ${opts.separator}`);
  const longVowel = opts.longVowel === undefined ? 'omit' : opts.longVowel;
  if (SLUG_LONG_VOWELS.indexOf(longVowel) === -1) throw new SlugToolError(`longVowel は omit か keep: ${opts.longVowel}`);
  const maxLength = opts.maxLength === undefined ? 0 : opts.maxLength;
  if (!Number.isInteger(maxLength) || maxLength < 0 || maxLength > 200) {
    throw new SlugToolError(`maxLength は 0〜200 の整数（0＝無制限）: ${opts.maxLength}`);
  }
  const o = { separator, longVowel, maxLength, splitKatakana: opts.splitKatakana !== false };

  if (opts.items !== undefined) {
    if (opts.title !== undefined || opts.reading !== undefined) throw new SlugToolError('items と title/reading は同時に渡せません');
    if (!Array.isArray(opts.items) || !opts.items.length) throw new SlugToolError('items は1件以上の配列で渡してください');
    if (opts.items.length > MAX_ITEMS) throw new SlugToolError(`items は ${MAX_ITEMS} 件まで: ${opts.items.length}`);
    const results = opts.items.map((it) => {
      const item = typeof it === 'string' ? { title: it } : it || {};
      return one({ title: String(item.title ?? ''), reading: String(item.reading ?? '') }, o, lang);
    });
    // 同じスラッグの衝突（WordPress は後の記事に -2 を付ける）
    const seen = new Map();
    for (const r of results) if (r.slug) seen.set(r.slug, (seen.get(r.slug) || 0) + 1);
    const dupes = [...seen].filter(([, n]) => n > 1).map(([s]) => s);
    const notes = dupes.length ? noteMessages([{ code: 'DUPLICATE', items: dupes.slice(0, 20) }], lang) : [];
    return { count: results.length, separator, longVowel, max_length: maxLength, results, notes };
  }

  if (typeof opts.title !== 'string' && typeof opts.reading !== 'string') {
    throw new SlugToolError('title か reading（またはまとめて作るなら items）を渡してください');
  }
  return { separator, longVowel, max_length: maxLength, ...one({ title: opts.title || '', reading: opts.reading || '' }, o, lang) };
}
