#!/usr/bin/env node
// stdio E2E smoke test: spawns server.mjs as a child process and speaks minimal
// JSON-RPC over stdin/stdout, asserting `initialize` succeeds, `tools/list`
// returns all 18 registered tools, and `tools/call` actually executes handlers
// (contrast_check / count_chars / marp_render / testdata_generate / diff_check / cron_explain /
// base64_encode / url_params / html_escape / json_to_yaml / yaml_to_json / px_rem_convert /
// color_convert / hash_generate) and returns the expected values — this catches
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
    'llmstxt_generate',
    'marp_render',
    'px_rem_convert',
    'testdata_generate',
    'url_params',
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

  console.log('e2e ok:', names.join(', '));
  child.kill();
  process.exit(0);
} catch (err) {
  console.error('e2e failed:', err.message || err);
  child.kill();
  process.exit(1);
}
