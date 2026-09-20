// HTML → Markdown 変換（tools.first-ch.com/html-md/ と同一ロジック）
//
// 「変換コア」ブロックは site 側の site/html-md/app.js と同一の実装。
// 2箇所ルール: 片方を直したらもう片方も同じ内容で直す（site側が正本）。
// site側はIIFEの中で2字下げ・こちらは行頭に export が付くだけの差なので、コメントで
// 挟んだ範囲を sed で切り出して diff すれば同期漏れを機械確認できる（csv-json.mjs と同じ手順。
// 手順そのものは FirstCHTools の CLAUDE.md を参照）。追記は必ずコアの終わりより下へ。
// DOM（DOMParser / innerHTML）に依存しないので、Node でもブラウザでも同じ結果になる。
import { readFile, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

/* ==================== ここから変換コア（site / MCP で同一） ==================== */

/* HTMLの構文解析からMarkdownの組み立てまで。DOM（DOMParser / innerHTML）には依存しない——
 * ブラウザとNode.jsの両方で同じ結果を出すため、字句解析も木の組み立ても自前で行う。
 * 外部への通信は一切しない（相対URLの解決も渡された baseUrl の文字列計算だけ）。 */

// 閉じタグを持たない要素
const HM_VOID_TAGS = ['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
  'link', 'meta', 'param', 'source', 'track', 'wbr'];
// 中身をタグとして読まない要素（終了タグまで生のまま取る）
const HM_RAW_TEXT_TAGS = ['script', 'style', 'textarea', 'title'];
// 中身ごと捨てる要素（本文ではない）
const HM_DROP_TAGS = ['script', 'style', 'noscript', 'template', 'head', 'meta',
  'link', 'base', 'param', 'source', 'track', 'col', 'colgroup', 'select', 'option',
  'optgroup', 'datalist', 'textarea'];
// Markdownに対応が無く、HTMLのまま残すしかない要素（unknown オプションで挙動を選ぶ）
const HM_MEDIA_TAGS = ['svg', 'math', 'iframe', 'video', 'audio', 'object', 'embed', 'canvas'];
// 「本文だけ」で落とす要素
const HM_CHROME_TAGS = ['nav', 'header', 'footer', 'aside', 'form', 'menu'];
// ブロック要素（段落の切れ目になる）
const HM_BLOCK_TAGS = ['address', 'article', 'aside', 'blockquote', 'caption', 'dd',
  'details', 'div', 'dl', 'dt', 'fieldset', 'figcaption', 'figure', 'footer', 'form',
  'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hgroup', 'hr', 'legend', 'li', 'main',
  'menu', 'nav', 'ol', 'p', 'pre', 'section', 'summary', 'table', 'tbody', 'td',
  'tfoot', 'th', 'thead', 'tr', 'ul'];
// 印だけ外して中身をそのまま流す要素
const HM_TRANSPARENT_TAGS = ['span', 'font', 'small', 'big', 'cite', 'time', 'data',
  'label', 'picture', 'bdi', 'bdo', 'ruby', 'rb', 'nobr', 'center', 'acronym', 'output'];
// HTMLのまま残すインライン要素（Markdownに記法が無い）
const HM_KEEP_INLINE_TAGS = ['sup', 'sub', 'mark', 'ins', 'u', 'kbd', 'samp', 'var',
  'abbr', 'q', 'dfn', 'tt', 'rt', 'rp'];

export const HM_HEADING_STYLES = ['atx', 'setext'];
export const HM_BULLETS = ['-', '*', '+'];
const HM_EMPHASIS = ['*', '_'];
const HM_STRONG = ['**', '__'];
export const HM_CODE_BLOCKS = ['fenced', 'indented'];
const HM_FENCES = ['```', '~~~'];
const HM_HRS = ['---', '***', '___'];
export const HM_LINK_STYLES = ['inline', 'reference', 'strip'];
export const HM_IMAGE_STYLES = ['keep', 'alt', 'drop'];
export const HM_TABLE_STYLES = ['gfm', 'html'];
export const HM_UNKNOWN_STYLES = ['keep', 'text', 'drop'];
export const HM_BR_STYLES = ['spaces', 'backslash', 'html', 'space'];

export const HM_DEFAULTS = {
  headings: 'atx',       // 見出しの書き方（atx = #・setext = 下線）
  bullet: '-',           // 箇条書きの印
  emphasis: '*',         // 強調（em）の印
  strong: '**',          // 太字（strong）の印
  codeBlock: 'fenced',   // コードブロックの書き方
  fence: '```',          // フェンスの文字
  hr: '---',             // 水平線
  links: 'inline',       // リンクの書き方
  images: 'keep',        // 画像の扱い
  tables: 'gfm',         // 表の書き方
  unknown: 'keep',       // Markdownに無い要素の扱い
  br: 'spaces',          // <br> の書き方
  baseUrl: '',           // 相対URLを絶対URLへ直すときの基準
  mainOnly: false,       // main / article だけを取り出す
  escape: true,          // Markdownの記号をエスケープする
  gfm: true,             // 表・取り消し線・タスクリスト（GitHub Flavored Markdown）
  padTables: true,       // 表の桁を揃える
  collapseBlankLines: true, // 空行を2行以上続けない
};

/* -------------------- 文字参照 -------------------- */

const HM_ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', ensp: '\u2002',
  emsp: '\u2003', thinsp: '\u2009', zwnj: '\u200c', zwj: '\u200d', lrm: '\u200e',
  rlm: '\u200f', ndash: '–', mdash: '—', horbar: '―', lsquo: '‘', rsquo: '’',
  sbquo: '‚', ldquo: '“', rdquo: '”', bdquo: '„', dagger: '†', Dagger: '‡',
  permil: '‰', lsaquo: '‹', rsaquo: '›', oline: '‾', frasl: '⁄', euro: '€',
  cent: '¢', pound: '£', yen: '¥', curren: '¤', sect: '§', copy: '©', reg: '®',
  trade: '™', deg: '°', plusmn: '±', sup1: '¹', sup2: '²', sup3: '³', micro: 'µ',
  para: '¶', middot: '·', cedil: '¸', ordm: 'º', ordf: 'ª', laquo: '«', raquo: '»',
  frac14: '¼', frac12: '½', frac34: '¾', iquest: '¿', iexcl: '¡', brvbar: '¦',
  uml: '¨', not: '¬', shy: '\u00ad', macr: '¯', acute: '´', times: '×', divide: '÷',
  minus: '−', lowast: '∗', radic: '√', prop: '∝', infin: '∞', ne: '≠', le: '≤',
  ge: '≥', asymp: '≈', equiv: '≡', sum: '∑', prod: '∏', int: '∫', part: '∂',
  nabla: '∇', isin: '∈', notin: '∉', cap: '∩', cup: '∪', sub: '⊂', sup: '⊃',
  sube: '⊆', supe: '⊇', oplus: '⊕', otimes: '⊗', perp: '⊥', sdot: '⋅', bull: '•',
  hellip: '…', prime: '′', Prime: '″', larr: '←', uarr: '↑', rarr: '→', darr: '↓',
  harr: '↔', crarr: '↵', lArr: '⇐', uArr: '⇑', rArr: '⇒', dArr: '⇓', hArr: '⇔',
  loz: '◊', spades: '♠', clubs: '♣', hearts: '♥', diams: '♦', star: '☆',
  check: '✓', cross: '✗', alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ',
  epsilon: 'ε', zeta: 'ζ', eta: 'η', theta: 'θ', iota: 'ι', kappa: 'κ',
  lambda: 'λ', mu: 'μ', nu: 'ν', xi: 'ξ', omicron: 'ο', pi: 'π', rho: 'ρ',
  sigmaf: 'ς', sigma: 'σ', tau: 'τ', upsilon: 'υ', phi: 'φ', chi: 'χ', psi: 'ψ',
  omega: 'ω', Alpha: 'Α', Beta: 'Β', Gamma: 'Γ', Delta: 'Δ', Epsilon: 'Ε',
  Zeta: 'Ζ', Eta: 'Η', Theta: 'Θ', Iota: 'Ι', Kappa: 'Κ', Lambda: 'Λ', Mu: 'Μ',
  Nu: 'Ν', Xi: 'Ξ', Omicron: 'Ο', Pi: 'Π', Rho: 'Ρ', Sigma: 'Σ', Tau: 'Τ',
  Upsilon: 'Υ', Phi: 'Φ', Chi: 'Χ', Psi: 'Ψ', Omega: 'Ω', agrave: 'à',
  aacute: 'á', acirc: 'â', atilde: 'ã', auml: 'ä', aring: 'å', aelig: 'æ',
  ccedil: 'ç', egrave: 'è', eacute: 'é', ecirc: 'ê', euml: 'ë', igrave: 'ì',
  iacute: 'í', icirc: 'î', iuml: 'ï', eth: 'ð', ntilde: 'ñ', ograve: 'ò',
  oacute: 'ó', ocirc: 'ô', otilde: 'õ', ouml: 'ö', oslash: 'ø', ugrave: 'ù',
  uacute: 'ú', ucirc: 'û', uuml: 'ü', yacute: 'ý', thorn: 'þ', yuml: 'ÿ',
  szlig: 'ß', Agrave: 'À', Aacute: 'Á', Acirc: 'Â', Atilde: 'Ã', Auml: 'Ä',
  Aring: 'Å', AElig: 'Æ', Ccedil: 'Ç', Egrave: 'È', Eacute: 'É', Ecirc: 'Ê',
  Euml: 'Ë', Igrave: 'Ì', Iacute: 'Í', Icirc: 'Î', Iuml: 'Ï', ETH: 'Ð',
  Ntilde: 'Ñ', Ograve: 'Ò', Oacute: 'Ó', Ocirc: 'Ô', Otilde: 'Õ', Ouml: 'Ö',
  Oslash: 'Ø', Ugrave: 'Ù', Uacute: 'Ú', Ucirc: 'Û', Uuml: 'Ü', Yacute: 'Ý',
  THORN: 'Þ', Yuml: 'Ÿ', OElig: 'Œ', oelig: 'œ', Scaron: 'Š', scaron: 'š',
  fnof: 'ƒ', circ: 'ˆ', tilde: '˜',
};

