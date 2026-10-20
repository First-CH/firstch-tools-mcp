/* 社内文書の重複・孤立・表記ゆれ検査（wiki_doc_lint）
 * 検査コア（lintDocs / buildReport / parseDoc / parseDictionary ほか）は
 * FirstCHTools の site/wiki-doc-lint/app.js と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルからコアの開始/終了コメントに挟まれた範囲を sed で切り出し
 * （site側は字下げ2文字を落とす・こちらは行頭の export を落とす）、
 * diff が空になることで同期を機械的に確認できる。
 *
 * Notion・Backlog Wiki・Confluence などから書き出した Markdown/HTML/テキストを読み、
 * 内容がほぼ同じページ・どこからもリンクされていないページ・表記ゆれや旧称・リンク切れを返す。
 * 読むだけでファイルは書き換えない。完全ローカル処理・ネットワーク送信なし。 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

/* ==================== ここから検査コア ==================== */

export const LIMITS = { files: 3000, fileBytes: 5 * 1024 * 1024, totalBytes: 60 * 1024 * 1024 };
export const DOC_EXT_RE = /\.(md|markdown|mdown|mkd|txt|html?|xhtml)$/i;
// 入口として扱うページ名（孤立に数えない）。Notion の32桁のIDを外し、小文字にしてから比べる
export const ENTRY_STEMS = ['index', 'readme', 'home', 'top', '_index', 'ホーム', 'トップ', 'トップページ', '目次'];
export const THRESHOLDS = [0.6, 0.7, 0.8, 0.9];
// 重複の判定に使う最小の長さ（記号と空白を除いた文字数）。これより短いページは比べない
export const MIN_DUP_CHARS = 40;
export const SHINGLE = 4;
export const SIG_BINS = 64;
export const MAX_HITS_PER_TERM = 300;
export const MAX_PAIRS = 300;

export const DEFAULT_DICT = [
  '# 1行に1つ、「揃える表記 ← ゆれ・旧称」の形で書きます（ゆれが複数あるときは読点かカンマで区切る）。',
  '# 「旧称 → 新しい名前」の向きでも書けます。行頭の # はコメントです。',
  '# 例: 経費ナビ ← 精算くん（サービス名の変更）',
  'サーバー ← サーバ',
  'ユーザー ← ユーザ',
  'コンピューター ← コンピュータ',
  'インターフェース ← インタフェース, インターフェイス',
  '問い合わせ ← 問合せ, 問合わせ, 問い合せ',
  '打ち合わせ ← 打合せ, 打ち合せ, 打合わせ',
  'JavaScript ← Javascript',
  'GitHub ← Github',
].join('\n');

export const DEFAULT_DICT_EN = [
  '# One rule per line: "preferred ← variant" (separate several variants with commas).',
  '# "old name → new name" also works. Lines starting with # are comments.',
  '# Example: Expense Hub ← ExpenseBot (a renamed service)',
  'email ← e-mail, E-mail',
  'website ← web site, Web site',
  'JavaScript ← Javascript',
  'GitHub ← Github',
  'サーバー ← サーバ',
  'ユーザー ← ユーザ',
  '問い合わせ ← 問合せ, 問合わせ, 問い合せ',
].join('\n');

export const WDL_MSG = {
  ja: {
    title: '社内文書チェックの結果',
    target: (s) => `対象: ${s.docs}ページ（Markdown ${s.md}・HTML ${s.html}・テキスト ${s.txt}）`,
    sumDup: (n) => `重複の疑い: ${n}組`,
    sumOrphan: (n) => `孤立ページ: ${n}件`,
    sumTerm: (k, n) => `表記ゆれ・旧称: ${k}種類・${n}か所`,
    sumBroken: (n) => `リンク切れ: ${n}件`,
    hDup: (th) => `重複の疑い（類似度${Math.round(th * 100)}%以上）`,
    hOrphan: '孤立ページ（ほかのどのページからもリンクされていない）',
    hTerm: '表記ゆれ・旧称',
    hBroken: 'リンク切れ',
    none: 'ありません。',
    dupHead: (a, b, p) => `${a} ⇔ ${b}（類似度 ${p}%）`,
    orphanItem: (path, title, fix) => `\`${path}\`（${title}）— ${fix}`,
    onlyIn: (name) => `「${name}」だけにある行`,
    quote: (x) => `「${x}」`,
    dupFix: (keepT, keep, dropT, drop, why) =>
      `「${keepT}」（${keep}）を残します（${why}）。「${dropT}」（${drop}）だけにある記述を移してから削除するか、冒頭に「最新版は「${keepT}」を参照」と書いて残します。`,
    whyLinks: (a, b) => `被リンク ${a}件と${b}件`,
    whyLen: (a, b) => `本文 ${a}字と${b}字`,
    whyPath: '被リンク数と本文の長さが同じため、パスの順',
    orphanFix: (pt, p, line) => `「${pt}」（${p}）に次の行を足してリンクします: ${line}　不要なページなら削除かアーカイブを検討します。`,
    orphanFixNone: 'どのページからも辿れません。目次になるページ（README など）からリンクするか、不要なら削除かアーカイブを検討します。',
    brokenFix: (t) => `リンク先「${t}」が読み込んだファイルの中にありません。ページ名の変更・削除・移動を確認し、リンクを直すか外します。`,
    termHead: (pref, vars, src) => `${vars.join('・')} → ${pref}（${src === 'dict' ? '辞書' : '長音の自動検出・多い方'}）`,
    termCounts: (counts) => Object.keys(counts).map((f) => `${f} ${counts[f]}か所`).join('／'),
    line: (n) => `${n}行目`,
    more: (n) => `ほか${n}件は省略しました。`,
    entries: (list) => `入口として孤立に数えなかったページ: ${list.join('、')}`,
    short: (n) => `本文が短く重複の判定から外したページ: ${n}件`,
    dictErr: (l, t) => `辞書の${l}行目を読めませんでした（「揃える表記 ← ゆれ」の形で書きます）: ${t}`,
  },
  en: {
    title: 'Wiki document check',
    target: (s) => `Checked: ${s.docs} pages (Markdown ${s.md}, HTML ${s.html}, text ${s.txt})`,
    sumDup: (n) => `Likely duplicates: ${n} pair${n === 1 ? '' : 's'}`,
    sumOrphan: (n) => `Orphan pages: ${n}`,
    sumTerm: (k, n) => `Inconsistent or outdated terms: ${k} kind${k === 1 ? '' : 's'}, ${n} place${n === 1 ? '' : 's'}`,
    sumBroken: (n) => `Broken links: ${n}`,
    hDup: (th) => `Likely duplicates (similarity ${Math.round(th * 100)}% or more)`,
    hOrphan: 'Orphan pages (no other page links to them)',
    hTerm: 'Inconsistent and outdated terms',
    hBroken: 'Broken links',
    none: 'None.',
    dupHead: (a, b, p) => `${a} ⇔ ${b} (similarity ${p}%)`,
    orphanItem: (path, title, fix) => `\`${path}\` (${title}) — ${fix}`,
    onlyIn: (name) => `Lines found only in "${name}"`,
    quote: (x) => `"${x}"`,
    dupFix: (keepT, keep, dropT, drop, why) =>
      `Keep "${keepT}" (${keep}) (${why}). Move anything that only appears in "${dropT}" (${drop}) across, then delete it, or leave it with a first line saying "See ${keepT} for the current version".`,
    whyLinks: (a, b) => `${a} vs ${b} incoming links`,
    whyLen: (a, b) => `${a} vs ${b} characters of text`,
    whyPath: 'same links and length, so by path order',
    orphanFix: (pt, p, line) => `Add this line to "${pt}" (${p}) to link it: ${line}  If the page is no longer needed, delete or archive it.`,
    orphanFixNone: 'Nothing leads to this page. Link it from a contents page such as a README, or delete or archive it if it is no longer needed.',
    brokenFix: (t) => `"${t}" is not among the files you loaded. Check whether the page was renamed, moved or deleted, then fix or remove the link.`,
    termHead: (pref, vars, src) => `${vars.join(', ')} → ${pref} (${src === 'dict' ? 'dictionary' : 'long-vowel mark, auto-detected, majority form'})`,
    termCounts: (counts) => Object.keys(counts).map((f) => `${f} ×${counts[f]}`).join(' / '),
    line: (n) => `line ${n}`,
    more: (n) => `${n} more not shown.`,
    entries: (list) => `Treated as entry pages and not counted as orphans: ${list.join(', ')}`,
    short: (n) => `Pages too short to compare for duplicates: ${n}`,
    dictErr: (l, t) => `Could not read line ${l} of the dictionary (write it as "preferred ← variant"): ${t}`,
  },
};

