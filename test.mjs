// lib.mjs の簡易テスト（既知の参照値と突合）
import assert from 'node:assert/strict';
import { contrastCheck, countChars, analyzeEncoding, convertEncoding, detectNewline, convertNewline } from './lib.mjs';
import { diffCheck, diffSeq, buildDiff, toUnified, splitLines } from './diff.mjs';
import { cronExplain, parseCron, nextFires, describe as cronDescribe, CronError } from './cron.mjs';
import {
  base64Convert, bytesToBase64, base64ToBytes, formatBase64, parseDataUri,
  svgPercentDataUri, sniffType, percentDecode, Base64Error,
} from './base64.mjs';
import {
  urlParams, splitUrl, urlParts, parseQuery, buildQuery, buildUrl,
  decodeComponent, encodeComponent, setParam, removeParams, getUtm, analyzeUrl, UrlParamsError,
} from './url.mjs';
import { htmlEscape, escapeHtml, unescapeHtml, htmlEscapeConvert, HtmlEscapeError } from './html-escape.mjs';
import {
  jsonToYaml, yamlToJson, formatJsonFile, formatYamlFile, parseJson, parseYaml,
  formatJson, formatYaml, jsonYamlConvert, JsonYamlError,
} from './json-yaml.mjs';
import {
  pxRemConvert, prConvert, prConvertCss, prFormat, prParseLength, prResolveBase, prScale, PxRemError,
} from './px-rem.mjs';
import {
  colorConvert, clParseColor, clHex, clRgbStr, clHslStr, clOklchStr, clFlatten,
  clContrast, clPalette, clRgbToOklch, clOklchToRgb, ColorError,
} from './color.mjs';
import {
  hashGenerate, hashBuffer, encodeDigest, normalizeText, parseExpected, digestMatches, HashError,
} from './hash.mjs';
import {
  userAgentParse, parseUserAgent, tokenizeUA, detectBrowser, detectEngine, detectOS,
  detectDevice, detectBot, detectInApp, UserAgentError,
} from './user-agent.mjs';
import {
  jwtDecode, decodeJwt, normalizeInput, analyzeTiming, verifySignature,
  b64uToBytes, formatDuration, JwtError,
} from './jwt.mjs';
import {
  uuidGenerate, generateIds, formatIds, uuidV4FromBytes, encodeUlidTime, encodeUlidRandom,
  bumpUlidRandom, decodeUlid, UuidError,
} from './uuid.mjs';
import {
  aspectRatioCalc, arGcd, arFormat, arSimplify, arApprox, arNearestPreset, arParseRatio,
  arRound, arSize, arRatioOf, arFit, arTable, arSnippet, AspectRatioError,
} from './aspect-ratio.mjs';

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

/* ==================== url.mjs（tools.first-ch.com/url/ と同一ロジック） ==================== */
{
  // ---- splitUrl: # → ? の順に切る。値の中の ? はクエリの一部として残す ----
  const s1 = splitUrl('https://e.com/a?b=1&c=2#frag');
  assert.equal(s1.base, 'https://e.com/a');
  assert.equal(s1.query, 'b=1&c=2');
  assert.equal(s1.hash, 'frag');
  const s2 = splitUrl('https://e.com/a?r=https://x.com/p?q=1');
  assert.equal(s2.query, 'r=https://x.com/p?q=1', '2つ目以降の ? は値の一部');
  const s3 = splitUrl('/path/only');
  assert.equal(s3.base, '/path/only');
  assert.equal(s3.hasQuery, false);

  // ---- urlParts: スキーム無しは https を仮定・相対パスは null ----
  assert.equal(urlParts('https://e.com:8443/a/b').port, '8443');
  assert.equal(urlParts('example.com/a').assumedProtocol, true);
  assert.equal(urlParts('example.com/a').hostname, 'example.com');
  assert.equal(urlParts('/only/path'), null);
  assert.equal(urlParts('https://u:p@e.com/').hasPassword, true);

  // ---- parseQuery: + はスペース・= 無しのキーも拾う・空トークンは捨てる ----
  const rows = parseQuery('a=1&b&c=%E6%97%A5+%E6%9C%AC&&d=');
  assert.equal(rows.length, 4);
  assert.equal(rows[1].hasEq, false);
  assert.equal(rows[2].value, '日 本');
  assert.equal(rows[3].value, '');

  // 壊れた %XX でも投げず、読める範囲まで戻す
  assert.equal(parseQuery('a=100%').at(0).value, '100%');
  assert.equal(decodeComponent('%E6%97%A5%'), '日%');

  // ---- buildQuery: 未編集の行は生のまま（無編集の再構築は入力と完全一致） ----
  const raw = 'utm_source=Google&q=a+b&e=%2F%2F';
  assert.equal(buildQuery(parseQuery(raw), {}), raw, '触っていなければ1バイトも変わらない');
  const signed = 'https://e.com/f.jpg?Expires=1&Signature=aB%2Fc%3D&Key-Pair-Id=K1';
  assert.equal(
    buildUrl({ base: splitUrl(signed).base, query: buildQuery(parseQuery(splitUrl(signed).query), {}) }),
    signed,
    '署名付きURLは通しても壊れない',
  );

  // 編集した行だけ再エンコードされる
  const edited = parseQuery(raw);
  edited[1].value = 'x&y z';
  assert.equal(buildQuery(edited, {}), 'utm_source=Google&q=x%26y%20z&e=%2F%2F');
  // reencode は全体を正規化し、spaceAsPlus はスペースを + にする
  assert.equal(buildQuery(parseQuery('a=1+2'), { reencode: true }), 'a=1%202');
  assert.equal(buildQuery(parseQuery('a=1+2'), { reencode: true, spaceAsPlus: true }), 'a=1+2');
  // 無効化した行と空行は落ちる
  const off = parseQuery('a=1&b=2');
  off[0].on = false;
  assert.equal(buildQuery(off, {}), 'b=2');

  // ---- setParam / removeParams / getUtm ----
  const r2 = parseQuery('a=1&utm_source=x');
  setParam(r2, 'utm_source', 'y');
  setParam(r2, 'utm_medium', 'email');
  assert.equal(buildQuery(r2, {}), 'a=1&utm_source=y&utm_medium=email');
  setParam(r2, 'a', '');
  assert.equal(buildQuery(r2, {}), 'utm_source=y&utm_medium=email', '空文字を渡すと削除');
  assert.deepEqual(getUtm(r2), { utm_source: 'y', utm_medium: 'email' });
  assert.equal(buildQuery(removeParams(parseQuery('a=1&GCLID=x'), ['gclid']), {}), 'a=1', '大文字小文字を無視して削除');

  // ---- analyzeUrl ----
  const codes = (u) => {
    const sp = splitUrl(u);
    const rs = parseQuery(sp.query);
    return analyzeUrl({ rows: rs, parts: urlParts(sp.base), url: u, hasHash: sp.hasHash, hash: sp.hash }).map((w) => w.code);
  };
  assert.ok(codes('https://e.com/?a=1&a=2').includes('dup'));
  assert.ok(codes('https://e.com/?a=1 2').includes('raw_space'));
  assert.ok(codes('https://e.com/?a=100%zz').includes('bad_percent'));
  assert.ok(codes('https://e.com/?a=x+y').includes('plus_space'));
  assert.ok(codes('https://e.com/?token=abc').includes('secret'));
  assert.ok(codes('https://e.com/?gclid=abc').includes('click_id'));
  assert.ok(codes('https://e.com/?utm_source=Google&utm_medium=cpc').includes('utm_case'));
  assert.ok(codes('https://e.com/?utm_source=g').includes('utm_no_medium'));
  assert.ok(codes('https://e.com/?utm_medium=email').includes('utm_no_source'));
  assert.ok(codes('http://e.com/?a=1').includes('http'));
  assert.ok(codes('https://u:p@e.com/?a=1').includes('userinfo'));
  assert.ok(codes('https://e.com/?a=1#/x?y=2').includes('hash_query'));
  assert.ok(codes('https://e.com/?a=' + 'x'.repeat(2100)).includes('long_url'));
  assert.deepEqual(codes('https://e.com/?a=1&b=2'), [], '素直なURLでは何も出ない');

  // ---- urlParams（MCPの入口） ----
  const p1 = urlParams({ url: 'https://e.com/p?utm_source=Google&gclid=EAIa&q=a+b' });
  assert.equal(p1.url, 'https://e.com/p?utm_source=Google&gclid=EAIa&q=a+b');
  assert.equal(p1.changed, false);
  assert.equal(p1.hostname, 'e.com');
  assert.equal(p1.path, '/p');
  assert.equal(p1.params.length, 3);
  assert.equal(p1.params[2].value, 'a b');
  assert.equal(p1.stats.params, 3);
  assert.deepEqual(p1.utm, { utm_source: 'Google' });
  assert.ok(p1.warnings.some((w) => w.code === 'click_id' && w.message_ja.includes('gclid')));

  // クリックID削除 + 並べ替え
  const p2 = urlParams({ url: 'https://e.com/p?z=1&gclid=x&a=2', removeTracking: true, sort: true });
  assert.equal(p2.url, 'https://e.com/p?a=2&z=1');
  assert.deepEqual(p2.removed, ['gclid']);
  assert.equal(p2.changed, true);

  // UTM付与（source / utm_source のどちらの書き方も受ける）
  const p3 = urlParams({ url: 'https://e.com/lp/', utm: { source: 'newsletter', utm_medium: 'email', campaign: '2026-08' } });
  assert.equal(p3.url, 'https://e.com/lp/?utm_source=newsletter&utm_medium=email&utm_campaign=2026-08');
  assert.deepEqual(p3.utm, { utm_source: 'newsletter', utm_medium: 'email', utm_campaign: '2026-08' });

  // set / remove とフラグメントの保持
  const p4 = urlParams({ url: 'https://e.com/p?a=1&b=2#sec', set: { c: '日本' }, remove: ['a'] });
  assert.equal(p4.url, 'https://e.com/p?b=2&c=%E6%97%A5%E6%9C%AC#sec');
  assert.equal(p4.hash, 'sec');

  // 相対パス・スキーム無しでも例外にしない
  assert.equal(urlParams({ url: '/a/b?x=1' }).url, '/a/b?x=1');
  assert.equal(urlParams({ url: 'example.com/a?x=1' }).assumed_protocol, true);

  // encode / decode
  assert.equal(urlParams({ mode: 'encode', text: 'a b&c' }).output, 'a%20b%26c');
  assert.equal(urlParams({ mode: 'encode', text: 'a b&c', scheme: 'form' }).output, 'a+b%26c');
  assert.equal(urlParams({ mode: 'encode', text: 'https://e.com/a b', scheme: 'uri' }).output, 'https://e.com/a%20b');
  // component は encodeURIComponent の逆なので + はそのまま。form（クエリの流儀）だけ + を空白へ戻す
  assert.equal(urlParams({ mode: 'decode', text: '%E6%97%A5+%E6%9C%AC' }).output, '日+本');
  assert.equal(urlParams({ mode: 'decode', text: '%E6%97%A5+%E6%9C%AC', scheme: 'form' }).output, '日 本');
  // 壊れた %XX でも投げず、読める範囲まで戻す
  assert.equal(urlParams({ mode: 'decode', text: '%E6%97%A5%' }).output, '日%');

  // 入力の取り違えは UrlParamsError で弾く
  assert.throws(() => urlParams({}), UrlParamsError);
  assert.throws(() => urlParams({ url: '   ' }), UrlParamsError);
  assert.throws(() => urlParams({ mode: 'encode' }), UrlParamsError);
  assert.throws(() => urlParams({ mode: 'bogus', text: 'a' }), UrlParamsError);
  assert.throws(() => urlParams({ url: 'https://e.com/', scheme: 'bogus' }), UrlParamsError);
  assert.throws(() => urlParams({ url: 'https://e.com/', utm: { bogus: 'x' } }), UrlParamsError);
}

