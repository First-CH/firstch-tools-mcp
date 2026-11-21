/* X(Twitter) の重み付き文字数（count_chars の x_weight）
 * 「ここからウェイト計算コア」〜「ここまでウェイト計算コア」は FirstCHTools の site/x-length/app.js の
 * 同じ範囲と同一（2箇所ルール: site 側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * twitter-text の weighted length（configuration v3）を再現する: NFC 正規化・書記素単位・
 * 絵文字の塊は2・URL は一律23（スキーム無しのドメインも拾う）・メンション/ハッシュタグは普通の文字。
 *
 * 照合のしかた（site 側は字下げ2文字を落とす・こちらは行頭の export を落とす。diff が空なら同期済み）:
 *   S=<FirstCHTools>/site/x-length/app.js
 *   R='/^ *\/\* =* ここからウェイト計算コア/,/^ *\/\* =* ここまでウェイト計算コア/p'
 *   diff <(sed -n "$R" $S | sed 's/^  //') <(sed -n "$R" x-weight.mjs | sed 's/^export //')
 * test.mjs も、隣に FirstCHTools があれば（または FIRSTCH_TOOLS_REPO で場所を指定すれば）同じ照合をする。
 * 完全ローカル処理・ネットワーク送信なし。 */

/* ==================== ここからウェイト計算コア ==================== */

// twitter-text configuration v3。ranges に入る符号位置が weight 100（＝1）、
// それ以外は defaultWeight 200（＝2）。scale が 100 なので、ここでは 1 と 2 で持つ。
const X_LIGHT_RANGES = [[0, 4351], [8192, 8205], [8208, 8223], [8242, 8247]];
export const X_URL_WEIGHT = 23;      // t.co へ短縮されるため、URLは長さに関係なく一律23
export const X_DEFAULT_LIMIT = 280;

// 絵文字は連続した1つの塊（ZWJ・肌の色・異体字セレクタ・国旗・キーキャップ）で2ウェイト。
// Regional_Indicator（国旗）と U+20E3（キーキャップ）は Extended_Pictographic に入らないので足す。
const X_EMOJI_RE = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;

// ドメインだけで書かれたURL（スキーム無し）を拾うためのTLD。X本体は全gTLD/ccTLDを持つが、
// ここでは実務で見かけるものに絞っている（下の About に明記）。
const X_TLDS = [
  'com', 'net', 'org', 'edu', 'gov', 'mil', 'int', 'info', 'biz', 'name', 'pro', 'co',
  'io', 'ai', 'app', 'dev', 'me', 'tv', 'cc', 'xyz', 'site', 'online', 'shop', 'store',
  'blog', 'page', 'link', 'live', 'news', 'tech', 'cloud', 'design', 'studio', 'space',
  'world', 'today', 'team', 'work', 'wiki', 'zone', 'fun', 'life', 'digital', 'agency',
  'media', 'club', 'group', 'inc', 'ltd', 'tokyo', 'osaka', 'nagoya', 'jp', 'uk', 'us',
  'ca', 'au', 'de', 'fr', 'it', 'es', 'nl', 'se', 'no', 'fi', 'dk', 'pl', 'ru', 'ch',
  'at', 'be', 'pt', 'gr', 'cz', 'tr', 'br', 'mx', 'ar', 'cl', 'in', 'id', 'th', 'vn',
  'ph', 'my', 'sg', 'hk', 'tw', 'kr', 'cn', 'nz', 'za', 'ae', 'il', 'ie', 'is', 'lt',
  'lv', 'ee', 'hu', 'ro', 'ua', 'to', 'ly', 'gg', 'fm', 'am', 'sh', 'st', 'im', 'so',
];

// URLの本体として取り込まない文字（空白・全角空白・引用符・和文の括弧）
const URL_STOP = '\\s\\u3000<>"\'’“”「」『』（）【】';
const X_URL_RE = new RegExp(
  '(?<![A-Za-z0-9@._/-])' +
  '(?:https?://[^' + URL_STOP + ']+' +
  '|(?:[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\\.)+(?:' + X_TLDS.join('|') + ')(?![A-Za-z0-9-])' +
  '(?::\\d{2,5})?(?:/[^' + URL_STOP + ']*)?)',
  'gi'
);
// 文末の句読点や閉じ括弧はURLに含めない
const URL_TAIL_RE = /[.,!?;:、。）」』】)\]]+$/;

const X_MENTION_RE = /(?<![A-Za-z0-9_@/])@([A-Za-z0-9_]{1,15})(?![A-Za-z0-9_])/g;
// ハッシュタグは英数字・アンダースコアのほか、日本語（ひらがな・カタカナ・漢字・全角英数）も使える
const X_HASHTAG_BODY = 'A-Za-z0-9_\\u00c0-\\u024f\\u0370-\\u04ff\\u3005\\u3041-\\u309f\\u30a1-\\u30ff\\u3400-\\u4dbf\\u4e00-\\u9fff\\uff10-\\uff19\\uff21-\\uff3a\\uff41-\\uff5a\\uff66-\\uff9f';
const X_HASHTAG_RE = new RegExp('(?<![A-Za-z0-9_&' + X_HASHTAG_BODY + '])[#＃]([' + X_HASHTAG_BODY + ']+)', 'g');

