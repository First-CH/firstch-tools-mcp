#!/usr/bin/env node
// stdio E2E smoke test: spawns server.mjs as a child process and speaks minimal
// JSON-RPC over stdin/stdout, asserting `initialize` succeeds, `tools/list`
// returns all 9 registered tools, and `tools/call` actually executes handlers
// (contrast_check / count_chars / marp_render / testdata_generate / diff_check) and returns the expected values — this catches
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
    'contrast_check',
    'count_chars',
    'diff_check',
    'encoding_convert',
    'jsonld_generate',
    'llmstxt_generate',
    'marp_render',
    'testdata_generate',
    'webp_convert',
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

  console.log('e2e ok:', names.join(', '));
  child.kill();
  process.exit(0);
} catch (err) {
  console.error('e2e failed:', err.message || err);
  child.kill();
  process.exit(1);
}
