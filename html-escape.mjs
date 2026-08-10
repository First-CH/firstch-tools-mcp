// HTMLエンティティ・特殊文字のエスケープ / デコード（tools.first-ch.com/html-escape/ と同一ロジック）
//
// 「変換コア」ブロックは site 側の site/html-escape/app.js と同一の実装。
// 2箇所ルール: 片方を直したらもう片方も同じ内容で直す（site側が正本）。
// 使っているのは String/RegExp だけなので、ブラウザ版のコードをそのまま持ってこられる。
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

/* ==================== ここから変換コア（site/html-escape/app.js と同一） ==================== */

// HTML 4.01 の名前付き文字参照（252個）＋ HTML5 の apos。
// Latin-1 の 96個は U+00A0 から順に並ぶので、名前だけを順番に持って生成する。
const LATIN1_NAMES = ('nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy macr deg '
  + 'plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest '
  + 'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml '
  + 'ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig '
  + 'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml '
  + 'eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml').split(' ');

// Latin-1 以外は「名前:コードポイント(16進)」で持つ
const NAMED_HEX = 'quot:22 amp:26 apos:27 lt:3C gt:3E '
  + 'OElig:152 oelig:153 Scaron:160 scaron:161 Yuml:178 fnof:192 circ:2C6 tilde:2DC '
  + 'Alpha:391 Beta:392 Gamma:393 Delta:394 Epsilon:395 Zeta:396 Eta:397 Theta:398 Iota:399 Kappa:39A '
  + 'Lambda:39B Mu:39C Nu:39D Xi:39E Omicron:39F Pi:3A0 Rho:3A1 Sigma:3A3 Tau:3A4 Upsilon:3A5 Phi:3A6 '
  + 'Chi:3A7 Psi:3A8 Omega:3A9 alpha:3B1 beta:3B2 gamma:3B3 delta:3B4 epsilon:3B5 zeta:3B6 eta:3B7 '
  + 'theta:3B8 iota:3B9 kappa:3BA lambda:3BB mu:3BC nu:3BD xi:3BE omicron:3BF pi:3C0 rho:3C1 sigmaf:3C2 '
  + 'sigma:3C3 tau:3C4 upsilon:3C5 phi:3C6 chi:3C7 psi:3C8 omega:3C9 thetasym:3D1 upsih:3D2 piv:3D6 '
  + 'ensp:2002 emsp:2003 thinsp:2009 zwnj:200C zwj:200D lrm:200E rlm:200F ndash:2013 mdash:2014 '
  + 'lsquo:2018 rsquo:2019 sbquo:201A ldquo:201C rdquo:201D bdquo:201E dagger:2020 Dagger:2021 bull:2022 '
  + 'hellip:2026 permil:2030 prime:2032 Prime:2033 lsaquo:2039 rsaquo:203A oline:203E frasl:2044 euro:20AC '
  + 'image:2111 weierp:2118 real:211C trade:2122 alefsym:2135 larr:2190 uarr:2191 rarr:2192 darr:2193 '
  + 'harr:2194 crarr:21B5 lArr:21D0 uArr:21D1 rArr:21D2 dArr:21D3 hArr:21D4 forall:2200 part:2202 '
  + 'exist:2203 empty:2205 nabla:2207 isin:2208 notin:2209 ni:220B prod:220F sum:2211 minus:2212 '
  + 'lowast:2217 radic:221A prop:221D infin:221E ang:2220 and:2227 or:2228 cap:2229 cup:222A int:222B '
  + 'there4:2234 sim:223C cong:2245 asymp:2248 ne:2260 equiv:2261 le:2264 ge:2265 sub:2282 sup:2283 '
  + 'nsub:2284 sube:2286 supe:2287 oplus:2295 otimes:2297 perp:22A5 sdot:22C5 lceil:2308 rceil:2309 '
  + 'lfloor:230A rfloor:230B lang:2329 rang:232A loz:25CA spades:2660 clubs:2663 hearts:2665 diams:2666';

const NAMED = {};      // 名前 → 文字
const NAME_OF = {};    // 文字 → 名前（先に定義された方を優先）
LATIN1_NAMES.forEach((name, i) => {
  const ch = String.fromCodePoint(0xa0 + i);
  NAMED[name] = ch;
  NAME_OF[ch] = name;
});
NAMED_HEX.split(' ').forEach((pair) => {
  const i = pair.indexOf(':');
  const name = pair.slice(0, i);
  const ch = String.fromCodePoint(parseInt(pair.slice(i + 1), 16));
  NAMED[name] = ch;
  // & < > " ' は escapeHtml 側で個別に扱うので、非ASCIIの逆引きだけ登録する
  if (ch.codePointAt(0) > 0x7f && NAME_OF[ch] === undefined) NAME_OF[ch] = name;
});