// Windows-1252 として書かれた数値参照（&#147; など）の読み替え表
const HM_CP1252 = {
  128: '€', 130: '‚', 131: 'ƒ', 132: '„', 133: '…', 134: '†', 135: '‡', 136: 'ˆ',
  137: '‰', 138: 'Š', 139: '‹', 140: 'Œ', 142: 'Ž', 145: '‘', 146: '’', 147: '“',
  148: '”', 149: '•', 150: '–', 151: '—', 152: '˜', 153: '™', 154: 'š', 155: '›',
  156: 'œ', 158: 'ž', 159: 'Ÿ',
};

/** 数値文字参照を1文字へ */
function hmCodePoint(num) {
  if (!Number.isFinite(num) || num <= 0) return '�';
  if (HM_CP1252[num]) return HM_CP1252[num];
  if (num > 0x10ffff || (num >= 0xd800 && num <= 0xdfff)) return '�';
  return String.fromCodePoint(num);
}

/** 文字参照（&amp; &#39; &#x27;）をほどく */
export function hmDecodeEntities(text) {
  if (text.indexOf('&') === -1) return text;
  return text.replace(/&(#[Xx][0-9A-Fa-f]+|#\d+|[A-Za-z][A-Za-z0-9]{1,31});?/g, (whole, body) => {
    if (body.charAt(0) === '#') {
      const hex = body.charAt(1) === 'x' || body.charAt(1) === 'X';
      const num = hex ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return hmCodePoint(num);
    }
    if (Object.prototype.hasOwnProperty.call(HM_ENTITIES, body)) return HM_ENTITIES[body];
    // 末尾に「;」が無い形（&ampfoo）は元の文字列のまま残す
    return whole;
  });
}

/* -------------------- 字句解析 -------------------- */

/**
 * HTMLをトークンの列にする。壊れた引用符で暴走しないよう、
 * 正規表現ではなく1文字ずつ走査する（終端が無ければそこで打ち切って印を残す）。
 */
export function hmTokenize(html) {
  const tokens = [];
  const flags = { unterminatedTag: false, unterminatedComment: false };
  const len = html.length;
  let i = 0;
  let textStart = 0;

  const pushText = (end) => {
    if (end > textStart) tokens.push({ type: 'text', value: html.slice(textStart, end) });
  };

  while (i < len) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    const next = html.charAt(lt + 1);
    if (next === '!') {
      if (html.substr(lt + 2, 2) === '--') {
        const end = html.indexOf('-->', lt + 4);
        pushText(lt);
        if (end === -1) { flags.unterminatedComment = true; textStart = len; i = len; break; }
        tokens.push({ type: 'comment', value: html.slice(lt + 4, end) });
        i = end + 3;
        textStart = i;
        continue;
      }
      if (html.substr(lt + 2, 7).toUpperCase() === '[CDATA[') {
        const end = html.indexOf(']]>', lt + 9);
        pushText(lt);
        const stop = end === -1 ? len : end;
        tokens.push({ type: 'text', value: html.slice(lt + 9, stop) });
        i = end === -1 ? len : end + 3;
        textStart = i;
        continue;
      }
      const end = html.indexOf('>', lt + 2);
      pushText(lt);
      tokens.push({ type: 'doctype' });
      i = end === -1 ? len : end + 1;
      textStart = i;
      continue;
    }
    if (next === '/') {
      const m = /^<\/([A-Za-z][A-Za-z0-9:-]*)\s*/.exec(html.slice(lt, lt + 80));
      if (!m) { i = lt + 1; continue; }
      const end = html.indexOf('>', lt + m[0].length - 1);
      pushText(lt);
      tokens.push({ type: 'end', name: m[1].toLowerCase() });
      if (end === -1) { flags.unterminatedTag = true; textStart = len; i = len; break; }
      i = end + 1;
      textStart = i;
      continue;
    }
    if (!/[A-Za-z]/.test(next)) { i = lt + 1; continue; }

    // 開始タグ
    let p = lt + 1;
    while (p < len && /[A-Za-z0-9:-]/.test(html.charAt(p))) p += 1;
    const name = html.slice(lt + 1, p).toLowerCase();
    const attrs = {};
    let selfClosing = false;
    let broken = false;
    for (;;) {
      while (p < len && /\s/.test(html.charAt(p))) p += 1;
      if (p >= len) { broken = true; break; }
      const c = html.charAt(p);
      if (c === '>') { p += 1; break; }
      if (c === '/' && html.charAt(p + 1) === '>') { selfClosing = true; p += 2; break; }
      if (c === '/' || c === '=') { p += 1; continue; }
      const nameStart = p;
      while (p < len && !/[\s/>=]/.test(html.charAt(p))) p += 1;
      const attrName = html.slice(nameStart, p).toLowerCase();
      let value = '';
      let q = p;
      while (q < len && /\s/.test(html.charAt(q))) q += 1;
      if (html.charAt(q) === '=') {
        q += 1;
        while (q < len && /\s/.test(html.charAt(q))) q += 1;
        const quote = html.charAt(q);
        if (quote === '"' || quote === "'") {
          const close = html.indexOf(quote, q + 1);
          if (close === -1) {
            // 引用符が閉じていない。ここで打ち切らないと残り全部を属性値として飲み込む
            value = html.slice(q + 1);
            p = len;
            broken = true;
            attrs[attrName] = hmDecodeEntities(value);
            break;
          }
          value = html.slice(q + 1, close);
          p = close + 1;
        } else {
          const vStart = q;
          while (q < len && !/[\s>]/.test(html.charAt(q))) q += 1;
          value = html.slice(vStart, q);
          p = q;
        }
      }
      if (attrName) attrs[attrName] = hmDecodeEntities(value);
    }
    pushText(lt);
    if (broken) flags.unterminatedTag = true;
    tokens.push({ type: 'start', name, attrs, selfClosing });
    i = p;
    textStart = i;

    if (HM_RAW_TEXT_TAGS.indexOf(name) !== -1 && !selfClosing) {
      const lower = html.toLowerCase();
      let close = lower.indexOf('</' + name, i);
      if (close === -1) close = len;
      const raw = html.slice(i, close);
      tokens.push({ type: 'text', value: raw, raw: true });
      tokens.push({ type: 'end', name });
      const gt = html.indexOf('>', close);
      i = close === len ? len : (gt === -1 ? len : gt + 1);
      textStart = i;
    }
  }
  pushText(len);
  return { tokens, flags };
}

