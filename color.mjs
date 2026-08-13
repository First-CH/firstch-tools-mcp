// Colorコード変換＆アルファ透過（tools.first-ch.com/color/ と同一ロジック）
// 正本は site 側の site/color/app.js（FirstCHTools リポジトリ）。
// 変換コア（clParseColor / clHex / clRgbStr / clHslStr / clOklchStr / clFlatten /
// clContrast / clAlphaRows / clPalette）はそちらとバイト単位で同じ内容を保つこと。
// 完全ローカル処理・ネットワーク送信なし。

/* ==================== ここから変換コア（site / MCP で同一） ==================== */

const CL_MAX_DECIMALS = 6;
// OKLCH の彩度を % で書いたときの基準（CSS Color 4: 100% = 0.4）
const CL_OKLCH_C_PCT = 0.4;

// CSSの名前付き色（148色）。値は Chrome の getComputedStyle から取得した実測値
const CL_NAMED_SRC =
  'aliceblue f0f8ff,antiquewhite faebd7,aqua 00ffff,aquamarine 7fffd4,azure f0ffff,beige f5f5dc,' +
  'bisque ffe4c4,black 000000,blanchedalmond ffebcd,blue 0000ff,blueviolet 8a2be2,brown a52a2a,' +
  'burlywood deb887,cadetblue 5f9ea0,chartreuse 7fff00,chocolate d2691e,coral ff7f50,' +
  'cornflowerblue 6495ed,cornsilk fff8dc,crimson dc143c,cyan 00ffff,darkblue 00008b,darkcyan 008b8b,' +
  'darkgoldenrod b8860b,darkgray a9a9a9,darkgreen 006400,darkgrey a9a9a9,darkkhaki bdb76b,' +
  'darkmagenta 8b008b,darkolivegreen 556b2f,darkorange ff8c00,darkorchid 9932cc,darkred 8b0000,' +
  'darksalmon e9967a,darkseagreen 8fbc8f,darkslateblue 483d8b,darkslategray 2f4f4f,' +
  'darkslategrey 2f4f4f,darkturquoise 00ced1,darkviolet 9400d3,deeppink ff1493,deepskyblue 00bfff,' +
  'dimgray 696969,dimgrey 696969,dodgerblue 1e90ff,firebrick b22222,floralwhite fffaf0,' +
  'forestgreen 228b22,fuchsia ff00ff,gainsboro dcdcdc,ghostwhite f8f8ff,gold ffd700,goldenrod daa520,' +
  'gray 808080,green 008000,greenyellow adff2f,grey 808080,honeydew f0fff0,hotpink ff69b4,' +
  'indianred cd5c5c,indigo 4b0082,ivory fffff0,khaki f0e68c,lavender e6e6fa,lavenderblush fff0f5,' +
  'lawngreen 7cfc00,lemonchiffon fffacd,lightblue add8e6,lightcoral f08080,lightcyan e0ffff,' +
  'lightgoldenrodyellow fafad2,lightgray d3d3d3,lightgreen 90ee90,lightgrey d3d3d3,lightpink ffb6c1,' +
  'lightsalmon ffa07a,lightseagreen 20b2aa,lightskyblue 87cefa,lightslategray 778899,' +
  'lightslategrey 778899,lightsteelblue b0c4de,lightyellow ffffe0,lime 00ff00,limegreen 32cd32,' +
  'linen faf0e6,magenta ff00ff,maroon 800000,mediumaquamarine 66cdaa,mediumblue 0000cd,' +
  'mediumorchid ba55d3,mediumpurple 9370db,mediumseagreen 3cb371,mediumslateblue 7b68ee,' +
  'mediumspringgreen 00fa9a,mediumturquoise 48d1cc,mediumvioletred c71585,midnightblue 191970,' +
  'mintcream f5fffa,mistyrose ffe4e1,moccasin ffe4b5,navajowhite ffdead,navy 000080,oldlace fdf5e6,' +
  'olive 808000,olivedrab 6b8e23,orange ffa500,orangered ff4500,orchid da70d6,palegoldenrod eee8aa,' +
  'palegreen 98fb98,paleturquoise afeeee,palevioletred db7093,papayawhip ffefd5,peachpuff ffdab9,' +
  'peru cd853f,pink ffc0cb,plum dda0dd,powderblue b0e0e6,purple 800080,rebeccapurple 663399,' +
  'red ff0000,rosybrown bc8f8f,royalblue 4169e1,saddlebrown 8b4513,salmon fa8072,sandybrown f4a460,' +
  'seagreen 2e8b57,seashell fff5ee,sienna a0522d,silver c0c0c0,skyblue 87ceeb,slateblue 6a5acd,' +
  'slategray 708090,slategrey 708090,snow fffafa,springgreen 00ff7f,steelblue 4682b4,tan d2b48c,' +
  'teal 008080,thistle d8bfd8,tomato ff6347,turquoise 40e0d0,violet ee82ee,wheat f5deb3,' +
  'white ffffff,whitesmoke f5f5f5,yellow ffff00,yellowgreen 9acd32';

