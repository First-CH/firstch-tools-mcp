/* SERPプレビュー＆メタタグ文字数チェック（serp_check）
 * title / description / URL から、Google 検索結果での切り詰め（ピクセル幅基準）・文字数・
 * パンくず表示・指摘事項・貼り付け用のタグを返す。
 *
 * 行分割と切り詰めのコア（DEVICES / CJK / NO_START / NO_END / tokenize / wrap / layout / urlParts /
 * count / esc / buildTags）は FirstCHTools の site/serp/app.js と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * site 側はモジュールではなく目印のコメントも無いため、関数単位で写している。
 * 同期の確認は、両ファイルから同名の関数を `awk '/^function wrap/,/^}/'` のように切り出し
 * （こちらは行頭の export を落とす）、diff が空になることで行う。
 * 判定（状態と指摘の並び）は site 側 update() の「計測」「指摘」部分を DOM から切り離して写したもの（serpJudge）。
 *
 * site と違うのは文字幅の測り方だけ。site はブラウザの canvas measureText で実測するが、
 * Node には canvas が無いので、ここでは Arial の字幅表（欧文。Arial / Liberation Sans の公表値）と、
 * 和文・全角記号＝1em、半角カナ＝0.5em、ハングル＝0.865em、絵文字＝20px で22px・14px で18px の近似で測る
 * （macOS の Chrome で site の measure() と突き合わせた値）。カーニング（AV・Te や、ヒラギノのかなと句読点の詰め）は
 * 入れていないので、ブラウザの実測より数px広く出ることがある＝切り詰めの判定は早め（安全側）に寄る。
 * site 側の実測も端末のフォント（Mac のヒラギノ・Windows の游ゴシック/メイリオ）で変わるため、
 * 境目ぎりぎりの1〜2文字は目安として扱う。
 * URLを取りに行く処理は無い。完全ローカル処理・ネットワーク送信なし。 */

// ---- 計測の基準値（site と同一） ----
export const DEVICES = {
  desktop: { width: 600, title: { size: 20, lines: 1 }, desc: { size: 14, lines: 2 } },
  mobile: { width: 380, title: { size: 20, lines: 2 }, desc: { size: 14, lines: 3 } },
};

// site の canvas が使うフォント指定（参考。ここでは下の字幅表で測る）
export const FONT = 'Arial, "Helvetica Neue", Helvetica, "Hiragino Sans", "Hiragino Kaku Gothic ProN", "Yu Gothic", YuGothic, Meiryo, sans-serif';

