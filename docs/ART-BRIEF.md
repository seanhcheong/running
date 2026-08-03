# Art brief — the running course

What to generate, why the constraints are what they are, and prompts to paste
into an image generator (written against Google Flow / Imagen, but they work in
any text-to-image tool).

Drop finished files in `resources/`. `tools/extract-sprites.js` shows the
pipeline that turns a reference sheet into game sprites; the same keying works
for anything on a flat background.

---

## The one constraint everything follows from

The course is not a picture. It is a projection computed every frame:

```
s = 26 / (26 + z)                      depth scale, 1 at the player, → 0 at the horizon
y = horizonY + (groundY − horizonY)·s
x = centreX  + laneOffset·laneW·s      lane offsets are −1, 0, +1
```

The road also scrolls forever, at a speed driven by the player's real cadence.

**So: top-down or flat elevation, never baked perspective.** A road drawn in
perspective cannot be scrolled — the foreshortening is baked in, so translating
it drags the vanishing point around with it. The renderer samples art in road
space and projects each scanline itself.

Two numbers worth knowing: the horizon sits at 30–34% of screen height, the
player stands at 78–84%, and the road is three lanes wide with
`laneW = roadHalfW / 1.5`.

---

## Assets, in priority order

### 1. Road surface tile — by far the highest value

| | |
|---|---|
| View | Orthographic top-down (nadir). No vanishing point, no horizon in frame. |
| Aspect | 9:16 — vertical is the travel direction, so a tall tile gives more track per loop. 1:1 also works. |
| Tiling | Must continue off the top edge onto the bottom edge — that is the travel direction and it loops forever. |
| Lanes | Dividers at exactly ⅓ and ⅔ of the image width, so lane centres land on ⅙, ½, ⅚. |
| Value | Very dark. The current road is `#1b1c2e`; a daylit texture blows out the whole scene. Greyscale is also fine — it gets tinted. |
| Excludes | No sky, no horizon, no character, no props. |

### 2. Horizon backdrop

| | |
|---|---|
| View | Flat billboard, straight on, no perspective. Sits on the horizon line. |
| Aspect | As wide as the tool offers (16:9 minimum) |
| Transparency | The top two thirds must be plain flat black, so it can be keyed out and the animated star-field shows through. |
| Style | Dark silhouettes. High-contrast shapes read best at this size. |

### 3. Roadside props — 4–8 kinds

| | |
|---|---|
| View | Straight-on front elevation, eye level. Not top-down, not three-quarter. |
| Anchor | **Bottom edge = ground contact.** The renderer plants that edge on the road and scales by `s`. |
| Background | Flat magenta (see below). |
| Why | Biggest sense-of-speed gain per unit of effort. |

### 4. Obstacles — exactly 3, and each must telegraph its action

- **low hurdle** — jump over. Sits on the road, knee height.
- **high beam** — duck under. Hangs in the air with a clear gap beneath.
- **lane barrier** — step around. Full height, one lane wide.

The shape has to say which action is required before the player can read any
colour, because at the far end of the road colour is all that survives.

---

## Format

**Transparency → PNG.** If the generator cannot do transparency — most cannot —
put the subject on **flat magenta `#FF00FF`** and it gets keyed out here.

Magenta rather than white is deliberate and it is not fussiness. The character
sheet came in on white, and every anti-aliased edge pixel was teal blended
toward white; on a near-black sky that reads as a pale halo, and correcting it
needed an eroded matte plus an un-premultiply pass. A hue that appears nowhere
in the art keys perfectly cleanly instead. `tools/extract-sprites.js` already
works by hue.

Opaque assets (the road tile, an opaque horizon) can be JPEG.

---

## What cannot be used

- The road drawn in perspective, or any isometric / three-quarter view of it
- A composed scene with sky, road and character together — elements must be separable
- Bright or daylit art
- The character (already done, see `assets/sprites/`)

---

## Prompts

Self-contained — paste one whole block, no assembly. Aspect ratio is per prompt.

