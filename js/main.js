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
 *   ?mode=wall  start straight into Wall Mode (see docs/DESIGN-wall-mode.md).
 *               In ?sim=1 the number keys stand in for holding a pose — the
 *               legend on the start screen and in the HUD lists them.
 * ========================================================================== */

window.HP = window.HP || {};

(function (HP) {
  'use strict';

  const util = HP.util;
  const CONFIG = HP.CONFIG;
  const clamp = util.clamp;

  const SIM_MODE = util.queryFlag('sim');
  const FORCE_CANVAS = util.queryFlag('canvas');

  function queryValue(name) {
    try { return new URLSearchParams(window.location.search).get(name); }
    catch (e) { return null; }
  }
  const START_MODE = queryValue('mode') === 'wall' ? 'wall' : 'run';

  /* Sim-mode stand-in for holding a pose: number keys pick which shape you are
   * "in". Order matters — it is the on-screen key legend too. */
  const SIM_POSE_KEYS = ['stand_tall', 'squat_bottom', 'star', 't_pose',
                         'knee_up_left', 'knee_up_right', 'reach_up', 'clap',
                         'side_bend_left', 'side_bend_right'];

  /** Digit → pose. Keys run 1-9 then 0 for the tenth, the usual convention. */
  function simPoseFor(key) {
    if (!/^[0-9]$/.test(key)) return null;
    const n = key === '0' ? 10 : parseInt(key, 10);
    return SIM_POSE_KEYS[n - 1] || null;
  }

  /** "1 STAND TALL · 2 SQUAT · …" — built from the list above so the legend can
   *  never drift out of step with the keys that are actually bound. */
  function simPoseLegend(sep) {
    return SIM_POSE_KEYS.map((id, i) => ((i + 1) % 10) + ' ' +
      (HP.POSES && HP.POSES[id] ? HP.POSES[id].label : id)).join(sep || ' · ');
  }

  /* ===========================================================================
   * DOM
   * ======================================================================== */
  const el = (id) => document.getElementById(id);

  const dom = {
    body: document.body,
    video: el('video'),
    debugCanvas: el('debugCanvas'),
    gameRoot: el('gameRoot'),
    courseCanvas: el('courseCanvas'),

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

    wallHud: el('wallHud'),
    wallScore: el('wallScore'),
    wallCombo: el('wallCombo'),
    wallHealth: el('wallHealth'),
    wallToast: el('wallToast'),
    fitWrap: el('fitWrap'),
    fitPose: el('fitPose'),
    fitHint: el('fitHint'),
    fitCanvas: el('fitCanvas'),
    fitFill: el('fitFill'),
    fitTarget: el('fitTarget'),
    fitStatus: el('fitStatus'),
    btnWallDebug: el('btnWallDebug'),
    btnWallQuit: el('btnWallQuit'),
    wallSimKeys: el('wallSimKeys'),

    screenStart: el('screenStart'),
    btnStart: el('btnStart'),
    btnStartWall: el('btnStartWall'),
    simNote: el('simNote'),
    heroBlob: el('heroBlob'),

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
    overDistanceLabel: el('overDistanceLabel'),
    overTimeLabel: el('overTimeLabel'),
    overDodgedLabel: el('overDodgedLabel'),
    overHitsLabel: el('overHitsLabel'),
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
  /* The world behind the game. Created once and shared by both scenes — the road
   * is the same road in either mode. Art loads lazily and failure is fine: it
   * falls back to flat colours. */
  const course = new HP.Course(HP.PALETTE).attach(dom.courseCanvas);
  const sim = new HP.GameSim(CONFIG);
  const wallSim = new HP.WallSim(CONFIG);

  let tracker = null;         // null in sim mode
  let calibration = null;
  let game = null;            // Phaser.Game, created lazily on the first run
  let scene = null;

  let mode = START_MODE;      // 'run' | 'wall'
  let gameKind = null;        // which scene the live Phaser.Game is running
  let phase = 'start';        // start | loading | calibrating | running | over | error
  let framingActive = false;  // wall mode's framing-only pre-flight
  let framingHeldSince = null;
  let simPoseId = null;       // sim mode: the pose the player is "holding"
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
  function setCameraMode(which) {
    dom.body.classList.remove('cam-full', 'cam-pip', 'cam-off');
    if (which === 'pip') dom.body.classList.add('cam-pip');
    else if (which === 'full') dom.body.classList.add('cam-full');
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
    framingActive = false;
    console.error('[HP]', err);
    hideLoading();
    util.hide(dom.hud);
    util.hide(dom.wallHud);
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
      if (phase !== 'running') return;
      if (mode === 'wall') pullWallSignals(); else pullSignals();
    });

    tracker.on('onJump', () => {
      if (phase === 'running' && mode === 'run') sim.queueJump();
    });

    tracker.on('step', () => {
      if (phase === 'running' && mode === 'run') audio.step();
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
    framingActive = false;
    mode = 'run';
    util.hide(dom.wallHud);
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

    ensureGame('run');
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

  /**
   * One Phaser.Game at a time, rebuilt if the mode changes. Modes are only
   * chosen from the start screen, so a destroy/recreate is cheap and avoids
   * juggling two scene keys and two live WebGL contexts.
   */
  function ensureGame(kind) {
    if (game && gameKind === kind) return;
    if (game) {
      game.destroy(true);
      game = null;
      scene = null;
    }
    gameKind = kind;
    scene = kind === 'wall'
      ? new HP.WallScene({
          sim: wallSim,
          config: CONFIG,
          course: course,
          // Auto-scrolling, so the runner's legs move at a steady jog rather
          // than at a measured cadence there is no longer any of.
          getCadence: () => 2.4,
        })
      : new HP.RunScene({
          sim: sim,
          config: CONFIG,
          course: course,
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
    framingActive = false;
    util.hide(dom.hud);
    util.hide(dom.wallHud);
    util.hide(dom.countdown);
    util.show(dom.calibPanel);
    setCameraMode('off');
    showScreen('screenStart');
  }


  /* ===========================================================================
   * WALL MODE
   * ---------------------------------------------------------------------------
   * Notably simpler to enter than the running mode, because pose matching is
   * hip-anchored and body-scale divided — so it needs NO calibration at all. No
   * centre line, no standing hip height, no comfortable pace. Just framing.
   * ======================================================================== */

  /** Framing-only pre-flight. Reuses the calibration screen's furniture. */
  function startWallFraming() {
    phase = 'calibrating';
    wallSim.reset();
    util.hide(dom.hud);
    util.hide(dom.wallHud);
    util.hide(dom.countdown);
    util.show(dom.calibPanel);
    util.hide(dom.btnCalibSkip);
    setCameraMode('full');
    showScreen('screenCalib');

    util.setText(dom.calibIndex, '1');
    util.setText(dom.calibTitle, 'Get in frame, head to knees');
    util.setText(dom.calibInstruction, 'Wall Mode needs no pace calibration — just framing.');
    util.setText(dom.calibSub,
      'Feet can be out of frame, but your hands raised overhead should be inside it.');
    util.setText(dom.calibHint, '');
    util.setText(dom.calibCadence, '');
    dom.calibProgress.style.width = '0%';
    framingHeldSince = null;
    framingActive = true;
  }

  /**
   * Runs from the HUD loop while the framing gate is up.
   * Wall Mode asks for more than the running mode: the star pose puts the wrists
   * above the head, so headroom is checked here rather than discovered later as
   * a pose that can never be matched.
   */
  function tickWallFraming() {
    if (!tracker) return;
    const st = tracker.state;
    const c = CONFIG.calibration;
    const wristsVisible = st.poseNorm &&
      tracker.keypointMap &&
      tracker.keypointMap.left_wrist &&
      tracker.keypointMap.right_wrist &&
      tracker.keypointMap.left_wrist.score >= CONFIG.pose.minKeypointScore &&
      tracker.keypointMap.right_wrist.score >= CONFIG.pose.minKeypointScore;
    const ok = st.tracked && st.fullBody && wristsVisible;

    if (!ok) {
      framingHeldSince = null;
      dom.calibProgress.style.width = '0%';
      util.setText(dom.calibProgressLabel, '');
      if (!st.tracked) util.setText(dom.calibHint, 'No one detected. Stand in front of the camera.');
      else if (!st.fullBody) util.setText(dom.calibHint, 'Step back until your knees are in frame.');
      else util.setText(dom.calibHint,
        'Raise your hands overhead — they need to be in frame too. Tilt the phone up a little.');
      return;
    }

    util.setText(dom.calibHint, '');
    const now = util.now();
    if (framingHeldSince === null) framingHeldSince = now;
    const held = now - framingHeldSince;
    dom.calibProgress.style.width =
      (clamp(held / c.framingHoldSeconds, 0, 1) * 100).toFixed(1) + '%';
    util.setText(dom.calibProgressLabel, 'Hold still…');

    if (held >= c.framingHoldSeconds) {
      framingActive = false;
      if (audio) audio.calibrationStepDone();
      beginWallRun();
    }
  }

  async function beginWallRun() {
    wallSim.reset();
    audio.reset();
    simPoseId = null;

    util.hide(dom.calibPanel);
    showScreen('screenCalib');
    await countdownAlone();
    util.show(dom.calibPanel);

    phase = 'running';
    mode = 'wall';
    showScreen(null);
    util.hide(dom.countdown);
    util.hide(dom.hud);
    util.show(dom.wallHud);
    setCameraMode(SIM_MODE ? 'off' : 'pip');
    if (SIM_MODE) {
      dom.wallSimKeys.innerHTML = 'HOLD ' + simPoseLegend();
      util.show(dom.wallSimKeys);
    }

    // Threshold marker, same idea as the pace meter's comfortable-pace line.
    dom.fitTarget.style.left = (wallSim.fitThreshold() * 100).toFixed(1) + '%';

    if (SIM_MODE) applyWallSignals(); else pullWallSignals();
    updateWallHud();
    ensureGame('wall');
    wallSim.start();
  }

  /**
   * Pose → game. The ONLY crossing point, exactly like pullSignals() for the
   * running mode: one number, so the sim stays free of pose code.
   */
  function pullWallSignals() {
    const sig = wallSim.signals;
    if (!tracker) { sig.poseError = Infinity; sig.tracked = false; return; }
    const st = tracker.state;
    sig.tracked = st.tracked;
    const w = wallSim.activeWall();
    if (!w || !st.poseNorm) { sig.poseError = Infinity; return; }
    sig.poseError = HP.poseLib.errorFor(
      st.poseNorm, w.poseId, CONFIG.pose.minKeypointScore);
  }

  /** Sim-mode stand-in: a number key says which pose you are holding. */
  function applyWallSignals() {
    const sig = wallSim.signals;
    sig.tracked = true;
    const w = wallSim.activeWall();
    // 1.5 rather than Infinity so the fit bar still reads as "wrong shape"
    // instead of "cannot see you", which is a different failure.
    sig.poseError = (w && simPoseId && simPoseId === w.poseId) ? 0 : 1.5;
  }

  function wireWallSim() {
    wallSim.on('wallArmed', (e) => {
      const pose = HP.POSES[e.poseId];
      if (pose) audio.obstacleWarn('lane', util.now() * 1000);
    });
    wallSim.on('wallPassed', (e) => {
      audio.milestone();
      showWallToast(e.combo > 1 ? 'x' + e.combo : 'CLEAR', 'good', 700);
    });
    wallSim.on('wallMissed', () => {
      audio.hit(false);
      showWallToast('MISS', 'hit', 800);
    });
    wallSim.on('gameover', (summary) => endWallRun(summary));
    wallSim.on('complete', (summary) => endWallRun(summary));
  }

  function showWallToast(text, cls, ms) {
    dom.wallToast.className = 'toast show' + (cls ? ' ' + cls : '');
    util.setText(dom.wallToast, text);
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { dom.wallToast.className = 'toast'; }, ms || 800);
  }

  function updateWallHud() {
    const w = wallSim.activeWall();
    const cfgW = CONFIG.wall;

    util.setText(dom.wallScore, String(wallSim.score));
    util.setText(dom.wallCombo, 'x' + wallSim.combo);
    util.setText(dom.wallHealth,
      wallSim.health > 0 ? '◆'.repeat(wallSim.health) : '—');
    dom.wallHealth.classList.toggle('hurt', wallSim.health === 2);
    dom.wallHealth.classList.toggle('critical', wallSim.health <= 1);

    if (!w) {
      util.setText(dom.fitPose, '—');
      util.setText(dom.fitHint, '');
      dom.fitFill.style.width = '0%';
      dom.fitFill.className = 'fit-fill';
      dom.fitStatus.className = 'fit-status';
      util.setText(dom.fitStatus,
        wallSim.walls.length ? 'GET READY' : 'CLEAR ROAD');
      drawFitCanvas(null);
      return;
    }

    const pose = HP.POSES[w.poseId];
    util.setText(dom.fitPose, pose ? pose.label : w.poseId);

    const err = wallSim.signals.poseError;
    const tol = wallSim.toleranceFor(w.poseId);
    const fit = wallSim.fit();
    dom.fitFill.style.width = (fit * 100).toFixed(1) + '%';

    let band = 'far';
    if (!isFinite(err)) band = 'far';
    else if (err < tol) band = 'match';
    else if (err < tol * 2) band = 'close';
    dom.fitFill.className = 'fit-fill ' + band;

    /* Naming the worst joint is the difference between "you are wrong" and
     * "your left knee is wrong", which is the whole point of a fit meter. */
    let hint = '';
    if (!isFinite(err)) {
      hint = tracker && !wallSim.signals.tracked ? 'CAN’T SEE YOU' : 'OUT OF FRAME';
    } else if (band !== 'match' && tracker && tracker.state.poseNorm && pose) {
      const detail = HP.poseLib.poseErrorDetail(
        tracker.state.poseNorm, pose, CONFIG.pose.minKeypointScore);
      if (detail.worst) hint = 'FIX ' + detail.worst.replace(/_/g, ' ').toUpperCase();
    }
    util.setText(dom.fitHint, hint);

    if (w.state === 'contact') {
      const frac = w.required > 0 ? clamp(w.held / w.required, 0, 1) : 1;
      dom.fitStatus.className = 'fit-status holding';
      util.setText(dom.fitStatus, 'HOLD  ' + Math.round(frac * 100) + '%');
    } else if (band === 'match') {
      dom.fitStatus.className = 'fit-status match';
      util.setText(dom.fitStatus, 'LOCKED');
    } else if (!isFinite(err)) {
      dom.fitStatus.className = 'fit-status lost';
      util.setText(dom.fitStatus, 'NO POSE');
    } else {
      dom.fitStatus.className = 'fit-status';
      util.setText(dom.fitStatus, 'MATCH THE SHAPE');
    }

    drawFitCanvas(w);
  }

  /** Accept either the target format ([x,y]) or a normalised live pose ({x,y}). */
  function jointXY(src, name) {
    const v = src ? src[name] : null;
    if (!v) return null;
    return Array.isArray(v) ? { x: v[0], y: v[1] } : v;
  }

  function strokeFigure(ctx, src, plot, color, width, onlyJoints) {
    const allowed = onlyJoints ? {} : null;
    if (allowed) onlyJoints.forEach((j) => { allowed[j] = 1; });
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.lineCap = 'round';
    for (let i = 0; i < HP.POSE_BONES.length; i++) {
      const an = HP.POSE_BONES[i][0];
      const bn = HP.POSE_BONES[i][1];
      const a = jointXY(src, an);
      const b = jointXY(src, bn);
      if (!a || !b) continue;
      const pa = plot(a.x, a.y);
      const pb = plot(b.x, b.y);
      ctx.beginPath();
      ctx.moveTo(pa.x, pa.y);
      ctx.lineTo(pb.x, pb.y);
      ctx.stroke();
    }
    const nose = jointXY(src, 'nose');
    if (nose) {
      const p = plot(nose.x, nose.y);
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, width * 1.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /**
   * Target shape in outline with the player's LIVE pose drawn over it, both in
   * the same normalised space. Seeing the two figures diverge is what tells the
   * player which limb to move — a bar alone cannot say that.
   */
  /* One reusable offscreen canvas for the fit meter's ghost. Allocating a fresh
   * one every frame would churn a 150x150 buffer at 60fps for no reason. */
  let _ghost = null;
  function ghostBuffer(w, h) {
    if (!_ghost) _ghost = document.createElement('canvas');
    if (_ghost.width !== w || _ghost.height !== h) {
      _ghost.width = w;
      _ghost.height = h;
    }
    return _ghost;
  }

  function drawFitCanvas(wall) {
    const c = dom.fitCanvas;
    if (!c) return;
    const ctx = c.getContext('2d');
    const dpr = window.devicePixelRatio || 1;
    const cw = c.clientWidth || 104;
    const ch = c.clientHeight || 104;
    if (c.width !== Math.round(cw * dpr) || c.height !== Math.round(ch * dpr)) {
      c.width = Math.round(cw * dpr);
      c.height = Math.round(ch * dpr);
    }
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cw, ch);
    if (!wall) return;
    const pose = HP.POSES[wall.poseId];
    if (!pose) return;

    /* Frame to the BLOB's extent, not the joints': the body form rises about a
     * torso above the shoulder line, so framing on joints alone crops the head
     * off the target the player is being asked to copy. */
    const b = HP.avatar.blobBounds(pose.target) || HP.poseLib.poseBounds(pose);
    const pad = 6;
    const sc = Math.min(
      (cw - pad * 2) / Math.max(b.width, 0.2),
      (ch - pad * 2) / Math.max(b.height, 0.2)
    );
    const ox = cw / 2 - ((b.minX + b.maxX) / 2) * sc;
    const oy = ch / 2 - ((b.minY + b.maxY) / 2) * sc;
    const plot = (bx, by) => ({ x: ox + bx * sc, y: oy + by * sc });

    /* The target: the character's silhouette, ghosted.
     *
     * Drawn opaque into an offscreen buffer and composited ONCE, rather than
     * drawn at 22% directly. The figure is several overlapping shapes — legs
     * behind the body, arms over it — and overlapping translucent fills
     * composite, so drawing it directly at 22% produced bright seams wherever
     * two parts met. The buffer flattens it first, so the ghost is uniform. */
    const buf = ghostBuffer(Math.round(cw * dpr), Math.round(ch * dpr));
    const bctx = buf.getContext('2d');
    bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    bctx.clearRect(0, 0, cw, ch);
    HP.avatar.drawBlob(HP.avatar.canvasOps(bctx), {
      joints: pose.target, plot: plot, bsPx: sc,
      silhouette: true, color: 0xffffff, alpha: 1,
    });
    ctx.save();
    ctx.globalAlpha = 0.24;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(buf, 0, 0);
    ctx.restore();

    /* Your live pose over the top, as a SKELETON rather than a second blob. Two
     * overlapping silhouettes are impossible to read apart; a stick figure inside
     * the target shape says "this limb is outside the shape" at a glance, which
     * is the one question this widget exists to answer. */
    const live = SIM_MODE
      ? (simPoseId && HP.POSES[simPoseId] ? HP.POSES[simPoseId].target : null)
      : (tracker ? tracker.state.poseNorm : null);
    if (live) {
      strokeFigure(ctx, live, plot,
        wallSim.matched() ? '#3fffb4' : '#ff5c7a',
        Math.max(2, sc * 0.075), pose.joints);
    }
  }

  function endWallRun(summary) {
    phase = 'over';
    if (summary.reason === 'complete') audio.milestone(); else audio.gameOver();
    util.hide(dom.wallHud);
    setCameraMode('off');

    util.setText(dom.overTitle,
      summary.reason === 'complete' ? 'Workout complete'
        : summary.reason === 'quit' ? 'Session ended' : 'Crushed');
    util.setText(dom.overDistance, String(summary.score));
    util.setText(dom.overTime, formatTime(summary.seconds));
    util.setText(dom.overDodged, String(summary.reps));
    util.setText(dom.overHits, String(summary.missed));
    util.setText(dom.overDistanceLabel, 'score');
    util.setText(dom.overTimeLabel, 'time');
    util.setText(dom.overDodgedLabel, 'reps');
    util.setText(dom.overHitsLabel, 'missed');
    util.setText(dom.overNote,
      summary.passed + ' of ' + summary.total + ' shapes hit. Two positions make ' +
      'one rep, so ' + summary.reps + ' rep' + (summary.reps === 1 ? '' : 's') + '.');
    showScreen('screenOver');
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
      if (framingActive) tickWallFraming();
      if (mode === 'wall') {
        if (phase === 'running') {
          if (SIM_MODE) applyWallSignals();
          updateWallHud();
        }
      } else {
        if (SIM_MODE && phase === 'running') applySimInput();
        if (phase === 'running') updateHud();
      }
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
    /* The number keys are a stand-in for the CAMERA, so they are deliberately
     * inert once the camera is the thing driving the pose. Silence read as "the
     * keys are broken", so say which it is instead of ignoring the press. */
    if (!SIM_MODE) {
      if (mode === 'wall' && phase === 'running' && /^[0-9]$/.test(e.key)) {
        showWallToast('KEYS NEED ?sim=1', 'hit', 1400);
      }
      return;
    }

    /* Wall Mode: a number key stands in for holding a pose. Held, not tapped —
     * the wall wants the shape sustained through contact, and the sim should
     * exercise that rather than paper over it. */
    if (mode === 'wall') {
      const picked = simPoseFor(e.key);
      if (picked) { simPoseId = picked; e.preventDefault(); }
      return;
    }

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
    if (mode === 'wall') {
      const picked = simPoseFor(e.key);
      if (picked && simPoseId === picked) { simPoseId = null; e.preventDefault(); }
      return;
    }
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
  async function onStart(which) {
    if (phase === 'loading') return;
    phase = 'loading';
    mode = which === 'wall' ? 'wall' : 'run';
    // Both of these need the user gesture we are inside right now.
    await audio.unlock();

    try {
      if (SIM_MODE) {
        // No camera and no model: the keyboard stands in for the pose signals,
        // so there is nothing to calibrate or frame.
        booted = true;
        if (mode === 'wall') await beginWallRun();
        else await beginRun(true);
      } else {
        await boot();
        // Wall Mode needs framing but NOT calibration — pose matching is
        // hip-anchored and body-scale divided, so there is no baseline to learn.
        if (mode === 'wall') startWallFraming();
        else startCalibration();
      }
    } catch (err) {
      showError(err);
    }
  }

  function wireButtons() {
    dom.btnStart.addEventListener('click', () => onStart('run'));
    dom.btnStartWall.addEventListener('click', () => onStart('wall'));

    dom.btnWallDebug.addEventListener('click', () => setDebug(!debugOn));
    dom.btnWallQuit.addEventListener('click', () => {
      if (phase === 'running' && mode === 'wall') {
        wallSim.status = 'over';
        wallSim.endReason = 'quit';
        endWallRun(wallSim.summary());
      }
    });
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
      if (!booted) { toStartScreen(); return; }
      if (mode === 'wall') beginWallRun();
      else beginRun(true);
    });
    dom.btnRecalibrate.addEventListener('click', () => {
      if (mode === 'wall') {
        // Re-frame rather than re-calibrate: there is no baseline in this mode.
        if (SIM_MODE) beginWallRun(); else startWallFraming();
        return;
      }
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
    /* Palette first: the stylesheet's custom properties come from HP.PALETTE, so
     * anything measured or painted before this would use the wrong colours. */
    HP.applyPaletteToCss();

    /* Course art. Deliberately not awaited — the start screen must appear
     * immediately, and the course renderer draws flat colours until (or unless)
     * the tiles arrive. */
    /* Rendered frames for the character. Same posture as the course art: not
     * awaited, and a failure just leaves those states procedural. state-run is
     * first because it is also the scale reference — see states.REF. */
    HP.avatar.states.load(['state-run', 'state-jump', 'state-duck', 'state-hit'])
      .then((got) => {
        if (got.length < 4) {
          console.info('[HP] state sprites available: ' +
            (got.join(', ') || 'none') + ' — the rest stay procedural');
        }
      });

    course.load({
      roadTile: 'assets/course/road-tile.jpg',
      skyline: 'assets/course/skyline.png',
    }).then((got) => {
      if (!got.roadTile) console.info('[HP] no road texture — using flat colours');
    });

    wireSim();
    wireWallSim();
    wireButtons();

    /* A pose library that cannot distinguish two of its own shapes is a content
     * bug that shows up later as walls passing when they should not. Say so at
     * boot instead. */
    const poseProblems = HP.poseLib.validateLibrary(HP.POSES, CONFIG.wall.defaultTolerance);
    if (poseProblems.length) {
      console.warn('[HP] pose library problems:\n  ' + poseProblems.join('\n  '));
    }

    // The pace meter's target line sits at paceRatio 1.0 — "your comfortable
    // pace" — on a bar that runs to maxRatio. Keep the two in sync from config.
    dom.paceTarget.style.left = (100 / CONFIG.pace.maxRatio).toFixed(2) + '%';

    /* The start-screen character is the one thing in this game loaded from a
     * file. Everything else is drawn from primitives, and that property is worth
     * keeping: if the sprite is missing the game must still boot, not show a
     * broken-image placeholder above the logo. */
    if (dom.heroBlob) {
      const dropHero = () => { if (dom.heroBlob) dom.heroBlob.remove(); };
      dom.heroBlob.addEventListener('error', dropHero);
      /* An `error` listener alone is not enough and the difference is visible: a
       * 404 on a tiny local file resolves long before DOMContentLoaded fires, so
       * the event has already been dispatched by the time this runs and the
       * broken-image placeholder stays on screen above the logo. `complete` with
       * a zero natural width is how you detect a load that already failed. */
      if (dom.heroBlob.complete && dom.heroBlob.naturalWidth === 0) dropHero();
    }

    dom.btnMute.classList.add('active');
    setDebug(debugOn);
    // Runs from the very first frame, not from START: with ?debug=1 the readout
    // and skeleton are most useful DURING calibration, which is when framing and
    // lighting problems actually get diagnosed.
    startHudLoop();
    /* Both key sets, always — the start screen offers both modes, so keying the
     * legend off START_MODE told anyone who *clicked* WALL MODE about the wrong
     * controls and left 1–6 undiscoverable. */
    if (SIM_MODE) {
      util.show(dom.simNote);
      dom.simNote.innerHTML =
        'SIM MODE — no camera.<br>' +
        '<b>RUN:</b> <kbd>↑</kbd>/<kbd>↓</kbd> pace, <kbd>←</kbd><kbd>→</kbd> ' +
        'lane, <kbd>Space</kbd> jump, <kbd>Shift</kbd> duck<br>' +
        '<b>WALL:</b> hold a number key to "be" a pose — ' + simPoseLegend(', ');
    }
    setCameraMode('off');
    showScreen('screenStart');

    HP.app = {
      sim: sim,
      wallSim: wallSim,
      audio: audio,
      get mode() { return mode; },
      get tracker() { return tracker; },
      get game() { return game; },
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})(window.HP);