// ---- 字幅表（site との違いはここだけ） ----
// Arial の advance width（unitsPerEm=2048）。U+0020〜U+007E と U+00A0〜U+017F
const ARIAL_ASCII = [569, 569, 727, 1139, 1139, 1821, 1366, 391, 682, 682, 797, 1196, 569, 682, 569, 569, 1139, 1139, 1139, 1139, 1139, 1139, 1139, 1139, 1139, 1139, 569, 569, 1196, 1196, 1196, 1139, 2079, 1366, 1366, 1479, 1479, 1366, 1251, 1593, 1479, 569, 1024, 1366, 1139, 1706, 1479, 1593, 1366, 1593, 1479, 1366, 1251, 1479, 1366, 1933, 1366, 1366, 1251, 569, 569, 569, 961, 1139, 682, 1139, 1139, 1024, 1139, 1139, 569, 1139, 1139, 455, 455, 1024, 455, 1706, 1139, 1139, 1139, 1139, 682, 1024, 569, 1139, 1024, 1479, 1024, 1024, 1024, 684, 532, 684, 1196];
const ARIAL_LATIN1 = [569, 682, 1139, 1139, 1139, 1139, 532, 1139, 682, 1509, 758, 1139, 1196, 682, 1509, 1131, 819, 1124, 682, 682, 682, 1180, 1100, 682, 682, 682, 748, 1139, 1708, 1708, 1708, 1251, 1366, 1366, 1366, 1366, 1366, 1366, 2048, 1479, 1366, 1366, 1366, 1366, 569, 569, 569, 569, 1479, 1479, 1593, 1593, 1593, 1593, 1593, 1196, 1593, 1479, 1479, 1479, 1479, 1366, 1366, 1251, 1139, 1139, 1139, 1139, 1139, 1139, 1821, 1024, 1139, 1139, 1139, 1139, 569, 569, 569, 569, 1139, 1139, 1139, 1139, 1139, 1139, 1139, 1124, 1251, 1139, 1139, 1139, 1139, 1024, 1139, 1024, 1366, 1139, 1366, 1139, 1366, 1139, 1479, 1024, 1479, 1024, 1479, 1024, 1479, 1024, 1479, 1259, 1479, 1139, 1366, 1139, 1366, 1139, 1366, 1139, 1366, 1139, 1366, 1139, 1593, 1139, 1593, 1139, 1593, 1139, 1593, 1139, 1479, 1139, 1479, 1139, 569, 569, 569, 569, 569, 569, 569, 455, 569, 569, 1505, 909, 1024, 455, 1366, 1024, 1024, 1139, 455, 1139, 455, 1139, 597, 1139, 684, 1139, 455, 1479, 1139, 1479, 1139, 1479, 1139, 1237, 1481, 1139, 1593, 1139, 1593, 1139, 1593, 1139, 2048, 1933, 1479, 682, 1479, 682, 1479, 682, 1366, 1024, 1366, 1024, 1366, 1024, 1366, 1024, 1251, 569, 1251, 768, 1251, 569, 1479, 1139, 1479, 1139, 1479, 1139, 1479, 1139, 1479, 1139, 1479, 1139, 1933, 1479, 1366, 1024, 1366, 1251, 1024, 1251, 1024, 1251, 1024, 455];
const ARIAL_PUNCT = { 0x2013: 1139, 0x2014: 2048, 0x2018: 455, 0x2019: 455, 0x201c: 682, 0x201d: 682, 0x2022: 717, 0x2026: 2048, 0x2039: 682, 0x203a: 682, 0x20ac: 1139, 0x2122: 2048 };
const PICTO = /\p{Extended_Pictographic}/u;

function charWidth(ch, size) {
  const cp = ch.codePointAt(0);
  if (cp >= 0x20 && cp <= 0x7e) return (ARIAL_ASCII[cp - 0x20] * size) / 2048;
  if (cp >= 0xa0 && cp <= 0x17f) return (ARIAL_LATIN1[cp - 0xa0] * size) / 2048;
  if (ARIAL_PUNCT[cp]) return (ARIAL_PUNCT[cp] * size) / 2048;
  if (cp === 0x09) return (ARIAL_ASCII[0] * size) / 2048;
  if (cp >= 0x300 && cp <= 0x36f) return 0; // 結合文字
  if (cp === 0x200d || (cp >= 0xfe00 && cp <= 0xfe0f)) return 0; // ZWJ・異体字セレクタ
  if (cp >= 0xff61 && cp <= 0xff9f) return size / 2; // 半角カナ
  if (cp >= 0xac00 && cp <= 0xd7a3) return size * 0.865; // ハングル（Apple SD Gothic Neo）
  if (PICTO.test(ch)) return size === 20 ? 22 : size === 14 ? 18 : size * 1.1; // カラー絵文字
  return size; // 和文・全角記号ほか
}

/** 文字列の表示幅（px）。site の measure() の代わり */
export function measure(text, size) {
  let w = 0;
  for (const ch of text) w += charWidth(ch, size);
  return w;
}