// ---- html-escape.mjs（HTMLエスケープ / エンティティのデコード） ----
{
  // 基本の5文字。' は既定で &#39;（&apos; はHTML 4.01に無い）
  assert.equal(escapeHtml(`<a href='x'>a & b</a>"q"`).text, '&lt;a href=&#39;x&#39;&gt;a &amp; b&lt;/a&gt;&quot;q&quot;');
  assert.equal(escapeHtml("it's", { apos: true }).text, 'it&apos;s');
  assert.equal(escapeHtml('<&>', { numeric: true }).text, '&#60;&#38;&#62;');
  assert.equal(escapeHtml(`"'`, { quotes: false }).text, `"'`);

  // & を最初に処理するので、平文を2回エスケープしても壊れない形になる（1回目が正しい形のまま）
  assert.equal(escapeHtml('a & b').text, 'a &amp; b');
  assert.equal(escapeHtml(escapeHtml('a & b').text).text, 'a &amp;amp; b');

  // U+00A0 は見えないので常に参照へ倒す
  assert.equal(escapeHtml('a\u00a0b').text, 'a&nbsp;b');
  assert.equal(escapeHtml('a\u00a0b', { numeric: true }).text, 'a&#160;b');

  // 非ASCII
  assert.equal(escapeHtml('あ©', { nonAscii: 'decimal' }).text, '&#12354;&#169;');
  assert.equal(escapeHtml('あ©', { nonAscii: 'hex' }).text, '&#x3042;&#xA9;');
  assert.equal(escapeHtml('あ©', { nonAscii: 'named' }).text, '&#12354;&copy;');
  // サロゲートペアが割れない（コードポイント単位で回している）
  assert.equal(escapeHtml('😀', { nonAscii: 'hex' }).text, '&#x1F600;');
  assert.equal(escapeHtml('日本語').text, '日本語');

  // デコード: 名前付き・10進・16進
  assert.equal(unescapeHtml('&lt;p&gt;5 &amp;lt; 10&lt;/p&gt;').text, '<p>5 &lt; 10</p>');
  assert.equal(unescapeHtml('&#12354;&#x3042;&hearts;&Omega;').text, 'ああ♥Ω');
  // C1領域はHTML仕様どおり Windows-1252 へ読み替える（&#128; は U+0080 ではなく €）
  assert.equal(unescapeHtml('&#128;&#147;').text, '€“');
  // 知らない名前・範囲外の数値・セミコロン無しは変換せず残す
  const u = unescapeHtml('&foo; &#999999999; &bar &amp;');
  assert.equal(u.text, '&foo; &#999999999; &bar &');
  assert.deepEqual(u.unknown, ['&foo;']);
  assert.deepEqual(u.invalid, ['&#999999999;']);
  // 不正なコードポイントは U+FFFD（仕様どおり）
  assert.equal(unescapeHtml('&#0;&#xD800;').text, '\uFFFD\uFFFD');
  // 往復（既定オプションで戻ること）
  const round = 'タグ <b> と & と " と \' と \u00a0';
  assert.equal(unescapeHtml(escapeHtml(round).text).text, round);

  // 指摘事項
  const codes = (r) => r.notes.map((n) => n.code);
  assert.ok(codes(htmlEscapeConvert({ mode: 'escape', text: 'a &amp; b' })).includes('DOUBLE_ESCAPE'));
  assert.ok(codes(htmlEscapeConvert({ mode: 'escape', text: 'a\u00a0b' })).includes('HAS_NBSP'));
  assert.ok(codes(htmlEscapeConvert({ mode: 'escape', text: 'plain' })).includes('NOTHING_TO_ESCAPE'));
  assert.ok(codes(htmlEscapeConvert({ mode: 'unescape', text: '&bar' })).includes('MISSING_SEMICOLON'));
  assert.ok(codes(htmlEscapeConvert({ mode: 'unescape', text: 'a & b' })).includes('BARE_AMP'));
  assert.ok(codes(htmlEscapeConvert({ mode: 'unescape', text: '&lt;b&gt;' })).includes('HAS_TAGS'));
  // セミコロン無しの参照らしき文字列は BARE_AMP で二重に数えない
  assert.ok(!codes(htmlEscapeConvert({ mode: 'unescape', text: '&bar' })).includes('BARE_AMP'));

  // 件数
  const c = htmlEscapeConvert({ mode: 'escape', text: '<a> & <b>' });
  assert.equal(c.changed, 5);
  assert.deepEqual(c.counts, { amp: 1, lt: 2, gt: 2, quot: 0, apos: 0, nbsp: 0, nonAscii: 0 });
}

// html_escape（MCPの入口・ファイル入出力を含む）
{
  const r = await htmlEscape({ text: '<b>a & b</b>' });
  assert.equal(r.text, '&lt;b&gt;a &amp; b&lt;/b&gt;');
  assert.equal(r.mode, 'escape');
  assert.deepEqual(r.source, { type: 'text' });
  assert.equal(r.options.non_ascii, 'none');

  const back = await htmlEscape({ mode: 'unescape', text: r.text });
  assert.equal(back.text, '<b>a & b</b>');
  assert.ok(back.notes.every((n) => typeof n.message === 'string' && n.message.length > 0));

  // ファイル入出力
  const { mkdtemp, writeFile: wf, readFile: rf } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'firstch-html-escape-'));
  const src = join(dir, 'in.txt');
  const dst = join(dir, 'out.html');
  await wf(src, '5 < 10 & 3 > 1', 'utf8');
  const fileRes = await htmlEscape({ path: src, outputPath: dst });
  assert.equal(fileRes.text, undefined);
  assert.equal(fileRes.output, dst);
  assert.equal(fileRes.source.name, 'in.txt');
  assert.equal(await rf(dst, 'utf8'), '5 &lt; 10 &amp; 3 &gt; 1');

  // 入力の取り違えは HtmlEscapeError で弾く
  await assert.rejects(() => htmlEscape({}), HtmlEscapeError);
  await assert.rejects(() => htmlEscape({ text: 'a', path: '/tmp/x' }), HtmlEscapeError);
  await assert.rejects(() => htmlEscape({ text: 'a', mode: 'bogus' }), HtmlEscapeError);
  await assert.rejects(() => htmlEscape({ text: 'a', nonAscii: 'bogus' }), HtmlEscapeError);
}

// ---- json-yaml.mjs（JSON ⇄ YAML 相互変換＆構文フォーマッター） ----
{
  // JSONパーサ: JSON.parse と同じ値になる
  for (const src of ['{"a":1,"b":[true,false,null]}', '[]', '{}', '"\\u3042\\n"', '-0.5', '1e10', '{"":"empty"}']) {
    const r = parseJson(src);
    assert.ok(r.ok, src + ' → ' + JSON.stringify(r.error));
    assert.deepEqual(JSON.parse(formatJson(r.value, { indent: 0 })), JSON.parse(src), src);
  }
  // JSON出力は JSON.stringify と一致する（インデント2 / 1行 / タブ）
  for (const v of [{ a: 1, b: [1, 2], c: { d: 'e' } }, [], {}, { s: 'q" b\\ t\t n\n' }]) {
    assert.equal(formatJson(v, { indent: 2 }), JSON.stringify(v, null, 2));
    assert.equal(formatJson(v, { indent: 0 }), JSON.stringify(v));
    assert.equal(formatJson(v, { indent: 'tab' }), JSON.stringify(v, null, '\t'));
  }
  // エラーは行と桁で返る
  const badJson = parseJson('{\n  "a": 1,\n  "b" 2\n}');
  assert.equal(badJson.ok, false);
  assert.equal(badJson.error.code, 'JSON_COLON_EXPECTED');
  assert.deepEqual([badJson.error.line, badJson.error.col], [3, 7]);
  // コメント・末尾カンマ・裸のキーは読んだうえで指摘する（tsconfig.json 等が実在するため）
  const relaxed = parseJson('{\n // c\n a: 1,\n "b": [1,2,],\n}');
  assert.ok(relaxed.ok);
  assert.deepEqual(JSON.parse(formatJson(relaxed.value, { indent: 0 })), { a: 1, b: [1, 2] });
  assert.deepEqual(relaxed.notes.map((n) => n.code).sort(), ['JSON_COMMENT', 'JSON_TRAILING_COMMA', 'JSON_UNQUOTED_KEY']);
  assert.equal(parseJson('[1,2,]', { relaxed: false }).error.code, 'JSON_TRAILING_COMMA');
  // __proto__ でプロトタイプ汚染しない
  assert.ok(parseJson('{"__proto__":{"x":1}}').ok);
  assert.equal({}.x, undefined);

  // YAMLパーサ: ブロック・フロー・ブロックスカラー・アンカー・マージキー・複数ドキュメント
  const y = parseYaml([
    'version: "3.9"',
    'services:',
    '  web:',
    '    image: nginx:1.25',
    '    ports:',
    '      - "80:80"',
    '    depends_on: [db, cache]',
    '    command: |',
    '      echo one',
    '      echo two',
    '    note: >',
    '      folded text',
    '      continues',
    'defaults: &d',
    '  pool: 5',
    'dev:',
    '  <<: *d',
    '  name: dev',
    '---',
    '- a',
    '- b',
  ].join('\n'));
  assert.ok(y.ok, JSON.stringify(y.error));
  assert.equal(y.docs.length, 2);
  const doc = y.docs[0];
  assert.equal(doc.version, '3.9');
  assert.deepEqual(doc.services.web.ports, ['80:80']);
  assert.deepEqual(doc.services.web.depends_on, ['db', 'cache']);
  assert.equal(doc.services.web.command, 'echo one\necho two\n');
  assert.equal(doc.services.web.note, 'folded text continues\n');
  assert.deepEqual(JSON.parse(formatJson(y.docs[0].dev, { indent: 0 })), { pool: 5, name: 'dev' });
  assert.deepEqual(y.docs[1], ['a', 'b']);

  // スカラーの解釈は YAML 1.2 core schema
  const sc = parseYaml('a: 42\nb: -1.5\nc: true\nd: null\ne: ~\nf:\ng: yes\nh: 0755\ni: 0o755\nj: 0x1F\nk: .inf\nl: "42"\n');
  assert.ok(sc.ok, JSON.stringify(sc.error));
  assert.equal(sc.value.a, 42);
  assert.equal(sc.value.b, -1.5);
  assert.equal(sc.value.c, true);
  assert.equal(sc.value.d, null);
  assert.equal(sc.value.e, null);
  assert.equal(sc.value.f, null);
  assert.equal(sc.value.g, 'yes');   // 1.2 では文字列（1.1 では真偽値なので notes で知らせる）
  assert.equal(sc.value.h, 755);     // 先頭の0は8進数ではない
  assert.equal(sc.value.i, 493);
  assert.equal(sc.value.j, 31);
  assert.equal(sc.value.k, Infinity);
  assert.equal(sc.value.l, '42');

  // 構文エラー（行つき）
  for (const [text, code, line] of [
    ['a: 1\n\tb: 2\n', 'TAB_INDENT', 2],
    ['a: b: c\n', 'YAML_NESTED_COLON', 1],
    ['a: "x\n', 'YAML_UNTERMINATED_QUOTE', 1],
    ['a: [1, 2\n', 'YAML_UNTERMINATED_FLOW', 1],
    ['a: *missing\n', 'YAML_ALIAS_NOT_FOUND', 1],
    ['items: - a\n', 'YAML_SEQ_INLINE', 1],
    ['a: 1\nnot a key\n', 'YAML_KEY_EXPECTED', 2],
    ['? a\n: b\n', 'YAML_EXPLICIT_KEY', 1],
  ]) {
    const r = parseYaml(text);
    assert.equal(r.ok, false, JSON.stringify(text) + ' が通ってしまった');
    assert.equal(r.error.code, code, JSON.stringify(text) + ' → ' + JSON.stringify(r.error));
    assert.equal(r.error.line, line, JSON.stringify(text) + ' → ' + JSON.stringify(r.error));
  }
  // 壊れた入力でも例外にはしない（必ず ok:false で返す）
  for (const text of ['"', '|', '[', '{a', '&x', '*', '%YAML', '- - -', '\t']) {
    assert.equal(parseYaml(text).ok !== undefined, true, JSON.stringify(text));
  }
  // 深すぎる入れ子で落ちない
  let deep = '';
  for (let k = 0; k < 400; k++) deep += ' '.repeat(k) + 'a:\n';
  assert.equal(parseYaml(deep).error.code, 'TOO_DEEP');

  // 指摘事項
  const notes = parseYaml('perm: 0755\nflag: yes\nt: 12:30\ndup: 1\ndup: 2\nid: 123456789012345678901\n').notes.map((n) => n.code);
  for (const c of ['YAML_LEADING_ZERO', 'YAML11_BOOL', 'YAML_SEXAGESIMAL', 'DUPLICATE_KEY', 'NUMBER_PRECISION']) {
    assert.ok(notes.includes(c), c + ' の指摘が無い: ' + notes);
  }

  // YAML出力: 別の型に読まれうる文字列は引用符で守る（往復して値が変わらないこと）
  const tricky = {
    yes: 'yes', no: 'no', on: 'on', t: 'true', n: 'null', tilde: '~', num: '42', zero: '0755',
    time: '12:30', date: '2026-08-12', empty: '', pad: ' x ', hash: 'a # b', colon: 'a: b',
    dash: '- a', star: '*.js', amp: '&x', pipe: '| x', q: "it's", nl: 'a\nb', nl2: 'a\nb\n',
    doc: '---', merge: '<<',
  };
  const out = formatYaml(tricky);
  const back = parseYaml(out);
  assert.ok(back.ok, JSON.stringify(back.error) + '\n' + out);
  assert.deepEqual(JSON.parse(formatJson(back.value, { indent: 0 })), tricky, out);

  // 出力の見た目（シーケンス内のマップはコンパクト記法・空コレクションはフロー表記）
  // キー名に y を使わないのは、y が YAML 1.1 の真偽値で引用符が付くため（別のテストで確認している）
  assert.equal(
    formatYaml({ a: [{ x: 1, z: 2 }], b: [[1, 2]], c: {}, d: [], e: 'ok' }),
    'a:\n  - x: 1\n    z: 2\nb:\n  - - 1\n    - 2\nc: {}\nd: []\ne: ok\n',
  );
  // キーも別の型に読まれうるなら引用符で守る（y: は YAML 1.1 では true というキーになる）
  assert.equal(formatYaml({ y: 1, on: 2, '0755': 3 }), "'y': 1\n'on': 2\n'0755': 3\n");
  assert.equal(formatYaml({ a: { b: [1] } }, { indent: 4 }), 'a:\n    b:\n        - 1\n');
  assert.equal(formatYaml({ a: 'one\ntwo\n' }), 'a: |\n  one\n  two\n');
  assert.equal(formatYaml({ a: 'one\ntwo' }), 'a: |-\n  one\n  two\n');
  assert.equal(formatYaml({ a: null }, { nullStyle: 'tilde', docStart: true }), '---\na: ~\n');
  assert.equal(formatYaml({ b: 1, a: 2 }, { sortKeys: true }), 'a: 2\nb: 1\n');

  // jsonYamlConvert: 4方向と統計
  const j2y = jsonYamlConvert({ direction: 'json2yaml', text: '{"a":[1,{"b":"x"}]}' });
  assert.ok(j2y.ok);
  assert.equal(j2y.output, 'a:\n  - 1\n  - b: x\n');
  assert.equal(j2y.stats.max_depth, 4);
  const y2j = jsonYamlConvert({ direction: 'yaml2json', text: 'a: 1\n---\nb: 2\n', indent: 0 });
  assert.equal(y2j.output.trim(), '[{"a":1},{"b":2}]');
  assert.equal(y2j.documents, 2);
  assert.ok(y2j.notes.some((n) => n.code === 'MULTI_DOC'));
  assert.equal(jsonYamlConvert({ direction: 'json2json', text: '{"b":1}' }).output, '{\n  "b": 1\n}\n');
  assert.equal(jsonYamlConvert({ direction: 'yaml2yaml', text: 'b:   1\na: [1]\n' }).output, 'b: 1\na:\n  - 1\n');
  assert.equal(jsonYamlConvert({ direction: 'json2yaml', text: '  \n' }).empty, true);
  // .inf / .nan は JSON に無いので null になり、そのことを知らせる
  const nf = jsonYamlConvert({ direction: 'yaml2json', text: 'a: .nan\n', indent: 0 });
  assert.equal(nf.output.trim(), '{"a":null}');
  assert.ok(nf.notes.some((n) => n.code === 'NONFINITE_OUTPUT'));
  // エラー時は抜き出しがエラー行を指す
  const ex = jsonYamlConvert({ direction: 'yaml2json', text: 'a: 1\nb: 2\n\tc: 3\nd: 4\n' });
  assert.equal(ex.ok, false);
  assert.equal(ex.error.line, 3);
  assert.deepEqual(ex.excerpt.rows.map((r) => r.line), [1, 2, 3, 4]);
}

