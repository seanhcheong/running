# Design: what makes THIS game addictive

An opinion, written down so the reasoning survives. The prompt was "make it
addictive like Subway Surfers". The short answer is that Subway Surfers is the
wrong template for most of its own engine, and copying it wholesale produces a
game people admire once and never open again.

## Why the analogy breaks

Subway Surfers' retention rests on five load-bearing mechanics. Three of them
depend on one property: **a swipe is free.** It costs no energy, no recovery, no
willpower. You can play it lying in bed with one thumb.

Here the input is cardio. That single change inverts three of the five:

| Subway Surfers | Transfers? | Why |
| --- | --- | --- |
| Sub-second restart, no menus | **Inverts** | Recovery is physiological, not attentional. A player 90 seconds into max effort cannot "just one more" — their heart rate decides, not their interest. |
| Losing a 10-minute run costs nothing but time | **Inverts hard** | Here it costs ten minutes of *cardio*, the most expensive currency the player has. Punishing that with "start from zero" is the fastest way to make someone quit for good. |
| ~1 decision per second, most trivially passable | **Partly** | The *feeling* of constant skill is right; the density is not sustainable when every input is a squat. |
| Score = distance x a growing multiplier | **Transfers** | Costs nothing physically and creates real late-run tension. |
| Parallel currencies and daily missions | **Transfers, reshaped** | The compulsion loop should be a streak, not a shop. See below. |

There is also one asymmetry in this game's favour, and it is easy to forget:
**nobody plays Subway Surfers for the swiping, but people do run for the run.**
The exertion is intrinsically rewarding. So this game needs *less* manufactured
reward than a mobile runner does — what it needs is the friction removed from the
reward that is already there.

## The design I would argue for

### 1. The run cannot be lost. This is the highest-leverage change.

Today `gap <= 0` for longer than the grace window calls `_gameOver('caught')` and
the run is over. For a game whose input is effort, that is backwards: it throws
away the thing the player spent, which is the one thing you must never do.

Getting caught should drop the player into a **recovery** state instead — the void
backs off, the pace demand drops to a walk, the combo multiplier is lost, and the
run continues. The run ends when the *workout* ends, not when the player fails.

That keeps loss aversion (you lose the multiplier, and multipliers are where the
score lives) while never wasting the cardio. It also means every session ends in
"I finished", which is the feeling habits are built out of. Zwift and Ring Fit
both work this way and neither has a fail state.

### 2. Give a run a SHAPE. Endless is a consequence of free input.

Subway Surfers is endless because a swipe is free, so the only natural stopping
point is a mistake. Cardio has a natural shape already: warm-up, intervals, a hard
finish, cool-down. A run should be 4-6 minutes with that structure, and the void
should be the *pacer inside it* rather than the executioner.

A fixed-length session also makes the ask legible — "four minutes" is a decision
someone can make on a Tuesday evening; "until you fail" is not.

### 3. Gates are the spine; obstacles are the texture.

Obstacles (jump / duck / sidestep) are reflex tests. They are the Subway Surfers
part, they are cheap, and they are not the exercise. Pose gates are the exercise:
they have a readable success moment, they escalate legibly, and they are the only
part of the run that makes it a *workout* rather than a cardio timer.

Today gates come every 130m and obstacles every 55m, both constant. I would ramp
that across a session — obstacle-dense early, gate-dense late — which is also
exactly how an interval workout escalates. One ratio, doing two jobs.

### 4. Keep the multiplier. Reset it, never the run.

Combo from consecutive clean gates, score as distance x combo. Late gates are then
worth far more than early ones, which produces the "don't blow it now" tension
that makes a good run feel valuable — the one Subway Surfers mechanic that costs
nothing to port. A miss resets the combo. A miss does not end anything.

### 5. The compulsion loop is DAILY, not per-minute.

Per-minute compulsion is what a free-input game can have. An effort-input game
gets its compulsion from the streak:

- a visible chain of days
- **a rest-day bank** — one or two banked per week, so a missed Wednesday does not
  nuke a 40-day streak. Streaks without a mercy rule do not survive contact with
  real life, and a broken 40-day streak is a permanent quit event.
- what you are protecting costs four minutes, not forty

### 6. What I would NOT build

- **A shop, coins, unlockable characters.** Large build cost, and it competes with
  an intrinsic reward that is already strong. Revisit only if retention proves out
  and needs a second hook.
- **Global leaderboards.** Cardio capacity varies enormously between people and
  barely at all within one person week to week. A stranger's score is noise;
  your own last week is signal. Compare against that.
- **Anything that rewards unboundedly longer sessions.** That is how a fitness
  game produces injuries and burnout instead of habits.