**Do the road tile first and on its own.** It changes the course more than the
other three combined, and it is the one most likely to need several attempts.

### 1. Road tile — aspect 9:16

Vertical rather than square on purpose: vertical is the travel direction, so a
tall tile gives more track per loop.

> Orthographic top-down plan view, camera pointing straight down from directly
> overhead at a three-lane futuristic running track, nadir drone shot,
> absolutely no perspective and no horizon visible anywhere in the frame. The
> track fills the entire image edge to edge and runs vertically from the top
> edge to the bottom edge. Two thin glowing cyan lane divider lines run
> vertically, dividing the width into three equal lanes. Dark charcoal-violet
> track surface with a subtle fine grid texture, and faint emissive strips along
> the far left and far right edges. The pattern continues smoothly off the top
> edge and onto the bottom edge — seamlessly tileable vertically, no visible
> seam. Very dark overall. Style: dark neon holographic, near-black, cyan and
> mint emissive accents, deep violet ambient glow, clean minimal geometric
> forms, high contrast, low-key lighting. No text, no watermark, no logos, no
> people, no characters, no creatures.

### 2. Horizon backdrop — aspect 16:9

> A wide panoramic silhouette of a distant futuristic city skyline at night,
> viewed straight on at eye level from very far away, completely flat with no
> perspective distortion, intended as a flat backdrop layer. Dark navy and
> near-black towers and spires in silhouette, thin cyan and mint emissive window
> lines, deep violet atmospheric haze glowing low along the base of the
> buildings. The upper two thirds of the frame is pure flat solid black empty
> sky with absolutely nothing in it. Extremely dark, distant, hazy, high
> contrast. Style: dark neon holographic, cyan and mint emissive accents, deep
> violet ambient glow, clean minimal geometric forms, low-key lighting. No text,
> no watermark, no logos, no people, no characters, no creatures.

### 3. Roadside props — aspect 16:9

> A neat reference sheet grid of eight separate futuristic roadside objects, each
> object isolated with clear empty space all around it, on a completely flat
> solid magenta #FF00FF background. Every object viewed straight on at eye level
> as a flat front elevation, orthographic with no perspective, standing upright
> with its base resting on an invisible ground line at the bottom of its cell.
> The eight objects: a tall thin glowing pillar; a wide arch gateway; a street
> lamp with a cyan lamp head; a floating ring hovering above a short post; an
> angular pylon; an empty holographic billboard frame; a cluster of three
> vertical light rods; a low geometric barrier block. Dark charcoal bodies with
> cyan and mint emissive edge lighting. Style: dark neon holographic, cyan and
> mint emissive accents, clean minimal geometric forms, high contrast. Keep the
> background a perfectly flat solid magenta with no shading and no gradient. No
> text, no watermark, no logos, no people, no characters, no creatures.

### 4. Obstacles — aspect 16:9

> A reference sheet of three separate futuristic running-track obstacles
> arranged in a single row, each isolated with clear empty space around it, on a
> completely flat solid magenta #FF00FF background. All three viewed straight on
> at eye level as flat front elevations, orthographic with no perspective.
> LEFT: a low wide hurdle — a knee-height horizontal glowing amber bar on two
> short posts, resting on the ground, obviously something to jump over.
> CENTRE: a high suspended beam — a wide violet glowing horizontal bar floating
> in the air with a large clear empty gap underneath it, obviously something to
> duck below.
> RIGHT: a tall narrow barrier — a full-height glowing pink slab, narrow enough
> to block only one lane of three, obviously something to step around.
> Dark bodies with bright emissive edges. Style: dark neon holographic, clean
> minimal geometric forms, high contrast. Keep the background a perfectly flat
> solid magenta with no shading and no gradient. No text, no watermark, no
> logos, no people, no characters, no creatures.

---

## Three things the generator will fight you on

1. **True top-down.** It drifts to three-quarter view. "Nadir", "plan view",
   "camera pointing straight down", "no horizon visible" all help, and it may
   still take several tries. If it keeps adding perspective, try phrasing it as
   a photograph: *"a drone photograph taken from directly above, looking
   straight down"* — that pushes models toward a real nadir framing.
