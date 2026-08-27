/* robots.txt ジェネレーター（robotstxt_generate）
 * 生成コア（AI_CRAWLERS / buildRobotsTxt とその補助関数）は
 * FirstCHTools の site/robots-txt/app.js と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 下のコアは site 側からそのまま持ってきたもので、両ファイルから
 * コアの開始/終了コメントに挟まれた範囲を sed で切り出し（site側は字下げ2文字を落とす）、
 * diff が空になることで同期を機械的に確認できる。
 *
 * クロールの許可/禁止・サイトマップ宣言・AIクローラー（GPTBot / ClaudeBot 等）の
 * 許可プリセットから robots.txt を組み立て、書き間違いの指摘も返す。
 * 完全ローカル処理・ネットワーク送信なし。 */

/* ==================== ここから生成コア（site / MCP で同一） ==================== */

export const AI_PRESETS = ['allow', 'block', 'training', 'none', 'custom'];
export const AI_DECISIONS = ['allow', 'block', 'omit'];

// AIクローラーの一覧。purpose は収集の目的で、robots.txt の書き分けの単位になる:
//   training = モデルの学習データを集める / search = AI検索の索引を作る
//   user     = 利用者がURLを貼った・質問したときだけ取りに来る
// 「学習は断りたいが、AI検索には出したい」が典型的な要望なので purpose で分けられるようにしてある。
export const AI_CRAWLERS = [
  { ua: 'GPTBot', vendor: 'OpenAI', purpose: 'training',
    ja: 'ChatGPTのモデル学習に使うデータを集める', en: 'Collects data used to train OpenAI models' },
  { ua: 'OAI-SearchBot', vendor: 'OpenAI', purpose: 'search',
    ja: 'ChatGPTの検索結果に出すための索引を作る（学習には使われない）', en: 'Indexes pages so they can appear in ChatGPT search (not used for training)' },
  { ua: 'ChatGPT-User', vendor: 'OpenAI', purpose: 'user',
    ja: '利用者が貼ったURLをその場で読みに来る', en: 'Fetches a URL a user pasted into ChatGPT' },
  { ua: 'ClaudeBot', vendor: 'Anthropic', purpose: 'training',
    ja: 'Claudeのモデル学習に使うデータを集める', en: 'Collects data used to train Claude' },
  { ua: 'Claude-SearchBot', vendor: 'Anthropic', purpose: 'search',
    ja: 'Claudeの検索結果に出すための索引を作る', en: 'Indexes pages for Claude search results' },
  { ua: 'Claude-User', vendor: 'Anthropic', purpose: 'user',
    ja: '利用者の指示でそのページを読みに来る', en: 'Fetches a page when a user asks for it' },
  { ua: 'Google-Extended', vendor: 'Google', purpose: 'training',
    ja: 'Geminiの学習・回答の根拠づけに使う（Google検索の順位には影響しない）', en: 'Gemini training and grounding (does not affect Google Search ranking)' },
  { ua: 'Applebot-Extended', vendor: 'Apple', purpose: 'training',
    ja: 'Apple Intelligenceの学習に使う（検索用のApplebot本体とは別）', en: 'Apple Intelligence training (separate from Applebot, which is for search)' },
  { ua: 'PerplexityBot', vendor: 'Perplexity', purpose: 'search',
    ja: 'Perplexityの検索索引を作る', en: 'Indexes pages for Perplexity search' },
  { ua: 'Perplexity-User', vendor: 'Perplexity', purpose: 'user',
    ja: '利用者の質問に答えるためにそのページを読みに来る', en: 'Fetches a page to answer a user question' },
  { ua: 'Meta-ExternalAgent', vendor: 'Meta', purpose: 'training',
    ja: 'Meta AIの学習に使うデータを集める', en: 'Collects data used to train Meta AI' },
  { ua: 'meta-externalfetcher', vendor: 'Meta', purpose: 'user',
    ja: '利用者の指示でそのページを読みに来る', en: 'Fetches a page when a user asks for it' },
  { ua: 'Amazonbot', vendor: 'Amazon', purpose: 'search',
    ja: 'Alexaなどの回答に使うために読みに来る', en: 'Fetches pages to answer questions in Alexa and other services' },
  { ua: 'Bytespider', vendor: 'ByteDance', purpose: 'training',
    ja: 'ByteDance（TikTok運営）のモデル学習に使うデータを集める', en: 'Collects training data for ByteDance (TikTok) models' },
  { ua: 'CCBot', vendor: 'Common Crawl', purpose: 'training',
    ja: '公開データセットを作る（多くのLLMの学習元になっている）', en: 'Builds a public dataset that many LLMs are trained on' },
  { ua: 'cohere-ai', vendor: 'Cohere', purpose: 'training',
    ja: 'Cohereのモデル学習に使うデータを集める', en: 'Collects data used to train Cohere models' },
  { ua: 'MistralAI-User', vendor: 'Mistral AI', purpose: 'user',
    ja: 'Le Chatの利用者の指示で読みに来る', en: 'Fetches a page when a Le Chat user asks for it' },
  { ua: 'DuckAssistBot', vendor: 'DuckDuckGo', purpose: 'search',
    ja: 'DuckAssistの回答を作るために読みに来る', en: 'Fetches pages to build DuckAssist answers' },
  { ua: 'YouBot', vendor: 'You.com', purpose: 'search',
    ja: 'You.comの検索索引を作る', en: 'Indexes pages for You.com search' },
  { ua: 'Diffbot', vendor: 'Diffbot', purpose: 'training',
    ja: 'ナレッジグラフと学習用データセットを作る', en: 'Builds a knowledge graph and training datasets' },
  { ua: 'ImagesiftBot', vendor: 'ImageSift', purpose: 'training',
    ja: '画像のデータセットを作る', en: 'Builds image datasets' },
  { ua: 'Omgilibot', vendor: 'Webz.io', purpose: 'training',
    ja: '学習用データセットとして販売するために集める', en: 'Collects data that is sold as training datasets' },
  { ua: 'Timpibot', vendor: 'Timpi', purpose: 'training',
    ja: '分散型検索・データセット向けに集める', en: 'Collects data for a decentralised search index and datasets' },
  { ua: 'anthropic-ai', vendor: 'Anthropic', purpose: 'training',
    ja: '旧称（現在はClaudeBot。古い設定を残しているサイト向け）', en: 'Legacy name (now ClaudeBot; kept for older configurations)' },
];