// HTML仕様が定める数値文字参照の置き換え表。&#128; は U+0080 ではなく € になる
// （Windows-1252 を UTF-8 と取り違えたページが大量にあったため、仕様側が追認した）。
const C1_REMAP = {
  0x80: 0x20ac, 0x82: 0x201a, 0x83: 0x0192, 0x84: 0x201e, 0x85: 0x2026, 0x86: 0x2020, 0x87: 0x2021,
  0x88: 0x02c6, 0x89: 0x2030, 0x8a: 0x0160, 0x8b: 0x2039, 0x8c: 0x0152, 0x8e: 0x017d, 0x91: 0x2018,
  0x92: 0x2019, 0x93: 0x201c, 0x94: 0x201d, 0x95: 0x2022, 0x96: 0x2013, 0x97: 0x2014, 0x98: 0x02dc,
  0x99: 0x2122, 0x9a: 0x0161, 0x9b: 0x203a, 0x9c: 0x0153, 0x9e: 0x017e, 0x9f: 0x0178,
};

const BASIC = { '&': 'amp', '<': 'lt', '>': 'gt', '"': 'quot', "'": 'apos' };
const BASIC_CP = { '&': 38, '<': 60, '>': 62, '"': 34, "'": 39 };

/**
 * テキストをHTMLエスケープする。
 * @param {string} text
 * @param {object} [opts]
 * @param {boolean} [opts.quotes=true]   " と ' も変換する（属性値に入れるなら必須）
 * @param {boolean} [opts.apos=false]    ' を &apos; にする（false なら &#39;。HTML4には &apos; が無い）
 * @param {boolean} [opts.numeric=false] 名前ではなく数値文字参照（&#38; 形式）で出力する
 * @param {boolean} [opts.nbsp=true]     U+00A0（ノーブレークスペース）を必ず参照にする
 * @param {'none'|'named'|'decimal'|'hex'} [opts.nonAscii='none'] 非ASCII文字の扱い
 */
export function escapeHtml(text, opts) {
  const o = opts || {};
  const quotes = o.quotes !== false;
  const numeric = Boolean(o.numeric);
  const nbsp = o.nbsp !== false;
  const nonAscii = o.nonAscii || 'none';
  const counts = { amp: 0, lt: 0, gt: 0, quot: 0, apos: 0, nbsp: 0, nonAscii: 0 };
  let out = '';
  // for…of は文字単位ではなくコードポイント単位で回るので、絵文字などのサロゲートペアが割れない
  for (const ch of String(text)) {
    const cp = ch.codePointAt(0);
    if (BASIC_CP[ch] !== undefined) {
      if ((ch === '"' || ch === "'") && !quotes) {
        out += ch;
        continue;
      }
      counts[BASIC[ch]] += 1;
      if (numeric) {
        out += '&#' + BASIC_CP[ch] + ';';
      } else if (ch === "'" && !o.apos) {
        // &apos; は HTML 4.01 に無く、古いIEでそのまま表示されるため既定は数値参照
        out += '&#39;';
      } else {
        out += '&' + BASIC[ch] + ';';
      }
      continue;
    }
    if (cp === 0xa0 && nbsp) {
      counts.nbsp += 1;
      out += numeric ? '&#160;' : '&nbsp;';
      continue;
    }
    if (cp > 0x7f && nonAscii !== 'none') {
      counts.nonAscii += 1;
      if (nonAscii === 'named' && NAME_OF[ch]) out += '&' + NAME_OF[ch] + ';';
      else if (nonAscii === 'hex') out += '&#x' + cp.toString(16).toUpperCase() + ';';
      else out += '&#' + cp + ';';
      continue;
    }
    out += ch;
  }
  return { text: out, counts };
}

// 数値文字参照のコードポイントを文字へ。仕様どおり不正な値は U+FFFD へ倒す。範囲外は null
export function charFromCodePoint(cp) {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff) return null;
  if (C1_REMAP[cp] !== undefined) return String.fromCodePoint(C1_REMAP[cp]);
  if (cp === 0 || (cp >= 0xd800 && cp <= 0xdfff)) return '�';
  return String.fromCodePoint(cp);
}

