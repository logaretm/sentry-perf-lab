// Generates real, network-fetchable assets so the lab exercises the code paths
// that actually cost something at load: image requests + fetch/XHR. High-entropy
// pixels (LCG) so PNGs don't compress to nothing — real bytes over the wire.
import { mkdirSync, writeFileSync } from 'node:fs';
import zlib from 'node:zlib';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return buf => {
    let c = 0xffffffff;
    for (let i = 0; i < buf.length; i++) c = t[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
})();

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(CRC(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function png(w, h, seed) {
  // Per-8x8-block color (deflate-friendly) → realistic ~tens-of-KB transfer sizes,
  // like optimized JPEG profile media, while still being real distinct bytes.
  const stride = w * 3 + 1;
  const raw = Buffer.alloc(stride * h);
  const hash = (bx, by) => {
    let s = (bx * 73856093) ^ (by * 19349663) ^ (seed * 83492791);
    s = (s * 1664525 + 1013904223) >>> 0;
    return s;
  };
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    for (let x = 0; x < w; x++) {
      const v = hash((x >> 3), (y >> 3));
      const o = y * stride + 1 + x * 3;
      raw[o] = v & 0xff;
      raw[o + 1] = (v >> 8) & 0xff;
      raw[o + 2] = (v >> 16) & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2; // RGB
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

mkdirSync('public/img', { recursive: true });
mkdirSync('public/api', { recursive: true });

// Banner ~big (LCP element), avatars, and several media images for the feed.
writeFileSync('public/img/banner.png', png(800, 300, 1)); // ~big
writeFileSync('public/img/avatar.png', png(200, 200, 2));
for (let i = 0; i < 8; i++) writeFileSync(`public/img/media-${i}.png`, png(600, 340, 100 + i));

// API endpoints: a profile bootstrap + paginated feed + side panels — the kind
// of request burst a real profile page fires on load.
const post = i => ({
  id: i,
  author: 'Abdullah',
  handle: '@logaretm',
  text: `Post number ${i} — measuring real load behaviour with actual requests.`,
  media: i % 3 === 0 ? `/img/media-${i % 8}.png` : null,
  replies: (i * 7) % 90,
  reposts: (i * 13) % 200,
  likes: (i * 29) % 1500,
});
writeFileSync('public/api/profile.json', JSON.stringify({ name: 'Abdullah', handle: '@logaretm', followers: 38200, following: 1204 }));
writeFileSync('public/api/followers.json', JSON.stringify({ items: Array.from({ length: 20 }, (_, i) => ({ id: i, handle: `@user${i}` })) }));
writeFileSync('public/api/suggestions.json', JSON.stringify({ items: Array.from({ length: 10 }, (_, i) => ({ id: i, handle: `@suggest${i}` })) }));
for (let pageN = 0; pageN < 12; pageN++) {
  writeFileSync(`public/api/feed-${pageN}.json`, JSON.stringify({ page: pageN, posts: Array.from({ length: 10 }, (_, i) => post(pageN * 10 + i)) }));
}

console.log('assets generated');