export const PURPOSE_LABEL = {
  training: { ja: '学習', en: 'Training' },
  search: { ja: 'AI検索', en: 'AI search' },
  user: { ja: '利用者の指示', en: 'User-triggered' },
};

const ROBOTS_MSG = {
  header: {
    ja: () => '# robots.txt — First CH Tools (https://tools.first-ch.com/robots-txt/) で生成',
    en: () => '# robots.txt — generated with First CH Tools (https://tools.first-ch.com/robots-txt/)',
  },
  headerSite: {
    ja: (a) => `# 対象サイト: ${a.url}`,
    en: (a) => `# Site: ${a.url}`,
  },
  sitemapComment: {
    ja: () => 'サイトマップの場所（クロールの起点になる）',
    en: () => 'Sitemap location (where crawlers start from)',
  },
  aiBlockComment: {
    ja: (a) => `AIクローラー: 拒否（${a.n}件）`,
    en: (a) => `AI crawlers: blocked (${a.n})`,
  },
  aiAllowComment: {
    ja: (a) => `AIクローラー: 許可（${a.n}件）`,
    en: (a) => `AI crawlers: allowed (${a.n})`,
  },
  aiAllowBlockedComment: {
    ja: (a) => `AIクローラー: 許可の指定（${a.n}件）だが共通ルールでサイト全体を拒否`,
    en: (a) => `AI crawlers: marked as allowed (${a.n}) but the shared rule blocks the whole site`,
  },
  pathFromUrl: {
    ja: (a) => `絶対URLからパスだけを取り出しました（${a.from} → ${a.to}）。robots.txt に書けるのは「/」で始まるパスだけです。`,
    en: (a) => `Took just the path out of a full URL (${a.from} → ${a.to}). robots.txt only accepts paths that start with "/".`,
  },
  pathFixed: {
    ja: (a) => `パスの先頭に「/」を補いました（${a.from} → ${a.to}）。パスはサイトのルートからの絶対パスで書きます。`,
    en: (a) => `Added the leading slash (${a.from} → ${a.to}). Paths are written from the site root.`,
  },
  pathSpace: {
    ja: (a) => `「${a.value}」に空白が含まれています。robots.txt は空白でパスが切れるため、%20 に置き換えてください。`,
    en: (a) => `"${a.value}" contains a space. A space ends the path in robots.txt, so write it as %20.`,
  },
  pathNonAscii: {
    ja: (a) => `「${a.value}」にASCII以外の文字が含まれています。日本語のパスはパーセントエンコード（%E3%81%82 の形）で書くのが確実です。`,
    en: (a) => `"${a.value}" contains non-ASCII characters. Percent-encode them (the %E3%81%82 form) to be safe.`,
  },
  pathWildcard: {
    ja: (a) => `「${a.value}」はワイルドカード（* と $）を使っています。Google・Bing・OpenAIなど主要なクローラーは解釈しますが、対応していないクローラーは文字どおりに読みます。`,
    en: (a) => `"${a.value}" uses wildcards (* and $). Google, Bing and OpenAI understand them, but crawlers that do not will read them literally.`,
  },
  crawlDelayIgnored: {
    ja: () => 'Crawl-delay はGooglebotが解釈しません（Googleのクロール頻度はSearch Consoleで調整します）。Bing・Yandexなどには効きます。',
    en: () => 'Googlebot ignores Crawl-delay (adjust Google crawl rate in Search Console). Bing and Yandex do honour it.',
  },
  crawlDelayInvalid: {
    ja: (a) => `Crawl-delay の値「${a.value}」は0以上の数値ではないため出力しませんでした。`,
    en: (a) => `Crawl-delay "${a.value}" is not a number of zero or more, so it was left out.`,
  },
  sitemapNotAbsolute: {
    ja: (a) => `Sitemap は絶対URLで書く必要があります（「${a.value}」は http:// または https:// で始まっていません）。`,
    en: (a) => `Sitemap must be an absolute URL ("${a.value}" does not start with http:// or https://).`,
  },
  noSitemap: {
    ja: () => 'サイトマップが宣言されていません。「Sitemap: https://example.com/sitemap.xml」を入れておくと、クローラーがページの一覧を見つけやすくなります。',
    en: () => 'No sitemap is declared. Adding "Sitemap: https://example.com/sitemap.xml" helps crawlers find every page.',
  },
  blockAll: {
    ja: () => 'すべてのクローラーにサイト全体を拒否しています（User-agent: * に Disallow: /）。このまま公開すると検索結果に出なくなります。',
    en: () => 'Every crawler is blocked from the whole site (Disallow: / under User-agent: *). Published as-is, the site will drop out of search results.',
  },
  blockAllSitemap: {
    ja: () => 'サイト全体を拒否しているため、宣言したサイトマップもクローラーには読まれません。',
    en: () => 'Because the whole site is blocked, crawlers will not read the sitemap you declared either.',
  },
  notNoindex: {
    ja: () => 'Disallow はクロールを止めるだけで、すでに検索結果に載っているページを消すものではありません（他サイトからリンクされていればURLだけ残ることがあります）。消したいページには noindex を使います。',
    en: () => 'Disallow only stops crawling; it does not remove pages already in the index (a URL linked from elsewhere can still be listed). Use noindex to drop a page.',
  },
  duplicateAgent: {
    ja: (a) => `User-agent「${a.name}」が複数のグループに出てきます。クローラーは自分に一致するグループを1つだけ使うため、意図しない方が採用されることがあります。`,
    en: (a) => `User-agent "${a.name}" appears in more than one group. A crawler obeys only one matching group, so the wrong one may win.`,
  },
  aiOwnGroup: {
    ja: () => 'AIクローラーに専用のグループを作ると、そのクローラーは User-agent: * のルールを読まなくなります（一致するグループを1つだけ使う仕様のため）。共通の禁止パスはAI側のグループにも書き写す必要があります。',
    en: () => 'Once an AI crawler has its own group it stops reading the User-agent: * rules (a crawler obeys only one matching group). Shared disallow paths must be repeated in the AI group.',
  },
  aiInherited: {
    ja: (a) => `共通の禁止パス（${a.n}件）を、許可するAIクローラーのグループにも書き写しました。`,
    en: (a) => `Copied the shared disallow paths (${a.n}) into the group for the AI crawlers you allow.`,
  },
  aiAllowButBlocked: {
    ja: () => 'サイト全体を拒否しているため、許可としたAIクローラーにも Disallow: / が引き継がれています（結果としてどのAIも読めません）。',
    en: () => 'The whole site is blocked, so the AI crawlers you allowed inherit Disallow: / as well — none of them can read anything.',
  },
  unlistedAllowed: {
    ja: () => 'robots.txt は「書いていないものは許可」の仕組みです。一覧に無いクローラーや新しく登場したクローラーは、拒否したことになりません。',
    en: () => 'robots.txt allows anything it does not mention. Crawlers missing from this list — including new ones — are not blocked.',
  },
  tooLarge: {
    ja: (a) => `${a.kb} KB あります。Googleが読むのは先頭500KiBまでで、それ以降は無視されます。`,
    en: (a) => `The file is ${a.kb} KB. Google only reads the first 500 KiB and ignores the rest.`,
  },
  ok: {
    ja: () => '気になる点はありません。サイトのルート（https://example.com/robots.txt）に置いてください。',
    en: () => 'Nothing to flag. Upload it to the site root (https://example.com/robots.txt).',
  },
};

