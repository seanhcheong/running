#!/usr/bin/env node
/* =============================================================================
 * Slice the character reference sheets in resources/ into game sprites.
 * =============================================================================
 * Run:  node tools/extract-sprites.js
 * Out:  assets/sprites/*.png  (transparent, character 250px tall — see STAND_PX)
 *
 * This exists as a tool rather than as a one-off because the source sheets are
 * checked in: if the art is ever re-rendered, the sprites regenerate instead of
 * being hand-traced again. It also PRUNES: any PNG in the output directory that
 * this run does not produce is deleted, so a renamed or dropped frame cannot linger
 * at a stale scale under a name the game still asks for.
 *
 * WHY IT WORKS THE WAY IT DOES
 *
 * There is no PIL, numpy, ImageMagick or sharp in this project's toolchain, and
 * adding one for a build step that runs once would be a poor trade. Chromium is
 * already a dependency (Playwright drives the test suite), and it is a complete
 * image pipeline: decode JPEG, read pixels, write PNG. So the browser is the
 * image library.
 *
 * There are TWO keys, chosen per sheet, because the two sheets pose different
 * problems (see SHEETS below for which gets which and the measurements behind it):
 *
 *   'hue'       Key on hue, not luminance. Needed when the subject stands on
 *               something that is not a flat backdrop:
 *                 - grid lines and text labels are grey   -> no saturation, out
 *                 - rainbow ground shadows are saturated, but their hue sweeps
 *                   the whole wheel, so a narrow teal window rejects them while
 *                   keeping the character standing on top of them
 *                 - the character's pale highlights keep just enough saturation
 *               The cost is that it decides by what the subject is expected to
 *               look like, so it clips shadowed pixels whose hue has drifted.
 *
 *   'backdrop'  Key on distance from the sampled backdrop colour. Correct when
 *               there IS a flat backdrop, and strictly better there: it asks
 *               "is this the background" rather than "is this the subject", so no
 *               amount of shadow or colour drift in the subject can clip it.
 *
 * The source is JPEG, which matters. 4:2:0 chroma subsampling halves colour
 * resolution and ringing fringes every high-contrast edge, so a raw matte comes
 * out with a 1-2px halo of half-keyed pixels. Two things deal with it: edge
 * pixels get partial alpha rather than full, and their colour is un-premultiplied
 * against the sampled backdrop before being re-composited.
 * ========================================================================== */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'assets', 'sprites');
const PORT = 8123;

/* ===========================================================================
 * ONE CHARACTER SIZE ACROSS BOTH SHEETS
 * ---------------------------------------------------------------------------
 * The character's standing height, in output pixels, in every shipped frame.
 *
 * This used to be a download cap (longest edge <= 256) applied per sheet, and
 * that was fine while the game only drew frames from ONE sheet. It stopped being
 * fine when the runner started using the square-on back view from the blob sheet
 * while jump/duck/hit came from the penguin sheet: the two sheets render the
 * character at different sizes, so a cap on the longest edge pinned each sheet
 * independently and the character changed size the moment it jumped. Measured,
 * the same upright pose came out 199px tall on one sheet and 243px on the other,
 * a 22% jump.
 *
 * Sizing to a declared STANDING HEIGHT instead makes the invariant the game needs
 * — the character is the same size in every frame — a property of the output
 * rather than a coincidence of two caps. Each sheet names an upright pose as its
 * `standRef`; every frame on that sheet is scaled by STAND_PX / that pose's
 * measured height, which preserves relative pose sizes within the sheet exactly
 * as before while also making them agree ACROSS sheets.
 *
 * 250 is chosen to match what the game actually draws: _avatarHeightPx() is
 * ~248px on a 412x892 phone, the largest it gets, so frames are never upscaled.
 * MAX_EDGE stays on as a pure safety valve against a pose with its arms flung
 * wide producing an absurd canvas; it is not the sizing mechanism and should not
 * normally bind.
 * ======================================================================== */
const STAND_PX = 250;
const MAX_EDGE = 400;

/* ===========================================================================
 * SHEETS
 * ---------------------------------------------------------------------------
 * One slicer serves both sheets; they differ in their grid, their naming, and
 * their `key`. Each sheet's `key` comment records the measurement that chose it.
 *
 * Cells are assigned by GRID POSITION (row = floor(cy*rows), col = floor(cx*cols))
 * rather than by sort order. Sorting by centroid looked equivalent and is not:
 * on the state sheet the airborne jump frame sits higher in its row than its
 * neighbours, so a cy-dominant sort interleaved row 1 and put the names one cell
 * out. Grid assignment cannot do that.
 * ======================================================================== */
