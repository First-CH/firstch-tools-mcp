// テキスト・コード差分（diff_check）
// アルゴリズムは tools.first-ch.com/diff/ の site/diff/app.js と同一（site側が正本）。
//
// 行差分は patience diff（両方に1回だけ現れる行をアンカーにして分割）＋
// アンカーが取れない区間だけ Myers O(ND)。Myers は編集距離が MAX_D を超えたら
// その区間を丸ごと「削除＋追加」に落とす（巨大な無関係ファイル同士で固まらないため）。
// 変更行の対応付けができたペアだけ、さらにトークン単位の差分を取って
// 語（和文は1文字）単位の変更点を返す。

const MAX_D = 1200; // Myers の編集距離の上限
export const MAX_LINES = 50000; // 1入力あたりの行数上限

/** 比較用のキーへ正規化する（表示は常に元の行を使う） */
function normalize(line, opt) {
  let s = line;
  if (opt.ignoreWhitespace) s = s.replace(/\s+/g, ' ').trim();
  else if (opt.ignoreTrailing) s = s.replace(/[ \t]+$/, '');
  if (opt.ignoreCase) s = s.toLowerCase();
  return s;
}

/** 両方にちょうど1回だけ現れる行を拾い、b側の位置の最長増加部分列を返す（patience diff） */
function uniqueAnchors(a, b, a0, a1, b0, b1) {
  const ca = new Map();
  const cb = new Map();
  for (let i = a0; i < a1; i++) ca.set(a[i], (ca.get(a[i]) || 0) + 1);
  for (let j = b0; j < b1; j++) cb.set(b[j], (cb.get(b[j]) || 0) + 1);
  const posB = new Map();
  for (let j = b0; j < b1; j++) if (cb.get(b[j]) === 1) posB.set(b[j], j);
  const pairs = [];
  for (let i = a0; i < a1; i++) {
    if (ca.get(a[i]) !== 1) continue;
    const j = posB.get(a[i]);
    if (j !== undefined) pairs.push([i, j]);
  }
  if (!pairs.length) return [];
  // pairs は i の昇順。j の最長増加部分列（O(k log k)）
  const tail = [];
  const prev = new Int32Array(pairs.length).fill(-1);
  for (let k = 0; k < pairs.length; k++) {
    const j = pairs[k][1];
    let lo = 0;
    let hi = tail.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tail[mid]][1] < j) lo = mid + 1;
      else hi = mid;
    }
    if (lo > 0) prev[k] = tail[lo - 1];
    tail[lo] = k;
  }
  const out = [];
  let k = tail[tail.length - 1];
  while (k >= 0) {
    out.push(pairs[k]);
    k = prev[k];
  }
  return out.reverse();
}

/**
 * 行（またはトークン）の配列2本の差分を取る。
 * @returns {Array<{t:'='|'-'|'+', a:number, b:number}>} a/b は元配列の添字（無い側は -1）
 */
export function diffSeq(a, b) {
  const out = [];
  const push = (t, i, j) => out.push({ t, a: i, b: j });

  function myers(a0, a1, b0, b1) {
    const n = a1 - a0;
    const m = b1 - b0;
    const maxD = Math.min(n + m, MAX_D);
    const off = maxD;
    const v = new Int32Array(2 * maxD + 1);
    const trace = [];
    let found = -1;
    for (let d = 0; d <= maxD && found < 0; d++) {
      trace.push(v.slice());
      for (let k = -d; k <= d; k += 2) {
        let x;
        if (k === -d || (k !== d && v[off + k - 1] < v[off + k + 1])) x = v[off + k + 1];
        else x = v[off + k - 1] + 1;
        let y = x - k;
        while (x < n && y < m && a[a0 + x] === b[b0 + y]) { x++; y++; }
        v[off + k] = x;
        if (x >= n && y >= m) { found = d; break; }
      }
    }
    if (found < 0) {
      // 上限超過。この区間は「まるごと置き換え」として出す
      for (let i = a0; i < a1; i++) push('-', i, -1);
      for (let j = b0; j < b1; j++) push('+', -1, j);
      return;
    }
    const rev = [];
    let x = n;
    let y = m;
    for (let d = found; d > 0; d--) {
      const vp = trace[d];
      const k = x - y;
      const prevK = (k === -d || (k !== d && vp[off + k - 1] < vp[off + k + 1])) ? k + 1 : k - 1;
      const px = vp[off + prevK];
      const py = px - prevK;
      while (x > px && y > py) { x--; y--; rev.push(['=', a0 + x, b0 + y]); }
      if (x > px) { x--; rev.push(['-', a0 + x, -1]); }
      else if (y > py) { y--; rev.push(['+', -1, b0 + y]); }
    }
    while (x > 0 && y > 0) { x--; y--; rev.push(['=', a0 + x, b0 + y]); }
    for (let t = rev.length - 1; t >= 0; t--) push(rev[t][0], rev[t][1], rev[t][2]);
  }

  function middle(a0, a1, b0, b1) {
    if (a0 >= a1 && b0 >= b1) return;
    if (a0 >= a1) { for (let j = b0; j < b1; j++) push('+', -1, j); return; }
    if (b0 >= b1) { for (let i = a0; i < a1; i++) push('-', i, -1); return; }
    const anchors = uniqueAnchors(a, b, a0, a1, b0, b1);
    if (!anchors.length) { myers(a0, a1, b0, b1); return; }
    let ai = a0;
    let bi = b0;
    for (const [i, j] of anchors) {
      walk(ai, i, bi, j);
      push('=', i, j);
      ai = i + 1;
      bi = j + 1;
    }
    walk(ai, a1, bi, b1);
  }

  function walk(a0, a1, b0, b1) {
    while (a0 < a1 && b0 < b1 && a[a0] === b[b0]) { push('=', a0, b0); a0++; b0++; }
    let tail = 0;
    while (a1 - tail > a0 && b1 - tail > b0 && a[a1 - 1 - tail] === b[b1 - 1 - tail]) tail++;
    middle(a0, a1 - tail, b0, b1 - tail);
    for (let t = 0; t < tail; t++) push('=', a1 - tail + t, b1 - tail + t);
  }

  walk(0, a.length, 0, b.length);
  return out;
}

