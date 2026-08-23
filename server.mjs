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
import { renderMarp } from './marp.mjs';
import { diffCheck } from './diff.mjs';
import { cronExplain } from './cron.mjs';
import { base64Convert } from './base64.mjs';
import { urlParams } from './url.mjs';
import { htmlEscape } from './html-escape.mjs';
import { jsonToYaml, yamlToJson } from './json-yaml.mjs';
import { pxRemConvert } from './px-rem.mjs';
import { colorConvert } from './color.mjs';
import { hashGenerate } from './hash.mjs';
import { jwtDecode } from './jwt.mjs';
import { userAgentParse } from './user-agent.mjs';
import { uuidGenerate, MAX_COUNT as UUID_MAX_COUNT } from './uuid.mjs';
import { aspectRatioCalc } from './aspect-ratio.mjs';
import { markdownTable } from './markdown-table.mjs';
import { sqlFormatTool } from './sql-format.mjs';
import { qrGenerateTool } from './qr.mjs';
import { unixtimeConvert } from './unixtime.mjs';

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
  'marp_render',
  {
    title: 'Marp Markdown→スライド レンダリング',
    description:
      'Marp Markdown をスライドへレンダリングし、HTML（テーマCSSをインラインした自己完結ファイル）や PDF を書き出す。' +
      'AIが生成したスライド用Markdownをそのまま渡せば描画まで完結する（社内の marp ビルドの定型化・顧客配布資料の生成に使う）。' +
      '和文テーマ firstch（firstch-design 準拠・紙/墨/朱・IBM Plex Sans JP）を同梱し、既定テーマにする。' +
      'Markdown 側の Marp フロントマター（例: theme:/paginate:/size:/`<!-- _class: lead -->`）はそのまま効く。' +
      'PDF はローカルの Chrome/Chromium を headless で呼び出して生成する（未検出なら HTML のみ返し理由を添える。' +
      '環境変数 MARP_CHROME_PATH で実行ファイルを明示可）。完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      markdown: z.string().optional().describe('Marp Markdown 本文（inputPath と排他・どちらか必須）'),
      inputPath: z.string().optional().describe('Markdownファイルの絶対パス（markdown 未指定時に読み込む）'),
      theme: z
        .enum(['firstch', 'default', 'gaia', 'uncover'])
        .optional()
        .describe('既定テーマ（既定 firstch＝和文）。Markdown内の theme 指示が優先される'),
      formats: z
        .array(z.enum(['html', 'pdf']))
        .optional()
        .describe("出力フォーマット（既定 ['html']）。['html','pdf'] で両方"),
      outputPath: z
        .string()
        .optional()
        .describe('出力ファイルのベースパス（拡張子は自動。省略時は inputPath 準拠、無ければ一時ディレクトリ）'),
      title: z.string().optional().describe('HTML の <title>（既定 "Marp slides"）'),
    },
  },
  async ({ markdown, inputPath, theme, formats, outputPath, title }) => {
    await logUsage('marp_render');
    let md = markdown;
    let outBase = outputPath;
    let docTitle = title;
    if ((md === undefined || md === '') && inputPath) {
      const { readFile } = await import('node:fs/promises');
      const { basename, extname } = await import('node:path');
      md = await readFile(inputPath, 'utf8');
      if (!outBase) outBase = inputPath; // 既定は入力と同じ場所・同名
      if (!docTitle) docTitle = basename(inputPath, extname(inputPath));
    }
    if (md === undefined || md === '') throw new Error('markdown か inputPath のどちらかが必要です');
    return asText(await renderMarp(md, { theme, formats, outputPath: outBase, title: docTitle }));
  },
);

server.registerTool(
  'testdata_generate',
  {
    title: 'テストデータ生成（ダミーCSV/JSON/Excel・境界値テキスト）',
    description:
      'フォーム入力テスト・CSV取り込みテスト用のダミーデータを生成する。' +
      'mode=records（既定）は氏名・フリガナ・住所・郵便番号・メール・電話番号などをCSV/TSV/JSON/XLSXで返し、' +
      '文字コード（UTF-8 / Shift_JIS）・BOM・改行コード（LF/CRLF）を指定できる。' +
      'format=xlsx は Excel の .xlsx ファイル（バイナリ）を base64 で返す。outputPath を併せて渡すとファイルに書き出せる。' +
      'mode=text は maxlength の境界値テスト用に、指定文字種で n-1 / n / n+1 文字ちょうどの文字列を返す。' +
      '生成データはすべて架空（メールは RFC 2606 の example.com 系）。seed を渡すと同じデータを再現できる。',
    inputSchema: {
      mode: z.enum(['records', 'text']).optional().describe('既定 records。text は文字種・境界値テキスト'),
      rows: z.number().int().min(1).max(1000).optional().describe('行数（既定10・最大1000）'),
      fields: z
        .array(z.enum(FIELDS))
        .optional()
        .describe(`出力する列（既定: ${DEFAULT_FIELDS.join(',')}）。locale=en では name_kana / name_romaji は空になる`),
      format: z.enum(['csv', 'tsv', 'json', 'xlsx']).optional().describe('出力形式（既定 csv）。xlsx は Excel ファイルを base64 で返す'),
      locale: z.enum(['ja', 'en']).optional().describe('データの言語（既定 ja。氏名・住所・電話番号の体系が変わる）'),
      encoding: z.enum(['utf-8', 'shift_jis']).optional().describe('文字コード（既定 utf-8）。shift_jis のときは base64 も返す。xlsx では無視される'),
      newline: z.enum(['LF', 'CRLF']).optional().describe('改行コード（既定 LF）。xlsx では無視される'),
      bom: z.boolean().optional().describe('UTF-8 BOMを付けるか（既定 false・Excelで開くCSV向け）。xlsx では無視される'),
      header: z.boolean().optional().describe('ヘッダー行を付けるか（既定 true・csv/tsv/xlsxのみ）'),
      seed: z.string().optional().describe('乱数シード。同じ値なら常に同じデータを生成する（省略時はランダム）'),
      preset: z.enum(PRESETS).optional().describe('mode=text の文字種（既定 mixed）'),
      length: z.number().int().min(1).max(10000).optional().describe('mode=text の文字数N（既定20・最大10000）'),
      outputPath: z.string().optional().describe('指定するとその絶対パスへファイルとして書き出す（mode=records のみ・format=xlsx では実質必須）'),
    },
  },
  async (opts) => {
    await logUsage('testdata_generate');
    const { _bytes, ...result } = generateTestData(opts);
    if (opts.outputPath && result.mode === 'records') {
      await writeFile(opts.outputPath, _bytes);
      result.output = opts.outputPath;
      // ファイルに書けたなら base64 は重複した重い情報でしかない
      delete result.base64;
    }
    return asText(result);
  },
);

