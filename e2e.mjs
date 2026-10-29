#!/usr/bin/env node
// stdio E2E smoke test: spawns server.mjs as a child process and speaks minimal
// JSON-RPC over stdin/stdout, asserting `initialize` succeeds, `tools/list`
// returns all 43 local tools plus the app_* tools from apps.mjs when FIRSTCH_ENABLE_APPS=1 (the app_* calls go to a local fake
// API via FIRSTCH_APPS_BASE_URL, never to the network), and `tools/call` actually executes handlers
// (contrast_check / count_chars / marp_render / testdata_generate / diff_check / cron_explain /
// base64_encode / url_params / html_escape / json_to_yaml / yaml_to_json / px_rem_convert /
// color_convert / hash_generate / jwt_decode / user_agent_parse / uuid_generate / aspect_ratio_calc / markdown_table / sql_format / qr_generate / unixtime_convert / robotstxt_generate / case_convert / csv_convert / zenkaku_convert / cidr_calc / date_calc / html_to_markdown / wareki_convert / slug_generate / htpasswd_generate / openapi_doc_generate /
// faq_jsonld_generate / lines_process / dpi_calc / serp_check / css_layout_generate / wiki_doc_lint / fit_to_box) and returns the expected values — this catches
// regressions where a handler throws but the tool is still listed correctly.
// Exits non-zero on any failure.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createServer } from 'node:http';
import { APP_TOOLS } from './apps.mjs';

const here = dirname(fileURLToPath(import.meta.url));

// app_* ツールは apps.first-ch.com を呼ぶ。E2E では実ネットワークを使わず、手元に立てた偽の API へ向ける
// （FIRSTCH_APPS_BASE_URL）。受けたリクエストを記録し、パスごとに決めた応答を返す。
const appsRequests = [];
const fakeApps = createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    appsRequests.push({ method: req.method, url: req.url, headers: req.headers, body: raw });
    if (req.url === '/meta-check/api/inspect') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ url: JSON.parse(raw).url, title: { value: 'Example', ok: true }, stored: false }));
    } else {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_url', message: 'URLの形式が正しくありません。' }));
    }
  });
});
await new Promise((resolve) => fakeApps.listen(0, '127.0.0.1', resolve));
const fakeAppsUrl = `http://127.0.0.1:${fakeApps.address().port}`;

const child = spawn(process.execPath, [join(here, 'server.mjs')], {
  stdio: ['pipe', 'pipe', 'inherit'],
  env: { ...process.env, FIRSTCH_APPS_BASE_URL: fakeAppsUrl, FIRSTCH_ENABLE_APPS: '1' },
});

const pending = new Map();
let buf = '';
child.stdout.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  let idx;
  while ((idx = buf.indexOf('\n')) !== -1) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    const resolve = pending.get(msg.id);
    if (resolve) {
      pending.delete(msg.id);
      resolve(msg);
    }
  }
});

