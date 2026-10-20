/* Flexbox / CSS Grid ジェネレーター（css_layout_generate）
 * FirstCHTools の site/css-layout/app.js（正本）から、指定→CSS / HTML の組み立てと指摘を写したもの
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 *
 * site側にはコアの開始/終了の目印が無いため、次の3節を節見出しのコメントごと写している:
 *   「grid-template-areas の検証」「CSS の組み立て」「指摘（チェック結果）」
 * site側との違いは、関数がモジュール内の state / T を直接読む代わりに引数で受けることだけ:
 *   parseAreas(text) → parseAreas(text, T) / flexDecls() → flexDecls(state) / gridColsCss() → gridColsCss(state)
 *   gridDecls(area) → gridDecls(state, area) / itemDecls(it) → itemDecls(state, it)
 *   buildCss(area) → buildCss(state, area) / buildHtml(area) → buildHtml(state, area) / diagnose(area) → diagnose(state, area, T)
 * 同期の確認は、site側の3節を切り出して上の置き換えを当てたもの（字下げ2文字を落とす）と、
 * こちらの3節（行頭の export を落とす）の diff が空になること。
 * 文言（T・VAL）・子要素の既定（DEF_ITEM）・状態の初期値・プリセット（PRESETS）も site と同じ値。
 * プレビューの描画・折り返し行数の実測（DOM が要る）・コピー・タブ・URLパラメータは持たない。
 * 完全ローカル処理・ネットワーク送信なし。 */

/* ==================== 文言（site の T。site は <html lang>、こちらは lang 引数で選ぶ） ==================== */