server.registerTool(
  'diff_check',
  {
    title: 'テキスト・コード差分チェック',
    description:
      '2つのテキスト（またはファイル）を比較し、追加・削除・変更の件数と unified diff（.patch）を返す' +
      '（tools.first-ch.com/diff/ と同一ロジック）。原稿の推敲差分の確認、コード修正のレビュー、' +
      '設定ファイルの比較、AIが書き換えた文章の変更点の抽出に使う。' +
      '行の対応づけは patience diff（両方に1回だけ現れる行をアンカーに分割）＋アンカーの取れない範囲だけ Myers。' +
      'format=blocks / both では、変更行のペアを語単位（英数字はひとかたまり・和文は1文字ずつ）で比較した ' +
      'changed_parts も返すため、「どの語が変わったか」まで取れる。完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      a: z.string().optional().describe('変更前のテキスト（pathA と排他・どちらか必須）'),
      b: z.string().optional().describe('変更後のテキスト（pathB と排他・どちらか必須）'),
      pathA: z.string().optional().describe('変更前ファイルの絶対パス（a 未指定時に読み込む・UTF-8）'),
      pathB: z.string().optional().describe('変更後ファイルの絶対パス（b 未指定時に読み込む・UTF-8）'),
      format: z
        .enum(['unified', 'blocks', 'both'])
        .optional()
        .describe('既定 unified。blocks は変更ブロックの配列、both は両方'),
      context: z.number().int().min(0).max(100).optional().describe('unified diff の前後コンテキスト行数（既定3）'),
      ignoreWhitespace: z.boolean().optional().describe('空白の違いを無視するか（既定 false）'),
      ignoreCase: z.boolean().optional().describe('大文字・小文字の違いを無視するか（既定 false）'),
      words: z.boolean().optional().describe('語単位の変更点も求めるか（既定 true・format=blocks/both で返る）'),
    },
  },
  async ({ a, b, pathA, pathB, format, context, ignoreWhitespace, ignoreCase, words }) => {
    await logUsage('diff_check');
    let textA = a;
    let textB = b;
    if (textA === undefined && pathA) {
      const { readFile } = await import('node:fs/promises');
      textA = await readFile(pathA, 'utf8');
    }
    if (textB === undefined && pathB) {
      const { readFile } = await import('node:fs/promises');
      textB = await readFile(pathB, 'utf8');
    }
    if (textA === undefined || textB === undefined) {
      throw new Error('a/b（テキスト）か pathA/pathB（ファイルパス）で、両側の入力を渡してください');
    }
    return asText(
      diffCheck(textA, textB, {
        format,
        context,
        ignoreWhitespace,
        ignoreCase,
        words,
        nameA: pathA || 'a',
        nameB: pathB || 'b',
      }),
    );
  },
);

server.registerTool(
  'cron_explain',
  {
    title: 'Cron式の解説＋次回発火日時',
    description:
      'Cron式（例: */15 * * * *）を人間向けの文へ読み下し、次回からの発火日時を返す' +
      '（tools.first-ch.com/cron/ と同一ロジック）。バッチ・CI・スケジューラの設定レビュー、' +
      '「この式は結局いつ動くのか」の確認、書き間違いの検出に使う。解釈は Vixie cron（crontab(5)）準拠で、' +
      '範囲・ステップ・列挙・JAN-DEC / SUN-SAT の名前・@daily 等の省略記法に対応し、6フィールドのときは先頭を秒として扱う。' +
      '「日」と「曜日」の両方が指定されたときの OR 解釈、範囲を割り切らない */n、存在しない日付（2月30日など）は warnings で知らせる。' +
      '発火日時はタイムゾーンの壁時計上で求めてから実時刻へ戻すため、夏時間のある地域でもずれない。完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      expression: z.string().describe('Cron式（5フィールド「分 時 日 月 曜日」/ 秒付き6フィールド / @daily 等）'),
      timeZone: z
        .string()
        .optional()
        .describe('発火日時を求めるタイムゾーン（IANA名。既定 UTC。例: Asia/Tokyo）'),
      count: z.number().int().min(1).max(100).optional().describe('返す発火日時の件数（既定5・最大100）'),
      from: z.string().optional().describe('この日時より後を探す（ISO8601。既定は現在時刻）'),
    },
  },
  async ({ expression, timeZone, count, from }) => {
    await logUsage('cron_explain');
    return asText(cronExplain(expression, { timeZone, count, from }));
  },
);

server.registerTool(
  'base64_encode',
  {
    title: 'Base64 / Data URI エンコード・デコード',
    description:
      'テキストやファイルを Base64・data URI へ変換し、そのまま貼れる HTML <img> / CSS background-image の' +
      'スニペットも返す（tools.first-ch.com/base64/ と同一ロジック）。mode="decode" では Base64 や data URI を' +
      '元のバイト列へ戻し、outputPath を渡せばファイルとして書き出す。' +
      'アイコンやSVGのCSS埋め込み、メールHTML用の画像インライン化、APIやJWTで受け取ったBase64の中身の確認、' +
      'ログに出てきたdata URIの復元に使う。' +
      'SVGは base64（必ず約1.33倍になる）よりパーセントエンコードの方が小さいため両方の長さを返して短い方を既定にし、' +
      '& " < > # % と空白・非ASCIIを必ずエスケープするのでHTML属性にもCSSの url("…") にもそのまま貼れる。' +
      'デコードは標準/URLセーフのどちらでも、空白・改行混じりでも、パディングが欠けていても読み取り、' +
      'data URI が名乗るMIMEタイプより実際のマジックナンバー（PNG/JPEG/GIF/WebP/ico/PDF/zip/woff/woff2/SVG）から' +
      '判定した種類を優先する。完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      mode: z.enum(['encode', 'decode']).optional().describe('既定 encode。decode は base64 を元のバイト列へ戻す'),
      text: z.string().optional().describe('encode: 変換するテキスト（UTF-8として符号化する。path と排他）'),
      path: z.string().optional().describe('encode: 変換するファイルの絶対パス（text と排他）'),
      base64: z.string().optional().describe('decode: Base64本体、または data:…;base64,… の全体'),
      outputPath: z.string().optional().describe('decode: 復元したバイト列を書き出す絶対パス（指定すると base64 は返さない）'),
      urlSafe: z.boolean().optional().describe('encode: URLセーフ（+/ を -_ に・パディング無し）にするか（既定 false）'),
      wrap: z.number().int().min(1).max(998).optional().describe('encode: n桁ごとに改行する（MIMEは76）'),
      dataUri: z.boolean().optional().describe('encode: data URI も返すか（path 指定時は常に返す）'),
      mimeType: z.string().optional().describe('encode: data URI のMIMEタイプ（未指定なら中身から判定）'),
      snippets: z.boolean().optional().describe('encode: HTML <img> / CSS background-image のスニペットも返すか（画像のみ）'),
    },
  },
  async (opts) => {
    await logUsage('base64_encode');
    return asText(await base64Convert(opts));
  },
);