const SHEETS = [
  {
    match: /blob_character.*\.(jpe?g|png)$/i,
    rows: 5, cols: 3,
    /* Hue window. This sheet is a white grid page and the characters stand on
     * RAINBOW ground shadows that touch their feet, so there is no single
     * backdrop colour to key against and the shadow cannot be dropped afterwards
     * (it merges into the character's own connected component). A teal hue window
     * plus an upper brightness bound is the only thing that separates them. */
    key: 'hue',
    /* An upright standing pose, which is what STAND_PX is measured against. This
     * one is a FRONT view and that is fine: height does not depend on which way an
     * upright figure faces, and it is the cleanest stand on the sheet. */
    standRef: 'standing',
    names: [
      ['standing', 'running_front', 'state-run'],
      ['step_front', 'running_side', 'running_back_road'],
      ['burpee_down', 'squat_down_side', 'hands_down_plant'],
      ['plank', 'mid_push_up', 'recovery_upward'],
      ['jumping', 'clap', 'stretching'],
    ],
    /* Only two frames ship from this sheet. `state-run` is the game's runner: it is
     * the only square-on BACK view either sheet contains, measuring 1% silhouette
     * mirror mismatch against 19% for the penguin sheet's upright pose, which is
     * what a character running straight down a road needs. `standing` is the start
     * screen's hero image, and is also this sheet's scale reference.
     *
     * The other five that used to ship — burpee_down, recovery_upward, clap,
     * stretching, jumping — were kept for a wall-mode pose reference that was never
     * wired up, and every one of them is a FRONT view with a face, so none could
     * serve as a runner. They were 200KB the player downloaded and never saw. The
     * remaining cells are side/three-quarter views, floor poses the matcher cannot
     * yet handle, or composed scenes rather than characters. */
    keep: ['standing', 'state-run'],
  },
  {
    /* --- THE RUN CYCLE -----------------------------------------------------
     * Not yet in resources/. This entry ships ahead of the art so that dropping
     * the sheet in and re-running the tool is the whole job.
     *
     * WHY THIS SHEET IS THE ONE THAT MATTERS
     *
     * The runner is currently a single frame moved by transforms, and a filmstrip
     * of one full stride showed the reason that will never read as running: across
     * all eight phases THE FEET ARE PIXEL-IDENTICAL. Both planted, never
     * alternating, while the body bobs and leans. A rigid two-footed stance that
     * rocks side to side is not an under-tuned run, it is the definition of a
     * waddle, and no amount of amplitude tuning converts one into the other. The
     * feet have to change between frames, and only art can do that.
     *
     * The same filmstrip also settled an earlier claim of mine in the other
     * direction: the feet are plainly visible below the body, unobstructed. The
     * "body occludes the legs, so leg position does not read from behind" argument
     * was simply wrong, and this is the second correction it has needed.
     *
     * 4 columns x 2 rows. Row 1 is the left foot's step, row 2 the right; four
     * moments each (contact, passing, push-off, flight). See docs/ART-BRIEF.md for
     * the prompt and for why each cell is described categorically rather than as a
     * degree of swing. */
    match: /(run_cycle|Penguin_run_cycle|run.?cycle).*\.(jpe?g|png)$/i,
    rows: 2, cols: 4,
    key: 'backdrop',
    /* No standing pose exists on a run-cycle sheet. The left CONTACT frame is the
     * closest thing: the stance leg is straight and vertical under the hips, so the
     * body sits at very close to full standing height. Approximate on purpose, and
     * the one number to check first if the character changes size when the cycle
     * takes over from state-run. */
    standRef: 'state-run-1',
    names: [
      ['state-run-1', 'state-run-2', 'state-run-3', 'state-run-4'],
      ['state-run-5', 'state-run-6', 'state-run-7', 'state-run-8'],
    ],
    keep: ['state-run-1', 'state-run-2', 'state-run-3', 'state-run-4',
           'state-run-5', 'state-run-6', 'state-run-7', 'state-run-8'],
  },
  {
    match: /Penguin_reference_sheet.*\.(jpe?g|png)$/i,
    rows: 3, cols: 3,
    /* --- BACKDROP DISTANCE, not a hue window ------------------------------
     * This sheet is a flat magenta backdrop with NO ground shadow: sampled six
     * pixels under the feet, every probe across the cell came back
     * rgb(251,4,243). So the two clauses the hue key needs on the other sheet
     * cost accuracy here and buy nothing — measured over the whole state-idle
     * cell, the `mx < 242` brightness bound rejected exactly zero pixels, while
     * the hue window's green edge rejected ~790 (0.17% of the cell), which is
     * where the ragged notch through the character's crotch came from. Those are
     * real character pixels: mean rgb(102,136,111), hue 136 degrees, i.e. teal
     * gone slightly green in a deep shadowed crevice, a couple of degrees
     * outside a window tuned on lit surfaces.
     *
     * With a known flat backdrop the correct key is distance FROM it — the same
     * technique tools/build-course.js uses on the skyline, and for the same
     * reason: a hue window asks "is this the colour I expect the subject to be",
     * which fails on every shadow and every JPEG-smeared edge, where distance
     * from the backdrop only asks "is this the backdrop", which is the question
     * actually being decided. */
    key: 'backdrop',
    standRef: 'state-idle',
    /* Named from what the sheet actually contains, which is not what was asked
     * for. The top row was meant to be three stride phases; measured pairwise
     * silhouette difference came out at 0.4-0.7%, i.e. the same render three
     * times. From directly behind, the body occludes the legs, so a stride is
     * nearly invisible at this camera angle. That killed the run cycle but it also
     * removed the reason to want one: the runner is now a single frame moved by
     * bob, sway, squash and rock, and none of those needs a second drawing. */
    names: [
      ['state-idle', 'idle_b', 'idle_c'],
      ['state-dive', 'state-jump', 'idle_d'],
      ['state-duck', 'state-hit', 'idle_e'],
    ],
    /* state-idle is this sheet's standRef and so is still MEASURED, but it no longer
     * ships: it is a three-quarter turn (silhouette mirror mismatch 19%, against
     * 1% for the square-on back view now used for the run) so it was never a
     * defensible frame to draw a character running straight down a road. Being the
     * scale reference does not require being downloaded. */
    keep: ['state-jump', 'state-duck', 'state-hit'],
  },
];

