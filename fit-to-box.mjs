/* 記入欄に収める字の大きさと改行位置（fit_to_box）
 * 割り付けのコア（fitAddress / fitText / fitToBox / daiji ほか）は
 * FirstCHTools の site/nakabukuro-ran/app.js と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルからコアの開始/終了コメントに挟まれた範囲を sed で切り出し
 * （site側は字下げ2文字を落とす・こちらは行頭の export を落とす）、
 * diff が空になることで同期を機械的に確認できる。
 *
 * 市販の中袋（ご祝儀袋・香典袋）など、欄が印刷済みの用紙に手で書くときに、欄の幅・高さ（mm）と向きから
 * 収まる1字の大きさ・行数・改行位置を返す。住所は「〜番地」と「建物名・部屋番号」の境目を優先して改行し、
 * 縦書きでは番地を漢数字に、金額は大字にする。完全ローカル処理・ネットワーク送信なし。 */

// ==== ここからコア（DOM に触らない。tests/nakabukuro-ran.test.mjs が確かめる。MCP の fit-to-box.mjs と同じ）====
export var PAD = 1.5;                       // 欄の線の内側に空ける余白（mm・四辺）
export var GAP = 0.3;                       // 行と行の間（1字の大きさに対する比）
export var MIN_OK = 4;                      // 1字がこれを下回ると、代わりの割り付けを並べる（mm）
export var MAX_LINES = 4;                   // 住所の行数の上限（郵便番号の行を除く）
export var CAP = { address: 9, name: 14, amount: 14, plain: 12 };   // 欄が大きくても、手書きでこれより大きくはしない（mm）
export var NAIVE = 5;                       // 「そのまま書く」ときの1字の大きさ（mm）
export var KAN = '〇一二三四五六七八九';
export var DAIJI = ['', '壱', '弐', '参', '四', '伍', '六', '七', '八', '九'];
export var NUM_K = '〇一二三四五六七八九十百千';
export var NO_HEAD = 'ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶー・、。，．）」』】〕〉》！？!?)]}室階-';   // 行頭に来させない字
export var ROTATE_V = 'ー－-‐―—〜～…‥（）()「」『』【】〔〕〈〉《》[]{}＝=';   // 縦書きで90度回す字
export var SMALL_V = 'ぁぃぅぇぉっゃゅょゎァィゥェォッャュョヮヵヶ';
export var PUNCT_V = '、。，．';

// 全角英数を半角に、全角空白を半角に、連続する空白を1つに（改行は残す）
export function toHalf(s) {
  return String(s == null ? '' : s)
    .replace(/[！-～]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })
    .replace(/\r\n?/g, '\n').replace(/[　\t]/g, ' ').replace(/ +/g, ' ')
    .split('\n').map(function (l) { return l.trim(); }).join('\n').replace(/\n{2,}/g, '\n').trim();
}
// 住所の正規化: 数字の間のハイフン類をすべて「-」にそろえる
export function normAddress(s) {
  return toHalf(s).replace(/([0-9])\s*[‐‑‒–—―−ーｰ－-]\s*(?=[0-9])/g, '$1-');
}
export function normPostal(s) {
  var d = toHalf(s).replace(/[^0-9]/g, '');
  if (!d) return '';
  return d.length === 7 ? d.slice(0, 3) + '-' + d.slice(3) : d;
}
// 算用数字の列を漢数字に。style='digits' は「一〇」型（1字ずつ）、'tens' は「十」型（位取り・4桁まで）
export function kanjiNum(digits, style) {
  var n = parseInt(digits, 10);
  if (style !== 'tens' || /^0/.test(digits) || n === 0 || digits.length > 4) {
    return digits.replace(/[0-9]/g, function (d) { return KAN[+d]; });
  }
  var out = '', units = ['', '十', '百', '千'];
  for (var i = digits.length - 1, p = 0; i >= 0; i--, p++) {
    var d = +digits[i];
    if (!d) continue;
    out = ((d === 1 && p > 0) ? '' : KAN[d]) + units[p] + out;
  }
  return out;
}
// 横書きの文字列を縦書き用に: 数字は漢数字、ハイフンは「ー」、英字・記号は全角（縦書きで立てて書く）
export function verticalize(s, style) {
  return String(s).replace(/[0-9]+/g, function (d) { return kanjiNum(d, style); })
    .replace(/-/g, 'ー')
    .replace(/[!-~]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 0xFEE0); });
}
// 金額を大字に（1〜99,999,999円）。opts: sen（'阡'|'千'|'仟'）・en（'円'|'圓'）・nari（也を付ける）・printed（「金」「円」が欄に印刷済み）
export function parseAmount(s) {
  var t = toHalf(s).replace(/[,，、\s円圓]/g, '');
  if (!t) return null;
  var m = /^([0-9]+)(?:万([0-9]*))?$/.exec(t);
  if (!m) return NaN;
  var n = m[2] !== undefined ? (+m[1]) * 10000 + (m[2] ? +m[2] : 0) : +m[1];
  return n;
}
export function daiji(n, opts) {
  opts = opts || {};
  if (!(n >= 1 && n <= 99999999 && Math.floor(n) === n)) return null;
  var sen = opts.sen || '阡', units = ['', '拾', '百', sen];
  function group(g) {
    var out = '';
    for (var p = 3; p >= 0; p--) {
      var d = Math.floor(g / Math.pow(10, p)) % 10;
      if (d) out += DAIJI[d] + units[p];
    }
    return out;
  }
  var hi = Math.floor(n / 10000), lo = n % 10000;
  var body = (hi ? group(hi) + '萬' : '') + group(lo);
  if (opts.printed) return body;
  return '金' + body + (opts.en || '円') + (opts.nari ? '也' : '');
}

