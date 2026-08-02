# Design: Wall Mode

An auto-scrolling mode where the player does not run in place. Walls with
pose-shaped cutouts approach, and the player must be in that shape as each wall
passes through them.

Status: **design, not built.** Nothing in `js/` implements this. Companion to
[`DESIGN-exercise-map.md`](./DESIGN-exercise-map.md), which covers the
rep-gate/segment approach for the *running* mode — read that one for the
exercise-detectability tiers, which apply here too.

Every number below is marked **[measured]** (verified this session against the
real tracker) or **[proposed]** (a starting guess to be tuned by playing).

---

## 1. What it is, and why it exists

The running mode couples effort to survival: your pace is your speed, and a void
eats you if you slack. That is its whole engine.

Wall Mode throws that engine away. The world scrolls at a speed **the level
sets**, and the player's only job is:

> read the shape coming at you → get your body into it → hold it while it passes

This exists because it solves two problems the running mode could not.

**Tempo.** In the running mode an obstacle gives 3.7 seconds of warning at a
comfortable pace, and a burpee takes 2–4 seconds to perform, so slow exercises
simply do not fit. When the game controls the speed, a 3-second movement is fine
if walls arrive every 4 seconds. The constraint dissolves.

**Framing.** A burpee's floor phase is invisible to the standing camera setup —
**[measured]** all six core keypoints drop to 0.02 confidence, `coreVisible` goes
false, and an unmodified build reads a burpee as "the player left the frame."
Because Wall Mode has no running, it can ask for a floor-friendly camera *once*,
at setup, instead of needing two incompatible aims in one session.

The cost is real and must be designed around: **effort is no longer required to
progress.** See §9.

---

## 2. What it inherits, and what it discards

Reused as-is — this is most of the value:

| Machinery | Why it transfers |
| --- | --- |
| Body-scale normalisation | Makes pose matching height- and distance-invariant for free. §4 |
| One Euro filtering | Same jitter problem, same fix |
| `sim.signals` as the only pose→game crossing | Keeps `?sim=1` keyboard testing possible. §10 |
| Real-clock timestep | **[measured]** Phaser's delta is smoothed toward the target frame rate and lies on any device under 60fps. Wall timing is timing-critical here, so this matters more, not less |
| Low-frame-rate watchdog | Pose sampling still bounds everything |
| 3 lanes, lean/step → lane | **[measured]** a lane change is a 14cm torso shift, and the frame has ~3.5× the room needed. §12 |

Discarded:

- **Cadence** — no running, so `paceRatio`, the pace curve, and the comfortable-pace
  calibration are all unused.
- **The void** — nothing chases you. Failure is health/score. §9
- **Jump and duck as gestures** — subsumed by pose matching. A "jump" is a pose
  wall with an airborne silhouette; a "duck" is a crouch silhouette.

---

## 3. Wall lifecycle

```
  spawn ────── telegraph ────── ARM ──────┬── CONTACT ──┬───── resolve
  ~4s out      shape readable       ~1.2s │   passing   │
                                          │   through   │
                                  fit meter on     thickness ÷ speed
```

| Phase | Trigger | Behaviour |
| --- | --- | --- |
| Spawn | `atZ` from the level | Wall enters at the far plane |
| Telegraph | on spawn | Silhouette drawn and growing. Must be *recognisable* small — see the shape-distinctness rule in §5 |
| Arm | ~1.2s before contact **[proposed]** | Start sampling the player's pose; show the fit meter (§7) |
| Contact | wall reaches the player's z | Duration = `thickness ÷ speed`. Accumulate held time |
| Resolve | wall passes | Pass, or crash (§9) |

Contact is a *window*, never an instant. **[measured]** At the frame rates this
runs at, a single-frame check is unreliable — the same reasoning that made jump
confirmation duration-based rather than frame-count based.

---

## 4. Pose matching

Nearly free, because the hard part already exists. Keypoints are normalised by
body scale, so a match is a distance comparison:

```
for each joint J in pose.joints:
    live[J]   = (keypoint[J] − hipMidpoint) / bodyScale
    target[J] = pose.target[J]                       (same normalisation)

error   = mean( distance(live[J], target[J]) )
matched = error < pose.tolerance
```

Anchoring on the hip midpoint makes it translation-invariant; dividing by
`bodyScale` makes it scale-invariant. So a 5'2" player standing 6ft away and a
6'4" player standing 10ft away hit the same target. That is the same property
every existing threshold relies on, and it is why no ML is needed.

`tolerance` starts at **0.15 bs [proposed]**.

### Only the joints the pose defines

Each pose declares its own `joints` list and **everything else is ignored**. A
squat is hips and knees; where the arms are is irrelevant. Score the full
skeleton and a stray arm fails a correct squat.

### Two hard constraints on the pose vocabulary

**No depth.** MoveNet is 2D, so poses differing only front-to-back — arm forward
vs arm back — are indistinguishable. This is *not* the limitation it appears to
be: it is also the **silhouette's** limitation. If two poses project to the same
outline, the player could not tell them apart from the wall either. The sensor and
the mechanic fail identically, so design poses as silhouettes and nothing is lost.

