/* llms.txt の生成・取り込み・点検（llmstxt_generate）
 * 生成・取り込み・点検のコアは FirstCHTools の site/llms-txt/lib.mjs と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルの「ここからコア」〜「ここまでコア」はバイト一致する（どちらも ES module）:
 *   diff <(sed -n '/^\/\/ ===== ここから/,/^\/\/ ===== ここまで/p' site/llms-txt/lib.mjs) <(sed -n '/^\/\/ ===== ここから/,/^\/\/ ===== ここまで/p' llms-txt.mjs)
 *
 * 仕様は https://llmstxt.org/（H1 必須 → 引用ブロックの要約 → 見出し以外の本文 → H2 ごとのリンクの一覧・"Optional" は省いてよいリンク）。
 * 題名の [ ] と URL の空白・括弧を逃がし、同じ URL の2つ目以降・読めない URL は出力から外して warnings で知らせる。
 * 完全ローカル処理・ネットワーク送信なし（sitemap も取りに行かない。中身を importText で渡す）。 */

// ===== ここからコア =====
export const LIMITS = { importRows: 2000, lintChars: 500000 };

const ESCAPABLE = /[!-/:-@[-`{-~]/;

/** 改行・タブを空白1つにして前後を落とす（全角の空白はそのまま） */
export function oneLine(s) {
  return String(s ?? '').replace(/[ \t]*[\r\n\t]+[ \t]*/g, ' ').trim();
}

/** リンクの文字の \ [ ] を逃がす（Markdown のリンクが途中で切れないように） */
export function escapeLinkText(s) {
  return oneLine(s).replace(/[\\[\]]/g, (c) => '\\' + c);
}

/** URL の中の空白・括弧・<>"・制御文字を %XX にする（リンクの ( ) が途中で閉じないように） */
export function encodeLinkUrl(u) {
  return oneLine(u).replace(/[\s()<>"\x00-\x1f\x7f]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

/** URL を確かめる。code: ok / relative（/ で始まる）/ invalid（読めない）/ badScheme（http・https 以外）/ empty。key は重複を見るための形 */
export function checkUrl(u) {
  const s = encodeLinkUrl(u);
  if (!s) return { code: 'empty', key: '' };
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    if (!/^https?:/i.test(s)) return { code: 'badScheme', key: s };
    try {
      const x = new URL(s);
      if (!x.hostname || !/^https?:\/\//i.test(s)) return { code: 'invalid', key: s };
      return { code: 'ok', key: x.href };
    } catch {
      return { code: 'invalid', key: s };
    }
  }
  if (s.startsWith('/')) {
    try {
      const x = new URL(s, 'https://relative.invalid');
      return { code: 'relative', key: x.host === 'relative.invalid' ? x.pathname + x.search + x.hash : x.href };
    } catch {
      return { code: 'invalid', key: s };
    }
  }
  return { code: 'invalid', key: s };
}

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
  const t = decodeSeg(s).replace(/[-_+]+/g, ' ').replace(/\s+/g, ' ').trim();
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
  return String(s)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (m, e) => {
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

function xmlBlocks(src, tag) {
  const re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '\\s*>', 'gi');
  const out = [];
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out;
}

function locOf(block) {
  const m = /<loc(?:\s[^>]*)?>([\s\S]*?)<\/loc\s*>/i.exec(block);
  return m ? decodeXml(m[1]) : '';
}

const looksLikeUrl = (s) => /^https?:\/\/\S+$/i.test(s) || /^\/\S*$/.test(s);

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
  let dest = '';
  if (str[j] === '<') {
    const k = str.indexOf('>', j);
    if (k < 0) return null;
    dest = str.slice(j + 1, k);
    j = k + 1;
    while (str[j] === ' ') j++;
    if (str[j] !== ')') return null;
  } else {
    let pd = 1;
    for (; j < str.length; j++) {
      const c = str[j];
      if (c === '\\' && j + 1 < str.length) { dest += c + str[j + 1]; j++; continue; }
      if (c === '(') pd++;
      else if (c === ')' && --pd === 0) break;
      dest += c;
    }
    if (pd !== 0) return null;
  }
  const d = dest.trim();
  const m = /^(\S*)(?:\s+([\s\S]*))?$/.exec(d);
  const url = m ? m[1] : d;
  const extra = m && m[2] ? m[2].trim() : '';
  const spaceInUrl = Boolean(extra) && !/^(?:"[^"]*"|'[^']*'|\([^)]*\))$/.test(extra);
  const rest = str.slice(j + 1);
  let note = '';
  let noteFormat = true;
  if (/\S/.test(rest)) {
    const nm = /^\s*:\s*([\s\S]*)$/.exec(rest);
    if (nm) note = nm[1].trim();
    else { note = rest.trim(); noteFormat = false; }
  }
  return { title: text.trim(), url: spaceInUrl ? d : url, note, noteFormat, spaceInUrl };
}

/**
 * 貼り付けた sitemap.xml か URL の一覧（1行1URL・「URL<TAB>題名」・「- [題名](URL)」）を読む。
 * kind: sitemap / sitemapindex（children に子の sitemap の URL）/ list / empty。題名が無ければ titleFromUrl で仮に作る（guessed: true）。
 */
export function parseImport(text) {
  const src = String(text ?? '').replace(/^﻿/, '');
  const out = { kind: 'empty', items: [], children: [], skipped: [], truncated: 0 };
  if (!src.trim()) return out;
  const push = (url, title, note) => {
    const u = oneLine(url);
    if (out.items.length >= LIMITS.importRows) { out.truncated++; return; }
    const t = oneLine(title);
    out.items.push({ url: u, title: t || titleFromUrl(u), note: oneLine(note), guessed: !t });
  };
  if (/<sitemapindex[\s>]/i.test(src)) {
    out.kind = 'sitemapindex';
    out.children = xmlBlocks(src, 'sitemap').map(locOf).filter(Boolean);
    return out;
  }
  if (/<urlset[\s>]/i.test(src) || (/<url[\s>]/i.test(src) && /<loc[\s>]/i.test(src))) {
    out.kind = 'sitemap';
    for (const b of xmlBlocks(src, 'url')) {
      const u = locOf(b);
      if (u) push(u, '', '');
    }
    return out;
  }
  out.kind = 'list';
  src.split(/\r\n?|\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('>')) return;
    const li = /^(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const p = parseLinkItem(li[1]);
      if (p && p.url) { push(p.url, p.title, p.note); return; }
    }
    if (line.includes('\t')) {
      const cols = line.split('\t').map((c) => c.trim()).filter(Boolean);
      const k = cols.findIndex(looksLikeUrl);
      if (k >= 0) { push(cols[k], cols.filter((_, n) => n !== k).join(' '), ''); return; }
    } else {
      const m = /^(\S+)(?:\s+(.*))?$/.exec(line);
      if (m && looksLikeUrl(m[1])) { push(m[1], m[2] || '', ''); return; }
    }
    out.skipped.push({ line: i + 1, text: line.slice(0, 200) });
  });
  return out;
}

/**
 * 取り込んだ行をセクションへ振り分ける。byPath が真なら、パスの1階層目が同じページが2件以上ある階層を
 * 別のセクション（題名は階層名を読みやすくしたもの）にし、残りは defaultTitle へ入れる。返り値は [{ title, links, base? }]（base は defaultTitle の組）。
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
      if (!groups.has(seg)) groups.set(seg, { title: labelOf(seg) || seg, links: [] });
      groups.get(seg).links.push(it);
    } else {
      base.links.push(it);
    }
  }
  return [base, ...groups.values()].filter((g) => g.links.length);
}

function escapeBody(s) {
  return s
    .replace(/^([ \t]{0,3})(#{1,6})(?=[ \t]|$)/gm, '$1\\$2')
    .replace(/^([ \t]{0,3})(=+|-+)([ \t]*)$/gm, '$1\\$2$3');
}

/**
 * llms.txt を組み立てる。spec: { siteName, summary?, notes?, sections?: [{ title, links: [{ title, url, note? }] }] }
 * 返り値: { text, warnings: [{ section, row, code, level, dropped, ref? }], stats: { sections, links } }。
 * row が -1 の警告はセクションそのものへの指摘。dropped が真の行・セクションは出力に入れていない。
 */
export function buildLlmsTxtDetailed(spec = {}) {
  const name = oneLine(spec.siteName);
  if (!name) throw new Error('siteName は必須です');
  const parts = [`# ${name}`];
  const summary = String(spec.summary ?? '').replace(/\r\n?/g, '\n').trim();
  if (summary) {
    parts.push(summary.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => `> ${l}`).join('\n'));
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
      if (chk.code === 'invalid' || chk.code === 'badScheme') { warn(si, ri, chk.code, 'error', true); return; }
      if (!t) { warn(si, ri, 'noTitle', 'warn', true); return; }
      const prev = seen.get(chk.key);
      if (prev) { warn(si, ri, 'dupUrl', 'warn', true, prev); return; }
      seen.set(chk.key, { section: si, row: ri });
      if (chk.code === 'relative') warn(si, ri, 'relative', 'warn', false);
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
    parts.push(`## ${title}\n\n${lines.join('\n')}`);
    linkCount += lines.length;
    secCount++;
  });
  return { text: parts.join('\n\n') + '\n', warnings, stats: { sections: secCount, links: linkCount } };
}

