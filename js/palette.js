/* =============================================================================
 * Huff&Puff — PALETTE
 * =============================================================================
 * One source of truth for colour, because there are three consumers that must
 * agree and previously each held its own copy:
 *
 *   - css/style.css    the HUD and the screens        (CSS custom properties)
 *   - js/course.js     sky, ground, road              (CSS colour strings)
 *   - js/game.js       avatar, obstacles, the void    (Phaser wants 0xRRGGBB)
 *
 * Defined here as hex strings and pushed into CSS custom properties at boot, so
 * a colour changes in exactly one place. `num()` converts for Phaser.
 *
 * THE DAYLIGHT SWITCH
 *
 * This started as neon-on-near-black. The art direction is pastel daylight — a
 * clay character, a rainbow track, a blue-sky city — and the two cannot both be
 * right: the road art measured 0.727 mean luminance against the old road's 0.10,
 * seven times brighter.
 *
 * Going bright inverts what the UI has to do. Neon on black works because the
 * accent is the brightest thing present; on a pale sky the same accent is
 * *darker* than its background and reads as mud. So the HUD's contrast comes from
 * dark ink on translucent white, and colour is reserved for state — the pace
 * band, the void, a hit — rather than spent on every label.
 *
 * The one thing that gets BETTER: the void. It was black-on-black and had to be
 * outlined in red to be visible at all. On a bright world it is the darkest thing
 * on screen, which is exactly what a thing chasing you should be.
 * ========================================================================== */

window.HP = window.HP || {};

(function (HP) {
  'use strict';

  const PALETTE = {
    /* --- sky and ground ------------------------------------------------- */
    skyTop: '#8fcfe8',
    skyBottom: '#cfeaf4',
    groundFar: '#dcefe9',
    groundNear: '#c6e3dc',
    /* Aerial perspective at the horizon. Pale and mostly opaque near the
     * vanishing point, clear by the time the road is close. */
    hazeStrong: 'rgba(214, 238, 246, 0.95)',
    hazeClear: 'rgba(214, 238, 246, 0)',

    /* --- the street ------------------------------------------------------
     * Buildings flanking the road. Sampled from the skyline art so the near
     * street and the distant city read as the same place. */
    streetHues: ['#f2a9bd', '#f7c9a3', '#f6e3a8', '#a9dfc8', '#c3bde8',
                 '#f0b7cd', '#bfe3d6', '#f5d3b0'],
    streetShade: 'rgba(90, 105, 140, 0.20)',

    /* --- road, only used when the texture is missing -------------------- */
    road: '#b9c9d6',
    roadEdge: '#93a8ba',
    laneLine: '#e8f2f7',
    stripe: '#ffffff',

    /* --- the character -------------------------------------------------
     * The reference clay teal, used as authored. The previous build pushed its
     * value up to survive a near-black sky; on a pale sky that same brightening
     * washes it out, so it goes back to the source colour. */
    blobBody: '#74c9c3',
    blobLight: '#a9e2dd',
    blobShade: '#3f948f',
    blobFace: '#2b4a4f',
    blobDuckBody: '#7cc4de',
    blobDuckLight: '#b0e0ef',
    blobDuckShade: '#43869e',

    /* --- obstacles: pastel clay, one hue per required action ------------ */
    obstacleLow: '#f0a878',      // hurdle — jump
    obstacleHigh: '#a898e0',     // beam — duck
    obstacleLane: '#ef9ab4',     // barrier — sidestep
    obstacleShade: 'rgba(70, 60, 90, 0.22)',

    /* --- the void ------------------------------------------------------- */
    voidCore: '#2c2340',
    voidEdge: '#5d4b7a',
    voidGlow: '#8c6bb1',

    /* --- UI ------------------------------------------------------------- */
    ink: '#243447',
    inkDim: '#5b7186',
    panel: 'rgba(255, 255, 255, 0.82)',
    panelLine: 'rgba(60, 90, 120, 0.18)',
    accent: '#1fb89a',
    accent2: '#3ba7d6',
    warn: '#e08a2e',
    danger: '#e0455f',
    violet: '#8b6fd4',
    bg: '#cfeaf4',
  };

  /** '#rrggbb' → 0xrrggbb, for Phaser. Non-hex values (rgba) return null. */
  function num(v) {
    const m = /^#([0-9a-f]{6})$/i.exec(String(v).trim());
    return m ? parseInt(m[1], 16) : null;
  }

  /* CSS custom property names, so style.css can consume the same values. Only
   * the ones the stylesheet actually references are exported. */
  const CSS_VARS = {
    '--bg': 'bg',
    '--ink': 'ink',
    '--dim': 'inkDim',
    '--accent': 'accent',
    '--accent-2': 'accent2',
    '--warn': 'warn',
    '--danger': 'danger',
    '--violet': 'violet',
    '--panel': 'panel',
    '--panel-line': 'panelLine',
    '--sky-top': 'skyTop',
    '--sky-bottom': 'skyBottom',
  };

  function applyToCss(root) {
    const el = root || document.documentElement;
    Object.keys(CSS_VARS).forEach((prop) => {
      el.style.setProperty(prop, PALETTE[CSS_VARS[prop]]);
    });
  }

  HP.PALETTE = PALETTE;
  HP.paletteNum = num;
  HP.applyPaletteToCss = applyToCss;
})(window.HP);
