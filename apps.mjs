// apps.first-ch.com（First CH の「サーバーで動くWebアプリ」）の JSON API を呼ぶツールの定義表。
//
// 他のツール（端末内で計算する）と違い、ここのツールは入力（URL・ドメイン名・文面など）を
// apps.first-ch.com のサーバーへ送り、そこで処理した結果を受け取る薄い HTTP クライアント。
// 全アプリが認証なしの `POST https://apps.first-ch.com/<slug>/api/<action>` を持つ
// （一覧は https://apps.first-ch.com/llms.txt・正本は FirstCHApps の functions/_shared/apps-registry.ts）。
// 入力の形は各アプリの functions/<slug>/[[path]].ts の API 実装に合わせている。
//
// server.mjs は APP_TOOLS をループで登録するだけにして、apps 側の変更はこのファイルに閉じる。
import { z } from 'zod';

export const DEFAULT_APPS_BASE_URL = 'https://apps.first-ch.com';
/** テスト・検証環境向けにベース URL を差し替える環境変数 */
export const APPS_BASE_URL_ENV = 'FIRSTCH_APPS_BASE_URL';
/** 1回の呼び出しの待ち時間の既定（ミリ秒） */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 取得件数が多い・AI を呼ぶアプリの待ち時間（AI 側のタイムアウトが45秒のため、それより長くする） */
export const SLOW_TIMEOUT_MS = 60_000;
/** 応答本文の上限（API の JSON は数十KB程度。想定外に大きい応答で固まらないための保険） */
const MAX_RESPONSE_CHARS = 5_000_000;

// ---------------------------------------------------------------------------
// 説明文の共通部品
// ---------------------------------------------------------------------------

const SENDS = (what) =>
  `**この呼び出しは${what}を First CH のサーバー apps.first-ch.com へ送って処理する**（他の First CH ツールと違い、端末内では完結しない）。` +
  '入力も結果もサーバーには保存されない。';
const FETCHES = 'apps.first-ch.com のサーバーが対象のサイトへアクセスするので、相手のサーバーにはこちらの端末ではなく apps.first-ch.com からのアクセスとして記録される。';
const RESULT = '応答は API の JSON をそのまま返す（入力の不備・相手サイトに届かない等は error と message つきのエラーになる）。';
const AI_LIMIT =
  '**回数制限あり**: 同じIPから10分に5回まで、さらに app_tone_check と app_lp_persona_check の合計で1日50回まで（日本時間9時にリセット）。' +
  '超えると HTTP 429（rate_limited / daily_limit）が返るので、間を置くか翌日に回す。AI による参考意見で、結果は毎回少し変わりうる。';

const LANG = z
  .enum(['ja', 'en'])
  .optional()
  .describe("結果の文言（判定・指摘・エラー文）の言語。既定 'ja'。'en' は英語版の API（/en/…）を呼ぶ");

const URL_PARAM = (what = '診断するページのURL') =>
  z.string().min(1).max(2048).describe(`${what}（http/https。スキームを省くと https:// を補う）`);
const DOMAIN_PARAM = z.string().min(1).max(512).describe('ドメイン名（例: example.com。URLを渡してもホスト名だけを使う）');

/** URL を1つ受けるアプリ（大半）の定義を作る */
function urlApp(slug, apiPath, title, summary, extra = {}) {
  return {
    slug,
    apiPath,
    title,
    summary,
    sends: extra.sends ?? '入力したURL',
    fetches: true,
    slow: extra.slow ?? false,
    inputSchema: { url: URL_PARAM(extra.urlLabel), lang: LANG },
  };
}

// ---------------------------------------------------------------------------
// 定義表（apps-registry.ts の APPS と同じ並び）
// ---------------------------------------------------------------------------