const CL_NAMED = Object.create(null);
const CL_NAME_OF = Object.create(null);
for (const entry of CL_NAMED_SRC.split(',')) {
  const sp = entry.indexOf(' ');
  const name = entry.slice(0, sp);
  const hex = entry.slice(sp + 1);
  CL_NAMED[name] = hex;
  // 同じ値に複数の名前がある場合（aqua/cyan・gray/grey 等）は先に出てくる方を代表にする
  if (!CL_NAME_OF[hex]) CL_NAME_OF[hex] = name;
}

// 明度パレットの段。sRGBで表現できる範囲になるよう彩度は自動で落とす
const CL_TONES = [
  { key: '50', l: 0.971 }, { key: '100', l: 0.936 }, { key: '200', l: 0.885 },
  { key: '300', l: 0.828 }, { key: '400', l: 0.75 }, { key: '500', l: 0.665 },
  { key: '600', l: 0.59 }, { key: '700', l: 0.51 }, { key: '800', l: 0.44 },
  { key: '900', l: 0.378 }, { key: '950', l: 0.272 },
];

const clClamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);

/** 小数 d 桁で四捨五入した数値（JSONへ入れる数値用） */
const clRound = (n, d) => {
  const p = Math.pow(10, clClamp(Math.trunc(d), 0, CL_MAX_DECIMALS));
  return Math.round(n * p) / p;
};

/** 数値を小数 d 桁までで文字列に（末尾の0は落とす。-0 は 0） */
function clFix(n, d) {
  if (!Number.isFinite(n)) return '0';
  let s = n.toFixed(clClamp(Math.trunc(d), 0, CL_MAX_DECIMALS));
  if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return /^-0$/.test(s) ? '0' : s;
}

/* ---- 解析 ---- */

const CL_HEX_RE = /^#?([0-9a-f]+)$/i;

/** #rgb / #rgba / #rrggbb / #rrggbbaa を読む（3,4,6,8桁以外は不正） */
function clParseHex(input) {
  const m = CL_HEX_RE.exec(String(input).trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  const n = h.length;
  if (n !== 3 && n !== 4 && n !== 6 && n !== 8) return null;
  if (n <= 4) {
    const d = (i) => parseInt(h.charAt(i) + h.charAt(i), 16);
    return { r: d(0), g: d(1), b: d(2), a: n === 4 ? d(3) / 255 : 1, format: 'hex' };
  }
  const p = (i) => parseInt(h.substr(i, 2), 16);
  return { r: p(0), g: p(2), b: p(4), a: n === 8 ? p(6) / 255 : 1, format: 'hex' };
}

const CL_NUM_RE = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+)(?:e[+-]?\d+)?)(%?)$/i;
const CL_ANGLE_RE = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))(deg|grad|rad|turn)?$/i;

/** 数値トークンを読む。% なら pctBase を 100% とみなす。`none` は 0（CSS Color 4） */
function clScalar(token, pctBase) {
  const t = String(token).trim().toLowerCase();
  if (t === 'none') return 0;
  const m = CL_NUM_RE.exec(t);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  return m[2] ? (v / 100) * pctBase : v;
}

