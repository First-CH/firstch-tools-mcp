// apps.mjs（apps.first-ch.com の API を呼ぶ app_* ツール）のテスト。実ネットワークは使わない。
// - fetch を差し替えて、リクエストの URL・メソッド・ヘッダー・本文と、応答の受け渡し・エラーの形を確かめる
// - 定義表が FirstCHApps の functions/_shared/apps-registry.ts の一覧と一致することを確かめる
//   （隣のリポジトリが無い環境では飛ばす。場所は FIRSTCH_APPS_REPO で指定できる）
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import {
  APP_TOOLS, callAppTool, buildRequestBody, resolveBaseUrl, AppsApiError,
  DEFAULT_APPS_BASE_URL, DEFAULT_TIMEOUT_MS, SLOW_TIMEOUT_MS,
} from './apps.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const byName = Object.fromEntries(APP_TOOLS.map((d) => [d.name, d]));
let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log(`  ok - ${label}`);
};

/** 呼ばれた引数を記録し、決めた応答を返す fetch の偽物 */
function mockFetch(respond) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init, body: init?.body ? JSON.parse(init.body) : undefined });
    return respond(url, init);
  };
  fn.calls = calls;
  return fn;
}
const jsonRes = (obj, status = 200, headers = {}) =>
  new Response(JSON.stringify(obj), { status, headers: { 'content-type': 'application/json', ...headers } });

// ---------------------------------------------------------------------------
// 定義表そのもの
// ---------------------------------------------------------------------------
{
  assert.ok(APP_TOOLS.length >= 30, `定義が少なすぎる: ${APP_TOOLS.length}`);
  const names = new Set();
  for (const d of APP_TOOLS) {
    assert.match(d.name, /^app_[a-z0-9_]+$/, d.name);
    assert.equal(d.name, `app_${d.slug.replace(/-/g, '_')}`);
    assert.ok(!names.has(d.name), `重複: ${d.name}`);
    names.add(d.name);
    assert.match(d.apiPath, new RegExp(`^/${d.slug}/api/[a-z]+$`), `${d.name}: apiPath ${d.apiPath}`);
    assert.ok(d.title.includes('apps.first-ch.com'), `${d.name}: title に送信先が無い`);
    assert.ok(d.description.includes('apps.first-ch.com へ送って処理する'), `${d.name}: 送信の明記が無い`);
    assert.ok(d.description.includes('サーバーには保存されない'), `${d.name}: 保存しない旨が無い`);
    assert.ok('lang' in d.inputSchema, `${d.name}: lang が無い`);
    // inputSchema は z.object に包める（server.mjs と同じ扱い）
    z.object(d.inputSchema);
    assert.ok([DEFAULT_TIMEOUT_MS, SLOW_TIMEOUT_MS].includes(d.timeoutMs));
  }
  // AI を使う2本は回数制限を説明に書く
  for (const n of ['app_tone_check', 'app_lp_persona_check']) {
    assert.equal(byName[n].ai, true);
    assert.match(byName[n].description, /回数制限あり/);
    assert.match(byName[n].description, /1日50回/);
    assert.match(byName[n].description, /10分に5回/);
    assert.equal(byName[n].timeoutMs, SLOW_TIMEOUT_MS, 'AI 側のタイムアウト45秒より長く待つ');
  }
  assert.equal(APP_TOOLS.filter((d) => d.ai).length, 2);
  assert.match(byName.app_nap_check.description, /10分に10回/);
  assert.match(byName.app_redirect_map.description, /1分に60組/);
  assert.match(byName.app_lookalike_domain.description, /10分に30回/);
  assert.match(byName.app_lookalike_domain.description, /取引先のドメイン一覧/);
  ok(`定義表 ${APP_TOOLS.length} 件の形`);
}

