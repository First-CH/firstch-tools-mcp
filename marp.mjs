// Marp Markdown → スライド レンダリング（MCPツール用・Node実行）
//
// marp-core（純JS・ブラウザ非依存）で Markdown → スライドHTML を生成する。
// HTMLはテーマCSSをインラインした完全自己完結ファイルで、そのままブラウザで閲覧でき、
// 印刷（Ctrl/Cmd+P）すると1スライド=1ページのPDFになる。
//
// PDF出力はローカルにインストール済みの Chrome / Chromium を headless で呼び出して
// HTMLから印刷する（puppeteer/Chromium を同梱しない＝`npx -y` 導入を軽く保つ）。
// Chrome が見つからない場合は HTML のみ返し、PDFは skip して理由を添える。
//
// 和文テーマ firstch（firstch-design 準拠）を marp-theme.css として同梱し、
// Markdown が theme 指示を持たないときの既定テーマにする。

import { readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import os from 'node:os';
import { Marp } from '@marp-team/marp-core';

const execFileP = promisify(execFile);
const THEME_URL = new URL('./marp-theme.css', import.meta.url);

export const BUILTIN_THEMES = ['firstch', 'default', 'gaia', 'uncover'];

let themeCssCache;
async function firstchThemeCss() {
  if (themeCssCache === undefined) themeCssCache = await readFile(THEME_URL, 'utf8');
  return themeCssCache;
}

// Chrome/Chromium を探す（env 優先 → プラットフォーム別の定番パス）。
// 見つからなければ null（PDFはスキップする）。
export function findChrome() {
  const env = process.env.MARP_CHROME_PATH || process.env.CHROME_PATH;
  if (env && existsSync(env)) return env;
  const byPlatform = {
    darwin: [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ],
    linux: [
      '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium',
    ],
    win32: [
      'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
      'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    ],
  };
  const candidates = byPlatform[process.platform] || [];
  return candidates.find((p) => existsSync(p)) || null;
}

// レンダリング済みテーマCSSからスライド1枚の寸法（px）を取り出す。
// size 指示（4:3 等）にも追従する。取れなければ 16:9 の既定にフォールバック。
function slideSize(css) {
  const m = css.match(/section\s*\{[^}]*?width:\s*(\d+)px;\s*height:\s*(\d+)px/);
  return m ? { w: Number(m[1]), h: Number(m[2]) } : { w: 1280, h: 720 };
}

function buildHtmlDoc({ html, css, size, title }) {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Sans+JP:wght@400;500;700&family=IBM+Plex+Mono:wght@400;600&display=swap" rel="stylesheet">
<style>
${css}
</style>
<style>
/* ビューア/印刷の枠組み（テーマCSSとは分離） */
html, body { margin: 0; padding: 0; }
body { background: #e8e4db; }
.marpit { padding: 24px 0; }
.marpit > svg[data-marpit-svg] {
  display: block;
  width: min(96vw, ${size.w}px);
  height: auto;
  margin: 0 auto 20px;
  box-shadow: 0 4px 18px rgba(0, 0, 0, .14);
}
@media print {
  html, body { background: #fff; }
  .marpit { padding: 0; }
  .marpit > svg[data-marpit-svg] {
    width: 100%;
    height: 100%;
    margin: 0;
    box-shadow: none;
    break-after: page;
  }
  .marpit > svg[data-marpit-svg]:last-of-type { break-after: auto; }
  @page { size: ${size.w}px ${size.h}px; margin: 0; }
}
</style>
</head>
<body>
${html}
</body>
</html>`;
}

async function htmlToPdf(chrome, htmlFile, pdfPath) {
  const userDataDir = path.join(os.tmpdir(), `marp-chrome-${process.pid}-${Date.now()}`);
  const args = [
    '--headless',
    '--disable-gpu',
    '--no-sandbox',
    '--no-pdf-header-footer',
    '--virtual-time-budget=8000', // Webフォント読み込みを待つ
    `--user-data-dir=${userDataDir}`,
    `--print-to-pdf=${pdfPath}`,
    pathToFileURL(htmlFile).href,
  ];
  try {
    await execFileP(chrome, args, { timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
  } finally {
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
  if (!existsSync(pdfPath)) throw new Error('Chrome がPDFを生成しませんでした');
}

/**
 * Marp Markdown をスライドへレンダリングする。
 * @param {string} markdown  Marp Markdown 本文
 * @param {object} opts
 *   - theme    {string}   'firstch'（既定）/ 'default' / 'gaia' / 'uncover'。md内 theme 指示が優先される
 *   - formats  {string[]} ['html'] 既定。'html' / 'pdf' を指定
 *   - outputPath {string} 出力ファイルのベースパス（拡張子は format 側で決まる）。省略時は tmp
 *   - title    {string}   HTML の <title>（既定 'Marp slides'）
 * @returns {Promise<object>} { theme, slides, size, outputs: {html?, pdf?}, pdf_skipped? }
 */
export async function renderMarp(markdown, opts = {}) {
  if (typeof markdown !== 'string' || markdown.trim() === '') {
    throw new Error('markdown が空です');
  }
  const theme = opts.theme || 'firstch';
  if (!BUILTIN_THEMES.includes(theme)) {
    throw new Error(`未対応のテーマ: ${theme}（対応: ${BUILTIN_THEMES.join(' / ')}）`);
  }
  const formats = Array.isArray(opts.formats) && opts.formats.length ? opts.formats : ['html'];
  for (const f of formats) {
    if (f !== 'html' && f !== 'pdf') throw new Error(`未対応の format: ${f}（html / pdf のみ）`);
  }

  const base = opts.outputPath
    ? opts.outputPath.replace(/\.(html?|pdf)$/i, '')
    : path.join(os.tmpdir(), `marp-${process.pid}-${Date.now()}`);
  const title = opts.title || 'Marp slides';

  // marp-core は html:false（marp-cli既定と同じ）で生HTML注入を無効化。ディレクティブ用コメントは有効。
  const marp = new Marp({ html: false });
  marp.themeSet.add(await firstchThemeCss());
  marp.themeSet.default = marp.themeSet.get(theme);
  const { html, css } = marp.render(markdown);

  const slides = (html.match(/<section id=/g) || []).length;
  const size = slideSize(css);
  const doc = buildHtmlDoc({ html, css, size, title });

  const outputs = {};
  const wantHtml = formats.includes('html');
  const wantPdf = formats.includes('pdf');

  let htmlForPrint;
  if (wantHtml) {
    outputs.html = `${base}.html`;
    await writeFile(outputs.html, doc);
    htmlForPrint = outputs.html;
  }

  const result = { theme, slides, size, outputs };

  if (wantPdf) {
    const chrome = findChrome();
    if (!chrome) {
      result.pdf_skipped =
        'PDF出力にはローカルの Chrome/Chromium が必要ですが見つかりませんでした。' +
        '環境変数 MARP_CHROME_PATH で実行ファイルを指定できます。' +
        'または生成された HTML をブラウザで開き、印刷→PDFで保存してください（1スライド=1ページ）。';
    } else {
      // html を出力しない場合は印刷用の一時HTMLを使う
      let tempHtml;
      if (!htmlForPrint) {
        tempHtml = path.join(os.tmpdir(), `marp-print-${process.pid}-${Date.now()}.html`);
        await writeFile(tempHtml, doc);
        htmlForPrint = tempHtml;
      }
      try {
        outputs.pdf = `${base}.pdf`;
        await htmlToPdf(chrome, htmlForPrint, outputs.pdf);
      } catch (e) {
        delete outputs.pdf;
        result.pdf_skipped = `PDF生成に失敗しました: ${String(e.message || e)}`;
      } finally {
        if (tempHtml) await rm(tempHtml, { force: true }).catch(() => {});
      }
    }
  }

  return result;
}
