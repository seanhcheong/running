/* =============================================================================
 * Huff&Puff — APPLICATION WIRING
 * =============================================================================
 * This is the only file that knows about all the other modules at once. Its job
 * is to be the plumbing and nothing else:
 *
 *   PoseTracker  ──frame──▶  sim.signals        (pose → intent, every read)
 *                ──events──▶ sim.queueJump()    (discrete gestures)
 *   Calibration  ──events──▶ the calibration screen
 *   GameSim      ──events──▶ HUD, toasts, audio
 *   RunScene     ──drives──▶ sim.update(dt)     (one clock for sim + render)
 *
 * All the interesting decisions live elsewhere: thresholds in config.js, signal
 * processing in pose-tracker.js, rules in game.js. If you are tuning the game,
 * you almost certainly want config.js instead of this file.
 *
 * SCREEN FLOW
 *   start ─▶ camera + model ─▶ calibration ─▶ run ─▶ over ─┬─▶ run (same baseline)
 *                                                          └─▶ calibration
 *
 * URL FLAGS
 *   ?sim=1      no camera at all — drive the game from the keyboard. This is how
 *               you tune the game feel on a laptop without running in place.
 *   ?debug=1    skeleton overlay + numeric readout from the first frame
 *   ?canvas=1   force Phaser's canvas renderer, freeing the second WebGL context
 *               for TF.js (worth trying if a phone thermally throttles)
 * ========================================================================== */

window.HP = window.HP || {};

