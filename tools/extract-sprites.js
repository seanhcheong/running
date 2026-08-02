#!/usr/bin/env node
/* =============================================================================
 * Slice resources/Teal_blob_character_fitness_poses_*.jpeg into game sprites.
 * =============================================================================
 * Run:  node tools/extract-sprites.js
 * Out:  assets/sprites/*.png  (transparent, longest edge <= MAX_EDGE)
 *
 * This exists as a tool rather than as a one-off because the source sheet is
 * checked in: if the art is ever re-rendered, the sprites regenerate instead of
 * being hand-traced again.
 *
 * WHY IT WORKS THE WAY IT DOES
 *
 * There is no PIL, numpy, ImageMagick or sharp in this project's toolchain, and
 * adding one for a build step that runs once would be a poor trade. Chromium is
 * already a dependency (Playwright drives the test suite), and it is a complete
 * image pipeline: decode JPEG, read pixels, write PNG. So the browser is the
 * image library.
 *
 * The key is on HUE, not luminance, and that is what makes it robust:
 *   - grid lines and text labels are grey            -> no saturation, rejected
 *   - rainbow ground shadows are saturated, but their hue sweeps the whole
 *     wheel, so a narrow teal window rejects them while keeping the character
 *     standing on top of them
 *   - the character's pale specular highlights keep just enough saturation
 *
 * The source is JPEG, which matters. 4:2:0 chroma subsampling halves colour
 * resolution and ringing fringes every high-contrast edge, so a raw matte comes
 * out with a 1-2px halo of half-teal pixels. On a white page that is invisible;
 * on this game's near-black sky it reads as a pale outline around the character.
 * Two things deal with it: edge pixels get partial alpha rather than full, and
 * their colour is un-premultiplied against white before being re-composited.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'assets', 'sprites');
const MAX_EDGE = 256;
const PORT = 8123;

/* Grid position -> name, read off the sheet. Row 1 carries no printed labels. */
const NAMES = [
  ['standing', 'running_front', 'running_back'],
  ['step_front', 'running_side', 'running_back_road'],
  ['burpee_down', 'squat_down_side', 'hands_down_plant'],
  ['plank', 'mid_push_up', 'recovery_upward'],
  ['jumping', 'clap', 'stretching'],
];

/* Only these ship. The rest of the sheet is either a side/three-quarter view
 * (unusable as a front-facing pose), a floor pose the matcher cannot yet handle,
 * or a composed scene rather than a character. Listed explicitly so that adding
 * one later is a deliberate act. */
const KEEP = new Set([
  'standing',          // start screen, and the stand_tall shape
  'burpee_down',       // squat
  'recovery_upward',   // arms overhead
  'clap',
  'stretching',        // side bend; mirror for the other side
  'jumping',
  'running_back',      // the game's own camera angle
]);

function findSheet() {
  const dir = path.join(ROOT, 'resources');
  if (!fs.existsSync(dir)) throw new Error('no resources/ directory');
  const hit = fs.readdirSync(dir).find((f) => /blob_character.*\.(jpe?g|png)$/i.test(f));
  if (!hit) throw new Error('no character sheet found in resources/');
  return hit;
}

/* A throwaway static server. The canvas has to be same-origin with the image or
 * getImageData refuses on a tainted canvas, and file:// does not qualify. */
function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
      const abs = path.join(ROOT, rel);
      if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        res.writeHead(rel === '' ? 200 : 404, { 'Content-Type': 'text/html' });
        return res.end('<!doctype html><title>extract</title>');
      }
      res.writeHead(200, { 'Content-Type': /\.png$/.test(abs) ? 'image/png' : 'image/jpeg' });
      fs.createReadStream(abs).pipe(res);
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