// 1字の幅（1字の大きさに対する比）。横書きの半角英数・記号は 0.6、空白は 0.5、ほかは1
export function unitOf(ch, orient) {
  if (ch === ' ') return 0.5;
  if (orient !== 'v' && /[!-~]/.test(ch)) return 0.6;
  return 1;
}
export function unitsOf(str, orient) {
  var u = 0;
  for (var i = 0; i < str.length; i++) u += unitOf(str[i], orient);
  return u;
}
// 欄の中に入る大きさ。lines は行ごとの幅（字数相当）
export function sizeFor(lineUnits, w, h, orient, cap) {
  var L = (orient === 'v' ? h : w) - 2 * PAD, C = (orient === 'v' ? w : h) - 2 * PAD;
  if (L <= 0 || C <= 0 || !lineUnits.length) return 0;
  var n = lineUnits.length, maxU = Math.max.apply(null, lineUnits.concat([0.5]));
  return Math.max(0, Math.min(L / maxU, C / (n + (n - 1) * GAP), cap));
}
export function floor1(x) { return Math.floor(x * 10 + 1e-9) / 10; }

// 住所を「都道府県」「〜番地」「建物名・部屋番号」に分ける（横書きの正規化済みの文字列で）
export var PREF_RE = /^(東京都|北海道|(?:京都|大阪)府|[^\s0-9]{2,3}?県)/;
export var CHAIN_RE = /[0-9]+(?:(?:丁目|番地|番|号|の|-)+[0-9]+)*(?:丁目|番地|番|号)?/g;
export var KCHAIN_RE = /[〇一二三四五六七八九十百千]+(?:丁目|番地|番|号)(?:(?:の|-|ー)?[〇一二三四五六七八九十百千]+(?:番地|番|号)?)*/g;
export function splitAddress(addr) {
  var s = normAddress(addr), main = s, building = '', explicit = false;
  var nl = s.indexOf('\n');
  if (nl >= 0) { main = s.slice(0, nl); building = s.slice(nl + 1).replace(/\n/g, ' '); explicit = true; }
  else {
    var end = -1, m;
    CHAIN_RE.lastIndex = 0;
    while ((m = CHAIN_RE.exec(s))) {
      var next = s.charAt(m.index + m[0].length);
      if (/[条線丁地]/.test(next)) continue;              // 「北4条西」の 4 のように町名の一部の数字
      end = m.index + m[0].length; break;
    }
    if (end < 0) {
      KCHAIN_RE.lastIndex = 0;
      if ((m = KCHAIN_RE.exec(s))) end = m.index + m[0].length;
    }
    if (end > 0) { main = s.slice(0, end).trim(); building = s.slice(end).trim(); }
  }
  var pm = PREF_RE.exec(main);
  return { pref: pm ? pm[1] : '', main: main, building: building, explicit: explicit };
}

