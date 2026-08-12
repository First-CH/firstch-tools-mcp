// px ⇄ rem / em 単位変換＆フォントスケール表（tools.first-ch.com/px-rem/ と同一ロジック）
//
// 「変換コア」ブロックは site 側の site/px-rem/app.js と同一の実装。
// 2箇所ルール: 片方を直したらもう片方も同じ内容で直す（site側が正本）。
// 使っているのは Number/String/RegExp だけなので、ブラウザ版のコードをそのまま持ってこられる。
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

/* ==================== ここから変換コア（site / MCP で同一） ==================== */

export const PR_DEFAULT_ROOT = 16;   // ブラウザ既定のルートフォントサイズ
const PR_MAX_DECIMALS = 6;    // 表示・丸めに使う小数の上限（rem は 1/16 刻みなので4桁あれば割り切れる）
const PR_MAX_SIZE = 1000;     // 基準サイズとして受け付ける上限 px

// スケール表に並べる標準サイズ（12〜64px）。用途ラベルは表示側で日英に訳す
export const PR_SCALE_SIZES = [12, 13, 14, 15, 16, 18, 20, 24, 28, 32, 36, 40, 48, 56, 64];
const PR_SCALE_ROLE = {
  12: 'CAPTION', 13: 'FINE', 14: 'SMALL', 15: 'BODY_SM', 16: 'BODY', 18: 'BODY_LG',
  20: 'H4', 24: 'H3', 28: 'H2_SP', 32: 'H2', 36: 'H1_SP', 40: 'H1',
  48: 'TITLE', 56: 'HERO', 64: 'HERO_LG',
};

// CSS一括変換の向き。base は換算の基準（root=ルート / parent=親要素）
export const PR_CSS_DIRECTIONS = {
  px2rem: { from: 'px', to: 'rem', base: 'root' },
  px2em: { from: 'px', to: 'em', base: 'parent' },
  rem2px: { from: 'rem', to: 'px', base: 'root' },
  em2px: { from: 'em', to: 'px', base: 'parent' },
};

const PR_PT_PER_PX = 72 / 96;  // CSSの1ptは1/72インチ・1pxは1/96インチ

/** 基準サイズとして使える正の数へ寄せる（不正なら fallback） */
export function prSize(v, fallback) {
  const n = typeof v === 'string' ? Number(String(v).trim()) : Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > PR_MAX_SIZE) return fallback;
  return n;
}

/**
 * 指定桁で四捨五入する。
 * 8.325 * 100 が 832.4999… になるような二進浮動小数の誤差で1桁ずれないよう、
 * 絶対値に比例した微小量を足してから丸める（負数は0から遠い側へ寄せる）。
 */
export function prRound(n, decimals) {
  if (!Number.isFinite(n)) return n;
  const d = Math.max(0, Math.min(PR_MAX_DECIMALS, Math.trunc(decimals)));
  const p = Math.pow(10, d);
  const scaled = n * p;
  const eps = Math.abs(scaled) * Number.EPSILON * 4;
  const r = scaled < 0 ? -Math.round(-scaled + eps) : Math.round(scaled + eps);
  return r / p;
}

/**
 * 数値をCSSに書ける文字列へ。
 * precision が 'auto'（既定）なら末尾の0を落とす（0.750000 → 0.75）。
 * 数値なら桁を固定する（0.75 を桁数3で 0.750）。
 */
export function prFormat(n, precision) {
  if (!Number.isFinite(n)) return '';
  if (precision === undefined || precision === null || precision === 'auto' || precision === '') {
    let s = prRound(n, PR_MAX_DECIMALS).toFixed(PR_MAX_DECIMALS);
    s = s.replace(/0+$/, '').replace(/\.$/, '');
    return s === '-0' ? '0' : s;
  }
  const d = Math.max(0, Math.min(PR_MAX_DECIMALS, Math.trunc(Number(precision) || 0)));
  const s = prRound(n, d).toFixed(d);
  return /^-0(\.0*)?$/.test(s) ? s.slice(1) : s;
}

