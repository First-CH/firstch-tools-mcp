/* htpasswd ジェネレーター（htpasswd_generate）
 * ハッシュのコア（md5 / md5crypt / bcrypt / htpasswdLine / verifyHash ほか）は
 * FirstCHTools の site/htpasswd/app.js と同一
 * （2箇所ルール: site側が正本・片方を直したらもう片方も同じ内容で反映する）。
 * 両ファイルからコアの開始/終了コメントに挟まれた範囲を sed で切り出し
 * （site側は字下げ2文字を落とす・こちらは行頭の export を落とす）、
 * diff が空になることで同期を機械的に確認できる。
 * コアの直後の補助（randomPassword / parseBulk / isIPv6 / parseIps / snippet）も
 * site側の「パスワードの自動生成」〜「UI文言」の直前と同一。
 * 入力の検査（USER_EMPTY・PW_SHORT など）は site側の画面処理 generate() の判定を写したもの。
 *
 * 乱数（ソルト・自動生成のパスワード）は crypto.getRandomValues（Node の Web Crypto）。
 * パスワードはどこにも記録しない（notes にも入れない）。完全ローカル処理・ネットワーク送信なし。 */

import { isAbsolute } from 'node:path';
import { writeOutput } from './fs-safe.mjs';

/* ==================== ここからハッシュのコア ==================== */

export const utf8 = (s) => new TextEncoder().encode(s);

export function randomBytes(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

/* ---- MD5（apr1 用。RFC 1321） ---- */

export const MD5_S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];
export const MD5_K = (() => {
  const k = new Uint32Array(64);
  for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0;
  return k;
})();

/** @param {Uint8Array} msg @returns {Uint8Array} 16 bytes */
export function md5(msg) {
  const len = msg.length;
  const total = (((len + 8) >>> 6) + 1) << 6;
  const buf = new Uint8Array(total);
  buf.set(msg);
  buf[len] = 0x80;
  const bits = len * 8;
  const dv = new DataView(buf.buffer);
  dv.setUint32(total - 8, bits >>> 0, true);
  dv.setUint32(total - 4, Math.floor(bits / 4294967296), true);
  let a0 = 0x67452301, b0 = 0xefcdab89, c0 = 0x98badcfe, d0 = 0x10325476;
  const m = new Uint32Array(16);
  for (let off = 0; off < total; off += 64) {
    for (let i = 0; i < 16; i++) m[i] = dv.getUint32(off + i * 4, true);
    let a = a0, b = b0, c = c0, d = d0;
    for (let i = 0; i < 64; i++) {
      let f, g;
      if (i < 16) { f = (b & c) | (~b & d); g = i; }
      else if (i < 32) { f = (d & b) | (~d & c); g = (5 * i + 1) & 15; }
      else if (i < 48) { f = b ^ c ^ d; g = (3 * i + 5) & 15; }
      else { f = c ^ (b | ~d); g = (7 * i) & 15; }
      const s = MD5_S[(i >>> 4) * 4 + (i & 3)];
      const x = (a + f + MD5_K[i] + m[g]) | 0;
      a = d; d = c; c = b;
      b = (b + ((x << s) | (x >>> (32 - s)))) | 0;
    }
    a0 = (a0 + a) | 0; b0 = (b0 + b) | 0; c0 = (c0 + c) | 0; d0 = (d0 + d) | 0;
  }
  const out = new Uint8Array(16);
  const ov = new DataView(out.buffer);
  ov.setUint32(0, a0 >>> 0, true); ov.setUint32(4, b0 >>> 0, true);
  ov.setUint32(8, c0 >>> 0, true); ov.setUint32(12, d0 >>> 0, true);
  return out;
}