// 文字列を「区切れる単位（atom）」に分け、各単位の前で改行してよいかを重みで持つ（0 = 改行しない）
// 数字の並び（「2丁目10番地の18」「1203号」）は1つの単位にして途中で切らない
export function atomize(text, startWeight) {
  var atoms = [], i = 0, s = String(text), m, spaceBefore = false;
  CHAIN_RE.lastIndex = 0;
  var chains = [];
  while ((m = CHAIN_RE.exec(s))) chains.push([m.index, m.index + m[0].length]);
  var ci = 0;
  while (i < s.length) {
    if (s[i] === ' ') { spaceBefore = true; i++; continue; }
    var t;
    if (ci < chains.length && chains[ci][0] === i) { t = s.slice(i, chains[ci][1]); ci++; }
    else t = s[i];
    while (ci < chains.length && chains[ci][0] < i + t.length) ci++;
    // 区切りの無い字の間で切るのは、ほかに手が無いときだけ（「烏丸通七／条」のように語の途中で切れる）
    var w = atoms.length ? (spaceBefore ? 0.9 : (NO_HEAD.indexOf(t[0]) >= 0 ? 0 : 0.6)) : 0;
    atoms.push({ t: t, w: w, sp: spaceBefore && atoms.length > 0 });
    spaceBefore = false;
    i += t.length;
  }
  return atoms;
}
// 位置 at（main の先頭からの文字数）の単位の前の重みを w 以上にする
export function markAt(atoms, at, w) {
  var pos = 0;
  for (var k = 0; k < atoms.length; k++) {
    if (pos === at && k > 0) { atoms[k].w = Math.max(atoms[k].w, w); return; }
    pos += atoms[k].t.length;
  }
}
// 住所1件ぶんの単位の列（郵便番号を除く）。primary は「〜番地」と「建物名」の境目の単位の番号（無ければ -1）
export function addressAtoms(parts, omitPref) {
  var main = parts.main;
  if (omitPref && parts.pref && main.indexOf(parts.pref) === 0) main = main.slice(parts.pref.length);
  var a = atomize(main);
  var prefLen = (!omitPref && parts.pref && parts.main.indexOf(parts.pref) === 0) ? parts.pref.length : 0;
  if (prefLen) markAt(a, prefLen, 0.95);
  // 市区町村の後（数字の前を含む）
  var pos = 0;
  for (var k = 0; k < a.length; k++) {
    var t = a[k].t;
    if (k > 0 && pos >= prefLen) {
      var prev = a[k - 1].t;
      if (/[市区郡町村]$/.test(prev) && !/^[0-9〇一二三四五六七八九十]/.test(t)) a[k].w = Math.max(a[k].w, 0.95);
      if (/^[0-9]/.test(t) || /^[〇一二三四五六七八九十百千]+(?:丁目|番地|番|号)/.test(t)) a[k].w = Math.max(a[k].w, 0.93);
    }
    pos += t.length;
  }
  var primary = -1, room = -1;
  if (parts.building) {
    var b = atomize(parts.building);
    // 部屋番号の前（末尾の「1203号室」「101」「2F」など）
    var rm = /^(.*\S)\s*([0-9A-Za-z]+(?:-[0-9]+)?\s*(?:号室|号|F|階)?|[〇一二三四五六七八九]+号室)$/.exec(parts.building);
    if (rm && rm[1].length) { markAt(b, parts.building.length - rm[2].length, 0.95); room = a.length + indexAt(b, parts.building.length - rm[2].length); }
    b.forEach(function (x, k) { if (k > 0 && /[棟館]$/.test(b[k - 1].t)) x.w = Math.max(x.w, 0.9); });
    b[0].w = 1; b[0].sp = true;
    primary = a.length;
    a = a.concat(b);
  }
  return { atoms: a, primary: primary, room: room };
}
export function indexAt(atoms, at) {
  var pos = 0;
  for (var k = 0; k < atoms.length; k++) { if (pos === at) return k; pos += atoms[k].t.length; }
  return -1;
}
// 単位の列を、改行の組み合わせ（最大 maxBreaks 個）から、字がいちばん大きく、区切りの良い割り付けを選ぶ
// fixed: 先頭に必ず置く行（郵便番号）、must: 必ず改行する単位の番号、primary: 優先する区切り
export function bestLayout(atoms, conv, opt) {
  var orient = opt.orient, n = atoms.length, cap = opt.cap;
  var disp = atoms.map(function (x) { return conv(x.t); });
  var units = disp.map(function (t) { return unitsOf(t, orient); });
  var cand = [];
  for (var k = 1; k < n; k++) if (atoms[k].w > 0) cand.push(k);
  var must = (opt.must || []).filter(function (k) { return k > 0 && k < n; });
  var fixedU = (opt.fixed || []).map(function (t) { return unitsOf(t, orient); });
  // 「〜番地」と「建物名」の境目で改行する割り付け（pri）と、すべての割り付け（any）の最良をそれぞれ持つ
  var pri = null, any = null, hasPri = opt.primary > 0;
  function lineUnits(breaks) {
    var out = [], start = 0;
    breaks.concat([n]).forEach(function (b) {
      var u = 0;
      for (var k = start; k < b; k++) u += units[k] + (k > start && atoms[k].sp ? 0.5 : 0);
      out.push(u); start = b;
    });
    return out;
  }
  function consider(breaks) {
    for (var i = 0; i < must.length; i++) if (breaks.indexOf(must[i]) < 0) return;
    var lu = lineUnits(breaks);
    var s = sizeFor(fixedU.concat(lu), opt.w, opt.h, orient, cap);
    var score = s;
    if (!opt.maxSize) {                                // 代わりの割り付けは、区切りの良さより字の大きさを取る
      breaks.forEach(function (b) { score *= atoms[b].w; });
      score *= 1 - 0.03 * breaks.length;
    }
    score -= 1e-5 * lu.reduce(function (a, u) { return a + u * u; }, 0);   // 同じ大きさなら、行の長さがそろう方
    var cand1 = { score: score, size: s, breaks: breaks.slice() };
    if (!any || score > any.score + 1e-9) any = cand1;
    if (hasPri && breaks.indexOf(opt.primary) >= 0 && (!pri || score > pri.score + 1e-9)) pri = cand1;
  }
  var maxB = Math.min(opt.maxBreaks == null ? MAX_LINES - 1 : opt.maxBreaks, cand.length);
  consider([]);
  for (var a = 0; a < cand.length && maxB >= 1; a++) {
    consider([cand[a]]);
    for (var b = a + 1; b < cand.length && maxB >= 2; b++) {
      consider([cand[a], cand[b]]);
      for (var c = b + 1; c < cand.length && maxB >= 3; c++) consider([cand[a], cand[b], cand[c]]);
    }
  }
  // 境目で改行して 4mm 以上になるならそれを使う。届かないときだけ、字が大きくなるほかの区切りを使う
  var best = pri && (pri.size >= MIN_OK || !(any.size > pri.size + 0.05)) ? pri : any;
  if (!best) return null;
  var lines = [], start = 0;
  best.breaks.concat([n]).forEach(function (b) {
    var t = '';
    for (var k = start; k < b; k++) t += (k > start && atoms[k].sp ? ' ' : '') + disp[k];
    lines.push(t); start = b;
  });
  return { size: best.size, lines: (opt.fixed || []).concat(lines), breaks: best.breaks };
}
export function result(lay, w, h, orient, kind) {
  var size = floor1(lay.size);
  return { size: size, lines: lay.lines, lineCount: lay.lines.length, orientation: orient === 'v' ? 'vertical' : 'horizontal', width: w, height: h,
    ok: size >= MIN_OK, kind: kind };
}
export function postalLine(postal, orient, style) {
  var p = normPostal(postal);
  if (!p) return '';
  return orient === 'v' ? '〒' + verticalize(p, 'digits') : '〒' + p;
}
// 住所欄。返り値: main（優先の割り付け）・noPref（都道府県を省いた場合）・bld2（建物名を2行にした場合）・naive（そのまま1行で書いた場合）
export function fitAddress(o) {
  var orient = o.orientation === 'vertical' || o.orientation === 'v' ? 'v' : 'h';
  var w = +o.width, h = +o.height, style = o.numerals === 'tens' ? 'tens' : 'digits';
  var conv = orient === 'v' ? function (t) { return verticalize(t, style); } : function (t) { return t; };
  var parts = splitAddress(o.address || '');
  if (!parts.main) return { error: 'EMPTY' };
  if (!(w > 2 * PAD) || !(h > 2 * PAD)) return { error: 'TOO_SMALL' };
  var fixed = o.postal ? [postalLine(o.postal, orient, style)].filter(Boolean) : [];
  var base = addressAtoms(parts, false);
  var opt = { orient: orient, w: w, h: h, cap: CAP.address, fixed: fixed, primary: base.primary };
  var main = result(bestLayout(base.atoms, conv, opt), w, h, orient, 'address');
  var out = { main: main, parts: { prefecture: parts.pref, main: conv(parts.main), building: conv(parts.building) } };
  // そのまま1行で書いた場合（共有の画像の「はみ出す例」）
  var whole = fixed.concat([conv(parts.main + (parts.building ? ' ' + parts.building : ''))]);
  var C = (orient === 'v' ? w : h) - 2 * PAD, L = (orient === 'v' ? h : w) - 2 * PAD;
  var ns = Math.min(NAIVE, C / (whole.length + (whole.length - 1) * GAP));
  var nu = unitsOf(whole[whole.length - 1], orient);
  out.naive = { size: floor1(ns), lines: whole, need: Math.round(ns * nu * 10) / 10, room: Math.round(L * 10) / 10,
    overflowChars: Math.max(0, Math.ceil((ns * nu - L) / ns)) };
  if (parts.pref) {
    var np = addressAtoms(parts, true);
    out.noPref = result(bestLayout(np.atoms, conv, { orient: orient, w: w, h: h, cap: CAP.address, fixed: fixed, primary: np.primary, maxSize: true }), w, h, orient, 'address');
  }
  if (parts.building && base.primary > 0) {
    var must = [base.primary];
    var inner = [];
    for (var k = base.primary + 1; k < base.atoms.length; k++) if (base.atoms[k].w > 0) inner.push(k);
    if (inner.length) {
      // 建物名の中の区切り（部屋番号の前など）のうち、いちばん重いものを必ず使う
      var bestK = inner.reduce(function (p, k) { return base.atoms[k].w > base.atoms[p].w ? k : p; }, inner[0]);
      if (base.room > 0 && inner.indexOf(base.room) >= 0) bestK = base.room;
      var lay = bestLayout(base.atoms, conv, { orient: orient, w: w, h: h, cap: CAP.address, fixed: fixed, primary: base.primary, must: must.concat([bestK]), maxSize: true });
      if (lay) out.bld2 = result(lay, w, h, orient, 'address');
    }
  }
  return out;
}
// 氏名・金額・任意の文字列。kind: 'name' | 'amount' | 'plain'。改行を入れた所は必ず改行する
export function fitText(o) {
  var orient = o.orientation === 'vertical' || o.orientation === 'v' ? 'v' : 'h';
  var w = +o.width, h = +o.height, kind = o.kind || 'plain', style = o.numerals === 'tens' ? 'tens' : 'digits';
  if (!(w > 2 * PAD) || !(h > 2 * PAD)) return { error: 'TOO_SMALL' };
  var text = toHalf(o.text);
  if (!text) return { error: 'EMPTY' };
  var conv = orient === 'v' ? function (t) { return verticalize(t, style); } : function (t) { return t; };
  var atoms = [], must = [];
  text.split('\n').forEach(function (line, li) {
    var a = atomize(line);
    if (kind !== 'plain') a.forEach(function (x) { x.w = x.sp ? x.w : 0; });   // 氏名・金額は空白でだけ改行してよい
    if (li > 0 && a.length) { a[0].w = 1; must.push(atoms.length); }
    atoms = atoms.concat(a);
  });
  var lay = bestLayout(atoms, conv, { orient: orient, w: w, h: h, cap: CAP[kind] || CAP.plain, must: must, maxBreaks: kind === 'plain' ? 3 : Math.max(1, must.length) });
  return result(lay, w, h, orient, kind);
}
// MCP の fit_to_box と同じ入口
export function fitToBox(o) {
  if ((o.kind || 'address') === 'address') return fitAddress({ address: o.text, postal: o.postalCode, width: o.width, height: o.height, orientation: o.orientation, numerals: o.numerals });
  if (o.kind === 'amount') {
    var n = parseAmount(o.text);
    var d = daiji(n, o.amount || {});
    if (!d) return { error: 'BAD_AMOUNT' };
    var r = fitText({ text: d, width: o.width, height: o.height, orientation: o.orientation, kind: 'amount' });
    r.daiji = d;
    return r;
  }
  return fitText({ text: o.text, width: o.width, height: o.height, orientation: o.orientation, kind: o.kind, numerals: o.numerals });
}
// ==== ここまでコア ====

