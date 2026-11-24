/* llms.txt の生成・取り込み・点検（llmstxt_generate）
 * 生成・取り込み・点検のコアは FirstCHTools の site/llms-txt/lib.mjs と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルの「ここからコア」〜「ここまでコア」はバイト一致する（どちらも ES module）:
 *   diff <(sed -n '/^\/\/ ===== ここから/,/^\/\/ ===== ここまで/p' site/llms-txt/lib.mjs) <(sed -n '/^\/\/ ===== ここから/,/^\/\/ ===== ここまで/p' llms-txt.mjs)
 *
 * 仕様は https://llmstxt.org/（H1 必須 → 引用ブロックの要約 → 見出し以外の本文 → H2 ごとのリンクの一覧・"Optional" は省いてよいリンク）。
 * タイトルの [ ] と URL の空白・括弧・\ を置き換え、同じ URL の2つ目以降・javascript: など・http(s) なのに読めない URL は
 * 出力から外して warnings で知らせる（相対 URL・mailto: などは出力したうえで注意）。
 * 完全ローカル処理・ネットワーク送信なし（sitemap も取りに行かない。中身を importText で渡す）。 */

// ===== ここからコア =====
export const LIMITS = { importRows: 2000, importChars: 5000000, lintChars: 500000 };

const ESCAPABLE = /[!-/:-@[-`{-~]/;
const UNSAFE_SCHEME = /^(?:javascript|vbscript|data|file):/i;

/** 改行・タブを空白1つにして前後を落とす（全角の空白はそのまま）。正規表現の後戻りを避けて分割で処理する */
export function oneLine(s) {
  return String(s ?? '').split(/[\r\n\t]/).map((x) => x.trim()).filter(Boolean).join(' ');
}

/** リンクの文字の \ [ ] を逃がす（Markdown のリンクが途中で切れないように） */
export function escapeLinkText(s) {
  return oneLine(s).replace(/[\\[\]]/g, (c) => '\\' + c);
}

/** URL の中の空白（全角・NBSP・BOM を含む）・括弧・<>"\・制御文字を UTF-8 の %XX にする（リンクの ( ) が途中で閉じないように） */
export function encodeLinkUrl(u) {
  return oneLine(u).replace(/[\s​﻿()<>"\\\x00-\x1f\x7f]/g, (c) =>
    encodeURIComponent(c).replace(/[()]/g, (p) => '%' + p.charCodeAt(0).toString(16).toUpperCase()));
}

/**
 * URL を確かめる。code:
 *   ok（http・https の絶対 URL）/ relative（相対 URL。/a・a/b・./a など）/ hostLike（https:// の無いドメインらしい形）/
 *   protocolRelative（// で始まる）/ otherScheme（mailto: など）/ unsafe（javascript: など）/ invalid（http(s) なのに読めない）/ empty。
 * key は重複を見るための形。
 */
export function checkUrl(u) {
  const s = encodeLinkUrl(u);
  if (!s) return { code: 'empty', key: '' };
  if (s.startsWith('//')) {
    try { return { code: 'protocolRelative', key: new URL('https:' + s).href }; } catch { return { code: 'invalid', key: s }; }
  }
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (UNSAFE_SCHEME.test(s)) return { code: 'unsafe', key: s };
    if (!/^https?:/i.test(s)) return { code: 'otherScheme', key: s };
    try {
      const x = new URL(s);
      if (!x.hostname || !/^https?:\/\//i.test(s)) return { code: 'invalid', key: s };
      return { code: 'ok', key: x.href };
    } catch {
      return { code: 'invalid', key: s };
    }
  }
  let key = s;
  try {
    const x = new URL(s, 'https://relative.invalid/');
    key = x.pathname + x.search + x.hash;
  } catch { /* 読めない相対 URL は文字のまま比べる */ }
  const head = s.slice(0, 300);
  const hostLike = /^(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}(?:[/:?#]|$)/i.test(head) && (/^www\./i.test(head) || /^[^/]+\.[a-z]{2,}\//i.test(head));
  return { code: hostLike ? 'hostLike' : 'relative', key };
}

const KEEP = { ok: true, relative: true, hostLike: true, protocolRelative: true, otherScheme: true };

function pathSegments(u) {
  try {
    const x = new URL(encodeLinkUrl(u), 'https://relative.invalid');
    return { host: x.host === 'relative.invalid' ? '' : x.host, segs: x.pathname.split('/').filter(Boolean) };
  } catch {
    return { host: '', segs: [] };
  }
}

function decodeSeg(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

function labelOf(s) {
  const t = decodeSeg(s).split(/[-_+\s]+/).filter(Boolean).join(' ');
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : '';
}

/** URL のパスから仮の題名を作る（/blog/llms-txt-guide/ → Llms txt guide・トップはホスト名） */
export function titleFromUrl(u) {
  const { host, segs } = pathSegments(u);
  const list = segs.map((s) => decodeSeg(s).replace(/\.(?:html?|php|aspx?|jsp|md|txt)$/i, ''));
  while (list.length && /^(?:index|default)$/i.test(list[list.length - 1])) list.pop();
  const label = list.length ? labelOf(list[list.length - 1]) : '';
  return label || host || oneLine(u);
}

/** パスの1階層目（/blog/abc/ → blog）。1階層しかないページ（/about/）は '' */
export function firstSegment(u) {
  const { segs } = pathSegments(u);
  return segs.length >= 2 ? decodeSeg(segs[0]) : '';
}

function decodeXml(s) {
  let t = String(s);
  const a = t.indexOf('<![CDATA[');
  if (a >= 0) {
    const b = t.indexOf(']]>', a);
    t = b >= 0 ? t.slice(a + 9, b) : t.slice(a + 9);
  }
  return t
    .replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|amp|lt|gt|quot|apos);/gi, (m, e) => {
      const k = e.toLowerCase();
      if (k === 'amp') return '&';
      if (k === 'lt') return '<';
      if (k === 'gt') return '>';
      if (k === 'quot') return '"';
      if (k === 'apos') return "'";
      const n = k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10);
      try { return String.fromCodePoint(n); } catch { return m; }
    })
    .trim();
}

// コメント（<!-- -->）を外す。正規表現の後戻りを避けて indexOf で進める
function stripXmlComments(src) {
  let out = '';
  let i = 0;
  for (;;) {
    const a = src.indexOf('<!--', i);
    if (a < 0) return out + src.slice(i);
    out += src.slice(i, a);
    const b = src.indexOf('-->', a + 4);
    if (b < 0) return out;
    i = b + 3;
  }
}

// <tag ...>中身</tag> を順に取り出す（tag は名前空間の接頭辞を含む。大文字・小文字は区別しない）
function xmlBlocks(src, tag) {
  const lower = src.toLowerCase();
  const open = '<' + tag.toLowerCase();
  const close = '</' + tag.toLowerCase();
  const out = [];
  let i = 0;
  while ((i = lower.indexOf(open, i)) >= 0) {
    const c = lower.charAt(i + open.length);
    if (c !== '>' && !/\s/.test(c)) { i += open.length; continue; }
    const gt = lower.indexOf('>', i);
    if (gt < 0) break;
    const end = lower.indexOf(close, gt);
    if (end < 0) break;
    out.push(src.slice(gt + 1, end));
    i = end + close.length;
  }
  return out;
}

function locOf(block, prefix) {
  const b = xmlBlocks(block, prefix + 'loc');
  return b.length ? decodeXml(b[0]) : '';
}

const looksLikeUrl = (s) => /^https?:\/\/\S+$/i.test(s) || /^\/\S*$/.test(s);
const unAngle = (s) => (/^<\S+>$/.test(s) ? s.slice(1, -1) : s);

/** 1行のリストの中身（行頭の「- 」を除いたもの）から [名前](url): 説明 を読む。読めなければ null */
export function parseLinkItem(s) {
  const str = String(s ?? '');
  if (str[0] !== '[') return null;
  let i = 1;
  let depth = 1;
  let text = '';
  for (; i < str.length; i++) {
    const c = str[i];
    if (c === '\\' && i + 1 < str.length && ESCAPABLE.test(str[i + 1])) { text += str[i + 1]; i++; continue; }
    if (c === '[') depth++;
    else if (c === ']' && --depth === 0) break;
    text += c;
  }
  if (depth !== 0 || str[i + 1] !== '(') return null;
  let j = i + 2;
  while (str[j] === ' ') j++;
  let url = '';
  let spaceInUrl = false;
  if (str[j] === '<') {
    const k = str.indexOf('>', j);
    if (k < 0) return null;
    url = str.slice(j + 1, k);
    j = k + 1;
    while (str[j] === ' ') j++;
    if (str[j] === '"' || str[j] === "'") {
      const q = str.indexOf(str[j], j + 1);
      if (q < 0) return null;
      j = q + 1;
      while (str[j] === ' ') j++;
    }
    if (str[j] !== ')') return null;
  } else {
    let pd = 1;
    let dest = '';
    for (; j < str.length; j++) {
      const c = str[j];
      if (c === '\\' && j + 1 < str.length) { dest += c + str[j + 1]; j++; continue; }
      if (c === '(') pd++;
      else if (c === ')' && --pd === 0) break;
      dest += c;
    }
    if (pd !== 0) return null;
    const d = dest.trim();
    const sp = d.search(/\s/);
    if (sp < 0) url = d;
    else {
      const extra = d.slice(sp).trim();
      if (/^(?:"[^"]*"|'[^']*'|\([^)]*\))$/.test(extra)) url = d.slice(0, sp);
      else { url = d; spaceInUrl = true; }
    }
  }
  const rest = str.slice(j + 1);
  let note = '';
  let noteFormat = true;
  if (/\S/.test(rest)) {
    const r = rest.trim();
    if (r[0] === ':') note = r.slice(1).trim();
    else { note = r; noteFormat = false; }
  }
  return { title: text.trim(), url, note, noteFormat, spaceInUrl };
}

/**
 * 貼り付けた sitemap.xml か URL の一覧（1行1URL・「URL<TAB>題名」・「- [題名](URL)」・「- URL」・「<URL>」）を読む。
 * kind: sitemap / sitemapindex（children に子の sitemap の URL）/ list / empty / tooLong。
 * 題名が無ければ titleFromUrl で仮に作る（guessed: true）。
 */
export function parseImport(text) {
  const out = { kind: 'empty', items: [], children: [], skipped: [], truncated: 0 };
  let src = String(text ?? '');
  if (src.length > LIMITS.importChars) { out.kind = 'tooLong'; return out; }
  src = src.replace(/^﻿/, '');
  if (!src.trim()) return out;
  const push = (url, title, note) => {
    const u = oneLine(url);
    if (out.items.length >= LIMITS.importRows) { out.truncated++; return; }
    const t = oneLine(title);
    out.items.push({ url: u, title: t || titleFromUrl(u), note: oneLine(note), guessed: !t });
  };
  const xml = /<[a-z?!]/i.test(src) ? stripXmlComments(src) : src;
  const ix = /<(?:([\w.-]+):)?sitemapindex[\s>]/i.exec(xml);
  if (ix) {
    const pre = ix[1] ? ix[1] + ':' : '';
    out.kind = 'sitemapindex';
    out.children = xmlBlocks(xml, pre + 'sitemap').map((b) => locOf(b, pre)).filter(Boolean);
    return out;
  }
  const us = /<(?:([\w.-]+):)?urlset[\s>]/i.exec(xml);
  if (us || (/<url[\s>]/i.test(xml) && /<loc[\s>]/i.test(xml))) {
    const pre = us && us[1] ? us[1] + ':' : '';
    out.kind = 'sitemap';
    for (const b of xmlBlocks(xml, pre + 'url')) {
      const u = locOf(b, pre);
      if (u) push(u, '', '');
    }
    return out;
  }
  out.kind = 'list';
  src.split(/\r\n?|\n/).forEach((raw, i) => {
    let line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('>')) return;
    const li = /^(?:[-*+]|\d{1,9}[.)])\s+(.*)$/.exec(line);
    if (li) {
      const p = parseLinkItem(li[1]);
      if (p && p.url) { push(p.url, p.title, p.note); return; }
      line = li[1].trim();
    }
    if (line.includes('\t')) {
      const cols = line.split('\t').map((c) => unAngle(c.trim())).filter(Boolean);
      const k = cols.findIndex(looksLikeUrl);
      if (k >= 0) { push(cols[k], cols.filter((_, n) => n !== k).join(' '), ''); return; }
    } else {
      const sp = line.search(/\s/);
      const first = unAngle(sp < 0 ? line : line.slice(0, sp));
      if (looksLikeUrl(first)) { push(first, sp < 0 ? '' : line.slice(sp + 1), ''); return; }
    }
    out.skipped.push({ line: i + 1, text: line.slice(0, 200) });
  });
  return out;
}

/**
 * 取り込んだ行をセクションへ振り分ける。byPath が真なら、パスの1階層目が同じページが2件以上ある階層を
 * 別のセクション（題名は階層名を読みやすくしたもの）にし、残りは defaultTitle へ入れる。返り値は [{ title, links, base? }]（base は defaultTitle の組）。
 * 階層名が optional のときは、仕様の「Optional」と取り違えないよう「/optional/」を見出しにする。
 */
export function groupImport(items, { byPath = false, defaultTitle = '' } = {}) {
  const base = { title: defaultTitle, links: [], base: true };
  if (!byPath) { base.links = items.slice(); return [base]; }
  const count = new Map();
  for (const it of items) {
    const seg = firstSegment(it.url);
    if (seg) count.set(seg, (count.get(seg) || 0) + 1);
  }
  const groups = new Map();
  for (const it of items) {
    const seg = firstSegment(it.url);
    if (seg && count.get(seg) >= 2) {
      if (!groups.has(seg)) {
        const label = labelOf(seg) || seg;
        groups.set(seg, { title: label.toLowerCase() === 'optional' ? `/${seg}/` : label, links: [] });
      }
      groups.get(seg).links.push(it);
    } else {
      base.links.push(it);
    }
  }
  return [base, ...groups.values()].filter((g) => g.links.length);
}

// 見出しの末尾の「 #」が閉じの記号として消えないよう、最後の # の並びを逃がす
function escapeHeading(t) {
  let j = t.length;
  while (j > 0 && t[j - 1] === '#') j--;
  if (j < t.length && (j === 0 || t[j - 1] === ' ' || t[j - 1] === '\t')) return t.slice(0, j) + '\\' + t.slice(j);
  return t;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})/;

// 本文の行頭の # と、文の直後の === / --- を見出しにならないよう逃がす（コードブロックの中は触らない）
function escapeBody(s) {
  const lines = s.split('\n');
  let fence = '';
  let prevText = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    const f = FENCE.exec(l);
    if (fence) {
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = '';
      prevText = false;
      continue;
    }
    if (f) { fence = f[1]; prevText = false; continue; }
    if (/^ {0,3}#{1,6}(?:[ \t]|$)/.test(l)) lines[i] = l.replace(/#/, '\\#');
    else if (prevText && /^ {0,3}(?:=+|-+)[ \t]*$/.test(l)) lines[i] = l.replace(/[=-]/, (c) => '\\' + c);
    prevText = /\S/.test(l);
  }
  return lines.join('\n');
}

/**
 * llms.txt を組み立てる。spec: { siteName, summary?, notes?, sections?: [{ title, links: [{ title, url, note? }] }] }
 * 返り値: { text, warnings: [{ section, row, code, level, dropped, ref? }], stats: { sections, links } }。
 * row が -1 の警告はセクションそのものへの指摘。dropped が真の行・セクションは出力に入れていない
 * （題名か URL の無い行・javascript: などの URL・http(s) なのに読めない URL・同じ URL の2つ目以降）。
 */
export function buildLlmsTxtDetailed(spec = {}) {
  const name = oneLine(spec.siteName);
  if (!name) throw new Error('siteName は必須です（siteName is required）');
  const parts = [`# ${escapeHeading(name)}`];
  const summary = String(spec.summary ?? '').replace(/\r\n?/g, '\n').trim();
  if (summary) {
    parts.push(summary.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `> ${l.replace(/^[>#]/, (c) => '\\' + c)}`).join('\n'));
  }
  const notes = String(spec.notes ?? '').replace(/\r\n?/g, '\n').trim();
  if (notes) parts.push(escapeBody(notes));
  const warnings = [];
  const warn = (section, row, code, level, dropped, ref) =>
    warnings.push(ref ? { section, row, code, level, dropped, ref } : { section, row, code, level, dropped });
  const seen = new Map();
  const titles = new Map();
  let linkCount = 0;
  let secCount = 0;
  (spec.sections || []).forEach((sec, si) => {
    const title = oneLine(sec && sec.title);
    const lines = [];
    let touched = false;
    ((sec && sec.links) || []).forEach((l, ri) => {
      const t = oneLine(l && l.title);
      const u = oneLine(l && l.url);
      const n = oneLine(l && l.note);
      if (!t && !u) { if (n) { touched = true; warn(si, ri, 'noUrl', 'warn', true); } return; }
      touched = true;
      if (!u) { warn(si, ri, 'noUrl', 'warn', true); return; }
      const chk = checkUrl(u);
      if (!KEEP[chk.code]) { warn(si, ri, chk.code, 'error', true); return; }
      if (!t) { warn(si, ri, 'noTitle', 'warn', true); return; }
      const prev = seen.get(chk.key);
      if (prev) { warn(si, ri, 'dupUrl', 'warn', true, prev); return; }
      seen.set(chk.key, { section: si, row: ri });
      if (chk.code !== 'ok') warn(si, ri, chk.code, 'warn', false);
      const enc = encodeLinkUrl(u);
      if (enc !== u) warn(si, ri, 'encoded', 'info', false);
      lines.push(`- [${escapeLinkText(t)}](${enc})${n ? ': ' + n : ''}`);
    });
    if (!lines.length) {
      if (title && touched) warn(si, -1, 'emptySection', 'warn', true);
      return;
    }
    if (!title) { warn(si, -1, 'noSectionTitle', 'warn', true); return; }
    const k = title.toLowerCase();
    if (titles.has(k)) warn(si, -1, 'dupSection', 'warn', false, { section: titles.get(k), row: -1 });
    else titles.set(k, si);
    parts.push(`## ${escapeHeading(title)}\n\n${lines.join('\n')}`);
    linkCount += lines.length;
    secCount++;
  });
  return { text: parts.join('\n\n') + '\n', warnings, stats: { sections: secCount, links: linkCount } };
}

