/* 印刷サイズ・DPI計算（dpi_calc）
 * 計算コア（dpiCalc / dpiReverse / dpiFor / dpiGrade / dpiTable ほか・用紙一覧 PAPERS）は
 * FirstCHTools の site/dpi/app.js と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルからコアの開始/終了コメントに挟まれた範囲を sed で切り出し
 * （site側は字下げ2文字を落とす・こちらは行頭の export を落とす）、
 * diff が空になることで同期を機械的に確認できる。
 *
 * コアの外（DPI_TEXT と dpiCalcTool）は、site側の画面処理（renderCalc / renderReverse /
 * buildTableText / renderUnits）が組み立てる指摘・入稿メモ・早見表・単位換算を、
 * DOM に書かずに値で返す形へ移したもの。文言は site側の T（日英）と同じ。
 * プレビューの紙面の描画・コピー・タブは持たない。
 * 完全ローカル処理・ネットワーク送信なし。 */

/* ==================== ここから計算コア（site / MCP で同一） ==================== */

export const MM_PER_INCH = 25.4;
export const PT_PER_INCH = 72;          // DTPポイント（1pt = 1/72 inch）
export const MAX_MM = 10000;            // 用紙の一辺として受け付ける上限（10m）
export const MAX_PX = 500000;           // ピクセル数の上限
export const MAX_DPI = 4800;
export const PSD_LIMIT = 30000;         // PSD が持てる一辺の上限 px（超えると PSB が要る）

/**
 * 用紙プリセット。寸法は短辺 × 長辺（mm）で持ち、向きは表示側で入れ替える。
 * land: 既定で横向きに使うもの（名刺・往復はがき）
 */
export const PAPERS = [
  { key: 'A0', group: 'a', w: 841, h: 1189 },
  { key: 'A1', group: 'a', w: 594, h: 841 },
  { key: 'A2', group: 'a', w: 420, h: 594 },
  { key: 'A3', group: 'a', w: 297, h: 420 },
  { key: 'A4', group: 'a', w: 210, h: 297 },
  { key: 'A5', group: 'a', w: 148, h: 210 },
  { key: 'A6', group: 'a', w: 105, h: 148 },
  { key: 'B1', group: 'b', w: 728, h: 1030 },
  { key: 'B2', group: 'b', w: 515, h: 728 },
  { key: 'B3', group: 'b', w: 364, h: 515 },
  { key: 'B4', group: 'b', w: 257, h: 364 },
  { key: 'B5', group: 'b', w: 182, h: 257 },
  { key: 'B6', group: 'b', w: 128, h: 182 },
  { key: 'MEISHI', group: 'card', w: 55, h: 91, land: true },
  { key: 'MEISHI_SQ', group: 'card', w: 60, h: 60 },
  { key: 'US_CARD', group: 'card', w: 50.8, h: 88.9, land: true },
  { key: 'CD', group: 'card', w: 121, h: 121 },
  { key: 'HAGAKI', group: 'post', w: 100, h: 148 },
  { key: 'OFUKU', group: 'post', w: 148, h: 200, land: true },
  { key: 'PHOTO_L', group: 'post', w: 89, h: 127 },
  { key: 'PHOTO_2L', group: 'post', w: 127, h: 178 },
  { key: 'PHOTO_KG', group: 'post', w: 102, h: 152 },
  { key: 'NAGA3', group: 'etc', w: 120, h: 235, land: true },
  { key: 'YOKO_NOBORI', group: 'etc', w: 600, h: 1800 },
  { key: 'TICKET', group: 'etc', w: 55, h: 180, land: true },
  { key: 'LETTER', group: 'us', w: 215.9, h: 279.4 },
  { key: 'LEGAL', group: 'us', w: 215.9, h: 355.6 },
  { key: 'TABLOID', group: 'us', w: 279.4, h: 431.8 },
];

// 早見表に載せる定番（全プリセットだと縦に長くなりすぎる）
export const TABLE_KEYS = ['A2', 'A3', 'A4', 'A5', 'A6', 'B3', 'B4', 'B5', 'MEISHI', 'HAGAKI', 'PHOTO_L', 'LETTER'];

export const DPI_PRESETS = [72, 96, 150, 200, 250, 300, 350, 400, 600, 1200];

/** 文字列・数値を有限な数へ。読めなければ NaN */
export function dpNum(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : NaN;
  const s = String(v === undefined || v === null ? '' : v)
    .trim().replace(/,/g, '').replace(/(px|mm|dpi|ppi)$/i, '').trim();
  if (!s) return NaN;
  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
}

export function isMm(n) { return Number.isFinite(n) && n > 0 && n <= MAX_MM; }
export function isPx(n) { return Number.isFinite(n) && n > 0 && n <= MAX_PX; }
export function isDpi(n) { return Number.isFinite(n) && n > 0 && n <= MAX_DPI; }
export function isBleed(n) { return Number.isFinite(n) && n >= 0 && n <= 100; }

/** 小数を見やすい文字列へ（小数点以下の末尾の0だけを落とす。300 を 3 にしない） */
export function fmt(n, digits) {
  if (!Number.isFinite(n)) return '';
  const d = digits === undefined ? 2 : digits;
  let s = n.toFixed(d);
  if (s.indexOf('.') !== -1) s = s.replace(/0+$/, '').replace(/\.$/, '');
  return s === '-0' ? '0' : s;
}

/** 3桁区切り（ピクセル数は桁が多いので読みやすくする） */
export function group(n) {
  if (!Number.isFinite(n)) return '';
  return Math.round(n).toLocaleString('en-US');
}

/** mm → px（解像度 dpi のとき） */
export function mmToPx(mm, dpi) { return mm / MM_PER_INCH * dpi; }

