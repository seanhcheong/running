/* =============================================================================
 * Huff&Puff — THE COURSE (sky, ground, textured road)
 * =============================================================================
 * Draws the world behind the game onto its own 2D canvas, layered beneath the
 * Phaser canvas. Phaser keeps drawing everything that MOVES — avatar, obstacles,
 * gates, the void — on top.
 *
 * WHY A SEPARATE CANVAS RATHER THAN PHASER GRAPHICS
 *
 * The road is a texture projected per scanline, and that needs `drawImage` with
 * a source rectangle. Phaser's Graphics API has no equivalent: it fills shapes
 * with flat colours. Doing it inside Phaser would mean maintaining a canvas
 * texture and re-uploading it every frame, which is the same work plus a GPU
 * upload. A plain canvas underneath is simpler and strictly cheaper.
 *
 * HOW THE ROAD IS PROJECTED
 *
 * The scene's projection is  s = zRef / (zRef + z),  y = horizon + depth·s.
 * Inverting it per screen row gives the depth of that row:
 *
 *     s = (y − horizon) / depth
 *     z = zRef · (1 − s) / s
 *
 * Then one horizontal band of the texture is stretched across the road's width
 * at that depth, which is `roadHalfW · s` either side of centre. Scrolling is an
 * offset added to z, so the road moves at exactly the rate the sim reports.
 *
 * THE TEXTURE HAS TO BE CROPPED, AND THE CROP IS MEASURED, NOT GUESSED
 *
 * The source art is a full track render including its side rails, so its three
 * lanes do NOT sit at the 1/6, 1/2, 5/6 the projection expects. The crop below
 * was derived by measuring the colourfulness profile across the tile: the
 * metallic dividers show as chroma minima at 0.34–0.37 and 0.63–0.66, putting
 * the lane centres at 0.213 / 0.500 / 0.775. Cropping to those bounds lands all
 * three centres within 0.3% of a lane width of where the avatar is drawn.
 *
 * Verified by sampling the rendered result under each lane centre: chroma 55–64
 * at all three, i.e. on rainbow surface, not on a grey divider.
 * ========================================================================== */

window.HP = window.HP || {};