2. **Seamless tiling.** It will mostly fail. Send it anyway: a non-tiling tile
   can be mirrored and cross-blended into a loop here, at some cost in detail.
3. **Transparency.** Use the magenta background.

## Before sending a file over

- Road tile: cover the bottom half with your hand — do the lane lines stay
  parallel? If they converge, it has perspective and cannot be used.
- Props/obstacles: is the background one flat colour, or has it been shaded and
  gradiented? A gradient background still keys, but less cleanly.
- Everything: any text or watermark baked in? Those key as part of the subject.

---
---

# Art brief — the character: a run cycle, and wall poses

Added after the first pass on the character shipped and the runner was seen
moving. Two separate asks; the run cycle is the urgent one.

## Why the runner needs more frames than it has

The runner is currently ONE frame — `state-run.png`, a square-on back view —
moved by transforms: bob, sway, squash and a small rock. That was a deliberate
choice and the reasoning behind it was partly wrong.

The argument was that leg position does not read from directly behind, on the
evidence that three commissioned stride frames measured 0.4–0.7% pairwise
silhouette difference. That measurement was real but it does not support that
conclusion. **What it actually showed is that the generator returned the same
render three times.** It was a measurement of a generator failure, and using it
as a fact about anatomy was a mistake. Alternating legs read fine from behind —
what does not read is the *forward* swing, which foreshortens to nothing. The
part that reads is vertical: the trailing heel kicking up, the sole turning
toward the camera, the stance leg straightening.

The visible consequence is a waddle. With no alternating legs, the only
once-per-stride motion is lateral sway, and sway had been pushed up to cover for
them. Measured against a 248px body: lateral travel 9.2% of body height at once
per stride, vertical bob 6.0% at twice per stride — so the largest and slowest
motion on screen was a sideways lurch. A real runner from behind is the inverse:
5–7% vertical, 1–2% lateral. Sway is now pinned at 2.0% with the ratio asserted
in the harness, which removes most of the hobble, but a single frame cannot do
the rest.

## 5. Back-view run cycle — the highest-value character asset

**8 cells, 4 columns × 2 rows.** Six works. Even four (the two contacts and the
two flights) would fix the hobble, because the alternation is the point.

Row 1 is the LEFT foot's step, row 2 is the RIGHT foot's — the same four
moments, mirrored. They cannot be produced by flipping row 1 here: the render is
lit from one side and the two halves of the silhouette differ by 24–32
luminance units, so a mirrored frame flips the highlight and flickers.

Per step, the four moments, which are described this way because they are
*categorically* different rather than incrementally different. The last attempt
asked for "three stride phases" and got one pose three times; a generator will
collapse anything it can read as "the same pose, slightly further along":

1. **Contact** — one foot flat on the ground directly below the hips, leg
   straight. The other leg trails behind, knee bent hard, heel kicked up toward
   the tail, **the sole of that foot turned toward the camera**. Body at its
   lowest and widest.
2. **Passing** — both feet close together beneath the body. The stance foot flat,
   the other's toe just leaving the ground. The narrowest, most compact frame.
3. **Push-off** — stance leg fully straight, that heel rising off the ground,
   toe still down. The other knee has swung forward and is mostly hidden by the
   body — only a sliver of it shows past the hip. Body rising.
4. **Flight** — **both feet clear of the ground.** Trailing foot high behind, sole
   square to the camera; leading foot tucked under and forward, hidden. Body at
   its highest and narrowest.

The sole-to-camera in frames 1 and 4 is the single strongest cue that this is a
back view of something running rather than a shape sliding along. It is worth
saying twice in the prompt.

## 6. Front-view exercise poses — optional, wall mode already works

Wall mode has ten poses and they are drawn from the rig, so nothing is blocked
on art. Rendered art would upgrade two things at once: the shape cut out of the
gate, and the "get into this pose" reference. One PNG serves both — the cutout
comes from its alpha channel.

