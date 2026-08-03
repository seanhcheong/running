#!/usr/bin/env node
/* =============================================================================
 * Build the course art from resources/ into assets/course/
 * =============================================================================
 * Run:  node tools/build-course.js
 * Out:  assets/course/road-tile.jpg   cropped so its lanes align to the projection
 *       assets/course/skyline.png     rooftop band, sky keyed to transparent
 *
 * Same reasoning as tools/extract-sprites.js: no PIL / ImageMagick / sharp in
 * this toolchain, and Chromium is already here and is a complete image pipeline.
 *
 * WHY THE ROAD TILE NEEDS CROPPING AT ALL
 *
 * The renderer projects lane centres to 1/6, 1/2 and 5/6 of the road's width.
 * The source art is a full track render INCLUDING its side rails, so its three
 * lanes do not sit there. Measuring the colourfulness profile across the tile
 * puts the metallic dividers at chroma minima around 0.34 and 0.65, which places
 * the lane centres at 0.213 / 0.500 / 0.775. Cropping to CROP below lands all
 * three within 0.3% of a lane width of where the avatar is actually drawn —
 * verified by sampling the rendered road under each lane centre and confirming
 * chroma 55-64 at all three, i.e. rainbow surface rather than grey divider.
 *
 * WHICH SOURCE TILE, AND WHY THE NEWER ONE LOST
 *
 * Two versions were generated. The second dropped the baked coins, which was an
 * improvement, but measured much worse where it counts:
 *
 *                        divider contrast   lane chroma   seam
 *     v1 (with coins)         67% / 67%          78       0.030
 *     v2 (no coins)           42% / 39%          57       0.036
 *
 * Divider contrast is not cosmetic — it is how the player knows which lane they
 * are in. v2's dividers are also organic and wobbling rather than straight, and
 * a divider that wobbles reads as a warped road once projected. So v1 ships. If
 * the tile is ever regenerated, ask for the coins gone AND crisp straight lane
 * dividers, and re-run this tool.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'assets', 'course');
const PORT = 8124;

/* ===========================================================================
 * ROAD TILE CANDIDATES
 * ---------------------------------------------------------------------------
 * Listed newest-first; the first one present in resources/ wins. Each carries its
 * OWN crop, because whether a crop is needed is a property of the art:
 *
 *   red athletics track   no crop. Generated to the "lanes fill the image edge to
 *                         edge, no rails" spec, and it landed — measured lane
 *                         centres 0.1775 / 0.5071 / 0.8295 against the 0.1667 /
 *                         0.5 / 0.8333 the projection wants, i.e. within 1.1% of
 *                         tile width. Nothing to trim.
 *   rainbow track         cropped. A full track render including its side rails,
 *                         so its lanes sat at 0.213 / 0.500 / 0.775 and 16% of
 *                         the width had to go.
 *
 * The crop belongs HERE and nowhere else. It was also being applied a second time
 * at draw time in course.js, which silently trimmed another 8% off each side of an
 * already-cropped tile and pulled the lanes out of register with the avatar. The
 * prototype that verified the crop read the raw source and cropped once, so it
 * never saw the fault.
 * ======================================================================== */
const ROAD_TILES = [
  { match: /Red_running_track.*\.(jpe?g|png)$/i, crop: { x0: 0, x1: 1 } },
  { match: /Running_track_with_rainbow_lanes.*\.(jpe?g|png)$/i,
    crop: { x0: 0.079, x1: 0.922 } },
  { match: /Running_track.*rainbow.*\.(jpe?g|png)$/i, crop: { x0: 0.079, x1: 0.922 } },
];

/* Output width for the road. The road is at most ~2 x roadHalfW on screen, which
 * is under 400px on a phone, so anything past ~640 is bytes the player downloads
 * and never sees. */
const ROAD_W = 640;

/* The skyline is used as a thin band on the horizon, so only the rooftops are
 * wanted — the lower two thirds of the render is dense city that would never be
 * visible above the horizon line. */
const SKY_BAND = { y0: 0.0, y1: 0.44 };
const SKY_W = 1100;

function pick(patterns) {
  const dir = path.join(ROOT, 'resources');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir) : [];
  for (const re of patterns) {
    const hit = files.filter((f) => re.test(f)).sort().pop();
    if (hit) return hit;
  }
  return null;
}

function serve() {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const rel = decodeURIComponent(req.url.split('?')[0]).replace(/^\/+/, '');
      const abs = path.join(ROOT, rel);
      if (!abs.startsWith(ROOT) || !fs.existsSync(abs) || fs.statSync(abs).isDirectory()) {
        res.writeHead(rel === '' ? 200 : 404, { 'Content-Type': 'text/html' });
        return res.end('<!doctype html><title>build</title>');
      }
      res.writeHead(200, { 'Content-Type': /\.png$/.test(abs) ? 'image/png' : 'image/jpeg' });
      fs.createReadStream(abs).pipe(res);
    });
    srv.listen(PORT, '127.0.0.1', () => resolve(srv));
  });
}

