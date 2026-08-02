/* =============================================================================
 * Huff&Puff — POSE LIBRARY + MATCHER (Wall Mode)
 * =============================================================================
 * Turns "is the player currently in this shape?" into a single number.
 *
 * THE WHOLE TRICK is that the hard part is already done elsewhere. Keypoints
 * arrive body-scale normalised, so a pose match is just a distance comparison:
 *
 *     live[joint]  = (keypoint - hipMidpoint) / bodyScale
 *     error        = MAX over the pose's joints of |live[joint] - target[joint]|
 *
 * The error is the WORST joint, not the average, and that is load-bearing. The
 * first version averaged, and the validator immediately caught what averaging
 * does: knee_up_left differs from stand_tall in exactly one joint, by 0.84 body
 * scales — but spread across six scored joints that averages to 0.14, under a
 * 0.15 tolerance. Standing perfectly still would have matched "left knee up".
 *
 * Max also says the right thing: a pose is a shape, so EVERY joint it cares
 * about has to be in place, and one wrong limb cannot be compensated for by
 * five correct ones. The cost is sensitivity to a single jittery keypoint, which
 * is what the One Euro filter upstream and a slightly looser tolerance absorb.
 *
 * Anchoring on the hip midpoint makes it translation-invariant. Dividing by
 * bodyScale makes it scale-invariant. So a 5'2" player standing 6ft away and a
 * 6'4" player standing 10ft away hit the same target, and no training data, no
 * model, and no per-player authoring is needed.
 *
 * TWO RULES THAT SHAPE THE WHOLE LIBRARY
 *
 * 1. Only the joints a pose actually defines are scored. A squat is hips and
 *    knees; where the arms are is irrelevant. Score the full skeleton and a
 *    stray arm fails a correct squat.
 *
 * 2. Poses must be distinguishable AS SILHOUETTES. MoveNet is 2D, so arm-forward
 *    and arm-back are the same to it — but they are also the same to the player
 *    looking at a cutout in a wall. The sensor and the mechanic have identical
 *    blind spots, so designing for the silhouette costs nothing.
 *
 * Coordinate reminder: pose-tracker.js mirrors every x once, so in this space
 * SMALLER x is the player's own LEFT, and y grows DOWNWARD.
 * ========================================================================== */

window.HP = window.HP || {};