export function concat(...parts) {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

/* ---- apr1-md5（Apache の md5crypt。magic が $apr1$ なだけで $1$ と同じ手順） ---- */

export const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/**
 * @param {Uint8Array} pw パスワード（UTF-8）
 * @param {string} salt ITOA64 の文字で最大8文字
 * @param {string} [magic] '$apr1$' または '$1$'
 */
export function md5crypt(pw, salt, magic = '$apr1$') {
  salt = salt.slice(0, 8);
  const sb = utf8(salt);
  const mb = utf8(magic);
  const alt = md5(concat(pw, sb, pw));
  const parts = [pw, mb, sb];
  for (let pl = pw.length; pl > 0; pl -= 16) parts.push(alt.subarray(0, Math.min(16, pl)));
  for (let i = pw.length; i; i >>>= 1) parts.push(i & 1 ? new Uint8Array(1) : pw.subarray(0, 1));
  let fin = md5(concat(...parts));
  for (let i = 0; i < 1000; i++) {
    const c = [i & 1 ? pw : fin];
    if (i % 3) c.push(sb);
    if (i % 7) c.push(pw);
    c.push(i & 1 ? fin : pw);
    fin = md5(concat(...c));
  }
  let out = '';
  const to64 = (v, n) => { for (; n > 0; n--) { out += ITOA64[v & 0x3f]; v >>>= 6; } };
  for (const [a, b, c] of [[0, 6, 12], [1, 7, 13], [2, 8, 14], [3, 9, 15], [4, 10, 5]]) {
    to64((fin[a] << 16) | (fin[b] << 8) | fin[c], 4);
  }
  to64(fin[11], 2);
  return magic + salt + '$' + out;
}

export function apr1Salt() {
  // 64種の文字なので 256 を 64 で割った余りに偏りは出ない
  return Array.from(randomBytes(8), (b) => ITOA64[b & 63]).join('');
}

/* ---- bcrypt（$2y$。OpenBSD の eksblowfish） ---- */

// Blowfish の初期値（P配列18語＋Sボックス 4×256語）＝円周率の小数部の16進表記
export const BF_INIT_HEX =
  '243f6a8885a308d313198a2e03707344a4093822299f31d0082efa98ec4e6c89452821e638d01377be5466cf34e90c6c' +
  'c0ac29b7c97c50dd3f84d5b5b54709179216d5d98979fb1bd1310ba698dfb5ac2ffd72dbd01adfb7b8e1afed6a267e96' +
  'ba7c9045f12c7f9924a19947b3916cf70801f2e2858efc16636920d871574e69a458fea3f4933d7e0d95748f728eb658' +
  '718bcd5882154aee7b54a41dc25a59b59c30d5392af26013c5d1b023286085f0ca417918b8db38ef8e79dcb0603a180e' +
  '6c9e0e8bb01e8a3ed71577c1bd314b2778af2fda55605c60e65525f3aa55ab945748986263e8144055ca396a2aab10b6' +
  'b4cc5c341141e8cea15486af7c72e993b3ee1411636fbc2a2ba9c55d741831f6ce5c3e169b87931eafd6ba336c24cf5c' +
  '7a325381289586773b8f48986b4bb9afc4bfe81b6628219361d809ccfb21a991487cac605dec8032ef845d5de98575b1' +
  'dc262302eb651b8823893e81d396acc50f6d6ff383f442392e0b4482a484200469c8f04a9e1f9b5e21c66842f6e96c9a' +
  '670c9c61abd388f06a51a0d2d8542f68960fa728ab5133a36eef0b6c137a3be4ba3bf0507efb2a98a1f1651d39af0176' +
  '66ca593e82430e888cee8619456f9fb47d84a5c33b8b5ebee06f75d885c12073401a449f56c16aa64ed3aa62363f7706' +
  '1bfedf72429b023d37d0d724d00a1248db0fead349f1c09b075372c980991b7b25d479d8f6e8def7e3fe501ab6794c3b' +
  '976ce0bd04c006bac1a94fb6409f60c45e5c9ec2196a246368fb6faf3e6c53b51339b2eb3b52ec6f6dfc511f9b30952c' +
  'cc814544af5ebd09bee3d004de334afd660f2807192e4bb3c0cba85745c8740fd20b5f39b9d3fbdb5579c0bd1a60320a' +
  'd6a100c6402c7279679f25fefb1fa3cc8ea5e9f8db3222f83c7516dffd616b152f501ec8ad0552ab323db5fafd238760' +
  '53317b483e00df829e5c57bbca6f8ca01a87562edf1769dbd542a8f6287effc3ac6732c68c4f5573695b27b0bbca58c8' +
  'e1ffa35db8f011a010fa3d98fd2183b84afcb56c2dd1d35b9a53e479b6f84565d28e49bc4bfb9790e1ddf2daa4cb7e33' +
  '62fb1341cee4c6e8ef20cada36774c01d07e9efe2bf11fb495dbda4dae909198eaad8e716b93d5a0d08ed1d0afc725e0' +
  '8e3c5b2f8e7594b78ff6e2fbf2122b648888b812900df01c4fad5ea0688fc31cd1cff191b3a8c1ad2f2f2218be0e1777' +
  'ea752dfe8b021fa1e5a0cc0fb56f74e818acf3d6ce89e299b4a84fe0fd13e0b77cc43b81d2ada8d9165fa26680957705' +
  '93cc7314211a1477e6ad206577b5fa86c75442f5fb9d35cfebcdaf0c7b3e89a0d6411bd3ae1e7e4900250e2d2071b35e' +
  '226800bb57b8e0af2464369bf009b91e5563911d59dfa6aa78c14389d95a537f207d5ba202e5b9c5832603766295cfa9' +
  '11c819684e734a41b3472dca7b14a94a1b5100529a532915d60f573fbc9bc6e42b60a47681e6740008ba6fb5571be91f' +
  'f296ec6b2a0dd915b6636521e7b9f9b6ff34052ec585566453b02d5da99f8fa108ba47996e85076a4b7a70e9b5b32944' +
  'db75092ec4192623ad6ea6b049a7df7d9cee60b88fedb266ecaa8c71699a17ff5664526cc2b19ee1193602a575094c29' +
  'a0591340e4183a3e3f54989a5b429d656b8fe4d699f73fd6a1d29c07efe830f54d2d38e6f0255dc14cdd20868470eb26' +
  '6382e9c6021ecc5e09686b3f3ebaefc93c9718146b6a70a1687f358452a0e286b79c5305aa5007373e07841c7fdeae5c' +
  '8e7d44ec5716f2b8b03ada37f0500c0df01c1f040200b3ffae0cf51a3cb574b225837a58dc0921bdd19113f97ca92ff6' +
  '9432477322f547013ae5e58137c2dadcc8b576349af3dda7a94461460fd0030eecc8c73ea4751e41e238cd993bea0e2f' +
  '3280bba1183eb3314e548b384f6db9086f420d03f60a04bf2cb8129024977c795679b072bcaf89afde9a771fd9930810' +
  'b38bae12dccf3f2e5512721f2e6b7124501adde69f84cd877a5847187408da17bc9f9abce94b7d8cec7aec3adb851dfa' +
  '63094366c464c3d2ef1c18473215d908dd433b3724c2ba1612a14d432a65c45150940002133ae4dd71dff89e10314e55' +
  '81ac77d65f11199b043556f1d7a3c76b3c11183b5924a509f28fe6ed97f1fbfa9ebabf2c1e153c6e86e34570eae96fb1' +
  '860e5e0a5a3e2ab3771fe71c4e3d06fa2965dcb999e71d0f803e89d65266c8252e4cc9789c10b36ac6150eba94e2ea78' +
  'a5fc3c531e0a2df4f2f74ea7361d2b3d1939260f19c279605223a708f71312b6ebadfe6eeac31f66e3bc4595a67bc883' +
  'b17f37d1018cff28c332ddefbe6c5aa56558218568ab9802eecea50fdb2f953b2aef7dad5b6e2f841521b62829076170' +
  'ecdd4775619f151013cca830eb61bd960334fe1eaa0363cfb5735c904c70a239d59e9e0bcbaade14eecc86bc60622ca7' +
  '9cab5cabb2f3846e648b1eaf19bdf0caa02369b9655abb5040685a323c2ab4b3319ee9d5c021b8f79b540b19875fa099' +
  '95f7997e623d7da8f837889a97e32d7711ed935f166812810e358829c7e61fd696dedfa17858ba9957f584a51b227263' +
  '9b83c3ff1ac24696cdb30aeb532e30548fd948e46dbc312858ebf2ef34c6ffeafe28ed61ee7c3c735d4a14d9e864b7e3' +
  '42105d14203e13e045eee2b6a3aaabeadb6c4f15facb4fd0c742f442ef6abbb5654f3b1d41cd2105d81e799e86854dc7' +
  'e44b476a3d816250cf62a1f25b8d2646fc8883a0c1c7b6a37f1524c369cb749247848a0b5692b285095bbf00ad19489d' +
  '1462b17423820e0058428d2a0c55f5ea1dadf43e233f70613372f0928d937e41d65fecf16c223bdb7cde3759cbee7460' +
  '4085f2a7ce77326ea607808419f8509ee8efd85561d99735a969a7aac50c06c25a04abfc800bcadc9e447a2ec3453484' +
  'fdd567050e1e9ec9db73dbd3105588cd675fda79e3674340c5c43465713e38d83d28f89ef16dff20153e21e78fb03d4a' +
  'e6e39f2bdb83adf7e93d5a68948140f7f64c261c94692934411520f77602d4f7bcf46b2ed4a20068d40824713320f46a' +
  '43b7d4b7500061af1e39f62e9724454614214f74bf8b88404d95fc1d96b591af70f4ddd366a02f45bfbc09ec03bd9785' +
  '7fac6dd031cb850496eb27b355fd3941da2547e6abca0a9a28507825530429f40a2c86dae9b66dfb68dc1462d7486900' +
  '680ec0a427a18dee4f3ffea2e887ad8cb58ce0067af4d6b6aace1e7cd3375fecce78a399406b2a4220fe9e35d9f385b9' +
  'ee39d7ab3b124e8b1dc9faf74b6d185626a36631eae397b23a6efa74dd5b43326841e7f7ca7820fbfb0af54ed8feb397' +
  '454056acba48952755533a3a20838d87fe6ba9b7d096954b55a867bca1159a58cca9296399e1db33a62a4a563f3125f9' +
  '5ef47e1c9029317cfdf8e80204272f7080bb155c05282ce395c11548e4c66d2248c1133fc70f86dc07f9c9ee41041f0f' +
  '404779a45d886e17325f51ebd59bc0d1f2bcc18f41113564257b7834602a9c60dff8e8a31f636c1b0e12b4c202e1329e' +
  'af664fd1cad181156b2395e0333e92e13b240b62eebeb92285b2a20ee6ba0d99de720c8c2da2f728d012784595b794fd' +
  '647d0862e7ccf5f05449a36f877d48fac39dfd27f33e8d1e0a476341992eff743a6f6eabf4f8fd37a812dc60a1ebddf8' +
  '991be14cdb6e6b0dc67b55106d672c372765d43bdcd0e804f1290dc7cc00ffa3b5390f92690fed0b667b9ffbcedb7d9c' +
  'a091cf0bd9155ea3bb132f88515bad247b9479bf763bd6eb37392eb3cc1159798026e297f42e312d6842ada7c66a2b3b' +
  '12754ccc782ef11c6a124237b79251e706a1bbe64bfb63501a6b101811caedfa3d25bdd8e2e1c3c9444216590a121386' +
  'd90cec6ed5abea2a64af674eda86a85fbebfe98864e4c3fe9dbc8057f0f7c08660787bf86003604dd1fd8346f6381fb0' +
  '7745ae04d736fccc83426b33f01eab71b08041873c005e5f77a057bebde8ae2455464299bf582e614e58f48ff2ddfda2' +
  'f474ef388789bdc25366f9c3c8b38e74b475f25546fcd9b97aeb26618b1ddf84846a0e79915f95e2466e598e20b45770' +
  '8cd55591c902de4cb90bace1bb8205d011a862487574a99eb77f19b6e0a9dc09662d09a1c4324633e85a1f0209f0be8c' +
  '4a99a0251d6efe101ab93d1d0ba5a4dfa186f20f2868f169dcb7da83573906fea1e2ce9b4fcd7f5250115e01a70683fa' +
  'a002b5c40de6d0279af88c27773f8641c3604c0661a806b5f0177a28c0f586e0006058aa30dc7d6211e69ed72338ea63' +
  '53c2dd94c2c21634bbcbee5690bcb6deebfc7da1ce591d766f05e4094b7c018839720a3d7c927c2486e3725f724d9db9' +
  '1ac15bb4d39eb8fced54557808fca5b5d83d7cd34dad0fc41e50ef5eb161e6f8a28514d96c51133c6fd5c7e756e14ec4' +
  '362abfceddc6c837d79a323492638212670efa8e406000e03a39ce37d3faf5cfabc277375ac52d1b5cb0679e4fa33742' +
  'd382274099bc9bbed5118e9dbf0f7315d62d1c7ec700c47bb78c1b6b21a19045b26eb1be6a366eb45748ab2fbc946e79' +
  'c6a376d26549c2c8530ff8ee468dde7dd5730a1d4cd04dc62939bbdba9ba4650ac9526e8be5ee304a1fad5f06a2d519a' +
  '63ef8ce29a86ee22c089c2b843242ef6a51e03aa9cf2d0a483c061ba9be96a4d8fe51550ba645bd62826a2f9a73a3ae1' +
  '4ba99586ef5562e9c72fefd3f752f7da3f046f6977fa0a5980e4a91587b086019b09e6ad3b3ee593e990fd5a9e34d797' +
  '2cf0b7d9022b8b5196d5ac3a017da67dd1cf3ed67c7d2d281f9f25cfadf2b89b5ad6b4725a88f54ce029ac71e019a5e6' +
  '47b0acfded93fa9be8d3c48d283b57ccf8d5662979132e28785f0191ed756055f7960e44e3d35e8c15056dd488f46dba' +
  '03a161250564f0bdc3eb9e153c9057a297271aeca93a072a1b3f6d9b1e6321f5f59c66fb26dcf3197533d928b155fdf5' +
  '035634828aba3cbb28517711c20ad9f8abcc5167ccad925f4de817513830dc8e379d58629320f991ea7a90c2fb3e7bce' +
  '5121ce64774fbe32a8b6e37ec3293d4648de53696413e680a2ae0810dd6db22469852dfd09072166b39a460a6445c0dd' +
  '586cdecf1c20c8ae5bbef7dd1b588d40ccd2017f6bb4e3bbdda26a7e3a59ff453e350a44bcb4cdd572eacea8fa6484bb' +
  '8d6612aebf3c6f47d29be463542f5d9eaec2771bf64e6370740e0d8de75b1357f8721671af537d5d4040cb084eb4e2cc' +
  '34d2466a0115af84e1b0042895983a1d06b89fb4ce6ea0486f3f3b823520ab82011a1d4b277227f8611560b1e7933fdc' +
  'bb3a792b344525bda08839e151ce794b2f32c9b7a01fbac9e01cc87ebcc7d1f6cf0111c3a1e8aac71a908749d44fbd9a' +
  'd0dadecbd50ada380339c32ac69136678df9317ce0b12b4ff79e59b743f5bb3af2d519ff27d9459cbf97222c15e6fc2a' +
  '0f91fc719b941525fae59361ceb69cebc2a8645912baa8d1b6c1075ee3056a0c10d25065cb03a442e0ec6e0e1698db3b' +
  '4c98a0be3278e9649f1f9532e0d392dfd3a0342b8971f21e1b0a74414ba3348cc5be7120c37632d8df359f8d9b992f2e' +
  'e60b6f470fe3f11de54cda541edad891ce6279cfcd3e7e6f1618b166fd2c1d05848fd2c5f6fb2299f523f357a6327623' +
  '93a8353156cccd02acf081625a75ebb56e16369788d273ccde96629281b949d04c50901b71c65614e6c6c7bd327a140a' +
  '45e1d006c3f27b9ac9aa53fd62a80f00bb25bfe235bdd2f671126905b2040222b6cbcf7ccd769c2b53113ec01640e3d3' +
  '38abbd602547adf0ba38209cf746ce7677afa1c52075606085cbfe4e8ae88dd87aaaf9b04cf9aa7e1948c25c02fb8a8c' +
  '01c36ae4d6ebe1f990d4f869a65cdea03f09252dc208e69fb74e6132ce77e25b578fdfe33ac372e6';

export const BF_INIT = (() => {
  const w = new Uint32Array(1042);
  for (let i = 0; i < 1042; i++) w[i] = parseInt(BF_INIT_HEX.substr(i * 8, 8), 16);
  return w;
})();

export const BCRYPT_B64 = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function bcryptEncode(bytes) {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const c1 = bytes[i], c2 = bytes[i + 1], c3 = bytes[i + 2];
    out += BCRYPT_B64[c1 >> 2];
    if (i + 1 >= bytes.length) { out += BCRYPT_B64[(c1 & 3) << 4]; break; }
    out += BCRYPT_B64[((c1 & 3) << 4) | (c2 >> 4)];
    if (i + 2 >= bytes.length) { out += BCRYPT_B64[(c2 & 15) << 2]; break; }
    out += BCRYPT_B64[((c2 & 15) << 2) | (c3 >> 6)];
    out += BCRYPT_B64[c3 & 63];
  }
  return out;
}