/** 角度トークンを 0〜360 の度数へ（deg / grad / rad / turn と単位なしに対応） */
function clAngle(token) {
  const t = String(token).trim().toLowerCase();
  if (t === 'none') return 0;
  const m = CL_ANGLE_RE.exec(t);
  if (!m) return null;
  const v = Number(m[1]);
  if (!Number.isFinite(v)) return null;
  const u = (m[2] || 'deg').toLowerCase();
  const deg = u === 'deg' ? v : u === 'grad' ? v * 0.9 : u === 'rad' ? (v * 180) / Math.PI : v * 360;
  return ((deg % 360) + 360) % 360;
}

/** アルファのトークン（0〜1 か 0%〜100%）を 0〜1 へ */
function clAlphaToken(token) {
  const v = clScalar(token, 1);
  return v === null ? null : clClamp(v, 0, 1);
}

/** rgb() / hsl() / oklch() / oklab() の中身を読む。旧記法（カンマ）と新記法（空白＋/）の両対応 */
function clParseFn(name, body) {
  if (body.indexOf('(') !== -1) return null;   // var() や calc() の入れ子は扱わない
  let head = body;
  let alphaTok = null;
  const slash = body.indexOf('/');
  if (slash !== -1) {
    head = body.slice(0, slash);
    alphaTok = body.slice(slash + 1).trim();
    if (!alphaTok) return null;
  }
  const parts = head.split(/[\s,]+/).filter(Boolean);
  if (alphaTok === null && parts.length === 4) alphaTok = parts.pop();
  if (parts.length !== 3) return null;

  let a = 1;
  if (alphaTok !== null) {
    a = clAlphaToken(alphaTok);
    if (a === null) return null;
  }

  if (name === 'rgb' || name === 'rgba') {
    const v = parts.map((t) => clScalar(t, 255));
    if (v.indexOf(null) !== -1) return null;
    return { r: clClamp(v[0], 0, 255), g: clClamp(v[1], 0, 255), b: clClamp(v[2], 0, 255), a, format: 'rgb' };
  }
  if (name === 'hsl' || name === 'hsla') {
    const h = clAngle(parts[0]);
    const s = clScalar(parts[1], 100);
    const l = clScalar(parts[2], 100);
    if (h === null || s === null || l === null) return null;
    const c = clHslToRgb(h, clClamp(s, 0, 100), clClamp(l, 0, 100));
    return { r: c.r, g: c.g, b: c.b, a, format: 'hsl' };
  }
  if (name === 'hwb') {
    const h = clAngle(parts[0]);
    const w = clScalar(parts[1], 100);
    const bl = clScalar(parts[2], 100);
    if (h === null || w === null || bl === null) return null;
    const c = clHwbToRgb(h, clClamp(w, 0, 100), clClamp(bl, 0, 100));
    return { r: c.r, g: c.g, b: c.b, a, format: 'hwb' };
  }
  if (name === 'oklch') {
    const L = clScalar(parts[0], 1);
    const C = clScalar(parts[1], CL_OKLCH_C_PCT);
    const H = clAngle(parts[2]);
    if (L === null || C === null || H === null) return null;
    const c = clOklchToRgb(clClamp(L, 0, 1), Math.max(0, C), H);
    return { r: c.r, g: c.g, b: c.b, a, format: 'oklch', clipped: c.clipped };
  }
  if (name === 'oklab') {
    const L = clScalar(parts[0], 1);
    const A = clScalar(parts[1], CL_OKLCH_C_PCT);
    const B = clScalar(parts[2], CL_OKLCH_C_PCT);
    if (L === null || A === null || B === null) return null;
    const lch = clOklabToOklch(clClamp(L, 0, 1), A, B);
    const c = clOklchToRgb(lch.l, lch.c, lch.h);
    return { r: c.r, g: c.g, b: c.b, a, format: 'oklab', clipped: c.clipped };
  }
  return null;
}

/**
 * 色の文字列を {r,g,b（0〜255）, a（0〜1）, format} へ。読めなければ null。
 * HEX（3/4/6/8桁）・rgb()/rgba()・hsl()/hsla()・oklch()・oklab()・CSSの名前付き色・transparent に対応。
 */