// 改行（オプションでカンマ）区切りの入力を、空行・コメント行・重複を落とした配列にする
export function robotsList(value, opts) {
  const options = opts || {};
  const raw = Array.isArray(value)
    ? value.map((v) => String(v == null ? '' : v))
    : String(value == null ? '' : value).split(/\r?\n/);
  const parts = options.comma ? raw.reduce((acc, line) => acc.concat(line.split(',')), []) : raw;
  const out = [];
  for (const part of parts) {
    const s = part.trim();
    if (!s || s.charAt(0) === '#') continue;
    if (out.indexOf(s) === -1) out.push(s);
  }
  return out;
}

// 同じ指摘は1回だけ積む（同じパスを2度書いても2行にしない）
function robotsWarn(warnings, level, code, lang, args) {
  const entry = ROBOTS_MSG[code];
  const message = entry ? entry[lang](args || {}) : code;
  for (const w of warnings) if (w.code === code && w.message === message) return;
  warnings.push({ level, code, message });
}

function robotsPath(value, warnings, lang) {
  let s = String(value == null ? '' : value).trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) {
    const m = s.match(/^https?:\/\/[^/]*(\/.*)?$/i);
    const path = (m && m[1]) || '/';
    robotsWarn(warnings, 'info', 'pathFromUrl', lang, { from: s, to: path });
    s = path;
  } else if (s.charAt(0) !== '/' && s.charAt(0) !== '*') {
    const fixed = '/' + s;
    robotsWarn(warnings, 'info', 'pathFixed', lang, { from: s, to: fixed });
    s = fixed;
  }
  if (/\s/.test(s)) robotsWarn(warnings, 'warn', 'pathSpace', lang, { value: s });
  if (/[^\x20-\x7E]/.test(s)) robotsWarn(warnings, 'info', 'pathNonAscii', lang, { value: s });
  if (s.indexOf('*') !== -1 || s.indexOf('$') !== -1) robotsWarn(warnings, 'info', 'pathWildcard', lang, { value: s });
  return s;
}

