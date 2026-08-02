/* =============================================================================
 * Huff&Puff — POSE TRACKING MODULE
 * =============================================================================
 * Owns: the camera stream, TF.js + MoveNet, One Euro filtering, and turning
 * filtered keypoints into game-meaningful signals.
 *
 * The game code NEVER touches TF.js, the video element, or a raw keypoint. It
 * only consumes:
 *
 *   Values (poll via tracker.state):
 *     state.currentCadence  steps/sec, smoothed
 *     state.paceRatio       currentCadence / this player's comfortable cadence
 *     state.running         true only after several consistent running cycles
 *     state.laneIntent      -1 | 0 | +1  (player's own left / centre / right)
 *     state.ducking         boolean
 *     state.tracked         is a usable pose visible right now
 *     state.confidence      mean score of the keypoints we care about
 *
 *   Events (tracker.on(...)):
 *     'onLeanLeft'  'onLeanRight'  'onCenter'
 *     'onJump'      'onDuck'       'onDuckEnd'
 *     'frame'       per processed frame, carries the full metrics snapshot
 *     'found' / 'lost'             pose acquired / dropped
 *     'error'
 *
 * Every threshold this file uses comes from HP.CONFIG (config.js) and is
 * documented there.
 * ========================================================================== */

window.HP = window.HP || {};

