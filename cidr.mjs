/* IPアドレス・CIDR計算（cidr_calc）
 * 計算コア（cidrParse / cidrCalc / cidrSplit / cidrSummarize ほか）は
 * FirstCHTools の site/cidr/app.js と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルからコアの開始/終了コメントに挟まれた範囲を sed で切り出し
 * （site側は字下げ2文字を落とす・こちらは行頭の export を落とす）、
 * diff が空になることで同期を機械的に確認できる。
 *
 * 使っているのは BigInt と String だけなので、ブラウザ版のコードをそのまま持ってこられる。
 * 完全ローカル処理・ネットワーク送信なし。 */

/* ==================== ここから計算コア（site / MCP で同一） ==================== */

export class CidrError extends Error {
  constructor(code, info) {
    super(code);
    this.name = 'CidrError';
    this.code = code;
    this.info = info || {};
  }
}

export const CIDR_BITS = { 4: 32, 6: 128 };

/** そのバージョンの全ビットが1の値（IPv4なら255.255.255.255） */
export function cidrFull(version) {
  return (1n << BigInt(CIDR_BITS[version])) - 1n;
}

/** プレフィックス長 → ネットマスクの数値 */
export function cidrMask(prefix, version) {
  const bits = CIDR_BITS[version];
  if (prefix <= 0) return 0n;
  return ((1n << BigInt(prefix)) - 1n) << BigInt(bits - prefix);
}

/** 左から1が連続しているか（ネットマスクとして成立するか）。成立すればプレフィックス長・しなければ -1 */
export function cidrMaskPrefix(value, version) {
  const bits = CIDR_BITS[version];
  let seenZero = false;
  let prefix = 0;
  for (let i = bits - 1; i >= 0; i--) {
    if (((value >> BigInt(i)) & 1n) === 1n) {
      if (seenZero) return -1;
      prefix++;
    } else {
      seenZero = true;
    }
  }
  return prefix;
}

/** ドット10進のIPv4を数値へ。IPv4の形をしていなければ null（形は合っていて値が不正なら例外） */
export function cidrParseIpv4(str) {
  const s = String(str).trim();
  if (!/^\d{1,3}(\.\d{1,3}){3}$/.test(s)) return null;
  let v = 0n;
  for (const part of s.split('.')) {
    // 先頭の0は 8進数と解釈する実装（inet_aton 系）があり、同じ表記で別のアドレスになるため受け取らない
    if (part.length > 1 && part.charAt(0) === '0') throw new CidrError('LEADING_ZERO', { text: s });
    const n = Number(part);
    if (n > 255) throw new CidrError('OCTET_RANGE', { text: s, octet: part });
    v = (v << 8n) | BigInt(n);
  }
  return v;
}

/** IPv6（:: の省略・末尾のIPv4表記・[] 囲み・%zone 付き）を数値へ。形が違えば null */
export function cidrParseIpv6(str) {
  let s = String(str).trim();
  if (s.charAt(0) === '[' && s.charAt(s.length - 1) === ']') s = s.slice(1, -1);
  let zone = '';
  const zi = s.indexOf('%');
  if (zi !== -1) {
    zone = s.slice(zi + 1);
    s = s.slice(0, zi);
  }
  if (s.indexOf(':') === -1) return null;
  if (!/^[0-9a-fA-F:.]+$/.test(s)) return null;
  // ::ffff:192.168.0.1 のように末尾がIPv4表記なら、16進の2グループへ置き換えてから読む
  if (s.indexOf('.') !== -1) {
    const di = s.lastIndexOf(':');
    const v4 = cidrParseIpv4(s.slice(di + 1));
    if (v4 === null) return null;
    s = s.slice(0, di + 1) + (v4 >> 16n).toString(16) + ':' + (v4 & 0xffffn).toString(16);
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] === '' ? [] : halves[0].split(':');
  const tail = halves.length === 2 ? (halves[1] === '' ? [] : halves[1].split(':')) : [];
  let groups;
  if (halves.length === 1) {
    if (head.length !== 8) return null;
    groups = head;
  } else {
    // :: は最低1グループを表すので、前後を足して7グループまで
    if (head.length + tail.length > 7) return null;
    groups = head.concat(new Array(8 - head.length - tail.length).fill('0'), tail);
  }
  let v = 0n;
  for (const g of groups) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
    v = (v << 16n) | BigInt(parseInt(g, 16));
  }
  return { value: v, zone: zone };
}

/** IPアドレス1つを読む。{ version, value, zone } */
export function cidrParseIp(str) {
  const s = String(str == null ? '' : str).trim();
  if (s === '') throw new CidrError('EMPTY', {});
  if (s.indexOf(':') !== -1) {
    const r = cidrParseIpv6(s);
    if (!r) throw new CidrError('BAD_IP', { text: s });
    return { version: 6, value: r.value, zone: r.zone };
  }
  const v4 = cidrParseIpv4(s);
  if (v4 === null) throw new CidrError('BAD_IP', { text: s });
  return { version: 4, value: v4, zone: '' };
}