export function bcryptDecode(str, n) {
  const out = new Uint8Array(n);
  let bits = 0, acc = 0, o = 0;
  for (const ch of str) {
    const v = BCRYPT_B64.indexOf(ch);
    if (v < 0) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      if (o < n) out[o++] = (acc >> bits) & 0xff;
    }
  }
  return o === n ? out : null;
}

/**
 * @param {Uint8Array} pw パスワード（UTF-8）。末尾にNULを足して先頭72バイトだけ使う
 * @param {number} cost 4〜31（2^cost 回の鍵展開）
 * @param {Uint8Array} salt 16バイト
 * @param {string} [variant] '2y'（Apache の htpasswd -B と同じ）・'2b'・'2a'
 */
export function bcrypt(pw, cost, salt, variant = '2y') {
  const key = concat(pw, new Uint8Array(1)).subarray(0, 72);
  const P = BF_INIT.slice(0, 18);
  const S = BF_INIT.slice(18);
  const lr = new Uint32Array(2);

  function encipher(l, r) {
    l ^= P[0];
    for (let i = 1; i <= 16; i += 2) {
      r ^= (((S[l >>> 24] + S[256 | ((l >>> 16) & 0xff)]) ^ S[512 | ((l >>> 8) & 0xff)]) + S[768 | (l & 0xff)]) ^ P[i];
      l ^= (((S[r >>> 24] + S[256 | ((r >>> 16) & 0xff)]) ^ S[512 | ((r >>> 8) & 0xff)]) + S[768 | (r & 0xff)]) ^ P[i + 1];
    }
    lr[0] = r ^ P[17];
    lr[1] = l;
  }

  // 鍵（またはソルト）をバイト列として巡回しながら32ビットずつ読む
  function streamer(data) {
    let pos = 0;
    return () => {
      let w = 0;
      for (let i = 0; i < 4; i++) { w = (w << 8) | data[pos]; pos = (pos + 1) % data.length; }
      return w >>> 0;
    };
  }

  function expand(k, s) {
    const nk = streamer(k);
    for (let i = 0; i < 18; i++) P[i] ^= nk();
    const ns = s ? streamer(s) : null;
    let l = 0, r = 0;
    for (let i = 0; i < 18; i += 2) {
      if (ns) { l ^= ns(); r ^= ns(); }
      encipher(l, r); l = lr[0]; r = lr[1];
      P[i] = l; P[i + 1] = r;
    }
    for (let i = 0; i < 1024; i += 2) {
      if (ns) { l ^= ns(); r ^= ns(); }
      encipher(l, r); l = lr[0]; r = lr[1];
      S[i] = l; S[i + 1] = r;
    }
  }

  expand(key, salt);
  const rounds = 2 ** cost;
  for (let i = 0; i < rounds; i++) {
    expand(key, null);
    expand(salt, null);
  }

  // "OrpheanBeholderScryDoubt" を64回暗号化する
  const ctext = new Uint32Array([0x4f727068, 0x65616e42, 0x65686f6c, 0x64657253, 0x63727944, 0x6f756274]);
  for (let j = 0; j < 64; j++) {
    for (let i = 0; i < 6; i += 2) {
      encipher(ctext[i], ctext[i + 1]);
      ctext[i] = lr[0]; ctext[i + 1] = lr[1];
    }
  }
  const raw = new Uint8Array(24);
  for (let i = 0; i < 6; i++) {
    raw[i * 4] = ctext[i] >>> 24; raw[i * 4 + 1] = ctext[i] >>> 16;
    raw[i * 4 + 2] = ctext[i] >>> 8; raw[i * 4 + 3] = ctext[i];
  }
  return '$' + variant + '$' + String(cost).padStart(2, '0') + '$' +
    bcryptEncode(salt) + bcryptEncode(raw.subarray(0, 23));
}