/** 符号位置1つ分のウェイト（1 または 2） */
function cpWeight(cp) {
  for (const [start, end] of X_LIGHT_RANGES) {
    if (cp >= start && cp <= end) return 1;
  }
  return 2;
}

const SEGMENTER = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
  ? new Intl.Segmenter(undefined, { granularity: 'grapheme' })
  : null;

/** 書記素クラスタ（見た目の1文字）へ分ける。Intl.Segmenter が無い環境では符号位置で代用する */
function graphemes(text) {
  if (!SEGMENTER) return [...text];
  const out = [];
  for (const seg of SEGMENTER.segment(text)) out.push(seg.segment);
  return out;
}

/**
 * 書記素1つ分のウェイト。
 * 絵文字の塊は全体で2、それ以外は符号位置ごとの合計（結合文字も1文字ぶん数える＝X本体と同じ）。
 */
function graphemeWeight(g) {
  if (X_EMOJI_RE.test(g)) return 2;
  let w = 0;
  for (const ch of g) w += cpWeight(ch.codePointAt(0));
  return w;
}

/** 重なり合わない実体（URL・メンション・ハッシュタグ）を先頭から順に取り出す */
export function extractEntities(text) {
  const found = [];
  const taken = [];
  const overlaps = (start, end) => taken.some((r) => start < r[1] && end > r[0]);

  X_URL_RE.lastIndex = 0;
  for (let m = X_URL_RE.exec(text); m; m = X_URL_RE.exec(text)) {
    let raw = m[0].replace(URL_TAIL_RE, '');
    if (!raw) continue;
    const start = m.index;
    const end = start + raw.length;
    found.push({ type: 'url', text: raw, start, end });
    taken.push([start, end]);
    X_URL_RE.lastIndex = end;
  }
  for (const [re, type] of [[X_MENTION_RE, 'mention'], [X_HASHTAG_RE, 'hashtag']]) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      const start = m.index;
      const end = start + m[0].length;
      // 数字だけのハッシュタグ（#1 など）はXではタグにならない
      if (type === 'hashtag' && /^[0-9０-９]+$/.test(m[1])) continue;
      if (overlaps(start, end)) continue;
      found.push({ type, text: m[0], start, end });
      taken.push([start, end]);
    }
  }
  found.sort((a, b) => a.start - b.start);
  return found;
}

/**
 * 投稿1件のウェイトを数える。
 * @param {string} raw 下書き
 * @param {number} limit 上限ウェイト（既定280）
 * @returns {{weight:number, remaining:number, over:boolean, units:Array, entities:Array,
 *            chars:number, codePoints:number, lines:number, emoji:number, wide:number,
 *            urls:number, mentions:number, hashtags:number, text:string}}
 */
export function measure(raw, limit) {
  // Xは投稿をNFCへ正規化してから数える（「カ」＋濁点の2文字は「ガ」1文字として扱われる）
  const text = raw.normalize('NFC');
  const entities = extractEntities(text);
  const units = [];   // 表示と超過位置の判定に使う最小単位
  let weight = 0;
  let emoji = 0;
  let wide = 0;
  let chars = 0;

  let pos = 0;
  const pushText = (chunk) => {
    for (const g of graphemes(chunk)) {
      const w = graphemeWeight(g);
      const isEmoji = X_EMOJI_RE.test(g);
      if (isEmoji) emoji += 1;
      else if (w === 2) wide += 1;
      units.push({ text: g, weight: w, type: isEmoji ? 'emoji' : 'text' });
      weight += w;
      chars += 1;
    }
  };
  for (const ent of entities) {
    if (ent.start > pos) pushText(text.slice(pos, ent.start));
    if (ent.type === 'url') {
      units.push({ text: ent.text, weight: X_URL_WEIGHT, type: 'url' });
      weight += X_URL_WEIGHT;
      chars += graphemes(ent.text).length;
    } else {
      // メンション・ハッシュタグは普通の文字として数える（色を付けるためだけに型を持たせる）
      const from = units.length;
      pushText(ent.text);
      for (let i = from; i < units.length; i += 1) units[i].type = ent.type;
    }
    pos = ent.end;
  }
  if (pos < text.length) pushText(text.slice(pos));

  const count = (type) => entities.filter((e) => e.type === type).length;
  return {
    text,
    units,
    entities,
    weight,
    remaining: limit - weight,
    over: weight > limit,
    chars,
    codePoints: [...text].length,
    lines: text === '' ? 0 : text.split('\n').length,
    emoji,
    wide,
    urls: count('url'),
    mentions: count('mention'),
    hashtags: count('hashtag'),
  };
}

/* ==================== ここまでウェイト計算コア ==================== */