server.registerTool(
  'url_params',
  {
    title: 'URLパラメータの分解・編集・再構築',
    description:
      'URLのクエリ文字列をキーと値へ分解し、編集・追加・削除・並べ替えをして再構築する' +
      '（tools.first-ch.com/url/ と同一ロジック）。UTMタグの付与、gclid等のクリックIDの一括削除、' +
      '文字列単体のURLエンコード/デコード（mode="encode" / "decode"）もできる。' +
      'リダイレクトURLやAPI引数の中身の確認、計測用URLの作成、共有前のクエリの掃除に使う。' +
      '値はデコードして返し（%XX を元の文字へ、+ を半角スペースへ）、編集していないパラメータは' +
      '生の文字列のまま書き戻すため、何も指定しなければ再構築後のURLは入力と1バイトも変わらない' +
      '（署名付きURLを通しても壊れない）。reencode=true で全体を encodeURIComponent の規則へ正規化する。' +
      '重複キー・未エンコードのスペースや非ASCII・壊れた %XX・+ のスペース解釈・UTM値の大文字混在や' +
      'source/mediumの片落ち・URL内のパスワード・トークンらしきキー・2000文字超を warnings で知らせる。' +
      '相対パスや壊れたパーセントエンコードでも例外にせず、読める範囲まで分解する。' +
      '完全ローカル処理・ネットワーク送信なし（URLへのアクセスは行わない）。',
    inputSchema: {
      url: z.string().optional().describe('mode="parse": 分解するURL（相対パス・部分的なURLも可）'),
      mode: z
        .enum(['parse', 'encode', 'decode'])
        .optional()
        .describe('既定 parse。encode/decode は url ではなく text を対象にする'),
      text: z.string().optional().describe('mode="encode"/"decode": 対象の文字列'),
      scheme: z
        .enum(['component', 'uri', 'form'])
        .optional()
        .describe('encode/decode の方式（既定 component=encodeURIComponent / uri=encodeURI / form=スペースを +）'),
      set: z.record(z.string()).optional().describe('parse: 追加・上書きするパラメータ（値が空文字なら削除）'),
      remove: z.array(z.string()).optional().describe('parse: 削除するパラメータ名（大文字小文字を無視）'),
      utm: z
        .record(z.string())
        .optional()
        .describe('parse: UTMタグ。source / medium / campaign / content / term / id（utm_ 付きでも可）'),
      removeTracking: z.boolean().optional().describe('parse: gclid・fbclid 等のクリックIDを一括削除する'),
      sort: z.boolean().optional().describe('parse: パラメータを名前順に並べ替える'),
      reencode: z.boolean().optional().describe('parse: 全パラメータを encodeURIComponent の規則で書き直す'),
      spaceAsPlus: z.boolean().optional().describe('parse: 新たにエンコードする値のスペースを %20 ではなく + にする'),
    },
  },
  async (opts) => {
    await logUsage('url_params');
    return asText(urlParams(opts));
  },
);

server.registerTool(
  'html_escape',
  {
    title: 'HTML特殊文字のエスケープ・エンティティのデコード',
    description:
      'テキスト中の < > & " \' をHTMLエンティティへ変換し、逆に &amp; &#39; &#x3042; などの文字参照を' +
      '元の文字へ戻す（tools.first-ch.com/html-escape/ と同一ロジック）。' +
      '記事やコード例へHTMLをそのまま載せる、テンプレートへ差し込む値を安全にする、' +
      'スクレイピングやAPIで受け取ったエンティティ混じりのテキストを読める形に戻す、といった用途に使う。' +
      'エスケープは & を最初に処理するため何度実行しても二重エスケープにならず、' +
      '名前付き参照と数値文字参照（10進・16進）を切り替えられる。' +
      'デコードはHTML 4.01の名前付き文字参照252個すべてと10進/16進に対応し、' +
      '知らない名前や範囲外の数値は推測で変換せずそのまま残して notes で知らせる。' +
      '&#128; のようなC1領域の数値参照はHTML仕様どおり Windows-1252 の文字（€）へ読み替える。' +
      'すでにエスケープ済みの入力・裸の &・セミコロンで閉じていない参照・ノーブレークスペース(U+00A0)の' +
      '混入も notes で指摘する。完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      mode: z.enum(['escape', 'unescape']).optional().describe('既定 escape。unescape はエンティティを元の文字へ戻す'),
      text: z.string().optional().describe('対象のテキスト（path と排他）'),
      path: z.string().optional().describe('対象ファイルの絶対パス（UTF-8として読む。text と排他）'),
      outputPath: z.string().optional().describe('結果を書き出す絶対パス（指定すると text は返さない）'),
      quotes: z.boolean().optional().describe('escape: " と \' も変換するか（既定 true。属性値へ入れるなら必須）'),
      apos: z.boolean().optional().describe("escape: ' を &apos; にするか（既定 false=&#39;。&apos; はHTML 4.01に無い）"),
      numeric: z.boolean().optional().describe('escape: 名前ではなく数値文字参照（&#38; 形式）で出力するか（既定 false）'),
      nonAscii: z
        .enum(['none', 'named', 'decimal', 'hex'])
        .optional()
        .describe('escape: 非ASCII文字の扱い（既定 none。文字コードが伝わらない経路へ渡すなら decimal/hex）'),
    },
  },
  async (opts) => {
    await logUsage('html_escape');
    return asText(await htmlEscape(opts));
  },
);

// JSON ⇄ YAML は「入力の形式」ごとに別ツールにしている（direction を間違えると
// 何も変換されないまま返ってしまうため、名前で向きが決まる方が誤用しにくい）。
const JSON_YAML_SHARED =
  '変換は完全ローカル処理・ネットワーク送信なし。text か path のどちらか一方を渡す。' +
  'outputPath を渡すとファイルへ書き出す（本文は返さない）。' +
  '構文エラーのときは「何行何桁・原因・直し方」と、その前後2行の抜き出しをエラーとして返すので、' +
  '設定ファイルの構文チェックにも使える。' +
  '読み替えで意味が変わる箇所は notes で知らせる（キーの重複＝後が勝つ・2の53乗を超える整数の桁落ちなど）。';

server.registerTool(
  'json_to_yaml',
  {
    title: 'JSON → YAML 変換・整形',
    description:
      'JSONをYAMLへ変換して整形する（tools.first-ch.com/json-yaml/ と同一ロジック）。' +
      'APIレスポンスやテンプレートの出力を docker-compose・GitHub Actions・Kubernetes マニフェストのような' +
      '設定ファイルへ写すときに使う。インデント幅・引用符の付け方・null の書き方・複数行文字列を' +
      'ブロックスカラー（|）で書くか・キーを名前順に並べるか・先頭に --- を付けるかを選べる。' +
      '別の型に読まれうる文字列（yes / no / on / off / 0755 / 12:30 / 2026-08-12 / 数値に見える文字列）、' +
      '前後に空白がある文字列、- や * や # で始まる文字列は自動で引用符を付けるので、' +
      'YAML 1.1 のパーサ（PyYAMLなど）に渡しても意味が変わらない。' +
      '改行を含む文字列は | のブロック表記にし、行末の空白など復元できない形のときだけ "…" に倒す。' +
      'コメント・末尾カンマ・シングルクォート・引用符なしのキーを含むJSON（tsconfig.json など）も' +
      '読み取って変換し、JSONとしては不正であることを notes で知らせる（relaxed=false で厳密に拒否できる）。' +
      JSON_YAML_SHARED,
    inputSchema: {
      text: z.string().optional().describe('変換するJSON（path と排他）'),
      path: z.string().optional().describe('変換するJSONファイルの絶対パス（UTF-8として読む。text と排他）'),
      outputPath: z.string().optional().describe('YAMLを書き出す絶対パス（指定すると text は返さない）'),
      indent: z.number().int().min(1).max(8).optional().describe('YAMLのインデント幅（既定2）'),
      quote: z
        .enum(['auto', 'single', 'double'])
        .optional()
        .describe("引用符の付け方（既定 auto=必要なときだけ / single='…' / double=\"…\"）"),
      nullStyle: z.enum(['null', 'tilde', 'empty']).optional().describe('null の書き方（既定 null / tilde=~ / empty=空欄）'),
      block: z.boolean().optional().describe('改行を含む文字列を | のブロック表記で書くか（既定 true）'),
      sortKeys: z.boolean().optional().describe('キーを名前順に並べるか（既定 false=入力の順）'),
      docStart: z.boolean().optional().describe('先頭に --- を付けるか（既定 false）'),
      relaxed: z.boolean().optional().describe('コメント・末尾カンマ等を含むJSONも読むか（既定 true）'),
    },
  },
  async (opts) => {
    await logUsage('json_to_yaml');
    return asText(await jsonToYaml(opts));
  },
);

