/* =============================================================================
 * Huff&Puff — WALL MODE
 * =============================================================================
 * Auto-scrolling mode. The player does not run in place: the world moves at a
 * speed the level sets, walls with pose-shaped cutouts approach, and the player
 * must be in that shape as each wall passes through them.
 *
 * See docs/DESIGN-wall-mode.md for the reasoning. The two things worth knowing
 * before reading the code:
 *
 * ONE WALL IS ONE POSITION, NOT ONE REP.
 *   A wall can only ever answer "are you in this shape right now?" — it cannot
 *   see movement. So a rep is built from a SEQUENCE of walls: plank, then
 *   bottom, then plank is one push-up. Alternation enforces itself, because you
 *   cannot pass the plank wall from the bottom position. That is why there is no
 *   rep-counting code anywhere in this file.
 *
 * THICKNESS IS TIME UNDER TENSION.
 *   contactDuration = thickness / speed, so a thin wall is a snap into position
 *   and a thick wall is a hold. An isometric — plank, wall sit — is just a very
 *   long wall, needing no special handling.
 *
 * WallSim is deliberately free of pose code, exactly like GameSim. It consumes
 * ONE number, signals.poseError, and derives everything else. That is what keeps
 * ?sim=1 keyboard testing possible.
 * ========================================================================== */

window.HP = window.HP || {};

