# Huff&Puff

A browser fitness game where **running in place is the controller**. Your phone's
front camera watches you, MoveNet turns you into a skeleton, and your real
cadence becomes your speed in the game. A consuming void chases you. Slack off
and it eats you.

No app install, no wearable, no assets to download at runtime, and no video ever
leaves the device.

```
        pace    →  speed        run faster, go faster
        lean    →  lane         dodge the barriers
        jump    →  jump         clear the low hurdles
        crouch  →  slide        duck the high beams
```

---

## Run it

The camera API requires a **secure origin**, so `file://` will not work and
neither will plain `http://` from another machine on your LAN. Two options:

**On the machine itself** — `localhost` counts as secure:

```sh
python3 -m http.server 8000
# then open http://localhost:8000
```

**On your phone** (which is the point) — you need HTTPS. Easiest is a tunnel:

```sh
python3 -m http.server 8000
npx localtunnel --port 8000     # or: cloudflared tunnel --url http://localhost:8000
```

Open the `https://…` URL it prints on your phone.

### Physical setup

This matters more than anything in the code:

- Prop the phone at roughly **knee height**, leaning against something.
- Stand **6–10 feet back**, far enough that your **whole body** — head to ankles
  — is in frame. If your feet are cut off, cadence detection cannot work.
- Bright, even light. Avoid a window directly behind you; you will be a
  silhouette and every keypoint score will collapse.
- Clear the space around you. You will be moving and not looking at the floor.

### No camera? Play it with a keyboard

```
index.html?sim=1
```

Sim mode replaces the pose signals with keys — `↑`/`↓` pace, `←`/`→` lane,
`Space` jump, `Shift` duck. It drives the *same* `signals` object the tracker
writes to, so it is the right way to tune game feel at a desk.

Other flags: `?debug=1` for the skeleton overlay and numeric readout (or press
`d`, or tap **DEBUG**), `?canvas=1` to force Phaser's canvas renderer, which
frees a WebGL context for TF.js on phones that thermally throttle.

---

## How it works

### Calibration is the whole design

"Keep up or die" is only fair if *keeping up* means **your** pace. So nothing in
the game is tuned to an absolute steps-per-minute number. A five-step flow at the
start of every session measures this player, right now, in this room:

| Step | What it captures | Why |
| --- | --- | --- |
| 1 framing | full body visible + held, plus a lighting check | everything downstream needs ankles and knees |
| 2 neutral | centre line, standing hip height, body scale | the reference every gesture threshold is measured against |
| 3 warm-up | **comfortable cadence**, knee-lift amplitude, hip bounce | the target pace, the cadence deadband, and the jump threshold |
| 4 max effort | peak cadence (optional, skippable) | only tunes the effort readout |
| 5 countdown | — | 3, 2, 1, go |

`paceRatio = liveCadence / comfortableCadence`. **1.0 means the pace you told us
was comfortable**, whoever you are.

### Turning a skeleton into intent

Two ideas do most of the work.

**Body-scale normalisation.** Every threshold is divided by the distance from
your shoulder-midpoint to your hip-midpoint *on that frame*. Standing 6ft or
10ft from the phone stops mattering, so a "lean" is the same lean either way.

**The knee-alternation signal.** Cadence comes from
`kneeDiff = (rightKnee.y − leftKnee.y) / bodyScale`. Running in place is
essentially the only common movement that makes this oscillate across zero at a
steady rate with real amplitude:

```
 +band ─────╮────╮────╮────╮──────    running in place: clean alternation
   0   ─────┼────┼────┼────┼──────
 −band ─────╯────╯────╯────╯──────

 +band ────────────────────────────    swaying: both knees move together,
   0   ──╲__╱─╲__╱─╲__╱──────────      amplitude never leaves the deadband
 −band ────────────────────────────
```

Turning that into `running === true` requires **all** of: sign flips past a
personalised deadband, half-cycle intervals inside a plausible human range
(1.0–5.5 steps/sec), four consecutive consistent cycles, and amplitude holding
up against your calibrated knee lift. A single leg lift can never start the game.

