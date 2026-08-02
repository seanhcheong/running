/* =============================================================================
 * Huff&Puff — THE BLOB AVATAR
 * =============================================================================
 * One character definition, drawn from a set of joints, rendered through three
 * different call sites:
 *
 *   1. the running avatar          (Phaser Graphics, joints from the run rig)
 *   2. the wall cutouts            (Phaser Graphics, joints from a pose target)
 *   3. the fit meter               (2D canvas, target + live pose overlaid)
 *
 * Those used to be three separate figures — a back-view humanoid, a stick
 * figure, and another stick figure. Which meant the thing you are told to match
 * looked nothing like the thing you control, and any change to the character
 * had to be made three times. So the character lives here, and the drawing API
 * it targets is abstracted behind a four-method adapter (see phaserOps and
 * canvasOps) rather than duplicated per backend.
 *
 * WHY A BLOB IS THE RIGHT CHOICE HERE, not just a style preference:
 *
 *   - Everything in this game is drawn with primitives, zero image assets. A
 *     rounded body with stub limbs is *easier* to build from ellipses and
 *     tapered quads than a jointed humanoid is, and it degrades gracefully at
 *     small sizes where a stick figure turns to mush.
 *   - A blob silhouette is a more readable hole in a wall than a stick figure,
 *     because it has area. Measured, rendering all ten poses at the pixel sizes
 *     a wall actually occupies and comparing every pair by luminance — the
 *     fraction of pixels that differ between the HARDEST pair of poses:
 *
 *              depth      stick    blob
 *              z=100      0.23%   0.59%    first visible, 12.5s to contact
 *              z= 30      0.61%   1.52%    3.8s to contact
 *              z=  0      2.24%   5.31%    at the player
 *
 *     Better everywhere, by about 2.4x. Note what the absolute numbers say
 *     though: the hardest pair is always standing vs a knee raise, and it is
 *     genuinely near-identical until roughly z=30. That leaves ~3.8s to read and
 *     act, which is fine — but it is the reason the raised knee gets drawn over
 *     the body with a seam rather than tucked inside the silhouette, and the
 *     reason that seam has a floor in pixels. See METRICS.
 *
 * COORDINATE SPACE. Callers pass `joints` (hip-anchored, y grows downward) plus
 * a `plot` that maps that space to pixels, and `bsPx` = pixels per unit of that
 * space. Geometry happens in joint space; `plot` is applied last. That is what
 * lets the run rig hand over PIXEL joints with plot=identity while the pose
 * library hands over body-scale joints with a scaling plot, and get the same
 * character out of both.
 * ========================================================================== */

window.HP = window.HP || {};