/** px → mm */
export function pxToMm(px, dpi) { return px / dpi * MM_PER_INCH; }

/** 用紙プリセットを引く */
export function paperByKey(key) {
  return PAPERS.find((p) => p.key === String(key || '').toUpperCase()) || null;
}

/** 向きを当てた寸法（mm）。orientation: 'portrait' | 'landscape' */
export function paperSize(paper, orientation) {
  const short = Math.min(paper.w, paper.h);
  const long = Math.max(paper.w, paper.h);
  return orientation === 'landscape' ? { w: long, h: short } : { w: short, h: long };
}

/**
 * 用紙（mm）と解像度から、入稿に必要なピクセル数を求める。
 * 端数は切り上げる（足りないより1px多い方が安全なため）。
 * @param {object} o
 * @param {number} o.widthMm   仕上がりの幅（mm）
 * @param {number} o.heightMm  仕上がりの高さ（mm）
 * @param {number} o.dpi       解像度
 * @param {number} [o.bleedMm=0] 塗り足し（片側・mm）
 * @returns {object|null}
 */
export function dpiCalc(o) {
  const wMm = dpNum(o.widthMm);
  const hMm = dpNum(o.heightMm);
  const dpi = dpNum(o.dpi);
  const bleed = isBleed(dpNum(o.bleedMm)) ? dpNum(o.bleedMm) : 0;
  if (!isMm(wMm) || !isMm(hMm) || !isDpi(dpi)) return null;

  const fullW = wMm + bleed * 2;
  const fullH = hMm + bleed * 2;
  const exact = { w: mmToPx(wMm, dpi), h: mmToPx(hMm, dpi) };
  const trim = { w: Math.ceil(exact.w - 1e-9), h: Math.ceil(exact.h - 1e-9) };
  const full = { w: Math.ceil(mmToPx(fullW, dpi) - 1e-9), h: Math.ceil(mmToPx(fullH, dpi) - 1e-9) };
  const pixels = full.w * full.h;

  return {
    widthMm: wMm,
    heightMm: hMm,
    bleedMm: bleed,
    dpi,
    fullWidthMm: fullW,
    fullHeightMm: fullH,
    widthIn: wMm / MM_PER_INCH,
    heightIn: hMm / MM_PER_INCH,
    exactWidth: exact.w,
    exactHeight: exact.h,
    trimWidth: trim.w,
    trimHeight: trim.h,
    width: full.w,            // 塗り足し込み
    height: full.h,
    bleedPx: mmToPx(bleed, dpi),
    megapixels: pixels / 1e6,
    // 非圧縮・8bit/chをそのまま並べたときの目安（PSD/TIFFの素の大きさ）
    bytesRgb: pixels * 3,
    bytesCmyk: pixels * 4,
  };
}

/**
 * 手持ちのピクセル数から、その解像度で印刷できる実寸を求める。
 * @returns {object|null}
 */
export function dpiReverse(o) {
  const px = dpNum(o.width);
  const py = dpNum(o.height);
  const dpi = dpNum(o.dpi);
  if (!isPx(px) || !isPx(py) || !isDpi(dpi)) return null;
  return {
    width: px,
    height: py,
    dpi,
    widthMm: pxToMm(px, dpi),
    heightMm: pxToMm(py, dpi),
    widthIn: px / dpi,
    heightIn: py / dpi,
    megapixels: px * py / 1e6,
  };
}

/**
 * 手持ちのピクセル数をその用紙に使ったときの実効dpi。
 * 用紙の向きは、画像の向きに合わせて有利な方を選ぶ（縦横は刷る前に回せるため）。
 * @returns {object|null}
 */
export function dpiFor(o) {
  const px = dpNum(o.width);
  const py = dpNum(o.height);
  const wMm = dpNum(o.widthMm);
  const hMm = dpNum(o.heightMm);
  const bleed = isBleed(dpNum(o.bleedMm)) ? dpNum(o.bleedMm) : 0;
  if (!isPx(px) || !isPx(py) || !isMm(wMm) || !isMm(hMm)) return null;
  const W = wMm + bleed * 2;
  const H = hMm + bleed * 2;
  // 用紙を回した2通りを試し、実効dpiが高い方を採る
  const cases = [{ w: W, h: H, rotated: false }, { w: H, h: W, rotated: true }];
  let best = null;
  for (const c of cases) {
    // 紙を埋める（cover）ときの実効dpi＝足を引っぱる方の辺で決まる
    const eff = Math.min(px / (c.w / MM_PER_INCH), py / (c.h / MM_PER_INCH));
    if (!best || eff > best.dpi) best = { dpi: eff, rotated: c.rotated, widthMm: c.w, heightMm: c.h };
  }
  return best;
}

/** 実効dpiの評価。350以上=十分 / 300以上=実用 / 200以上=用途しだい / それ未満=不足 */
export function dpiGrade(dpi) {
  if (!(dpi > 0)) return 'ng';
  if (dpi >= 350) return 'best';
  if (dpi >= 300) return 'ok';
  if (dpi >= 200) return 'fair';
  return 'ng';
}

/** 早見表の行を作る */
export function dpiTable(keys, dpi, bleedMm) {
  const rows = [];
  for (const key of keys) {
    const p = paperByKey(key);
    if (!p) continue;
    const size = paperSize(p, p.land ? 'landscape' : 'portrait');
    const r = dpiCalc({ widthMm: size.w, heightMm: size.h, dpi, bleedMm });
    if (r) rows.push(Object.assign({ key: p.key }, r));
  }
  return rows;
}

