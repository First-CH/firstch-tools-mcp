#!/usr/bin/env node
// First CH Tools MCP サーバー（stdio）
// 導入例: npx -y @first-ch/tools-mcp
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { appendFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { contrastCheck, countChars, buildLlmsTxt, buildJsonLd, analyzeEncoding, convertEncoding } from './lib.mjs';
import { generateTestData, FIELDS, DEFAULT_FIELDS, PRESETS } from './testdata.mjs';
import { convertToWebp } from './webp.mjs';

const { version } = createRequire(import.meta.url)('./package.json');
const server = new McpServer({ name: 'firstch-tools', version });

const asText = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] });

// 社内利用の計測（tools-strategy.md KPI 5）。環境変数を設定したときだけローカルJSONLに追記する
// （opt-in・未設定なら一切記録しない）。ネットワーク送信は一切しない。
// 集計は FirstCHOps 側 scripts/tools/tools-usage-report.py。計測失敗でツール本体は止めない。
const USAGE_LOG = process.env.FIRSTCH_TOOLS_USAGE_LOG; // 未設定なら記録しない（opt-in）
const logUsage = (tool) =>
  USAGE_LOG
    ? appendFile(USAGE_LOG, JSON.stringify({ ts: new Date().toISOString(), tool, source: 'mcp' }) + '\n').catch(() => {})
    : Promise.resolve();

server.registerTool(
  'contrast_check',
  {
    title: 'WCAGコントラスト比チェック',
    description:
      '文字色と背景色のWCAG 2.1コントラスト比を計算し、AA/AAA基準（通常/大テキスト・UI部品）の合否を返す。' +
      'Webデザインの配色検証・アクセシビリティチェックに使う。',
    inputSchema: {
      fg: z.string().describe('文字色（hex。例: #333333 / 333 / fff）'),
      bg: z.string().describe('背景色（hex。例: #ffffff）'),
    },
  },
  async ({ fg, bg }) => {
    await logUsage('contrast_check');
    return asText(contrastCheck(fg, bg));
  },
);

server.registerTool(
  'count_chars',
  {
    title: '文字数カウント（Xウェイト対応）',
    description:
      '日本語テキストの文字数（書記素単位）・全角/半角内訳・行数と、X(Twitter)の投稿ウェイト' +
      '（全角=2・半角=1・URL=一律23、上限280）を返す。SNS投稿や文字数制限のあるフォーム入力の検証に使う。',
    inputSchema: {
      text: z.string().describe('カウント対象のテキスト'),
    },
  },
  async ({ text }) => {
    await logUsage('count_chars');
    return asText(countChars(text));
  },
);

server.registerTool(
  'webp_convert',
  {
    title: '画像→WebP変換',
    description:
      'PNG/JPEG画像ファイルをWebPへ変換して保存する。エンコーダは tools.first-ch.com/webp/ と同一の' +
      'libwebp WASM（品質既定80）。Web制作の画像最適化・納品前の軽量化に使う。' +
      '入力は絶対パス。出力先を省略すると入力と同じ場所に拡張子.webpで保存する。',
    inputSchema: {
      paths: z.array(z.string()).min(1).describe('変換するPNG/JPEGファイルの絶対パスの配列'),
      quality: z.number().int().min(1).max(100).optional().describe('品質1-100（既定80）'),
      outputDir: z.string().optional().describe('出力先ディレクトリ（省略時は各入力と同じ場所）'),
    },
  },
  async ({ paths, quality, outputDir }) => {
    await logUsage('webp_convert');
    const { join, basename } = await import('node:path');
    const results = [];
    for (const p of paths) {
      try {
        const output = outputDir ? join(outputDir, basename(p).replace(/\.[^.]+$/, '') + '.webp') : undefined;
        results.push(await convertToWebp(p, { quality, output }));
      } catch (e) {
        results.push({ input: p, error: String(e.message || e) });
      }
    }
    return asText({ converted: results.filter((r) => !r.error).length, results });
  },
);