// json_to_yaml / yaml_to_json（MCPの入口・ファイル入出力を含む）
{
  const r = await jsonToYaml({ text: '{"name":"web","ports":["80:80"],"mode":"0755","env":{"TZ":"Asia/Tokyo"}}' });
  assert.equal(r.text, "name: web\nports:\n  - 80:80\nmode: '0755'\nenv:\n  TZ: Asia/Tokyo\n");
  assert.equal(r.direction, 'json2yaml');
  assert.deepEqual(r.source, { type: 'text' });
  assert.equal(r.options.indent, 2);
  assert.equal(r.stats.keys, 5);   // 入れ子の中まで数える（env.TZ を含む）

  const back = await yamlToJson({ text: r.text, indent: 0 });
  assert.equal(back.text.trim(), '{"name":"web","ports":["80:80"],"mode":"0755","env":{"TZ":"Asia/Tokyo"}}');
  assert.equal(back.documents, 1);

  // 指摘には必ず日本語の説明が付く
  const noted = await yamlToJson({ text: 'a: 0755\nb: yes\n' });
  assert.ok(noted.notes.length >= 2);
  assert.ok(noted.notes.every((n) => typeof n.message === 'string' && n.message.length > 0), JSON.stringify(noted.notes));
  assert.ok(noted.notes.every((n) => n.level === 'warn' || n.level === 'info'));

  // 整形（同じ形式のまま）
  assert.equal((await formatJsonFile({ text: '{"b":1,"a":2}', sortKeys: true })).text, '{\n  "a": 2,\n  "b": 1\n}\n');
  assert.equal((await formatYamlFile({ text: 'a:  [1,2]\n' })).text, 'a:\n  - 1\n  - 2\n');

  // ファイル入出力
  const { mkdtemp, writeFile: wf, readFile: rf } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'firstch-json-yaml-'));
  const src = join(dir, 'in.json');
  const dst = join(dir, 'out.yaml');
  await wf(src, '{"a": 1, "b": ["x"]}', 'utf8');
  const fileRes = await jsonToYaml({ path: src, outputPath: dst, indent: 4 });
  assert.equal(fileRes.text, undefined);
  assert.equal(fileRes.output, dst);
  assert.equal(fileRes.source.name, 'in.json');
  assert.equal(await rf(dst, 'utf8'), 'a: 1\nb:\n    - x\n');

  // 構文エラーは JsonYamlError（メッセージに行・桁・原因・抜き出しを含む）
  await assert.rejects(
    () => yamlToJson({ text: 'a: 1\n\tb: 2\n' }),
    (e) => {
      assert.ok(e instanceof JsonYamlError, String(e));
      assert.match(e.message, /TAB_INDENT/);
      assert.match(e.message, /2行 1桁/);
      assert.match(e.message, /\^/);
      return true;
    },
  );
  await assert.rejects(() => jsonToYaml({ text: '{"a" 1}' }), JsonYamlError);

  // 入力・オプションの取り違えは JsonYamlError で弾く
  await assert.rejects(() => jsonToYaml({}), JsonYamlError);
  await assert.rejects(() => jsonToYaml({ text: 'a', path: '/tmp/x' }), JsonYamlError);
  await assert.rejects(() => jsonToYaml({ text: '{}', indent: 99 }), JsonYamlError);
  await assert.rejects(() => jsonToYaml({ text: '{}', quote: 'bogus' }), JsonYamlError);
  await assert.rejects(() => jsonToYaml({ text: '{}', nullStyle: 'bogus' }), JsonYamlError);
}


// ---- px-rem.mjs（px ⇄ rem / em の換算・CSSの一括変換） ----
{
  // 基本の換算（ルート16px）
  const r = prConvert({ value: 24 });
  assert.equal(r.px, 24);
  assert.equal(r.rem, 1.5);
  assert.equal(r.em, 1.5);
  assert.equal(r.pt, 18);          // 1px = 0.75pt

  // rem / em / pt / % からも戻せる
  assert.equal(prConvert({ value: 1.5, unit: 'rem' }).px, 24);
  assert.equal(prConvert({ value: 2, unit: 'em', parent: 10 }).px, 20);
  assert.equal(prConvert({ value: 18, unit: 'pt' }).px, 24);
  assert.equal(prConvert({ value: 150, unit: '%', parent: 16 }).px, 24);
  assert.equal(prConvert({ value: 'zzz' }), null);

  // ルートが変われば rem も変わる（em は親要素基準で別に動く）
  const r10 = prConvert({ value: 24, root: 10 });
  assert.equal(r10.rem, 2.4);
  assert.equal(r10.em, 2.4);
  const nested = prConvert({ value: 24, root: 16, parent: 20 });
  assert.equal(nested.rem, 1.5);
  assert.equal(nested.em, 1.2);

  // 基準サイズの指定は 62.5% のようなパーセントでも読む（ブラウザ既定16pxに対する割合）
  assert.equal(prResolveBase('62.5%', 16), 10);
  assert.equal(prResolveBase('12pt', 16), 16);
  assert.equal(prResolveBase('', 16), 16);
  assert.equal(prResolveBase('0', 16), 16);      // 0 や負値は基準にできないので fallback
  assert.equal(prResolveBase(20, 16), 20);

  // 数の書き出し: auto は末尾の0を落とし、桁を渡すと固定する
  assert.equal(prFormat(1.5, 'auto'), '1.5');
  assert.equal(prFormat(1.5, 3), '1.500');
  assert.equal(prFormat(16 / 14, 'auto'), '1.142857');
  assert.equal(prFormat(0, 'auto'), '0');
  assert.equal(prFormat(-0.0001, 2), '0.00');    // 桁固定でも -0 にはしない
  assert.equal(prFormat(8.325, 2), '8.33');      // 8.325*100 が 832.4999… になる誤差を吸収する

  // 長さの読み取り
  assert.deepEqual(prParseLength('24px'), { value: 24, unit: 'px' });
  assert.deepEqual(prParseLength('1.5 rem'), { value: 1.5, unit: 'rem' });
  assert.deepEqual(prParseLength('24', 'em'), { value: 24, unit: 'em' });
  assert.equal(prParseLength('24 px 3'), null);
  assert.equal(prParseLength(''), null);

  // スケール表は 12〜64px の15段
  const scale = prScale({ root: 16 });
  assert.equal(scale.length, 15);
  assert.equal(scale[0].px, 12);
  assert.equal(scale[0].rem, 0.75);
  assert.equal(scale[scale.length - 1].px, 64);
  assert.equal(scale[scale.length - 1].rem, 4);

  // CSSの一括変換: 既定は px→rem・1px の罫線と @media の条件は残す
  const css = prConvertCss(
    'a{padding:24px;border:1px solid red;font-size:16px}\n@media (min-width:768px){a{font-size:18px}}',
    { minPx: 2 },
  );
  assert.equal(
    css.text,
    'a{padding:1.5rem;border:1px solid red;font-size:1rem}\n@media (min-width:768px){a{font-size:1.125rem}}',
  );
  assert.equal(css.stats.found, 5);
  assert.equal(css.stats.converted, 3);
  assert.equal(css.stats.skipped_small, 1);
  assert.equal(css.stats.skipped_media, 1);

  // コメント・文字列・url() の中身と、識別子の一部の数字は書き換えない
  const safe = prConvertCss('/* 24px */ .a{margin:0px;width:calc(100% - 10px);content:"10px";background:url(a10px.png)}');
  assert.equal(safe.text, '/* 24px */ .a{margin:0;width:calc(100% - 0.625rem);content:"10px";background:url(a10px.png)}');
  assert.equal(safe.stats.zeroed, 1);
  assert.equal(prConvertCss('--size-16px: 3px;').text, '--size-16px: 0.1875rem;');

  // 逆向き・em 向き・除外プロパティ
  assert.equal(prConvertCss('a{font-size:1.5rem}', { direction: 'rem2px' }).text, 'a{font-size:24px}');
  assert.equal(prConvertCss('a{padding:24px}', { direction: 'px2em', parent: 20 }).text, 'a{padding:1.2em}');
  assert.equal(
    prConvertCss('.b{border:4px solid;padding:4px}', { ignoreProps: ['border'] }).text,
    '.b{border:4px solid;padding:0.25rem}',
  );
  // 負の値・小数・ショートハンドも通る
  assert.equal(prConvertCss('p{margin:-10px 0 12px;font:14px/20px sans-serif}').text,
    'p{margin:-0.625rem 0 0.75rem;font:0.875rem/1.25rem sans-serif}');

  // MCPツール本体: 値の換算はスケール表と指摘つきで返る
  const v = await pxRemConvert({ value: 24 });
  assert.equal(v.mode, 'value');
  assert.equal(v.formatted.rem, '1.5rem');
  assert.equal(v.css, 'font-size: 1.5rem; /* 24px */');
  assert.equal(v.exact, true);
  assert.equal(v.scale.length, 15);
  assert.equal(v.notes.length, 0);

  // ルート10px は 62.5%テクニックとして警告する
  const v10 = await pxRemConvert({ value: 1.4, unit: 'rem', root: '62.5%' });
  assert.equal(v10.formatted.px, '14px');
  const codes10 = v10.notes.map((n) => n.code);
  assert.ok(codes10.includes('ROOT_NOT_16'));
  assert.ok(codes10.includes('ROOT_625'));

  // 割り切れない値は丸めたことを知らせる
  const v14 = await pxRemConvert({ value: 16, root: 14, scale: false });
  assert.equal(v14.exact, false);
  assert.equal(v14.scale, undefined);
  assert.ok(v14.notes.some((n) => n.code === 'NOT_EXACT'));

  // CSSモード（既定 minPx=2 で 1px を残す）
  const c = await pxRemConvert({ css: 'a{border:1px solid;padding:24px}' });
  assert.equal(c.mode, 'css');
  assert.equal(c.text, 'a{border:1px solid;padding:1.5rem}');
  assert.ok(c.notes.some((n) => n.code === 'SKIPPED_SMALL'));

  // ファイル入出力
  {
    const { mkdtemp, writeFile: wf, readFile: rf } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'firstch-px-rem-'));
    const src = join(dir, 'in.css');
    const dst = join(dir, 'out.css');
    await wf(src, '.a{font-size:24px}\n', 'utf8');
    const fileRes = await pxRemConvert({ path: src, outputPath: dst });
    assert.equal(fileRes.text, undefined);
    assert.equal(fileRes.output, dst);
    assert.equal(fileRes.source.name, 'in.css');
    assert.equal(await rf(dst, 'utf8'), '.a{font-size:1.5rem}\n');
  }

  // 入力の取り違えは PxRemError で弾く
  await assert.rejects(() => pxRemConvert({}), PxRemError);
  await assert.rejects(() => pxRemConvert({ value: 24, css: 'a{}' }), PxRemError);
  await assert.rejects(() => pxRemConvert({ css: 'a{}', path: '/tmp/x.css' }), PxRemError);
  await assert.rejects(() => pxRemConvert({ value: 'zzz' }), PxRemError);
  await assert.rejects(() => pxRemConvert({ css: 'a{}', direction: 'bogus' }), PxRemError);
}