/** バイト数を MB / GB の文字列へ（1MB = 1024×1024 bytes） */
export function bytes(n) {
  if (!(n > 0)) return '0 MB';
  const mb = n / 1048576;
  if (mb >= 1024) return fmt(mb / 1024, 2) + ' GB';
  if (mb >= 100) return fmt(mb, 0) + ' MB';
  return fmt(mb, 1) + ' MB';
}

/* ==================== ここまで計算コア ==================== */

/* ---- 文言（site側の T と同じ。site はページの <html lang> で切り替え、こちらは lang 引数で選ぶ） ---- */
export const DPI_TEXT = {
  ja: {
    badMm: '仕上がりサイズをmmで入れてください（例: 210 × 297）。',
    badDpi: '解像度を 1〜4800 dpi の範囲で入れてください。',
    badBleed: '塗り足しを 0〜100mm の範囲で入れてください。',
    badPx: '手持ちの画像のピクセル数を入れてください（例: 4000 × 3000）。',
    papers: {
      A0: 'A0 — 841 × 1189 mm', A1: 'A1 — 594 × 841 mm', A2: 'A2 — 420 × 594 mm',
      A3: 'A3 — 297 × 420 mm', A4: 'A4 — 210 × 297 mm', A5: 'A5 — 148 × 210 mm',
      A6: 'A6 — 105 × 148 mm', B1: 'B1（JIS） — 728 × 1030 mm', B2: 'B2（JIS） — 515 × 728 mm',
      B3: 'B3（JIS） — 364 × 515 mm', B4: 'B4（JIS） — 257 × 364 mm', B5: 'B5（JIS） — 182 × 257 mm',
      B6: 'B6（JIS） — 128 × 182 mm',
      MEISHI: '名刺（日本・4号） — 91 × 55 mm', MEISHI_SQ: '正方形の名刺 — 60 × 60 mm',
      US_CARD: '名刺（欧米） — 88.9 × 50.8 mm', CD: 'CDジャケット — 121 × 121 mm',
      HAGAKI: 'はがき・DM — 100 × 148 mm', OFUKU: '往復はがき — 200 × 148 mm',
      PHOTO_L: 'L判写真 — 89 × 127 mm', PHOTO_2L: '2L判写真 — 127 × 178 mm',
      PHOTO_KG: 'KG（はがきサイズ写真） — 102 × 152 mm',
      NAGA3: '長形3号封筒 — 235 × 120 mm', YOKO_NOBORI: 'のぼり旗 — 600 × 1800 mm',
      TICKET: 'チケット・しおり — 180 × 55 mm',
      LETTER: 'レター（US） — 215.9 × 279.4 mm', LEGAL: 'リーガル（US） — 215.9 × 355.6 mm',
      TABLOID: 'タブロイド（US） — 279.4 × 431.8 mm',
    },
    paperShort: {
      A0: 'A0', A1: 'A1', A2: 'A2', A3: 'A3', A4: 'A4', A5: 'A5', A6: 'A6',
      B1: 'B1', B2: 'B2', B3: 'B3', B4: 'B4', B5: 'B5', B6: 'B6',
      MEISHI: '名刺', MEISHI_SQ: '正方形の名刺', US_CARD: '名刺（欧米）', CD: 'CDジャケット',
      HAGAKI: 'はがき', OFUKU: '往復はがき', PHOTO_L: 'L判写真', PHOTO_2L: '2L判写真',
      PHOTO_KG: 'KG判', NAGA3: '長形3号封筒', YOKO_NOBORI: 'のぼり旗', TICKET: 'チケット',
      LETTER: 'レター', LEGAL: 'リーガル', TABLOID: 'タブロイド',
    },
    custom: '自由なサイズ（mm）',
    orient: { portrait: '縦（ポートレート）', landscape: '横（ランドスケープ）' },
    grades: { best: '十分', ok: '実用', fair: '用途しだい', ng: '不足' },
    gradeNote: {
      best: '商業印刷の標準（350dpi）に届いています',
      ok: '300dpi — たいていの印刷物で問題ありません',
      fair: '300dpi未満。離れて見る大判なら使えます',
      ng: '200dpi未満。手に取って見る印刷物ではぼやけます',
    },
    memoTitle: '入稿データの仕様',
    memoPaper: '用紙', memoRes: '解像度', memoTrim: '仕上がり',
    memoBleed: '塗り足し', memoFull: '塗り足し込み', memoData: '非圧縮でのデータ量',
    memoNone: 'なし',
    previewTrim: '仕上がり', previewBleed: '塗り足し', previewSafe: '安全な範囲',
    tableHead: ['用紙', 'サイズ（mm）', '仕上がり（px）', '塗り足し込み（px）'],
    revHead: ['用紙', '実効dpi', '判定'],
    fmtLabels: { text: 'テキスト', md: 'Markdownの表', csv: 'CSV' },
    statTrim: '仕上がり（px）', statFull: '塗り足し込み（px）', statMm: '仕上がりの実寸',
    statData: '非圧縮のデータ量', statPrint: '印刷できる大きさ', statDpi: '実効dpi',
    statMax: '350dpiでの上限', statMp: '画素数',
    unitsHead: ['単位', '値'],
    units: { mm: 'ミリメートル', cm: 'センチメートル', inch: 'インチ', px: 'ピクセル', pt: 'ポイント（1/72インチ）', q: '級（Q・0.25mm）' },
    noteStandard: (dpi) => `${fmt(dpi, 0)}dpi は日本の商業印刷・オンデマンド印刷で標準的に求められる解像度です（欧米は300dpiが基準）。どちらでも手に取って見る印刷物で問題ありません。`,
    noteLow: (dpi) => `${fmt(dpi, 0)}dpi は多くの印刷所が求める300dpiを下回ります。数メートル離れて見るポスターや横断幕なら十分ですが、手元で見る印刷物では文字や細部がぼやけます。`,
    noteVeryLow: (dpi) => `${fmt(dpi, 0)}dpi は画面向けの解像度です。この大きさで刷るとピクセルそのものが見えます。350dpi にするにはピクセル数を約${fmt(350 / dpi, 1)}倍にしてください。`,
    noteHigh: (dpi) => `${fmt(dpi, 0)}dpi が効くのは線画・バーコード・小さな文字（単色）です。写真は400dpiを超えても印刷の網点が再現できないため、データが重くなるだけで見た目は変わりません。`,
    noteBleed: (mm) => `塗り足しは四辺それぞれ${fmt(mm)}mmです。断裁位置より${fmt(mm)}mm外側まで絵柄を伸ばして作ります。2つのピクセル数の差（${fmt(mm * 2)}mm分）がこれにあたります。`,
    noteNoBleed: '塗り足しなしの設定です。背景色や写真が紙の端まで届くデザインなら3mmを足してください。断裁のわずかなズレで、白い筋が出ます。',
    noteSafe: (mm) => `文字やロゴは仕上がり線より${fmt(mm)}mm内側に収めてください（プレビューの点線）。断裁の精度は1mm前後で、端ぎりぎりの文字は窮屈にも見えます。`,
    noteRound: (exact, px) => `正確には ${exact}px で、切り上げて ${px}px にしています。端数は必ず切り上げてください。1px足りないと端に白い線が残ります。`,
    noteData: (rgb, cmyk) => `統合済み8bitの非圧縮データでおよそ RGB ${rgb} / CMYK ${cmyk} です。レイヤーや効果を持つ作業データはこの数倍になるので、余裕を見てください。`,
    notePsd: (side) => `一辺が ${group(side)}px で、PSD形式の上限（30,000px）を超えます。Photoshopは PSB での保存を求めます。このサイズの制作物は離れて見るものなので、150〜200dpi で作る方が現実的です。`,
    noteBig: (mp) => `${fmt(mp, 0)}メガピクセルは編集が重くなる大きさです。大判では寸法ではなく解像度を落とすのが定石で、dpiを半分にすると画素数は4分の1になります。`,
    noteCmyk: '指定がなければCMYKで入稿します。RGBのまま渡すと印刷所側の変換で鮮やかな青や緑がくすみ、校正が出るまで気づけません。',
    revExact: (mm, dpi) => `${fmt(dpi, 0)}dpi で ${mm} になります。`,
    revMax: (dpi, w, h) => `${fmt(dpi, 0)}dpi なら最大 ${w} × ${h} mm まで印刷できます。`,
    revFits: (paper, dpi) => `${paper} に${fmt(dpi, 0)}dpiで使えます。`,
    revShort: (paper, dpi, need) => `${paper} では${fmt(dpi, 0)}dpiになります。350dpiにするには ${need} が必要です。`,
    revUpscale: 'Photoshopで拡大しても情報は増えません（無いピクセルを作っているだけです）。実効dpiが足りないときは、撮り直す・スキャンし直す方が確実です。',
    revVector: 'ロゴや文字は、解像度を持たないベクター（AI・PDF・SVG）で渡すのが安全です。どんな大きさでも輪郭が崩れません。',
    unitNote: (dpi) => `換算は ${fmt(dpi, 0)}dpi で行っています。`,
  },
  en: {
    badMm: 'Enter the finished size in millimetres (e.g. 210 × 297).',
    badDpi: 'Enter a resolution between 1 and 4800 dpi.',
    badBleed: 'Enter a bleed between 0 and 100 mm.',
    badPx: 'Enter the pixel size of the file you have (e.g. 4000 × 3000).',
    papers: {
      A0: 'A0 — 841 × 1189 mm', A1: 'A1 — 594 × 841 mm', A2: 'A2 — 420 × 594 mm',
      A3: 'A3 — 297 × 420 mm', A4: 'A4 — 210 × 297 mm', A5: 'A5 — 148 × 210 mm',
      A6: 'A6 — 105 × 148 mm', B1: 'B1 (JIS) — 728 × 1030 mm', B2: 'B2 (JIS) — 515 × 728 mm',
      B3: 'B3 (JIS) — 364 × 515 mm', B4: 'B4 (JIS) — 257 × 364 mm', B5: 'B5 (JIS) — 182 × 257 mm',
      B6: 'B6 (JIS) — 128 × 182 mm',
      MEISHI: 'Business card, Japan — 91 × 55 mm', MEISHI_SQ: 'Square card — 60 × 60 mm',
      US_CARD: 'Business card, US — 88.9 × 50.8 mm', CD: 'CD sleeve — 121 × 121 mm',
      HAGAKI: 'Postcard, Japan — 100 × 148 mm', OFUKU: 'Reply-paid postcard — 200 × 148 mm',
      PHOTO_L: 'Photo L — 89 × 127 mm', PHOTO_2L: 'Photo 2L — 127 × 178 mm',
      PHOTO_KG: 'Photo KG / 4×6 — 102 × 152 mm',
      NAGA3: 'Envelope Naga 3 — 235 × 120 mm', YOKO_NOBORI: 'Banner flag — 600 × 1800 mm',
      TICKET: 'Ticket / bookmark — 180 × 55 mm',
      LETTER: 'US Letter — 215.9 × 279.4 mm', LEGAL: 'US Legal — 215.9 × 355.6 mm',
      TABLOID: 'Tabloid / Ledger — 279.4 × 431.8 mm',
    },
    paperShort: {
      A0: 'A0', A1: 'A1', A2: 'A2', A3: 'A3', A4: 'A4', A5: 'A5', A6: 'A6',
      B1: 'B1', B2: 'B2', B3: 'B3', B4: 'B4', B5: 'B5', B6: 'B6',
      MEISHI: 'Business card', MEISHI_SQ: 'Square card', US_CARD: 'US card', CD: 'CD sleeve',
      HAGAKI: 'Postcard', OFUKU: 'Reply postcard', PHOTO_L: 'Photo L', PHOTO_2L: 'Photo 2L',
      PHOTO_KG: 'Photo KG', NAGA3: 'Envelope', YOKO_NOBORI: 'Banner', TICKET: 'Ticket',
      LETTER: 'Letter', LEGAL: 'Legal', TABLOID: 'Tabloid',
    },
    custom: 'Custom size (mm)',
    orient: { portrait: 'Portrait', landscape: 'Landscape' },
    grades: { best: 'Plenty', ok: 'Fine', fair: 'Depends', ng: 'Too low' },
    gradeNote: {
      best: 'at or above the 350 dpi commercial standard',
      ok: '300 dpi — fine for almost any press job',
      fair: 'below 300 dpi; acceptable for large format viewed from a distance',
      ng: 'below 200 dpi — visibly soft in print',
    },
    memoTitle: 'Artwork specification',
    memoPaper: 'Paper', memoRes: 'Resolution', memoTrim: 'Trim size',
    memoBleed: 'Bleed', memoFull: 'With bleed', memoData: 'Uncompressed size',
    memoNone: 'none',
    previewTrim: 'trim', previewBleed: 'bleed', previewSafe: 'safe area',
    tableHead: ['Paper', 'Size (mm)', 'Trim (px)', 'With bleed (px)'],
    revHead: ['Paper', 'Effective dpi', 'Verdict'],
    fmtLabels: { text: 'Plain text', md: 'Markdown table', csv: 'CSV' },
    statTrim: 'Trim size (px)', statFull: 'With bleed (px)', statMm: 'Finished size',
    statData: 'Uncompressed', statPrint: 'Print size', statDpi: 'Effective dpi',
    statMax: 'Max at 350 dpi', statMp: 'Megapixels',
    unitsHead: ['Unit', 'Value'],
    units: { mm: 'Millimetres', cm: 'Centimetres', inch: 'Inches', px: 'Pixels', pt: 'Points (1/72 in)', q: 'Q (0.25 mm)' },
    noteStandard: (dpi) => `${fmt(dpi, 0)} dpi is the usual resolution for commercial offset and on-demand printing in Japan; 300 dpi is the international norm. Either is safe for a job read in the hand.`,
    noteLow: (dpi) => `${fmt(dpi, 0)} dpi is below the 300 dpi most printers ask for. It is fine for a poster or banner read from a couple of metres away, but text and fine detail will look soft in the hand.`,
    noteVeryLow: (dpi) => `${fmt(dpi, 0)} dpi is a screen resolution. Printed at this size the pixels themselves become visible — multiply the pixel count by about ${fmt(350 / dpi, 1)} to reach 350 dpi.`,
    noteHigh: (dpi) => `${fmt(dpi, 0)} dpi only pays off for line art, barcodes and small type set in a single colour. For photographs anything past 400 dpi adds file size without adding detail, because the press screen cannot resolve it.`,
    noteBleed: (mm) => `Bleed is ${fmt(mm)} mm on every side, so the artwork must extend ${fmt(mm)} mm past the trim line on all four edges. That is what the ${fmt(mm * 2)} mm difference between the two pixel figures is.`,
    noteNoBleed: 'No bleed. If any colour or image touches the edge of the paper, add 3 mm — otherwise a white sliver shows up wherever the guillotine drifts.',
    noteSafe: (mm) => `Keep text and logos at least ${fmt(mm)} mm inside the trim line as well (the dotted box in the preview). Cutting is accurate to about a millimetre, and a page right against the edge looks cramped.`,
    noteRound: (exact, px) => `The exact figure is ${exact} px, rounded up to ${px} px. Always round up: a pixel short leaves a hairline of white along the edge.`,
    noteData: (rgb, cmyk) => `A flattened 8-bit file at this size is about ${rgb} in RGB and ${cmyk} in CMYK before compression. Layers and effects multiply that, so allow several times the figure while working.`,
    notePsd: (side) => `One side is ${group(side)} px, past the 30,000 px limit of the PSD format — Photoshop will ask you to save as PSB. For a piece this large, work at 150-200 dpi instead: it is read from metres away.`,
    noteBig: (mp) => `${fmt(mp, 0)} megapixels is a heavy file to edit. For large-format work the trade is normally resolution, not size: halving the dpi quarters the pixel count.`,
    noteCmyk: 'Send CMYK unless the printer says otherwise. Converting RGB at the press flattens vivid blues and greens, and you will not see that until the proof.',
    revExact: (mm, dpi) => `${mm} at ${fmt(dpi, 0)} dpi.`,
    revMax: (dpi, w, h) => `At ${fmt(dpi, 0)} dpi this file prints at up to ${w} × ${h} mm.`,
    revFits: (paper, dpi) => `Large enough for ${paper} at ${fmt(dpi, 0)} dpi.`,
    revShort: (paper, dpi, need) => `${paper} would come out at ${fmt(dpi, 0)} dpi; it needs ${need} to reach 350 dpi.`,
    revUpscale: 'Enlarging a file in Photoshop does not add detail — it only invents pixels. Rescan or reshoot instead when the effective dpi is short.',
    revVector: 'Logos and type are better sent as vector (AI, PDF or SVG): they have no resolution at all and stay sharp at any size.',
    unitNote: (dpi) => `Conversions use ${fmt(dpi, 0)} dpi.`,
  },
};