(function (HP) {
  'use strict';

  const util = HP.util;
  const CONFIG = HP.CONFIG;
  const clamp = util.clamp;

  const SIM_MODE = util.queryFlag('sim');
  const FORCE_CANVAS = util.queryFlag('canvas');

  /* ===========================================================================
   * DOM
   * ======================================================================== */
  const el = (id) => document.getElementById(id);

  const dom = {
    body: document.body,
    video: el('video'),
    debugCanvas: el('debugCanvas'),
    gameRoot: el('gameRoot'),

    hud: el('hud'),
    hudDistance: el('hudDistance'),
    hudSpeed: el('hudSpeed'),
    hudShields: el('hudShields'),
    gapWrap: util.$('.gap-wrap'),
    gapText: el('gapText'),
    gapFill: el('gapFill'),
    paceFill: el('paceFill'),
    paceTarget: el('paceTarget'),
    paceText: el('paceText'),
    cadenceText: el('cadenceText'),
    toast: el('toast'),
    trackingWarn: el('trackingWarn'),
    btnDebug: el('btnDebug'),
    btnMute: el('btnMute'),
    btnQuit: el('btnQuit'),

    screenStart: el('screenStart'),
    btnStart: el('btnStart'),
    simNote: el('simNote'),

    screenCalib: el('screenCalib'),
    calibPanel: util.$('.calib-panel'),
    calibIndex: el('calibIndex'),
    calibTitle: el('calibTitle'),
    calibInstruction: el('calibInstruction'),
    calibSub: el('calibSub'),
    calibProgress: el('calibProgress'),
    calibProgressLabel: el('calibProgressLabel'),
    calibHint: el('calibHint'),
    calibCadence: el('calibCadence'),
    btnCalibDebug: el('btnCalibDebug'),
    btnCalibSkip: el('btnCalibSkip'),
    btnCalibCancel: el('btnCalibCancel'),
    countdown: el('countdown'),

    screenOver: el('screenOver'),
    overTitle: el('overTitle'),
    overDistance: el('overDistance'),
    overTime: el('overTime'),
    overDodged: el('overDodged'),
    overHits: el('overHits'),
    overNote: el('overNote'),
    btnAgain: el('btnAgain'),
    btnRecalibrate: el('btnRecalibrate'),

    screenError: el('screenError'),
    errBody: el('errBody'),
    errHelp: el('errHelp'),
    btnRetry: el('btnRetry'),

    debugPanel: el('debugPanel'),
    debugText: el('debugText'),
    loading: el('loading'),
    loadingText: el('loadingText'),
  };

  /* ===========================================================================
   * STATE
   * ======================================================================== */
  const audio = new HP.Audio(CONFIG);
  const sim = new HP.GameSim(CONFIG);

  let tracker = null;         // null in sim mode
  let calibration = null;
  let game = null;            // Phaser.Game, created lazily on the first run
  let scene = null;

  let phase = 'start';        // start | loading | calibrating | running | over | error
  let debugOn = util.queryFlag('debug') || CONFIG.debug.overlayOnByDefault;
  let booted = false;         // camera + model are up

  let hudRafId = null;
  let toastTimer = null;
  let lastPaceBand = 'good';  // for the one-shot pace-drop / recovered cues
  let untrackedSince = null;
  let slowGpu = false;        // WebGL unavailable — the mechanic will feel broken
  let lowFpsSince = null;     // sustained-low-frame-rate watchdog (see checkFrameRate)
  let lowFpsWarned = false;

  /* Keyboard-driven stand-ins for the pose signals (sim mode only). */
  const simInput = { pace: 1.0, lane: 0, ducking: false, up: false, down: false };

  /* ===========================================================================
   * SCREENS
   * ======================================================================== */
  const SCREENS = ['screenStart', 'screenCalib', 'screenOver', 'screenError'];

  function showScreen(name) {
    SCREENS.forEach((key) => {
      if (key === name) util.show(dom[key]); else util.hide(dom[key]);
    });
  }

  /**
   * 'off'  hidden (start / game over)
   * 'full' full screen (calibration — the player must see their own framing)
   * 'pip'  corner mirror (playing — enough to notice you have drifted out)
   * cam-off deliberately keeps a geometry class so the element still has a size.
   */
  function setCameraMode(mode) {
    dom.body.classList.remove('cam-full', 'cam-pip', 'cam-off');
    if (mode === 'pip') dom.body.classList.add('cam-pip');
    else if (mode === 'full') dom.body.classList.add('cam-full');
    else dom.body.classList.add('cam-full', 'cam-off');
  }

  function showLoading(text) {
    util.setText(dom.loadingText, text);
    util.show(dom.loading);
  }

  function hideLoading() {
    util.hide(dom.loading);
  }

  function showError(err) {
    phase = 'error';
    console.error('[HP]', err);
    hideLoading();
    util.hide(dom.hud);
    setCameraMode('off');

    // Boot failed part-way, so release the camera rather than leaving the
    // indicator light on behind an error screen. TRY AGAIN re-boots from clean.
    if (tracker && !booted) {
      tracker.dispose();
      tracker = null;
      calibration = null;
    }
    util.setText(dom.errBody, errorMessage(err));
    dom.errHelp.innerHTML = errorHelp(err);
    showScreen('screenError');
  }

  /** Re-tag an error with the boot stage it came from, without mutating it. */
  function stageError(stage, err) {
    const e = new Error((err && err.message) || String(err));
    e.name = (err && err.name) || 'Error';
    e.hpStage = stage;
    return e;
  }

  /** Turn a getUserMedia / init failure into something a player can act on. */
  function errorMessage(err) {
    const name = err && err.name;
    if (err && err.hpStage === 'model') {
      return 'The pose model could not be loaded, so there is nothing to read ' +
        'your movement with.';
    }
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      return 'Camera permission was denied, so there is no way to see you run.';
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return 'No camera was found on this device.';
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return 'The camera is busy — another app or tab is probably using it.';
    }
    return (err && err.message) ? err.message : 'Something went wrong starting up.';
  }

  function errorHelp(err) {
    const name = err && err.name;
    const secure = window.isSecureContext;
    const parts = [];

    if (err && err.hpStage === 'model') {
      // The libraries in vendor/ are local; only the weights are not.
      parts.push(
        'All of the game\'s code is bundled locally, but MoveNet\'s weights are ' +
        'downloaded once on first run and cached. That download failed — you are ' +
        'either offline or on a network that blocks it.'
      );
      parts.push(
        'To remove that last request entirely, put the weights in ' +
        '<code>vendor/models/movenet-lightning/</code> and set ' +
        '<code>pose.modelUrl</code> in <code>js/config.js</code> — see the ' +
        'README section "Running fully offline".'
      );
      parts.push('The underlying error was: <code>' + escapeHtml(err.message) + '</code>');
    }
    if (!secure) {
      // By far the most common cause of a dead camera on a phone: the page was
      // opened over plain http from another machine on the LAN.
      parts.push(
        '<b>This page is not on a secure origin.</b> Browsers only grant camera ' +
        'access over <code>https://</code> or <code>localhost</code>. You are on ' +
        '<code>' + escapeHtml(window.location.origin) + '</code>.'
      );
    }
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      parts.push(
        'Reset the permission for this site in your browser settings ' +
        '(iOS: Settings → Safari → Camera; Android Chrome: the padlock in the ' +
        'address bar), then reload.'
      );
    }
    parts.push(
      'You can still try the game without a camera using keyboard controls: ' +
      '<code>' + escapeHtml(window.location.pathname) + '?sim=1</code>'
    );
    return parts.map((p) => '<p>' + p + '</p>').join('');
  }

  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  /* ===========================================================================
   * BOOT — camera + model. Must run inside the START click (iOS needs the user
   * gesture for both getUserMedia and video.play()).
   * ======================================================================== */
  async function boot() {
    if (booted) return;

    tracker = new HP.PoseTracker(dom.video, CONFIG);
    tracker.on('error', (err) => console.warn('[HP] tracker error:', err));
    // Wired before init() so the 'backend' event isn't missed.
    wireTracker();

    showLoading('Starting camera…');
    setCameraMode('full');
    await tracker.startCamera();

    showLoading('Loading the pose model…\nThis takes a few seconds the first time.');
    try {
      await tracker.init();
    } catch (err) {
      // Tagged because this failure has a completely different cause and cure
      // from a camera failure: the code is all local, but MoveNet's WEIGHTS are
      // fetched once. Offline or behind a filtering proxy, this is what breaks.
      throw stageError('model', err);
    }

    tracker.start();

    calibration = new HP.Calibration(tracker, CONFIG, audio);
    wireCalibration();

    booted = true;
    hideLoading();
  }

  /**
   * Copy the tracker's continuous signals into the sim. This is the ONLY place
   * pose state crosses into the game, which is what lets sim mode substitute a
   * keyboard for a camera without the sim knowing.
   */
  function pullSignals() {
    const s = tracker.state;
    const sig = sim.signals;
    sig.paceRatio = s.paceRatio;
    sig.running = s.running;
    sig.tracked = s.tracked;
    sig.laneIntent = s.laneIntent;
    sig.ducking = s.ducking;
    sig.cadence = s.currentCadence;
  }

  /* ===========================================================================
   * TRACKER → SIM
   * ======================================================================== */
  function wireTracker() {
    // Continuous signals are polled per frame; only the discrete gestures need
    // to be events, because missing one of those would lose an input entirely.
    tracker.on('frame', () => {
      if (phase === 'running') pullSignals();
    });

    tracker.on('onJump', () => {
      if (phase === 'running') sim.queueJump();
    });

    tracker.on('step', () => {
      if (phase === 'running') audio.step();
    });

    // Deferred rather than shown now: the toast lives inside the HUD, which is
    // still hidden while the model loads.
    tracker.on('backend', (info) => { slowGpu = !info.ok; });
  }

  /* ===========================================================================
   * CALIBRATION → SCREEN
   * ======================================================================== */
  function wireCalibration() {
    calibration.on('step', (s) => {
      util.setText(dom.calibIndex, String(s.index));
      util.setText(dom.calibTitle, s.title);
      util.setText(dom.calibInstruction, s.instruction);
      util.setText(dom.calibSub, s.sub);
      util.setText(dom.calibHint, '');
      util.setText(dom.calibCadence, '');
      dom.calibProgress.style.width = '0%';
      util.setText(dom.calibProgressLabel, '');
      if (s.canSkip) util.show(dom.btnCalibSkip); else util.hide(dom.btnCalibSkip);
    });

    calibration.on('progress', (p) => {
      dom.calibProgress.style.width = (p.value * 100).toFixed(1) + '%';
      util.setText(dom.calibProgressLabel, p.label || '');
      util.setText(dom.calibCadence,
        p.cadence ? Math.round(p.cadence * 60) + ' spm' : '');
    });

    calibration.on('hint', (h) => util.setText(dom.calibHint, h.text));

    calibration.on('countdown', (c) => {
      if (c.value > 0) {
        popCountdown(String(c.value));
      } else {
        popCountdown('GO');
        setTimeout(() => util.hide(dom.countdown), 420);
      }
    });

    calibration.on('done', () => beginRun(false));
    calibration.on('aborted', () => toStartScreen());
  }

  /** Show n in the big countdown element, restarting the pop animation. */
  function popCountdown(text) {
    util.setText(dom.countdown, text);
    util.show(dom.countdown);
    // Re-trigger the CSS animation by forcing a reflow between removals.
    dom.countdown.style.animation = 'none';
    void dom.countdown.offsetWidth;
    dom.countdown.style.animation = '';
  }

  function startCalibration() {
    phase = 'calibrating';
    sim.reset();
    util.hide(dom.hud);
    util.hide(dom.countdown);
    util.show(dom.calibPanel);
    setCameraMode('full');
    showScreen('screenCalib');
    calibration.start();
  }

  /* ===========================================================================
   * RUN
   * ======================================================================== */
  /**
   * @param {boolean} withCountdown  true when restarting on an existing
   *   baseline — the calibration flow ends with its own countdown, so counting
   *   again there would just delay a player who is already running.
   */
  async function beginRun(withCountdown) {
    sim.reset();
    audio.reset();
    // Start in the "not up to pace yet" band so the first cue the player hears
    // is the recovery ping as they get going, not a pace-drop warning.
    lastPaceBand = 'low';
    untrackedSince = null;
    lowFpsSince = null;
    lowFpsWarned = false;

    if (withCountdown) {
      // Reuse the calibration screen as a bare countdown backdrop.
      util.hide(dom.calibPanel);
      showScreen('screenCalib');
      await countdownAlone();
      util.show(dom.calibPanel);
    }

    phase = 'running';
    showScreen(null);
    util.hide(dom.countdown);
    util.hide(dom.trackingWarn);
    util.show(dom.hud);
    setCameraMode(SIM_MODE ? 'off' : 'pip');

    // Seed the signals before the first sim step. Without this the sim sees one
    // frame of tracked:false and announces a tracking loss at every run start.
    if (SIM_MODE) applySimInput(); else pullSignals();
    updateHud();

    ensureGame();
    sim.start();

    if (slowGpu) showToast('NO GPU — SLOW', 'hit', 2600);
  }

  function countdownAlone() {
    return new Promise((resolve) => {
      const c = CONFIG.calibration;
      let n = c.countdownFrom;
      const stepMs = c.countdownStepSeconds * 1000;
      const tick = () => {
        if (n > 0) {
          popCountdown(String(n));
          audio.countdownBeep(n);
          n--;
          setTimeout(tick, stepMs);
        } else {
          popCountdown('GO');
          audio.go();
          setTimeout(resolve, 420);
        }
      };
      tick();
    });
  }

  function ensureGame() {
    if (game) return;
    scene = new HP.RunScene({
      sim: sim,
      config: CONFIG,
      getCadence: () => sim.signals.cadence || 0,
    });
    game = new Phaser.Game({
      type: FORCE_CANVAS ? Phaser.CANVAS : Phaser.AUTO,
      parent: dom.gameRoot,
      transparent: true,   // the camera feed and page background show through
      scale: {
        mode: Phaser.Scale.RESIZE,
        autoCenter: Phaser.Scale.NO_CENTER,
        width: '100%',
        height: '100%',
      },
      // Target only drives Phaser's own loop. RunScene deliberately ignores the
      // `delta` Phaser hands it — that value is smoothed toward this target, so
      // it lies on any device that misses 60fps. See the note in RunScene.update.
      fps: { target: 60 },
      banner: false,
      scene: scene,
    });
  }

  function endRun(summary) {
    phase = 'over';
    audio.gameOver();
    util.hide(dom.hud);
    util.hide(dom.trackingWarn);
    setCameraMode('off');

    util.setText(dom.overTitle,
      summary.reason === 'quit' ? 'Run ended' : 'The void got you');
    util.setText(dom.overDistance, String(summary.distance));
    util.setText(dom.overTime, formatTime(summary.seconds));
    util.setText(dom.overDodged, String(summary.dodged));
    util.setText(dom.overHits, String(summary.hits));
    util.setText(dom.overNote, overNote(summary));
    showScreen('screenOver');
  }

  function overNote(s) {
    const pct = Math.round(s.avgPaceRatio * 100);
    if (!pct) {
      return 'No pace was recorded — check that your whole body stays in frame.';
    }
    const bits = ['You averaged ' + pct + '% of your comfortable pace.'];
    if (s.reason !== 'quit') {
      if (pct >= 105) bits.push('You were pushing well past it — the void just ran out of patience.');
      else if (pct >= 90) bits.push('Right on target. Next time bank some gap early.');
      else bits.push('Try holding your calibrated pace for longer before you dig in.');
    }
    return bits.join(' ');
  }

  function formatTime(seconds) {
    const s = Math.max(0, Math.floor(seconds));
    return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
  }

  function toStartScreen() {
    phase = 'start';
    util.hide(dom.hud);
    util.hide(dom.countdown);
    util.show(dom.calibPanel);
    setCameraMode('off');
    showScreen('screenStart');
  }

  /* ===========================================================================
   * SIM → HUD / AUDIO
   * ======================================================================== */
  function wireSim() {
    sim.on('hit', (e) => {
      audio.hit(e.hadShield);
      showToast(e.hadShield ? 'HIT' : 'NO SHIELD', 'hit', 900);
    });
    sim.on('dodge', () => { /* silent by design — only mistakes get a sound */ });
    sim.on('jump', () => audio.jump());
    sim.on('laneChange', () => audio.laneChange());
    sim.on('obstacleWarn', (e) => audio.obstacleWarn(e.kind, util.now() * 1000));

    sim.on('milestone', (e) => {
      audio.milestone();
      if (e.shieldRegained) audio.shieldRegained();
      showToast(e.distance + 'm', 'good', 1100);
    });

    sim.on('trackingLost', () => {
      audio.trackingLost();
      util.show(dom.trackingWarn);
    });
    sim.on('trackingRestored', () => util.hide(dom.trackingWarn));

    sim.on('gameover', (summary) => endRun(summary));
  }

  function showToast(text, cls, ms) {
    dom.toast.className = 'toast show' + (cls ? ' ' + cls : '');
    util.setText(dom.toast, text);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      dom.toast.className = 'toast';
    }, ms || 1000);
  }

  /* ===========================================================================
   * HUD LOOP
   * ---------------------------------------------------------------------------
   * Deliberately separate from the Phaser loop: the HUD is DOM, and it must keep
   * updating on the calibration and game-over screens too, when no scene is
   * running. Reads state, never writes it.
   * ======================================================================== */
  function startHudLoop() {
    if (hudRafId !== null) return;
    const tick = () => {
      hudRafId = requestAnimationFrame(tick);
      if (SIM_MODE && phase === 'running') applySimInput();
      if (phase === 'running') updateHud();
      if (debugOn) {
        if (tracker) tracker.drawDebug(dom.debugCanvas);
        updateDebugText();
      }
    };
    hudRafId = requestAnimationFrame(tick);
  }

  function updateHud() {
    const g = CONFIG.game;
    const sig = sim.signals;

    util.setText(dom.hudDistance, String(Math.floor(sim.distance)));
    util.setText(dom.hudSpeed, sim.speed.toFixed(1));

    /* --- shields ------------------------------------------------------- */
    util.setText(dom.hudShields, sim.shields > 0 ? '◆'.repeat(sim.shields) : '—');
    dom.hudShields.classList.toggle('empty', sim.shields <= 0);

    /* --- void proximity ------------------------------------------------ */
    dom.gapFill.style.width = (sim.gapFraction() * 100).toFixed(1) + '%';
    let gapState = '';
    let gapLabel = 'SAFE';
    if (sim.gap <= 0) { gapState = 'danger'; gapLabel = 'RUN!'; }
    else if (sim.gap < g.gapDanger) { gapState = 'danger'; gapLabel = 'ON YOU'; }
    else if (sim.gap < g.gapWarn) { gapState = 'warn'; gapLabel = 'CLOSING'; }
    dom.gapWrap.classList.toggle('warn', gapState === 'warn');
    dom.gapWrap.classList.toggle('danger', gapState === 'danger');
    util.setText(dom.gapText, gapLabel);

    /* --- pace ---------------------------------------------------------- */
    const ratio = sig.paceRatio || 0;
    const p = CONFIG.pace;
    dom.paceFill.style.width = (clamp(ratio / p.maxRatio, 0, 1) * 100).toFixed(1) + '%';
    const band = ratio >= 1.02 ? 'over'
      : ratio >= p.warnRatio ? 'good'
      : ratio >= p.dangerRatio ? 'warn'
      : 'low';
    dom.paceFill.className = 'pace-fill ' + band;
    util.setText(dom.paceText, ratio > 0 ? Math.round(ratio * 100) + '% PACE' : '—');
    util.setText(dom.cadenceText, Math.round((sig.cadence || 0) * 60) + ' spm');

    /* --- audio channel ------------------------------------------------- */
    const nowMs = util.now() * 1000;
    audio.updateDanger(sim.gap, nowMs);
    // Cues fire on band TRANSITIONS only. A cue on every frame below target
    // would be a drone the player quickly learns to ignore.
    const slow = band === 'low' || band === 'warn';
    const wasSlow = lastPaceBand === 'low' || lastPaceBand === 'warn';
    if (slow && !wasSlow) audio.paceDrop(nowMs);
    else if (!slow && wasSlow) audio.paceRecovered();
    lastPaceBand = band;

    if (!SIM_MODE) checkFrameRate();

    /* --- tracking warning ----------------------------------------------
     * Driven by state rather than the sim's freeze event, so the warning stays
     * up after the freeze grace expires and the void starts moving again. */
    if (!SIM_MODE) {
      if (!sig.tracked) {
        if (untrackedSince === null) untrackedSince = util.now();
        if (util.now() - untrackedSince > 0.6) util.show(dom.trackingWarn);
      } else {
        untrackedSince = null;
        util.hide(dom.trackingWarn);
      }
    }
  }

  /**
   * Sustained-low-frame-rate watchdog.
   *
   * This is not a performance nicety. Cadence detection reads sign flips in the
   * knee signal, so it is bound by sampling rate: too few pose reads per second
   * and fast running ALIASES — the intervals come out irregular, the consistency
   * gate rejects them, and cadence reads zero while the player is sprinting.
   * From the player's side the game simply stops responding and eats them, which
   * is the worst possible failure for a fitness game. So say so out loud.
   */
  function checkFrameRate() {
    if (!tracker || lowFpsWarned) return;
    const fps = tracker.state.processFps;
    // 0 means the fps window hasn't closed yet, not "infinitely slow".
    if (fps > 0 && fps < CONFIG.pose.minProcessFps) {
      if (lowFpsSince === null) lowFpsSince = util.now();
      else if (util.now() - lowFpsSince > 3) {
        lowFpsWarned = true;
        showToast('LOW FRAME RATE', 'hit', 2600);
        console.warn(
          '[HP] only ' + fps.toFixed(1) + ' pose reads/sec (need ' +
          CONFIG.pose.minProcessFps + '+). Fast running will not be detected ' +
          'reliably. Try ?canvas=1 to free a WebGL context, close other apps, ' +
          'or lower camera.width/height in js/config.js. Do NOT raise ' +
          'pose.frameThrottle — that samples even less often.'
        );
      }
    } else {
      lowFpsSince = null;
    }
  }

  function updateDebugText() {
    const lines = [];
    const sig = sim.signals;

    if (tracker) {
      const s = tracker.state;
      const cd = tracker.cadenceDetector;
      // The LOW marker is the first thing to check when cadence misbehaves.
      const slowFps = s.processFps > 0 && s.processFps < CONFIG.pose.minProcessFps;
      lines.push('backend  ' + tracker.backend + '   pose ' + s.processFps.toFixed(1) +
        '/s' + (slowFps ? ' LOW!' : ''));
      lines.push('tracked  ' + (s.tracked ? 'yes' : 'NO ') +
        '  conf ' + s.confidence.toFixed(2) +
        '  full ' + (s.fullBody ? 'y' : 'n'));
      if (s.missingKeypoints.length) {
        lines.push('missing  ' + s.missingKeypoints.join(' ').replace(/_/g, ''));
      }
      lines.push('cadence  ' + s.currentCadence.toFixed(2) + ' sps (' +
        Math.round(s.currentCadence * 60) + ' spm) ' + (s.running ? 'RUN' : '—'));
      lines.push('kneeDiff ' + s.kneeDiff.toFixed(3) +
        '  band ' + cd.deadband.toFixed(3) +
        '  amp ' + cd.amplitude.toFixed(3));
      lines.push('steps    ' + s.stepCount + '  consec ' + cd.consecutive);
      lines.push('lean     ' + s.centerOffset.toFixed(2) + ' → lane ' + s.laneIntent);
      lines.push('hipOff   ' + s.hipOffset.toFixed(2) + (s.ducking ? '  DUCK' : ''));
      lines.push('hipVel   ' + s.hipVelocity.toFixed(2) +
        ' / ' + tracker.thresholds.jumpVelocity.toFixed(2));
      lines.push('comfort  ' + fmt(tracker.baseline.comfortableCadence) + ' sps');
    } else {
      lines.push(SIM_MODE ? 'SIM MODE — no camera' : 'camera not started yet');
    }

    lines.push('pace     ' + (sig.paceRatio || 0).toFixed(2) +
      ' → speedNorm ' + sim.speedNormFor(sig.paceRatio || 0).toFixed(2));
    lines.push('speed    ' + sim.speed.toFixed(1) + '  void ' + sim.wallSpeed.toFixed(1));
    lines.push('gap      ' + sim.gap.toFixed(1) + '  grace ' + sim.grace.toFixed(1) +
      (sim.frozen ? '  FROZEN' : ''));
    lines.push('lane     ' + sim.lane.toFixed(2) + '→' + sim.targetLane +
      '  obst ' + sim.obstacles.length);
    lines.push('t        ' + sim.t.toFixed(1) + 's  status ' + sim.status);

    util.setText(dom.debugText, lines.join('\n'));
  }

  function fmt(v) {
    return typeof v === 'number' ? v.toFixed(2) : '—';
  }

  function setDebug(on) {
    debugOn = !!on;
    dom.btnDebug.classList.toggle('active', debugOn);
    dom.btnCalibDebug.classList.toggle('active', debugOn);
    if (debugOn) {
      util.show(dom.debugCanvas);
      util.show(dom.debugPanel);
    } else {
      util.hide(dom.debugCanvas);
      util.hide(dom.debugPanel);
    }
  }

  /* ===========================================================================
   * SIM-MODE KEYBOARD INPUT
   * ---------------------------------------------------------------------------
   * The point of this is not playability, it is that the whole game — pace
   * curve, void ramp, obstacle spacing — can be tuned at a desk. The keyboard
   * feeds exactly the same `signals` object the pose tracker writes to, so
   * nothing downstream can tell the difference.
   * ======================================================================== */
  function applySimInput() {
    const dt = 1 / 60;
    if (simInput.up) simInput.pace += 1.4 * dt;
    if (simInput.down) simInput.pace -= 1.8 * dt;
    // Bleed back toward the comfortable pace when nothing is held, so standing
    // on the keyboard is not the resting state.
    if (!simInput.up && !simInput.down) {
      simInput.pace = util.approach(simInput.pace, 1.0, 0.6, dt);
    }
    simInput.pace = clamp(simInput.pace, 0, CONFIG.pace.maxRatio);

    const sig = sim.signals;
    sig.paceRatio = simInput.pace;
    sig.cadence = simInput.pace * 2.6;   // plausible spm for the leg animation
    sig.running = simInput.pace > 0.3;
    sig.tracked = true;
    sig.laneIntent = simInput.lane;
    sig.ducking = simInput.ducking;
  }

  function onKeyDown(e) {
    if (e.key === 'd' || e.key === 'D') {
      setDebug(!debugOn);
      return;
    }
    if (!SIM_MODE) return;
    switch (e.key) {
      case 'ArrowUp': simInput.up = true; break;
      case 'ArrowDown': simInput.down = true; break;
      case 'ArrowLeft': simInput.lane = -1; break;
      case 'ArrowRight': simInput.lane = 1; break;
      case ' ': if (phase === 'running') sim.queueJump(); break;
      case 'Shift': simInput.ducking = true; break;
      default: return;
    }
    e.preventDefault();
  }

  function onKeyUp(e) {
    if (!SIM_MODE) return;
    switch (e.key) {
      case 'ArrowUp': simInput.up = false; break;
      case 'ArrowDown': simInput.down = false; break;
      case 'ArrowLeft': if (simInput.lane === -1) simInput.lane = 0; break;
      case 'ArrowRight': if (simInput.lane === 1) simInput.lane = 0; break;
      case 'Shift': simInput.ducking = false; break;
      default: return;
    }
    e.preventDefault();
  }

  /* ===========================================================================
   * BUTTONS
   * ======================================================================== */
  async function onStart() {
    if (phase === 'loading') return;
    phase = 'loading';
    // Both of these need the user gesture we are inside right now.
    await audio.unlock();

    try {
      if (SIM_MODE) {
        // No camera and no model. paceRatio comes straight off the keyboard, so
        // there is no baseline to calibrate — go straight to a countdown.
        booted = true;
        await beginRun(true);
      } else {
        await boot();
        startCalibration();
      }
    } catch (err) {
      showError(err);
    }
  }

  function wireButtons() {
    dom.btnStart.addEventListener('click', onStart);
    dom.btnRetry.addEventListener('click', () => {
      // A retry is a fresh attempt at boot, not a page reload: the model may
      // already be cached, and a permission grant needs a new user gesture.
      booted = false;
      if (tracker) { tracker.dispose(); tracker = null; }
      toStartScreen();
    });

    // Reachable during calibration, unlike the HUD's DEBUG button.
    dom.btnCalibDebug.addEventListener('click', () => setDebug(!debugOn));
    dom.btnCalibSkip.addEventListener('click', () => calibration && calibration.skipCurrentStep());
    dom.btnCalibCancel.addEventListener('click', () => calibration && calibration.abort());

    dom.btnAgain.addEventListener('click', () => {
      if (booted) beginRun(true);
      else toStartScreen();
    });
    dom.btnRecalibrate.addEventListener('click', () => {
      if (SIM_MODE || !calibration) beginRun(true);
      else startCalibration();
    });

    dom.btnDebug.addEventListener('click', () => setDebug(!debugOn));
    dom.btnMute.addEventListener('click', () => {
      audio.setEnabled(!audio.enabled);
      dom.btnMute.classList.toggle('active', audio.enabled);
    });
    dom.btnQuit.addEventListener('click', () => {
      if (phase === 'running') sim.end('quit');
    });

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
  }

  /* ===========================================================================
   * INIT
   * ======================================================================== */
  function init() {
    wireSim();
    wireButtons();

    // The pace meter's target line sits at paceRatio 1.0 — "your comfortable
    // pace" — on a bar that runs to maxRatio. Keep the two in sync from config.
    dom.paceTarget.style.left = (100 / CONFIG.pace.maxRatio).toFixed(2) + '%';

    dom.btnMute.classList.add('active');
    setDebug(debugOn);
    // Runs from the very first frame, not from START: with ?debug=1 the readout
    // and skeleton are most useful DURING calibration, which is when framing and
    // lighting problems actually get diagnosed.
    startHudLoop();
    if (SIM_MODE) util.show(dom.simNote);
    setCameraMode('off');
    showScreen('screenStart');

    HP.app = { sim, audio, get tracker() { return tracker; }, get game() { return game; } };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.HP);