// 語（英数字の連なり）は1トークン、和文・記号は1文字ずつ。和文は分かち書きが無いため
// まとめると行全体が1トークンになり、単語ハイライトが機能しない
const TOKEN_RE = /[A-Za-z0-9_]+|\s+|[\s\S]/gu;
const tokenize = (s) => s.match(TOKEN_RE) || [];

/** 行を配列にする。末尾の改行だけの空行は落とす（差分に無意味な1行が出るため） */
export function splitLines(text) {
  const t = String(text).replace(/\r\n?/g, '\n');
  if (t === '') return [];
  const lines = t.split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

/** 隣り合う同種の断片をつなぐ（<del>,</del><del> </del>… と分かれると読みにくいため） */
function mergeParts(parts) {
  const out = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (last && last.c === p.c) last.s += p.s;
    else out.push({ c: p.c, s: p.s });
  }
  return out;
}

/** 削除行と追加行を上から順に対応づけ、似ている組だけトークン差分を持たせる */
function pairWords(del, ins, opt) {
  const n = Math.min(del.length, ins.length);
  for (let k = 0; k < n; k++) {
    const ta = tokenize(del[k].text);
    const tb = tokenize(ins[k].text);
    if (ta.length + tb.length > 4000) continue; // 極端に長い行は語差分を諦める（行単位で見せる）
    const ka = ta.map((s) => normalize(s, { ignoreWhitespace: false, ignoreCase: opt.ignoreCase }));
    const kb = tb.map((s) => normalize(s, { ignoreWhitespace: false, ignoreCase: opt.ignoreCase }));
    const ops = diffSeq(ka, kb);
    let same = 0;
    for (const o of ops) if (o.t === '=') same += ta[o.a].length;
    const len = Math.max(del[k].text.length, ins[k].text.length, 1);
    // 共通部分が少なすぎる組は「別の行」。無理に語ハイライトすると読めなくなる
    if (same / len < 0.3) continue;
    del[k].parts = mergeParts(ops.filter((o) => o.t !== '+').map((o) => ({ c: o.t === '=', s: ta[o.a] })));
    ins[k].parts = mergeParts(ops.filter((o) => o.t !== '-').map((o) => ({ c: o.t === '=', s: tb[o.b] })));
  }
}

/**
 * 差分を「ブロック」の列にまとめる。
 * blocks: {t:'equal', rows:[{a,b,text}]} | {t:'change', del:[{a,text,parts?}], ins:[{b,text,parts?}]}
 */
export function buildDiff(textA, textB, options) {
  const opt = Object.assign(
    { ignoreWhitespace: false, ignoreCase: false, ignoreTrailing: true, words: true },
    options,
  );
  const A = splitLines(textA);
  const B = splitLines(textB);
  const truncated = A.length > MAX_LINES || B.length > MAX_LINES;
  if (truncated) { A.length = Math.min(A.length, MAX_LINES); B.length = Math.min(B.length, MAX_LINES); }
  const ka = A.map((l) => normalize(l, opt));
  const kb = B.map((l) => normalize(l, opt));
  const ops = diffSeq(ka, kb);

  const blocks = [];
  const stats = { added: 0, removed: 0, changed: 0, same: 0 };
  let i = 0;
  while (i < ops.length) {
    if (ops[i].t === '=') {
      const rows = [];
      while (i < ops.length && ops[i].t === '=') { rows.push({ a: ops[i].a, b: ops[i].b, text: A[ops[i].a] }); i++; }
      stats.same += rows.length;
      blocks.push({ t: 'equal', rows });
      continue;
    }
    // 連続する非一致をひとまとめにする（'+' が '-' より先に来ることもあるため分けて集める）
    const del = [];
    const ins = [];
    while (i < ops.length && ops[i].t !== '=') {
      if (ops[i].t === '-') del.push({ a: ops[i].a, text: A[ops[i].a] });
      else ins.push({ b: ops[i].b, text: B[ops[i].b] });
      i++;
    }
    const paired = Math.min(del.length, ins.length);
    stats.changed += paired;
    stats.removed += del.length - paired;
    stats.added += ins.length - paired;
    if (opt.words) pairWords(del, ins, opt);
    blocks.push({ t: 'change', del, ins });
  }
  return { blocks, stats, truncated, linesA: A.length, linesB: B.length };
}