// 用紙の分類（site の <optgroup> と同じ並び・名前）
export const DPI_GROUP_ORDER = ['a', 'b', 'card', 'post', 'etc', 'us'];
const GROUP_LABEL = {
  ja: { a: 'A判', b: 'B判（JIS）', card: '名刺・カード', post: 'はがき・写真', etc: 'その他', us: '米国規格' },
  en: { a: 'A series', b: 'B series (JIS)', card: 'Cards', post: 'Postcards & photos', etc: 'Other', us: 'US sizes' },
};

// 安全な範囲（仕上がり線から内側へ）。site の SAFE_MM と同じ
const SAFE_MM = 3;
export const DPI_UNITS = ['mm', 'cm', 'inch', 'px', 'pt', 'q'];
export const DPI_TABLE_FORMATS = ['text', 'md', 'csv'];
export const DPI_MODES = ['size', 'reverse', 'table', 'units', 'papers'];

export class DpiToolError extends Error {}

/* ---- site の画面ヘルパー（mmLabel / mmLabelRound / paren）を lang 引数つきで ---- */
const mmLabel = (w, h) => fmt(w, 1) + ' × ' + fmt(h, 1) + ' mm';
const mmLabelRound = (w, h) => fmt(w, 0) + ' × ' + fmt(h, 0) + ' mm';
const paren = (lang, name, inner) => (lang === 'en' ? name + ' (' + inner + ')' : name + '（' + inner + '）');
const note = (code, level, message) => ({ code, level, message });