const DEFS = [
  urlApp(
    'geo',
    '/geo/api/diagnose',
    'GEO簡易チェッカー（AI検索に引用されやすいか）',
    'URLのページが AI検索（ChatGPT・Perplexity・Gemini・AI Overviews）に引用されやすい構造かを6軸100点で診断し、軸ごとの点数・グレード・見つかった JSON-LD の型・AIクローラーの拒否状況・改善点を返す。',
  ),
  urlApp(
    'meta-check',
    '/meta-check/api/inspect',
    'メタタグ・SEO基本診断',
    'URLのページの title・meta description・canonical・robots・h1・OGP・lang・viewport を取得して合否つきで返す。文字数（title 全角32字・description 100〜170字）と robots.txt のクロール可否も判定する。',
  ),
  urlApp(
    'headers',
    '/headers/api/inspect',
    'セキュリティヘッダー採点',
    'URLの応答の CSP・HSTS・X-Content-Type-Options・X-Frame-Options・Referrer-Policy・Permissions-Policy を100点満点で採点し、A〜Fの評価・各ヘッダーの値・解説と推奨設定例を返す。',
  ),
  {
    slug: 'ssl',
    apiPath: '/ssl/api/inspect',
    title: 'SSL/TLS証明書チェッカー',
    summary:
      'ホスト名へサーバー側から実際に TLS 接続し、配信中の証明書の有効期限・残り日数・発行者・SAN・中間証明書のチェーンを返す（期限30日切れで警告）。接続できないときは CT ログの記録から読む。',
    sends: '入力したホスト名（TLS の SNI としても送る）',
    fetches: true,
    inputSchema: {
      host: z.string().min(1).max(300).describe('ホスト名（例: example.com。URLを渡してもホスト名だけを使う。ポートは 443 のみ）'),
      lang: LANG,
    },
  },
  urlApp(
    'redirect-trace',
    '/redirect-trace/api/trace',
    'リダイレクトチェーン追跡',
    'URLから 301・302・307・308・meta refresh の転送を1ホップずつ追跡し（最大5回）、各ステップのステータス・URL・所要時間と最終到達URLを返す。3回以上の転送には SEO 上の警告を付ける。',
  ),
  {
    slug: 'status-check',
    apiPath: '/status-check/api/check',
    title: 'HTTPステータス一括チェック',
    summary:
      'URLの一覧（1回10件まで）について、HTTPステータス・応答時間・リダイレクト後の最終URLをまとめて返す。リニューアル後の疎通確認やリンク集の生存確認向け。ページ本文は読まない。11件以上は10件ずつ分けて呼ぶ。',
    sends: '入力したURLの一覧',
    fetches: true,
    slow: true,
    inputSchema: {
      urls: z.array(z.string().min(1).max(2048)).min(1).max(10).describe('確認するURLの配列（1〜10件）'),
      lang: LANG,
    },
  },
  {
    slug: 'redirect-map',
    apiPath: '/redirect-map/api/check',
    title: '301リダイレクト対応表チェッカー（1組）',
    summary:
      'サイト移転・リニューアルの「旧URL→新URL」1組について、旧URLの転送をたどり、期待した新URLへ厳密に一致して転送されているかを判定する。302の一時リダイレクト・チェーン・ループ・転送未設定・404も示す。' +
      '対応表が複数組なら1組ずつ呼ぶ（同じIPから1分に60組まで。超えると HTTP 429）。',
    sends: '旧URLと新URL',
    fetches: true,
    inputSchema: {
      from: z.string().min(1).max(2048).describe('旧URL（転送元）'),
      to: z.string().min(1).max(2048).describe('期待する新URL（転送先）'),
      lang: LANG,
    },
  },
  urlApp(
    'link-check',
    '/link-check/api/inspect',
    'リンク切れ・alt属性チェック',
    'URLのページ内のリンク（a href）を抽出して最大40件の生死を確認し、404などのリンク切れ・空のリンク文字・target=_blank の危険な指定を返す。画像の alt の欠落・ファイル名のままの alt も一覧する。対象は渡した1ページだけ（サイト全体はクロールしない）。',
    { slow: true },
  ),
  urlApp(
    'ogp-check',
    '/ogp-check/api/inspect',
    'OGP確認（URL版）',
    'URLのページの og: / twitter: タグを取得して判定し、og:image を実際に取得して寸法まで確認した結果を返す。',
  ),
  urlApp(
    'headings',
    '/headings/api/extract',
    '見出し構造（h1〜h6）抽出',
    'URLのページの h1〜h6 を出現順に返し、h1 が複数・レベル飛ばし・空見出しを指摘する。構成案に貼れる Markdown のアウトラインも返す。',
  ),
  urlApp(
    'structured-data',
    '/structured-data/api/inspect',
    '構造化データ（JSON-LD）抽出・検証',
    'URLのページ内の JSON-LD を全て取り出して @type ごとに返し、JSON の構文エラーを行・列つきで検出する。Article・FAQPage・BreadcrumbList・LocalBusiness・Organization の必須／推奨プロパティの充足も判定する。',
  ),
  urlApp(
    'ai-access',
    '/ai-access/api/check',
    'AIクローラー許可チェッカー',
    'URLのサイトの robots.txt を取得し、GPTBot・ClaudeBot・PerplexityBot・Google-Extended・CCBot・Bytespider など主要AIクローラーごとの許可／拒否と効いた Disallow を返す。llms.txt の有無と X-Robots-Tag も確認する。',
  ),
  {
    slug: 'robots-tester',
    apiPath: '/robots-tester/api/test',
    title: 'robots.txt テスター',
    summary:
      'URLのサイトの robots.txt を取得し、指定した User-agent がそのURLをクロールしてよいかを Google のマッチング仕様（最長一致・同着は Allow 優先）で判定する。効いた規則と負けた規則を行番号つきで返し、構文の警告も出す。',
    sends: '入力したURLとUser-agent名',
    fetches: true,
    inputSchema: {
      url: URL_PARAM('判定したいURL（パスまで含める）'),
      userAgent: z.string().max(300).optional().describe("User-agent 名（例: Googlebot / GPTBot。既定 'Googlebot'）"),
      lang: LANG,
    },
  },
  urlApp(
    'sitemap-check',
    '/sitemap-check/api/check',
    'sitemap.xml 検証',
    'サイトマップを取得して XML 構文を検証し、URL件数・lastmod の分布・サイトマップインデックスの中身（1階層）・エスケープ漏れなどの警告（行番号つき）と、抽出したURLの先頭200件を返す。サイトのURLを渡すと robots.txt から自動発見する。gzip（.xml.gz）にも対応。',
    { urlLabel: 'サイトマップのURL（サイトのトップURLでも可）' },
  ),
  urlApp(
    'hreflang',
    '/hreflang/api/check',
    'hreflang 相互参照チェック',
    'URLのページの hreflang 宣言（link rel=alternate・HTTP の Link ヘッダー）を抽出し、宣言先のページ（10件まで）も取得して返照（return link）があるかを検証する。自己参照・x-default の有無と無効な言語／地域コード（en-UK・jp 等）も判定する。',
    { slow: true },
  ),
  urlApp(
    'mixed-content',
    '/mixed-content/api/check',
    '混在コンテンツチェッカー',
    'https のページに残った http:// の参照（img・script・link・iframe・video・source・CSS の url()）を抽出し、行番号・タグ・直し方と、ブラウザがブロックするか自動で https 化されるかを返す。見つかった http:// のURLへはアクセスしない。',
  ),
  urlApp(
    'image-audit',
    '/image-audit/api/inspect',
    'ページ内画像診断',
    'URLのページ内の img / picture を抽出し、フォーマット（WebP・AVIF 対応）・loading=lazy・width/height の指定・alt を診断する。先頭30枚は HEAD リクエストで実際のファイルサイズと形式まで測る。',
    { slow: true },
  ),
  urlApp(
    'tech-detect',
    '/tech-detect/api/detect',
    '技術スタック検出',
    'URLのページの HTML と応答ヘッダーのシグネチャから、CMS（WordPress・Shopify・Wix・STUDIO 等）・フレームワーク・CDN・解析タグ（GA4/GTM）・Webフォントを推定し、そう判断した根拠（どこで何に合致したか）と一緒に返す。',
  ),
  urlApp(
    'wp-check',
    '/wp-check/api/check',
    'WordPress簡易診断',
    'URLのサイトが WordPress かどうか・テーマ名・名乗っている範囲のバージョンを判定し、REST API のユーザー名列挙・xmlrpc.php・著者アーカイブ・既定のログインURL・readme.html・デバッグログの露出を診断する。攻撃的な列挙はせず GET で見える範囲だけを見る（WordPress の痕跡があるときだけ既定パス7本を追加で GET。ユーザー名は件数だけ返す）。',
  ),
  urlApp(
    'feed-check',
    '/feed-check/api/check',
    'RSS/Atomフィード検証',
    'フィードを自動発見して取得し、XML の構文・必須要素・記事一覧・文字化け・日付形式（RSS は RFC 822・Atom は RFC 3339）を検証する。itunes 名前空間のあるフィードは Apple Podcasts の必須要素も確認する。',
    { urlLabel: 'フィードのURL（サイトのURLでも可。フィードを自動発見する）' },
  ),
  urlApp(
    'favicon-check',
    '/favicon-check/api/inspect',
    'faviconチェッカー',
    'URLのページの favicon.ico・link rel=icon・apple-touch-icon・Web App Manifest のアイコン宣言を抽出し、1件ずつ実際に取得して形式・実寸法（ICO は内包サイズ全部）・容量を返す。',
  ),
  {
    slug: 'dns',
    apiPath: '/dns/api/lookup',
    title: 'DNSレコードチェッカー',
    summary:
      'ドメインの A・AAAA・CNAME・MX・TXT・NS・SOA・CAA を Cloudflare の DNS over HTTPS（1.1.1.1）で引いて返す。www の向き先・SPF が1本か・CAA の有無も判定する。',
    sends: '入力したドメイン名',
    fetches: false,
    inputSchema: { domain: DOMAIN_PARAM, lang: LANG },
  },
  {
    slug: 'dns-propagation',
    apiPath: '/dns-propagation/api/check',
    title: 'DNS伝播チェック',
    summary:
      'ドメインとレコード種別を5つの公開DNSリゾルバ（Cloudflare・Google・OpenDNS ほか）へ同時に問い合わせ、回答が一致しているかを返す。TTL と SOA serial から「反映待ち」と「設定ミス」を切り分けられる。expected を渡すと期待する値と一致したかも判定する。',
    sends: '入力したドメイン名とレコード種別（と期待する値）',
    fetches: false,
    inputSchema: {
      domain: DOMAIN_PARAM,
      type: z.enum(['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'CAA']).optional().describe("レコード種別（既定 'A'）"),
      expected: z.string().max(256).optional().describe('期待する値（例: 192.0.2.10。渡すと各リゾルバの回答と照合する）'),
      lang: LANG,
    },
  },
  {
    slug: 'email-dns',
    apiPath: '/email-dns/api/check',
    title: 'メール設定チェッカー（MX・SPF・DKIM・DMARC）',
    summary:
      'ドメインの MX・SPF・DKIM・DMARC を引いて診断する。SPF は include: をたどって DNS ルックアップ10回の上限を実測し、DMARC のポリシーを解釈して Gmail 送信者ガイドライン（2024年〜）への適合も判定する。DKIM はセレクタが分からないと確認できないため、省略時は代表的なセレクタを当てる（見つからなくても DKIM が無いとは限らない）。',
    sends: '入力したドメイン名と DKIM セレクタ',
    fetches: false,
    inputSchema: {
      domain: DOMAIN_PARAM,
      selector: z
        .string()
        .max(200)
        .optional()
        .describe('DKIM セレクタ（例: google / selector1。カンマ区切りで3個まで。省略時は代表的なものを当てる）'),
      lang: LANG,
    },
  },
  {
    slug: 'domain-info',
    apiPath: '/domain-info/api/lookup',
    title: 'ドメイン情報・期限チェッカー（RDAP）',
    summary:
      'ドメインを RDAP（WHOIS の後継）で引き、レジストラ・作成日・有効期限と残り日数・ステータス（clientHold 等）・ネームサーバーを返す。RDAP 非対応の TLD（.jp を含む）はその旨を返す。登録者・管理者の個人情報は読まない。',
    sends: '入力したドメイン名',
    fetches: false,
    inputSchema: { domain: DOMAIN_PARAM, lang: LANG },
  },
  {
    slug: 'domain-availability',
    apiPath: '/domain-availability/api/check',
    title: 'ドメイン空き一括チェック',
    summary:
      'サービス名・屋号の候補1つについて、.com / .net / .org / .jp / .co.jp / .dev / .io / .ai / .app / .co の登録有無を RDAP と公開DNSでまとめて判定する。判定は「登録済み／未登録の可能性／判定不能」の3値で、空きは断定しない。',
    sends: '入力した名前',
    fetches: false,
    slow: true,
    inputSchema: {
      name: z.string().min(1).max(253).describe('調べる名前（例: firstch。firstch.com のように TLD つきで渡してもよい）'),
      lang: LANG,
    },
  },
  {
    slug: 'myip',
    apiPath: '/myip/api/info',
    title: 'IP・リクエスト情報の確認',
    summary:
      'この MCP サーバーが動いている端末から apps.first-ch.com へ届いたリクエストを見て、グローバルIP・推定国/都市・回線（ASN）・HTTP/TLS の方式・User-Agent・主要リクエストヘッダーを返す。VPN の切り替え確認などに使う。',
    sends: 'リクエストそのもの（端末のグローバルIPとヘッダー）',
    fetches: false,
    inputSchema: { lang: LANG },
  },
  urlApp(
    'brand-fetch',
    '/brand-fetch/api/extract',
    'ブランド情報抽出',
    'サイトのロゴ・ファビコン・主要配色・会社説明を抽出して返す。配色は CSS の出現頻度順で、白地・黒地とのコントラスト比つき。画像は URL と寸法だけを返す。提案書やモックの仮ブランド作りに使う。',
    { urlLabel: 'サイトのURLまたはドメイン（例: example.com）' },
  ),
  {
    slug: 'tone-check',
    apiPath: '/tone-check/api/check',
    title: 'ビジネス文面のニュアンスチェック（AI）',
    summary:
      '日本語のビジネスメール・提案文の失礼・曖昧・二重敬語・催促のきつさを「相手にどう受け取られるか」の観点で指摘し、言い換え候補を返す。英訳して送るときの文化的な誤解ポイントも添える。',
    sends: '入力した文面',
    ai: true,
    slow: true,
    inputSchema: {
      text: z.string().min(1).max(2000).describe('確認する日本語の文面（2000文字まで）'),
      lang: LANG,
    },
  },
  {
    slug: 'lp-persona-check',
    apiPath: '/lp-persona-check/api/check',
    title: 'LP文言・ペルソナ反応チェッカー（AI）',
    summary:
      'LP・サービス紹介の訴求文を、選んだ業種（士業・EC・BtoB SaaS）の疑似ペルソナ3人の視点で読み、分かりやすさ・信頼性・購買意欲への影響の推定スコア、敬語トーンの強弱（5段階）、ペルソナごとの反応、言い換え案を返す。疑似ペルソナによる推測で、実在の顧客の反応ではない。',
    sends: '入力した訴求文と業種',
    ai: true,
    slow: true,
    inputSchema: {
      text: z.string().min(1).max(2000).describe('評価する訴求文（2000文字まで）'),
      industry: z.enum(['shigyo', 'ec', 'saas']).describe("想定する業種（'shigyo'＝士業 / 'ec'＝EC / 'saas'＝BtoB SaaS）"),
      lang: LANG,
    },
  },
  {
    slug: 'ja-readability-check',
    apiPath: '/ja-readability-check/api/check',
    title: '和文可読性チェッカー',
    summary:
      'URLのページの本文の日本語タイポグラフィを、PC とスマホの画面幅で推定して診断する。1文字だけの孤立行・句読点や閉じ括弧の行頭禁則・1行の文字数（35〜40字の目安）・和文フォントのフォールバック欠けを該当箇所つきで返す。ページとその CSS（8本まで）を取得する。',
    sends: '入力したURL',
    fetches: true,
    slow: true,
    inputSchema: {
      url: URL_PARAM(),
      cpl: z.number().int().min(10).max(80).optional().describe('1行の文字数（10〜80の整数）。省略時は CSS から推定する'),
      lang: LANG,
    },
  },
  {
    slug: 'faq-site-diff',
    apiPath: '/faq-site-diff/api/check',
    title: 'FAQ×サイト 記載差分チェッカー',
    summary:
      'FAQ・ヘルプページと本体サイトのページ（3件まで）の料金・営業時間・電話番号・日付・「〇日以内」などの記載を突き合わせ、食い違う箇所を返す。FAQ の更新漏れ探しに使う。',
    sends: '入力したURL',
    fetches: true,
    slow: true,
    inputSchema: {
      faq: URL_PARAM('FAQ・ヘルプページのURL'),
      sites: z.array(z.string().min(1).max(2048)).min(1).max(3).describe('比べる本体サイトのページURLの配列（1〜3件。FAQ と同じURLは不可）'),
      lang: LANG,
    },
  },
  {
    slug: 'nap-check',
    apiPath: '/nap-check/api/check',
    title: '会社名・住所・電話の表記ゆれチェッカー（NAP）',
    summary:
      '同じサイトのページ（3件まで・同じオリジン）の表示テキスト・フッター・tel: リンク・JSON-LD から会社名・住所・電話番号・営業時間を拾い、ページ間や構造化データとの表記ゆれ・不一致候補を返す。ローカルSEOの下調べに使う。' +
      '同じIPから10分に10回まで（超えると HTTP 429）。',
    sends: '入力したURL',
    fetches: true,
    slow: true,
    inputSchema: {
      urls: z.array(z.string().min(1).max(2048)).min(1).max(3).describe('照合するページURLの配列（1〜3件・同じサイト）'),
      lang: LANG,
    },
  },
];

const toolName = (slug) => `app_${slug.replace(/-/g, '_')}`;

function buildDescription(d) {
  return [
    d.summary,
    `apps.first-ch.com${d.slug === 'myip' ? '/myip/' : `/${d.slug}/`} と同じ処理（POST ${d.apiPath}）。`,
    SENDS(d.sends),
    d.fetches ? FETCHES : '',
    d.ai ? `文面は Cloudflare Workers AI（Cloudflare 上の言語モデル）に渡して判定する。${AI_LIMIT}` : '',
    RESULT,
  ]
    .filter(Boolean)
    .join('');
}

/** server.mjs が登録する定義（name・title・description・inputSchema と呼び出しに使う値） */
export const APP_TOOLS = DEFS.map((d) => ({
  name: toolName(d.slug),
  slug: d.slug,
  apiPath: d.apiPath,
  summary: d.summary,
  title: `${d.title}［apps.first-ch.com へ送信］`,
  description: buildDescription(d),
  inputSchema: d.inputSchema,
  timeoutMs: d.slow ? SLOW_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
  ai: Boolean(d.ai),
}));

// ---------------------------------------------------------------------------
// HTTP 呼び出し
// ---------------------------------------------------------------------------

export class AppsApiError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'AppsApiError';
    Object.assign(this, details);
  }
}

