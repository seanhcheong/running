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

  const COLORS = {
    skyTop: 0x05060f,
    skyBottom: 0x141033,
    horizonGlow: 0x3b2f7a,
    ground: 0x0b0c18,
    road: 0x1b1c2e,
    roadEdge: 0x2f3350,
    stripe: 0x39d9ff,
    laneLine: 0x2a3f63,
    player: 0x7dffb0,
    playerDuck: 0x62d8ff,
    obstacleLane: 0xff4d9d,
    obstacleLow: 0xffc23d,
    obstacleHigh: 0xb478ff,
    voidCore: 0x000000,
    voidEdge: 0x8b1030,
    voidGlow: 0xff2b57,
  };

  class RunScene extends Phaser.Scene {
    constructor(deps) {
      super({ key: 'RunScene' });
      this.sim = deps.sim;
      this.getCadence = deps.getCadence || (() => 0);
      this.cfg = deps.config || HP.CONFIG;
      this.onStep = deps.onStep || null;

      this.runPhase = 0;   // leg-swing phase, advanced by live cadence
      this.shake = 0;      // screen shake impulse, decays
      this.flash = 0;      // white/red flash on hit
      this.voidWobble = 0;
    }

    create() {
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
      this.roadHalfW = Math.min(w * 0.46, depth * 0.62);
      this.laneW = this.roadHalfW / 1.5; // 3 lanes => lane centres at -1, 0, 1
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
      const dt = delta / 1000;
      const sim = this.sim;

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

      this._drawSky(time);
      this._drawRoad();
      this._drawObstacles();
      this._drawPlayer();
      this._drawVoid();
      this._drawFx();
    }

    _drawSky(time) {
      const g = this.gSky;
      g.clear();
      // Vertical gradient, faked with a few bands (cheap and good enough).
      const bands = 12;
      for (let i = 0; i < bands; i++) {
        const t = i / (bands - 1);
        const c = Phaser.Display.Color.Interpolate.ColorWithColor(
          Phaser.Display.Color.ValueToColor(COLORS.skyTop),
          Phaser.Display.Color.ValueToColor(COLORS.skyBottom),
          100, t * 100
        );
        g.fillStyle(Phaser.Display.Color.GetColor(c.r, c.g, c.b), 1);
        g.fillRect(0, (this.horizonY / bands) * i - 1, this.W, this.horizonY / bands + 2);
      }

      /* Ground plane. The road converges at its own zFar, which is still well
       * short of the horizon line, so without this fill the band between them
       * shows the page background as a visible seam across the screen. */
      g.fillStyle(COLORS.ground, 1);
      g.fillRect(0, this.horizonY - 1, this.W, this.H - this.horizonY + 1);

      // Stars
      for (let i = 0; i < this.stars.length; i++) {
        const st = this.stars[i];
        const a = 0.25 + 0.55 * (0.5 + 0.5 * Math.sin(time * 0.002 + st.tw));
        g.fillStyle(0xffffff, a);
        g.fillCircle(st.x * this.W, st.y * this.horizonY, st.r);
      }

      // Horizon glow — brighter the faster you're going, so speed reads even
      // when you're too winded to look at the HUD. Kept flat so it straddles the
      // horizon line rather than floating in the sky as a blob.
      const speedNorm = clamp(this.sim.speed / (this.cfg.game.speedAtTargetPace * 1.4), 0, 1);
      g.fillStyle(COLORS.horizonGlow, 0.25 + speedNorm * 0.4);
      g.fillEllipse(this.cx, this.horizonY, this.W * 0.9, this.H * 0.05);
    }

    _drawRoad() {
      const g = this.gRoad;
      const cfg = this.cfg.game;
      g.clear();

      const zFar = 120;
      const sFar = this._scaleAt(zFar);
      const yFar = this._yAt(zFar);
      const yNear = this.groundY;

      // Road surface
      g.fillStyle(COLORS.road, 1);
      g.beginPath();
      g.moveTo(this.cx - this.roadHalfW, yNear);
      g.lineTo(this.cx + this.roadHalfW, yNear);
      g.lineTo(this.cx + this.roadHalfW * sFar, yFar);
      g.lineTo(this.cx - this.roadHalfW * sFar, yFar);
      g.closePath();
      g.fillPath();

      // Road edges
      g.lineStyle(2, COLORS.roadEdge, 0.9);
      g.beginPath();
      g.moveTo(this.cx - this.roadHalfW, yNear);
      g.lineTo(this.cx - this.roadHalfW * sFar, yFar);
      g.strokePath();
      g.beginPath();
      g.moveTo(this.cx + this.roadHalfW, yNear);
      g.lineTo(this.cx + this.roadHalfW * sFar, yFar);
      g.strokePath();

      // Lane divider lines
      g.lineStyle(1.5, COLORS.laneLine, 0.65);
      [-0.5, 0.5].forEach((off) => {
        g.beginPath();
        g.moveTo(this._xAt(off, 0), yNear);
        g.lineTo(this._xAt(off, zFar), yFar);
        g.strokePath();
      });

      /* Transverse stripes scrolling toward the player: the primary sense of
       * speed. Their positions come from distance travelled, so they scroll at
       * exactly the rate the sim says you're moving. */
      const spacing = 12;
      const phase = this.sim.distance % spacing;
      for (let n = 0; n < 12; n++) {
        const z = n * spacing - phase;
        if (z < 0 || z > zFar) continue;
        const s = this._scaleAt(z);
        const y = this._yAt(z);
        const thickness = Math.max(1, 8 * s);
        g.fillStyle(COLORS.stripe, 0.10 + 0.35 * s);
        g.fillRect(this.cx - this.roadHalfW * s, y, this.roadHalfW * 2 * s, thickness);
      }

      // Speed streaks at the sides when in overdrive.
      const over = clamp((this.sim.signals.paceRatio - 1) / 0.8, 0, 1);
      if (over > 0.02) {
        g.fillStyle(0x9fe8ff, 0.18 * over);
        for (let i = 0; i < 8; i++) {
          const t = (this.sim.distance * 3 + i * 37) % 100 / 100;
          const y = this.horizonY + t * (this.H - this.horizonY);
          const len = 40 + t * 120;
          g.fillRect(0, y, len, 2);
          g.fillRect(this.W - len, y + 13, len, 2);
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
        const alpha = clamp(s * 3.2, 0.15, 1);

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

    _drawPlayer() {
      const g = this.gPlayer;
      const sim = this.sim;
      g.clear();

      const x = this._xAt(sim.lane - 1, 0);
      const jumpPx = sim.jumpHeight * this.H;
      const scale = this.laneW / 90;              // avatar size relative to lanes
      const duck = sim.ducking ? 1 : 0;
      const bodyH = (58 - duck * 22) * scale;
      const legLen = (34 - duck * 12) * scale;
      const y = this.groundY - jumpPx;

      // Shadow shrinks as you rise — the only cue that reads as "airborne".
      const shadowScale = 1 - clamp(jumpPx / (this.H * 0.2), 0, 0.7);
      g.fillStyle(0x000000, 0.4 * shadowScale);
      g.fillEllipse(x, this.groundY + 3, 34 * scale * shadowScale, 9 * scale * shadowScale);

      const col = sim.ducking ? COLORS.playerDuck : COLORS.player;
      const invuln = sim.t < sim.invulnUntil;
      // Blink while invulnerable so a hit is unmistakable.
      const alpha = invuln ? (Math.floor(sim.t * 14) % 2 ? 0.35 : 1) : 1;

      // Legs: swing in antiphase at the measured cadence.
      const swing = Math.sin(this.runPhase);
      const swing2 = Math.sin(this.runPhase + Math.PI);
      const hipY = y - legLen;
      g.lineStyle(Math.max(2, 7 * scale), col, alpha);
      [swing, swing2].forEach((sw) => {
        const kneeX = x + sw * 13 * scale;
        const kneeY = hipY + legLen * 0.55;
        const footX = x + sw * 20 * scale;
        const footY = y - Math.max(0, sw) * 12 * scale;
        g.beginPath();
        g.moveTo(x, hipY);
        g.lineTo(kneeX, kneeY);
        g.lineTo(footX, footY);
        g.strokePath();
      });

      // Torso + head
      const shoulderY = hipY - bodyH * 0.55;
      g.lineStyle(Math.max(3, 10 * scale), col, alpha);
      g.beginPath();
      g.moveTo(x, hipY);
      g.lineTo(x + duck * 6 * scale, shoulderY);
      g.strokePath();
      g.fillStyle(col, alpha);
      g.fillCircle(x + duck * 9 * scale, shoulderY - 11 * scale, 9 * scale);

      // Arms pumping in antiphase to the legs.
      g.lineStyle(Math.max(2, 5 * scale), col, alpha * 0.9);
      [swing2, swing].forEach((sw, i) => {
        const ex = x + sw * 14 * scale * (i ? -1 : 1);
        const ey = shoulderY + 16 * scale;
        g.beginPath();
        g.moveTo(x, shoulderY + 2 * scale);
        g.lineTo(ex, ey);
        g.strokePath();
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