// 「24」「24px」「1.5 rem」「62.5%」のような1つの長さ
const PR_LENGTH_RE = /^([+-]?(?:\d+(?:\.\d+)?|\.\d+))\s*(px|rem|em|pt|%)?$/i;

/**
 * 長さの文字列を {value, unit} へ。単位が無ければ fallbackUnit（既定 px）とみなす。
 * 読めなければ null（0 と区別するため例外にはしない）。
 */
export function prParseLength(input, fallbackUnit) {
  const s = String(input === undefined || input === null ? '' : input).trim();
  if (!s) return null;
  const m = PR_LENGTH_RE.exec(s);
  if (!m) return null;
  const value = Number(m[1]);
  if (!Number.isFinite(value)) return null;
  return { value, unit: (m[2] || fallbackUnit || 'px').toLowerCase() };
}

/**
 * 基準サイズの指定（16 / '16px' / '62.5%' / '12pt'）を px の数値へ。
 * % と rem / em は「ブラウザ既定の16pxに対する割合」として読む（html { font-size: 62.5% } → 10px）。
 */
export function prResolveBase(input, fallback) {
  const fb = prSize(fallback, PR_DEFAULT_ROOT);
  if (input === undefined || input === null || input === '') return fb;
  const parsed = typeof input === 'number'
    ? { value: input, unit: 'px' }
    : prParseLength(input, 'px');
  if (!parsed) return fb;
  const px = parsed.unit === '%' ? (parsed.value / 100) * PR_DEFAULT_ROOT
    : parsed.unit === 'pt' ? parsed.value / PR_PT_PER_PX
      : parsed.unit === 'px' ? parsed.value
        : parsed.value * PR_DEFAULT_ROOT;
  return prSize(px, fb);
}

/**
 * 1つの長さを px / rem / em / pt へ相互換算する。
 * @param {object} opts
 * @param {number|string} opts.value 入力値
 * @param {'px'|'rem'|'em'|'pt'|'%'} [opts.unit='px'] 入力の単位
 * @param {number} [opts.root=16]  ルート（html要素）のフォントサイズ px
 * @param {number} [opts.parent]   親要素のフォントサイズ px（em の基準。既定は root と同じ）
 * @returns {object|null} 換算結果（読めない入力なら null）
 */
export function prConvert(opts) {
  const o = opts || {};
  const root = prSize(o.root, PR_DEFAULT_ROOT);
  const parent = prSize(o.parent, root);
  const unit = String(o.unit || 'px').toLowerCase();
  const value = typeof o.value === 'string' ? Number(String(o.value).trim()) : Number(o.value);
  if (!Number.isFinite(value)) return null;

  let px;
  if (unit === 'px') px = value;
  else if (unit === 'rem') px = value * root;
  else if (unit === 'em') px = value * parent;
  else if (unit === 'pt') px = value / PR_PT_PER_PX;
  else if (unit === '%') px = (value / 100) * parent;
  else return null;

  return {
    input: { value, unit },
    root,
    parent,
    px,
    rem: px / root,
    em: px / parent,
    pt: px * PR_PT_PER_PX,
    percent: (px / parent) * 100,
  };
}

/**
 * よく使うフォントサイズのスケール表を作る。
 * @param {object} [opts] root / parent / sizes
 */
export function prScale(opts) {
  const o = opts || {};
  const root = prSize(o.root, PR_DEFAULT_ROOT);
  const parent = prSize(o.parent, root);
  const sizes = Array.isArray(o.sizes) && o.sizes.length ? o.sizes : PR_SCALE_SIZES;
  return sizes
    .map((px) => Number(px))
    .filter((px) => Number.isFinite(px) && px > 0)
    .map((px) => ({
      px,
      rem: px / root,
      em: px / parent,
      pt: px * PR_PT_PER_PX,
      role: PR_SCALE_ROLE[px] || 'OTHER',
    }));
}

