// lib.mjs の簡易テスト（既知の参照値と突合）
import assert from 'node:assert/strict';
import { contrastCheck, countChars, analyzeEncoding, convertEncoding, detectNewline, convertNewline } from './lib.mjs';
import { diffCheck, diffSeq, buildDiff, toUnified, splitLines } from './diff.mjs';
import { cronExplain, parseCron, nextFires, describe as cronDescribe, CronError } from './cron.mjs';
import {
  base64Convert, bytesToBase64, base64ToBytes, formatBase64, parseDataUri,
  svgPercentDataUri, sniffType, percentDecode, Base64Error,
} from './base64.mjs';

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

// ---- 文字コード・改行コード（encoding_convert） ----
{
  const enc = new TextEncoder();

  // 改行コードの判定（CRLFはCR+LFで1件）
  const nl = detectNewline('a\r\nb\r\nc\n');
  assert.equal(nl.crlf, 2);
  assert.equal(nl.lf, 1);
  assert.equal(nl.mixed, true);
  assert.equal(nl.dominant, 'CRLF');

  // 相互変換して元に戻ること
  assert.equal(convertNewline('a\r\nb', 'LF'), 'a\nb');
  assert.equal(convertNewline('a\nb', 'CRLF'), 'a\r\nb');
  assert.equal(convertNewline(convertNewline('a\r\nb', 'LF'), 'CRLF'), 'a\r\nb');

  // UTF-8 BOM の検出とBOM除去後の本文
  const bom = Uint8Array.from([0xef, 0xbb, 0xbf, ...enc.encode('x\ny')]);
  const a1 = analyzeEncoding(bom);
  assert.equal(a1.bom, 'utf-8');
  assert.equal(a1.has_bom, true);
  assert.equal(a1.text, 'x\ny');

  // Shift_JIS を自動判定できる（UTF-8として不正なバイト列）
  const sjis = Uint8Array.from(Buffer.from('氏名', 'utf-8').length ? [0x8e, 0x81, 0x96, 0xbc] : []);
  const a2 = analyzeEncoding(sjis);
  assert.equal(a2.encoding, 'shift_jis');
  assert.equal(a2.encoding_detected, true);
  assert.equal(a2.text, '氏名');

  // 変換: Shift_JIS+CRLF → UTF-8(BOM付き)+LF
  const r = convertEncoding(sjis, { newline: 'LF', bom: true });
  assert.equal(r.from.encoding, 'shift_jis');
  assert.equal(r.to.encoding, 'utf-8');
  assert.equal(r.to.has_bom, true);
  const out = Buffer.from(r.base64, 'base64');
  assert.deepEqual([...out.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(out.slice(3).toString('utf-8'), '氏名');

  // 明示指定が自動判定より優先される
  const a3 = analyzeEncoding(enc.encode('abc'), 'utf-8');
  assert.equal(a3.encoding_detected, false);
}

// ---- Marp レンダリング（marp_render） ----
{
  const { renderMarp, findChrome } = await import('./marp.mjs');
  const { readFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');

  const md = `# タイトル\n\n本文\n\n---\n\n## 2枚目\n- 箇条書き\n`;
  const base = join(tmpdir(), `firstch-marp-test-${process.pid}`);

  // HTML: 自己完結ファイル・スライド数・既定テーマ firstch が効いていること
  const r = await renderMarp(md, { outputPath: base, formats: ['html'] });
  assert.equal(r.theme, 'firstch');
  assert.equal(r.slides, 2);
  assert.equal(r.outputs.html, `${base}.html`);
  const html = await readFile(r.outputs.html, 'utf8');
  assert.ok(html.includes('<!DOCTYPE html>'));
  assert.equal((html.match(/<section id=/g) || []).length, 2);
  assert.ok(html.includes('#faf8f4'), 'firstch テーマの紙色がインラインされている');
  assert.ok(html.includes('@page'), '印刷用CSS(@page)がある');
  await rm(r.outputs.html, { force: true });

  // md 内の theme 指示が既定より優先される
  const g = await renderMarp(`<!-- theme: gaia -->\n# G`, { outputPath: base, formats: ['html'] });
  const ghtml = await readFile(g.outputs.html, 'utf8');
  assert.ok(!ghtml.includes('#faf8f4'), 'gaia 指示で firstch は適用されない');
  await rm(g.outputs.html, { force: true });

  // 空入力・未対応テーマ・未対応formatはthrow
  await assert.rejects(() => renderMarp(''));
  await assert.rejects(() => renderMarp('# x', { theme: 'zzz' }));
  await assert.rejects(() => renderMarp('# x', { formats: ['docx'] }));

  // PDF: Chrome があれば実際に生成して2ページ、無ければ pdf_skipped を返す
  const chrome = findChrome();
  const p = await renderMarp(md, { outputPath: base, formats: ['html', 'pdf'] });
  if (chrome) {
    assert.equal(p.outputs.pdf, `${base}.pdf`);
    const pdf = await readFile(p.outputs.pdf);
    assert.equal(pdf.slice(0, 5).toString(), '%PDF-', 'PDFシグネチャ');
    const count = (pdf.toString('latin1').match(/\/Type\s*\/Pages[^s].*?\/Count\s+(\d+)/s) || [])[1];
    assert.equal(count, '2', `PDFは2ページ（実際: ${count}）`);
    await rm(p.outputs.pdf, { force: true });
  } else {
    assert.ok(p.pdf_skipped, 'Chrome 未検出時は pdf_skipped を返す');
  }
  await rm(p.outputs.html, { force: true });
}

// ---- テストデータ生成（testdata_generate） ----
{
  const { generateTestData, generateRecords, serialize, encodeText, sjisEncode, FIELDS } = await import('./testdata.mjs');

  // seed が同じなら常に同じデータ（site側 /testdata/?seed=... と同一の出力になることが前提）
  const a = generateTestData({ rows: 5, seed: 'test-2026' });
  const b = generateTestData({ rows: 5, seed: 'test-2026' });
  assert.equal(a.text, b.text);
  assert.notEqual(generateTestData({ rows: 5, seed: 'other' }).text, a.text);
  assert.equal(a.seed, 'test-2026');

  // 既定は CSV・ヘッダー行あり・LF・UTF-8
  const lines = a.text.trimEnd().split('\n');
  assert.equal(lines.length, 6, 'ヘッダー1行 + 5行');
  assert.equal(lines[0], 'id,name,name_kana,email,tel,zip,address');
  assert.equal(a.encoding, 'utf-8');
  assert.equal(a.has_bom, false);
  assert.equal(a.base64, undefined, 'UTF-8(BOMなし)では base64 を返さない');

  // 列指定・ヘッダーなし・TSV
  const t = generateTestData({ rows: 2, fields: ['name', 'email'], format: 'tsv', header: false, seed: 'x' });
  assert.equal(t.text.trimEnd().split('\n').length, 2);
  assert.equal(t.text.split('\n')[0].split('\t').length, 2);

  // JSON は指定した列だけを持つ配列になる
  const j = JSON.parse(generateTestData({ rows: 3, fields: ['id', 'email'], format: 'json', seed: 'x' }).text);
  assert.equal(j.length, 3);
  assert.deepEqual(Object.keys(j[0]), ['id', 'email']);
  assert.match(j[0].email, /@example\.(com|net|org)$/, 'メールは RFC 2606 の予約ドメイン');

  // 生成される値の形式（日本語ロケール）
  const rec = generateRecords({ rows: 50, seed: 'shape', locale: 'ja' }).records;
  for (const r of rec) {
    assert.match(r.zip, /^\d{3}-\d{4}$/);
    assert.match(r.tel, /^0\d{1,3}-\d{3,4}-\d{4}$/);
    assert.match(r.birthday, /^(19[6-9]\d|200[0-5])-\d{2}-\d{2}$/);
    assert.match(r.name, /^\S+ \S+$/);
  }
  // 英語ロケールは架空番号用に予約された 555-01xx を使い、かなフィールドは空になる
  const en = generateRecords({ rows: 20, seed: 'shape', locale: 'en' }).records;
  for (const r of en) {
    assert.match(r.tel, /^\(\d{3}\) 555-01\d{2}$/);
    assert.equal(r.name_kana, '');
  }

  // RFC 4180: カンマ・引用符・改行を含む値はクォートされ、引用符は2重になる
  const csv = serialize(
    [{ text: 'a,b' }, { text: 'say "hi"' }, { text: 'line1\nline2' }],
    ['text'],
    { format: 'csv', newline: 'CRLF', header: true },
  );
  assert.equal(csv, 'text\r\n"a,b"\r\n"say ""hi"""\r\n"line1\r\nline2"\r\n');

  // Shift_JIS 書き出し（site側と同一バイト列になること＝2箇所ルールの実質検証）
  const s = generateTestData({ rows: 3, seed: 'sjis-test', encoding: 'shift_jis', newline: 'CRLF' });
  assert.equal(s.encoding, 'shift_jis');
  assert.equal(s.has_bom, false, 'Shift_JIS に BOM は無い');
  assert.equal(s.unencodable, 0);
  const sbytes = Buffer.from(s.base64, 'base64');
  assert.equal(sbytes.length, s.bytes);
  assert.equal(new TextDecoder('shift_jis').decode(sbytes), s.text, 'Shift_JISとして復号すると元のテキストに戻る');
  // CP932 の別名（波ダッシュ U+301C → 0x8160）も表現できる
  assert.deepEqual([...sjisEncode('〜').bytes], [0x81, 0x60]);
  assert.equal(sjisEncode('〜').unencodable, 0);
  // 表現できない文字は '?' に置換して件数を返す
  const emoji = sjisEncode('あ😀い');
  assert.equal(emoji.unencodable, 1);
  assert.deepEqual([...emoji.bytes.slice(2, 3)], [0x3f]);

  // UTF-8 BOM
  const bom = encodeText('abc', { encoding: 'utf-8', bom: true });
  assert.deepEqual([...bom.bytes.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  assert.equal(generateTestData({ rows: 1, bom: true, seed: 'x' }).has_bom, true);
  assert.equal(generateTestData({ rows: 1, bom: true, encoding: 'shift_jis', seed: 'x' }).has_bom, false);

  // mode=text: n-1 / n / n+1 ちょうどの文字列（コードポイント単位）
  const txt = generateTestData({ mode: 'text', preset: 'emoji', length: 5 });
  assert.deepEqual(txt.variants.map((v) => v.length), [4, 5, 6]);
  assert.deepEqual(txt.variants.map((v) => v.code_points), [4, 5, 6]);
  assert.deepEqual(txt.variants.map((v) => v.utf16), [8, 10, 12], '絵文字はサロゲートペアでUTF-16長が倍');
  assert.equal(txt.variants[1].utf8_bytes, 20);
  const zen = generateTestData({ mode: 'text', preset: 'mixed', length: 10 });
  assert.equal([...zen.variants[1].text].length, 10);
  assert.equal(zen.variants[1].utf8_bytes, 30);
  // 前後空白プリセットは先頭が半角スペース・末尾が全角スペース
  const sp = generateTestData({ mode: 'text', preset: 'space', length: 8 }).variants[1].text;
  assert.equal(sp.at(0), ' ');
  assert.equal(sp.at(-1), '　');

  // 不正な入力は throw
  assert.throws(() => generateTestData({ format: 'xls' }));
  assert.throws(() => generateTestData({ encoding: 'euc-jp' }));
  assert.throws(() => generateTestData({ fields: ['password'] }));
  assert.throws(() => generateTestData({ mode: 'text', preset: 'klingon' }));
  // 行数は上限1000に丸められる
  assert.equal(generateTestData({ rows: 99999, fields: ['id'], seed: 'x' }).rows, 1000);
  assert.equal(FIELDS.length, 14);
}


// ---- .xlsx 書き出し（testdata_generate format=xlsx） ----
{
  const { generateTestData, buildXlsx, generateRecords, FIELDS } = await import('./testdata.mjs');
  // node:zlib の crc32 は Node 20.15 / 22.2 以降にしか無い。engines の下限は 18.14.1 なので、
  // 無い環境ではCRCの照合だけ飛ばす（ZIP構造・中身の検査は下で従来どおり行う）。
  // 自前の crc32 を借りて突き合わせても、同じ実装どうしの比較になり検査の意味が無いため代替にしない。
  const { crc32 } = await import('node:zlib');
  const canVerifyCrc = typeof crc32 === 'function';

  /** 無圧縮ZIPを読み、CRCを検証しつつ { 名前: 中身 } を返す（自前ライターの逆操作） */
  const unzip = (buf) => {
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let eocd = buf.length - 22;
    while (eocd >= 0 && dv.getUint32(eocd, true) !== 0x06054b50) eocd -= 1;
    assert.ok(eocd >= 0, 'EOCDが見つからない');
    const count = dv.getUint16(eocd + 10, true);
    const dirSize = dv.getUint32(eocd + 12, true);
    const dirOff = dv.getUint32(eocd + 16, true);
    assert.equal(dirOff + dirSize + 22, buf.length, 'EOCDのサイズ/オフセットが実体と一致する');
    const out = {};
    let p = dirOff;
    for (let i = 0; i < count; i++) {
      assert.equal(dv.getUint32(p, true), 0x02014b50, '中央ディレクトリのシグネチャ');
      const crc = dv.getUint32(p + 16, true);
      const size = dv.getUint32(p + 24, true);
      const nameLen = dv.getUint16(p + 28, true);
      const local = dv.getUint32(p + 42, true);
      const name = new TextDecoder().decode(buf.subarray(p + 46, p + 46 + nameLen));
      assert.equal(dv.getUint32(local, true), 0x04034b50, 'ローカルヘッダのシグネチャ');
      assert.equal(dv.getUint16(local + 8, true), 0, '無圧縮(store)で格納されている');
      const start = local + 30 + dv.getUint16(local + 26, true) + dv.getUint16(local + 28, true);
      const body = buf.subarray(start, start + size);
      if (canVerifyCrc) assert.equal(crc32(body), crc, `CRC不一致: ${name}`);
      out[name] = new TextDecoder().decode(body);
      p += 46 + nameLen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    }
    return out;
  };

  const x = generateTestData({ rows: 5, seed: 'test-2026', format: 'xlsx' });
  assert.equal(x.format, 'xlsx');
  assert.equal(x.encoding, 'utf-8');
  assert.equal(x.has_bom, false);
  assert.ok(x.base64, 'xlsx は base64 でファイル本体を返す');
  const bytes = Buffer.from(x.base64, 'base64');
  assert.equal(bytes.length, x.bytes);
  assert.deepEqual([...bytes.subarray(0, 4)], [0x50, 0x4b, 0x03, 0x04], 'ZIPのシグネチャ PK');
  assert.ok(x.text.includes('\t'), 'text はタブ区切りのプレビュー');

  const parts = unzip(new Uint8Array(bytes));
  assert.deepEqual(Object.keys(parts).sort(), [
    '[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels',
    'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml',
  ]);
  const sheet = parts['xl/worksheets/sheet1.xml'];
  assert.match(sheet, /<sheetData>/);
  assert.match(sheet, /state="frozen"/, 'ヘッダー行があるときは先頭行を固定する');
  assert.match(sheet, /<dimension ref="A1:G6"\/>/, '既定7列 + ヘッダー1行 + 5行');
  assert.match(sheet, /<c r="A2"><v>1<\/v><\/c>/, '連番は数値セル');
  assert.match(sheet, /<c r="F2" t="inlineStr"><is><t xml:space="preserve">\d{3}-\d{4}<\/t>/, '郵便番号は文字列セル（先頭ゼロが消えない）');
  assert.match(parts['xl/workbook.xml'], /name="testdata"/);

  // 同じ seed なら .xlsx もバイト単位で同一（タイムスタンプ固定）
  assert.ok(Buffer.from(generateTestData({ rows: 5, seed: 'test-2026', format: 'xlsx' }).base64, 'base64').equals(bytes));

  // header:false ではヘッダー行も固定枠も無い
  const noHdr = unzip(buildXlsx(generateRecords({ rows: 3, seed: 'h' }).records, ['id', 'name'], { header: false }));
  const noHdrSheet = noHdr['xl/worksheets/sheet1.xml'];
  assert.doesNotMatch(noHdrSheet, /state="frozen"/);
  assert.doesNotMatch(noHdrSheet, /<t xml:space="preserve">name<\/t>/);
  assert.match(noHdrSheet, /<dimension ref="A1:B3"\/>/);

  // XMLエスケープと、XML 1.0 に置けない制御文字の除去
  const esc = unzip(buildXlsx(
    [{ id: '1', name: 'a&b<c>d"e', text: 'x\u0001y\u0002z' }],
    ['id', 'name', 'text'],
    { header: false },
  ))['xl/worksheets/sheet1.xml'];
  assert.match(esc, /<t xml:space="preserve">a&amp;b&lt;c&gt;d"e<\/t>/);
  assert.match(esc, /<t xml:space="preserve">xyz<\/t>/, '制御文字は落とす（残るとExcelが破損扱いする）');

  // 空文字の列はセルごと省略される（en ロケールのフリガナなど）
  const sparse = unzip(buildXlsx([{ id: '1', name: 'A', name_kana: '' }], ['id', 'name', 'name_kana'], { header: false }))['xl/worksheets/sheet1.xml'];
  assert.doesNotMatch(sparse, /r="C1"/);

  // xlsx では encoding / newline / bom の指定が無視される
  const ignored = generateTestData({ rows: 2, seed: 'q', format: 'xlsx', encoding: 'shift_jis', newline: 'CRLF', bom: true });
  assert.equal(ignored.encoding, 'utf-8');
  assert.equal(ignored.newline, 'LF');
  assert.equal(ignored.has_bom, false);
  assert.equal(ignored.unencodable, 0);
  assert.ok(ignored.note.includes('xlsx'));

  // 1000行 × 全14列でも壊れない
  const big = generateTestData({ rows: 1000, seed: 'big', format: 'xlsx', fields: FIELDS });
  const bigSheet = unzip(new Uint8Array(Buffer.from(big.base64, 'base64')))['xl/worksheets/sheet1.xml'];
  assert.match(bigSheet, /<dimension ref="A1:N1001"\/>/);
}

// ---- テキスト差分（diff_check） ----
{
  // 1行だけ書き換え
  const one = diffCheck('a\nb\nc\n', 'a\nB\nc\n', { format: 'both' });
  assert.equal(one.identical, false);
  assert.deepEqual(
    [one.added, one.removed, one.changed, one.unchanged],
    [0, 0, 1, 2],
    '1行書き換えは changed=1',
  );
  assert.equal(one.unified, '--- a\n+++ b\n@@ -1,3 +1,3 @@\n a\n-b\n+B\n c\n');
  assert.equal(one.changes.length, 1);
  assert.deepEqual(one.changes[0].removed.map((r) => r.line), [2]);
  assert.deepEqual(one.changes[0].added.map((r) => r.line), [2]);

  // 同一なら unified も changes も付けない（差分が無いことを identical で示す）
  const same = diffCheck('x\ny\n', 'x\ny\n', { format: 'both' });
  assert.equal(same.identical, true);
  assert.equal(same.unified, undefined);
  assert.equal(same.changes, undefined);
  assert.equal(same.unchanged, 2);

  // 改行コードが違うだけなら同一扱い（CRLF / CR / LF は同じ行区切り）
  assert.equal(diffCheck('a\r\nb\r\n', 'a\nb\n').identical, true);
  assert.equal(diffCheck('a\rb\r', 'a\nb\n').identical, true);

  // 行末の空白だけの差は既定で無視。行中の空白は ignoreWhitespace が必要
  assert.equal(diffCheck('a  \nb\n', 'a\nb\n').identical, true);
  assert.equal(diffCheck('a  b\n', 'a b\n').identical, false);
  assert.equal(diffCheck('a  b\n', 'a b\n', { ignoreWhitespace: true }).identical, true);
  assert.equal(diffCheck('Abc\n', 'abc\n').identical, false);
  assert.equal(diffCheck('Abc\n', 'abc\n', { ignoreCase: true }).identical, true);

  // 純粋な追加・削除は changed ではなく added / removed に出る
  const addOnly = diffCheck('a\nb\n', 'a\nx\ny\nb\n');
  assert.deepEqual([addOnly.added, addOnly.removed, addOnly.changed], [2, 0, 0]);
  const delOnly = diffCheck('a\nx\ny\nb\n', 'a\nb\n');
  assert.deepEqual([delOnly.added, delOnly.removed, delOnly.changed], [0, 2, 0]);

  // 空文字は0行。片側が空なら全行が追加/削除
  assert.deepEqual(splitLines(''), []);
  assert.deepEqual(splitLines('a\n'), ['a']);
  assert.deepEqual(splitLines('a\n\n'), ['a', '']);
  const fromEmpty = diffCheck('', 'a\nb\n');
  assert.deepEqual([fromEmpty.added, fromEmpty.removed, fromEmpty.changed], [2, 0, 0]);
  assert.equal(diffCheck('', '').identical, true);

  // 語単位: 変更ペアは changed_parts に「変わった語」だけが入る（隣接は連結される）
  const words = diffCheck('const greet = (name) => {\n', 'const greet = (name, lang = "ja") => {\n', { format: 'blocks' });
  assert.deepEqual(words.changes[0].added[0].changed_parts, [', lang = "ja"']);
  assert.deepEqual(words.changes[0].removed[0].changed_parts, []);
  // 和文は1文字ずつ比べる（分かち書きが無いため）
  const ja = diffCheck('これはテストです\n', 'これは試験です\n', { format: 'blocks' });
  assert.deepEqual(ja.changes[0].removed[0].changed_parts, ['テスト']);
  assert.deepEqual(ja.changes[0].added[0].changed_parts, ['試験']);
  // 共通部分が3割未満のペアは「別の行」とみなして語ハイライトしない
  const unrelated = diffCheck('aaaaaaaaaaaa\n', 'bbbbbbbbbbbb\n', { format: 'blocks' });
  assert.equal(unrelated.changes[0].removed[0].changed_parts, undefined);

  // words:false なら語単位の比較をしない
  const noWords = diffCheck('これはテストです\n', 'これは試験です\n', { format: 'blocks', words: false });
  assert.equal(noWords.changes[0].removed[0].changed_parts, undefined);

  // コンテキスト行数と、離れた変更が別ハンクになること
  const lines = (n, f = (i) => `line ${i}`) => Array.from({ length: n }, (_, i) => f(i + 1)).join('\n') + '\n';
  const far = toUnified(lines(40), lines(40, (i) => (i === 5 || i === 35 ? `line ${i} X` : `line ${i}`)), {}, 'a', 'b', 3);
  assert.equal((far.match(/^@@ /gm) || []).length, 2, '離れた変更は2ハンクに分かれる');
  assert.match(far, /^@@ -2,7 \+2,7 @@$/m);
  const ctx0 = toUnified('a\nb\nc\n', 'a\nB\nc\n', {}, 'a', 'b', 0);
  assert.equal(ctx0, '--- a\n+++ b\n@@ -2,1 +2,1 @@\n-b\n+B\n');

  // ファイル名はヘッダーに反映される
  assert.match(diffCheck('a\n', 'b\n', { nameA: 'old.css', nameB: 'new.css' }).unified, /^--- old\.css\n\+\+\+ new\.css$/m);

  // 差分の走査順の不変条件（a側・b側それぞれの添字を昇順にちょうど1回ずつ通る）
  const A = ['x', 'y', 'z', 'y', 'q'];
  const B = ['y', 'z', 'q', 'q', 'w'];
  const ops = diffSeq(A, B);
  assert.deepEqual(ops.filter((o) => o.a >= 0).map((o) => o.a), [0, 1, 2, 3, 4]);
  assert.deepEqual(ops.filter((o) => o.b >= 0).map((o) => o.b), [0, 1, 2, 3, 4]);
  for (const o of ops) if (o.t === '=') assert.equal(A[o.a], B[o.b]);

  // 大きな入力でも現実的な時間で終わる（patience diff のアンカーが効いていること）
  const big = lines(20000);
  const bigB = lines(20000, (i) => (i % 500 === 0 ? `line ${i} changed` : `line ${i}`));
  const t0 = Date.now();
  const bigDiff = diffCheck(big, bigB);
  assert.equal(bigDiff.changed, 40);
  assert.equal(bigDiff.unchanged, 19960);
  assert.ok(Date.now() - t0 < 10000, `20000行の差分が遅すぎる: ${Date.now() - t0}ms`);

  // まったく無関係な大きい入力でも、上限で打ち切って必ず返る
  const noise = (tag) => Array.from({ length: 3000 }, (_, i) => `${tag}-${i}`).join('\n') + '\n';
  const wild = diffCheck(noise('p'), noise('q'));
  assert.equal(wild.identical, false);
  assert.equal(wild.unchanged, 0);
  assert.equal(wild.lines_a, 3000);

  // blocks では変更のあったブロックだけを返す
  const blocks = buildDiff('a\nb\nc\nd\n', 'a\nB\nc\nD\n', {});
  assert.equal(blocks.blocks.filter((x) => x.t === 'change').length, 2);
}

// ---- cron.mjs（cron_explain）----
{
  const FROM = '2026-08-08T12:03:20+09:00'; // 土曜
  const TZ = 'Asia/Tokyo';
  const at = (expr, count = 3, tz = TZ) => cronExplain(expr, { timeZone: tz, count, from: FROM }).next.map((n) => n.local);

  // 基本の展開と次回発火
  assert.deepEqual(at('*/15 * * * *'), ['2026-08-08 12:15:00', '2026-08-08 12:30:00', '2026-08-08 12:45:00']);
  assert.deepEqual(at('* * * * *'), ['2026-08-08 12:04:00', '2026-08-08 12:05:00', '2026-08-08 12:06:00']);
  assert.deepEqual(at('0 9 * * *'), ['2026-08-09 09:00:00', '2026-08-10 09:00:00', '2026-08-11 09:00:00']);
  // 平日9:30（2026-08-08は土曜なので次は10日の月曜）
  assert.deepEqual(at('30 9 * * 1-5'), ['2026-08-10 09:30:00', '2026-08-11 09:30:00', '2026-08-12 09:30:00']);
  // 列挙とVixieの `a/n`（5から10おき）
  assert.deepEqual(at('30 5 1,15 * *'), ['2026-08-15 05:30:00', '2026-09-01 05:30:00', '2026-09-15 05:30:00']);
  assert.deepEqual(parseCron('5/10 * * * *').fields.minute.values, [5, 15, 25, 35, 45, 55]);
  // 省略記法・名前指定
  assert.deepEqual(at('@weekly'), ['2026-08-09 00:00:00', '2026-08-16 00:00:00', '2026-08-23 00:00:00']);
  assert.deepEqual(parseCron('0 0 * JAN,JUL *').fields.month.values, [1, 7]);
  assert.deepEqual(parseCron('0 0 * * MON-FRI').fields.dow.values, [1, 2, 3, 4, 5]);
  // 曜日の 7 は 0（日曜）。0-7 / 1-7 は全曜日
  assert.deepEqual(parseCron('0 0 * * 7').fields.dow.values, [0]);
  assert.equal(parseCron('0 0 * * 0-7').fields.dow.all, true);
  assert.equal(parseCron('0 0 * * 1-7').fields.dow.all, true);
  // 月・曜日だけ折り返しを許す
  assert.deepEqual(parseCron('0 0 * NOV-FEB *').fields.month.values, [1, 2, 11, 12]);
  assert.deepEqual(parseCron('0 0 * * FRI-MON').fields.dow.values, [0, 1, 5, 6]);
  assert.throws(() => parseCron('10-5 * * * *'), CronError);

  // 「日」と「曜日」の両方指定は AND ではなく OR（Vixie cron の仕様）
  const or = cronExplain('0 0 1 * 1', { timeZone: TZ, count: 4, from: FROM });
  assert.deepEqual(or.next.map((n) => n.local), [
    '2026-08-10 00:00:00', // 月曜
    '2026-08-17 00:00:00',
    '2026-08-24 00:00:00',
    '2026-08-31 00:00:00',
  ]);
  assert.ok(or.warnings_ja.some((w) => w.includes('OR')));

  // 範囲を割り切らない */n は等間隔にならない旨を警告する
  const uneven = cronExplain('*/7 * * * *', { timeZone: TZ, from: FROM });
  assert.deepEqual(parseCron('*/7 * * * *').fields.minute.values, [0, 7, 14, 21, 28, 35, 42, 49, 56]);
  assert.ok(uneven.warnings_ja.some((w) => w.includes('*/7')));

  // 存在しない日付は発火しない／うるう日は4年ごと
  const never = cronExplain('0 0 30 2 *', { timeZone: TZ, from: FROM });
  assert.equal(never.never_fires, true);
  assert.equal(never.next.length, 0);
  assert.deepEqual(at('0 0 29 2 *', 2), ['2028-02-29 00:00:00', '2032-02-29 00:00:00']);

  // 秒付き6フィールドは先頭が秒
  const six = cronExplain('*/20 * * * * *', { timeZone: TZ, count: 3, from: FROM });
  assert.equal(six.has_seconds, true);
  assert.deepEqual(six.next.map((n) => n.local), ['2026-08-08 12:03:40', '2026-08-08 12:04:00', '2026-08-08 12:04:20']);

  // 夏時間: 存在しない現地時刻（2027-03-14 02:30 America/New_York）は一覧から落とす
  const spring = cronExplain('30 2 * * *', { timeZone: 'America/New_York', count: 4, from: '2027-03-12T00:00:00Z' });
  assert.deepEqual(spring.next.map((n) => n.iso), [
    '2027-03-12T02:30:00-05:00',
    '2027-03-13T02:30:00-05:00',
    '2027-03-15T02:30:00-04:00',
    '2027-03-16T02:30:00-04:00',
  ]);
  assert.ok(spring.warnings_ja.some((w) => w.includes('夏時間')));
  // 夏時間の戻り（重複する現地時刻）は1回だけ返す
  const fall = cronExplain('30 1 * * *', { timeZone: 'America/New_York', count: 3, from: '2027-11-06T00:00:00Z' });
  assert.deepEqual(fall.next.map((n) => n.iso), [
    '2027-11-06T01:30:00-04:00',
    '2027-11-07T01:30:00-04:00',
    '2027-11-08T01:30:00-05:00',
  ]);

  // タイムゾーンを変えると同じ式でも実時刻が変わる（FROM は UTC では 08-08 03:03 なので当日の9時が次）
  const utc = cronExplain('0 9 * * *', { timeZone: 'UTC', count: 1, from: FROM });
  assert.equal(utc.next[0].iso, '2026-08-08T09:00:00+00:00');
  assert.equal(cronExplain('0 9 * * *', { timeZone: TZ, count: 1, from: FROM }).next[0].iso, '2026-08-09T09:00:00+09:00');

  // 読み下し
  assert.equal(cronDescribe(parseCron('*/15 * * * *'), false), '毎日、15分ごと（毎時 0分・15分・30分・45分）に実行します。');
  assert.equal(cronDescribe(parseCron('30 9 * * 1-5'), true), 'Runs on Mon–Fri, at 09:30.');
  assert.equal(cronDescribe(parseCron('@yearly'), false), '1月1日、0時00分に実行します。');

  // 不正な入力
  for (const bad of ['', '* * * *', '* * * * * * *', '61 * * * *', 'abc * * * *', '* * * * 8', '*/0 * * * *', '@bogus', '@reboot', 'L * * * *', '* * * * 1#2']) {
    assert.throws(() => parseCron(bad), CronError, `should reject: ${JSON.stringify(bad)}`);
  }
  assert.throws(() => cronExplain('* * * * *', { timeZone: 'Nowhere/Nothing' }), /タイムゾーン/);

  // 発火しない式でも現実的な時間で必ず返る
  const t0 = Date.now();
  cronExplain('0 0 31 2 *', { timeZone: TZ, count: 5, from: FROM });
  assert.ok(Date.now() - t0 < 5000, `存在しない日付の探索が遅すぎる: ${Date.now() - t0}ms`);
}

/* ==================== base64.mjs（tools.first-ch.com/base64/ と同一ロジック） ==================== */
{
  const enc = (s) => new TextEncoder().encode(s);

  // RFC 4648 のテストベクタ
  assert.equal(bytesToBase64(enc('')), '');
  assert.equal(bytesToBase64(enc('f')), 'Zg==');
  assert.equal(bytesToBase64(enc('fo')), 'Zm8=');
  assert.equal(bytesToBase64(enc('foo')), 'Zm9v');
  assert.equal(bytesToBase64(enc('foob')), 'Zm9vYg==');
  assert.equal(bytesToBase64(enc('fooba')), 'Zm9vYmE=');
  assert.equal(bytesToBase64(enc('foobar')), 'Zm9vYmFy');

  // 日本語はUTF-8のバイト列を経由する
  assert.equal(bytesToBase64(enc('こんにちは')), Buffer.from('こんにちは', 'utf8').toString('base64'));

  // 全256バイトを往復しても壊れない（バイナリ安全）
  const all = new Uint8Array(256).map((_, i) => i);
  assert.deepEqual([...base64ToBytes(bytesToBase64(all))], [...all]);
  // String.fromCharCode.apply の分割境界（0x8000）をまたいでも壊れない
  const big = new Uint8Array(0x8000 * 2 + 7).map((_, i) => i % 251);
  assert.equal(bytesToBase64(big), Buffer.from(big).toString('base64'));

  // デコードは URLセーフ・パディング欠け・空白/改行混じりをすべて受け付ける
  const want = [...enc('foobar?~')];
  const std = Buffer.from('foobar?~').toString('base64');
  assert.deepEqual([...base64ToBytes(std)], want);
  assert.deepEqual([...base64ToBytes(std.replace(/=+$/, ''))], want);
  assert.deepEqual([...base64ToBytes(std.replace(/\+/g, '-').replace(/\//g, '_'))], want);
  assert.deepEqual([...base64ToBytes('Zm9v\n  YmFy\tP34=')], want);

  // 壊れた入力は理由の分かる例外にする
  assert.throws(() => base64ToBytes('!!!!'), /BAD_CHAR/);
  assert.throws(() => base64ToBytes('Zm9vYmFyP'), /BAD_LENGTH/); // 4n+1 は存在しない長さ

  // 整形: URLセーフ／76桁改行
  const long = bytesToBase64(enc('a'.repeat(100) + '???'));
  assert.ok(!formatBase64(long, { urlSafe: true }).includes('='));
  assert.ok(formatBase64(long, { urlSafe: true }).includes('_'));
  const wrapped = formatBase64(long, { wrap: 76 }).split('\n');
  assert.ok(wrapped.slice(0, -1).every((l) => l.length === 76));
  assert.equal(wrapped.join(''), long);

  // data URI の分解（base64版・パーセント版・非data URI）
  const du = parseDataUri('data:image/png;base64,Zm9vYmFy');
  assert.equal(du.mimeType, 'image/png');
  assert.equal(du.isBase64, true);
  assert.equal(Buffer.from(du.bytes).toString(), 'foobar');
  const pu = parseDataUri("data:image/svg+xml,%3Csvg%20a='1'/%3E");
  assert.equal(pu.isBase64, false);
  assert.equal(Buffer.from(pu.bytes).toString(), "<svg a='1'/>");
  assert.equal(parseDataUri('SGVsbG8='), null);
  // charset 付き。%XX はバイト単位で解くので非UTF-8のバイトでも壊れない
  assert.equal(parseDataUri('data:text/plain;charset=utf-8;base64,SGk=').charset, 'utf-8');
  assert.deepEqual([...percentDecode('%FF%00a')], [0xff, 0x00, 0x61]);

  // マジックナンバーからの種類判定
  assert.equal(sniffType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13])).mimeType, 'image/png');
  assert.equal(sniffType(enc('<svg xmlns="http://www.w3.org/2000/svg"/>')).mimeType, 'image/svg+xml');
  assert.equal(sniffType(enc('<?xml version="1.0"?><svg xmlns="x"/>')).mimeType, 'image/svg+xml');
  assert.equal(sniffType(enc('hello world!')).mimeType, 'text/plain');
  assert.equal(sniffType(new Uint8Array([0xff, 0xfe, 0x00, 0x01, 2, 3, 4, 5, 6, 7, 8, 9])).mimeType, 'application/octet-stream');

  // SVGのパーセントエンコード: HTML属性にもCSS url("…") にも貼れるよう危険な文字を必ず退避する
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><circle r="10" fill="#c8501f"/></svg>';
  const uri = svgPercentDataUri(svg);
  assert.ok(uri.startsWith('data:image/svg+xml,%3Csvg'));
  for (const ch of ['"', '<', '>', '&', '#', ' ', '\n']) {
    assert.ok(!uri.includes(ch), `percent-encoded SVG must not contain ${JSON.stringify(ch)}: ${uri}`);
  }
  // 中身は失われない（' は " の短縮置換なので元に戻して比較する）
  assert.equal(decodeURIComponent(uri.slice('data:image/svg+xml,'.length)).replace(/'/g, '"'), svg);
  // base64より短い（＝この置き換えに意味がある）
  assert.ok(uri.length < ('data:image/svg+xml;base64,' + bytesToBase64(enc(svg))).length);
  // ' を含むSVGは " を潰さない（属性値を壊さないため）
  assert.ok(svgPercentDataUri("<svg a=\"it's\"/>").includes('%22'));
  // <text> があるときはタグ間の空白を詰めない（語間の空白が描画に効くため）
  assert.ok(svgPercentDataUri('<svg><text>a</text> <text>b</text></svg>').includes('%3E%20%3C'));
  assert.ok(!svgPercentDataUri('<svg><rect/> <rect/></svg>').includes('%3E%20%3C'));

  // ---- base64Convert: encode ----
  const t = await base64Convert({ text: 'こんにちは' });
  assert.equal(t.base64, Buffer.from('こんにちは', 'utf8').toString('base64'));
  assert.equal(t.bytes, 15);
  assert.equal(t.growth, '+33%');
  assert.equal(t.data_uri, undefined); // dataUri 未指定のテキストには付けない

  const tu = await base64Convert({ text: 'こんにちは', dataUri: true });
  assert.equal(tu.data_uri, 'data:text/plain;charset=utf-8;base64,' + t.base64);

  // SVGソースをテキストで渡しても画像として扱い、短いパーセント版を既定にする
  const sv = await base64Convert({ text: svg, dataUri: true, snippets: true });
  assert.equal(sv.mime_type, 'image/svg+xml');
  assert.equal(sv.data_uri_encoding, 'percent');
  assert.equal(sv.data_uri, sv.data_uri_percent);
  assert.ok(sv.data_uri_percent.length < sv.data_uri_base64.length);
  assert.ok(sv.snippets.html.startsWith('<img src="data:image/svg+xml,'));
  assert.ok(sv.snippets.html.includes('width="24" height="24"'));   // width/height 属性から寸法を読む
  assert.ok(sv.snippets.css.includes('background-image: url("data:image/svg+xml,'));
  // width/height が無ければ viewBox から読む
  const vb = await base64Convert({ text: '<svg xmlns="x" viewBox="0 0 48 32"/>', dataUri: true, snippets: true });
  assert.ok(vb.snippets.html.includes('width="48" height="32"'));
  // どちらも読めないときは寸法属性を落とし、その旨を伝える
  const nodim = await base64Convert({ text: '<svg xmlns="x" width="100%"/>', dataUri: true, snippets: true });
  assert.ok(!/"\s+width="/.test(nodim.snippets.html), `寸法が読めない画像に width/height を付けてはいけない: ${nodim.snippets.html}`);
  assert.ok(!nodim.snippets.css.includes('  width:'));
  assert.ok(nodim.snippets_note);

  // URLセーフ・改行の指定
  const us = await base64Convert({ text: 'a'.repeat(100) + '???', urlSafe: true, wrap: 76 });
  assert.equal(us.url_safe, true);
  assert.equal(us.wrap, 76);
  assert.ok(!us.base64.includes('=') && us.base64.includes('_'));
  assert.ok(us.base64.split('\n').slice(0, -1).every((l) => l.length === 76));

  // ---- base64Convert: ファイル入出力 ----
  {
    const { mkdtemp, writeFile: wf, readFile: rf, rm } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'firstch-b64-'));
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVR4nGP8z8Dwn4GBgYEJRIAAFvIC/RRXCWsAAAAASUVORK5CYII=',
      'base64',
    );
    const src = join(dir, 'dot.png');
    await wf(src, png);

    // パスを渡すと data URI は常に返る。拡張子ではなく中身（マジックナンバー）で判定する
    const f = await base64Convert({ path: src, snippets: true });
    assert.equal(f.mime_type, 'image/png');
    assert.equal(f.bytes, png.length);
    assert.equal(f.source.name, 'dot.png');
    assert.equal(f.data_uri, 'data:image/png;base64,' + png.toString('base64'));
    assert.equal(f.data_uri_encoding, undefined); // PNGにパーセント版は無い
    assert.ok(f.snippets.html.startsWith('<img src="data:image/png;base64,'));

    // decode → 同じバイト列がファイルへ戻る
    const out = join(dir, 'out.png');
    const d = await base64Convert({ mode: 'decode', base64: f.data_uri, outputPath: out });
    assert.equal(d.mime_type, 'image/png');
    assert.equal(d.bytes, png.length);
    assert.equal(d.is_text, false);
    assert.equal(d.output, out);
    assert.equal(d.base64, undefined); // ファイルに書いたら base64 は返さない
    assert.deepEqual([...(await rf(out))], [...png]);

    await rm(dir, { recursive: true, force: true });
  }

  // ---- base64Convert: decode ----
  const dt = await base64Convert({ mode: 'decode', base64: 'data:text/plain;base64,44GT44KT44Gr44Gh44Gv' });
  assert.equal(dt.text, 'こんにちは');
  assert.equal(dt.is_text, true);
  assert.equal(dt.mime_type, 'text/plain');
  assert.equal(dt.suggested_extension, 'txt');
  // 素のBase64でも、パディングが欠けていても、URLセーフでも読める
  assert.equal((await base64Convert({ mode: 'decode', base64: 'SGVsbG8' })).text, 'Hello');
  // data URI の名乗りより中身を優先する（宣言のずれたコピペを拾わない）
  const lie = await base64Convert({ mode: 'decode', base64: 'data:text/plain;base64,' + Buffer.from([0x89, 0x50, 0x4e, 0x47, 13, 10, 26, 10, 0, 0, 0, 13]).toString('base64') });
  assert.equal(lie.mime_type, 'image/png');
  assert.equal(lie.declared_mime_type, 'text/plain');

  // 入力の取り違えは Base64Error で弾く
  await assert.rejects(() => base64Convert({ mode: 'decode', base64: '!!!!' }), Base64Error);
  await assert.rejects(() => base64Convert({ mode: 'decode' }), Base64Error);
  await assert.rejects(() => base64Convert({}), Base64Error);                                  // text も path も無い
  await assert.rejects(() => base64Convert({ text: 'a', path: '/tmp/x' }), Base64Error);       // 両方はだめ
  await assert.rejects(() => base64Convert({ mode: 'bogus', text: 'a' }), Base64Error);
}

console.log('all tests passed');