server.registerTool(
  'yaml_to_json',
  {
    title: 'YAML → JSON 変換・構文チェック',
    description:
      'YAMLをJSONへ変換する（tools.first-ch.com/json-yaml/ と同一ロジック）。' +
      'docker-compose・GitHub Actions・Kubernetes マニフェスト・CIの設定を、プログラムから扱える形へ' +
      '読み替えるときや、構文の妥当性を確かめるときに使う。インデント2/4/タブ/1行（indent=0）を選べ、' +
      'キーの並べ替えと非ASCII文字の \\uXXXX 化もできる。' +
      '複数ドキュメント（--- 区切り）はJSONの配列1つにまとめ、アンカー &名前 / エイリアス *名前 /' +
      'マージキー << は展開する（JSONに参照の仕組みが無いため。展開したことは notes で知らせる）。' +
      'スカラーの解釈は YAML 1.2 core schema に従うので yes / no / on / off / NO は文字列のままだが、' +
      'YAML 1.1 のパーサでは真偽値になる値、0755（10進の755になる）、12:30（60進数の750になる）、' +
      '日付に見える値は notes で知らせる。' +
      '対応: ブロックマップ/シーケンス・フロー表記 [] {}・引用スカラー（複数行・エスケープ）・' +
      'ブロックスカラー | > と chomping - + と明示インデント・タグ（!!str !!int !!float !!bool !!null !!binary）・コメント。' +
      '未対応は「? キー」の明示キー記法のみ。' +
      JSON_YAML_SHARED,
    inputSchema: {
      text: z.string().optional().describe('変換するYAML（path と排他）'),
      path: z.string().optional().describe('変換するYAMLファイルの絶対パス（UTF-8として読む。text と排他）'),
      outputPath: z.string().optional().describe('JSONを書き出す絶対パス（指定すると text は返さない）'),
      indent: z
        .union([z.number().int().min(0).max(8), z.literal('tab')])
        .optional()
        .describe('JSONのインデント（既定2 / 0=改行なしの1行 / "tab"=タブ）'),
      sortKeys: z.boolean().optional().describe('キーを名前順に並べるか（既定 false=入力の順）'),
      ascii: z.boolean().optional().describe('非ASCII文字を \\uXXXX へエスケープするか（既定 false）'),
    },
  },
  async (opts) => {
    await logUsage('yaml_to_json');
    return asText(await yamlToJson(opts));
  },
);

server.registerTool(
  'px_rem_convert',
  {
    title: 'px ⇄ rem / em 単位換算・CSSの一括変換',
    description:
      'CSSの長さの単位を px ⇄ rem / em / pt で換算する（tools.first-ch.com/px-rem/ と同一ロジック）。' +
      'value を渡すと1つの値の換算になり、px・rem・em・pt の値と、そのまま貼れる font-size の1行、' +
      'よく使うフォントサイズ（12〜64px）のスケール表を返す。' +
      'css か path を渡すとCSS全体の一括変換になり、px→rem（px2rem）のほか px2em / rem2px / em2px を選べる。' +
      'デザインカンプのpx指定をremへ直す、既存のスタイルシートをアクセシビリティのためにrem化する、' +
      'rem表記のCSSを実寸で確かめる、といった用途に使う。' +
      '一括変換ではコメント・文字列（content: "10px"）・url() の中身と、--size-16px のように' +
      '識別子の一部になっている数字は書き換えない。既定では minPx=2 で1pxの罫線を残し（remにすると' +
      '環境によって太さがばらつくため）、@media などアットルールの条件（ブレークポイント）も変換しない。' +
      'ルートは 62.5% のようなパーセントでも指定でき、その場合はブラウザ既定16pxに対する割合として読む。' +
      '割り切れない値は丸めたことを notes で知らせる。完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      value: z
        .union([z.number(), z.string()])
        .optional()
        .describe('換算する1つの値（24 / "24px" / "1.5rem" のように単位を含めてもよい。css / path と排他）'),
      unit: z
        .enum(['px', 'rem', 'em', 'pt', '%'])
        .optional()
        .describe('value の単位（既定 px。value に単位を書いた場合はそちらが優先）'),
      css: z.string().optional().describe('一括変換するCSS（value / path と排他）'),
      path: z.string().optional().describe('一括変換するCSSファイルの絶対パス（UTF-8として読む。value / css と排他）'),
      outputPath: z.string().optional().describe('変換後のCSSを書き出す絶対パス（指定すると本文は返さない）'),
      direction: z
        .enum(['px2rem', 'px2em', 'rem2px', 'em2px'])
        .optional()
        .describe('一括変換の向き（既定 px2rem）'),
      root: z
        .union([z.number(), z.string()])
        .optional()
        .describe('ルート（html要素）のフォントサイズ px（既定16。"62.5%" のような指定も可）'),
      parent: z
        .union([z.number(), z.string()])
        .optional()
        .describe('親要素のフォントサイズ px（em の基準。既定は root と同じ）'),
      precision: z
        .union([z.number().int().min(0).max(6), z.literal('auto')])
        .optional()
        .describe('小数の桁（既定 auto=6桁まで見て末尾の0を落とす。数値を渡すとその桁で固定）'),
      minPx: z
        .number()
        .optional()
        .describe('一括変換で、換算後の絶対値がこの px 未満の値は変換しない（既定2＝1pxの罫線を残す。0で全部変換）'),
      zeroUnitless: z.boolean().optional().describe('0 を単位なしの 0 にするか（既定 true）'),
      skipMedia: z.boolean().optional().describe('@media などアットルールの条件を変換対象から外すか（既定 true）'),
      ignoreProps: z
        .array(z.string())
        .optional()
        .describe('変換しないプロパティ（前方一致。例 ["border","outline","box-shadow"]）'),
      scale: z.boolean().optional().describe('値の換算のときに12〜64pxのスケール表を返すか（既定 true）'),
    },
  },
  async (opts) => {
    await logUsage('px_rem_convert');
    return asText(await pxRemConvert(opts));
  },
);

server.registerTool(
  'color_convert',
  {
    title: 'カラーコード変換・アルファ透過計算',
    description:
      '色のコードを HEX / RGB / HSL / OKLCH で相互変換し、アルファ（透過度）付きの rgba() / hsla() / 8桁HEX を返す' +
      '（tools.first-ch.com/color/ と同一ロジック）。' +
      '入力は HEX（3/4/6/8桁）・rgb()・hsl()・hwb()・oklch()・oklab()・CSSの名前付き色（148色）・transparent を受け付け、' +
      '旧記法のカンマ区切りと新記法のスラッシュ区切り、角度の単位（deg / grad / rad / turn）も読む。' +
      'background を渡すと、透過色をその背景の上に重ねたときに実際に見える色（アルファ合成の結果）を flattened で返すので、' +
      'デザインカンプの半透明レイヤーを不透明なHEXへ置き換える用途に使える。' +
      'あわせて白文字・黒文字とのWCAG 2.1コントラスト比、アルファを刻んだ表（alpha_table）、' +
      '色相と彩度を保ったまま明度だけを50〜950の11段に振った明度パレット（palette）を返す。' +
      'sRGBで表現できないOKLCHは、RGBを切り詰めると色相がずれるため、明度と色相を保ったまま彩度だけを下げて収める。' +
      '完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      color: z
        .string()
        .describe('変換する色（"#c8501f" / "rgb(200 80 31)" / "hsl(17 73% 45%)" / "oklch(56% 0.16 41)" / "tomato" など）'),
      alpha: z
        .union([z.number(), z.string()])
        .optional()
        .describe('アルファ（0〜1・0〜100・"50%" のいずれか。指定すると color 側のアルファを上書きする）'),
      background: z
        .string()
        .optional()
        .describe('重ねる背景色（既定 #ffffff）。flattened と alpha_table の合成結果に使う'),
      syntax: z
        .enum(['modern', 'legacy'])
        .optional()
        .describe('rgb(200 80 31 / 50%) のモダン記法（既定）か、rgba(200, 80, 31, 0.5) の従来記法か'),
      uppercase: z.boolean().optional().describe('HEXを大文字で書き出すか（既定 false）'),
      alphaPercent: z.boolean().optional().describe('アルファをパーセントで書くか（既定 false＝0〜1）'),
      step: z.number().optional().describe('alpha_table の刻み（%・1〜50。既定10）'),
      alphaTable: z.boolean().optional().describe('アルファを刻んだ表を返すか（既定 true）'),
      palette: z.boolean().optional().describe('明度パレット（50〜950の11段）を返すか（既定 true）'),
    },
  },
  async (opts) => {
    await logUsage('color_convert');
    return asText(colorConvert(opts));
  },
);

