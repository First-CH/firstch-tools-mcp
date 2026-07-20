// WebP変換（MCPツール用・Node実行）
// エンコーダはパッケージ内 packages/mcp/vendor/jsquash-webp の libwebp WASM を読み込む。
// これは site/vendor/jsquash-webp とバイト単位で同期させたコピー（CLAUDE.md「vendorコピーの同期ルール」対象・CIで検査）
// ＝ブラウザ版と同一品質・同一アルゴリズム。
// PNG/JPEG のデコードのみ Node に Canvas がないため pure-JS の pngjs / jpeg-js で行う。

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { PNG } from 'pngjs';
import jpeg from 'jpeg-js';
// encode.js は 'wasm-feature-detect' を bare import しており Node から解決できないため、
// emscripten グルーを直接読み込む（encode.js がSIMD対応環境で行うのと同じ組み合わせ）
import webpEncoder from './vendor/jsquash-webp/codec/enc/webp_enc_simd.js';
import { initEmscriptenModule } from './vendor/jsquash-webp/utils.js';
import { defaultOptions } from './vendor/jsquash-webp/meta.js';

let encoderReady;

function ensureEncoder() {
  if (!encoderReady) {
    encoderReady = (async () => {
      const wasmUrl = new URL('./vendor/jsquash-webp/codec/enc/webp_enc_simd.wasm', import.meta.url);
      const wasmModule = await WebAssembly.compile(await readFile(wasmUrl));
      return initEmscriptenModule(webpEncoder, wasmModule);
    })();
  }
  return encoderReady;
}

function decodeImage(buf, file) {
  if (buf[0] === 0x89 && buf[1] === 0x50) {
    const png = PNG.sync.read(buf);
    return { data: new Uint8ClampedArray(png.data), width: png.width, height: png.height };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    const img = jpeg.decode(buf, { useTArray: true, maxMemoryUsageInMB: 2048, maxResolutionInMP: 200 });
    return { data: new Uint8ClampedArray(img.data), width: img.width, height: img.height };
  }
  throw new Error(`${file}: PNG / JPEG のみ対応です（SVG・WebP入力は未対応）`);
}

/**
 * 1ファイルをWebPへ変換する。
 * @param {string} input  入力ファイルの絶対パス（PNG/JPEG）
 * @param {object} opts   { output?: 出力パス（既定=入力の拡張子を.webpに）, quality?: 1-100（既定80・サイト版と同じ） }
 * @returns {Promise<object>} { input, output, width, height, bytesIn, bytesOut, saving }
 */
export async function convertToWebp(input, opts = {}) {
  const encoder = await ensureEncoder();
  const quality = opts.quality ?? 80;
  const output = opts.output || input.replace(/\.[^.]+$/, '') + '.webp';
  const buf = await readFile(input);
  const image = decodeImage(buf, path.basename(input));
  const result = encoder.encode(image.data, image.width, image.height, { ...defaultOptions, quality });
  if (!result) throw new Error(`${path.basename(input)}: エンコードに失敗しました`);
  const webp = result.buffer;
  await writeFile(output, Buffer.from(webp));
  const bytesOut = webp.byteLength;
  return {
    input,
    output,
    width: image.width,
    height: image.height,
    bytesIn: buf.length,
    bytesOut,
    saving: `${(100 - (bytesOut / buf.length) * 100).toFixed(1)}%`,
  };
}