// 入力スキーマの要所（API 実装の受け口に合わせているか）
{
  const parse = (name, v) => z.object(byName[name].inputSchema).safeParse(v);
  assert.ok(parse('app_meta_check', { url: 'https://example.com/' }).success);
  assert.ok(!parse('app_meta_check', {}).success);
  assert.ok(parse('app_ssl', { host: 'example.com' }).success);
  assert.ok(parse('app_lookalike_domain', { sender: 'keiri@example.co.jp', trusted: ['example.co.jp'] }).success);
  assert.ok(parse('app_lookalike_domain', { sender: 'keiri@example.co.jp' }).success, 'trusted は省ける（登録日と MX だけ）');
  assert.ok(!parse('app_lookalike_domain', { trusted: ['example.co.jp'] }).success);
  assert.ok(!parse('app_lookalike_domain', { sender: 'a@b.jp', trusted: new Array(51).fill('example.co.jp') }).success);
  assert.ok(parse('app_gaibu_soushinsaki', { url: 'https://example.com/', lang: 'en' }).success);
  assert.ok(!parse('app_gaibu_soushinsaki', {}).success, 'url は必須');
  assert.ok(!parse('app_gaibu_soushinsaki', { url: 'https://example.com/' + 'a'.repeat(2048) }).success, 'URL は2,048字まで');
  assert.ok(parse('app_status_check', { urls: ['https://a.example/'] }).success);
  assert.ok(!parse('app_status_check', { urls: new Array(11).fill('https://a.example/') }).success);
  assert.ok(parse('app_redirect_map', { from: 'https://a/', to: 'https://b/' }).success);
  assert.ok(!parse('app_redirect_map', { from: 'https://a/' }).success);
  assert.ok(parse('app_robots_tester', { url: 'https://example.com/x', userAgent: 'GPTBot' }).success);
  assert.ok(parse('app_dns_propagation', { domain: 'example.com', type: 'MX', expected: '10 mx.example.com' }).success);
  assert.ok(!parse('app_dns_propagation', { domain: 'example.com', type: 'SOA' }).success);
  assert.ok(parse('app_email_dns', { domain: 'example.com', selector: 'google,selector1' }).success);
  assert.ok(parse('app_domain_availability', { name: 'firstch' }).success);
  assert.ok(parse('app_myip', {}).success);
  assert.ok(parse('app_tone_check', { text: 'お世話になっております。' }).success);
  assert.ok(!parse('app_tone_check', { text: 'あ'.repeat(2001) }).success);
  assert.ok(parse('app_lp_persona_check', { text: '無料相談', industry: 'shigyo' }).success);
  assert.ok(!parse('app_lp_persona_check', { text: '無料相談' }).success, 'industry は必須');
  assert.ok(!parse('app_lp_persona_check', { text: '無料相談', industry: 'food' }).success);
  assert.ok(parse('app_ja_readability_check', { url: 'https://example.com/', cpl: 40 }).success);
  assert.ok(!parse('app_ja_readability_check', { url: 'https://example.com/', cpl: 9 }).success);
  assert.ok(parse('app_faq_site_diff', { faq: 'https://e.example/faq/', sites: ['https://e.example/p/'] }).success);
  assert.ok(!parse('app_faq_site_diff', { faq: 'https://e.example/faq/', sites: [] }).success);
  assert.ok(!parse('app_nap_check', { urls: ['a', 'b', 'c', 'd'] }).success);
  assert.ok(!parse('app_meta_check', { url: 'https://example.com/', lang: 'fr' }).success);
  ok('入力スキーマ');
}

// ---------------------------------------------------------------------------
// HTTP 呼び出し
// ---------------------------------------------------------------------------

// 既定のベース URL・メソッド・ヘッダー・本文・応答の受け渡し
{
  const reply = { url: 'https://example.com/', checks: [{ key: 'title', ok: true }], stored: false };
  const f = mockFetch(() => jsonRes(reply));
  const out = await callAppTool(byName.app_meta_check, { url: 'https://example.com/' }, { fetch: f, version: '9.9.9', baseUrl: '' });
  assert.deepEqual(out, reply, '応答の JSON をそのまま返す');
  assert.equal(f.calls.length, 1);
  const { url, init, body } = f.calls[0];
  assert.equal(url, `${DEFAULT_APPS_BASE_URL}/meta-check/api/inspect`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers['content-type'], 'application/json');
  assert.equal(init.headers.accept, 'application/json');
  assert.equal(init.headers['user-agent'], 'first-ch-tools-mcp/9.9.9');
  assert.equal(init.redirect, 'manual');
  assert.ok(init.signal instanceof AbortSignal);
  assert.deepEqual(body, { url: 'https://example.com/' });
  ok('POST・UA・本文・応答の受け渡し');
}

// lang: 'en' は /en/ の API を呼び、本文には lang を入れない。undefined の項目は落とす
{
  const f = mockFetch(() => jsonRes({ ok: true }));
  await callAppTool(
    byName.app_dns_propagation,
    { domain: 'example.com', type: 'MX', expected: undefined, lang: 'en' },
    { fetch: f, baseUrl: 'http://127.0.0.1:8788/' },
  );
  assert.equal(f.calls[0].url, 'http://127.0.0.1:8788/en/dns-propagation/api/check');
  assert.deepEqual(f.calls[0].body, { domain: 'example.com', type: 'MX' });
  ok("lang='en' とベース URL の上書き");
}