/* ---- SHA-1（{SHA} 形式の照合用。生成には使わない） ---- */

export async function sha1Base64(pw) {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-1', pw));
  let s = '';
  for (const b of d) s += String.fromCharCode(b);
  return btoa(s);
}

/* ---- 1行を作る・照合する ---- */

export const ALGOS = ['bcrypt', 'apr1'];
export const COST_MIN = 4, COST_MAX = 14;

/**
 * @param {string} user
 * @param {string} password
 * @param {{algo?: string, cost?: number}} [opt]
 * @returns {string} "user:hash"
 */
export function htpasswdLine(user, password, opt = {}) {
  const algo = opt.algo || 'bcrypt';
  const pw = utf8(password);
  if (algo === 'apr1') return user + ':' + md5crypt(pw, apr1Salt());
  const cost = opt.cost == null ? 5 : opt.cost;
  return user + ':' + bcrypt(pw, cost, randomBytes(16));
}

// 照合はメインスレッドで同期計算するため、コストの上限を生成側の選択肢（最大14）に揃える。
// $2y$31$ のような値を貼られると 2^31 回の鍵展開で画面が長時間止まるため、上限を超えたら計算しない
export const MAX_VERIFY_COST = 14;

/** 既存の htpasswd 行（またはハッシュだけ）とパスワードを照合する */
export async function verifyHash(hashOrLine, password) {
  let h = String(hashOrLine).trim();
  let user = '';
  const colon = h.indexOf(':');
  if (colon >= 0 && !h.startsWith('$') && !h.startsWith('{')) { user = h.slice(0, colon); h = h.slice(colon + 1).trim(); }
  const pw = utf8(password);
  let m = h.match(/^\$(2[abxy])\$(\d\d)\$([./A-Za-z0-9]{22})([./A-Za-z0-9]{31})$/);
  if (m) {
    const cost = Number(m[2]);
    if (cost < 4 || cost > 31) return { user, format: 'bcrypt', ok: null };
    if (cost > MAX_VERIFY_COST) return { user, format: 'bcrypt', cost, ok: null, reason: 'cost' };
    const salt = bcryptDecode(m[3], 16);
    if (!salt) return { user, format: 'bcrypt', ok: null };
    // 1バイト目が "2x" の古い実装のバグ互換は再現しない（$2x$ は照合不能として扱う）
    if (m[1] === '2x') return { user, format: 'bcrypt', ok: null };
    const got = bcrypt(pw, cost, salt, m[1]);
    return { user, format: 'bcrypt', cost, ok: got.slice(-31) === m[4] };
  }
  m = h.match(/^(\$apr1\$|\$1\$)([^$]{0,8})\$([./0-9A-Za-z]{22})$/);
  if (m) return { user, format: m[1] === '$apr1$' ? 'apr1' : 'md5crypt', ok: md5crypt(pw, m[2], m[1]) === h };
  m = h.match(/^\{SHA\}([A-Za-z0-9+/]{27}=)$/);
  if (m) return { user, format: 'sha1', ok: (await sha1Base64(pw)) === m[1] };
  return { user, format: 'unknown', ok: null };
}