export function wdlMsg(lang) {
  return WDL_MSG[lang === 'en' ? 'en' : 'ja'];
}

export function isDocName(path) {
  const p = String(path).replace(/\\/g, '/');
  if (p.split('/').some((s) => s.length > 1 && s[0] === '.' && s !== '..')) return false;
  return DOC_EXT_RE.test(p);
}

export function docType(path) {
  const m = /\.([a-z]+)$/i.exec(path);
  const e = m ? m[1].toLowerCase() : '';
  if (e === 'txt') return 'txt';
  if (e === 'html' || e === 'htm' || e === 'xhtml') return 'html';
  return 'md';
}

/** バイト列を文字列へ。BOM → UTF-8（厳密） → Shift_JIS の順に試す */
export function decodeBytes(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (u8[0] === 0xef && u8[1] === 0xbb && u8[2] === 0xbf) return { text: new TextDecoder('utf-8').decode(u8.subarray(3)), encoding: 'utf-8' };
  if (u8[0] === 0xff && u8[1] === 0xfe) return { text: new TextDecoder('utf-16le').decode(u8.subarray(2)), encoding: 'utf-16le' };
  if (u8[0] === 0xfe && u8[1] === 0xff) return { text: new TextDecoder('utf-16be').decode(u8.subarray(2)), encoding: 'utf-16be' };
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(u8), encoding: 'utf-8' };
  } catch (e) {
    // UTF-8 として読めないものは Shift_JIS とみなす（古い Wiki の書き出しに残っている）
  }
  try {
    return { text: new TextDecoder('shift_jis').decode(u8), encoding: 'shift_jis' };
  } catch (e) {
    return { text: new TextDecoder('utf-8').decode(u8), encoding: 'utf-8' };
  }
}

/* ---------- パス ---------- */

export function normPath(p) {
  const out = [];
  String(p).replace(/\\/g, '/').split('/').forEach((s) => {
    if (!s || s === '.') return;
    if (s === '..') out.pop();
    else out.push(s);
  });
  return out.join('/');
}

export function dirOf(p) {
  const i = p.lastIndexOf('/');
  return i < 0 ? '' : p.slice(0, i);
}

export function baseOf(p) {
  return p.slice(p.lastIndexOf('/') + 1);
}

export function stemOf(p) {
  return baseOf(p).replace(/\.[^.]+$/, '');
}

// Notion の書き出しはファイル名・URLの末尾に32桁のIDを付ける
export function stripNotionId(s) {
  return String(s).replace(/[\s_-]+[0-9a-f]{32}$/i, '') || String(s);
}

// ページ名の照合用。全角半角・大文字小文字・空白/ハイフン/アンダースコアの違いを無視する
export function nameKey(s) {
  return stripNotionId(String(s).normalize('NFKC').trim())
    .toLowerCase()
    .replace(/[\s_\-+]+/g, ' ')
    .trim();
}

export function safeDecode(s) {
  try {
    return decodeURIComponent(s);
  } catch (e) {
    return s;
  }
}

/** fromDir から toPath への相対パス（Markdown/HTML のリンクにそのまま書ける形） */
export function relPath(fromDir, toPath, type) {
  const a = fromDir ? fromDir.split('/') : [];
  const b = toPath.split('/');
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) i++;
  const segs = [];
  for (let k = i; k < a.length; k++) segs.push('..');
  for (let k = i; k < b.length; k++) segs.push(b[k]);
  const enc = (s) => (type === 'html' ? s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;') : s.replace(/%/g, '%25').replace(/ /g, '%20').replace(/\(/g, '%28').replace(/\)/g, '%29'));
  return segs.map(enc).join('/');
}