**Five of these already exist and just are not shipping.** `clap`, `jumping`,
`recovery_upward`, `stretching` and `standing` are front views already extracted
from the first character sheet; they were dropped from `keep` in
`tools/extract-sprites.js` because nothing consumed them. Re-enabling them costs
one line, so do not commission those again.

Genuinely missing, and worth generating — front views, chosen because each is a
**distinct silhouette at gate distance**, which is the only thing that matters
for a shape the player has to match while out of breath:

| Pose | Shape |
| --- | --- |
| `squat_bottom` | hips low, knees wide, arms straight forward |
| `t_pose` | arms straight out sideways, level with the shoulders, feet together |
| `knee_up_left` / `_right` | one knee lifted to hip height, arms bent at the sides |
| `star` | arms up in a wide V and legs wide apart, at the same instant |
| overhead press | elbows out wide, hands at head height — a goalpost |
| side lunge L / R | feet very wide, one knee deeply bent, body shifted over it |

### What NOT to generate yet, and why

**No floor poses.** Burpees, push-ups and planks are in the mockup and cannot be
tracked yet, for two independent reasons:

1. Pose matching divides every measurement by the shoulder-mid → hip-mid
   distance to cancel out how far the player is standing from the phone. When
   the torso points at the camera that distance collapses toward zero and the
   normalisation blows up. Those poses need a different anchor.
2. It is not known whether MoveNet reports usable keypoints for a prone body
   from a phone on the floor angled up. **This needs a physical test** — phone on
   the floor, get into a plank, see whether the skeleton tracks — and no amount
   of work here settles it.

Art for a mechanic that cannot ship is wasted, so this waits on the test.

## Format for both sheets

Same as the road assets above, plus three things specific to a character sheet,
each of which is a mistake a previous sheet actually made:

- **Flat magenta `#FF00FF` background, and NO ground shadow under the feet.**
  The penguin sheet came in this way and keyed almost perfectly: 0.2% edge
  contamination. The first character sheet came in on white with rainbow ground
  shadows pooled under the feet, and because the shadow touches the feet it
  merges into the character's own shape and cannot be removed afterwards — it
  forced a hue-window key that then clipped the character's own dark creases and
  tore a notch through its crotch.
- **Locked-off camera, dead behind at hip height.** Not above, not
  three-quarter. The previous sheet's upright pose came in turned, measuring 19%
  silhouette mirror mismatch, and a character angled away from the road it is
  running down looks wrong in a way no code can fix. Square-on measures 1%.
- **The character the same size in every cell, feet on a common baseline.** The
  extractor applies one scale factor per sheet precisely so relative pose sizes
  survive; if the generator drifts the camera in or out between cells, the
  character will pulse as the game switches frames.

Send the existing `assets/sprites/state-run.png` along as a character reference
if the tool accepts one, and generate each sheet in a single pass so the
character stays consistent within it.

---

## Prompts

### 5. Back-view run cycle — aspect 2:1, 4 columns × 2 rows