/** site の buildTableText と同じ（EN の判定を lang 引数に置き換えただけ） */
export function dpiTableText(rows, f, dpi, bleed, lang) {
  const T = DPI_TEXT[lang];
  const EN = lang === 'en';
  const head = T.tableHead;
  if (f === 'md') {
    return [
      `| ${head[0]} | ${head[1]} | ${head[2]} | ${head[3]} |`,
      '| --- | ---: | ---: | ---: |',
      ...rows.map((r) => `| ${T.paperShort[r.key]} | ${fmt(r.widthMm, 1)} × ${fmt(r.heightMm, 1)} | ${r.trimWidth} × ${r.trimHeight} | ${r.width} × ${r.height} |`),
    ].join('\n');
  }
  if (f === 'csv') {
    return ['paper,width_mm,height_mm,trim_width_px,trim_height_px,bleed_width_px,bleed_height_px,dpi,bleed_mm',
      ...rows.map((r) => [T.paperShort[r.key], fmt(r.widthMm, 1), fmt(r.heightMm, 1), r.trimWidth, r.trimHeight, r.width, r.height, fmt(dpi, 0), fmt(bleed)].join(','))].join('\n');
  }
  return [
    `${fmt(dpi, 0)} dpi / ${T.memoBleed} ${bleed > 0 ? fmt(bleed) + ' mm' : T.memoNone}`,
    ...rows.map((r) => `${T.paperShort[r.key]}: ${group(r.trimWidth)} × ${group(r.trimHeight)} px${EN ? ' (' : '（'}${T.memoFull} ${group(r.width)} × ${group(r.height)} px${EN ? ')' : '）'}`),
  ].join('\n');
}