**Framing bounds the vocabulary.** Feet are not required in frame (the standing
setup deliberately stops at the knees to buy ~25% standing distance), so a pose
must be distinguishable from roughly the top 72% of the body. Fine: star, squat
bottom, side bend, overhead reach, single-knee raise. Not fine: anything defined
by foot placement.

---

## 5. Pass condition

Accumulate held time during contact, and pass on a fraction of the window:

```
if matched:  heldSeconds += dt
pass = heldSeconds >= contactDuration × minHeldFraction
```

`minHeldFraction` = **0.8 [proposed]**. High enough that flailing through several
poses cannot get lucky; loose enough that one bad keypoint frame does not fail a
correct hold.

### Shape distinctness is a validation rule, not a hope

Two poses whose normalised targets are closer together than `2 × tolerance` are
**mutually unreachable** — a player matching one matches both, and the game cannot
tell which they meant. The pose registry should reject that at load time rather
than producing mysterious behaviour.

---

## 6. Reps come from positions, not rep counting

A single wall proves a **position**, not a **movement**. If a wall demands the
bottom of a push-up, a player can lower into it and sit there. That is a hold.

So alternate the shapes and let the rep emerge:

```
  ▢ SQUAT       ▯ STAND       ▢ SQUAT       ▯ STAND
  hips low      upright       hips low      upright
  └───────── one squat ─────────┘
```

You cannot pass STAND from a squat, or SQUAT while upright, so **alternation
enforces itself.** No state machines, no rep counters, no anti-cheese logic.

Two consequences worth building in:

- **Level rule:** never two consecutive walls with the same pose. The loader
  should reject it — consecutive identical walls are a free pass.
- **Wall spacing = rep tempo.** The player cannot rush or stall; the level
  dictates when each position must happen. This kills the cheat that rep
  counters suffer from, where bouncing shallow and fast inflates a count.

### Thickness = time under tension

`contactDuration = thickness ÷ speed`, so wall thickness is a direct dial on how
long a position must be held. Thin wall: snap into it. Thick wall: hold it. **A
plank is just a very long wall** — which means isometrics need no special code,
and for isometrics a position check is the *correct* measurement anyway.

---

## 7. The fit meter — the piece that decides whether this is fun

`error` is continuous, so **do not hide it behind pass/fail.** The player needs to
know they are at 70% and closing while there is still time to fix it.

- Silhouette fills / brightens as `error` falls.
- Locks visibly at the moment `matched` becomes true.
- During contact, show held-time accumulating against what is required.

Without this the mode is a guessing game, and a near-miss is indistinguishable
from a wild miss. This is not polish — it is the core feedback loop, and it should
exist in the first prototype.

---

## 8. Difficulty

Levers, in the order I would reach for them:

1. **Pose difficulty** — how demanding the shape is.
2. **Wall density** — reps per minute.
3. **Thickness** — hold duration.
4. **Tolerance** — how precise the match must be.
5. **Speed** — last resort, and it should be **capped**.

Speed is deliberately last. Raising it shortens the arm window, which forces
faster reps, which degrades form — the opposite of what a fitness game should
reward. Difficulty should come from *harder and longer*, not *rushed*.

---

## 9. Failure, and the mode's core weakness

**On a miss:** crash through, lose health, lose the combo multiplier — but **keep
moving.** An auto-scroller should not stall.

**The weakness to design against:** progress no longer depends on effort. A player
can ignore every wall, eat the damage, and still travel. In the running mode this
was impossible; the void guaranteed the workout.

Health alone is a weak guarantee, so:

- Missed walls **cost the score multiplier**, making the score evidence of work
  rather than of elapsed time.
- Report **reps completed**, not just distance, on the summary.
- Consider distance itself being multiplier-scaled, so coasting literally does not
  get you far.

**Safety, carried over from the other doc:** cap consecutive hard walls, mandate
recovery stretches in the level data, and never require max effort to survive —
only to excel.

---

## 10. Data model

### Level

```js
{
  id: 'squats-intro',
  facing: 'front',            // 'front' | 'side' — see §12
  speed: 8,                   // world units/sec, constant
  lanes: true,                // false for side-on sessions
  walls: [
    { pose: 'squat_bottom', thickness: 0.4, atZ: 40 },
    { pose: 'stand_tall',   thickness: 0.3, atZ: 55 },
    { pose: 'squat_bottom', thickness: 0.4, atZ: 70 },
    { pose: 'rest',         thickness: 0.0, atZ: 95 },   // breather
  ],
}
```

### Pose

```js
{
  id: 'squat_bottom',
  facing: 'front',
  tolerance: 0.15,
  joints: ['left_hip','right_hip','left_knee','right_knee',
           'left_shoulder','right_shoulder'],
  target: { /* normalised offsets from the hip midpoint */ },
  silhouette: [ /* polygon for the cutout, drawn from `target` */ ],
}
```

### The architectural invariant

`GameSim` must stay free of pose code, exactly as in the running mode. The wall
sim consumes **one new signal** —

```js
sim.signals.poseError   // continuous, lower is better; Infinity when untracked
```