export const CL_TEXT = {
  ja: {
    item: (n) => `子要素 ${n}`,
    lines: (n) => `${n}行`,
    tracks: (n) => `${n}本`,
    areaErrRagged: (n, m) => `grid-template-areas は全ての行のマス数を揃える必要があります（${n}行目が${m}マス）。`,
    areaErrRect: (name) => `エリア「${name}」が長方形になっていません。名前がL字や分断された形になると、CSSは grid-template-areas の値全体を捨てます。`,
    areaErrEmpty: 'エリア名を1行以上入れてください（例: 「header header」／「side main」）。',
    areaErrName: (tok) => `「${tok}」はエリア名に使えません（英数字・- ・_ のみ。「.」1文字だけは空きマスの意味）。`,
    areaOk: (r, c, n) => `${r} 行 × ${c} 列・名前の付いたエリアは ${n} 個。`,
    trackCountMismatch: (t, a) => `列トラックは ${t} 本ですが、エリアの行は ${a} マスです。あふれたマスは暗黙のトラック（grid-auto-columns: auto）に入ります。`,
    noFreeSpace: '1fr のトラックが余白を全部使うため、justify-content に配る余りが残りません。',
    justifyDead: 'flex-grow が 0 より大きい子要素があるので、行に余白が残らず justify-content は効きません。',
    alignContentDead: 'align-content は折り返した「行」を動かすプロパティです。flex-wrap: nowrap では行が1本しかないので何も起きません。',
    alignItemsStretchNote: 'align-items: stretch は子要素の高さをいちばん高いものに揃えます（背の低い箱が伸びているのはこれ）。外したい子要素には align-self か height を指定します。',
    reverseNote: 'row-reverse / column-reverse は描く順だけを反転します。Tab移動と読み上げの順はHTMLのままなので、マークアップは読む順で書いてください。',
    gapNote: 'flexbox の gap は Safari 14.1（2021年）以降が必要です。それ以前のSafariは無視して隙間が消えるため、対応が必要なら margin を使います。',
    shrinkNote: 'flex-shrink は元の幅に掛け算されます。同じ値でも、幅の広い子要素のほうが多くのピクセルを譲ります。',
    basisNote: 'flex-basis: 0 は行の全幅を flex-grow の比で配ります。auto は先に中身の幅を確保して残りだけを配るので、grow を同じにしても幅は揃いません。',
    minWidthNote: 'flex の子要素は中身の幅より狭くなりません（min-width: auto）。長いURLや表が入ると行があふれるので、縮めたい子要素には min-width: 0 を足します。',
    frMinNote: '1fr の最小値は auto なので、幅の広い中身（長いURL・表・pre）が入るとトラックが持ち分を超えてグリッドがあふれます。縮めたいときは minmax(0, 1fr) と書きます。',
    autoFitNote: 'auto-fit は空いたトラックを畳むので子要素が伸びて埋まります。auto-fill はトラックを残すため末尾に空きができます——違いはここだけです。',
    wrapNote: 'flex-wrap: wrap が狭い画面での積み上がりを作ります。無いと子要素は下へ回らず、読めない幅まで縮み続けます。',
    dense: 'grid-auto-flow の dense は空いたマスを後ろの子要素で埋めるため、HTMLより前に表示される子要素が出ます。読む順が崩れます。',
    itemsN: (n) => `子要素 ${n} 個`,
    areaLegend: '名前付きエリア',
    selHint: (n) => `子要素 ${n} を編集しています。プレビューの箱をクリックすると切り替わります。`,
    selHintArea: '名前付きエリアでは配置を名前で決めるため、ここで子要素ごとに設定する項目はありません。',
    dirRow: '主軸は左→右。justify-content が横、align-items が縦を動かします。',
    dirRowRev: '主軸は右→左。HTMLで最初の子要素が右端に描かれます。',
    dirCol: '主軸は上→下。justify-content が縦、align-items が横を動かす——2つの役割が入れ替わります。',
    dirColRev: '主軸は下→上。HTMLで最初の子要素が下端に描かれます。',
  },
  en: {
    item: (n) => `Item ${n}`,
    lines: (n) => (n === 1 ? '1 line' : `${n} lines`),
    tracks: (n) => (n === 1 ? '1 track' : `${n} tracks`),
    areaErrRagged: (n, m) => `Every row of grid-template-areas needs the same number of cells. Row ${n} has ${m}.`,
    areaErrRect: (name) => `The area "${name}" is not a rectangle. CSS throws away the whole grid-template-areas value when any name is L-shaped or split.`,
    areaErrEmpty: 'Type at least one row of area names, for example "header header" / "side main".',
    areaErrName: (tok) => `"${tok}" cannot be an area name. Use letters, digits, - and _ (a lone "." means an empty cell).`,
    areaOk: (r, c, n) => `${r} × ${c} cells, ${n} named ${n === 1 ? 'area' : 'areas'}.`,
    trackCountMismatch: (t, a) => `grid-template-columns has ${t} tracks but the area rows have ${a} cells. The extra cells fall into implicit tracks sized by grid-auto-columns (auto).`,
    noFreeSpace: 'A track is 1fr, so it eats all the free space — justify-content then has nothing left to distribute.',
    justifyDead: 'An item has flex-grow above 0, so the items fill the line and justify-content has no free space to distribute.',
    alignContentDead: 'align-content only moves wrapped lines. With flex-wrap: nowrap there is a single line, so it does nothing.',
    alignItemsStretchNote: 'align-items: stretch makes the items as tall as the tallest one (that is why the short boxes match). Give an item align-self or a height to opt out.',
    reverseNote: 'row-reverse / column-reverse only flips the painting order. Tab and screen-reader order still follow the HTML, so keep the markup in reading order.',
    gapNote: 'gap in flexbox needs Safari 14.1+ (2021). Older Safari ignores it and the items touch — use margins if you must support it.',
    shrinkNote: 'flex-shrink is multiplied by the base size, so a wide item gives up more pixels than a narrow one at the same shrink value.',
    basisNote: 'flex-basis: 0 distributes the whole line by flex-grow. With auto the content width is reserved first and only the leftover is shared, so equal grow values still produce unequal widths.',
    minWidthNote: 'A flex item will not shrink below the width of its content (min-width: auto). Long words or a table inside make the line overflow — add min-width: 0 to the item to allow it.',
    frMinNote: 'A 1fr track has a minimum of auto, so wide content (long URLs, tables, pre) pushes the track past its share and the grid overflows. Write minmax(0, 1fr) to let it shrink.',
    autoFitNote: 'auto-fit collapses the empty tracks, so the items stretch to fill the row. auto-fill keeps them, leaving a gap at the end — that is the only difference.',
    wrapNote: 'flex-wrap: wrap is what lets narrow screens stack. Without it the items shrink past readability instead of moving down.',
    dense: 'grid-auto-flow: dense backfills holes, so items can appear before earlier ones. Reading order stops matching the HTML.',
    itemsN: (n) => `${n} items`,
    areaLegend: 'Named areas',
    selHint: (n) => `Editing item ${n}. Click a box in the preview to switch.`,
    selHintArea: 'With named areas each box is placed by its name, so there is nothing to set per item here.',
    dirRow: 'Main axis runs left → right. justify-content moves the items horizontally, align-items vertically.',
    dirRowRev: 'Main axis runs right → left. The first item in the HTML is painted on the right.',
    dirCol: 'Main axis runs top → bottom. justify-content now moves the items vertically and align-items horizontally — the two swap roles.',
    dirColRev: 'Main axis runs bottom → top. The first item in the HTML is painted at the bottom.',
  },
};

