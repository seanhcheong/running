/* =============================================================================
 * Huff&Puff — AUDIO CUES (WebAudio, synthesised, zero assets)
 * =============================================================================
 * The player is standing 6-10 feet from a phone while out of breath. They cannot
 * read small text and they are not looking at the screen continuously. So every
 * important state change gets an audio cue as well as a visual one:
 *
 *   the void is closing   -> a pulse that speeds up as it gets nearer
 *   your pace is dropping -> a falling two-tone
 *   obstacle ahead        -> a short blip, pitched by what you must do
 *   you were hit          -> a dull thud
 *   milestone             -> a rising chime
 *
 * Everything is generated with oscillators and a noise buffer, so there are no
 * audio files to load and nothing to 404 offline.
 *
 * The AudioContext MUST be created/resumed inside a user gesture (the START
 * button) or iOS Safari leaves it suspended and the game is silent.
 * ========================================================================== */

window.HP = window.HP || {};

(function (HP) {
  'use strict';

  const util = HP.util;

  class Audio {
    constructor(config) {
      this.cfg = (config || HP.CONFIG).audio;
      this.ctx = null;
      this.master = null;
      this.enabled = true;
      this.noiseBuffer = null;

      this._lastPaceDropMs = 0;
      this._lastObstacleMs = 0;
      this._nextPulseAt = 0;
      this._pulseUrgency = 0; // 0 = calm, 1 = touching
    }

    /** Call from a user gesture. Safe to call repeatedly. */
    async unlock() {
      if (!this.ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        if (!Ctx) {
          this.enabled = false;
          console.warn('[HP] WebAudio unavailable — running silent.');
          return false;
        }
        this.ctx = new Ctx();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.cfg.masterGain;
        this.master.connect(this.ctx.destination);
        this._buildNoise();
      }
      if (this.ctx.state === 'suspended') {
        try { await this.ctx.resume(); } catch (e) { /* ignore */ }
      }
      return this.ctx.state === 'running';
    }

    setEnabled(on) {
      this.enabled = !!on;
      if (this.master) {
        this.master.gain.value = this.enabled ? this.cfg.masterGain : 0;
      }
    }

    _buildNoise() {
      const len = Math.floor(this.ctx.sampleRate * 0.4);
      const buf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const data = buf.getChannelData(0);
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
      this.noiseBuffer = buf;
    }

    get _ok() {
      return this.enabled && this.ctx && this.ctx.state === 'running';
    }

    /* --- primitives ------------------------------------------------------- */

    /** A single shaped oscillator note. */
    _tone(opts) {
      if (!this._ok) return;
      const o = opts || {};
      const now = this.ctx.currentTime + (o.delay || 0);
      const dur = o.dur || 0.12;
      const osc = this.ctx.createOscillator();
      const gain = this.ctx.createGain();
      osc.type = o.type || 'sine';
      osc.frequency.setValueAtTime(o.freq || 440, now);
      if (o.toFreq) {
        osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.toFreq), now + dur);
      }
      const peak = (o.gain === undefined ? 0.5 : o.gain);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(peak, now + Math.min(0.02, dur * 0.3));
      gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      osc.connect(gain);
      gain.connect(this.master);
      osc.start(now);
      osc.stop(now + dur + 0.02);
    }

    /** Filtered noise burst — thuds, impacts, footfalls. */
    _noise(opts) {
      if (!this._ok || !this.noiseBuffer) return;
      const o = opts || {};
      const now = this.ctx.currentTime + (o.delay || 0);
      const dur = o.dur || 0.18;
      const src = this.ctx.createBufferSource();
      src.buffer = this.noiseBuffer;
      const filter = this.ctx.createBiquadFilter();
      filter.type = o.filterType || 'lowpass';
      filter.frequency.setValueAtTime(o.freq || 400, now);
      if (o.toFreq) {
        filter.frequency.exponentialRampToValueAtTime(Math.max(40, o.toFreq), now + dur);
      }
      const gain = this.ctx.createGain();
      gain.gain.setValueAtTime((o.gain === undefined ? 0.5 : o.gain), now);
      gain.gain.exponentialRampToValueAtTime(0.0001, now + dur);
      src.connect(filter);
      filter.connect(gain);
      gain.connect(this.master);
      src.start(now);
      src.stop(now + dur + 0.02);
    }

    /* --- cues ------------------------------------------------------------- */

    countdownBeep(n) {
      // Rising pitch per count so "3, 2, 1" is audibly a countdown.
      this._tone({ freq: 440 + (3 - n) * 110, dur: 0.14, type: 'triangle', gain: 0.5 });
    }

    go() {
      this._tone({ freq: 660, toFreq: 990, dur: 0.3, type: 'triangle', gain: 0.55 });
    }

    calibrationStepDone() {
      this._tone({ freq: 620, dur: 0.09, type: 'sine', gain: 0.4 });
      this._tone({ freq: 930, dur: 0.13, type: 'sine', gain: 0.4, delay: 0.09 });
    }

    /** Fires once per detected footfall — a quiet tick that confirms tracking. */
    step() {
      this._noise({ freq: 220, dur: 0.05, gain: 0.12 });
    }

    /**
     * Repeating danger pulse. Call every frame with the current gap; it decides
     * internally whether it's time to pulse and how urgent to sound.
     * @param {number} gap    current gap in world metres
     * @param {number} nowMs
     */
    updateDanger(gap, nowMs) {
      const g = HP.CONFIG.game;
      if (gap > g.gapDanger) {
        this._pulseUrgency = 0;
        return;
      }
      // 0 at the danger threshold, 1 when the void is touching the player.
      const urgency = util.clamp(1 - gap / Math.max(1, g.gapDanger), 0, 1);
      this._pulseUrgency = urgency;
      const period = util.lerp(this.cfg.dangerPulseSlowMs, this.cfg.dangerPulseFastMs, urgency);
      if (nowMs < this._nextPulseAt) return;
      this._nextPulseAt = nowMs + period;
      // Lower and louder as it closes in.
      this._tone({
        freq: util.lerp(150, 92, urgency),
        toFreq: util.lerp(120, 66, urgency),
        dur: 0.14,
        type: 'sawtooth',
        gain: util.lerp(0.22, 0.5, urgency),
      });
    }

    /** Rate-limited "you're slowing down" cue. */
    paceDrop(nowMs) {
      if (nowMs - this._lastPaceDropMs < this.cfg.paceDropCooldownMs) return;
      this._lastPaceDropMs = nowMs;
      this._tone({ freq: 520, toFreq: 300, dur: 0.26, type: 'sine', gain: 0.4 });
    }

    /** Pace recovered above the warning band. */
    paceRecovered() {
      this._tone({ freq: 380, toFreq: 620, dur: 0.2, type: 'sine', gain: 0.34 });
    }

    /**
     * Obstacle warning, pitched by the action required, so the sound alone tells
     * you what to do: high = jump, low = duck, mid double = change lane.
     */
    obstacleWarn(kind, nowMs) {
      if (nowMs - this._lastObstacleMs < this.cfg.obstacleCooldownMs) return;
      this._lastObstacleMs = nowMs;
      if (kind === 'low') {
        this._tone({ freq: 880, toFreq: 1180, dur: 0.13, type: 'square', gain: 0.3 });
      } else if (kind === 'high') {
        this._tone({ freq: 300, toFreq: 190, dur: 0.16, type: 'square', gain: 0.3 });
      } else {
        this._tone({ freq: 560, dur: 0.07, type: 'square', gain: 0.28 });
        this._tone({ freq: 560, dur: 0.07, type: 'square', gain: 0.28, delay: 0.11 });
      }
    }

    hit(hadShield) {
      this._noise({ freq: 900, toFreq: 90, dur: 0.3, gain: 0.7 });
      if (!hadShield) {
        this._tone({ freq: 150, toFreq: 70, dur: 0.4, type: 'sawtooth', gain: 0.4 });
      }
    }

    jump() {
      this._tone({ freq: 420, toFreq: 780, dur: 0.14, type: 'triangle', gain: 0.25 });
    }

    duck() {
      this._tone({ freq: 420, toFreq: 240, dur: 0.14, type: 'triangle', gain: 0.25 });
    }

    laneChange() {
      this._tone({ freq: 700, dur: 0.05, type: 'sine', gain: 0.16 });
    }

    milestone() {
      [523, 659, 784, 1047].forEach((f, i) => {
        this._tone({ freq: f, dur: 0.18, type: 'triangle', gain: 0.34, delay: i * 0.075 });
      });
    }

    shieldRegained() {
      this._tone({ freq: 780, toFreq: 1170, dur: 0.22, type: 'sine', gain: 0.3 });
    }

    gameOver() {
      this._tone({ freq: 330, toFreq: 60, dur: 1.1, type: 'sawtooth', gain: 0.5 });
      this._noise({ freq: 600, toFreq: 60, dur: 1.0, gain: 0.35, delay: 0.05 });
    }

    /** Tracking lost — distinct from danger so the player knows to step back in. */
    trackingLost() {
      this._tone({ freq: 240, dur: 0.1, type: 'square', gain: 0.3 });
      this._tone({ freq: 200, dur: 0.14, type: 'square', gain: 0.3, delay: 0.12 });
    }

    reset() {
      this._nextPulseAt = 0;
      this._lastPaceDropMs = 0;
      this._lastObstacleMs = 0;
      this._pulseUrgency = 0;
    }
  }

  HP.Audio = Audio;
})(window.HP);
