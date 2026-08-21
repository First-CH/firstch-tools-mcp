// QRコードの生成（tools.first-ch.com/qr/ と同一ロジック）
//
// 「生成のコア」ブロックは site 側の site/qr/app.js と同一の実装。
// 2箇所ルール: 片方を直したらもう片方も同じ内容で直す（site側が正本）。
// 使っているのは String/Array/Uint8Array/TextEncoder だけなので、ブラウザ版のコードを
// そのまま持ってこられる（PNGの書き出しだけは Node に Canvas が無いため pngjs を使う）。
// 実装は JIS X 0510 / ISO 18004 に沿っており、型番1〜40・誤り訂正レベル L/M/Q/H・
// 数字/英数字/バイト(UTF-8)モードに対応する。
import { writeFile } from 'node:fs/promises';
import { PNG } from 'pngjs';

export class QrError extends Error {}

/* ==================== ここから生成のコア（site / MCP で同一） ==================== */

/** 誤り訂正レベル（L=約7% / M=約15% / Q=約25% / H=約30%まで復元できる） */
export const QR_EC_LEVELS = ['L', 'M', 'Q', 'H'];
/** 形式情報に書き込むレベルの2bit表現（数字の大小と並びが一致しないので表で持つ） */
const QR_EC_BITS = { L: 1, M: 0, Q: 3, H: 2 };
/** 符号化モード（auto は入力を見て numeric → alnum → byte の順に選ぶ） */
export const QR_MODES = ['auto', 'numeric', 'alnum', 'byte'];
/** 英数字モードで使える45文字。この並び順がそのまま値（0〜44）になる */
const QR_ALNUM_CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
/** 1ブロックあたりの誤り訂正コード語数（添字＝型番1〜40。0番は未使用） */
const QR_ECC_PER_BLOCK = {
  L: [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  M: [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  Q: [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  H: [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
};
/** 誤り訂正ブロックの数（添字＝型番1〜40） */
const QR_BLOCKS = {
  L: [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  M: [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  Q: [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  H: [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
};
/** マスクのペナルティ点（JIS X 0510 の N1〜N4） */
const QR_PENALTY = { N1: 3, N2: 3, N3: 40, N4: 10 };

/** 文字列をUTF-8のバイト列にする（QRの8bitバイトモードはバイト列をそのまま載せる） */
function qrUtf8Bytes(text) {
  return new TextEncoder().encode(text);
}

/** 数字モードで書けるか（0〜9だけか） */
function qrIsNumeric(text) {
  return text.length > 0 && /^[0-9]+$/.test(text);
}

/** 英数字モードで書けるか（45文字の表に全部あるか。小文字は入らない） */
function qrIsAlnum(text) {
  if (text.length === 0) return false;
  for (const ch of text) {
    if (QR_ALNUM_CHARS.indexOf(ch) === -1) return false;
  }
  return true;
}

/** 入力に合う最も密なモードを選ぶ（数字 > 英数字 > バイト の順に容量が良い） */
function qrPickMode(text) {
  if (qrIsNumeric(text)) return 'numeric';
  if (qrIsAlnum(text)) return 'alnum';
  return 'byte';
}

/** 文字数指示子のビット数（型番の帯で変わる） */
function qrCharCountBits(mode, version) {
  const i = version <= 9 ? 0 : version <= 26 ? 1 : 2;
  if (mode === 'numeric') return [10, 12, 14][i];
  if (mode === 'alnum') return [9, 11, 13][i];
  return [8, 16, 16][i];
}

/** 型番ごとの、機能パターンと形式・型番情報を除いたデータ用モジュール数 */
function qrNumRawDataModules(version) {
  let result = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const numAlign = Math.floor(version / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (version >= 7) result -= 36;
  }
  return result;
}

/** 型番・誤り訂正レベルごとに載せられるデータコード語数 */
function qrNumDataCodewords(version, ecLevel) {
  return (
    Math.floor(qrNumRawDataModules(version) / 8) -
    QR_ECC_PER_BLOCK[ecLevel][version] * QR_BLOCKS[ecLevel][version]
  );
}

/** モードと入力の長さから、データ部に必要なビット数を求める */
function qrSegmentBits(mode, text, bytes, version) {
  const header = 4 + qrCharCountBits(mode, version);
  if (mode === 'numeric') {
    const n = text.length;
    return header + Math.floor(n / 3) * 10 + (n % 3 === 1 ? 4 : n % 3 === 2 ? 7 : 0);
  }
  if (mode === 'alnum') {
    const n = text.length;
    return header + Math.floor(n / 2) * 11 + (n % 2 === 1 ? 6 : 0);
  }
  return header + bytes.length * 8;
}

/** ビット列を組み立てる小さな入れ物（1要素＝1bit） */
function qrBitBuffer() {
  const bits = [];
  return {
    bits,
    push(value, len) {
      for (let i = len - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
    },
  };
}

/** 選んだモードでデータ部のビット列を書く */
function qrWriteSegment(bb, mode, text, bytes, version) {
  if (mode === 'numeric') {
    bb.push(0b0001, 4);
    bb.push(text.length, qrCharCountBits(mode, version));
    for (let i = 0; i < text.length; i += 3) {
      const chunk = text.slice(i, i + 3);
      bb.push(parseInt(chunk, 10), chunk.length * 3 + 1);
    }
    return;
  }
  if (mode === 'alnum') {
    bb.push(0b0010, 4);
    bb.push(text.length, qrCharCountBits(mode, version));
    for (let i = 0; i < text.length; i += 2) {
      const a = QR_ALNUM_CHARS.indexOf(text[i]);
      if (i + 1 < text.length) {
        bb.push(a * 45 + QR_ALNUM_CHARS.indexOf(text[i + 1]), 11);
      } else {
        bb.push(a, 6);
      }
    }
    return;
  }
  bb.push(0b0100, 4);
  bb.push(bytes.length, qrCharCountBits(mode, version));
  for (const b of bytes) bb.push(b, 8);
}

/** GF(256)（原始多項式 0x11D）の掛け算 */
function qrGfMul(x, y) {
  let z = 0;
  for (let i = 7; i >= 0; i -= 1) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** 次数degreeのリード・ソロモン生成多項式 */
function qrRsDivisor(degree) {
  const result = new Uint8Array(degree);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i += 1) {
    for (let j = 0; j < degree; j += 1) {
      result[j] = qrGfMul(result[j], root);
      if (j + 1 < degree) result[j] ^= result[j + 1];
    }
    root = qrGfMul(root, 0x02);
  }
  return result;
}

/** データコード語の剰余＝誤り訂正コード語 */
function qrRsRemainder(data, divisor) {
  const result = new Uint8Array(divisor.length);
  for (const b of data) {
    const factor = b ^ result[0];
    result.copyWithin(0, 1);
    result[result.length - 1] = 0;
    for (let i = 0; i < divisor.length; i += 1) result[i] ^= qrGfMul(divisor[i], factor);
  }
  return result;
}

/** データをブロックへ分け、誤り訂正コード語を付けて交互に並べ直す */
function qrAddEccAndInterleave(data, version, ecLevel) {
  const numBlocks = QR_BLOCKS[ecLevel][version];
  const eccLen = QR_ECC_PER_BLOCK[ecLevel][version];
  const rawCodewords = Math.floor(qrNumRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks = [];
  const divisor = qrRsDivisor(eccLen);
  for (let i = 0, k = 0; i < numBlocks; i += 1) {
    const len = shortBlockLen - eccLen + (i < numShortBlocks ? 0 : 1);
    const dat = data.slice(k, k + len);
    k += len;
    const block = Array.from(dat);
    const ecc = qrRsRemainder(dat, divisor);
    if (i < numShortBlocks) block.push(0); // 短いブロックは並べ替えのとき1つ空ける
    for (const b of ecc) block.push(b);
    blocks.push(block);
  }

  const result = new Uint8Array(rawCodewords);
  let p = 0;
  for (let i = 0; i < blocks[0].length; i += 1) {
    for (let j = 0; j < blocks.length; j += 1) {
      // 短いブロックのために空けた1つ（データ部の最後尾）だけ飛ばす
      if (i !== shortBlockLen - eccLen || j >= numShortBlocks) {
        result[p] = blocks[j][i];
        p += 1;
      }
    }
  }
  return result;
}

/** 型番から位置合わせパターンの中心座標を求める */
function qrAlignPositions(version) {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const size = version * 4 + 17;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** すべてのモジュールを白で初期化した作業用の面を作る */
function qrNewGrid(size) {
  const rows = [];
  for (let y = 0; y < size; y += 1) rows.push(new Uint8Array(size));
  return rows;
}

/** 機能パターン（位置検出・分離・タイミング・位置合わせ）を描く */
function qrDrawFunctionPatterns(modules, isFunction, version) {
  const size = modules.length;
  const set = (x, y, dark) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return;
    modules[y][x] = dark ? 1 : 0;
    isFunction[y][x] = 1;
  };

  // タイミングパターン（6行目・6列目の白黒の交互）
  for (let i = 0; i < size; i += 1) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }

  // 位置検出パターン3つ（分離パターンの白まで含めて9×9を塗る）
  for (const [cx, cy] of [[3, 3], [size - 4, 3], [3, size - 4]]) {
    for (let dy = -4; dy <= 4; dy += 1) {
      for (let dx = -4; dx <= 4; dx += 1) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        set(cx + dx, cy + dy, dist !== 2 && dist !== 4);
      }
    }
  }

  // 位置合わせパターン（3隅の位置検出パターンと重なる組み合わせは置かない）
  const pos = qrAlignPositions(version);
  const last = pos.length - 1;
  for (let i = 0; i <= last; i += 1) {
    for (let j = 0; j <= last; j += 1) {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          set(pos[i] + dx, pos[j] + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    }
  }

  // 形式情報の領域を機能パターンとして押さえる（中身はマスク確定後に書く）
  qrDrawFormatBits(modules, isFunction, 'M', 0);
  qrDrawVersionBits(modules, isFunction, version);
}

/** 形式情報15bit（誤り訂正レベル＋マスク番号＋BCH符号）を2か所へ書く */
function qrDrawFormatBits(modules, isFunction, ecLevel, mask) {
  const size = modules.length;
  const set = (x, y, dark) => {
    modules[y][x] = dark ? 1 : 0;
    isFunction[y][x] = 1;
  };
  const data = (QR_EC_BITS[ecLevel] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  const bits = ((data << 10) | rem) ^ 0x5412;
  const bit = (i) => ((bits >>> i) & 1) === 1;

  for (let i = 0; i <= 5; i += 1) set(8, i, bit(i));
  set(8, 7, bit(6));
  set(8, 8, bit(7));
  set(7, 8, bit(8));
  for (let i = 9; i < 15; i += 1) set(14 - i, 8, bit(i));

  for (let i = 0; i < 8; i += 1) set(size - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i += 1) set(8, size - 15 + i, bit(i));
  set(8, size - 8, true); // 常に黒のモジュール
}

/** 型番情報18bit（型番7以上のみ）を左下と右上へ書く */
function qrDrawVersionBits(modules, isFunction, version) {
  if (version < 7) return;
  const size = modules.length;
  let rem = version;
  for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i += 1) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    modules[b][a] = dark ? 1 : 0;
    isFunction[b][a] = 1;
    modules[a][b] = dark ? 1 : 0;
    isFunction[a][b] = 1;
  }
}

/** コード語を右下から2列ずつ、上下に折り返しながら置く */
function qrDrawCodewords(modules, isFunction, data) {
  const size = modules.length;
  let i = 0;
  for (let right = size - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5; // タイミングパターンの列は飛ばす
    for (let vert = 0; vert < size; vert += 1) {
      for (let j = 0; j < 2; j += 1) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? size - 1 - vert : vert;
        if (!isFunction[y][x] && i < data.length * 8) {
          modules[y][x] = (data[i >>> 3] >>> (7 - (i & 7))) & 1;
          i += 1;
        }
      }
    }
  }
}

/** マスクを掛ける（同じ関数をもう一度呼べば外れる） */
function qrApplyMask(modules, isFunction, mask) {
  const size = modules.length;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      if (isFunction[y][x]) continue;
      let invert = false;
      switch (mask) {
        case 0: invert = (x + y) % 2 === 0; break;
        case 1: invert = y % 2 === 0; break;
        case 2: invert = x % 3 === 0; break;
        case 3: invert = (x + y) % 3 === 0; break;
        case 4: invert = (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0; break;
        case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
        case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
        default: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
      }
      if (invert) modules[y][x] ^= 1;
    }
  }
}

/** 読み取りにくい並びへの減点（小さいほど読みやすい） */
function qrPenaltyScore(modules) {
  const size = modules.length;
  let result = 0;

  // N1: 同じ色が5つ以上続く並び（縦・横）
  const runScore = (len) => (len >= 5 ? QR_PENALTY.N1 + (len - 5) : 0);
  for (let y = 0; y < size; y += 1) {
    let runColor = modules[y][0];
    let runLen = 1;
    for (let x = 1; x < size; x += 1) {
      if (modules[y][x] === runColor) {
        runLen += 1;
      } else {
        result += runScore(runLen);
        runColor = modules[y][x];
        runLen = 1;
      }
    }
    result += runScore(runLen);
  }
  for (let x = 0; x < size; x += 1) {
    let runColor = modules[0][x];
    let runLen = 1;
    for (let y = 1; y < size; y += 1) {
      if (modules[y][x] === runColor) {
        runLen += 1;
      } else {
        result += runScore(runLen);
        runColor = modules[y][x];
        runLen = 1;
      }
    }
    result += runScore(runLen);
  }

  // N2: 同じ色の2×2のかたまり
  for (let y = 0; y < size - 1; y += 1) {
    for (let x = 0; x < size - 1; x += 1) {
      const c = modules[y][x];
      if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) {
        result += QR_PENALTY.N2;
      }
    }
  }

  // N3: 位置検出パターンに似た並び（1011101 の前後どちらかに白4つ）
  const finderLike = (get, n) => {
    let count = 0;
    for (let i = 0; i + 6 < n; i += 1) {
      const p = [];
      for (let k = 0; k < 7; k += 1) p.push(get(i + k));
      if (!(p[0] && !p[1] && p[2] && p[3] && p[4] && !p[5] && p[6])) continue;
      let before = true;
      for (let k = i - 4; k < i; k += 1) if (k >= 0 && get(k)) before = false;
      let after = true;
      for (let k = i + 7; k < i + 11; k += 1) if (k < n && get(k)) after = false;
      if (before || after) count += 1;
    }
    return count;
  };
  for (let y = 0; y < size; y += 1) result += QR_PENALTY.N3 * finderLike((x) => modules[y][x] === 1, size);
  for (let x = 0; x < size; x += 1) result += QR_PENALTY.N3 * finderLike((y) => modules[y][x] === 1, size);

  // N4: 黒の比率が50%からどれだけ離れているか（5%ごとに加点）
  let dark = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) dark += modules[y][x];
  }
  const total = size * size;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  result += Math.max(k, 0) * QR_PENALTY.N4;
  return result;
}

/**
 * 文字列をQRコードのモジュール配列にする。
 *
 * opts:
 *   ecLevel  'L' | 'M' | 'Q' | 'H'（既定 'M'）
 *   mode     'auto' | 'numeric' | 'alnum' | 'byte'（既定 'auto'）
 *   minVersion / maxVersion  型番の下限・上限（1〜40。既定 1〜40）
 *   mask     0〜7を指定すると固定。省略時はペナルティの一番低いものを選ぶ
 *
 * 返り値の modules は [y][x] の Uint8Array（1＝黒）。
 */
export function qrEncode(text, opts) {
  const o = opts || {};
  const src = typeof text === 'string' ? text : String(text == null ? '' : text);
  if (src.length === 0) throw new RangeError('empty input');
  const ecLevel = QR_EC_LEVELS.indexOf(o.ecLevel) === -1 ? 'M' : o.ecLevel;
  const minVersion = Math.min(Math.max(Math.trunc(o.minVersion || 1), 1), 40);
  const maxVersion = Math.min(Math.max(Math.trunc(o.maxVersion || 40), minVersion), 40);

  const wanted = QR_MODES.indexOf(o.mode) === -1 ? 'auto' : o.mode;
  const auto = qrPickMode(src);
  let mode = wanted === 'auto' ? auto : wanted;
  if (mode === 'numeric' && !qrIsNumeric(src)) mode = auto;
  if (mode === 'alnum' && !qrIsAlnum(src)) mode = auto;
  const bytes = qrUtf8Bytes(src);

  // 入りきる最小の型番を探す（文字数指示子のビット数が型番の帯で変わるので都度数え直す）
  let version = -1;
  let dataBits = 0;
  let capacityBits = 0;
  for (let v = minVersion; v <= maxVersion; v += 1) {
    const need = qrSegmentBits(mode, src, bytes, v);
    const room = qrNumDataCodewords(v, ecLevel) * 8;
    if (need <= room) {
      version = v;
      dataBits = need;
      capacityBits = room;
      break;
    }
  }
  if (version === -1) throw new RangeError('data too long');

  const bb = qrBitBuffer();
  qrWriteSegment(bb, mode, src, bytes, version);
  // 終端パターン（最大4bitの0）→ バイト境界まで0 → 埋め草を交互に
  for (let i = 0; i < 4 && bb.bits.length < capacityBits; i += 1) bb.bits.push(0);
  while (bb.bits.length % 8 !== 0) bb.bits.push(0);
  for (let pad = 0xec; bb.bits.length < capacityBits; pad ^= 0xec ^ 0x11) bb.push(pad, 8);

  const dataCodewords = new Uint8Array(bb.bits.length / 8);
  for (let i = 0; i < bb.bits.length; i += 1) {
    dataCodewords[i >>> 3] |= bb.bits[i] << (7 - (i & 7));
  }

  const size = version * 4 + 17;
  const modules = qrNewGrid(size);
  const isFunction = qrNewGrid(size);
  qrDrawFunctionPatterns(modules, isFunction, version);
  qrDrawCodewords(modules, isFunction, qrAddEccAndInterleave(dataCodewords, version, ecLevel));

  let mask = Number.isInteger(o.mask) && o.mask >= 0 && o.mask <= 7 ? o.mask : -1;
  if (mask === -1) {
    let best = Infinity;
    for (let m = 0; m < 8; m += 1) {
      qrApplyMask(modules, isFunction, m);
      qrDrawFormatBits(modules, isFunction, ecLevel, m);
      const score = qrPenaltyScore(modules);
      if (score < best) {
        best = score;
        mask = m;
      }
      qrApplyMask(modules, isFunction, m); // 同じマスクをもう一度掛けて元へ戻す
    }
  }
  qrApplyMask(modules, isFunction, mask);
  qrDrawFormatBits(modules, isFunction, ecLevel, mask);

  return {
    modules,
    size,
    version,
    ecLevel,
    mask,
    mode,
    dataBits,
    capacityBits,
    dataCodewords: dataCodewords.length,
    eccCodewords: QR_ECC_PER_BLOCK[ecLevel][version] * QR_BLOCKS[ecLevel][version],
    blocks: QR_BLOCKS[ecLevel][version],
    byteLength: bytes.length,
    charLength: src.length,
  };
}

/** 黒モジュールを横に連結した矩形の並びにする（SVG・Canvasで共通に使う） */
function qrDarkRuns(modules) {
  const runs = [];
  const size = modules.length;
  for (let y = 0; y < size; y += 1) {
    let x = 0;
    while (x < size) {
      if (!modules[y][x]) {
        x += 1;
        continue;
      }
      let w = 1;
      while (x + w < size && modules[y][x + w]) w += 1;
      runs.push([x, y, w]);
      x += w;
    }
  }
  return runs;
}

/**
 * モジュール配列をSVGの文字列にする。
 *
 * opts:
 *   size    出力の一辺（px。既定 320）
 *   margin  余白のモジュール数（クワイエットゾーン。既定 4）
 *   dark / light  前景色・背景色（light に 'none' を渡すと背景を描かない）
 */
export function qrMatrixToSvg(qr, opts) {
  const o = opts || {};
  const margin = Math.max(0, Math.trunc(o.margin == null ? 4 : o.margin));
  const px = Math.max(16, Math.trunc(o.size == null ? 320 : o.size));
  const dark = o.dark || '#000000';
  const light = o.light == null ? '#ffffff' : o.light;
  const span = qr.size + margin * 2;

  let d = '';
  for (const [x, y, w] of qrDarkRuns(qr.modules)) {
    d += `M${x + margin} ${y + margin}h${w}v1h-${w}z`;
  }
  const bg = light === 'none' || light === '' ? '' : `<rect width="${span}" height="${span}" fill="${light}"/>`;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${px}" height="${px}" viewBox="0 0 ${span} ${span}" ` +
    `shape-rendering="crispEdges" role="img" aria-label="QR code">` +
    bg +
    `<path fill="${dark}" d="${d}"/>` +
    `</svg>`
  );
}

/* ==================== ここまで生成のコア ==================== */

/** モジュール配列をPNG（RGBA・pngjs）のバッファにする。Node には Canvas が無いので自前で塗る */
export function qrMatrixToPng(qr, opts) {
  const o = opts || {};
  const margin = Math.max(0, Math.trunc(o.margin == null ? 4 : o.margin));
  const px = Math.max(16, Math.trunc(o.size == null ? 320 : o.size));
  const span = qr.size + margin * 2;
  const png = new PNG({ width: px, height: px });
  png.data.fill(0xff); // 背景は白（不透明）
  // モジュールの境目を整数pxへ丸める。丸めないと縁に半端な色が出る
  const at = (i) => Math.round((i * px) / span);
  for (let y = 0; y < qr.size; y += 1) {
    const y0 = at(y + margin);
    const y1 = at(y + 1 + margin);
    for (const [x, , w] of qrDarkRuns(qr.modules).filter((r) => r[1] === y)) {
      const x0 = at(x + margin);
      const x1 = at(x + w + margin);
      for (let py = y0; py < y1; py += 1) {
        for (let pxi = x0; pxi < x1; pxi += 1) {
          const i = (py * px + pxi) * 4;
          png.data[i] = 0;
          png.data[i + 1] = 0;
          png.data[i + 2] = 0;
          png.data[i + 3] = 0xff;
        }
      }
    }
  }
  return PNG.sync.write(png);
}

/** モジュール配列を端末に貼れる文字の図にする（1モジュール＝全角2文字ぶん） */
export function qrMatrixToText(qr, opts) {
  const o = opts || {};
  const margin = Math.max(0, Math.trunc(o.margin == null ? 4 : o.margin));
  const dark = o.dark || '██';
  const light = o.light || '  ';
  const span = qr.size + margin * 2;
  const blank = light.repeat(span);
  const lines = [];
  for (let i = 0; i < margin; i += 1) lines.push(blank);
  for (let y = 0; y < qr.size; y += 1) {
    let line = light.repeat(margin);
    for (let x = 0; x < qr.size; x += 1) line += qr.modules[y][x] ? dark : light;
    lines.push(line + light.repeat(margin));
  }
  for (let i = 0; i < margin; i += 1) lines.push(blank);
  return lines.join('\n') + '\n';
}

export const QR_FORMATS = ['svg', 'png', 'text'];

/**
 * URL・テキストからQRコードを作る（site側の /qr/ と同一ロジック）。
 *
 * @param {object} opts
 * @param {string} opts.text                       QRコードにする内容（UTF-8）
 * @param {'L'|'M'|'Q'|'H'} [opts.ecLevel='M']     誤り訂正レベル
 * @param {number} [opts.size=320]                 出力の一辺（px。64〜4096）
 * @param {number} [opts.margin=4]                 余白のモジュール数（規格の推奨は4）
 * @param {'svg'|'png'|'text'} [opts.format='svg'] 出力の形式
 * @param {'auto'|'numeric'|'alnum'|'byte'} [opts.mode='auto'] 符号化モード
 * @param {number} [opts.mask]                     マスク（0〜7。省略時は自動選択）
 * @param {number} [opts.minVersion]               型番の下限（1〜40）
 * @param {string} [opts.outputPath]               書き出す絶対パス（指定すると本文は返さない）
 * @returns {Promise<object>}
 */
export async function qrGenerateTool(opts = {}) {
  if (typeof opts.text !== 'string' || opts.text === '') {
    throw new QrError('QRコードにする内容（text）を渡してください');
  }
  // 画面側（URLパラメータ）は不正値を既定へ落とすが、MCPでは黙って別の設定で返さない
  const check = (name, value, allowed) => {
    if (value === undefined || value === null) return;
    if (allowed.indexOf(String(value)) === -1) {
      throw new QrError(`${name} は ${allowed.join(' / ')} のいずれかを指定してください（受け取った値: ${value}）`);
    }
  };
  check('ecLevel', opts.ecLevel, QR_EC_LEVELS);
  check('format', opts.format, QR_FORMATS);
  check('mode', opts.mode, QR_MODES);
  if (opts.mask !== undefined && opts.mask !== null) {
    if (!Number.isInteger(opts.mask) || opts.mask < 0 || opts.mask > 7) {
      throw new QrError(`mask は 0〜7 の整数を指定してください（受け取った値: ${opts.mask}）`);
    }
  }
  const size = opts.size == null ? 320 : Math.trunc(opts.size);
  if (!Number.isFinite(size) || size < 64 || size > 4096) {
    throw new QrError(`size は 64〜4096 の範囲で指定してください（受け取った値: ${opts.size}）`);
  }
  const margin = opts.margin == null ? 4 : Math.trunc(opts.margin);
  if (!Number.isFinite(margin) || margin < 0 || margin > 32) {
    throw new QrError(`margin は 0〜32 の範囲で指定してください（受け取った値: ${opts.margin}）`);
  }
  const format = opts.format || 'svg';

  let qr;
  try {
    qr = qrEncode(opts.text, {
      ecLevel: opts.ecLevel || 'M',
      mode: opts.mode || 'auto',
      mask: opts.mask,
      minVersion: opts.minVersion,
    });
  } catch (e) {
    // 容量超過は利用者が直せる入力の問題なので、そのまま投げずに理由を添える
    throw new QrError(
      `この誤り訂正レベルでは入りきりません（${opts.text.length}文字）。` +
      '文字数を減らすか、ecLevel を下げてください' +
      '（上限は数字7089桁・英数字4296文字・バイト2953文字。いずれもレベルL）',
    );
  }

  const result = {
    version: qr.version,
    modules: qr.size,
    ec_level: qr.ecLevel,
    mode: qr.mode,
    mask: qr.mask,
    size,
    margin,
    format,
    content: { chars: qr.charLength, bytes: qr.byteLength },
    capacity: {
      data_bits: qr.dataBits,
      capacity_bits: qr.capacityBits,
      used_percent: Math.round((qr.dataBits / qr.capacityBits) * 100),
      data_codewords: qr.dataCodewords,
      ecc_codewords: qr.eccCodewords,
      blocks: qr.blocks,
    },
  };

  if (format === 'png') {
    const buf = qrMatrixToPng(qr, { size, margin });
    if (opts.outputPath) {
      await writeFile(opts.outputPath, buf);
      result.output = opts.outputPath;
      result.bytes = buf.length;
    } else {
      // PNGは本文をそのまま返せないので data URI にする（ファイルへ書くほうが軽い）
      result.data_uri = `data:image/png;base64,${buf.toString('base64')}`;
      result.bytes = buf.length;
    }
    return result;
  }

  const body = format === 'text' ? qrMatrixToText(qr, { margin }) : qrMatrixToSvg(qr, { size, margin });
  if (opts.outputPath) {
    await writeFile(opts.outputPath, body, 'utf8');
    result.output = opts.outputPath;
    result.bytes = Buffer.byteLength(body);
  } else if (format === 'text') {
    result.text = body;
  } else {
    result.svg = body;
  }
  return result;
}