**Jitter vs. responsiveness.** Every keypoint goes through a hand-written
[One Euro Filter](https://gery.casiez.net/1euro/) before any threshold sees it:
heavy smoothing when you are still (no false triggers), light smoothing when you
move fast (a jump stays snappy). A fixed low-pass forces you to pick one.

Jump and duck are measured against *your* numbers too — the jump threshold is
`max(floor, yourRunningBounce × 1.75)`, so a jump has to clearly beat the bounce
you already produce while running.

### The game loop

Your pace sets your speed on a deliberately asymmetric curve: below your
comfortable pace, speed falls off **faster** than linear, so slacking is felt
immediately. Above it, speed **saturates** — sprinting buys buffer, but max
effort is never required just to survive.

The void starts slower than your comfortable pace and accelerates with session
time, so the first minute feels winnable and later you have to dig in. Obstacles
never kill you; they cost you *gap*, the same currency the void spends. A hit
means "run harder now", not "game over".

Three forgiveness mechanisms exist because this is exercise, not a twitch game:
a 2s grace window once the void touches you, shields that absorb the first hits
and come back at every 400m, and a **tracking-loss freeze** — if pose detection
drops out entirely the void stops for 2.5s rather than eating someone who is
probably still running. It resumes after that, so covering the camera is not an
exploit.

---

## Layout

```
index.html              layers, HUD, screens
css/style.css           big high-contrast HUD, safe-area aware, PIP camera
js/config.js            ★ EVERY threshold and magic number, documented
js/util.js              math + DOM helpers, event emitter
js/one-euro-filter.js   adaptive smoothing, no dependencies
js/pose-tracker.js      camera + MoveNet + cadence/gesture detection
js/calibration.js       the five-step flow
js/game.js              GameSim (pure, testable) + RunScene (Phaser drawing)
js/audio.js             synthesised cues, zero assets
js/main.js              wiring only
tools/vendor.sh         rebuilds vendor/ from npm
```

**Tuning lives in `js/config.js`.** Every number in it is commented with what it
does and which way to move it. Nothing else should need editing to change how the
game feels.

`GameSim` has no reference to Phaser, the DOM, or pose code — it reads a plain
`signals` object. That is what makes `?sim=1` possible and what keeps the tuning
honest.

The renderer is Graphics primitives only: no sprites, no fonts, no audio files,
nothing to 404.

---

## Tracking is not working

Turn on the debug overlay (`?debug=1` or the **DEBUG** button) and look at the
**knee alternation trace** at the bottom. If that is not a clean wave crossing
the dashed deadband lines, nothing else will work. Then:

| Symptom | Cause | Fix |
| --- | --- | --- |
| `LOW!` next to `pose n/s`, or a **LOW FRAME RATE** toast | see *the sampling trap* below | `?canvas=1`, close other apps, or shrink `camera.width/height` |
| `pose  2–4/s` in the readout | WebGL unavailable, running on CPU | try `?canvas=1`; a phone this old may not manage |
| skeleton missing legs | feet out of frame | step back, tilt the phone down |
| all scores ~0.2 | backlit or dim | face the light, not the window |
| cadence stays 0 while running | knee lift below the deadband | lift knees higher, or lower `cadence.deadbandMin` |
| lanes flicker | lean hysteresis too tight | raise `gesture.leanEnter` |
| jumps not registering | your running bounce is close to the threshold | lower `gesture.jumpVelocityMargin` |
| jumps firing while running | the same, in reverse | raise it |

The overlay's dashed blue lines are the calibrated centre line and standing hip
height. If they are visibly wrong, redo calibration standing *still*.

### The sampling trap

Cadence detection counts sign flips, so it is bound by **sampling rate**, not by
CPU speed in general. Resolving N flips per second needs roughly 3N pose reads
per second:

```
 30 reads/sec   ~5.5 samples per flip at a 5.5 step/sec sprint    fine
 10 reads/sec   ~1.2 samples per flip                            aliases
```

When it aliases, the half-cycle intervals come out irregular, the consistency
gate correctly rejects them, and **cadence reads zero while you are sprinting**.
The game looks broken and eats you. That is why there is a watchdog: sustained
reads below `pose.minProcessFps` get a **LOW FRAME RATE** toast and a console
warning.

The counter-intuitive part: **do not raise `pose.frameThrottle` to help a slow
phone.** Throttling samples *less* often, which is the actual problem. Reduce the
work per frame instead — `?canvas=1`, a smaller `camera.width/height`, or fewer
apps competing for the GPU.

---

## Running fully offline

`vendor/` is committed, so all the code is local. MoveNet's **weights** are still
fetched from TF Hub on first run (then browser-cached). To remove that last
request:

1. Download the MoveNet SinglePose Lightning TFJS weights and put them at
   `vendor/models/movenet-lightning/` (`model.json` plus its `.bin` shards).
2. Set `pose.modelUrl` in `js/config.js`:

   ```js
   modelUrl: 'vendor/models/movenet-lightning/model.json',
   ```

`vendor/models/` is gitignored — the weights are a few MB and not ours to
redistribute.

To rebuild the vendored libraries: `./tools/vendor.sh` (needs npm; the scratch
tree it creates is gitignored).

---

## Limits

Worth knowing before you file a bug:

- **One player.** MoveNet SinglePose. A second person in frame will confuse it.
- **Face the camera.** Turn side-on and the torso collapses to a line; the code
  falls back to shoulder width, but tracking degrades.
- **Calibration is per session** by design — move the phone or change the
  lighting and the old numbers would be wrong anyway.
- **World metres are abstract**, not real distance. It is a score, not a
  pedometer.
- Battery: camera + two WebGL contexts is a genuinely heavy page. Expect a warm
  phone.