server.registerTool(
  'jsonld_generate',
  {
    title: 'JSON-LD構造化データ生成',
    description:
      'schema.org準拠のJSON-LD構造化データを生成する（tools.first-ch.com/jsonld/ と同一ロジック）。' +
      '対応タイプ: organization（会社情報）/ faqpage（よくある質問）/ service（提供サービス）/ breadcrumb（パンくず）。' +
      '空の項目は出力から自動で省略される。返り値は json オブジェクトと <script> スニペット。',
    inputSchema: {
      type: z.enum(['organization', 'faqpage', 'service', 'breadcrumb']).describe('スキーマタイプ'),
      organization: z
        .object({
          name: z.string().optional(),
          alternateName: z.string().optional(),
          url: z.string().optional(),
          logo: z.string().optional(),
          description: z.string().optional(),
          sameAs: z.array(z.string()).optional().describe('SNS・外部プロフィールURL'),
        })
        .optional()
        .describe('type=organization のときの項目'),
      faq: z
        .array(z.object({ q: z.string().describe('質問'), a: z.string().describe('回答') }))
        .optional()
        .describe('type=faqpage のときのQ&Aリスト'),
      service: z
        .object({
          name: z.string().optional(),
          serviceType: z.string().optional(),
          description: z.string().optional(),
          url: z.string().optional(),
          areaServed: z.string().optional(),
          providerName: z.string().optional(),
          providerUrl: z.string().optional(),
        })
        .optional()
        .describe('type=service のときの項目'),
      breadcrumb: z
        .array(z.object({ name: z.string(), url: z.string().optional().describe('最下層（現在ページ）は省略可') }))
        .optional()
        .describe('type=breadcrumb のときの階層リスト（上から position 1,2,3…）'),
    },
  },
  async ({ type, organization, faq, service, breadcrumb }) => {
    await logUsage('jsonld_generate');
    const fields = { organization, faqpage: { faq }, service, breadcrumb: { items: breadcrumb } }[type];
    return asText(buildJsonLd(type, fields || {}));
  },
);

server.registerTool(
  'llmstxt_generate',
  {
    title: 'llms.txt 生成',
    description:
      '生成AI・AI検索にサイト概要を伝える llms.txt（llmstxt.org 提案フォーマット準拠）を生成する' +
      '（tools.first-ch.com/llms-txt/ と同一ロジック）。生成テキストをサイトのルート（/llms.txt）に設置して使う。',
    inputSchema: {
      siteName: z.string().describe('サイト名（H1になる）'),
      summary: z.string().optional().describe('サイト概要（引用ブロックになる・改行可）'),
      notes: z.string().optional().describe('補足説明（自由記述の段落）'),
      sections: z
        .array(
          z.object({
            title: z.string().describe('セクション見出し（例: Main Pages / Optional）'),
            links: z.array(
              z.object({
                title: z.string().describe('ページタイトル'),
                url: z.string().describe('ページURL'),
                note: z.string().optional().describe('1行説明'),
              }),
            ),
          }),
        )
        .optional()
        .describe('リンクセクション（順に出力される）'),
    },
  },
  async (spec) => {
    await logUsage('llmstxt_generate');
    return asText({ text: buildLlmsTxt(spec) });
  },
);