/** 文字列だけを返す版（MCP の lib.mjs から公開している従来の関数） */
export function buildLlmsTxt(spec) {
  return buildLlmsTxtDetailed(spec).text;
}

// ATX 見出し（# 見出し）を読む。正規表現の後戻りを避けて手で読む。見出しでなければ null
function atxHeading(raw) {
  let i = 0;
  while (i < 3 && raw[i] === ' ') i++;
  let n = 0;
  while (raw[i + n] === '#') n++;
  if (n < 1 || n > 6) return null;
  const after = raw[i + n];
  if (after !== undefined && after !== ' ' && after !== '\t') return null;
  let t = raw.slice(i + n).trim();
  let j = t.length;
  while (j > 0 && t[j - 1] === '#') j--;
  if (j === 0) t = '';
  else if (j < t.length && (t[j - 1] === ' ' || t[j - 1] === '\t')) t = t.slice(0, j).trim();
  return { level: n, title: t };
}

const SETEXT = /^ {0,3}(=+|-+)[ \t]*$/;
const LIST_ITEM = /^( *)(?:[-*+]|\d{1,9}[.)])(?:[ \t]+(.*))?$/;

/**
 * 既存の llms.txt を仕様に照らして点検する。返り値:
 * { ok（error が無い）, issues: [{ line, code, level, ref?, detail? }], stats: { title, sections: [{ title, line, links }], links },
 *   spec（編集画面へ戻すための siteName・summary・notes・sections） }。line は1始まり（0はファイル全体）。
 * リストの字下げした続きの行・入れ子のリスト・山括弧の URL・Setext 形式の見出し（=== / ---）は Markdown どおりに読む。
 */