/* ==================== color_convert ==================== */
{
  // 入力形式ごとに同じ色へ落ちる（HEX / rgb / hsl / 色名 / 大文字 / 3桁）
  const same = ['#c8501f', '#C8501F', 'rgb(200 80 31)', 'rgb(200, 80, 31)', 'rgb(78.43% 31.37% 12.16%)'];
  for (const v of same) {
    const c = clParseColor(v);
    assert.ok(c, v);
    assert.equal(clHex(c, { alpha: 'never' }), '#c8501f', v);
  }
  assert.equal(clHex(clParseColor('#0f0'), { alpha: 'never' }), '#00ff00');
  assert.equal(clHex(clParseColor('tomato'), { alpha: 'never' }), '#ff6347');
  assert.equal(clParseColor('rebeccapurple').name, 'rebeccapurple');
  assert.equal(clParseColor('transparent').a, 0);
  // hsl / hwb / oklab の既知値
  assert.equal(clHex(clParseColor('hsl(0 100% 50%)'), { alpha: 'never' }), '#ff0000');
  assert.equal(clHex(clParseColor('hsl(120deg 100% 50%)'), { alpha: 'never' }), '#00ff00');
  assert.equal(clHex(clParseColor('hsl(0.5turn 100% 50%)'), { alpha: 'never' }), '#00ffff');
  assert.equal(clHex(clParseColor('hwb(0 0% 0%)'), { alpha: 'never' }), '#ff0000');
  assert.equal(clHex(clParseColor('hwb(0 50% 50%)'), { alpha: 'never' }), '#808080');
  // アルファの読み取り（4桁/8桁HEX・カンマ・スラッシュ・パーセント）
  assert.equal(clParseColor('#00000080').a, 128 / 255);
  assert.equal(clParseColor('rgba(0, 0, 0, 0.5)').a, 0.5);
  assert.equal(clParseColor('rgb(0 0 0 / 50%)').a, 0.5);
  assert.equal(clParseColor('#f00f').a, 1);
  // 読めない入力は null（5桁・7桁のHEXは不正）
  for (const v of ['zzz', '#12345', '#1234567', 'rgb(1 2)', 'oklch(50%)', '']) {
    assert.equal(clParseColor(v), null, v);
  }

  // 往復（HEX → OKLCH → HEX）が全ての名前付き色で1/255以内に戻る
  let worst = 0;
  for (const name of ['tomato', 'dodgerblue', 'rebeccapurple', 'gold', 'darkslategray', 'white', 'black', 'lime']) {
    const c = clParseColor(name);
    const lch = clRgbToOklch(c.r, c.g, c.b);
    const back = clOklchToRgb(lch.l, lch.c, lch.h);
    worst = Math.max(worst, Math.abs(back.r - c.r), Math.abs(back.g - c.g), Math.abs(back.b - c.b));
  }
  assert.ok(worst < 0.5, `oklch round-trip drift ${worst}`);

  // sRGB外のOKLCHは彩度だけを下げて収める（明度と色相は保つ）
  const wide = clParseColor('oklch(70% 0.35 140)');
  assert.equal(wide.clipped, true);
  const fitted = clRgbToOklch(wide.r, wide.g, wide.b);
  assert.ok(Math.abs(fitted.l - 0.7) < 0.005, `L drift ${fitted.l}`);
  assert.ok(Math.abs(fitted.h - 140) < 0.5, `H drift ${fitted.h}`);
  assert.ok(fitted.c < 0.35);

  // アルファ合成: 黒50%を白に重ねると #808080（127.5 の四捨五入で128）
  const flat = clFlatten({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 });
  assert.equal(clHex(flat, { alpha: 'never' }), '#808080');
  // 背景も透過している場合はアルファも合成する
  const both = clFlatten({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 0.5 });
  assert.equal(Math.round(both.a * 100) / 100, 0.75);

  // コントラスト比（既知値: 黒×白 = 21）
  assert.equal(clContrast({ r: 0, g: 0, b: 0 }, { r: 255, g: 255, b: 255 }), 21);

  // 書き出しの記法
  const c8 = clParseColor('#c8501f');
  c8.a = 0.5;
  assert.equal(clRgbStr(c8, { alpha: 'always' }), 'rgb(200 80 31 / 0.5)');
  assert.equal(clRgbStr(c8, { alpha: 'always', legacy: true }), 'rgba(200, 80, 31, 0.5)');
  assert.equal(clRgbStr(c8, { alpha: 'always', alphaPercent: true }), 'rgb(200 80 31 / 50%)');
  assert.equal(clHslStr(c8, { alpha: 'always', legacy: true }), 'hsla(17.4, 73.16%, 45.29%, 0.5)');
  assert.equal(clHex(c8, { alpha: 'always', upper: true }), '#C8501F80');
  assert.match(clOklchStr(c8, { alpha: 'never' }), /^oklch\(58\.3% 0\.164\d 40\.2\d?\)$/);

  // パレット: 11段・明度が単調に下がる・入力に最も近い段が1つだけ base
  const pal = clPalette(clParseColor('#c8501f'));
  assert.equal(pal.length, 11);
  assert.equal(pal.filter((p) => p.base).length, 1);
  for (let i = 1; i < pal.length; i++) {
    assert.ok(clRgbToOklch(pal[i].color.r, pal[i].color.g, pal[i].color.b).l
      < clRgbToOklch(pal[i - 1].color.r, pal[i - 1].color.g, pal[i - 1].color.b).l, `tone ${pal[i].key}`);
  }

  // colorConvert 本体
  const r = colorConvert({ color: '#c8501f', alpha: 0.4, background: '#ffffff' });
  assert.equal(r.formats.hex, '#c8501f');
  assert.equal(r.formats.hex8, '#c8501f66');
  assert.equal(r.formats.rgba, 'rgb(200 80 31 / 0.4)');
  assert.equal(r.rgb.r, 200);
  assert.equal(r.alpha, 0.4);
  assert.equal(r.flattened.hex, '#e9b9a5');
  assert.equal(r.contrast.on_white, 4.54);
  assert.equal(r.alpha_table.length, 11);
  assert.equal(r.alpha_table[5].percent, 50);
  assert.equal(r.alpha_table[5].flattened, '#e4a88f');
  assert.equal(r.alpha_table[10].flattened, '#ffffff');
  assert.equal(r.palette.length, 11);
  assert.ok(r.notes.some((n) => n.code === 'ALPHA'));

  // alpha は 0〜1 でも 0〜100 でも '50%' でも同じ意味に読む
  assert.equal(colorConvert({ color: '#000', alpha: 40 }).alpha, 0.4);
  assert.equal(colorConvert({ color: '#000', alpha: '40%' }).alpha, 0.4);
  assert.equal(colorConvert({ color: '#000', alpha: 0.4 }).alpha, 0.4);

  // 名前付き色に一致したら指摘する / 無彩色は色相に意味がないと指摘する
  assert.ok(colorConvert({ color: 'rgb(255 99 71)' }).notes.some((n) => n.code === 'NAMED'));
  assert.ok(colorConvert({ color: '#808080' }).notes.some((n) => n.code === 'GRAY'));
  assert.ok(colorConvert({ color: 'oklch(70% 0.35 140)' }).notes.some((n) => n.code === 'CLIPPED'));

  // 背景を変えると合成結果も変わる
  assert.equal(colorConvert({ color: '#000', alpha: 0.5, background: '#23282e' }).flattened.hex, '#121417');

  // 表・パレットは切れる
  const slim = colorConvert({ color: '#c8501f', alphaTable: false, palette: false });
  assert.equal(slim.alpha_table, undefined);
  assert.equal(slim.palette, undefined);
  assert.equal(colorConvert({ color: '#c8501f', step: 25 }).alpha_table.length, 5);

  // 不正な入力は ColorError
  assert.throws(() => colorConvert({}), ColorError);
  assert.throws(() => colorConvert({ color: 'zzz' }), ColorError);
  assert.throws(() => colorConvert({ color: '#fff', background: 'nope' }), ColorError);
  assert.throws(() => colorConvert({ color: '#fff', step: 0 }), ColorError);
  assert.throws(() => colorConvert({ color: '#fff', syntax: 'bogus' }), ColorError);
}