const REF_RE = /&(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g;

/**
 * HTMLエンティティを元の文字へ戻す。名前付き（HTML4の252個＋apos）・10進・16進に対応。
 * 知らない名前や範囲外の数値はそのまま残し、何を残したかを返す（黙って壊さないため）。
 */
export function unescapeHtml(text) {
  const counts = { named: 0, decimal: 0, hex: 0 };
  const unknown = [];
  const invalid = [];
  const out = String(text).replace(REF_RE, (whole, body) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const cp = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      const ch = charFromCodePoint(cp);
      if (ch === null) {
        if (invalid.indexOf(whole) === -1) invalid.push(whole);
        return whole;
      }
      counts[hex ? 'hex' : 'decimal'] += 1;
      return ch;
    }
    const ch = NAMED[body];
    if (ch === undefined) {
      if (unknown.indexOf(whole) === -1) unknown.push(whole);
      return whole;
    }
    counts.named += 1;
    return ch;
  });
  return { text: out, counts, unknown, invalid };
}

// セミコロンが無い参照らしき文字列（&nbsp や &#39 など）。ブラウザは一部を救済するが挙動が割れる
const LOOSE_RE = /&(#[xX]?[0-9a-fA-F]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,30})(?![0-9a-zA-Z;])/g;
// 参照として成立していない裸の &
const BARE_AMP_RE = /&(?!(#[xX][0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);)/g;

const countMatches = (re, s) => (String(s).match(re) || []).length;

/**
 * エスケープ / デコードを1回分実行し、結果・内訳・指摘事項を返す。
 * 指摘は表示側で日英に訳せるようコード（DOUBLE_ESCAPE など）で返す。
 *
 * @param {object} opts
 * @param {'escape'|'unescape'} [opts.mode='escape']
 * @param {string} opts.text
 * @param {boolean} [opts.quotes] @param {boolean} [opts.apos]
 * @param {boolean} [opts.numeric] @param {boolean} [opts.nbsp]
 * @param {'none'|'named'|'decimal'|'hex'} [opts.nonAscii]
 */
export function htmlEscapeConvert(opts) {
  const o = opts || {};
  const mode = o.mode === 'unescape' ? 'unescape' : 'escape';
  const input = typeof o.text === 'string' ? o.text : '';
  const notes = [];

  if (mode === 'escape') {
    const r = escapeHtml(input, o);
    const already = countMatches(REF_RE, input);
    if (already > 0) notes.push({ code: 'DOUBLE_ESCAPE', count: already });
    const nbspCount = (input.match(/\u00a0/g) || []).length;
    if (nbspCount) notes.push({ code: 'HAS_NBSP', count: nbspCount });
    if (r.counts.apos > 0 && !o.apos && !o.numeric) notes.push({ code: 'APOS_NUMERIC' });
    if (!(o.quotes !== false) && /["']/.test(input)) notes.push({ code: 'QUOTES_KEPT' });
    const changed = r.counts.amp + r.counts.lt + r.counts.gt + r.counts.quot
      + r.counts.apos + r.counts.nbsp + r.counts.nonAscii;
    if (changed === 0 && input) notes.push({ code: 'NOTHING_TO_ESCAPE' });
    return {
      mode,
      text: r.text,
      input_length: [...input].length,
      output_length: [...r.text].length,
      changed,
      counts: r.counts,
      notes,
    };
  }

  const r = unescapeHtml(input);
  const changed = r.counts.named + r.counts.decimal + r.counts.hex;
  if (r.unknown.length) notes.push({ code: 'UNKNOWN_ENTITY', items: r.unknown.slice(0, 8), count: r.unknown.length });
  if (r.invalid.length) notes.push({ code: 'INVALID_NUMERIC', items: r.invalid.slice(0, 8), count: r.invalid.length });
  const loose = input.match(LOOSE_RE) || [];
  if (loose.length) notes.push({ code: 'MISSING_SEMICOLON', items: loose.slice(0, 8), count: loose.length });
  const bare = countMatches(BARE_AMP_RE, input) - loose.length;
  if (bare > 0) notes.push({ code: 'BARE_AMP', count: bare });
  if (/<[a-zA-Z!/]/.test(r.text)) notes.push({ code: 'HAS_TAGS' });
  if (changed === 0 && input) notes.push({ code: 'NOTHING_TO_DECODE' });
  return {
    mode,
    text: r.text,
    input_length: [...input].length,
    output_length: [...r.text].length,
    changed,
    counts: r.counts,
    unknown: r.unknown,
    invalid: r.invalid,
    notes,
  };
}

/* ==================== ここまで変換コア ==================== */

// 指摘事項のコードを日本語の文へ。site側は同じコードを日英それぞれの文へ訳している
const NOTE_TEXT = {
  DOUBLE_ESCAPE: (n) => `入力にすでに文字参照が ${n} 個含まれています（すでにエスケープ済みのテキストではありませんか）。もう一度エスケープすると &amp; が &amp;amp; になります。`,
  HAS_NBSP: (n) => `ノーブレークスペース（U+00A0）が ${n} 個あります。見た目は半角スペースですが別の文字なので &nbsp; として書き出しました。`,
  APOS_NUMERIC: () => "アポストロフィは &apos; ではなく &#39; で出力しています（&apos; はHTML 4.01に無く、古いブラウザではそのまま表示されるため）。apos=true で切り替えられます。",
  QUOTES_KEPT: () => '引用符をそのまま残しています。要素の中身なら問題ありませんが、属性値に入れると壊れます。',
  NOTHING_TO_ESCAPE: () => 'エスケープが必要な文字はありませんでした。',
  UNKNOWN_ENTITY: (n, items) => `知らないエンティティ名が ${n} 個あり、そのまま残しました: ${items.join(' ')}`,
  INVALID_NUMERIC: (n, items) => `Unicodeの範囲外を指す数値文字参照が ${n} 個あり、そのまま残しました: ${items.join(' ')}`,
  MISSING_SEMICOLON: (n, items) => `セミコロンで閉じていない参照が ${n} 個あります: ${items.join(' ')} — ブラウザによって解釈が割れるためデコードしていません。`,
  BARE_AMP: (n) => `参照になっていない裸の「&」が ${n} 個あります。HTMLとしては &amp; と書くのが正しい形です。`,
  HAS_TAGS: () => 'デコード結果にタグが含まれています。ページに入れると文字ではなくHTMLとして解釈されます。',
  NOTHING_TO_DECODE: () => '文字参照は見つかりませんでした（入力のままです）。',
};

export class HtmlEscapeError extends Error {}

/**
 * テキスト（または UTF-8 のテキストファイル）をHTMLエスケープするか、
 * HTMLエンティティを元の文字へ戻す。
 *
 * @param {object} opts
 * @param {'escape'|'unescape'} [opts.mode='escape']
 * @param {string} [opts.text]        対象テキスト（path と排他）
 * @param {string} [opts.path]        対象ファイルの絶対パス（UTF-8として読む）
 * @param {string} [opts.outputPath]  結果を書き出す絶対パス（指定すると text は返さない）
 * @param {boolean}[opts.quotes=true] escape: " と ' も変換する
 * @param {boolean}[opts.apos=false]  escape: ' を &apos; にする（既定は &#39;）
 * @param {boolean}[opts.numeric=false] escape: 名前ではなく数値文字参照で出力する
 * @param {'none'|'named'|'decimal'|'hex'} [opts.nonAscii='none'] escape: 非ASCII文字の扱い
 */
export async function htmlEscape(opts = {}) {
  const mode = opts.mode || 'escape';
  if (mode !== 'escape' && mode !== 'unescape') throw new HtmlEscapeError(`mode は escape か unescape: ${opts.mode}`);
  const hasText = typeof opts.text === 'string';
  if (hasText === Boolean(opts.path)) throw new HtmlEscapeError('text か path のどちらか一方を渡してください');
  if (opts.nonAscii && ['none', 'named', 'decimal', 'hex'].indexOf(opts.nonAscii) === -1) {
    throw new HtmlEscapeError(`nonAscii は none / named / decimal / hex: ${opts.nonAscii}`);
  }

  const input = hasText ? opts.text : await readFile(opts.path, 'utf8');
  const r = htmlEscapeConvert({ ...opts, mode, text: input });

  const result = {
    mode: r.mode,
    source: hasText ? { type: 'text' } : { path: opts.path, name: basename(opts.path) },
    text: r.text,
    input_length: r.input_length,
    output_length: r.output_length,
    changed: r.changed,
    counts: r.counts,
    options: mode === 'escape'
      ? {
        quotes: opts.quotes !== false,
        apos: Boolean(opts.apos),
        numeric: Boolean(opts.numeric),
        non_ascii: opts.nonAscii || 'none',
      }
      : null,
    notes: r.notes.map((n) => ({
      code: n.code,
      message: NOTE_TEXT[n.code] ? NOTE_TEXT[n.code](n.count, n.items || []) : n.code,
    })),
  };
  if (mode === 'unescape') {
    result.unknown_entities = r.unknown;
    result.invalid_references = r.invalid;
  }
  if (opts.outputPath) {
    await writeFile(opts.outputPath, r.text, 'utf8');
    result.output = opts.outputPath;
    // ファイルに書けたなら本文は重複した重い情報でしかない
    delete result.text;
  }
  return result;
}
