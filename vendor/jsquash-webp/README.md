# vendor/jsquash-webp（サブセットコピー）

出所: `site/vendor/jsquash-webp`（`@jsquash/webp` v1.5.0）のサブセットコピー。

npm パッケージ `@first-ch/tools-mcp` は tarball としてパッケージルート外を参照できないため、
`packages/mcp/webp.mjs` が必要とする以下6ファイルのみを、相対ディレクトリ構造を保ったままここへ複製している。

- `utils.js`
- `meta.js`
- `codec/enc/webp_enc_simd.js`
- `codec/enc/webp_enc_simd.wasm`
- `LICENSE`
- `codec/LICENSE.codec.md`

非SIMD版（`webp_enc.js` / `webp_enc.wasm`）はパッケージサイズを不必要に増やさないため含めていない。

## ライセンス

- jSquash 部分（`utils.js` / `meta.js` 等）: Apache-2.0（`LICENSE`）
- libwebp codec 部分（`codec/enc/webp_enc_simd.*`）: BSD-3-Clause（`codec/LICENSE.codec.md`）。同梱WASMの実体は libwebp v1.0.2（Copyright (c) 2010 Google Inc.）

## 同期ルール

**site側 vendor（`site/vendor/jsquash-webp`）を更新したら、`packages/mcp` 側も同一コミットで更新すること。**
CIが `cmp` でバイト一致を検査するため、片方だけ更新するとCIが落ちる。