— alongside the existing `tracked`. Everything else (matched, held time, pass/fail)
is derived inside the sim from that one number.

This is what keeps `?sim=1` working: a keyboard key can drive `poseError` toward
zero, so the whole mode is tunable at a desk without a camera. That has been worth
more than anything else in this project so far, and it should not be given up.

---

## 11. Where target poses come from

Two options, and the second is better:

1. **Hand-authored** normalised skeletons. Works, but every target is a guess
   about what an average body can reach.
2. **Recorded from the player**: "copy this shape" once, per pose, behind a
   one-off unlock. Guarantees the target is achievable by *that* body,
   personalises difficulty exactly as the cadence calibration already does, and
   makes the silhouette on the wall literally their own outline.

Option 2 costs setup time, so it belongs in an unlock flow rather than the
per-session calibration — which should stay as short as it is now.

This also fixes a known gap: lean and duck thresholds are currently scaled to body
*size* but not to range of *motion*. Recorded poses are range-of-motion capture by
construction.

---

## 12. Camera, facing, and the lane trade

**[measured]** A floor-level camera angled up is the best single position, because
everything of interest is *above* the lens. At 2m away, lens ~8cm off the floor,
tilted up ~19°:

| To see | Angle from horizontal |
| --- | --- |
| Floor at the player's feet | −2.3° |
| Head, standing | +39.9° |
| **Total span** | **42°** — fits a typical ~60° vertical FOV |

**[measured]** Tilt has a cost: thresholds are fractions of on-screen torso
length, which foreshortens as `cos(tilt)`. At 45° a lean needs 21px and a duck
13px; at 75° they are 8px and 5px, indistinguishable from keypoint jitter. **Keep
tilt under ~45°, and never lay the phone flat** — flat also breaks the assumption
that the image's vertical axis is gravity.

### Front vs side

| | Front-facing | Side-on |
| --- | --- | --- |
| Lanes | ✅ work | ❌ a sideways step moves toward the lens, not across frame |
| Standing poses | ✅ | ✅ |
| Push-ups / planks | ❌ torso foreshortens to nothing | ✅ **[measured]** torso projects at full length; shoulders travel ~0.87 bs between top and bottom, ~3× a duck threshold |
| Form legibility | worse | better — how every form-check video is shot |

**They cannot be mixed within a session**, so `facing` is a level property.
Side-on sessions set `lanes: false` and draw **profile** silhouettes — a
front-view star is unmatchable to a player standing sideways.

---

## 13. Status: proven vs unknown

**Proven this session:**

- Body-scale normalisation works and makes thresholds size/distance invariant.
- The skeleton tracks a real standing body — the model loads and runs on a phone.
- Standing detectors reject noise: **[measured]** zero false triggers for jump,
  duck, lane or "running" at up to 8px of Gaussian keypoint jitter.
- Derivative signals are the fragile ones: **[measured]** 30 false jumps/min at
  8px jitter, fixed by requiring the condition to persist. Pose matching reads
  *positions*, not derivatives, so it should be inherently steadier than jump
  detection ever was.

**Unknown, and blocking the floor half:**

- **Does MoveNet report usable keypoints for a prone body seen from ground
  level?** The geometry says the signal is large. Whether the model — trained
  mostly on upright people — produces accurate keypoints in that pose is untested,
  because the weights cannot be downloaded in the dev sandbox. This is a five
  minute check on a real phone and it decides whether push-ups, planks and
  burpees are in or out.
- **Can a person read a silhouette and hit it in ~1.2s while winded?** Nothing
  about this design survives a "no" here, and no amount of tuning fixes it.

---

## 14. Build order

Sequenced so the riskiest assumption dies first and cheapest.

1. **Pose comparator** — pure function of the metrics snapshot, unit-tested
   against synthetic keypoints. No game changes.
2. **`poseError` into `sim.signals`**, plus a keyboard driver so `?sim=1` can fake
   a match.
3. **One wall, one hand-authored pose** (a star), full width, fit meter,
   health on miss. Auto-scroll at a constant speed.
4. **STOP AND PLAY IT.** Can you hit a shape in time? Does the fit meter make it
   feel fair? If not, stop here — the rest is wasted.
5. Alternating pairs → reps. Thickness → holds.
6. Level data + the loader's validation rules (§5, §6).
7. Recorded target poses (§11).
8. Side-on sessions and floor poses — last, and only if §13's unknown resolves
   favourably.

Step 3 is a day. Step 4 is the whole bet.

---

## 15. Open questions

- **Does missing a wall need a physical consequence** beyond health and
  multiplier? A stumble animation reads well but stalling breaks auto-scroll.
- **Do coins/pickups belong in the lanes** to give the lanes a job on
  front-facing levels, or does that split attention too far?
- **How is a session paced?** The running mode's difficulty emerged from the void
  ramp. Here it is entirely authored, which means somebody has to design workouts
  — that is a content problem, not a code problem, and it is the real long-term
  cost of this mode.
- **Is `rest` a wall with no pose, or the absence of walls?** Absence is simpler
  but gives no positive feedback that a breather is intentional rather than a
  content gap.