/* ---------- 行 ---------- */

export function lineStarts(text) {
  const a = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) a.push(i + 1);
  return a;
}

export function lineIndexAt(starts, pos) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= pos) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

/* ---------- 読み取り（コード・タグ・URLを同じ長さの空白で隠し、位置をずらさない） ---------- */

export function blank(s) {
  return s.replace(/[^\n]/g, ' ');
}

export const URL_RE = /https?:\/\/[^\s<>()[\]"'`、。「」（）]+/g;

export function decodeEntities(s) {
  const map = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : m;
    }
    const k = e.toLowerCase();
    return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : m;
  });
}

export function plainInline(s) {
  return decodeEntities(s.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

// Markdown の1段目: 前付け（front matter）・コードブロック・インラインコード・コメントを隠す
export function maskMarkdownCode(text) {
  const lines = text.split('\n');
  let fence = null;
  let inFront = false;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (i === 0 && /^---\s*$/.test(l)) {
      inFront = true;
      lines[i] = blank(l);
      continue;
    }
    if (inFront) {
      if (/^(---|\.\.\.)\s*$/.test(l)) inFront = false;
      lines[i] = blank(l);
      continue;
    }
    if (fence) {
      const m = /^ {0,3}(`{3,}|~{3,})\s*$/.exec(l);
      if (m && m[1][0] === fence.ch && m[1].length >= fence.len) fence = null;
      lines[i] = blank(l);
      continue;
    }
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(l);
    if (m && !(m[1][0] === '`' && l.indexOf('`', m[0].length) !== -1)) {
      fence = { ch: m[1][0], len: m[1].length };
      lines[i] = blank(l);
    }
  }
  return lines
    .join('\n')
    .replace(/<!--[\s\S]*?-->/g, blank)
    .replace(/``[^\n]+?``|`[^`\n]+`/g, blank);
}

export function frontMatterTitle(text) {
  if (!/^---\s*\n/.test(text)) return '';
  const end = text.search(/\n(---|\.\.\.)\s*(\n|$)/);
  if (end < 0) return '';
  const m = /^title:\s*(.+)$/m.exec(text.slice(0, end));
  return m ? m[1].trim().replace(/^(["'])(.*)\1$/, '$2').trim() : '';
}

export const MD_LINK_RE = /(!?)\[((?:[^[\]\n]|\[[^[\]\n]*\])*)\]\(\s*(?:<([^>\n]*)>|([^)\s]+(?:\([^)\s]*\)[^)\s]*)*))(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g;
export const WIKI_LINK_RE = /\[\[([^[\]\n|#]*)(?:#[^[\]\n|]*)?(?:\|[^[\]\n]*)?\]\]/g;
export const REF_DEF_RE = /^ {0,3}\[(?!\^)[^\]\n]+\]:[ \t]*<?([^\s>]+)>?/gm;
export const A_HREF_RE = /<a\b[^>]*?\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>"']+))/gi;

export function collectHtmlLinks(s, links) {
  A_HREF_RE.lastIndex = 0;
  let m;
  while ((m = A_HREF_RE.exec(s))) {
    const t = decodeEntities(m[1] !== undefined ? m[1] : m[2] !== undefined ? m[2] : m[3]);
    links.push({ kind: 'html', target: t, pos: m.index });
  }
}

export function collectUrls(s, links) {
  URL_RE.lastIndex = 0;
  let m;
  while ((m = URL_RE.exec(s))) links.push({ kind: 'url', target: m[0], pos: m.index });
}

/** 1ファイルを読み、タイトル・リンク・検査用の本文（コード等を隠したもの）を取り出す */
export function parseDoc(path, text) {
  const p = normPath(path);
  const type = docType(p);
  const src = String(text == null ? '' : text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  const links = [];
  let title = '';
  let masked;
  if (type === 'html') {
    const s1 = src.replace(/<script\b[\s\S]*?<\/script\s*>|<style\b[\s\S]*?<\/style\s*>|<!--[\s\S]*?-->/gi, blank);
    collectHtmlLinks(s1, links);
    const h1 = /<h1\b[^>]*>([\s\S]*?)<\/h1\s*>/i.exec(s1);
    const tt = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(s1);
    collectUrls(s1.replace(/<[^>]*>/g, blank), links);
    title = plainInline(h1 ? h1[1] : tt ? tt[1] : '');
    // Confluence の書き出しは「スペース名 : ページ名」
    const cm = /^[^:]{1,80}\s:\s(.+)$/.exec(title);
    if (cm) title = cm[1].trim();
    masked = s1
      .replace(/<(pre|code|head)\b[\s\S]*?<\/\1\s*>/gi, blank)
      .replace(/<[^>]*>/g, blank)
      .replace(URL_RE, blank);
  } else if (type === 'md') {
    const s1 = maskMarkdownCode(src);
    MD_LINK_RE.lastIndex = 0;
    let m;
    while ((m = MD_LINK_RE.exec(s1))) {
      if (m[1]) continue;
      links.push({ kind: 'md', target: m[3] !== undefined ? m[3] : m[4], pos: m.index });
    }
    WIKI_LINK_RE.lastIndex = 0;
    while ((m = WIKI_LINK_RE.exec(s1))) links.push({ kind: 'wiki', target: m[1], pos: m.index });
    REF_DEF_RE.lastIndex = 0;
    while ((m = REF_DEF_RE.exec(s1))) links.push({ kind: 'ref', target: m[1], pos: m.index });
    collectHtmlLinks(s1, links);
    collectUrls(s1.replace(/\]\([^)\n]*\)|<[^>\n]*>/g, blank), links);
    title = frontMatterTitle(src);
    if (!title) {
      const h = /^ {0,3}#[ \t]+(.+?)[ \t#]*$/m.exec(s1);
      if (h) title = plainInline(h[1].replace(/[*_`]/g, '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1'));
    }
    masked = s1
      .replace(/<\/?[A-Za-z][^>\n]*>/g, blank)
      .replace(/\]\(\s*(?:<[^>\n]*>|[^)\s]+(?:\([^)\s]*\)[^)\s]*)*)(?:\s+(?:"[^"\n]*"|'[^'\n]*'))?\s*\)/g, (x) => ']' + blank(x.slice(1)))
      .replace(/^( {0,3}\[[^\]\n]+\]:)([^\n]*)/gm, (x, a, b) => a + blank(b))
      .replace(URL_RE, blank);
  } else {
    collectUrls(src, links);
    masked = src.replace(URL_RE, blank);
  }
  if (!title) title = stripNotionId(stemOf(p));
  return { path: p, type, text: src, masked, title, links, starts: lineStarts(src) };
}

/* ---------- 辞書 ---------- */

export function parseDictionary(src) {
  const rules = [];
  const errors = [];
  const seen = new Set();
  String(src == null ? '' : src)
    .split(/\r\n?|\n/)
    .forEach((raw, i) => {
      const line = raw.replace(/(^|\s)#.*$/, '').trim();
      if (!line) return;
      let m = /^(.+?)\s*(?:←|<-|<=)\s*(.+)$/.exec(line);
      let preferred;
      let vars;
      if (m) {
        preferred = m[1];
        vars = m[2];
      } else if ((m = /^(.+?)\s*(?:→|->|=>)\s*(.+)$/.exec(line))) {
        preferred = m[2];
        vars = m[1];
      } else {
        errors.push({ line: i + 1, text: raw.trim() });
        return;
      }
      preferred = preferred.trim();
      const variants = [];
      vars.split(/[,、，;；]/).forEach((v) => {
        const t = v.trim();
        if (t && t !== preferred && variants.indexOf(t) === -1 && !seen.has(t)) variants.push(t);
      });
      if (!preferred || /[,、，;；←→]|<-|->/.test(preferred) || !variants.length) {
        errors.push({ line: i + 1, text: raw.trim() });
        return;
      }
      variants.forEach((v) => seen.add(v));
      rules.push({ preferred, variants, line: i + 1 });
    });
  return { rules, errors };
}

/* ---------- 表記ゆれ ---------- */

export const KATA_CH = /[\u30a1-\u30fa\u30fc]/;
export const WORD_CH = /[A-Za-z0-9_]/;
export const KATA_RUN_RE = /[\u30a1-\u30fa\u30fc\u30fd\u30fe]+/g;

export function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 語の途中を拾わない（英数字の語の中・カタカナ語の続き〔ユーザ→ユーザビリティ〕）
export function boundaryOk(t, s, e, f) {
  const before = s > 0 ? t[s - 1] : '';
  const after = e < t.length ? t[e] : '';
  if (WORD_CH.test(f[0]) && before && WORD_CH.test(before)) return false;
  if (WORD_CH.test(f[f.length - 1]) && after && WORD_CH.test(after)) return false;
  if (KATA_CH.test(f[f.length - 1]) && after && KATA_CH.test(after)) return false;
  return true;
}

export function scanRule(rule, docs) {
  const forms = [rule.preferred].concat(rule.variants).sort((a, b) => b.length - a.length);
  const re = new RegExp(forms.map(escapeRe).join('|'), 'g');
  const counts = {};
  [rule.preferred].concat(rule.variants).forEach((f) => (counts[f] = 0));
  const hits = [];
  docs.forEach((d, di) => {
    const t = d.masked;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(t))) {
      const f = m[0];
      if (!boundaryOk(t, m.index, m.index + f.length, f)) {
        re.lastIndex = m.index + 1;
        continue;
      }
      counts[f]++;
      if (f !== rule.preferred) hits.push({ doc: di, pos: m.index, form: f });
    }
  });
  return { counts, hits };
}

// 辞書に無いカタカナ語の長音ゆれ（サーバ／サーバー）。語の末尾の「ー」の有無だけを見る
export function autoChoonGroups(docs, dictForms) {
  const count = new Map();
  docs.forEach((d) => {
    KATA_RUN_RE.lastIndex = 0;
    let m;
    while ((m = KATA_RUN_RE.exec(d.masked))) count.set(m[0], (count.get(m[0]) || 0) + 1);
  });
  const groups = [];
  count.forEach((nLong, long) => {
    if (long.slice(-1) !== 'ー' || long.slice(-2) === 'ーー') return;
    const short = long.slice(0, -1);
    if (short.length < 3 || !count.has(short)) return;
    if (dictForms.has(long) || dictForms.has(short)) return;
    const nShort = count.get(short);
    const preferred = nLong >= nShort ? long : short;
    const variant = preferred === long ? short : long;
    const counts = {};
    counts[preferred] = preferred === long ? nLong : nShort;
    counts[variant] = variant === long ? nLong : nShort;
    groups.push({ preferred, variants: [variant], counts });
  });
  const byVariant = new Map(groups.map((g) => [g.variants[0], g]));
  groups.forEach((g) => (g.hits = []));
  if (groups.length) {
    docs.forEach((d, di) => {
      KATA_RUN_RE.lastIndex = 0;
      let m;
      while ((m = KATA_RUN_RE.exec(d.masked))) {
        const g = byVariant.get(m[0]);
        if (g) g.hits.push({ doc: di, pos: m.index, form: m[0] });
      }
    });
  }
  return groups;
}

/* ---------- 重複（4文字単位の断片の集合で Jaccard 係数を求める） ---------- */

export function normForDup(masked) {
  return masked
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export function shingleHashes(norm) {
  const n = norm.length - SHINGLE + 1;
  if (n <= 0) return new Uint32Array(0);
  const a = new Uint32Array(n);
  for (let i = 0; i < n; i++) {
    let h = 0x811c9dc5;
    for (let j = i; j < i + SHINGLE; j++) {
      h ^= norm.charCodeAt(j);
      h = Math.imul(h, 0x01000193);
    }
    h ^= h >>> 16;
    h = Math.imul(h, 0x85ebca6b);
    h ^= h >>> 13;
    h = Math.imul(h, 0xc2b2ae35);
    h ^= h >>> 16;
    a[i] = h >>> 0;
  }
  a.sort();
  let k = 0;
  for (let i = 0; i < n; i++) if (i === 0 || a[i] !== a[k - 1]) a[k++] = a[i];
  return a.subarray(0, k);
}

// 1回のハッシュで作る MinHash（区画ごとの最小値・空の区画は右隣から回して埋める）
export function signatureOf(set) {
  const raw = new Float64Array(SIG_BINS).fill(Infinity);
  for (let i = 0; i < set.length; i++) {
    const h = set[i];
    const b = h >>> 26;
    const v = h & 0x3ffffff;
    if (v < raw[b]) raw[b] = v;
  }
  // 26ビットの値＋回した距離（最大63）×2^26 は32ビットに収まる
  const sig = new Uint32Array(SIG_BINS);
  for (let i = 0; i < SIG_BINS; i++) {
    let d = 0;
    while (d < SIG_BINS && raw[(i + d) % SIG_BINS] === Infinity) d++;
    sig[i] = d >= SIG_BINS ? 0xffffffff : raw[(i + d) % SIG_BINS] + d * 0x4000000;
  }
  return sig;
}

export function jaccard(a, b) {
  let i = 0;
  let j = 0;
  let inter = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      inter++;
      i++;
      j++;
    } else if (a[i] < b[j]) i++;
    else j++;
  }
  const uni = a.length + b.length - inter;
  return uni ? inter / uni : 0;
}

export function lineKeys(masked) {
  const out = new Map();
  masked.split('\n').forEach((l) => {
    const t = l.trim();
    const k = t.normalize('NFKC').toLowerCase().replace(/[\s#>*_\-|`]+/g, '');
    if (k.length >= 4 && !out.has(k)) out.set(k, t.replace(/\s+/g, ' '));
  });
  return out;
}

export function clip(s, n) {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

/* ---------- リンクの解決 ---------- */

export function buildIndex(docs) {
  const byPath = new Map();
  const byNoExt = new Map();
  const byName = new Map();
  const add = (map, k, i) => {
    if (!k) return;
    const a = map.get(k);
    if (!a) map.set(k, [i]);
    else if (a.indexOf(i) === -1) a.push(i);
  };
  docs.forEach((d, i) => {
    const lp = d.path.toLowerCase();
    if (!byPath.has(lp)) byPath.set(lp, i);
    add(byNoExt, lp.replace(/\.[^./]+$/, ''), i);
    add(byName, nameKey(stemOf(d.path)), i);
    add(byName, nameKey(d.title), i);
  });
  return { byPath, byNoExt, byName };
}

export function pickNear(cands, docs, fromDir) {
  if (!cands || !cands.length) return -1;
  if (cands.length === 1) return cands[0];
  const same = cands.filter((i) => dirOf(docs[i].path) === fromDir);
  return same.length ? same[0] : cands[0];
}

/** リンク1本の行き先。{ to: 文書番号 } / { broken: true } / null（外部・添付・アンカーなど対象外） */
export function resolveLink(link, from, docs, idx) {
  const fromDir = dirOf(docs[from].path);
  let t = String(link.target || '').trim();
  if (!t) return null;
  if (link.kind === 'wiki') {
    const hit = pickNear(idx.byName.get(nameKey(t)), docs, fromDir);
    if (hit >= 0) return { to: hit };
    const p = normPath(fromDir + '/' + t).toLowerCase();
    const hit2 = idx.byPath.has(p) ? idx.byPath.get(p) : pickNear(idx.byNoExt.get(p), docs, fromDir);
    return hit2 >= 0 ? { to: hit2 } : { broken: true };
  }
  if (/^(mailto|tel|javascript|data|ftp|file|sms):/i.test(t)) return null;
  const external = /^[a-z][a-z0-9+.-]*:/i.test(t) || t.slice(0, 2) === '//';
  t = t.replace(/[?#].*$/, '');
  if (!t) return null;
  if (external) {
    // Notion（…/Page-Title-<32桁>）・Confluence（…/Page+Title）のURLは末尾のページ名で照合する。外れても切れとはしない
    const segs = t.replace(/^[a-z][a-z0-9+.-]*:\/\/[^/]*/i, '').replace(/^\/\/[^/]*/, '').split('/').filter(Boolean);
    if (!segs.length) return null;
    const last = safeDecode(segs[segs.length - 1].replace(/\+/g, ' ')).replace(/\.(html?|md)$/i, '');
    const hit = pickNear(idx.byName.get(nameKey(last)), docs, fromDir);
    return hit >= 0 ? { to: hit } : null;
  }
  const p = safeDecode(t);
  const target = (p[0] === '/' ? normPath(p) : normPath(fromDir + '/' + p)).toLowerCase();
  if (idx.byPath.has(target)) return { to: idx.byPath.get(target) };
  const hasExt = /\.[a-z0-9]{1,8}$/i.test(baseOf(target));
  const docExt = DOC_EXT_RE.test(target);
  if (hasExt && !docExt) return null;
  const noExt = docExt ? target.replace(/\.[^./]+$/, '') : target;
  let hit = pickNear(idx.byNoExt.get(noExt), docs, fromDir);
  if (hit < 0) hit = pickNear(idx.byName.get(nameKey(stemOf(target))), docs, fromDir);
  if (hit >= 0) return { to: hit };
  return docExt ? { broken: true } : null;
}

/* ---------- まとめ ---------- */

// 該当箇所の前後（HTML はタグを隠した本文から取り、空白をまとめる）
export function snippetAround(text, starts, pos, len, replacement, collapse) {
  const li = lineIndexAt(starts, pos);
  const ls = starts[li];
  const le = li + 1 < starts.length ? starts[li + 1] - 1 : text.length;
  const line = text.slice(ls, le);
  const col = pos - ls;
  const sq = (x) => (collapse ? x.replace(/\s+/g, ' ') : x);
  let pre = sq(line.slice(0, col));
  let post = sq(line.slice(col + len));
  if (pre.length > 30) pre = '…' + pre.slice(-30);
  if (post.length > 30) post = post.slice(0, 30) + '…';
  const word = line.slice(col, col + len);
  return { line: li + 1, col: col + 1, before: (pre + word + post).trim(), after: (pre + replacement + post).trim() };
}

/**
 * 社内文書の検査。files は [{ path, text }]。
 * opts: threshold（0.5〜1・既定0.8）/ dictionary（辞書の本文・既定 DEFAULT_DICT）/ autoChoon（既定 true）/
 *       entryPages（index・README などを孤立に数えない・既定 true）/ lang（'ja'|'en'）
 */
export function lintDocs(files, opts) {
  const o = opts || {};
  const lang = o.lang === 'en' ? 'en' : 'ja';
  const M = wdlMsg(lang);
  let threshold = o.threshold === undefined ? 0.8 : Number(o.threshold);
  if (!(threshold >= 0.5 && threshold <= 1)) threshold = 0.8;
  const list = Array.isArray(files) ? files : [];
  if (list.length > LIMITS.files) {
    const err = new Error(lang === 'en' ? `Too many files (up to ${LIMITS.files})` : `ファイルが多すぎます（${LIMITS.files}件まで）`);
    err.code = 'WDL_TOO_MANY';
    throw err;
  }
  const docs = [];
  const seenPath = new Set();
  list.forEach((f) => {
    if (!f || typeof f.path !== 'string') return;
    const d = parseDoc(f.path, f.text);
    if (!d.path || seenPath.has(d.path.toLowerCase())) return;
    seenPath.add(d.path.toLowerCase());
    docs.push(d);
  });
  docs.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const idx = buildIndex(docs);

  // リンク
  const inbound = docs.map(() => new Set());
  const outbound = docs.map(() => new Set());
  const broken = [];
  docs.forEach((d, i) => {
    d.links.forEach((l) => {
      const r = resolveLink(l, i, docs, idx);
      if (!r) return;
      if (r.broken) {
        const li = lineIndexAt(d.starts, l.pos);
        broken.push({ path: d.path, line: li + 1, target: l.target, fix: M.brokenFix(l.target) });
      } else if (r.to !== i) {
        inbound[r.to].add(i);
        outbound[i].add(r.to);
      }
    });
  });

  // 孤立
  const entryOn = o.entryPages !== false;
  const isEntry = (d) => entryOn && ENTRY_STEMS.indexOf(nameKey(stemOf(d.path))) !== -1;
  const entries = docs.filter(isEntry).map((d) => d.path);
  const orphans = [];
  if (docs.length >= 2) {
    docs.forEach((d, i) => {
      if (inbound[i].size || isEntry(d)) return;
      const parent = orphanParent(d, i, docs);
      let addLine = null;
      let fix = M.orphanFixNone;
      if (parent >= 0) {
        const pd = docs[parent];
        const rel = relPath(dirOf(pd.path), d.path, pd.type);
        addLine = pd.type === 'html' ? `<li><a href="${rel}">${d.title.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</a></li>` : pd.type === 'md' ? `- [${d.title.replace(/([[\]])/g, '\\$1')}](${rel})` : d.path;
        fix = M.orphanFix(pd.title, pd.path, addLine);
      }
      orphans.push({ path: d.path, title: d.title, outLinks: outbound[i].size, parent: parent >= 0 ? docs[parent].path : null, addLine, fix });
    });
  }

  // 重複
  const short = [];
  const sets = docs.map((d) => {
    const norm = normForDup(d.masked);
    d.dupLen = norm.length;
    if (norm.length < MIN_DUP_CHARS) {
      short.push(d.path);
      return null;
    }
    return shingleHashes(norm);
  });
  const sigs = sets.map((s) => (s ? signatureOf(s) : null));
  const pairs = [];
  // 署名での推定値が「しきい値−0.25」に届かない組は正確な計算を省く（届かないと決まった時点で打ち切る）
  const need = Math.max(1, Math.ceil((threshold - 0.25) * SIG_BINS));
  const miss = SIG_BINS - need;
  for (let i = 0; i < docs.length; i++) {
    const a = sigs[i];
    if (!a) continue;
    for (let j = i + 1; j < docs.length; j++) {
      const b = sigs[j];
      if (!b) continue;
      let ng = 0;
      let k = 0;
      for (; k < SIG_BINS; k++) if (a[k] !== b[k] && ++ng > miss) break;
      if (k < SIG_BINS) continue;
      const sim = jaccard(sets[i], sets[j]);
      if (sim >= threshold) pairs.push({ i, j, sim });
    }
  }
  pairs.sort((x, y) => y.sim - x.sim || (docs[x.i].path < docs[y.i].path ? -1 : 1));
  const duplicates = pairs.slice(0, MAX_PAIRS).map(({ i, j, sim }) => {
    const A = docs[i];
    const B = docs[j];
    let keep = i;
    let why;
    if (inbound[i].size !== inbound[j].size) {
      keep = inbound[i].size > inbound[j].size ? i : j;
      why = M.whyLinks(inbound[keep].size, inbound[keep === i ? j : i].size);
    } else if (A.dupLen !== B.dupLen) {
      keep = A.dupLen > B.dupLen ? i : j;
      why = M.whyLen(docs[keep].dupLen, docs[keep === i ? j : i].dupLen);
    } else why = M.whyPath;
    const drop = keep === i ? j : i;
    const ka = lineKeys(A.masked);
    const kb = lineKeys(B.masked);
    const only = (x, y) => {
      const out = [];
      x.forEach((v, k) => {
        if (!y.has(k) && out.length < 3) out.push(clip(v, 80));
      });
      return out;
    };
    return {
      a: A.path,
      b: B.path,
      aTitle: A.title,
      bTitle: B.title,
      similarity: Math.round(sim * 1000) / 1000,
      keep: docs[keep].path,
      drop: docs[drop].path,
      onlyA: only(ka, kb),
      onlyB: only(kb, ka),
      fix: M.dupFix(docs[keep].title, docs[keep].path, docs[drop].title, docs[drop].path, why),
    };
  });

  // 表記ゆれ
  const dict = parseDictionary(o.dictionary === undefined ? (lang === 'en' ? DEFAULT_DICT_EN : DEFAULT_DICT) : o.dictionary);
  const terms = [];
  const dictForms = new Set();
  dict.rules.forEach((r) => {
    dictForms.add(r.preferred);
    r.variants.forEach((v) => dictForms.add(v));
    const { counts, hits } = scanRule(r, docs);
    if (hits.length) terms.push({ preferred: r.preferred, variants: r.variants.filter((v) => counts[v] > 0), source: 'dict', counts: pickCounts(counts), rawHits: hits });
  });
  if (o.autoChoon !== false) {
    autoChoonGroups(docs, dictForms).forEach((g) => terms.push({ preferred: g.preferred, variants: g.variants, source: 'auto', counts: g.counts, rawHits: g.hits }));
  }
  let termHits = 0;
  terms.forEach((t) => {
    termHits += t.rawHits.length;
    t.total = t.rawHits.length;
    t.hits = t.rawHits.slice(0, MAX_HITS_PER_TERM).map((h) => {
      const d = docs[h.doc];
      const sn = d.type === 'html' ? snippetAround(d.masked, d.starts, h.pos, h.form.length, t.preferred, true) : snippetAround(d.text, d.starts, h.pos, h.form.length, t.preferred, false);
      return { path: d.path, line: sn.line, col: sn.col, form: h.form, before: sn.before, after: sn.after };
    });
    delete t.rawHits;
  });
  terms.sort((a, b) => (a.source === b.source ? b.total - a.total : a.source === 'dict' ? -1 : 1));

  let links = 0;
  inbound.forEach((s) => (links += s.size));
  return {
    lang,
    threshold,
    stats: {
      docs: docs.length,
      md: docs.filter((d) => d.type === 'md').length,
      html: docs.filter((d) => d.type === 'html').length,
      txt: docs.filter((d) => d.type === 'txt').length,
      links,
      broken: broken.length,
      duplicatePairs: pairs.length,
      orphans: orphans.length,
      termKinds: terms.length,
      termHits,
    },
    duplicates,
    orphans,
    broken,
    terms,
    entries,
    short,
    dictErrors: dict.errors,
  };
}

export function pickCounts(counts) {
  const out = {};
  Object.keys(counts).forEach((k) => {
    if (counts[k] > 0) out[k] = counts[k];
  });
  return out;
}

// 孤立ページのリンク元の候補: Notion 型の親（同名のページ＋同名のフォルダー）→ 同じフォルダー以上の目次ページ
export function orphanParent(d, i, docs) {
  const dir = dirOf(d.path);
  if (dir) {
    const up = dirOf(dir);
    const key = nameKey(baseOf(dir));
    for (let k = 0; k < docs.length; k++) {
      if (k !== i && dirOf(docs[k].path) === up && nameKey(stemOf(docs[k].path)) === key) return k;
    }
  }
  let cur = dir;
  for (;;) {
    for (let k = 0; k < docs.length; k++) {
      if (k !== i && dirOf(docs[k].path) === cur && ENTRY_STEMS.indexOf(nameKey(stemOf(docs[k].path))) !== -1) return k;
    }
    if (!cur) break;
    cur = dirOf(cur);
  }
  return -1;
}

/** 結果を Markdown のレポート（修正案つき）にする。limit は各節に載せる件数の上限 */
export function buildReport(r, limitOpt) {
  const M = wdlMsg(r.lang);
  const limit = limitOpt || 200;
  const L = [];
  const s = r.stats;
  L.push(`# ${M.title}`, '', M.target(s), '');
  L.push(`- ${M.sumDup(s.duplicatePairs)}`, `- ${M.sumOrphan(s.orphans)}`, `- ${M.sumTerm(s.termKinds, s.termHits)}`, `- ${M.sumBroken(s.broken)}`, '');
  r.dictErrors.forEach((e) => L.push(`> ${M.dictErr(e.line, e.text)}`));
  if (r.dictErrors.length) L.push('');
  const more = (n) => {
    if (n > 0) L.push('', M.more(n));
  };

  L.push(`## 1. ${M.hDup(r.threshold)}`, '');
  if (!r.duplicates.length) L.push(M.none);
  r.duplicates.slice(0, limit).forEach((p) => {
    L.push(`### ${M.dupHead(p.a, p.b, Math.round(p.similarity * 100))}`);
    L.push(`- ${p.fix}`);
    if (p.onlyA.length) L.push(`- ${M.onlyIn(p.a)}: ${p.onlyA.map(M.quote).join(' ')}`);
    if (p.onlyB.length) L.push(`- ${M.onlyIn(p.b)}: ${p.onlyB.map(M.quote).join(' ')}`);
    L.push('');
  });
  more(s.duplicatePairs - Math.min(limit, r.duplicates.length));

  L.push('', `## 2. ${M.hOrphan}`, '');
  if (!r.orphans.length) L.push(M.none);
  r.orphans.slice(0, limit).forEach((x) => L.push(`- ${M.orphanItem(x.path, x.title, x.fix)}`));
  more(r.orphans.length - limit);
  if (r.entries.length) L.push('', M.entries(r.entries.slice(0, 20)));

  L.push('', `## 3. ${M.hTerm}`, '');
  if (!r.terms.length) L.push(M.none);
  let shown = 0;
  r.terms.forEach((t) => {
    L.push(`### ${M.termHead(t.preferred, t.variants, t.source)}`, '', M.termCounts(t.counts), '');
    t.hits.forEach((h) => {
      if (shown++ >= limit * 5) return;
      L.push(`- \`${h.path}\` ${M.line(h.line)}: ${h.before} → ${h.after}`);
    });
    if (t.total > t.hits.length) L.push(`- ${M.more(t.total - t.hits.length)}`);
    L.push('');
  });

  L.push(`## 4. ${M.hBroken}`, '');
  if (!r.broken.length) L.push(M.none);
  r.broken.slice(0, limit).forEach((b) => L.push(`- \`${b.path}\` ${M.line(b.line)}: ${b.fix}`));
  more(r.broken.length - limit);
  if (r.short.length) L.push('', M.short(r.short.length));
  return L.join('\n').replace(/\n{3,}/g, '\n\n') + '\n';
}

/* ==================== ここまで検査コア ==================== */

export class WikiDocLintError extends Error {}

const LANGS = ['ja', 'en'];

// ディレクトリを辿って文書のファイルだけを集める（隠しフォルダー・node_modules は飛ばす）
async function collectFiles(root, out, skipped) {
  const st = await stat(root);
  if (st.isFile()) {
    out.push({ abs: root, rel: root.split(sep).pop(), size: st.size, base: null });
    return;
  }
  if (!st.isDirectory()) return;
  const walk = async (dir) => {
    const ents = await readdir(dir, { withFileTypes: true });
    ents.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const e of ents) {
      if (e.name[0] === '.' || e.name === 'node_modules') continue;
      const abs = join(dir, e.name);
      if (e.isDirectory()) await walk(abs);
      else if (e.isFile()) {
        const rel = relative(root, abs).split(sep).join('/');
        if (!isDocName(rel)) {
          skipped.count++;
          continue;
        }
        out.push({ abs, rel, size: (await stat(abs)).size });
        if (out.length > LIMITS.files) throw new WikiDocLintError(`ファイルが多すぎます（${LIMITS.files}件まで）: ${root}`);
      }
    }
  };
  await walk(root);
}

/**
 * MCP の入口。paths（絶対パスのファイル・フォルダー）か files（[{ path, text }]）のどちらかを渡す。
 * format: 'both'（既定・結果のJSONとレポート）/ 'json' / 'markdown'
 */
export async function wikiDocLintTool(opts = {}) {
  const lang = opts.lang === undefined ? 'ja' : opts.lang;
  if (LANGS.indexOf(lang) === -1) throw new WikiDocLintError(`lang は ja か en: ${opts.lang}`);
  const hasPaths = opts.paths !== undefined;
  const hasFiles = opts.files !== undefined;
  if (hasPaths === hasFiles) throw new WikiDocLintError('paths（ファイル・フォルダーの絶対パス）か files（{ path, text } の配列）のどちらか一方を渡してください');
  const format = opts.format === undefined ? 'both' : opts.format;
  if (['both', 'json', 'markdown'].indexOf(format) === -1) throw new WikiDocLintError(`format は both / json / markdown のどれか: ${opts.format}`);
  if (opts.threshold !== undefined && !(typeof opts.threshold === 'number' && opts.threshold >= 0.5 && opts.threshold <= 1)) {
    throw new WikiDocLintError(`threshold は 0.5〜1 の数: ${opts.threshold}`);
  }
  if (opts.dictionary !== undefined && typeof opts.dictionary !== 'string') throw new WikiDocLintError('dictionary は文字列（1行に1つ「揃える表記 ← ゆれ」）');

  const files = [];
  let skipped = 0;
  const encodings = {};
  if (hasPaths) {
    const list = Array.isArray(opts.paths) ? opts.paths : [opts.paths];
    if (!list.length) throw new WikiDocLintError('paths が空です');
    const found = [];
    const sk = { count: 0 };
    for (const p of list) {
      if (typeof p !== 'string' || !isAbsolute(p)) throw new WikiDocLintError(`paths は絶対パスで指定してください: ${p}`);
      const before = found.length;
      await collectFiles(p, found, sk);
      // 複数のフォルダーを渡したときに相対パスが衝突しないよう、2つ目以降はフォルダー名を前に付ける
      if (list.length > 1) {
        const name = p.replace(/[\\/]+$/, '').split(/[\\/]/).pop();
        for (let i = before; i < found.length; i++) found[i].rel = name + '/' + found[i].rel;
      }
    }
    skipped = sk.count;
    if (found.length > LIMITS.files) throw new WikiDocLintError(`ファイルが多すぎます（${LIMITS.files}件まで）`);
    let total = 0;
    for (const f of found) {
      if (!isDocName(f.rel) || f.size > LIMITS.fileBytes) {
        skipped++;
        continue;
      }
      total += f.size;
      if (total > LIMITS.totalBytes) throw new WikiDocLintError(`ファイルの合計が大きすぎます（${LIMITS.totalBytes / 1024 / 1024}MB まで）`);
      const dec = decodeBytes(new Uint8Array(await readFile(f.abs)));
      encodings[dec.encoding] = (encodings[dec.encoding] || 0) + 1;
      files.push({ path: f.rel, text: dec.text });
    }
  } else {
    if (!Array.isArray(opts.files)) throw new WikiDocLintError('files は { path, text } の配列で渡してください');
    if (opts.files.length > LIMITS.files) throw new WikiDocLintError(`ファイルが多すぎます（${LIMITS.files}件まで）`);
    let total = 0;
    for (const f of opts.files) {
      if (!f || typeof f.path !== 'string' || typeof f.text !== 'string') throw new WikiDocLintError('files の各要素は { path: 文字列, text: 文字列 }');
      if (!isDocName(f.path)) {
        skipped++;
        continue;
      }
      total += Buffer.byteLength(f.text);
      if (total > LIMITS.totalBytes) throw new WikiDocLintError(`text の合計が大きすぎます（${LIMITS.totalBytes / 1024 / 1024}MB まで）`);
      files.push({ path: f.path, text: f.text });
    }
  }
  if (!files.length) throw new WikiDocLintError('Markdown・HTML・テキスト（.md .markdown .html .htm .txt）のファイルが見つかりません');

  // 渡した辞書は既定の辞書に足す（useDefaultDictionary: false なら渡した辞書だけを使う）
  const base = opts.useDefaultDictionary === false ? '' : lang === 'en' ? DEFAULT_DICT_EN : DEFAULT_DICT;
  const dictionary = opts.dictionary === undefined ? base : base ? base + '\n' + opts.dictionary : opts.dictionary;
  const result = lintDocs(files, {
    threshold: opts.threshold,
    dictionary,
    autoChoon: opts.autoChoon,
    entryPages: opts.entryPages,
    lang,
  });
  const out = { stats: { ...result.stats, skipped } };
  if (hasPaths) out.encodings = encodings;
  if (format !== 'markdown') {
    out.threshold = result.threshold;
    out.duplicates = result.duplicates;
    out.orphans = result.orphans;
    out.terms = result.terms;
    out.broken = result.broken;
    out.entries = result.entries;
    out.short = result.short;
    if (result.dictErrors.length) out.dictErrors = result.dictErrors;
  }
  if (format !== 'json') out.report = buildReport(result);
  return out;
}
