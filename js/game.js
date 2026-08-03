/* =============================================================================
 * Huff&Puff — GAME SIMULATION + RENDERER
 * =============================================================================
 * Two things live here, deliberately separated:
 *
 *   HP.GameSim   Pure simulation. No Phaser, no DOM, no pose code. It reads a
 *                plain `signals` object (paceRatio / laneIntent / ducking /
 *                tracked / poseError) that main.js refreshes from the tracker,
 *                and emits gameplay events. This is what makes the game testable with a
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
 *
 *   Punctuating that: POSE GATES. A wall with a pose-shaped hole closes on you and
 *   you have to be in that shape when it arrives — so a run is not only cadence
 *   and reflexes, it also asks for squats, star jumps and knee raises. The void
 *   waits while a gate is live, because a gate asks you to stop running and the
 *   void's whole premise is that stopping kills you; charging you for complying
 *   would make every gate a punishment for engaging with it. See _updateGates and
 *   cfg.game.gate.
 *
 *   Distinct from WALL MODE (js/wall-mode.js), which is a separate auto-scrolling
 *   scene built entirely out of those walls and where you never run at all. Both
 *   draw through the same renderer.
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

      /* --- pose gates ---------------------------------------------------- */
      this.gates = [];
      this.nextGateAt = g.gate.firstAtM;
      this.gateHold = false;      // a gate is live: the void waits, see cfg.gate
      this.gatesPassed = 0;
      this.gatesMissed = 0;
      this._gateId = 0;
      this._lastGatePose = null;
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
        /* How far the player's body is from the shape the live gate is asking
         * for, in body-scale units. ONE number, exactly like paceRatio: the sim
         * stays free of pose code, which is what keeps ?sim=1 testable. Infinity
         * means "no reading", which is a different failure from "wrong shape"
         * and is reported differently by the HUD. */
        poseError: Infinity,
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

      /* --- pose gates ----------------------------------------------------
       * Before the void, because the void reads gateHold, and after speed,
       * because a gate's approach rate depends on it. */
      this._updateGates(dt);

      /* --- the void ------------------------------------------------------
       * `gateHold` suspends it exactly as tracking loss does, and for a related
       * reason: in both cases the player is being asked to do something other
       * than run, so charging them for not running is charging them for
       * complying. See cfg.game.gate — THE VOID WAITS. */
      this.wallSpeed = this.wallSpeedAt(this.t);
      if (!this.frozen && !this.gateHold) {
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

    /* =========================================================================
     * POSE GATES
     * -------------------------------------------------------------------------
     * A wall with a pose-shaped hole closes on the player, who must be in that
     * shape when it arrives. The state machine is approach -> armed -> contact
     * -> done, and the hold is ACCUMULATED across the contact window rather than
     * sampled once, so a pose that flickers in and out does not pass.
     *
     * `armed` is the moment the demand becomes visible: the prompt and the fit
     * meter appear, and the void stops advancing. Everything the player needs to
     * react is available for cfg.gate.armSeconds before contact.
     * ====================================================================== */

    /** Approach rate of a gate: the world's, or the wall's own, whichever is faster. */
    _gateSpeed() {
      return Math.max(this.speed, this.cfg.game.gate.approachSpeed);
    }

    /** The gate the player should be reacting to, or null. */
    activeGate() {
      for (let i = 0; i < this.gates.length; i++) {
        const gt = this.gates[i];
        if (gt.state === 'armed' || gt.state === 'contact') return gt;
      }
      return null;
    }

    gateToleranceFor(poseId) {
      const pose = HP.POSES && HP.POSES[poseId];
      return (pose && pose.tolerance) || this.cfg.wall.defaultTolerance;
    }

    /** 0..1 how close the player is to the live gate's shape, for the fit meter. */
    gateFit() {
      const gt = this.activeGate();
      if (!gt) return 0;
      const err = this.signals.poseError;
      if (!isFinite(err)) return 0;
      const range = this.gateToleranceFor(gt.poseId) * this.cfg.wall.fitRangeMultiple;
      return clamp(1 - err / range, 0, 1);
    }

    /** Where on the fit bar the pass threshold sits, so it can be marked. */
    gateFitThreshold() {
      return 1 - 1 / this.cfg.wall.fitRangeMultiple;
    }

    gateMatched() {
      const gt = this.activeGate();
      if (!gt) return false;
      return this.signals.poseError < this.gateToleranceFor(gt.poseId);
    }

    _pickGatePose() {
      const list = this.cfg.game.gate.poses.filter((id) => HP.POSES && HP.POSES[id]);
      if (!list.length) return null;
      /* Never the same shape twice running. A repeat can be passed by simply not
       * moving, which is the one thing this mechanic exists to prevent — the same
       * reason wall mode's level alternates. */
      const choices = list.length > 1
        ? list.filter((id) => id !== this._lastGatePose)
        : list;
      return choices[Math.floor(Math.random() * choices.length)];
    }

    _updateGates(dt) {
      const cfg = this.cfg.game.gate;
      if (!cfg.enabled) return;

      /* --- spawn ---------------------------------------------------------
       * On distance, like obstacles, so a faster player does not meet a denser
       * field. Never two at once: overlapping demands would be unreadable, and
       * the fit meter can only show one. */
      if (this.distance >= this.nextGateAt && !this.gates.some((gt) => gt.state !== 'done')) {
        const poseId = this._pickGatePose();
        if (poseId) {
          this._lastGatePose = poseId;
          this.gates.push({
            id: ++this._gateId,
            poseId: poseId,
            z: cfg.spawnZ,
            thickness: cfg.thickness,
            state: 'approach',
            held: 0,
            required: 0,     // set on contact, from the speed actually seen
            result: null,
          });
          this.emit('gateSpawn', { poseId: poseId });
        }
        const jitter = (Math.random() * 2 - 1) * cfg.intervalJitterM;
        this.nextGateAt = this.distance + Math.max(40, cfg.intervalM + jitter);
      }

      /* --- advance and resolve -------------------------------------------- */
      const rate = this._gateSpeed();
      const armZ = rate * cfg.armSeconds;
      let hold = false;

      for (let i = this.gates.length - 1; i >= 0; i--) {
        const gt = this.gates[i];
        gt.z -= rate * dt;
        const halfT = gt.thickness / 2;

        if (gt.state !== 'done') {
          if (gt.z > armZ) {
            gt.state = 'approach';
          } else if (gt.z > halfT) {
            if (gt.state !== 'armed') {
              gt.state = 'armed';
              /* Sweep the road between the wall and the player. Suppressing
               * obstacle SPAWNS during a gate is not enough on its own: the two run
               * on independent schedules and a gate outruns an obstacle whenever the
               * player slows down, which is exactly what a gate asks them to do. So
               * anything still in flight in front of the player when the wall arms
               * gets taken by the wall. Removed rather than counted as a dodge,
               * because the player did not dodge it.
               *
               * Without this the game can demand two incompatible things at once —
               * a duck beam during an ARMS OUT gate — which is unpassable and reads
               * as the game being broken rather than hard. */
              const swept = this.obstacles.filter((o) => !o.resolved && o.z > 0).length;
              if (swept) {
                this.obstacles = this.obstacles.filter((o) => o.resolved || o.z <= 0);
                this.emit('gateSweep', { count: swept });
              }
              this.emit('gateArmed', { gate: gt, poseId: gt.poseId });
            }
          } else if (gt.z >= -halfT) {
            if (gt.state !== 'contact') {
              gt.state = 'contact';
              /* Fixed on entry rather than recomputed per frame. The player's
               * speed changes a lot during a gate — that is the point of the
               * mechanic — and a moving target would mean the amount of hold
               * demanded depended on how hard they happened to be running. */
              const window = gt.thickness / Math.max(0.001, rate);
              gt.required = window * cfg.minHeldFraction;
              this.emit('gateContact', { gate: gt });
            }
            if (this.signals.poseError < this.gateToleranceFor(gt.poseId)) gt.held += dt;
          } else {
            this._resolveGate(gt);
          }
          if (gt.state === 'armed' || gt.state === 'contact') hold = true;
        }

        if (gt.z < cfg.despawnZ) this.gates.splice(i, 1);
      }

      this.gateHold = cfg.suspendVoid && hold;
    }

    _resolveGate(gt) {
      const cfg = this.cfg.game.gate;
      const g = this.cfg.game;
      gt.state = 'done';
      const pass = gt.required > 0 && gt.held >= gt.required;
      gt.result = pass ? 'pass' : 'miss';

      if (pass) {
        this.gatesPassed++;
        this.gap = clamp(this.gap + cfg.passGapReward, 0, g.gapMax);
        this.emit('gatePassed', {
          gate: gt, poseId: gt.poseId, gap: this.gap, passed: this.gatesPassed,
        });
      } else {
        this.gatesMissed++;
        /* The same consequence as any other obstacle, deliberately: gap and a
         * shield, never an instant end. A missed gate should read as "that cost
         * me", the same currency as a clipped hurdle, so the player does not
         * have to learn a second penalty model. */
        this._applyHit({ kind: 'gate' });
        this.emit('gateMissed', {
          gate: gt, poseId: gt.poseId, missed: this.gatesMissed,
        });
      }
    }

    _updateObstacles(dt) {
      const g = this.cfg.game;

      /* Spawn on distance travelled, not on time: a faster player meets
       * obstacles at the same spacing, so pushing hard is never punished with a
       * denser obstacle field. */
      if (this.distance >= this.nextObstacleAt) {
        /* Never on top of a pose gate. A duck beam arriving while a gate demands
         * ARMS OUT is an impossible instruction — the player cannot be ducking and
         * arms-out at once — and it was happening: the two spawn on independent
         * distance schedules, so they collide sooner or later. Holding the spawn
         * rather than skipping it means the obstacle simply arrives after the gate
         * instead of being silently dropped from the run. */
        if (this.gates.some((gt) => gt.state !== 'done')) {
          this.nextObstacleAt = this.distance + 8;
        } else {
          this._spawnObstacle();
          const jitter = (Math.random() * 2 - 1) * g.obstacleIntervalJitterM;
          this.nextObstacleAt = this.distance + Math.max(20, g.obstacleIntervalM + jitter);
        }
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
        gatesPassed: this.gatesPassed,
        gatesMissed: this.gatesMissed,
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
  const RUN_METRICS = {
    legOut: 0, legLength: 0.92,
    /* Tuck the flippers in. The default pushes arms out to the silhouette edge so
     * a WALL CUTOUT stays readable — three of the ten poses differ only in the
     * arms, and buried arms make those unmatchable. The runner has the opposite
     * need: nobody is judging its arm position, and at this camera scale the same
     * spread reads as long paddles rather than as the reference's stubby
     * flippers. Overriding here leaves the cutouts untouched. */
    armAnchor: 0.80,
  };

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
   * character's WIDTH is about 38% of the road's width — the measurement that
   * matters, since it decides whether the player can still see the lanes and the
   * gate they are steering into. The blob is 1.9 torsos wide, so
   * 1.9 * 30 * scale = 0.38 * 2 * roadHalfW  =>  scale = roadHalfW / 75.
   *
   * Nudged to 64 after the road was extended past the player to the bottom of the
   * frame: the road now flares much wider below groundY, and the eye reads the
   * character against that full width rather than against its width at the
   * character's own depth, so 75 looked smaller than the same ratio did before.
   *
   * The height term is a cap for landscape, where roadHalfW is generous and the
   * screen is short. Sizing by width alone put the avatar at 43% of the frame
   * width and it occluded the road it was running on. */
  const AVATAR_ROAD_DIV = 64;      // roadHalfW / this = unit scale
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
      this._stateSprite = null;   // created lazily; see _drawStateSprite

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
      /* Pose gates. Behind the runner, because a gate the player has not reached
       * yet is FARTHER than they are, so painter's order puts it underneath — that
       * is what makes the character read as passing through the hole rather than
       * being pasted over the wall. Wall mode draws its walls to this same layer
       * for the same reason. */
      this.gGates = this.add.graphics();
      this.gObstacles = this.add.graphics();
      this.gPlayer = this.add.graphics();
      this.gVoid = this.add.graphics();
      this.gFx = this.add.graphics();

      /* Explicit depths rather than relying on creation order, so a subclass that
       * adds a layer cannot silently reshuffle the stack. */
      this.gSky.setDepth(0);
      this.gRoad.setDepth(1);
      this.gGates.setDepth(2);
      this.gObstacles.setDepth(3);
      this.gPlayer.setDepth(4);
      this.gVoid.setDepth(5);
      this.gFx.setDepth(6);

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
      /* Wide, per the reference: the track dominates the foreground and the
       * buildings sit in the middle distance rather than flanking the camera.
       *
       * Two bounds, and both had to move. The width term is what normally binds
       * on a phone. The DEPTH term exists to stop the road being wider than it is
       * deep, which reads as a fisheye — but at 0.62 it was binding on tablets
       * and squaring off the road there while phones got the full width, so the
       * same build looked like two different games. */
      this.roadHalfW = Math.min(w * 0.46, depth * 0.78);
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
      this._drawGates();
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

    /* Pose gates, drawn with the SAME renderer wall mode uses — see
     * HP.drawWallList in js/wall-mode.js.
     *
     * That file is a hard dependency of the app, not an optional one: js/main.js
     * constructs HP.WallSim at module scope, so removing wall-mode.js stops the
     * game booting at all (verified: "HP.WallSim is not a constructor"). An
     * earlier version of this method carried a fallback that disabled gates when
     * HP.drawWallList was missing — it was unreachable, because the app is already
     * dead by then. The cheap existence checks below stay, since they cost nothing
     * and a scene can legitimately be constructed before its layers exist, but
     * they are not a graceful-degradation story and should not be read as one. */
    _drawGates() {
      if (!this.gGates || !HP.drawWallList) return;
      const sim = this.sim;
      HP.drawWallList(this, sim.gates, {
        graphics: this.gGates,
        poseError: sim.signals.poseError,
        toleranceFor: (id) => sim.gateToleranceFor(id),
        /* The opening follows the player's lane, so being off-centre is never a
         * silent way to fail a pose that was held correctly. */
        holeXFor: (s) => this.cx + (sim.lane - 1) * this.laneW * s,
      });
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
    /**
     * Draw a rendered frame of the character, or report that it is unavailable.
     *
     * This is now the PRIMARY path, including for running, and that reverses an
     * earlier decision on the strength of a measurement. The argument against a
     * sprite runner was that a still frame cannot animate a stride. But the
     * measurement that killed the commissioned run cycle also kills the objection:
     * from directly behind, three deliberately different stride phases differed by
     * 0.4-0.7% of their silhouettes, because the body occludes the legs. Leg
     * position simply does not read at this camera angle.
     *
     * What DOES sell a back-view run is bob, sway, squash and lean — and every one
     * of those is a transform, which applies to a rendered frame exactly as well
     * as to a rig. So the thing a sprite cannot do is the thing that does not
     * matter here, and the thing that matters is the thing a sprite does fine.
     *
     * Scale comes from the IDLE reference sprite, so a jump stays proportionally
     * taller than a crouch and the character never changes size when the state
     * changes. Sizing each frame to a fixed height would make a crouch and a jump
     * identical, which is the exact pulsing this avoids.
     *
     * @param {object} tf  {rot, sx, sy} — rotation in radians and scale
     *                     multipliers, applied about the feet.
     */
    _drawStateSprite(name, x, footY, alpha, tf) {
      const states = HP.avatar.states;
      if (!name || !states.has(name) || !states.refHeight()) return false;
      const img = states.get(name);

      // Register with Phaser's texture manager on first use — the images load
      // asynchronously and may well arrive after create() has run.
      if (!this.textures.exists(name)) this.textures.addImage(name, img);
      if (!this._stateSprite) {
        this._stateSprite = this.add.image(0, 0, name)
          .setDepth(this.gPlayer.depth + 0.1);
      }
      const sp = this._stateSprite;
      if (sp.texture.key !== name) sp.setTexture(name);
      /* Origin at the character's FEET and body centre, measured from the frame's
       * own pixels rather than assumed to be the canvas corner — see states.origin.
       * Per frame, because each pose has its own. Anchoring there is also what makes
       * the transforms mean the right thing: scaleY compresses toward the ground
       * like a footfall, and a rotation tips the body over its contact point like a
       * lean. About the canvas centre, the same numbers would make it hover and
       * pivot in mid-air. */
      const o = states.origin(name);
      sp.setOrigin(o.x, o.y);
      const k = this._avatarHeightPx() / states.refHeight();
      const t = tf || {};
      sp.setVisible(true)
        .setPosition(x, footY)
        .setScale(k * (t.sx === undefined ? 1 : t.sx),
                  k * (t.sy === undefined ? 1 : t.sy))
        .setAlpha(alpha)
        .setRotation(t.rot || 0);
      return true;
    }

    _hideStateSprite() {
      if (this._stateSprite) this._stateSprite.setVisible(false);
    }

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

      /* --- the run cycle, from one signal -----------------------------------
       * runPhase advances PI per step, so footfalls land at runPhase 0 and PI and
       * the flight apex sits halfway between them. `contact` is 1 at a footfall
       * and 0 at the apex, and everything else in the cycle is derived from it so
       * the parts cannot drift out of phase with each other.
       *
       * They previously did. Bob was sin(2*phase), which is zero at phase 0 and PI
       * — exactly where a footfall is — while squash peaked at those same phases.
       * So the body was compressing while passing through neutral height and
       * extending while at its lowest, which is the run cycle inside out: it read
       * as a wobble rather than as weight landing.
       *
       * Killed in the air, all of it: a bobbing, squashing jump reads as a glitch
       * rather than a leap. */
      const contact = sim.airborne ? 1 : (1 + Math.cos(this.runPhase * 2)) / 2;
      // Body rises off the ground between footfalls. ~6% of body height, which is
      // in the range a real runner's centre of mass travels.
      const bob = sim.airborne ? 0 : -(1 - contact) * 6.2 * scale;
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

      /* --- secondary motion -------------------------------------------------
       * A back-view runner has almost nothing to read: the body hides the legs,
       * so leg position carries very little. What sells the run from behind is
       * everything OTHER than the legs.
       *
       *   sway    the body shifts side to side ONCE per stride, because weight
       *           goes onto one foot and then the other. Driven by phase directly
       *           rather than by `contact`, which is deliberately blind to which
       *           foot is down.
       *
       *           SMALL, and that is the whole point. This was 4.2 and it made the
       *           character waddle: measured against a 248px body, lateral travel
       *           came to 9.2% of body height at once per stride while the vertical
       *           bob was 6.0% at twice per stride, so the biggest, slowest motion
       *           on screen was a sideways lurch. A real runner seen from behind is
       *           the other way round — the centre of mass oscillates 5-7% of height
       *           vertically and the torso sways only 1-2% — because what actually
       *           alternates is the legs, and a single frame has none. Overdriving
       *           sway to stand in for that does not read as running, it reads as
       *           hobbling. See RUN_SWAY_MAX_FRACTION in the harness.
       *   squash  the body compresses on each footfall and widens as it does,
       *           conserving apparent mass. Squared, so it is a sharp landing
       *           rather than a slow pulse.
       *   twist   shoulders rotate against the hips, so the two ends of the body
       *           disagree instead of moving as a slab. Rig path only — a sprite
       *           has no separate shoulder line to counter-rotate.
       *   lean    grows with speed, and pulls the shoulder line toward the hips,
       *           which is what a forward lean looks like from behind. Rig path
       *           only, and see the sprite transform below for why.
       */
      const strideSway = sim.airborne ? 0 : Math.sin(this.runPhase) * 0.9 * scale;
      const squash = sim.airborne ? 0 : contact * contact * 0.06;
      const twist = sim.airborne ? 0 : Math.sin(this.runPhase) * 3.2 * scale;
      const leanNorm = clamp(sim.speed / (this.cfg.game.speedAtTargetPace * 1.3), 0, 1);
      const lean = leanNorm * 0.10;

      const sx = x + tilt + strideSway;

      const invuln = sim.t < sim.invulnUntil;
      // Blink while invulnerable so a hit is unmistakable.
      const alpha = invuln ? (Math.floor(sim.t * 14) % 2 ? 0.35 : 1) : 1;

      /* Shadow shrinks as you rise — the only cue that reads as "airborne".
       * Two stacked ellipses rather than one: on a bright, busy road a single
       * flat ellipse reads as a sticker, and a soft outer falloff is what makes
       * the character look like it is standing ON the road rather than over it.
       *
       * The run's own bob counts as rising. It has to: the bob is now large enough
       * to lift the feet clearly off the road, and a shadow that stays full size
       * under a body in mid-flight is what makes a runner look like a sticker
       * sliding along. Weighted well above the jump term because the bob is a much
       * smaller distance and would otherwise contribute nothing visible. */
      const shadowScale = 1 - clamp((jumpPx + (-bob) * 3.2) / (this.H * 0.2), 0, 0.72);
      g.fillStyle(COLORS.ink, 0.12 * shadowScale);
      g.fillEllipse(x, this.groundY + 3 * scale,
        50 * scale * shadowScale, 14 * scale * shadowScale);
      g.fillStyle(COLORS.ink, 0.26 * shadowScale);
      g.fillEllipse(x, this.groundY + 3 * scale,
        32 * scale * shadowScale, 8 * scale * shadowScale);

      /* Squash pulls the shoulder line toward the hips and widens the body; lean
       * pulls it further still, which is what foreshortening looks like from
       * behind. Both are applied to the SHOULDER line rather than to a transform,
       * so every limb hung off it follows for free. */
      const shoulderYc = shoulderY + torsoH * (squash + lean);
      const shHalfc = shHalf * (1 + squash * 1.6);

      /* --- the rendered path ------------------------------------------------
       * Running included. The secondary motion computed above becomes transforms
       * on the frame rather than offsets on a rig: bob and sway move it, squash
       * scales it toward the ground, and a stride rock rotates it about the feet.
       * See _drawStateSprite for why a still frame is not a compromise at this
       * camera angle.
       *
       * `lean` is deliberately NOT applied here, and that is a correction rather
       * than an omission. On the rig it moves the shoulder line toward the hips
       * while the legs stay put, which is what foreshortening is. As a scaleY on a
       * whole frame it compresses the legs too, and since lean is near-constant at
       * speed the result was a permanent squash — measured at scaleX 1.046 against
       * scaleY 0.868, so the character ran 17% wider-than-tall relative to its own
       * art for the entire game. That is not a lean, it is a differently-shaped
       * penguin. Speed is already carried by the road scroll, the overdrive
       * streaks, the HUD and the cadence itself, so nothing is lost by dropping it.
       */
      const stateName = sim.airborne ? 'state-jump'
        : duck ? 'state-duck'
        : (invuln ? 'state-hit' : 'state-run');
      const isRunning = stateName === 'state-run';
      if (this._drawStateSprite(stateName, x + (isRunning ? strideSway : 0),
            groundContact + 2, alpha, isRunning ? {
              /* Rock about the contact point, once per stride, plus whatever lean
               * the lane change asks for. Small: past about 0.05 rad it stops
               * reading as running and starts reading as staggering. */
              rot: (tilt / Math.max(1, this.laneW)) * 0.55 +
                   Math.sin(this.runPhase) * 0.012,
              /* Widen as it compresses, so apparent mass is conserved. */
              sx: 1 + squash * 0.85,
              sy: 1 - squash,
            } : {
              rot: (tilt / Math.max(1, this.laneW)) * 0.55,
            })) {
        return;
      }
      this._hideStateSprite();

      /* --- procedural fallback ----------------------------------------------
       * Everything below runs only when no rendered frame is available, which is
       * the zero-assets case. It has to stay: the game shipped able to run with no
       * art at all and that property is worth keeping. */
      const joints = {
        nose: [sx + tilt * 0.25 + twist * 0.4,
               shoulderYc - (0.45 - lean * 0.5) * torsoH],
        left_shoulder: [sx - shHalfc + twist, shoulderYc - twist * 0.22],
        right_shoulder: [sx + shHalfc + twist, shoulderYc + twist * 0.22],
        // Hips counter-rotate: opposite sign on both the shift and the tilt.
        left_hip: [x - hipHalf - twist * 0.5, hipY + twist * 0.14],
        right_hip: [x + hipHalf - twist * 0.5, hipY - twist * 0.14],
      };

      /* --- the stride ------------------------------------------------------ */
      const soles = [];
      for (let i = 0; i < 2; i++) {
        const side = i ? 1 : -1;
        const name = i ? 'right' : 'left';
        const sw = Math.sin(this.runPhase + (i ? Math.PI : 0));
        const lift = sw > 0 ? Math.pow(sw, 0.55) : 0;
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
        const raw = Math.sin(this.runPhase + (i ? 0 : Math.PI));
        const aw = Math.sign(raw) * Math.pow(Math.abs(raw), 0.72);
        const ax = sx + side * shHalfc * 0.9 + twist * 0.7;
        const ay = shoulderYc + 2.5 * scale;
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