/** 文字列だけを返す版（MCP の lib.mjs から公開している従来の関数） */
export function buildLlmsTxt(spec) {
  return buildLlmsTxtDetailed(spec).text;
}

/**
 * 既存の llms.txt を仕様に照らして点検する。返り値:
 * { ok（error が無い）, issues: [{ line, code, level, ref?, detail? }], stats: { title, sections: [{ title, line, links }], links },
 *   spec（編集画面へ戻すための siteName・summary・notes・sections） }。line は1始まり（0はファイル全体）。
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
  let inFence = false;
  let cur = null;
  const quote = [];
  const body = [];
  const seenUrl = new Map();
  const seenSec = new Map();
  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    const raw = lines[i];
    const t = raw.trim();
    if (inFence) {
      if (/^(```|~~~)/.test(t)) inFence = false;
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
    const h = /^ {0,3}(#{1,6})(?=[ \t]|$)[ \t]*(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(raw);
    if (h) {
      const level = h[1].length;
      const title = h[2].trim();
      if (level === 1) {
        if (h1Line) add(ln, 'multiH1', 'error', { ref: h1Line });
        else {
          h1Line = ln;
          if (ln !== firstContent) add(ln, 'h1NotFirst', 'error');
          if (!title) add(ln, 'emptyH1', 'error');
          stats.title = title;
          spec.siteName = title;
          if (state !== 'sections') state = 'afterH1';
        }
      } else if (level === 2) {
        if (state === 'start') state = 'afterH1';
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
      prevKind = 'heading';
      continue;
    }
    if (state === 'start') state = 'afterH1';
    const isQuote = /^ {0,3}>/.test(raw);
    if (isQuote) {
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
    if (/^(```|~~~)/.test(t)) {
      inFence = true;
      if (state === 'sections') add(ln, 'nonListInSection', 'warn');
      else { state = 'body'; body.push(raw); }
      prevKind = 'other';
      continue;
    }
    const li = /^\s*(?:[-*+]|\d{1,9}[.)])\s+(.*)$/.exec(raw);
    if (state === 'sections') {
      if (!li) {
        add(ln, 'nonListInSection', 'warn');
        prevKind = 'other';
        continue;
      }
      const p = parseLinkItem(li[1].trim());
      if (!p) {
        add(ln, 'itemNoLink', 'error');
        prevKind = 'item';
        continue;
      }
      cur.links++;
      stats.links++;
      if (!p.title) add(ln, 'emptyLinkText', 'warn');
      if (!p.noteFormat) add(ln, 'noteFormat', 'warn');
      if (p.spaceInUrl) add(ln, 'urlSpace', 'error');
      else {
        const chk = checkUrl(p.url);
        if (chk.code === 'empty') add(ln, 'emptyUrl', 'error');
        else if (chk.code === 'invalid' || chk.code === 'badScheme') add(ln, chk.code === 'badScheme' ? 'badScheme' : 'badUrl', 'error', { detail: p.url.slice(0, 200) });
        else {
          if (chk.code === 'relative') add(ln, 'relativeUrl', 'warn');
          if (seenUrl.has(chk.key)) add(ln, 'dupLink', 'warn', { ref: seenUrl.get(chk.key) });
          else seenUrl.set(chk.key, ln);
        }
      }
      spec.sections[spec.sections.length - 1].links.push({ title: p.title, url: p.url, note: p.note });
      prevKind = 'item';
      continue;
    }
    if (/^ {0,3}(?:=+|-+)\s*$/.test(raw) && prevKind === 'other') add(ln, 'headingInBody', 'warn');
    state = 'body';
    body.push(raw);
    prevKind = 'other';
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
    noTitle: '題名がありません。この行は出力していません。',
    invalid: 'URL として読めません（https:// から書くか、/ で始めてください）。この行は出力していません。',
    badScheme: 'http・https 以外の URL です。この行は出力していません。',
    dupUrl: '同じ URL が{ref}にあります。2つ目以降は出力していません。',
    relative: '/ で始まる URL です。AI がどのサイトのページか分かるよう、https:// からの URL をおすすめします。',
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
    noSummary: 'H1 の直後に引用ブロック（> で始まる要約）がありません。必須ではありませんが、置くことが勧められています。',
    summaryPosition: '引用ブロックが H1 の直後にありません。要約は H1 のすぐ後に置きます。',
    headingInBody: '本文に見出しがあります。本文（H1 と最初の H2 の間）には見出しを使わない決まりです。',
    subheading: 'H3 以下の見出しです。リンクの一覧は H2 の見出しの下に並べるのが仕様の形です。',
    emptySectionTitle: 'H2 の見出しが空です。',
    optionalCase: '仕様で「省いてよいリンク」の意味を持つのは「Optional」という見出しです（大文字・小文字を合わせると確実です）。',
    nonListInSection: 'H2 のセクションの中に、リストではない行があります。セクションには「- [名前](URL): 説明」の行だけを並べます。',
    itemNoLink: 'リストの行が「[名前](URL)」で始まっていません。',
    emptyLinkText: 'リンクの名前が空です。',
    noteFormat: 'リンクの後ろの説明は「: 」で区切ります。',
    urlSpace: 'URL に空白が入っています。%20 に置き換えてください。',
    emptyUrl: 'URL が空です。',
    badUrl: 'URL として読めません（{detail}）。',
    relativeUrl: '/ で始まる URL です。https:// からの URL にすると確実です。',
    dupLink: '同じ URL が{ref}にもあります。',
    noSections: 'H2 のセクションがありません。読ませたいページは H2 の下にリンクで並べます。',
    noLinks: 'このセクションにはリンクがありません。',
  },
  en: {
    noUrl: 'No URL. This row is left out of the output.',
    noTitle: 'No title. This row is left out of the output.',
    invalid: 'Not a valid URL (start with https:// or /). This row is left out of the output.',
    badScheme: 'Only http and https URLs are allowed. This row is left out of the output.',
    dupUrl: 'The same URL is already in {ref}. Only the first one is included.',
    relative: 'This URL starts with /. A full https:// URL tells AI systems which site the page is on.',
    encoded: 'Spaces, parentheses and similar characters in the URL were encoded (e.g. %20).',
    emptySection: 'No links would be output, so this section is left out.',
    noSectionTitle: 'The section heading is empty, so this section is left out.',
    dupSection: 'Another section with the same heading is at {ref}.',
    tooLong: 'Too long to check (500,000 characters max).',
    empty: 'The file is empty.',
    noH1: 'The first line is not "# Site name" (H1). The H1 is the only required part of the spec.',
    h1NotFirst: 'There is content before the H1. The H1 goes at the top of the file.',
    multiH1: 'There is more than one H1 (the first is on line {ref}). Use exactly one.',
    emptyH1: 'The H1 has no name.',
    noSummary: 'No blockquote summary (lines starting with >) right after the H1. It is optional but recommended.',
    summaryPosition: 'The blockquote is not right after the H1. Put the summary immediately after it.',
    headingInBody: 'A heading appears in the body. The spec allows no headings between the H1 and the first H2.',
    subheading: 'H3 or lower heading. The spec lists links under H2 headings.',
    emptySectionTitle: 'The H2 heading is empty.',
    optionalCase: 'The spec gives special meaning (links that can be skipped) to a section named exactly "Optional".',
    nonListInSection: 'A line inside an H2 section is not a list item. Sections should contain only "- [name](url): notes" lines.',
    itemNoLink: 'This list item does not start with a "[name](url)" link.',
    emptyLinkText: 'The link name is empty.',
    noteFormat: 'Separate the notes after a link with ": ".',
    urlSpace: 'The URL contains a space. Replace it with %20.',
    emptyUrl: 'The URL is empty.',
    badUrl: 'Not a valid URL ({detail}).',
    relativeUrl: 'This URL starts with /. A full https:// URL is safer.',
    dupLink: 'The same URL also appears on {ref}.',
    noSections: 'There are no H2 sections. List the pages you want read as links under H2 headings.',
    noLinks: 'This section has no links.',
  },
};

/** 指摘の文を作る。ref は {section,row}（生成）か行番号（点検）。refText で「どこ」の書き方を渡せる */
export function messageOf(issue, lang = 'ja', refText = '') {
  const L = MESSAGES[lang === 'en' ? 'en' : 'ja'];
  const t = L[issue.code] || issue.code;
  const ref = refText || (typeof issue.ref === 'number' ? (lang === 'en' ? 'line ' + issue.ref : issue.ref + '行目') : '');
  return t.replace('{ref}', ref).replace('{detail}', issue.detail || '');
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
    const defaultTitle = opts.importSection || (sections[0] && sections[0].title) || fallback;
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
  return out;
}