/** [row, col] of the sheet's standRef, for the page to locate by grid position. */
function standCellOf(spec) {
  for (let r = 0; r < spec.names.length; r++) {
    const c = spec.names[r].indexOf(spec.standRef);
    if (c >= 0) return [r, c];
  }
  throw new Error(spec.file + ': standRef "' + spec.standRef + '" is not in names');
}

function sheetsPresent() {
  const dir = path.join(ROOT, 'resources');
  if (!fs.existsSync(dir)) throw new Error('no resources/ directory');
  const files = fs.readdirSync(dir);
  const found = [];
  for (const spec of SHEETS) {
    const hit = files.filter((f) => spec.match.test(f)).sort().pop();
    if (hit) found.push(Object.assign({}, spec, { file: hit }));
  }
  if (!found.length) throw new Error('no recognised sheets in resources/');
  return found;
}

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

    /* The backdrop colour, for key === 'backdrop'. Taken as the median of the
     * four corners rather than one of them, so a stray grid line or a label in a
     * corner cannot become "the background". */
    const cornerAt = (x, y) => {
      const i = (y * W + x) * 4;
      return [px4[i], px4[i + 1], px4[i + 2]];
    };
    const corners = [cornerAt(2, 2), cornerAt(W - 3, 2),
                     cornerAt(2, H - 3), cornerAt(W - 3, H - 3)];
    const bg = [0, 1, 2].map((ch) => {
      const v = corners.map((c) => c[ch]).sort((a, b) => a - b);
      return (v[1] + v[2]) / 2;
    });

    /* --- backdrop key: a soft band, not a threshold ------------------------
     * A single cutoff does not work here, and the failure is measurable. Magenta
     * is rgb(251,8,241) and the character's teal sits ~240 units away in RGB, so
     * a pixel that is 60% backdrop still lands 96 units out. A cutoff anywhere
     * useful therefore accepts those pixels, and because they have a full set of
     * in-mask neighbours the edge pass gives them alpha 255 and the un-premultiply
     * below never runs on them: measured, that left a 1px magenta rim on 55-70% of
     * every silhouette, and nothing at all deeper than 2px.
     *
     * So the key returns a RAMP. Alpha rises across NEAR..FAR, which is where
     * JPEG chroma ringing lives, and every pixel in that band gets partial alpha
     * and is therefore un-premultiplied back to its true colour. FAR is set below
     * the 238 the palest highlight measures and the 260 the deepest shadow
     * measures, so the whole body stays fully opaque; NEAR is low enough that the
     * ramp is not clipped at its own start, and the >4000px component filter is
     * what stops the looser mask from admitting backdrop noise. */
    const BG_NEAR = 60, BG_FAR = 200;
    const bgAlpha = new Uint8Array(arg.key === 'backdrop' ? W * H : 0);

    const mask = new Uint8Array(W * H);
    for (let i = 0, p = 0; i < px4.length; i += 4, p++) {
      const r = px4[i], g = px4[i + 1], b = px4[i + 2];
      if (arg.key === 'backdrop') {
        const dist = Math.sqrt((r - bg[0]) ** 2 + (g - bg[1]) ** 2 + (b - bg[2]) ** 2);
        if (dist > BG_NEAR) {
          mask[p] = 1;
          bgAlpha[p] = dist >= BG_FAR ? 255
            : Math.round(255 * (dist - BG_NEAR) / (BG_FAR - BG_NEAR));
        }
        continue;
      }
      const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
      const sat = mx === 0 ? 0 : (mx - mn) / mx;
      const h = hueOf(r, g, b);
      /* The upper `mx` bound rejects the rainbow ground shadows. They contain
       * teal-ish bands that pass a hue test, and because the feet touch them
       * they merge into the character's own component — so they cannot be
       * dropped later as separate specks. Every part of them is brighter than
       * the character's lightest highlight, which measures ~236.
       *
       * The window's lower edge is 145 for LIT surfaces and 125 for dark ones.
       * Teal drifts toward green as it darkens, so a single edge tuned on lit
       * surfaces clips the deep creases — which is where the ragged notch through
       * the character's crotch came from. Histogramming the running_back cell put
       * 1021 pixels in hue 120-149, of which exactly ONE sat below the foot line:
       * they are creases in the body, not ground. They are also dark, mean
       * max-channel 125-142, where the ground shadow this window exists to reject
       * is brighter than 236 — so DARK_MAX separates the two cleanly with room to
       * spare, and the relaxation cannot let any of that shadow back in. */
      const DARK_MAX = 200;
      const loEdge = mx < DARK_MAX ? 125 : 145;
      if (sat > 0.10 && h >= loEdge && h <= 215 && mx > 28 && mx < 242) mask[p] = 1;
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
    const holesFilled = [];
    for (const k of comps.filter((z) => z.area > 4000).sort((a, b) => b.area - a.area)) {
      const pad = 6;
      const x0 = Math.max(0, k.minX - pad), y0 = Math.max(0, k.minY - pad);
      const x1 = Math.min(W - 1, k.maxX + pad), y1 = Math.min(H - 1, k.maxY + pad);
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      if (w < 40 || h < 40) continue;

      /* --- fill enclosed holes ---------------------------------------------
       * The mask's upper brightness bound (mx < 242) exists to reject the
       * rainbow ground shadow, and it does that job — but it also rejects the
       * character's OWN specular highlights, which measure up to 236. Where such
       * a highlight is surrounded by body, the result is a transparent speck in
       * the middle of the character. Measured on the hue-keyed sheet, this fills
       * 2-107 pixels per frame across 14 frames, which is small but shows up as
       * pinholes once the sprite is drawn at 250px.
       *
       * Fixed here rather than by relaxing the bound, because the bound is
       * load-bearing: the shadow touches the feet and merges into the same
       * connected component, so it cannot be dropped afterwards.
       *
       * An enclosed transparent region, by contrast, is unambiguous. The crop
       * is padded, so its border is background by construction; flood the
       * background inward from that border and any transparent pixel it fails
       * to reach is surrounded by character and therefore part of it. Those
       * pixels are relabelled into the component so they also take part in the
       * edge-alpha pass below — otherwise a ring of partial alpha would be left
       * around every filled hole. They keep their own source colour, which is
       * what they always were: a highlight on the body.
       *
       * This does NOT address the ragged notch that used to cut through the
       * crotch: that notch opened downward into the gap between the legs, so it
       * was never enclosed and the flood reached it. See the hue window's
       * DARK_MAX / loEdge above for the fix that did.
       * ------------------------------------------------------------------- */
      {
        const seen = new Uint8Array(w * h);
        const st = new Int32Array(w * h);
        let sp = 0;
        const push = (x, y) => {
          const q = y * w + x;
          if (seen[q]) return;
          if (label[(y0 + y) * W + (x0 + x)] === k.id) return;
          seen[q] = 1; st[sp++] = q;
        };
        for (let x = 0; x < w; x++) { push(x, 0); push(x, h - 1); }
        for (let y = 0; y < h; y++) { push(0, y); push(w - 1, y); }
        while (sp > 0) {
          const q = st[--sp];
          const x = q % w, y = (q - x) / w;
          if (x > 0) push(x - 1, y);
          if (x < w - 1) push(x + 1, y);
          if (y > 0) push(x, y - 1);
          if (y < h - 1) push(x, y + 1);
        }
        let filled = 0;
        for (let y = 0; y < h; y++) {
          for (let x = 0; x < w; x++) {
            const sq = (y0 + y) * W + (x0 + x);
            if (label[sq] !== k.id && !seen[y * w + x]) {
              label[sq] = k.id;
              /* Solid, or the alpha pass below would take min(edge, 0) and punch
               * the hole straight back open. */
              if (bgAlpha.length) bgAlpha[sq] = 255;
              filled++;
            }
          }
        }
        if (filled) holesFilled.push(filled);
      }

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
          /* Two independent reasons a pixel can be less than solid: it sits on
           * the silhouette boundary (few in-component neighbours), or it is
           * colour-contaminated by the backdrop. Take whichever says less — a
           * pixel deep enough inside to have all nine neighbours can still be
           * two-thirds backdrop, which is the rim this fixes. */
          let a = n >= 9 ? 255 : Math.round(255 * (n / 9) * 0.85);
          if (bgAlpha.length) a = Math.min(a, bgAlpha[sq]);
          const si = sq * 4;
          let r = px4[si], g = px4[si + 1], b = px4[si + 2];
          /* Un-premultiply against the PAGE, or every edge keeps a fringe of it.
           * Against the backdrop actually sampled, not against white: on the
           * magenta sheet, un-premultiplying a magenta-contaminated edge as if it
           * were white leaves the pink in and drives the green channel negative,
           * so the character gets a pink rim exactly where the fix is meant to
           * remove one. */
          if (a > 0 && a < 255) {
            const af = a / 255;
            r = Math.max(0, Math.min(255, (r - bg[0] * (1 - af)) / af));
            g = Math.max(0, Math.min(255, (g - bg[1] * (1 - af)) / af));
            b = Math.max(0, Math.min(255, (b - bg[2] * (1 - af)) / af));
          }
          const di = (y * w + x) * 4;
          dst.data[di] = r; dst.data[di + 1] = g; dst.data[di + 2] = b; dst.data[di + 3] = a;
        }
      }
      cctx.putImageData(dst, 0, 0);

      // Downscaling is deferred: see the shared-scale pass below.
      out.push({
        area: k.area,
        cx: (k.minX + k.maxX) / 2,
        cy: (k.minY + k.maxY) / 2,
        // Opaque box height BEFORE any scaling — what STAND_PX is measured against.
        boxH: k.maxY - k.minY + 1,
        canvas: cut,
      });
    }

    /* ONE scale factor for the whole sheet, not one per cell.
     *
     * Scaling each cell to its own longest edge destroys the RELATIVE size of the
     * poses — a crouch and a jump would come out the same height, and the
     * character would visibly pulse as the game switched between them. The whole
     * point of asking for a locked-off camera was to preserve those relative
     * sizes; normalising per cell would throw that away at the last step.
     *
     * The factor comes from the sheet's `standRef` cell, so it also lines up with
     * the OTHER sheet — see STAND_PX. Located by grid position, the same way node
     * assigns names, because the page has no name table. */
    let widest = 1;
    for (const o of out) widest = Math.max(widest, o.canvas.width, o.canvas.height);

    const cellW = W / arg.cols, cellH = W && arg.rows ? H / arg.rows : H;
    let standH = 0;
    for (const o of out) {
      const col = Math.min(arg.cols - 1, Math.floor(o.cx / cellW));
      const row = Math.min(arg.rows - 1, Math.floor(o.cy / cellH));
      if (row === arg.standCell[0] && col === arg.standCell[1]) standH = o.boxH;
    }
    /* No stand reference found (a sheet whose reference cell failed to key) falls
     * back to the old behaviour rather than shipping a wrongly-sized character. */
    let shared = standH ? arg.standPx / standH : Math.min(1, maxEdge / widest);
    shared = Math.min(shared, maxEdge / widest);

    const sprites = out.map((o) => {
      let c = o.canvas;
      if (Math.abs(shared - 1) > 1e-6) {
        const sc = document.createElement('canvas');
        sc.width = Math.max(1, Math.round(c.width * shared));
        sc.height = Math.max(1, Math.round(c.height * shared));
        const sctx = sc.getContext('2d');
        sctx.imageSmoothingEnabled = true;
        sctx.imageSmoothingQuality = 'high';
        sctx.drawImage(c, 0, 0, sc.width, sc.height);
        c = sc;
      }
      return { area: o.area, cx: o.cx, cy: o.cy, w: c.width, h: c.height,
               png: c.toDataURL('image/png') };
    });
    return { W, H, sheetScale: +shared.toFixed(4), sprites: sprites,
             holesFilled: holesFilled, bg: bg.map(Math.round),
             standH: standH, standOut: standH ? Math.round(standH * shared) : 0 };
  })();
}