/** unified diff（.patch）を組み立てる。context は前後に残す同一行の数 */
export function toUnified(textA, textB, options, nameA, nameB, context) {
  const ctx = context == null ? 3 : context;
  const A = splitLines(textA);
  const B = splitLines(textB);
  const opt = Object.assign({ ignoreTrailing: true }, options);
  const ops = diffSeq(A.map((l) => normalize(l, opt)), B.map((l) => normalize(l, opt)));
  const changed = ops.map((o) => o.t !== '=');
  if (!changed.some(Boolean)) return '';
  // 変更点の前後 ctx 行を含む範囲をまとめてハンクにする
  const keep = new Array(ops.length).fill(false);
  for (let i = 0; i < ops.length; i++) {
    if (!changed[i]) continue;
    for (let j = Math.max(0, i - ctx); j <= Math.min(ops.length - 1, i + ctx); j++) keep[j] = true;
  }
  const out = [`--- ${nameA || 'a'}`, `+++ ${nameB || 'b'}`];
  let i = 0;
  while (i < ops.length) {
    if (!keep[i]) { i++; continue; }
    let end = i;
    while (end < ops.length && keep[end]) end++;
    let aStart = -1;
    let bStart = -1;
    let aCount = 0;
    let bCount = 0;
    const body = [];
    for (let k = i; k < end; k++) {
      const o = ops[k];
      if (o.a >= 0) { if (aStart < 0) aStart = o.a; aCount++; }
      if (o.b >= 0) { if (bStart < 0) bStart = o.b; bCount++; }
      body.push((o.t === '=' ? ' ' : o.t) + (o.t === '+' ? B[o.b] : A[o.a]));
    }
    out.push(`@@ -${aCount ? aStart + 1 : 0},${aCount} +${bCount ? bStart + 1 : 0},${bCount} @@`);
    out.push(...body);
    i = end;
  }
  return out.join('\n') + '\n';
}

/**
 * MCP `diff_check` の本体。2つのテキストを比較して統計・unified diff・変更ハンクを返す。
 * @param {string} a 変更前テキスト
 * @param {string} b 変更後テキスト
 * @param {object} opts { ignoreWhitespace, ignoreCase, words, context, format, nameA, nameB }
 */
export function diffCheck(a, b, opts = {}) {
  const options = {
    ignoreWhitespace: !!opts.ignoreWhitespace,
    ignoreCase: !!opts.ignoreCase,
    ignoreTrailing: true,
    words: opts.words !== false,
  };
  const format = opts.format || 'unified';
  const { blocks, stats, truncated, linesA, linesB } = buildDiff(a, b, options);
  const identical = blocks.every((blk) => blk.t === 'equal');
  const result = {
    identical,
    lines_a: linesA,
    lines_b: linesB,
    added: stats.added,
    removed: stats.removed,
    changed: stats.changed,
    unchanged: stats.same,
    ignore_whitespace: options.ignoreWhitespace,
    ignore_case: options.ignoreCase,
  };
  if (truncated) result.note = `各テキストの先頭 ${MAX_LINES} 行までを比較しました。`;
  if (identical) return result;

  if (format === 'unified' || format === 'both') {
    result.unified = toUnified(a, b, options, opts.nameA || 'a', opts.nameB || 'b', opts.context);
  }
  if (format === 'blocks' || format === 'both') {
    // 変更のあったブロックだけを、行番号（1始まり）と語単位の変更点つきで返す
    result.changes = blocks
      .filter((blk) => blk.t === 'change')
      .map((blk) => ({
        removed: blk.del.map((r) => ({
          line: r.a + 1,
          text: r.text,
          ...(r.parts ? { changed_parts: r.parts.filter((p) => !p.c).map((p) => p.s) } : {}),
        })),
        added: blk.ins.map((r) => ({
          line: r.b + 1,
          text: r.text,
          ...(r.parts ? { changed_parts: r.parts.filter((p) => !p.c).map((p) => p.s) } : {}),
        })),
      }));
  }
  return result;
}