/** 数値 → 表記。IPv6は RFC 5952（小文字・最長の0連続だけを :: に畳む） */
export function cidrFormatIp(value, version) {
  if (version === 4) {
    return [24n, 16n, 8n, 0n].map((sh) => ((value >> sh) & 255n).toString()).join('.');
  }
  const groups = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((value >> BigInt(i * 16)) & 0xffffn));
  let bestStart = -1;
  let bestLen = 0;
  let curStart = -1;
  let curLen = 0;
  for (let i = 0; i < 8; i++) {
    if (groups[i] === 0) {
      if (curStart === -1) {
        curStart = i;
        curLen = 0;
      }
      curLen++;
      // 同じ長さなら左を採る（> で比較しているので最初の並びが残る）
      if (curLen > bestLen) {
        bestLen = curLen;
        bestStart = curStart;
      }
    } else {
      curStart = -1;
      curLen = 0;
    }
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestLen < 2) return hex.join(':');
  return hex.slice(0, bestStart).join(':') + '::' + hex.slice(bestStart + bestLen).join(':');
}

/** 省略しない表記（IPv6は 4桁×8グループ） */
export function cidrExpandIp(value, version) {
  if (version === 4) return cidrFormatIp(value, version);
  const groups = [];
  for (let i = 7; i >= 0; i--) {
    groups.push(('000' + Number((value >> BigInt(i * 16)) & 0xffffn).toString(16)).slice(-4));
  }
  return groups.join(':');
}

/** 「192.168.1.0/24」「10.0.0.1 255.0.0.0」「192.168.1.5」などを読む */
export function cidrParse(input) {
  const raw = String(input == null ? '' : input).trim();
  if (raw === '') throw new CidrError('EMPTY', {});
  const s = raw.replace(/\s*\/\s*/, '/');
  let addrPart = s;
  let maskPart = '';
  const slash = s.indexOf('/');
  if (slash !== -1) {
    addrPart = s.slice(0, slash).trim();
    maskPart = s.slice(slash + 1).trim();
    if (maskPart === '') throw new CidrError('NO_PREFIX', { text: raw });
  } else {
    const two = s.match(/^(\S+)\s+(\S+)$/);
    if (two) {
      addrPart = two[1];
      maskPart = two[2];
    }
  }
  const ip = cidrParseIp(addrPart);
  const bits = CIDR_BITS[ip.version];
  let prefix = bits;
  let hadPrefix = false;
  let maskKind = 'prefix';
  if (maskPart !== '') {
    hadPrefix = true;
    if (/^\d+$/.test(maskPart)) {
      prefix = Number(maskPart);
      if (prefix > bits) throw new CidrError('BAD_PREFIX', { text: maskPart, max: bits, version: ip.version });
    } else {
      const mv = cidrParseIp(maskPart);
      if (mv.version !== ip.version) throw new CidrError('MASK_VERSION', { text: maskPart });
      const asMask = cidrMaskPrefix(mv.value, ip.version);
      if (asMask >= 0) {
        prefix = asMask;
        maskKind = 'netmask';
      } else {
        // 0.0.0.255 のようなワイルドカードマスク（ACLでよく使う）も受け取る
        const asWild = cidrMaskPrefix(~mv.value & cidrFull(ip.version), ip.version);
        if (asWild < 0) throw new CidrError('BAD_MASK', { text: maskPart });
        prefix = asWild;
        maskKind = 'wildcard';
      }
    }
  }
  return {
    version: ip.version,
    address: ip.value,
    prefix: prefix,
    hadPrefix: hadPrefix,
    maskKind: maskKind,
    zone: ip.zone,
    input: raw,
  };
}

/* 特別な用途に予約されたアドレス帯（IANA の Special-Purpose Address Registry から主要なものだけ）。
   表示用の文言は site / MCP がそれぞれ持ち、ここではキーだけを返す。 */