// AIクローラー1件ごとの扱い（allow / block / omit）を決める。overrides が個別指定
function robotsAiDecisions(ai) {
  const conf = ai || {};
  const preset = AI_PRESETS.indexOf(conf.preset) === -1 ? 'training' : conf.preset;
  const overrides = conf.overrides || {};
  const decisions = {};
  for (const bot of AI_CRAWLERS) {
    let d;
    if (preset === 'allow') d = 'allow';
    else if (preset === 'block') d = 'block';
    else if (preset === 'training') d = bot.purpose === 'training' ? 'block' : 'allow';
    else d = 'omit'; // none / custom は既定で書かない
    const o = overrides[bot.ua];
    if (AI_DECISIONS.indexOf(o) !== -1) d = o;
    decisions[bot.ua] = d;
  }
  return { preset, decisions };
}

function robotsRenderGroup(group, opts) {
  const lines = [];
  const comments = opts.comments;
  if (comments && group.comment) lines.push('# ' + group.comment);
  const agents = group.userAgents.map((a) => (typeof a === 'string' ? { name: a, note: '' } : a));
  const heads = agents.map((a) => 'User-agent: ' + a.name);
  // 注釈を付ける行だけを見て桁を揃える（ボット名はASCIIなので文字数＝表示幅）
  let width = 0;
  if (comments) heads.forEach((h, i) => { if (agents[i].note) width = Math.max(width, h.length); });
  heads.forEach((h, i) => {
    const note = comments ? agents[i].note : '';
    lines.push(note ? h + new Array(Math.max(1, width - h.length + 2) + 1).join(' ') + '# ' + note : h);
  });
  const disallow = group.disallow || [];
  const allow = group.allow || [];
  if (!disallow.length && !allow.length) {
    // 空の Disallow は「すべて許可」を意味する（1994年の原案から現在のRFC 9309まで共通）
    lines.push(opts.allowStyle === 'allow-slash' ? 'Allow: /' : 'Disallow:');
  } else {
    for (const p of disallow) lines.push('Disallow: ' + p);
    for (const p of allow) lines.push('Allow: ' + p);
  }
  if (group.crawlDelay != null) lines.push('Crawl-delay: ' + group.crawlDelay);
  return lines.join('\n');
}