server.registerTool(
  'hash_generate',
  {
    title: 'MD5 / SHA-1 / SHA-256 / SHA-384 / SHA-512 ハッシュ生成・照合',
    description:
      'テキストまたはファイルの MD5・SHA-1・SHA-256・SHA-384・SHA-512 ハッシュ値を一度に算出する' +
      '（tools.first-ch.com/hash/ と同一の仕様）。' +
      'ダウンロードしたファイルが配布元のチェックサムと一致するかの確認、変更の検出、' +
      'APIリクエストの署名計算の下ごしらえ、キャッシュキーの生成といった用途に使う。' +
      'expected に期待値を渡すと桁数から対象のアルゴリズムを判定して照合し、一致したかどうかを返す。' +
      'expected は `sha256sum` の出力（`<ハッシュ値>␣␣<ファイル名>`）・`SHA256 (file) = …`・' +
      '`sha256:` のような接頭辞付き・コロン区切りの16進・Base64 をそのまま渡せる。' +
      '出力は16進の小文字/大文字・Base64・base64url を選べる。' +
      'text は改行コード（lf / crlf）とUTF-8のBOMの有無を指定できるので、Windowsで作られたファイルの' +
      '値も再現できる（文字コードはUTF-8固定）。ファイルは大きくてもストリームで1パス処理する。' +
      'MD5とSHA-1は衝突耐性が破られており署名・改ざん検知には使えないこと、ハッシュ値をそのまま' +
      'パスワード保存に使ってはいけないこと（ソルト付きのbcrypt / scrypt / Argon2を使う）は notes で知らせる。' +
      '完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      text: z.string().optional().describe('ハッシュ値を計算するテキスト（path と排他）'),
      path: z.string().optional().describe('ハッシュ値を計算するファイルの絶対パス（text と排他）'),
      algorithms: z
        .array(z.enum(['md5', 'sha1', 'sha256', 'sha384', 'sha512']))
        .optional()
        .describe('算出するアルゴリズム（既定 ["md5","sha1","sha256","sha512"]）'),
      format: z
        .enum(['hex', 'HEX', 'base64', 'base64url'])
        .optional()
        .describe('出力の書式（既定 hex=16進の小文字 / HEX=16進の大文字 / base64 / base64url）'),
      newline: z
        .enum(['lf', 'crlf'])
        .optional()
        .describe('text の改行コード（既定 lf。Windowsのファイルと突き合わせるなら crlf。path には影響しない）'),
      bom: z.boolean().optional().describe('text の先頭にUTF-8のBOMを付けるか（既定 false。path には影響しない）'),
      expected: z.string().optional().describe('照合するハッシュ値（コマンドの出力をそのまま渡してよい）'),
    },
  },
  async (opts) => {
    await logUsage('hash_generate');
    return asText(await hashGenerate(opts));
  },
);

server.registerTool(
  'jwt_decode',
  {
    title: 'JWTのデコード・有効期限チェック・署名の検証',
    description:
      'JWT（JSON Web Token）をデコードしてヘッダーとペイロードを返し、有効期限（exp / nbf / iat）を判定する' +
      '（tools.first-ch.com/jwt/ と同一の仕様）。' +
      '開発中の認証トークンの中身の確認、「なぜ401になるのか」の切り分け、期限切れかどうかの判定に使う。' +
      'token は `Authorization: Bearer <token>` のヘッダー1行のまま渡してよい（前後の引用符・改行も除去する）。' +
      'key を渡すと署名も検証する: HS256/384/512 は共有鍵の文字列（keyEncoding で base64url / hex も可）、' +
      'RS・PS・ES・EdDSA は SPKI形式のPEM公開鍵、またはJWK / JWKS のJSON（JWKSはヘッダーの kid で自動的に選ぶ）。' +
      '秘密鍵・証明書・PKCS#1 を渡した場合は検証せず、正しい取り出し方を返す。' +
      'clockTolerance で時計のズレを秒単位で許容でき、now でUNIX秒の現在時刻を固定できる（再現テスト用）。' +
      'alg:none・署名なし・期限切れ・nbfが未来・expがミリ秒（Date.now()の入れ間違い）・有効期間が長すぎる・' +
      'ペイロードに秘密情報や個人情報が入っている、といった落とし穴は warnings で知らせる。' +
      '5セグメントのJWE（暗号化トークン）はヘッダーのみ返す（復号は行わない）。' +
      '完全ローカル処理・ネットワーク送信なし（JWKSの取得も行わないので、鍵は呼び出し側が渡す）。',
    inputSchema: {
      token: z.string().describe('デコードするJWT（`Authorization: Bearer …` の1行のままでも可）'),
      key: z
        .string()
        .optional()
        .describe('署名の検証に使う鍵。HS*は共有鍵の文字列、その他はPEM公開鍵かJWK / JWKSのJSON（省略すると検証しない）'),
      keyEncoding: z
        .enum(['utf8', 'base64url', 'base64', 'hex'])
        .optional()
        .describe('HS* の共有鍵の読み方（既定 utf8＝そのままの文字列）'),
      clockTolerance: z.number().optional().describe('許容する時計のズレ（秒。既定0）'),
      now: z.number().optional().describe('判定に使う現在時刻（UNIX秒。既定は実時刻）'),
    },
  },
  async (opts) => {
    await logUsage('jwt_decode');
    return asText(await jwtDecode(opts));
  },
);