/** 用紙の指定（paper / widthMm・heightMm / orientation）を寸法へ。site の currentPaper と同じ判定 */
function resolvePaper(opts, T, lang) {
  const hasMm = opts.widthMm !== undefined || opts.heightMm !== undefined;
  if (hasMm && opts.paper !== undefined && String(opts.paper).toLowerCase() !== 'custom') {
    throw new DpiToolError('paper と widthMm/heightMm は同時に渡せません');
  }
  if (hasMm || String(opts.paper || '').toLowerCase() === 'custom') {
    const w = dpNum(opts.widthMm);
    const h = dpNum(opts.heightMm);
    if (!isMm(w) || !isMm(h)) throw new DpiToolError(T.badMm);
    return { key: null, w, h, label: mmLabel(w, h), orientation: null };
  }
  const p = paperByKey(opts.paper === undefined ? 'A4' : opts.paper);
  if (!p) throw new DpiToolError(`未対応の用紙: ${opts.paper}（mode="papers" で一覧を返す。自由なサイズは widthMm / heightMm）`);
  let orientation = opts.orientation;
  if (orientation === undefined) orientation = p.land ? 'landscape' : 'portrait';
  if (orientation !== 'portrait' && orientation !== 'landscape') throw new DpiToolError(`orientation は portrait か landscape: ${opts.orientation}`);
  const s = paperSize(p, orientation);
  return { key: p.key, w: s.w, h: s.h, label: paren(lang, T.paperShort[p.key], mmLabel(s.w, s.h)), orientation };
}

function readDpi(v, T) {
  const dpi = v === undefined ? 350 : dpNum(v);
  if (!isDpi(dpi)) throw new DpiToolError(T.badDpi);
  return dpi;
}

function readBleed(v, T) {
  const bleed = v === undefined ? 3 : dpNum(v);
  if (!isBleed(bleed)) throw new DpiToolError(T.badBleed);
  return bleed;
}