(function (HP) {
  'use strict';

  const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

  /* The road tile arrives ALREADY CROPPED by tools/build-course.js, so nothing is
   * trimmed here. This used to hold the crop as well, which meant the crop was
   * applied twice — another 8% came off each side of an already-cropped tile and
   * the lanes drifted out of register with where the avatar is drawn. The
   * prototype that verified the crop read the raw source and cropped once, so it
   * never saw it; only sampling the LIVE road did.
   *
   * Kept as a constant rather than deleted so the sampling call below still reads
   * as a crop, and so a tile that needs trimming at draw time (an animated source,
   * say) has somewhere obvious to go. */
  const TILE_CROP = { x0: 0, x1: 1 };

  /* How much road distance one tile length covers. Lower = the pattern repeats
   * more often, so the chevrons and coins sit closer together and the road reads
   * as moving faster for a given speed. Matched to the reference, where the
   * markings are noticeably denser than a literal reading of the tile gives. */
  const UNITS_PER_TILE = 17;

  /* Band height in screen pixels for the scanline loop. 1 is smoothest; 2 halves
   * the draw calls for no visible difference, because consecutive bands differ by
   * well under a texture pixel except right at the player's feet. */
  const BAND = 2;

  /* Where the road stops being drawn. Beyond this the bands sample less than one
   * texture row each and shimmer, so the last stretch fades into haze instead.
   * Set far enough back that the road's own far edge lands deep inside the haze —
   * at 130 it terminated in a hard horizontal line the haze did not reach. */
  const Z_FAR = 190;
  const HAZE_START = 0.42;   // fraction of the road's screen height, from the horizon

  class Course {
    /**
     * @param {object} palette  HP.PALETTE
     */
    constructor(palette) {
      this.palette = palette;
      this.canvas = null;
      this.ctx = null;
      this.tile = null;         // HTMLImageElement, or null until/unless it loads
      this.tileReady = false;
      this.skyline = null;
      this.skylineReady = false;
      this._dpr = 1;
    }

    attach(canvasEl) {
      this.canvas = canvasEl;
      this.ctx = canvasEl.getContext('2d');
      return this;
    }

    /**
     * Load the course art. Never rejects: the course must draw with flat colours
     * if the art is missing, because everything else in this game works with no
     * assets at all and the road should not be the one thing that breaks that.
     */
    load(paths) {
      const one = (src, onto, flag) => new Promise((resolve) => {
        if (!src) return resolve(false);
        const img = new Image();
        img.onload = () => { this[onto] = img; this[flag] = true; resolve(true); };
        img.onerror = () => { this[flag] = false; resolve(false); };
        img.src = src;
      });
      return Promise.all([
        one(paths.roadTile, 'tile', 'tileReady'),
        one(paths.skyline, 'skyline', 'skylineReady'),
      ]).then((r) => ({ roadTile: r[0], skyline: r[1] }));
    }

    /** Size the backing store to the element, accounting for device pixel ratio. */
    resize(w, h) {
      if (!this.canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      this._dpr = dpr;
      const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
      if (this.canvas.width !== bw || this.canvas.height !== bh) {
        this.canvas.width = bw;
        this.canvas.height = bh;
      }
      this.canvas.style.width = w + 'px';
      this.canvas.style.height = h + 'px';
    }

    /**
     * @param {object} L  layout from the scene — the SAME numbers it projects
     *                    with: { W, H, cx, horizonY, groundY, roadHalfW, zRef }
     * @param {number} scrollZ  distance travelled, in road units
     * @param {number} speedNorm 0..1, drives the horizon haze intensity
     */
    draw(L, scrollZ, speedNorm) {
      const ctx = this.ctx;
      if (!ctx) return;
      const P = this.palette;
      ctx.setTransform(this._dpr, 0, 0, this._dpr, 0, 0);
      ctx.clearRect(0, 0, L.W, L.H);

      /* --- sky ---------------------------------------------------------- */
      const sky = ctx.createLinearGradient(0, 0, 0, L.horizonY);
      sky.addColorStop(0, P.skyTop);
      sky.addColorStop(1, P.skyBottom);
      ctx.fillStyle = sky;
      ctx.fillRect(0, 0, L.W, L.horizonY + 1);

      /* --- distant skyline, sitting ON the horizon ----------------------- */
      if (this.skylineReady) {
        const img = this.skyline;
        const bandH = Math.max(18, L.H * 0.085);
        const scale = bandH / img.naturalHeight;
        const drawW = img.naturalWidth * scale;
        /* Parallax: drifts slowly with distance so the horizon is not dead, at a
         * fraction of the road's rate because it is supposed to be far away. */
        let off = (-scrollZ * 0.35) % drawW;
        if (off > 0) off -= drawW;
        ctx.save();
        ctx.globalAlpha = 0.9;
        for (let x = off; x < L.W; x += drawW) {
          ctx.drawImage(img, x, L.horizonY - bandH + 1, drawW, bandH);
        }
        ctx.restore();
      }

      /* --- ground plane -------------------------------------------------- */
      const gnd = ctx.createLinearGradient(0, L.horizonY, 0, L.H);
      gnd.addColorStop(0, P.groundFar);
      gnd.addColorStop(1, P.groundNear);
      ctx.fillStyle = gnd;
      ctx.fillRect(0, L.horizonY, L.W, L.H - L.horizonY);

      /* --- the street ----------------------------------------------------
       * Before the road, so a building whose base overhangs the kerb is covered
       * by the road rather than sitting on top of it. */
      this._drawStreet(L, scrollZ);

      /* --- the road ------------------------------------------------------ */
      if (this.tileReady) {
        this._drawTexturedRoad(L, scrollZ);
        this._drawTrackMarks(L, scrollZ);
      } else {
        this._drawFlatRoad(L, scrollZ);
      }

      /* --- horizon haze --------------------------------------------------
       * Two jobs. It hides the shimmer where scanline bands sample under one
       * texture row, and it reads as aerial perspective, which a daylight scene
       * needs or the far road looks like a sticker. Brightens with speed, so
       * pace is legible without looking at the HUD. */
      const depth = L.groundY - L.horizonY;
      const hazeH = depth * HAZE_START;
      const haze = ctx.createLinearGradient(0, L.horizonY, 0, L.horizonY + hazeH);
      haze.addColorStop(0, P.hazeStrong);
      haze.addColorStop(1, P.hazeClear);
      ctx.fillStyle = haze;
      ctx.globalAlpha = 0.75 + 0.25 * clamp(speedNorm, 0, 1);
      ctx.fillRect(0, L.horizonY, L.W, hazeH);
      ctx.globalAlpha = 1;
    }

    /**
     * Transverse markings across the track.
     *
     * Not decoration — a measured fix. The road texture is a uniform surface with
     * CONTINUOUS lane lines, which means nothing on it changes as it scrolls:
     * sampling the rendered road before and after 15 road units of travel found
     * only 6.4% of pixels changed, mean 4.8/255. The track conveyed no motion at
     * all, and every sense of speed was coming from the buildings.
     *
     * Anything crossing the direction of travel fixes that, because it sweeps
     * toward the player and grows as it comes. A real athletics track is covered
     * in exactly such markings — start lines, distance marks, exchange zones — so
     * this is authentic as well as functional, which is the good case.
     *
     * Drawn here rather than baked into the tile so the spacing is independent of
     * the texture's repeat length. Baked in, marks and tile would have to share a
     * period, and tuning one would move the other.
     */
    _drawTrackMarks(L, scrollZ) {
      const ctx = this.ctx;
      const zRef = L.zRef;
      const SPACING = 11;          // road units between marks
      const phase = ((scrollZ % SPACING) + SPACING) % SPACING;

      ctx.fillStyle = '#ffffff';
      for (let n = -1; n < Math.ceil(Z_FAR / SPACING) + 1; n++) {
        const z = n * SPACING - phase;
        if (z > Z_FAR) continue;
        const s = zRef / (zRef + z);
        if (!isFinite(s) || s <= 0) continue;
        const y = L.horizonY + (L.groundY - L.horizonY) * s;
        if (y > L.H) continue;
        const half = L.roadHalfW * s;
        /* Fade with distance, matching the horizon haze, and cap the near
         * thickness — a mark right at the camera would otherwise be a band
         * several times the height of anything else on screen. */
        ctx.globalAlpha = clamp(s * 1.9, 0, 1) * 0.42;
        ctx.fillRect(L.cx - half, y, half * 2, clamp(3.4 * s, 1, 9));
      }
      ctx.globalAlpha = 1;
    }

    /* --- the street ----------------------------------------------------
     * Buildings flanking the road, as flat front faces at successive depths and
     * drawn far to near so the nearer ones occlude the farther. Procedural rather
     * than from art, deliberately: this needs to key off the SAME projection the
     * road and the avatar use, and a pre-rendered street would have to agree with
     * that projection exactly or the two would slide against each other.
     *
     * Everything about a given building derives from a hash of its index, so it
     * does not shimmer or reshuffle as the road scrolls — a building three blocks
     * away must still be the same building when it arrives.
     */
    _drawStreet(L, scrollZ) {
      const ctx = this.ctx;
      const P = this.palette;
      const zRef = L.zRef;
      const SPACING = 6;            // road units between buildings
      const hues = P.streetHues;

      /* Integer hash. Stable per index, and cheap — this runs for every building
       * every frame. */
      const rnd = (i, salt) => {
        let h = (i * 374761393 + salt * 668265263) | 0;
        h = (h ^ (h >> 13)) * 1274126177 | 0;
        return ((h ^ (h >> 16)) >>> 0) / 4294967296;
      };

      const first = Math.floor(scrollZ / SPACING);
      const count = Math.ceil(Z_FAR / SPACING) + 2;
      // Far to near.
      for (let k = count; k >= 0; k--) {
        const idx = first + k;
        const z = idx * SPACING - scrollZ;
        /* Down to z = 2 rather than 5, so the frontages continue past the player
         * and off the bottom corners instead of stopping short and leaving a gap
         * of bare ground beside the camera. Still not to zero: a building at z~0
         * projects to several times the screen height and becomes a slab. */
        if (z < 2 || z > Z_FAR) continue;
        const s = zRef / (zRef + z);
        const yBase = L.horizonY + (L.groundY - L.horizonY) * s;
        const kerb = L.roadHalfW * s;

        for (let side = -1; side <= 1; side += 2) {
          const r0 = rnd(idx, side > 0 ? 1 : 2);
          const r1 = rnd(idx, side > 0 ? 3 : 4);
          const r2 = rnd(idx, side > 0 ? 5 : 6);
          // Heights in road units so they shrink with depth like everything else.
          const hUnits = 1.15 + r0 * 1.9;
          const wUnits = 1.0 + r1 * 1.0;
          const bw = wUnits * L.roadHalfW * s * 0.52;
          const bh = hUnits * (L.groundY - L.horizonY) * s * 0.40;
          /* A narrow kerb only. The reference has the frontages meeting the road
           * almost directly; the wider pavement this used to leave was reading as
           * a gap and pushing the street away from the track. */
          const xInner = L.cx + side * (kerb + L.roadHalfW * s * 0.03);
          const x0 = side < 0 ? xInner - bw : xInner;

          ctx.fillStyle = hues[Math.floor(r2 * hues.length) % hues.length];
          ctx.fillRect(x0, yBase - bh, bw, bh);
          /* A darker inner face so the row reads as a street with depth rather
           * than as a flat row of rectangles. */
          ctx.fillStyle = P.streetShade;
          ctx.fillRect(side < 0 ? xInner - bw * 0.18 : xInner, yBase - bh,
            bw * 0.18, bh);
          // Rooftop nick, for silhouette variety.
          if (r0 > 0.55) {
            ctx.fillStyle = hues[Math.floor(r1 * hues.length) % hues.length];
            const nw = bw * 0.4;
            ctx.fillRect(x0 + (side < 0 ? 0 : bw - nw), yBase - bh - bh * 0.16,
              nw, bh * 0.16);
          }

          /* --- lit windows and a sign --------------------------------------
           * On a dark facade this is where essentially all of the street's
           * readability comes from, and it is also the cheapest sense of speed
           * available: a grid of small bright marks streaming past the edge of
           * the frame reads as motion far more strongly than a plain wall does.
           *
           * Skipped once a building is small on screen — below a few pixels per
           * window the grid turns into noise that shimmers as the road scrolls. */
          if (bw > 22 && bh > 26) {
            const cols = Math.max(1, Math.round(bw / (10 * Math.max(0.35, s))));
            const rowsN = Math.max(1, Math.round(bh / (13 * Math.max(0.35, s))));
            const pad = bw * 0.14;
            const cw = (bw - pad * 2) / cols, chh = (bh - pad * 2) / rowsN;
            const ww = Math.max(1, cw * 0.52), wh = Math.max(1, chh * 0.46);
            for (let wy = 0; wy < rowsN; wy++) {
              for (let wx = 0; wx < cols; wx++) {
                const q = rnd(idx * 97 + wy * 13 + wx, side > 0 ? 11 : 12);
                if (q < 0.42) continue;                  // unlit
                ctx.fillStyle = q > 0.86 ? P.windowCool : P.windowLit;
                ctx.fillRect(x0 + pad + wx * cw, yBase - bh + pad + wy * chh, ww, wh);
              }
            }
            // A vertical neon sign on the road-facing edge, on some buildings.
            if (r1 > 0.62) {
              const sw2 = Math.max(1.5, bw * 0.10);
              const sh2 = bh * 0.42;
              ctx.fillStyle = P.signNeon;
              ctx.fillRect(side < 0 ? xInner - sw2 * 1.6 : xInner + sw2 * 0.6,
                yBase - bh + bh * 0.10, sw2, sh2);
            }
          }
        }
      }
    }

    /* --- scanline projection ------------------------------------------- */
    _drawTexturedRoad(L, scrollZ) {
      const ctx = this.ctx;
      const img = this.tile;
      const tw = img.naturalWidth, th = img.naturalHeight;
      const sx = Math.round(TILE_CROP.x0 * tw);
      const sw = Math.round((TILE_CROP.x1 - TILE_CROP.x0) * tw);
      const depth = L.groundY - L.horizonY;
      const zRef = L.zRef;

      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'low';   // 'high' costs ~3x here for no gain

      /* Down to the BOTTOM OF THE FRAME, not to groundY.
       *
       * groundY is where the player stands, i.e. z = 0 — it is not the edge of
       * the world. Stopping there left the bottom fifth of the screen as bare
       * ground with the road apparently floating above it, which is most of why
       * the track read as small and detached from the camera. Rows below groundY
       * simply have s > 1, so the same inverse gives a NEGATIVE z (road that has
       * already passed the player) and a half-width wider than roadHalfW. The
       * maths needs no special case; it only needed to be allowed to run. */
      const yTop = L.horizonY + depth * (zRef / (zRef + Z_FAR));
      for (let y = Math.ceil(yTop); y < L.H; y += BAND) {
        const s = (y - L.horizonY) / depth;
        if (s <= 0.002) continue;
        const z = zRef * (1 - s) / s;
        const sNext = (y + BAND - L.horizonY) / depth;
        const zNext = zRef * (1 - sNext) / sNext;

        const halfW = L.roadHalfW * s;
        // v runs 0..1 down the tile; negated so the road moves TOWARD the player.
        const v = 1 - (((z + scrollZ) / UNITS_PER_TILE) % 1);
        const dv = Math.abs(zNext - z) / UNITS_PER_TILE;
        const srcH = clamp(dv * th, 1, th);
        const srcY = clamp(v * th - srcH, 0, th - srcH);

        ctx.drawImage(img, sx, srcY, sw, srcH,
          L.cx - halfW, y, halfW * 2, BAND + 1);
      }
    }

    /* Flat fallback, used when the tile is absent. Deliberately kept: the game
     * shipped with zero assets and must still run that way. */
    _drawFlatRoad(L, scrollZ) {
      const ctx = this.ctx;
      const P = this.palette;
      const zRef = L.zRef;
      const sFar = zRef / (zRef + Z_FAR);
      const yFar = L.horizonY + (L.groundY - L.horizonY) * sFar;

      ctx.fillStyle = P.road;
      ctx.beginPath();
      ctx.moveTo(L.cx - L.roadHalfW, L.groundY);
      ctx.lineTo(L.cx + L.roadHalfW, L.groundY);
      ctx.lineTo(L.cx + L.roadHalfW * sFar, yFar);
      ctx.lineTo(L.cx - L.roadHalfW * sFar, yFar);
      ctx.closePath();
      ctx.fill();

      ctx.strokeStyle = P.laneLine;
      ctx.lineWidth = 1.5;
      [-0.5, 0.5].forEach((off) => {
        const laneW = L.roadHalfW / 1.5;
        ctx.beginPath();
        ctx.moveTo(L.cx + off * laneW, L.groundY);
        ctx.lineTo(L.cx + off * laneW * sFar, yFar);
        ctx.stroke();
      });

      const spacing = 12;
      const phase = scrollZ % spacing;
      ctx.fillStyle = P.stripe;
      for (let n = 0; n < 14; n++) {
        const z = n * spacing - phase;
        if (z < 0 || z > Z_FAR) continue;
        const s = zRef / (zRef + z);
        const y = L.horizonY + (L.groundY - L.horizonY) * s;
        ctx.globalAlpha = 0.10 + 0.35 * s;
        ctx.fillRect(L.cx - L.roadHalfW * s, y, L.roadHalfW * 2 * s, Math.max(1, 8 * s));
      }
      ctx.globalAlpha = 1;
    }
  }

  HP.Course = Course;
  HP.COURSE_TUNING = { TILE_CROP, UNITS_PER_TILE, BAND, Z_FAR };
})(window.HP);
