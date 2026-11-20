/* 航空券・ESTAの名前とパスポートの見比べ（romaji_name_check）
 * 照合のコアは FirstCHTools の site/romaji/lib.mjs と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルの「ここからコア」〜「ここまでコア」はバイト一致する（どちらも ES module）:
 *   diff <(sed -n '/^\/\/ =* ここから/,/^\/\/ =* ここまで/p' site/romaji/lib.mjs) <(sed -n '/^\/\/ =* ここから/,/^\/\/ =* ここまで/p' romaji-name.mjs)
 *
 * パスポートに印字された姓・名と、書類ごとのつづり（最大6つ）を1文字ずつ並べ、書類ごとに一致か違いありと、
 * 違いの位置と種類を返す。仮名からローマ字は作らず、搭乗や申請の可否も返さない。完全ローカル処理・ネットワーク送信なし。 */

// ==================== ここからコア ====================
// パスポートに印字された姓・名（利用者が打った基準）と、書類ごとのつづりを1文字ずつ並べて違いを探す。
// 仮名からローマ字は作らない。大文字と小文字の違い・全角と半角の違いは同じとみなす。
// 搭乗や申請の可否は返さない（違いの位置と種類だけ）。
export const MAX_DOCS = 6;
export const MAX_LEN = 80;
export const STATUSES = ['have', 'unknown', 'never'];   // 手元にある／取得したが表記不明・紛失／取得したことがない
export const TITLES = ['MR', 'MRS', 'MS', 'MISS', 'MSTR', 'MSTER', 'MX', 'DR', 'PROF', 'SIR', 'MADAM'];
export const KINDS = ['swap', 'sep', 'ou', 'nm', 'lookalike', 'drop', 'add', 'sub', 'title', 'extra_word', 'nonlatin'];
export const KIND_LABEL = {
  ja: {
    swap: '姓と名の入れ替え', sep: '空白・ハイフンの有無', ou: 'OとUの違い', nm: 'B・M・Pの前のNとM',
    lookalike: '似た字', drop: '文字の欠落', add: '文字の追加', sub: '違う字', title: '敬称の混入',
    extra_word: 'ミドルネーム欄などの余分な語', nonlatin: 'ローマ字以外の文字',
  },
  en: {
    swap: 'Surname and given name swapped', sep: 'Space or hyphen', ou: 'O vs U', nm: 'N vs M before B, M or P',
    lookalike: 'Look-alike character', drop: 'Missing letter', add: 'Extra letter', sub: 'Different letter', title: 'Title mixed in',
    extra_word: 'Extra word (middle-name field etc.)', nonlatin: 'Non-Latin character',
  },
};
const LOOKALIKE = ['0O', '0Q', '0D', '1I', '1L', 'IL', '5S', '8B', '2Z', '6G', 'UV'];   // 各組は字の順に並べて書く（classify が並べ替えた2字で引く）
const isSep = (c) => c === ' ' || c === '-';
const isLatin = (c) => /^[A-Z0-9 '\-.]$/.test(c);

export class RomajiError extends Error {
  constructor(code, message) { super(message); this.code = code; }
}

// NFKC（全角→半角）→大文字→空白をそろえる。wide=全角の英字・空白が入っていた
export function norm(s) {
  const raw = String(s == null ? '' : s);
  const wide = /[！-～　]/.test(raw);
  const text = raw.normalize('NFKC').toUpperCase().replace(/[\s ]+/g, ' ').trim().slice(0, MAX_LEN);
  return { text, wide };
}
const compact = (s) => s.replace(/[\s\-'.]/g, '');

// 書類のつづり: 「姓/名」「姓,名」なら区切りの前を姓とみなす。前後の敬称（MR・MS など）は外して記録する
export function splitDoc(text) {
  let t = text;
  let slash = -1;
  const m = /[\/,]/.exec(t);
  if (m) { slash = m.index; t = (t.slice(0, m.index) + ' ' + t.slice(m.index + 1)).replace(/ +/g, ' ').trim(); }
  const words = t.split(' ').filter(Boolean);
  const titles = [];
  const isTitle = (w) => TITLES.includes(w.replace(/\.$/, ''));
  while (words.length > 1 && isTitle(words[words.length - 1])) titles.unshift(words.pop());
  while (words.length > 1 && isTitle(words[0])) titles.unshift(words.shift());
  return { body: words.join(' '), titles, slash: slash >= 0 };
}

// 文字単位の編集距離と、その並べ方（同じ字・置き換え・欠落・追加）
export function align(a, b) {
  const n = a.length, m = b.length;
  const D = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) D[i][0] = i;
  for (let j = 0; j <= m; j++) D[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      D[i][j] = Math.min(D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1), D[i - 1][j] + 1, D[i][j - 1] + 1);
    }
  }
  const ops = [];
  let i = n, j = m;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && D[i][j] === D[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)) {
      ops.push({ op: a[i - 1] === b[j - 1] ? 'eq' : 'sub', a: a[i - 1], b: b[j - 1], ai: i - 1, bi: j - 1 }); i--; j--;
    } else if (i > 0 && D[i][j] === D[i - 1][j] + 1) {
      ops.push({ op: 'del', a: a[i - 1], b: '', ai: i - 1, bi: j }); i--;
    } else {
      ops.push({ op: 'ins', a: '', b: b[j - 1], ai: i, bi: j - 1 }); j--;
    }
  }
  return { dist: D[n][m], ops: ops.reverse() };
}