/** ベース URL を決める（引数 > 環境変数 > 既定）。http(s) 以外・パスつきは受けない */
export function resolveBaseUrl(raw = process.env[APPS_BASE_URL_ENV]) {
  const value = (raw ?? '').trim() || DEFAULT_APPS_BASE_URL;
  let u;
  try {
    u = new URL(value);
  } catch {
    throw new AppsApiError(`${APPS_BASE_URL_ENV} が URL として読めません: ${value}`);
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') {
    throw new AppsApiError(`${APPS_BASE_URL_ENV} は http:// か https:// で指定してください: ${value}`);
  }
  return u.origin;
}

/** API へ送る本文（lang は送らずパスで切り替える。undefined の項目は落とす） */
export function buildRequestBody(args = {}) {
  const body = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === 'lang' || v === undefined) continue;
    body[k] = v;
  }
  return body;
}

const HINT_BY_STATUS = {
  429: '回数制限に達しました。しばらく（AI のアプリは10分ほど・1日の上限なら日本時間9時以降）おいてから呼び直してください。',
  413: '入力が大きすぎます。',
  502: '相手のサイトに届かなかったか、応答が返りませんでした。',
};

/**
 * 定義1件ぶんの API を呼び、応答の JSON を返す。
 * 失敗（タイムアウト・接続失敗・HTTP エラー・JSON でない応答）は AppsApiError を投げる
 * （MCP ではツールのエラー＝isError として呼び出し側に返る）。
 */
