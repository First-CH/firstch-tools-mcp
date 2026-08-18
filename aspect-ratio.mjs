// アスペクト比計算＆レスポンシブサイズ算出（tools.first-ch.com/aspect-ratio/ と同一ロジック）
//
// 「計算コア」ブロックは site 側の site/aspect-ratio/app.js と同一の実装。
// 2箇所ルール: 片方を直したらもう片方も同じ内容で直す（site側が正本）。
// 使っているのは Number/String/RegExp だけなので、ブラウザ版のコードをそのまま持ってこられる。

/* ==================== ここから計算コア（site / MCP で同一） ==================== */

const AR_MAX_DECIMALS = 6;      // 表示・丸めに使う小数の上限
const AR_MAX_SIZE = 1000000;    // 寸法として受け付ける上限 px
const AR_APPROX_DEN = 50;       // 「およそ N:M」を出すときの分母の上限
export const AR_ROUND_MODES = ['none', 'round', 'floor', 'ceil', 'even'];
export const AR_DEFAULT_WIDTHS = [320, 375, 414, 768, 1024, 1280, 1440, 1920];

// よく使う比率。key は表示側で日英に訳す
export const AR_PRESETS = [
  { key: 'HD', w: 16, h: 9 },
  { key: 'SD', w: 4, h: 3 },
  { key: 'PHOTO', w: 3, h: 2 },
  { key: 'SQUARE', w: 1, h: 1 },
  { key: 'FIVE_FOUR', w: 5, h: 4 },
  { key: 'PORTRAIT_45', w: 4, h: 5 },
  { key: 'PORTRAIT_23', w: 2, h: 3 },
  { key: 'STORY', w: 9, h: 16 },
  { key: 'ULTRA', w: 21, h: 9 },
  { key: 'ULTRA_REAL', w: 64, h: 27 },
  { key: 'VISTA', w: 37, h: 20 },       // 1.85:1
  { key: 'SCOPE', w: 239, h: 100 },     // 2.39:1
  { key: 'OGP', w: 40, h: 21 },         // 1.905:1（1200×630）
  { key: 'GOLDEN', w: 1618, h: 1000 },  // 黄金比
  { key: 'PAPER', w: 297, h: 210 },     // A判用紙（√2:1）
  { key: 'TWO_ONE', w: 2, h: 1 },
];

// 「その寸法には名前がある」と言えるもの。key は表示側で日英に訳す
export const AR_KNOWN = {
  '1920x1080': 'FHD', '1280x720': 'HD', '3840x2160': 'UHD4K', '2560x1440': 'QHD',
  '1080x1920': 'FHD_V', '720x1280': 'HD_V', '1080x1080': 'IG_SQUARE', '1080x1350': 'IG_PORTRAIT',
  '1200x630': 'OGP_IMAGE', '640x480': 'VGA', '1024x768': 'XGA', '1366x768': 'LAPTOP',
  '3440x1440': 'UW34', '2560x1080': 'UW25', '1920x1200': 'WUXGA', '4096x2160': 'DCI4K',
};

/** 文字列・数値を有限な数へ。読めなければ NaN（0 と区別するため例外にはしない） */
export function arNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const s = String(v === undefined || v === null ? '' : v).trim().replace(/,/g, '').replace(/px$/i, '').trim();
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

/** 寸法として使える正の数か */
export function arIsSize(n) {
  return Number.isFinite(n) && n > 0 && n <= AR_MAX_SIZE;
}

/**
 * 数値を表示・CSS用の文字列へ。小数6桁まで見て末尾の0を落とす。
 * 二進小数の誤差（0.1+0.2）が末尾に出ないよう、丸めてから文字列にする。
 */
export function arFormat(n) {
  if (!Number.isFinite(n)) return '';
  const s = n.toFixed(AR_MAX_DECIMALS).replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/** 整数の最大公約数（0 のときは 1 を返して割り算を壊さない） */
export function arGcd(a, b) {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) {
    const t = x % y;
    x = y;
    y = t;
  }
  return x || 1;
}