(function (HP) {
  'use strict';

  const util = HP.util;
  const clamp = util.clamp;

  /* ===========================================================================
   * Level authoring
   * ---------------------------------------------------------------------------
   * `atZ` is the distance travelled at which the wall reaches the player, so
   * spacing between walls is what sets rep tempo. Levels will move to data; this
   * helper exists so the starter level reads as a workout rather than a table of
   * magic numbers.
   * ======================================================================== */
  function buildLevel(spec, cfg) {
    const walls = [];
    let z = spec.startAt === undefined ? 45 : spec.startAt;
    spec.sequence.forEach((entry) => {
      const poseId = typeof entry === 'string' ? entry : entry.pose;
      const gap = (typeof entry === 'object' && entry.gap) || spec.gap || 20;
      const thickness = (typeof entry === 'object' && entry.thickness) ||
        spec.thickness || cfg.defaultThickness;
      walls.push({ poseId: poseId, atZ: z, thickness: thickness });
      z += gap;
    });
    return {
      id: spec.id,
      facing: spec.facing || 'front',
      speed: spec.speed || cfg.speed,
      walls: walls,
    };
  }

  /**
   * The starter level. Alternates so that every demanded pose has to be entered
   * from a different one — squat/stand pairs are squats, knee-up left/right pairs
   * are marching, star/stand pairs are jumping jacks.
   */
  const STARTER_SPEC = {
    id: 'starter',
    gap: 22,
    sequence: [
      // Ease in: two big, unmistakable shapes.
      't_pose', 'stand_tall',
      // Squats.
      'squat_bottom', 'stand_tall', 'squat_bottom', 'stand_tall',
      // Jacks. Thin walls: these are snap-into-position, not holds.
      { pose: 'star', thickness: 2 }, { pose: 'stand_tall', thickness: 2 },
      { pose: 'star', thickness: 2 }, { pose: 'stand_tall', thickness: 2 },
      // Marching.
      'knee_up_left', 'knee_up_right', 'knee_up_left', 'knee_up_right',
      // A held squat — thick wall, so this one is time under tension.
      { pose: 'squat_bottom', thickness: 8 }, 'stand_tall',
      // Reach-and-clap: the upper-body pair. Both are arms-only, so they give
      // the legs a rest without letting the wall spacing drop.
      'reach_up', 'clap', 'reach_up', 'clap',
      // Side bends, alternating, as the cool-down. Held (thick walls) because a
      // stretch that is snapped into and straight back out of is not a stretch.
      { pose: 'side_bend_left', thickness: 7 }, 'stand_tall',
      { pose: 'side_bend_right', thickness: 7 }, 'stand_tall',
    ],
  };

  /* ===========================================================================
   * WallSim
   * ======================================================================== */
  class WallSim extends util.Emitter {
    constructor(config) {
      super();
      this.cfg = config || HP.CONFIG;
      this._wallId = 0;
      this.reset();
    }

    reset(level) {
      const w = this.cfg.wall;
      this.level = level || buildLevel(STARTER_SPEC, w);
      this.status = 'idle';           // idle | running | over | complete
      this.endReason = null;
      this.t = 0;
      this.distance = 0;
      this.speed = this.level.speed;

      this.health = w.startingHealth;
      this.score = 0;
      this.combo = 1;
      this.passed = 0;
      this.missed = 0;
      this.transitions = 0;           // pose changes between passed walls
      this._lastPassedPose = null;

      this.walls = [];
      this.nextWallIndex = 0;
      this.invulnUntil = 0;

      /* The ONLY crossing point from pose code, mirroring GameSim.signals.
       * poseError is the worst-joint distance to the ACTIVE wall's pose, in
       * body-scale units; Infinity means "cannot tell", never "far away". */
      this.signals = {
        poseError: Infinity,
        tracked: false,
        // Read by the shared renderer for its speed streaks; wall mode has no
        // pace, so it stays at zero.
        paceRatio: 0,
        cadence: 0,
      };

      /* --- renderer compatibility ------------------------------------------
       * RunScene's drawing helpers are reused wholesale (sky, road, runner, fx)
       * rather than duplicated, so WallSim exposes the handful of fields those
       * helpers read. These are NOT wall-mode mechanics — they are here so one
       * renderer serves both modes. */
      this.lane = 1;
      this.targetLane = 1;
      this.jumpHeight = 0;
      this.airborne = false;
      this.ducking = false;
      this.obstacles = [];
      this.gap = 9999;                // no void in this mode
      this.grace = 1;
    }

    start() {
      this.status = 'running';
      this.emit('start', {});
    }

    /** Red vignette intensity: rises as health falls. */
    dangerLevel() {
      const max = this.cfg.wall.startingHealth;
      return clamp(1 - this.health / max, 0, 1);
    }

    toleranceFor(poseId) {
      const pose = HP.POSES[poseId];
      return (pose && pose.tolerance) || this.cfg.wall.defaultTolerance;
    }

    /** The wall the player should currently be reacting to, or null. */
    activeWall() {
      for (let i = 0; i < this.walls.length; i++) {
        const w = this.walls[i];
        if (w.state === 'armed' || w.state === 'contact') return w;
      }
      return null;
    }

    /**
     * 0..1 how close the player is to the active wall's pose, for the fit meter.
     * Mapped over 0..(tolerance x fitRangeMultiple) so the MATCH threshold lands
     * at a fixed fraction of the bar and can be marked, exactly like the pace
     * meter's target line.
     */
    fit() {
      const w = this.activeWall();
      if (!w) return 0;
      const err = this.signals.poseError;
      if (!isFinite(err)) return 0;
      const range = this.fitRangeFor(w.poseId);
      return clamp(1 - err / range, 0, 1);
    }

    fitRangeFor(poseId) {
      return this.toleranceFor(poseId) * this.cfg.wall.fitRangeMultiple;
    }

    /** Where on the fit bar the match threshold sits, 0..1. */
    fitThreshold() {
      return 1 - 1 / this.cfg.wall.fitRangeMultiple;
    }

    matched() {
      const w = this.activeWall();
      if (!w) return false;
      return this.signals.poseError < this.toleranceFor(w.poseId);
    }

    update(dtRaw) {
      if (this.status !== 'running') return;
      const cfg = this.cfg.wall;
      const dt = clamp(dtRaw, 0, this.cfg.game.maxTimestep);
      if (dt <= 0) return;

      this.t += dt;
      this.distance += this.speed * dt;

      /* --- spawn ---------------------------------------------------------- */
      while (
        this.nextWallIndex < this.level.walls.length &&
        this.level.walls[this.nextWallIndex].atZ - this.distance <= cfg.spawnZ
      ) {
        const spec = this.level.walls[this.nextWallIndex++];
        const contactDuration = spec.thickness / this.speed;
        this.walls.push({
          id: ++this._wallId,
          poseId: spec.poseId,
          atZ: spec.atZ,
          thickness: spec.thickness,
          z: spec.atZ - this.distance,
          state: 'approach',
          held: 0,
          contactDuration: contactDuration,
          required: contactDuration * cfg.minHeldFraction,
          result: null,
        });
        this.emit('wallSpawn', { poseId: spec.poseId });
      }

      /* --- advance + resolve ---------------------------------------------- */
      const armZ = this.speed * cfg.armSeconds;
      for (let i = this.walls.length - 1; i >= 0; i--) {
        const w = this.walls[i];
        w.z = w.atZ - this.distance;
        const halfT = w.thickness / 2;

        if (w.state !== 'done') {
          if (w.z > armZ) {
            w.state = 'approach';
          } else if (w.z > halfT) {
            if (w.state !== 'armed') {
              w.state = 'armed';
              this.emit('wallArmed', { wall: w, poseId: w.poseId });
            }
          } else if (w.z >= -halfT) {
            if (w.state !== 'contact') {
              w.state = 'contact';
              this.emit('wallContact', { wall: w });
            }
            // Accumulated hold, not an instant check.
            if (this.signals.poseError < this.toleranceFor(w.poseId)) w.held += dt;
          } else {
            this._resolve(w);
          }
        }

        if (w.z < cfg.despawnZ) this.walls.splice(i, 1);
      }

      /* --- level complete -------------------------------------------------- */
      if (
        this.nextWallIndex >= this.level.walls.length &&
        this.walls.length === 0 &&
        this.status === 'running'
      ) {
        this.status = 'complete';
        this.endReason = 'complete';
        this.emit('complete', this.summary());
      }
    }

    _resolve(w) {
      const cfg = this.cfg.wall;
      w.state = 'done';
      const pass = w.held >= w.required;
      w.result = pass ? 'pass' : 'miss';

      if (pass) {
        this.passed++;
        this.score += cfg.scorePerWall * this.combo;
        this.combo = Math.min(this.combo + 1, cfg.comboMax);
        // A rep is a change of position between passed walls, which is why
        // nothing here counts reps directly.
        if (this._lastPassedPose && this._lastPassedPose !== w.poseId) {
          this.transitions++;
        }
        this._lastPassedPose = w.poseId;
        this.emit('wallPassed', { wall: w, combo: this.combo, score: this.score });
      } else {
        this.missed++;
        this.combo = 1;
        if (this.t >= this.invulnUntil) {
          this.health--;
          this.invulnUntil = this.t + cfg.missInvulnSeconds;
        }
        this.emit('wallMissed', { wall: w, health: this.health });
        if (this.health <= 0) {
          this.status = 'over';
          this.endReason = 'crushed';
          this.emit('gameover', this.summary());
        }
      }
    }

    /** Two positions make one rep, so reps are transitions halved. */
    reps() {
      return Math.floor(this.transitions / 2);
    }

    summary() {
      return {
        reason: this.endReason,
        score: this.score,
        seconds: this.t,
        distance: Math.floor(this.distance),
        passed: this.passed,
        missed: this.missed,
        reps: this.reps(),
        health: this.health,
        total: this.level.walls.length,
      };
    }
  }

  /* ===========================================================================
   * Drawing a pose as a stick figure
   * ---------------------------------------------------------------------------
   * Used for both the wall cutout and the fit meter, so a shape looks identical
   * wherever the player sees it. `plot` maps body-scale units to pixels.
   * ======================================================================== */
  /**
   * The cutout in the wall: the character's own silhouette in the pose you have
   * to hit.
   *
   * This was a stick figure, and a stick figure is the wrong shape for the job —
   * a wall is first visible at the far end of the road, where a limb two pixels
   * wide is a single pixel column and the pose is unreadable until far too late.
   * A blob silhouette has AREA, so it survives being small, and it is the same
   * character the player is looking at on the road.
   *
   * `inflate` widens every proportion for the outer glow pass, so the two passes
   * are the same shape rather than a shape plus a halo that does not match it.
   */
  function drawPoseFigure(g, pose, plot, bsPx, opts) {
    const o = opts || {};
    const inflate = o.inflate || 0;
    const metrics = inflate
      ? {
          halfWidth: HP.avatar.METRICS.halfWidth + inflate,
          crownAbove: HP.avatar.METRICS.crownAbove + inflate,
          baseBelow: HP.avatar.METRICS.baseBelow + inflate,
          armRoot: HP.avatar.METRICS.armRoot + inflate,
          armTip: HP.avatar.METRICS.armTip + inflate,
          legRoot: HP.avatar.METRICS.legRoot + inflate,
          legTip: HP.avatar.METRICS.legTip + inflate,
        }
      : null;
    HP.avatar.drawBlob(HP.avatar.phaserOps(g), {
      joints: pose.target,
      plot: plot,
      bsPx: bsPx,
      silhouette: true,
      color: o.color,
      alpha: o.alpha === undefined ? 1 : o.alpha,
      metrics: metrics,
    });
  }

  /* ===========================================================================
   * WallScene — extends RunScene so the sky, road, runner and fx are shared
   * rather than duplicated. Only the walls are new.
   * ======================================================================== */
  const WALL_COLORS = {
    frame: 0x8fe9ff,
    glass: 0xbdf3ff,      // lit glass sheet; see the holographic gate reference
    hole: 0x03040a,       // the void through the panel — darker than the sky
    panel: 0x123048,
    far: 0x6d7f9a,        // too far away to be judged yet
    miss: 0xff2b57,
    close: 0xffc23d,
    match: 0x3fffb4,
    passed: 0x3fffb4,
    failed: 0xff2b57,
  };

  class WallScene extends HP.RunScene {
    create() {
      super.create();
      /* Explicit depths: walls must sit behind the runner, and RunScene's layers
       * are otherwise ordered purely by creation. */
      this.gSky.setDepth(0);
      this.gRoad.setDepth(1);
      this.gWalls = this.add.graphics().setDepth(2);
      this.gObstacles.setDepth(3);
      this.gPlayer.setDepth(4);
      this.gVoid.setDepth(5);
      this.gFx.setDepth(6);

      this.sim.on('wallPassed', () => { this.flash = 0.35; });
      this.sim.on('wallMissed', () => { this.shake = 1; this.flash = 1; });
    }

    update(time, delta) {
      /* Own clock, for the same reason RunScene does: Phaser's delta is smoothed
       * toward the target frame rate and understates real elapsed time on any
       * device below 60fps. Wall timing is the entire mechanic here. */
      const now = util.now();
      const dt = this._lastUpdateT === null
        ? 0
        : clamp(now - this._lastUpdateT, 0, this.cfg.game.maxTimestep);
      this._lastUpdateT = now;
      if (dt <= 0) return;

      this.sim.update(dt);

      // The runner is auto-jogging, so keep the legs moving at a steady rate.
      this.runPhase += this.getCadence() * Math.PI * dt;
      this.shake = Math.max(0, this.shake - dt * 3.2);
      this.flash = Math.max(0, this.flash - dt * 2.6);
      this.voidWobble += dt * 2;

      const shakeX = this.shake ? (Math.random() * 2 - 1) * 10 * this.shake : 0;
      const shakeY = this.shake ? (Math.random() * 2 - 1) * 7 * this.shake : 0;
      this.cameras.main.setScroll(shakeX, shakeY);

      this._drawSky(time);
      this._drawRoad();
      this._drawWalls();
      this._drawPlayer();
      this._drawFx();
    }

    /** One body-scale unit in pixels, at depth scale s.
     *
     *  Delegated to RunScene._torsoPx() rather than hardcoded, because a cutout
     *  has to be the same size as the character being steered into it. It was
     *  hardcoded, and when the avatar was resized the two drifted 1.55x apart
     *  while the comment here still claimed they matched. */
    _bsPx(s) {
      return this._torsoPx() * s;
    }

    _drawWalls() {
      const g = this.gWalls;
      const sim = this.sim;
      g.clear();

      // Far to near, so nearer walls paint over farther ones.
      const list = sim.walls.slice().sort((a, b) => b.z - a.z);

      for (let i = 0; i < list.length; i++) {
        const w = list[i];
        if (w.z < -6 || w.z > 120) continue;
        const pose = HP.POSES[w.poseId];
        if (!pose) continue;

        const s = this._scaleAt(w.z);
        const yBase = this._yAt(w.z);
        const bsPx = this._bsPx(s);
        const alpha = clamp(s * 3.2, 0.12, 1);

        /* --- the panel ----------------------------------------------------
         * Modelled on resources/Holographic_wall_gates_*.jpeg: a sheet of lit
         * glass with a rounded top and a hot neon rim, not the wireframe box
         * this used to draw. Three passes — bloom, glass, rim — because the
         * bloom is what makes it read as emitting light rather than as a
         * translucent rectangle. */
        const halfW = this.roadHalfW * s * 1.06;
        const height = this.cfg.wall.wallHeightBs * bsPx;
        const top = yBase - height;
        const radius = Math.min(halfW * 0.55, height * 0.30);
        const rimW = Math.max(1.5, 3.4 * s);

        // Outer bloom: a few concentric soft strokes. Phaser has no blur, and
        // stacking translucent strokes is a cheap, stable stand-in.
        for (let b = 3; b >= 1; b--) {
          g.lineStyle(rimW + b * Math.max(2, 7 * s), WALL_COLORS.frame,
            alpha * 0.05 * b);
          g.strokeRoundedRect(this.cx - halfW, top, halfW * 2, height, radius);
        }
        g.fillStyle(WALL_COLORS.glass, alpha * 0.17);
        g.fillRoundedRect(this.cx - halfW, top, halfW * 2, height, radius);
        g.lineStyle(rimW, WALL_COLORS.frame, alpha * 0.95);
        g.strokeRoundedRect(this.cx - halfW, top, halfW * 2, height, radius);
        // Bright sill, so the gate reads as standing on the road.
        g.fillStyle(WALL_COLORS.frame, alpha * 0.55);
        g.fillRect(this.cx - halfW, yBase - rimW, halfW * 2, rimW);

        /* --- the cutout --------------------------------------------------- */
        // Hip line placed so the knees (target y ~ +1.0) land near the ground.
        const hipY = yBase - 1.18 * bsPx;
        const plot = (bx, by) => ({ x: this.cx + bx * bsPx, y: hipY + by * bsPx });

        let color = WALL_COLORS.far;
        if (w.state === 'done') {
          color = w.result === 'pass' ? WALL_COLORS.passed : WALL_COLORS.failed;
        } else if (w.state === 'armed' || w.state === 'contact') {
          const err = sim.signals.poseError;
          const tol = sim.toleranceFor(w.poseId);
          if (!isFinite(err)) color = WALL_COLORS.miss;
          else if (err < tol) color = WALL_COLORS.match;
          else if (err < tol * 2) color = WALL_COLORS.close;
          else color = WALL_COLORS.miss;
        }

        /* The cutout is a HOLE, per the reference: a void through the panel with
         * a glowing edge, rather than a coloured sticker on it. That inverts
         * where the fit feedback lives — the RIM now carries the grey/amber/green
         * signal, which is why it is stroked in `color` while the fill stays
         * dark. It also fixes a compositing problem for free: the void is opaque,
         * so the body and limb shapes can no longer stack alpha against each
         * other on a part-faded distant wall. */
        drawPoseFigure(g, pose, plot, bsPx, {
          /* This inflated pass is the fit signal's main carrier now that the
           * cutout itself is a dark void: it reads as coloured light spilling
           * out around the hole. The thin rim alone is too little colour to
           * judge at a glance. */
          color: color, alpha: alpha * 0.34, inflate: 0.13,
        });
        drawPoseFigure(g, pose, plot, bsPx, {
          color: WALL_COLORS.hole,
          rimColor: color,
          /* Deliberately thin. An arm is ~0.25 torsos across, so a rim of half
           * that on each side leaves no void between them and a near gate's
           * arms-out cutout collapses into a solid bar. */
          rimWidth: Math.max(1.0, 1.7 * s),
          alpha: 1,
        });

        /* --- hold progress, drawn on the wall while passing through -------- */
        if (w.state === 'contact' && w.required > 0) {
          const frac = clamp(w.held / w.required, 0, 1);
          const barW = halfW * 1.6;
          const barY = top - 8 * s - 4;
          g.fillStyle(0x000000, alpha * 0.5);
          g.fillRect(this.cx - barW / 2, barY, barW, Math.max(3, 7 * s));
          g.fillStyle(WALL_COLORS.match, alpha);
          g.fillRect(this.cx - barW / 2, barY, barW * frac, Math.max(3, 7 * s));
        }
      }
    }
  }

  HP.WallSim = WallSim;
  HP.WallScene = WallScene;
  HP.buildLevel = buildLevel;
  HP.WALL_STARTER_SPEC = STARTER_SPEC;
  HP.drawPoseFigure = drawPoseFigure;
})(window.HP);