export const CIDR_SPECIAL_SRC = [
  ['0.0.0.0/8', 'thisnet'],
  ['10.0.0.0/8', 'private'],
  ['100.64.0.0/10', 'cgnat'],
  ['127.0.0.0/8', 'loopback'],
  ['169.254.0.0/16', 'linklocal'],
  ['172.16.0.0/12', 'private'],
  ['192.0.0.0/24', 'ietf'],
  ['192.0.2.0/24', 'doc'],
  ['192.88.99.0/24', 'relay6to4'],
  ['192.168.0.0/16', 'private'],
  ['198.18.0.0/15', 'benchmark'],
  ['198.51.100.0/24', 'doc'],
  ['203.0.113.0/24', 'doc'],
  ['224.0.0.0/4', 'multicast'],
  ['240.0.0.0/4', 'future'],
  ['255.255.255.255/32', 'broadcast'],
  ['::/128', 'unspecified'],
  ['::1/128', 'loopback'],
  ['::ffff:0:0/96', 'mapped'],
  ['64:ff9b::/96', 'nat64'],
  ['100::/64', 'discard'],
  ['2001::/32', 'teredo'],
  ['2001:db8::/32', 'doc'],
  ['2002::/16', 'relay6to4'],
  ['2000::/3', 'global'],
  ['fc00::/7', 'ula'],
  ['fe80::/10', 'linklocal'],
  ['ff00::/8', 'multicast'],
];
export let CIDR_SPECIAL_CACHE = null;

export function cidrSpecialList() {
  if (!CIDR_SPECIAL_CACHE) {
    CIDR_SPECIAL_CACHE = CIDR_SPECIAL_SRC.map((e) => {
      const p = cidrParse(e[0]);
      return { cidr: e[0], key: e[1], version: p.version, value: p.address & cidrMask(p.prefix, p.version), prefix: p.prefix };
    });
  }
  return CIDR_SPECIAL_CACHE;
}

/** そのアドレスがどの予約帯に入るか（いちばん細かい一致を採る） */
export function cidrScope(value, prefix, version) {
  let hit = null;
  for (const e of cidrSpecialList()) {
    if (e.version !== version) continue;
    if ((value & cidrMask(e.prefix, version)) === e.value) {
      if (!hit || e.prefix > hit.prefix) hit = e;
    }
  }
  if (!hit) return { key: version === 4 ? 'global' : 'reserved', cidr: null, coversAll: true };
  // prefix が予約帯より短い＝ネットワークが予約帯からはみ出している
  return { key: hit.key, cidr: hit.cidr, coversAll: prefix >= hit.prefix };
}

/** IPv4の歴史的なクラス（A/B/C/D/E） */
export function cidrClassOf(value) {
  const first = Number((value >> 24n) & 255n);
  if (first < 128) return 'A';
  if (first < 192) return 'B';
  if (first < 224) return 'C';
  if (first < 240) return 'D';
  return 'E';
}

/** 2進表記をグループ（IPv4は8bit×4・IPv6は16bit×8）の配列で返す */
export function cidrBinary(value, version) {
  const size = version === 4 ? 8 : 16;
  const count = version === 4 ? 4 : 8;
  const out = [];
  for (let i = count - 1; i >= 0; i--) {
    let s = '';
    for (let b = size - 1; b >= 0; b--) s += ((value >> BigInt(i * size + b)) & 1n).toString();
    out.push(s);
  }
  return out;
}

/** 逆引き（PTR）の名前 */
export function cidrPtr(value, version) {
  if (version === 4) {
    return [0n, 8n, 16n, 24n].map((sh) => ((value >> sh) & 255n).toString()).join('.') + '.in-addr.arpa';
  }
  return cidrExpandIp(value, 6).replace(/:/g, '').split('').reverse().join('.') + '.ip6.arpa';
}

/** 逆引きゾーン名。区切りに合わないプレフィックス（IPv4は8の倍数・IPv6は4の倍数以外）は null */
export function cidrPtrZone(value, prefix, version) {
  if (version === 4) {
    if (prefix % 8 !== 0) return null;
    if (prefix === 0) return 'in-addr.arpa';
    const o = [0n, 8n, 16n, 24n].map((sh) => ((value >> sh) & 255n).toString());
    return o.slice(4 - prefix / 8).join('.') + '.in-addr.arpa';
  }
  if (prefix % 4 !== 0) return null;
  const hex = cidrExpandIp(value, 6).replace(/:/g, '');
  const keep = hex.slice(0, prefix / 4).split('').reverse().join('.');
  return (keep ? keep + '.' : '') + 'ip6.arpa';
}

/** 2のべき乗ならその指数を返す（アドレス数の短い表示に使う）。違えば -1 */
export function cidrPowerOfTwo(n) {
  if (n <= 0n) return -1;
  let e = 0;
  let v = n;
  while (v > 1n) {
    if (v & 1n) return -1;
    v >>= 1n;
    e++;
  }
  return e;
}