/** その数の小数桁数（表示上の桁数。1.850 → 2） */
export function arDecimals(n) {
  const s = arFormat(n);
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

/**
 * 幅・高さを約分した比にする。
 * 小数は「入力した桁数」ぶん10倍して整数にしてから約分する（1.85 : 1 → 37 : 20）。
 */
export function arSimplify(w, h) {
  const p = Math.pow(10, Math.min(AR_MAX_DECIMALS, Math.max(arDecimals(w), arDecimals(h))));
  const W = Math.round(w * p);
  const H = Math.round(h * p);
  const g = arGcd(W, H);
  return { w: W / g, h: H / g };
}

/**
 * 小数を「分母が maxDen 以下でいちばん近い分数」にする（連分数展開）。
 * 1.7778 → 16:9 のように、割り切れない比を人が読める形へ寄せるのに使う。
 */
export function arApprox(value, maxDen) {
  if (!(value > 0)) return null;
  const limit = Math.max(1, Math.trunc(maxDen) || 1);
  let n0 = 0, d0 = 1, n1 = 1, d1 = 0, x = value;
  for (let i = 0; i < 32; i += 1) {
    const a = Math.floor(x);
    const n2 = a * n1 + n0;
    const d2 = a * d1 + d0;
    if (d2 > limit) break;
    n0 = n1; d0 = d1; n1 = n2; d1 = d2;
    const frac = x - a;
    if (frac < 1e-12) break;
    x = 1 / frac;
  }
  if (!(n1 > 0) || !(d1 > 0)) return null;
  return { w: n1, h: d1, decimal: n1 / d1, error: Math.abs(n1 / d1 - value) / value * 100 };
}

/**
 * その小数と一致する定番比率（説明文に使う）。
 * 21:9 は約分すると 7:3 になるので、整数の一致ではなく小数で比べる。
 */
export function arPresetFor(decimal) {
  if (!(decimal > 0)) return null;
  return AR_PRESETS.find((p) => Math.abs(p.w / p.h - decimal) < 1e-9) || null;
}

/** いちばん近い定番比率と、そこからのずれ（%） */
export function arNearestPreset(decimal) {
  if (!(decimal > 0)) return null;
  let best = null;
  for (const p of AR_PRESETS) {
    const d = p.w / p.h;
    const error = Math.abs(d - decimal) / decimal * 100;
    if (!best || error < best.error) best = { key: p.key, w: p.w, h: p.h, decimal: d, error };
  }
  return best;
}

// 「16:9」「16/9」「16x9」「16 × 9」「1.85」「1.85:1」
const AR_NUM_SRC = '(\\d+(?:\\.\\d+)?|\\.\\d+)';
const AR_RATIO_RE = new RegExp('^' + AR_NUM_SRC + '\\s*(?::|/|x|×|by)\\s*' + AR_NUM_SRC + '$', 'i');
const AR_SINGLE_RE = new RegExp('^' + AR_NUM_SRC + '$');

/** 比率の文字列を {w, h} へ。読めなければ null */
export function arParseRatio(input) {
  const s = String(input === undefined || input === null ? '' : input).trim().replace(/,/g, '');
  if (!s) return null;
  let w, h;
  const m = AR_RATIO_RE.exec(s);
  if (m) {
    w = Number(m[1]);
    h = Number(m[2]);
  } else {
    const one = AR_SINGLE_RE.exec(s);
    if (!one) return null;
    w = Number(one[1]);
    h = 1;
  }
  if (!arIsSize(w) || !arIsSize(h)) return null;
  return { w, h };
}

/** 丸め方を適用する。none は二進小数の誤差だけ落とす */
export function arRound(v, mode) {
  if (!Number.isFinite(v)) return NaN;
  if (mode === 'round') return Math.round(v);
  if (mode === 'floor') return Math.floor(v);
  if (mode === 'ceil') return Math.ceil(v);
  if (mode === 'even') return Math.max(2, Math.round(v / 2) * 2);
  return Math.round(v * 1e6) / 1e6;
}

/**
 * 比率と、幅または高さから、もう一方を求める。
 * @param {object} opts
 * @param {number} opts.ratioW  比の左（幅）側
 * @param {number} opts.ratioH  比の右（高さ）側
 * @param {number} [opts.width]  幅 px（height と併せてどちらか一方は必須）
 * @param {number} [opts.height] 高さ px
 * @param {'none'|'round'|'floor'|'ceil'|'even'} [opts.round='none'] 整数への丸め方
 * @returns {object|null}
 */
export function arSize(opts) {
  const o = opts || {};
  const rw = arNum(o.ratioW);
  const rh = arNum(o.ratioH);
  if (!arIsSize(rw) || !arIsSize(rh)) return null;
  const decimal = rw / rh;

  let width = arNum(o.width);
  let height = arNum(o.height);
  const hasW = arIsSize(width);
  const hasH = arIsSize(height);
  if (!hasW && !hasH) return null;
  if (hasW && !hasH) height = width / decimal;
  else if (hasH && !hasW) width = height * decimal;

  const mode = AR_ROUND_MODES.indexOf(o.round) !== -1 ? o.round : 'none';
  const outW = arRound(width, mode);
  const outH = arRound(height, mode);
  const actual = outH > 0 ? outW / outH : NaN;
  const ratio = arSimplify(rw, rh);

  return {
    ratio,
    ratioInput: { w: rw, h: rh },
    decimal,
    exactWidth: width,
    exactHeight: height,
    width: outW,
    height: outH,
    // 'none' は二進小数の誤差を落とすだけなので「丸めた」とは言わない
    rounded: mode !== 'none' && (Math.abs(outW - width) > 1e-9 || Math.abs(outH - height) > 1e-9),
    exact: Math.abs(width - Math.round(width)) < 1e-9 && Math.abs(height - Math.round(height)) < 1e-9,
    actualRatio: actual,
    errorPercent: Number.isFinite(actual) ? (actual - decimal) / decimal * 100 : NaN,
    orientation: decimal > 1.0001 ? 'landscape' : decimal < 0.9999 ? 'portrait' : 'square',
    megapixels: outW * outH / 1e6,
    paddingTop: 100 / decimal,
    css: 'aspect-ratio: ' + arFormat(ratio.w) + ' / ' + arFormat(ratio.h) + ';',
  };
}

/**
 * 幅と高さから比率を求める（約分・近い分数・近い定番比率・向き・画素数）。
 * @returns {object|null}
 */
export function arRatioOf(width, height) {
  const w = arNum(width);
  const h = arNum(height);
  if (!arIsSize(w) || !arIsSize(h)) return null;
  const decimal = w / h;
  const ratio = arSimplify(w, h);
  const approx = arApprox(decimal, AR_APPROX_DEN);
  const nearest = arNearestPreset(decimal);
  // 約分した比が既に十分小さければ、近似分数はそれ自身（別掲する意味がない）
  const approxSame = !approx || (approx.w === ratio.w && approx.h === ratio.h);
  return {
    width: w,
    height: h,
    decimal,
    ratio,
    approx: approxSame ? null : approx,
    nearest,
    orientation: decimal > 1.0001 ? 'landscape' : decimal < 0.9999 ? 'portrait' : 'square',
    megapixels: w * h / 1e6,
    known: AR_KNOWN[arFormat(w) + 'x' + arFormat(h)] || null,
    paddingTop: 100 / decimal,
    css: 'aspect-ratio: ' + arFormat(ratio.w) + ' / ' + arFormat(ratio.h) + ';',
  };
}

/**
 * 元の寸法を表示枠へ contain / cover ではめ込んだ結果。
 * contain は枠に収める（余白が出る）、cover は枠を埋める（はみ出しを切る）。
 * @returns {object|null}
 */
export function arFit(opts) {
  const o = opts || {};
  const sw = arNum(o.srcW), sh = arNum(o.srcH);
  const bw = arNum(o.boxW), bh = arNum(o.boxH);
  if (![sw, sh, bw, bh].every(arIsSize)) return null;
  const mode = o.mode === 'cover' ? 'cover' : 'contain';
  const sx = bw / sw;
  const sy = bh / sh;
  const scale = mode === 'cover' ? Math.max(sx, sy) : Math.min(sx, sy);
  const w = sw * scale;
  const h = sh * scale;
  return {
    mode,
    scale,
    width: w,
    height: h,
    offsetX: (bw - w) / 2,
    offsetY: (bh - h) / 2,
    barX: Math.max(0, (bw - w) / 2),   // 左右の余白（ピラーボックス）
    barY: Math.max(0, (bh - h) / 2),   // 上下の余白（レターボックス）
    cropX: Math.max(0, (w - bw) / 2),  // 左右の切り取り
    cropY: Math.max(0, (h - bh) / 2),
    // 元画像のうち枠に残る面積の割合（cover のとき 100% 未満になる）
    visiblePercent: Math.min(100, (Math.min(w, bw) * Math.min(h, bh)) / (w * h) * 100),
    srcRatio: sw / sh,
    boxRatio: bw / bh,
  };
}

/**
 * 幅の一覧に対する高さの早見表。
 * @returns {Array<object>}
 */
export function arTable(opts) {
  const o = opts || {};
  const rw = arNum(o.ratioW);
  const rh = arNum(o.ratioH);
  if (!arIsSize(rw) || !arIsSize(rh)) return [];
  const decimal = rw / rh;
  const mode = AR_ROUND_MODES.indexOf(o.round) !== -1 ? o.round : 'round';
  const list = (Array.isArray(o.widths) && o.widths.length ? o.widths : AR_DEFAULT_WIDTHS)
    .map(arNum)
    .filter(arIsSize);
  return list.map((w) => {
    const exactHeight = w / decimal;
    const height = arRound(exactHeight, mode);
    return {
      width: w,
      exactHeight,
      height,
      exact: Math.abs(exactHeight - Math.round(exactHeight)) < 1e-9,
      paddingTop: 100 / decimal,
    };
  });
}

/**
 * CSS（と貼り付け用HTML）のスニペットを組み立てる。
 * @param {object} opts ratioW / ratioH / selector / target / fit / fallback / width
 */
export function arSnippet(opts) {
  const o = opts || {};
  const rw = arNum(o.ratioW);
  const rh = arNum(o.ratioH);
  if (!arIsSize(rw) || !arIsSize(rh)) return null;
  const ratio = arSimplify(rw, rh);
  const decimal = ratio.w / ratio.h;
  const sel = String(o.selector || '.media').trim() || '.media';
  const target = ['img', 'video', 'iframe', 'background'].indexOf(o.target) !== -1 ? o.target : 'img';
  const fit = ['cover', 'contain', 'fill', 'none'].indexOf(o.fit) !== -1 ? o.fit : 'cover';
  const ar = arFormat(ratio.w) + ' / ' + arFormat(ratio.h);
  const pad = arFormat(Math.round(100 / decimal * 1e4) / 1e4);
  const width = arIsSize(arNum(o.width)) ? arNum(o.width) : 1280;
  const height = arRound(width / decimal, 'round');

  const css = [];
  css.push(sel + ' {');
  css.push('  aspect-ratio: ' + ar + ';');
  css.push('  width: 100%;');
  if (target === 'background') {
    css.push('  background-image: url("/path/to/image.jpg");');
    css.push('  background-size: ' + (fit === 'contain' ? 'contain' : 'cover') + ';');
    css.push('  background-position: center;');
    css.push('  background-repeat: no-repeat;');
  } else {
    css.push('  overflow: hidden;');
  }
  css.push('}');
  if (target !== 'background') {
    css.push('');
    css.push(sel + ' > ' + target + ' {');
    css.push('  display: block;');
    css.push('  width: 100%;');
    css.push('  height: 100%;');
    if (target === 'iframe') css.push('  border: 0;');
    else css.push('  object-fit: ' + fit + ';');
    css.push('}');
  }
  if (o.fallback) {
    css.push('');
    css.push('/* aspect-ratio に対応しない古いブラウザ向け（padding-top の比率ハック） */');
    css.push('@supports not (aspect-ratio: 1 / 1) {');
    css.push('  ' + sel + ' {');
    css.push('    height: 0;');
    css.push('    padding-top: ' + pad + '%;');
    css.push('    position: relative;');
    css.push('  }');
    if (target !== 'background') {
      css.push('  ' + sel + ' > ' + target + ' {');
      css.push('    position: absolute;');
      css.push('    inset: 0;');
      css.push('  }');
    }
    css.push('}');
  }

  let html;
  if (target === 'background') {
    html = '<div class="' + sel.replace(/^\./, '') + '"></div>';
  } else if (target === 'iframe') {
    html = '<div class="' + sel.replace(/^\./, '') + '">\n'
      + '  <iframe src="https://www.youtube.com/embed/VIDEO_ID"\n'
      + '    width="' + arFormat(width) + '" height="' + arFormat(height) + '"\n'
      + '    title="" loading="lazy" allowfullscreen></iframe>\n'
      + '</div>';
  } else {
    html = '<div class="' + sel.replace(/^\./, '') + '">\n'
      + '  <' + target + ' src="/path/to/file" width="' + arFormat(width) + '" height="' + arFormat(height) + '"'
      + (target === 'img' ? ' alt=""' : ' controls') + '>' + (target === 'img' ? '' : '</' + target + '>') + '\n'
      + '</div>';
  }

  return {
    ratio,
    decimal,
    css: css.join('\n'),
    html,
    paddingTop: Number(pad),
    width,
    height,
  };
}

/* ==================== ここまで計算コア ==================== */

// 定番比率の説明（MCPの戻り値は日本語で返す。site側の T.presets と同じ内容）
const AR_PRESET_TEXT = {
  HD: '16:9（HD・FHD・4K・YouTube・動画全般）',
  SD: '4:3（旧テレビ・iPad・スライド）',
  PHOTO: '3:2（一眼レフ・L判プリント）',
  SQUARE: '1:1（正方形の投稿・アイコン）',
  FIVE_FOUR: '5:4（中判・古いモニタ）',
  PORTRAIT_45: '4:5（Instagram縦）',
  PORTRAIT_23: '2:3（縦位置の写真プリント）',
  STORY: '9:16（ストーリー・Reels・TikTok・スマホ全画面）',
  ULTRA: '21:9（いわゆるウルトラワイド・通称）',
  ULTRA_REAL: '64:27（2560×1080 のウルトラワイドの実際の比）',
  VISTA: '1.85:1（映画のビスタサイズ）',
  SCOPE: '2.39:1（シネマスコープ）',
  OGP: '1.91:1（OGP・SNSシェア画像・1200×630）',
  GOLDEN: '1.618:1（黄金比）',
  PAPER: '√2:1（A判用紙・A4は297×210）',
  TWO_ONE: '2:1（ユニビジウム）',
};

const AR_KNOWN_TEXT = {
  FHD: 'FHD（1080p）', HD: 'HD（720p）', UHD4K: '4K UHD', QHD: 'QHD（1440p）',
  FHD_V: '1080p の縦向き', HD_V: '720p の縦向き', IG_SQUARE: 'Instagramの正方形',
  IG_PORTRAIT: 'Instagramの縦長', OGP_IMAGE: 'OGP・SNSシェア画像',
  VGA: 'VGA', XGA: 'XGA', LAPTOP: 'ノートPCでよくある画面', UW34: '34インチのウルトラワイド',
  UW25: '25/29インチのウルトラワイド', WUXGA: 'WUXGA', DCI4K: 'DCI 4K',
};

const AR_NOTE_TEXT = {
  EXACT: (s) => `${s} は割り切れます（丸めは起きていません）。`,
  NOT_INTEGER: (a) => `${a.from} のとき ${a.to} は整数になりません。ブラウザは小数のまま扱えますが、画像や動画として書き出すときは整数にする必要があります（いちばん近いのは ${a.nearest}）。`,
  ROUNDED: (a) => `${a.size} に丸めた場合の実際の比率は ${a.ratio} で、指定した比率から ${a.error}% ずれます。`,
  ODD_DIMENSION: (s) => `${s} は奇数を含みます。H.264 / H.265 は色情報を縦横半分の解像度で持つ（YUV 4:2:0）ため、奇数の幅・高さはエンコーダに拒否されるか黙って引き伸ばされます。round="even" を指定してください。`,
  KNOWN_SIZE: (a) => `${a.size} は ${a.name}です。`,
  PRESET: (s) => s,
  ULTRAWIDE: () => '「21:9」のモニタは実際には21:9ではありません。2560×1080 は 64:27（2.370）、3440×1440 は 43:18（2.389）です。CSSに 21:9 と書くと端に1px前後の隙間が出ます。',
  NEAREST: (a) => `いちばん近い定番比率: ${a.label}（${a.error}% のずれ）。`,
  NEAREST_EXACT: (s) => `ちょうど ${s}です。`,
  APPROX: (a) => `これは ${a.ratio} と ${a.error}% しか違いません。CSSに書くならこちらの方が読みやすくなります。`,
  BIG_RATIO: (s) => `約分しても ${s} にしかなりません。共通の約数がほとんどない寸法は、比率から決めたものではなく切り抜きの結果であることが多いです。`,
};

export class AspectRatioError extends Error {}

const arNote = (code, arg) => ({ code, message: AR_NOTE_TEXT[code] ? AR_NOTE_TEXT[code](arg) : code });

/** 表示用に小数2桁へ寄せる（誤差やパーセントの見た目を揃える） */
const arPct = (n) => arFormat(Math.round(n * 100) / 100);
/** 表示用に小数4桁へ寄せる（比率の小数） */
const arDec = (n) => arFormat(Math.round(n * 1e4) / 1e4);

const arRatioText = (r) => arFormat(r.w) + ':' + arFormat(r.h);

/** 早見表の行を戻り値の形へ */
function arTableRows(rows) {
  return rows.map((r) => ({
    width: r.width,
    height: r.height,
    exact_height: Math.round(r.exactHeight * 1e6) / 1e6,
    exact: r.exact,
    padding_top: arFormat(Math.round(r.paddingTop * 1e4) / 1e4) + '%',
    css: `width: ${arFormat(r.width)}px; height: ${arFormat(r.height)}px;`,
  }));
}

/** はめ込み結果を戻り値の形へ */
function arFitResult(f) {
  const round2 = (n) => Math.round(n * 100) / 100;
  const out = {
    mode: f.mode,
    scale: Math.round(f.scale * 1e6) / 1e6,
    width: round2(f.width),
    height: round2(f.height),
    offset_x: round2(f.offsetX),
    offset_y: round2(f.offsetY),
  };
  if (f.mode === 'contain') {
    out.bar_x = round2(f.barX);
    out.bar_y = round2(f.barY);
  } else {
    out.crop_x = round2(f.cropX);
    out.crop_y = round2(f.cropY);
    out.visible_percent = round2(f.visiblePercent);
  }
  out.same_ratio = Math.abs(f.srcRatio - f.boxRatio) < 1e-6;
  return out;
}

/**
 * アスペクト比の計算。
 *
 * ratio と width / height の片方を渡すと、もう一方の寸法を求める（mode: 'size'）。
 * width と height を渡して ratio を渡さないと、その寸法の比率を求める（mode: 'measure'）。
 * ratio だけを渡すと、その比率そのものの情報を返す（mode: 'ratio'）。
 * box を渡すと、元の寸法をその枠へ contain / cover ではめ込んだ結果も返す。
 *
 * @param {object} opts
 * @param {string|number} [opts.ratio]   比率（'16:9' / '16/9' / '1.85' / 1.85）
 * @param {number} [opts.width]          幅 px
 * @param {number} [opts.height]         高さ px
 * @param {'none'|'round'|'floor'|'ceil'|'even'} [opts.round='none'] 丸め方
 * @param {number[]} [opts.widths]       早見表に並べる幅の一覧
 * @param {boolean} [opts.table]         早見表を返すか（widths を渡すと自動で true）
 * @param {string|object} [opts.box]     はめ込む枠（'1280x400' か {width,height}）
 * @param {'cover'|'contain'} [opts.fit='cover'] はめ方
 * @param {boolean} [opts.snippet]       CSS / HTML のスニペットを返すか
 * @param {string} [opts.selector='.media'] スニペットのセレクタ
 * @param {'img'|'video'|'iframe'|'background'} [opts.target='img'] スニペットの中身
 * @param {'cover'|'contain'|'fill'|'none'} [opts.objectFit='cover'] object-fit
 * @param {boolean} [opts.fallback]      padding-top のフォールバックを付けるか
 */
export function aspectRatioCalc(opts = {}) {
  const hasRatio = opts.ratio !== undefined && opts.ratio !== null && String(opts.ratio).trim() !== '';
  const width = arNum(opts.width);
  const height = arNum(opts.height);
  const hasW = opts.width !== undefined && opts.width !== null && String(opts.width).trim() !== '';
  const hasH = opts.height !== undefined && opts.height !== null && String(opts.height).trim() !== '';

  if (hasW && !arIsSize(width)) throw new AspectRatioError(`width は 0 より大きい ${AR_MAX_SIZE} 以下の数値で指定してください: ${opts.width}`);
  if (hasH && !arIsSize(height)) throw new AspectRatioError(`height は 0 より大きい ${AR_MAX_SIZE} 以下の数値で指定してください: ${opts.height}`);
  if (!hasRatio && !hasW && !hasH) {
    throw new AspectRatioError('ratio（比率）か width / height（寸法）のどちらかを渡してください');
  }
  if (!hasRatio && !(hasW && hasH)) {
    throw new AspectRatioError('ratio を省略する場合は width と height の両方を渡してください（その2つから比率を求めます）');
  }

  let ratio = null;
  if (hasRatio) {
    ratio = arParseRatio(opts.ratio);
    if (!ratio) throw new AspectRatioError(`ratio を読めません（'16:9' / '16/9' / '1.85' のように指定してください）: ${opts.ratio}`);
  }

  const round = opts.round === undefined || opts.round === null ? 'none' : String(opts.round);
  if (AR_ROUND_MODES.indexOf(round) === -1) {
    throw new AspectRatioError(`round は ${AR_ROUND_MODES.join(' / ')} のいずれか: ${opts.round}`);
  }
  const fitMode = opts.fit === undefined || opts.fit === null ? 'cover' : String(opts.fit);
  if (['cover', 'contain'].indexOf(fitMode) === -1) {
    throw new AspectRatioError(`fit は cover / contain のいずれか: ${opts.fit}`);
  }

  let box = null;
  if (opts.box !== undefined && opts.box !== null && opts.box !== '') {
    box = typeof opts.box === 'object'
      ? (arIsSize(arNum(opts.box.width)) && arIsSize(arNum(opts.box.height))
        ? { w: arNum(opts.box.width), h: arNum(opts.box.height) } : null)
      : arParseRatio(opts.box);
    if (!box) throw new AspectRatioError(`box を読めません（'1280x400' か {width,height} で指定してください）: ${JSON.stringify(opts.box)}`);
  }

  const wantTable = opts.table === true || (Array.isArray(opts.widths) && opts.widths.length > 0);
  const wantSnippet = opts.snippet === true;
  const notes = [];
  const result = {};

  if (hasRatio && (hasW || hasH)) {
    /* ---- 比率＋片側の寸法 → もう一方 ---- */
    const r = arSize({
      ratioW: ratio.w,
      ratioH: ratio.h,
      width: hasW ? width : undefined,
      height: hasH ? height : undefined,
      round,
    });
    if (!r) throw new AspectRatioError('寸法を計算できませんでした');
    const sizeText = `${arFormat(r.width)} × ${arFormat(r.height)}`;
    Object.assign(result, {
      mode: 'size',
      ratio: { w: r.ratio.w, h: r.ratio.h, text: arRatioText(r.ratio), decimal: arDec(r.decimal) },
      width: r.width,
      height: r.height,
      exact_width: Math.round(r.exactWidth * 1e6) / 1e6,
      exact_height: Math.round(r.exactHeight * 1e6) / 1e6,
      rounding: round,
      rounded: r.rounded,
      actual_ratio: arDec(r.actualRatio),
      error_percent: Math.round(r.errorPercent * 1e4) / 1e4,
      orientation: r.orientation,
      megapixels: Math.round(r.megapixels * 1000) / 1000,
      padding_top: arFormat(Math.round(r.paddingTop * 1e4) / 1e4) + '%',
      css: r.css,
      formatted: { size: sizeText },
    });

    const known = AR_KNOWN[arFormat(r.width) + 'x' + arFormat(r.height)];
    if (known) notes.push(arNote('KNOWN_SIZE', { size: sizeText, name: AR_KNOWN_TEXT[known] }));
    if (r.exact) {
      notes.push(arNote('EXACT', `${arFormat(r.exactWidth)} × ${arFormat(r.exactHeight)}`));
    } else {
      const from = hasW ? `幅 ${arFormat(r.exactWidth)}` : `高さ ${arFormat(r.exactHeight)}`;
      const to = hasW ? `高さ ${arFormat(r.exactHeight)}` : `幅 ${arFormat(r.exactWidth)}`;
      const other = hasW ? r.exactHeight : r.exactWidth;
      notes.push(arNote('NOT_INTEGER', { from, to, nearest: arFormat(Math.round(other)) }));
    }
    if (r.rounded && Math.abs(r.errorPercent) > 1e-9) {
      notes.push(arNote('ROUNDED', { size: sizeText, ratio: arDec(r.actualRatio), error: arPct(Math.abs(r.errorPercent)) }));
    }
    if (Number.isInteger(r.width) && Number.isInteger(r.height) && (r.width % 2 !== 0 || r.height % 2 !== 0)) {
      notes.push(arNote('ODD_DIMENSION', sizeText));
    }
    const preset = arPresetFor(r.decimal);
    if (preset && preset.key === 'ULTRA') notes.push(arNote('ULTRAWIDE'));
    else if (preset) notes.push(arNote('PRESET', AR_PRESET_TEXT[preset.key]));
  } else if (hasRatio) {
    /* ---- 比率だけ ---- */
    const simple = arSimplify(ratio.w, ratio.h);
    const decimal = ratio.w / ratio.h;
    const nearest = arNearestPreset(decimal);
    Object.assign(result, {
      mode: 'ratio',
      ratio: { w: simple.w, h: simple.h, text: arRatioText(simple), decimal: arDec(decimal) },
      orientation: decimal > 1.0001 ? 'landscape' : decimal < 0.9999 ? 'portrait' : 'square',
      padding_top: arFormat(Math.round(100 / decimal * 1e4) / 1e4) + '%',
      css: 'aspect-ratio: ' + arFormat(simple.w) + ' / ' + arFormat(simple.h) + ';',
    });
    const preset = arPresetFor(decimal);
    if (preset && preset.key === 'ULTRA') notes.push(arNote('ULTRAWIDE'));
    else if (preset) notes.push(arNote('PRESET', AR_PRESET_TEXT[preset.key]));
    else if (nearest && nearest.error >= 0.05) {
      notes.push(arNote('NEAREST', { label: AR_PRESET_TEXT[nearest.key], error: arPct(nearest.error) }));
    }
  } else {
    /* ---- 寸法だけ → 比率を求める ---- */
    const r = arRatioOf(width, height);
    if (!r) throw new AspectRatioError('比率を計算できませんでした');
    const sizeText = `${arFormat(r.width)} × ${arFormat(r.height)}`;
    ratio = { w: r.ratio.w, h: r.ratio.h };
    Object.assign(result, {
      mode: 'measure',
      width: r.width,
      height: r.height,
      ratio: { w: r.ratio.w, h: r.ratio.h, text: arRatioText(r.ratio), decimal: arDec(r.decimal) },
      orientation: r.orientation,
      megapixels: Math.round(r.megapixels * 1000) / 1000,
      padding_top: arFormat(Math.round(r.paddingTop * 1e4) / 1e4) + '%',
      css: r.css,
      formatted: { size: sizeText },
    });
    if (r.approx) {
      result.approx = { w: r.approx.w, h: r.approx.h, text: arRatioText(r.approx), error_percent: Math.round(r.approx.error * 1e4) / 1e4 };
    }
    if (r.nearest) {
      result.nearest = {
        w: r.nearest.w, h: r.nearest.h, text: arRatioText(r.nearest),
        label: AR_PRESET_TEXT[r.nearest.key], error_percent: Math.round(r.nearest.error * 1e4) / 1e4,
      };
    }
    if (r.known) {
      result.known = AR_KNOWN_TEXT[r.known];
      notes.push(arNote('KNOWN_SIZE', { size: sizeText, name: AR_KNOWN_TEXT[r.known] }));
    }
    if (r.nearest) {
      if (r.nearest.error < 0.05) notes.push(arNote('NEAREST_EXACT', AR_PRESET_TEXT[r.nearest.key]));
      else notes.push(arNote('NEAREST', { label: AR_PRESET_TEXT[r.nearest.key], error: arPct(r.nearest.error) }));
    }
    if (r.approx) {
      notes.push(arNote('APPROX', { ratio: arRatioText(r.approx), error: arPct(r.approx.error) }));
    }
    if (r.ratio.w > 100 || r.ratio.h > 100) notes.push(arNote('BIG_RATIO', arRatioText(r.ratio)));
    const preset = arPresetFor(r.decimal);
    if (preset && preset.key === 'ULTRA') notes.push(arNote('ULTRAWIDE'));
  }

  /* ---- 枠へのはめ込み ---- */
  if (box) {
    const srcW = result.width !== undefined ? result.width : ratio.w;
    const srcH = result.height !== undefined ? result.height : ratio.h;
    const f = arFit({ srcW, srcH, boxW: box.w, boxH: box.h, mode: fitMode });
    if (f) {
      result.fit = Object.assign({ box: { width: box.w, height: box.h } }, arFitResult(f));
    }
  }

  /* ---- 早見表 ---- */
  if (wantTable) {
    const rows = arTable({
      ratioW: ratio.w,
      ratioH: ratio.h,
      widths: opts.widths,
      round: round === 'none' ? 'round' : round,
    });
    result.table = arTableRows(rows);
  }

  /* ---- スニペット ---- */
  if (wantSnippet) {
    const s = arSnippet({
      ratioW: ratio.w,
      ratioH: ratio.h,
      selector: opts.selector,
      target: opts.target,
      fit: opts.objectFit,
      fallback: opts.fallback,
      width: result.width,
    });
    if (s) result.snippet = { css: s.css, html: s.html };
  }

  result.notes = notes;
  return result;
}