export function lintLlmsTxt(text) {
  const src = String(text ?? '');
  const issues = [];
  const add = (line, code, level, extra) => issues.push(Object.assign({ line, code, level }, extra || {}));
  const spec = { siteName: '', summary: '', notes: '', sections: [] };
  const stats = { title: '', sections: [], links: 0 };
  if (src.length > LIMITS.lintChars) {
    add(0, 'tooLong', 'error');
    return { ok: false, issues, stats, spec };
  }
  if (!src.trim()) {
    add(0, 'empty', 'error');
    return { ok: false, issues, stats, spec };
  }
  const lines = src.replace(/^﻿/, '').split(/\r\n?|\n/);
  let state = 'start';
  let h1Line = 0;
  let firstContent = 0;
  let summaryDone = false;
  let prevKind = '';
  let fence = '';
  let inItem = false;
  let cur = null;
  const quote = [];
  const body = [];
  const seenUrl = new Map();
  const seenSec = new Map();
  const heading = (ln, level, title) => {
    if (level === 1) {
      if (h1Line) { add(ln, 'multiH1', 'error', { ref: h1Line }); return; }
      h1Line = ln;
      if (ln !== firstContent) add(ln, 'h1NotFirst', 'error');
      if (!title) add(ln, 'emptyH1', 'error');
      stats.title = title;
      spec.siteName = title;
      if (state !== 'sections') state = 'afterH1';
    } else if (level === 2) {
      state = 'sections';
      if (!title) add(ln, 'emptySectionTitle', 'error');
      const k = title.toLowerCase();
      if (title && seenSec.has(k)) add(ln, 'dupSection', 'warn', { ref: seenSec.get(k) });
      else if (title) seenSec.set(k, ln);
      if (k === 'optional' && title !== 'Optional') add(ln, 'optionalCase', 'info');
      cur = { title, line: ln, links: 0 };
      stats.sections.push(cur);
      spec.sections.push({ title, links: [] });
    } else {
      add(ln, state === 'sections' ? 'subheading' : 'headingInBody', 'warn');
    }
  };
  const checkLink = (ln, p) => {
    cur.links++;
    stats.links++;
    if (!p.title) add(ln, 'emptyLinkText', 'warn');
    if (!p.noteFormat) add(ln, 'noteFormat', 'warn');
    if (p.spaceInUrl) add(ln, 'urlSpace', 'error');
    else {
      const chk = checkUrl(p.url);
      if (chk.code === 'empty') add(ln, 'emptyUrl', 'error');
      else if (chk.code === 'invalid') add(ln, 'badUrl', 'error', { detail: p.url.slice(0, 200) });
      else if (chk.code === 'unsafe') add(ln, 'unsafe', 'error');
      else {
        if (chk.code !== 'ok') add(ln, chk.code === 'relative' ? 'relativeUrl' : chk.code, 'warn');
        if (seenUrl.has(chk.key)) add(ln, 'dupLink', 'warn', { ref: seenUrl.get(chk.key) });
        else seenUrl.set(chk.key, ln);
      }
    }
    spec.sections[spec.sections.length - 1].links.push({ title: p.title, url: p.url, note: p.note });
  };
  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    const raw = lines[i];
    const t = raw.trim();
    if (fence) {
      const f = FENCE.exec(raw);
      if (f && f[1][0] === fence[0] && f[1].length >= fence.length) fence = '';
      if (state !== 'sections') body.push(raw);
      continue;
    }
    if (!t) {
      if (state === 'body' && body.length) body.push('');
      if (prevKind === 'quote') summaryDone = true;
      prevKind = prevKind === 'quote' ? 'blank-after-quote' : 'blank';
      continue;
    }
    if (!firstContent) firstContent = ln;
    const indent = raw.length - raw.replace(/^ +/, '').length;
    // リスト項目の中（字下げした続きの行・入れ子のリスト）
    if (inItem && indent >= 2) {
      const sub = LIST_ITEM.exec(raw);
      if (state === 'sections' && sub && sub[2]) {
        const p = parseLinkItem(sub[2].trim());
        if (p) checkLink(ln, p);
      }
      if (state !== 'sections') body.push(raw);
      prevKind = 'item';
      continue;
    }
    const h = atxHeading(raw);
    if (h) {
      inItem = false;
      if (state === 'start') state = 'afterH1';
      heading(ln, h.level, h.title);
      prevKind = 'heading';
      continue;
    }
    const li = LIST_ITEM.exec(raw);
    const isQuote = /^ {0,3}>/.test(raw);
    // Setext 形式の見出し（次の行が === か ---）
    if (!li && !isQuote && !FENCE.test(raw) && prevKind !== 'other' && prevKind !== 'item' && i + 1 < lines.length && SETEXT.test(lines[i + 1])) {
      inItem = false;
      if (!firstContent) firstContent = ln;
      if (state === 'start') state = 'afterH1';
      heading(ln, lines[i + 1].trim()[0] === '=' ? 1 : 2, t);
      prevKind = 'heading';
      i++;
      continue;
    }
    if (state === 'start') state = 'afterH1';
    if (isQuote) {
      inItem = false;
      if (state === 'afterH1' && !summaryDone && (prevKind === 'heading' || prevKind === 'quote' || prevKind === 'blank') && h1Line) {
        quote.push(raw.replace(/^ {0,3}> ?/, ''));
        prevKind = 'quote';
        continue;
      }
      if (state === 'sections') add(ln, 'nonListInSection', 'warn');
      else {
        if (!summaryDone && !quote.length) add(ln, 'summaryPosition', 'warn');
        state = 'body';
        body.push(raw);
      }
      prevKind = 'other';
      continue;
    }
    if (prevKind === 'quote' || prevKind === 'blank-after-quote') summaryDone = true;
    const f = FENCE.exec(raw);
    if (f) {
      inItem = false;
      fence = f[1];
      if (state === 'sections') add(ln, 'nonListInSection', 'warn');
      else { state = 'body'; body.push(raw); }
      prevKind = 'other';
      continue;
    }
    if (state === 'sections') {
      if (li) {
        inItem = true;
        const p = li[2] ? parseLinkItem(li[2].trim()) : null;
        if (p) checkLink(ln, p);
        else add(ln, 'itemNoLink', 'warn');
        prevKind = 'item';
        continue;
      }
      if (prevKind === 'item') {
        // 字下げの無い続きの行（Markdown では前の項目の続きとして読まれる）
        add(ln, 'continuation', 'info');
        continue;
      }
      inItem = false;
      add(ln, 'nonListInSection', 'warn');
      prevKind = 'other';
      continue;
    }
    inItem = Boolean(li);
    if (SETEXT.test(raw) && prevKind === 'other' && !li) add(ln, 'headingInBody', 'warn');
    state = 'body';
    body.push(raw);
    prevKind = li ? 'item' : 'other';
  }
  if (!h1Line) add(firstContent || 1, 'noH1', 'error');
  if (h1Line && !quote.length) add(h1Line, 'noSummary', 'info');
  for (const s of stats.sections) if (!s.links && s.title) add(s.line, 'noLinks', 'warn');
  if (!stats.sections.length) add(0, 'noSections', 'info');
  issues.sort((a, b) => a.line - b.line);
  spec.summary = quote.map((l) => l.trim()).filter(Boolean).join('\n');
  while (body.length && !body[body.length - 1].trim()) body.pop();
  spec.notes = body.join('\n').trim();
  return { ok: !issues.some((x) => x.level === 'error'), issues, stats, spec };
}

