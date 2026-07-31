# Design: the exercise map

Turning Huff&Puff from a single-verb runner into a route of exercise segments —
burpees, lunges, squats, jacks — without breaking what already works.

Status: **design, not built.** Nothing in `js/` implements this yet. Written to
be argued with before any code exists.

---

## 1. The problem this has to solve first

The game today is **continuous**: cadence → speed, resampled 30×/sec, forever.
Burpees are **discrete and slow** — 2–4 seconds per rep.

Do the arithmetic on the current obstacle pipeline. `obstacleSpawnZ` is 90m,
`obstacleWarnZ` is 45m, and a player at their comfortable pace moves 12 m/s. So a
warning gives **3.7 seconds** of notice. You cannot do a burpee in 3.7 seconds
while also running.

So a burpee cannot be a fourth obstacle kind alongside `lane` / `low` / `high`.
The container has to change, not just the contents.

### Options considered

| Approach | Mechanic | Verdict |
| --- | --- | --- |
| Bullet-time | World slows as the pose wall nears | **No.** Breaks "your pace is your speed", the one honest thing in the game |
| Gate | Wall *stops* you; void keeps closing; reps open it | **Yes.** Best tension — the exercise is *paid*, not dodged |
| Segment | Map is zoned; in a burpee zone each rep *is* one step forward | **Yes.** This is the "map" the whole idea wants |
| Arena | Running stretches punctuated by rep blocks, void paused | Falls out of Segment for free — a void-paused segment *is* a rest interval |

**Chosen: Segment as the container, Gate as the pressure.** The map becomes a
sequence of typed segments; gates sit at segment boundaries. "Arena" is then just
a segment with `voidBehaviour: 'pause'`, which means recovery intervals are a
map-authoring decision rather than new code.

The consequence worth noticing: **the map layout becomes the workout program.**
Strength blocks, cardio blocks and recovery blocks are all just segment types in
a list. That is the thing this can do that a workout video cannot.

---

## 2. What the camera can actually see

This constrains the exercise list far more than the game design does. Grounded in
what `pose-tracker.js` already computes: 17 COCO keypoints, **no depth**, camera
at knee height 6–10ft out, everything normalised by shoulder-to-hip distance.

### Tier 1 — reuses signals that already exist

| Exercise | Signal | Notes |
| --- | --- | --- |
| Squat | `hipOffset` past a deeper threshold than `duckEnter` | Effectively already implemented |
| Jumping jack | wrists above shoulders **and** knee-x separation widening, in phase | Two independent signals; very robust |
| High knees | existing cadence with a raised amplitude gate | A "sprint" variant |
| Skater / lateral hop | `centerOffset` + `hipVelocity` together | Free |
| Side lunge | knee-x separation + moderate hip drop, torso upright | Prefer over forward lunge — see below |
| ~~Butt kicks~~ | heel travelling toward the glute | **Needs feet in frame** — see below |

> **Leg-spread signals must key off KNEES, not ankles.** `requiredKeypoints` stops
> at the knees so the player can stand ~25% closer, which means feet are usually
> outside the frame. Knees separate in a jumping jack and a side lunge too, so
> nothing is lost. Butt kicks are the exception and drop out of Tier 1: the heel
> travelling to the glute *is* the exercise, so there is no knee-based
> substitute. Either require feet for that one movement or leave it out.
>
> Overhead movements need headroom instead: a jack only registers if the raised
> wrists are inside the frame. A floor-level camera tilted slightly up gains
> headroom as it loses floor, which happens to suit this — but it is a real
> constraint on the framing step, not a free assumption.

### Tier 2 — needs a new state machine, but sound

- **Burpee.** A 4-state sequence (§4). Detectable as *honest reps*; **form is not
  judgeable** and we should not pretend otherwise. ⚠️ Requires the floor to be in
  frame, which the standing setup does not provide — see the framing conflict
  below, which is the thing that actually decides whether this is buildable.
- **Alternating forward lunge.** Structurally the *same signal as running* —
  knee-height asymmetry — just slower and deeper. Reuses `kneeDiff` with a
  different deadband and interval band.
- **Plank hold.** A *held state*, not a rep. Different game verb (endurance).

### Tier 3 — risky with this camera and model

