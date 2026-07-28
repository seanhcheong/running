/* =============================================================================
 * Huff&Puff — CALIBRATION FLOW
 * =============================================================================
 * Why calibration exists at all: "keep up or the void eats you" is only fair if
 * "keeping up" means *your* pace. A 22-year-old runner and a 60-year-old
 * beginner both run in place at a comfortable pace; the game measures that pace
 * and makes THAT the reference. Nothing in the game is tuned to an absolute
 * steps-per-minute number.
 *
 * The flow, in order:
 *   1 framing    — full body visible and held, plus a lighting check
 *   2 neutral    — stand still: captures the reference centre-line, standing hip
 *                  height and body scale that every gesture threshold uses
 *   3 warmup     — "run at a pace you could hold for a few minutes":
 *                  captures comfortableCadence, knee-lift amplitude, and the
 *                  hips' natural running bounce (so a jump can be told apart
 *                  from a bounce)
 *   4 maxEffort  — optional 3s of hard running, only used for the effort readout
 *   5 countdown  — 3, 2, 1, go
 *
 * Everything measured here is per-session (a fresh calibration each run), which
 * also means the numbers stay right if the player moves the phone or changes
 * shoes/lighting between sessions.
 * ========================================================================== */

window.HP = window.HP || {};

(function (HP) {
  'use strict';

  const util = HP.util;
  const clamp = util.clamp;

  const STEP_COPY = {
    framing: {
      title: 'Get your whole body in frame',
      instruction: 'Step back until your head AND feet are visible.',
      sub: 'Prop the phone against something at about knee height.',
    },
    neutral: {
      title: 'Stand still',
      instruction: 'Face the camera, arms relaxed, feet together.',
      sub: 'This sets your centre line and standing height.',
    },
    warmup: {
      title: 'Run in place — comfortably',
      instruction: 'A pace you could hold for a few minutes. Not a sprint.',
      sub: 'This becomes your target pace for the whole session.',
    },
    maxEffort: {
      title: 'Now push hard',
      instruction: 'Fast as you can for a few seconds.',
      sub: 'Optional — this only tunes the effort meter.',
    },
    countdown: {
      title: 'Get ready',
      instruction: 'Start running when it says GO.',
      sub: '',
    },
  };

  class Calibration extends util.Emitter {
    constructor(tracker, config, audio) {
      super();
      this.tracker = tracker;
      this.cfg = config || HP.CONFIG;
      this.audio = audio || null;

      this.step = null;
      this.active = false;
      this.skipMaxEffort = false;

      this._onFrame = (state) => this._handleFrame(state);
      this._reset();
    }

    _reset() {
      const t = util.now();
      this.stepStart = t;
      this.holdStart = null;
      this.lowConfSince = null;
      this.trackingLostSince = null;
      this.lastHint = '';

      this.samples = {
        centerX: [],
        hipY: [],
        bodyScale: [],
        warmupCadence: [],
        warmupAmplitude: [],
        warmupHipVelUp: [],
        maxCadence: [],
        maxHipVelUp: [],
      };

      this.result = {
        centerX: null,
        standingHipY: null,
        bodyScale: null,
        comfortableCadence: null,
        maxCadence: null,
        kneeAmplitude: null,
        runBobVelocity: null,
      };

      this._countdownValue = null;
      this._warmupAttempts = 0;
    }

    /* -----------------------------------------------------------------------
     * Lifecycle
     * -------------------------------------------------------------------- */
    start() {
      if (this.active) return;
      this._reset();
      this.active = true;
      this.tracker.on('frame', this._onFrame);
      this._goto('framing');
    }

    abort() {
      if (!this.active) return;
      this.active = false;
      this.tracker.off('frame', this._onFrame);
      this.emit('aborted', {});
    }

    /** The "skip" button on the max-effort step. */
    skipCurrentStep() {
      if (this.step === 'maxEffort') {
        this.skipMaxEffort = true;
        this._finishMaxEffort();
      }
    }

    _goto(step) {
      this.step = step;
      this.stepStart = util.now();
      this.holdStart = null;
      this.lowConfSince = null;
      this.lastHint = '';
      const copy = STEP_COPY[step] || { title: '', instruction: '', sub: '' };
      this.emit('step', {
        id: step,
        index: ['framing', 'neutral', 'warmup', 'maxEffort', 'countdown'].indexOf(step) + 1,
        total: 5,
        title: copy.title,
        instruction: copy.instruction,
        sub: copy.sub,
        canSkip: step === 'maxEffort',
      });
      this.emit('progress', { value: 0, label: '' });
    }

    _hint(text) {
      if (text === this.lastHint) return;
      this.lastHint = text;
      this.emit('hint', { text: text });
    }

    /* -----------------------------------------------------------------------
     * Per-frame driver
     * -------------------------------------------------------------------- */
    _handleFrame(s) {
      if (!this.active) return;
      const t = util.now();
      const elapsed = t - this.stepStart;

      /* Tracking loss is handled the same way in every step: give it a moment
       * (a single dropped frame is normal), then send the player back to the
       * framing step rather than quietly recording garbage. */
      if (!s.tracked) {
        if (this.trackingLostSince === null) this.trackingLostSince = t;
        if (t - this.trackingLostSince > 1.5 && this.step !== 'framing') {
          this._hint('Lost you — step back into frame.');
          this._goto('framing');
          return;
        }
        if (this.step !== 'framing') return;
      } else {
        this.trackingLostSince = null;
      }

      switch (this.step) {
        case 'framing': return this._stepFraming(s, t, elapsed);
        case 'neutral': return this._stepNeutral(s, t, elapsed);
        case 'warmup': return this._stepWarmup(s, t, elapsed);
        case 'maxEffort': return this._stepMaxEffort(s, t, elapsed);
        case 'countdown': return this._stepCountdown(s, t, elapsed);
      }
    }

    /* --- 1. framing ------------------------------------------------------- */
    _stepFraming(s, t) {
      const c = this.cfg.calibration;

      // Lighting / confidence check runs alongside framing: a pose can be
      // "complete" and still be too unreliable to calibrate against.
      if (s.tracked && s.confidence < c.lowConfidenceThreshold) {
        if (this.lowConfSince === null) this.lowConfSince = t;
        if (t - this.lowConfSince > c.lowConfidenceHintAfter) {
          this._hint('Tracking is weak — try brighter, more even light, and avoid a window behind you.');
        }
      } else {
        this.lowConfSince = null;
      }

      if (!s.fullBody) {
        this.holdStart = null;
        this.emit('progress', { value: 0, label: '' });
        if (!s.tracked) {
          this._hint('No one detected. Stand in front of the camera.');
        } else if (s.missingKeypoints.length) {
          this._hint(this._missingHint(s.missingKeypoints));
        }
        return;
      }

      this._hint('');
      if (this.holdStart === null) this.holdStart = t;
      const held = t - this.holdStart;
      this.emit('progress', {
        value: clamp(held / c.framingHoldSeconds, 0, 1),
        label: 'Hold still…',
      });

      if (held >= c.framingHoldSeconds) {
        if (this.audio) this.audio.calibrationStepDone();
        this._goto('neutral');
      }
    }

    /** Turn missing keypoints into an instruction the player can act on. */
    _missingHint(missing) {
      const has = (n) => missing.indexOf(n) >= 0;
      if (has('left_ankle') || has('right_ankle')) {
        return 'Your feet are out of frame — step back or tilt the phone down.';
      }
      if (has('left_knee') || has('right_knee')) {
        return 'Your knees are out of frame — step back a bit further.';
      }
      if (has('left_hip') || has('right_hip')) {
        return 'Step back so your hips are visible.';
      }
      return 'Move so your whole body is inside the frame.';
    }

    /* --- 2. neutral standing baseline ------------------------------------- */
    _stepNeutral(s, t) {
      const c = this.cfg.calibration;

      if (!s.fullBody) {
        this.holdStart = null;
        this.samples.centerX.length = 0;
        this.samples.hipY.length = 0;
        this.samples.bodyScale.length = 0;
        this._hint('Stay fully in frame.');
        this.emit('progress', { value: 0, label: '' });
        return;
      }

      // "Still" means the hips aren't travelling and the knees aren't
      // alternating. Without this check a player who starts jogging early would
      // bake a bouncing hip height into the standing reference, which would then
      // make every duck and jump threshold wrong.
      const still = Math.abs(s.hipVelocity) < 0.35 && Math.abs(s.kneeDiff) < 0.09;
      if (!still) {
        this.holdStart = null;
        this.samples.centerX.length = 0;
        this.samples.hipY.length = 0;
        this.samples.bodyScale.length = 0;
        this._hint('Hold still for a moment — not yet running.');
        this.emit('progress', { value: 0, label: '' });
        return;
      }

      this._hint('');
      if (this.holdStart === null) this.holdStart = t;
      this.samples.centerX.push(s.centerXpx);
      this.samples.hipY.push(s.hipYpx);
      this.samples.bodyScale.push(s.bodyScale);

      const held = t - this.holdStart;
      this.emit('progress', {
        value: clamp(held / c.neutralHoldSeconds, 0, 1),
        label: 'Measuring…',
      });

      if (held >= c.neutralHoldSeconds && this.samples.centerX.length >= 5) {
        // Median, not mean: immune to one bad frame at the start or end.
        this.result.centerX = util.median(this.samples.centerX);
        this.result.standingHipY = util.median(this.samples.hipY);
        this.result.bodyScale = util.median(this.samples.bodyScale);

        // Apply the geometric part of the baseline immediately, so lean / duck /
        // jump are already meaningful during the warm-up (and the debug overlay
        // can draw the reference lines).
        this.tracker.applyBaseline({
          centerX: this.result.centerX,
          standingHipY: this.result.standingHipY,
          bodyScale: this.result.bodyScale,
        });

        if (this.audio) this.audio.calibrationStepDone();
        this._goto('warmup');
      }
    }

    /* --- 3. comfortable pace --------------------------------------------- */
    _stepWarmup(s, t, elapsed) {
      const c = this.cfg.calibration;
      const remaining = Math.max(0, c.warmupSeconds - elapsed);

      this.emit('progress', {
        value: clamp(elapsed / c.warmupSeconds, 0, 1),
        label: remaining > 0.4 ? Math.ceil(remaining) + 's' : 'Got it',
        cadence: s.currentCadence,
      });

      // Ignore the lead-in: the player is still getting going, and those first
      // strides would drag the measured comfortable pace down.
      if (elapsed >= c.warmupIgnoreLeadIn) {
        if (s.running && s.currentCadence > 0) {
          this.samples.warmupCadence.push(s.currentCadence);
          if (s.amplitude > 0) this.samples.warmupAmplitude.push(s.amplitude);
        }
        // The hips bounce while running. Capturing how much lets the jump
        // threshold be set above THIS player's bounce instead of a guess.
        if (s.hipVelocity > 0) this.samples.warmupHipVelUp.push(s.hipVelocity);
      }

      if (elapsed >= c.warmupIgnoreLeadIn && !s.running) {
        this._hint('Keep going — lift your knees a little more.');
      } else if (s.running) {
        this._hint('');
      }

      if (elapsed >= c.warmupSeconds) this._finishWarmup();
    }

    _finishWarmup() {
      const c = this.cfg.calibration;
      const samples = this.samples.warmupCadence;

      if (samples.length < c.warmupMinSamples) {
        this._warmupAttempts++;
        if (this._warmupAttempts < 3) {
          this._hint('Didn\'t get a clear read — lift your knees higher and try again.');
          this.samples.warmupCadence.length = 0;
          this.samples.warmupAmplitude.length = 0;
          this.samples.warmupHipVelUp.length = 0;
          this._goto('warmup');
          return;
        }
        // Third attempt: proceed on the config floor rather than trapping the
        // player in a loop they can't get out of. The session will simply be
        // calibrated conservatively.
        this._hint('Using a gentle default pace — you can recalibrate later.');
      }

      // Median of the cadence samples = this player's comfortable pace, with a
      // floor so a barely-moving warm-up can't set an unloseable baseline.
      const measured = samples.length ? util.median(samples) : 0;
      this.result.comfortableCadence = Math.max(measured, c.comfortableCadenceFloor);
      this.result.kneeAmplitude = this.samples.warmupAmplitude.length
        ? util.median(this.samples.warmupAmplitude)
        : null;
      // 90th percentile, not max: one glitchy frame shouldn't define the bounce.
      this.result.runBobVelocity = util.percentile(this.samples.warmupHipVelUp, 0.9);

      if (this.audio) this.audio.calibrationStepDone();
      this._goto('maxEffort');
    }

    /* --- 4. optional max effort ------------------------------------------ */
    _stepMaxEffort(s, t, elapsed) {
      const c = this.cfg.calibration;
      const remaining = Math.max(0, c.maxEffortSeconds - elapsed);
      this.emit('progress', {
        value: clamp(elapsed / c.maxEffortSeconds, 0, 1),
        label: remaining > 0.4 ? Math.ceil(remaining) + 's' : 'Nice',
        cadence: s.currentCadence,
      });

      if (s.running && s.currentCadence > 0) this.samples.maxCadence.push(s.currentCadence);
      if (s.hipVelocity > 0) this.samples.maxHipVelUp.push(s.hipVelocity);

      if (elapsed >= c.maxEffortSeconds) this._finishMaxEffort();
    }

    _finishMaxEffort() {
      const samples = this.samples.maxCadence;
      if (samples.length >= 4) {
        const peak = util.percentile(samples, 0.9);
        // Only trust it if it actually beat the comfortable pace.
        if (peak > this.result.comfortableCadence * 1.05) {
          this.result.maxCadence = peak;
        }
      }
      // The bounce during a hard effort is bigger than during a jog — use
      // whichever is larger so the jump threshold clears both.
      const maxBob = util.percentile(this.samples.maxHipVelUp, 0.9);
      this.result.runBobVelocity = Math.max(this.result.runBobVelocity || 0, maxBob);

      if (this.audio) this.audio.calibrationStepDone();
      this._goto('countdown');
    }

    /* --- 5. countdown ---------------------------------------------------- */
    _stepCountdown(s, t, elapsed) {
      const c = this.cfg.calibration;
      const ticks = Math.floor(elapsed / c.countdownStepSeconds);
      const value = c.countdownFrom - ticks;

      if (value !== this._countdownValue && value > 0) {
        this._countdownValue = value;
        this.emit('countdown', { value: value });
        if (this.audio) this.audio.countdownBeep(value);
      }

      if (elapsed >= c.countdownFrom * c.countdownStepSeconds) {
        this.emit('countdown', { value: 0 });
        if (this.audio) this.audio.go();
        this._complete();
      }
    }

    _complete() {
      this.active = false;
      this.tracker.off('frame', this._onFrame);
      // Hand the full baseline to the tracker: this is what turns raw cadence
      // into paceRatio and personalises the gesture thresholds.
      this.tracker.applyBaseline(this.result);
      this.emit('done', Object.assign({}, this.result));
    }

    /* -----------------------------------------------------------------------
     * Debug / sim shortcut: skip straight to a plausible baseline without
     * making the tester run in place first (?sim=1).
     * -------------------------------------------------------------------- */
    applyFakeBaseline() {
      const v = this.tracker.video;
      const baseline = {
        centerX: v && v.videoWidth ? v.videoWidth / 2 : 320,
        standingHipY: v && v.videoHeight ? v.videoHeight * 0.55 : 264,
        bodyScale: 100,
        comfortableCadence: 2.6,
        maxCadence: 3.9,
        kneeAmplitude: 0.16,
        runBobVelocity: 0.8,
      };
      this.result = baseline;
      this.tracker.applyBaseline(baseline);
      this.emit('done', Object.assign({}, baseline));
      return baseline;
    }
  }

  HP.Calibration = Calibration;
  HP.CALIBRATION_COPY = STEP_COPY;
})(window.HP);
