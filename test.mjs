// lib.mjs の簡易テスト（既知の参照値と突合）
import assert from 'node:assert/strict';
import { contrastCheck, countChars } from './lib.mjs';

// 黒×白 = 21:1（WCAG既知値）
const bw = contrastCheck('#000000', '#ffffff');
assert.equal(bw.ratio, 21);
assert.equal(bw.aaa_normal_text, true);

// #999×白 ≈ 2.85:1 → AA不合格
const gray = contrastCheck('999', 'fff');
assert.equal(gray.ratio, 2.85);
assert.equal(gray.aa_normal_text, false);
assert.equal(gray.ui_components, false);

// 不正入力はthrow
assert.throws(() => contrastCheck('zzz', '#fff'));

// 全角10字 → ウェイト20
const zen = countChars('あいうえおかきくけこ');
assert.equal(zen.total, 10);
assert.equal(zen.zenkaku, 10);
assert.equal(zen.x_weight, 20);

// 半角5字+空白+URL → 5+1+23 = 29
const url = countChars('abcde https://example.com/very/long/path?q=1');
assert.equal(url.x_weight, 29);
assert.equal(url.x_postable, true);

// 全角141字 → 282 超過
const over = countChars('あ'.repeat(141));
assert.equal(over.x_weight, 282);
assert.equal(over.x_postable, false);

// llmstxt_generate: サイトのフォーム出力（site/llms-txt/app.js）と同一形式
{
  const { buildLlmsTxt } = await import('./lib.mjs');
  const text = buildLlmsTxt({
    siteName: 'First CH Tools',
    summary: 'Web制作会社が公開する無料ブラウザツール集。\nすべての処理はブラウザ内で完結する。',
    notes: 'AIエージェントからの利用を歓迎する。',
    sections: [
      { title: '主要ページ', links: [{ title: 'WebP変換', url: 'https://tools.first-ch.com/webp/', note: '画像一括変換' }] },
      { title: 'Optional', links: [] }, // リンクなしセクションは出力されない
    ],
  });
  assert.equal(
    text,
    '# First CH Tools\n\n> Web制作会社が公開する無料ブラウザツール集。\n> すべての処理はブラウザ内で完結する。\n\nAIエージェントからの利用を歓迎する。\n\n## 主要ページ\n\n- [WebP変換](https://tools.first-ch.com/webp/): 画像一括変換\n',
  );
  assert.throws(() => buildLlmsTxt({ siteName: '' }));
}

// jsonld_generate: サイトのフォーム出力（site/jsonld/app.js）と同一形式・空項目は省略
{
  const { buildJsonLd } = await import('./lib.mjs');
  const org = buildJsonLd('organization', { name: 'First CH合同会社', url: 'https://first-ch.com', logo: '', sameAs: ['https://x.com/firstch', ''] });
  assert.deepEqual(org.json, {
    '@context': 'https://schema.org', '@type': 'Organization',
    name: 'First CH合同会社', url: 'https://first-ch.com', sameAs: ['https://x.com/firstch'],
  });
  assert.ok(org.snippet.startsWith('<script type="application/ld+json">'));

  const faq = buildJsonLd('faqpage', { faq: [{ q: '制作期間は？', a: '約4週間です。' }, { q: '', a: 'x' }] });
  assert.equal(faq.json.mainEntity.length, 1);
  assert.equal(faq.json.mainEntity[0].acceptedAnswer.text, '約4週間です。');

  const crumb = buildJsonLd('breadcrumb', { items: [{ name: 'Home', url: 'https://a.com/' }, { name: '現在ページ' }] });
  assert.equal(crumb.json.itemListElement[1].position, 2);
  assert.equal(crumb.json.itemListElement[1].item, undefined);

  const sv = buildJsonLd('service', { name: 'HP制作', providerName: 'First CH合同会社' });
  assert.equal(sv.json.provider.name, 'First CH合同会社');
  assert.throws(() => buildJsonLd('article', {}));
}

// webp_convert: PNG→WebP変換（RIFF/WEBPヘッダ・出力サイズ・拡張子既定）
{
  const { PNG } = await import('pngjs');
  const { writeFile, readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { convertToWebp } = await import('./webp.mjs');

  const src = join(tmpdir(), 'firstch-mcp-test.png');
  const png = new PNG({ width: 32, height: 32 });
  png.data.fill(200);
  await writeFile(src, PNG.sync.write(png));

  const r = await convertToWebp(src, { quality: 80 });
  assert.equal(r.output, join(tmpdir(), 'firstch-mcp-test.webp'));
  assert.equal(r.width, 32);
  const out = await readFile(r.output);
  assert.equal(out.slice(0, 4).toString(), 'RIFF');
  assert.equal(out.slice(8, 12).toString(), 'WEBP');
  assert.ok(out.length > 0 && out.length === r.bytesOut);
  await rm(src); await rm(r.output);

  // 非対応形式はエラー
  const bad = join(tmpdir(), 'firstch-mcp-test.gif');
  await writeFile(bad, Buffer.from('GIF89a'));
  await assert.rejects(() => convertToWebp(bad));
  await rm(bad);
}

console.log('all tests passed');