## The thing that actually decides this, and it is not a mechanic

**Time from opening the app to taking the first step.**

Subway Surfers is addictive partly because it starts *instantly*. This game
currently:

1. asks for camera permission
2. downloads TF.js + MoveNet (~5MB)
3. runs five calibration steps — framing 2.0s hold, neutral 1.5s, warm-up 5.0s,
   max-effort 3.0s, countdown 2.4s — so about **14 seconds of held stillness
   minimum**, before any of the standing-around and repositioning that really
   happens
4. **persists none of it.** There is no `localStorage` use anywhere in the
   codebase, so every one of those steps runs again on every single session.

Realistically that is 30-45 seconds of standing still before the game starts,
every time. No mechanic in this document survives that. A player will do it twice.

The fix is not clever, it is just unglamorous: cache the calibrated baseline,
detect whether the camera and standing position look like last time, and if they
do, replace the whole sequence with a 3-second "still good?" confirmation. Full
calibration becomes something that happens on the first run and after a real
change — a new room, new phone position.

If only one item from this document gets built, build that one.

## What is still unknown

Whether the loop is fun is an empirical question and nothing here settles it. Two
things gate it and both need a body, not more code:

- **Is running in place at a controlled cadence, for four minutes, while reading a
  road, actually enjoyable?** Nobody has done it yet.
- **The floor-camera test.** Whether MoveNet reports usable keypoints for a prone
  body from a phone on the floor decides whether burpees and push-ups — two of the
  three panels in the original mockup — can exist at all. See docs/ART-BRIEF.md.

---

# Measured: would angle-based matching improve pose recognition?

Asked while evaluating whether to adopt a MediaPipe-style declarative angle engine
for a new game mode. Worth recording because the answer is narrower than it looks,
and because the first version of my own reasoning was wrong.

The shipped matcher is POSITION-target: each pose in js/poses.js is a table of
(x,y) offsets per joint in torso-length units, hip-anchored, scored as worst-joint
distance against a 0.22 tolerance. The alternative is joint ANGLES over triplets.
Two axes decide it, and they give opposite answers.

## Body proportions: angles buy headroom, not correctness

Decomposing each shipped pose into joint angles plus segment lengths, then
rebuilding the body with the same angles and different limb lengths — the identical
pose performed by a differently proportioned person:

    limb length     worst error   vs tolerance   poses unmatchable
    -15%            0.159         0.72x          0 / 10
    -10%            0.106         0.48x          0 / 10
    reference       0             0x             0 / 10
    +10%            0.106         0.48x          0 / 10
    +15%            0.159         0.72x          0 / 10
    legs +15% only  0.153         0.70x          0 / 10

So the position matcher already absorbs realistic proportion variation — nothing
breaks. But it spends 72% of the tolerance budget doing it, leaving a long- or
short-limbed player 28% for actual sloppiness where a reference-proportioned player
gets 100%. That is a real fairness asymmetry and a modest win for angles, not the
correctness bug it first looked like. An earlier note here framed the torso-unit
targets as though they baked in a proportion assumption that failed in practice.
They bake it in; it does not fail.

## Whole-body rotation: angles are the enabler, not an improvement

stand_tall, rotated about the hips, with the elbow and hip angles an angle matcher
would read alongside:

    rotation   position error   vs tolerance   elbow angle   hip angle
    0          0                0x             177.5         166.4
    10         0.188            0.90x          177.5         166.4
    30         0.558            2.5x           177.5         166.4
    45         0.824            3.7x           177.5         166.4
    90         1.523            6.9x           177.5         166.4

The angles do not move at all — rotation invariance is exact, by construction.
Two conclusions:

- FLOOR POSES. At 90 degrees the position error is 6.9x tolerance. The current
  representation cannot express a plank or a push-up at any tolerance worth having.
  For those, angles are not an improvement, they are the only way in.
- STANDING POSES TOO. Ten degrees already costs 0.90x of the whole budget. That is
  a player leaning, or — far more common — a phone propped at a tilt against
  whatever was to hand. This is a live robustness issue for the ten poses that
  already ship, and a bigger one than proportions.

## What angles do NOT fix

2D angles are not projective invariants. A limb pointing toward the camera
foreshortens and its measured 2D angle is wrong, for angles and positions alike. So
this is not a general robustness upgrade: angles are invariant to scale, to limb
length, and to IN-PLANE rotation, and to nothing else. Out-of-plane error needs
either a 3D-lifting model or poses chosen to keep limbs in the frontal plane, which
is what the current pose library already does implicitly.

## Verdict