/* -------------------- 木の組み立て -------------------- */

// 開始タグが来たときに自動で閉じる組み合わせ
const HM_AUTO_CLOSE = {
  li: ['li'],
  dt: ['dt', 'dd'],
  dd: ['dt', 'dd'],
  tr: ['td', 'th', 'tr'],
  td: ['td', 'th'],
  th: ['td', 'th'],
  thead: ['td', 'th', 'tr'],
  tbody: ['td', 'th', 'tr', 'thead'],
  tfoot: ['td', 'th', 'tr', 'thead', 'tbody'],
  option: ['option'],
  p: ['p'],
};

/** 要素ノード */
function hmElement(name, attrs) {
  return { type: 'element', name, attrs: attrs || {}, children: [] };
}

/**
 * トークン列から木を作る。閉じ忘れ・閉じすぎのどちらでも落ちない
 * （開いたままの要素は最後にまとめて閉じ、行き場のない終了タグは捨てる）。
 */
function hmBuildTree(tokens) {
  const root = hmElement('#root', {});
  const stack = [root];
  const flags = { strayEnd: 0, unclosed: 0 };
  const top = () => stack[stack.length - 1];

  for (const t of tokens) {
    if (t.type === 'text') {
      top().children.push({ type: 'text', value: t.raw ? t.value : hmDecodeEntities(t.value), raw: !!t.raw });
      continue;
    }
    if (t.type === 'comment') {
      top().children.push({ type: 'comment', value: t.value });
      continue;
    }
    if (t.type === 'doctype') continue;
    if (t.type === 'start') {
      const closers = HM_AUTO_CLOSE[t.name];
      if (closers) {
        while (stack.length > 1 && closers.indexOf(top().name) !== -1) stack.pop();
      }
      // <p> はブロック要素の開始で閉じる
      if (HM_BLOCK_TAGS.indexOf(t.name) !== -1 && t.name !== 'p') {
        while (stack.length > 1 && top().name === 'p') stack.pop();
      }
      const el = hmElement(t.name, t.attrs);
      top().children.push(el);
      if (!t.selfClosing && HM_VOID_TAGS.indexOf(t.name) === -1) stack.push(el);
      continue;
    }
    if (t.type === 'end') {
      let found = -1;
      for (let k = stack.length - 1; k > 0; k -= 1) {
        if (stack[k].name === t.name) { found = k; break; }
      }
      if (found === -1) { flags.strayEnd += 1; continue; }
      if (found !== stack.length - 1) flags.unclosed += stack.length - 1 - found;
      stack.length = found;
    }
  }
  if (stack.length > 1) flags.unclosed += stack.length - 1;
  return { root, flags };
}

/** HTMLを木にする（本体・外部通信なし） */
export function hmParse(html) {
  const { tokens, flags } = hmTokenize(String(html === undefined || html === null ? '' : html));
  const built = hmBuildTree(tokens);
  return { root: built.root, flags: Object.assign({}, flags, built.flags) };
}

/* -------------------- 木の下ごしらえ -------------------- */

/** name の要素を（最初のものだけ）深さ優先で探す */
function hmFind(node, names) {
  if (node.type === 'element' && names.indexOf(node.name) !== -1) return node;
  if (!node.children) return null;
  for (const child of node.children) {
    const hit = hmFind(child, names);
    if (hit) return hit;
  }
  return null;
}

/** 捨てる要素を取り除きながら、落とした数を数える */
function hmPrune(node, o, counts) {
  if (!node.children) return;
  const kept = [];
  for (const child of node.children) {
    if (child.type === 'comment') { counts.comments += 1; continue; }
    if (child.type !== 'element') { kept.push(child); continue; }
    if (HM_DROP_TAGS.indexOf(child.name) !== -1) {
      if (child.name === 'script') counts.scripts += 1;
      else if (child.name === 'style') counts.styles += 1;
      if (child.name === 'colgroup' || child.name === 'col') continue;
      continue;
    }
    if (o.mainOnly && HM_CHROME_TAGS.indexOf(child.name) !== -1) { counts.chrome += 1; continue; }
    if (child.attrs && (child.attrs.hidden !== undefined
      || /(^|;)\s*display\s*:\s*none/i.test(child.attrs.style || ''))) {
      counts.hidden += 1;
      continue;
    }
    hmPrune(child, o, counts);
    kept.push(child);
  }
  node.children = kept;
}

/* -------------------- 文字幅とエスケープ -------------------- */

// 等幅フォントで2桁を占める文字（表の桁揃えに使う）
const HM_WIDE_RANGES = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x1f300, 0x1f64f],
  [0x1f900, 0x1f9ff], [0x20000, 0x3fffd],
];

/** 表示幅（全角を2桁として数える） */
export function hmWidth(s) {
  let w = 0;
  for (const ch of String(s)) {
    const cp = ch.codePointAt(0);
    if (cp === 0x200b || cp === 0xfeff || (cp >= 0x0300 && cp <= 0x036f)) continue;
    let wide = false;
    for (const r of HM_WIDE_RANGES) {
      if (cp >= r[0] && cp <= r[1]) { wide = true; break; }
    }
    w += wide ? 2 : 1;
  }
  return w;
}