server.registerTool(
  'user_agent_parse',
  {
    title: 'User-Agent文字列の解析とデバイス判定',
    description:
      'User-Agent文字列から、ブラウザ名とバージョン・レンダリングエンジン・OSとそのバージョン・' +
      'デバイス種別（desktop / mobile / tablet / tv / console / wearable / bot）・メーカーと機種・' +
      'CPUアーキテクチャを判定する（tools.first-ch.com/user-agent/ と同一の仕様）。' +
      'アクセスログの調査、問い合わせに付いてきたUAの読み解き、対応ブラウザの棚卸しに使う。' +
      'ua はアクセスログの行のまま渡してよい（先頭の `User-Agent:`・前後の引用符・末尾のカンマは除去する）。' +
      'uas に配列を渡すと複数件をまとめて解析し、ブラウザ・OS・デバイス種別の内訳を summary で返す。' +
      '判定は「より限定的なトークンから先に試す」順序で行う（Edg/ → OPR/ → Chrome/ → Safari/）。' +
      'Chrome・Edge・Opera はいずれも `Safari/` と `Chrome/` を名乗るため、部分一致では取り違える。' +
      'tokens でUA文字列をトークン単位に分解し、`Mozilla/5.0` や `KHTML, like Gecko` のような化石の意味を返す。' +
      'notes では「UAでは分からないこと」を知らせる: Chrome 110以降の削減済みUA（マイナー版は 0.0.0、' +
      'Androidの機種名は `K` に凍結）、macOSが常に 10.15.7 を名乗ること、Windows 10と11が区別できないこと、' +
      'iPadがMac版Safariと同じUAを送ること、アプリ内ブラウザ（LINE / Instagram / Facebook / Android WebView）、' +
      'そしてUAは誰でも名乗れるためアクセス制御の根拠にできないこと。' +
      'Googlebot・GPTBot・ClaudeBot などのクローラーや curl・python-requests のHTTPクライアントも判定する。' +
      '完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      ua: z.string().optional().describe('解析するUser-Agent文字列（`User-Agent:` 付きのログ1行のままでも可）'),
      uas: z
        .array(z.string())
        .optional()
        .describe('複数件をまとめて解析する場合のUA文字列の配列（内訳の集計 summary が付く。ua とは併用しない）'),
      includeTokens: z
        .boolean()
        .optional()
        .describe('uas で解析するときにトークン内訳を含めるか（既定: 20件以下なら含める）'),
    },
  },
  async (opts) => {
    await logUsage('user_agent_parse');
    return asText(userAgentParse(opts));
  },
);

server.registerTool(
  'uuid_generate',
  {
    title: 'UUID v4 / ULID の一括生成',
    description:
      'UUID v4 または ULID を1〜100件まとめて生成する（tools.first-ch.com/uuid/ と同一の仕様）。' +
      'テストデータやマイグレーションの一意なIDの発行、DBのダミーレコード作成に使う。' +
      'UUID v4 は128bitのうち122bitが乱数（残る6bitがバージョン4とバリアント）で、順序を持たない。' +
      'ULID は26文字で、先頭10文字が生成時刻（UNIX時間のミリ秒・48bit）、後ろ16文字が乱数（80bit）。' +
      '時刻が先頭にあるため文字列の辞書順が生成順と一致し、IDから作成日時を読み戻せる' +
      '（DBの主キーにするとB+treeインデックスの断片化を避けやすい。ただし生成時刻は誰にでも読める）。' +
      '同一ミリ秒内に複数生成するときは ULID 仕様の単調増加（monotonic）に従って乱数部を+1するため、' +
      '100件を一度に作っても順序が崩れない。' +
      '乱数は node:crypto の randomBytes（CSPRNG）で、Math.random は使わない。' +
      'format で出力の形（1行1件 / JSON配列 / カンマ区切り / SQLのINSERT向けの引用符付き）を、' +
      'uppercase・hyphens・braces で表記（UUIDの既定は RFC 9562 に従い小文字・ULIDの既定は大文字）を選べる。' +
      '完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      type: z.enum(['uuid', 'ulid']).optional().describe("生成するIDの種類（既定: 'uuid' = UUID v4）"),
      count: z.number().int().optional().describe(`生成する件数（1〜${UUID_MAX_COUNT}。既定: 1）`),
      format: z
        .enum(['plain', 'json', 'csv', 'quoted'])
        .optional()
        .describe("text の出力形式（plain=1行1件 / json=JSON配列 / csv=カンマ区切り / quoted=\"…\", 。既定: plain）"),
      uppercase: z.boolean().optional().describe('大文字にするか（既定: UUIDは false・ULIDは true）'),
      hyphens: z.boolean().optional().describe('UUIDのハイフンを残すか（false で32文字。既定: true。ULIDでは無視）'),
      braces: z.boolean().optional().describe('UUIDを波括弧で括るか（WindowsのGUID表記。既定: false。ULIDでは無視）'),
      timestamp: z
        .union([z.string(), z.number()])
        .optional()
        .describe('ULIDに埋め込む時刻（ISO8601文字列 / UNIX秒 / UNIXミリ秒。既定: 現在時刻。UUIDでは指定できない）'),
    },
  },
  async (opts) => {
    await logUsage('uuid_generate');
    return asText(uuidGenerate(opts));
  },
);

server.registerTool(
  'aspect_ratio_calc',
  {
    title: 'アスペクト比の計算・レスポンシブサイズ算出',
    description:
      'アスペクト比と寸法を相互に計算する（tools.first-ch.com/aspect-ratio/ と同一ロジック）。' +
      "ratio（'16:9' / '16/9' / '1.85'）と width か height の片方を渡すと、もう一方の寸法を返す。" +
      'width と height を渡して ratio を省くと、最大公約数で約分した比率・小数・向き・画素数と、' +
      'いちばん近い定番比率（16:9・4:3・3:2・1:1・4:5・9:16・21:9・1.85:1・2.39:1・1.91:1(OGP)・黄金比など）' +
      'からのずれを返す。1920×1080 のように名前のある寸法はその名前も返す。' +
      'round で 四捨五入（round）・偶数（even）・切り捨て（floor）・切り上げ（ceil）を選べ、' +
      '丸めた場合は丸め後の実際の比率と指定した比率からのずれ（%）を返す。' +
      'H.264 / H.265 は色情報を縦横半分で持つ（YUV 4:2:0）ため幅・高さとも偶数が必要で、動画向けには round="even" を使う。' +
      'box を渡すと、その枠へ contain / cover ではめ込んだときの描画サイズ・拡大率・余白（レターボックス / ピラーボックス）・' +
      '切り取られる量・見える割合を返す。' +
      'widths か table=true でブレークポイントごとの高さの早見表を、snippet=true で aspect-ratio のCSSと' +
      '（CLSを防ぐ width / height 属性入りの）HTMLを返す。' +
      '完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      ratio: z
        .union([z.string(), z.number()])
        .optional()
        .describe("アスペクト比（'16:9' / '16/9' / '16x9' / '1.85' / 1.85。省略時は width と height の両方が必要）"),
      width: z.number().optional().describe('幅 px（ratio と併せると高さを求める。ratio を省くと height と対で比率を求める）'),
      height: z.number().optional().describe('高さ px（ratio と併せると幅を求める）'),
      round: z
        .enum(['none', 'round', 'floor', 'ceil', 'even'])
        .optional()
        .describe("整数への丸め方（既定 'none'=計算どおり。'even' は動画向けに偶数へ寄せる）"),
      widths: z
        .array(z.number())
        .optional()
        .describe('早見表に並べる幅の一覧（既定 [320,375,414,768,1024,1280,1440,1920]。渡すと表を返す）'),
      table: z.boolean().optional().describe('既定の幅で早見表を返すか（widths を渡した場合は自動で true）'),
      box: z
        .union([z.string(), z.object({ width: z.number(), height: z.number() })])
        .optional()
        .describe("はめ込む枠の寸法（'1280x400' または {width,height}）"),
      fit: z.enum(['cover', 'contain']).optional().describe("box へのはめ方（既定 'cover'=枠を埋めてはみ出しを切る）"),
      snippet: z.boolean().optional().describe('CSS と HTML のスニペットを返すか（既定 false）'),
      selector: z.string().optional().describe("スニペットのセレクタ（既定 '.media'）"),
      target: z
        .enum(['img', 'video', 'iframe', 'background'])
        .optional()
        .describe("スニペットの中に入れる要素（既定 'img'）"),
      objectFit: z
        .enum(['cover', 'contain', 'fill', 'none'])
        .optional()
        .describe("スニペットの object-fit（既定 'cover'。target=iframe では使わない）"),
      fallback: z
        .boolean()
        .optional()
        .describe('aspect-ratio 非対応ブラウザ向けの padding-top フォールバックを付けるか（既定 false）'),
    },
  },
  async (opts) => {
    await logUsage('aspect_ratio_calc');
    return asText(aspectRatioCalc(opts));
  },
);