// ==================== hash_generate ====================
{
  // RFC 1321 (MD5) / RFC 3174 (SHA-1) / FIPS 180-4 の既知テストベクタ。
  // site 側（site/hash/app.js の自前MD5実装）も同じ値になることをブラウザ側の検証で確認している。
  const empty = hashBuffer(Buffer.alloc(0), ['md5', 'sha1', 'sha256', 'sha512']);
  assert.equal(empty.md5.toString('hex'), 'd41d8cd98f00b204e9800998ecf8427e');
  assert.equal(empty.sha1.toString('hex'), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
  assert.equal(
    empty.sha256.toString('hex'),
    'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
  );

  const abc = hashBuffer(Buffer.from('abc'), ['md5', 'sha1', 'sha256', 'sha384', 'sha512']);
  assert.equal(abc.md5.toString('hex'), '900150983cd24fb0d6963f7d28e17f72');
  assert.equal(abc.sha1.toString('hex'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
  assert.equal(
    abc.sha256.toString('hex'),
    'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  );
  assert.equal(
    abc.sha384.toString('hex'),
    'cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7',
  );

  // RFC 1321 のテストスイートより
  assert.equal(
    hashBuffer(Buffer.from('message digest'), ['md5']).md5.toString('hex'),
    'f96b697d7cb7938d525a2f31aaf161d0',
  );
  assert.equal(
    hashBuffer(Buffer.from('The quick brown fox jumps over the lazy dog'), ['md5']).md5.toString('hex'),
    '9e107d9d372bb6826bd81d3542a419d6',
  );
  // 64バイト境界をまたぐ入力（パディングの実装ミスが出やすい長さ）
  assert.equal(
    hashBuffer(Buffer.from('12345678901234567890123456789012345678901234567890123456789012345678901234567890'), ['md5']).md5.toString('hex'),
    '57edf4a22be3c955ac49da2e2107b67a',
  );

  // 書式の変換
  const sha256Hello = hashBuffer(Buffer.from('hello'), ['sha256']).sha256;
  assert.equal(encodeDigest(sha256Hello, 'hex'), '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal(encodeDigest(sha256Hello, 'HEX'), '2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824');
  assert.equal(encodeDigest(sha256Hello, 'base64'), 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=');
  assert.equal(encodeDigest(sha256Hello, 'base64url'), 'LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ');

  // 改行コード・BOM で対象のバイト列が変わる
  assert.equal(normalizeText('a\nb').toString('hex'), '610a62');
  assert.equal(normalizeText('a\nb', 'crlf').toString('hex'), '610d0a62');
  assert.equal(normalizeText('a\r\nb', 'lf').toString('hex'), '610a62');
  assert.equal(normalizeText('a', 'lf', true).toString('hex'), 'efbbbf61');

  // 期待値の読み取り: コマンドの出力をそのまま渡せる
  const md5Hello = '5d41402abc4b2a76b9719d911017c592';
  assert.deepEqual(parseExpected(md5Hello), { value: md5Hello, kind: 'hex', bits: 128 });
  assert.equal(parseExpected(md5Hello.toUpperCase()).value, md5Hello);
  assert.equal(parseExpected(`${md5Hello}  hello.txt`).value, md5Hello);
  assert.equal(parseExpected(`${md5Hello} *hello.txt`).value, md5Hello);
  assert.equal(parseExpected(`md5:${md5Hello}`).value, md5Hello);
  assert.equal(parseExpected(`MD5 (hello.txt) = ${md5Hello}`).value, md5Hello);
  assert.equal(parseExpected('5d:41:40:2a:bc:4b:2a:76:b9:71:9d:91:10:17:c5:92').value, md5Hello);
  assert.equal(parseExpected('').kind, '');
  assert.equal(parseExpected('not a hash at all').kind, '');
  // base64 / base64url はどちらも同じ標準形へ寄せる
  assert.equal(parseExpected('LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=').kind, 'base64');
  assert.equal(
    parseExpected('LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ').value,
    'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ',
  );
  assert.equal(parseExpected('LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ').bits, 256);
  assert.ok(digestMatches(sha256Hello, parseExpected('LPJNul-wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ')));
  assert.ok(digestMatches(sha256Hello, parseExpected('2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824')));

  // hashGenerate 本体（テキスト）
  const t = await hashGenerate({ text: 'hello' });
  assert.deepEqual(t.algorithms, ['md5', 'sha1', 'sha256', 'sha512']);
  assert.equal(t.hashes.md5, md5Hello);
  assert.equal(t.hashes.sha256, '2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824');
  assert.equal(t.hashes.sha384, undefined);
  assert.equal(t.source.bytes, 5);
  assert.equal(t.verification, undefined);
  assert.ok(t.notes.some((n) => n.includes('SHA-1')));

  // アルゴリズム・書式の指定
  const one = await hashGenerate({ text: 'hello', algorithms: ['sha256'], format: 'base64' });
  assert.deepEqual(one.algorithms, ['sha256']);
  assert.equal(one.hashes.sha256, 'LPJNul+wow4m6DsqxbninhsWHlwfp0JecwQzYpOLmCQ=');
  // MD5/SHA-1 を含めなければ「壊れている」の注意は出さない
  assert.ok(!one.notes.some((n) => n.includes('衝突耐性')));

  // 照合: 一致 / 不一致 / 読めない
  const hit = await hashGenerate({ text: 'hello', expected: `${md5Hello}  hello.txt` });
  assert.equal(hit.verification.matched, true);
  assert.equal(hit.verification.algorithm, 'md5');
  const miss = await hashGenerate({ text: 'HELLO', expected: md5Hello });
  assert.equal(miss.verification.matched, false);
  assert.equal(miss.verification.algorithm, 'md5');
  const unreadable = await hashGenerate({ text: 'hello', expected: 'nope' });
  assert.equal(unreadable.verification.matched, false);
  assert.equal(unreadable.verification.expected_format, 'unrecognized');
  // 算出していないアルゴリズムの桁数を渡された場合
  const other = await hashGenerate({ text: 'hello', algorithms: ['md5'], expected: 'a'.repeat(64) });
  assert.equal(other.verification.matched, false);
  assert.equal(other.verification.algorithm, null);

  // CRLF / BOM は結果を変え、notes に出る
  const crlf = await hashGenerate({ text: 'a\nb', newline: 'crlf' });
  const lf = await hashGenerate({ text: 'a\nb' });
  assert.notEqual(crlf.hashes.sha256, lf.hashes.sha256);
  assert.equal(crlf.source.bytes, 4);
  assert.ok(crlf.notes.some((n) => n.includes('CRLF')));
  const bom = await hashGenerate({ text: 'a', bom: true });
  assert.equal(bom.source.bytes, 4);
  assert.ok(bom.notes.some((n) => n.includes('BOM')));

  // ファイル入力（テキストと同じ値になること・照合が効くこと）
  {
    const { writeFile, rm, mkdtemp } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'firstch-hash-'));
    const file = join(dir, 'hello.txt');
    await writeFile(file, 'hello');
    const f = await hashGenerate({ path: file, expected: md5Hello });
    assert.equal(f.hashes.md5, md5Hello);
    assert.equal(f.source.type, 'file');
    assert.equal(f.source.name, 'hello.txt');
    assert.equal(f.source.bytes, 5);
    assert.equal(f.verification.matched, true);
    // newline / bom はファイルには効かない（中身をそのまま読む）
    const f2 = await hashGenerate({ path: file, newline: 'crlf', bom: true });
    assert.equal(f2.hashes.md5, md5Hello);
    await rm(dir, { recursive: true, force: true });
  }

  // 不正な入力は HashError
  await assert.rejects(() => hashGenerate({}), HashError);
  await assert.rejects(() => hashGenerate({ text: 'a', path: '/tmp/x' }), HashError);
  await assert.rejects(() => hashGenerate({ text: 'a', algorithms: ['sha3'] }), HashError);
  await assert.rejects(() => hashGenerate({ text: 'a', format: 'bogus' }), HashError);
  await assert.rejects(() => hashGenerate({ text: 'a', newline: 'cr' }), HashError);
}

// ==================== jwt_decode ====================
{
  const { createHmac, generateKeyPairSync, sign: nodeSign } = await import('node:crypto');
  const b64u = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');

  // RFC 7519 §3.1 の例（HS256・secret は "your-256-bit-secret" ではなく RFC の鍵ではないので
  // 署名は自前で作る）。まずはデコードだけを既知の値と突き合わせる
  const tok = b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u({ iss: 'joe', exp: 1300819380, 'http://example.com/is_root': true }) + '.sig';
  const d = decodeJwt(tok);
  assert.equal(d.ok, true);
  assert.equal(d.type, 'jws');
  assert.equal(d.header.alg, 'HS256');
  assert.equal(d.payload.iss, 'joe');
  assert.equal(d.payload.exp, 1300819380);
  assert.equal(d.signature, 'sig');

  // 入力の掃除: Authorization ヘッダー・Bearer・引用符・改行・末尾のカンマ
  assert.deepEqual(normalizeInput('Authorization: Bearer abc.def.ghi').token, 'abc.def.ghi');
  assert.deepEqual(normalizeInput('  "abc.def.ghi",  ').token, 'abc.def.ghi');
  assert.deepEqual(normalizeInput('abc.\ndef.\nghi').token, 'abc.def.ghi');
  assert.deepEqual(normalizeInput('Bearer abc.def.ghi').cleanups, ['bearer']);

  // base64url は標準Base64・パディング付きも受け入れる／長さが4n+1のものは弾く
  assert.equal(b64uToBytes('aGVsbG8').toString(), 'hello');
  assert.equal(b64uToBytes('aGVsbG8=').toString(), 'hello');
  assert.throws(() => b64uToBytes('aaaaa'), JwtError);

  // 有効期限の判定（now を固定）
  const now = 1786784400;
  const t1 = analyzeTiming({ iat: now - 600, exp: now + 600 }, now, 0);
  assert.equal(t1.status, 'valid');
  assert.equal(t1.remaining, 600);
  assert.equal(t1.lifetime, 1200);
  assert.equal(t1.progress, 0.5);
  assert.equal(analyzeTiming({ exp: now - 1 }, now, 0).status, 'expired');
  // 許容するズレを与えると期限切れの判定が後ろへずれる
  assert.equal(analyzeTiming({ exp: now - 30 }, now, 60).status, 'valid');
  assert.equal(analyzeTiming({ exp: now + 100, nbf: now + 50 }, now, 0).status, 'not_yet');
  assert.equal(analyzeTiming({ sub: 'a' }, now, 0).status, 'no_exp');
  // ミリ秒で入っている exp は秒へ直したうえで ms フラグを立てる
  const tms = analyzeTiming({ exp: 1786788000000 }, now, 0);
  assert.equal(tms.expMs, true);
  assert.equal(tms.exp, 1786788000);
  // 文字列の数値も読む
  assert.equal(analyzeTiming({ exp: '1786788000' }, now, 0).exp, 1786788000);

  assert.equal(formatDuration(0), '0秒');
  assert.equal(formatDuration(90), '1分30秒');
  assert.equal(formatDuration(3600), '1時間');
  assert.equal(formatDuration(86400 * 2 + 3600 * 3 + 60), '2日3時間');

  // HS256: 署名して検証する（node:crypto の HMAC と webcrypto の突合にもなる）
  const secret = 'firstch-tools-demo-secret-2026';
  const si = b64u({ alg: 'HS256', typ: 'JWT' }) + '.' + b64u({ sub: 'x', exp: now + 3600 });
  const hs = si + '.' + createHmac('sha256', secret).update(si).digest('base64url');

  const okRes = await jwtDecode({ token: hs, key: secret, now });
  assert.equal(okRes.verification.status, 'verified');
  assert.equal(okRes.expiry.status, 'valid');
  assert.equal(okRes.expiry.remaining_seconds, 3600);
  assert.equal(okRes.header.alg, 'HS256');
  assert.equal(okRes.payload.sub, 'x');
  // 検証できたら「検証していません」の指摘は出さない
  assert.equal(okRes.warnings.some((w) => w.includes('デコードは署名の検証ではありません')), false);

  const ngRes = await jwtDecode({ token: hs, key: 'wrong', now });
  assert.equal(ngRes.verification.status, 'failed');
  assert.ok(ngRes.verification.message.includes('一致しません'));

  // 鍵を渡さなければ検証しない（skipped）
  const skipRes = await jwtDecode({ token: hs, now });
  assert.equal(skipRes.verification.status, 'skipped');
  assert.ok(skipRes.warnings.some((w) => w.includes('デコードは署名の検証ではありません')));

  // 共有鍵の読み方（base64url / hex）
  const rawKey = Buffer.from('0123456789abcdef0123456789abcdef');
  const si2 = b64u({ alg: 'HS256' }) + '.' + b64u({ sub: 'y', exp: now + 60 });
  const hs2 = si2 + '.' + createHmac('sha256', rawKey).update(si2).digest('base64url');
  assert.equal((await jwtDecode({ token: hs2, key: rawKey.toString('base64url'), keyEncoding: 'base64url', now })).verification.status, 'verified');
  assert.equal((await jwtDecode({ token: hs2, key: rawKey.toString('hex'), keyEncoding: 'hex', now })).verification.status, 'verified');
  // oct の JWK でも検証できる
  assert.equal((await jwtDecode({ token: hs2, key: JSON.stringify({ kty: 'oct', k: rawKey.toString('base64url') }), now })).verification.status, 'verified');
  // 短い共有鍵は検証が通っても弱さを知らせる
  const shortRes = await jwtDecode({ token: hs, key: secret, now });
  assert.ok(shortRes.verification.warning.includes('RFC 7518'));

  // RS256: PEM公開鍵で検証する
  const rsa = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const rsSi = b64u({ alg: 'RS256', typ: 'JWT' }) + '.' + b64u({ sub: 'r', exp: now + 60 });
  const rs = rsSi + '.' + nodeSign('sha256', Buffer.from(rsSi), rsa.privateKey).toString('base64url');
  const rsPem = rsa.publicKey.export({ type: 'spki', format: 'pem' });
  assert.equal((await jwtDecode({ token: rs, key: rsPem, now })).verification.status, 'verified');
  // 公開鍵のJWKでも検証できる
  assert.equal((await jwtDecode({ token: rs, key: JSON.stringify(rsa.publicKey.export({ format: 'jwk' })), now })).verification.status, 'verified');

  // ES256: JWS の署名は R‖S の生の形（DER ではない）
  const ec = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const esSi = b64u({ alg: 'ES256', typ: 'JWT', kid: 'k2' }) + '.' + b64u({ sub: 'e', exp: now + 60 });
  const es = esSi + '.' + nodeSign('sha256', Buffer.from(esSi), { key: ec.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url');
  const ecJwk = ec.publicKey.export({ format: 'jwk' });
  assert.equal((await jwtDecode({ token: es, key: JSON.stringify(ecJwk), now })).verification.status, 'verified');
  // JWKS からは kid で選ぶ
  const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).publicKey.export({ format: 'jwk' });
  const jwks = JSON.stringify({ keys: [{ ...other, kid: 'k1' }, { ...ecJwk, kid: 'k2' }] });
  assert.equal((await jwtDecode({ token: es, key: jwks, now })).verification.status, 'verified');
  // kid が合わなければ先頭の鍵を使い、一致しない
  assert.equal((await jwtDecode({ token: es, key: JSON.stringify({ keys: [{ ...other, kid: 'k9' }] }), now })).verification.status, 'failed');
  // DER形式の署名は長さで弾く
  const esDer = esSi + '.' + nodeSign('sha256', Buffer.from(esSi), ec.privateKey).toString('base64url');
  const derRes = await jwtDecode({ token: esDer, key: JSON.stringify(ecJwk), now });
  assert.equal(derRes.verification.status, 'error');
  assert.ok(derRes.verification.message.includes('R‖S'));

  // EdDSA
  const ed = generateKeyPairSync('ed25519');
  const edSi = b64u({ alg: 'EdDSA', typ: 'JWT' }) + '.' + b64u({ sub: 'd', exp: now + 60 });
  const edTok = edSi + '.' + nodeSign(null, Buffer.from(edSi), ed.privateKey).toString('base64url');
  assert.equal((await jwtDecode({ token: edTok, key: ed.publicKey.export({ type: 'spki', format: 'pem' }), now })).verification.status, 'verified');

  // 秘密鍵・証明書・PKCS#1 は検証せず案内を返す
  const priv = await jwtDecode({ token: rs, key: rsa.privateKey.export({ type: 'pkcs8', format: 'pem' }), now });
  assert.equal(priv.verification.status, 'error');
  assert.ok(priv.verification.message.includes('公開鍵'));
  const p1 = await jwtDecode({ token: rs, key: '-----BEGIN RSA PUBLIC KEY-----\nMIIB\n-----END RSA PUBLIC KEY-----', now });
  assert.ok(p1.verification.message.includes('PKCS#1'));
  const cert = await jwtDecode({ token: rs, key: '-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----', now });
  assert.ok(cert.verification.message.includes('openssl x509'));

  // alg: none は検証しない
  const noneTok = b64u({ alg: 'none', typ: 'JWT' }) + '.' + b64u({ sub: 'a', admin: true }) + '.';
  const noneRes = await jwtDecode({ token: noneTok, key: 'anything', now });
  assert.equal(noneRes.verification.status, 'error');
  assert.ok(noneRes.warnings.some((w) => w.includes('alg: none')));
  assert.ok(noneRes.warnings.some((w) => w.includes('自然には失効しません')));

  // 指摘事項: 期限切れ・ミリ秒・秘密情報・長すぎる有効期間
  const expired = await jwtDecode({ token: b64u({ alg: 'HS256' }) + '.' + b64u({ exp: now - 3600 }) + '.x', now });
  assert.equal(expired.expiry.status, 'expired');
  assert.ok(expired.warnings.some((w) => w.includes('1時間 前に期限切れ')));
  const msTok = await jwtDecode({ token: b64u({ alg: 'HS256' }) + '.' + b64u({ exp: (now + 60) * 1000 }) + '.x', now });
  assert.ok(msTok.warnings.some((w) => w.includes('ミリ秒')));
  const secretTok = await jwtDecode({ token: b64u({ alg: 'HS256' }) + '.' + b64u({ sub: 'a', password: 'p', exp: now + 60 }) + '.x', now });
  assert.ok(secretTok.warnings.some((w) => w.includes('password')));
  const longTok = await jwtDecode({ token: b64u({ alg: 'HS256' }) + '.' + b64u({ iat: now, exp: now + 86400 * 400 }) + '.x', now });
  assert.ok(longTok.warnings.some((w) => w.includes('長すぎます')));

  // クレームの説明と日時
  const claims = (await jwtDecode({ token: hs, now })).claims;
  const sub = claims.find((c) => c.name === 'sub');
  assert.equal(sub.in, 'payload');
  assert.ok(sub.meaning.includes('Subject'));
  const expClaim = claims.find((c) => c.name === 'exp');
  assert.equal(expClaim.datetime, new Date((now + 3600) * 1000).toISOString());

  // JWE はヘッダーだけ返す
  const jwe = await jwtDecode({ token: b64u({ alg: 'RSA-OAEP', enc: 'A256GCM' }) + '.a.b.c.d', now });
  assert.equal(jwe.format, 'jwe');
  assert.equal(jwe.header.enc, 'A256GCM');
  assert.equal(jwe.payload, null);
  assert.ok(jwe.warnings.some((w) => w.includes('JWE')));

  // JWTでない入力
  const bad = await jwtDecode({ token: 'hello world', now });
  assert.equal(bad.decoded, false);
  assert.ok(bad.warnings.some((w) => w.includes('JWTとして読めません')));

  // 不正な引数は JwtError
  await assert.rejects(() => jwtDecode({}), JwtError);
  await assert.rejects(() => jwtDecode({ token: '   ' }), JwtError);
  await assert.rejects(() => jwtDecode({ token: hs, keyEncoding: 'rot13' }), JwtError);
  await assert.rejects(() => jwtDecode({ token: hs, clockTolerance: -1 }), JwtError);
}


// ==================== user_agent_parse ====================
{
  // site/user-agent/app.js と同じ判定結果になることを、代表的なUAで確かめる
  // （実ブラウザ側は site/_t の DOM 突合で同じ期待値を検証している）
  const CASES = [
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
      { browser: 'Google Chrome', major: '139', engine: 'Blink', os: 'Windows', osv: '10 / 11', type: 'desktop', cpu: 'x86-64 (64bit)' }],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36 Edg/139.0.0.0',
      { browser: 'Microsoft Edge', engine: 'Blink', os: 'Windows', type: 'desktop' }],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36 OPR/106.0.0.0',
      { browser: 'Opera', version: '106.0.0.0', engine: 'Blink' }],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
      { browser: 'Safari', version: '18.5', engine: 'WebKit', os: 'macOS', osv: '10.15.7', type: 'desktop' }],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
      { browser: 'Safari', engine: 'WebKit', os: 'iOS', osv: '18.5', type: 'mobile', vendor: 'Apple', model: 'iPhone' }],
    ['Mozilla/5.0 (iPad; CPU OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
      { os: 'iPadOS', osv: '18.5', type: 'tablet', vendor: 'Apple', model: 'iPad' }],
    ['Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/139.0.0.0 Mobile/15E148 Safari/604.1',
      { browser: 'Google Chrome', platform: 'iOS', engine: 'WebKit', os: 'iOS', type: 'mobile' }],
    ['Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36',
      { browser: 'Google Chrome', engine: 'Blink', os: 'Android', osv: '10', type: 'mobile', model: 'K' }],
    ['Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.6099.43 Mobile Safari/537.36',
      { os: 'Android', osv: '13', type: 'mobile', vendor: 'Google', model: 'Pixel 7' }],
    // Android は Mobile の有無だけがスマートフォンとタブレットの境目
    ['Mozilla/5.0 (Linux; Android 13; SM-X710) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      { type: 'tablet', vendor: 'Samsung', model: 'SM-X710' }],
    ['Mozilla/5.0 (Linux; Android 13; SM-G991B Build/TP1A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.0.0 Mobile Safari/537.36',
      { browser: 'Android WebView', os: 'Android', type: 'mobile', vendor: 'Samsung' }],
    ['Mozilla/5.0 (Linux; Android 13; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36',
      { browser: 'Samsung Internet', version: '23.0', engine: 'Blink', type: 'mobile', vendor: 'Samsung' }],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:141.0) Gecko/20100101 Firefox/141.0',
      { browser: 'Firefox', version: '141.0', engine: 'Gecko', os: 'Windows', type: 'desktop' }],
    ['Mozilla/5.0 (Windows NT 6.1; Trident/7.0; rv:11.0) like Gecko',
      { browser: 'Internet Explorer', version: '11.0', engine: 'Trident', os: 'Windows', osv: '7', type: 'desktop' }],
    ['Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/139.0.0.0 Safari/537.36',
      { browser: 'Headless Chrome', engine: 'Blink', os: 'Linux', type: 'desktop' }],
    ['Mozilla/5.0 (PlayStation; PlayStation 5/6.50) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Safari/605.1.15',
      { type: 'console', vendor: 'Sony' }],
    ['Mozilla/5.0 (SMART-TV; LINUX; Tizen 6.0) AppleWebKit/537.36 (KHTML, like Gecko) Version/6.0 TV Safari/537.36',
      { type: 'tv', vendor: 'Samsung', os: 'Tizen' }],
  ];
  for (const [ua, want] of CASES) {
    const r = userAgentParse({ ua });
    const label = ua.slice(0, 48);
    if (want.browser) assert.equal(r.browser.name, want.browser, label);
    if (want.version) assert.equal(r.browser.version, want.version, label);
    if (want.major) assert.equal(r.browser.major, want.major, label);
    if (want.platform) assert.equal(r.browser.platform, want.platform, label);
    if (want.engine) assert.equal(r.engine.name, want.engine, label);
    if (want.os) assert.equal(r.os.name, want.os, label);
    if (want.osv) assert.equal(r.os.version, want.osv, label);
    if (want.type) assert.equal(r.device.type, want.type, label);
    if (want.vendor) assert.equal(r.device.vendor, want.vendor, label);
    if (want.model) assert.equal(r.device.model, want.model, label);
    if (want.cpu) assert.equal(r.cpu, want.cpu, label);
    assert.equal(r.is_bot, false, label);
  }

  // ボットとHTTPクライアント
  const gb = userAgentParse({ ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' });
  assert.equal(gb.bot.name, 'Googlebot');
  assert.equal(gb.bot.category, 'search');
  assert.equal(gb.is_bot, true);
  assert.equal(gb.device.type, 'bot');
  assert.ok(gb.notes.some((n) => n.code === 'bot_spoof' && n.message.includes('逆引き')));

  const gpt = userAgentParse({ ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.1; +https://openai.com/gptbot' });
  assert.equal(gpt.bot.name, 'GPTBot');
  assert.equal(gpt.bot.category, 'ai');

  const curl = userAgentParse({ ua: 'curl/8.7.1' });
  assert.equal(curl.bot.name, 'curl');
  assert.equal(curl.bot.category, 'http');
  assert.equal(curl.bot.version, '8.7.1');

  // アプリ内ブラウザ
  const line = userAgentParse({ ua: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Line/15.2.0' });
  assert.equal(line.in_app_browser, 'LINE');
  assert.equal(line.os.name, 'iOS');
  assert.ok(line.notes.some((n) => n.code === 'inapp'));

  // アクセスログの行のまま渡せる（`User-Agent:`・引用符・末尾のカンマを剥がす）
  const raw = userAgentParse({ ua: 'User-Agent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36",' });
  assert.equal(raw.browser.name, 'Google Chrome');
  assert.equal(raw.os.name, 'macOS');
  assert.ok(raw.notes.some((n) => n.code === 'clean_header'));
  assert.ok(raw.notes.some((n) => n.code === 'clean_quoted'));

  // 「UAでは分からないこと」の指摘
  const win = userAgentParse({ ua: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36' });
  assert.ok(win.notes.some((n) => n.code === 'win_10_11'));
  assert.ok(win.notes.some((n) => n.code === 'reduced_chrome'));
  assert.ok(win.notes.some((n) => n.code === 'safari_token'));   // Chrome なのに Safari/ を含む
  assert.ok(win.notes.some((n) => n.code === 'client_hints'));
  assert.ok(win.notes.some((n) => n.code === 'spoofable'));
  const andr = userAgentParse({ ua: 'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Mobile Safari/537.36' });
  assert.ok(andr.notes.some((n) => n.code === 'reduced_android'));
  assert.ok(andr.notes.some((n) => n.code === 'model_k'));
  const mac = userAgentParse({ ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15' });
  assert.ok(mac.notes.some((n) => n.code === 'frozen_mac'));
  assert.ok(mac.notes.some((n) => n.code === 'ipad_desktop'));   // iPadと見分けが付かない
  const ie = userAgentParse({ ua: 'Mozilla/5.0 (Windows NT 6.1; Trident/7.0; rv:11.0) like Gecko' });
  assert.ok(ie.notes.some((n) => n.code === 'ie_eol'));
  assert.ok(ie.notes.some((n) => n.code === 'ie11_no_msie'));

  // トークンの分解と解説
  const toks = win.tokens.map((t) => t.token);
  assert.ok(toks.includes('Mozilla/5.0'));
  assert.ok(toks.includes('Windows NT 10.0'));
  assert.ok(toks.includes('KHTML, like Gecko'));
  assert.ok(toks.includes('Chrome/139.0.0.0'));
  assert.equal(win.tokens.find((t) => t.token === 'Safari/537.36').meaning.includes('部分一致'), true);
  // 括弧の中身は ; で分ける
  assert.deepEqual(
    tokenizeUA('Mozilla/5.0 (Linux; Android 13; Pixel 7)').filter((t) => t.kind === 'comment')[0].parts,
    ['Linux', 'Android 13', 'Pixel 7'],
  );

  // 複数件の一括解析と内訳
  const many = userAgentParse({
    uas: [
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/139.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
      'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
      'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
    ],
  });
  assert.equal(many.count, 4);
  assert.equal(many.summary.browsers['Google Chrome'], 2);
  assert.equal(many.summary.browsers.Safari, 1);
  assert.equal(many.summary.os.Windows, 2);
  assert.equal(many.summary.device_types.desktop, 2);
  assert.equal(many.summary.device_types.mobile, 1);
  assert.equal(many.summary.bots, 1);
  assert.equal(many.results.length, 4);

  // 判定できない入力でも落ちない
  const junk = userAgentParse({ ua: 'my-internal-agent' });
  assert.equal(junk.browser.name, null);
  assert.ok(junk.notes.some((n) => n.code === 'unknown'));

  // 不正な引数は UserAgentError
  assert.throws(() => userAgentParse({}), UserAgentError);
  assert.throws(() => userAgentParse({ ua: '   ' }), UserAgentError);
  assert.throws(() => userAgentParse({ ua: 'x', uas: ['y'] }), UserAgentError);
  assert.throws(() => userAgentParse({ uas: [1] }), UserAgentError);

  // 個別の関数も直接使える（site側と同じ分解）
  const ua = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
  const b = detectBrowser(ua);
  assert.equal(b.name, 'Google Chrome');
  assert.equal(detectEngine(ua, b).name, 'Blink');
  assert.equal(detectOS(ua).name, 'Android');
  assert.equal(detectDevice(ua, detectOS(ua), detectBot(ua), tokenizeUA(ua)).model, 'Pixel 7');
  assert.equal(detectInApp(ua), null);
  assert.equal(parseUserAgent(ua).ua, ua);
}


// ==================== uuid_generate ====================
{
  // site/uuid/app.js と同じ生成結果になることを、決め打ちの乱数で確かめる
  // （乱数を差し替えれば生成は決定的になる）
  const fixed = (byte) => (n) => Uint8Array.from({ length: n }, () => byte);
  const seq = (n) => Uint8Array.from({ length: n }, (_, i) => i & 0xff);

  // UUID v4: 13文字目が 4、17文字目が 8/9/a/b（バリアント 10xx）
  const u = generateIds({ type: 'uuid', count: 3, rand: seq });
  assert.equal(u.ids.length, 3);
  for (const id of u.ids) {
    assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.equal(id.length, 36);
  }
  // 0x00..0x0f のバイト列から作ると、バージョンとバリアントのビットだけが立つ
  assert.equal(uuidV4FromBytes(Uint8Array.from({ length: 16 }, (_, i) => i)), '00010203-0405-4607-8809-0a0b0c0d0e0f');
  // 全ビット1でも版とバリアントは固定される
  assert.equal(uuidV4FromBytes(Uint8Array.from({ length: 16 }, () => 0xff)), 'ffffffff-ffff-4fff-bfff-ffffffffffff');

  // ULID: 26文字・先頭10文字が時刻・Crockford Base32（I/L/O/U を含まない）
  const t = Date.UTC(2026, 7, 18, 12, 34, 56, 789);
  const ul = generateIds({ type: 'ulid', count: 5, time: t, rand: fixed(0) });
  assert.equal(ul.ids[0].length, 26);
  for (const id of ul.ids) assert.doesNotMatch(id, /[ILOU]/);
  assert.equal(decodeUlid(ul.ids[0]).time, t);
  assert.equal(ul.ids[0].slice(0, 10), encodeUlidTime(t));
  // 同一ミリ秒でも単調増加する＝辞書順が生成順と一致する
  assert.deepEqual(ul.ids, [...ul.ids].sort());
  assert.equal(ul.ids[0].slice(10), '0000000000000000');
  assert.equal(ul.ids[4].slice(10), '0000000000000004');
  // 桁上がり: 末尾が Z なら1つ上の桁へ繰り上がる
  assert.equal(bumpUlidRandom('000000000000000Z'), '0000000000000010');
  assert.equal(bumpUlidRandom('ZZZZZZZZZZZZZZZZ'), null);
  assert.equal(encodeUlidRandom(Uint8Array.from({ length: 16 }, () => 0x1f)), 'ZZZZZZZZZZZZZZZZ');
  // 時刻が進めば辞書順も進む
  assert.ok(encodeUlidTime(t) < encodeUlidTime(t + 1));
  assert.equal(encodeUlidTime(0), '0000000000');
  assert.equal(decodeUlid('not-a-ulid'), null);

  // 表記オプション（site側のチェックボックスと同じ挙動）
  const ids = ['3f2a9c14-7b6e-4d05-9a83-1c5ef0b27d41'];
  assert.equal(formatIds(ids, { type: 'uuid' }), '3f2a9c14-7b6e-4d05-9a83-1c5ef0b27d41');
  assert.equal(formatIds(ids, { type: 'uuid', uppercase: true }), '3F2A9C14-7B6E-4D05-9A83-1C5EF0B27D41');
  assert.equal(formatIds(ids, { type: 'uuid', hyphens: false }), '3f2a9c147b6e4d059a831c5ef0b27d41');
  assert.equal(formatIds(ids, { type: 'uuid', braces: true }), '{3f2a9c14-7b6e-4d05-9a83-1c5ef0b27d41}');
  assert.equal(formatIds(['a', 'b'], { type: 'uuid', format: 'csv' }), 'a,b');
  assert.equal(formatIds(['a', 'b'], { type: 'uuid', format: 'quoted' }), '"a",\n"b"');
  assert.deepEqual(JSON.parse(formatIds(['a', 'b'], { type: 'uuid', format: 'json' })), ['a', 'b']);
  // ULIDの既定は大文字（明示すれば小文字にもできる）
  assert.equal(formatIds(['01ARZ3NDEKTSV4RRFFQ69G5FAV'], { type: 'ulid' }), '01ARZ3NDEKTSV4RRFFQ69G5FAV');
  assert.equal(formatIds(['01ARZ3NDEKTSV4RRFFQ69G5FAV'], { type: 'ulid', uppercase: false }), '01arz3ndektsv4rrffq69g5fav');
  // ULIDにはハイフン/波括弧のオプションは効かない
  assert.equal(formatIds(['01ARZ3NDEKTSV4RRFFQ69G5FAV'], { type: 'ulid', braces: true, hyphens: false }), '01ARZ3NDEKTSV4RRFFQ69G5FAV');

  // ツール本体
  const r = uuidGenerate({ count: 10 });
  assert.equal(r.type, 'uuid');
  assert.equal(r.count, 10);
  assert.equal(r.ids.length, 10);
  assert.equal(r.duplicates, 0);
  assert.equal(r.length, 36);
  assert.equal(r.version, 4);
  assert.equal(r.text.split('\n').length, 10);
  assert.equal(new Set(r.ids).size, 10);

  const rj = uuidGenerate({ type: 'uuid', count: 3, format: 'json', hyphens: false, uppercase: true });
  assert.deepEqual(JSON.parse(rj.text), rj.ids);
  assert.equal(rj.length, 32);
  for (const id of rj.ids) assert.match(id, /^[0-9A-F]{32}$/);

  const rt = uuidGenerate({ type: 'ulid', count: 4, timestamp: '2026-08-18T12:34:56.789Z' });
  assert.equal(rt.timestamp.unix_ms, Date.parse('2026-08-18T12:34:56.789Z'));
  assert.equal(rt.timestamp.iso, '2026-08-18T12:34:56.789Z');
  assert.equal(rt.monotonic, true);
  assert.deepEqual(rt.ids, [...rt.ids].sort());
  for (const id of rt.ids) assert.equal(decodeUlid(id).time, rt.timestamp.unix_ms);
  // UNIX秒・ミリ秒でも同じ時刻になる
  assert.equal(uuidGenerate({ type: 'ulid', timestamp: 1786790096 }).timestamp.unix_ms, 1786790096000);
  assert.equal(uuidGenerate({ type: 'ulid', timestamp: 1786790096789 }).timestamp.unix_ms, 1786790096789);

  // 100件でも重複せず、ULIDは順序が保たれる
  const big = uuidGenerate({ type: 'ulid', count: 100 });
  assert.equal(big.ids.length, 100);
  assert.equal(big.duplicates, 0);
  assert.deepEqual(big.ids, [...big.ids].sort());

  // 不正な引数は UuidError
  assert.throws(() => uuidGenerate({ type: 'uuid7' }), UuidError);
  assert.throws(() => uuidGenerate({ count: 0 }), UuidError);
  assert.throws(() => uuidGenerate({ count: 101 }), UuidError);
  assert.throws(() => uuidGenerate({ count: 1.5 }), UuidError);
  assert.throws(() => uuidGenerate({ format: 'xml' }), UuidError);
  assert.throws(() => uuidGenerate({ type: 'uuid', timestamp: '2026-08-18' }), UuidError);
  assert.throws(() => uuidGenerate({ type: 'ulid', timestamp: 'yesterday' }), UuidError);
}



// ==================== aspect_ratio_calc ====================
{
  // 約分（site/aspect-ratio/app.js と同じ結果になること）
  assert.equal(arGcd(1920, 1080), 120);
  assert.equal(arGcd(0, 5), 5);
  assert.equal(arGcd(0, 0), 1);
  assert.deepEqual(arSimplify(1920, 1080), { w: 16, h: 9 });
  assert.deepEqual(arSimplify(3840, 2160), { w: 16, h: 9 });
  assert.deepEqual(arSimplify(1200, 630), { w: 40, h: 21 });
  assert.deepEqual(arSimplify(2560, 1080), { w: 64, h: 27 });
  assert.deepEqual(arSimplify(3440, 1440), { w: 43, h: 18 });
  // 小数は入力した桁数ぶん10倍してから約分する
  assert.deepEqual(arSimplify(1.85, 1), { w: 37, h: 20 });
  assert.deepEqual(arSimplify(2.39, 1), { w: 239, h: 100 });
  assert.deepEqual(arSimplify(1.5, 1), { w: 3, h: 2 });

  // 比率の読み取り（区切りは : / x × by、単独の数値は N:1）
  assert.deepEqual(arParseRatio('16:9'), { w: 16, h: 9 });
  assert.deepEqual(arParseRatio('16/9'), { w: 16, h: 9 });
  assert.deepEqual(arParseRatio('16x9'), { w: 16, h: 9 });
  assert.deepEqual(arParseRatio('1920 × 1080'), { w: 1920, h: 1080 });
  assert.deepEqual(arParseRatio('1.85'), { w: 1.85, h: 1 });
  assert.equal(arParseRatio('16:'), null);
  assert.equal(arParseRatio('0:9'), null);
  assert.equal(arParseRatio('-16:9'), null);
  assert.equal(arParseRatio(''), null);

  // 連分数展開: 1.7778 は分母50以下では 16:9 が最良
  const ap = arApprox(1.7778, 50);
  assert.equal(ap.w, 16);
  assert.equal(ap.h, 9);
  assert.ok(ap.error < 0.01);
  assert.deepEqual([arApprox(0.5625, 50).w, arApprox(0.5625, 50).h], [9, 16]);
  assert.equal(arApprox(0, 50), null);

  // いちばん近い定番比率
  assert.equal(arNearestPreset(16 / 9).key, 'HD');
  assert.equal(arNearestPreset(1200 / 630).key, 'OGP');
  assert.equal(arNearestPreset(2560 / 1080).key, 'ULTRA_REAL');
  assert.equal(arNearestPreset(1080 / 1350).key, 'PORTRAIT_45');

  // 丸め方
  assert.equal(arRound(768.375, 'round'), 768);
  assert.equal(arRound(768.375, 'floor'), 768);
  assert.equal(arRound(768.375, 'ceil'), 769);
  assert.equal(arRound(768.375, 'even'), 768);
  assert.equal(arRound(769, 'even'), 770);
  assert.equal(arRound(1, 'even'), 2);
  assert.equal(arRound(720.0000001, 'none'), 720);

  // 比率＋幅 → 高さ
  const s1 = arSize({ ratioW: 16, ratioH: 9, width: 1280 });
  assert.equal(s1.height, 720);
  assert.equal(s1.exact, true);
  assert.equal(s1.css, 'aspect-ratio: 16 / 9;');
  assert.equal(Math.round(s1.paddingTop * 100) / 100, 56.25);
  // 比率＋高さ → 幅
  assert.equal(arSize({ ratioW: 16, ratioH: 9, height: 1080 }).width, 1920);
  // 割り切れない幅
  const s2 = arSize({ ratioW: 16, ratioH: 9, width: 1366, round: 'round' });
  assert.equal(s2.exactHeight, 768.375);
  assert.equal(s2.height, 768);
  assert.equal(s2.exact, false);
  assert.equal(s2.rounded, true);
  assert.ok(Math.abs(s2.errorPercent) < 0.1);
  assert.equal(arSize({ ratioW: 16, ratioH: 9 }), null);
  assert.equal(arSize({ ratioW: 0, ratioH: 9, width: 100 }), null);

  // 寸法 → 比率
  const m = arRatioOf(1920, 1080);
  assert.deepEqual(m.ratio, { w: 16, h: 9 });
  assert.equal(m.known, 'FHD');
  assert.equal(m.orientation, 'landscape');
  assert.equal(Math.round(m.megapixels * 100) / 100, 2.07);
  assert.equal(arRatioOf(1080, 1920).orientation, 'portrait');
  assert.equal(arRatioOf(500, 500).orientation, 'square');
  assert.equal(arRatioOf(0, 100), null);

  // はめ込み: 1920×1080 を 1280×400 へ
  const cover = arFit({ srcW: 1920, srcH: 1080, boxW: 1280, boxH: 400, mode: 'cover' });
  assert.equal(cover.width, 1280);
  assert.equal(cover.height, 720);
  assert.equal(cover.cropY, 160);
  assert.equal(cover.cropX, 0);
  assert.equal(Math.round(cover.visiblePercent * 100) / 100, 55.56);
  const contain = arFit({ srcW: 1920, srcH: 1080, boxW: 1280, boxH: 400, mode: 'contain' });
  assert.equal(Math.round(contain.width), 711);
  assert.equal(contain.height, 400);
  assert.equal(Math.round(contain.barX * 100) / 100, 284.44);
  assert.equal(contain.barY, 0);
  // 比率が同じなら contain と cover は一致する
  const same = arFit({ srcW: 1920, srcH: 1080, boxW: 640, boxH: 360, mode: 'cover' });
  assert.equal(same.width, 640);
  assert.equal(same.height, 360);
  assert.equal(same.cropX, 0);
  assert.equal(same.cropY, 0);

  // 早見表
  const rows = arTable({ ratioW: 16, ratioH: 9, widths: [320, 768, 1280, 1920] });
  assert.deepEqual(rows.map((r) => r.height), [180, 432, 720, 1080]);
  assert.equal(rows[0].exact, true);
  assert.equal(arTable({ ratioW: 16, ratioH: 9 }).length, 8);
  assert.equal(arTable({ ratioW: 0, ratioH: 9 }).length, 0);

  // スニペット
  const sn = arSnippet({ ratioW: 16, ratioH: 9, selector: '.hero', target: 'img', fit: 'cover', width: 1280 });
  assert.ok(sn.css.includes('.hero {'));
  assert.ok(sn.css.includes('aspect-ratio: 16 / 9;'));
  assert.ok(sn.css.includes('object-fit: cover;'));
  assert.ok(sn.html.includes('width="1280" height="720"'));
  assert.ok(!sn.css.includes('@supports'));
  const snf = arSnippet({ ratioW: 16, ratioH: 9, fallback: true });
  assert.ok(snf.css.includes('@supports not (aspect-ratio: 1 / 1)'));
  assert.ok(snf.css.includes('padding-top: 56.25%;'));
  const sni = arSnippet({ ratioW: 16, ratioH: 9, target: 'iframe' });
  assert.ok(sni.css.includes('border: 0;'));
  assert.ok(!sni.css.includes('object-fit'));
  assert.ok(sni.html.includes('<iframe'));

  // ツール本体: 比率＋幅
  const r1 = aspectRatioCalc({ ratio: '16:9', width: 1280 });
  assert.equal(r1.mode, 'size');
  assert.equal(r1.height, 720);
  assert.equal(r1.ratio.text, '16:9');
  assert.equal(r1.padding_top, '56.25%');
  assert.equal(r1.css, 'aspect-ratio: 16 / 9;');
  assert.ok(r1.notes.some((n) => n.code === 'KNOWN_SIZE'));
  assert.ok(r1.notes.some((n) => n.code === 'EXACT'));

  // 奇数を含む結果には動画向けの指摘が付く
  const r2 = aspectRatioCalc({ ratio: '16:9', width: 1366, round: 'round' });
  assert.equal(r2.height, 768);
  assert.ok(r2.notes.some((n) => n.code === 'NOT_INTEGER'));
  assert.ok(r2.notes.some((n) => n.code === 'ROUNDED'));
  const r3 = aspectRatioCalc({ ratio: '16:9', width: 1000, round: 'round' });
  assert.equal(r3.height, 563);
  assert.ok(r3.notes.some((n) => n.code === 'ODD_DIMENSION'));
  assert.equal(aspectRatioCalc({ ratio: '16:9', width: 1000, round: 'even' }).height, 562);

  // 寸法だけ → 比率
  const r4 = aspectRatioCalc({ width: 1920, height: 1080 });
  assert.equal(r4.mode, 'measure');
  assert.equal(r4.ratio.text, '16:9');
  assert.equal(r4.known, 'FHD（1080p）');
  assert.equal(r4.nearest.error_percent, 0);
  assert.ok(r4.notes.some((n) => n.code === 'NEAREST_EXACT'));

  // 21:9 は実機と違うという指摘が付く（約分すると 7:3 なので判定は小数で行う）
  const r21 = aspectRatioCalc({ ratio: '21:9', width: 2560 });
  assert.equal(r21.ratio.text, '7:3');
  assert.ok(r21.notes.some((n) => n.code === 'ULTRAWIDE'));
  assert.equal(aspectRatioCalc({ width: 2560, height: 1080 }).ratio.text, '64:27');
  assert.ok(aspectRatioCalc({ width: 2560, height: 1080 }).notes.every((n) => n.code !== 'ULTRAWIDE'));

  // round='none' は丸めていない（1e-6 の桁揃えを「丸めた」と言わない）
  assert.equal(aspectRatioCalc({ ratio: '21:9', width: 2560 }).rounded, false);
  assert.equal(aspectRatioCalc({ ratio: '16:9', width: 1280 }).rounded, false);
  assert.ok(aspectRatioCalc({ ratio: '21:9', width: 2560 }).notes.every((n) => n.code !== 'ROUNDED'));
  assert.equal(aspectRatioCalc({ ratio: '16:9', width: 1366, round: 'round' }).rounded, true);

  // 比率だけ
  const r5 = aspectRatioCalc({ ratio: '1.85' });
  assert.equal(r5.mode, 'ratio');
  assert.equal(r5.ratio.text, '37:20');
  assert.equal(r5.css, 'aspect-ratio: 37 / 20;');

  // はめ込み・早見表・スニペット
  const r6 = aspectRatioCalc({ width: 1920, height: 1080, box: '1280x400', fit: 'cover' });
  assert.equal(r6.fit.mode, 'cover');
  assert.equal(r6.fit.crop_y, 160);
  assert.equal(r6.fit.same_ratio, false);
  const r7 = aspectRatioCalc({ ratio: '16:9', width: 1280, widths: [320, 768], snippet: true });
  assert.deepEqual(r7.table.map((t) => t.height), [180, 432]);
  assert.ok(r7.snippet.css.includes('aspect-ratio: 16 / 9;'));
  assert.ok(r7.snippet.html.includes('width="1280" height="720"'));
  assert.equal(aspectRatioCalc({ ratio: '16:9', width: 1280, table: true }).table.length, 8);

  // 不正な引数は AspectRatioError
  assert.throws(() => aspectRatioCalc({}), AspectRatioError);
  assert.throws(() => aspectRatioCalc({ width: 1920 }), AspectRatioError);
  assert.throws(() => aspectRatioCalc({ ratio: 'あ:い', width: 100 }), AspectRatioError);
  assert.throws(() => aspectRatioCalc({ ratio: '16:9', width: 0 }), AspectRatioError);
  assert.throws(() => aspectRatioCalc({ ratio: '16:9', width: -5 }), AspectRatioError);
  assert.throws(() => aspectRatioCalc({ ratio: '16:9', width: 100, round: 'nearest' }), AspectRatioError);
  assert.throws(() => aspectRatioCalc({ ratio: '16:9', width: 100, box: 'wide' }), AspectRatioError);
  assert.throws(() => aspectRatioCalc({ ratio: '16:9', width: 100, box: '1280x400', fit: 'fill' }), AspectRatioError);
}


console.log('all tests passed');