(async () => {
  const sheets = sheetsPresent();
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
    fs.mkdirSync(OUT_DIR, { recursive: true });

    /* Every name this run is expected to produce. Anything else already in the
     * output directory is a leftover from a previous configuration, and leaving it
     * there is worse than useless: it is a PNG of this character at a scale that no
     * longer matches, sitting under a name the game might still ask for. */
    const expected = new Set();
    for (const spec of sheets) spec.keep.forEach((n) => expected.add(n + '.png'));
    const stale = fs.readdirSync(OUT_DIR)
      .filter((f) => /\.png$/i.test(f) && !expected.has(f));

    for (const spec of sheets) {
      const url = base + 'resources/' + encodeURIComponent(spec.file);
      const res = await page.evaluate(sliceInPage, {
        src: url, maxEdge: MAX_EDGE, key: spec.key || 'hue',
        rows: spec.rows, cols: spec.cols,
        standPx: STAND_PX, standCell: standCellOf(spec),
      });
      console.log('\n' + spec.file);
      console.log('  ' + res.sprites.length + ' components in a ' +
        spec.rows + 'x' + spec.cols + ' grid, all scaled by ' + res.sheetScale +
        ' (one factor per sheet, so relative pose sizes survive)');
      console.log("  key '" + (spec.key || 'hue') + "', backdrop sampled as rgb(" +
        res.bg.join(',') + '), stand ref ' + spec.standRef + ' ' + res.standH +
        'px -> ' + res.standOut + 'px' +
        (res.holesFilled.length
          ? ', enclosed holes filled: ' + res.holesFilled.join('/')
          : ''));

      const cellW = res.W / spec.cols, cellH = res.H / spec.rows;
      const kept = [], skipped = [];
      for (const s of res.sprites) {
        const col = Math.min(spec.cols - 1, Math.floor(s.cx / cellW));
        const row = Math.min(spec.rows - 1, Math.floor(s.cy / cellH));
        const name = spec.names[row][col];
        if (spec.keep.indexOf(name) < 0) { skipped.push(name); continue; }
        const file = path.join(OUT_DIR, name + '.png');
        fs.writeFileSync(file, Buffer.from(s.png.split(',')[1], 'base64'));
        kept.push('  ' + name.padEnd(18) + s.w + 'x' + s.h + '  ' +
          (fs.statSync(file).size / 1024).toFixed(0) + 'KB');
      }
      kept.sort().forEach((l) => console.log(l));
      if (skipped.length) {
        console.log('  not shipped: ' + skipped.sort().join(', '));
      }
    }
    if (stale.length) {
      stale.forEach((f) => fs.unlinkSync(path.join(OUT_DIR, f)));
      console.log('\n  pruned (no longer produced): ' + stale.sort().join(', '));
    }
    console.log('\n-> assets/sprites/');
  } finally {
    await browser.close();
    srv.close();
  }
})().catch((e) => { console.error(e.message); process.exit(1); });