/* 値ごとの一言解説（site の VAL と同じ。[日本語, 英語]） */
export const VAL = {
  'justify-content': {
    'flex-start': ['主軸の先頭へ寄せます（既定）。', 'Packs the items at the start of the main axis (default).'],
    'flex-end': ['主軸の末尾へ寄せます。', 'Packs the items at the end of the main axis.'],
    center: ['主軸の中央へ寄せます。余白は両端に等分されます。', 'Centres the items; the free space is split between the two ends.'],
    'space-between': ['両端を端に付け、余白を子要素の「間」に等分します。子要素が1つだと先頭寄せと同じ見え方です。', 'Pushes the ends to the edges and splits the free space between the items. With one item it looks like flex-start.'],
    'space-around': ['子要素の両側に同じ余白を付けます。端の余白は間の余白の半分になります。', 'Gives each item equal space on both sides, so the outer gaps end up half the inner ones.'],
    'space-evenly': ['端も間もすべて同じ余白にします。見た目に「等間隔」を求めるならこちらです。', 'Makes every gap — including the outer ones — the same. This is the one that actually looks evenly spaced.'],
    start: ['書字方向の先頭へ寄せます（flex-start とほぼ同じですが Grid ではこちらが標準の書き方）。', 'Packs at the start in writing order — the usual spelling in Grid.'],
    end: ['書字方向の末尾へ寄せます。', 'Packs at the end in writing order.'],
    stretch: ['伸ばせるトラックがあれば余白を分配します（固定サイズのトラックには効きません）。', 'Distributes the free space to stretchable tracks (does nothing to fixed ones).'],
  },
  'align-items': {
    stretch: ['交差軸いっぱいに伸ばします（既定）。高さを指定していない子要素は、いちばん高い子要素に揃います。', 'Stretches the items across the cross axis (default), so items without a height match the tallest one.'],
    'flex-start': ['交差軸の先頭（横並びなら上端）へ揃えます。高さは中身なりになります。', 'Aligns to the start of the cross axis (the top in a row), leaving each item at its content height.'],
    'flex-end': ['交差軸の末尾（横並びなら下端）へ揃えます。', 'Aligns to the end of the cross axis (the bottom in a row).'],
    center: ['交差軸の中央へ揃えます。高さの違う箱を縦中央で並べる定番です。', 'Centres on the cross axis — the standard way to line up boxes of different heights.'],
    baseline: ['文字のベースラインを揃えます。文字サイズが違う見出しと本文を横に並べるときに効きます。', 'Lines up the text baselines, which is what you want when a large heading sits next to body text.'],
    start: ['書字方向の先頭へ揃えます（Grid での標準の書き方）。', 'Aligns to the start in writing order (the usual spelling in Grid).'],
    end: ['書字方向の末尾へ揃えます。', 'Aligns to the end in writing order.'],
  },
  'align-content': {
    stretch: ['行（トラック）を伸ばして余白を埋めます（既定）。', 'Stretches the lines to fill the free space (default).'],
    'flex-start': ['折り返した行のまとまりを上端へ寄せます。', 'Packs the wrapped lines at the top.'],
    'flex-end': ['行のまとまりを下端へ寄せます。', 'Packs the wrapped lines at the bottom.'],
    center: ['行のまとまりを縦中央へ寄せます。', 'Centres the block of wrapped lines.'],
    'space-between': ['最初と最後の行を端に付け、行の間に余白を等分します。', 'Pins the first and last line to the edges and splits the space between the lines.'],
    'space-around': ['各行の上下に同じ余白を付けます。', 'Gives each line equal space above and below.'],
    'space-evenly': ['行の間も上下端もすべて同じ余白にします。', 'Makes every gap between and around the lines the same.'],
    start: ['書字方向の先頭へ寄せます。', 'Packs at the start in writing order.'],
    end: ['書字方向の末尾へ寄せます。', 'Packs at the end in writing order.'],
  },
  'align-self': {
    auto: ['親の align-items に従います（既定）。', 'Follows the container’s align-items (default).'],
    stretch: ['この子要素だけ交差軸いっぱいに伸ばします。', 'Stretches just this item across the cross axis.'],
    'flex-start': ['この子要素だけ先頭（上端）へ揃えます。', 'Aligns just this item to the start (top).'],
    'flex-end': ['この子要素だけ末尾（下端）へ揃えます。「片方だけ下に置く」の定番。', 'Aligns just this item to the end (bottom) — the usual way to drop one item down.'],
    center: ['この子要素だけ中央へ揃えます。', 'Centres just this item.'],
    baseline: ['この子要素の文字のベースラインを揃えます。', 'Aligns this item on its text baseline.'],
  },
  'justify-items': {
    stretch: ['各マスの中で横いっぱいに伸ばします（既定）。', 'Stretches each item to fill its cell horizontally (default).'],
    start: ['各マスの左（書字方向の先頭）へ寄せます。中身の幅になります。', 'Packs each item at the inline start of its cell, at content width.'],
    end: ['各マスの右（書字方向の末尾）へ寄せます。', 'Packs each item at the inline end of its cell.'],
    center: ['各マスの中で横中央へ寄せます。', 'Centres each item horizontally in its cell.'],
  },
  'grid-auto-flow': {
    row: ['行を埋めてから次の行へ進みます（既定）。', 'Fills a row, then moves to the next one (default).'],
    column: ['列を埋めてから次の列へ進みます。', 'Fills a column, then moves to the next one.'],
    'row dense': ['行順に置きつつ、前にできた空きマスを後ろの子要素で埋めます。', 'Fills by row but backfills earlier holes with later items.'],
    'column dense': ['列順に置きつつ、空きマスを後ろの子要素で埋めます。', 'Fills by column but backfills earlier holes with later items.'],
  },
  'flex-wrap': {
    nowrap: ['折り返しません（既定）。子要素は1行に押し込まれ、収まらなければ縮みます。', 'No wrapping (default): everything is squeezed into one line and the items shrink instead.'],
    wrap: ['収まらない子要素を次の行へ送ります。レスポンシブの土台になります。', 'Moves items that do not fit onto the next line — the basis of responsive rows.'],
    'wrap-reverse': ['折り返しますが、行が積み上がる向きが逆（上へ）になります。', 'Wraps, but the new lines stack in the opposite direction (upwards).'],
  },
};

export const valHint = (prop, value, lang) => {
  const row = VAL[prop] && VAL[prop][value];
  return row ? (lang === 'en' ? row[1] : row[0]) : '';
};