/** CIDR 1件の計算。文字列でも cidrParse の結果でも受け取る */
export function cidrCalc(input) {
  const p = input && typeof input === 'object' && input.version ? input : cidrParse(input);
  const version = p.version;
  const bits = CIDR_BITS[version];
  const prefix = p.prefix;
  const mask = cidrMask(prefix, version);
  const network = p.address & mask;
  const last = network | (cidrFull(version) & ~mask);
  const total = 1n << BigInt(bits - prefix);
  let broadcast = null;
  let hostMin;
  let hostMax;
  let usable;
  if (version === 4) {
    if (prefix <= 30) {
      broadcast = last;
      hostMin = network + 1n;
      hostMax = last - 1n;
      usable = total - 2n;
    } else if (prefix === 31) {
      // RFC 3021: 2アドレスとも点対点リンクのホストに使える（ネットワーク/ブロードキャストを取らない）
      hostMin = network;
      hostMax = last;
      usable = 2n;
    } else {
      hostMin = network;
      hostMax = network;
      usable = 1n;
    }
  } else {
    // IPv6にブロードキャストは無い。先頭はサブネットルータ anycast だが範囲としては含める
    hostMin = network;
    hostMax = last;
    usable = total;
  }
  return {
    version: version,
    input: p.input,
    address: cidrFormatIp(p.address, version),
    addressExpanded: cidrExpandIp(p.address, version),
    prefix: prefix,
    hadPrefix: p.hadPrefix,
    maskKind: p.maskKind,
    zone: p.zone,
    cidr: cidrFormatIp(network, version) + '/' + prefix,
    inputCidr: cidrFormatIp(p.address, version) + '/' + prefix,
    isNetworkAddress: p.address === network,
    network: cidrFormatIp(network, version),
    broadcast: broadcast === null ? null : cidrFormatIp(broadcast, version),
    last: cidrFormatIp(last, version),
    netmask: cidrFormatIp(mask, version),
    wildcard: version === 4 ? cidrFormatIp(cidrFull(4) & ~mask, 4) : null,
    hostMin: cidrFormatIp(hostMin, version),
    hostMax: cidrFormatIp(hostMax, version),
    hasHosts: usable > 0n,
    networkBits: prefix,
    hostBits: bits - prefix,
    total: total.toString(),
    totalPow2: cidrPowerOfTwo(total),
    usable: usable.toString(),
    usablePow2: cidrPowerOfTwo(usable),
    scope: cidrScope(network, prefix, version),
    class: version === 4 ? cidrClassOf(network) : null,
    integer: network.toString(),
    hex: (version === 4 ? '0x' : '0x') + ('0'.repeat(version === 4 ? 8 : 32) + network.toString(16).toUpperCase()).slice(-(version === 4 ? 8 : 32)),
    ptr: cidrPtr(network, version),
    ptrZone: cidrPtrZone(network, prefix, version),
    binary: cidrBinary(network, version),
    binaryAddress: cidrBinary(p.address, version),
    values: { network: network, last: last, mask: mask, address: p.address },
  };
}

/** ネットワークを細かいプレフィックスへ分割する。limit 件で打ち切り、総数は count で返す */
export function cidrSplit(network, prefix, newPrefix, version, limit) {
  const bits = CIDR_BITS[version];
  if (!Number.isInteger(newPrefix) || newPrefix < 0 || newPrefix > bits) {
    throw new CidrError('BAD_PREFIX', { text: String(newPrefix), max: bits, version: version });
  }
  if (newPrefix < prefix) throw new CidrError('SPLIT_WIDER', { prefix: prefix, newPrefix: newPrefix });
  const count = 1n << BigInt(newPrefix - prefix);
  const step = 1n << BigInt(bits - newPrefix);
  const max = BigInt(limit == null ? 256 : limit);
  const subnets = [];
  let addr = network & cidrMask(prefix, version);
  for (let i = 0n; i < count && i < max; i++) {
    subnets.push({ network: addr, prefix: newPrefix, cidr: cidrFormatIp(addr, version) + '/' + newPrefix });
    addr += step;
  }
  return { count: count.toString(), step: step.toString(), subnets: subnets, truncated: count > max };
}

/** 開始〜終了のアドレス範囲を、過不足のない最小のCIDR集合へ分解する */
export function cidrFromRange(start, end, version) {
  if (start > end) throw new CidrError('RANGE_ORDER', { start: cidrFormatIp(start, version), end: cidrFormatIp(end, version) });
  const bits = BigInt(CIDR_BITS[version]);
  const out = [];
  let cur = start;
  while (cur <= end) {
    let size = 0n; // このアドレスから取れるブロックのホストビット数
    while (size < bits) {
      const next = size + 1n;
      const blockMask = (1n << next) - 1n;
      if ((cur & blockMask) !== 0n) break; // そろっていない
      if (cur + blockMask > end) break; // はみ出す
      size = next;
    }
    const prefix = Number(bits - size);
    out.push({ network: cur, prefix: prefix, cidr: cidrFormatIp(cur, version) + '/' + prefix });
    cur += 1n << size;
  }
  return out;
}

