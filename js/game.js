/* =============================================================================
 * Huff&Puff — GAME SIMULATION + RENDERER
 * =============================================================================
 * Two things live here, deliberately separated:
 *
 *   HP.GameSim   Pure simulation. No Phaser, no DOM, no pose code. It reads a
 *                plain `signals` object (paceRatio / laneIntent / ducking /
 *                tracked) that main.js refreshes from the tracker, and emits
 *                gameplay events. This is what makes the game testable with a
 *                keyboard (?sim=1) and what keeps the tuning honest.
 *
 *   HP.RunScene  A Phaser scene that draws the sim's state. Everything is drawn
 *                with Graphics primitives — no image assets, nothing to 404.
 *
 * THE CORE LOOP
 *   Your running pace sets your speed. A consuming void chases you at a speed
 *   that ramps with session time. Hold your own comfortable pace and you're fine
 *   early; as the void speeds up you have to dig in. Obstacles don't kill you —
 *   they cost you gap, which is the same currency the void spends. So a hit
 *   means "run harder now", not "game over".
 * ========================================================================== */

window.HP = window.HP || {};

(function (HP) {
  'use strict';

  const util = HP.util;
  const clamp = util.clamp;

  /* ===========================================================================
   * GameSim
   * ======================================================================== */
  class GameSim extends util.Emitter {
    constructor(config) {
      super();
      this.cfg = config || HP.CONFIG;
      this._obstacleId = 0;
      this.reset();
    }

    reset() {
      const g = this.cfg.game;
      this.status = 'idle';          // idle | running | over
      this.endReason = null;
      this.t = 0;                    // session seconds
      this.distance = 0;             // world metres travelled
      this.speed = 0;                // world m/s
      this.wallSpeed = 0;
      this.gap = g.gapStart;
      this.grace = g.graceSeconds;
      this.trackingLostFor = 0;
      this.frozen = false;

      this.lane = 1;                 // float position, 0=left 1=centre 2=right
      this.targetLane = 1;
      this.airborne = false;
      this.jumpT = 0;
      this.jumpHeight = 0;           // 0..1 fraction of screen height
      this.ducking = false;

      this.shields = g.startingShields;
      this.hitPenaltyUntil = 0;
      this.invulnUntil = 0;
      this.obstacles = [];
      this.nextObstacleAt = g.obstacleIntervalM * 0.75;
      this.nextMilestoneAt = g.milestoneDistanceM;
      this.hits = 0;
      this.dodged = 0;
      this.peakSpeed = 0;
      this.paceRatioSum = 0;
      this.paceRatioSamples = 0;

      this._jumpQueued = false;
      this._prevTargetLane = 1;

      // Refreshed every pose frame by main.js (or by keyboard in sim mode).
      this.signals = {
        paceRatio: 0,
        running: false,
        tracked: false,
        laneIntent: 0,
        ducking: false,
        cadence: 0,
      };
    }

    start() {
      this.status = 'running';
      this.emit('start', {});
    }

    /** Discrete jump event — consumed by the next update(). */
    queueJump() {
      this._jumpQueued = true;
    }

    /* --- the pace → speed curve ------------------------------------------
     * Below your comfortable pace, speed falls off FASTER than linear, so
     * slacking is felt immediately. Above it, speed saturates: sprinting buys
     * you buffer, but max effort is never required simply to survive. That
     * asymmetry is what stops the game becoming an all-out sprint test. */
    speedNormFor(paceRatio) {
      const p = this.cfg.pace;
      if (paceRatio <= 0) return 0;
      if (paceRatio < 1) return Math.pow(paceRatio, p.belowTargetExponent);
      return 1 + p.overdriveMax * (1 - Math.exp(-(paceRatio - 1) / p.overdriveK));
    }

    /** Void speed at a given session time. */
    wallSpeedAt(t) {
      const g = this.cfg.game;
      const base = g.speedAtTargetPace * g.wallBaseSpeedFactor;
      const ramp = g.wallRampPerMinute * (t / 60);
      return Math.min(base + ramp, g.speedAtTargetPace * g.wallMaxSpeedFactor);
    }

    update(dtRaw) {
      if (this.status !== 'running') return;
      const g = this.cfg.game;
      const s = this.signals;
      // A backgrounded tab returns one enormous delta; without this clamp the
      // void would teleport into the player on resume.
      const dt = clamp(dtRaw, 0, g.maxTimestep);
      if (dt <= 0) return;

      this.t += dt;

      /* --- tracking loss grace ------------------------------------------- */
      if (!s.tracked) {
        this.trackingLostFor += dt;
      } else if (this.trackingLostFor > 0) {
        this.trackingLostFor = 0;
        this.emit('trackingRestored', {});
      }
      const wasFrozen = this.frozen;
      this.frozen = this.trackingLostFor > 0 &&
        this.trackingLostFor <= g.trackingLossGraceSeconds;
      if (this.frozen && !wasFrozen) this.emit('trackingLost', {});

      /* --- speed --------------------------------------------------------- */
      const speedNorm = this.speedNormFor(s.paceRatio);
      let target = g.speedAtTargetPace * speedNorm;
      if (this.t < this.hitPenaltyUntil) target *= g.hitSpeedMultiplier;
      this.speed = util.approach(this.speed, target, g.speedLerpPerSec, dt);
      this.distance += this.speed * dt;
      this.peakSpeed = Math.max(this.peakSpeed, this.speed);
      if (s.paceRatio > 0) {
        this.paceRatioSum += s.paceRatio;
        this.paceRatioSamples++;
      }

      /* --- the void ------------------------------------------------------ */
      this.wallSpeed = this.wallSpeedAt(this.t);
      if (!this.frozen) {
        this.gap = clamp(this.gap + (this.speed - this.wallSpeed) * dt, 0, g.gapMax);

        if (this.gap <= 0) {
          this.grace -= dt;
          if (this.grace <= 0) {
            this._gameOver('caught');
            return;
          }
        } else {
          this.grace = Math.min(g.graceSeconds, this.grace + g.graceRecoverPerSec * dt);
        }
      }

      /* --- lane movement ------------------------------------------------- */
      this.targetLane = clamp(1 + (s.laneIntent | 0), 0, g.laneCount - 1);
      if (this.targetLane !== this._prevTargetLane) {
        this._prevTargetLane = this.targetLane;
        this.emit('laneChange', { lane: this.targetLane });
      }
      const step = g.laneSwitchPerSec * dt;
      if (Math.abs(this.targetLane - this.lane) <= step) this.lane = this.targetLane;
      else this.lane += Math.sign(this.targetLane - this.lane) * step;

      /* --- jump / duck --------------------------------------------------- */
      if (this._jumpQueued) {
        this._jumpQueued = false;
        if (!this.airborne) {
          this.airborne = true;
          this.jumpT = 0;
          this.emit('jump', {});
        }
      }
      if (this.airborne) {
        this.jumpT += dt;
        // A sine arc: zero at takeoff and landing, peak in the middle. Reads
        // better than a true parabola at these short airtimes.
        const k = clamp(this.jumpT / g.jumpAirtime, 0, 1);
        this.jumpHeight = g.jumpPeak * Math.sin(Math.PI * k);
        if (this.jumpT >= g.jumpAirtime) {
          this.airborne = false;
          this.jumpHeight = 0;
          this.emit('land', {});
        }
      } else {
        this.jumpHeight = 0;
      }
      // You can't duck mid-air; the jump wins.
      this.ducking = !!s.ducking && !this.airborne;

      /* --- obstacles ----------------------------------------------------- */
      this._updateObstacles(dt);

      /* --- milestones ---------------------------------------------------- */
      if (this.distance >= this.nextMilestoneAt) {
        this.nextMilestoneAt += g.milestoneDistanceM;
        const before = this.shields;
        this.shields = Math.min(g.startingShields, this.shields + 1);
        this.gap = clamp(this.gap + g.milestoneGapBonus, 0, g.gapMax);
        this.emit('milestone', {
          distance: Math.floor(this.distance),
          shieldRegained: this.shields > before,
        });
      }
    }

    _updateObstacles(dt) {
      const g = this.cfg.game;

      /* Spawn on distance travelled, not on time: a faster player meets
       * obstacles at the same spacing, so pushing hard is never punished with a
       * denser obstacle field. */
      if (this.distance >= this.nextObstacleAt) {
        this._spawnObstacle();
        const jitter = (Math.random() * 2 - 1) * g.obstacleIntervalJitterM;
        this.nextObstacleAt = this.distance + Math.max(20, g.obstacleIntervalM + jitter);
      }

      for (let i = this.obstacles.length - 1; i >= 0; i--) {
        const o = this.obstacles[i];
        o.z -= this.speed * dt;

        if (!o.warned && o.z <= g.obstacleWarnZ) {
          o.warned = true;
          this.emit('obstacleWarn', { kind: o.kind, lane: o.lane });
        }

        // The collision plane is the player's own z. Test on the frame the
        // obstacle crosses it.
        if (!o.resolved && o.z <= 0) {
          o.resolved = true;
          if (this._collides(o)) this._applyHit(o);
          else {
            this.dodged++;
            this.emit('dodge', { kind: o.kind });
          }
        }

        if (o.z < g.obstacleDespawnZ) this.obstacles.splice(i, 1);
      }
    }

    _spawnObstacle() {
      const g = this.cfg.game;
      const kind = util.weightedPick(g.obstacleWeights);
      let lane = -1;
      if (kind === 'lane') {
        // Bias TOWARD the lane the player is currently heading for, so most
        // barriers demand a real lane change instead of being free. The
        // remaining 40% is uniformly random, so it never becomes predictable
        // enough to game by hugging one side.
        lane = Math.random() < 0.6
          ? this.targetLane
          : Math.floor(Math.random() * g.laneCount);
      }
      this.obstacles.push({
        id: ++this._obstacleId,
        kind: kind,
        lane: lane,
        z: g.obstacleSpawnZ,
        warned: false,
        resolved: false,
      });
    }

    /**
     * kind 'lane' — a barrier filling one lane: dodge sideways
     * kind 'low'  — a hurdle across the road:  jump
     * kind 'high' — a beam across the road:    duck
     */
    _collides(o) {
      const g = this.cfg.game;
      if (o.kind === 'lane') {
        return Math.abs(this.lane - o.lane) < g.laneHitTolerance;
      }
      if (o.kind === 'low') return !this.airborne;
      if (o.kind === 'high') return !this.ducking;
      return false;
    }

    _applyHit(o) {
      const g = this.cfg.game;
      if (this.t < this.invulnUntil) return;
      this.invulnUntil = this.t + g.hitInvulnSeconds;
      this.hits++;

      const hadShield = this.shields > 0;
      if (hadShield) this.shields--;
      // A hit never ends the run directly — it hands metres to the void and
      // trips the player up. The pressure is real but recoverable.
      const loss = hadShield ? g.hitGapLoss : g.hitGapLossNoShield;
      this.gap = Math.max(0, this.gap - loss);
      this.hitPenaltyUntil = this.t + g.hitSpeedPenaltySeconds;

      this.emit('hit', {
        kind: o.kind,
        hadShield: hadShield,
        shields: this.shields,
        gap: this.gap,
      });
    }

    /** End the run from outside — the HUD's END button. */
    end(reason) {
      if (this.status === 'running') this._gameOver(reason || 'quit');
    }

    _gameOver(reason) {
      this.status = 'over';
      this.endReason = reason;
      this.emit('gameover', this.summary());
    }

    summary() {
      return {
        reason: this.endReason,
        distance: Math.floor(this.distance),
        seconds: this.t,
        hits: this.hits,
        dodged: this.dodged,
        shields: this.shields,
        peakSpeed: this.peakSpeed,
        avgPaceRatio: this.paceRatioSamples
          ? this.paceRatioSum / this.paceRatioSamples
          : 0,
      };
    }

    /* Convenience readouts for the HUD. */
    gapFraction() {
      return clamp(this.gap / this.cfg.game.gapVisibleMax, 0, 1);
    }

    dangerLevel() {
      const g = this.cfg.game;
      if (this.gap <= 0) return 1;
      if (this.gap >= g.gapWarn) return 0;
      return clamp(1 - this.gap / g.gapWarn, 0, 1);
    }
  }

  /* ===========================================================================
   * RunScene — Phaser renderer
   * ---------------------------------------------------------------------------
   * A flat pseudo-3D projection: a point `z` metres ahead is drawn at
   *   s = zRef / (zRef + z)        s = 1 at the player, → 0 at the horizon
   *   y = horizon + (ground - horizon) * s
   *   x = centre + laneOffset * laneWidth * s
   * That single scale factor also sizes obstacles, so everything shrinks
   * consistently into the distance. Cheap, stable, and no 3D maths to debug.
   * ======================================================================== */
  const PROJ_ZREF = 26;

  /* The run rig builds its joints straight in pixels, so the avatar module needs
   * no coordinate transform at all. Hoisted rather than rebuilt per frame. */
  const IDENTITY_PLOT = (x, y) => ({ x: x, y: y });

  /* Crouching shortens the torso, and every avatar proportion is a multiple of
   * torso length — so left alone a duck would shrink the whole character instead
   * of squashing it. Widening the multiples holds the mass roughly constant. */
  /* Ducking shortens the torso, and every avatar proportion is a multiple of
   * torso length — so left alone a crouch would shrink the character in BOTH
   * dimensions and read as "moved further away" rather than "got lower". These
   * multiples are scaled by 30/18 (the normal/ducked torso ratio) to hold the
   * silhouette's width constant while its height collapses. */
  const DUCK_METRICS = {
    crownAbove: 1.15, baseBelow: 0.75, halfWidth: 1.55,
    legOut: 0, legLength: 0.92,
  };

  /* The avatar module swings a raised knee outward and shortens legs into stubs,
   * because a pose CUTOUT has to be readable as a still silhouette. The runner
   * needs neither: its stride is already animated by the rig below, and applying
   * the exaggeration on top dragged the lifted foot across the belly instead of
   * up behind the body, which is the one cue that makes a back view read as
   * running. */
  const RUN_METRICS = { legOut: 0, legLength: 0.92 };

  /* Avatar sizing, named because WallScene has to size its cutouts to match the
   * runner — a cutout that is not the same size as the character you are steering
   * is a cutout you cannot judge yourself against. Kept here as the single source
   * of truth rather than copied into wall-mode.js, which is how the two silently
   * drifted apart by 1.55x the first time. */
  /* Avatar sizing.
   *
   * Keyed to screen HEIGHT first, with a road-width cap. Height-first is what the
   * reference framing needs: the character should read at about a third of the
   * screen, and that is a statement about height, not about lane width. Keying it
   * to laneW alone (as it was) made the avatar balloon to half the screen in
   * landscape, because laneW is bounded by width there.
   *
   * The cap stops the character growing wider than the road it stands on when the
   * viewport is very tall and narrow. */
  /* Derived from the reference mockup by proportion rather than guessed: there the
   * character's WIDTH is about 38% of the road's width, which is the measurement
   * that matters — it is what decides whether the player can still see the lanes
   * and the gate they are steering into. The blob is 1.9 torsos wide, so
   * 1.9 * 30 * scale = 0.38 * 2 * roadHalfW  =>  scale = roadHalfW / 75.
   *
   * The height term is a cap for landscape, where roadHalfW is generous and the
   * screen is short. Sizing by width alone put the avatar at 43% of the frame
   * width and it occluded the road it was running on. */
  const AVATAR_ROAD_DIV = 75;      // roadHalfW / this = unit scale
  const AVATAR_HEIGHT_CAP = 330;   // H / this caps it on short viewports
  const AVATAR_TORSO = 30;         // torso length in those units

  /* Phaser needs 0xRRGGBB numbers, so these are derived from HP.PALETTE rather
   * than written out again. One palette, three consumers — see js/palette.js. */
  const P = HP.PALETTE;
  const N = HP.paletteNum;
  const COLORS = {
    player: N(P.blobBody),
    playerDuck: N(P.blobDuckBody),
    playerSole: 0xfdfbf4,
    obstacleLane: N(P.obstacleLane),
    obstacleLow: N(P.obstacleLow),
    obstacleHigh: N(P.obstacleHigh),
    voidCore: N(P.voidCore),
    voidEdge: N(P.voidEdge),
    voidGlow: N(P.voidGlow),
    ink: N(P.ink),
  };

  class RunScene extends Phaser.Scene {
    constructor(deps) {
      super({ key: 'RunScene' });
      this.sim = deps.sim;
      this.getCadence = deps.getCadence || (() => 0);
      this.cfg = deps.config || HP.CONFIG;
      this.onStep = deps.onStep || null;
      /* The world behind this scene (js/course.js). Optional so the scene can be
       * constructed headlessly in tests without a canvas. */
      this.course = deps.course || null;

      this.runPhase = 0;   // leg-swing phase, advanced by live cadence
      this.shake = 0;      // screen shake impulse, decays
      this.flash = 0;      // white/red flash on hit
      this.voidWobble = 0;
      // Real-clock timestamp of the previous update — see the note in update().
      this._lastUpdateT = null;
    }

    create() {
      /* Kept so the layer order below is unchanged, but nothing draws to it any
       * more: sky and ground moved to the course canvas underneath. */
      this.gSky = this.add.graphics();
      this.gRoad = this.add.graphics();
      this.gObstacles = this.add.graphics();
      this.gPlayer = this.add.graphics();
      this.gVoid = this.add.graphics();
      this.gFx = this.add.graphics();

      // Star field for depth — fixed positions, twinkle only.
      this.stars = [];
      for (let i = 0; i < 70; i++) {
        this.stars.push({
          x: Math.random(),
          y: Math.random() * 0.55,
          r: 0.4 + Math.random() * 1.3,
          tw: Math.random() * Math.PI * 2,
        });
      }

      this.sim.on('hit', () => { this.shake = 1; this.flash = 1; });
      this.sim.on('milestone', () => { this.flash = 0.45; });
      this.scale.on('resize', () => this._layout());
      this._layout();
    }

    _layout() {
      const w = this.scale.gameSize.width;
      const h = this.scale.gameSize.height;
      this.W = w;
      this.H = h;
      this.cx = w / 2;
      /* A landscape phone has plenty of width and very little height, and it is
       * HEIGHT that becomes perspective depth. So push the horizon up and the
       * player down when the viewport is wide, to buy back some road. Portrait
       * — the orientation this game is actually played in — is unaffected. */
      const wide = w / h > 1.3;
      this.horizonY = h * (wide ? 0.30 : 0.34);
      this.groundY = h * (wide ? 0.84 : 0.78);   // where the player stands (z = 0)

      /* The road's width is bounded by the perspective DEPTH as well as by the
       * viewport width. laneW sizes the avatar and every obstacle, so keying it
       * to width alone makes both grotesquely large in landscape, where there is
       * lots of width and very little depth to draw into. */
      const depth = this.groundY - this.horizonY;
      /* Narrower than before: the reference framing gives the road about two
       * thirds of the screen and spends the outer thirds on the street. */
      this.roadHalfW = Math.min(w * 0.36, depth * 0.62);
      this.laneW = this.roadHalfW / 1.5; // 3 lanes => lane centres at -1, 0, 1
    }

    /** The avatar's unit scale. Shared with the cutouts so a gate is the same
     *  size as the character being steered into it. */
    _avatarScale() {
      return Math.min(this.roadHalfW / AVATAR_ROAD_DIV, this.H / AVATAR_HEIGHT_CAP);
    }

    /** Torso length in pixels at the player's own depth. One body-scale unit. */
    _torsoPx() {
      return AVATAR_TORSO * this._avatarScale();
    }

    /**
     * The avatar's real drawn height in pixels, crown to foot.
     *
     * Exists so tests measure the character rather than re-deriving it: the
     * responsive suite carried its own hardcoded formula from when the avatar was
     * a jointed humanoid, and went on reporting that figure for a blob whose
     * proportions are completely different. A renderer that can be asked its own
     * size cannot drift from the thing checking it.
     */
    _avatarHeightPx() {
      const m = HP.avatar.METRICS;
      const torso = this._torsoPx();
      const scale = this._avatarScale();
      const body = (m.crownAbove + 1 + m.baseBelow) * torso;
      // Legs run from the hip line down to the foot; the rig's legLen in units.
      const legs = 30 * scale * m.legLength;
      return body + legs;
    }

    /* --- projection ------------------------------------------------------- */
    _scaleAt(z) {
      return PROJ_ZREF / (PROJ_ZREF + Math.max(z, -PROJ_ZREF * 0.9));
    }

    _yAt(z) {
      const s = this._scaleAt(z);
      return this.horizonY + (this.groundY - this.horizonY) * s;
    }

    _xAt(laneOffset, z) {
      return this.cx + laneOffset * this.laneW * this._scaleAt(z);
    }

    update(time, delta) {
      /* Do NOT use Phaser's `delta`.
       *
       * Phaser smooths delta toward the configured target frame interval, so on
       * a device that cannot hold 60fps it keeps reporting ~16.7ms and game time
       * silently runs at (actualFps / 60) of real time. Measured here at 37fps:
       * 60 sim steps in 3.01s, every dt exactly 16.7ms, so the sim advanced 1.0s
       * in 3.0s of real time.
       *
       * That is fatal for this game rather than merely cosmetic. The player's
       * cadence is measured on a real monotonic clock, so paceRatio is in real
       * time — but speed, gap, the void's ramp and graceSeconds would all be in
       * slowed sim time. A slower phone would get a slow-motion void, a longer
       * grace window and a stretched difficulty curve. The whole premise is
       * coupling real physical effort to in-game consequence, so the sim has to
       * share the pose tracker's clock.
       *
       * maxTimestep still guards the backgrounded-tab case, inside sim.update. */
      const now = util.now();
      const dt = this._lastUpdateT === null
        ? 0
        : clamp(now - this._lastUpdateT, 0, this.cfg.game.maxTimestep);
      this._lastUpdateT = now;
      const sim = this.sim;
      if (dt <= 0) return;

      // The sim is advanced from here so simulation and rendering share exactly
      // one clock — no interpolation mismatch, no double-stepping.
      sim.update(dt);

      // Leg animation is driven by the REAL measured cadence, so the avatar's
      // legs move at the same rate as the player's. It's the clearest possible
      // feedback that the tracking is working.
      const cadence = this.getCadence();
      this.runPhase += cadence * Math.PI * dt;

      this.shake = Math.max(0, this.shake - dt * 3.2);
      this.flash = Math.max(0, this.flash - dt * 2.6);
      this.voidWobble += dt * (2 + sim.dangerLevel() * 6);

      const shakeX = this.shake ? (Math.random() * 2 - 1) * 10 * this.shake : 0;
      const shakeY = this.shake ? (Math.random() * 2 - 1) * 7 * this.shake : 0;
      this.cameras.main.setScroll(shakeX, shakeY);

      this._drawCourse(time);
      this._drawObstacles();
      this._drawPlayer();
      this._drawVoid();
      this._drawFx();
    }

    /**
     * The sky, ground and road now live on their own canvas beneath this one
     * (js/course.js), because projecting a texture per scanline needs drawImage
     * and Graphics cannot do it. This method's only job is to hand the course
     * renderer the SAME layout numbers this scene projects with — passing them
     * rather than recomputing them is what stops the two drifting apart.
     */
    _drawCourse() {
      const course = this.course;
      if (!course) return;
      const speedNorm = clamp(
        this.sim.speed / (this.cfg.game.speedAtTargetPace * 1.4), 0, 1);
      course.resize(this.W, this.H);
      course.draw({
        W: this.W, H: this.H, cx: this.cx,
        horizonY: this.horizonY, groundY: this.groundY,
        roadHalfW: this.roadHalfW, zRef: PROJ_ZREF,
      }, this.sim.distance, speedNorm);

      /* Overdrive streaks stay here rather than in the course: they are a
       * readout of the player's effort, not scenery. */
      const g = this.gRoad;
      g.clear();
      const over = clamp((this.sim.signals.paceRatio - 1) / 0.8, 0, 1);
      if (over > 0.02) {
        g.fillStyle(N(P.accent2), 0.22 * over);
        for (let i = 0; i < 8; i++) {
          const t = (this.sim.distance * 3 + i * 37) % 100 / 100;
          const y = this.groundY - t * (this.groundY - this.horizonY) * 0.9;
          const w = 26 * (1 - t) + 4;
          g.fillRect(4, y, w, 2);
          g.fillRect(this.W - 4 - w, y, w, 2);
        }
      }
    }

    _drawObstacles() {
      const g = this.gObstacles;
      g.clear();
      // Far to near so nearer obstacles paint over farther ones.
      const list = this.sim.obstacles.slice().sort((a, b) => b.z - a.z);

      for (let i = 0; i < list.length; i++) {
        const o = list[i];
        if (o.z < -4 || o.z > 120) continue;
        const s = this._scaleAt(o.z);
        const yBase = this._yAt(o.z);
        /* Fade into the course canvas's horizon haze rather than popping out of
         * it. The haze covers the road's nearest 42% of depth, so an obstacle's
         * visibility has to track s/0.42 or a distant hurdle sits crisply on top
         * of a road that is washed out behind it — which reads as a bug. */
        const alpha = clamp(s / 0.42, 0.06, 1);

        if (o.kind === 'lane') {
          const w = this.laneW * s * 0.86;
          const h = this.laneW * s * 1.5;
          const x = this._xAt(o.lane - 1, o.z);
          g.fillStyle(COLORS.obstacleLane, alpha);
          g.fillRect(x - w / 2, yBase - h, w, h);
          g.lineStyle(Math.max(1, 2 * s), 0xffffff, alpha * 0.5);
          g.strokeRect(x - w / 2, yBase - h, w, h);
          // Chevrons pointing to the open lanes.
          g.fillStyle(0xffffff, alpha * 0.55);
          g.fillRect(x - w * 0.3, yBase - h * 0.62, w * 0.6, Math.max(1, 3 * s));
        } else if (o.kind === 'low') {
          // Hurdle: sits on the ground, spans the road → jump it.
          const h = this.laneW * s * 0.5;
          const halfW = this.roadHalfW * s * 0.95;
          g.fillStyle(COLORS.obstacleLow, alpha);
          g.fillRect(this.cx - halfW, yBase - h, halfW * 2, h);
          g.fillStyle(0x000000, alpha * 0.35);
          for (let k = -2; k <= 2; k++) {
            g.fillRect(this.cx + k * halfW * 0.34 - 1, yBase - h, Math.max(1, 3 * s), h);
          }
        } else {
          // High beam: hangs above the road with a gap underneath → duck.
          const gapUnder = this.laneW * s * 1.15;
          const h = this.laneW * s * 0.62;
          const halfW = this.roadHalfW * s * 0.95;
          g.fillStyle(COLORS.obstacleHigh, alpha);
          g.fillRect(this.cx - halfW, yBase - gapUnder - h, halfW * 2, h);
          // Support posts, so it reads as hanging rather than floating.
          g.fillStyle(COLORS.obstacleHigh, alpha * 0.55);
          g.fillRect(this.cx - halfW, yBase - gapUnder - h, Math.max(1, 3 * s), gapUnder + h);
          g.fillRect(this.cx + halfW - Math.max(1, 3 * s), yBase - gapUnder - h, Math.max(1, 3 * s), gapUnder + h);
        }
      }
    }

    /* --- the runner, seen FROM BEHIND -------------------------------------
     * Third-person over-the-shoulder, like every endless runner: we see the
     * player's back and they run away down the road. This orientation is not
     * cosmetic — it is what makes "the void is behind me and the road is ahead"
     * legible at a glance. A side-on or facing-camera avatar gives the player no
     * sense of which way they are travelling.
     *
     * Selling "from behind" without a 3D model comes down to four cues:
     *   1. a tapered back — shoulders clearly wider than hips, filled, not a
     *      stick line, so the torso reads as a surface facing us
     *   2. a backpack: a hard high-contrast mass centred on the spine. This is
     *      the single strongest cue, and it is why every runner game has one
     *   3. no face on the head, and a cap crown on TOP of the skull
     *   4. the lifted foot showing its SOLE as the heel kicks up behind
     *
     * The leg motion is different from a side view. Swinging forward means
     * swinging away from the camera, which foreshortens to almost nothing, so
     * the visible movement is mostly the heel rising and the shin shortening —
     * not a side-on pendulum. Getting that wrong is what makes back-view
     * runners look like they are marching sideways.
     * ------------------------------------------------------------------------ */
    /* --- the runner -------------------------------------------------------
     * Drawn by js/avatar.js from a set of joints, the same way the wall cutouts
     * and the fit meter are, so the thing you control and the thing you are told
     * to match are visibly the same character. That leaves this method with one
     * job: turn the run rig — stride, arm swing, bob, lean — into joints.
     *
     * The joints are in PIXELS with an identity plot, which the avatar module
     * supports because all its proportions are multiples of torso length rather
     * than absolute units.
     */
    /* --- the runner -------------------------------------------------------
     * Drawn by js/avatar.js from a set of joints, the same way the wall cutouts
     * and the fit meter are, so the thing you control and the thing you are told
     * to match are visibly the same character. That leaves this method with one
     * job: turn the run rig — stride, arm swing, bob, lean — into joints.
     *
     * The joints are in PIXELS with an identity plot, which the avatar module
     * supports because all its proportions are multiples of torso length rather
     * than absolute units.
     */
    _drawPlayer() {
      const g = this.gPlayer;
      const sim = this.sim;
      g.clear();

      const scale = this._avatarScale();
      const x = this._xAt(sim.lane - 1, 0);
      const jumpPx = sim.jumpHeight * this.H;
      const duck = sim.ducking ? 1 : 0;

      // Vertical bob, twice per stride (once per footfall). Killed in the air:
      // a bobbing jump reads as a glitch rather than a leap.
      const bob = sim.airborne ? 0 : Math.sin(this.runPhase * 2) * 1.6 * scale;
      const groundContact = this.groundY - jumpPx + bob;

      const legLen = (30 - duck * 13) * scale;
      const torsoH = (30 - duck * 12) * scale;
      const hipY = groundContact - legLen;
      const shoulderY = hipY - torsoH;
      const shHalf = 13 * scale;                  // half shoulder width
      const hipHalf = 8.5 * scale;

      // Lean into a lane change: the upper body leads and the feet trail, which
      // is both how running works and a useful hint that a lane change is
      // actually in progress.
      const tilt = clamp(sim.targetLane - sim.lane, -1, 1) * 7 * scale;
      const sx = x + tilt;

      const invuln = sim.t < sim.invulnUntil;
      // Blink while invulnerable so a hit is unmistakable.
      const alpha = invuln ? (Math.floor(sim.t * 14) % 2 ? 0.35 : 1) : 1;

      /* Shadow shrinks as you rise — the only cue that reads as "airborne".
       * Two stacked ellipses rather than one: on a bright, busy road a single
       * flat ellipse reads as a sticker, and a soft outer falloff is what makes
       * the character look like it is standing ON the road rather than over it. */
      const shadowScale = 1 - clamp(jumpPx / (this.H * 0.2), 0, 0.72);
      g.fillStyle(COLORS.ink, 0.12 * shadowScale);
      g.fillEllipse(x, this.groundY + 3 * scale,
        50 * scale * shadowScale, 14 * scale * shadowScale);
      g.fillStyle(COLORS.ink, 0.26 * shadowScale);
      g.fillEllipse(x, this.groundY + 3 * scale,
        32 * scale * shadowScale, 8 * scale * shadowScale);

      const joints = {
        nose: [sx + tilt * 0.25, shoulderY - 0.45 * torsoH],
        left_shoulder: [sx - shHalf, shoulderY],
        right_shoulder: [sx + shHalf, shoulderY],
        left_hip: [x - hipHalf, hipY],
        right_hip: [x + hipHalf, hipY],
      };

      /* --- the stride -------------------------------------------------------
       * The back-view running cue is the trailing leg FOLDING: the foot comes up
       * toward the glute with the sole toward the camera. Merely shortening the
       * leg (which is what naive foreshortening gives you) reads as marching on
       * the spot.
       *
       * lift is deliberately not a plain sine. Two antiphase sines cross zero at
       * the same instant, so both legs sit neutral for a wide window and the
       * figure looks like it is standing. The fractional power makes each leg
       * commit to up-or-down quickly and narrows that window. */
      const soles = [];
      for (let i = 0; i < 2; i++) {
        const side = i ? 1 : -1;
        const name = i ? 'right' : 'left';
        const sw = Math.sin(this.runPhase + (i ? Math.PI : 0));
        const lift = sw > 0 ? Math.pow(sw, 0.55) : 0;     // 0..1, heel rising
        // The blob's legs are stubs off one rounded base, so the knee joint IS
        // the foot — the fold shows as the stub swinging up and outward.
        const fx = x + side * (hipHalf * 0.78 + (1.5 + lift * 4) * scale);
        const fy = groundContact - lift * legLen * 0.72;
        joints[name + '_knee'] = [fx, fy];
        if (lift > 0.28) {
          soles.push({ x: fx, y: fy, a: clamp((lift - 0.28) / 0.35, 0, 1) });
        }
      }

      /* --- arms: swing in antiphase to the same-side leg ------------------ */
      for (let i = 0; i < 2; i++) {
        const side = i ? 1 : -1;
        const name = i ? 'right' : 'left';
        const aw = Math.sin(this.runPhase + (i ? 0 : Math.PI));
        const ax = sx + side * shHalf * 0.9;
        const ay = shoulderY + 2.5 * scale;
        joints[name + '_elbow'] = [ax + side * (4.5 + 1.5 * aw) * scale,
                                   ay + (11 - aw * 3) * scale];
        joints[name + '_wrist'] = [ax + side * (6 + 2 * aw) * scale,
                                   ay + (19 + aw * 5) * scale];
      }

      HP.avatar.drawBlob(HP.avatar.phaserOps(g), {
        joints: joints,
        plot: IDENTITY_PLOT,
        bsPx: 1,                 // joints are already in pixels
        skin: duck ? 'duck' : 'normal',
        alpha: alpha,
        // No face: this is a back view, and an absent face is the cue that says
        // so. Nothing else in the silhouette distinguishes front from back.
        face: false,
        // Ducking shortens the torso, which would otherwise shrink the whole
        // character rather than squashing it. Widening the torso multiples keeps
        // the mass constant and reads as a crouch.
        metrics: duck ? DUCK_METRICS : RUN_METRICS,
      });

      /* The sole of the foot, facing us once it is up behind. Drawn after the
       * body so it is not swallowed by it. */
      soles.forEach((s) => {
        g.fillStyle(COLORS.playerSole, alpha * s.a);
        g.fillEllipse(s.x, s.y, 11 * scale, 5.5 * scale);
      });
    }

    /* --- the consuming void ---------------------------------------------- */
    _drawVoid() {
      const g = this.gVoid;
      const sim = this.sim;
      g.clear();

      // gap → how far up the screen the void has crept from the bottom edge.
      const closeness = 1 - clamp(sim.gap / this.cfg.game.gapVisibleMax, 0, 1);
      if (closeness <= 0.001) return;
      const maxRise = this.H * 0.62;
      const topY = this.H - maxRise * closeness;

      // Body of the void
      g.fillStyle(COLORS.voidCore, 0.93);
      g.fillRect(0, topY, this.W, this.H - topY);

      // Jagged, animated leading edge — the thing that makes it feel alive.
      const teeth = 26;
      const amp = 10 + 26 * closeness;
      g.fillStyle(COLORS.voidCore, 0.93);
      g.beginPath();
      g.moveTo(0, this.H);
      for (let i = 0; i <= teeth; i++) {
        const fx = i / teeth;
        const wobble =
          Math.sin(this.voidWobble * 1.7 + fx * 9.1) * amp * 0.6 +
          Math.sin(this.voidWobble * 2.9 + fx * 21.7) * amp * 0.4;
        g.lineTo(fx * this.W, topY + wobble);
      }
      g.lineTo(this.W, this.H);
      g.closePath();
      g.fillPath();

      // Glowing rim
      g.lineStyle(3, COLORS.voidEdge, 0.6 + 0.4 * closeness);
      g.beginPath();
      for (let i = 0; i <= teeth; i++) {
        const fx = i / teeth;
        const wobble =
          Math.sin(this.voidWobble * 1.7 + fx * 9.1) * amp * 0.6 +
          Math.sin(this.voidWobble * 2.9 + fx * 21.7) * amp * 0.4;
        const px = fx * this.W;
        const py = topY + wobble;
        if (i === 0) g.moveTo(px, py); else g.lineTo(px, py);
      }
      g.strokePath();

      // Tendrils reaching for the player when it's very close.
      if (closeness > 0.55) {
        const reach = (closeness - 0.55) / 0.45;
        g.lineStyle(2, COLORS.voidGlow, 0.5 * reach);
        for (let i = 0; i < 7; i++) {
          const fx = (i + 0.5) / 7;
          const px = fx * this.W;
          const len = (40 + 120 * reach) * (0.6 + 0.4 * Math.sin(this.voidWobble * 3 + i));
          g.beginPath();
          g.moveTo(px, topY);
          g.lineTo(px + Math.sin(this.voidWobble * 2 + i) * 22, topY - len);
          g.strokePath();
        }
      }
    }

    _drawFx() {
      const g = this.gFx;
      const sim = this.sim;
      g.clear();

      // Danger vignette — pulses in time with the audio danger cue.
      const danger = sim.dangerLevel();
      if (danger > 0.01) {
        const pulse = 0.5 + 0.5 * Math.sin(this.voidWobble * 4);
        const a = danger * (0.18 + 0.22 * pulse);
        const bands = 6;
        for (let i = 0; i < bands; i++) {
          const t = i / bands;
          g.fillStyle(COLORS.voidGlow, a * (1 - t) * 0.5);
          const inset = t * Math.min(this.W, this.H) * 0.12;
          g.fillRect(0, inset, this.W, 6);                       // top
          g.fillRect(0, this.H - inset - 6, this.W, 6);           // bottom
          g.fillRect(inset, 0, 6, this.H);                       // left
          g.fillRect(this.W - inset - 6, 0, 6, this.H);           // right
        }
      }

      // Hit / milestone flash
      if (this.flash > 0.01) {
        g.fillStyle(0xffffff, this.flash * 0.3);
        g.fillRect(0, 0, this.W, this.H);
      }

      // Grace window: the void is touching and the clock is running out.
      if (sim.gap <= 0 && sim.status === 'running') {
        const frac = clamp(sim.grace / this.cfg.game.graceSeconds, 0, 1);
        g.fillStyle(0xff2b57, 0.9);
        g.fillRect(0, this.H - 6, this.W * frac, 6);
      }
    }
  }

  HP.GameSim = GameSim;
  HP.RunScene = RunScene;
  HP.GAME_COLORS = COLORS;
})(window.HP);
