/* =============================================================================
 * One Euro Filter — hand-written, no dependencies
 * =============================================================================
 * Reference: Casiez, Roussel & Vogel (CHI 2012), "1e Filter: A Simple
 * Speed-based Low-pass Filter for Noisy Input in Interactive Systems".
 *
 * Why this and not a plain moving average: pose keypoints are noisy at rest
 * (jitter that causes false gesture triggers) but must stay responsive during
 * fast movement (a jump must not be smoothed into nothing). A fixed low-pass
 * forces you to pick one. The One Euro Filter adapts its cutoff to the signal's
 * own speed: heavy smoothing when slow, light smoothing when fast.
 *
 *   alpha(cutoff, dt) = 1 / (1 + tau/dt),  tau = 1 / (2*pi*cutoff)
 *   dx      = (x - xPrev) / dt                      (raw derivative)
 *   edx     = lowpass(dx, alpha(dcutoff, dt))       (smoothed derivative)
 *   cutoff  = mincutoff + beta * |edx|              (speed-adaptive cutoff)
 *   out     = lowpass(x, alpha(cutoff, dt))
 *
 * Tunables live in HP.CONFIG.filter (mincutoff / beta) — see the comments there.
 * ========================================================================== */

window.HP = window.HP || {};

(function (HP) {
  'use strict';

  /** Plain exponential low-pass with an externally supplied alpha. */
  class LowPassFilter {
    constructor() {
      this.hasLastValue = false;
      this.lastRaw = 0;
      this.lastFiltered = 0;
    }

    filter(value, alpha) {
      let out;
      if (!this.hasLastValue) {
        out = value;
        this.hasLastValue = true;
      } else {
        out = alpha * value + (1 - alpha) * this.lastFiltered;
      }
      this.lastRaw = value;
      this.lastFiltered = out;
      return out;
    }

    reset() {
      this.hasLastValue = false;
      this.lastRaw = 0;
      this.lastFiltered = 0;
    }
  }

  class OneEuroFilter {
    /**
     * @param {object} opts
     * @param {number} opts.freq      initial sampling-rate estimate (Hz). Only
     *                                used before the first real dt is measured.
     * @param {number} opts.mincutoff smoothing floor for slow movement (Hz).
     *                                Lower = smoother + laggier.
     * @param {number} opts.beta      how fast the filter opens up for quick
     *                                movement. Higher = more responsive.
     * @param {number} opts.dcutoff   cutoff for the internal derivative filter.
     */
    constructor(opts) {
      const cfg = opts || {};
      this.freq = cfg.freq > 0 ? cfg.freq : 30;
      this.mincutoff = cfg.mincutoff > 0 ? cfg.mincutoff : 1.0;
      this.beta = typeof cfg.beta === 'number' ? cfg.beta : 0.0;
      this.dcutoff = cfg.dcutoff > 0 ? cfg.dcutoff : 1.0;

      this.xFilter = new LowPassFilter();
      this.dxFilter = new LowPassFilter();
      this.lastTimestamp = null; // seconds
    }

    /** alpha for a given cutoff frequency and timestep. */
    _alpha(cutoff, dt) {
      const tau = 1.0 / (2 * Math.PI * cutoff);
      return 1.0 / (1.0 + tau / dt);
    }

    /**
     * @param {number} value      new raw sample
     * @param {number} timestamp  sample time in SECONDS (monotonic)
     * @returns {number} filtered value
     */
    filter(value, timestamp) {
      let dt = 1 / this.freq;
      if (this.lastTimestamp !== null && timestamp > this.lastTimestamp) {
        dt = timestamp - this.lastTimestamp;
        // Guard against absurd timesteps (tab backgrounded, first frame after a
        // stall): fall back to the nominal rate rather than blowing up alpha.
        if (dt > 0.5 || dt < 1e-4) dt = 1 / this.freq;
        else this.freq = 1 / dt;
      }
      this.lastTimestamp = timestamp;

      // Speed of the signal, itself low-passed so noise doesn't inflate it.
      const prev = this.xFilter.hasLastValue ? this.xFilter.lastRaw : value;
      const dx = (value - prev) / dt;
      const edx = this.dxFilter.filter(dx, this._alpha(this.dcutoff, dt));

      // Adaptive cutoff: fast movement => higher cutoff => less smoothing.
      const cutoff = this.mincutoff + this.beta * Math.abs(edx);
      return this.xFilter.filter(value, this._alpha(cutoff, dt));
    }

    reset() {
      this.xFilter.reset();
      this.dxFilter.reset();
      this.lastTimestamp = null;
    }

    /** Live re-tuning (used by the debug panel). */
    setParams(mincutoff, beta) {
      if (typeof mincutoff === 'number' && mincutoff > 0) this.mincutoff = mincutoff;
      if (typeof beta === 'number' && beta >= 0) this.beta = beta;
    }
  }

  /**
   * A bank of One Euro Filters: one filter per keypoint per axis (x and y).
   * Everything downstream of this — cadence, lean, jump, duck, the debug
   * skeleton — reads the FILTERED coordinates, never the raw ones.
   */
  class KeypointFilterBank {
    constructor(opts) {
      this.opts = opts || {};
      this.filters = new Map(); // keypoint name -> {x: OneEuroFilter, y: OneEuroFilter}
    }

    _pair(name) {
      let pair = this.filters.get(name);
      if (!pair) {
        pair = {
          x: new OneEuroFilter(this.opts),
          y: new OneEuroFilter(this.opts),
        };
        this.filters.set(name, pair);
      }
      return pair;
    }

    /**
     * @param {Array<{name:string,x:number,y:number,score:number}>} keypoints
     * @param {number} timestamp seconds
     * @returns {Array} new array of filtered keypoints (input is not mutated)
     */
    apply(keypoints, timestamp) {
      const out = new Array(keypoints.length);
      for (let i = 0; i < keypoints.length; i++) {
        const kp = keypoints[i];
        const pair = this._pair(kp.name);
        out[i] = {
          name: kp.name,
          score: kp.score,
          // Raw values kept alongside so the debug overlay can visualise how
          // much the filter is actually doing.
          rawX: kp.x,
          rawY: kp.y,
          x: pair.x.filter(kp.x, timestamp),
          y: pair.y.filter(kp.y, timestamp),
        };
      }
      return out;
    }

    setParams(mincutoff, beta) {
      this.opts.mincutoff = mincutoff;
      this.opts.beta = beta;
      this.filters.forEach((pair) => {
        pair.x.setParams(mincutoff, beta);
        pair.y.setParams(mincutoff, beta);
      });
    }

    reset() {
      this.filters.forEach((pair) => {
        pair.x.reset();
        pair.y.reset();
      });
    }
  }

  HP.LowPassFilter = LowPassFilter;
  HP.OneEuroFilter = OneEuroFilter;
  HP.KeypointFilterBank = KeypointFilterBank;
})(window.HP);