/* ==================== 状態（site の state の初期値と同じ） ==================== */

export const DEF_ITEM = () => ({ grow: 0, shrink: 1, basis: 'auto', self: 'auto', order: 0, cspan: 1, rspan: 1 });

export function defaultState() {
  return {
    mode: 'flex',
    flex: {
      display: 'flex',
      direction: 'row',
      wrap: 'wrap',
      justify: 'flex-start',
      alignItems: 'stretch',
      alignContent: 'stretch',
      rowGap: 12,
      colGap: 12,
      count: 4,
      sel: 0,
      varied: true,
      height: 200,
      items: [DEF_ITEM(), DEF_ITEM(), DEF_ITEM(), DEF_ITEM(), DEF_ITEM(), DEF_ITEM(), DEF_ITEM(), DEF_ITEM()],
    },
    grid: {
      cols: ['1fr', '1fr', '1fr'],
      rows: ['auto'],
      autoFit: false,
      autoFitMin: 200,
      flow: 'row',
      rowGap: 12,
      colGap: 12,
      justifyItems: 'stretch',
      alignItems: 'stretch',
      justifyContent: 'start',
      alignContent: 'start',
      useAreas: false,
      areas: 'header header header\nside   main   main\nfoot   foot   foot',
      count: 6,
      sel: 0,
      height: 260,
      items: [DEF_ITEM(), DEF_ITEM(), DEF_ITEM(), DEF_ITEM(), DEF_ITEM(), DEF_ITEM(), DEF_ITEM(), DEF_ITEM(), DEF_ITEM(), DEF_ITEM(), DEF_ITEM(), DEF_ITEM()],
    },
  };
}

/* ==================== grid-template-areas の検証 ==================== */

export const NAME_RE = /^[A-Za-z_][\w-]*$/;

