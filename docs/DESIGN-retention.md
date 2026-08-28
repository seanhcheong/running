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