// 基準の文字列と、各文字が姓・名の何文字目か（空白・ハイフンは数えない）
// 姓か名の片方が空なら、間の空白を置かずにもう片方だけを基準にする
function baseLine(first, second, firstPart, secondPart) {
  const both = !!first && !!second;
  const text = both ? first + ' ' + second : first + second;
  const where = [];
  let k = 0;
  for (const c of first) { where.push(isSep(c) ? null : { part: firstPart, pos: ++k }); }
  if (both) where.push({ part: 'between', pos: 0 });
  k = 0;
  for (const c of second) { where.push(isSep(c) ? null : { part: secondPart, pos: ++k }); }
  return { text, where };
}

function classify(ops, base, doc) {
  const diffs = [];
  const baseMark = new Array(base.text.length).fill(null);
  const docMark = new Array(doc.length).fill(null);
  // 位置の言い方: 置き換え・欠落は基準のその字、追加は直前の基準の字の後ろ
  const posAfter = (ai) => {
    for (let k = ai - 1; k >= 0; k--) {
      const w = base.where[k];
      if (w) return w.part === 'between' ? w : { ...w, after: true };
    }
    return { part: null, pos: 0, after: true };
  };
  const posAt = (ai) => base.where[ai] || posAfter(ai);
  let k = 0;
  while (k < ops.length) {
    const o = ops[k];
    if (o.op === 'eq') { k++; continue; }
    if (o.op === 'sub') {
      const pair = [o.a, o.b].sort().join('');
      const nextA = base.text[o.ai + 1] || '', nextB = doc[o.bi + 1] || '';
      let kind = 'sub';
      if (isSep(o.a) && isSep(o.b)) kind = 'sep';
      else if (pair === 'OU') kind = 'ou';
      else if (pair === 'MN' && (/[BMP]/.test(nextA) || /[BMP]/.test(nextB))) kind = 'nm';
      else if (LOOKALIKE.includes(pair)) kind = 'lookalike';
      diffs.push({ kind, from: o.a, to: o.b, baseAt: o.ai, docAt: o.bi, len: 1, where: posAt(o.ai) });
      baseMark[o.ai] = kind; docMark[o.bi] = kind;
      k++; continue;
    }
    // 同じ向きの欠落・追加は1つにまとめる
    let e = k;
    while (e + 1 < ops.length && ops[e + 1].op === o.op) e++;
    const run = ops.slice(k, e + 1);
    const chars = run.map((r) => (o.op === 'del' ? r.a : r.b)).join('');
    const prev = o.op === 'del' ? base.text[o.ai - 1] || '' : doc[o.bi - 1] || '';
    const next = o.op === 'del' ? base.text[o.ai + run.length] || '' : doc[o.bi + run.length] || '';
    let kind;
    if ([...chars].every(isSep)) kind = 'sep';
    else if (chars.length === 1 && ((/[OU]/.test(chars) && prev === 'O') || (chars === 'O' && next === 'O'))) kind = 'ou';
    else if (o.op === 'ins' && compact(chars).length >= 2 && (isSep(chars[0]) || prev === '' || prev === ' ') && (isSep(chars[chars.length - 1]) || next === '' || next === ' ')) kind = 'extra_word';
    else kind = o.op === 'del' ? 'drop' : 'add';
    if (o.op === 'del') {
      diffs.push({ kind, from: chars, to: '', baseAt: o.ai, docAt: o.bi, len: chars.length, where: posAt(o.ai) });
      for (const r of run) baseMark[r.ai] = kind;
    } else {
      diffs.push({ kind, from: '', to: chars, baseAt: o.ai, docAt: o.bi, len: chars.length, where: posAfter(o.ai) });
      for (const r of run) docMark[r.bi] = kind;
    }
    k = e + 1;
  }
  return { diffs, baseMark, docMark };
}