/** Markdownの記号として読まれてしまう文字を打ち消す */
export function hmEscapeText(text) {
  return text
    .replace(/([\\*[\]`])/g, '\\$1')
    .replace(/_/g, (m, idx, whole) => {
      // 単語の途中（snake_case）は読み手に意味があるのでそのまま残す
      const before = idx > 0 ? whole.charAt(idx - 1) : '';
      const after = whole.charAt(idx + 1) || '';
      const word = /[A-Za-z0-9]/;
      return word.test(before) && word.test(after) ? '_' : '\\_';
    })
    .replace(/<(?=[A-Za-z/!?])/g, '\\<')
    .replace(/&(?=[A-Za-z#][A-Za-z0-9]*;)/g, '\\&')
    .replace(/~~/g, '\\~\\~');
}

/** 行頭がブロック記法に見える場合だけ打ち消す */
function hmEscapeLineStarts(text) {
  return text.split('\n').map((line) => line
    .replace(/^(\s*)(#{1,6})(\s|$)/, '$1\\$2$3')
    .replace(/^(\s*)([-+])(\s)/, '$1\\$2$3')
    .replace(/^(\s*)(\d{1,9})([.)])(\s)/, '$1$2\\$3$4')
    .replace(/^(\s*)(>)/, '$1\\$2')
    .replace(/^(\s*)(={2,}|-{2,})\s*$/, '$1\\$2')).join('\n');
}

/* -------------------- URL -------------------- */

/** 相対URLを baseUrl で絶対URLにする（base が空なら何もしない） */
export function hmResolveUrl(url, base) {
  const raw = String(url === undefined || url === null ? '' : url).trim();
  if (!raw || !base) return raw;
  if (/^[a-z][a-z0-9+.-]*:/i.test(raw) || raw.charAt(0) === '#') return raw;
  try {
    return new URL(raw, base).href;
  } catch (e) {
    return raw;
  }
}

/** Markdownのリンク先として書ける形に整える */
function hmLinkTarget(url) {
  const raw = String(url || '').trim().replace(/\s+/g, ' ');
  if (raw === '') return '';
  if (/[\s()<>]/.test(raw)) return '<' + raw.replace(/[<>]/g, (c) => encodeURIComponent(c)) + '>';
  return raw;
}

/** タイトル属性を " " で括る */
function hmTitlePart(title) {
  const t = String(title || '').trim().replace(/\s+/g, ' ');
  if (!t) return '';
  return ' "' + t.replace(/"/g, '\\"') + '"';
}

/* -------------------- 生HTMLへの書き戻し -------------------- */

const HM_ATTR_ESCAPE = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };

/** 残すと決めた要素をHTMLの文字列に戻す */
export function hmSerialize(node) {
  if (node.type === 'text') return String(node.value).replace(/[&<>]/g, (c) => HM_ATTR_ESCAPE[c]);
  if (node.type === 'comment') return '';
  if (node.type !== 'element') return '';
  const attrs = Object.keys(node.attrs).map((k) => {
    const v = String(node.attrs[k]).replace(/[&<>"]/g, (c) => HM_ATTR_ESCAPE[c]);
    return v === '' ? ' ' + k : ' ' + k + '="' + v + '"';
  }).join('');
  if (HM_VOID_TAGS.indexOf(node.name) !== -1) return '<' + node.name + attrs + '>';
  const inner = (node.children || []).map(hmSerialize).join('');
  return '<' + node.name + attrs + '>' + inner + '</' + node.name + '>';
}

/** 要素の中の文字だけを取り出す（コードブロック・alt用） */
function hmTextOf(node) {
  if (node.type === 'text') return String(node.value);
  if (node.type !== 'element') return '';
  if (node.name === 'br') return '\n';
  return (node.children || []).map(hmTextOf).join('');
}

/* -------------------- インライン -------------------- */

/** インライン要素かどうか（ブロックでなければインラインとして扱う） */
function hmIsBlock(node) {
  return node.type === 'element' && HM_BLOCK_TAGS.indexOf(node.name) !== -1;
}

/** 前後の空白を印の外へ出す（** text ** は強調にならないため） */
function hmWrapInline(inner, mark) {
  const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(inner);
  const body = m[2];
  if (body === '') return m[1] + m[3] === '' ? '' : ' ';
  return m[1] + mark + body + mark + m[3];
}

/** インラインコードのバッククォートの本数を決める */
function hmCodeSpan(text) {
  const body = text.replace(/\r?\n/g, ' ');
  let longest = 0;
  const runs = body.match(/`+/g);
  if (runs) for (const r of runs) longest = Math.max(longest, r.length);
  const fence = '`'.repeat(longest + 1);
  const pad = /^`|`$|^\s|\s$/.test(body) && body !== '' ? ' ' : '';
  return fence + pad + body + pad + fence;
}

/** ノードの並びをインラインのMarkdownへ */
function hmInline(nodes, ctx) {
  let out = '';
  for (const node of nodes) {
    out += hmInlineNode(node, ctx);
  }
  return out;
}

function hmInlineNode(node, ctx) {
  const o = ctx.o;
  if (node.type === 'comment') return '';
  if (node.type === 'text') {
    let text = String(node.value);
    if (!ctx.pre) text = text.replace(/[\t\n\r ]+/g, ' ').replace(/\u00a0/g, ' ');
    if (ctx.code) return text;
    return o.escape ? hmEscapeText(text) : text;
  }
  if (node.type !== 'element') return '';
  const name = node.name;
  const attrs = node.attrs || {};

  if (HM_DROP_TAGS.indexOf(name) !== -1) return '';
  if (name === 'br') {
    if (ctx.cell) return o.gfm ? '<br>' : ' ';
    if (o.br === 'space') return ' ';
    if (o.br === 'html') return '<br>\n';
    if (o.br === 'backslash') return '\\\n';
    return '  \n';
  }
  if (name === 'wbr') return '';
  if (name === 'img') {
    ctx.stats.images += 1;
    const alt = String(attrs.alt || '').replace(/\s+/g, ' ').replace(/[[\]]/g, '\\$&');
    if (o.images === 'drop') return '';
    const src = hmResolveUrl(attrs.src || attrs['data-src'] || '', o.baseUrl);
    if (o.images === 'alt' || !src) return alt;
    if (!/^[a-z][a-z0-9+.-]*:/i.test(src) && o.baseUrl === '') ctx.stats.relative += 1;
    return '![' + alt + '](' + hmLinkTarget(src) + hmTitlePart(attrs.title) + ')';
  }
  if (name === 'input') {
    // リストの項目の先頭にあるチェックボックスは li 側で読む。それ以外は本文ではない
    if (String(attrs.type || '').toLowerCase() === 'checkbox') return '';
    return attrs.value && String(attrs.type || '').toLowerCase() !== 'hidden' ? String(attrs.value) : '';
  }
  if (name === 'a') {
    const href = String(attrs.href || '');
    const inner = hmInline(node.children, Object.assign({}, ctx, { inLink: true }));
    if (ctx.inLink || !href || o.links === 'strip') return inner;
    if (/^javascript:/i.test(href)) return inner;
    const label = inner.trim();
    if (label === '') return '';
    ctx.stats.links += 1;
    const url = hmResolveUrl(href, o.baseUrl);
    if (!/^[a-z][a-z0-9+.-]*:/i.test(url) && url.charAt(0) !== '#' && o.baseUrl === '') ctx.stats.relative += 1;
    if (o.links === 'reference') {
      const id = hmRefId(ctx, url, attrs.title);
      return '[' + label + '][' + id + ']';
    }
    // 文字列がそのままURLなら自動リンクにする
    if (label.replace(/\\/g, '') === url && /^(https?|mailto):/i.test(url)) return '<' + url + '>';
    return '[' + label + '](' + hmLinkTarget(url) + hmTitlePart(attrs.title) + ')';
  }
  if (name === 'code') {
    if (ctx.code) return hmInline(node.children, ctx);
    return hmCodeSpan(hmTextOf(node));
  }
  if (name === 'strong' || name === 'b') {
    return hmWrapInline(hmInline(node.children, ctx), o.strong);
  }
  if (name === 'em' || name === 'i') {
    return hmWrapInline(hmInline(node.children, ctx), o.emphasis);
  }
  if (name === 'del' || name === 's' || name === 'strike') {
    if (o.gfm) return hmWrapInline(hmInline(node.children, ctx), '~~');
    return o.unknown === 'keep' ? hmSerialize(node) : hmInline(node.children, ctx);
  }
  if (HM_TRANSPARENT_TAGS.indexOf(name) !== -1) return hmInline(node.children, ctx);
  if (HM_MEDIA_TAGS.indexOf(name) !== -1) {
    ctx.stats.media += 1;
    if (o.unknown === 'drop') return '';
    if (o.unknown === 'text') return hmInline(node.children, ctx);
    ctx.notes.push({ code: 'MEDIA_KEPT', tag: name });
    return hmSerialize(node);
  }
  if (HM_KEEP_INLINE_TAGS.indexOf(name) !== -1) {
    const inner = hmInline(node.children, ctx);
    if (inner.trim() === '') return '';
    if (o.unknown === 'keep') {
      ctx.notes.push({ code: 'HTML_KEPT', tag: name });
      return '<' + name + '>' + inner + '</' + name + '>';
    }
    return inner;
  }
  // 未知のインライン要素は中身だけ流す
  return hmInline(node.children, ctx);
}

/** 参照リンクの番号を採る（同じ宛先は同じ番号を使い回す） */
function hmRefId(ctx, url, title) {
  const key = url + '\u0000' + (title || '');
  if (ctx.refMap[key]) return ctx.refMap[key];
  const id = String(ctx.refs.length + 1);
  ctx.refMap[key] = id;
  ctx.refs.push({ id, url, title: title || '' });
  return id;
}

/* -------------------- ブロック -------------------- */

/** 子ノードをブロックの配列にする（続くインラインは段落にまとめる） */
function hmBlocks(children, ctx) {
  const out = [];
  let buffer = [];
  const flush = () => {
    if (!buffer.length) return;
    let text = hmInline(buffer, ctx).trim();
    buffer = [];
    if (text === '') return;
    if (ctx.o.escape) text = hmEscapeLineStarts(text);
    out.push({ text, kind: 'paragraph' });
  };
  for (const child of children) {
    if (hmIsBlock(child)) {
      flush();
      const block = hmBlock(child, ctx);
      if (block && block.text !== '') out.push(block);
    } else {
      buffer.push(child);
    }
  }
  flush();
  return out;
}

/** ブロックの配列を1つの文字列へ（リストの直後だけ空行を空けない） */
function hmJoinBlocks(blocks, tight) {
  let out = '';
  for (let i = 0; i < blocks.length; i += 1) {
    if (i > 0) out += (tight && blocks[i].kind === 'list') ? '\n' : '\n\n';
    out += blocks[i].text;
  }
  return out;
}

/** 1つのブロック要素をMarkdownへ */
function hmBlock(el, ctx) {
  const o = ctx.o;
  const name = el.name;

  if (/^h[1-6]$/.test(name)) {
    const level = Number(name.charAt(1));
    const text = hmInline(el.children, ctx).replace(/\s*\n\s*/g, ' ').trim();
    if (text === '') return null;
    ctx.stats.headings += 1;
    if (o.headings === 'setext' && level <= 2) {
      return { text: text + '\n' + (level === 1 ? '='.repeat(Math.max(3, hmWidth(text))) : '-'.repeat(Math.max(3, hmWidth(text)))), kind: 'heading' };
    }
    return { text: '#'.repeat(level) + ' ' + text.replace(/#+\s*$/, ''), kind: 'heading' };
  }

  if (name === 'hr') return { text: o.hr, kind: 'hr' };

  if (name === 'pre') return hmCodeBlock(el, ctx);

  if (name === 'blockquote') {
    const inner = hmJoinBlocks(hmBlocks(el.children, ctx), false);
    if (inner.trim() === '') return null;
    const text = inner.split('\n').map((line) => (line === '' ? '>' : '> ' + line)).join('\n');
    return { text, kind: 'quote' };
  }

  if (name === 'ul' || name === 'ol') return hmList(el, ctx);

  if (name === 'table') return hmTable(el, ctx);

  if (name === 'dl') return hmDefList(el, ctx);

  if (name === 'details' || name === 'summary' || name === 'figure' || name === 'figcaption'
    || name === 'div' || name === 'section' || name === 'article' || name === 'main'
    || name === 'header' || name === 'footer' || name === 'aside' || name === 'nav'
    || name === 'address' || name === 'form' || name === 'fieldset' || name === 'legend'
    || name === 'hgroup' || name === 'menu' || name === 'caption' || name === 'li'
    || name === 'dd' || name === 'dt' || name === 'td' || name === 'th'
    || name === 'tr' || name === 'thead' || name === 'tbody' || name === 'tfoot'
    || name === 'p') {
    const blocks = hmBlocks(el.children, ctx);
    if (!blocks.length) return null;
    if (name === 'summary' && blocks.length === 1) {
      return { text: hmWrapInline(blocks[0].text, o.strong), kind: 'paragraph' };
    }
    return { text: hmJoinBlocks(blocks, false), kind: blocks.length === 1 ? blocks[0].kind : 'group' };
  }

  const blocks = hmBlocks(el.children, ctx);
  if (!blocks.length) return null;
  return { text: hmJoinBlocks(blocks, false), kind: 'group' };
}

/** pre（＋中の code）をコードブロックへ */
function hmCodeBlock(el, ctx) {
  const o = ctx.o;
  const codeEl = (el.children || []).find((c) => c.type === 'element' && c.name === 'code');
  const target = codeEl || el;
  let code = hmTextOf(target).replace(/\r\n?/g, '\n');
  code = code.replace(/^\n/, '').replace(/\n[ \t]*$/, '');
  if (code === '') return null;
  ctx.stats.codeBlocks += 1;
  const cls = String((codeEl && codeEl.attrs && codeEl.attrs.class) || el.attrs.class || '');
  const m = /(?:^|\s)(?:language|lang|highlight|brush:)[-:]?([A-Za-z0-9+#.-]+)/.exec(cls);
  let lang = m ? m[1].toLowerCase() : '';
  if (lang === 'highlight' || lang === 'source') lang = '';
  if (o.codeBlock === 'indented') {
    return { text: code.split('\n').map((line) => (line === '' ? '' : '    ' + line)).join('\n'), kind: 'code' };
  }
  const fenceChar = o.fence.charAt(0);
  let fenceLen = 3;
  const runs = code.match(new RegExp('^' + (fenceChar === '`' ? '`' : '~') + '{3,}', 'gm'));
  if (runs) for (const r of runs) fenceLen = Math.max(fenceLen, r.length + 1);
  const fence = fenceChar.repeat(fenceLen);
  return { text: fence + lang + '\n' + code + '\n' + fence, kind: 'code' };
}

/** ul / ol をリストへ（入れ子もそのまま） */
function hmList(el, ctx) {
  const o = ctx.o;
  const ordered = el.name === 'ol';
  const startAttr = parseInt(el.attrs.start, 10);
  let n = Number.isFinite(startAttr) ? startAttr : 1;
  const items = [];
  ctx.stats.lists += 1;
  for (const child of el.children || []) {
    if (child.type !== 'element') continue;
    if (child.name !== 'li') {
      // li の外に置かれた入れ子リストも項目として拾う
      if (child.name === 'ul' || child.name === 'ol') {
        const nested = hmList(child, ctx);
        if (nested) items.push({ marker: '', text: nested.text, nested: true });
      }
      continue;
    }
    const marker = ordered ? n + '. ' : o.bullet + ' ';
    if (ordered) n += 1;
    let children = child.children || [];
    let task = '';
    if (o.gfm) {
      const box = hmFindCheckbox(children);
      if (box) {
        task = box.attrs.checked !== undefined ? '[x] ' : '[ ] ';
        children = hmWithout(children, box);
        ctx.stats.tasks += 1;
      }
    }
    const blocks = hmBlocks(children, Object.assign({}, ctx, { listDepth: ctx.listDepth + 1 }));
    const body = hmJoinBlocks(blocks, true);
    items.push({ marker, text: task + body });
  }
  if (!items.length) return null;
  const indentOf = (marker) => ' '.repeat(marker.length);
  const text = items.map((item) => {
    if (item.nested) {
      return item.text.split('\n').map((line) => (line === '' ? '' : '  ' + line)).join('\n');
    }
    const lines = item.text.split('\n');
    const pad = indentOf(item.marker);
    return lines.map((line, idx) => {
      if (idx === 0) return item.marker + line;
      return line === '' ? '' : pad + line;
    }).join('\n');
  }).join('\n');
  return { text, kind: 'list' };
}

/** li の先頭にあるチェックボックスを探す */
function hmFindCheckbox(children) {
  for (const child of children) {
    if (child.type === 'text' && child.value.trim() === '') continue;
    if (child.type !== 'element') return null;
    if (child.name === 'input' && String(child.attrs.type || '').toLowerCase() === 'checkbox') return child;
    if (child.name === 'label' || child.name === 'p' || child.name === 'span') {
      const hit = hmFindCheckbox(child.children || []);
      if (hit) return hit;
    }
    return null;
  }
  return null;
}

/** 木から1つのノードだけ取り除いたコピーを返す */
function hmWithout(children, target) {
  const out = [];
  for (const child of children) {
    if (child === target) continue;
    if (child.type === 'element' && child.children && child.children.length) {
      const inner = hmWithout(child.children, target);
      if (inner !== child.children) {
        out.push(Object.assign({}, child, { children: inner }));
        continue;
      }
    }
    out.push(child);
  }
  return out;
}

/** dl を定義リストへ（Markdownに標準の記法が無いので term と : で書く） */
function hmDefList(el, ctx) {
  const o = ctx.o;
  const lines = [];
  for (const child of el.children || []) {
    if (child.type !== 'element') continue;
    if (child.name === 'dt') {
      const text = hmInline(child.children, ctx).replace(/\s*\n\s*/g, ' ').trim();
      if (text) lines.push((lines.length ? '\n' : '') + hmWrapInline(text, o.strong));
    } else if (child.name === 'dd') {
      const text = hmJoinBlocks(hmBlocks(child.children, ctx), false).replace(/\n/g, '\n  ');
      if (text) lines.push(': ' + text);
    }
  }
  if (!lines.length) return null;
  ctx.notes.push({ code: 'DEF_LIST' });
  return { text: lines.join('\n'), kind: 'group' };
}

/* -------------------- 表 -------------------- */

/** table から行（tr）を順番に集める */
function hmRowsOf(el, rows) {
  for (const child of el.children || []) {
    if (child.type !== 'element') continue;
    if (child.name === 'tr') rows.push(child);
    else if (child.name === 'thead' || child.name === 'tbody' || child.name === 'tfoot') hmRowsOf(child, rows);
  }
  return rows;
}

/** セルの配置（align属性 / style の text-align） */
function hmCellAlign(cell) {
  const a = String(cell.attrs.align || '').toLowerCase();
  if (a === 'left' || a === 'center' || a === 'right') return a;
  const m = /text-align\s*:\s*(left|center|right)/i.exec(cell.attrs.style || '');
  return m ? m[1].toLowerCase() : '';
}

/** table を GFM の表へ（セルにブロックが入っていればHTMLのまま残す） */
function hmTable(el, ctx) {
  const o = ctx.o;
  ctx.stats.tables += 1;
  const caption = (el.children || []).find((c) => c.type === 'element' && c.name === 'caption');
  const rows = hmRowsOf(el, []);
  if (!rows.length) return null;

  if (o.tables === 'html' || !o.gfm) {
    ctx.notes.push({ code: 'TABLE_HTML' });
    return { text: hmSerialize(el), kind: 'table' };
  }

  const grid = [];
  const aligns = [];
  let complex = false;
  let spans = 0;
  for (const tr of rows) {
    const cells = [];
    for (const cell of tr.children || []) {
      if (cell.type !== 'element' || (cell.name !== 'td' && cell.name !== 'th')) continue;
      // セルの中にブロック（リスト・表・コード）があるとGFMの表には収まらない
      for (const inner of cell.children || []) {
        if (inner.type === 'element'
          && ['ul', 'ol', 'table', 'pre', 'blockquote', 'dl'].indexOf(inner.name) !== -1) complex = true;
      }
      const text = hmInline(cell.children, Object.assign({}, ctx, { cell: true }))
        .replace(/\s*\n\s*/g, ' ').replace(/\|/g, '\\|').trim();
      const colspan = Math.max(1, Math.min(32, parseInt(cell.attrs.colspan, 10) || 1));
      const rowspan = Math.max(1, parseInt(cell.attrs.rowspan, 10) || 1);
      if (colspan > 1 || rowspan > 1) spans += 1;
      cells.push({ text, align: hmCellAlign(cell), header: cell.name === 'th' });
      for (let k = 1; k < colspan; k += 1) cells.push({ text: '', align: '', header: cell.name === 'th' });
    }
    if (cells.length) grid.push(cells);
  }
  if (!grid.length) return null;

  if (complex) {
    ctx.notes.push({ code: 'TABLE_COMPLEX' });
    return { text: hmSerialize(el), kind: 'table' };
  }
  if (spans) ctx.notes.push({ code: 'TABLE_SPAN', n: spans });

  const columns = grid.reduce((max, row) => Math.max(max, row.length), 0);
  for (const row of grid) while (row.length < columns) row.push({ text: '', align: '', header: false });

  let header;
  let body;
  const firstIsHeader = grid[0].some((c) => c.header)
    || (el.children || []).some((c) => c.type === 'element' && c.name === 'thead');
  if (firstIsHeader) {
    header = grid[0].map((c) => c.text);
    body = grid.slice(1);
  } else {
    header = new Array(columns).fill('');
    body = grid;
    ctx.notes.push({ code: 'TABLE_NO_HEAD' });
  }
  for (let c = 0; c < columns; c += 1) {
    let align = '';
    for (const row of grid) {
      if (row[c] && row[c].align) { align = row[c].align; break; }
    }
    aligns.push(align);
  }

  const widths = new Array(columns).fill(3);
  if (o.padTables) {
    for (let c = 0; c < columns; c += 1) {
      widths[c] = Math.max(widths[c], hmWidth(header[c]));
      for (const row of body) widths[c] = Math.max(widths[c], hmWidth(row[c].text));
    }
  }
  const pad = (text, c) => {
    if (!o.padTables) return text;
    const gap = widths[c] - hmWidth(text);
    return text + ' '.repeat(gap > 0 ? gap : 0);
  };
  const line = (cells) => '| ' + cells.map((t, c) => pad(t, c)).join(' | ') + ' |';
  const sep = aligns.map((a, c) => {
    const w = o.padTables ? widths[c] : 3;
    if (a === 'left') return ':' + '-'.repeat(Math.max(2, w - 1));
    if (a === 'right') return '-'.repeat(Math.max(2, w - 1)) + ':';
    if (a === 'center') return ':' + '-'.repeat(Math.max(1, w - 2)) + ':';
    return '-'.repeat(Math.max(3, w));
  });
  const out = [line(header), '| ' + sep.join(' | ') + ' |'];
  for (const row of body) out.push(line(row.map((c) => c.text)));
  let text = out.join('\n');
  if (caption) {
    const capText = hmInline(caption.children, ctx).replace(/\s*\n\s*/g, ' ').trim();
    if (capText) text = hmWrapInline(capText, o.emphasis) + '\n\n' + text;
  }
  return { text, kind: 'table' };
}

/* -------------------- 入口 -------------------- */

/** 渡されたオプションを既定値で埋め、値の妥当性も見る */
function hmOptions(options) {
  const o = Object.assign({}, HM_DEFAULTS, options || {});
  const pick = (key, allowed) => { if (allowed.indexOf(o[key]) === -1) o[key] = HM_DEFAULTS[key]; };
  pick('headings', HM_HEADING_STYLES);
  pick('bullet', HM_BULLETS);
  pick('emphasis', HM_EMPHASIS);
  pick('strong', HM_STRONG);
  pick('codeBlock', HM_CODE_BLOCKS);
  pick('fence', HM_FENCES);
  pick('hr', HM_HRS);
  pick('links', HM_LINK_STYLES);
  pick('images', HM_IMAGE_STYLES);
  pick('tables', HM_TABLE_STYLES);
  pick('unknown', HM_UNKNOWN_STYLES);
  pick('br', HM_BR_STYLES);
  o.baseUrl = String(o.baseUrl || '').trim();
  return o;
}

/**
 * HTML断片をMarkdownへ変換する。返すのは
 * { markdown, stats, notes, refs } で、notes はコードだけ（文言は呼び出し側が持つ）。
 */
export function hmToMarkdown(html, options) {
  const o = hmOptions(options);
  const parsed = hmParse(html);
  const counts = { scripts: 0, styles: 0, comments: 0, chrome: 0, hidden: 0 };
  hmPrune(parsed.root, o, counts);

  let root = parsed.root;
  if (o.mainOnly) {
    const main = hmFind(root, ['main', 'article']);
    if (main) root = main;
    else {
      const body = hmFind(root, ['body']);
      if (body) root = body;
    }
  } else {
    const body = hmFind(root, ['body']);
    if (body) root = body;
  }

  const ctx = {
    o,
    notes: [],
    refs: [],
    refMap: {},
    listDepth: 0,
    stats: {
      headings: 0, links: 0, images: 0, tables: 0, codeBlocks: 0,
      lists: 0, tasks: 0, media: 0, relative: 0,
    },
  };

  const blocks = hmBlocks(root.children || [], ctx);
  let markdown = hmJoinBlocks(blocks, false);

  if (o.links === 'reference' && ctx.refs.length) {
    markdown += '\n\n' + ctx.refs
      .map((r) => '[' + r.id + ']: ' + hmLinkTarget(r.url) + hmTitlePart(r.title)).join('\n');
  }

  // 行末の空白は落とす。ただし2つちょうどのときは <br> 由来の改行なので残す
  markdown = markdown.split('\n')
    .map((line) => line.replace(/[ \t]+$/, (m) => (m === '  ' ? '  ' : '')))
    .join('\n');
  if (o.collapseBlankLines) markdown = markdown.replace(/\n{3,}/g, '\n\n');
  markdown = markdown.replace(/^\n+/, '').replace(/\s+$/, '');
  if (markdown !== '') markdown += '\n';

  // 指摘の組み立て
  const notes = [];
  const seen = {};
  for (const n of ctx.notes) {
    const key = n.code + (n.tag || '');
    if (seen[key]) { seen[key].n = (seen[key].n || 1) + (n.n || 1); continue; }
    const copy = Object.assign({}, n);
    seen[key] = copy;
    notes.push(copy);
  }
  if (counts.scripts || counts.styles) notes.unshift({ code: 'DROPPED_CODE', scripts: counts.scripts, styles: counts.styles });
  if (counts.chrome) notes.unshift({ code: 'MAIN_ONLY', n: counts.chrome });
  if (counts.hidden) notes.push({ code: 'HIDDEN_DROPPED', n: counts.hidden });
  if (parsed.flags.unterminatedTag) notes.unshift({ code: 'BROKEN_TAG' });
  if (parsed.flags.unterminatedComment) notes.unshift({ code: 'BROKEN_COMMENT' });
  if (parsed.flags.unclosed) notes.push({ code: 'UNCLOSED', n: parsed.flags.unclosed });
  if (parsed.flags.strayEnd) notes.push({ code: 'STRAY_END', n: parsed.flags.strayEnd });
  if (ctx.stats.relative) notes.push({ code: 'RELATIVE_URL', n: ctx.stats.relative });
  if (ctx.stats.tables && !o.gfm) notes.push({ code: 'GFM_OFF' });

  const stats = Object.assign({}, ctx.stats, {
    chars: markdown.length,
    lines: markdown === '' ? 0 : markdown.replace(/\n$/, '').split('\n').length,
    words: (markdown.match(/[A-Za-z0-9]+/g) || []).length,
  });

  return { markdown, stats, notes, refs: ctx.refs, options: o };
}

/* ==================== ここまで変換コア ==================== */

/* ==================== ここからMCP側だけの部分 ==================== */

// 指摘の文面（site側は同じ code を日英の T テーブルで出し分けている）
const NOTE_JA = {
  BROKEN_TAG: () => 'タグが閉じられていません（属性の引用符が開いたままです）。以降をすべて1つの属性値として読みました。',
  BROKEN_COMMENT: () => 'コメント（<!--）が閉じられていないため、以降をすべてコメントとして捨てました。',
  UNCLOSED: (n) => `閉じられていない要素が ${n.n} 個ありました。ブラウザと同じように末尾で自動的に閉じています。`,
  STRAY_END: (n) => `対応する開始タグが無い閉じタグを ${n.n} 個無視しました。`,
  DROPPED_CODE: (n) => `<script> を ${n.scripts} 個・<style> を ${n.styles} 個取り除きました（中身は本文ではなくコードのため）。`,
  MAIN_ONLY: (n) => `main_only により header / nav / footer / aside / form を ${n.n} 個取り除きました。`,
  HIDDEN_DROPPED: (n) => `非表示の要素（hidden 属性・display:none）を ${n.n} 個取り除きました。`,
  RELATIVE_URL: (n) => `相対パスのままのリンク・画像が ${n.n} 件あります。base_url に元ページのアドレスを渡すと絶対URLに直せます。`,
  TABLE_NO_HEAD: () => '見出し行の無い表がありました。GFMの表は見出し行を省けないため、空の見出し行を書いています。',
  TABLE_SPAN: (n) => `colspan / rowspan を使ったセルが ${n.n} 個あります。Markdownの表にセルの結合は無いので、colspan は空セルで埋め、rowspan は先頭の行にだけ値が入ります。`,
  TABLE_COMPLEX: () => '表のセルの中にリスト・表・コードブロックが入っています。Markdownの表には収まらないため、その表はHTMLのまま残しました。',
  TABLE_HTML: () => '指定により表はHTMLのまま残しています。',
  DEF_LIST: () => '<dl> は「太字の語＋": " の行」として書き出しました（Markdown Extra の記法で、CommonMark・GFMには含まれません）。',
  MEDIA_KEPT: (n) => `<${n.tag}> はMarkdownに対応する書き方が無いため、HTMLのまま残しました（unknown で扱いを変えられます）。`,
  HTML_KEPT: (n) => `<${n.tag}> はMarkdownに対応する書き方が無いため、インラインのHTMLタグのまま残しました。`,
  GFM_OFF: () => '表が含まれていますが gfm=false です——表・タスクリスト・取り消し線はGitHubの拡張で、CommonMarkには含まれません。',
};

const NOTE_EN = {
  BROKEN_TAG: () => 'A tag is not closed properly (an attribute quote is left open); everything after it was read as one attribute value.',
  BROKEN_COMMENT: () => 'An HTML comment (<!--) is never closed, so the rest of the document was treated as comment and dropped.',
  UNCLOSED: (n) => `${n.n} element(s) were left open and closed automatically at the end, the way a browser does.`,
  STRAY_END: (n) => `${n.n} closing tag(s) had no matching opening tag and were ignored.`,
  DROPPED_CODE: (n) => `Removed ${n.scripts} <script> and ${n.styles} <style> block(s); their contents are code, not text.`,
  MAIN_ONLY: (n) => `main_only removed ${n.n} header / nav / footer / aside / form block(s).`,
  HIDDEN_DROPPED: (n) => `${n.n} element(s) marked hidden (the hidden attribute or display:none) were removed.`,
  RELATIVE_URL: (n) => `${n.n} link(s) or image(s) still point at a relative path. Pass the page's address as base_url to make them absolute.`,
  TABLE_NO_HEAD: () => 'A table had no header row. A GFM table cannot omit one, so an empty header was written above the separator row.',
  TABLE_SPAN: (n) => `${n.n} cell(s) use colspan / rowspan. Markdown tables have no merged cells: a colspan was filled with empty cells and a rowspan is only written on its first row.`,
  TABLE_COMPLEX: () => 'A table cell contains a list, a table or a code block, which does not fit in a Markdown table, so that table was left as HTML.',
  TABLE_HTML: () => 'Tables were left as HTML because that is what was asked for.',
  DEF_LIST: () => 'A <dl> was written as a bold term plus a ": " line (the Markdown Extra syntax, which is in neither CommonMark nor GFM).',
  MEDIA_KEPT: (n) => `<${n.tag}> has no Markdown equivalent and was kept as raw HTML (use unknown to change that).`,
  HTML_KEPT: (n) => `<${n.tag}> has no Markdown equivalent and was kept as an inline HTML tag.`,
  GFM_OFF: () => 'The source has a table, but gfm=false — tables, task lists and strikethrough are GitHub extensions, not CommonMark.',
};

const hmNoteText = (lang, note) => {
  const table = lang === 'en' ? NOTE_EN : NOTE_JA;
  const make = table[note.code];
  return make ? make(note) : note.code;
};

export class HtmlToMarkdownToolError extends Error {}

/**
 * HTML断片をMarkdownへ変換する（tools.first-ch.com/html-md/ と同一ロジック）。
 *
 * @param {object} opts
 * @param {string} [opts.html]        変換するHTML（path と排他）
 * @param {string} [opts.path]        変換するファイルの絶対パス（UTF-8として読む）
 * @param {string} [opts.outputPath]  結果を書き出す絶対パス（指定すると markdown は返さない）
 * @param {boolean} [opts.main_only]  main / article の中だけを取り出す
 * @param {string} [opts.base_url]    相対URLを絶対URLへ直すための基準
 * @param {boolean} [opts.gfm]        表・タスクリスト・取り消し線（既定 true）
 * @param {boolean} [opts.escape]     Markdownの記号をエスケープする（既定 true）
 * @param {boolean} [opts.pad_tables] 表の桁を揃える（既定 true）
 * @param {string} [opts.headings]    atx / setext
 * @param {string} [opts.bullet]      - / * / +
 * @param {string} [opts.code_block]  fenced / indented
 * @param {string} [opts.links]       inline / reference / strip
 * @param {string} [opts.images]      keep / alt / drop
 * @param {string} [opts.tables]      gfm / html
 * @param {string} [opts.unknown]     keep / text / drop
 * @param {string} [opts.br]          spaces / backslash / html / space
 * @param {string} [opts.lang]        notes の言語（ja / en）
 */
export async function htmlToMarkdownTool(opts = {}) {
  const o = opts || {};
  const lang = o.lang === undefined ? 'ja' : o.lang;
  if (lang !== 'ja' && lang !== 'en') throw new HtmlToMarkdownToolError(`lang は ja か en: ${o.lang}`);

  const hasHtml = typeof o.html === 'string';
  const hasPath = typeof o.path === 'string' && o.path.trim() !== '';
  if (hasHtml === hasPath) {
    throw new HtmlToMarkdownToolError('html か path のどちらか一方を指定してください');
  }
  const enumOpt = (name, value, allowed) => {
    if (value === undefined || value === null) return undefined;
    if (allowed.indexOf(value) === -1) {
      throw new HtmlToMarkdownToolError(`${name} は ${allowed.join(' / ')} のどれかです: ${value}`);
    }
    return value;
  };

  const source = hasHtml ? String(o.html) : await readFile(o.path, 'utf8');
  const options = {
    headings: enumOpt('headings', o.headings, HM_HEADING_STYLES),
    bullet: enumOpt('bullet', o.bullet, HM_BULLETS),
    codeBlock: enumOpt('code_block', o.code_block, HM_CODE_BLOCKS),
    links: enumOpt('links', o.links, HM_LINK_STYLES),
    images: enumOpt('images', o.images, HM_IMAGE_STYLES),
    tables: enumOpt('tables', o.tables, HM_TABLE_STYLES),
    unknown: enumOpt('unknown', o.unknown, HM_UNKNOWN_STYLES),
    br: enumOpt('br', o.br, HM_BR_STYLES),
    baseUrl: o.base_url === undefined ? '' : String(o.base_url),
    mainOnly: o.main_only === true,
    gfm: o.gfm !== false,
    escape: o.escape !== false,
    padTables: o.pad_tables !== false,
  };
  for (const key of Object.keys(options)) {
    if (options[key] === undefined) delete options[key];
  }

  const r = hmToMarkdown(source, options);
  const used = r.options;
  const result = {
    ok: true,
    source: hasHtml ? { type: 'html', bytes: Buffer.byteLength(source, 'utf8') }
      : { type: 'file', path: o.path, name: basename(o.path), bytes: Buffer.byteLength(source, 'utf8') },
    markdown: r.markdown,
    stats: {
      headings: r.stats.headings,
      links: r.stats.links,
      images: r.stats.images,
      tables: r.stats.tables,
      code_blocks: r.stats.codeBlocks,
      lists: r.stats.lists,
      task_items: r.stats.tasks,
      kept_html: r.stats.media,
      relative_urls: r.stats.relative,
      characters: r.stats.chars,
      lines: r.stats.lines,
    },
    options: {
      main_only: used.mainOnly,
      base_url: used.baseUrl,
      gfm: used.gfm,
      escape: used.escape,
      pad_tables: used.padTables,
      headings: used.headings,
      bullet: used.bullet,
      code_block: used.codeBlock,
      links: used.links,
      images: used.images,
      tables: used.tables,
      unknown: used.unknown,
      br: used.br,
    },
    notes: r.notes.map((n) => ({ code: n.code, message: hmNoteText(lang, n) })),
  };
  if (used.links === 'reference' && r.refs.length) {
    result.references = r.refs.map((ref) => ({ id: ref.id, url: ref.url, title: ref.title || null }));
  }
  if (o.outputPath) {
    await writeFile(o.outputPath, r.markdown, 'utf8');
    result.output = o.outputPath;
    // ファイルに書けたなら本文は重複した重い情報でしかない
    delete result.markdown;
  }
  return result;
}