// ---- 行分割（site と同一） ----
// 和文は文字単位、欧文は単語単位で折り返す。約物の行頭・行末禁則だけ簡易に処理する。
export const CJK = /[⺀-〿぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/;
export const NO_START = '、。，．・：；？！゛゜ゝゞヽヾーァィゥェォッャュョヮヵヶぁぃぅぇぉっゃゅょゎ々）］｝〉》」』】〕”’｠»,.:;?!)]}%';
export const NO_END = '（［｛〈《「『【〔“‘｟«([{$￥';

export function tokenize(text) {
  const out = [];
  let buf = '';
  for (const ch of text) {
    if (ch === ' ' || ch === '\t' || ch === '　') {
      if (buf) { out.push(buf); buf = ''; }
      out.push(ch);
    } else if (CJK.test(ch)) {
      if (buf) { out.push(buf); buf = ''; }
      out.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf) out.push(buf);
  return out;
}

export function wrap(text, width, size) {
  const lines = [];
  let cur = '';
  for (const tok of tokenize(text)) {
    const next = cur + tok;
    if (cur === '' && (tok === ' ' || tok === '\t')) continue;
    if (measure(next, size) <= width) { cur = next; continue; }
    // 行頭に置けない約物は、はみ出しても前の行にぶら下げる
    if (tok.length === 1 && NO_START.includes(tok)) { cur = next; continue; }
    if (cur === '') { cur = tok; continue; }
    // 行末に置けない括弧類は次の行へ送る
    let carry = '';
    if (NO_END.includes(cur.slice(-1))) { carry = cur.slice(-1); cur = cur.slice(0, -1); }
    lines.push(cur);
    cur = (carry + tok).replace(/^[ \t]+/, '');
  }
  if (cur) lines.push(cur);
  return lines;
}

// 行数の上限を超えたら、最終行を「…」が入る幅まで削って切り詰め位置を返す。
export function layout(text, width, size, maxLines) {
  const src = text.replace(/\s+/g, ' ').trim();
  if (!src) return { lines: [], cut: '', truncated: false, width: 0 };
  const all = wrap(src, width, size);
  const total = measure(src, size);
  if (all.length <= maxLines) return { lines: all, cut: '', truncated: false, width: total };
  const kept = all.slice(0, maxLines);
  const rest = all.slice(maxLines).join('');
  let last = kept[maxLines - 1];
  let dropped = '';
  while (last && measure(last + '…', size) > width) {
    dropped = last.slice(-1) + dropped;
    last = last.slice(0, -1);
  }
  kept[maxLines - 1] = last.replace(/\s+$/, '') + '…';
  return { lines: kept, cut: (dropped + rest).trim(), truncated: true, width: total };
}

// ---- URL の表示（Googleのパンくず風・site と同一） ----
export function urlParts(raw) {
  const s = raw.trim();
  if (!s) return null;
  let u;
  try { u = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
  let host = u.hostname.replace(/^www\./, '');
  try { host = decodeURIComponent(host); } catch { /* そのまま */ }
  const segs = u.pathname.split('/').filter(Boolean).map((p) => {
    try { return decodeURIComponent(p); } catch { return p; }
  });
  return { host, segs, protocol: u.protocol, raw: s };
}

// ---- 文字数（絵文字などを1文字として数える・site と同一） ----
const seg = typeof Intl !== 'undefined' && Intl.Segmenter ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
export const count = (s) => (seg ? [...seg.segment(s)].length : [...s].length);

const esc = (s) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function buildTags(title, desc, parts) {
  const out = [];
  if (title) out.push(`<title>${esc(title)}</title>`);
  if (desc) out.push(`<meta name="description" content="${esc(desc)}">`);
  if (parts) out.push(`<link rel="canonical" href="${esc(parts.raw)}">`);
  return out.join('\n');
}

/**
 * 判定（site の update() の「計測」「指摘」部分）。入力の空白は site の v() と同じく1つに畳んで前後を落とす。
 * @param {{title?:string, description?:string, url?:string}} input
 * @param {'desktop'|'mobile'} deviceName
 */
export function serpJudge(input, deviceName) {
  const dev = DEVICES[deviceName] || DEVICES.desktop;
  const norm = (s) => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const title = norm(input.title);
  const desc = norm(input.description);
  const parts = urlParts(String(input.url == null ? '' : input.url));

  const tl = layout(title, dev.width, dev.title.size, dev.title.lines);
  const dl = layout(desc, dev.width, dev.desc.size, dev.desc.lines);
  const titleLimit = dev.width * dev.title.lines;
  const descLimit = dev.width * dev.desc.lines;

  const st = (empty, truncated, short) => (empty ? 'empty' : truncated ? 'cut' : short ? 'short' : 'ok');
  const tState = st(!title, tl.truncated, tl.width < titleLimit * 0.5);
  const dState = st(!desc, dl.truncated, dl.width < descLimit * 0.5);

  const checks = [];
  if (!title) checks.push(['fail', 'TITLE_EMPTY']);
  else {
    if (tl.truncated) checks.push(['warn', 'TITLE_CUT']);
    else if (tState === 'short') checks.push(['warn', 'TITLE_SHORT']);
    if (!/[|｜\-–—:：·]/.test(title)) checks.push(['warn', 'TITLE_NO_BRAND']);
  }
  if (!desc) checks.push(['fail', 'DESC_EMPTY']);
  else if (dl.truncated) checks.push(['warn', 'DESC_CUT']);
  else if (dState === 'short') checks.push(['warn', 'DESC_SHORT']);
  if (!parts) checks.push(['warn', 'URL_EMPTY']);
  else {
    if (parts.protocol !== 'https:') checks.push(['warn', 'URL_HTTP']);
    if (parts.segs.length > 3) checks.push(['warn', 'URL_LONG']);
    if (/%[0-9a-f]{2}/i.test(parts.raw)) checks.push(['warn', 'URL_ENCODED']);
  }

  return {
    device: DEVICES[deviceName] ? deviceName : 'desktop',
    width: dev.width,
    title: { text: title, chars: count(title), width: tl.width, limit: titleLimit, maxLines: dev.title.lines, lines: tl.lines, truncated: tl.truncated, cut: tl.cut, state: tState },
    description: { text: desc, chars: count(desc), width: dl.width, limit: descLimit, maxLines: dev.desc.lines, lines: dl.lines, truncated: dl.truncated, cut: dl.cut, state: dState },
    url: parts,
    checks,
    tags: buildTags(title, desc, parts),
  };
}

/* ==================== ここから MCP 側だけ（ツールの入出力） ==================== */

// 指摘の文言（site の T と同じ文）
const CHECK_TEXT = {
  ja: {
    TITLE_EMPTY: 'タイトルが未入力です。検索結果の見出しになる、ページ内で最も効く要素です。',
    TITLE_CUT: 'タイトルが切り詰められます。伝えたい語を前半に置くか、短くしてください。',
    TITLE_SHORT: 'タイトルに余裕があります。狙う検索語を足せます。',
    TITLE_NO_BRAND: 'サイト名が見当たりません。「ページ名 | サイト名」が通例です（Googleが書き換え・追記することもあります）。',
    DESC_EMPTY: '説明文が未入力です。Googleが本文から抜粋を作るため、出る文章を選べません。',
    DESC_CUT: '説明文が切り詰められます。要点を1行目に置いてください。',
    DESC_SHORT: '説明文に余裕があります。もう1文入ります。',
    URL_EMPTY: 'URLが未入力です。タイトル上のパンくず表示に使われます。',
    URL_HTTP: 'https ではありません。Chromeは http のページに「保護されていない通信」を出します。',
    URL_LONG: 'パスが長いため、検索結果のパンくず表示自体も省略されます。',
    URL_ENCODED: 'URLにパーセントエンコードが含まれます。Googleはデコードして表示します（このプレビューも同じ）。',
  },
  en: {
    TITLE_EMPTY: 'The title is empty. The <title> element is the strongest on-page signal for what the result is called.',
    TITLE_CUT: 'The title is cut off. Put the words that matter first, or shorten it.',
    TITLE_SHORT: 'The title is short. There is room left for the query the page should win.',
    TITLE_NO_BRAND: 'No site name found. “Page name | Site name” is the usual shape (Google may rewrite or append it either way).',
    DESC_EMPTY: 'The description is empty. Google then builds the snippet from the page body, and you do not choose it.',
    DESC_CUT: 'The description is cut off. Say the point in the first line.',
    DESC_SHORT: 'The description is short — there is room for another sentence.',
    URL_EMPTY: 'No URL entered. The breadcrumb above the title is drawn from it.',
    URL_HTTP: 'Not https. Chrome marks http pages as “Not secure”.',
    URL_LONG: 'The path is long, so the breadcrumb itself gets shortened in the result.',
    URL_ENCODED: 'The URL contains percent-encoded characters. Google shows them decoded, which is what the preview does here.',
  },
};

const MEASURE_NOTE = {
  ja: 'ピクセル幅は Arial の字幅表と和文1em の近似（カーニングなし）。ブラウザの実測より数px広く出ることがあり、切り詰めの判定は早めに寄る。',
  en: 'Pixel widths use Arial advance widths and 1em for CJK (no kerning). They can run a few px wider than a browser measurement, so truncation is flagged slightly early.',
};

export const SERP_MAX_ITEMS = 500;

export class SerpToolError extends Error {}

function field(f) {
  return {
    text: f.text,
    chars: f.chars,
    width_px: Math.round(f.width),
    limit_px: f.limit,
    max_lines: f.maxLines,
    lines: f.lines,
    truncated: f.truncated,
    cut: f.cut,
    state: f.state,
  };
}

function one(input, device, lang) {
  const r = serpJudge(input, device);
  return {
    device: r.device,
    result_width_px: r.width,
    title: field(r.title),
    description: field(r.description),
    url: r.url ? { host: r.url.host, segments: r.url.segs, breadcrumb: [r.url.host, ...r.url.segs].join(' › '), protocol: r.url.protocol } : null,
    pass: r.checks.length === 0,
    checks: r.checks.map(([level, code]) => ({ level, code, message: CHECK_TEXT[lang][code] })),
    tags: r.tags,
  };
}

function check(input, devices, lang) {
  if (devices.length === 1) return one(input, devices[0], lang);
  const out = {};
  for (const d of devices) out[d] = one(input, d, lang);
  return { pass: devices.every((d) => out[d].pass), ...out };
}

/**
 * title / description / URL を検索結果の表示幅で判定する。
 * @param {object} opts
 * @param {string} [opts.title]
 * @param {string} [opts.description]
 * @param {string} [opts.url]
 * @param {{title?:string, description?:string, url?:string}[]} [opts.items] まとめて判定（500件まで）
 * @param {'desktop'|'mobile'|'both'} [opts.device='desktop']
 * @param {'ja'|'en'} [opts.lang='ja']
 */
export async function serpCheckTool(opts = {}) {
  const lang = opts.lang || 'ja';
  if (lang !== 'ja' && lang !== 'en') throw new SerpToolError(`lang は ja か en: ${opts.lang}`);
  const device = opts.device === undefined ? 'desktop' : opts.device;
  if (!['desktop', 'mobile', 'both'].includes(device)) throw new SerpToolError(`device は desktop / mobile / both: ${opts.device}`);
  const devices = device === 'both' ? ['desktop', 'mobile'] : [device];
  for (const k of ['title', 'description', 'url']) {
    if (opts[k] !== undefined && typeof opts[k] !== 'string') throw new SerpToolError(`${k} は文字列で渡してください`);
  }

  if (opts.items !== undefined) {
    if (opts.title !== undefined || opts.description !== undefined || opts.url !== undefined) {
      throw new SerpToolError('items と title/description/url は同時に渡せません');
    }
    if (!Array.isArray(opts.items) || !opts.items.length) throw new SerpToolError('items は1件以上の配列で渡してください');
    if (opts.items.length > SERP_MAX_ITEMS) throw new SerpToolError(`items は ${SERP_MAX_ITEMS} 件まで: ${opts.items.length}`);
    const results = opts.items.map((it) => check(it || {}, devices, lang));
    return { count: results.length, device, passed: results.filter((r) => r.pass).length, results, measurement: MEASURE_NOTE[lang] };
  }

  if (opts.title === undefined && opts.description === undefined && opts.url === undefined) {
    throw new SerpToolError('title・description・url のどれか（まとめて判定するなら items）を渡してください');
  }
  return { device, ...check(opts, devices, lang), measurement: MEASURE_NOTE[lang] };
}