function request(method, params, id) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method} (id ${id})`)), 15000);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      resolve(msg);
    });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
}

try {
  const initRes = await request(
    'initialize',
    { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'firstch-tools-e2e', version: '0.0.0' } },
    1,
  );
  assert.ok(initRes.result, `initialize failed: ${JSON.stringify(initRes)}`);
  assert.equal(initRes.result.serverInfo?.name, 'firstch-tools');

  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');

  const listRes = await request('tools/list', {}, 2);
  const names = (listRes.result?.tools || []).map((t) => t.name).sort();
  const expected = [
    'aspect_ratio_calc',
    'base64_encode',
    'case_convert',
    'cidr_calc',
    'color_convert',
    'contrast_check',
    'count_chars',
    'cron_explain',
    'css_layout_generate',
    'csv_convert',
    'date_calc',
    'diff_check',
    'dpi_calc',
    'encoding_convert',
    'faq_jsonld_generate',
    'fit_to_box',
    'hash_generate',
    'html_escape',
    'html_to_markdown',
    'htpasswd_generate',
    'json_to_yaml',
    'jsonld_generate',
    'jwt_decode',
    'lines_process',
    'llmstxt_generate',
    'markdown_table',
    'marp_render',
    'openapi_doc_generate',
    'px_rem_convert',
    'qr_generate',
    'robotstxt_generate',
    'serp_check',
    'slug_generate',
    'sql_format',
    'testdata_generate',
    'unixtime_convert',
    'url_params',
    'user_agent_parse',
    'uuid_generate',
    'wareki_convert',
    'webp_convert',
    'wiki_doc_lint',
    'yaml_to_json',
    'zenkaku_convert',
  ];
  // apps.first-ch.com を呼ぶ app_* ツールは apps.mjs の定義表から足す
  expected.push(...APP_TOOLS.map((d) => d.name));
  expected.sort();
  assert.deepEqual(names, expected, `unexpected tool list: ${JSON.stringify(names)}`);

  // annotations: 全ツールに readOnlyHint・destructiveHint・openWorldHint・title がある（Software Directory Policy 5E）。
  // ファイルを書くツールは readOnlyHint:false・destructiveHint:true で、上書きは overwrite で明示させる。
  const WRITERS = new Set([
    'webp_convert', 'marp_render', 'testdata_generate', 'base64_encode', 'html_escape', 'json_to_yaml', 'yaml_to_json',
    'px_rem_convert', 'markdown_table', 'sql_format', 'qr_generate', 'robotstxt_generate', 'case_convert', 'csv_convert',
    'zenkaku_convert', 'html_to_markdown', 'htpasswd_generate', 'openapi_doc_generate', 'lines_process',
  ]);
  for (const t of listRes.result.tools) {
    const a = t.annotations || {};
    for (const k of ['readOnlyHint', 'destructiveHint', 'openWorldHint']) {
      assert.equal(typeof a[k], 'boolean', `${t.name}: annotations.${k} が無い: ${JSON.stringify(a)}`);
    }
    assert.ok(a.title, `${t.name}: annotations.title が無い`);
    const props = t.inputSchema?.properties || {};
    const writes = 'outputPath' in props || 'outputDir' in props || WRITERS.has(t.name);
    assert.equal(WRITERS.has(t.name), writes, `${t.name}: 書き込みツールの一覧と inputSchema が食い違う`);
    if (writes) {
      assert.equal(a.readOnlyHint, false, `${t.name}: ファイルを書くのに readOnlyHint が true`);
      assert.equal(a.destructiveHint, true, `${t.name}: 上書きしうるのに destructiveHint が false`);
      assert.ok('overwrite' in props, `${t.name}: overwrite 引数が無い`);
    } else {
      assert.equal(a.readOnlyHint, true, `${t.name}: 読むだけなのに readOnlyHint が false`);
      assert.equal(a.destructiveHint, false, `${t.name}: destructiveHint が true`);
    }
    assert.equal(a.openWorldHint, t.name === 'marp_render' || t.name.startsWith('app_'), `${t.name}: openWorldHint が想定と違う`);
  }

  // tools/call: actually invoke a couple of handlers so a change that makes every
  // handler throw (while leaving tools/list untouched) fails this smoke test too.
  const callTool = async (name, args, id) => {
    const res = await request('tools/call', { name, arguments: args }, id);
    assert.ok(!res.result?.isError, `${name} call errored: ${JSON.stringify(res)}`);
    const text = res.result?.content?.[0]?.text;
    assert.ok(text, `${name} returned no text content: ${JSON.stringify(res)}`);
    return JSON.parse(text);
  };

  // encoding_convert: text だけでも呼べる（base64 は任意）
  const encText = await callTool('encoding_convert', { text: 'abc\r\n' }, 990);
  assert.equal(encText.newline?.dominant, 'CRLF', `encoding_convert text-only: ${JSON.stringify(encText)}`);

  const contrast = await callTool('contrast_check', { fg: '#333333', bg: '#ffffff' }, 3);
  assert.equal(contrast.ratio, 12.63, `contrast_check ratio mismatch: ${JSON.stringify(contrast)}`);
  assert.equal(contrast.aa_normal_text, true, `contrast_check aa_normal_text mismatch: ${JSON.stringify(contrast)}`);

  const chars = await callTool('count_chars', { text: 'あいうえおかきくけこ' }, 4);
  assert.equal(chars.x_weight, 20, `count_chars x_weight mismatch: ${JSON.stringify(chars)}`);
  assert.equal(chars.total, 10, `count_chars total mismatch: ${JSON.stringify(chars)}`);

  // marp_render: 実際にレンダーしてスライド数・HTML出力パスを確認（html のみ＝Chrome非依存）
  const marp = await callTool(
    'marp_render',
    { markdown: '# A\n\n---\n\n# B', formats: ['html'] },
    5,
  );
  assert.equal(marp.slides, 2, `marp_render slides mismatch: ${JSON.stringify(marp)}`);
  assert.ok(marp.outputs?.html, `marp_render produced no html: ${JSON.stringify(marp)}`);
  {
    const { readFile, rm } = await import('node:fs/promises');
    const html = await readFile(marp.outputs.html, 'utf8');
    assert.ok(html.includes('<section id='), 'marp_render html has slide sections');
    await rm(marp.outputs.html, { force: true });
  }

  // seed を固定すれば出力は完全に再現される（id列だけなら生成辞書に依存しない）
  const td = await callTool('testdata_generate', { rows: 2, seed: 'e2e', fields: ['id'], format: 'csv' }, 6);
  assert.equal(td.text, 'id\n1\n2\n', `testdata_generate text mismatch: ${JSON.stringify(td)}`);
  assert.equal(td.seed, 'e2e', `testdata_generate seed mismatch: ${JSON.stringify(td)}`);

  const boundary = await callTool('testdata_generate', { mode: 'text', preset: 'digit', length: 3 }, 7);
  assert.deepEqual(
    boundary.variants.map((v) => v.text),
    ['01', '012', '0123'],
    `testdata_generate boundary text mismatch: ${JSON.stringify(boundary)}`,
  );


  // format=xlsx は base64 で .xlsx 本体を返す（MCP経由でもバイナリが壊れないこと）
  const xl = await callTool('testdata_generate', { rows: 2, seed: 'e2e', fields: ['id', 'name'], format: 'xlsx' }, 8);
  assert.equal(xl.format, 'xlsx', `testdata_generate format mismatch: ${JSON.stringify(xl)}`);
  const xlBytes = Buffer.from(xl.base64, 'base64');
  assert.equal(xlBytes.length, xl.bytes, 'xlsx byte count mismatch');
  assert.deepEqual([...xlBytes.subarray(0, 2)], [0x50, 0x4b], 'xlsx is not a ZIP');
  assert.ok(xlBytes.includes(Buffer.from('xl/worksheets/sheet1.xml')), 'xlsx is missing the worksheet part');

  // diff_check: 実際に差分を取り、unified diff と件数が返ること
  const diff = await callTool('diff_check', { a: 'a\nb\nc\n', b: 'a\nB\nc\n', format: 'both' }, 9);
  assert.equal(diff.identical, false, `diff_check identical mismatch: ${JSON.stringify(diff)}`);
  assert.equal(diff.changed, 1, `diff_check changed mismatch: ${JSON.stringify(diff)}`);
  assert.equal(diff.unchanged, 2, `diff_check unchanged mismatch: ${JSON.stringify(diff)}`);
  assert.equal(
    diff.unified,
    '--- a\n+++ b\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n',
    `diff_check unified mismatch: ${JSON.stringify(diff.unified)}`,
  );
  assert.deepEqual(diff.changes?.[0]?.added?.map((r) => r.line), [2], `diff_check changes mismatch: ${JSON.stringify(diff.changes)}`);

  const identical = await callTool('diff_check', { a: 'x\ny\n', b: 'x\r\ny\r\n' }, 10);
  assert.equal(identical.identical, true, `diff_check should ignore line-ending style: ${JSON.stringify(identical)}`);

  // cron_explain: from を固定して読み下しと発火日時を突合（実行時刻に依存しない）
  const cron = await callTool(
    'cron_explain',
    { expression: '*/15 * * * *', timeZone: 'Asia/Tokyo', count: 2, from: '2026-08-08T12:03:20+09:00' },
    11,
  );
  assert.equal(cron.description_ja, '毎日、15分ごと（毎時 0分・15分・30分・45分）に実行します。', `cron_explain description mismatch: ${JSON.stringify(cron.description_ja)}`);
  assert.deepEqual(
    cron.next.map((n) => n.local),
    ['2026-08-08 12:15:00', '2026-08-08 12:30:00'],
    `cron_explain next mismatch: ${JSON.stringify(cron.next)}`,
  );
  const cronErr = await request('tools/call', { name: 'cron_explain', arguments: { expression: '61 * * * *' } }, 12);
  assert.ok(cronErr.result?.isError, `cron_explain should reject an out-of-range field: ${JSON.stringify(cronErr)}`);

  // base64_encode: エンコード → デコードの往復がMCP越しでも壊れないこと
  const b64 = await callTool('base64_encode', { text: 'こんにちは', dataUri: true }, 13);
  assert.equal(b64.base64, Buffer.from('こんにちは', 'utf8').toString('base64'), `base64_encode mismatch: ${JSON.stringify(b64)}`);
  assert.equal(b64.data_uri, 'data:text/plain;charset=utf-8;base64,' + b64.base64, `base64_encode data_uri mismatch: ${JSON.stringify(b64)}`);

  const b64back = await callTool('base64_encode', { mode: 'decode', base64: b64.data_uri }, 14);
  assert.equal(b64back.text, 'こんにちは', `base64_encode decode mismatch: ${JSON.stringify(b64back)}`);
  assert.equal(b64back.is_text, true, `base64_encode is_text mismatch: ${JSON.stringify(b64back)}`);

  // SVGはパーセントエンコードの方が短いので、そちらが data_uri になり HTML/CSS スニペットも付く
  const svgRes = await callTool(
    'base64_encode',
    { text: '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle r="10"/></svg>', dataUri: true, snippets: true },
    15,
  );
  assert.equal(svgRes.data_uri_encoding, 'percent', `base64_encode svg encoding mismatch: ${JSON.stringify(svgRes)}`);
  assert.ok(svgRes.snippets?.html.includes('width="24" height="24"'), `base64_encode svg snippet mismatch: ${JSON.stringify(svgRes.snippets)}`);
  for (const ch of ['"', '<', '>', '&', '#', ' ']) {
    assert.ok(!svgRes.data_uri.includes(ch), `percent-encoded SVG must not contain ${JSON.stringify(ch)}: ${svgRes.data_uri}`);
  }

  const b64Err = await request('tools/call', { name: 'base64_encode', arguments: { mode: 'decode', base64: '!!!!' } }, 16);
  assert.ok(b64Err.result?.isError, `base64_encode should reject invalid Base64: ${JSON.stringify(b64Err)}`);

  // url_params: 無編集の再構築が1バイトも変わらないこと（MCP越しでも生の値を保つ）
  const signed = 'https://e.com/f.jpg?Expires=1&Signature=aB%2Fc%3D&q=a+b';
  const up = await callTool('url_params', { url: signed }, 17);
  assert.equal(up.url, signed, `url_params must not rewrite an untouched URL: ${JSON.stringify(up)}`);
  assert.equal(up.params.at(-1).value, 'a b', `url_params should decode + as a space: ${JSON.stringify(up.params)}`);

  // UTM付与とクリックID削除
  const utmRes = await callTool(
    'url_params',
    { url: 'https://e.com/lp/?gclid=EAIa', utm: { source: 'newsletter', medium: 'email' }, removeTracking: true },
    18,
  );
  assert.equal(
    utmRes.url,
    'https://e.com/lp/?utm_source=newsletter&utm_medium=email',
    `url_params utm/removeTracking mismatch: ${JSON.stringify(utmRes)}`,
  );
  assert.deepEqual(utmRes.removed, ['gclid'], `url_params removed mismatch: ${JSON.stringify(utmRes)}`);

  const encRes = await callTool('url_params', { mode: 'encode', text: '検索 語' }, 19);
  assert.equal(encRes.output, encodeURIComponent('検索 語'), `url_params encode mismatch: ${JSON.stringify(encRes)}`);

  const urlErr = await request('tools/call', { name: 'url_params', arguments: {} }, 20);
  assert.ok(urlErr.result?.isError, `url_params should reject a missing url: ${JSON.stringify(urlErr)}`);


  // html_escape: エスケープ → デコードの往復がMCP越しでも壊れないこと
  const esc = await callTool('html_escape', { text: `<a href='/x'>5 & 10</a>` }, 21);
  assert.equal(
    esc.text,
    '&lt;a href=&#39;/x&#39;&gt;5 &amp; 10&lt;/a&gt;',
    `html_escape mismatch: ${JSON.stringify(esc)}`,
  );
  const unesc = await callTool('html_escape', { mode: 'unescape', text: esc.text }, 22);
  assert.equal(unesc.text, `<a href='/x'>5 & 10</a>`, `html_escape unescape mismatch: ${JSON.stringify(unesc)}`);
  assert.ok(
    unesc.notes.some((n) => n.code === 'HAS_TAGS'),
    `html_escape should flag decoded markup: ${JSON.stringify(unesc.notes)}`,
  );

  const escErr = await request('tools/call', { name: 'html_escape', arguments: {} }, 23);
  assert.ok(escErr.result?.isError, `html_escape should reject a missing text/path: ${JSON.stringify(escErr)}`);

  // json_to_yaml / yaml_to_json: 往復がMCP越しでも壊れないこと。値が別の型に読まれる形
  // （0755 / yes）は引用符が付いて出ることまで見る
  const y = await callTool('json_to_yaml', { text: '{"mode":"0755","flag":"yes","ports":["80:80"]}' }, 24);
  assert.equal(
    y.text,
    "mode: '0755'\nflag: 'yes'\nports:\n  - 80:80\n",
    `json_to_yaml mismatch: ${JSON.stringify(y.text)}`,
  );

  const j = await callTool('yaml_to_json', { text: y.text, indent: 0 }, 25);
  assert.equal(
    j.text.trim(),
    '{"mode":"0755","flag":"yes","ports":["80:80"]}',
    `yaml_to_json round-trip mismatch: ${JSON.stringify(j.text)}`,
  );

  // 複数ドキュメントは配列になり、意味が変わる箇所は notes で返る
  const multi = await callTool('yaml_to_json', { text: 'a: 0755\n---\nb: 2\n', indent: 0 }, 26);
  assert.equal(multi.documents, 2, `yaml_to_json documents mismatch: ${JSON.stringify(multi)}`);
  assert.equal(multi.text.trim(), '[{"a":755},{"b":2}]', `yaml_to_json multi-doc mismatch: ${JSON.stringify(multi.text)}`);
  assert.ok(
    multi.notes.some((n) => n.code === 'YAML_LEADING_ZERO' && n.message),
    `yaml_to_json should flag a leading zero: ${JSON.stringify(multi.notes)}`,
  );

  // 構文エラーは isError で返し、メッセージに行・桁が入っていること
  const yamlErr = await request('tools/call', { name: 'yaml_to_json', arguments: { text: 'a: 1\n\tb: 2\n' } }, 27);
  assert.ok(yamlErr.result?.isError, `yaml_to_json should reject tab indentation: ${JSON.stringify(yamlErr)}`);
  assert.match(
    yamlErr.result?.content?.[0]?.text || '',
    /TAB_INDENT/,
    `yaml_to_json error should name the cause: ${JSON.stringify(yamlErr.result)}`,
  );

  const jyErr = await request('tools/call', { name: 'json_to_yaml', arguments: {} }, 28);
  assert.ok(jyErr.result?.isError, `json_to_yaml should reject a missing text/path: ${JSON.stringify(jyErr)}`);

  // px_rem_convert: 値の換算とCSSの一括変換（1pxの罫線と @media の条件は既定で残す）
  const pxv = await callTool('px_rem_convert', { value: 24 }, 29);
  assert.equal(pxv.formatted?.rem, '1.5rem', `px_rem_convert rem mismatch: ${JSON.stringify(pxv)}`);
  assert.equal(pxv.scale?.length, 15, `px_rem_convert scale mismatch: ${JSON.stringify(pxv.scale)}`);

  const pxc = await callTool(
    'px_rem_convert',
    { css: 'a{border:1px solid;padding:24px}\n@media (min-width:768px){a{font-size:18px}}' },
    30,
  );
  assert.equal(
    pxc.text,
    'a{border:1px solid;padding:1.5rem}\n@media (min-width:768px){a{font-size:1.125rem}}',
    `px_rem_convert css mismatch: ${JSON.stringify(pxc.text)}`,
  );

  const pxErr = await request('tools/call', { name: 'px_rem_convert', arguments: {} }, 31);
  assert.ok(pxErr.result?.isError, `px_rem_convert should reject an empty call: ${JSON.stringify(pxErr)}`);

  // color_convert: 形式変換とアルファ合成（黒50%を白に重ねると #808080）
  const col = await callTool('color_convert', { color: 'rgb(200 80 31)', alpha: 0.4, background: '#ffffff' }, 32);
  assert.equal(col.formats?.hex, '#c8501f', `color_convert hex mismatch: ${JSON.stringify(col.formats)}`);
  assert.equal(col.formats?.rgba, 'rgb(200 80 31 / 0.4)', `color_convert rgba mismatch: ${JSON.stringify(col.formats)}`);
  assert.equal(col.formats?.hex8, '#c8501f66', `color_convert hex8 mismatch: ${JSON.stringify(col.formats)}`);
  assert.equal(col.flattened?.hex, '#e9b9a5', `color_convert flattened mismatch: ${JSON.stringify(col.flattened)}`);
  assert.equal(col.palette?.length, 11, `color_convert palette mismatch: ${JSON.stringify(col.palette)}`);

  const colBlack = await callTool('color_convert', { color: 'black', alpha: '50%', alphaTable: false, palette: false }, 33);
  assert.equal(colBlack.flattened?.hex, '#808080', `color_convert composite mismatch: ${JSON.stringify(colBlack.flattened)}`);

  const colErr = await request('tools/call', { name: 'color_convert', arguments: { color: 'zzz' } }, 34);
  assert.ok(colErr.result?.isError, `color_convert should reject an unreadable colour: ${JSON.stringify(colErr)}`);

  // hash_generate: 既知のテストベクタと、期待値との照合
  const hash = await callTool('hash_generate', { text: 'hello', expected: '5d41402abc4b2a76b9719d911017c592  hello.txt' }, 35);
  assert.equal(hash.hashes?.md5, '5d41402abc4b2a76b9719d911017c592', `hash_generate md5 mismatch: ${JSON.stringify(hash.hashes)}`);
  assert.equal(
    hash.hashes?.sha256,
    '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824',
    `hash_generate sha256 mismatch: ${JSON.stringify(hash.hashes)}`,
  );
  assert.equal(hash.verification?.matched, true, `hash_generate verification mismatch: ${JSON.stringify(hash.verification)}`);

  const hashB64 = await callTool('hash_generate', { text: 'hello', algorithms: ['sha256'], format: 'base64' }, 36);
  assert.equal(
    hashB64.hashes?.sha256,
    'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=',
    `hash_generate base64 mismatch: ${JSON.stringify(hashB64.hashes)}`,
  );

  const hashErr = await request('tools/call', { name: 'hash_generate', arguments: {} }, 37);
  assert.ok(hashErr.result?.isError, `hash_generate should require text or path: ${JSON.stringify(hashErr)}`);

  // jwt_decode: HS256のトークンをデコードし、期限と署名を判定する
  // （固定のトークン。now を渡して判定時刻を固定するので、時間が経っても結果は変わらない）
  const jwtTok = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'
    + '.eyJzdWIiOiIxMjM0NTY3ODkwIiwiaXNzIjoiaHR0cHM6Ly9hdXRoLmV4YW1wbGUuY29tLyIsImlhdCI6MTc4Njc4NDQwMCwiZXhwIjoxNzg2Nzg4MDAwfQ'
    + '.KVvjU3NS8y9w9bwIAyLzQB-WMs5QIxsl3vTqgfDrhlc';
  const jwtRes = await callTool('jwt_decode', { token: 'Bearer ' + jwtTok, key: 'firstch-tools-demo-secret-2026', now: 1786786000 }, 38);
  assert.equal(jwtRes.header?.alg, 'HS256', `jwt_decode header mismatch: ${JSON.stringify(jwtRes.header)}`);
  assert.equal(jwtRes.payload?.sub, '1234567890', `jwt_decode payload mismatch: ${JSON.stringify(jwtRes.payload)}`);
  assert.equal(jwtRes.expiry?.status, 'valid', `jwt_decode expiry mismatch: ${JSON.stringify(jwtRes.expiry)}`);
  assert.equal(jwtRes.expiry?.remaining_seconds, 2000, `jwt_decode remaining mismatch: ${JSON.stringify(jwtRes.expiry)}`);
  assert.equal(jwtRes.verification?.status, 'verified', `jwt_decode verification mismatch: ${JSON.stringify(jwtRes.verification)}`);

  // 同じトークンを期限後に見ると expired、鍵が違えば failed
  const jwtExp = await callTool('jwt_decode', { token: jwtTok, key: 'wrong-secret', now: 1786790000 }, 39);
  assert.equal(jwtExp.expiry?.status, 'expired', `jwt_decode should be expired: ${JSON.stringify(jwtExp.expiry)}`);
  assert.equal(jwtExp.verification?.status, 'failed', `jwt_decode should not verify: ${JSON.stringify(jwtExp.verification)}`);

  const jwtErr = await request('tools/call', { name: 'jwt_decode', arguments: {} }, 40);
  assert.ok(jwtErr.result?.isError, `jwt_decode should require a token: ${JSON.stringify(jwtErr)}`);

  // user_agent_parse: Edge のUAを、Chrome や Safari と取り違えずに判定する
  const uaRes = await callTool('user_agent_parse', {
    ua: 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0',
  }, 41);
  assert.equal(uaRes.browser?.name, 'Microsoft Edge', `user_agent_parse browser mismatch: ${JSON.stringify(uaRes.browser)}`);
  assert.equal(uaRes.engine?.name, 'Blink', `user_agent_parse engine mismatch: ${JSON.stringify(uaRes.engine)}`);
  assert.equal(uaRes.os?.name, 'Windows', `user_agent_parse os mismatch: ${JSON.stringify(uaRes.os)}`);
  assert.equal(uaRes.device?.type, 'desktop', `user_agent_parse device mismatch: ${JSON.stringify(uaRes.device)}`);
  assert.equal(uaRes.is_bot, false, `user_agent_parse should not be a bot: ${JSON.stringify(uaRes.bot)}`);
  assert.ok(
    uaRes.notes?.some((n) => n.code === 'win_10_11'),
    `user_agent_parse should flag Windows 10/11: ${JSON.stringify(uaRes.notes)}`,
  );

  // 複数件は内訳付きで返す
  const uaMany = await callTool('user_agent_parse', {
    uas: [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    ],
  }, 42);
  assert.equal(uaMany.count, 2, `user_agent_parse count mismatch: ${JSON.stringify(uaMany.count)}`);
  assert.equal(uaMany.summary?.bots, 1, `user_agent_parse bot count mismatch: ${JSON.stringify(uaMany.summary)}`);
  assert.equal(uaMany.summary?.device_types?.mobile, 1, `user_agent_parse device summary mismatch: ${JSON.stringify(uaMany.summary)}`);

  const uaErr = await request('tools/call', { name: 'user_agent_parse', arguments: {} }, 43);
  assert.ok(uaErr.result?.isError, `user_agent_parse should require ua or uas: ${JSON.stringify(uaErr)}`);

  // uuid_generate: UUID v4 を10件（重複なし・書式が RFC 9562 どおり）
  const uuidRes = await callTool('uuid_generate', { type: 'uuid', count: 10 }, 44);
  assert.equal(uuidRes.count, 10, `uuid_generate count mismatch: ${JSON.stringify(uuidRes.count)}`);
  assert.equal(uuidRes.ids?.length, 10, `uuid_generate ids mismatch: ${JSON.stringify(uuidRes.ids)}`);
  assert.equal(uuidRes.duplicates, 0, `uuid_generate produced duplicates: ${JSON.stringify(uuidRes.ids)}`);
  for (const id of uuidRes.ids) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, `uuid_generate bad id: ${id}`);
  }

  // ULID は時刻を固定でき、同一ミリ秒内でも辞書順＝生成順になる
  const ulidRes = await callTool('uuid_generate', { type: 'ulid', count: 5, timestamp: '2026-08-18T12:34:56.789Z', format: 'json' }, 45);
  assert.equal(ulidRes.timestamp?.iso, '2026-08-18T12:34:56.789Z', `uuid_generate ulid timestamp mismatch: ${JSON.stringify(ulidRes.timestamp)}`);
  assert.deepEqual(ulidRes.ids, [...ulidRes.ids].sort(), `ulid batch is not sorted: ${JSON.stringify(ulidRes.ids)}`);
  assert.deepEqual(JSON.parse(ulidRes.text), ulidRes.ids, `uuid_generate json format mismatch: ${ulidRes.text}`);
  for (const id of ulidRes.ids) {
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/, `uuid_generate bad ulid: ${id}`);
  }

  const uuidErr = await request('tools/call', { name: 'uuid_generate', arguments: { count: 1000 } }, 46);
  assert.ok(uuidErr.result?.isError, `uuid_generate should reject count > 100: ${JSON.stringify(uuidErr)}`);

  // aspect_ratio_calc: 16:9 で幅1280 → 高さ720・padding-top 56.25%
  const arRes = await callTool('aspect_ratio_calc', { ratio: '16:9', width: 1280, snippet: true }, 47);
  assert.equal(arRes.height, 720, `aspect_ratio_calc height mismatch: ${JSON.stringify(arRes.height)}`);
  assert.equal(arRes.ratio?.text, '16:9', `aspect_ratio_calc ratio mismatch: ${JSON.stringify(arRes.ratio)}`);
  assert.equal(arRes.padding_top, '56.25%', `aspect_ratio_calc padding_top mismatch: ${arRes.padding_top}`);
  assert.ok(arRes.snippet?.css.includes('aspect-ratio: 16 / 9;'), `aspect_ratio_calc snippet mismatch: ${arRes.snippet?.css}`);

  // 寸法だけを渡すと約分した比率と、枠へはめ込んだときの切り取り量を返す
  const arMeasure = await callTool('aspect_ratio_calc', { width: 1920, height: 1080, box: '1280x400', fit: 'cover' }, 48);
  assert.equal(arMeasure.ratio?.text, '16:9', `aspect_ratio_calc measure mismatch: ${JSON.stringify(arMeasure.ratio)}`);
  assert.equal(arMeasure.fit?.crop_y, 160, `aspect_ratio_calc fit mismatch: ${JSON.stringify(arMeasure.fit)}`);

  const arErr = await request('tools/call', { name: 'aspect_ratio_calc', arguments: { width: 1920 } }, 49);
  assert.ok(arErr.result?.isError, `aspect_ratio_calc should require ratio or both sides: ${JSON.stringify(arErr)}`);

  // markdown_table: 全角混じりのTSVを桁揃えしたMarkdownの表へ（数値の列は右寄せ）
  const mtRes = await callTool('markdown_table', { text: '商品名\t単価\n和紙ノート\t1,200\n' }, 50);
  assert.equal(mtRes.text,
    '| 商品名     |  単価 |\n| ---------- | ----: |\n| 和紙ノート | 1,200 |\n',
    `markdown_table text mismatch: ${JSON.stringify(mtRes.text)}`);
  assert.equal(mtRes.source?.format, 'tsv', `markdown_table source mismatch: ${JSON.stringify(mtRes.source)}`);
  assert.equal(mtRes.columns, 2, `markdown_table columns mismatch: ${JSON.stringify(mtRes.columns)}`);
  assert.deepEqual(mtRes.aligns, ['none', 'right'], `markdown_table aligns mismatch: ${JSON.stringify(mtRes.aligns)}`);

  // Markdownの表はCSVへ戻せる（配置を読み、<br> は改行に戻して引用符で囲む）
  const mtBack = await callTool('markdown_table', { text: '| a | b |\n| :-- | --: |\n| 1 | x<br>y |\n', to: 'csv' }, 51);
  assert.equal(mtBack.text, 'a,b\n1,"x\ny"\n', `markdown_table csv mismatch: ${JSON.stringify(mtBack.text)}`);
  assert.equal(mtBack.source?.format, 'markdown', `markdown_table should detect markdown: ${JSON.stringify(mtBack.source)}`);

  const mtErr = await request('tools/call', { name: 'markdown_table', arguments: {} }, 52);
  assert.ok(mtErr.result?.isError, `markdown_table should require text or path: ${JSON.stringify(mtErr)}`);

  // sql_format: 1行のSQLを句ごとに改行して字下げし、WHEREの無いDELETEは指摘する
  const sqlRes = await callTool('sql_format', { text: 'select o.id, u.name from orders o inner join users u on u.id=o.uid where o.a=1 and o.b=2' }, 53);
  assert.equal(sqlRes.text,
    'SELECT\n    o.id,\n    u.name\nFROM orders o\nINNER JOIN users u\n    ON u.id = o.uid\nWHERE o.a = 1\n    AND o.b = 2\n',
    `sql_format text mismatch: ${JSON.stringify(sqlRes.text)}`);
  assert.equal(sqlRes.statements, 1, `sql_format statements mismatch: ${JSON.stringify(sqlRes.statements)}`);
  assert.equal(sqlRes.options?.indent, '4', `sql_format options mismatch: ${JSON.stringify(sqlRes.options)}`);

  const sqlWarn = await callTool('sql_format', { text: 'delete from logs', compact: true }, 54);
  assert.equal(sqlWarn.text, 'DELETE FROM logs\n', `sql_format compact mismatch: ${JSON.stringify(sqlWarn.text)}`);
  assert.ok(sqlWarn.notes?.some((n) => n.code === 'NO_WHERE'),
    `sql_format should warn about a missing WHERE: ${JSON.stringify(sqlWarn.notes)}`);

  const sqlErr = await request('tools/call', { name: 'sql_format', arguments: {} }, 55);
  assert.ok(sqlErr.result?.isError, `sql_format should require text or path: ${JSON.stringify(sqlErr)}`);

  // qr_generate: URLからQRコードのSVGを作り、型番と誤り訂正の内訳を返す
  const qrRes = await callTool('qr_generate', { text: 'https://tools.first-ch.com/qr/' }, 56);
  assert.equal(qrRes.version, 3, `qr_generate version mismatch: ${JSON.stringify(qrRes.version)}`);
  assert.equal(qrRes.modules, 29, `qr_generate modules mismatch: ${JSON.stringify(qrRes.modules)}`);
  assert.equal(qrRes.ec_level, 'M', `qr_generate ec_level mismatch: ${JSON.stringify(qrRes.ec_level)}`);
  assert.ok(qrRes.svg?.startsWith('<svg xmlns="http://www.w3.org/2000/svg" width="320" height="320" viewBox="0 0 37 37"'),
    `qr_generate svg mismatch: ${JSON.stringify(qrRes.svg?.slice(0, 120))}`);

  const qrText = await callTool('qr_generate', { text: '12345', format: 'text', margin: 0, ecLevel: 'H' }, 57);
  assert.equal(qrText.mode, 'numeric', `qr_generate mode mismatch: ${JSON.stringify(qrText.mode)}`);
  assert.ok(qrText.text?.includes('██'), `qr_generate text art mismatch: ${JSON.stringify(qrText.text?.slice(0, 40))}`);

  const qrErr = await request('tools/call', { name: 'qr_generate', arguments: { text: 'a', ecLevel: 'Z' } }, 58);
  assert.ok(qrErr.result?.isError, `qr_generate should reject an unknown ecLevel: ${JSON.stringify(qrErr)}`);

  // unixtime_convert: UNIX秒を日本時間へ直し、逆方向（日時→秒）と単位の自動判定も確かめる
  const utRes = await callTool(
    'unixtime_convert',
    { input: '1755999999\n1755999999123\n2026-08-24T09:30:00Z\nnope', timeZone: 'Asia/Tokyo', now: '2026-08-24T09:00:00Z' },
    59,
  );
  assert.equal(utRes.converted, 3, `unixtime_convert converted mismatch: ${JSON.stringify(utRes.converted)}`);
  assert.equal(utRes.unreadable, 1, `unixtime_convert unreadable mismatch: ${JSON.stringify(utRes.unreadable)}`);
  assert.equal(utRes.rows?.[0]?.local, '2025-08-24 10:46:39',
    `unixtime_convert local mismatch: ${JSON.stringify(utRes.rows?.[0])}`);
  assert.equal(utRes.rows?.[1]?.read_as, 'UNIXミリ秒',
    `unixtime_convert unit detection mismatch: ${JSON.stringify(utRes.rows?.[1]?.read_as)}`);
  assert.equal(utRes.rows?.[2]?.unix_seconds, 1787563800,
    `unixtime_convert reverse mismatch: ${JSON.stringify(utRes.rows?.[2])}`);
  assert.equal(utRes.rows?.[2]?.relative, '30分後',
    `unixtime_convert relative mismatch: ${JSON.stringify(utRes.rows?.[2]?.relative)}`);
  assert.equal(utRes.rows?.[3]?.error?.code, 'unparsable',
    `unixtime_convert should flag the unreadable line: ${JSON.stringify(utRes.rows?.[3])}`);

  const utErr = await request('tools/call', { name: 'unixtime_convert', arguments: { input: '1755999999', timeZone: 'Mars/Olympus' } }, 60);
  assert.ok(utErr.result?.isError, `unixtime_convert should reject an unknown time zone: ${JSON.stringify(utErr)}`);

  // robotstxt_generate: 学習用のAIクローラーだけを拒否し、共通の禁止パスをAI側へ書き写す
  const rtRes = await callTool(
    'robotstxt_generate',
    { siteUrl: 'https://example.com', disallow: '/admin/', sitemaps: 'https://example.com/sitemap.xml' },
    61,
  );
  assert.ok(rtRes.text?.includes('User-agent: GPTBot'),
    `robotstxt_generate should block GPTBot by default: ${JSON.stringify(rtRes.text?.slice(0, 120))}`);
  assert.ok(rtRes.text?.includes('User-agent: OAI-SearchBot'),
    `robotstxt_generate should list OAI-SearchBot as allowed: ${JSON.stringify(rtRes.text?.slice(0, 120))}`);
  assert.equal((rtRes.text?.match(/Disallow: \/admin\//g) || []).length, 2,
    `robotstxt_generate should copy the shared disallow into the AI group: ${JSON.stringify(rtRes.text)}`);
  assert.ok(rtRes.text?.endsWith('Sitemap: https://example.com/sitemap.xml\n'),
    `robotstxt_generate sitemap mismatch: ${JSON.stringify(rtRes.text?.slice(-80))}`);
  assert.ok(rtRes.stats?.aiBlocked > 0 && rtRes.stats?.aiAllowed > 0,
    `robotstxt_generate stats mismatch: ${JSON.stringify(rtRes.stats)}`);

  const rtList = await callTool('robotstxt_generate', { listCrawlers: true }, 62);
  assert.equal(rtList.count, 24, `robotstxt_generate crawler count mismatch: ${JSON.stringify(rtList.count)}`);

  const rtErr = await request('tools/call', { name: 'robotstxt_generate', arguments: { ai: { preset: 'sometimes' } } }, 63);
  assert.ok(rtErr.result?.isError, `robotstxt_generate should reject an unknown preset: ${JSON.stringify(rtErr)}`);

  // case_convert: 行ごとの一括変換とCSVヘッダー（区切りを保つ）
  const ccRes = await callTool('case_convert', { text: 'user_name\nLAST-NAME\nXMLHttpRequest', format: 'camel' }, 64);
  assert.equal(ccRes.text, 'userName\nlastName\nxmlHttpRequest',
    `case_convert camelCase mismatch: ${JSON.stringify(ccRes.text)}`);
  assert.equal(ccRes.items?.[0]?.detected, 'snake',
    `case_convert should detect snake_case: ${JSON.stringify(ccRes.items?.[0])}`);

  const ccCsv = await callTool('case_convert', { text: 'First Name, Last Name', format: 'snake', scope: 'items' }, 65);
  assert.equal(ccCsv.text, 'first_name, last_name',
    `case_convert should keep the separators: ${JSON.stringify(ccCsv.text)}`);

  const ccAll = await callTool('case_convert', { text: 'XMLHttpRequest', scope: 'whole', allFormats: true }, 66);
  assert.equal(ccAll.items?.[0]?.all?.constant, 'XML_HTTP_REQUEST',
    `case_convert allFormats mismatch: ${JSON.stringify(ccAll.items?.[0]?.all)}`);

  const ccList = await callTool('case_convert', { listFormats: true }, 67);
  assert.equal(ccList.count, 11, `case_convert format count mismatch: ${JSON.stringify(ccList.count)}`);

  const ccErr = await request('tools/call', { name: 'case_convert', arguments: { text: 'a', format: 'CamelCase' } }, 68);
  assert.ok(ccErr.result?.isError, `case_convert should reject an unknown format: ${JSON.stringify(ccErr)}`);

  // csv_convert: 両方向・入れ子・向きの推定・構文エラーの位置
  const cjRes = await callTool('csv_convert', { text: 'id,name\n1,Ada\n2,Bob\n' }, 69);
  assert.equal(cjRes.direction, 'csv2json', `csv_convert should guess csv2json: ${JSON.stringify(cjRes.direction)}`);
  assert.deepEqual(JSON.parse(cjRes.output || 'null'), [{ id: 1, name: 'Ada' }, { id: 2, name: 'Bob' }],
    `csv_convert csv2json mismatch: ${JSON.stringify(cjRes.output)}`);

  const cjBack = await callTool('csv_convert', { text: '[{"id":1,"stock":{"qty":5}}]' }, 70);
  assert.equal(cjBack.direction, 'json2csv', `csv_convert should guess json2csv: ${JSON.stringify(cjBack.direction)}`);
  assert.equal(cjBack.output, 'id,stock.qty\n1,5\n',
    `csv_convert json2csv mismatch: ${JSON.stringify(cjBack.output)}`);

  // 先頭0や2^53超のIDは文字列のまま（桁が落ちない）
  const cjKeep = await callTool('csv_convert', { text: 'zip,id\n0123,12345678901234567890\n' }, 71);
  assert.deepEqual(JSON.parse(cjKeep.output || 'null'), [{ zip: '0123', id: '12345678901234567890' }],
    `csv_convert should keep unrepresentable numbers as text: ${JSON.stringify(cjKeep.output)}`);

  const cjTab = await callTool('csv_convert', { text: 'a\tb\n1\t2\n' }, 72);
  assert.equal(cjTab.delimiter, 'tab', `csv_convert should detect the tab: ${JSON.stringify(cjTab.delimiter)}`);

  // 壊れたJSONは例外ではなく ok:false ＋ 行・桁で返る
  const cjBad = await callTool('csv_convert', { text: '[{"a":1,}]' }, 73);
  assert.equal(cjBad.ok, false, `csv_convert should report a syntax error: ${JSON.stringify(cjBad)}`);
  assert.equal(cjBad.error?.line, 1, `csv_convert error line mismatch: ${JSON.stringify(cjBad.error)}`);

  const cjErr = await request('tools/call', { name: 'csv_convert', arguments: { text: 'a', delimiter: 'colon' } }, 74);
  assert.ok(cjErr.result?.isError, `csv_convert should reject an unknown delimiter: ${JSON.stringify(cjErr)}`);

  // zenkaku_convert: 文字種ごとの向き・半角カナの合成・掃除・点検
  const zkRes = await callTool('zenkaku_convert', { text: '株式会社ＡＢＣ　ﾃｽﾄ ﾃﾞｰﾀ\nTEL：０３－１２３４' }, 75);
  assert.equal(zkRes.text, '株式会社ABC テスト データ\nTEL:03-1234',
    `zenkaku_convert default mismatch: ${JSON.stringify(zkRes.text)}`);
  assert.equal(zkRes.options?.kana, 'zen', `zenkaku_convert default kana mismatch: ${JSON.stringify(zkRes.options)}`);

  // 個別指定は preset より優先される（カタカナだけ半角のまま残す）
  const zkKeep = await callTool('zenkaku_convert', { text: 'ｱｲｳ ＡＢＣ', preset: 'ja', kana: 'keep' }, 76);
  assert.equal(zkKeep.text, 'ｱｲｳ ABC', `zenkaku_convert per-kind override mismatch: ${JSON.stringify(zkKeep.text)}`);

  // 全角カナ → 半角カナ（濁点は2文字へ分解する）
  const zkHan = await callTool('zenkaku_convert', { text: 'ガパ「テスト」', preset: 'han' }, 77);
  assert.equal(zkHan.text, 'ｶﾞﾊﾟ｢ﾃｽﾄ｣', `zenkaku_convert half-width katakana mismatch: ${JSON.stringify(zkHan.text)}`);

  // CSV取込前のプリセット（空白の掃除と見えない文字の除去まで）
  const zkCsv = await callTool('zenkaku_convert', { text: '  Ａ   Ｂ  \n ﾃｽﾄ\u200b \n', preset: 'csv' }, 78);
  assert.equal(zkCsv.text, 'A B\nテスト\n', `zenkaku_convert csv preset mismatch: ${JSON.stringify(zkCsv.text)}`);

  // inspect は変換せず点検だけ（本文を返さない）
  const zkIns = await callTool('zenkaku_convert', { text: 'ﾃｽﾄ　①', inspect: true }, 79);
  assert.equal(zkIns.text, undefined, `zenkaku_convert inspect should not return text: ${JSON.stringify(zkIns.text)}`);
  assert.deepEqual((zkIns.notes || []).map((n) => n.code).sort(), ['HANKAKU_KANA', 'PLATFORM', 'ZEN_SPACE'],
    `zenkaku_convert inspect notes mismatch: ${JSON.stringify(zkIns.notes)}`);

  const zkErr = await request('tools/call', { name: 'zenkaku_convert', arguments: { text: 'a', alnum: 'full' } }, 80);
  assert.ok(zkErr.result?.isError, `zenkaku_convert should reject an unknown direction: ${JSON.stringify(zkErr)}`);

  // cidr_calc: 計算・分割・包含・範囲の逆算・壊れた入力
  const cdRes = await callTool('cidr_calc', { cidr: '192.168.1.10/24' }, 81);
  assert.equal(cdRes.cidr, '192.168.1.0/24', `cidr_calc network mismatch: ${JSON.stringify(cdRes.cidr)}`);
  assert.equal(cdRes.broadcast, '192.168.1.255', `cidr_calc broadcast mismatch: ${JSON.stringify(cdRes.broadcast)}`);
  assert.equal(cdRes.usable_hosts, '254', `cidr_calc usable hosts mismatch: ${JSON.stringify(cdRes.usable_hosts)}`);
  assert.ok((cdRes.notes || []).some((n) => n.code === 'HOST_BITS'),
    `cidr_calc should flag host bits: ${JSON.stringify(cdRes.notes)}`);

  const cdSplit = await callTool('cidr_calc', { cidr: '192.168.1.0/24', split: 26, contains: ['192.168.1.77', '10.0.0.1'] }, 82);
  assert.equal(cdSplit.subnets?.list?.[1]?.cidr, '192.168.1.64/26', `cidr_calc split mismatch: ${JSON.stringify(cdSplit.subnets)}`);
  assert.deepEqual((cdSplit.contains || []).map((x) => x.inside), [true, false],
    `cidr_calc contains mismatch: ${JSON.stringify(cdSplit.contains)}`);

  const cdRange = await callTool('cidr_calc', { range: '10.0.0.0/24;10.0.1.0 - 10.0.1.255' }, 83);
  assert.deepEqual(cdRange.range?.cidrs, ['10.0.0.0/23'], `cidr_calc range mismatch: ${JSON.stringify(cdRange.range)}`);

  const cdV6 = await callTool('cidr_calc', { cidr: '2001:db8::1/48', lang: 'en' }, 84);
  assert.equal(cdV6.cidr, '2001:db8::/48', `cidr_calc IPv6 mismatch: ${JSON.stringify(cdV6.cidr)}`);
  assert.equal(cdV6.last_address, '2001:db8:0:ffff:ffff:ffff:ffff:ffff', `cidr_calc IPv6 last mismatch: ${JSON.stringify(cdV6.last_address)}`);

  const cdBad = await callTool('cidr_calc', { cidr: '192.168.001.1' }, 85);
  assert.equal(cdBad.ok, false, `cidr_calc should report a bad address: ${JSON.stringify(cdBad)}`);
  assert.equal(cdBad.error?.code, 'LEADING_ZERO', `cidr_calc error code mismatch: ${JSON.stringify(cdBad.error)}`);

  const cdErr = await request('tools/call', { name: 'cidr_calc', arguments: { split: 26 } }, 86);
  assert.ok(cdErr.result?.isError, `cidr_calc should reject split without cidr: ${JSON.stringify(cdErr)}`);

  // date_calc: 2日付間・営業日の期日・支払サイト・壊れた入力
  const dcBetween = await callTool('date_calc', { start: '2026-09-01', end: '2026-09-30' }, 87);
  assert.equal(dcBetween.business_days, 19, `date_calc business days mismatch: ${JSON.stringify(dcBetween.business_days)}`);
  assert.equal(dcBetween.holiday_days, 3, `date_calc holiday days mismatch: ${JSON.stringify(dcBetween.holiday_days)}`);
  assert.equal(dcBetween.holidays?.[1]?.name, '国民の休日', `date_calc holiday name mismatch: ${JSON.stringify(dcBetween.holidays)}`);

  const dcAdd = await callTool('date_calc', { mode: 'add', base: '2026-09-15', n: 10, unit: 'business', lang: 'en' }, 88);
  assert.equal(dcAdd.result?.date, '2026-10-02', `date_calc due date mismatch: ${JSON.stringify(dcAdd.result)}`);
  assert.equal(dcAdd.skipped_days?.length, 7, `date_calc skipped days mismatch: ${JSON.stringify(dcAdd.skipped_days)}`);

  const dcPay = await callTool('date_calc', { mode: 'payment', invoice: '2026-09-20' }, 89);
  assert.equal(dcPay.closing?.date, '2026-09-30', `date_calc closing mismatch: ${JSON.stringify(dcPay.closing)}`);
  assert.equal(dcPay.payment?.date, '2026-10-30', `date_calc payment mismatch: ${JSON.stringify(dcPay.payment)}`);

  const dcBad = await callTool('date_calc', { start: '2026-02-30', end: '2026-09-30' }, 90);
  assert.equal(dcBad.ok, false, `date_calc should report a bad date: ${JSON.stringify(dcBad)}`);
  assert.equal(dcBad.error?.code, 'NO_SUCH_DATE', `date_calc error code mismatch: ${JSON.stringify(dcBad.error)}`);

  const dcErr = await request('tools/call', { name: 'date_calc', arguments: { start: '2026-09-01' } }, 91);
  assert.ok(dcErr.result?.isError, `date_calc should reject start without end: ${JSON.stringify(dcErr)}`);

  // html_to_markdown: 見出し/リスト/表・本文だけの抽出・壊れたHTML・壊れた引数
  const hmBasic = await callTool('html_to_markdown', {
    html: '<h1>Title</h1><ul><li>a</li><li>b</li></ul><table><tr><th>A</th><th>B</th></tr><tr><td>1</td><td>2</td></tr></table>',
  }, 92);
  assert.equal(hmBasic.markdown, '# Title\n\n- a\n- b\n\n| A   | B   |\n| --- | --- |\n| 1   | 2   |\n',
    `html_to_markdown output mismatch: ${JSON.stringify(hmBasic.markdown)}`);
  assert.equal(hmBasic.stats?.headings, 1, `html_to_markdown stats mismatch: ${JSON.stringify(hmBasic.stats)}`);

  const hmMain = await callTool('html_to_markdown', {
    html: '<body><header>nav</header><main><h2>Body</h2><p><a href="/a">x</a></p></main><footer>f</footer></body>',
    main_only: true,
    base_url: 'https://example.com/blog/1/',
    lang: 'en',
  }, 93);
  assert.equal(hmMain.markdown, '## Body\n\n[x](https://example.com/a)\n',
    `html_to_markdown main_only mismatch: ${JSON.stringify(hmMain.markdown)}`);
  assert.ok(hmMain.notes?.some((n) => n.code === 'MAIN_ONLY'),
    `html_to_markdown should report MAIN_ONLY: ${JSON.stringify(hmMain.notes)}`);

  const hmBroken = await callTool('html_to_markdown', { html: '<p>a<b>bold<a href="x>c' }, 94);
  assert.ok(hmBroken.notes?.some((n) => n.code === 'BROKEN_TAG'),
    `html_to_markdown should report BROKEN_TAG: ${JSON.stringify(hmBroken.notes)}`);

  const hmErr = await request('tools/call', { name: 'html_to_markdown', arguments: {} }, 95);
  assert.ok(hmErr.result?.isError, `html_to_markdown should reject an empty call: ${JSON.stringify(hmErr)}`);

  // wareki_convert: 和暦→西暦・存在しない和暦の指摘・年齢・壊れた入力・壊れた引数
  const wkOne = await callTool('wareki_convert', { date: '令和8年10月1日' }, 96);
  assert.equal(wkOne.seireki?.iso, '2026-10-01', `wareki_convert conversion mismatch: ${JSON.stringify(wkOne.seireki)}`);
  assert.equal(wkOne.weekday, '木', `wareki_convert weekday mismatch: ${JSON.stringify(wkOne.weekday)}`);

  const wkH32 = await callTool('wareki_convert', { dates: ['H32.4.1', '1989-01-08'], lang: 'en' }, 97);
  assert.equal(wkH32.results?.[0]?.notes?.[0]?.code, 'ERA_ENDED', `wareki_convert should flag Heisei 32: ${JSON.stringify(wkH32.results?.[0])}`);
  assert.equal(wkH32.results?.[1]?.wareki?.[0]?.formats?.full, '平成元年1月8日', `wareki_convert boundary mismatch: ${JSON.stringify(wkH32.results?.[1])}`);

  const wkAgeRes = await callTool('wareki_convert', { birth: '昭和60年4月2日', reference: '2026-10-01' }, 98);
  assert.equal(wkAgeRes.age, 41, `wareki_convert age mismatch: ${JSON.stringify(wkAgeRes.age)}`);
  assert.equal(wkAgeRes.school?.[0]?.wareki, '平成4年4月', `wareki_convert school mismatch: ${JSON.stringify(wkAgeRes.school)}`);

  const wkBad = await callTool('wareki_convert', { date: '2026-02-30' }, 99);
  assert.equal(wkBad.ok, false, `wareki_convert should report a bad date: ${JSON.stringify(wkBad)}`);
  assert.equal(wkBad.error?.code, 'NO_SUCH_DATE', `wareki_convert error code mismatch: ${JSON.stringify(wkBad.error)}`);

  const wkErr = await request('tools/call', { name: 'wareki_convert', arguments: { mode: 'age' } }, 100);
  assert.ok(wkErr.result?.isError, `wareki_convert should reject age without birth: ${JSON.stringify(wkErr)}`);

  // slug_generate: 読みからのスラッグ・漢字の取りこぼし・一括と衝突・壊れた引数
  const sgOne = await callTool('slug_generate', { title: '東京で食べたラーメン10選', reading: 'とうきょう で たべた ラーメン 10せん' }, 101);
  assert.equal(sgOne.slug, 'tokyo-de-tabeta-ramen-10-sen', `slug_generate slug mismatch: ${JSON.stringify(sgOne.slug)}`);
  assert.equal(sgOne.variants?.snake_keep, 'toukyou_de_tabeta_raamen_10_sen', `slug_generate variants mismatch: ${JSON.stringify(sgOne.variants)}`);

  const sgKanji = await callTool('slug_generate', { title: '東京のラーメン' }, 102);
  assert.equal(sgKanji.notes?.[0]?.code, 'KANJI', `slug_generate should flag kanji: ${JSON.stringify(sgKanji.notes)}`);

  const sgMany = await callTool('slug_generate', { items: ['まっちゃ', { reading: 'まっちゃ' }], separator: 'snake', lang: 'en' }, 103);
  assert.equal(sgMany.results?.[1]?.slug, 'matcha', `slug_generate batch mismatch: ${JSON.stringify(sgMany.results)}`);
  assert.equal(sgMany.notes?.[0]?.code, 'DUPLICATE', `slug_generate should flag duplicates: ${JSON.stringify(sgMany.notes)}`);

  const sgErr = await request('tools/call', { name: 'slug_generate', arguments: { title: 'a', maxLength: 500 } }, 104);
  assert.ok(sgErr.result?.isError, `slug_generate should reject maxLength 500: ${JSON.stringify(sgErr)}`);

  // expected（ツール一覧）へ 'htpasswd_generate' を追加（アルファベット順で 'html_escape' の前）
  // WRITERS へ 'htpasswd_generate' を追加（outputPath を持つため）

  // htpasswd_generate: bcrypt の1行・パスワードの自動生成とスニペット・照合・壊れた引数
  const htOne = await callTool('htpasswd_generate', { user: 'client', password: 'correct-horse-battery', cost: 4 }, 110);
  assert.match(htOne.entries?.[0]?.line ?? '', /^client:\$2y\$04\$[./A-Za-z0-9]{53}$/, `htpasswd_generate line mismatch: ${JSON.stringify(htOne)}`);

  const htBulk = await callTool('htpasswd_generate', { bulk: 'a:\nb:\n', algo: 'apr1', server: 'nginx', ips: '1.2.3.4' }, 111);
  assert.equal(htBulk.generated?.length, 2, `htpasswd_generate should generate passwords: ${JSON.stringify(htBulk.generated)}`);
  assert.match(htBulk.snippet?.text ?? '', /allow 1\.2\.3\.4;/, `htpasswd_generate snippet mismatch: ${JSON.stringify(htBulk.snippet)}`);

  const htVerify = await callTool('htpasswd_generate', { hash: 'myName:$apr1$r31.....$HqJZimcKQFAMYayBlzkrA/', password: 'myPassword' }, 112);
  assert.equal(htVerify.match, true, `htpasswd_generate verify mismatch: ${JSON.stringify(htVerify)}`);

  const htErr = await request('tools/call', { name: 'htpasswd_generate', arguments: { user: 'a', cost: 20 } }, 113);
  assert.ok(htErr.result?.isError, `htpasswd_generate should reject cost 20: ${JSON.stringify(htErr)}`);

  // e2e.mjs: expected 一覧に 'openapi_doc_generate' を（アルファベット順で）足し、WRITERS にも足す。

  // openapi_doc_generate: 型定義とドキュメント・構文エラー・壊れた引数
  const oaSpec = "openapi: 3.0.3\ninfo: {title: Pet Shop, version: 2.1.0}\npaths:\n  /pets/{petId}:\n    get:\n      operationId: get-pet\n      parameters:\n        - {name: petId, in: path, required: true, schema: {type: integer}}\n      responses:\n        '200': {description: OK, content: {application/json: {schema: {$ref: '#/components/schemas/Pet'}}}}\ncomponents:\n  schemas:\n    Pet: {type: object, required: [id], properties: {id: {type: integer}, name: {type: string}}}\n";
  const oaOne = await callTool('openapi_doc_generate', { spec: oaSpec }, 130);
  assert.equal(oaOne.endpoints, 1, `openapi_doc_generate endpoints mismatch: ${JSON.stringify(oaOne.endpoints)}`);
  assert.match(oaOne.typescript || '', /export interface Pet \{/, `openapi_doc_generate typescript mismatch: ${oaOne.typescript}`);
  assert.match(oaOne.typescript || '', /export type GetPetResponse = Pet;/, `openapi_doc_generate operation types missing: ${oaOne.typescript}`);
  assert.match(oaOne.markdown || '', /^# Pet Shop API リファレンス$/m, `openapi_doc_generate markdown mismatch: ${oaOne.markdown}`);

  const oaBad = await callTool('openapi_doc_generate', { spec: 'foo: 1\n', lang: 'en' }, 131);
  assert.equal(oaBad.error?.code, 'OA_NOT_SPEC', `openapi_doc_generate should reject a non-spec: ${JSON.stringify(oaBad)}`);

  const oaErr = await request('tools/call', { name: 'openapi_doc_generate', arguments: { spec: 'a', path: '/tmp/a.yaml' } }, 132);
  assert.ok(oaErr.result?.isError, `openapi_doc_generate should reject spec+path: ${JSON.stringify(oaErr)}`);

  // faq_jsonld_generate: 回答の Markdown→HTML・一括貼り付け・警告・壊れた引数
  const fqOne = await callTool('faq_jsonld_generate', {
    items: [{ q: '支払い方法は？', a: '次の方法に対応しています。\n- 銀行振込\n- クレジットカード' }],
    bulk: 'Q: 送料は？\nA: 全国一律です。',
  }, 140);
  assert.equal(fqOne.count, 2, `faq_jsonld_generate count mismatch: ${JSON.stringify(fqOne.count)}`);
  assert.equal(fqOne.data?.mainEntity?.[0]?.acceptedAnswer?.text, '<p>次の方法に対応しています。</p><ul><li>銀行振込</li><li>クレジットカード</li></ul>', `faq_jsonld_generate answer html mismatch: ${JSON.stringify(fqOne.data)}`);
  assert.match(fqOne.markdown || '', /^### 送料は？$/m, `faq_jsonld_generate markdown mismatch: ${JSON.stringify(fqOne.markdown)}`);

  const fqWarn = await callTool('faq_jsonld_generate', { items: [{ q: 'a', a: '[x](javascript:alert(1))' }, { q: 'A', a: 'b' }], lang: 'en' }, 141);
  assert.deepEqual(fqWarn.warnings?.map((w) => w.code), ['DUPLICATE', 'UNSAFE_LINK'], `faq_jsonld_generate warnings mismatch: ${JSON.stringify(fqWarn.warnings)}`);

  const fqErr = await request('tools/call', { name: 'faq_jsonld_generate', arguments: {} }, 142);
  assert.ok(fqErr.result?.isError, `faq_jsonld_generate should reject missing items/bulk: ${JSON.stringify(fqErr)}`);

  // expected（ツール一覧）へ 'lines_process' を追加（アルファベット順で 'jwt_decode' の後・'llmstxt_generate' の前）
  // WRITERS へ 'lines_process' を追加（outputPath を持つため）

  // lines_process: プリセット・シード付きシャッフル・壊れた引数
  const lnSort = await callTool('lines_process', { text: 'banana\napple\n  cherry  \nitem10\nitem2\n\nApple\nbanana\n10\n-3\n1.5\n1.25\nitem1\napple\n', preset: 'uniqsort' }, 120);
  assert.equal(lnSort.text, '-3\n1.25\n1.5\n10\napple\nApple\nbanana\ncherry\nitem1\nitem2\nitem10\n', `lines_process uniqsort mismatch: ${JSON.stringify(lnSort.text)}`);
  assert.equal(lnSort.stats?.dup_removed, 2, `lines_process stats mismatch: ${JSON.stringify(lnSort.stats)}`);

  const lnNum = await callTool('lines_process', { text: 'a\r\nb\r\n', number: true, sep: 'paren', lang: 'en' }, 121);
  assert.equal(lnNum.text, '1) a\r\n2) b\r\n', `lines_process numbering mismatch: ${JSON.stringify(lnNum.text)}`);

  const lnErr = await request('tools/call', { name: 'lines_process', arguments: { text: 'a', sort: 'random' } }, 122);
  assert.ok(lnErr.result?.isError, `lines_process should reject sort=random: ${JSON.stringify(lnErr)}`);

  // dpi_calc: 必要ピクセル数（既定 A4・350dpi・塗り足し3mm）・逆算と実効dpi・早見表・単位換算・壊れた引数
  const dpSize = await callTool('dpi_calc', { paper: 'A4' }, 160);
  assert.equal(dpSize.display?.full, '2,977 × 4,176 px', `dpi_calc size mismatch: ${JSON.stringify(dpSize.display)}`);
  assert.equal(dpSize.trimWidth, 2894, `dpi_calc trim mismatch: ${JSON.stringify(dpSize.trimWidth)}`);

  const dpRev = await callTool('dpi_calc', { width: 4000, height: 3000, paper: 'A4' }, 161);
  assert.equal(dpRev.effective?.display, '335 dpi', `dpi_calc reverse mismatch: ${JSON.stringify(dpRev.effective)}`);
  assert.equal(dpRev.effective?.grade, 'ok', `dpi_calc grade mismatch: ${JSON.stringify(dpRev.effective)}`);

  const dpTable = await callTool('dpi_calc', { mode: 'table', format: 'csv', dpi: 300, bleedMm: 0, papers: ['A4'], lang: 'en' }, 162);
  assert.equal(dpTable.text?.split('\n')[1], 'A4,210,297,2481,3508,2481,3508,300,0', `dpi_calc table mismatch: ${JSON.stringify(dpTable.text)}`);

  const dpUnits = await callTool('dpi_calc', { value: '210mm' }, 163);
  assert.equal(dpUnits.display?.px, '2893.7 px', `dpi_calc units mismatch: ${JSON.stringify(dpUnits.display)}`);

  const dpErr = await request('tools/call', { name: 'dpi_calc', arguments: { dpi: 5000 } }, 164);
  assert.ok(dpErr.result?.isError, `dpi_calc should reject 5000 dpi: ${JSON.stringify(dpErr)}`);

  // serp_check: ピクセル幅での切り詰め・両デバイス・一括・壊れた引数
  const spOne = await callTool('serp_check', { title: 'SERPプレビュー＆メタタグ文字数チェック｜title・descriptionのピクセル幅を実測 | First CH Tools', description: '検索結果に表示される説明文です。', url: 'https://example.com/serp/' }, 150);
  assert.equal(spOne.title?.truncated, true, `serp_check should truncate the title: ${JSON.stringify(spOne.title)}`);
  assert.equal(spOne.title?.cut, 'のピクセル幅を実測 | First CH Tools', `serp_check cut mismatch: ${JSON.stringify(spOne.title?.cut)}`);
  assert.equal(spOne.url?.breadcrumb, 'example.com › serp', `serp_check breadcrumb mismatch: ${JSON.stringify(spOne.url)}`);

  const spBoth = await callTool('serp_check', { items: [{ title: 'Page | Site', description: 'x'.repeat(100), url: 'https://a.com/' }], device: 'both' }, 151);
  assert.equal(spBoth.results?.[0]?.mobile?.title?.max_lines, 2, `serp_check mobile mismatch: ${JSON.stringify(spBoth.results?.[0])}`);

  const spErr = await request('tools/call', { name: 'serp_check', arguments: { title: 'a', device: 'tablet' } }, 152);
  assert.ok(spErr.result?.isError, `serp_check should reject device tablet: ${JSON.stringify(spErr)}`);

  // css_layout_generate: 既定の flex・grid のトラックと span・エリアの検証・プリセット・壊れた引数
  const clFlex = await callTool('css_layout_generate', {}, 170);
  assert.equal(clFlex.css, '.layout {\n  display: flex;\n  flex-direction: row;\n  flex-wrap: wrap;\n  gap: 12px;\n}', `css_layout_generate flex mismatch: ${JSON.stringify(clFlex.css)}`);

  const clGrid = await callTool('css_layout_generate', { columns: ['1fr', '1fr', '1fr', '240px'], gap: 16, items: [{ columnSpan: 2 }] }, 171);
  assert.match(clGrid.css || '', /grid-template-columns: repeat\(3, 1fr\) 240px;[\s\S]*grid-column: span 2;/, `css_layout_generate grid mismatch: ${JSON.stringify(clGrid.css)}`);

  const clBad = await callTool('css_layout_generate', { areas: 'a a / b a' }, 172);
  assert.ok(clBad.areas?.error, `css_layout_generate should flag a non-rectangular area: ${JSON.stringify(clBad.areas)}`);
  assert.equal(clBad.notes?.[0]?.level, 'warn', `css_layout_generate area note mismatch: ${JSON.stringify(clBad.notes)}`);

  const clPreset = await callTool('css_layout_generate', { preset: 'holy-grail' }, 173);
  assert.deepEqual(clPreset.areas?.names, ['header', 'nav', 'main', 'aside', 'footer'], `css_layout_generate preset mismatch: ${JSON.stringify(clPreset.areas)}`);

  const clErr = await request('tools/call', { name: 'css_layout_generate', arguments: { gap: 500 } }, 174);
  assert.ok(clErr.result?.isError, `css_layout_generate should reject gap 500: ${JSON.stringify(clErr)}`);

  // wiki_doc_lint: 重複・孤立・表記ゆれ・リンク切れと、壊れた引数（読むだけのツール）
  const wikiBody = '経費精算は月末までに申請します。領収書の原本は翌月5日までに総務へ提出し、立替金は翌月25日に振り込みます。交通費は乗車日と区間を入力すれば領収書は要りません。';
  const wl = await callTool('wiki_doc_lint', {
    files: [
      { path: 'README.md', text: '# 目次\n- [手順](new.md)\n- [[無いページ]]\n' },
      { path: 'new.md', text: '# 手順\n' + wikiBody + '\nサーバの再起動は夜間。' },
      { path: 'old.md', text: '# 手順\n' + wikiBody },
    ],
  }, 180);
  assert.equal(wl.stats?.duplicatePairs, 1, `wiki_doc_lint duplicates mismatch: ${JSON.stringify(wl.stats)}`);
  assert.deepEqual(wl.orphans?.map((o) => [o.path, o.addLine]), [['old.md', '- [手順](old.md)']], `wiki_doc_lint orphans mismatch: ${JSON.stringify(wl.orphans)}`);
  assert.equal(wl.terms?.[0]?.hits?.[0]?.after, 'サーバーの再起動は夜間。', `wiki_doc_lint terms mismatch: ${JSON.stringify(wl.terms)}`);
  assert.deepEqual(wl.broken?.map((b) => b.target), ['無いページ']);
  assert.match(wl.report, /^# 社内文書チェックの結果/);
  const wlErr = await request('tools/call', { name: 'wiki_doc_lint', arguments: { files: [{ path: 'a.md', text: 'x' }], threshold: 2 } }, 181);
  assert.ok(wlErr.result?.isError, `wiki_doc_lint should reject threshold 2: ${JSON.stringify(wlErr)}`);

  // fit_to_box: 住所の割り付け・金額の大字・壊れた引数
  const fb = await callTool('fit_to_box', { text: '北海道札幌市中央区見本通西二十丁目12番地の18 グランドメゾン見本ヒルズ東棟1203号室', postalCode: '000-0000', width: 20, height: 90 }, 182);
  assert.equal(fb.charSizeMm, 3.6, `fit_to_box size mismatch: ${JSON.stringify(fb)}`);
  assert.equal(fb.lines?.[2], 'グランドメゾン見本ヒルズ東棟一二〇三号室', `fit_to_box lines mismatch: ${JSON.stringify(fb.lines)}`);
  assert.equal(fb.alternatives?.omitPrefecture?.fits4mm, true, `fit_to_box alternatives mismatch: ${JSON.stringify(fb.alternatives)}`);
  const fbAmt = await callTool('fit_to_box', { kind: 'amount', text: '30000', width: 18, height: 60 }, 183);
  assert.equal(fbAmt.daiji, '金参萬円', `fit_to_box daiji mismatch: ${JSON.stringify(fbAmt)}`);
  const fbErr = await request('tools/call', { name: 'fit_to_box', arguments: { text: 'x', width: 20, height: 90, orientation: 'diagonal' } }, 184);
  assert.ok(fbErr.result?.isError, `fit_to_box should reject a bad orientation: ${JSON.stringify(fbErr)}`);

  // app_*: 偽の API へ POST し、応答の JSON をそのまま返す・API のエラーは isError になる
  const appMeta = await callTool('app_meta_check', { url: 'https://example.com/' }, 200);
  assert.deepEqual(appMeta, { url: 'https://example.com/', title: { value: 'Example', ok: true }, stored: false });
  const metaReq = appsRequests.find((r) => r.url === '/meta-check/api/inspect');
  assert.equal(metaReq?.method, 'POST', `app_meta_check request: ${JSON.stringify(metaReq)}`);
  assert.deepEqual(JSON.parse(metaReq.body), { url: 'https://example.com/' });
  assert.match(metaReq.headers['user-agent'], /^first-ch-tools-mcp\/\d+\.\d+\.\d+/);
  const appErr = await request('tools/call', { name: 'app_headers', arguments: { url: 'nope', lang: 'en' } }, 201);
  assert.ok(appErr.result?.isError, `app_headers should surface the API error: ${JSON.stringify(appErr)}`);
  assert.match(JSON.stringify(appErr.result), /invalid_url/);
  assert.ok(appsRequests.some((r) => r.url === '/en/headers/api/inspect'), 'lang=en should call the /en/ API');

  // 既定（FIRSTCH_ENABLE_APPS なし）では app_* を出さない＝入力を外へ送るツールは明示的に有効にしたときだけ
  const plain = spawn(process.execPath, [join(here, 'server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'], env: { ...process.env, FIRSTCH_ENABLE_APPS: '' } });
  const plainNames = await new Promise((resolve, reject) => {
    let out = '';
    const timer = setTimeout(() => reject(new Error('timeout waiting for default tools/list')), 15000);
    plain.stdout.on('data', (chunk) => {
      out += chunk.toString('utf8');
      for (const line of out.split('\n')) {
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id === 2) { clearTimeout(timer); resolve((msg.result?.tools || []).map((t) => t.name)); }
      }
    });
    plain.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'e2e-default', version: '0.0.0' } } }) + '\n');
    plain.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    plain.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
  });
  plain.kill();
  assert.ok(plainNames.length > 30, `default tools/list returned too few tools: ${plainNames.length}`);
  assert.equal(plainNames.filter((n) => n.startsWith('app_')).length, 0, 'app_* tools must be opt-in (FIRSTCH_ENABLE_APPS=1)');

  console.log('e2e ok:', names.join(', '));
  fakeApps.close();
  child.kill();
  process.exit(0);
} catch (err) {
  console.error('e2e failed:', err.message || err);
  child.kill();
  process.exit(1);
}