/* robots.txt を組み立てる。
 * config = {
 *   groups: [{ userAgents, disallow, allow, crawlDelay, comment }],  // 省略時は User-agent: * ひとつ
 *   ai: { preset: 'allow'|'block'|'training'|'none'|'custom', overrides: {UA: 'allow'|'block'|'omit'}, inherit },
 *   sitemaps, siteUrl, comments, allowStyle: 'disallow-empty'|'allow-slash', lang: 'ja'|'en'
 * }
 * 返り値 = { text, warnings, stats, ai } */
export function buildRobotsTxt(config) {
  const conf = config || {};
  const lang = conf.lang === 'en' ? 'en' : 'ja';
  const comments = conf.comments !== false;
  const allowStyle = conf.allowStyle === 'allow-slash' ? 'allow-slash' : 'disallow-empty';
  const warnings = [];
  const siteUrl = String(conf.siteUrl == null ? '' : conf.siteUrl).trim();

  const inputGroups = Array.isArray(conf.groups) && conf.groups.length ? conf.groups : [{ userAgents: ['*'] }];
  const groups = [];
  for (const g of inputGroups) {
    const source = g || {};
    const agents = robotsList(source.userAgents == null ? '*' : source.userAgents, { comma: true });
    const disallow = robotsList(source.disallow).map((p) => robotsPath(p, warnings, lang)).filter(Boolean);
    const allow = robotsList(source.allow).map((p) => robotsPath(p, warnings, lang)).filter(Boolean);
    let crawlDelay = null;
    const rawDelay = source.crawlDelay;
    if (rawDelay != null && String(rawDelay).trim() !== '') {
      const n = Number(rawDelay);
      if (!isFinite(n) || n < 0) {
        robotsWarn(warnings, 'warn', 'crawlDelayInvalid', lang, { value: String(rawDelay) });
      } else {
        crawlDelay = n;
        robotsWarn(warnings, 'info', 'crawlDelayIgnored', lang, {});
      }
    }
    groups.push({
      comment: source.comment || '',
      userAgents: agents.length ? agents : ['*'],
      disallow,
      allow,
      crawlDelay,
    });
  }

  // 「*」のグループ＝共通ルール。AIクローラーへ書き写す元になる
  let base = null;
  for (const g of groups) if (g.userAgents.indexOf('*') !== -1) { base = g; break; }

  const { preset, decisions } = robotsAiDecisions(conf.ai);
  const inherit = !(conf.ai && conf.ai.inherit === false);
  const blockedBots = [];
  const allowedBots = [];
  for (const bot of AI_CRAWLERS) {
    const d = decisions[bot.ua];
    const entry = { name: bot.ua, note: bot.vendor + ' / ' + PURPOSE_LABEL[bot.purpose][lang] };
    if (d === 'block') blockedBots.push(entry);
    else if (d === 'allow') allowedBots.push(entry);
  }
  const aiGroups = [];
  if (blockedBots.length) {
    aiGroups.push({
      comment: ROBOTS_MSG.aiBlockComment[lang]({ n: blockedBots.length }),
      userAgents: blockedBots,
      disallow: ['/'],
      allow: [],
      crawlDelay: null,
    });
  }
  if (allowedBots.length) {
    const inheritedDisallow = inherit && base ? base.disallow.slice() : [];
    const inheritedAllow = inherit && base ? base.allow.slice() : [];
    // 共通ルールが全体拒否のときは「許可」と書くと出力と食い違うので見出しを変える
    const shutOut = inheritedDisallow.indexOf('/') !== -1;
    const commentKey = shutOut ? 'aiAllowBlockedComment' : 'aiAllowComment';
    aiGroups.push({
      comment: ROBOTS_MSG[commentKey][lang]({ n: allowedBots.length }),
      userAgents: allowedBots,
      disallow: inheritedDisallow,
      allow: inheritedAllow,
      crawlDelay: null,
    });
    if (inheritedDisallow.length) robotsWarn(warnings, 'info', 'aiInherited', lang, { n: inheritedDisallow.length });
    if (shutOut) robotsWarn(warnings, 'warn', 'aiAllowButBlocked', lang, {});
  }
  if (aiGroups.length) robotsWarn(warnings, 'info', 'aiOwnGroup', lang, {});
  if (blockedBots.length) robotsWarn(warnings, 'info', 'unlistedAllowed', lang, {});

  const allGroups = groups.concat(aiGroups);

  // 同じUser-agentが2つのグループに出ていないか（クローラーは1グループしか読まない）
  const seen = {};
  for (const g of allGroups) {
    for (const a of g.userAgents) {
      const name = typeof a === 'string' ? a : a.name;
      const key = name.toLowerCase();
      if (seen[key]) robotsWarn(warnings, 'warn', 'duplicateAgent', lang, { name });
      seen[key] = true;
    }
  }

  const sitemaps = robotsList(conf.sitemaps).map((s) => {
    if (!/^https?:\/\//i.test(s)) robotsWarn(warnings, 'warn', 'sitemapNotAbsolute', lang, { value: s });
    return s;
  });

  const blocksAll = !!base && base.disallow.indexOf('/') !== -1;
  if (blocksAll) {
    robotsWarn(warnings, 'warn', 'blockAll', lang, {});
    if (sitemaps.length) robotsWarn(warnings, 'info', 'blockAllSitemap', lang, {});
  }
  let ruleCount = 0;
  for (const g of allGroups) ruleCount += g.disallow.length + g.allow.length;
  if (ruleCount) robotsWarn(warnings, 'info', 'notNoindex', lang, {});
  if (!sitemaps.length) robotsWarn(warnings, 'info', 'noSitemap', lang, {});

  const blocks = [];
  if (comments) {
    const head = [ROBOTS_MSG.header[lang]({})];
    if (siteUrl) head.push(ROBOTS_MSG.headerSite[lang]({ url: siteUrl }));
    blocks.push(head.join('\n'));
  }
  for (const g of allGroups) blocks.push(robotsRenderGroup(g, { comments, allowStyle }));
  if (sitemaps.length) {
    const sm = [];
    if (comments) sm.push('# ' + ROBOTS_MSG.sitemapComment[lang]({}));
    for (const s of sitemaps) sm.push('Sitemap: ' + s);
    blocks.push(sm.join('\n'));
  }
  const text = blocks.join('\n\n') + '\n';
  const bytes = new TextEncoder().encode(text).length;
  if (bytes > 512000) robotsWarn(warnings, 'warn', 'tooLarge', lang, { kb: Math.round(bytes / 102.4) / 10 });

  return {
    text,
    warnings,
    stats: {
      groups: allGroups.length,
      rules: ruleCount,
      sitemaps: sitemaps.length,
      lines: text.replace(/\n$/, '').split('\n').length,
      bytes,
      aiAllowed: allowedBots.length,
      aiBlocked: blockedBots.length,
    },
    ai: { preset, decisions, allowed: allowedBots.map((b) => b.name), blocked: blockedBots.map((b) => b.name) },
  };
}

/* ==================== ここまで生成コア ==================== */

/* ==================== MCPツールの入口（site側には無い） ==================== */

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const AI_PURPOSES = ['training', 'search', 'user'];

function assertEnum(value, allowed, label) {
  if (value != null && allowed.indexOf(value) === -1) {
    throw new Error(`${label} は ${allowed.join(' / ')} のいずれかを指定してください（受け取った値: ${JSON.stringify(value)}）`);
  }
}

/** AIクローラーの一覧を返す（生成せずに相手を確かめたいとき用） */
export function listAiCrawlers(lang = 'ja') {
  const l = lang === 'en' ? 'en' : 'ja';
  return {
    count: AI_CRAWLERS.length,
    purposes: AI_PURPOSES.map((p) => ({
      purpose: p,
      label: PURPOSE_LABEL[p][l],
      crawlers: AI_CRAWLERS.filter((b) => b.purpose === p).map((b) => b.ua),
    })),
    crawlers: AI_CRAWLERS.map((b) => ({
      userAgent: b.ua,
      vendor: b.vendor,
      purpose: b.purpose,
      description: b[l],
    })),
  };
}

/** MCPツール robotstxt_generate の本体 */
export async function robotsTxtGenerate(opts = {}) {
  const lang = opts.lang === 'en' ? 'en' : 'ja';
  if (opts.listCrawlers) return listAiCrawlers(lang);

  assertEnum(opts.allowStyle, ['disallow-empty', 'allow-slash'], 'allowStyle');
  const ai = opts.ai ? { ...opts.ai } : {};
  assertEnum(ai.preset, AI_PRESETS, 'ai.preset');
  if (ai.overrides) {
    for (const [ua, decision] of Object.entries(ai.overrides)) {
      if (!AI_CRAWLERS.some((b) => b.ua === ua)) {
        throw new Error(`ai.overrides の "${ua}" は一覧にないクローラーです（listCrawlers=true で一覧を取得できます）`);
      }
      assertEnum(decision, AI_DECISIONS, `ai.overrides["${ua}"]`);
    }
  }

  let groups;
  if (Array.isArray(opts.groups) && opts.groups.length) {
    groups = opts.groups;
  } else {
    groups = [{
      userAgents: opts.userAgents == null ? '*' : opts.userAgents,
      disallow: opts.disallow,
      allow: opts.allow,
      crawlDelay: opts.crawlDelay,
    }];
  }
  const others = robotsList(opts.blockCrawlers, { comma: true });
  if (others.length) {
    groups = groups.concat([{
      comment: lang === 'en' ? 'Other crawlers you asked to stay out' : '個別に拒否したクローラー',
      userAgents: others,
      disallow: ['/'],
    }]);
  }

  const result = buildRobotsTxt({
    groups,
    ai,
    sitemaps: opts.sitemaps,
    siteUrl: opts.siteUrl,
    comments: opts.comments,
    allowStyle: opts.allowStyle,
    lang,
  });

  if (opts.outputPath) {
    if (!path.isAbsolute(opts.outputPath)) throw new Error('outputPath は絶対パスで指定してください');
    await writeFile(opts.outputPath, result.text, 'utf8');
    return { written: opts.outputPath, warnings: result.warnings, stats: result.stats, ai: result.ai };
  }
  return result;
}