/** 重なり・隣接した範囲をまとめる */
export function cidrMergeRanges(ranges) {
  const sorted = ranges.slice().sort((a, b) => {
    if (a.start < b.start) return -1;
    if (a.start > b.start) return 1;
    if (a.end < b.end) return -1;
    if (a.end > b.end) return 1;
    return 0;
  });
  const out = [];
  for (const r of sorted) {
    const prev = out[out.length - 1];
    if (prev && r.start <= prev.end + 1n) {
      if (r.end > prev.end) prev.end = r.end;
    } else {
      out.push({ start: r.start, end: r.end });
    }
  }
  return out;
}

export function cidrRangeFromPair(a, b, source) {
  const s = cidrParseIp(a);
  const e = cidrParseIp(b);
  if (s.version !== e.version) throw new CidrError('MIXED_VERSION', { text: source });
  if (s.value > e.value) throw new CidrError('RANGE_ORDER', { start: a, end: b });
  return { start: s.value, end: e.value, version: s.version, source: source, kind: 'range' };
}

/** 1行を範囲として読む。CIDR・単体のIP・「a - b」「a ~ b」「a b」のいずれも受ける */
export function cidrParseRangeLine(line) {
  const s = String(line).trim();
  if (s === '' || s.charAt(0) === '#') return null;
  const dash = s.match(/^(\S+)\s*(?:\.\.|[-–—~,])\s*(\S+)$/);
  if (dash) return cidrRangeFromPair(dash[1], dash[2], s);
  try {
    const p = cidrParse(s);
    const mask = cidrMask(p.prefix, p.version);
    const network = p.address & mask;
    return {
      start: network,
      end: network | (cidrFull(p.version) & ~mask),
      version: p.version,
      source: s,
      kind: p.hadPrefix ? 'cidr' : 'ip',
      prefix: p.prefix,
    };
  } catch (err) {
    const two = s.match(/^(\S+)\s+(\S+)$/);
    if (two) return cidrRangeFromPair(two[1], two[2], s);
    throw err;
  }
}

/** 複数行（範囲・CIDR・単体IPの混在）をまとめて最小のCIDR集合にする */
export function cidrSummarize(text) {
  const lines = String(text == null ? '' : text).split(/\r\n|\n|\r/);
  const ranges = [];
  const errors = [];
  let version = null;
  for (let i = 0; i < lines.length; i++) {
    let r;
    try {
      r = cidrParseRangeLine(lines[i]);
    } catch (err) {
      if (!(err instanceof CidrError)) throw err;
      errors.push({ line: i + 1, text: lines[i].trim(), code: err.code, info: err.info });
      continue;
    }
    if (!r) continue;
    if (version === null) version = r.version;
    else if (version !== r.version) {
      errors.push({ line: i + 1, text: lines[i].trim(), code: 'MIXED_VERSION', info: {} });
      continue;
    }
    ranges.push(r);
  }
  const merged = cidrMergeRanges(ranges);
  const cidrs = [];
  for (const r of merged) {
    for (const c of cidrFromRange(r.start, r.end, version)) cidrs.push(c);
  }
  let total = 0n;
  for (const r of merged) total += r.end - r.start + 1n;
  return {
    version: version,
    inputCount: ranges.length,
    ranges: ranges,
    merged: merged.map((r) => ({
      start: cidrFormatIp(r.start, version),
      end: cidrFormatIp(r.end, version),
      count: (r.end - r.start + 1n).toString(),
    })),
    cidrs: cidrs.map((c) => c.cidr),
    total: total.toString(),
    errors: errors,
  };
}

/** そのアドレスがネットワークに含まれるか */
export function cidrContains(network, prefix, version, value) {
  const mask = cidrMask(prefix, version);
  return (value & mask) === (network & mask);
}

/* ==================== ここまで計算コア ==================== */

/* ---- ここから下はMCP側だけの層（入出力・文言）。site側の app.js には UI 用の同じ文言表がある ---- */

export class CidrCalcError extends Error {}

const SCOPE_JA = {
  private: 'プライベート（RFC 1918）',
  cgnat: 'キャリアグレードNAT（RFC 6598）',
  loopback: 'ループバック',
  linklocal: 'リンクローカル',
  thisnet: '「このネットワーク」',
  ietf: 'IETFプロトコル用',
  doc: '文書・例示用',
  relay6to4: '6to4 リレー',
  benchmark: '性能試験用',
  multicast: 'マルチキャスト',
  future: '将来用に予約',
  broadcast: '限定ブロードキャスト',
  global: 'グローバル（インターネット側）',
  unspecified: '未指定アドレス',
  mapped: 'IPv4射影アドレス',
  nat64: 'NAT64 用',
  discard: '破棄専用',
  teredo: 'Teredo',
  ula: 'ユニークローカル（IPv6の私設用）',
  reserved: '未割り当て・予約',
};

