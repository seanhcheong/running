/* =============================================================================
 * Huff&Puff — CENTRAL TUNING CONFIG
 * =============================================================================
 * EVERY threshold, gain, and magic number in the prototype lives here so it can
 * be tuned in one place without touching game or tracking logic.
 *
 * Units used throughout:
 *   - "sps"      = steps per second (one step = one knee reaching the top of its
 *                  lift; a full running cycle = 2 steps). 3.0 sps ~= 180 spm.
 *   - "bs"       = body-scale units. 1 bs = distance from shoulder-midpoint to
 *                  hip-midpoint of THIS player as detected on THIS frame.
 *                  Normalising by body scale makes every threshold independent
 *                  of how far the player is standing from the phone.
 *   - "m"        = abstract world metres used by the game sim (not real metres).
 *   - seconds for all durations unless the name ends in _MS.
 * ========================================================================== */

window.HP = window.HP || {};

window.HP.CONFIG = {
  /* ---------------------------------------------------------------------------
   * CAMERA
   * ------------------------------------------------------------------------ */
  camera: {
    // Requested capture size. Small is GOOD: MoveNet Lightning downsamples to
    // 192x192 anyway, and a smaller stream costs far less GPU on phones.
    //
    // KEEP THIS 4:3. Phone sensors are natively 4:3, so asking for 16:9 makes
    // the camera crop the top and bottom away — which costs exactly the vertical
    // field of view this game needs to see you from head to knees.
    width: 640,
    height: 480,
    frameRate: 30,
    facingMode: 'user', // front camera — the player faces the phone

    /* --- field of view -----------------------------------------------------
     * Fitting a whole standing body in frame is the single hardest part of
     * setting this game up, so we ask for the widest view the hardware will
     * give us. Three separate levers, because they fail independently:
     * -------------------------------------------------------------------- */

    // 'none' asks the browser NOT to crop-and-scale the sensor down to our
    // requested size. The default ('crop-and-scale') is allowed to letterbox or
    // centre-crop to hit the numbers above, silently narrowing the view.
    resizeMode: 'none',

    // Many phones expose a digital zoom that does not default to 1x. If the
    // track reports a zoom capability, wind it to its minimum — this is
    // literally "zoom out as far as this camera goes".
    zoomToMinimum: true,

    // If the device lists several front cameras (some Androids expose a normal
    // and an ultra-wide), prefer one whose label looks wide-angle.
    preferWideAngleDevice: true,
    wideAngleLabelHints: ['ultra', 'wide', '0.5'],

    // The raw front-camera image is NOT mirrored, so the player's left hand
    // appears on the right of the frame. We mirror every keypoint x once, right
    // after detection, so all downstream logic (and the debug overlay) works in
    // "the player's own frame": smaller x = the player's left = screen left.
    mirror: true,
  },

  /* ---------------------------------------------------------------------------
   * POSE MODEL
   * ------------------------------------------------------------------------ */
  pose: {
    // MoveNet SinglePose Lightning — the fast variant, required for phones.
    modelType: 'SinglePose.Lightning',

    // Leave null to let @tensorflow-models/pose-detection use its bundled
    // default URL (TF Hub). Set this to a local path such as
    // 'vendor/models/movenet-lightning/model.json' to run fully offline — see
    // README "Running fully offline".
    modelUrl: null,

    // MoveNet's own temporal smoothing is DISABLED: we run our own One Euro
    // Filter (below) so the smoothing is tunable and we know exactly what the
    // threshold logic sees.
    enableSmoothing: false,

    // Poses below this overall score are treated as "no player detected".
    minPoseScore: 0.2,

    // Per-keypoint confidence gates.
    minKeypointScore: 0.3,       // a keypoint is "usable" above this
    goodKeypointScore: 0.45,     // a keypoint is "solid" above this (calibration)

    // Process every Nth camera frame. 1 = every frame (~60fps, hot phone),
    // 2 = every other frame (~30 pose reads/sec) which is plenty for cadence
    // detection and roughly halves GPU load.
    //
    // DO NOT raise this to "help" a slow device. Cadence detection is a
    // sampling problem: the knee signal flips sign maxStepsPerSec times a
    // second, and resolving those flips needs roughly 3 samples per half-cycle.
    // At 30 reads/sec a 5.5 steps/sec sprint gets ~5.5 samples per flip, which
    // is comfortable. Drop to ~10 reads/sec and fast running ALIASES: intervals
    // come out irregular, the consistency gate fails, and cadence reads zero
    // while the player is running perfectly. Throttling harder makes that worse,
    // not better.
    frameThrottle: 2,

    // Sustained pose reads/sec below this mean the device cannot sample cadence
    // reliably (see above). The game warns the player rather than quietly
    // eating them. 14/sec is about the floor for a 2.5 steps/sec jog.
    minProcessFps: 14,
  },

  /* ---------------------------------------------------------------------------
   * ONE EURO FILTER — applied to every keypoint x/y BEFORE any threshold logic
   * ---------------------------------------------------------------------------
   * The One Euro Filter is an adaptive low-pass: it smooths hard when the
   * signal is slow (killing jitter while standing still) and barely smooths at
   * all when the signal moves fast (preserving the snap of a real jump).
   *
   *   mincutoff — lower = smoother but laggier. This is the smoothing floor
   *               applied to slow movement. 1.0-1.5Hz is a good starting band
   *               for pose keypoints at 30fps.
   *   beta      — how aggressively the filter opens up for fast movement.
   *               Higher = more responsive to jumps/lunges, less smoothing.
   *               If jumps feel laggy, raise beta. If jitter causes false
   *               triggers, lower beta and/or lower mincutoff.
   * ------------------------------------------------------------------------ */
  filter: {
    mincutoff: 1.2,   // Hz
    beta: 0.35,       // unitless
    dcutoff: 1.0,     // Hz — cutoff for the internal derivative filter; rarely needs changing
    freq: 30,         // Hz — initial rate estimate; real dt is measured per frame
  },

  /* ---------------------------------------------------------------------------
   * CADENCE DETECTION (running-in-place)
   * ---------------------------------------------------------------------------
   * Signal: kneeDiff = (rightKnee.y - leftKnee.y) / bodyScale
   *         y grows downward, so kneeDiff > 0 means the LEFT knee is higher.
   * Running in place makes this a clean oscillation around zero. Swaying,
   * fidgeting, and walking toward the phone do NOT — both knees move together,
   * so the amplitude stays under the deadband.
   * ------------------------------------------------------------------------ */
  cadence: {
    // Rolling buffer of recent processed frames used for pattern inspection.
    // At frameThrottle 2 (~30 reads/sec) 26 frames ~= 0.85s of history, enough
    // to hold 2+ full running cycles.
    bufferFrames: 26,

    // A sign flip only counts once the signal passes this far past zero, in
    // body-scale units. This deadband is THE false-positive guard: idle sway
    // produces |kneeDiff| well under 0.05.
    // Overridden per player at calibration (see amplitudeDeadbandRatio).
    deadband: 0.055,

    // After calibration the deadband becomes
    //   clamp(amplitudeDeadbandRatio * playerKneeAmplitude, min, max)
    // so a player with a low shuffling knee-lift still registers, and a player
    // with huge knee drive doesn't trigger on their bounce.
    amplitudeDeadbandRatio: 0.34,
    deadbandMin: 0.028,
    deadbandMax: 0.13,

    // Plausible human range for running in place, in steps/sec.
    // 1.0 sps = 60 spm (a slow march) … 5.5 sps = 330 spm (sprint in place).
    // Half-cycle intervals outside this window are discarded as noise — this is
    // what rejects a single ambiguous leg movement.
    // maxStepsPerSec also sets the frame rate the tracker needs: resolving N
    // sign flips per second takes ~3N samples per second. See pose.frameThrottle.
    minStepsPerSec: 1.0,
    maxStepsPerSec: 5.5,

    // Consistency gate: this many recent, in-range, alternating half-cycles
    // must agree before the tracker reports running === true. 4 half-cycles =
    // 2 full running cycles, so a single leg lift can never start the game.
    minConsistentSteps: 4,

    // Max relative spread between recent half-cycle intervals for them to count
    // as "a repeating pattern". 0.5 = intervals may vary +/-50% around the
    // median. Tighten toward 0.3 to reject sloppier movement.
    maxIntervalVariance: 0.5,

    // Knee amplitude must also hold up, as a fraction of the player's
    // calibrated amplitude. Guards against the pattern surviving as the player
    // decays into a tiny shuffle.
    minAmplitudeRatio: 0.4,

    // Exponential smoothing on the reported cadence (0-1, per processed frame).
    // Lower = steadier number, slower to react to a genuine surge.
    smoothing: 0.25,

    // No flip for this long => the player has stopped; begin decaying cadence.
    flipTimeout: 0.55,
    // Time constant of that decay, in seconds. Cadence falls ~63% per tau.
    decayTau: 0.35,
    // Cadence below this is reported as a hard zero and running := false.
    stoppedThreshold: 0.35,
  },

  /* ---------------------------------------------------------------------------
   * LEAN / JUMP / DUCK GESTURES
   * ---------------------------------------------------------------------------
   * All thresholds are in body-scale units relative to the neutral standing
   * baseline captured during calibration, so they adapt to each player and to
   * how far away they stand.
   * ------------------------------------------------------------------------ */
  gesture: {
    /* --- Sideways movement → lane change ---------------------------------
     * Measured as the horizontal offset of the shoulder/hip midpoint from the
     * calibrated centre, in body-scale units.
     *
     * ON THE NAMING: these are called "lean" for historical reasons, but the
     * signal is just torso offset and it does not care HOW you produce it. A
     * side STEP moves the torso midpoint exactly as a lean does, so both work
     * and the player can use whichever feels better. 0.30 bs is roughly 14cm of
     * travel for an adult — small enough to step without leaving frame.
     *
     * Stepping is more natural, more athletic, and what players expect from the
     * genre. Leaning is steadier, since you are on one foot half the time while
     * running in place, and it does not interrupt the knee-alternation pattern
     * the way a lateral step briefly can.
     * -------------------------------------------------------------------- */
    leanEnter: 0.30,   // enter the left/right lane past this offset
    leanExit: 0.17,    // return to centre lane inside this offset (hysteresis)
    leanCooldownMs: 220, // min time between lane-intent changes (debounce)

    /* Slow re-centring of the reference line. This is what makes STEPPING
     * viable rather than only leaning.
     *
     * Lane position is absolute — measured against the centre captured at
     * calibration. That is self-correcting when you lean, because you always
     * return to your planted feet. It is NOT self-correcting when you step:
     * small errors accumulate, and after a few minutes a player can end up
     * permanently offset and stuck in a lane, with the game reading it as a
     * deliberate hold.
     *
     * So while the player reads as centred, drag the reference centre toward
     * where they actually are, at this fraction of the remaining error per
     * second. Deliberately slow, and gated on already being inside the centre
     * deadzone, so it can never cancel a held lane change. 0 disables it. */
    centerDriftPerSec: 0.09,

    // --- Jump ---------------------------------------------------------------
    // Upward hip velocity, in body-scale units per second. Running in place
    // bobs the hips continuously, so the live threshold is
    //   max(jumpVelocityMin, calibratedRunBobVelocity * jumpVelocityMargin)
    // i.e. a jump must clearly beat the player's own running bounce.
    jumpVelocityMin: 1.5,
    jumpVelocityMargin: 1.75,
    // The hips must also actually END UP higher than neutral by this much,
    // which rejects fast-but-shallow bounces.
    jumpRiseMin: 0.045,
    jumpCooldownMs: 550,

    /* How long the velocity AND rise conditions must BOTH hold before a jump
     * fires, in seconds.
     *
     * Jump is the noise-sensitive detector, because it is the only one reading a
     * DERIVATIVE. Velocity is Δposition/Δt, so a fixed few pixels of keypoint
     * jitter becomes a velocity spike that grows as Δt shrinks — this gets worse
     * at higher frame rates, not better. Measured with 8px of Gaussian jitter
     * while running: 30 false jumps per minute, all from single-frame spikes.
     * Requiring the condition to persist removed all of them.
     *
     * Deliberately a DURATION, not a frame count. A frame count means a
     * different physical requirement on every device — at 30fps two frames is
     * 67ms, at 8fps it is 250ms, which is longer than a real jump's whole
     * upward phase, so slow devices would simply stop registering jumps.
     *
     * It also degrades in the right direction: when frames arrive further apart
     * than this window, a single sample already covers it and fires immediately.
     * So fast devices — where derivative noise is worst — get the protection,
     * and slow devices lose the protection rather than losing the jump. 0
     * disables it. */
    jumpConfirmSeconds: 0.05,

    // --- Duck / slide -------------------------------------------------------
    // Hip drop below the calibrated standing hip height, in body-scale units.
    duckEnter: 0.19,
    duckExit: 0.11,      // hysteresis so a held crouch doesn't flicker
    duckMinHoldMs: 260,  // once ducking, stay ducked at least this long
  },

  /* ---------------------------------------------------------------------------
   * PACE → SPEED MAPPING (the core mechanic)
   * ---------------------------------------------------------------------------
   *   paceRatio = liveCadence / comfortableCadence   (comfortable = calibrated)
   *
   * paceRatio 1.0 means "the pace you told us was comfortable". The curve is
   * deliberately NOT linear:
   *   - below 1.0 it falls off faster than linear (slacking costs you)
   *   - above 1.0 it saturates (pushing harder helps, but max effort is never
   *     required just to survive — it buys buffer, not survival)
   * ------------------------------------------------------------------------ */
  pace: {
    // Hard clamp on reported paceRatio, so a glitchy read can't spike speed.
    maxRatio: 2.2,

    // Below target: speedNorm = paceRatio ^ belowTargetExponent
    // 1.35 → paceRatio 0.8 gives 0.74 speed, 0.5 gives 0.39. Raise to punish
    // slacking harder; lower toward 1.0 for a gentler ramp.
    belowTargetExponent: 1.35,

    // Above target: speedNorm = 1 + overdriveMax * (1 - e^-((p-1)/overdriveK))
    // overdriveMax is the ceiling of the plateau: sprinting flat-out can only
    // ever buy you 45% more speed than your own comfortable pace.
    overdriveMax: 0.45,
    overdriveK: 0.5,

    // Pace bands used for the colour-coded HUD and audio cues.
    warnRatio: 0.8,    // below this the "pace dropping" cue can fire
    dangerRatio: 0.55, // clearly not keeping up
  },

  /* ---------------------------------------------------------------------------
   * GAME SIMULATION
   * ------------------------------------------------------------------------ */
  game: {
    // World speed (abstract m/s) when the player is exactly at their own
    // comfortable pace (paceRatio 1.0, speedNorm 1.0).
    speedAtTargetPace: 12.0,
    // Speed smoothing: how fast actual speed chases the pace-derived target.
    // Units: fraction of the remaining gap closed per second (higher = snappier).
    speedLerpPerSec: 3.2,

    // --- The consuming space ----------------------------------------------
    // Starting distance between the player and the void, in world metres.
    gapStart: 45,
    // The gap can never bank more than this, so a strong player can't build an
    // unloseable lead and stop exercising.
    gapMax: 90,
    // Visual/HUD mapping: gap >= gapVisibleMax reads as a full safe bar.
    gapVisibleMax: 60,
    // HUD colour + audio bands.
    gapWarn: 32,
    gapDanger: 18,

    // Void speed at t=0. 0.8 × target means a player holding their comfortable
    // pace opens the gap at first — the early session should feel winnable.
    wallBaseSpeedFactor: 0.8,
    // The void accelerates over session time. +1.8 m/s per minute means that
    // around the 2 minute mark a comfortable pace is no longer enough and the
    // player must dip into overdrive.
    wallRampPerMinute: 1.8,
    // Ceiling on void speed, as a factor of speedAtTargetPace. 1.25 sits just
    // under a strong overdrive (~1.28-1.39), so a fit player can still hold on
    // at full effort but nobody coasts forever.
    wallMaxSpeedFactor: 1.25,

    // --- Grace window ------------------------------------------------------
    // Once the void touches the player, they have this long to re-establish
    // pace before the session ends. Absorbs a stumble, a cough, or a bad read.
    graceSeconds: 2.0,
    // Grace refills at this many seconds per second once the gap re-opens.
    graceRecoverPerSec: 0.5,

    // If pose tracking drops out entirely (player walked out of frame, phone
    // knocked, terrible lighting) the void is FROZEN for this long instead of
    // eating a player who is probably still running. After that it resumes, so
    // covering the camera isn't an exploit.
    trackingLossGraceSeconds: 2.5,

    // --- Lanes -------------------------------------------------------------
    // Fixed at 3 (left / centre / right). Genuinely fixed, not just defaulted:
    // the lane width divisor, the spawn logic and the renderer's centre-lane
    // index all assume 3. To play without lanes, zero the lane obstacle weight
    // below rather than changing this.
    //
    // Space cost, measured: a lane change is a 14cm torso lean, so the whole
    // 3-lane range needs 28cm of horizontal travel against roughly 98cm of frame
    // width at normal standing distance. Lanes are never the framing problem —
    // vertical fit always is.
    laneCount: 3,
    laneSwitchPerSec: 4.5, // lanes traversed per second when changing lanes

    // --- Jump arc (screen-height fractions) --------------------------------
    jumpPeak: 0.16,     // apex height as a fraction of screen height
    jumpAirtime: 0.62,  // seconds from takeoff to landing

    // --- Obstacles ---------------------------------------------------------
    obstacleSpawnZ: 90,          // spawn distance ahead, world metres
    obstacleIntervalM: 55,       // one obstacle per this much distance travelled
    obstacleIntervalJitterM: 18, // +/- randomisation so it isn't metronomic
    obstacleDespawnZ: -10,
    obstacleWarnZ: 45,           // audio "obstacle approaching" fires here
    // Relative spawn weights per obstacle kind.
    //
    // Setting lane to 0 gives you a de-facto SINGLE-LANE game without touching
    // code: no barriers spawn, so leaning stops mattering. Worth trying if
    // leaning turns out to feel unstable — you are on one foot half the time
    // while running in place, and a 14cm torso shift (that is what leanEnter
    // 0.30 works out to) is a real balance ask. Try lowering gesture.leanEnter
    // to ~0.22 first, though; lateral torso work is good variety to keep.
    //
    // laneCount itself is NOT parameterisable — see the note there.
    obstacleWeights: { lane: 0.45, low: 0.3, high: 0.25 },
    // Collision half-width of a lane barrier, in lanes: you are hit while your
    // (fractional) lane position is closer than this to the barrier's lane. At
    // 0.55 you clear it once you are a little past half-way out of its lane —
    // raise it to demand fully committed lane changes, lower it to forgive
    // late ones.
    laneHitTolerance: 0.55,

    // --- Cost of a hit (a stacking stressor, never an instant fail) --------
    startingShields: 3,
    hitGapLoss: 12,            // metres of gap the void instantly gains
    hitGapLossNoShield: 20,    // harsher once shields are gone
    hitSpeedMultiplier: 0.7,   // stumble: forward speed penalty …
    hitSpeedPenaltySeconds: 1.2, // … for this long
    hitInvulnSeconds: 0.8,     // no second hit inside this window

    // --- Milestones --------------------------------------------------------
    milestoneDistanceM: 400,   // chime + 1 shield back (capped at startingShields)
    milestoneGapBonus: 6,      // small breather reward

    // Safety clamp on the per-frame timestep, so a backgrounded tab can't
    // teleport the void into the player on resume.
    maxTimestep: 0.05,
  },

  /* ---------------------------------------------------------------------------
   * CALIBRATION
   * ------------------------------------------------------------------------ */
  calibration: {
    // Step 1 — framing. Full body must stay detected this long, continuously.
    framingHoldSeconds: 2.0,
    /* Keypoints that must all be visible before framing is accepted.
     *
     * ANKLES ARE DELIBERATELY NOT HERE. Nothing in the game reads them: body
     * scale comes from shoulders-to-hips, lean from those midpoints, jump and
     * duck from the hips, and cadence from the KNEES. Ankles only ever appeared
     * in a hint string and in the debug skeleton's shin bones.
     *
     * Requiring them made the gate stricter than the mechanics: it asked the
     * player to fit ~96% of their height in frame when only the top ~72% is
     * used, which costs about 25% more standing distance — the difference
     * between needing 8 feet and needing 6. Fitting a whole body in a phone's
     * field of view is the hardest part of setting this game up, so that
     * distance is worth more than the tidiness of a head-to-toe silhouette.
     *
     * Add 'left_ankle', 'right_ankle' back if you want the stricter gate; the
     * mechanics behave identically either way. */
    requiredKeypoints: [
      'left_shoulder', 'right_shoulder',
      'left_hip', 'right_hip',
      'left_knee', 'right_knee',
    ],
    // Step 2 — lighting hint. If mean confidence sits below this for
    // lowConfidenceHintAfter seconds, prompt for better lighting instead of
    // proceeding on unreliable tracking.
    lowConfidenceThreshold: 0.35,
    lowConfidenceHintAfter: 2.5,

    // Step 3 — neutral standing baseline.
    neutralHoldSeconds: 1.5,

    // Step 4 — comfortable pace capture.
    warmupSeconds: 5.0,
    // Discard the first moment of the warm-up: the player is still starting up.
    warmupIgnoreLeadIn: 1.2,
    // Minimum running samples needed or we ask the player to try again.
    warmupMinSamples: 12,
    // Floor on the captured comfortable cadence, so a barely-moving warm-up
    // doesn't set an impossible-to-lose baseline.
    comfortableCadenceFloor: 1.6,

    // Step 5 — optional max-effort capture.
    maxEffortSeconds: 3.0,
    // If the player skips it, assume their ceiling is this much above
    // comfortable (used only for the "% of your range" HUD readout).
    assumedMaxRatio: 1.4,

    // Step 6 — countdown.
    countdownFrom: 3,
    countdownStepSeconds: 0.8,
  },

  /* ---------------------------------------------------------------------------
   * AUDIO — a secondary channel because the player is 6-10 feet away and
   * cannot read fine detail.
   * ------------------------------------------------------------------------ */
  audio: {
    masterGain: 0.35,
    // Danger pulse repeats faster as the void closes: period interpolates from
    // dangerPulseSlowMs (at the danger threshold) to dangerPulseFastMs (touching).
    dangerPulseSlowMs: 700,
    dangerPulseFastMs: 190,
    // "Your pace is dropping" cue, rate-limited so it never becomes a drone.
    paceDropCooldownMs: 2600,
    obstacleCooldownMs: 260,
  },

  /* ---------------------------------------------------------------------------
   * DEBUG
   * ------------------------------------------------------------------------ */
  debug: {
    // Start with the skeleton overlay + numeric readout visible.
    // Also switchable at runtime with the on-screen DEBUG button or ?debug=1.
    overlayOnByDefault: false,
    // Log the active TF.js backend and model load timing to the console.
    logBackend: true,
    // Draw keypoints below minKeypointScore in a dimmed colour instead of
    // hiding them (useful for diagnosing lighting problems).
    drawLowConfidenceKeypoints: true,
  },
};