/** areas のテキストを検証して {rows, cols, names, error} を返す */
export function parseAreas(text, T) {
  const lines = text.split('\n').map((l) => l.trim()).filter((l) => l !== '');
  if (!lines.length) return { error: T.areaErrEmpty };
  const grid = lines.map((l) => l.replace(/["']/g, ' ').trim().split(/\s+/));
  const w = grid[0].length;
  for (let r = 0; r < grid.length; r++) {
    if (grid[r].length !== w) return { error: T.areaErrRagged(r + 1, grid[r].length) };
    for (const tok of grid[r]) {
      if (tok === '.' || /^\.+$/.test(tok)) continue;
      if (!NAME_RE.test(tok)) return { error: T.areaErrName(tok) };
    }
  }
  // 同じ名前が長方形になっているか（仕様: 長方形でないと値全体が無効）
  const seen = new Map();
  for (let r = 0; r < grid.length; r++) {
    for (let c = 0; c < w; c++) {
      const tok = grid[r][c];
      if (/^\.+$/.test(tok)) continue;
      const box = seen.get(tok);
      if (!box) seen.set(tok, { r0: r, r1: r, c0: c, c1: c, n: 1 });
      else {
        box.r0 = Math.min(box.r0, r); box.r1 = Math.max(box.r1, r);
        box.c0 = Math.min(box.c0, c); box.c1 = Math.max(box.c1, c);
        box.n++;
      }
    }
  }
  for (const [name, box] of seen) {
    const need = (box.r1 - box.r0 + 1) * (box.c1 - box.c0 + 1);
    if (need !== box.n) return { error: T.areaErrRect(name) };
  }
  return { grid, rows: grid.length, cols: w, names: [...seen.keys()] };
}

/* ==================== CSS の組み立て ==================== */

export const px = (n) => `${n}px`;
export const gapValue = (row, col) => (row === col ? px(row) : `${px(row)} ${px(col)}`);

/** 同じ値のトラックが2本以上続けば repeat() へ畳む */
export function tracksToCss(list) {
  if (!list.length) return 'none';
  const out = [];
  let i = 0;
  while (i < list.length) {
    let j = i;
    while (j + 1 < list.length && list[j + 1] === list[i]) j++;
    const n = j - i + 1;
    out.push(n >= 2 ? `repeat(${n}, ${list[i]})` : list[i]);
    i = j + 1;
  }
  return out.join(' ');
}

export function flexDecls(state) {
  const f = state.flex;
  const d = [['display', f.display], ['flex-direction', f.direction]];
  if (f.wrap !== 'nowrap') d.push(['flex-wrap', f.wrap]);
  if (f.justify !== 'flex-start') d.push(['justify-content', f.justify]);
  if (f.alignItems !== 'stretch') d.push(['align-items', f.alignItems]);
  if (f.wrap !== 'nowrap' && f.alignContent !== 'stretch') d.push(['align-content', f.alignContent]);
  if (f.rowGap || f.colGap) d.push(['gap', gapValue(f.rowGap, f.colGap)]);
  return d;
}

export function gridColsCss(state) {
  const g = state.grid;
  return g.autoFit ? `repeat(auto-fit, minmax(${px(g.autoFitMin)}, 1fr))` : tracksToCss(g.cols);
}

export function gridDecls(state, area) {
  const g = state.grid;
  const d = [['display', 'grid'], ['grid-template-columns', gridColsCss(state)]];
  if (g.rows.length && !(g.rows.length === 1 && g.rows[0] === 'auto')) d.push(['grid-template-rows', tracksToCss(g.rows)]);
  if (g.useAreas && area && area.grid) {
    const w = area.grid.reduce((m, row) => Math.max(m, ...row.map((t) => t.length)), 0);
    d.push(['grid-template-areas', '\n' + area.grid.map((row) => '    "' + row.map((t) => t.padEnd(w)).join(' ').trimEnd() + '"').join('\n')]);
  }
  if (g.rowGap || g.colGap) d.push(['gap', gapValue(g.rowGap, g.colGap)]);
  if (g.flow !== 'row') d.push(['grid-auto-flow', g.flow]);
  if (g.justifyItems !== 'stretch') d.push(['justify-items', g.justifyItems]);
  if (g.alignItems !== 'stretch') d.push(['align-items', g.alignItems]);
  if (g.justifyContent !== 'start') d.push(['justify-content', g.justifyContent]);
  if (g.alignContent !== 'start') d.push(['align-content', g.alignContent]);
  return d;
}

/** 子要素ごとの宣言（既定と違うものだけ） */
export function itemDecls(state, it) {
  const d = [];
  if (state.mode === 'flex') {
    if (it.grow !== 0 || it.shrink !== 1 || it.basis !== 'auto') d.push(['flex', `${it.grow} ${it.shrink} ${it.basis}`]);
    if (it.self !== 'auto') d.push(['align-self', it.self]);
    if (it.order !== 0) d.push(['order', String(it.order)]);
  } else {
    if (it.cspan > 1) d.push(['grid-column', `span ${it.cspan}`]);
    if (it.rspan > 1) d.push(['grid-row', `span ${it.rspan}`]);
  }
  return d;
}

// 複数行の値（grid-template-areas）はコロンの直後に改行させる＝行末に空白を残さない
export const declsToCss = (decls, indent) => decls.map(([k, v]) => `${indent}${k}:${v[0] === '\n' ? '' : ' '}${v};`).join('\n');

export function buildCss(state, area) {
  const mode = state.mode;
  const decls = mode === 'flex' ? flexDecls(state) : gridDecls(state, area);
  let css = '.layout {\n' + declsToCss(decls, '  ') + '\n}';
  if (mode === 'grid' && state.grid.useAreas && area && area.names) {
    for (const name of area.names) css += `\n\n.layout > .${name} {\n  grid-area: ${name};\n}`;
    return css;
  }
  const items = mode === 'flex' ? state.flex.items.slice(0, state.flex.count) : state.grid.items.slice(0, state.grid.count);
  items.forEach((it, i) => {
    const d = itemDecls(state, it);
    if (d.length) css += `\n\n.layout > :nth-child(${i + 1}) {\n` + declsToCss(d, '  ') + '\n}';
  });
  return css;
}

export function buildHtml(state, area) {
  if (state.mode === 'grid' && state.grid.useAreas && area && area.names) {
    return '<div class="layout">\n' + area.names.map((n) => `  <div class="${n}">${n}</div>`).join('\n') + '\n</div>';
  }
  const n = state.mode === 'flex' ? state.flex.count : state.grid.count;
  const rows = [];
  for (let i = 1; i <= n; i++) rows.push(`  <div class="item">${i}</div>`);
  return '<div class="layout">\n' + rows.join('\n') + '\n</div>';
}

/* ==================== 指摘（チェック結果） ==================== */

export function diagnose(state, area, T) {
  const out = [];
  const add = (kind, text) => out.push({ kind, text });
  if (state.mode === 'flex') {
    const f = state.flex;
    const grows = f.items.slice(0, f.count).some((it) => it.grow > 0);
    if (grows && f.justify !== 'flex-start') add('warn', T.justifyDead);
    if (f.wrap === 'nowrap' && f.alignContent !== 'stretch') add('warn', T.alignContentDead);
    if (f.direction.endsWith('reverse')) add('warn', T.reverseNote);
    if (f.wrap === 'nowrap') add('info', T.wrapNote);
    if (f.alignItems === 'stretch') add('info', T.alignItemsStretchNote);
    if (f.rowGap || f.colGap) add('info', T.gapNote);
    if (f.items.slice(0, f.count).some((it) => it.basis === '0')) add('info', T.basisNote);
    if (f.items.slice(0, f.count).some((it) => it.shrink > 1)) add('info', T.shrinkNote);
    add('info', T.minWidthNote);
  } else {
    const g = state.grid;
    if (g.useAreas) {
      if (area.error) add('warn', area.error);
      else {
        add('ok', T.areaOk(area.rows, area.cols, area.names.length));
        const tracks = g.autoFit ? 0 : g.cols.length;
        if (tracks && tracks !== area.cols) add('warn', T.trackCountMismatch(tracks, area.cols));
      }
    }
    if (g.autoFit) add('info', T.autoFitNote);
    if (!g.autoFit && g.cols.includes('1fr')) add('info', T.frMinNote);
    if (g.flow.indexOf('dense') !== -1) add('warn', T.dense);
    if (!g.autoFit && g.cols.every((c) => c.endsWith('fr')) && g.justifyContent !== 'start') add('warn', T.noFreeSpace);
    if (g.rowGap || g.colGap) add('info', T.gapNote);
  }
  return out;
}

/* ==================== プリセット（site の PRESETS と同じ。id はこちらで付けた呼び名） ==================== */

export const PRESETS = [
  {
    ja: '横並びを中央へ', en: 'Centre a row', mode: 'flex',
    flex: { justify: 'center', alignItems: 'center', wrap: 'wrap', direction: 'row', rowGap: 12, colGap: 12, count: 3 },
  },
  {
    ja: 'ヘッダー（両端＋縦中央）', en: 'Header (ends + middle)', mode: 'flex',
    flex: { justify: 'space-between', alignItems: 'center', wrap: 'nowrap', direction: 'row', rowGap: 0, colGap: 16, count: 3 },
  },
  {
    ja: '折り返すカード列', en: 'Wrapping card row', mode: 'flex',
    flex: { justify: 'flex-start', alignItems: 'stretch', wrap: 'wrap', direction: 'row', rowGap: 16, colGap: 16, count: 6 },
    items: { all: { grow: 1, shrink: 1, basis: '240px' } },
  },
  {
    ja: 'サイドバー＋本文', en: 'Sidebar + content', mode: 'grid',
    grid: { cols: ['240px', 'minmax(0, 1fr)'], rows: ['auto'], useAreas: false, count: 2, rowGap: 24, colGap: 40, autoFit: false },
  },
  {
    ja: '聖杯レイアウト（エリア）', en: 'Holy grail (areas)', mode: 'grid',
    grid: {
      cols: ['200px', 'minmax(0, 1fr)', '160px'], rows: ['auto', '1fr', 'auto'], useAreas: true, autoFit: false, rowGap: 12, colGap: 12, height: 320,
      areas: 'header header header\nnav    main   aside\nfooter footer footer',
    },
  },
  {
    ja: '自動で折り返すグリッド', en: 'Auto-fit grid', mode: 'grid',
    grid: { autoFit: true, autoFitMin: 200, rows: ['auto'], useAreas: false, count: 7, rowGap: 16, colGap: 16 },
  },
  {
    ja: '写真の敷き詰め（dense）', en: 'Photo mosaic (dense)', mode: 'grid',
    grid: { cols: ['1fr', '1fr', '1fr', '1fr'], rows: ['120px', '120px'], useAreas: false, autoFit: false, flow: 'row dense', count: 8, rowGap: 8, colGap: 8 },
    items: { 0: { cspan: 2, rspan: 2 }, 3: { cspan: 2 } },
  },
  {
    ja: '縦に積んで下端へ1つ', en: 'Stack with one at the bottom', mode: 'flex',
    flex: { direction: 'column', wrap: 'nowrap', justify: 'flex-start', alignItems: 'stretch', rowGap: 10, colGap: 10, count: 4, height: 300, varied: false },
    items: { 3: { self: 'flex-end' } },
  },
];

// プリセットの呼び名（PRESETS と同じ並び）
export const PRESET_IDS = ['center-row', 'header', 'card-row', 'sidebar', 'holy-grail', 'auto-fit', 'mosaic', 'stack-bottom'];

/** site の applyPreset のうち状態を書き換える部分（画面の同期・タブ切替を除く） */
export function applyPreset(state, p) {
  state.mode = p.mode;
  if (p.flex) Object.assign(state.flex, p.flex);
  if (p.grid) Object.assign(state.grid, JSON.parse(JSON.stringify(p.grid)));
  const st = p.mode === 'flex' ? state.flex : state.grid;
  st.items = st.items.map(() => DEF_ITEM());
  if (p.items) {
    for (const key of Object.keys(p.items)) {
      if (key === 'all') st.items = st.items.map((it) => Object.assign(it, p.items.all));
      else Object.assign(st.items[Number(key)], p.items[key]);
    }
  }
  st.sel = 0;
  return state;
}

/* ==================== MCP ツール ==================== */

export class CssLayoutError extends Error {}

// site のフォーム（select の選択肢・range の範囲）と同じ値域
export const CL_CHOICES = {
  display: ['flex', 'inline-flex'],
  direction: ['row', 'row-reverse', 'column', 'column-reverse'],
  wrap: ['nowrap', 'wrap', 'wrap-reverse'],
  flexJustify: ['flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly'],
  flexAlignItems: ['stretch', 'flex-start', 'flex-end', 'center', 'baseline'],
  flexAlignContent: ['stretch', 'flex-start', 'flex-end', 'center', 'space-between', 'space-around', 'space-evenly'],
  basis: ['auto', '0', '0%', '25%', '33.333%', '50%', '100%', '120px', '200px', '240px', 'min-content', 'max-content'],
  self: ['auto', 'stretch', 'flex-start', 'flex-end', 'center', 'baseline'],
  flow: ['row', 'column', 'row dense', 'column dense'],
  justifyItems: ['stretch', 'start', 'end', 'center'],
  gridAlignItems: ['stretch', 'start', 'end', 'center'],
  gridContent: ['start', 'end', 'center', 'space-between', 'space-around', 'space-evenly', 'stretch'],
};
const RANGES = {
  gap: [0, 80], flexCount: [1, 8], gridCount: [1, 12], grow: [0, 5], shrink: [0, 5], order: [-2, 2],
  span: [1, 6], autoFitMin: [80, 400], tracks: [1, 12],
};
// トラックの値は site の一覧にある値のほか、URLパラメータと同じく自由に書ける。ただし宣言を壊す文字は通さない
const TRACK_RE = /^[^;{}<>"'\n\r\\]{1,60}$/;
const BASIS_RE = /^(?:0|\d+(?:\.\d+)?(?:px|%|rem|em|vw|vh|ch))$/;

function oneOf(name, v, list) {
  if (list.indexOf(v) === -1) throw new CssLayoutError(`${name} は ${list.join(' / ')} のどれか: ${v}`);
  return v;
}
function intIn(name, v, [lo, hi]) {
  if (!Number.isInteger(v) || v < lo || v > hi) throw new CssLayoutError(`${name} は ${lo}〜${hi} の整数: ${v}`);
  return v;
}
function trackList(name, v) {
  if (!Array.isArray(v) || v.length < RANGES.tracks[0] || v.length > RANGES.tracks[1]) {
    throw new CssLayoutError(`${name} は1〜12本のトラックの配列で渡してください（例: ["240px", "minmax(0, 1fr)"]）`);
  }
  return v.map((t) => {
    const s = String(t).trim();
    if (!TRACK_RE.test(s)) throw new CssLayoutError(`${name} に使えない値: ${t}`);
    return s;
  });
}

/**
 * Flexbox / CSS Grid の CSS と HTML を組み立てる。
 * 既定の状態（site を開いたときと同じ）→ preset → 個別の指定、の順に重ねる。
 */
export async function cssLayoutGenerateTool(opts = {}) {
  const lang = opts.lang || 'ja';
  if (lang !== 'ja' && lang !== 'en') throw new CssLayoutError(`lang は ja か en: ${opts.lang}`);
  const T = CL_TEXT[lang];

  if (opts.mode === 'presets') {
    return {
      presets: PRESETS.map((p, i) => {
        const r = cssLayoutBuild(applyPreset(defaultState(), p), p.mode === 'grid' && p.grid && p.grid.useAreas ? p.grid.areas : null, T);
        return { id: PRESET_IDS[i], name: lang === 'en' ? p.en : p.ja, mode: p.mode, css: r.css, html: r.html };
      }),
    };
  }

  const state = defaultState();
  let areasText = null;
  if (opts.preset !== undefined) {
    const i = PRESET_IDS.indexOf(opts.preset);
    if (i === -1) throw new CssLayoutError(`preset は ${PRESET_IDS.join(' / ')} のどれか: ${opts.preset}`);
    applyPreset(state, PRESETS[i]);
    if (state.mode === 'grid' && state.grid.useAreas) areasText = state.grid.areas;
  }
  const gridHints = opts.columns !== undefined || opts.rows !== undefined || opts.areas !== undefined || opts.autoFit !== undefined;
  let mode = opts.mode;
  if (mode === undefined) mode = opts.preset !== undefined ? state.mode : gridHints ? 'grid' : 'flex';
  oneOf('mode', mode, ['flex', 'grid', 'presets']);
  state.mode = mode;
  const isFlex = mode === 'flex';
  const st = isFlex ? state.flex : state.grid;

  if (opts.gap !== undefined) st.rowGap = st.colGap = intIn('gap', opts.gap, RANGES.gap);
  if (opts.rowGap !== undefined) st.rowGap = intIn('rowGap', opts.rowGap, RANGES.gap);
  if (opts.colGap !== undefined) st.colGap = intIn('colGap', opts.colGap, RANGES.gap);
  if (opts.count !== undefined) st.count = intIn('count', opts.count, isFlex ? RANGES.flexCount : RANGES.gridCount);

  if (isFlex) {
    const f = state.flex;
    if (opts.display !== undefined) f.display = oneOf('display', opts.display, CL_CHOICES.display);
    if (opts.direction !== undefined) f.direction = oneOf('direction', opts.direction, CL_CHOICES.direction);
    if (opts.wrap !== undefined) f.wrap = oneOf('wrap', opts.wrap, CL_CHOICES.wrap);
    if (opts.justifyContent !== undefined) f.justify = oneOf('justifyContent', opts.justifyContent, CL_CHOICES.flexJustify);
    if (opts.alignItems !== undefined) f.alignItems = oneOf('alignItems', opts.alignItems, CL_CHOICES.flexAlignItems);
    if (opts.alignContent !== undefined) f.alignContent = oneOf('alignContent', opts.alignContent, CL_CHOICES.flexAlignContent);
    for (const k of ['columns', 'rows', 'areas', 'autoFit', 'autoFitMin', 'flow', 'justifyItems']) {
      if (opts[k] !== undefined) throw new CssLayoutError(`${k} は mode="grid" の指定です`);
    }
  } else {
    const g = state.grid;
    if (opts.columns !== undefined) { g.cols = trackList('columns', opts.columns); g.autoFit = false; }
    if (opts.rows !== undefined) g.rows = trackList('rows', opts.rows);
    if (opts.autoFit !== undefined) g.autoFit = !!opts.autoFit;
    if (opts.autoFitMin !== undefined) g.autoFitMin = intIn('autoFitMin', opts.autoFitMin, RANGES.autoFitMin);
    if (opts.flow !== undefined) g.flow = oneOf('flow', opts.flow, CL_CHOICES.flow);
    if (opts.justifyItems !== undefined) g.justifyItems = oneOf('justifyItems', opts.justifyItems, CL_CHOICES.justifyItems);
    if (opts.alignItems !== undefined) g.alignItems = oneOf('alignItems', opts.alignItems, CL_CHOICES.gridAlignItems);
    if (opts.justifyContent !== undefined) g.justifyContent = oneOf('justifyContent', opts.justifyContent, CL_CHOICES.gridContent);
    if (opts.alignContent !== undefined) g.alignContent = oneOf('alignContent', opts.alignContent, CL_CHOICES.gridContent);
    if (opts.areas !== undefined) {
      if (typeof opts.areas !== 'string') throw new CssLayoutError('areas は文字列（行を改行か " / " で区切る）で渡してください');
      // site の URLパラメータ areas と同じく「/」も行の区切りとして読む
      areasText = opts.areas.replace(/\s*\/\s*/g, '\n');
      g.areas = areasText;
      g.useAreas = true;
    }
    for (const k of ['display', 'direction', 'wrap']) {
      if (opts[k] !== undefined) throw new CssLayoutError(`${k} は mode="flex" の指定です`);
    }
  }

  if (opts.items !== undefined) {
    if (!Array.isArray(opts.items)) throw new CssLayoutError('items は子要素ごとの指定の配列で渡してください');
    if (opts.items.length > st.items.length) throw new CssLayoutError(`items は ${st.items.length} 件まで`);
    opts.items.forEach((raw, i) => {
      if (raw === null || raw === undefined) return;
      const it = st.items[i];
      if (isFlex) {
        if (raw.grow !== undefined) it.grow = intIn(`items[${i}].grow`, raw.grow, RANGES.grow);
        if (raw.shrink !== undefined) it.shrink = intIn(`items[${i}].shrink`, raw.shrink, RANGES.shrink);
        if (raw.basis !== undefined) {
          const b = String(raw.basis).trim();
          if (CL_CHOICES.basis.indexOf(b) === -1 && !BASIS_RE.test(b)) throw new CssLayoutError(`items[${i}].basis に使えない値: ${raw.basis}`);
          it.basis = b;
        }
        if (raw.alignSelf !== undefined) it.self = oneOf(`items[${i}].alignSelf`, raw.alignSelf, CL_CHOICES.self);
        if (raw.order !== undefined) it.order = intIn(`items[${i}].order`, raw.order, RANGES.order);
      } else {
        if (raw.columnSpan !== undefined) it.cspan = intIn(`items[${i}].columnSpan`, raw.columnSpan, RANGES.span);
        if (raw.rowSpan !== undefined) it.rspan = intIn(`items[${i}].rowSpan`, raw.rowSpan, RANGES.span);
      }
    });
  }

  const r = cssLayoutBuild(state, state.mode === 'grid' && state.grid.useAreas ? areasText ?? state.grid.areas : null, T);
  const hints = {};
  if (isFlex) {
    const f = state.flex;
    hints['flex-direction'] = f.direction === 'row' ? T.dirRow : f.direction === 'row-reverse' ? T.dirRowRev : f.direction === 'column' ? T.dirCol : T.dirColRev;
    hints['flex-wrap'] = valHint('flex-wrap', f.wrap, lang);
    hints['justify-content'] = valHint('justify-content', f.justify, lang);
    hints['align-items'] = valHint('align-items', f.alignItems, lang);
    hints['align-content'] = valHint('align-content', f.alignContent, lang);
  } else {
    const g = state.grid;
    hints['grid-auto-flow'] = valHint('grid-auto-flow', g.flow, lang);
    hints['justify-items'] = valHint('justify-items', g.justifyItems, lang);
    hints['align-items'] = valHint('align-items', g.alignItems, lang);
    hints['justify-content'] = valHint('justify-content', g.justifyContent, lang);
    hints['align-content'] = valHint('align-content', g.alignContent, lang);
  }
  return { mode: state.mode, ...(opts.preset !== undefined ? { preset: opts.preset } : {}), ...r, hints };
}

/** site の render() のうち、CSS・HTML・集計・指摘を作る部分（プレビューの描画と行数の実測を除く） */
export function cssLayoutBuild(state, areasText, T) {
  const mode = state.mode;
  const area = mode === 'grid' && state.grid.useAreas ? parseAreas(areasText ?? '', T) : null;
  const drawArea = area && !area.error ? area : null;
  const css = buildCss(state, drawArea);
  const html = buildHtml(state, drawArea);
  const st = mode === 'flex' ? state.flex : state.grid;
  const diag = diagnose(state, mode === 'grid' && state.grid.useAreas ? (area || {}) : null, T);
  return {
    css,
    html,
    items: drawArea ? drawArea.names.length : st.count,
    declarations: (mode === 'flex' ? flexDecls(state) : gridDecls(state, drawArea)).length,
    css_length: css.length,
    ...(mode === 'grid'
      ? { tracks: drawArea ? `${drawArea.rows}×${drawArea.cols}` : state.grid.autoFit ? 'auto-fit' : state.grid.cols.length }
      : {}),
    ...(area ? { areas: area.error ? { error: area.error } : { rows: area.rows, cols: area.cols, names: area.names } } : {}),
    notes: diag.map((d) => ({ level: d.kind, message: d.text })),
  };
}