// アプリごとの本文の形（配列・数値・複数項目）がそのまま届く
{
  const cases = [
    ['app_status_check', { urls: ['https://a.example/', 'https://b.example/'] }, '/status-check/api/check'],
    ['app_redirect_map', { from: 'https://old.example/a', to: 'https://new.example/a/' }, '/redirect-map/api/check'],
    ['app_robots_tester', { url: 'https://example.com/admin/', userAgent: 'Googlebot' }, '/robots-tester/api/test'],
    ['app_ssl', { host: 'example.com' }, '/ssl/api/inspect'],
    ['app_email_dns', { domain: 'example.com', selector: 'google' }, '/email-dns/api/check'],
    ['app_domain_availability', { name: 'firstch' }, '/domain-availability/api/check'],
    ['app_tone_check', { text: '先日の件、どうなっていますか？' }, '/tone-check/api/check'],
    ['app_lp_persona_check', { text: '相続の手続き、まずは無料でご相談ください。', industry: 'shigyo' }, '/lp-persona-check/api/check'],
    ['app_ja_readability_check', { url: 'https://example.com/', cpl: 40 }, '/ja-readability-check/api/check'],
    ['app_faq_site_diff', { faq: 'https://example.com/faq/', sites: ['https://example.com/pricing/'] }, '/faq-site-diff/api/check'],
    ['app_nap_check', { urls: ['https://example.com/', 'https://example.com/company/'] }, '/nap-check/api/check'],
    ['app_myip', {}, '/myip/api/info'],
  ];
  for (const [name, args, path] of cases) {
    const f = mockFetch(() => jsonRes({ name }));
    const out = await callAppTool(byName[name], args, { fetch: f, baseUrl: 'https://apps.test' });
    assert.deepEqual(out, { name });
    assert.equal(f.calls[0].url, `https://apps.test${path}`, name);
    assert.deepEqual(f.calls[0].body, args, name);
  }
  ok(`本文の形 ${cases.length} 種`);
}

// 全定義について、パスが registry の apiPath どおりに組み立てられる
{
  for (const d of APP_TOOLS) {
    const f = mockFetch(() => jsonRes({}));
    await callAppTool(d, {}, { fetch: f, baseUrl: 'https://apps.test' });
    assert.equal(f.calls[0].url, `https://apps.test${d.apiPath}`);
    assert.equal(f.calls[0].init.method, 'POST');
  }
  ok('全定義の呼び出し先');
}

// HTTP エラー（API の error/message を含める・429 は回数制限の案内）
{
  const f400 = mockFetch(() => jsonRes({ error: 'invalid_url', message: 'URLの形式が正しくありません。' }, 400));
  await assert.rejects(
    () => callAppTool(byName.app_meta_check, { url: 'x' }, { fetch: f400 }),
    (e) => {
      assert.ok(e instanceof AppsApiError);
      assert.equal(e.status, 400);
      assert.equal(e.code, 'invalid_url');
      assert.match(e.message, /HTTP 400・invalid_url/);
      assert.match(e.message, /URLの形式が正しくありません/);
      assert.deepEqual(e.body, { error: 'invalid_url', message: 'URLの形式が正しくありません。' });
      return true;
    },
  );
  const f429 = mockFetch(() => jsonRes({ error: 'daily_limit', message: '本日の上限に達しました。' }, 429));
  await assert.rejects(
    () => callAppTool(byName.app_tone_check, { text: 'a' }, { fetch: f429 }),
    (e) => e.status === 429 && /daily_limit/.test(e.message) && /回数制限/.test(e.message),
  );
  const f502 = mockFetch(() => jsonRes({ error: 'timeout' }, 502));
  await assert.rejects(
    () => callAppTool(byName.app_geo, { url: 'https://example.com/' }, { fetch: f502 }),
    (e) => e.status === 502 && /相手のサイトに届かなかった/.test(e.message),
  );
  ok('HTTP エラーの伝え方');
}