(function (HP) {
  'use strict';

  const util = HP.util;
  const clamp = util.clamp;

  /* MoveNet (COCO) keypoint layout, for the debug skeleton. */
  const SKELETON_EDGES = [
    ['left_shoulder', 'right_shoulder'],
    ['left_shoulder', 'left_elbow'], ['left_elbow', 'left_wrist'],
    ['right_shoulder', 'right_elbow'], ['right_elbow', 'right_wrist'],
    ['left_shoulder', 'left_hip'], ['right_shoulder', 'right_hip'],
    ['left_hip', 'right_hip'],
    ['left_hip', 'left_knee'], ['left_knee', 'left_ankle'],
    ['right_hip', 'right_knee'], ['right_knee', 'right_ankle'],
    ['nose', 'left_shoulder'], ['nose', 'right_shoulder'],
  ];

  /* ===========================================================================
   * CadenceDetector
   * ---------------------------------------------------------------------------
   * Input per processed frame: kneeDiff = (rightKnee.y - leftKnee.y) / bodyScale
   * (y grows downward, so a POSITIVE value means the left knee is higher).
   *
   * Running in place is the only common movement that makes this signal
   * oscillate across zero at a steady rate with real amplitude:
   *   - swaying / shifting weight  -> both knees move together, amplitude stays
   *                                  inside the deadband
   *   - one-off leg lift           -> a single flip, never a repeating pattern
   *   - fidgeting                  -> flips at implausible/irregular intervals
   *
   * So we require: alternating sign flips, each past a deadband, at intervals
   * inside a plausible human range, consistent across several cycles, with
   * amplitude holding up. Only then is `running` true and a cadence reported.
   * ======================================================================== */
  class CadenceDetector {
    constructor(cfg) {
      this.cfg = cfg;
      this.reset();
    }

    reset() {
      this.buffer = [];          // rolling {t, v} history (for pattern inspection/debug)
      this.sign = 0;             // current side: +1 left knee up, -1 right knee up
      this.lastFlipTime = null;
      this.intervals = [];       // recent half-cycle durations (seconds/step)
      this.consecutive = 0;      // consecutive in-range alternating half-cycles
      this.halfPeak = 0;         // peak |v| within the current half cycle
      this.amplitude = 0;        // smoothed knee-lift amplitude, body-scale units
      this.cadence = 0;          // smoothed steps/sec
      this.rawCadence = 0;
      this.running = false;
      this.lastStepAt = null;    // for the debug readout / footfall animation
      this.stepCount = 0;
      this.lastUpdateT = null;   // previous update timestamp, for time-based decay
      // Deadband can be personalised at calibration; start from the config default.
      this.deadband = this.cfg.deadband;
      this.calibratedAmplitude = null;
    }

    /** Personalise the deadband + amplitude gate from calibration results. */
    setBaseline(kneeAmplitude) {
      if (kneeAmplitude > 0) {
        this.calibratedAmplitude = kneeAmplitude;
        this.deadband = clamp(
          this.cfg.amplitudeDeadbandRatio * kneeAmplitude,
          this.cfg.deadbandMin,
          this.cfg.deadbandMax
        );
      }
    }

    /**
     * @param {number} v  kneeDiff in body-scale units
     * @param {number} t  timestamp in seconds
     * @returns {{cadence:number, running:boolean, stepped:boolean}}
     */
    update(v, t) {
      const cfg = this.cfg;

      this.buffer.push({ t, v });
      if (this.buffer.length > cfg.bufferFrames) this.buffer.shift();

      this.halfPeak = Math.max(this.halfPeak, Math.abs(v));

      let stepped = false;
      const newSign = v > this.deadband ? 1 : v < -this.deadband ? -1 : 0;

      // A step = the signal crossing the deadband on the OPPOSITE side to the
      // side it was last on. Passing through the deadband (newSign 0) is not a
      // step by itself, which is what makes this robust to small wobbles.
      if (newSign !== 0 && newSign !== this.sign) {
        if (this.sign !== 0 && this.lastFlipTime !== null) {
          const interval = t - this.lastFlipTime;
          const sps = interval > 0 ? 1 / interval : 0;
          const inRange = sps >= cfg.minStepsPerSec && sps <= cfg.maxStepsPerSec;
          const amplitudeOk = this.halfPeak >= this.deadband;

          if (inRange && amplitudeOk) {
            this.intervals.push(interval);
            if (this.intervals.length > 6) this.intervals.shift();
            this.consecutive++;
            // Smoothed amplitude of the knee lift, used as a running-quality gate.
            this.amplitude = this.amplitude === 0
              ? this.halfPeak
              : this.amplitude + (this.halfPeak - this.amplitude) * 0.3;
            stepped = true;
            this.stepCount++;
            this.lastStepAt = t;
          } else {
            // Implausible interval or too-small movement: the pattern is broken.
            this.consecutive = 0;
            this.intervals.length = 0;
          }
        }
        this.sign = newSign;
        this.lastFlipTime = t;
        this.halfPeak = 0;
      }

      /* --- Is this a repeating pattern, not just two flips? ---------------- */
      let patternOk = false;
      if (this.consecutive >= cfg.minConsistentSteps && this.intervals.length >= 2) {
        const med = util.median(this.intervals);
        if (med > 0) {
          // Every recent interval must sit within maxIntervalVariance of the median.
          let consistent = true;
          for (let i = 0; i < this.intervals.length; i++) {
            if (Math.abs(this.intervals[i] - med) / med > cfg.maxIntervalVariance) {
              consistent = false;
              break;
            }
          }
          // Amplitude must hold up against this player's calibrated knee lift.
          const ampFloor = this.calibratedAmplitude
            ? this.calibratedAmplitude * cfg.minAmplitudeRatio
            : this.deadband;
          if (consistent && this.amplitude >= ampFloor) {
            patternOk = true;
            this.rawCadence = 1 / med;
          }
        }
      }

      /* --- Smooth, or decay when the player stops -------------------------- */
      const sinceFlip = this.lastFlipTime === null ? Infinity : t - this.lastFlipTime;
      if (patternOk && sinceFlip <= cfg.flipTimeout) {
        this.cadence += (this.rawCadence - this.cadence) * cfg.smoothing;
        this.running = true;
      } else {
        // Decay rather than snapping to zero: a single missed frame or one
        // sloppy stride shouldn't read as "stopped dead". Time-based, so the
        // decay feels the same whatever rate frames arrive at.
        const dt = this.lastUpdateT === null
          ? 0
          : clamp(t - this.lastUpdateT, 0, 0.25);
        this.cadence *= Math.exp(-dt / cfg.decayTau);
        if (sinceFlip > cfg.flipTimeout) {
          this.consecutive = 0;
          this.intervals.length = 0;
        }
        if (this.cadence < cfg.stoppedThreshold) {
          this.cadence = 0;
          this.running = false;
          this.amplitude *= 0.9;
        }
      }

      this.lastUpdateT = t;
      return { cadence: this.cadence, running: this.running, stepped };
    }
  }

  /* ===========================================================================
   * PoseTracker
   * ======================================================================== */
  class PoseTracker extends util.Emitter {
    constructor(videoEl, config) {
      super();
      this.cfg = config || HP.CONFIG;
      this.video = videoEl;

      this.detector = null;
      this.stream = null;
      this.backend = null;
      this.running = false;
      this.frameIndex = 0;
      this._busy = false;
      this._rafId = null;

      this.filterBank = new HP.KeypointFilterBank({
        freq: this.cfg.filter.freq,
        mincutoff: this.cfg.filter.mincutoff,
        beta: this.cfg.filter.beta,
        dcutoff: this.cfg.filter.dcutoff,
      });

      this.cadenceDetector = new CadenceDetector(this.cfg.cadence);

      /* Per-session personal baseline, filled in by calibration.js.
       * Until then, gesture thresholds fall back to the config defaults and
       * paceRatio stays 0 (there is nothing to compare a cadence against). */
      this.baseline = {
        centerX: null,        // neutral shoulder/hip midpoint x, video px
        standingHipY: null,   // neutral hip midpoint y, video px
        bodyScale: null,      // neutral shoulder-to-hip distance, video px
        comfortableCadence: null, // steps/sec
        maxCadence: null,     // steps/sec
        kneeAmplitude: null,  // body-scale units
        runBobVelocity: null, // body-scale units/sec, hips during normal running
      };

      /* Live thresholds derived from the baseline (recomputed in applyBaseline). */
      this.thresholds = {
        jumpVelocity: this.cfg.gesture.jumpVelocityMin,
      };

      this.state = this._blankState();

      /* Gesture bookkeeping */
      this._leanZone = 0;
      this._lastLeanChangeMs = 0;
      this._lastJumpMs = 0;
      this._jumpReadySince = null; // when the jump conditions first held
      this._duckStartMs = 0;
      this._prevHipY = null;
      this._prevHipT = null;
      this._hipVel = 0;         // body-scale units/sec, positive = moving UP
      this._prevMetricT = null; // for the centre drift correction's timestep
      this._lostSince = null;
      this._processedFrames = 0;
      this._fpsWindowStart = util.now();
      this._processFps = 0;
      this.keypoints = null;    // filtered keypoints of the latest good frame
      this.keypointMap = null;
    }

    _blankState() {
      return {
        tracked: false,
        confidence: 0,
        fullBody: false,
        currentCadence: 0,
        cadenceCyclesPerSec: 0,
        paceRatio: 0,
        effortPercent: 0,   // where the player sits in THEIR OWN range, 0-100
        running: false,
        laneIntent: 0,
        ducking: false,
        airborne: false,
        bodyScale: 0,
        // Raw video-pixel positions. Only calibration.js uses these — it has to
        // measure the neutral pose BEFORE a baseline exists to normalise against.
        centerXpx: 0,
        hipYpx: 0,
        centerOffset: 0,    // body-scale units, +ve = player's right
        hipOffset: 0,       // body-scale units, +ve = hips BELOW neutral
        hipVelocity: 0,     // body-scale units/sec, +ve = up
        kneeDiff: 0,
        // Keypoints re-expressed in body-scale units from the hip midpoint.
        // Wall Mode's pose matcher reads this; the running mode ignores it.
        poseNorm: null,
        amplitude: 0,
        stepCount: 0,
        processFps: 0,
        missingKeypoints: [],
      };
    }

    /* -----------------------------------------------------------------------
     * Init: TF.js backend (explicitly WebGL) + MoveNet
     * -------------------------------------------------------------------- */
    async init() {
      if (typeof tf === 'undefined') {
        throw new Error('TensorFlow.js failed to load (vendor/tf-core.min.js).');
      }
      if (typeof poseDetection === 'undefined') {
        throw new Error('pose-detection failed to load (vendor/pose-detection.min.js).');
      }

      /* --- Explicitly select the WebGL backend --------------------------- */
      // Not optional on mobile: the CPU backend runs MoveNet at ~2-4 fps, which
      // is far too slow to see a knee alternation pattern at all. If WebGL is
      // unavailable we fall back to CPU but say so loudly, because the whole
      // mechanic will feel broken.
      let backendNote = '';
      try {
        await tf.setBackend('webgl');
        await tf.ready();
      } catch (err) {
        console.warn('[HP] WebGL backend unavailable, falling back to CPU:', err);
        backendNote = ' (WebGL failed — pose detection will be far too slow)';
        try {
          await tf.setBackend('cpu');
          await tf.ready();
        } catch (err2) {
          throw new Error('No usable TF.js backend: ' + err2.message);
        }
      }
      this.backend = tf.getBackend();

      if (this.cfg.debug.logBackend) {
        console.log(
          '%c[HP] TF.js backend: ' + this.backend + backendNote,
          'font-weight:bold;color:' + (this.backend === 'webgl' ? '#12b886' : '#e8590c')
        );
        console.log('[HP] TF.js version:', (tf.version && tf.version.tfjs) || tf.version_core || 'unknown');
      }
      this.emit('backend', { backend: this.backend, ok: this.backend === 'webgl' });

      /* --- Create the MoveNet detector ----------------------------------- */
      const detectorConfig = {
        modelType: this.cfg.pose.modelType,
        enableSmoothing: this.cfg.pose.enableSmoothing,
        minPoseScore: this.cfg.pose.minPoseScore,
      };
      // Only set modelUrl when the config asks for it, otherwise the library
      // uses its own default hosted model.
      if (this.cfg.pose.modelUrl) detectorConfig.modelUrl = this.cfg.pose.modelUrl;

      const t0 = util.now();
      this.detector = await poseDetection.createDetector(
        poseDetection.SupportedModels.MoveNet,
        detectorConfig
      );
      if (this.cfg.debug.logBackend) {
        console.log('[HP] MoveNet ' + this.cfg.pose.modelType +
          ' loaded in ' + ((util.now() - t0) * 1000).toFixed(0) + 'ms');
      }

      this.emit('ready', { backend: this.backend });
      return this.backend;
    }

    /* -----------------------------------------------------------------------
     * Camera
     * -------------------------------------------------------------------- */
    async startCamera() {
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error(
          'getUserMedia is unavailable. On a phone the page must be served over ' +
          'HTTPS (or localhost) — see the README.'
        );
      }

      const c = this.cfg.camera;

      /* Widest-view request. aspectRatio is stated explicitly as well as
       * width/height because some implementations honour one and ignore the
       * other, and getting 16:9 instead of 4:3 silently crops away the vertical
       * field of view this game depends on. */
      const preferred = {
        facingMode: c.facingMode,
        width: { ideal: c.width },
        height: { ideal: c.height },
        aspectRatio: { ideal: c.width / c.height },
        frameRate: { ideal: c.frameRate },
        resizeMode: c.resizeMode,
      };

      const deviceId = c.preferWideAngleDevice ? await this._findWideAngleCamera() : null;
      if (deviceId) preferred.deviceId = { exact: deviceId };

      /* Fall back rather than fail. Unknown constraint keys are ignored by
       * browsers, but an exact deviceId or an unsatisfiable aspectRatio can
       * throw OverconstrainedError — and a working narrow camera beats no
       * camera at all. */
      try {
        this.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: preferred });
      } catch (err) {
        console.warn('[HP] widest-view constraints rejected (' + err.name +
          '), retrying with defaults:', err.message);
        this.stream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: { facingMode: c.facingMode },
        });
      }
      this.video.srcObject = this.stream;
      // iOS Safari refuses to play an inline video without these attributes,
      // and Capacitor's WKWebView behaves the same way.
      this.video.setAttribute('playsinline', '');
      this.video.setAttribute('webkit-playsinline', '');
      this.video.muted = true;

      await new Promise((resolve, reject) => {
        let settled = false;
        const done = () => {
          if (settled) return;
          settled = true;
          resolve();
        };
        if (this.video.readyState >= 2 && this.video.videoWidth > 0) {
          done();
          return;
        }
        this.video.onloadedmetadata = done;
        this.video.onerror = () => {
          if (!settled) {
            settled = true;
            reject(new Error('Camera video element failed to load.'));
          }
        };
        setTimeout(done, 4000); // don't hang forever on a quirky browser
      });

      // play() must be triggered from a user gesture on iOS — the START button
      // in main.js is that gesture.
      try {
        await this.video.play();
      } catch (err) {
        console.warn('[HP] video.play() rejected:', err);
      }

      const track = this.stream.getVideoTracks()[0];
      await this._zoomOut(track);

      const settings = track && track.getSettings ? track.getSettings() : {};
      const vw = this.video.videoWidth, vh = this.video.videoHeight;
      console.log('[HP] camera:', vw + 'x' + vh,
        settings.frameRate ? '@' + Math.round(settings.frameRate) + 'fps' : '',
        '| aspect ' + (vw && vh ? (Math.max(vw, vh) / Math.min(vw, vh)).toFixed(2) : '?') + ':1',
        settings.resizeMode ? '| resizeMode ' + settings.resizeMode : '',
        settings.zoom !== undefined ? '| zoom ' + settings.zoom : '');
      // 4:3 is 1.33. Anything near 1.78 means we were given a 16:9 crop and lost
      // vertical view, which is the usual cause of "my feet are cut off".
      if (vw && vh && Math.max(vw, vh) / Math.min(vw, vh) > 1.5) {
        console.warn('[HP] camera returned a widescreen crop (' + vw + 'x' + vh +
          '). Vertical field of view is reduced — stand further back.');
      }

      return this.stream;
    }

    /**
     * Some devices expose more than one front camera, e.g. a normal and an
     * ultra-wide. Labels are only populated once permission has been granted, so
     * this returns null on a first-ever run and simply works on later ones.
     */
    async _findWideAngleCamera() {
      if (!navigator.mediaDevices.enumerateDevices) return null;
      try {
        const devices = await navigator.mediaDevices.enumerateDevices();
        const cams = devices.filter((d) => d.kind === 'videoinput' && d.label);
        if (cams.length < 2) return null;
        const hints = this.cfg.camera.wideAngleLabelHints || [];
        const front = cams.filter((d) => /front|user|face/i.test(d.label));
        const pool = front.length ? front : cams;
        const wide = pool.find((d) => {
          const label = d.label.toLowerCase();
          return hints.some((h) => label.indexOf(h) >= 0);
        });
        if (wide) console.log('[HP] using wide-angle camera:', wide.label);
        return wide ? wide.deviceId : null;
      } catch (e) {
        return null;
      }
    }

    /** Wind any digital zoom back to its minimum — "zoom out as far as it goes". */
    async _zoomOut(track) {
      if (!this.cfg.camera.zoomToMinimum) return;
      if (!track || !track.getCapabilities || !track.applyConstraints) return;
      let caps;
      try { caps = track.getCapabilities(); } catch (e) { return; }
      if (!caps || !caps.zoom || typeof caps.zoom.min !== 'number') return;
      const current = track.getSettings ? track.getSettings().zoom : undefined;
      if (current !== undefined && current <= caps.zoom.min) return;
      try {
        // `advanced` so a device that cannot honour it degrades instead of
        // throwing and killing an otherwise good stream.
        await track.applyConstraints({ advanced: [{ zoom: caps.zoom.min }] });
        console.log('[HP] zoomed out: ' + current + ' -> ' + caps.zoom.min +
          ' (range ' + caps.zoom.min + '-' + caps.zoom.max + ')');
      } catch (e) {
        console.warn('[HP] could not apply minimum zoom:', e.message);
      }
    }

    stopCamera() {
      if (this.stream) {
        this.stream.getTracks().forEach((t) => t.stop());
        this.stream = null;
      }
      if (this.video) this.video.srcObject = null;
    }

    /* -----------------------------------------------------------------------
     * Frame loop
     * -------------------------------------------------------------------- */
    start() {
      if (this.running) return;
      this.running = true;
      this.frameIndex = 0;
      this._fpsWindowStart = util.now();
      this._processedFrames = 0;
      const tick = () => {
        if (!this.running) return;
        this._rafId = requestAnimationFrame(tick);
        this._maybeProcess();
      };
      this._rafId = requestAnimationFrame(tick);
    }

    stop() {
      this.running = false;
      if (this._rafId !== null) {
        cancelAnimationFrame(this._rafId);
        this._rafId = null;
      }
    }

    /** Frame throttling: only run inference on every Nth animation frame. */
    _maybeProcess() {
      this.frameIndex++;
      if (this.frameIndex % this.cfg.pose.frameThrottle !== 0) return;
      // Never queue a second inference while one is in flight — on a slow phone
      // that would build an ever-growing backlog of stale frames.
      if (this._busy) return;
      if (!this.detector || !this.video || this.video.readyState < 2) return;
      if (!this.video.videoWidth) return;
      this._busy = true;
      this._processFrame().catch((err) => {
        console.error('[HP] pose frame error:', err);
        this.emit('error', err);
      }).then(() => {
        this._busy = false;
      });
    }

    async _processFrame() {
      const poses = await this.detector.estimatePoses(this.video, {
        maxPoses: 1,
        flipHorizontal: false, // we mirror ourselves, once, below
      });
      const t = util.now();

      /* processed-frames-per-second, for the debug readout */
      this._processedFrames++;
      if (t - this._fpsWindowStart >= 1) {
        this._processFps = this._processedFrames / (t - this._fpsWindowStart);
        this._processedFrames = 0;
        this._fpsWindowStart = t;
      }

      if (!poses || poses.length === 0 || !poses[0].keypoints) {
        this._handleLostPose(t);
        return;
      }

      const pose = poses[0];
      const vw = this.video.videoWidth;

      /* --- Mirror ONCE, here ---------------------------------------------
       * After this line every coordinate is in "the player's own frame":
       * smaller x is the player's left, which is also screen-left in the
       * mirrored selfie view the player is looking at. */
      const mirrored = pose.keypoints.map((kp) => ({
        name: kp.name,
        score: kp.score,
        x: this.cfg.camera.mirror ? vw - kp.x : kp.x,
        y: kp.y,
      }));

      /* --- One Euro Filter, BEFORE any threshold logic -------------------- */
      const kps = this.filterBank.apply(mirrored, t);
      const map = Object.create(null);
      for (let i = 0; i < kps.length; i++) map[kps[i].name] = kps[i];
      this.keypoints = kps;
      this.keypointMap = map;

      this._computeMetrics(map, t, pose.score);
    }

    _handleLostPose(t) {
      if (this._lostSince === null) this._lostSince = t;
      const s = this.state;
      s.tracked = false;
      s.confidence = 0;
      s.fullBody = false;
      s.processFps = this._processFps;
      // Let cadence decay naturally rather than zeroing it — a one-frame dropout
      // in the middle of a run shouldn't read as a dead stop. The game applies
      // its own tracking-loss grace on top of this.
      const res = this.cadenceDetector.update(0, t);
      s.currentCadence = res.cadence;
      s.cadenceCyclesPerSec = res.cadence / 2;
      s.running = res.running;
      s.paceRatio = this._paceRatioFor(res.cadence);
      s.poseNorm = null;   // nothing to match against without a pose
      this.emit('lost', { since: this._lostSince, t });
      this.emit('frame', s);
    }

    /* -----------------------------------------------------------------------
     * Metrics + gesture recognition
     * -------------------------------------------------------------------- */
    _computeMetrics(map, t, poseScore) {
      const cfg = this.cfg;
      const s = this.state;
      const nowMs = t * 1000;
      /* Time since the previous processed frame. Computed ONCE here and used by
       * everything below, because _prevMetricT is only advanced at the very end
       * of this method — reading it mid-method after an early update would
       * silently yield zero. Infinity on the first frame so any
       * "is the frame interval longer than X" test passes rather than divides. */
      const frameDt = this._prevMetricT === null
        ? Infinity
        : Math.max(0, t - this._prevMetricT);

      const ls = map.left_shoulder, rs = map.right_shoulder;
      const lh = map.left_hip, rh = map.right_hip;
      const lk = map.left_knee, rk = map.right_knee;

      /* --- Confidence bookkeeping ---------------------------------------- */
      const required = cfg.calibration.requiredKeypoints;
      let sum = 0;
      const missing = [];
      for (let i = 0; i < required.length; i++) {
        const kp = map[required[i]];
        const score = kp ? kp.score : 0;
        sum += score;
        if (score < cfg.pose.minKeypointScore) missing.push(required[i]);
      }
      const confidence = sum / required.length;
      const coreVisible = ls && rs && lh && rh &&
        ls.score >= cfg.pose.minKeypointScore && rs.score >= cfg.pose.minKeypointScore &&
        lh.score >= cfg.pose.minKeypointScore && rh.score >= cfg.pose.minKeypointScore;

      s.confidence = confidence;
      s.missingKeypoints = missing;
      s.fullBody = missing.length === 0;
      s.processFps = this._processFps;

      if (!coreVisible) {
        // Torso itself isn't reliable — nothing downstream can be trusted.
        this._handleLostPose(t);
        return;
      }

      if (!s.tracked) {
        this._lostSince = null;
        this.emit('found', { t });
      }
      s.tracked = true;

      /* --- Body scale: the distance-invariance trick ----------------------
       * Every threshold below is divided by this, so standing 6ft vs 10ft from
       * the phone doesn't change how big a lean or a hip drop has to be. */
      const shoulderMidX = (ls.x + rs.x) / 2;
      const shoulderMidY = (ls.y + rs.y) / 2;
      const hipMidX = (lh.x + rh.x) / 2;
      const hipMidY = (lh.y + rh.y) / 2;

      let bodyScale = util.dist(shoulderMidX, shoulderMidY, hipMidX, hipMidY);
      if (!(bodyScale > 8)) {
        // Degenerate torso (player side-on, or a bad read): fall back to
        // shoulder width, and finally to a fixed floor so we never divide by ~0.
        const shoulderWidth = Math.abs(ls.x - rs.x);
        bodyScale = shoulderWidth > 8 ? shoulderWidth * 1.4 : Math.max(bodyScale, 40);
      }
      s.bodyScale = bodyScale;

      /* --- Torso centre (lean reference) ---------------------------------- */
      const centerX = (shoulderMidX + hipMidX) / 2;
      const neutralCenterX = this.baseline.centerX !== null
        ? this.baseline.centerX
        : this.video.videoWidth / 2;
      const centerOffset = (centerX - neutralCenterX) / bodyScale;
      s.centerOffset = centerOffset;
      s.centerXpx = centerX;
      s.hipYpx = hipMidY;

      /* --- Hip height (duck / jump reference) ----------------------------- */
      const standingHipY = this.baseline.standingHipY !== null
        ? this.baseline.standingHipY
        : hipMidY;
      // Positive = hips BELOW the neutral standing height (a crouch).
      const hipOffset = (hipMidY - standingHipY) / bodyScale;
      s.hipOffset = hipOffset;

      /* --- Hip vertical velocity (jump detection) ------------------------- */
      if (this._prevHipY !== null && this._prevHipT !== null) {
        const dt = t - this._prevHipT;
        if (dt > 1e-3 && dt < 0.5) {
          // Screen y grows downward, so a NEGATIVE dy is upward movement.
          const velUp = -((hipMidY - this._prevHipY) / bodyScale) / dt;
          // Light extra smoothing: the position is already One Euro filtered,
          // but a derivative always amplifies whatever noise is left.
          this._hipVel += (velUp - this._hipVel) * 0.5;
        }
      }
      this._prevHipY = hipMidY;
      this._prevHipT = t;
      s.hipVelocity = this._hipVel;

      /* --- Cadence -------------------------------------------------------- */
      // kneeDiff > 0 means the LEFT knee is higher (smaller y).
      const kneesVisible = lk && rk &&
        lk.score >= cfg.pose.minKeypointScore && rk.score >= cfg.pose.minKeypointScore;
      const kneeDiff = kneesVisible ? (rk.y - lk.y) / bodyScale : 0;
      s.kneeDiff = kneeDiff;

      const cad = this.cadenceDetector.update(kneeDiff, t);
      s.currentCadence = cad.cadence;
      s.cadenceCyclesPerSec = cad.cadence / 2;
      s.running = cad.running;
      s.amplitude = this.cadenceDetector.amplitude;
      s.stepCount = this.cadenceDetector.stepCount;
      s.paceRatio = this._paceRatioFor(cad.cadence);
      s.effortPercent = this._effortPercentFor(cad.cadence);
      if (cad.stepped) this.emit('step', { t, cadence: cad.cadence });

      /* --- Lean -> lane intent -------------------------------------------
       * Absolute mapping (not incremental): lean left => LEFT lane, come back
       * to centre => CENTRE lane. With hysteresis so a running wobble near the
       * boundary can't strobe between lanes. */
      const g = cfg.gesture;
      let zone = this._leanZone;
      if (this._leanZone === 0) {
        if (centerOffset <= -g.leanEnter) zone = -1;
        else if (centerOffset >= g.leanEnter) zone = 1;
      } else {
        if (Math.abs(centerOffset) < g.leanExit) zone = 0;
        else if (this._leanZone === -1 && centerOffset >= g.leanEnter) zone = 1;
        else if (this._leanZone === 1 && centerOffset <= -g.leanEnter) zone = -1;
      }
      if (zone !== this._leanZone && nowMs - this._lastLeanChangeMs >= g.leanCooldownMs) {
        this._leanZone = zone;
        this._lastLeanChangeMs = nowMs;
        s.laneIntent = zone;
        if (zone === -1) this.emit('onLeanLeft', { offset: centerOffset });
        else if (zone === 1) this.emit('onLeanRight', { offset: centerOffset });
        else this.emit('onCenter', { offset: centerOffset });
      }

      /* --- drift correction on the centre reference ----------------------
       * Only runs while the player already reads as centred, so it can never
       * cancel a held lane change. Without this, SIDE-STEPPING accumulates
       * error until the player sits permanently offset and the game reads it as
       * a deliberate hold. Leaning does not need it — planted feet re-centre
       * you for free — but the signal is the same for both, so stepping should
       * not be the worse option just because of bookkeeping. */
      if (
        g.centerDriftPerSec > 0 &&
        this.baseline.centerX !== null &&
        this._leanZone === 0 &&
        Math.abs(centerOffset) < g.leanExit &&
        frameDt !== Infinity
      ) {
        this.baseline.centerX = util.approach(
          this.baseline.centerX, centerX, g.centerDriftPerSec,
          clamp(frameDt, 0, 0.25)
        );
      }

      /* --- Jump ----------------------------------------------------------
       * Must beat this player's own running bounce (threshold derived from the
       * warm-up capture) AND actually end up above neutral hip height. */
      const jumpThreshold = this.thresholds.jumpVelocity;
      /* Both conditions must hold for jumpConfirmSeconds, because a single
       * frame's noise spike can satisfy them simultaneously and velocity noise
       * grows as the frame interval shrinks.
       *
       * The frameDt escape hatch is what keeps this from punishing slow devices:
       * once frames are further apart than the confirm window, one sample
       * already spans it, so the jump fires on the first qualifying frame. Fast
       * devices — where derivative noise is worst — get the protection; slow
       * ones lose the protection rather than losing the jump. */
      const jumpReady = this._hipVel >= jumpThreshold && -hipOffset >= g.jumpRiseMin;
      const confirmWindow = g.jumpConfirmSeconds || 0;
      if (!jumpReady) {
        this._jumpReadySince = null;
      } else if (this._jumpReadySince === null) {
        this._jumpReadySince = t;
      }
      const heldLongEnough = jumpReady && (
        t - this._jumpReadySince >= confirmWindow || frameDt >= confirmWindow
      );
      if (heldLongEnough && nowMs - this._lastJumpMs >= g.jumpCooldownMs) {
        this._jumpReadySince = null;
        this._lastJumpMs = nowMs;
        s.airborne = true;
        this.emit('onJump', { velocity: this._hipVel, rise: -hipOffset });
      } else if (s.airborne && nowMs - this._lastJumpMs > g.jumpCooldownMs) {
        s.airborne = false;
      }

      /* --- Duck ----------------------------------------------------------- */
      if (!s.ducking) {
        if (hipOffset >= g.duckEnter) {
          s.ducking = true;
          this._duckStartMs = nowMs;
          this.emit('onDuck', { drop: hipOffset });
        }
      } else if (hipOffset < g.duckExit && nowMs - this._duckStartMs >= g.duckMinHoldMs) {
        s.ducking = false;
        this.emit('onDuckEnd', { drop: hipOffset });
      }

      /* Normalised pose for Wall Mode's matcher. Hip-anchored and body-scale
       * divided, so it is translation- and scale-invariant — the same property
       * every threshold above relies on. Cheap: one pass over 17 keypoints. */
      s.poseNorm = HP.poseLib ? HP.poseLib.normalise(map, bodyScale) : null;

      // Advance the frame clock last, so every consumer above saw the real
      // interval since the previous frame.
      this._prevMetricT = t;
      this.emit('frame', s);
    }

    /* paceRatio: 1.0 == this player's own comfortable pace. */
    _paceRatioFor(cadence) {
      const comfortable = this.baseline.comfortableCadence;
      if (!comfortable || comfortable <= 0) return 0;
      return clamp(cadence / comfortable, 0, this.cfg.pace.maxRatio);
    }

    /* Where the player sits inside THEIR OWN comfortable..max band, 0-100. */
    _effortPercentFor(cadence) {
      const b = this.baseline;
      if (!b.comfortableCadence) return 0;
      const max = b.maxCadence && b.maxCadence > b.comfortableCadence
        ? b.maxCadence
        : b.comfortableCadence * this.cfg.calibration.assumedMaxRatio;
      return clamp((cadence / max) * 100, 0, 130);
    }

    /* -----------------------------------------------------------------------
     * Baseline (called by calibration.js at the end of the flow)
     * -------------------------------------------------------------------- */
    applyBaseline(baseline) {
      Object.assign(this.baseline, baseline);

      // Personalise the cadence deadband from the measured knee-lift amplitude.
      if (this.baseline.kneeAmplitude) {
        this.cadenceDetector.setBaseline(this.baseline.kneeAmplitude);
      }

      // Jump must clearly exceed this player's own running bob.
      const g = this.cfg.gesture;
      const bob = this.baseline.runBobVelocity || 0;
      this.thresholds.jumpVelocity = Math.max(
        g.jumpVelocityMin,
        bob * g.jumpVelocityMargin
      );

      console.log('[HP] session baseline:', {
        comfortableCadence: round2(this.baseline.comfortableCadence),
        maxCadence: round2(this.baseline.maxCadence),
        kneeAmplitude: round2(this.baseline.kneeAmplitude),
        deadband: round2(this.cadenceDetector.deadband),
        jumpVelocityThreshold: round2(this.thresholds.jumpVelocity),
        standingHipY: round2(this.baseline.standingHipY),
        centerX: round2(this.baseline.centerX),
      });
      this.emit('baseline', this.baseline);
    }

    /** Clear per-run gesture state without dropping the calibrated baseline. */
    resetRunState() {
      this.cadenceDetector.reset();
      if (this.baseline.kneeAmplitude) {
        this.cadenceDetector.setBaseline(this.baseline.kneeAmplitude);
      }
      this.filterBank.reset();
      this._leanZone = 0;
      this._prevHipY = null;
      this._prevHipT = null;
      this._prevMetricT = null;
      this._hipVel = 0;
      this._jumpReadySince = null;
      this.state = this._blankState();
    }

    /* -----------------------------------------------------------------------
     * Debug overlay — draws the detected skeleton over the camera feed so
     * tracking accuracy can be checked visually while testing.
     * -------------------------------------------------------------------- */
    drawDebug(canvas) {
      if (!canvas) return;
      const ctx = canvas.getContext('2d');
      const dpr = window.devicePixelRatio || 1;
      const cssW = canvas.clientWidth || canvas.width;
      const cssH = canvas.clientHeight || canvas.height;
      if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
        canvas.width = Math.round(cssW * dpr);
        canvas.height = Math.round(cssH * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, cssW, cssH);

      const kps = this.keypointMap;
      if (!kps || !this.video || !this.video.videoWidth) return;

      /* Replicate the video element's own object-fit/object-position so the
       * skeleton lands exactly over the visible image. The fit mode is READ from
       * computed style rather than assumed, because it differs between
       * calibration (contain) and play (cover) — see the CSS.
       * Note the video element is CSS-mirrored and our coordinates are already
       * mirrored, so no extra flip belongs here. */
      const vw = this.video.videoWidth;
      const vh = this.video.videoHeight;
      const cs = window.getComputedStyle(this.video);
      const scale = cs.objectFit === 'contain'
        ? Math.min(cssW / vw, cssH / vh)
        : Math.max(cssW / vw, cssH / vh);
      // object-position as fractions; default '50% 50%' if unparseable.
      const pos = (cs.objectPosition || '50% 50%').split(/\s+/);
      const fx = parseFloat(pos[0]) / 100;
      const fy = parseFloat(pos.length > 1 ? pos[1] : pos[0]) / 100;
      const offX = (cssW - vw * scale) * (isNaN(fx) ? 0.5 : fx);
      const offY = (cssH - vh * scale) * (isNaN(fy) ? 0.5 : fy);
      const px = (x) => offX + x * scale;
      const py = (y) => offY + y * scale;

      const minScore = this.cfg.pose.minKeypointScore;

      /* Bones */
      ctx.lineWidth = Math.max(2, 3.5 * (cssW / 400));
      ctx.lineCap = 'round';
      for (let i = 0; i < SKELETON_EDGES.length; i++) {
        const a = kps[SKELETON_EDGES[i][0]];
        const b = kps[SKELETON_EDGES[i][1]];
        if (!a || !b) continue;
        const weak = a.score < minScore || b.score < minScore;
        if (weak && !this.cfg.debug.drawLowConfidenceKeypoints) continue;
        ctx.strokeStyle = weak ? 'rgba(255,255,255,0.22)' : 'rgba(63,255,180,0.9)';
        ctx.beginPath();
        ctx.moveTo(px(a.x), py(a.y));
        ctx.lineTo(px(b.x), py(b.y));
        ctx.stroke();
      }

      /* Joints — knees and hips get emphasis because they drive the mechanics */
      const emphasised = { left_knee: 1, right_knee: 1, left_hip: 1, right_hip: 1 };
      const r = Math.max(3, 5 * (cssW / 400));
      Object.keys(kps).forEach((name) => {
        const kp = kps[name];
        const weak = kp.score < minScore;
        if (weak && !this.cfg.debug.drawLowConfidenceKeypoints) return;
        ctx.beginPath();
        ctx.arc(px(kp.x), py(kp.y), emphasised[name] ? r * 1.6 : r, 0, Math.PI * 2);
        ctx.fillStyle = weak
          ? 'rgba(255,255,255,0.25)'
          : emphasised[name] ? '#ffd43b' : '#3fffb4';
        ctx.fill();
      });

      /* Reference lines from the calibrated baseline: the centre the lean is
       * measured against, and the standing hip height duck/jump compare to. */
      if (this.baseline.centerX !== null) {
        ctx.strokeStyle = 'rgba(120,180,255,0.55)';
        ctx.lineWidth = 2;
        ctx.setLineDash([6, 6]);
        ctx.beginPath();
        ctx.moveTo(px(this.baseline.centerX), 0);
        ctx.lineTo(px(this.baseline.centerX), cssH);
        ctx.stroke();
        if (this.baseline.standingHipY !== null) {
          ctx.beginPath();
          ctx.moveTo(0, py(this.baseline.standingHipY));
          ctx.lineTo(cssW, py(this.baseline.standingHipY));
          ctx.stroke();
        }
        ctx.setLineDash([]);
      }

      /* Knee-alternation trace: the actual signal the cadence detector reads.
       * If this isn't a clean oscillation crossing the dashed deadband lines,
       * cadence detection will not work — this is the single most useful thing
       * to look at when tuning. */
      this._drawCadenceTrace(ctx, cssW, cssH);
    }

    _drawCadenceTrace(ctx, cssW, cssH) {
      const buf = this.cadenceDetector.buffer;
      if (!buf || buf.length < 2) return;
      const h = Math.min(90, cssH * 0.22);
      const w = cssW;
      const y0 = cssH - h - 4;
      const midY = y0 + h / 2;
      const vRange = 0.45; // body-scale units mapped to half the trace height

      ctx.fillStyle = 'rgba(0,0,0,0.45)';
      ctx.fillRect(0, y0, w, h);

      // Zero line + deadband band
      const db = this.cadenceDetector.deadband;
      const toY = (v) => midY - (v / vRange) * (h / 2);
      ctx.strokeStyle = 'rgba(255,255,255,0.35)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(0, midY);
      ctx.lineTo(w, midY);
      ctx.stroke();
      ctx.strokeStyle = 'rgba(255,212,59,0.6)';
      ctx.setLineDash([4, 4]);
      [db, -db].forEach((v) => {
        ctx.beginPath();
        ctx.moveTo(0, toY(v));
        ctx.lineTo(w, toY(v));
        ctx.stroke();
      });
      ctx.setLineDash([]);

      // The signal
      ctx.strokeStyle = this.state.running ? '#3fffb4' : '#ff6b6b';
      ctx.lineWidth = 2;
      ctx.beginPath();
      for (let i = 0; i < buf.length; i++) {
        const x = (i / (buf.length - 1)) * w;
        const y = clamp(toY(buf[i].v), y0, y0 + h);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      ctx.fillStyle = 'rgba(255,255,255,0.75)';
      ctx.font = '600 11px system-ui, sans-serif';
      ctx.fillText('knee alternation (L−R)', 6, y0 + 13);
    }

    dispose() {
      this.stop();
      this.stopCamera();
      if (this.detector && this.detector.dispose) {
        try { this.detector.dispose(); } catch (e) { /* ignore */ }
      }
      this.detector = null;
    }
  }

  function round2(v) {
    return typeof v === 'number' ? Math.round(v * 100) / 100 : v;
  }

  HP.CadenceDetector = CadenceDetector;
  HP.PoseTracker = PoseTracker;
  HP.SKELETON_EDGES = SKELETON_EDGES;
})(window.HP);