function clParseColor(input) {
  const raw = String(input === undefined || input === null ? '' : input).trim();
  if (!raw) return null;
  const low = raw.toLowerCase();
  if (low === 'transparent') return { r: 0, g: 0, b: 0, a: 0, format: 'named', name: 'transparent' };
  if (CL_NAMED[low]) {
    const c = clParseHex(CL_NAMED[low]);
    c.format = 'named';
    c.name = low;
    return c;
  }
  const fn = /^([a-z]+)\(([^]*)\)$/i.exec(low);
  if (fn) return clParseFn(fn[1].toLowerCase(), fn[2]);
  return clParseHex(low);
}

/* ---- 色空間の変換 ---- */

/** HSL（h:0-360 / s,l:0-100）→ RGB（0-255） */
function clHslToRgb(h, s, l) {
  const hh = ((h % 360) + 360) % 360;
  const ss = s / 100;
  const ll = l / 100;
  const k = (n) => (n + hh / 30) % 12;
  const aa = ss * Math.min(ll, 1 - ll);
  const f = (n) => ll - aa * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
  return { r: f(0) * 255, g: f(8) * 255, b: f(4) * 255 };
}

/** HWB（h:0-360 / w,b:0-100）→ RGB（0-255）。白と黒の合計が100%以上なら灰色になる */
function clHwbToRgb(h, w, b) {
  const W = w / 100;
  const B = b / 100;
  if (W + B >= 1) {
    const g = (W / (W + B)) * 255;
    return { r: g, g, b: g };
  }
  const pure = clHslToRgb(h, 100, 50);
  const mix = (v) => (v / 255) * (1 - W - B) * 255 + W * 255;
  return { r: mix(pure.r), g: mix(pure.g), b: mix(pure.b) };
}

/** RGB（0-255）→ HSL（h:0-360 / s,l:0-100） */
function clRgbToHsl(r, g, b) {
  const R = r / 255;
  const G = g / 255;
  const B = b / 255;
  const max = Math.max(R, G, B);
  const min = Math.min(R, G, B);
  const d = max - min;
  let h = 0;
  if (d > 0) {
    if (max === R) h = ((G - B) / d) % 6;
    else if (max === G) h = (B - R) / d + 2;
    else h = (R - G) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  const l = (max + min) / 2;
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1));
  return { h, s: clClamp(s * 100, 0, 100), l: clClamp(l * 100, 0, 100) };
}

// sRGB のガンマ（符号つき。ガモット外の負値も折り返さずそのまま返す）
const clLinear = (c) => {
  const v = c / 255;
  const s = v < 0 ? -1 : 1;
  const x = Math.abs(v);
  return s * (x <= 0.04045 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4));
};
const clGamma = (c) => {
  const s = c < 0 ? -1 : 1;
  const x = Math.abs(c);
  return 255 * s * (x <= 0.0031308 ? x * 12.92 : 1.055 * Math.pow(x, 1 / 2.4) - 0.055);
};

/** RGB（0-255）→ OKLab（Björn Ottosson の行列） */
function clRgbToOklab(r, g, b) {
  const R = clLinear(r);
  const G = clLinear(g);
  const B = clLinear(b);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  return {
    L: 0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
    a: 1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
    b: 0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
  };
}

