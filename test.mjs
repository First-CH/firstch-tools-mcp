// lib.mjs の簡易テスト（既知の参照値と突合）
import assert from 'node:assert/strict';
import { contrastCheck, countChars, analyzeEncoding, convertEncoding, detectNewline, convertNewline } from './lib.mjs';

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

console.log('all tests passed');