(function (HP) {
  'use strict';

  /* ===========================================================================
   * PALETTE
   * ---------------------------------------------------------------------------
   * The reference art is a soft pastel teal (~#74c9c3). Used literally it loses
   * most of its contrast against this game's near-black sky (#05060f) and dark
   * road (#1b1c2e) — the avatar has to stay legible while it is the smallest
   * bright thing on a moving background. So the hue is kept and the value is
   * pushed up. Same character, lit for a night scene.
   * ======================================================================== */
  const SKIN = {
    normal: { body: 0x6fdfd0, light: 0xb9fdf2, shade: 0x2f9d94, face: 0x08222c },
    duck:   { body: 0x62d8ff, light: 0xb6ecff, shade: 0x2b7ea8, face: 0x08222c },
  };

  /* ===========================================================================
   * BODY PROFILE
   * ---------------------------------------------------------------------------
   * Half-width as a fraction of the widest point, sampled down the torso axis:
   * u = 0 is the crown of the head, u = 1 is the base of the body. Head and
   * torso are ONE continuous form with no neck — that is the whole silhouette.
   *
   * The widest point sits at u ~= 0.66 (low-bellied, so it reads as sitting on
   * its base rather than as an egg), and the last two samples close the base
   * quickly to give a broad rounded bottom rather than a point.
   * ======================================================================== */
  const PROFILE = [
    [0.00, 0.00], [0.02, 0.31], [0.06, 0.50], [0.12, 0.66], [0.20, 0.79],
    [0.31, 0.89], [0.44, 0.96], [0.58, 1.00], [0.72, 0.99], [0.84, 0.94],
    [0.93, 0.81], [1.00, 0.00],
  ];

  /* Proportions, every one a MULTIPLE OF TORSO LENGTH (shoulder-mid to hip-mid).
   *
   * Torso-relative rather than absolute is what makes this module unit-agnostic:
   * the pose library hands over joints already in body scales (torso = 1.0), the
   * run rig hands over raw pixels (torso = ~30px), and both produce the same
   * character without either caller converting anything.
   *
   * Tuned against the reference sheet: the body form comes out ~2.4 torsos tall
   * by ~1.45 wide — noticeably rounder than tall-and-thin, short of a ball. */
  const METRICS = {
    crownAbove: 0.88,   // how far the dome rises above the shoulder line
    baseBelow: 0.50,    // how far the base drops below the hip line
    halfWidth: 0.95,    // widest half-width of the body
    armRoot: 0.20,      // arm half-thickness at the shoulder
    armTip: 0.125,      // …and at the wrist
    legRoot: 0.30,      // leg half-thickness at the hip
    legTip: 0.21,       // …and at the tip (the visible foot: see below)
    eyeR: 0.062,
    eyeSpread: 0.20,
    outline: 0.055,     // dark seam that keeps limbs off the body

    /* --- readability exaggeration ---------------------------------------
     * These three exist because a blob is WIDE, and a wide body swallows any
     * limb whose 2D position happens to fall over the torso. They move the
     * DRAWING only; no match target is touched by them, so what the matcher
     * accepts is unchanged. See the note in drawBlob for why that is not
     * cheating but a necessity.
     */
    armAnchor: 1.02,    // arms hang off the body EDGE, not the shoulder keypoint
    armEase: 1.4,       // how fast that offset decays for a hand reaching inward
    legLength: 0.68,    // draw legs this fraction of the way to the knee: stubs
    legOut: 0.35,       // nudge a RAISED knee outward by up to this much
    legEase: 1.8,       // …applied steeply, so a squat splays far less than a raise
    legNeutral: 1.00,   // knee distance below the hips that counts as "standing"
  };

  const OUTLINE_SAMPLES = 13;   // per profile segment; the base needs the density

  /* ===========================================================================
   * BACKEND ADAPTERS
   * ---------------------------------------------------------------------------
   * Colours are canonically numbers (0xRRGGBB) because Phaser wants them that
   * way; the canvas adapter converts. Four methods is all the character needs.
   * ======================================================================== */
  function phaserOps(g) {
    return {
      poly(pts, color, alpha) {
        if (pts.length < 3) return;
        g.fillStyle(color, alpha);
        g.fillPoints(pts, true, true);
      },
      strokePoly(pts, color, alpha, width) {
        if (pts.length < 2) return;
        g.lineStyle(width, color, alpha);
        g.strokePoints(pts, true, true);
      },
      circle(x, y, r, color, alpha) {
        if (r <= 0) return;
        g.fillStyle(color, alpha);
        g.fillCircle(x, y, r);
      },
      ellipse(x, y, w, h, color, alpha) {
        if (w <= 0 || h <= 0) return;
        g.fillStyle(color, alpha);
        g.fillEllipse(x, y, w, h);
      },
    };
  }

  const hex = (n) => '#' + (n & 0xffffff).toString(16).padStart(6, '0');

  function canvasOps(ctx) {
    const trace = (pts) => {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
    };
    return {
      poly(pts, color, alpha) {
        if (pts.length < 3) return;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = hex(color);
        trace(pts);
        ctx.fill();
        ctx.globalAlpha = 1;
      },
      strokePoly(pts, color, alpha, width) {
        if (pts.length < 2) return;
        ctx.globalAlpha = alpha;
        ctx.strokeStyle = hex(color);
        ctx.lineWidth = width;
        ctx.lineJoin = 'round';
        trace(pts);
        ctx.stroke();
        ctx.globalAlpha = 1;
      },
      circle(x, y, r, color, alpha) {
        if (r <= 0) return;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = hex(color);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      },
      ellipse(x, y, w, h, color, alpha) {
        if (w <= 0 || h <= 0) return;
        ctx.globalAlpha = alpha;
        ctx.fillStyle = hex(color);
        ctx.beginPath();
        ctx.ellipse(x, y, w / 2, h / 2, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
      },
    };
  }

  /* ===========================================================================
   * GEOMETRY
   * ======================================================================== */
  const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

  function pt(joints, name) {
    const v = joints ? joints[name] : null;
    if (!v) return null;
    if (Array.isArray(v)) return { x: v[0], y: v[1] };
    if (typeof v.x !== 'number' || typeof v.y !== 'number') return null;
    return { x: v.x, y: v.y };
  }

  function mid(a, b) {
    if (a && b) return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    return a || b || null;
  }

  /** Half-width at u, linearly interpolated through PROFILE. */
  function profileAt(u) {
    if (u <= 0 || u >= 1) return 0;
    for (let i = 1; i < PROFILE.length; i++) {
      if (u <= PROFILE[i][0]) {
        const [u0, w0] = PROFILE[i - 1];
        const [u1, w1] = PROFILE[i];
        const t = (u1 - u0) < 1e-6 ? 0 : (u - u0) / (u1 - u0);
        return w0 + (w1 - w0) * t;
      }
    }
    return 0;
  }

  /**
   * The torso frame, plus the two readability exaggerations that live in it.
   *
   * `along` runs hip -> shoulder (so a knee below the hips is negative) and `lat`
   * is perpendicular. Working in this frame rather than in screen axes is what
   * makes both exaggerations follow a leaning body instead of sliding off it.
   *
   * Shared by drawBlob and blobBounds — the bounds have to describe what is
   * actually DRAWN, or the fit meter frames the un-exaggerated pose and clips a
   * raised knee straight off the edge of the canvas.
   */
  function torsoRig(shMid, hipMid, len, m) {
    const ux = (shMid.x - hipMid.x) / len, uy = (shMid.y - hipMid.y) / len;
    const nx = -uy, ny = ux;

    const toFrame = (p) => ({
      along: (p.x - hipMid.x) * ux + (p.y - hipMid.y) * uy,
      lat: (p.x - hipMid.x) * nx + (p.y - hipMid.y) * ny,
    });
    const fromFrame = (f) => ({
      x: hipMid.x + ux * f.along + nx * f.lat,
      y: hipMid.y + uy * f.along + ny * f.lat,
    });

    return {
      ux: ux, uy: uy, nx: nx, ny: ny,
      toFrame: toFrame, fromFrame: fromFrame,

      /** Half-width of the body form at a given distance along the torso axis. */
      bodyHalfWidthAt(along) {
        const crown = len * (1 + m.crownAbove);
        const total = len * (1 + m.crownAbove + m.baseBelow);
        return profileAt((crown - along) / total) * m.halfWidth * len;
      },

      /* Hang the arm off the body's EDGE rather than off the shoulder keypoint.
       *
       * A shoulder sits at ~0.40 body scales from the midline; this body is ~0.95
       * wide. So an anatomically-placed arm is drawn entirely inside the
       * silhouette and simply cannot be seen — which for a pose library where
       * three of ten poses differ only in the arms is fatal. Shifting the whole
       * chain out by the gap between the two fixes it.
       *
       * The shift decays for joints that are closer to the midline than the
       * shoulder is, which is what keeps the clap's hands together: they want to
       * meet in front of the chest, and a rigid outward shift would prise them
       * apart by half a body width. */
      spreadArm(p, shoulderLat) {
        if (!p) return null;
        const f = toFrame(p);
        const root = Math.abs(shoulderLat);
        if (root < 1e-6) return fromFrame(f);
        const gap = Math.max(0, m.halfWidth * m.armAnchor * len - root);
        const ease = Math.pow(clamp01(Math.abs(f.lat) / root), m.armEase);
        f.lat += (shoulderLat < 0 ? -1 : 1) * gap * ease;
        return fromFrame(f);
      },

      /* Legs are stubs, and a raised knee gets swung outward.
       *
       * The swing is not decoration. MoveNet is 2D and so is the cutout, and a
       * knee raised TOWARD the camera lands in 2D almost on top of the belly —
       * which on a body this wide means the stub is drawn inside the silhouette
       * and "knee up" becomes pixel-identical to "standing". That is not a
       * hypothetical: the first version of this renderer produced a contact sheet
       * where knee_up_left and stand_tall were indistinguishable, and those are
       * two poses a winded player has to tell apart in about a second. So the
       * higher the knee, the further out the stub is drawn. No match target is
       * touched, so what the matcher accepts is exactly what it was. */
      legTip(side, knee) {
        if (!knee) return null;
        const f = toFrame(knee);
        /* Eased, not linear: a squat's knees rise about half as far as a knee
         * raise's do, and a linear push splayed the squat into the splits. */
        const rise = clamp01(1 - Math.abs(f.along) / (m.legNeutral * len || 1));
        f.lat += side * m.legOut * Math.pow(rise, m.legEase) * len;
        f.along *= m.legLength;
        return fromFrame(f);
      },
    };
  }

  /**
   * The body form as a closed outline in JOINT space.
   *
   * Built along the torso axis (hip-mid → shoulder-mid) rather than along
   * screen-vertical, so a side bend or a lane-change lean tilts the whole body
   * instead of shearing it. Returns points in joint space; the caller plots.
   */
  function bodyOutline(shMid, hipMid, m) {
    let dx = shMid.x - hipMid.x;
    let dy = shMid.y - hipMid.y;
    let len = Math.sqrt(dx * dx + dy * dy);
    /* A torso pointing at the camera collapses this length toward zero, which
     * would divide the whole character by ~0. Fall back to upright: a degenerate
     * torso is exactly the case the pose library does not yet cover, and drawing
     * a sane blob beats drawing a singularity. */
    if (!isFinite(len) || len < 1e-3) { dx = 0; dy = -1; len = 1; }
    const ux = dx / len, uy = dy / len;          // unit: hip → shoulder
    const px = -uy, py = ux;                     // unit normal

    // Crown and base, measured along the torso axis from the hip. Metrics are
    // torso multiples, so scaling by `len` keeps this in the caller's units.
    const topD = len * (1 + m.crownAbove);
    const botD = -len * m.baseBelow;
    const total = topD - botD;

    const ax = hipMid.x + ux * topD, ay = hipMid.y + uy * topD;   // crown
    const half = m.halfWidth * len;

    const right = [], left = [];
    for (let i = 0; i < PROFILE.length - 1; i++) {
      const u0 = PROFILE[i][0], u1 = PROFILE[i + 1][0];
      for (let s = 0; s < OUTLINE_SAMPLES; s++) {
        const u = u0 + (u1 - u0) * (s / OUTLINE_SAMPLES);
        const hw = profileAt(u) * half;
        const cx = ax - ux * total * u, cy = ay - uy * total * u;
        right.push({ x: cx + px * hw, y: cy + py * hw });
        left.push({ x: cx - px * hw, y: cy - py * hw });
      }
    }
    // Close at the base explicitly so the two sides meet cleanly.
    const bx = ax - ux * total, by = ay - uy * total;
    right.push({ x: bx, y: by });
    return right.concat(left.reverse());
  }

  /**
   * A tapered stub with round caps and round joints, as a SINGLE closed polygon.
   *
   * The obvious construction — a quad per segment plus a disc at each joint — is
   * wrong here, and visibly so. Every shape this module draws can be translucent
   * (far walls fade in by depth; the fit meter ghosts its target at 22%), and
   * overlapping translucent fills COMPOSITE: 0.22 over 0.22 reads as 0.39. The
   * caps and the quad overlap by definition, so limbs came out as a lumpy
   * chain-of-pearls with bright beads at every joint.
   *
   * One polygon, filled once, cannot accumulate against itself — even where it
   * self-intersects, which it does on the inside of a sharp bend. Nonzero winding
   * fills that region exactly once, so the artifact simply cannot occur.
   */
  const CAP_SEGMENTS = 7;

  /** Arc points of radius r about c, from angle a0 sweeping by `sweep`. */
  function arcPoints(c, r, a0, sweep, n) {
    const out = [];
    for (let i = 1; i < n; i++) {
      const a = a0 + sweep * (i / n);
      out.push({ x: c.x + Math.cos(a) * r, y: c.y + Math.sin(a) * r });
    }
    return out;
  }

  function limbShape(chain, wRoot, wTip) {
    const pts = chain.filter(Boolean);
    if (pts.length < 2) return null;

    /* Taper follows ARC LENGTH, not segment index — otherwise the width jumps at
     * the elbow of a bent limb. */
    const segDir = [], segLen = [];
    let total = 0;
    for (let i = 1; i < pts.length; i++) {
      const dx = pts[i].x - pts[i - 1].x, dy = pts[i].y - pts[i - 1].y;
      const d = Math.hypot(dx, dy);
      if (d < 1e-9) { segDir.push(null); segLen.push(0); continue; }
      segDir.push({ x: dx / d, y: dy / d });
      segLen.push(d);
      total += d;
    }
    if (total < 1e-6) return null;

    const widths = [];
    let run = 0;
    for (let i = 0; i < pts.length; i++) {
      if (i > 0) run += segLen[i - 1];
      widths.push(wRoot + (wTip - wRoot) * (run / total));
    }

    // Normal of a segment: the segment direction rotated +90 degrees.
    const nrm = (d) => (d ? { x: -d.y, y: d.x } : { x: 1, y: 0 });
    const firstDir = segDir.find(Boolean) || { x: 0, y: -1 };
    const lastDir = segDir.slice().reverse().find(Boolean) || firstDir;

    const right = [], left = [];
    for (let i = 0; i < pts.length; i++) {
      const w = widths[i];
      const dIn = i > 0 ? (segDir[i - 1] || firstDir) : null;
      const dOut = i < pts.length - 1 ? (segDir[i] || lastDir) : null;
      const off = (n, sign) => ({ x: pts[i].x + n.x * w * sign, y: pts[i].y + n.y * w * sign });

      if (!dIn) { right.push(off(nrm(dOut), 1)); left.push(off(nrm(dOut), -1)); continue; }
      if (!dOut) { right.push(off(nrm(dIn), 1)); left.push(off(nrm(dIn), -1)); continue; }

      /* Interior joint: round it by walking from the incoming normal to the
       * outgoing one. Done on both sides; the inner side self-intersects and that
       * is fine (see the note above). */
      const nIn = nrm(dIn), nOut = nrm(dOut);
      const aIn = Math.atan2(nIn.y, nIn.x), aOut = Math.atan2(nOut.y, nOut.x);
      let sweep = aOut - aIn;
      while (sweep > Math.PI) sweep -= Math.PI * 2;
      while (sweep < -Math.PI) sweep += Math.PI * 2;
      right.push(off(nIn, 1));
      arcPoints(pts[i], w, aIn, sweep, 4).forEach((q) => right.push(q));
      right.push(off(nOut, 1));
      left.push(off(nIn, -1));
      arcPoints(pts[i], w, aIn + Math.PI, sweep, 4).forEach((q) => left.push(q));
      left.push(off(nOut, -1));
    }

    /* Caps. From the +normal, rotating by -PI passes through the outward segment
     * direction and lands on the -normal, which is exactly a semicircular cap. */
    const tip = pts[pts.length - 1], root = pts[0];
    const nTip = nrm(lastDir), nRoot = nrm(firstDir);
    const tipCap = arcPoints(tip, widths[widths.length - 1],
      Math.atan2(nTip.y, nTip.x), -Math.PI, CAP_SEGMENTS);
    const rootCap = arcPoints(root, widths[0],
      Math.atan2(-nRoot.y, -nRoot.x), -Math.PI, CAP_SEGMENTS);

    return { poly: right.concat(tipCap, left.reverse(), rootCap) };
  }

  /* ===========================================================================
   * DRAW
   * ======================================================================== */

  /**
   * Draw the blob from a set of joints.
   *
   * @param {object} ops      phaserOps(graphics) or canvasOps(ctx2d)
   * @param {object} o
   *   joints      {name: [x,y] | {x,y}} hip-anchored, y down
   *   plot        (x, y) => {x, y} in pixels
   *   bsPx        pixels per joint-space unit — sizes every stroke width
   *   skin        'normal' | 'duck' | explicit {body, light, shade, face}
   *   alpha       0..1
   *   face        draw eyes and mouth (front view only)
   *   silhouette  flat single-colour form, no shading or face (wall cutouts)
   *   color       overrides every colour when silhouette is set
   *   metrics     partial METRICS override (e.g. a squashed duck)
   */
  function drawBlob(ops, o) {
    const joints = o.joints;
    const plot = o.plot;
    const bsPx = o.bsPx === undefined ? 1 : o.bsPx;
    const alpha = o.alpha === undefined ? 1 : o.alpha;
    const m = o.metrics ? Object.assign({}, METRICS, o.metrics) : METRICS;

    const shMid = mid(pt(joints, 'left_shoulder'), pt(joints, 'right_shoulder'));
    const hipMid = mid(pt(joints, 'left_hip'), pt(joints, 'right_hip'));
    if (!shMid || !hipMid) return false;

    /* Torso length in the CALLER's units. Every metric is a multiple of this, so
     * the same numbers describe the character whether the caller works in body
     * scales or in pixels. See the note on METRICS. */
    let len = Math.hypot(shMid.x - hipMid.x, shMid.y - hipMid.y);
    if (!isFinite(len) || len < 1e-3) len = 1;
    const ux = (shMid.x - hipMid.x) / len, uy = (shMid.y - hipMid.y) / len;
    const nx = -uy, ny = ux;                 // torso normal, points to +x when upright
    const px = (v) => v * len * bsPx;        // torso multiple -> pixels

    const skin = typeof o.skin === 'object' && o.skin
      ? o.skin
      : (SKIN[o.skin] || SKIN.normal);
    const solid = o.silhouette ? (o.color === undefined ? skin.body : o.color) : null;
    const cBody = solid === null ? skin.body : solid;
    const cShade = solid === null ? skin.shade : solid;

    const mapAll = (arr) => arr.map((p) => plot(p.x, p.y));

    const rig = torsoRig(shMid, hipMid, len, m);

    /* --- limbs ------------------------------------------------------------
     * Legs, then the body, then the arms ON TOP. The order matters: poses like
     * the clap put the hands in front of the chest, and an arm drawn behind the
     * body would vanish at exactly the moment its position is being judged.
     *
     * Hip-mid, not the hip keypoint, is the leg root — the blob's legs are stubs
     * emerging from one rounded base, not limbs hung off a pelvis. And the KNEE
     * is the visible foot: framing deliberately stops above the ankles, so there
     * is no ankle keypoint to draw to and nothing is lost by ending there. */
    /* Split legs by the same silhouette test as the arms, and for a sharper
     * reason. A raised knee sits at roughly hip height in 2D, which is exactly
     * where the arms hang — so pushed outward far enough to clear the body it
     * merely hid behind an arm instead, and knee_up stayed indistinguishable
     * from standing. Drawn IN FRONT at its true height it reads immediately as a
     * knee lifted across the body, and needs almost no outward nudge at all. */
    const legsBehind = [], legsFront = [];
    for (const [side, sign] of [['left', -1], ['right', 1]]) {
      const tip = rig.legTip(sign, pt(joints, side + '_knee'));
      if (!tip) continue;
      const shape = limbShape([hipMid, tip], m.legRoot * len, m.legTip * len);
      if (!shape) continue;
      const f = rig.toFrame(tip);
      const inside = Math.abs(f.lat) < rig.bodyHalfWidthAt(f.along) * 0.98;
      (inside ? legsFront : legsBehind).push(shape);
    }

    /* A limb is filled body-colour over a slightly wider shade-colour stroke.
     * The reference art separates limb from body with 3D shading, which is not
     * available here; without this seam an arm crossing the chest disappears
     * into it. Skipped for silhouettes, which are one flat colour by definition
     * and where a darker edge would read as a second shape. */
    /* Floored in PIXELS, not scaled purely by body size. A wall first appears at
     * roughly 7px per body scale, where the proportional seam works out under one
     * pixel and vanishes — and the seam is the ONLY thing distinguishing a limb
     * drawn over the torso, which is what "knee up" is. Measured: without the
     * floor, stand_tall and knee_up_right differ by 0.27% of pixels at that size. */
    const seam = Math.max(1.1, px(m.outline));
    /* In a flat silhouette there is no shading to separate a limb from the body,
     * so a limb drawn OVER the torso would be perfectly invisible — and three of
     * the ten poses are defined by exactly such a limb. A dark groove reads as an
     * internal edge on any cutout colour, which is what a stencil needs. */
    const seamColor = o.silhouette ? 0x000000 : cShade;
    const seamAlpha = o.silhouette ? alpha * 0.55 : alpha;
    const paintLimb = (shape, withSeam) => {
      if (!shape) return;
      const poly = mapAll(shape.poly);
      if (withSeam && seam > 0.4) ops.strokePoly(poly, seamColor, seamAlpha, seam * 2);
      ops.poly(poly, cBody, alpha);
    };

    /* Arm draw order, decided per arm rather than fixed.
     *
     * An arm whose hand ends up OUTSIDE the silhouette goes behind the body, so
     * the body hides its root and it reads as a limb emerging from the form. Drawn
     * in front instead, the same arm reads as a separate object lying on top of
     * the character — that was the first version, and a hanging arm looked like
     * the blob was holding two batons.
     *
     * An arm whose hand ends up INSIDE the silhouette has to go in front, or it
     * disappears entirely. That is the clap, and the squat's clasped hands. */
    const armsBehind = [], armsFront = [];
    for (const side of ['left', 'right']) {
      const shoulder = pt(joints, side + '_shoulder');
      if (!shoulder) continue;
      const rootLat = rig.toFrame(shoulder).lat;
      const chain = [
        rig.spreadArm(shoulder, rootLat),
        rig.spreadArm(pt(joints, side + '_elbow'), rootLat),
        rig.spreadArm(pt(joints, side + '_wrist'), rootLat),
      ].filter(Boolean);
      const shape = limbShape(chain, m.armRoot * len, m.armTip * len);
      if (!shape) continue;
      const tip = rig.toFrame(chain[chain.length - 1]);
      const inside = Math.abs(tip.lat) < rig.bodyHalfWidthAt(tip.along) * 0.98;
      (inside ? armsFront : armsBehind).push(shape);
    }

    legsBehind.forEach((l) => paintLimb(l, !o.silhouette));
    armsBehind.forEach((a) => paintLimb(a, !o.silhouette));

    /* --- the body form ---------------------------------------------------- */
    const outlinePx = mapAll(bodyOutline(shMid, hipMid, m));
    ops.poly(outlinePx, cBody, alpha);

    if (o.silhouette) {
      // A rim on the cutout is what makes it legible against the wall panel
      // behind it, which is the entire job of a cutout.
      ops.strokePoly(outlinePx, cBody, alpha, Math.max(1.5, px(0.05)));
    } else {
      /* Two soft patches of shading rather than a gradient: enough to make the
       * form read as round, cheap enough to redraw every frame. Placed along the
       * torso axis so they follow a lean instead of sliding off the body. */
      const along = (d) => plot(hipMid.x + ux * d * len, hipMid.y + uy * d * len);
      const hi = along(1 + m.crownAbove * 0.30);
      ops.ellipse(hi.x - px(0.16), hi.y, px(0.62), px(0.80), skin.light, alpha * 0.34);
      const lo = along(-m.baseBelow * 0.25);
      ops.ellipse(lo.x, lo.y, px(1.16), px(0.52), cShade, alpha * 0.30);
    }

    /* Front limbs always get the seam, in both modes: it is the only thing
     * distinguishing them from the body they are drawn on top of. */
    legsFront.forEach((l) => paintLimb(l, true));
    armsFront.forEach((a) => paintLimb(a, true));

    /* --- face ------------------------------------------------------------- */
    if (o.face && !o.silhouette) {
      /* Anchored on the nose keypoint and laid out along the torso axis, so the
       * face tilts with a side bend instead of staying stubbornly level. */
      const nose = pt(joints, 'nose');
      const base = nose || { x: shMid.x + ux * 0.45 * len, y: shMid.y + uy * 0.45 * len };
      const at = (fwd, side) => plot(
        base.x + ux * fwd * len + nx * side * len,
        base.y + uy * fwd * len + ny * side * len);
      const r = Math.max(0.7, px(m.eyeR));
      [-1, 1].forEach((s) => {
        const e = at(0.10, s * m.eyeSpread);
        ops.ellipse(e.x, e.y, r * 1.6, r * 2.2, skin.face, alpha * 0.9);
      });
      const mo = at(-0.14, 0);
      ops.ellipse(mo.x, mo.y, Math.max(1.4, px(0.17)), Math.max(0.8, px(0.035)),
        skin.face, alpha * 0.75);
    }

    return true;
  }

  /**
   * Bounding box of the drawn form in joint space, so callers can frame it.
   * poseLib.poseBounds() covers the JOINTS; the blob body extends well past
   * them (a crown ~1 unit above the shoulders), and framing to the joints alone
   * crops the head off in the fit meter.
   */
  function blobBounds(joints, metricsOverride) {
    const m = metricsOverride ? Object.assign({}, METRICS, metricsOverride) : METRICS;
    const shMid = mid(pt(joints, 'left_shoulder'), pt(joints, 'right_shoulder'));
    const hipMid = mid(pt(joints, 'left_hip'), pt(joints, 'right_hip'));
    if (!shMid || !hipMid) return null;

    let len = Math.hypot(shMid.x - hipMid.x, shMid.y - hipMid.y);
    if (!isFinite(len) || len < 1e-3) len = 1;

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const eat = (x, y, pad) => {
      minX = Math.min(minX, x - pad); maxX = Math.max(maxX, x + pad);
      minY = Math.min(minY, y - pad); maxY = Math.max(maxY, y + pad);
    };
    /* Bound the DRAWN limb positions, not the raw targets — a raised knee is
     * swung well outside the silhouette, and framing on the target instead would
     * clip it off the edge of the fit meter. */
    const rig = torsoRig(shMid, hipMid, len, m);
    bodyOutline(shMid, hipMid, m).forEach((p) => eat(p.x, p.y, 0));
    [['left_knee', -1], ['right_knee', 1]].forEach(([n, sign]) => {
      const p = rig.legTip(sign, pt(joints, n));
      if (p) eat(p.x, p.y, m.legTip * len);
    });
    ['left', 'right'].forEach((side) => {
      const shoulder = pt(joints, side + '_shoulder');
      if (!shoulder) return;
      const rootLat = rig.toFrame(shoulder).lat;
      [side + '_elbow', side + '_wrist'].forEach((n) => {
        const p = rig.spreadArm(pt(joints, n), rootLat);
        if (p) eat(p.x, p.y, m.armTip * len);
      });
    });
    return {
      minX, minY, maxX, maxY,
      width: maxX - minX, height: maxY - minY,
      cx: (minX + maxX) / 2, cy: (minY + maxY) / 2,
    };
  }

  HP.avatar = {
    SKIN: SKIN,
    METRICS: METRICS,
    phaserOps: phaserOps,
    canvasOps: canvasOps,
    drawBlob: drawBlob,
    blobBounds: blobBounds,
  };
})(window.HP);