export class FitToBoxError extends Error {}

const KINDS = ['address', 'name', 'amount', 'plain'];
const MSG = {
  ja: {
    EMPTY: '文字列が空です',
    TOO_SMALL: '欄が小さすぎます（四辺に1.5mmずつの余白を取ると字が入りません）',
    BAD_AMOUNT: '金額は 1〜99,999,999 の整数で渡してください（「3万」「30,000円」も可）',
    small: '1字が4mmを下回ります。都道府県を省いた場合（omitPrefecture）と建物名を2行にした場合（buildingTwoLines）の大きさも返します。省いてよいかは使う人が決めてください',
  },
  en: {
    EMPTY: 'The text is empty',
    TOO_SMALL: 'The box is too small (no room after a 1.5 mm margin on each side)',
    BAD_AMOUNT: 'Pass an amount from 1 to 99,999,999 (e.g. 30000, 3万 or 30,000円)',
    small: 'Characters are under 4 mm; sizes with the prefecture dropped (omitPrefecture) and with the building on two lines (buildingTwoLines) are included. Whether to drop anything is the user\'s call',
  },
};

function layoutOut(r) {
  return { charSizeMm: r.size, lineCount: r.lineCount, lines: r.lines, fits4mm: r.ok };
}

/**
 * MCP の入口。text・width・height（mm）・orientation（'vertical' | 'horizontal'）を受け、
 * 欄に収まる1字の大きさ（mm・0.1mm 単位で切り捨て）と、改行した後の各行を返す。
 * kind: 'address'（既定）| 'name' | 'amount' | 'plain'
 */