```
A reference sheet of one 3D-rendered cartoon penguin character, arranged in a
strict 4 column by 2 row grid, 8 cells total, seen from DIRECTLY BEHIND.

The character: a plump rounded penguin, soft matte pastel teal, smooth clay-like
surface, no outlines, gentle studio lighting. Wide heavy base tapering to a small
rounded head with no neck. Short stubby flipper arms at its sides. Two small
webbed feet. No face is visible because we are behind it.

Camera: locked off and identical in every cell — same position, same distance,
same lens, at the character's hip height, level, pointing straight at its back.
The character is centred in every cell, its spine vertical, both flippers
symmetric about the spine. It must be exactly the same size in every cell and
its feet must sit on the same baseline height in every cell. No turning, no
three-quarter angle, no top-down angle.

Background: FLAT SOLID MAGENTA #FF00FF, edge to edge, in every cell. NO ground
shadow, NO contact shadow, NO reflection, no floor, no grid lines, no text,
no labels, no numbers, no borders between cells.

The 8 cells are 8 moments of a running stride. Top row is the LEFT foot's step,
bottom row is the RIGHT foot's step — the same four moments with the legs
swapped. The legs must be clearly and obviously different between cells:

Top row, left to right:
1. LEFT foot flat on the ground directly under the hips, left leg straight. The
   RIGHT leg trails far behind, knee bent hard, heel kicked up high toward the
   tail, and THE SOLE OF THE RIGHT FOOT IS TURNED TO FACE THE CAMERA. Body at
   its lowest, squashed slightly wider.
2. Both feet close together directly beneath the body. LEFT foot flat, RIGHT toe
   just barely lifting off the ground. The most compact, narrowest pose.
3. LEFT leg fully straight and pushing, LEFT heel lifted off the ground with the
   toe still down. RIGHT knee has swung forward and is hidden behind the body,
   only a small sliver visible past the hip. Body stretched taller.
4. BOTH FEET COMPLETELY OFF THE GROUND, mid-air. RIGHT foot high up behind, ITS
   SOLE SQUARE TO THE CAMERA. LEFT foot tucked forward under the body and hidden.
   Body at its tallest and narrowest.

Bottom row, left to right: exactly the same four moments 1-4, with left and
right legs swapped, so the LEFT foot is the one trailing behind with its sole
showing.

Style: soft pastel clay, matte, no outlines, no cel shading, no text anywhere.
```

### 6. Front-view exercise poses — aspect 3:2, 3 columns × 2 rows

```
A reference sheet of one 3D-rendered cartoon penguin character, arranged in a
strict 3 column by 2 row grid, 6 cells total, FACING THE CAMERA head on.

The character: a plump rounded penguin, soft matte pastel teal, smooth clay-like
surface, no outlines, gentle studio lighting. Wide heavy base tapering to a small
rounded head with no neck. Short stubby flipper arms. Two small webbed feet. A
simple friendly face: two small dark oval eyes and a small mouth. Same character
in every cell.

Camera: locked off and identical in every cell — same position, same distance,
same lens, at the character's chest height, level, pointing straight at its
front. The character is centred and facing directly forward in every cell,
exactly the same size in every cell, feet on the same baseline height. No
turning, no three-quarter angle, no profile views.

Background: FLAT SOLID MAGENTA #FF00FF, edge to edge, in every cell. NO ground
shadow, NO contact shadow, no floor, no grid lines, no text, no labels, no
numbers, no borders between cells.

The 6 poses, each held still and read as a clear distinct silhouette:

Top row, left to right:
1. DEEP SQUAT — hips dropped low, knees bent and pushed out wide to the sides,
   both flippers held straight out forward.
2. T-POSE — both flippers straight out sideways, level with the shoulders, as
   wide as they go. Feet together, legs straight, standing tall.
3. ONE KNEE UP — standing on the left leg, RIGHT knee lifted up to hip height,
   flippers bent and held at the sides.

Bottom row, left to right:
4. STAR JUMP — both flippers raised up and out in a wide V above the head AND
   both legs spread wide apart at the same time, feet planted.
5. OVERHEAD PRESS — elbows bent and pushed out wide to both sides, flipper tips
   up at head height, forming a goalpost shape. Legs straight.
6. SIDE LUNGE — feet planted very wide apart, the RIGHT knee bent deeply with
   the body shifted across over that leg, LEFT leg straight. Flippers forward
   for balance.

Style: soft pastel clay, matte, no outlines, no cel shading, no text anywhere.
```

### If the run cycle comes back with identical cells

That is the failure that already happened once, and it is detectable without
opening the file — measure it rather than eyeballing it:

```
node tools/extract-sprites.js     # then compare pairwise silhouette difference
```

Cells of a genuine stride differ by well over 5% of their silhouettes. Anything
under about 2% means the generator produced one pose repeatedly, and the fix is
to make the cell descriptions *more categorical* — push on "both feet off the
ground" and "the sole faces the camera", which are things it either drew or
did not, rather than on degrees of swing.