- **Push-ups, mountain climbers.** Prone and facing *away*: the camera sees the
  top of the head, and the torso foreshortens to nearly nothing — which also
  destroys `bodyScale`, the normaliser everything else depends on.

### THE FRAMING CONFLICT — measured, and it breaks the burpee plan

The tier list above quietly assumes one camera setup serves every exercise. It
does not, and the conflict is not about which keypoints you need — it is about
**where the camera is pointing.**

Standing framing wants the phone **low and tilted UP**, which maximises vertical
coverage of an upright body and is what the setup copy now recommends. That aim
points the camera *away from the floor*. Floor exercises need the opposite.

Simulated one burpee against the real tracker, with the floor just below the
frame (out-of-image keypoints given the near-zero confidence MoveNet actually
returns):

```
 1 standing        tracked: true    shoulders 0.9  hips 0.9  knees 0.9
 2 squat           tracked: true    shoulders 0.9  hips 0.9  knees 0.9
 3 down (floor)    tracked: FALSE   shoulders 0.02 hips 0.02 knees 0.02
 4 back up         tracked: true    shoulders 0.9  hips 0.9  knees 0.9
```

The down phase is **entirely invisible**. All six core keypoints fall below
`minKeypointScore`, `coreVisible` goes false, and `_handleLostPose` runs — so the
`bodyScale`-collapse signal the burpee state machine in §4 is built on **never
fires**, because there is no pose at all to measure it from.

Worse, in-game this trips `trackingLossGraceSeconds`: an unmodified build reads a
burpee as *"the player has left the frame"* and freezes the void.

Consequences for this design:

- **Framing is a per-segment property, not a global setup step.** A `floor`
  segment needs the camera aimed differently from a `run` segment, so segments
  must carry framing requirements, and the map loader has to reject a map that
  mixes incompatible ones without a re-framing beat between them.
- **A compromise framing exists but is expensive.** One camera position covering
  floor-to-standing-head, level rather than tilted up, needs a frame roughly the
  player's height in *both* axes — so meaningfully more distance, which is the
  resource players have least of. It also shrinks the standing body in frame,
  costing keypoint precision for the running segments that dominate play.
- **Re-aiming mid-session is not an option.** You cannot ask someone to bend down
  and re-prop a phone while a void is chasing them.
- **There is a crude fallback**: "descended, vanished from frame for 0.5–3s,
  reappeared standing" is a usable burpee signature that needs no floor
  visibility at all. It is spoofable — ducking below frame satisfies it — and it
  cannot count depth or form, so it is only honest with a rep-time floor and a
  clear label that it is generous.

**So v1 of the map should be standing-only.** That is exactly the Tier 1 list —
squats, jacks, high knees, lateral hops, side lunges, butt kicks — which reuses
signals that already exist, needs no re-framing, and is a complete workout.
Burpees, push-ups, planks and mountain climbers belong in a separate **floor
mode** with its own framing step and its own calibration, entered deliberately
between sessions rather than mid-run.

### The trick that rescues floor work

Have the game instruct the player to **turn 90° side-on** for floor segments. In
profile a push-up, plank and burpee are all cleanly visible: the torso keeps its
full length and hip height is unambiguous. You lose lean/lane-change, but a
burpee bridge does not need lanes.

`FLOOR SECTION — TURN SIDEWAYS` is a natural segment transition, and it moves
push-ups and planks from Tier 3 to Tier 2. This is why segments carry a
`facing` field (§3).

### Two rate facts that are counter-intuitive

1. **Slow exercises are *easier* to detect than fast running.** The aliasing
   problem documented in `config.js` only bites fast cadence. A 2-second burpee
   gets ~60 samples at 30 reads/sec. No sampling concern at all.
2. **But they need timeouts, not thresholds.** A rep spans seconds, so every
   Tier 2 detector is a state machine with a deadline, and an abandoned rep must
   reset rather than hang half-complete.

---

## 3. Segment architecture

### The map is data

A map is a plain array, authored in a new `js/maps.js`, consumed by `GameSim`.
Nothing about it should require touching sim logic:

