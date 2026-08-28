/* =============================================================================
 * Huff&Puff — MEDIAPIPE POSE BACKEND
 * =============================================================================
 * A drop-in alternative to MoveNet, behind the only interface js/pose-tracker.js
 * actually uses:
 *
 *     estimatePoses(video, opts) -> [{ keypoints: [{ name, x, y, score }, ...] }]
 *     dispose()
 *
 * That seam turned out to be two methods wide, which is why this is a separate
 * file rather than a rewrite: pose-tracker.js keeps every line of its cadence
 * detection, One Euro filtering, gesture thresholds and calibration, and simply
 * gets its keypoints from somewhere else.
 *
 * WHY BOTHER, given MoveNet already works
 *
 * Two reasons, and only two — the rest of the model choice is a wash:
 *
 *   FEET. MediaPipe returns 33 landmarks including heels (29/30) and foot
 *   indices (31/32). MoveNet's COCO-17 stops at the ankles. Which foot is
 *   forward and how deep a lunge is are both much easier with feet, and lunges
 *   are the point of the mode this was added for.
 *
 *   IT WAS VALIDATED FOR THIS. MediaPipe publishes PCK@0.2 of 95.5-97.5 on
 *   Yoga, Dance and HIIT validation sets, single subject 2-4 metres from camera.
 *   This game asks the player to stand 6-10 feet away, which is 1.8-3m. MoveNet
 *   is a general-purpose COCO model with no comparable fitness validation.
 *
 * WHAT THIS IS NOT
 *
 * It is NOT verified to be better here, and nothing in this file should be read
 * as claiming so. It has never been run against a camera in this environment —
 * there isn't one — so the mapping below is tested against synthetic landmarks
 * and the model has never seen a real body. MoveNet stays the default for
 * exactly that reason. Flip between them with ?pose=mediapipe and measure on a
 * real phone; cfg.pose.backend exists so the comparison is one flag wide.
 *
 * COORDINATES
 *
 * MediaPipe returns x/y NORMALISED to 0..1 of the input frame. MoveNet returns
 * pixels. pose-tracker.js expects pixels, so this multiplies up — getting that
 * backwards would silently put every joint in the top-left corner and read as
 * "the model cannot see you".
 * ========================================================================== */

window.HP = window.HP || {};

(function (HP) {
  'use strict';

  /* MediaPipe landmark index -> the COCO names the rest of the codebase speaks.
   *
   * The first 17 are the COCO set pose-tracker.js and js/poses.js already use, so
   * every existing pose, threshold and gesture keeps working untouched. The last
   * four have no MoveNet equivalent and are the reason this backend exists; they
   * are additive, so nothing breaks by their absence on the MoveNet path.
   *
   * MediaPipe's eye landmarks come in inner/centre/outer triples — 2 and 5 are
   * the centres, which is what COCO's left_eye / right_eye mean. */
  const LANDMARK_NAMES = {
    0: 'nose',
    2: 'left_eye',
    5: 'right_eye',
    7: 'left_ear',
    8: 'right_ear',
    11: 'left_shoulder',
    12: 'right_shoulder',
    13: 'left_elbow',
    14: 'right_elbow',
    15: 'left_wrist',
    16: 'right_wrist',
    23: 'left_hip',
    24: 'right_hip',
    25: 'left_knee',
    26: 'right_knee',
    27: 'left_ankle',
    28: 'right_ankle',
    /* --- beyond COCO: the whole point --------------------------------------- */
    29: 'left_heel',
    30: 'right_heel',
    31: 'left_foot_index',
    32: 'right_foot_index',
  };

  /**
   * Convert one MediaPipe result into the MoveNet-shaped pose array.
   *
   * Exported for its own sake: it is pure, so it is the part that CAN be tested
   * without a camera or a GPU, and it is where a silent coordinate or naming
   * mistake would live.
   *
   * @param {object} result   PoseLandmarker output: { landmarks: [[{x,y,visibility}]] }
   * @param {number} w        frame width in pixels
   * @param {number} h        frame height in pixels
   */
  function toMoveNetShape(result, w, h) {
    const sets = result && result.landmarks;
    if (!sets || !sets.length || !sets[0] || !sets[0].length) return [];
    const lm = sets[0];
    const keypoints = [];
    Object.keys(LANDMARK_NAMES).forEach((k) => {
      const i = +k;
      const p = lm[i];
      if (!p) return;
      keypoints.push({
        name: LANDMARK_NAMES[i],
        x: p.x * w,
        y: p.y * h,
        /* `visibility` is MediaPipe's confidence and plays the role MoveNet's
         * `score` plays downstream, where it is compared against
         * cfg.pose.minKeypointScore. Absent on some builds, in which case a
         * present landmark is taken at face value rather than dropped — a
         * missing confidence must not read as "cannot see you". */
        score: p.visibility === undefined ? 1 : p.visibility,
      });
    });
    return keypoints.length ? [{ keypoints: keypoints }] : [];
  }

  /**
   * Build a detector that pose-tracker.js can use in place of MoveNet.
   *
   * @param {object} cfg  HP.CONFIG
   */
  async function createMediaPipeDetector(cfg) {
    if (typeof Vision === 'undefined') {
      throw new Error(
        'MediaPipe failed to load (vendor/mediapipe/vision_bundle.js). ' +
        'Run ./tools/vendor-mediapipe.sh — the wasm and model are gitignored.');
    }
    const p = cfg.pose;
    const fileset = await Vision.FilesetResolver.forVisionTasks(p.mediapipeWasmPath);
    const landmarker = await Vision.PoseLandmarker.createFromOptions(fileset, {
      baseOptions: {
        modelAssetPath: p.mediapipeModelPath,
        /* GPU for the same reason pose-tracker.js insists on the WebGL backend
         * for TF.js: on CPU this runs at single-digit fps, which cannot resolve a
         * step pattern at all. */
        delegate: 'GPU',
      },
      runningMode: 'VIDEO',
      numPoses: 1,
      minPoseDetectionConfidence: p.minPoseScore,
      minPosePresenceConfidence: p.minPoseScore,
      minTrackingConfidence: p.minPoseScore,
      outputSegmentationMasks: false,
    });

    /* VIDEO mode requires strictly increasing timestamps and throws on a repeat,
     * which is easy to hit when a frame arrives twice or the clock is coarse. */
    let lastTs = -1;

    return {
      backendName: 'mediapipe',
      estimatePoses(video) {
        const w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) return [];
        let ts = (typeof performance !== 'undefined' ? performance.now() : Date.now());
        if (ts <= lastTs) ts = lastTs + 1;
        lastTs = ts;
        /* Synchronous, unlike MoveNet's promise. The call site awaits it, and
         * awaiting a non-promise is fine, so no branch is needed there. */
        return toMoveNetShape(landmarker.detectForVideo(video, ts), w, h);
      },
      dispose() {
        try { landmarker.close(); } catch (e) { /* already gone */ }
      },
    };
  }

  HP.mediapipe = {
    LANDMARK_NAMES: LANDMARK_NAMES,
    toMoveNetShape: toMoveNetShape,
    createDetector: createMediaPipeDetector,
  };
})(window.HP);