// JSON でない応答・転送・接続失敗・タイムアウト
{
  const html = mockFetch(() => new Response('<!doctype html><title>Oops</title>', { status: 500, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(
    () => callAppTool(byName.app_geo, { url: 'https://example.com/' }, { fetch: html }),
    (e) => e.code === 'not_json' && /JSON ではありません/.test(e.message) && /HTTP 500/.test(e.message) && /text\/html/.test(e.message),
  );
  const okHtml = mockFetch(() => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }));
  await assert.rejects(() => callAppTool(byName.app_geo, { url: 'https://example.com/' }, { fetch: okHtml }), (e) => e.code === 'not_json');

  const moved = mockFetch(() => new Response(null, { status: 301, headers: { location: 'https://apps.first-ch.com/geo/' } }));
  await assert.rejects(
    () => callAppTool(byName.app_geo, { url: 'https://example.com/' }, { fetch: moved }),
    (e) => e.code === 'redirect' && /HTTP 301/.test(e.message),
  );

  const down = async () => {
    throw new TypeError('fetch failed', { cause: { code: 'ECONNREFUSED' } });
  };
  await assert.rejects(
    () => callAppTool(byName.app_geo, { url: 'https://example.com/' }, { fetch: down }),
    (e) => e.code === 'network' && /接続できませんでした（ECONNREFUSED）/.test(e.message),
  );

  // 応答が返らない fetch。signal の abort で止まること
  const hang = (url, init) =>
    new Promise((_, reject) => {
      init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  const t0 = Date.now();
  await assert.rejects(
    () => callAppTool(byName.app_geo, { url: 'https://example.com/' }, { fetch: hang, timeoutMs: 50 }),
    (e) => e.code === 'timeout' && /タイムアウト/.test(e.message),
  );
  assert.ok(Date.now() - t0 < 2000);
  ok('JSON でない応答・転送・接続失敗・タイムアウト');
}

// ベース URL の決め方と本文の組み立て
{
  assert.equal(resolveBaseUrl(''), DEFAULT_APPS_BASE_URL);
  assert.equal(resolveBaseUrl(undefined), DEFAULT_APPS_BASE_URL);
  assert.equal(resolveBaseUrl('http://localhost:8788/'), 'http://localhost:8788');
  assert.throws(() => resolveBaseUrl('ftp://example.com'), AppsApiError);
  assert.throws(() => resolveBaseUrl('not a url'), AppsApiError);
  const saved = process.env.FIRSTCH_APPS_BASE_URL;
  process.env.FIRSTCH_APPS_BASE_URL = 'http://127.0.0.1:9999';
  try {
    const f = mockFetch(() => jsonRes({}));
    await callAppTool(byName.app_dns, { domain: 'example.com' }, { fetch: f });
    assert.equal(f.calls[0].url, 'http://127.0.0.1:9999/dns/api/lookup');
  } finally {
    if (saved === undefined) delete process.env.FIRSTCH_APPS_BASE_URL;
    else process.env.FIRSTCH_APPS_BASE_URL = saved;
  }
  assert.deepEqual(buildRequestBody({ url: 'u', lang: 'en', cpl: undefined }), { url: 'u' });
  ok('ベース URL（環境変数 FIRSTCH_APPS_BASE_URL）と本文');
}

// ---------------------------------------------------------------------------
// FirstCHApps の apps-registry.ts と一致するか（隣のリポジトリがあるときだけ）
// ---------------------------------------------------------------------------
{
  const candidates = [
    process.env.FIRSTCH_APPS_REPO,
    join(here, '..', 'FirstCHApps'),
  ].filter(Boolean);
  const repo = candidates.find((p) => existsSync(join(p, 'functions', '_shared', 'apps-registry.ts')));
  if (!repo) {
    console.log('  skip - apps-registry.ts との突合（FirstCHApps が見つからない。FIRSTCH_APPS_REPO で場所を指定できる）');
  } else {
    const src = readFileSync(join(repo, 'functions', '_shared', 'apps-registry.ts'), 'utf8');
    // APPS 配列の各要素の slug と apiPath を出現順に拾う
    const list = src.slice(src.indexOf('export const APPS'));
    const registry = [];
    const re = /slug:\s*"([^"]+)"[\s\S]*?apiPath:\s*"([^"]+)"/g;
    let m;
    while ((m = re.exec(list))) registry.push({ slug: m[1], apiPath: m[2] });
    assert.ok(registry.length >= 30, `registry の読み取りに失敗: ${registry.length} 件`);
    assert.deepEqual(
      APP_TOOLS.map((d) => ({ slug: d.slug, apiPath: d.apiPath })),
      registry,
      'apps.mjs の定義表と apps-registry.ts の APPS（slug・apiPath・並び）が食い違う',
    );
    // 各アプリの API 実装が、こちらが送る項目名を読んでいるか（本文の項目名の打ち間違いを拾う）
    for (const d of APP_TOOLS) {
      const handler = readFileSync(join(repo, 'functions', d.slug, '[[path]].ts'), 'utf8');
      assert.ok(handler.includes(d.apiPath.slice(d.slug.length + 2)) || handler.includes(d.apiPath), `${d.slug}: API パスが実装に無い`);
      for (const key of Object.keys(d.inputSchema)) {
        if (key === 'lang') continue;
        assert.match(handler, new RegExp(`[.?]${key}\\b`), `${d.slug}: 実装が "${key}" を読んでいない`);
      }
    }
    ok(`apps-registry.ts との突合（${registry.length} 件・${repo}）`);
  }
}

console.log(`apps tests passed (${passed})`);