const SCOPE_EN = {
  private: 'Private (RFC 1918)',
  cgnat: 'Carrier-grade NAT (RFC 6598)',
  loopback: 'Loopback',
  linklocal: 'Link-local',
  thisnet: '"This network"',
  ietf: 'IETF protocol assignments',
  doc: 'Documentation / examples',
  relay6to4: '6to4 relay',
  benchmark: 'Benchmarking',
  multicast: 'Multicast',
  future: 'Reserved for future use',
  broadcast: 'Limited broadcast',
  global: 'Global unicast (routable)',
  unspecified: 'Unspecified address',
  mapped: 'IPv4-mapped',
  nat64: 'NAT64 prefix',
  discard: 'Discard-only',
  teredo: 'Teredo',
  ula: 'Unique local (private)',
  reserved: 'Reserved / unassigned',
};

const ERR_JA = {
  EMPTY: () => '入力が空です。',
  BAD_IP: (i) => `IPアドレスとして読めません: ${i.text} — IPv4は 192.168.1.10、IPv6は 2001:db8::1 のように書きます。`,
  LEADING_ZERO: (i) =>
    `先頭に0の付いた数字があります: ${i.text} — 8進数として読む実装があり別のアドレスになるため、0を外して書いてください（010 → 10）。`,
  OCTET_RANGE: (i) => `IPv4の各数字は0〜255までです: ${i.text}（${i.octet} が範囲外）。`,
  BAD_PREFIX: (i) => `プレフィックス長が範囲外です: /${i.text} — IPv${i.version} は 0〜${i.max} です。`,
  NO_PREFIX: () => '/ の後ろにプレフィックス長がありません（例: /24）。',
  BAD_MASK: (i) => `サブネットマスクとして成立しません: ${i.text} — 1が左から連続している必要があります（255.255.255.0 など）。`,
  MASK_VERSION: (i) => `アドレスとマスクのIPバージョンが違います: ${i.text}`,
  MIXED_VERSION: () => 'IPv4とIPv6が混ざっています。どちらかに揃えてください。',
  RANGE_ORDER: (i) => `開始が終了より後ろになっています: ${i.start} → ${i.end}`,
  SPLIT_WIDER: (i) => `/${i.newPrefix} は元の /${i.prefix} より大きい範囲です。分割するには元より長いプレフィックスを選びます。`,
};

const ERR_EN = {
  EMPTY: () => 'The input is empty.',
  BAD_IP: (i) => `Not a valid IP address: ${i.text} — write IPv4 as 192.168.1.10 or IPv6 as 2001:db8::1.`,
  LEADING_ZERO: (i) =>
    `An octet has a leading zero: ${i.text} — some libraries read that as octal, which is a different address. Drop the zero (010 → 10).`,
  OCTET_RANGE: (i) => `Each IPv4 octet must be 0–255: ${i.text} (${i.octet} is out of range).`,
  BAD_PREFIX: (i) => `Prefix length out of range: /${i.text} — IPv${i.version} allows 0–${i.max}.`,
  NO_PREFIX: () => 'Nothing after the slash — write a prefix length such as /24.',
  BAD_MASK: (i) => `Not a valid subnet mask: ${i.text} — the 1 bits must be contiguous from the left (255.255.255.0 and so on).`,
  MASK_VERSION: (i) => `Address and mask are different IP versions: ${i.text}`,
  MIXED_VERSION: () => 'IPv4 and IPv6 are mixed. Use one family at a time.',
  RANGE_ORDER: (i) => `The start address comes after the end: ${i.start} → ${i.end}`,
  SPLIT_WIDER: (i) => `/${i.newPrefix} is larger than the original /${i.prefix}. Pick a longer prefix to split into.`,
};

const NOTE_JA = {
  NO_PREFIX: (n) => `プレフィックスが無いので /${n.prefix}（1アドレスだけ）として計算しました。範囲を見るなら ${n.address}/24 のように書きます。`,
  HOST_BITS: (n) => `${n.address} はホスト部にビットが立っています。この /${n.prefix} のネットワークは ${n.cidr} です（設定ファイルに書くときはこちら）。`,
  MASK_GIVEN: (n) => `サブネットマスク ${n.mask} を /${n.prefix} として読みました。`,
  WILDCARD_GIVEN: (n) => `ワイルドカードマスク ${n.mask} を /${n.prefix} として読みました（ACLの書き方）。`,
  P2P: () => '/31 は点対点リンク用で、2つのアドレスをどちらもホストに使えます（RFC 3021）。ネットワーク/ブロードキャストは取りません。',
  SINGLE: () => '/32 は1台だけを指す書き方です（許可リストではこの形を使います）。',
  V6_NO_BROADCAST: () => 'IPv6にブロードキャストはありません。先頭のアドレスはサブネットルータanycastとして予約されています。',
  V6_SLAAC: () => 'IPv6のLANセグメントは /64 が基本です。これより細かく切るとSLAAC（ホストが自分でアドレスを作る仕組み）が動きません。',
  SCOPE_PARTIAL: (n) => `このネットワークは ${n.cidr}（${n.label}）からはみ出しています。一部だけが重なっています。`,
  SPLIT_TRUNCATED: (n) => `全 ${n.count} 個のうち先頭 ${n.shown} 個だけを返しました。limit を上げると増やせます。`,
  RANGE_MERGED: (n) => `${n.input} 行を ${n.merged} つの連続した範囲にまとめ、${n.cidrs} 個のCIDRで過不足なく表せました。`,
};