export function fitToBoxTool(opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'ja';
  const kind = opts.kind === undefined ? 'address' : opts.kind;
  if (!KINDS.includes(kind)) throw new FitToBoxError(`kind は ${KINDS.join(' / ')} のどれかです`);
  const orientation = opts.orientation === undefined ? 'vertical' : opts.orientation;
  if (!['vertical', 'horizontal'].includes(orientation)) throw new FitToBoxError("orientation は 'vertical' か 'horizontal' です");
  const width = Number(opts.width), height = Number(opts.height);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 1000 || height > 1000) {
    throw new FitToBoxError('width と height は 0 より大きく 1000 以下の mm で渡してください');
  }
  if (typeof opts.text !== 'string') throw new FitToBoxError('text（文字列）が必要です');
  if (opts.text.length > 2000) throw new FitToBoxError('text は2000字までです');
  const r = fitToBox({
    kind, text: opts.text, width, height, orientation, postalCode: opts.postalCode, numerals: opts.numerals,
    amount: { sen: opts.thousandChar, en: opts.yenChar, nari: !!opts.nari, printed: !!opts.kinEnPrinted },
  });
  const base = { kind, orientation, width, height, marginMm: PAD, lineGapRatio: GAP };
  if (r.error) return { ok: false, ...base, error: { code: r.error, message: MSG[lang][r.error] } };
  if (kind !== 'address') {
    const out = { ok: true, ...base, ...layoutOut(r) };
    if (r.daiji) out.daiji = r.daiji;
    return out;
  }
  const out = { ok: true, ...base, ...layoutOut(r.main), parts: r.parts,
    asIs: { charSizeMm: r.naive.size, lines: r.naive.lines, neededMm: r.naive.need, availableMm: r.naive.room, overflowChars: r.naive.overflowChars } };
  if (!r.main.ok) {
    out.alternatives = {};
    if (r.noPref) out.alternatives.omitPrefecture = layoutOut(r.noPref);
    if (r.bld2) out.alternatives.buildingTwoLines = layoutOut(r.bld2);
    out.notes = [MSG[lang].small];
  }
  return out;
}
