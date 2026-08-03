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