/** タブ1（必要なピクセル数）。site の renderCalc が画面に書く値と指摘を返す */
function sizeMode(opts, T, lang) {
  const paper = resolvePaper(opts, T, lang);
  const dpi = readDpi(opts.dpi, T);
  const bleed = readBleed(opts.bleedMm, T);
  const r = dpiCalc({ widthMm: paper.w, heightMm: paper.h, dpi, bleedMm: bleed });
  const memo = [
    '【' + T.memoTitle + '】',
    T.memoPaper + ': ' + paper.label,
    T.memoRes + ': ' + fmt(dpi, 0) + ' dpi',
    T.memoTrim + ': ' + group(r.trimWidth) + ' × ' + group(r.trimHeight) + ' px',
    T.memoBleed + ': ' + (bleed > 0 ? fmt(bleed) + ' mm' : T.memoNone),
    T.memoFull + ': ' + group(r.width) + ' × ' + group(r.height) + ' px',
    T.memoData + ': RGB ' + bytes(r.bytesRgb) + ' / CMYK ' + bytes(r.bytesCmyk),
  ].join('\n');
  const notes = [];
  if (dpi >= 300 && dpi <= 400) notes.push(note('STANDARD', 'ok', T.noteStandard(dpi)));
  else if (dpi > 400) notes.push(note('HIGH', 'info', T.noteHigh(dpi)));
  else if (dpi >= 150) notes.push(note('LOW', 'warn', T.noteLow(dpi)));
  else notes.push(note('VERY_LOW', 'warn', T.noteVeryLow(dpi)));
  if (bleed > 0) notes.push(note('BLEED', 'info', T.noteBleed(bleed)));
  else notes.push(note('NO_BLEED', 'warn', T.noteNoBleed));
  notes.push(note('SAFE_AREA', 'info', T.noteSafe(SAFE_MM)));
  if (Math.abs(r.exactWidth - r.trimWidth) > 1e-6 || Math.abs(r.exactHeight - r.trimHeight) > 1e-6) {
    notes.push(note('ROUNDED_UP', 'info', T.noteRound(
      fmt(r.exactWidth, 1) + ' × ' + fmt(r.exactHeight, 1),
      group(r.trimWidth) + ' × ' + group(r.trimHeight),
    )));
  }
  notes.push(note('DATA_SIZE', 'info', T.noteData(bytes(r.bytesRgb), bytes(r.bytesCmyk))));
  const side = Math.max(r.width, r.height);
  if (side > PSD_LIMIT) notes.push(note('PSB_REQUIRED', 'warn', T.notePsd(side)));
  else if (r.megapixels > 200) notes.push(note('HEAVY', 'info', T.noteBig(r.megapixels)));
  notes.push(note('CMYK', 'info', T.noteCmyk));
  return {
    mode: 'size',
    paper: paper.key || 'custom',
    paper_label: paper.label,
    ...(paper.orientation ? { orientation: paper.orientation } : {}),
    ...r,
    safe_mm: SAFE_MM,
    display: {
      trim: group(r.trimWidth) + ' × ' + group(r.trimHeight) + ' px',
      full: group(r.width) + ' × ' + group(r.height) + ' px',
      size: mmLabel(r.widthMm, r.heightMm),
      data_rgb: bytes(r.bytesRgb),
      data_cmyk: bytes(r.bytesCmyk),
    },
    memo,
    notes,
  };
}

/** タブ2（逆算）。site の renderReverse と同じ。用紙は portrait の寸法を渡し、dpiFor が有利な向きを選ぶ */
function reverseMode(opts, T, lang) {
  const w = dpNum(opts.width);
  const h = dpNum(opts.height);
  if (!isPx(w) || !isPx(h)) throw new DpiToolError(T.badPx);
  const dpi = readDpi(opts.dpi, T);
  const bleed = readBleed(opts.bleedMm, T);
  const p = paperByKey(opts.paper === undefined ? 'A4' : opts.paper);
  if (!p) throw new DpiToolError(`未対応の用紙: ${opts.paper}（mode="papers" で一覧を返す）`);
  const r = dpiReverse({ width: w, height: h, dpi });
  const at350 = dpiReverse({ width: w, height: h, dpi: 350 });
  const port = paperSize(p, 'portrait');
  const eff = dpiFor({ width: w, height: h, widthMm: port.w, heightMm: port.h, bleedMm: bleed });
  const grade = dpiGrade(eff.dpi);
  const notes = [];
  notes.push(note('EXACT', 'info', T.revExact(mmLabel(r.widthMm, r.heightMm), r.dpi)));
  notes.push(note('MAX_AT_350', 'info', T.revMax(350, fmt(at350.widthMm, 1), fmt(at350.heightMm, 1))));
  const need = dpiCalc({ widthMm: eff.widthMm - bleed * 2, heightMm: eff.heightMm - bleed * 2, dpi: 350, bleedMm: bleed });
  const label = T.paperShort[p.key];
  if (eff.dpi >= 350) notes.push(note('FITS', 'ok', T.revFits(label, eff.dpi)));
  else {
    notes.push(note('SHORT', 'warn', T.revShort(label, eff.dpi, need ? group(need.width) + ' × ' + group(need.height) + ' px' : '')));
    notes.push(note('NO_UPSCALE', 'info', T.revUpscale));
  }
  notes.push(note('VECTOR', 'info', T.revVector));
  const papers = [];
  for (const key of TABLE_KEYS) {
    const paper = paperByKey(key);
    const size = paperSize(paper, 'portrait');
    const e = dpiFor({ width: w, height: h, widthMm: size.w, heightMm: size.h, bleedMm: bleed });
    if (!e) continue;
    const g = dpiGrade(e.dpi);
    papers.push({ paper: key, label: paren(lang, T.paperShort[key], mmLabel(size.w, size.h)), dpi: e.dpi, display: fmt(e.dpi, 0) + ' dpi', grade: g, grade_label: T.grades[g], rotated: e.rotated });
  }
  return {
    mode: 'reverse',
    ...r,
    bleedMm: bleed,
    print_size: mmLabelRound(r.widthMm, r.heightMm),
    max_at_350: { widthMm: at350.widthMm, heightMm: at350.heightMm, display: mmLabelRound(at350.widthMm, at350.heightMm) },
    effective: {
      paper: p.key,
      label: T.paperShort[p.key],
      dpi: eff.dpi,
      display: fmt(eff.dpi, 0) + ' dpi',
      grade,
      grade_label: T.grades[grade],
      grade_note: T.gradeNote[grade],
      rotated: eff.rotated,
      paper_with_bleed_mm: { width: eff.widthMm, height: eff.heightMm },
      ...(eff.dpi < 350 && need ? { needed_at_350: { width: need.width, height: need.height } } : {}),
    },
    papers,
    notes,
  };
}