const NOTE_EN = {
  NO_PREFIX: (n) => `No prefix was given, so this was read as /${n.prefix} (a single address). Write it as ${n.address}/24 to see a range.`,
  HOST_BITS: (n) => `${n.address} has bits set in the host part. The network it belongs to is ${n.cidr} — use that form in config files.`,
  MASK_GIVEN: (n) => `The subnet mask ${n.mask} was read as /${n.prefix}.`,
  WILDCARD_GIVEN: (n) => `The wildcard mask ${n.mask} was read as /${n.prefix} (the ACL convention).`,
  P2P: () => 'A /31 is for point-to-point links: both addresses are usable hosts (RFC 3021), with no network or broadcast address.',
  SINGLE: () => 'A /32 names a single host — the form used in allow lists.',
  V6_NO_BROADCAST: () => 'IPv6 has no broadcast address. The first address of a subnet is reserved for the subnet-router anycast.',
  V6_SLAAC: () => 'IPv6 LAN segments are /64 by convention. Splitting below that stops SLAAC (hosts building their own addresses) from working.',
  SCOPE_PARTIAL: (n) => `This network extends beyond ${n.cidr} (${n.label}); only part of it overlaps that reserved range.`,
  SPLIT_TRUNCATED: (n) => `Returned the first ${n.shown} of ${n.count} subnets. Raise limit to get more.`,
  RANGE_MERGED: (n) => `Merged ${n.input} lines into ${n.merged} contiguous range(s), covered exactly by ${n.cidrs} CIDR block(s).`,
};

const errText = (lang, code, info) => {
  const table = lang === 'en' ? ERR_EN : ERR_JA;
  return table[code] ? table[code](info || {}) : code;
};

const noteText = (lang, code, info) => {
  const table = lang === 'en' ? NOTE_EN : NOTE_JA;
  return { code: code, message: table[code] ? table[code](info || {}) : code };
};

const scopeLabel = (lang, key) => (lang === 'en' ? SCOPE_EN : SCOPE_JA)[key] || key;

/** 計算結果1件をMCPの戻り値の形へ（BigIntは残さず文字列にする） */
function shapeCalc(r, lang) {
  const notes = [];
  if (!r.hadPrefix) notes.push(noteText(lang, 'NO_PREFIX', { prefix: r.prefix, address: r.address }));
  else if (!r.isNetworkAddress) notes.push(noteText(lang, 'HOST_BITS', { address: r.address, prefix: r.prefix, cidr: r.cidr }));
  if (r.maskKind === 'netmask') notes.push(noteText(lang, 'MASK_GIVEN', { mask: r.netmask, prefix: r.prefix }));
  if (r.maskKind === 'wildcard') notes.push(noteText(lang, 'WILDCARD_GIVEN', { mask: r.wildcard, prefix: r.prefix }));
  if (r.version === 4 && r.prefix === 31) notes.push(noteText(lang, 'P2P', {}));
  if (r.version === 4 && r.prefix === 32) notes.push(noteText(lang, 'SINGLE', {}));
  if (r.version === 6) notes.push(noteText(lang, 'V6_NO_BROADCAST', {}));
  if (r.version === 6 && r.prefix > 64) notes.push(noteText(lang, 'V6_SLAAC', {}));
  if (!r.scope.coversAll) notes.push(noteText(lang, 'SCOPE_PARTIAL', { cidr: r.scope.cidr, label: scopeLabel(lang, r.scope.key) }));

  const out = {
    version: r.version,
    input: r.input,
    address: r.address,
    prefix: r.prefix,
    cidr: r.cidr,
    is_network_address: r.isNetworkAddress,
    network: r.network,
    netmask: r.netmask,
    host_min: r.hostMin,
    host_max: r.hostMax,
    total_addresses: r.total,
    usable_hosts: r.usable,
    network_bits: r.networkBits,
    host_bits: r.hostBits,
    type: { key: r.scope.key, label: scopeLabel(lang, r.scope.key), block: r.scope.cidr, covers_all: r.scope.coversAll },
    integer: r.integer,
    hex: r.hex,
    reverse_dns: r.ptr,
    reverse_zone: r.ptrZone,
    binary: r.binary.join(r.version === 4 ? '.' : ':'),
    notes: notes,
  };
  if (r.version === 4) {
    out.broadcast = r.broadcast;
    out.wildcard = r.wildcard;
    out.class = r.class;
  } else {
    out.last_address = r.last;
    out.expanded = r.addressExpanded;
    if (r.zone) out.zone = r.zone;
  }
  return out;
}