server.registerTool(
  'markdown_table',
  {
    title: 'TSV/CSV → Markdownテーブル整形・相互変換',
    description:
      'ExcelやスプレッドシートからコピーしたTSV/CSV（クリップボードの中身はカンマ区切りではなくタブ区切り）を' +
      'Markdownの表へ整形し、逆にMarkdownの表をCSV/TSV/HTML/JSONへ書き出す（tools.first-ch.com/markdown-table/ と同一ロジック）。' +
      '区切り文字はタブ・カンマ・セミコロンのそれぞれで実際に読んでみて「列数がいちばん揃うもの」を選ぶ方式で自動判定するため、' +
      '金額の桁区切り（1,200）が入っていても列がずれない。CSVはRFC 4180の引用符（セル内のカンマ・改行・"" ）に対応。' +
      '桁揃えでは全角文字をUnicodeのEast Asian Width（Wide / Fullwidth）に従って2桁として数えるので、等幅フォントで縦線が揃う。' +
      '空でないセルがすべて数値（桁区切り・小数点・通貨記号・%・単位を含む）の列は自動で右寄せ（---:）にし、aligns で列ごとに指定もできる。' +
      'セルの中の | は \\| へエスケープし、セル内の改行は <br> か半角スペースへ置換し、列数が足りない行には空セルを補う（直した件数は notes で返す）。' +
      'Markdownを読むときは区切り行のコロンから配置を読み取り、<br> は改行へ戻すので、CSVへ書き出せばセル内改行のあるデータとして表計算ソフトへ戻せる。' +
      'text か path のどちらか一方を渡す。outputPath を渡すとファイルへ書き出す（本文は返さない）。' +
      '完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      text: z.string().optional().describe('対象のテキスト（TSV / CSV / セミコロン区切り / Markdownの表。path と排他）'),
      path: z.string().optional().describe('対象ファイルの絶対パス（UTF-8として読む。text と排他）'),
      outputPath: z.string().optional().describe('結果を書き出す絶対パス（指定すると text は返さない）'),
      from: z
        .enum(['auto', 'tsv', 'csv', 'ssv', 'markdown'])
        .optional()
        .describe("入力の形式（既定 'auto'=自動判定。ssv はセミコロン区切り）"),
      to: z
        .enum(['markdown', 'csv', 'tsv', 'ssv', 'html', 'json'])
        .optional()
        .describe("出力の形式（既定 'markdown'。json は見出しをキーにしたオブジェクトの配列）"),
      header: z
        .enum(['first', 'auto', 'none'])
        .optional()
        .describe("1行目の扱い（既定 'first'=見出し。'auto'=col1… を振る / 'none'=見出しを空欄にする）"),
      align: z
        .enum(['auto', 'none', 'left', 'center', 'right'])
        .optional()
        .describe("全列の配置（既定 'auto'=元のMarkdownの指定を引き継ぎ、数値列は右寄せ）"),
      aligns: z
        .array(z.enum(['none', 'left', 'center', 'right']))
        .optional()
        .describe('列ごとの配置（align より優先。左から順に対応させる）'),
      pad: z.boolean().optional().describe('桁を揃えるか（既定 true。Markdown出力のみ。表示結果は変わらずソースが読みやすくなる）'),
      eastAsian: z.boolean().optional().describe('全角を2桁として数えるか（既定 true。等幅フォントで縦線を揃えるため）'),
      autoNumber: z.boolean().optional().describe('数値だけの列を右寄せにするか（既定 true）'),
      trim: z.boolean().optional().describe('セルの前後の空白を削るか（既定 true）'),
      skipEmpty: z.boolean().optional().describe('空行を飛ばすか（既定 true）'),
      transpose: z.boolean().optional().describe('行と列を入れ替えるか（既定 false）'),
      multiline: z
        .enum(['br', 'space'])
        .optional()
        .describe("セル内の改行の書き方（既定 'br'=<br>。'space' は半角スペースへ潰す）"),
      eol: z.enum(['lf', 'crlf']).optional().describe("出力の改行コード（既定 'lf'）"),
    },
  },
  async (opts) => {
    await logUsage('markdown_table');
    return asText(await markdownTable(opts));
  },
);

server.registerTool(
  'sql_format',
  {
    title: 'SQLクエリの整形（予約語の大文字化・句ごとの改行・字下げ）',
    description:
      'ログやORMが吐いた1行に固まったSQLを、予約語の大文字化・句ごとの改行・字下げの付いたクエリへ整形する' +
      '（tools.first-ch.com/sql-format/ と同一ロジック）。' +
      'SELECT / FROM / WHERE / GROUP BY / HAVING / ORDER BY / LIMIT / INSERT INTO / VALUES / UPDATE / SET / ' +
      'DELETE FROM / WITH / UNION などの句を行頭へ、その中身を1段下げて並べ直す。JOIN は行頭に置いて ON を1段下げ、' +
      'AND / OR は条件ごとに改行する（BETWEEN a AND b の AND は条件の区切りではないので改行しない）。' +
      '( の直後が SELECT / WITH / VALUES のときだけサブクエリとみなして改行＋字下げし、' +
      '関数呼び出し（SUM(…) / IN (1, 2, 3) / OVER (PARTITION BY … ORDER BY …)）は1行のまま保つ。' +
      'CASE 式は WHEN / ELSE / END を縦に並べる。予約語と型名だけを大文字（または小文字）へ揃え、' +
      'テーブル名・列名・別名の綴りは変えない（識別子の折りたたみ方がDBごとに違うため）。' +
      "文字列（'…'）・引用符付き識別子（\"…\" / `…` / […]）・コメント（-- / # / /* … */）・" +
      'プレースホルダ（? / :name / $1 / @var）はそのまま残す。' +
      '整形と同時に、WHEREの無いUPDATE/DELETE・閉じていない括弧や引用符・SELECT *・暗黙の結合・プレースホルダの有無を notes で返す。' +
      'compact=true にすると逆に改行を畳んで1行へ戻す。特定DBのパーサーではなく字句ベースの整形器なので、' +
      'MySQL・PostgreSQL・SQL Server・SQLite・Oracle の方言も壊さずに通す（構文エラーの検出はしない）。' +
      'text か path のどちらか一方を渡す。outputPath を渡すとファイルへ書き出す（本文は返さない）。' +
      '完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      text: z.string().optional().describe('対象のSQL（path と排他）'),
      path: z.string().optional().describe('対象ファイルの絶対パス（UTF-8として読む。text と排他）'),
      outputPath: z.string().optional().describe('結果を書き出す絶対パス（指定すると text は返さない）'),
      keywordCase: z
        .enum(['upper', 'lower', 'preserve'])
        .optional()
        .describe("予約語・型名の表記（既定 'upper'。'preserve' は元の綴りのまま）"),
      functionCase: z
        .enum(['upper', 'lower', 'preserve'])
        .optional()
        .describe("関数名の表記（既定 'upper'）"),
      indent: z.enum(['2', '4', '8', 'tab']).optional().describe("インデントの幅（既定 '4'=スペース4つ）"),
      commaStyle: z.enum(['trailing', 'leading']).optional().describe("カンマの位置（既定 'trailing'=行末）"),
      logicStyle: z.enum(['leading', 'trailing']).optional().describe("AND / OR の位置（既定 'leading'=行頭）"),
      breakColumns: z.boolean().optional().describe('SELECT の列・SET の代入・VALUES の行を1行ずつに分けるか（既定 true）'),
      breakLogic: z.boolean().optional().describe('WHERE / HAVING / ON の AND / OR で折り返すか（既定 true）'),
      breakOn: z.boolean().optional().describe('JOIN の ON を改行して1段下げるか（既定 true）'),
      breakCase: z.boolean().optional().describe('CASE 式の WHEN / ELSE / END を縦に並べるか（既定 true）'),
      breakSubquery: z.boolean().optional().describe('サブクエリの括弧を改行して字下げするか（既定 true）'),
      expandClauses: z.boolean().optional().describe('FROM や WHERE の中身も次の行から書くか＝完全展開（既定 false）'),
      compact: z.boolean().optional().describe('改行を畳んで1行にまとめるか（既定 false）'),
      eol: z.enum(['lf', 'crlf']).optional().describe("出力の改行コード（既定 'lf'）"),
    },
  },
  async (opts) => {
    await logUsage('sql_format');
    return asText(await sqlFormatTool(opts));
  },
);