// 数値＋単位。sticky（y）で位置を指定して照合する
const PR_NUM_RE = /(-?(?:\d+(?:\.\d+)?|\.\d+))(px|rem|em)(?![a-zA-Z0-9_])/iy;
// 直前がこれらの文字なら識別子の途中（--size-16px など）なので触らない
const PR_IDENT_BEFORE = /[A-Za-z0-9_.#%-]/;

/**
 * CSS（や値の羅列）の中の長さの単位をまとめて変換する。
 * コメント・文字列・url() の中身は触らない。プロパティ名を追いかけているので
 * 除外プロパティの指定と、@media などアットルールの前置きのスキップができる。
 *
 * @param {string} css 変換するCSS
 * @param {object} [opts]
 * @param {'px2rem'|'px2em'|'rem2px'|'em2px'} [opts.direction='px2rem']
 * @param {number} [opts.root=16]        ルートのフォントサイズ px
 * @param {number} [opts.parent]         親要素のフォントサイズ px（em の基準）
 * @param {number|'auto'} [opts.precision='auto'] 小数の桁
 * @param {number} [opts.minPx=0]        換算後の絶対値がこれ未満のpxは変換しない（1pxの罫線を残す用）
 * @param {boolean} [opts.zeroUnitless=true] 0 を単位なしの 0 にする
 * @param {boolean} [opts.skipMedia=true]    @media などアットルールの前置きは変換しない
 * @param {string[]} [opts.ignoreProps=[]]   変換しないプロパティ（前方一致）
 */
export function prConvertCss(css, opts) {
  const o = opts || {};
  const dir = PR_CSS_DIRECTIONS[o.direction] || PR_CSS_DIRECTIONS.px2rem;
  const root = prSize(o.root, PR_DEFAULT_ROOT);
  const parent = prSize(o.parent, root);
  const base = dir.base === 'parent' ? parent : root;
  const precision = o.precision === undefined ? 'auto' : o.precision;
  const minPx = Number.isFinite(Number(o.minPx)) ? Math.abs(Number(o.minPx)) : 0;
  const zeroUnitless = o.zeroUnitless !== false;
  const skipMedia = o.skipMedia !== false;
  const ignore = (Array.isArray(o.ignoreProps) ? o.ignoreProps : [])
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);

  const src = String(css === undefined || css === null ? '' : css);
  const len = src.length;
  const stats = { found: 0, converted: 0, zeroed: 0, skipped_small: 0, skipped_media: 0, skipped_prop: 0 };

  let out = '';
  let i = 0;
  let pending = '';   // 直前の区切りからここまで（プロパティ名の取り出しに使う）
  let prop = '';      // 現在の宣言のプロパティ名
  let atRule = '';    // アットルールの前置きにいるならその名前
  let depth = 0;      // 丸括弧の深さ

  while (i < len) {
    const ch = src.charAt(i);

    // コメント（中の { } ; は状態に反映しない＝コメントアウトされた指定に引きずられない）
    if (ch === '/' && src.charAt(i + 1) === '*') {
      const end = src.indexOf('*/', i + 2);
      const stop = end === -1 ? len : end + 2;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }
    // 文字列（content: "10px" などを書き換えない）
    if (ch === '"' || ch === "'") {
      let j = i + 1;
      while (j < len) {
        const c = src.charAt(j);
        if (c === '\\') { j += 2; continue; }
        j += 1;
        if (c === ch || c === '\n') break;
      }
      out += src.slice(i, j);
      i = j;
      continue;
    }
    // url(...) は data URI に "…px" のような並びが出うるので中身ごと素通し
    if ((ch === 'u' || ch === 'U') && /^url\(/i.test(src.substr(i, 4))) {
      const end = src.indexOf(')', i);
      const stop = end === -1 ? len : end + 1;
      out += src.slice(i, stop);
      i = stop;
      continue;
    }

    // 区切り記号で宣言の状態を更新する
    if (ch === '(') { depth += 1; out += ch; pending += ch; i += 1; continue; }
    if (ch === ')') { depth = Math.max(0, depth - 1); out += ch; pending += ch; i += 1; continue; }
    if (ch === '{' || ch === '}' || ch === ';') {
      prop = ''; pending = ''; atRule = ''; depth = 0;
      out += ch; i += 1;
      continue;
    }
    if (ch === '@' && !pending.trim()) {
      const m = /^@[-a-zA-Z]+/.exec(src.substr(i, 32));
      atRule = m ? m[0].slice(1).toLowerCase() : 'at';
      out += ch; pending += ch; i += 1;
      continue;
    }
    if (ch === ':' && depth === 0 && !atRule) {
      const name = pending.trim().toLowerCase();
      prop = /^[-a-zA-Z_][-a-zA-Z0-9_]*$/.test(name) ? name : '';
      pending = '';
      out += ch; i += 1;
      continue;
    }

    // 数値＋単位
    PR_NUM_RE.lastIndex = i;
    const m = PR_NUM_RE.exec(src);
    if (m) {
      const prev = i > 0 ? src.charAt(i - 1) : '';
      if (prev && PR_IDENT_BEFORE.test(prev)) {
        out += ch; pending += ch; i += 1;
        continue;
      }
      const whole = m[0];
      const num = Number(m[1]);
      const unit = m[2].toLowerCase();
      let replaced = null;
      if (unit === dir.from && Number.isFinite(num)) {
        stats.found += 1;
        const px = dir.from === 'px' ? num : num * base;
        const propIgnored = ignore.some((p) => prop === p || prop.indexOf(p) === 0);
        if (skipMedia && atRule) {
          stats.skipped_media += 1;
        } else if (propIgnored) {
          stats.skipped_prop += 1;
        } else if (num === 0) {
          replaced = zeroUnitless ? '0' : '0' + dir.to;
          if (zeroUnitless) stats.zeroed += 1; else stats.converted += 1;
        } else if (Math.abs(px) < minPx) {
          stats.skipped_small += 1;
        } else {
          replaced = prFormat(dir.to === 'px' ? px : px / base, precision) + dir.to;
          stats.converted += 1;
        }
      }
      out += replaced === null ? whole : replaced;
      pending += whole;
      i += whole.length;
      continue;
    }

    out += ch;
    pending += ch;
    // プロパティ名を拾うのに長い文字列は要らない（巨大な入力でも増え続けないようにする）
    if (pending.length > 240) pending = pending.slice(-120);
    i += 1;
  }

  return {
    text: out,
    direction: o.direction && PR_CSS_DIRECTIONS[o.direction] ? o.direction : 'px2rem',
    root,
    parent,
    base,
    stats,
  };
}

/* ==================== ここまで変換コア ==================== */

// スケール表の用途ラベル。site側は同じコードを日英それぞれの文へ訳している
const PR_ROLE_TEXT = {
  CAPTION: '注釈・キャプション', FINE: '細目・注意書き', SMALL: '小さめの本文・UIラベル',
  BODY_SM: '本文（やや小）', BODY: '本文（ブラウザ既定）', BODY_LG: 'リード文・大きめの本文',
  H4: '小見出し（h4）', H3: '中見出し（h3）', H2_SP: '見出し（h2・モバイル）', H2: '見出し（h2）',
  H1_SP: '大見出し（h1・モバイル）', H1: '大見出し（h1）', TITLE: 'ページタイトル',
  HERO: 'ヒーロー見出し', HERO_LG: 'ヒーロー見出し（大）', OTHER: '—',
};

// 指摘事項のコードを日本語の文へ
const PR_NOTE_TEXT = {
  ROOT_NOT_16: (n) => `基準（ルート）を ${n}px として計算しました。ブラウザの既定は16pxなので、閲覧者が文字サイズを変えている場合は見え方が変わります。`,
  ROOT_625: () => 'ルート10px（62.5%テクニック）です。暗算はしやすくなりますが、書いたremがすべてブラウザ既定の8分の5になるため、文字を大きく設定している閲覧者の拡大幅が意図より小さくなります。ルートは100%のままにして、換算した値を書く方が安全です。',
  EM_PARENT: (n) => `em は親要素のフォントサイズ（${n}px）が基準です。入れ子にすると掛け算になるので、フォントサイズの指定には rem の方が安全です。`,
  NOT_EXACT: (v) => `${v} は割り切れないため丸めています（ブラウザは内部でより高い精度を保つので、見た目の差は0.01px未満です）。`,
  NOTHING_FOUND: (u) => `変換対象が見つかりませんでした（${u} の値がありません）。`,
  SKIPPED_SMALL: (n) => `${n}箇所は minPx 未満だったのでそのまま残しました（1pxの罫線をremにすると環境によって太さがばらつくためです）。`,
  SKIPPED_MEDIA: (n) => `${n}箇所は @media などアットルールの条件だったのでそのまま残しました（skipMedia=false で変換できます）。`,
  SKIPPED_PROP: (n) => `${n}箇所は ignoreProps に一致するプロパティだったのでそのまま残しました。`,
  ZEROED: (n) => `${n}箇所の 0 は単位なしの 0 にしました（zeroUnitless=false でそのまま残せます）。`,
};

export class PxRemError extends Error {}

const prNote = (code, arg) => ({ code, message: PR_NOTE_TEXT[code] ? PR_NOTE_TEXT[code](arg) : code });

/**
 * 長さを px / rem / em / pt へ換算するか、CSSの単位をまとめて置き換える。
 *
 * value を渡すと1つの値の換算（よく使うサイズのスケール表つき）、
 * css / path を渡すとCSS全体の一括変換になる。
 *
 * @param {object} opts
 * @param {number|string} [opts.value]   換算する値（'1.5rem' のように単位を含めてもよい）
 * @param {'px'|'rem'|'em'|'pt'|'%'} [opts.unit='px'] value の単位
 * @param {string} [opts.css]            一括変換するCSS（value / path と排他）
 * @param {string} [opts.path]           一括変換するCSSファイルの絶対パス（value / css と排他）
 * @param {string} [opts.outputPath]     変換後のCSSを書き出す絶対パス（指定すると本文は返さない）
 * @param {'px2rem'|'px2em'|'rem2px'|'em2px'} [opts.direction='px2rem'] 一括変換の向き
 * @param {number|string} [opts.root=16] ルート（html要素）のフォントサイズ px（'62.5%' も可）
 * @param {number|string} [opts.parent]  親要素のフォントサイズ px（emの基準。既定は root と同じ）
 * @param {number|'auto'} [opts.precision='auto'] 小数の桁（auto は末尾の0を落とす）
 * @param {number} [opts.minPx=2]        一括変換で、この値未満のpxは変換しない
 * @param {boolean} [opts.zeroUnitless=true] 0 を単位なしの 0 にする
 * @param {boolean} [opts.skipMedia=true]    @media などアットルールの条件は変換しない
 * @param {string[]} [opts.ignoreProps]  変換しないプロパティ（前方一致。例 ['border','box-shadow']）
 * @param {boolean} [opts.scale=true]    値の換算のときにスケール表を返す
 */
export async function pxRemConvert(opts = {}) {
  const hasCss = typeof opts.css === 'string';
  const hasPath = typeof opts.path === 'string' && opts.path !== '';
  const hasValue = opts.value !== undefined && opts.value !== null && String(opts.value).trim() !== '';
  if (hasCss && hasPath) throw new PxRemError('css と path は同時に指定できません');
  if ((hasCss || hasPath) && hasValue) throw new PxRemError('value と css / path は同時に指定できません');
  if (!hasCss && !hasPath && !hasValue) {
    throw new PxRemError('value（換算する値）か css / path（一括変換するCSS）のどちらかを渡してください');
  }

  const root = prResolveBase(opts.root, PR_DEFAULT_ROOT);
  const parent = prResolveBase(opts.parent, root);
  const precision = opts.precision === undefined || opts.precision === null ? 'auto' : opts.precision;
  const fmt = (n) => prFormat(n, precision);

  const baseNotes = [];
  if (root !== PR_DEFAULT_ROOT) baseNotes.push(prNote('ROOT_NOT_16', prFormat(root, 'auto')));
  if (Math.abs(root - 10) < 0.001) baseNotes.push(prNote('ROOT_625'));

  /* ---- CSSの一括変換 ---- */
  if (hasCss || hasPath) {
    const direction = opts.direction || 'px2rem';
    if (!PR_CSS_DIRECTIONS[direction]) {
      throw new PxRemError(`direction は px2rem / px2em / rem2px / em2px のいずれか: ${opts.direction}`);
    }
    const dir = PR_CSS_DIRECTIONS[direction];
    const input = hasCss ? opts.css : await readFile(opts.path, 'utf8');
    const minPx = opts.minPx === undefined || opts.minPx === null ? 2 : Number(opts.minPx);
    const r = prConvertCss(input, {
      direction,
      root,
      parent,
      precision,
      minPx,
      zeroUnitless: opts.zeroUnitless,
      skipMedia: opts.skipMedia,
      ignoreProps: opts.ignoreProps,
    });

    const notes = baseNotes.slice();
    if (dir.base === 'parent' && parent !== root) notes.push(prNote('EM_PARENT', prFormat(parent, 'auto')));
    if (!r.stats.found) notes.push(prNote('NOTHING_FOUND', dir.from));
    if (r.stats.skipped_small) notes.push(prNote('SKIPPED_SMALL', r.stats.skipped_small));
    if (r.stats.skipped_media) notes.push(prNote('SKIPPED_MEDIA', r.stats.skipped_media));
    if (r.stats.skipped_prop) notes.push(prNote('SKIPPED_PROP', r.stats.skipped_prop));
    if (r.stats.zeroed) notes.push(prNote('ZEROED', r.stats.zeroed));

    const result = {
      mode: 'css',
      direction,
      source: hasCss ? { type: 'text' } : { path: opts.path, name: basename(opts.path) },
      root,
      parent,
      options: {
        precision,
        min_px: minPx,
        zero_unitless: opts.zeroUnitless !== false,
        skip_media: opts.skipMedia !== false,
        ignore_props: Array.isArray(opts.ignoreProps) ? opts.ignoreProps : [],
      },
      stats: r.stats,
      text: r.text,
      notes,
    };
    if (opts.outputPath) {
      await writeFile(opts.outputPath, r.text, 'utf8');
      result.output = opts.outputPath;
      // ファイルに書けたなら本文は重複した重い情報でしかない
      delete result.text;
    }
    return result;
  }

  /* ---- 1つの値の換算 ---- */
  const parsed = prParseLength(opts.value, opts.unit || 'px');
  if (!parsed) throw new PxRemError(`value を数値として読めません: ${opts.value}`);
  if (opts.unit && ['px', 'rem', 'em', 'pt', '%'].indexOf(String(opts.unit).toLowerCase()) === -1) {
    throw new PxRemError(`unit は px / rem / em / pt / % のいずれか: ${opts.unit}`);
  }
  const r = prConvert({ value: parsed.value, unit: parsed.unit, root, parent });
  if (!r) throw new PxRemError(`value を換算できません: ${opts.value}`);

  const remStr = prFormat(r.rem, 'auto');
  // 表示した rem を px へ戻して一致するか（1e-9 は二進小数の誤差を吸収するための幅）
  const exact = Math.abs(Number(remStr) * root - r.px) < 1e-9;

  const notes = baseNotes.slice();
  if (parent !== root) notes.push(prNote('EM_PARENT', prFormat(parent, 'auto')));
  if (!exact) notes.push(prNote('NOT_EXACT', remStr + 'rem'));

  const result = {
    mode: 'value',
    input: { value: parsed.value, unit: parsed.unit },
    root,
    parent,
    px: r.px,
    rem: r.rem,
    em: r.em,
    pt: r.pt,
    formatted: {
      px: fmt(r.px) + 'px',
      rem: fmt(r.rem) + 'rem',
      em: fmt(r.em) + 'em',
      pt: fmt(r.pt) + 'pt',
    },
    css: `font-size: ${fmt(r.rem)}rem; /* ${fmt(r.px)}px */`,
    exact,
    notes,
  };
  if (opts.scale !== false) {
    result.scale = prScale({ root, parent }).map((row) => ({
      px: row.px,
      rem: fmt(row.rem) + 'rem',
      em: fmt(row.em) + 'em',
      role: PR_ROLE_TEXT[row.role] || row.role,
    }));
  }
  return result;
}