Add angles; keep positions. They answer different questions and the game needs
both — the wall gates DRAW their target from pose.target via drawPoseFigure, and a
shape cannot be drawn from angles without solving inverse kinematics with unknown
limb lengths. Positions are an art asset as much as a matcher.

    positions -> gates: a shape to match, and to render
    angles    -> exercises: a movement to perform, and floor poses at all

---

## Follow-up: angles vs positions on the actual new-mode exercises

Four exercises — stand / squat / lunge_left / lunge_right — built from joint angles
by forward kinematics, with position targets derived from those same canonical
bodies (exactly how a target table is authored today), so both representations get
identical definitions and identical inputs. Score is worst-rule, matching
poseErrorDetail. "Margin" is the gap to the nearest WRONG exercise: bigger is more
headroom before a misread.

    condition               positions            angles
                            correct   margin     correct   margin
    ideal                   100%      0.381      100%      0.756
    limbs +15%              100%      0.275      100%      0.756
    limbs -15%              100%      0.222      100%      0.756
    phone tilted 10 deg     100%      0.174      100%      0.756
    phone tilted 20 deg     100%      0.063      100%      0.756
    tilt 15 + limbs +15%    100%      0.066      100%      0.756
    keypoint noise 0.02     100%      0.256      100%      0.402
    keypoint noise 0.05     100%      0.123      99.8%     0.004
    noise 0.02 + tilt 15    100%      0.029      100%      0.363
    noise 0.05 + tilt 15    98.0%     0.002      99.9%     0.002

BOTH CLASSIFY ALL FOUR CORRECTLY in every clean condition. Neither breaks. So for
these standing exercises the honest answer to "would angles be much better" is NO —
it is a trade, not an upgrade:

- Limb proportions and camera tilt: angles win, exactly and by construction. The
  position margin collapses 0.381 -> 0.063 under 20 degrees of tilt, an 83% loss of
  safety margin, while the angle margin never moves at all.
- KEYPOINT NOISE: POSITIONS WIN. At sigma 0.05 the position worst-case margin is
  0.123 against the angles' 0.004, and angles misread 0.2% of frames where
  positions never do. This is not a fluke — an angle is a DERIVED quantity, an
  arccos of differences of noisy positions, and arccos has unbounded derivative
  near its limits. Angles amplify the noise they are computed from.

Two caveats on that noise column. The invariance rows are close to tautological:
uniform limb scaling and in-plane rotation are precisely the two things angles are
invariant to, so confirming they hold proves the arithmetic, not the robustness. And
the noise model is IID Gaussian per joint, which is NOT how MoveNet errs — its
errors are structured and correlated, a whole limb going wrong together. Treat that
row as indicative.

The actionable consequence: the noise penalty is fixable. Positions are already One
Euro filtered upstream; angles computed from them need their OWN smoothing, because
the derivative reintroduces what the filter removed. Filter the angles and the 0.004
margin problem largely goes away.

So the case for angles narrows to one thing, and it is still decisive: floor poses,
where positions sit at 6.9x tolerance and are inexpressible rather than merely
worse. Adopt angles there. For the standing exercises, positions are already fine
and cheaper — the reason to unify on angles would be consistency, not accuracy.

---

# Measured: why the recognition actually felt bad

Prompted by the only piece of evidence in this document that came from a body
rather than a script: "the current workout recognition is not very good". Every
test above varied ONE thing at a time. That is not how a real player differs from
the reference — they have their own limbs AND a crooked phone AND noisy keypoints,
simultaneously, and worst-joint scoring means the worst of the three decides.

Stacking them, against the shipped library at the shipped 0.22 tolerance:

    condition                                 worst error   vs tol   poses failing
    reference body, level phone, no noise     0             0x       0%
    limbs +10% only                           0.106         0.48x    0%
    phone tilt 8 deg only                     0.295         1.34x    40%
    keypoint noise 0.02 only                  0.097         0.44x    0%
    all three, mild                           0.378         1.72x    53.5%
    all three, unlucky                        0.582         2.65x    95.8%

No single perturbation broke anything. All three together broke half the library.
And the pose library passes its own distinctness check (validateLibrary returns
empty), so confusable poses were never the problem.

**Tilt is the dominant term, by a wide margin.** Nobody props a phone level.

## It was worse than the pose gates, because it also broke the throttle

kneeDiff is `(rightKnee.y - leftKnee.y)` and the sign test around it is symmetric
about zero, so a tilt does not add noise — it adds a CONSTANT:

    kneeDiff' = (rk.x - lk.x) * sin(roll) + kneeDiff * cos(roll)

The knees sit 0.40 body scales apart, so 8 degrees of tilt is a 0.056 offset
against a default deadband of 0.055. Measured against the real detector, a player
with a modest knee lift at 12 degrees of tilt produced **zero detected steps while
running perfectly**: the signal never reached the far side of the deadband, so
nothing alternated, so there was no pattern to find.