export const MESSAGES = {
  ja: {
    noUrl: 'URL がありません。この行は出力していません。',
    noTitle: 'タイトルがありません。この行は出力していません。',
    invalid: 'URL として読めません。この行は出力していません。',
    unsafe: 'javascript: などの URL はリンクにできません。この行は出力していません。',
    otherScheme: 'http・https 以外の URL です。AI が読めるページか確かめてください。',
    protocolRelative: '// で始まる URL です。https: を付けた URL にすると確実です。',
    hostLike: 'https:// が無いため、相対 URL として扱われます。ドメインから書くなら https:// を付けてください。',
    dupUrl: '同じ URL が{ref}にあります。2つ目以降は出力していません。',
    relative: '相対 URL です。仕様上は使えますが、https:// からの URL にするとどのサイトのページか確実に伝わります。',
    encoded: 'URL の空白・括弧などを %20 などに置き換えて出力しました。',
    emptySection: 'リンクが1つも出力されないため、このセクションは出力していません。',
    noSectionTitle: 'セクションの見出しが空のため、このセクションは出力していません。',
    dupSection: '同じ見出しのセクションが{ref}にもあります。',
    tooLong: '長すぎるため点検していません（50万字まで）。',
    empty: '中身がありません。',
    noH1: '最初の行が「# サイト名」（H1）になっていません。H1 は仕様で唯一の必須項目です。',
    h1NotFirst: 'H1 の前に別の行があります。H1 はファイルの先頭に置きます。',
    multiH1: 'H1 が2つ以上あります（最初の H1 は{ref}）。H1 は1つだけにします。',
    emptyH1: 'H1 に名前がありません。',
    noSummary: 'H1 の直後に引用ブロック（> で始まる要約）がありません。必須ではありません。',
    summaryPosition: '引用ブロックが H1 の直後にありません。仕様では要約は H1 のすぐ後に置く形です。',
    headingInBody: '本文に見出しがあります。仕様では、H1 と最初の H2 の間に見出しを置かない形です。',
    subheading: 'H3 以下の見出しです。仕様の形では、リンクの一覧は H2 の見出しの下に並べます。',
    emptySectionTitle: 'H2 の見出しが空です。',
    optionalCase: '仕様で「省いてよいリンク」の意味を持つのは「Optional」という見出しです（大文字・小文字を合わせると確実です）。',
    nonListInSection: 'H2 のセクションの中に、リストではない行があります。仕様の形では、セクションには「- [名前](URL): 説明」の行を並べます。',
    continuation: '字下げの無い続きの行です。前のリスト項目の続きとして読まれます。',
    itemNoLink: 'リストの行が「[名前](URL)」で始まっていません。',
    emptyLinkText: 'リンクの名前が空です。',
    noteFormat: 'リンクの後ろの説明は「: 」で区切ります。',
    urlSpace: 'URL に空白が入っています。%20 に置き換えるか、<URL> のように山括弧で囲んでください。',
    emptyUrl: 'URL が空です。',
    badUrl: 'URL として読めません（{detail}）。',
    relativeUrl: '相対 URL です。仕様上は使えますが、https:// からの URL にすると確実です。',
    dupLink: '同じ URL が{ref}にもあります。',
    noSections: 'H2 のセクションがありません。読ませたいページは H2 の下にリンクで並べます。',
    noLinks: 'このセクションにはリンクがありません。',
  },
  en: {
    noUrl: 'No URL. This row is left out of the output.',
    noTitle: 'No title. This row is left out of the output.',
    invalid: 'Not a valid URL. This row is left out of the output.',
    unsafe: 'URLs such as javascript: cannot be links. This row is left out of the output.',
    otherScheme: 'This is not an http or https URL. Make sure AI systems can read it.',
    protocolRelative: 'This URL starts with //. Adding https: makes it unambiguous.',
    hostLike: 'Without https:// this is treated as a relative URL. Add https:// if you meant a domain.',
    dupUrl: 'The same URL is already in {ref}. Only the first one is included.',
    relative: 'This is a relative URL. The spec allows it, but a full https:// URL tells AI systems which site the page is on.',
    encoded: 'Spaces, parentheses and similar characters in the URL were encoded (e.g. %20).',
    emptySection: 'No links would be output, so this section is left out.',
    noSectionTitle: 'The section heading is empty, so this section is left out.',
    dupSection: 'Another section with the same heading is at {ref}.',
    tooLong: 'Too long to check (500,000 characters max).',
    empty: 'The file is empty.',
    noH1: 'The first line is not "# Site name" (H1). The H1 is the only required part of the spec.',
    h1NotFirst: 'There is content before the H1. The H1 goes at the top of the file.',
    multiH1: 'There is more than one H1 (the first is on {ref}). Use exactly one.',
    emptyH1: 'The H1 has no name.',
    noSummary: 'No blockquote summary (lines starting with >) right after the H1. It is optional.',
    summaryPosition: 'The blockquote is not right after the H1. In the spec, the summary comes immediately after it.',
    headingInBody: 'A heading appears in the body. In the spec, there are no headings between the H1 and the first H2.',
    subheading: 'H3 or lower heading. In the spec, links are listed under H2 headings.',
    emptySectionTitle: 'The H2 heading is empty.',
    optionalCase: 'The spec gives special meaning (links that can be skipped) to a section named exactly "Optional".',
    nonListInSection: 'A line inside an H2 section is not a list item. In the spec, sections list "- [name](url): notes" lines.',
    continuation: 'An unindented continuation line. It is read as part of the previous list item.',
    itemNoLink: 'This list item does not start with a "[name](url)" link.',
    emptyLinkText: 'The link name is empty.',
    noteFormat: 'Separate the notes after a link with ": ".',
    urlSpace: 'The URL contains a space. Replace it with %20 or wrap the URL in <angle brackets>.',
    emptyUrl: 'The URL is empty.',
    badUrl: 'Not a valid URL ({detail}).',
    relativeUrl: 'This is a relative URL. The spec allows it, but a full https:// URL is safer.',
    dupLink: 'The same URL also appears on {ref}.',
    noSections: 'There are no H2 sections. List the pages you want read as links under H2 headings.',
    noLinks: 'This section has no links.',
  },
};