server.registerTool(
  'qr_generate',
  {
    title: 'QRコードの生成（SVG / PNG / 文字の図）',
    description:
      'URLやテキストからQRコードを生成し、SVG（ベクター）・PNG・端末に貼れる文字の図で返す' +
      '（tools.first-ch.com/qr/ と同一ロジック）。' +
      '符号化（数字 / 英数字 / UTF-8のバイトモードを入力に応じて自動選択）・リード・ソロモン符号による誤り訂正・' +
      '位置検出パターンや型番情報の配置・8種類のマスクからの自動選択まで自前で実装しており（JIS X 0510 / ISO 18004・型番1〜40）、' +
      '外部のAPIも画像生成サーバーも使わない。' +
      '誤り訂正レベルは L（約7%）/ M（約15%）/ Q（約25%）/ H（約30%）から選ぶ（印刷物はQ以上を推奨）。' +
      'size は出力の一辺（px。SVGでは表示上の初期サイズ）、margin は余白＝クワイエットゾーンのモジュール数で規格の推奨は4' +
      '（0にすると背景によっては読み取れなくなる）。' +
      'Wi-Fi（WIFI:T:WPA;S:…;P:…;;）・メール（mailto:）・電話（tel:）・SMS（SMSTO:）・座標（geo:）などの' +
      '定型書式も、その文字列をそのまま text に渡せばよい。' +
      'outputPath を渡すとファイルへ書き出す（本文は返さない）。format="png" で outputPath を省いた場合は data URI で返る。' +
      '容量の上限は数字7089桁・英数字4296文字・バイト2953文字（いずれもレベルL）で、超えるとエラーになる。' +
      '完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      text: z.string().describe('QRコードにする内容（URL・テキスト。UTF-8）'),
      ecLevel: z
        .enum(['L', 'M', 'Q', 'H'])
        .optional()
        .describe("誤り訂正レベル（既定 'M'。L=約7% / M=約15% / Q=約25% / H=約30%まで復元できる）"),
      size: z.number().int().optional().describe('出力の一辺（px。64〜4096・既定 320）'),
      margin: z.number().int().optional().describe('余白のモジュール数（0〜32・既定 4＝規格の推奨）'),
      format: z.enum(['svg', 'png', 'text']).optional().describe("出力の形式（既定 'svg'。'text' は端末に貼れる文字の図）"),
      mode: z
        .enum(['auto', 'numeric', 'alnum', 'byte'])
        .optional()
        .describe("符号化モード（既定 'auto'＝入力に合う最も密なモードを選ぶ）"),
      mask: z.number().int().optional().describe('マスクパターン（0〜7。省略時は減点の一番低いものを自動選択）'),
      minVersion: z.number().int().optional().describe('型番の下限（1〜40。指定するとこれより小さい型番は使わない）'),
      outputPath: z.string().optional().describe('結果を書き出す絶対パス（指定すると本文は返さない）'),
    },
  },
  async (opts) => {
    await logUsage('qr_generate');
    return asText(await qrGenerateTool(opts));
  },
);

server.registerTool(
  'unixtime_convert',
  {
    title: 'UNIXタイムスタンプ⇄日時の相互変換',
    description:
      'UNIX秒・ミリ秒・マイクロ秒・ナノ秒と、ISO 8601や日時文字列を相互に変換する' +
      '（tools.first-ch.com/unixtime/ と同一ロジック）。ログに出ている数値が結局いつなのかの確認、' +
      '期限や有効期限の突き合わせ、タイムゾーンをまたぐ時刻のすり合わせに使う。' +
      '数値の単位は桁数から自動判定する（10桁までを秒 / 13桁までをミリ秒 / 16桁までをマイクロ秒 / それ以上をナノ秒）。' +
      'unit を渡せば自動判定を使わずその単位で読む。ミリ秒より下の桁は切り捨て、その旨を notes で返す。' +
      '日時側は 2026-08-24T09:30:00Z（ISO 8601）・2026-08-24 18:30・2026/8/24 9:05・2026年8月24日 18時30分・' +
      'Sun, 24 Aug 2026 03:00:00 GMT（HTTP-date）・now を受け付け、' +
      'CSVやJSONから貼ったときの引用符・角括弧・行末カンマは自動で外す。' +
      'input は1行1件で最大500行まとめて変換でき、行ごとにUNIX秒・ミリ秒・ISO 8601（UTC）・' +
      '指定タイムゾーンの現地時刻（曜日・UTCオフセット付き）・相対表示（○分前 / ○日後）を返す。' +
      '読めなかった行は他の行を巻き込まず、その行だけ error として返す。' +
      '**オフセットを持たない日時は timeZone の壁時計として解釈**し、必ず notes で明示する' +
      '（+09:00 や Z が入力にあれば timeZone より入力側が優先される）。' +
      '夏時間で存在しない時刻は切り替え後へ繰り上げ、こちらも notes に出す。' +
      '8桁の数字（20260824）はUNIX秒として読むため、日付のつもりの入力には notes で注意を返す。' +
      '負の値（1970年より前）と小数点付きの秒にも対応する。' +
      '完全ローカル処理・ネットワーク送信なし。',
    inputSchema: {
      input: z.string().describe('変換する値（1行1件。UNIX秒/ミリ秒/マイクロ秒/ナノ秒・ISO 8601・日時文字列・now）'),
      timeZone: z
        .string()
        .optional()
        .describe("現地時刻に使うIANAタイムゾーン名（既定 'UTC'。例: Asia/Tokyo / America/New_York）"),
      unit: z
        .enum(['auto', 's', 'ms', 'us', 'ns'])
        .optional()
        .describe("数値の単位（既定 'auto'＝桁数から自動判定。s=秒 / ms=ミリ秒 / us=マイクロ秒 / ns=ナノ秒）"),
      now: z
        .union([z.number(), z.string()])
        .optional()
        .describe('相対表示の基準時刻（UNIXミリ秒の数値か日時文字列。既定は実行時刻）'),
      lang: z.enum(['ja', 'en']).optional().describe("ラベル・相対表示・注記の言語（既定 'ja'）"),
    },
  },
  async (opts) => {
    await logUsage('unixtime_convert');
    return asText(unixtimeConvert(opts.input, opts));
  },
);

await server.connect(new StdioServerTransport());