/**
 * MCPツール cidr_calc の本体。CIDRの計算・サブネット分割・包含判定・範囲の逆算を1つで受ける。
 * 計算そのものは計算コア（site版と同一）に任せ、ここは入出力と文言だけを持つ。
 */
export async function cidrCalcTool(opts = {}) {
  const o = opts || {};
  const lang = o.lang === undefined ? 'ja' : o.lang;
  if (lang !== 'ja' && lang !== 'en') throw new CidrCalcError(`lang は ja か en: ${o.lang}`);

  const hasCidr = typeof o.cidr === 'string' && o.cidr.trim() !== '';
  const hasRange = typeof o.range === 'string' && o.range.trim() !== '';
  // 「split だけ渡した」のように狙いが分かるものは、先に具体的な言い方で返す
  if (o.split !== undefined && !hasCidr) throw new CidrCalcError('split は cidr と一緒に渡してください');
  if (o.contains !== undefined && !hasCidr) throw new CidrCalcError('contains は cidr と一緒に渡してください');
  if (!hasCidr && !hasRange) throw new CidrCalcError('cidr か range のどちらかを渡してください');
  if (o.contains !== undefined && !Array.isArray(o.contains)) throw new CidrCalcError('contains は文字列の配列です');
  if (o.split !== undefined && !Number.isInteger(o.split)) throw new CidrCalcError(`split は整数のプレフィックス長です: ${o.split}`);
  if (o.limit !== undefined && !(Number.isInteger(o.limit) && o.limit >= 1 && o.limit <= 4096)) {
    throw new CidrCalcError(`limit は 1〜4096 の整数です: ${o.limit}`);
  }
  const limit = o.limit === undefined ? 256 : o.limit;

  const result = { ok: true };

  let calc = null;
  if (hasCidr) {
    try {
      calc = cidrCalc(o.cidr);
    } catch (err) {
      if (!(err instanceof CidrError)) throw err;
      // 入力が壊れているのは「呼び出し方の誤り」ではないので、例外ではなく結果として返す
      return { ok: false, input: o.cidr, error: { code: err.code, message: errText(lang, err.code, err.info) } };
    }
    Object.assign(result, shapeCalc(calc, lang));
  }

  if (o.split !== undefined) {
    let sp;
    try {
      sp = cidrSplit(calc.values.network, calc.prefix, o.split, calc.version, limit);
    } catch (err) {
      if (!(err instanceof CidrError)) throw err;
      return { ok: false, input: o.cidr, error: { code: err.code, message: errText(lang, err.code, err.info) } };
    }
    result.subnets = {
      prefix: o.split,
      count: sp.count,
      addresses_each: sp.step,
      truncated: sp.truncated,
      list: sp.subnets.map((s) => {
        const c = cidrCalc(s.cidr);
        const row = { cidr: c.cidr, network: c.network, host_min: c.hostMin, host_max: c.hostMax };
        if (c.version === 4) row.broadcast = c.broadcast;
        else row.last_address = c.last;
        return row;
      }),
    };
    if (sp.truncated) {
      result.notes = (result.notes || []).concat([
        noteText(lang, 'SPLIT_TRUNCATED', { count: sp.count, shown: sp.subnets.length }),
      ]);
    }
  }

  if (o.contains !== undefined) {
    result.contains = o.contains.map((raw) => {
      let ip;
      try {
        ip = cidrParseIp(raw);
      } catch (err) {
        if (!(err instanceof CidrError)) throw err;
        return { address: String(raw), inside: null, error: { code: err.code, message: errText(lang, err.code, err.info) } };
      }
      if (ip.version !== calc.version) {
        return { address: cidrFormatIp(ip.value, ip.version), inside: null, error: { code: 'MIXED_VERSION', message: errText(lang, 'MIXED_VERSION', {}) } };
      }
      return {
        address: cidrFormatIp(ip.value, ip.version),
        inside: cidrContains(calc.values.network, calc.prefix, calc.version, ip.value),
      };
    });
  }

  if (hasRange) {
    const s = cidrSummarize(o.range.split(';').join('\n'));
    result.range = {
      version: s.version,
      input_count: s.inputCount,
      merged: s.merged,
      cidrs: s.cidrs,
      total_addresses: s.total,
      errors: s.errors.map((e) => ({ line: e.line, text: e.text, code: e.code, message: errText(lang, e.code, e.info) })),
    };
    if (s.merged.length && s.inputCount > s.merged.length) {
      result.range.notes = [noteText(lang, 'RANGE_MERGED', { input: s.inputCount, merged: s.merged.length, cidrs: s.cidrs.length })];
    }
  }

  return result;
}