// 1つの書類のつづりを基準と比べる
export function compareOne(surname, given, docText) {
  const S = norm(surname).text, G = norm(given).text;
  const d = norm(docText);
  if (!d.text) return { verdict: 'empty', text: '', wide: false, order: null, titles: [], diffs: [], base: '', baseMark: [], docMark: [], ops: [] };
  const sp = splitDoc(d.text);
  const body = sp.body;
  // ローマ字以外の文字（仮名・漢字など）があれば、並べて比べずにその字だけを示す
  if ([...body].some((ch) => !isLatin(ch))) {
    const docMark = [...body].map((ch) => (isLatin(ch) ? null : 'nonlatin'));
    const bad = [...new Set([...body].filter((ch) => !isLatin(ch)))].join('');
    return { verdict: 'diff', text: body, wide: d.wide, order: null, titles: sp.titles,
      diffs: [{ kind: 'nonlatin', from: '', to: bad, baseAt: -1, docAt: body.search(/[^A-Z0-9 '\-.]/), len: bad.length, where: null }],
      base: (S + ' ' + G).trim(), baseMark: [], docMark, ops: [] };
  }
  const sg = baseLine(S, G, 'surname', 'given');
  const gs = baseLine(G, S, 'given', 'surname');
  const straight = align(sg.text, body);
  // 姓と名を逆に並べた方が近ければ入れ替えとみなし、入れ替えた基準で残りの違いを探す
  const swapped = S !== G && compact(S) && compact(G) ? align(gs.text, body) : null;
  const useSwap = swapped && swapped.dist < straight.dist && compact(body) !== compact(sg.text);
  const base = useSwap ? gs : sg;
  const ops = (useSwap ? swapped : straight).ops;
  const c = classify(ops, base, body);
  const diffs = [];
  if (useSwap) diffs.push({ kind: 'swap', from: '', to: '', baseAt: -1, docAt: -1, len: 0, where: null });
  for (const t of sp.titles) diffs.push({ kind: 'title', from: '', to: t, baseAt: -1, docAt: -1, len: t.length, where: null });
  diffs.push(...c.diffs);
  return {
    verdict: diffs.length ? 'diff' : 'match', text: body, wide: d.wide, order: useSwap ? 'given-first' : 'surname-first',
    titles: sp.titles, diffs, base: base.text, baseMark: c.baseMark, docMark: c.docMark,
    ops: ops.map((o) => ({ op: o.op, a: o.a, b: o.b, ai: o.ai, bi: o.bi })),
  };
}

// 全体: パスポートの状態・別名併記や改姓の有無と、書類（最大6つ）
export function checkNames(input) {
  const o = input && typeof input === 'object' ? input : {};
  const status = STATUSES.includes(o.status) ? o.status : 'have';
  const review = !!o.review;
  const S = norm(o.surname), G = norm(o.given);
  const base = { surname: S.text, given: G.text, text: (S.text + ' ' + G.text).trim(), wide: S.wide || G.wide,
    nonLatin: [...(S.text + G.text)].some((ch) => !isLatin(ch)) };
  if (status !== 'have') return { status, review, base, rows: [] };
  const docs = Array.isArray(o.docs) ? o.docs.slice(0, MAX_DOCS) : [];
  const rows = docs.map((x, i) => {
    const label = String((x && x.label) || '').trim().slice(0, 40) || String(i + 1);
    const r = base.text ? compareOne(S.text, G.text, x && x.text) : { verdict: 'empty', text: '', diffs: [], base: '', baseMark: [], docMark: [], titles: [], order: null, wide: false, ops: [] };
    return { label, ...r, verdict: review && r.verdict !== 'empty' ? 'review' : r.verdict };
  });
  return { status, review, base, rows };
}

// 違い1件の位置の言い方（姓の3文字目・名の2文字目の後ろ・先頭）
export function whereText(w, lang = 'ja') {
  if (!w) return '';
  const part = w.part === 'surname' ? (lang === 'en' ? 'surname' : '姓') : w.part === 'given' ? (lang === 'en' ? 'given name' : '名') : '';
  if (w.part === 'between') return lang === 'en' ? 'between surname and given name' : '姓と名の間';
  if (!part) return lang === 'en' ? 'at the start' : '先頭';
  if (lang === 'en') return w.after ? `after letter ${w.pos} of the ${part}` : `letter ${w.pos} of the ${part}`;
  return w.after ? `${part}の${w.pos}文字目の後ろ` : `${part}の${w.pos}文字目`;
}

// 違い1件の短い説明（種類・位置・字）
export function diffText(d, lang = 'ja') {
  const L = KIND_LABEL[lang === 'en' ? 'en' : 'ja'];
  const label = L[d.kind] || d.kind;
  if (d.kind === 'swap') return label;
  if (d.kind === 'title') return `${label} (${d.to})`;
  if (d.kind === 'nonlatin') return `${label}: ${d.to}`;
  const at = whereText(d.where, lang);
  const SEP = lang === 'en' ? { ' ': 'space', '-': 'hyphen' } : { ' ': '空白', '-': 'ハイフン' };
  const sp = (s) => ([...s].every(isSep) ? [...s].map((c) => SEP[c]).join('+') : s.trim());
  let what;
  if (d.from && d.to) what = `${sp(d.from)} → ${sp(d.to)}`;
  else if (d.from) what = lang === 'en' ? `${sp(d.from)} missing` : `${sp(d.from)} が無い`;
  else what = lang === 'en' ? `extra ${sp(d.to)}` : `${sp(d.to)} が余分`;
  return lang === 'en' ? `${label}: ${what}, ${at}` : `${label}: ${at} ${what}`;
}

// 名前を伏せた表示: 語の頭文字と違いのある位置だけ残し、ほかは「•」
export function maskLine(text, marks) {
  let out = '';
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    const head = i === 0 || isSep(text[i - 1]);
    out += isSep(c) || head || (marks && marks[i]) ? c : '•';
  }
  return out;
}
// ==================== ここまでコア ====================

// ---- MCP の入口 ----
const NOTES = {
  ja: {
    unknown: '基準未確認: パスポートの表記は戸籍の変更が無い限り原則として変えられないため、前に取ったパスポートの表記が基準になる。申請した旅券窓口で確かめてから照合する。',
    never: '対象外: このツールはパスポートに印字された表記を基準にする。これから取る場合の表記の決まりは旅券窓口の資料（ヘボン式）を見る。',
    review: '別名併記・改姓ありのため、全行を要確認とした。どの表記を入れるかは旅券窓口や予約先で確かめる。',
    airline: '名前の入力の決まり（ミドルネーム・敬称の欄など）は航空会社ごとに違う。予約する航空会社の案内で確かめる。',
    mynumber: 'マイナンバーカードに書いたローマ字は、原則として削除できない（豊島区）。',
  },
  en: {
    unknown: 'Reference not confirmed: a Japanese passport spelling generally cannot change unless the family register changes, so the earlier passport sets the spelling. Check it with the passport office before comparing.',
    never: 'Not covered: this check uses the spelling printed in a passport. For the rules used when applying, see the passport office guides (Hepburn).',
    review: 'The passport shows an alias or the surname changed, so every row is marked for checking. Ask the passport office or the booking site which spelling to use.',
    airline: 'Name entry rules (middle names, title fields and so on) differ by airline. Check the guide of the airline you book with.',
    mynumber: 'Romaji added to a My Number Card generally cannot be removed (Toshima City).',
  },
};
export const SOURCES = [
  'https://www.pref.fukuoka.lg.jp/uploaded/attachment/107685.pdf',
  'https://www.pref.osaka.lg.jp/o070140/passport/top/romaji.html',
  'https://www.city.toshima.lg.jp/096/tetsuzuki/mynumber/2606031703.html',
  'https://www.kojinbango-card.go.jp/260515_2/',
];

export function romajiNameTool(opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'ja';
  const status = opts.status == null ? 'have' : opts.status;
  if (!STATUSES.includes(status)) throw new RomajiError('BAD_STATUS', `status must be one of ${STATUSES.join(', ')}`);
  if (status === 'have' && !norm(opts.surname).text && !norm(opts.given).text) throw new RomajiError('NO_NAME', 'surname or given (as printed in the passport) is required');
  const docs = opts.documents == null ? [] : opts.documents;
  if (!Array.isArray(docs)) throw new RomajiError('BAD_DOCUMENTS', 'documents must be an array of { label, text }');
  if (docs.length > MAX_DOCS) throw new RomajiError('TOO_MANY', `documents: up to ${MAX_DOCS}`);
  const r = checkNames({ status, review: !!opts.review, surname: opts.surname, given: opts.given, docs: docs.map((d) => (typeof d === 'string' ? { text: d } : d)) });
  const N = NOTES[lang];
  const notes = [];
  if (status !== 'have') notes.push(N[status]);
  else {
    if (r.review) notes.push(N.review);
    notes.push(N.airline, N.mynumber);
  }
  return {
    status: r.status,
    stopped: status !== 'have',
    passport: r.base.text,
    passportNonLatin: r.base.nonLatin,
    documents: r.rows.map((row) => ({
      label: row.label,
      text: row.text,
      verdict: row.verdict,
      order: row.order,
      compared: row.base,
      differences: row.diffs.map((d) => ({
        kind: d.kind,
        label: KIND_LABEL[lang][d.kind],
        from: d.from,
        to: d.to,
        part: d.where ? d.where.part : null,
        position: d.where ? d.where.pos : null,
        after: !!(d.where && d.where.after),
        text: diffText(d, lang),
      })),
      fullWidth: row.wide,
    })),
    notes,
    sources: SOURCES,
  };
}