/* ==================== ここまでハッシュのコア ==================== */

/* ---- パスワードの自動生成（/password/ と同じく CSPRNG＋棄却サンプリング） ---- */

// 紛らわしい字（0 O o 1 l I）と、シェルや設定ファイルで引用が要る記号を除く
export const PW_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789-_.!@%+=';

export function randomPassword(len = 16) {
  const n = PW_CHARS.length;
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < len) {
    for (const b of randomBytes(len * 2)) {
      if (b < limit) out += PW_CHARS[b % n];
      if (out.length === len) break;
    }
  }
  return out;
}

/* ---- 入力の読み取り ---- */

/**
 * 一括欄を読む。1行1人で「ユーザー名:パスワード」。パスワードに : を含んでよい
 * （ユーザー名側に : は入れられないので最初の : で切る）。パスワードが空なら自動生成する。
 */
export function parseBulk(text) {
  const rows = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].replace(/\r$/, '');
    if (!raw.trim() || raw.trim().startsWith('#')) continue;
    const c = raw.indexOf(':');
    if (c < 0) rows.push({ line: i + 1, user: raw.trim(), password: '' });
    else rows.push({ line: i + 1, user: raw.slice(0, c).trim(), password: raw.slice(c + 1) });
  }
  return rows;
}

/* ---- 設定スニペット ---- */

export const IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(\/([12]?\d|3[0-2]))?$/;
export const IPV4_ADDR = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;
export const HEX16 = /^[0-9a-fA-F]{1,4}$/;

/** IPv6 アドレス（任意で /0〜/128）。:: の省略は1回まで、各区切りは16進1〜4桁、末尾のIPv4埋め込みも可 */
export function isIPv6(t) {
  const slash = t.indexOf('/');
  let addr = t;
  if (slash >= 0) {
    const p = t.slice(slash + 1);
    if (!/^(12[0-8]|1[01]\d|[1-9]?\d)$/.test(p)) return false;
    addr = t.slice(0, slash);
  }
  if (!addr.includes(':')) return false;
  const halves = addr.split('::');
  if (halves.length > 2) return false;
  const groups = (s) => (s === '' ? [] : s.split(':'));
  const parts = halves.length === 2 ? [...groups(halves[0]), ...groups(halves[1])] : groups(addr);
  let need = 8;
  if (parts.length && parts[parts.length - 1].includes('.')) {
    if (!IPV4_ADDR.test(parts.pop())) return false;
    need = 6;
  }
  if (!parts.every((g) => HEX16.test(g))) return false;
  return halves.length === 2 ? parts.length < need : parts.length === need;
}

export function parseIps(text) {
  const ok = [], bad = [];
  for (const t of text.split(/[\s,、]+/)) {
    if (!t) continue;
    if (IPV4.test(t) || isIPv6(t)) ok.push(t);
    else bad.push(t);
  }
  return { ok, bad };
}