## The fix: read the camera's roll off the hip line

Every target in js/poses.js puts left_hip and right_hip at the same y — a squat, a
knee raise, a star, a clap and a side bend all leave the pelvis level, because the
pelvis is what the body moves around. So the observed hip-line angle IS the
camera's roll, and nothing in the library perturbs it.

Rejected alternative: the torso axis, which is 1.0 body scales long against the hip
line's 0.36 and therefore 2.7x quieter. It moves. side_bend_left/right lean the
torso +/-20 degrees on purpose, and a horizon that cannot tell a leaning player
from a leaning phone would stop scoring the lean — turning a side bend into
"stand there with one arm up". The hip line trades lever length for not lying.

Also rejected: adopting angle-based matching for this, which was the previous
recommendation. Angles are tilt-invariant by construction, but they are invariant
by DISCARDING the information, so they inherit the same side-bend problem, and they
amplify keypoint noise (see the section above). Measuring the tilt and removing it
keeps the information and fixes the cause.

**The correction only works filtered, and that is not a detail.** With that short
lever the per-frame estimate is noisy enough that applying it raw is worse than
leaving the tilt in — measured, 54% of poses failing at keypoint sigma 0.05 against
0.3% uncorrected. It works because roll is a property of a propped phone and
therefore static, so it can be averaged over time in a way a pose never can.

    condition                        correction OFF        correction ON
                                     worst   fail%         worst   fail%
    reference, level, no noise        0       0%            0       0%
    limbs +10% only                   0.106   0%            0.106   0%
    phone tilt 8 deg only             0.295   40%           0       0%
    phone tilt 15 deg only            0.552   100%          0       0%
    keypoint noise 0.02 only          0.118   0%            0.119   0%
    keypoint noise 0.05 only          0.273   1%            0.264   1.9%
    all three, mild                   0.411   54.6%         0.19    0%
    all three, unlucky                0.603   97.3%         0.311   9.9%

The one place it is slightly worse is pure keypoint noise with no tilt at all —
1.9% against 1%, the residual of estimating a horizon from a short line. That is
the trade, and it is a good one: no real phone is at 0 degrees.

Verified separately that the side bends still cannot be passed with an upright
torso: the cheat scores 0.377 against a 0.22 tolerance, unchanged, because the hip
line reads 0 degrees for it.

## Two unrelated bugs found in the same detector while measuring this

Both were found because the tilt tests kept producing results that were backwards,
which is a good reason to chase an anomaly instead of explaining it away.

**1. The amplitude gate deadlocked, and a crooked phone was hiding it.**
`this.amplitude *= 0.9` ran per FRAME — 0.9^30 = 0.04 per second at 30 reads/sec —
while steps replenished it once per half-cycle. Solving the recurrence puts the
fixed point at 0.38x the true knee peak, against a `minAmplitudeRatio` floor of
0.40. It failed by 5%. A clean 2.6 steps/sec run with a symmetric knee signal
reported cadence 0 and running false indefinitely, while the SAME run seen by a
tilted phone reported 2.61 correctly — the tilt inflated one side's peak just
enough to clear the floor. Now time-based, fixed point 0.49-0.67x across the range
and no longer moving with frame rate.

**2. minStepsPerSec was off by 73%.** `flipTimeout` was a constant 0.55s, but flips
arrive 1/cadence apart, so a fixed window is a hidden floor on detectable cadence.
Measured by bisection: the real floor was **1.73 steps/sec (104 steps/min)** against
the 1.0 (60/min) the config advertises and calls "a slow march". Everything in
between reported a hard zero while the player ran — and during calibration's warm-up
they were told to lift their knees higher, advice that cannot help, because the
problem was tempo. The timeout now scales with the rhythm the player has
established; the measured floor is 0.99 steps/sec at 15, 30 and 60 reads/sec, and
stop detection got *faster* for quick runners (0.32s at 5 steps/sec, against 0.55).

Checked that the guards this timeout was also serving survived: idle sway plus a
single leg lift plus a two-step shuffle still produce zero running frames over 25
seconds, one skipped stride mid-run still does not drop the player out of running,
and a player who stops is reported stopped in 1.1-1.3s.

## Still unmeasurable here

All of the above is synthetic. The tilt model is a rigid rotation of the whole body
in image space, which is what a rolled camera does, but the keypoint noise model is
IID Gaussian and MoveNet's errors are structured and correlated. And the 8-degree
figure is a plausible guess at how crooked a propped phone is, not a measurement.
`?debug=1` now prints the filtered roll in degrees, so the real number is one
session away.