/** タブ3（早見表） */
function tableMode(opts, T, lang) {
  const dpi = readDpi(opts.dpi, T);
  const bleed = readBleed(opts.bleedMm, T);
  const format = opts.format === undefined ? 'text' : opts.format;
  if (DPI_TABLE_FORMATS.indexOf(format) === -1) throw new DpiToolError(`format は text / md / csv: ${opts.format}`);
  let keys = TABLE_KEYS;
  if (opts.papers !== undefined) {
    if (!Array.isArray(opts.papers) || !opts.papers.length) throw new DpiToolError('papers は1件以上の用紙キーの配列で渡してください');
    keys = opts.papers.map((k) => {
      const p = paperByKey(k);
      if (!p) throw new DpiToolError(`未対応の用紙: ${k}`);
      return p.key;
    });
  }
  const rows = dpiTable(keys, dpi, bleed);
  return {
    mode: 'table',
    dpi,
    bleedMm: bleed,
    format,
    rows: rows.map((r) => ({ paper: r.key, label: T.paperShort[r.key], widthMm: r.widthMm, heightMm: r.heightMm, trimWidth: r.trimWidth, trimHeight: r.trimHeight, width: r.width, height: r.height })),
    text: dpiTableText(rows, format, dpi, bleed, lang),
  };
}

/** タブ4（単位換算）。site の renderUnits と同じ（いったん mm に揃えてから各単位へ） */
function unitsMode(opts, T) {
  const v = dpNum(opts.value);
  if (!Number.isFinite(v)) throw new DpiToolError(`value は数値で渡してください: ${opts.value}`);
  const from = opts.from === undefined ? 'mm' : opts.from;
  if (DPI_UNITS.indexOf(from) === -1) throw new DpiToolError(`from は ${DPI_UNITS.join(' / ')} のどれか: ${opts.from}`);
  const dpi = readDpi(opts.dpi, T);
  let mm;
  if (from === 'mm') mm = v;
  else if (from === 'cm') mm = v * 10;
  else if (from === 'inch') mm = v * MM_PER_INCH;
  else if (from === 'pt') mm = v / PT_PER_INCH * MM_PER_INCH;
  else if (from === 'q') mm = v * 0.25;
  else mm = pxToMm(v, dpi);
  const values = { mm, cm: mm / 10, inch: mm / MM_PER_INCH, px: mmToPx(mm, dpi), pt: mm / MM_PER_INCH * PT_PER_INCH, q: mm / 0.25 };
  const display = {
    mm: fmt(mm, 3) + ' mm',
    cm: fmt(mm / 10, 3) + ' cm',
    inch: fmt(mm / MM_PER_INCH, 4) + ' in',
    px: fmt(mmToPx(mm, dpi), 1) + ' px',
    pt: fmt(mm / MM_PER_INCH * PT_PER_INCH, 2) + ' pt',
    q: fmt(mm / 0.25, 2) + ' Q',
  };
  return { mode: 'units', value: v, from, dpi, values, display, labels: T.units, note: T.unitNote(dpi) };
}

function papersMode(T, lang) {
  return {
    mode: 'papers',
    groups: DPI_GROUP_ORDER.map((g) => ({
      group: g,
      label: GROUP_LABEL[lang][g],
      papers: PAPERS.filter((p) => p.group === g).map((p) => ({
        key: p.key, label: T.papers[p.key], short: T.paperShort[p.key], widthMm: p.w, heightMm: p.h,
        orientation: p.land ? 'landscape' : 'portrait',
      })),
    })),
    table_keys: TABLE_KEYS,
    dpi_presets: DPI_PRESETS,
  };
}

/**
 * 印刷サイズ・DPI計算。
 * mode: size（用紙×dpi→必要px）/ reverse（px→印刷できる大きさ・実効dpi）/ table（早見表）/ units（単位換算）/ papers（用紙一覧）。
 * 省略時は width/height があれば reverse、value があれば units、それ以外は size。
 */
export async function dpiCalcTool(opts = {}) {
  const lang = opts.lang || 'ja';
  if (lang !== 'ja' && lang !== 'en') throw new DpiToolError(`lang は ja か en: ${opts.lang}`);
  const T = DPI_TEXT[lang];
  let mode = opts.mode;
  if (mode === undefined) {
    if (opts.width !== undefined || opts.height !== undefined) mode = 'reverse';
    else if (opts.value !== undefined) mode = 'units';
    else mode = 'size';
  }
  if (DPI_MODES.indexOf(mode) === -1) throw new DpiToolError(`mode は ${DPI_MODES.join(' / ')} のどれか: ${opts.mode}`);
  if (mode === 'size') return sizeMode(opts, T, lang);
  if (mode === 'reverse') return reverseMode(opts, T, lang);
  if (mode === 'table') return tableMode(opts, T, lang);
  if (mode === 'units') return unitsMode(opts, T);
  return papersMode(T, lang);
}