export function realmOf(s) {
  // AuthName / auth_basic は二重引用符で囲むので、" と \ は外す
  return (s || '').replace(/["\\\r\n]/g, '').trim() || 'Restricted Area';
}

// 空白や設定の区切り文字を含むパスは引用しないと引数が分割されるため、二重引用符で囲む
// （Apache・nginx とも引用符内の \" と \\ はエスケープとして読む）
export function quotePath(file) {
  return /[\s"'\\;{}#]/.test(file) ? '"' + file.replace(/["\\]/g, '\\$&') + '"' : file;
}

export function snippet(server, file, realm, ips) {
  realm = realmOf(realm);
  file = quotePath(file);
  if (server === 'nginx') {
    const L = ['location / {'];
    if (ips.length) {
      L.push('    satisfy any;');
      for (const ip of ips) L.push('    allow ' + ip + ';');
      L.push('    deny  all;');
      L.push('');
    }
    L.push('    auth_basic "' + realm + '";');
    L.push('    auth_basic_user_file ' + file + ';');
    L.push('}');
    return L.join('\n');
  }
  const L = [
    'AuthType Basic',
    'AuthName "' + realm + '"',
    'AuthUserFile ' + file,
  ];
  if (ips.length) {
    L.push('<RequireAny>');
    for (const ip of ips) L.push('    Require ip ' + ip);
    L.push('    Require valid-user');
    L.push('</RequireAny>');
  } else {
    L.push('Require valid-user');
  }
  return L.join('\n');
}

/* ==================== ここからツールのラッパー（MCP のみ） ==================== */

export class HtpasswdToolError extends Error {}

const MAX_USERS = 200;
// bcrypt は 2^cost 回の鍵展開を人数ぶん行う。コスト10の200人（約15秒）を上限の目安にする（コスト14なら12人まで）
const MAX_WORK = 200 * 2 ** 10;

// 指摘事項。site側の文言（T）のうち、生成・スニペット・照合の判定に当たるものと同じ
const NOTE_TEXT = {
  ja: {
    USER_EMPTY: (r) => `${r.line}行目: ユーザー名が空です。この行は飛ばしました。`,
    USER_COLON: (r) => `${r.line}行目: ユーザー名に「:」は使えません（${r.user}）。この行は飛ばしました。`,
    USER_SPACE: (r) => `「${r.user}」に空白が入っています。Apache は受け付けますが、ログイン画面で打ち間違えやすくなります。`,
    USER_NONASCII: (r) => `「${r.user}」に英数字以外の文字が入っています。ブラウザによって送り方が違い、ログインできないことがあります。英数字と - _ . だけにしてください。`,
    USER_LONG: (r) => `「${r.user}」は255バイトを超えています（Apache のユーザー名の上限）。この行は飛ばしました。`,
    DUP: (r) => `「${r.user}」が2回以上出てきます。Apache は最初に一致した行を使うため、2行目以降のパスワードではログインできません。`,
    PW_AUTO: (r) => `パスワードが空欄の${r.count}人ぶんは16文字のパスワードを自動生成しました（generated に入っています。どこにも保存していないので、この結果から渡してください）。`,
    PW_SHORT: (r) => `「${r.user}」のパスワードは${r.len}文字です。Basic認証はURLを知っている人なら何度でも試せるため、12文字以上を勧めます。`,
    PW_SAME: (r) => `「${r.user}」のパスワードがユーザー名と同じです。`,
    PW_SPACE: (r) => `「${r.user}」のパスワードの先頭か末尾に空白があります。空白も含めてハッシュにしているので、ログイン時も空白まで入れる必要があります。`,
    PW_72: (r) => `「${r.user}」のパスワードはUTF-8で${r.bytes}バイトあります。bcrypt は先頭72バイトしか使わず、残りは無視されます。`,
    PW_NONASCII: (r) => `「${r.user}」のパスワードに英数字・記号以外の文字（全角文字など）が入っています。Basic認証でUTF-8を送らないブラウザがあり、ログインできないことがあります。`,
    NO_USERS: () => 'ユーザー名を入れてください。',
    APR1: () => 'apr1-md5 は bcrypt を読めないサーバー（Apache 2.2 や、crypt() が bcrypt 非対応の環境の nginx）向けです。対応しているなら bcrypt を選んでください。',
    COST_HIGH: (r) => `コスト${r.cost}: サーバーはリクエストのたび（画像・CSS・JSの1ファイルごと）にハッシュを計算し直すため、高いほど全ページが遅くなります。ステージング用途なら5〜10が目安です。`,
    IP_BAD: (r) => `IPアドレス・CIDRとして読めないため、スニペットに入れていません: ${r.items.join(' ')}`,
    FILE_REL: () => 'AuthUserFile は / から始まる絶対パスで書きます。相対パスは .htaccess の場所ではなくサーバーのルートから解釈されます。',
    REALM_NONASCII: () => '認証領域名（AuthName）は英数字にしてください。日本語は表示が崩れるブラウザがあり、今の主要ブラウザはそもそも表示しません。',
    V_OK: (r) => `一致しました。このパスワードは ${r.format} のハッシュと合っています${r.user ? `（ユーザー「${r.user}」）` : ''}。`,
    V_NG: (r) => `一致しません。このパスワードからはこの ${r.format} のハッシュになりません${r.user ? `（ユーザー「${r.user}」）` : ''}。`,
    V_COST: (r) => `コスト${r.cost}は照合しません（2^${r.cost}回の鍵展開で長時間止まるため）。照合できるのはコスト14までです。`,
    V_UNKNOWN: () => 'この形式は照合できません（対応: $2y$/$2b$/$2a$ の bcrypt・$apr1$・$1$・{SHA}）。',
  },
  en: {
    USER_EMPTY: (r) => `Line ${r.line}: the user name is empty. This line was skipped.`,
    USER_COLON: (r) => `Line ${r.line}: a user name cannot contain ":" (${r.user}). This line was skipped.`,
    USER_SPACE: (r) => `"${r.user}" contains a space or tab. Apache accepts it, but it is easy to mistype at the login prompt.`,
    USER_NONASCII: (r) => `"${r.user}" contains non-ASCII characters. Browsers do not agree on how they send them, so the login may fail. Use letters, digits and - _ . only.`,
    USER_LONG: (r) => `"${r.user}" is over 255 bytes, the limit Apache accepts for a user name. This line was skipped.`,
    DUP: (r) => `"${r.user}" appears more than once. Apache uses the first matching line, so later passwords for this user never work.`,
    PW_AUTO: (r) => `${r.count} password(s) were left empty and generated randomly (16 characters). They are in generated and are not stored anywhere — hand them over from this result.`,
    PW_SHORT: (r) => `The password for "${r.user}" is ${r.len} characters. Anyone who knows the URL can keep trying passwords, so 12+ characters is safer.`,
    PW_SAME: (r) => `The password for "${r.user}" is the same as the user name.`,
    PW_SPACE: (r) => `The password for "${r.user}" begins or ends with a space. It is hashed as typed, so the space must be typed at login too.`,
    PW_72: (r) => `The password for "${r.user}" is ${r.bytes} bytes in UTF-8. bcrypt only uses the first 72 bytes; the rest is ignored.`,
    PW_NONASCII: (r) => `The password for "${r.user}" contains non-ASCII characters. Some browsers do not send them as UTF-8 for Basic auth, so the login may fail.`,
    NO_USERS: () => 'Enter a user name.',
    APR1: () => 'apr1-md5 is for servers that cannot read bcrypt (Apache 2.2 and nginx on a system whose crypt() lacks bcrypt). Use bcrypt when the server supports it.',
    COST_HIGH: (r) => `Cost ${r.cost}: the server re-hashes the password on every request (every image, CSS and JS file), so a high cost slows every page. 5–10 is usual for a staging site.`,
    IP_BAD: (r) => `Not an IP address or CIDR range, left out of the snippet: ${r.items.join(' ')}`,
    FILE_REL: () => 'AuthUserFile should be an absolute path (starting with /). A relative path is resolved from the server root, not from the .htaccess folder.',
    REALM_NONASCII: () => 'Keep the realm (AuthName) in ASCII. Browsers do not agree on how to display other characters, and most no longer show it at all.',
    V_OK: (r) => `Match — the password is correct for this ${r.format} hash${r.user ? ` (user "${r.user}")` : ''}.`,
    V_NG: (r) => `No match — the password does not produce this ${r.format} hash${r.user ? ` (user "${r.user}")` : ''}.`,
    V_COST: (r) => `Cost ${r.cost} is not checked: 2^${r.cost} key expansions would take a long time. Hashes up to cost 14 can be checked.`,
    V_UNKNOWN: () => 'This format cannot be checked (supported: $2y$/$2b$/$2a$ bcrypt, $apr1$, $1$, {SHA}).',
  },
};

const DEFAULT_FILE = { apache: '/home/example/.htpasswd', nginx: '/etc/nginx/.htpasswd' };

function note(lang, level, code, info = {}) {
  const out = { level, code, message: NOTE_TEXT[lang][code](info) };
  if (info.user !== undefined && info.user !== '') out.user = info.user;
  if (info.line !== undefined) out.line = info.line;
  return out;
}

/**
 * 生成の前の検査。site側 generate() の判定と同じ（パスワードが空なら16文字を自動生成する＝一括欄の扱い）。
 * @param {{line:number, user:string, password:string}[]} rows
 * @param {{algo:string, cost:number, lang:'ja'|'en'}} o
 * @param {(n:number) => string} [genPassword] テスト用に差し替えられる
 */
export function htCheckRows(rows, o, genPassword = randomPassword) {
  const { algo, cost, lang } = o;
  const diag = [];
  const seen = new Set();
  const good = [];
  let autoCount = 0;
  for (const r0 of rows) {
    const r = { ...r0 };
    // site側は1人入力欄で両方空のときだけ黙る。ここでは全員を一括欄と同じに扱う
    if (!r.user) { diag.push(note(lang, 'warn', 'USER_EMPTY', { line: r.line })); continue; }
    if (r.user.includes(':')) { diag.push(note(lang, 'warn', 'USER_COLON', r)); continue; }
    if (utf8(r.user).length > 255) { diag.push(note(lang, 'warn', 'USER_LONG', r)); continue; }
    if (/\s/.test(r.user)) diag.push(note(lang, 'info', 'USER_SPACE', r));
    if (/[^\x21-\x7e\s]/.test(r.user)) diag.push(note(lang, 'warn', 'USER_NONASCII', r));
    if (seen.has(r.user)) diag.push(note(lang, 'warn', 'DUP', r));
    seen.add(r.user);
    if (!r.password) {
      r.password = genPassword(16);
      r.auto = true;
      autoCount++;
    } else {
      const len = [...r.password].length;
      if (len < 12) diag.push(note(lang, 'warn', 'PW_SHORT', { user: r.user, len }));
      if (r.password === r.user) diag.push(note(lang, 'warn', 'PW_SAME', r));
      if (/^\s|\s$/.test(r.password)) diag.push(note(lang, 'info', 'PW_SPACE', r));
      if (/[^\x20-\x7e]/.test(r.password)) diag.push(note(lang, 'warn', 'PW_NONASCII', r));
      const bytes = utf8(r.password).length;
      if (algo === 'bcrypt' && bytes > 72) diag.push(note(lang, 'warn', 'PW_72', { user: r.user, bytes }));
    }
    good.push(r);
  }
  if (!rows.length || (!good.length && !diag.length)) diag.push(note(lang, 'warn', 'NO_USERS'));
  if (autoCount) diag.unshift(note(lang, 'info', 'PW_AUTO', { count: autoCount }));
  if (algo === 'apr1') diag.push(note(lang, 'info', 'APR1'));
  if (algo === 'bcrypt' && cost >= 11) diag.push(note(lang, 'info', 'COST_HIGH', { cost }));
  return { good, notes: diag };
}

/** 設定スニペットと、その検査（site側 updateSnippet() の判定と同じ） */
export function htSnippet(server, file, realm, ipsText, lang) {
  const ips = parseIps(ipsText);
  const f = (file || '').trim() || DEFAULT_FILE[server];
  const notes = [];
  if (ips.bad.length) notes.push(note(lang, 'warn', 'IP_BAD', { items: ips.bad }));
  if ((file || '').trim() && !file.trim().startsWith('/')) notes.push(note(lang, 'warn', 'FILE_REL'));
  if (/[^\x20-\x7e]/.test(realm || '')) notes.push(note(lang, 'info', 'REALM_NONASCII'));
  return {
    server,
    target: server === 'nginx' ? 'nginx.conf (server { … })' : '.htaccess',
    file: f,
    realm: realmOf(realm),
    ips: ips.ok,
    text: snippet(server, f, realm || '', ips.ok),
    notes,
  };
}

function toRows(opts) {
  if (opts.bulk !== undefined) {
    if (typeof opts.bulk !== 'string') throw new HtpasswdToolError('bulk は文字列（1行1人の「ユーザー名:パスワード」）で渡してください');
    return parseBulk(opts.bulk);
  }
  if (opts.users !== undefined) {
    if (!Array.isArray(opts.users) || !opts.users.length) throw new HtpasswdToolError('users は1件以上の配列で渡してください');
    return opts.users.map((u, i) => {
      if (typeof u === 'string') {
        // 文字列は一括欄の1行と同じ読み方（最初の : で切る・: が無ければパスワード空）
        const c = u.indexOf(':');
        return c < 0 ? { line: i + 1, user: u.trim(), password: '' } : { line: i + 1, user: u.slice(0, c).trim(), password: u.slice(c + 1) };
      }
      const o = u || {};
      return { line: i + 1, user: String(o.user ?? '').trim(), password: o.password == null ? '' : String(o.password) };
    });
  }
  if (opts.user !== undefined) {
    return [{ line: 1, user: String(opts.user).trim(), password: opts.password == null ? '' : String(opts.password) }];
  }
  return null;
}

/**
 * htpasswd の行を作る・既存のハッシュと照合する・Apache / nginx の設定スニペットを作る。
 *
 * @param {object} opts
 * @param {'generate'|'verify'} [opts.mode] 省略時は hash があれば verify、無ければ generate
 * @param {string} [opts.user] 1人ぶんのユーザー名（password と組）
 * @param {string} [opts.password] パスワード（空なら16文字を自動生成。verify では照合するパスワード）
 * @param {(string|{user:string,password?:string})[]} [opts.users] まとめて作る（200人まで）
 * @param {string} [opts.bulk] 1行1人の「ユーザー名:パスワード」（# で始まる行と空行は飛ばす）
 * @param {'bcrypt'|'apr1'} [opts.algo='bcrypt']
 * @param {number} [opts.cost=5] bcrypt のコスト（4〜14）
 * @param {'apache'|'nginx'} [opts.server] 渡すと設定スニペットも返す
 * @param {string} [opts.file] AuthUserFile / auth_basic_user_file のパス
 * @param {string} [opts.realm] 認証領域名（AuthName）
 * @param {string|string[]} [opts.ips] 認証なしで通すIP・CIDR
 * @param {string} [opts.hash] verify で照合する htpasswd の1行（またはハッシュだけ）
 * @param {string} [opts.outputPath] htpasswd の中身を書き出す絶対パス
 * @param {'ja'|'en'} [opts.lang='ja']
 */
export async function htpasswdGenerateTool(opts = {}) {
  const lang = opts.lang || 'ja';
  if (lang !== 'ja' && lang !== 'en') throw new HtpasswdToolError(`lang は ja か en: ${opts.lang}`);
  const mode = opts.mode || (opts.hash !== undefined ? 'verify' : 'generate');
  if (mode !== 'generate' && mode !== 'verify') throw new HtpasswdToolError(`mode は generate か verify: ${opts.mode}`);

  if (mode === 'verify') {
    if (typeof opts.hash !== 'string' || !opts.hash.trim()) throw new HtpasswdToolError('verify には hash（htpasswd の1行かハッシュ）を渡してください');
    if (typeof opts.password !== 'string' || !opts.password) throw new HtpasswdToolError('verify には照合する password を渡してください');
    const r = await verifyHash(opts.hash, opts.password);
    const code = r.ok === true ? 'V_OK' : r.ok === false ? 'V_NG' : r.reason === 'cost' ? 'V_COST' : 'V_UNKNOWN';
    return {
      mode,
      match: r.ok,
      format: r.format,
      ...(r.user ? { user: r.user } : {}),
      ...(r.cost !== undefined ? { cost: r.cost } : {}),
      notes: [{ level: r.ok === true ? 'ok' : r.ok === false ? 'warn' : 'info', code, message: NOTE_TEXT[lang][code](r) }],
    };
  }

  const algo = opts.algo === undefined ? 'bcrypt' : opts.algo;
  if (ALGOS.indexOf(algo) === -1) throw new HtpasswdToolError(`algo は bcrypt か apr1: ${opts.algo}`);
  const cost = opts.cost === undefined ? 5 : opts.cost;
  if (!Number.isInteger(cost) || cost < COST_MIN || cost > COST_MAX) {
    throw new HtpasswdToolError(`cost は ${COST_MIN}〜${COST_MAX} の整数: ${opts.cost}`);
  }
  const given = ['user', 'users', 'bulk'].filter((k) => opts[k] !== undefined);
  if (given.length > 1) throw new HtpasswdToolError('user・users・bulk はどれか1つだけ渡してください');
  const server = opts.server;
  if (server !== undefined && server !== 'apache' && server !== 'nginx') throw new HtpasswdToolError(`server は apache か nginx: ${server}`);
  const rows = toRows(opts);
  if (!rows && !server) throw new HtpasswdToolError('user（と password）・users・bulk のどれか、またはスニペットだけなら server を渡してください');
  if (rows && rows.length > MAX_USERS) throw new HtpasswdToolError(`ユーザーは ${MAX_USERS} 人まで: ${rows.length}`);

  if (rows && algo === 'bcrypt' && rows.length * 2 ** cost > MAX_WORK) {
    throw new HtpasswdToolError(`コスト${cost}で ${rows.length} 人は時間がかかりすぎます（コスト${cost}は ${Math.floor(MAX_WORK / 2 ** cost)} 人まで）。コストを下げるか分けて作ってください`);
  }

  const result = { mode, algo, ...(algo === 'bcrypt' ? { cost } : {}) };
  if (rows) {
    const { good, notes } = htCheckRows(rows, { algo, cost, lang });
    const entries = good.map((r) => ({ user: r.user, line: htpasswdLine(r.user, r.password, { algo, cost }) }));
    const text = entries.length ? entries.map((e) => e.line).join('\n') + '\n' : '';
    result.count = entries.length;
    result.htpasswd = text;
    result.entries = entries;
    // 自動生成したパスワードだけを返す（利用者が渡したパスワードは繰り返さない）
    result.generated = good.filter((r) => r.auto).map((r) => ({ user: r.user, password: r.password }));
    result.notes = notes;
    if (opts.outputPath) {
      if (!isAbsolute(opts.outputPath)) throw new HtpasswdToolError('outputPath は絶対パスで指定してください');
      if (!text) throw new HtpasswdToolError('書き出す行がありません（notes を確認してください）');
      await writeOutput(opts.outputPath, text, { overwrite: opts.overwrite });
      result.output = opts.outputPath;
      delete result.htpasswd;
    }
  }
  if (server) {
    const ips = Array.isArray(opts.ips) ? opts.ips.join(' ') : String(opts.ips ?? '');
    result.snippet = htSnippet(server, opts.file === undefined ? '' : String(opts.file), opts.realm === undefined ? '' : String(opts.realm), ips, lang);
  }
  return result;
}