server.registerTool(
  'encoding_convert',
  {
    title: '文字コード・改行コード変換',
    description:
      'CSV/テキストの文字コード（UTF-8 / Shift_JIS）・BOM有無・改行コード（CRLF/LF/CR）を判定し、UTF-8へ変換する。' +
      '顧客から受け取ったCSVの文字化け調査、フォーム取り込みデータの前処理、' +
      'リポジトリ内ファイルの改行コード事故（CRLFがLFに書き換わる等）の確認に使う。' +
      'mode=analyze なら判定のみ、mode=convert なら変換後のテキストとbase64を返す。',
    inputSchema: {
      base64: z.string().describe('対象ファイルの内容（base64）。テキストを直接渡す場合は text を使う'),
      text: z.string().optional().describe('base64の代わりにテキストを直接渡す場合（UTF-8として扱う）'),
      mode: z.enum(['analyze', 'convert']).optional().describe('既定 analyze。convert で変換結果を返す'),
      encoding: z.enum(['utf-8', 'shift_jis']).optional().describe('入力の文字コード。省略時は自動判定'),
      newline: z.enum(['LF', 'CRLF', 'CR']).optional().describe('変換後の改行コード（mode=convert のとき）'),
      bom: z.boolean().optional().describe('変換後にUTF-8 BOMを付けるか（既定 false）'),
    },
  },
  async ({ base64, text, mode, encoding, newline, bom }) => {
    await logUsage('encoding_convert');
    if (!base64 && text === undefined) throw new Error('base64 か text のどちらかが必要です');
    const bytes = base64
      ? Uint8Array.from(Buffer.from(base64, 'base64'))
      : new TextEncoder().encode(text);
    if (mode === 'convert') return asText(convertEncoding(bytes, { encoding, newline, bom }));
    const { text: _drop, ...info } = analyzeEncoding(bytes, encoding);
    return asText(info);
  },
);

server.registerTool(
  'testdata_generate',
  {
    title: 'テストデータ生成（ダミーCSV/JSON・境界値テキスト）',
    description:
      'フォーム入力テスト・CSV取り込みテスト用のダミーデータを生成する。' +
      'mode=records（既定）は氏名・フリガナ・住所・郵便番号・メール・電話番号などをCSV/TSV/JSONで返し、' +
      '文字コード（UTF-8 / Shift_JIS）・BOM・改行コード（LF/CRLF）を指定できる。' +
      'mode=text は maxlength の境界値テスト用に、指定文字種で n-1 / n / n+1 文字ちょうどの文字列を返す。' +
      '生成データはすべて架空（メールは RFC 2606 の example.com 系）。seed を渡すと同じデータを再現できる。',
    inputSchema: {
      mode: z.enum(['records', 'text']).optional().describe('既定 records。text は文字種・境界値テキスト'),
      rows: z.number().int().min(1).max(1000).optional().describe('行数（既定10・最大1000）'),
      fields: z
        .array(z.enum(FIELDS))
        .optional()
        .describe(`出力する列（既定: ${DEFAULT_FIELDS.join(',')}）。locale=en では name_kana / name_romaji は空になる`),
      format: z.enum(['csv', 'tsv', 'json']).optional().describe('出力形式（既定 csv）'),
      locale: z.enum(['ja', 'en']).optional().describe('データの言語（既定 ja。氏名・住所・電話番号の体系が変わる）'),
      encoding: z.enum(['utf-8', 'shift_jis']).optional().describe('文字コード（既定 utf-8）。shift_jis のときは base64 も返す'),
      newline: z.enum(['LF', 'CRLF']).optional().describe('改行コード（既定 LF）'),
      bom: z.boolean().optional().describe('UTF-8 BOMを付けるか（既定 false・Excelで開くCSV向け）'),
      header: z.boolean().optional().describe('ヘッダー行を付けるか（既定 true・csv/tsvのみ）'),
      seed: z.string().optional().describe('乱数シード。同じ値なら常に同じデータを生成する（省略時はランダム）'),
      preset: z.enum(PRESETS).optional().describe('mode=text の文字種（既定 mixed）'),
      length: z.number().int().min(1).max(10000).optional().describe('mode=text の文字数N（既定20・最大10000）'),
      outputPath: z.string().optional().describe('指定するとその絶対パスへファイルとして書き出す（mode=records のみ）'),
    },
  },
  async (opts) => {
    await logUsage('testdata_generate');
    const { _bytes, ...result } = generateTestData(opts);
    if (opts.outputPath && result.mode === 'records') {
      await writeFile(opts.outputPath, _bytes);
      result.output = opts.outputPath;
    }
    return asText(result);
  },
);

await server.connect(new StdioServerTransport());
