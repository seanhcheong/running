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
| Aspect | 1:1 |
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
