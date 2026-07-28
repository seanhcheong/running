/* =============================================================================
 * Small shared math / DOM helpers.
 * ========================================================================== */

window.HP = window.HP || {};

(function (HP) {
  'use strict';

  const util = {
    clamp(v, lo, hi) {
      return v < lo ? lo : v > hi ? hi : v;
    },

    lerp(a, b, t) {
      return a + (b - a) * t;
    },

    /**
     * Frame-rate independent exponential approach: moves `current` toward
     * `target`, closing `ratePerSec` of the remaining distance each second.
     */
    approach(current, target, ratePerSec, dt) {
      const t = 1 - Math.exp(-ratePerSec * dt);
      return current + (target - current) * t;
    },

    /** Inverse lerp, clamped to 0..1. */
    norm(v, lo, hi) {
      if (hi === lo) return 0;
      return util.clamp((v - lo) / (hi - lo), 0, 1);
    },

    median(arr) {
      if (!arr || arr.length === 0) return 0;
      const s = Array.prototype.slice.call(arr).sort((a, b) => a - b);
      const mid = s.length >> 1;
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    },

    mean(arr) {
      if (!arr || arr.length === 0) return 0;
      let sum = 0;
      for (let i = 0; i < arr.length; i++) sum += arr[i];
      return sum / arr.length;
    },

    /** p in 0..1 — e.g. percentile(samples, 0.9) for a robust "near max". */
    percentile(arr, p) {
      if (!arr || arr.length === 0) return 0;
      const s = Array.prototype.slice.call(arr).sort((a, b) => a - b);
      const idx = util.clamp(Math.round((s.length - 1) * p), 0, s.length - 1);
      return s[idx];
    },

    dist(ax, ay, bx, by) {
      const dx = ax - bx;
      const dy = ay - by;
      return Math.sqrt(dx * dx + dy * dy);
    },

    /** Monotonic clock in SECONDS. Used for every filter/threshold timestamp. */
    now() {
      return (typeof performance !== 'undefined' && performance.now
        ? performance.now()
        : Date.now()) / 1000;
    },

    /** Weighted pick: weights = {key: weight, ...} */
    weightedPick(weights) {
      const keys = Object.keys(weights);
      let total = 0;
      for (let i = 0; i < keys.length; i++) total += weights[keys[i]];
      let r = Math.random() * total;
      for (let i = 0; i < keys.length; i++) {
        r -= weights[keys[i]];
        if (r <= 0) return keys[i];
      }
      return keys[keys.length - 1];
    },

    /** Minimal event emitter — the pose tracker and game core both use this. */
    Emitter: class Emitter {
      constructor() {
        this._handlers = Object.create(null);
      }

      on(event, fn) {
        (this._handlers[event] || (this._handlers[event] = [])).push(fn);
        return this;
      }

      off(event, fn) {
        const list = this._handlers[event];
        if (!list) return this;
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
        return this;
      }

      emit(event, payload) {
        const list = this._handlers[event];
        if (!list) return;
        // Copy so a handler that unsubscribes mid-emit can't corrupt iteration.
        const snapshot = list.slice();
        for (let i = 0; i < snapshot.length; i++) {
          try {
            snapshot[i](payload);
          } catch (err) {
            console.error('[HP] handler error for "' + event + '"', err);
          }
        }
      }
    },

    /* --- tiny DOM helpers -------------------------------------------------- */
    $(sel) {
      return document.querySelector(sel);
    },

    show(el) {
      if (el) el.classList.remove('hidden');
    },

    hide(el) {
      if (el) el.classList.add('hidden');
    },

    setText(el, text) {
      if (el && el.textContent !== text) el.textContent = text;
    },

    /** Read a query-string flag: ?debug=1 / ?sim=1 */
    queryFlag(name) {
      try {
        const params = new URLSearchParams(window.location.search);
        if (!params.has(name)) return false;
        const v = params.get(name);
        return v === '' || v === '1' || v === 'true' || v === 'yes';
      } catch (e) {
        return false;
      }
    },
  };

  HP.util = util;
})(window.HP);
