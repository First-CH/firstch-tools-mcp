// User-Agent 文字列の解析とデバイス判定
// （tools.first-ch.com/user-agent/ と同一の仕様）
//
// 2箇所ルール: 解析のコア（normalizeInput / tokenizeUA / detectBot / detectBrowser /
// detectEngine / detectOS / detectDevice / collectNotes / parseUserAgent）は
// site/user-agent/app.js と対になっている。片方を直したらもう片方も同じ内容で直す（site側が正本）。
//
// UA文字列は歴史的な経緯の塊で、正規表現の「順番」が結果を決める。
// Edge は Chrome を名乗り、Chrome は Safari を名乗り、Safari は Mozilla を名乗るため、
// 判定は必ず「より限定的なもの」から先に試す（下の BROWSERS の並び順がそのまま優先順位）。
// 判定はこのプロセスの中だけで行い、ネットワークへは一切出ない。

export class UserAgentError extends Error {}

/** 貼り付けられた文字列からUA本体を取り出す。`User-Agent: …` のヘッダー1行や引用符付きでも渡せる */
export function normalizeInput(raw) {
  const cleanups = [];
  const mark = (c) => { if (cleanups.indexOf(c) === -1) cleanups.push(c); };
  let s = String(raw == null ? '' : raw).replace(/[\r\n]+/g, ' ').trim();
  if (!s) return { ua: '', cleanups };
  // `"User-Agent: …",` のように包みが重なることがあるので、変化しなくなるまで繰り返す
  for (let i = 0; i < 4; i += 1) {
    const before = s;
    const header = s.match(/^(?:-H\s*)?["']?\s*user-agent\s*:\s*(.*)$/is);
    if (header) {
      s = header[1].trim();
      mark('header');
    }
    const tail = s.replace(/[,;]+$/, '');
    if (tail !== s) {
      s = tail.trim();
      mark('punct');
    }
    if (s.length > 1 && /^["'`]/.test(s) && s[s.length - 1] === s[0]) {
      s = s.slice(1, -1).trim();
      mark('quoted');
    }
    if (s === before) break;
  }
  if (/\s{2,}/.test(s)) {
    s = s.replace(/\s{2,}/g, ' ');
    mark('spaces');
  }
  return { ua: s, cleanups };
}

/**
 * UA文字列を「製品トークン」と「コメント（括弧）」に切り分ける。
 * RFC 9110 の User-Agent は product ( "/" version )? と comment の並びと決められている。
 */
export function tokenizeUA(ua) {
  const out = [];
  let buf = '';
  let depth = 0;
  const flush = (kind) => {
    const text = buf.trim();
    buf = '';
    if (!text) return;
    if (kind === 'comment') {
      out.push({
        kind: 'comment',
        text,
        name: '',
        version: '',
        parts: text.replace(/^\(|\)$/g, '').split(';').map((p) => p.trim()).filter(Boolean),
      });
      return;
    }
    for (const piece of text.split(/\s+/)) {
      if (!piece) continue;
      const m = piece.match(/^([^/]+)\/(.*)$/);
      out.push({ kind: 'product', text: piece, name: m ? m[1] : piece, version: m ? m[2] : '', parts: [] });
    }
  };
  for (let i = 0; i < ua.length; i += 1) {
    const ch = ua[i];
    if (ch === '(') {
      if (depth === 0) flush('product');
      depth += 1;
      buf += ch;
    } else if (ch === ')') {
      buf += ch;
      depth = Math.max(0, depth - 1);
      if (depth === 0) flush('comment');
    } else {
      buf += ch;
    }
  }
  flush(depth > 0 ? 'comment' : 'product');
  return out;
}

/** トークンに付ける解説。UAには「意味を失ったまま残っている」語が多い */
const TOKEN_DOCS = [
  { re: /^Mozilla\/5\.0$/i, code: 'mozilla' },
  { re: /^Mozilla\/[\d.]+$/i, code: 'mozilla' },
  { re: /^AppleWebKit\/537\.36$/i, code: 'webkit537' },
  { re: /^AppleWebKit\//i, code: 'webkit' },
  { re: /^KHTML, like Gecko$/i, code: 'khtml' },
  { re: /^like Gecko$/i, code: 'khtml' },
  { re: /^Gecko\/\d+$/i, code: 'geckotrail' },
  { re: /^Safari\//i, code: 'safaritoken' },
  { re: /^Version\//i, code: 'version' },
  { re: /^Mobile\/\w+$/i, code: 'mobilebuild' },
  { re: /^Mobile$/i, code: 'mobileflag' },
  { re: /^like Mac OS X$/i, code: 'likemac' },
  { re: /^wv$/i, code: 'wv' },
  { re: /^Win64$|^x64$|^WOW64$/i, code: 'win64' },
  { re: /^rv:/i, code: 'rv' },
  { re: /^Build\//i, code: 'build' },
  { re: /^Chrome\//i, code: 'chrome' },
  { re: /^CriOS\//i, code: 'crios' },
  { re: /^FxiOS\//i, code: 'fxios' },
  { re: /^Edg(?:A|iOS)?\//i, code: 'edg' },
  { re: /^OPR\//i, code: 'opr' },
  { re: /^Trident\//i, code: 'trident' },
];

const TOKEN_TEXT = {
  mozilla: '歴史的な遺物。Netscape互換を名乗る記述で、ほぼ全ブラウザが今も送っている。情報量はゼロ。',
  webkit537: '2013年から 537.36 に凍結されている。実際のWebKit / Blinkのバージョンではない。',
  webkit: 'WebKitのビルド番号。Safariもこの値を長年 605.1.15 で凍結している。',
  khtml: '歴史的な遺物。WebKitが祖先のKHTML互換を名乗り、そのKHTMLがさらにGecko互換を名乗っている。',
  geckotrail: 'Firefoxが固定値として送る日付 20100101。ビルド日ではない。',
  safaritoken: 'Chrome・Edge・Opera・Samsung Internet もこれを送る。「Safari」の部分一致でSafariを判定してはいけない。',
  version: 'Safariが実際のバージョンを入れる場所。Safari/ の側にはWebKitのビルド番号が入る。',
  mobilebuild: 'iOSのビルド番号（15E148 など）。iOSのバージョンではない。',
  mobileflag: 'Androidではスマートフォンに付き、タブレットには付かない。両者を見分ける公式の方法。',
  likemac: 'iOSが「Mac互換」を名乗る記述。端末がMacという意味ではない。',
  wv: 'Android WebView。ネイティブアプリに埋め込まれたブラウザで、Chrome本体ではない。',
  win64: '64bit版Windows。WOW64 は 64bit Windows 上で 32bit ブラウザが動いている状態。',
  rv: 'Geckoのリビジョン。IE11では MSIE が削除されたため、本当のバージョンはここにある。',
  build: '端末のAndroidビルド番号。',
  chrome: 'Chrome / Chromium のバージョン。Chrome 110以降、マイナー以下は 0.0.0 に凍結されている。',
  crios: 'iOS版Chrome。中身のエンジンはBlinkではなくWebKit。',
  fxios: 'iOS版Firefox。中身のエンジンはGeckoではなくWebKit。',
  edg: 'Microsoft Edge（Chromium版）。Chrome/ より後ろに置かれるため、Chromeを先に判定すると必ず取り違える。',
  opr: 'Opera（Chromium版）。Edgeと同じ罠で、Chrome/ も Safari/ も送ってくる。',
  trident: 'Internet Explorer のエンジン。',
};

function docForToken(text) {
  for (const d of TOKEN_DOCS) if (d.re.test(text)) return d.code;
  return '';
}

/** クローラー・APIクライアント。ブラウザ判定より先に見る */
const BOTS = [
  { re: /Googlebot-Image\/?([\d.]*)/i, name: 'Googlebot Image', cat: 'search' },
  { re: /Googlebot-Video\/?([\d.]*)/i, name: 'Googlebot Video', cat: 'search' },
  { re: /Googlebot-News/i, name: 'Googlebot News', cat: 'search' },
  { re: /Googlebot\/?([\d.]*)/i, name: 'Googlebot', cat: 'search' },
  { re: /Storebot-Google\/?([\d.]*)/i, name: 'Google StoreBot', cat: 'search' },
  { re: /Google-InspectionTool\/?([\d.]*)/i, name: 'Google Inspection Tool', cat: 'tool' },
  { re: /Chrome-Lighthouse/i, name: 'Lighthouse', cat: 'tool' },
  { re: /Mediapartners-Google/i, name: 'Google AdSense', cat: 'ads' },
  { re: /AdsBot-Google-Mobile/i, name: 'AdsBot Google (Mobile)', cat: 'ads' },
  { re: /AdsBot-Google/i, name: 'AdsBot Google', cat: 'ads' },
  { re: /Google-Extended/i, name: 'Google-Extended', cat: 'ai' },
  { re: /GoogleOther/i, name: 'GoogleOther', cat: 'search' },
  { re: /bingbot\/?([\d.]*)/i, name: 'bingbot', cat: 'search' },
  { re: /BingPreview\/?([\d.]*)/i, name: 'BingPreview', cat: 'search' },
  { re: /Slurp/i, name: 'Yahoo! Slurp', cat: 'search' },
  { re: /DuckDuckBot\/?([\d.]*)/i, name: 'DuckDuckBot', cat: 'search' },
  { re: /Baiduspider(?:-\w+)?\/?([\d.]*)/i, name: 'Baiduspider', cat: 'search' },
  { re: /YandexBot\/?([\d.]*)/i, name: 'YandexBot', cat: 'search' },
  { re: /Applebot-Extended/i, name: 'Applebot-Extended', cat: 'ai' },
  { re: /Applebot\/?([\d.]*)/i, name: 'Applebot', cat: 'search' },
  { re: /PetalBot/i, name: 'PetalBot', cat: 'search' },
  { re: /SeznamBot\/?([\d.]*)/i, name: 'SeznamBot', cat: 'search' },
  { re: /Amazonbot\/?([\d.]*)/i, name: 'Amazonbot', cat: 'search' },
  { re: /GPTBot\/?([\d.]*)/i, name: 'GPTBot', cat: 'ai' },
  { re: /ChatGPT-User\/?([\d.]*)/i, name: 'ChatGPT-User', cat: 'ai' },
  { re: /OAI-SearchBot\/?([\d.]*)/i, name: 'OAI-SearchBot', cat: 'ai' },
  { re: /ClaudeBot\/?([\d.]*)/i, name: 'ClaudeBot', cat: 'ai' },
  { re: /Claude-User\/?([\d.]*)/i, name: 'Claude-User', cat: 'ai' },
  { re: /Claude-SearchBot\/?([\d.]*)/i, name: 'Claude-SearchBot', cat: 'ai' },
  { re: /Claude-Web/i, name: 'Claude-Web', cat: 'ai' },
  { re: /anthropic-ai/i, name: 'anthropic-ai', cat: 'ai' },
  { re: /PerplexityBot\/?([\d.]*)/i, name: 'PerplexityBot', cat: 'ai' },
  { re: /Perplexity-User/i, name: 'Perplexity-User', cat: 'ai' },
  { re: /meta-externalagent\/?([\d.]*)/i, name: 'Meta External Agent', cat: 'ai' },
  { re: /Bytespider/i, name: 'Bytespider', cat: 'ai' },
  { re: /CCBot\/?([\d.]*)/i, name: 'CCBot (Common Crawl)', cat: 'ai' },
  { re: /facebookexternalhit\/?([\d.]*)/i, name: 'facebookexternalhit', cat: 'social' },
  { re: /Twitterbot\/?([\d.]*)/i, name: 'Twitterbot', cat: 'social' },
  { re: /Slackbot(?:-LinkExpanding)?\/?([\d.]*)/i, name: 'Slackbot', cat: 'social' },
  { re: /Discordbot\/?([\d.]*)/i, name: 'Discordbot', cat: 'social' },
  { re: /LinkedInBot\/?([\d.]*)/i, name: 'LinkedInBot', cat: 'social' },
  { re: /TelegramBot/i, name: 'TelegramBot', cat: 'social' },
  { re: /Pinterestbot\/?([\d.]*)/i, name: 'Pinterestbot', cat: 'social' },
  { re: /AhrefsBot\/?([\d.]*)/i, name: 'AhrefsBot', cat: 'seo' },
  { re: /SemrushBot\/?([\d.]*)/i, name: 'SemrushBot', cat: 'seo' },
  { re: /MJ12bot\/?([\w.]*)/i, name: 'MJ12bot', cat: 'seo' },
  { re: /DotBot\/?([\d.]*)/i, name: 'DotBot', cat: 'seo' },
  { re: /Screaming Frog SEO Spider\/?([\d.]*)/i, name: 'Screaming Frog SEO Spider', cat: 'seo' },
  { re: /UptimeRobot\/?([\d.]*)/i, name: 'UptimeRobot', cat: 'monitor' },
  { re: /Pingdom/i, name: 'Pingdom', cat: 'monitor' },
  { re: /curl\/?([\d.]*)/i, name: 'curl', cat: 'http' },
  { re: /Wget\/?([\d.]*)/i, name: 'Wget', cat: 'http' },
  { re: /python-requests\/?([\d.]*)/i, name: 'python-requests', cat: 'http' },
  { re: /python-httpx\/?([\d.]*)/i, name: 'httpx', cat: 'http' },
  { re: /aiohttp\/?([\d.]*)/i, name: 'aiohttp', cat: 'http' },
  { re: /axios\/?([\d.]*)/i, name: 'axios', cat: 'http' },
  { re: /node-fetch\/?([\d.]*)/i, name: 'node-fetch', cat: 'http' },
  { re: /undici/i, name: 'undici', cat: 'http' },
  { re: /Go-http-client\/?([\d.]*)/i, name: 'Go http client', cat: 'http' },
  { re: /okhttp\/?([\d.]*)/i, name: 'OkHttp', cat: 'http' },
  { re: /PostmanRuntime\/?([\d.]*)/i, name: 'Postman', cat: 'http' },
  { re: /Apache-HttpClient\/?([\d.]*)/i, name: 'Apache HttpClient', cat: 'http' },
  { re: /libwww-perl\/?([\d.]*)/i, name: 'libwww-perl', cat: 'http' },
  { re: /GuzzleHttp\/?([\d.]*)/i, name: 'Guzzle', cat: 'http' },
  { re: /Java\/?([\d._]*)/i, name: 'Java', cat: 'http' },
];

export function detectBot(ua) {
  for (const b of BOTS) {
    const m = ua.match(b.re);
    if (m) return { name: b.name, version: (m[1] || '').replace(/\.$/, ''), category: b.cat };
  }
  return null;
}

/**
 * ブラウザ判定。**並び順が優先順位**で、より限定的なトークンを先に置いてある。
 * `when` は「そのトークンが他の判定より優先される条件」を書く場所。
 */
const BROWSERS = [
  { re: /EdgiOS\/([\d.]+)/, name: 'Microsoft Edge', platform: 'iOS' },
  { re: /EdgA\/([\d.]+)/, name: 'Microsoft Edge', platform: 'Android' },
  { re: /Edg\/([\d.]+)/, name: 'Microsoft Edge' },
  { re: /Edge\/([\d.]+)/, name: 'Microsoft Edge', legacy: 'EdgeHTML' },
  { re: /OPiOS\/([\d.]+)/, name: 'Opera', platform: 'iOS' },
  { re: /Opera Mini\/([\d.]+)/, name: 'Opera Mini' },
  { re: /OPT\/([\d.]+)/, name: 'Opera Touch' },
  { re: /OPR\/([\d.]+)/, name: 'Opera' },
  { re: /Opera[\s/]([\d.]+)/, name: 'Opera', legacy: 'Presto' },
  { re: /Vivaldi\/([\d.]+)/, name: 'Vivaldi' },
  { re: /Brave\/([\d.]+)/, name: 'Brave' },
  { re: /YaBrowser\/([\d.]+)/, name: 'Yandex Browser' },
  { re: /SamsungBrowser\/([\d.]+)/, name: 'Samsung Internet' },
  { re: /UCBrowser\/([\d.]+)/, name: 'UC Browser' },
  { re: /HuaweiBrowser\/([\d.]+)/, name: 'Huawei Browser' },
  { re: /MiuiBrowser\/([\d.]+)/, name: 'MIUI Browser' },
  { re: /Whale\/([\d.]+)/, name: 'Naver Whale' },
  { re: /MQQBrowser\/([\d.]+)/, name: 'QQ Browser' },
  { re: /QQBrowser\/([\d.]+)/, name: 'QQ Browser' },
  { re: /Silk\/([\d.]+)/, name: 'Amazon Silk' },
  { re: /(?:DuckDuckGo|Ddg)\/([\d.]+)/, name: 'DuckDuckGo Browser' },
  { re: /SeaMonkey\/([\d.]+)/, name: 'SeaMonkey' },
  { re: /(?:PaleMoon|Pale Moon)\/([\d.]+)/, name: 'Pale Moon' },
  { re: /Waterfox\/([\d.]+)/, name: 'Waterfox' },
  { re: /LibreWolf\/([\d.]+)/, name: 'LibreWolf' },
  { re: /FxiOS\/([\d.]+)/, name: 'Firefox', platform: 'iOS' },
  { re: /Focus\/([\d.]+)/, name: 'Firefox Focus' },
  { re: /Firefox\/([\d.]+)/, name: 'Firefox' },
  { re: /CriOS\/([\d.]+)/, name: 'Google Chrome', platform: 'iOS' },
  { re: /HeadlessChrome\/([\d.]+)/, name: 'Headless Chrome' },
  { re: /Chromium\/([\d.]+)/, name: 'Chromium' },
  // Android WebView は Chrome を名乗るが、コメント内に `wv` が入る
  { re: /Chrome\/([\d.]+)/, name: 'Android WebView', when: (ua) => /;\s*wv[;)]/.test(ua) },
  { re: /Chrome\/([\d.]+)/, name: 'Google Chrome' },
  { re: /Version\/([\d.]+).*\bSafari\//, name: 'Safari' },
  // Version/ を持たない Safari/ は iOS のアプリ内ブラウザ（SFSafariViewController / WKWebView）
  { re: /Safari\/([\d.]+)/, name: 'WebKit', inapp: true },
  { re: /Trident\/[\d.]+.*rv:([\d.]+)/, name: 'Internet Explorer' },
  { re: /MSIE ([\d.]+)/, name: 'Internet Explorer' },
  { re: /AppleWebKit\/([\d.]+)/, name: 'WebKit', inapp: true },
];

export function detectBrowser(ua) {
  for (const b of BROWSERS) {
    if (b.when && !b.when(ua)) continue;
    const m = ua.match(b.re);
    if (!m) continue;
    const version = m[1] || '';
    return {
      name: b.name,
      version,
      major: version ? version.split('.')[0] : '',
      platform: b.platform || '',
      legacy: b.legacy || '',
      inapp: !!b.inapp,
    };
  }
  return { name: '', version: '', major: '', platform: '', legacy: '', inapp: false };
}

/** アプリ内ブラウザ（WebViewを埋め込んでいるアプリ）。ブラウザ判定とは別に併記する */
const IN_APP = [
  { re: /FBAN\/|FBAV\/([\d.]*)|FB_IAB/, name: 'Facebook' },
  { re: /Instagram\s([\d.]+)/, name: 'Instagram' },
  { re: /\bLine\/([\d.]+)/i, name: 'LINE' },
  { re: /MicroMessenger\/([\d.]+)/i, name: 'WeChat' },
  { re: /KAKAOTALK\s?([\d.]*)/i, name: 'KakaoTalk' },
  { re: /(?:TwitterAndroid|Twitter for iPhone|TwitterForiPhone)/i, name: 'X (Twitter)' },
  { re: /(?:musical_ly|BytedanceWebview|TikTok)[_/]?([\d.]*)/i, name: 'TikTok' },
  { re: /Snapchat\/?([\d.]*)/i, name: 'Snapchat' },
  { re: /Electron\/([\d.]+)/, name: 'Electron' },
  { re: /Slack(?:_SSB)?\/([\d.]+)/, name: 'Slack' },
];

export function detectInApp(ua) {
  for (const a of IN_APP) {
    const m = ua.match(a.re);
    if (m) return { name: a.name, version: (m[1] || '') };
  }
  return null;
}

/** レンダリングエンジン。Blink と WebKit は AppleWebKit/ を共有するので Chrome系の有無で分ける */
export function detectEngine(ua, browser) {
  let m;
  if ((m = ua.match(/Trident\/([\d.]+)/))) return { name: 'Trident', version: m[1] };
  if (/MSIE [\d.]+/.test(ua) && !/Trident/.test(ua)) return { name: 'Trident', version: '' };
  if (browser.legacy === 'EdgeHTML') return { name: 'EdgeHTML', version: browser.version };
  if ((m = ua.match(/Presto\/([\d.]+)/))) return { name: 'Presto', version: m[1] };
  if ((m = ua.match(/Goanna\/([\d.]+)/))) return { name: 'Goanna', version: m[1] };
  if ((m = ua.match(/(?:Chrome|Chromium|CriOS|HeadlessChrome)\/([\d.]+)/))) {
    // iOS では Chrome も Firefox も中身は WebKit（App Store の規約による）
    if (/(?:CriOS|FxiOS|EdgiOS|OPiOS)\//.test(ua)) {
      const w = ua.match(/AppleWebKit\/([\d.]+)/);
      return { name: 'WebKit', version: w ? w[1] : '' };
    }
    const major = parseInt(m[1], 10);
    if (major >= 28) return { name: 'Blink', version: m[1] };
    return { name: 'WebKit', version: (ua.match(/AppleWebKit\/([\d.]+)/) || [])[1] || '' };
  }
  if ((m = ua.match(/AppleWebKit\/([\d.]+)/))) return { name: 'WebKit', version: m[1] };
  if (/Gecko\/\d+|rv:[\d.]+/.test(ua) && /Firefox|SeaMonkey|Waterfox|LibreWolf|Gecko\//.test(ua)) {
    const rv = ua.match(/rv:([\d.]+)/);
    return { name: 'Gecko', version: rv ? rv[1] : (browser.version || '') };
  }
  return { name: '', version: '' };
}

const WINDOWS_NT = {
  '10.0': '10 / 11', '6.3': '8.1', '6.2': '8', '6.1': '7',
  '6.0': 'Vista', '5.2': 'XP x64', '5.1': 'XP', '5.0': '2000',
};

/** OS判定。並び順が優先順位（Xbox は Windows NT を含むので先に見る、など） */
export function detectOS(ua) {
  let m;
  if (/Xbox/i.test(ua)) return { name: 'Xbox', version: (ua.match(/Xbox One|Xbox Series/i) || [''])[0] };
  if ((m = ua.match(/PlayStation\s?(\w*)\s?([\d.]*)/i))) return { name: 'PlayStation ' + (m[1] || ''), version: m[2] || '' };
  if (/Nintendo (?:Switch|WiiU|3DS)/i.test(ua)) return { name: (ua.match(/Nintendo (?:Switch|WiiU|3DS)/i) || [''])[0], version: '' };
  if ((m = ua.match(/Windows Phone(?: OS)? ([\d.]+)/i))) return { name: 'Windows Phone', version: m[1] };
  if ((m = ua.match(/Windows NT ([\d.]+)/i))) return { name: 'Windows', version: WINDOWS_NT[m[1]] || ('NT ' + m[1]), raw: m[1] };
  if (/Windows/i.test(ua) && !/Windows NT/i.test(ua)) return { name: 'Windows', version: '' };
  if ((m = ua.match(/(?:Android|Adr)[\s/]([\d.]+)/i))) return { name: 'Android', version: m[1] };
  if (/Android/i.test(ua)) return { name: 'Android', version: '' };
  if ((m = ua.match(/CrOS (\S+) ([\d.]+)/))) return { name: 'ChromeOS', version: m[2], arch: m[1] };
  if (/CrOS/.test(ua)) return { name: 'ChromeOS', version: '' };
  if ((m = ua.match(/iPhone OS ([\d_]+)/i))) return { name: 'iOS', version: m[1].replace(/_/g, '.') };
  if ((m = ua.match(/CPU OS ([\d_]+)/i))) return { name: /iPad/i.test(ua) ? 'iPadOS' : 'iOS', version: m[1].replace(/_/g, '.') };
  if (/iPhone|iPod/i.test(ua)) return { name: 'iOS', version: '' };
  if (/iPad/i.test(ua)) return { name: 'iPadOS', version: '' };
  if ((m = ua.match(/Mac OS X ([\d_.]+)/i))) return { name: 'macOS', version: m[1].replace(/_/g, '.') };
  if (/Mac OS X|Macintosh/i.test(ua)) return { name: 'macOS', version: '' };
  if ((m = ua.match(/(?:Tizen)[\s/]([\d.]+)/i))) return { name: 'Tizen', version: m[1] };
  if ((m = ua.match(/(?:Web0S|WebOS|hpwOS)[\s/]?([\d.]*)/i))) return { name: 'webOS', version: m[1] || '' };
  if ((m = ua.match(/KAIOS\/([\d.]+)/i))) return { name: 'KaiOS', version: m[1] };
  if ((m = ua.match(/HarmonyOS\s?([\d.]*)/i))) return { name: 'HarmonyOS', version: m[1] || '' };
  if ((m = ua.match(/(Ubuntu|Fedora|Debian|CentOS|Red Hat|SUSE|Arch|Gentoo|Slackware|Mint)[\s/]?([\d.]*)/i))) {
    return { name: m[1], version: m[2] || '' };
  }
  if ((m = ua.match(/(FreeBSD|OpenBSD|NetBSD|SunOS|AIX)[\s/]?([\d.]*)/i))) return { name: m[1], version: m[2] || '' };
  if (/BlackBerry|BB10|RIM Tablet/i.test(ua)) return { name: 'BlackBerry', version: '' };
  if (/Linux/i.test(ua)) return { name: 'Linux', version: '' };
  return { name: '', version: '' };
}

/** 端末の作り手をモデル名から推定する（先頭一致・当たらなければ空） */
const VENDORS = [
  { re: /^(?:SM-|SC-|SCV|SGH|SHV|GT-|SPH|SCH)/i, name: 'Samsung' },
  { re: /^(?:Pixel|Nexus)/i, name: 'Google' },
  { re: /^(?:moto|XT\d)/i, name: 'Motorola' },
  { re: /^(?:LM-|LG-|LGV|Nexus 5)/i, name: 'LG' },
  { re: /^(?:CPH|PC\w{2}|OPPO)/i, name: 'OPPO' },
  { re: /^(?:vivo|V\d{4})/i, name: 'vivo' },
  { re: /^(?:Redmi|Mi\s|MI\s|POCO|M2\d|22\d|23\d|24\d|Xiaomi)/i, name: 'Xiaomi' },
  { re: /^(?:ONEPLUS|KB2|LE21|IN2|GM19)/i, name: 'OnePlus' },
  { re: /^(?:SO-|SOV|SOG|Xperia|A\d{3}SO)/i, name: 'Sony' },
  { re: /^(?:SH-|SHV|SHG|AQUOS)/i, name: 'Sharp' },
  { re: /^(?:HUAWEI|ALP-|ANE-|VOG-|ELS-|LIO-|JNY-|NOH-|MAR-)/i, name: 'Huawei' },
  { re: /^(?:KF|Kindle|AFT)/i, name: 'Amazon' },
  { re: /^(?:Nokia|TA-)/i, name: 'Nokia (HMD)' },
  { re: /^(?:F-\d|F0\d|arrows)/i, name: 'FCNT' },
  { re: /^(?:Pixel C|iPhone|iPad|iPod|Macintosh)/i, name: 'Apple' },
];

function vendorFor(model) {
  if (!model) return '';
  for (const v of VENDORS) if (v.re.test(model)) return v.name;
  return '';
}

/** デバイス種別・機種。TV/ゲーム機はモバイル判定より先に見る */
export function detectDevice(ua, os, bot, tokens) {
  if (bot) return { type: 'bot', vendor: '', model: '' };
  if (/Xbox|PlayStation|Nintendo (?:Switch|WiiU|3DS)/i.test(ua)) {
    return {
      type: 'console',
      vendor: /Xbox/i.test(ua) ? 'Microsoft' : (/PlayStation/i.test(ua) ? 'Sony' : 'Nintendo'),
      model: '',
    };
  }
  if (/SmartTV|Smart-TV|SMART-TV|GoogleTV|Android TV|AppleTV|HbbTV|NetCast|BRAVIA|Roku|CrKey|\bTV\b|AFT\w+|VIDAA|Web0S|WebOS/i.test(ua)) {
    let vendor = '';
    if (/BRAVIA/i.test(ua)) vendor = 'Sony';
    else if (/Tizen/i.test(ua)) vendor = 'Samsung';
    else if (/Web0S|WebOS|NetCast/i.test(ua)) vendor = 'LG';
    else if (/AFT\w+|Fire TV/i.test(ua)) vendor = 'Amazon';
    else if (/CrKey/i.test(ua)) vendor = 'Google';
    return { type: 'tv', vendor, model: (ua.match(/AFT\w+/i) || [''])[0] };
  }
  if (/Watch|Wear OS|WatchOS/i.test(ua)) return { type: 'wearable', vendor: /Apple/i.test(ua) ? 'Apple' : '', model: '' };
  // Android の機種名は最初のコメントの3番目（`Linux; Android 13; Pixel 7 Build/…`）
  let model = '';
  if (os.name === 'Android') {
    const comment = tokens.filter((t) => t.kind === 'comment')[0];
    if (comment) {
      for (const part of comment.parts) {
        if (/^(?:Linux|U|Android[\s/][\d.]*|wv|Mobile|Tablet|arm\w*|x86\w*)$/i.test(part)) continue;
        if (/^Android/i.test(part)) continue;
        model = part.replace(/\s*Build\/.*$/i, '').trim();
        break;
      }
    }
  }
  if (/iPhone/i.test(ua)) return { type: 'mobile', vendor: 'Apple', model: 'iPhone' };
  if (/iPod/i.test(ua)) return { type: 'mobile', vendor: 'Apple', model: 'iPod touch' };
  if (/iPad/i.test(ua)) return { type: 'tablet', vendor: 'Apple', model: 'iPad' };
  if (/Kindle|Silk\//i.test(ua) && !/Mobile/i.test(ua)) return { type: 'tablet', vendor: 'Amazon', model: model || 'Kindle' };
  if (/Tablet|PlayBook|RIM Tablet|Nexus (?:7|9|10)/i.test(ua)) return { type: 'tablet', vendor: vendorFor(model), model };
  if (os.name === 'Android') {
    // Android は「Mobile が入っていればスマートフォン、無ければタブレット」が公式の見分け方
    const type = /\bMobile\b/.test(ua) ? 'mobile' : 'tablet';
    return { type, vendor: vendorFor(model), model };
  }
  if (/Windows Phone|BlackBerry|BB10|Opera Mini|IEMobile|\bMobile\b/i.test(ua)) return { type: 'mobile', vendor: '', model: '' };
  if (os.name === 'macOS' || os.name === 'Windows' || os.name === 'ChromeOS' || os.name === 'Linux'
    || /Ubuntu|Fedora|Debian|CentOS|FreeBSD|OpenBSD/i.test(os.name)) {
    return { type: 'desktop', vendor: os.name === 'macOS' ? 'Apple' : '', model: '' };
  }
  return { type: '', vendor: '', model: '' };
}

/** CPUアーキテクチャ */
export function detectCPU(ua) {
  if (/(?:Win64|WOW64|x86[_-]64|x64|amd64)/i.test(ua)) return 'x86-64 (64bit)';
  if (/(?:aarch64|arm64)/i.test(ua)) return 'ARM64';
  if (/\bARM\b|armv\d/i.test(ua)) return 'ARM';
  if (/(?:i686|i386|x86)/i.test(ua)) return 'x86 (32bit)';
  if (/PPC|PowerPC/i.test(ua)) return 'PowerPC';
  if (/Intel Mac OS X/i.test(ua)) return 'Intel (Mac)';
  return '';
}

const NOTE_TEXT = {
  clean_header: () => '先頭の `User-Agent:` を取り除いてから解析しました。',
  clean_quoted: () => '前後の引用符を取り除いてから解析しました。',
  clean_punct: () => '末尾のカンマ・セミコロンを取り除いてから解析しました。',
  clean_spaces: () => '連続する空白を1つにまとめてから解析しました。',
  empty: () => 'UA文字列が空です。',
  unknown: () => '既知のブラウザ・ボットのトークンが見つかりませんでした。独自クライアント・ログの途中で切れた行・意図的に書き換えたUAのいずれかの可能性があります。',
  bot_spoof: (n) => `${n} と判定しました。ただしUA文字列は誰でも自由に名乗れます。本物のGooglebot・bingbotかを確かめるには、アクセス元IPの逆引きと再正引き（forward-confirmed reverse DNS）で照合してください。UAだけを根拠に権限を与えてはいけません。`,
  headless: () => 'ヘッドレスChromeです。Puppeteer・Playwright・Lighthouse・CIなどの自動操作で、実ユーザーはこの文字列を送りません。',
  webview: () => 'Android WebView（`wv`）です。ネイティブアプリに埋め込まれたブラウザで、一部のAPI・ファイルのダウンロード・OAuthのリダイレクトがChromeと違う挙動になります。',
  inapp: (n) => `${n} アプリ内蔵のブラウザで開かれています。アプリ内ブラウザはファイルのダウンロード・外部決済へのリダイレクト・一部のストレージAPIが使えないことがあるため、この経路は別途テストしてください。`,
  webkit_only: () => '`Version/` を持たないWebKitのUAです。Safari本体ではなく、iOSのアプリ内ブラウザ（WKWebView / SFSafariViewController）である可能性が高いです。',
  reduced_chrome: () => 'Chromeの削減済みUAです。マイナーバージョンは `0.0.0` に凍結されているので、意味があるのはメジャーバージョンだけです。',
  reduced_android: () => '凍結された固定値 `Android 10; K` が入っています。Chrome 110以降は本当のAndroidバージョンと機種名をここに出しません。Client Hints（`Sec-CH-UA-Platform-Version` / `Sec-CH-UA-Model`）から読んでください。',
  frozen_mac: () => 'macOSは実際のバージョンに関係なく `10_15_7` を名乗ります。SafariもChromeもこの値を凍結したため、新しいMacでも 10.15.7 と出ます。',
  win_10_11: () => '`Windows NT 10.0` は Windows 10 と Windows 11 の両方を指し、UAでは区別できません。`Sec-CH-UA-Platform-Version` を使うと判別できます（14.0.0 以上なら Windows 11）。',
  ipad_desktop: () => 'iPadは既定の「デスクトップ用Webサイトを表示」のとき、Mac版Safariとまったく同じUAを送ります。MacとiPadを見分けるには `navigator.maxTouchPoints > 1` を併用してください。',
  frozen_webkit: () => 'Safariは `AppleWebKit/605.1.15` を長年凍結しています。実際のSafariのバージョンは `Version/` の側を見てください。',
  safari_token: (n) => `ブラウザは ${n} ですが、UAには \`Safari/\` が含まれています。「Safari」の部分一致で判定すると、大半のトラフィックを取り違えます。`,
  chrome_token: (n) => `ブラウザは ${n} ですが、UAには \`Chrome/\` が含まれています。より限定的なトークンから先に判定してください。`,
  ios_webkit: (n) => `iOSでは全ブラウザがWebKitを使う決まりのため、${n} もSafariと同じエンジンで描画されています。ここで出る描画バグはSafariのバグです。`,
  ie_eol: () => 'Internet Explorer は2022年6月にサポートが終了しており、セキュリティ更新も提供されていません。',
  edge_legacy: () => 'EdgeHTML時代の旧Edge（2015〜2020）です。現在のChromium版Edgeとは別物です。',
  ie11_no_msie: () => 'IE11は `MSIE` を削除したため、バージョンは `rv:` にあります。「MSIE」を探す古いスクリプトはIE11を取りこぼします。',
  client_hints: () => 'Chromium 110以降なら、User-Agent Client Hints（`Sec-CH-UA-*` ヘッダー）のほうが凍結されておらず、UA文字列より確実です。',
  model_k: () => '機種名が、削減済みUAの固定値である `K` そのものです。実在する機種名ではありません。',
  spoofable: () => 'User-Agent はクライアントが自由に決められる自己申告です。統計と不具合の切り分けには使えますが、アクセス制御や課金の根拠にしてはいけません。',
};

/**
 * 判定のあとに残る「UAでは分からないこと」を列挙する。
 * このツールの価値の大半はここにある（UAは凍結・偽装・使い回しが当たり前のため）。
 */
export function collectNotes(ua, r) {
  const notes = [];
  const add = (level, code, arg) => notes.push({ level, code, arg: arg === undefined ? '' : String(arg) });
  if (!ua) {
    add('info', 'empty');
    return notes;
  }
  for (const c of r.cleanups) add('info', 'clean_' + c);
  if (!r.browser.name && !r.bot) add('warn', 'unknown');

  if (r.bot) add('warn', 'bot_spoof', r.bot.name);
  if (r.browser.name === 'Headless Chrome') add('warn', 'headless');
  if (r.browser.name === 'Android WebView') add('warn', 'webview');
  if (r.inapp) add('warn', 'inapp', r.inapp.name);
  if (r.browser.inapp && !r.inapp) add('warn', 'webkit_only');

  // Chrome 110（2023年）以降のUA削減。マイナー版は 0.0.0 に凍結された
  if (/Chrome\/\d+\.0\.0\.0/.test(ua)) add('info', 'reduced_chrome');
  if (/Android 10; K\b/.test(ua)) add('warn', 'reduced_android');
  if (/Mac OS X 10[._]15[._]7/.test(ua)) add('warn', 'frozen_mac');
  if (r.os.name === 'Windows' && r.os.raw === '10.0') add('warn', 'win_10_11');
  if (r.os.name === 'macOS' && /Safari/.test(ua) && !r.browser.platform) add('info', 'ipad_desktop');
  if (/AppleWebKit\/605\.1\.15/.test(ua)) add('info', 'frozen_webkit');

  // Chrome も Edge も Firefox(iOS) も「Safari」を名乗る。部分一致での判定は必ず外れる
  if (/Safari\//.test(ua) && r.browser.name && r.browser.name !== 'Safari' && r.browser.name !== 'WebKit') {
    add('info', 'safari_token', r.browser.name);
  }
  if (/Chrome\//.test(ua) && r.browser.name && r.browser.name.indexOf('Chrome') === -1 && r.browser.name !== 'Chromium') {
    add('info', 'chrome_token', r.browser.name);
  }
  if (r.browser.platform === 'iOS') add('info', 'ios_webkit', r.browser.name);
  if (r.browser.name === 'Internet Explorer') add('warn', 'ie_eol');
  if (r.browser.legacy === 'EdgeHTML') add('warn', 'edge_legacy');
  if (/Trident/.test(ua) && !/MSIE/.test(ua)) add('info', 'ie11_no_msie');
  if (r.engine.name === 'Blink' && parseInt(r.browser.major || '0', 10) >= 110 && !r.bot) add('info', 'client_hints');
  if (r.os.name === 'Android' && /\bwv[;)]/.test(ua) === false && r.device.model === 'K') add('info', 'model_k');
  add('info', 'spoofable');
  return notes;
}

/** UA文字列を解析する。入力を正規化 → トークン分解 → 各要素を判定 → 指摘を集める */
export function parseUserAgent(raw) {
  const { ua, cleanups } = normalizeInput(raw);
  const tokens = ua ? tokenizeUA(ua) : [];
  const bot = ua ? detectBot(ua) : null;
  const browser = ua ? detectBrowser(ua) : { name: '', version: '', major: '', platform: '', legacy: '', inapp: false };
  const engine = ua ? detectEngine(ua, browser) : { name: '', version: '' };
  const os = ua ? detectOS(ua) : { name: '', version: '' };
  const device = ua ? detectDevice(ua, os, bot, tokens) : { type: '', vendor: '', model: '' };
  const inapp = ua ? detectInApp(ua) : null;
  const result = {
    ua, cleanups, tokens, bot, browser, engine, os, device, inapp,
    cpu: ua ? detectCPU(ua) : '',
    length: ua.length,
  };
  result.notes = collectNotes(ua, result);
  return result;
}

/** MCPの返り値の形。site側の「JSON」パネルと同じ項目に、トークン内訳と指摘を足したもの */
function toResult(raw, { includeTokens = true } = {}) {
  const r = parseUserAgent(raw);
  const out = {
    user_agent: r.ua,
    browser: {
      name: r.browser.name || null,
      version: r.browser.version || null,
      major: r.browser.major || null,
      platform: r.browser.platform || null,
      legacy_engine: r.browser.legacy || null,
    },
    engine: { name: r.engine.name || null, version: r.engine.version || null },
    os: { name: r.os.name || null, version: r.os.version || null },
    device: { type: r.device.type || null, vendor: r.device.vendor || null, model: r.device.model || null },
    cpu: r.cpu || null,
    in_app_browser: r.inapp ? r.inapp.name : null,
    bot: r.bot ? { name: r.bot.name, version: r.bot.version || null, category: r.bot.category } : null,
    is_bot: Boolean(r.bot),
  };
  if (includeTokens) {
    const tokens = [];
    for (const tok of r.tokens) {
      const texts = tok.kind === 'comment' ? tok.parts : [tok.text];
      for (const t of texts) {
        const code = docForToken(t);
        tokens.push(code ? { token: t, meaning: TOKEN_TEXT[code] } : { token: t });
      }
    }
    out.tokens = tokens;
  }
  out.notes = r.notes
    .map((n) => {
      const fn = NOTE_TEXT[n.code];
      return fn ? { level: n.level, code: n.code, message: fn(n.arg) } : null;
    })
    .filter(Boolean);
  return out;
}

/** 件数の多い順に並べた内訳を作る（アクセスログの集計向け） */
function tally(values) {
  const counts = new Map();
  for (const v of values) {
    const key = v || '(unknown)';
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return Object.fromEntries([...counts.entries()].sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0]))));
}

/**
 * user_agent_parse の本体。
 * ua は1件、uas は複数件（アクセスログの集計に使う）。
 */
export function userAgentParse(opts = {}) {
  const hasOne = typeof opts.ua === 'string' && opts.ua.trim() !== '';
  const hasMany = Array.isArray(opts.uas) && opts.uas.length > 0;
  if (!hasOne && !hasMany) throw new UserAgentError('ua（1件のUA文字列）または uas（複数件の配列）を渡してください');
  if (hasOne && hasMany) throw new UserAgentError('ua と uas は同時に渡せません（どちらか一方にしてください）');

  if (hasOne) return toResult(opts.ua);

  const includeTokens = opts.includeTokens !== false && opts.uas.length <= 20;
  const results = opts.uas.map((u) => {
    if (typeof u !== 'string') throw new UserAgentError('uas の要素はすべて文字列で渡してください');
    return toResult(u, { includeTokens });
  });
  return {
    count: results.length,
    summary: {
      browsers: tally(results.map((r) => r.browser.name)),
      os: tally(results.map((r) => r.os.name)),
      device_types: tally(results.map((r) => r.device.type)),
      engines: tally(results.map((r) => r.engine.name)),
      bots: results.filter((r) => r.is_bot).length,
      in_app_browsers: results.filter((r) => r.in_app_browser).length,
    },
    results,
  };
}
