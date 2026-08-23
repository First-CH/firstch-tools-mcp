#!/usr/bin/env node
// stdio E2E smoke test: spawns server.mjs as a child process and speaks minimal
// JSON-RPC over stdin/stdout, asserting `initialize` succeeds, `tools/list`
// returns all 26 registered tools, and `tools/call` actually executes handlers
// (contrast_check / count_chars / marp_render / testdata_generate / diff_check / cron_explain /
// base64_encode / url_params / html_escape / json_to_yaml / yaml_to_json / px_rem_convert /
// color_convert / hash_generate / jwt_decode / user_agent_parse / uuid_generate / aspect_ratio_calc / markdown_table / sql_format / qr_generate / unixtime_convert) and returns the expected values — this catches
// regressions where a handler throws but the tool is still listed correctly.
// Exits non-zero on any failure.
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const child = spawn(process.execPath, [join(here, 'server.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] });

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
    const timer = setTimeout(() => reject(new Error(`timeout waiting for ${method}`)), 15000);
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
    'color_convert',
    'contrast_check',
    'count_chars',
    'cron_explain',
    'diff_check',
    'encoding_convert',
    'hash_generate',
    'html_escape',
    'json_to_yaml',
    'jsonld_generate',
    'jwt_decode',
    'llmstxt_generate',
    'markdown_table',
    'marp_render',
    'px_rem_convert',
    'qr_generate',
    'sql_format',
    'testdata_generate',
    'unixtime_convert',
    'url_params',
    'user_agent_parse',
    'uuid_generate',
    'webp_convert',
    'yaml_to_json',
  ];
  assert.deepEqual(names, expected, `unexpected tool list: ${JSON.stringify(names)}`);

  // tools/call: actually invoke a couple of handlers so a change that makes every
  // handler throw (while leaving tools/list untouched) fails this smoke test too.
  const callTool = async (name, args, id) => {
    const res = await request('tools/call', { name, arguments: args }, id);
    assert.ok(!res.result?.isError, `${name} call errored: ${JSON.stringify(res)}`);
    const text = res.result?.content?.[0]?.text;
    assert.ok(text, `${name} returned no text content: ${JSON.stringify(res)}`);
    return JSON.parse(text);
  };

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

  console.log('e2e ok:', names.join(', '));
  child.kill();
  process.exit(0);
} catch (err) {
  console.error('e2e failed:', err.message || err);
  child.kill();
  process.exit(1);
}