```js
{
  id: 'city-1',
  name: 'Downtown',
  segments: [
    { type: 'run',   lengthM: 260 },
    { type: 'gate',  exercise: 'squat',  reps: 6 },
    { type: 'run',   lengthM: 200, obstacles: ['lane', 'low'] },
    { type: 'gate',  exercise: 'jack',   reps: 10 },
    { type: 'floor', exercise: 'burpee', reps: 5, facing: 'side' },
    { type: 'rest',  seconds: 20 },
    // …repeats, ramping, until the void catches you
  ],
}
```

Four segment types, each a different verb:

| Type | Forward motion | Void | Ends when |
| --- | --- | --- | --- |
| `run` | pace → speed (today's behaviour) | chases | `lengthM` travelled |
| `gate` | **halts** at the barrier | **keeps closing** | reps complete |
| `floor` | halts; player turns side-on | slowed, not paused | reps complete |
| `rest` | coasts at a fixed speed | **paused** | timer |

`gate` is where the design lives. Forward motion stops, the void does not, and
the gap bar the player already knows becomes a countdown they can only stop by
doing the reps. No new pressure mechanic needs inventing — it reuses the void.

`floor` slows rather than pauses the void because the player is on the ground and
cannot see the screen well; a hard chase there is unfair and unsafe. `rest`
pauses it entirely, and is what makes this a workout rather than a grinder.

### Sim changes

`GameSim` gains a segment cursor and a small state machine. Everything already
there stays:

```
GameSim
  + segmentIndex, segmentProgress, segmentState ('active' | 'gated' | 'clearing')
  + activeGate: { exercise, repsRequired, repsDone, startedAt } | null
  + events: 'segmentEnter', 'segmentExit', 'gateOpen', 'gateRep', 'gateCleared', 'gateFailed'
```

The critical invariant: **`update(dt)` must stay pure of pose code.** The gate
consumes `signals.reps[exercise]`, a counter the tracker increments, exactly as
it consumes `signals.paceRatio` today. That keeps `?sim=1` working — a number key
can fake a rep — and keeps the tuning honest.

### What must NOT change

- The pace→speed curve and the void ramp. They are tuned and they work.
- `sim.signals` as the single crossing point between pose and game.
- Config-only tuning: every new threshold goes in `config.js` with a comment.

---

## 4. Detector state machines

New file `js/exercises.js`, holding one detector per exercise behind a common
interface, so `pose-tracker.js` only needs to own the *registry*, not the rules:

```js
{
  id: 'burpee',
  facing: 'front' | 'side' | 'any',
  minRepSeconds: 1.2,          // anti-cheese floor
  maxRepSeconds: 8,            // abandon and reset
  reset(),
  update(state, t) -> 'idle' | 'progress' | 'rep'
}
```

`state` is the existing metrics snapshot (`hipOffset`, `bodyScale`, `kneeDiff`,
wrist/ankle keypoints…). Detectors are pure functions of it plus their own
internal phase, which makes them unit-testable without a camera.

### Squat — 3 states

```
STAND  ──hipOffset > squatEnter (≈0.34 bs)──▶  BOTTOM
BOTTOM ──hipOffset < squatExit  (≈0.12 bs)──▶  STAND   ⇒ rep
```
Hysteresis and a `minRepSeconds` floor. Reuses the duck pattern exactly; a squat
is just a deeper duck with rep counting instead of a held state.

### Jumping jack — 2 signals ANDed

```
CLOSED ──wristsAboveShoulders AND kneeSpread > openWidth──▶ OPEN
OPEN   ──NOT wristsAbove      AND kneeSpread < closeWidth──▶ CLOSED  ⇒ rep
```
Requiring **both** arms and legs is what stops arm-flapping from scoring. Knee
spread rather than ankle spread, because feet are outside the frame at the
distance the framing step asks for. This is the most robust of the lot and the
right one to build first.

### Burpee — 4 states, the interesting one

```
STAND ──hipOffset > squatEnter────────────────▶ SQUAT
SQUAT ──bodyScale < 0.55×neutral AND hipY low──▶ DOWN     (torso gone horizontal)
DOWN  ──bodyScale recovered AND hips rising────▶ UP
UP    ──hipVelocity > jumpThreshold───────────▶ STAND    ⇒ rep
```
The `bodyScale` collapse is the key insight: the normaliser breaking is itself the
signal that the player has gone horizontal. Any state may time out to `STAND`
without scoring, so a half-done burpee simply does not count.

### Alternating lunge — reuse the cadence detector

Same sign-flip machinery as running on `kneeDiff`, with a larger deadband, a much
slower interval band (0.4–1.2 flips/sec), and an added `hipOffset` gate so a jog
cannot satisfy a lunge. Literally a second `CadenceDetector` instance with a
different config block.

### Anti-cheese, which matters more than it sounds

Any threshold detector can be gamed — bobbing instead of squatting. Three
defences, all already idiomatic in this codebase:

1. Require the **full state sequence**, never a single threshold crossing.
2. Enforce `minRepSeconds`. A "rep" completed in 200ms is not one.
3. Keep hysteresis on every transition (the existing `*Enter` / `*Exit` pattern).

---

## 5. The pose stencil

### Why this beats the rep gate

A stencil wall is not a softer version of §1's gate — it **solves** §1's problem.

The reason burpees cannot be obstacles is tempo: a rep takes 2–4 seconds and the
obstacle pipeline gives 3.7 seconds of warning. But **hitting a shape is not a
rep.** Matching a pose takes roughly 0.5–1 second, which fits inside that warning
window comfortably. So pose-match walls can live in the existing obstacle stream
alongside `lane` / `low` / `high` — no gate, no segment cursor, no halting the
player, nothing new in the sim's structure.

That makes this the cheapest path to strength-ish work by a wide margin, and it
should come before the gate machinery in §8.

The trade-off is honest: a wall tests **positions**, a gate tests **repetitions**.
A wall cannot make you do six squats; it can make you hit the bottom of one, over
and over, at whatever rate the map spawns them. For a game whose core loop is
already "sustain effort under pressure", spaced pose-hits may well be the better
exercise anyway — and they never interrupt the run.

### How matching actually works

This is nearly free, because the hard part is already built. Keypoints are
normalised by body scale, so a pose match is just a distance comparison in
body-scale units:

```
error = mean( |live[joint] - target[joint]| ) over the matched joints,
        both expressed in body-scale units relative to the hip midpoint
pass  = error < poseMatchTolerance     (~0.15 bs to start)
```

Because both sides are body-scale normalised, this is automatically invariant to
how far away the player stands and how tall they are — which is the same property
that makes every existing threshold work. No new machinery, no ML, no training.

Add a `minHoldFrames` so a shape has to be *held* for a moment rather than swept
through, and the same anti-cheese logic as §4 applies.

### Two constraints on the pose vocabulary

**No depth.** MoveNet gives 2D keypoints, so poses differing only in depth — arm
forward versus arm back — are indistinguishable. That sounds limiting until you
notice it is *the stencil's own limitation too*: if two poses project to the same
silhouette, the player could not tell them apart from the wall either. The
mechanic and the sensor have exactly the same blind spot, so design the poses as
silhouettes and nothing is lost.

**Head to knees only.** Framing does not include feet (§2), so a pose must be
distinguishable from the top ~72% of the body. Fine: star, squat-bottom, side
bend, overhead reach, single-knee-raise, arms-crossed. Not fine: anything defined
by foot placement.

### How it meets the three lanes

The lanes already exist — 3 of them, `laneCount: 3`, lean to change. Three ways to
combine them, in increasing difficulty:

| | Wall | Demands |
| --- | --- | --- |
| A | Full width, one pose | pose only; lane irrelevant |
| B | Full width, hole in one lane | pose **and** be in that lane |
| C | Different pose per lane | rejected — three silhouettes is far too much to read at speed while winded |

Start with **A**, since it isolates the new mechanic. **B** is the interesting one
long-term: it composes the existing lane verb with the new pose verb, and the
combination is legible because the hole's position tells you the lane and its
shape tells you the pose, in one glance, with no text.

### Where the target poses come from

Two options, and the second is better:

1. **Hand-authored** normalised keypoint sets. Works, but every pose is a guess
   about what an average body can reach.
2. **Recorded from the player** during setup: "copy this shape" once per pose, and
   store *their* version as the target. Guarantees the pose is achievable by that
   body, personalises the difficulty exactly as the cadence calibration already
   does, and makes the stencil drawn on the wall literally their own silhouette.
   Costs setup time, so it belongs behind a one-off "unlock this exercise" flow
   rather than the per-session calibration.

### The movement-versus-shape catch

One catch remains: **a stencil is a static shape and an exercise is a movement.** A
burpee cannot be one silhouette.

Resolution: the stencil shows the **key frame** — the extreme of the movement
(bottom of the squat, star of the jack) — and carries N pips. Each rep fills a
pip. Shape communicates *which* exercise with no text; pips communicate *how
many*.

The synergy worth exploiting: calibration already captures the player's neutral
pose and `bodyScale`, so the stencil can be **drawn to that player's own
proportions**. It will feel fitted rather than generic, and "get inside the
shape" stays fair for a 5'2" and a 6'4" player alike.

Rendering is cheap in the existing style — the stencil is a filled polygon on the
gate plane, projected with `_scaleAt(z)` like every other obstacle, with the
silhouette punched out. No new renderer.

---

## 6. Safety and fatigue

This is the part a fitness game gets wrong and hurts people.

Burpees for time, under threat, with the void closing, is precisely how form
collapses and backs get injured. Design commitments:

- **Cap reps per gate** (~8 for compound moves) regardless of difficulty ramp.
- **Mandatory `rest` segments.** The map author cannot omit them; the loader
  should reject a map with more than N consecutive non-rest segments.
- **A failed gate must not be a dead end.** If the void reaches a gated player,
  they should lose the run, not be trapped grinding reps they physically cannot
  do. Consider a bail-out: the gate opens at partial credit with a gap penalty.
- **Extend the existing principle**: max effort must never be *required* to
  survive, only to excel. The pace curve already embodies this; gates must too.

---

## 7. Calibration must not bloat

Naively, six exercises means calibrating six ranges of motion — a three-minute
setup nobody tolerates, defeating the 15-second flow that exists now.

Instead:

1. Keep the current single calibration (framing, neutral, comfortable pace).
2. Derive every new threshold as a **fraction of body scale**, as today.
3. **Auto-adapt from the player's first rep** of each exercise: take rep one as a
   range sample and scale the thresholds to it, the same way `kneeAmplitude`
   already personalises the cadence deadband.

Setup stays where it is.

---

## 8. Build order

Deliberately sequenced so the riskiest assumption dies first and cheapest.

Revised, because the pose wall (§5) turned out to be both cheaper and less
invasive than the gate: it needs no new sim structure at all.

1. **A pose-match comparator** — `error = mean normalised joint distance`, plus a
   hold requirement. Pure function of the metrics snapshot, unit-testable against
   synthetic keypoints, no game changes.
2. **One `pose` obstacle kind** in the existing stream, single hand-authored
   target (a star), full-width wall, placeholder rendering. This rides the
   pipeline that already spawns, warns, and resolves obstacles.
3. **Stop and evaluate.** *Can you actually hit a shape while running in place
   and out of breath?* If yes, the entire strength layer has a home. If it feels
   like flailing, no amount of gate machinery would have saved it.
4. Then the stencil silhouette drawn from the player's own calibrated
   proportions, replacing the placeholder.
5. Then wall variant **B** — a hole in one lane, composing pose with the existing
   lane verb.
6. Only then the rep-based `gate` and the segment cursor, for exercises that
   genuinely need counted reps rather than positions.
7. Floor mode last: separate framing, separate calibration, burpees and
   push-ups.

Step 2 is a day's work and answers the only question that matters. Note it comes
*before* any of the segment/map architecture — that machinery is only worth
building once something needs it.

---

## 9. Open questions

- **Does the void chasing a squatting player feel fair?** They cannot see the
  screen well mid-squat. Audio may have to carry the whole gap signal here — the
  danger pulse already exists and may be enough.
- **How does distance scoring work when a gate halts forward motion?** Options:
  reps convert to metres, or distance simply pauses and the score becomes
  distance + reps. The second is more honest and probably reads better.
- **Lane changes during a gate** are meaningless — should the barrier span all
  three lanes, or should one lane be a costly skip that hands metres to the void?
  A skip lane makes the workout optional, which may be the wrong incentive.
- **Side-on facing loses `centerOffset`** as a lean signal. Do floor segments
  disable lane logic entirely, or re-map it?