export async function callAppTool(def, args = {}, opts = {}) {
  const fetchImpl = opts.fetch ?? globalThis.fetch;
  const base = resolveBaseUrl(opts.baseUrl ?? process.env[APPS_BASE_URL_ENV]);
  const version = opts.version ?? '0.0.0';
  const timeoutMs = opts.timeoutMs ?? def.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const path = `${args.lang === 'en' ? '/en' : ''}${def.apiPath}`;
  const url = `${base}${path}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  let text;
  try {
    try {
      res = await fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          accept: 'application/json',
          'user-agent': `first-ch-tools-mcp/${version}`,
        },
        body: JSON.stringify(buildRequestBody(args)),
        // POST の 301/302 を追うと GET に化けて 405 になるため、転送は追わずにエラーにする
        redirect: 'manual',
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      if (controller.signal.aborted) {
        throw new AppsApiError(
          `${url} の応答が ${Math.round(timeoutMs / 1000)} 秒以内に返りませんでした（タイムアウト）。時間をおいて呼び直してください。`,
          { code: 'timeout', url },
        );
      }
      const cause = err?.cause?.code || err?.cause?.message || err?.message || String(err);
      throw new AppsApiError(`${url} に接続できませんでした（${cause}）。ネットワーク接続を確認してください。`, {
        code: 'network',
        url,
      });
    }
  } finally {
    clearTimeout(timer);
  }

  const status = res.status;
  if (status >= 300 && status < 400) {
    throw new AppsApiError(
      `${url} が転送（HTTP ${status} → ${res.headers.get('location') ?? '転送先なし'}）を返しました。API のパスが変わった可能性があります。`,
      { code: 'redirect', status, url },
    );
  }
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new AppsApiError(`${url} の応答が大きすぎます（${text.length} 文字）。`, { code: 'too_large', status, url });
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const type = res.headers.get('content-type') ?? '不明';
    const head = text.replace(/\s+/g, ' ').trim().slice(0, 200);
    throw new AppsApiError(
      `${url} の応答が JSON ではありません（HTTP ${status}・content-type: ${type}）。先頭: ${head || '（空）'}`,
      { code: 'not_json', status, url },
    );
  }

  if (!res.ok) {
    const errCode = data && typeof data === 'object' && typeof data.error === 'string' ? data.error : '';
    const message = data && typeof data === 'object' && typeof data.message === 'string' ? data.message : '';
    const parts = [`apps.first-ch.com がエラーを返しました（HTTP ${status}${errCode ? `・${errCode}` : ''}）`];
    if (message) parts.push(message);
    if (HINT_BY_STATUS[status]) parts.push(HINT_BY_STATUS[status]);
    throw new AppsApiError(parts.join(': '), { code: errCode || `http_${status}`, status, url, body: data });
  }
  return data;
}