function buildInPage(arg) {
  return (async () => {
    const load = async (src) => {
      const img = new Image();
      img.src = src;
      await img.decode();
      return img;
    };
    const out = {};

    /* --- road: crop and downscale ------------------------------------- */
    {
      const img = await load(arg.roadSrc);
      const sx = Math.round(arg.crop.x0 * img.naturalWidth);
      const sw = Math.round((arg.crop.x1 - arg.crop.x0) * img.naturalWidth);
      const scale = arg.roadW / sw;
      const c = document.createElement('canvas');
      c.width = arg.roadW;
      c.height = Math.round(img.naturalHeight * scale);
      const ctx = c.getContext('2d');
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, 0, sw, img.naturalHeight, 0, 0, c.width, c.height);
      out.road = { w: c.width, h: c.height, data: c.toDataURL('image/jpeg', 0.88) };
    }

    /* --- skyline: crop the rooftop band, key the sky to transparent ---- */
    if (arg.skySrc) {
      const img = await load(arg.skySrc);
      const y0 = Math.round(arg.band.y0 * img.naturalHeight);
      const y1 = Math.round(arg.band.y1 * img.naturalHeight);
      const sh = y1 - y0;
      const scale = arg.skyW / img.naturalWidth;
      const c = document.createElement('canvas');
      c.width = arg.skyW;
      c.height = Math.max(1, Math.round(sh * scale));
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, 0, y0, img.naturalWidth, sh, 0, 0, c.width, c.height);

      /* Key on the sky colour sampled from the very top-left, which is always
       * open sky in this render. Keying by DISTANCE to that colour rather than by
       * a hue window, because the buildings are pastel too and several of them
       * are within a hue or two of the sky — distance in RGB separates them where
       * hue alone does not. */
      const d = ctx.getImageData(0, 0, c.width, c.height);
      const px = d.data;
      const kr = px[0], kg = px[1], kb = px[2];
      const NEAR = 26, FAR = 52;   // fully transparent below NEAR, opaque past FAR
      for (let i = 0; i < px.length; i += 4) {
        const dist = Math.sqrt(
          (px[i] - kr) ** 2 + (px[i + 1] - kg) ** 2 + (px[i + 2] - kb) ** 2);
        if (dist <= NEAR) px[i + 3] = 0;
        else if (dist < FAR) px[i + 3] = Math.round(255 * (dist - NEAR) / (FAR - NEAR));
      }
      ctx.putImageData(d, 0, 0);
      out.sky = {
        w: c.width, h: c.height, key: [kr, kg, kb],
        data: c.toDataURL('image/png'),
      };
    }
    return out;
  })();
}

(async () => {
  const dir = fs.readdirSync(path.join(ROOT, 'resources'));
  let road = null;
  for (const cand of ROAD_TILES) {
    const hit = dir.filter((f) => cand.match.test(f)).sort().pop();
    if (hit) { road = { file: hit, crop: cand.crop }; break; }
  }
  if (!road) throw new Error('no road tile found in resources/');
  const roadFile = road.file;
  const skyFile = pick([/Stylized_city_skyline.*1529.*\.jpe?g$/i,
                        /Stylized_city_skyline.*\.jpe?g$/i]);
  console.log('road   <- ' + roadFile +
    '   crop x ' + road.crop.x0 + '..' + road.crop.x1);
  console.log('sky    <- ' + (skyFile || '(none)'));

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
    const res = await page.evaluate(buildInPage, {
      roadSrc: base + 'resources/' + encodeURIComponent(roadFile),
      skySrc: skyFile ? base + 'resources/' + encodeURIComponent(skyFile) : null,
      crop: road.crop, roadW: ROAD_W, band: SKY_BAND, skyW: SKY_W,
    });

    fs.mkdirSync(OUT, { recursive: true });
    const write = (name, entry) => {
      const file = path.join(OUT, name);
      fs.writeFileSync(file, Buffer.from(entry.data.split(',')[1], 'base64'));
      console.log('  ' + name.padEnd(16) + entry.w + 'x' + entry.h + '  ' +
        (fs.statSync(file).size / 1024).toFixed(0) + 'KB');
    };
    console.log('');
    write('road-tile.jpg', res.road);
    if (res.sky) {
      write('skyline.png', res.sky);
      console.log('  (sky keyed on rgb(' + res.sky.key.join(',') + '))');
    }
  } finally {
    await browser.close();
    srv.close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