/** 指摘の文を作る。ref は {section,row}（生成）か行番号（点検）。refText で「どこ」の書き方を渡せる */
export function messageOf(issue, lang = 'ja', refText = '') {
  const en = lang === 'en';
  const L = MESSAGES[en ? 'en' : 'ja'];
  const t = L[issue.code] || issue.code;
  const ref = refText || (typeof issue.ref === 'number' ? (en ? 'line ' + issue.ref : issue.ref + '行目') : '');
  return t.replace('{ref}', () => ref).replace('{detail}', () => issue.detail || '');
}
// ===== ここまでコア =====

/**
 * MCP の llmstxt_generate の本体。
 * mode=generate（既定）: siteName・summary・notes・sections から llms.txt を作る。importText（sitemap.xml の中身か URL の一覧）を
 *   渡すと、その行を importSection の見出しのセクション（既定は sections の最初・無ければ "Main Pages"／ja は「主要ページ」）へ足す。
 *   importByPath:true ならパスの1階層目が同じページが2件以上ある階層を別のセクションにする。sitemapindex を渡したときは
 *   生成せず children（子の sitemap の URL）を返す。
 * mode=lint（text を渡し mode を省いたときも）: 既存の llms.txt を点検し issues を返す。
 */
export function llmsTxtTool(opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'ja';
  const mode = opts.mode || (opts.text !== undefined && !opts.siteName ? 'lint' : 'generate');
  if (mode === 'generate' && !String(opts.siteName ?? '').trim()) {
    throw new Error(lang === 'en'
      ? 'siteName is required for mode="generate". To check an existing llms.txt, pass text (with mode="lint").'
      : 'mode="generate" では siteName が必須です。既存の llms.txt を点検するなら text を渡してください（mode="lint"）。');
  }
  if (mode === 'lint') {
    const r = lintLlmsTxt(opts.text ?? '');
    return {
      mode: 'lint',
      ok: r.ok,
      issues: r.issues.map((i) => ({ ...i, message: messageOf(i, lang) })),
      stats: r.stats,
      spec: r.spec,
    };
  }
  const sections = (opts.sections || []).map((s) => ({ title: s.title, links: [...(s.links || [])] }));
  let imported = null;
  if (opts.importText !== undefined) {
    const imp = parseImport(opts.importText);
    if (imp.kind === 'tooLong') throw new Error(`importText is too long (${LIMITS.importChars} characters max)`);
    if (imp.kind === 'sitemapindex') {
      return {
        mode: 'generate',
        text: null,
        imported: { kind: imp.kind, count: 0, children: imp.children },
        hint: lang === 'en'
          ? 'This is a sitemap index. Pass the contents of one of the child sitemaps as importText.'
          : 'sitemapindex（sitemap の目次）です。children の sitemap の中身を importText に渡してください。',
      };
    }
    const fallback = lang === 'en' ? 'Main Pages' : '主要ページ';
    let defaultTitle = opts.importSection || (sections[0] && sections[0].title) || fallback;
    if (String(defaultTitle).trim().toLowerCase() === 'optional') defaultTitle = 'Optional';
    const groups = groupImport(imp.items, { byPath: Boolean(opts.importByPath), defaultTitle });
    for (const g of groups) {
      const k = String(g.title).trim().toLowerCase();
      let sec = sections.find((s) => String(s.title || '').trim().toLowerCase() === k);
      if (!sec) {
        sec = { title: g.title, links: [] };
        const opt = sections.findIndex((s) => String(s.title || '').trim().toLowerCase() === 'optional');
        if (opt >= 0) sections.splice(opt, 0, sec); else sections.push(sec);
      }
      for (const it of g.links) sec.links.push({ title: it.title, url: it.url, note: it.note });
    }
    imported = { kind: imp.kind, count: imp.items.length, guessedTitles: imp.items.filter((i) => i.guessed).length, skipped: imp.skipped, truncated: imp.truncated };
  }
  const r = buildLlmsTxtDetailed({ siteName: opts.siteName, summary: opts.summary, notes: opts.notes, sections });
  const where = (s, row) => (lang === 'en'
    ? (row < 0 ? `section ${s + 1}` : `section ${s + 1}, row ${row + 1}`)
    : (row < 0 ? `セクション${s + 1}` : `セクション${s + 1}の${row + 1}行目`));
  const out = {
    mode: 'generate',
    text: r.text,
    stats: r.stats,
    warnings: r.warnings.map((w) => ({ ...w, message: messageOf(w, lang, w.ref ? where(w.ref.section, w.ref.row) : '') })),
  };
  if (imported) out.imported = imported;
  if (opts.text !== undefined) {
    out.notice = lang === 'en'
      ? 'text was ignored because mode is "generate". Pass mode="lint" to check it.'
      : 'mode が "generate" のため text は使っていません。点検するなら mode="lint" を渡してください。';
  }
  return out;
}