(function (HP) {
  'use strict';

  const util = HP.util;

  /* Bones used to draw a pose as a readable stick figure (wall cutouts and the
   * fit meter). Same topology as the debug skeleton, minus the ankles, since
   * feet are deliberately outside the framing. */
  const POSE_BONES = [
    ['left_shoulder', 'right_shoulder'],
    ['left_shoulder', 'left_elbow'], ['left_elbow', 'left_wrist'],
    ['right_shoulder', 'right_elbow'], ['right_elbow', 'right_wrist'],
    ['left_shoulder', 'left_hip'], ['right_shoulder', 'right_hip'],
    ['left_hip', 'right_hip'],
    ['left_hip', 'left_knee'], ['right_hip', 'right_knee'],
  ];

  /* ===========================================================================
   * The starter library — all front-facing, all standing.
   * ---------------------------------------------------------------------------
   * Deliberately excludes anything needing the floor in frame, and anything
   * defined by foot placement, because framing stops at the knees.
   *
   * Targets are in body-scale units from the hip midpoint. Reference values for
   * a neutral adult: shoulders at y -1.0, shoulder half-width 0.40, hip
   * half-width 0.18, knees at y +1.0.
   * ======================================================================== */
  const POSES = {
    /* Neutral. The "other half" of every rep — see wall-mode.js on how a rep is
     * composed from two positions rather than counted. */
    stand_tall: {
      id: 'stand_tall',
      label: 'STAND TALL',
      facing: 'front',
      joints: ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip',
               'left_knee', 'right_knee', 'left_wrist', 'right_wrist'],
      target: {
        nose: [0, -1.45],
        left_shoulder: [-0.40, -1.00], right_shoulder: [0.40, -1.00],
        left_elbow: [-0.45, -0.55], right_elbow: [0.45, -0.55],
        left_wrist: [-0.48, -0.10], right_wrist: [0.48, -0.10],
        left_hip: [-0.18, 0], right_hip: [0.18, 0],
        left_knee: [-0.20, 1.00], right_knee: [0.20, 1.00],
      },
    },

    /* Jumping-jack open position. Needs HEADROOM: the wrists sit well above the
     * head, so the framing step has to leave room above the player. */
    star: {
      id: 'star',
      label: 'STAR',
      facing: 'front',
      joints: ['left_wrist', 'right_wrist', 'left_elbow', 'right_elbow',
               'left_knee', 'right_knee', 'left_shoulder', 'right_shoulder'],
      target: {
        nose: [0, -1.45],
        left_shoulder: [-0.40, -1.00], right_shoulder: [0.40, -1.00],
        left_elbow: [-0.75, -1.45], right_elbow: [0.75, -1.45],
        left_wrist: [-1.00, -1.85], right_wrist: [1.00, -1.85],
        left_hip: [-0.18, 0], right_hip: [0.18, 0],
        left_knee: [-0.55, 0.95], right_knee: [0.55, 0.95],
      },
    },

    /* Bottom of a squat. Note this works BECAUSE the frame is hip-relative: the
     * hips do not move in this space, but the knees rise toward hip level and
     * spread outward, which is exactly what a squat does. */
    squat_bottom: {
      id: 'squat_bottom',
      label: 'SQUAT',
      facing: 'front',
      joints: ['left_knee', 'right_knee', 'left_shoulder', 'right_shoulder',
               'left_hip', 'right_hip'],
      target: {
        nose: [0, -1.35],
        left_shoulder: [-0.40, -0.92], right_shoulder: [0.40, -0.92],
        left_elbow: [-0.38, -0.50], right_elbow: [0.38, -0.50],
        left_wrist: [-0.18, -0.68], right_wrist: [0.18, -0.68],
        left_hip: [-0.20, 0], right_hip: [0.20, 0],
        left_knee: [-0.46, 0.44], right_knee: [0.46, 0.44],
      },
    },

    /* Arms straight out sideways at shoulder height. Reads as a clean cross and
     * is trivially distinguishable from both stand_tall and star. */
    t_pose: {
      id: 't_pose',
      label: 'ARMS OUT',
      facing: 'front',
      joints: ['left_wrist', 'right_wrist', 'left_elbow', 'right_elbow',
               'left_knee', 'right_knee'],
      target: {
        nose: [0, -1.45],
        left_shoulder: [-0.40, -1.00], right_shoulder: [0.40, -1.00],
        left_elbow: [-0.80, -1.02], right_elbow: [0.80, -1.02],
        left_wrist: [-1.18, -1.04], right_wrist: [1.18, -1.04],
        left_hip: [-0.18, 0], right_hip: [0.18, 0],
        left_knee: [-0.20, 1.00], right_knee: [0.20, 1.00],
      },
    },

    /* One knee driven up to hip height. Left/right are separate poses, which is
     * what lets a level alternate them into marching. */
    knee_up_left: {
      id: 'knee_up_left',
      label: 'LEFT KNEE UP',
      facing: 'front',
      joints: ['left_knee', 'right_knee', 'left_hip', 'right_hip',
               'left_shoulder', 'right_shoulder'],
      target: {
        nose: [0, -1.45],
        left_shoulder: [-0.40, -1.00], right_shoulder: [0.40, -1.00],
        left_elbow: [-0.45, -0.55], right_elbow: [0.45, -0.55],
        left_wrist: [-0.48, -0.10], right_wrist: [0.48, -0.10],
        left_hip: [-0.18, 0], right_hip: [0.18, 0],
        left_knee: [-0.26, 0.16], right_knee: [0.20, 1.00],
      },
    },

    knee_up_right: {
      id: 'knee_up_right',
      label: 'RIGHT KNEE UP',
      facing: 'front',
      joints: ['left_knee', 'right_knee', 'left_hip', 'right_hip',
               'left_shoulder', 'right_shoulder'],
      target: {
        nose: [0, -1.45],
        left_shoulder: [-0.40, -1.00], right_shoulder: [0.40, -1.00],
        left_elbow: [-0.45, -0.55], right_elbow: [0.45, -0.55],
        left_wrist: [-0.48, -0.10], right_wrist: [0.48, -0.10],
        left_hip: [-0.18, 0], right_hip: [0.18, 0],
        left_knee: [-0.20, 1.00], right_knee: [0.26, 0.16],
      },
    },
  };

  /* ===========================================================================
   * Matching
   * ======================================================================== */

  /**
   * Re-express a keypoint map in body-scale units relative to the hip midpoint.
   * Returns null when there is nothing trustworthy to anchor on.
   */
  function normalise(keypointMap, bodyScale) {
    if (!keypointMap || !(bodyScale > 0)) return null;
    const lh = keypointMap.left_hip;
    const rh = keypointMap.right_hip;
    if (!lh || !rh) return null;
    const hx = (lh.x + rh.x) / 2;
    const hy = (lh.y + rh.y) / 2;
    const out = Object.create(null);
    const names = Object.keys(keypointMap);
    for (let i = 0; i < names.length; i++) {
      const kp = keypointMap[names[i]];
      out[names[i]] = {
        x: (kp.x - hx) / bodyScale,
        y: (kp.y - hy) / bodyScale,
        score: kp.score,
      };
    }
    return out;
  }

  /**
   * Worst-joint distance between a normalised live pose and a target, in
   * body-scale units. Lower is better; 0 is a perfect match.
   *
   * MAX rather than mean — see the note at the top of this file for the concrete
   * bug averaging caused.
   *
   * Returns Infinity rather than a large number when a joint the pose depends on
   * is not confidently visible. "I cannot tell" must never read as "close
   * enough": a caller comparing against a tolerance would otherwise be fooled by
   * a missing limb whose coordinates sit near the origin.
   *
   * @returns {{error:number, worst:string|null}}
   */
  function poseErrorDetail(norm, pose, minKeypointScore) {
    if (!norm || !pose) return { error: Infinity, worst: null };
    const joints = pose.joints;
    const minScore = minKeypointScore === undefined ? 0.3 : minKeypointScore;
    let worstD = 0;
    let worst = null;
    let n = 0;
    for (let i = 0; i < joints.length; i++) {
      const name = joints[i];
      const target = pose.target[name];
      if (!target) continue;              // pose lists a joint it never defined
      const live = norm[name];
      if (!live || live.score < minScore) return { error: Infinity, worst: name };
      const dx = live.x - target[0];
      const dy = live.y - target[1];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > worstD) { worstD = d; worst = name; }
      n++;
    }
    return n ? { error: worstD, worst: worst } : { error: Infinity, worst: null };
  }

  function poseError(norm, pose, minKeypointScore) {
    return poseErrorDetail(norm, pose, minKeypointScore).error;
  }

  /** Worst-joint distance between two TARGETS, for the distinctness check. */
  function targetDistance(a, b) {
    const joints = {};
    a.joints.forEach((j) => { joints[j] = 1; });
    b.joints.forEach((j) => { joints[j] = 1; });
    const names = Object.keys(joints);
    let worst = 0;
    let n = 0;
    for (let i = 0; i < names.length; i++) {
      const ta = a.target[names[i]];
      const tb = b.target[names[i]];
      if (!ta || !tb) continue;
      const dx = ta[0] - tb[0];
      const dy = ta[1] - tb[1];
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d > worst) worst = d;
      n++;
    }
    return n ? worst : Infinity;
  }

  /**
   * Two poses closer together than 2x tolerance are mutually unreachable: a
   * player matching one matches both, and the game cannot tell which they meant.
   * That is a content bug, and it should be loud at startup rather than showing
   * up later as walls that pass when they should not.
   *
   * @returns {Array<string>} human-readable problems; empty means fine.
   */
  function validateLibrary(poses, tolerance) {
    const ids = Object.keys(poses);
    const problems = [];
    for (let i = 0; i < ids.length; i++) {
      const a = poses[ids[i]];
      // Every scored joint must actually have a target.
      for (let k = 0; k < a.joints.length; k++) {
        if (!a.target[a.joints[k]]) {
          problems.push(a.id + ' scores "' + a.joints[k] + '" but has no target for it');
        }
      }
      for (let j = i + 1; j < ids.length; j++) {
        const b = poses[ids[j]];
        if (a.facing !== b.facing) continue;
        const tol = Math.max(a.tolerance || tolerance, b.tolerance || tolerance);
        const d = targetDistance(a, b);
        if (d < tol * 2) {
          problems.push(a.id + ' and ' + b.id + ' are only ' + d.toFixed(3) +
            ' apart, under the ' + (tol * 2).toFixed(3) + ' needed to tell them apart');
        }
      }
    }
    return problems;
  }

  /**
   * Bounding box of a pose's drawable joints, in body-scale units. Used to size
   * the cutout in a wall and to fit the target into the fit meter.
   */
  function poseBounds(pose) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    Object.keys(pose.target).forEach((name) => {
      const t = pose.target[name];
      if (t[0] < minX) minX = t[0];
      if (t[0] > maxX) maxX = t[0];
      if (t[1] < minY) minY = t[1];
      if (t[1] > maxY) maxY = t[1];
    });
    // Leave room for the head circle, which sits above the topmost joint.
    minY -= 0.28;
    return { minX, maxX, minY, maxY, width: maxX - minX, height: maxY - minY };
  }

  HP.POSES = POSES;
  HP.POSE_BONES = POSE_BONES;
  HP.poseLib = {
    normalise: normalise,
    poseError: poseError,
    poseErrorDetail: poseErrorDetail,
    targetDistance: targetDistance,
    validateLibrary: validateLibrary,
    poseBounds: poseBounds,
    /** Convenience: error against a pose id. */
    errorFor: function (norm, poseId, minScore) {
      return poseError(norm, POSES[poseId], minScore);
    },
  };
})(window.HP);