/* Runs inside the page. Returns one entry per connected component. */
function sliceInPage(arg) {
  // Playwright passes exactly one argument to page.evaluate.
  const src = arg.src, maxEdge = arg.maxEdge;
  return (async () => {
    const img = new Image();
    img.src = src;
    await img.decode();
    const W = img.naturalWidth, H = img.naturalHeight;

    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const ctx = c.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    const px4 = ctx.getImageData(0, 0, W, H).data;

    const hueOf = (r, g, b) => {
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      if (mx === mn) return -1;
      const d = mx - mn;
      let h;
      if (mx === r) h = ((g - b) / d) % 6;
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
      return h < 0 ? h + 360 : h;
    };

    const mask = new Uint8Array(W * H);
    for (let i = 0, p = 0; i < px4.length; i += 4, p++) {
      const r = px4[i], g = px4[i + 1], b = px4[i + 2];
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      const h = hueOf(r, g, b);
      /* The upper `mx` bound rejects the rainbow ground shadows. They contain
       * teal-ish bands that pass a hue test, and because the feet touch them
       * they merge into the character's own component — so they cannot be
       * dropped later as separate specks. Every part of them is brighter than
       * the character's lightest highlight, which measures ~236. */
      if (sat > 0.10 && h >= 145 && h <= 215 && mx > 28 && mx < 242) mask[p] = 1;
    }

    // Connected components, iterative so a 2048x2048 sheet cannot blow the stack.
    const label = new Int32Array(W * H).fill(-1);
    const stack = new Int32Array(W * H);
    const comps = [];
    for (let seed = 0; seed < mask.length; seed++) {
      if (!mask[seed] || label[seed] !== -1) continue;
      const id = comps.length;
      let sp = 0;
      stack[sp++] = seed;
      label[seed] = id;
      let minX = W, minY = H, maxX = -1, maxY = -1, area = 0;
      while (sp > 0) {
        const q = stack[--sp];
        const x = q % W, y = (q - x) / W;
        area++;
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
        for (let dy = -1; dy <= 1; dy++) {
          for (let dx = -1; dx <= 1; dx++) {
            if (!dx && !dy) continue;
            const nx = x + dx, ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const nq = ny * W + nx;
            if (mask[nq] && label[nq] === -1) { label[nq] = id; stack[sp++] = nq; }
          }
        }
      }
      comps.push({ id, minX, minY, maxX, maxY, area });
    }

    const out = [];
    for (const k of comps.filter((z) => z.area > 4000).sort((a, b) => b.area - a.area)) {
      const pad = 6;
      const x0 = Math.max(0, k.minX - pad), y0 = Math.max(0, k.minY - pad);
      const x1 = Math.min(W - 1, k.maxX + pad), y1 = Math.min(H - 1, k.maxY + pad);
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      if (w < 40 || h < 40) continue;

      const cut = document.createElement('canvas');
      cut.width = w; cut.height = h;
      const cctx = cut.getContext('2d');
      const dst = cctx.createImageData(w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const sq = (y0 + y) * W + (x0 + x);
          if (label[sq] !== k.id) continue;
          let n = 0;
          for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
              const nx = x0 + x + dx, ny = y0 + y + dy;
              if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
              if (label[ny * W + nx] === k.id) n++;
            }
          }
          const a = n >= 9 ? 255 : Math.round(255 * (n / 9) * 0.85);
          const si = sq * 4;
          let r = px4[si], g = px4[si + 1], b = px4[si + 2];
          // Un-premultiply against the white page, or every edge stays lighter
          // than the body it belongs to.
          if (a > 0 && a < 255) {
            const af = a / 255;
            r = Math.max(0, Math.min(255, (r - 255 * (1 - af)) / af));
            g = Math.max(0, Math.min(255, (g - 255 * (1 - af)) / af));
            b = Math.max(0, Math.min(255, (b - 255 * (1 - af)) / af));
          }
          const di = (y * w + x) * 4;
          dst.data[di] = r; dst.data[di + 1] = g; dst.data[di + 2] = b; dst.data[di + 3] = a;
        }
      }
      cctx.putImageData(dst, 0, 0);

      // Downscale on the way out. Browser resampling is area-averaged, which is
      // also a free second pass at softening JPEG edge ringing.
      let final = cut;
      const longest = Math.max(w, h);
      if (longest > maxEdge) {
        const s = maxEdge / longest;
        const sc = document.createElement('canvas');
        sc.width = Math.max(1, Math.round(w * s));
        sc.height = Math.max(1, Math.round(h * s));
        const sctx = sc.getContext('2d');
        sctx.imageSmoothingEnabled = true;
        sctx.imageSmoothingQuality = 'high';
        sctx.drawImage(cut, 0, 0, sc.width, sc.height);
        final = sc;
      }

      out.push({
        area: k.area,
        cx: (k.minX + k.maxX) / 2,
        cy: (k.minY + k.maxY) / 2,
        w: final.width, h: final.height,
        png: final.toDataURL('image/png'),
      });
    }
    return { W, H, sprites: out };
  })();
}

(async () => {
  const sheet = findSheet();
  const srv = await serve();
  const { chromium } = require('/opt/node22/lib/node_modules/playwright');
  const browser = await chromium.launch({
    executablePath: process.env.CHROMIUM_PATH ||
      '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  try {
    const page = await browser.newPage();
    const base = 'http://127.0.0.1:' + PORT + '/';
    await page.goto(base, { waitUntil: 'load' });
    const url = base + 'resources/' + encodeURIComponent(sheet);
    const res = await page.evaluate(sliceInPage, { src: url, maxEdge: MAX_EDGE });

    fs.mkdirSync(OUT_DIR, { recursive: true });
    const cellW = res.W / 3, cellH = res.H / 5;
    let kept = 0, skipped = [];
    for (const s of res.sprites) {
      const col = Math.min(2, Math.floor(s.cx / cellW));
      const row = Math.min(4, Math.floor(s.cy / cellH));
      const name = NAMES[row][col];
      if (!KEEP.has(name)) { skipped.push(name); continue; }
      const file = path.join(OUT_DIR, name + '.png');
      fs.writeFileSync(file, Buffer.from(s.png.split(',')[1], 'base64'));
      kept++;
      console.log('  ' + name.padEnd(18) + s.w + 'x' + s.h + '  ' +
        (fs.statSync(file).size / 1024).toFixed(0) + 'KB');
    }
    console.log('\n' + sheet + ' (' + res.W + 'x' + res.H + ') -> ' +
      kept + ' sprites in assets/sprites/');
    console.log('not shipped (see KEEP): ' + skipped.sort().join(', '));
  } finally {
    await browser.close();
    srv.close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