/** OKLab → RGB（0-255・クランプなし＝ガモット外は範囲外の値のまま返す） */
function clOklabToRgbRaw(L, a, b) {
  const l = Math.pow(L + 0.3963377774 * a + 0.2158037573 * b, 3);
  const m = Math.pow(L - 0.1055613458 * a - 0.0638541728 * b, 3);
  const s = Math.pow(L - 0.0894841775 * a - 1.2914855480 * b, 3);
  return {
    r: clGamma(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
    g: clGamma(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
    b: clGamma(-0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s),
  };
}

function clOklabToOklch(L, a, b) {
  const c = Math.sqrt(a * a + b * b);
  let h = c < 1e-7 ? 0 : (Math.atan2(b, a) * 180) / Math.PI;
  if (h < 0) h += 360;
  return { l: L, c, h };
}

/** RGB（0-255）→ OKLCH（l:0-1 / c:0- / h:0-360） */
function clRgbToOklch(r, g, b) {
  const lab = clRgbToOklab(r, g, b);
  return clOklabToOklch(lab.L, lab.a, lab.b);
}

const CL_GAMUT_EPS = 1e-4;
const clInGamut = (c) =>
  c.r >= -CL_GAMUT_EPS && c.r <= 255 + CL_GAMUT_EPS &&
  c.g >= -CL_GAMUT_EPS && c.g <= 255 + CL_GAMUT_EPS &&
  c.b >= -CL_GAMUT_EPS && c.b <= 255 + CL_GAMUT_EPS;

function clOklchToRgbRaw(l, c, h) {
  const rad = (h * Math.PI) / 180;
  return clOklabToRgbRaw(l, c * Math.cos(rad), c * Math.sin(rad));
}

/**
 * OKLCH → sRGB。sRGBで表現できない色は、明度と色相を保ったまま彩度だけを二分探索で下げて収める
 * （CSS Color 4 のガモットマッピングを簡略化したもの。単純にRGBを切り詰めると色相がずれるため）。
 */
function clOklchToRgb(l, c, h) {
  const L = clClamp(l, 0, 1);
  const C = Math.max(0, c);
  const raw = clOklchToRgbRaw(L, C, h);
  if (clInGamut(raw)) {
    return { r: clClamp(raw.r, 0, 255), g: clClamp(raw.g, 0, 255), b: clClamp(raw.b, 0, 255), clipped: false };
  }
  let lo = 0;
  let hi = C;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (clInGamut(clOklchToRgbRaw(L, mid, h))) lo = mid; else hi = mid;
  }
  const fit = clOklchToRgbRaw(L, lo, h);
  return {
    r: clClamp(fit.r, 0, 255),
    g: clClamp(fit.g, 0, 255),
    b: clClamp(fit.b, 0, 255),
    clipped: true,
    chroma: lo,
  };
}

/* ---- 書き出し ---- */

const CL_DEF = { alpha: 'auto', legacy: false, upper: false, alphaPercent: false };
const clOpt = (o, key) => (o && o[key] !== undefined ? o[key] : CL_DEF[key]);

const clShowAlpha = (color, o) => {
  const mode = clOpt(o, 'alpha');
  return mode === 'always' || (mode !== 'never' && color.a < 1 - 1e-9);
};

const clAlphaStr = (a, o) =>
  (clOpt(o, 'alphaPercent') ? clFix(a * 100, 2) + '%' : clFix(a, 4));

/** HEX（#rrggbb / #rrggbbaa） */
function clHex(color, o) {
  const h = (n) => clClamp(Math.round(n), 0, 255).toString(16).padStart(2, '0');
  let s = h(color.r) + h(color.g) + h(color.b);
  if (clShowAlpha(color, o)) s += h(color.a * 255);
  return '#' + (clOpt(o, 'upper') ? s.toUpperCase() : s);
}

/** rgb() / rgba()。legacy=true でカンマ区切りの従来記法 */
function clRgbStr(color, o) {
  const v = [color.r, color.g, color.b].map((n) => clClamp(Math.round(n), 0, 255));
  const withA = clShowAlpha(color, o);
  if (clOpt(o, 'legacy')) {
    return withA
      ? `rgba(${v[0]}, ${v[1]}, ${v[2]}, ${clAlphaStr(color.a, o)})`
      : `rgb(${v[0]}, ${v[1]}, ${v[2]})`;
  }
  return withA ? `rgb(${v[0]} ${v[1]} ${v[2]} / ${clAlphaStr(color.a, o)})` : `rgb(${v[0]} ${v[1]} ${v[2]})`;
}

/** hsl() / hsla() */
function clHslStr(color, o) {
  const h = clRgbToHsl(color.r, color.g, color.b);
  const H = clFix(h.h, 2);
  const S = clFix(h.s, 2);
  const L = clFix(h.l, 2);
  const withA = clShowAlpha(color, o);
  if (clOpt(o, 'legacy')) {
    return withA
      ? `hsla(${H}, ${S}%, ${L}%, ${clAlphaStr(color.a, o)})`
      : `hsl(${H}, ${S}%, ${L}%)`;
  }
  return withA ? `hsl(${H} ${S}% ${L}% / ${clAlphaStr(color.a, o)})` : `hsl(${H} ${S}% ${L}%)`;
}

/** oklch()。CSSの慣例に合わせて明度は % で書く */
function clOklchStr(color, o) {
  const c = clRgbToOklch(color.r, color.g, color.b);
  const body = `${clFix(c.l * 100, 2)}% ${clFix(c.c, 4)} ${clFix(c.h, 2)}`;
  return clShowAlpha(color, o) ? `oklch(${body} / ${clAlphaStr(color.a, o)})` : `oklch(${body})`;
}

/* ---- 合成・コントラスト ---- */

/** 背景の上に重ねたときに実際に見える色（アルファ合成） */
function clFlatten(fg, bg) {
  const a = clClamp(fg.a === undefined ? 1 : fg.a, 0, 1);
  const ba = clClamp(bg && bg.a !== undefined ? bg.a : 1, 0, 1);
  const outA = a + ba * (1 - a);
  if (outA <= 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (f, b) => (f * a + b * ba * (1 - a)) / outA;
  return { r: mix(fg.r, bg.r), g: mix(fg.g, bg.g), b: mix(fg.b, bg.b), a: outA };
}

function clLuminance(c) {
  const f = (v) => {
    const x = clClamp(v, 0, 255) / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
}

/** WCAG 2.1 のコントラスト比（小数2桁。透過色は背景に重ねてから渡すこと） */
function clContrast(c1, c2) {
  const l1 = clLuminance(c1);
  const l2 = clLuminance(c2);
  const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  return Math.round(ratio * 100) / 100;
}

/** アルファを step% 刻みで振った表（背景に重ねた実際の色つき） */
function clAlphaRows(color, bg, step) {
  const st = clClamp(Number(step) || 10, 1, 50);
  const rows = [];
  for (let p = 100; p >= 0; p -= st) {
    const a = Math.round(p) / 100;
    const c = { r: color.r, g: color.g, b: color.b, a };
    rows.push({ percent: Math.round(p), alpha: a, color: c, flat: clFlatten(c, bg) });
  }
  if (rows.length && rows[rows.length - 1].percent !== 0) {
    const c = { r: color.r, g: color.g, b: color.b, a: 0 };
    rows.push({ percent: 0, alpha: 0, color: c, flat: clFlatten(c, bg) });
  }
  return rows;
}

/** 色相と彩度を保ったまま明度だけを振った11段のパレット（sRGB外は彩度を自動で下げる） */
function clPalette(color) {
  const base = clRgbToOklch(color.r, color.g, color.b);
  let nearest = 0;
  CL_TONES.forEach((t, i) => {
    if (Math.abs(t.l - base.l) < Math.abs(CL_TONES[nearest].l - base.l)) nearest = i;
  });
  return CL_TONES.map((t, i) => {
    const c = clOklchToRgb(t.l, base.c, base.h);
    const rgb = { r: c.r, g: c.g, b: c.b, a: 1 };
    return {
      key: t.key,
      l: t.l,
      chroma: c.clipped ? c.chroma : base.c,
      hue: base.h,
      color: rgb,
      clipped: !!c.clipped,
      base: i === nearest,
      on_white: clContrast(rgb, { r: 255, g: 255, b: 255 }),
      on_black: clContrast(rgb, { r: 0, g: 0, b: 0 }),
    };
  });
}

// 指摘事項のコードを日本語の文へ
const CL_NOTE_TEXT = {
  NAMED: (n) => `CSSの名前付き色 ${n} と同じ値です。`,
  GRAY: () => '彩度が0の無彩色です。hsl() と oklch() の色相の値に意味はありません。',
  CLIPPED: () => '指定された色はsRGBの範囲外だったため、明度と色相を保ったまま彩度を下げて収めました（RGBを切り詰めると色相までずれるためです）。',
  ALPHA: (p) => `アルファが ${p}% なので、実際の見え方は背景しだいです。flattened（背景に重ねた実際の色）を使ってください。`,
  HEX8: () => '8桁HEX（#rrggbbaa）は現行ブラウザではすべて使えます。IE 11だけが非対応なので、必要な場合は rgba() を使ってください。',
  CONTRAST: (w, b) => `白とのコントラスト比は ${w}:1、黒とは ${b}:1 です（WCAG 2.1の本文基準は4.5:1）。`,
  BG_ALPHA: () => '背景色にもアルファが指定されているため、背景の透過も含めて合成しています（結果のアルファは1未満になります）。',
};

export class ColorError extends Error {}

const clNote = (code, a, b) => ({ code, message: CL_NOTE_TEXT[code] ? CL_NOTE_TEXT[code](a, b) : code });

/**
 * 色コードを HEX / RGB / HSL / OKLCH へ相互変換し、アルファ付きの rgba() / hsla() と
 * 背景に重ねたときの実際の色（アルファ合成の結果）・コントラスト比・明度パレットを返す。
 *
 * @param {object} opts
 * @param {string} opts.color               変換する色（'#c8501f' / 'rgb(200 80 31)' / 'hsl(17 73% 45%)' / 'oklch(56% 0.16 41)' / 'tomato' など）
 * @param {number|string} [opts.alpha]      アルファ（0〜1・'50%'・0〜100 のいずれか。指定すると color 側のアルファを上書きする）
 * @param {string} [opts.background='#ffffff'] 重ねる背景色
 * @param {'modern'|'legacy'} [opts.syntax='modern'] rgb(200 80 31 / 50%) か rgba(200, 80, 31, 0.5) か
 * @param {boolean} [opts.uppercase=false]  HEXを大文字にする
 * @param {boolean} [opts.alphaPercent=false] アルファをパーセントで書く
 * @param {number} [opts.step=10]           アルファ表の刻み（%）
 * @param {boolean} [opts.alphaTable=true]  アルファ表を返すか
 * @param {boolean} [opts.palette=true]     明度パレットを返すか
 */
export function colorConvert(opts = {}) {
  const input = opts.color;
  if (input === undefined || input === null || String(input).trim() === '') {
    throw new ColorError('color（変換する色）を渡してください（例: "#c8501f" / "rgb(200 80 31)" / "oklch(56% 0.16 41)" / "tomato"）');
  }
  const parsed = clParseColor(input);
  if (!parsed) {
    throw new ColorError(`色として読めません: ${input}（HEX 3/4/6/8桁・rgb()・hsl()・hwb()・oklch()・oklab()・CSSの色名・transparent に対応）`);
  }

  if (opts.alpha !== undefined && opts.alpha !== null && String(opts.alpha).trim() !== '') {
    const raw = String(opts.alpha).trim();
    const a = clAlphaToken(raw);
    if (a === null) throw new ColorError(`alpha は 0〜1 か 0%〜100% で指定してください: ${opts.alpha}`);
    const num = Number(raw.replace('%', ''));
    // 0〜1 でも 0〜100 でも受ける（0.4 / 40 / '40%' はすべて 40%）
    parsed.a = raw.indexOf('%') === -1 && num > 1 ? clClamp(num / 100, 0, 1) : a;
  }

  const bgInput = opts.background === undefined || opts.background === null || String(opts.background).trim() === ''
    ? '#ffffff'
    : opts.background;
  const bg = clParseColor(bgInput);
  if (!bg) throw new ColorError(`background を色として読めません: ${opts.background}`);

  const step = opts.step === undefined || opts.step === null ? 10 : Number(opts.step);
  if (!Number.isFinite(step) || step < 1 || step > 50) {
    throw new ColorError(`step は 1〜50 の数値で指定してください: ${opts.step}`);
  }
  if (opts.syntax !== undefined && opts.syntax !== 'modern' && opts.syntax !== 'legacy') {
    throw new ColorError(`syntax は modern か legacy: ${opts.syntax}`);
  }

  const o = {
    legacy: opts.syntax === 'legacy',
    upper: opts.uppercase === true,
    alphaPercent: opts.alphaPercent === true,
  };
  const withA = (extra) => Object.assign({}, o, extra);
  const solid = { r: parsed.r, g: parsed.g, b: parsed.b, a: 1 };
  const lch = clRgbToOklch(parsed.r, parsed.g, parsed.b);
  const hsl = clRgbToHsl(parsed.r, parsed.g, parsed.b);
  const flat = clFlatten(parsed, bg);
  const onWhite = clContrast(solid, { r: 255, g: 255, b: 255 });
  const onBlack = clContrast(solid, { r: 0, g: 0, b: 0 });
  const hexKey = clHex(solid, { alpha: 'never' }).slice(1);

  const notes = [];
  if (CL_NAME_OF[hexKey]) notes.push(clNote('NAMED', CL_NAME_OF[hexKey]));
  if (parsed.clipped) notes.push(clNote('CLIPPED'));
  if (lch.c < 0.002) notes.push(clNote('GRAY'));
  if (parsed.a < 1 - 1e-9) {
    notes.push(clNote('ALPHA', clFix(parsed.a * 100, 1)));
    notes.push(clNote('HEX8'));
  }
  if (bg.a < 1 - 1e-9) notes.push(clNote('BG_ALPHA'));
  notes.push(clNote('CONTRAST', onWhite.toFixed(2), onBlack.toFixed(2)));

  const result = {
    input: { value: String(input), format: parsed.format, name: parsed.name },
    alpha: parsed.a,
    rgb: {
      r: clClamp(Math.round(parsed.r), 0, 255),
      g: clClamp(Math.round(parsed.g), 0, 255),
      b: clClamp(Math.round(parsed.b), 0, 255),
    },
    hsl: { h: clRound(hsl.h, 2), s: clRound(hsl.s, 2), l: clRound(hsl.l, 2) },
    oklch: { l: clRound(lch.l, 4), c: clRound(lch.c, 4), h: clRound(lch.h, 2) },
    formats: {
      hex: clHex(solid, withA({ alpha: 'never' })),
      hex8: clHex(parsed, withA({ alpha: 'always' })),
      rgb: clRgbStr(solid, withA({ alpha: 'never' })),
      rgba: clRgbStr(parsed, withA({ alpha: 'always' })),
      hsl: clHslStr(solid, withA({ alpha: 'never' })),
      hsla: clHslStr(parsed, withA({ alpha: 'always' })),
      oklch: clOklchStr(parsed, withA({ alpha: 'auto' })),
    },
    background: {
      input: String(bgInput),
      hex: clHex(bg, withA({ alpha: 'auto' })),
    },
    flattened: {
      hex: clHex(flat, withA({ alpha: 'never' })),
      rgb: clRgbStr({ r: flat.r, g: flat.g, b: flat.b, a: 1 }, withA({ alpha: 'never' })),
      alpha: clRound(flat.a, 4),
      contrast_with_background: clContrast(flat, { r: bg.r, g: bg.g, b: bg.b }),
    },
    contrast: {
      on_white: onWhite,
      on_black: onBlack,
      aa_text_color: onWhite >= 4.5 && onBlack >= 4.5 ? 'both' : onWhite >= 4.5 ? 'white' : onBlack >= 4.5 ? 'black' : 'none',
    },
    css: `:root {\n  --color: ${clHex(solid, withA({ alpha: 'never' }))};\n  --color-a: ${clRgbStr(parsed, withA({ alpha: 'always' }))};\n  --color-oklch: ${clOklchStr(solid, withA({ alpha: 'never' }))};\n}`,
    notes,
  };

  if (opts.alphaTable !== false) {
    result.alpha_table = clAlphaRows(parsed, bg, step).map((row) => ({
      percent: row.percent,
      alpha: row.alpha,
      rgba: clRgbStr(row.color, withA({ alpha: 'always' })),
      hsla: clHslStr(row.color, withA({ alpha: 'always' })),
      hex8: clHex(row.color, withA({ alpha: 'always' })),
      flattened: clHex(row.flat, withA({ alpha: 'never' })),
    }));
  }

  if (opts.palette !== false) {
    result.palette = clPalette(parsed).map((row) => ({
      key: row.key,
      hex: clHex(row.color, withA({ alpha: 'never' })),
      oklch: clOklchStr(row.color, withA({ alpha: 'never' })),
      on_white: row.on_white,
      on_black: row.on_black,
      base: row.base,
      chroma_reduced: row.clipped,
    }));
  }

  return result;
}

export {
  clParseColor, clHex, clRgbStr, clHslStr, clOklchStr, clFlatten, clContrast,
  clAlphaRows, clPalette, clRgbToHsl, clHslToRgb, clRgbToOklch, clOklchToRgb, clFix,
};
