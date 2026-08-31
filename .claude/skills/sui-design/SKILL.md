---
name: sui-design
description: Build any Structs UI using the game's own SUI design system. Use whenever adding or changing UI in this repo — a window, a panel, a control, a row, a form field, an icon — including the Comms/chat window, Team Ops, the raid viewer, and the Pay window. Also use when a new surface "looks wrong" or unstyled next to the game.
---

# Building UI in Structs

Every surface this app adds sits beside a pixel-art game. It has to look like
part of it, not like a web form someone bolted on. That is not a matter of
taste: SUI already has a component for nearly everything, and inventing one is
how a window ends up in the wrong font with the wrong buttons.

## Relation to Anthropic's `frontend-design` skill

That skill (github.com/anthropics/skills/skills/frontend-design) is about
making something DISTINCTIVE: a signature element, typography chosen for
personality, a critique pass against generic defaults. It is written for
greenfield work, and on its central point it is the opposite of what this repo
needs — the look is already decided, and inventing one here is the failure
mode, not the goal.

What does carry over, and is worth applying inside SUI:

- **Restraint.** Cut decoration that does not serve the brief. A control that
  is not needed on a row should not be on the row.
- **Structure information meaningfully.** Group by what the reader is deciding,
  not by what is convenient to render.
- **Copy.** Active voice, plain language, one vocabulary throughout. Say what a
  control does, not what it is. Error text should say what to do next.

If it is ever enabled in a session, use it for those; use THIS skill for
everything about how the pixels look.

## Source of truth, in order

1. **`frontend/css/sui/sui.css`** — what actually ships. 206 `.sui-*` classes.
   If the code and the doc disagree, the code wins.
2. **`proposals/SUI-DESIGN-SYSTEM-GUIDE.md`** — the Figma design system written
   up: tokens, typography, the two icon systems, component inventory.
3. The existing windows — `frontend/board.js` (`H.*` helpers wrap SUI),
   `frontend/chat.js`, `frontend/raidview.html`.

**Never edit `frontend/css/`, `fonts/`, `img/`, `structicons/` or `js/`.**
`scripts/sync.sh` does `rm -rf` on those and re-copies them from the
`structs-webapp` submodule, so an edit there is both off-limits and erased by
the next `make release`. Changing the game's own styling means a patch in
`scripts/apply-patches.sh`, not an edit.

## Read the webapp's own components before building one

`frontend/css/sui/sui.css` is only the stylesheet. The webapp's **source** has
the reference implementations and the real constants, and they are the thing to
copy:

- `structs-webapp/src/js/sui/` — the SUI library itself (`SUITooltip`,
  `SUIInputStepper`, `SUIOffcanvas`, `SUICheatsheet*`, `SUIUtil`).
- `structs-webapp/src/js/view_models/components/` — the reusable pieces:
  `PfpViewerComponent`, `PlanetCardComponent`, `AlphaOwnedComponent`,
  `EnergyUsageComponent`, `GenericResourceComponent`, `ShieldStatusComponent`,
  `StructStillRenderer`.
- `structs-webapp/src/js/constants/` — the authoritative numbers:
  `PfpConstants` (part counts), `ObjectTypes` (guild 0, player 1, planet 2,
  reactor 3, substation 4, struct 5, allocation 6, infusion 7, address 8,
  fleet 9, provider 10, agreement 11), `Ambits`, `StructConstants`,
  `TaskTypes`, `RaidStatus`, `Permissions`, `PrecisionConstants`.

Our windows cannot `import` from the submodule, so a value sometimes has to be
copied. When it is, **pin the copy against reality in a test** — the portrait
part counts are checked against the files in `img/pfp/`, which is what would
actually 404. Do not copy a number and hope.

Read the component before writing your own version of it. `PfpViewerComponent`
settles the layer order (background, arms, body, neck, head — back to front),
the path shape, the placeholder, and that indices are **1-based**; a
hand-written version got the bounds wrong in both directions and three fixtures
encoded a portrait that could never load.

## Before writing any markup

Find the component first:

```bash
grep -oE "\.sui-[a-z-]+" frontend/css/sui/sui.css | sort -u | grep -i <thing>
```

Then read the rule to learn the markup it expects. The class families are
`sui-screen` (screens, nav, buttons), `sui-panel`, `sui-result` (rows),
`sui-input`/`sui-radio` (forms), `sui-text` (typography), `sui-icon`,
`sui-message`, `sui-theme`, and `sui-mod-*` modifiers.

## The one sanctioned exception: the π door

The main window's debug panel ends with a small **π** that opens Team Ops. It
is set in a pinned Georgia serif stack, because π is U+03C0 and neither bundled
face has a Greek glyph.

It is outside the design system, the owner knows, and **it stays**. It has
already been "corrected" to `icon-cmd-post` once on perfectly sound reasoning
and had to be put back. If you find yourself about to improve it, don't.

`scripts/harness-tests/sui.test.mjs` names this exception by file and by family
so the font audit stays strict everywhere else — a Georgia in any other file
still fails.

The general rule this illustrates: a deviation the owner has chosen is not a
defect. Record it, scope it, and leave it alone.

## Icon sizes — the game never goes below 16px

`--icon-xs: 8px`, `--icon-sm: 16px`, `--icon-md: 24px`, `--icon-lg: 32px`,
`--icon-xl: 48px`.

Across the **entire webapp**, `sui-icon-xs` is used **zero times**. The default
is `sui-icon-md` (84 uses); `sm` is the small variant (12 uses). The Comms
window had adopted `xs` as its dominant size — 22 of them — so every icon in
chat was drawing at a third of the game's size.

The split the webapp's own usage shows:

- **`md`** when the icon stands as its OWN element — a button (the game's
  `ActionBarComponent` uses `md` for all 20 of its action buttons), a block's
  leading glyph, a resource readout.
- **`sm`** when it sits inline inside a run of text — "Visit the Guild Site ⧉",
  a close affordance on a tab, a chip beside a word.

Never `xs`. If something looks like it needs 8px, the layout around it is
wrong.

Note both the game window and ours render under `transform: scale(2)` at
≥1152px (main.css scales `#menu-page-layout` and friends), so these CSS sizes
double on screen. That scaling is shared — it is never the reason something
looks small.

## Never write a `var(--x, #fallback)` fallback

This is the single rule that matters most, because breaking it is invisible.

`var(--border, #345)` looks defensive. What it actually does is let a token
name that **does not exist** render as a colour you invented — and the window
then looks almost right, which is worse than looking broken. Three of these
shipped: `--text-error`, `--input-background` and `--button-background` are not
SUI tokens at all, and every window using them was painting hex I made up. That
is precisely why the Pay window and the raid rail "weren't Structs".

Write `var(--border-subtle)` with no fallback. A wrong name then renders as
nothing, and you find out immediately.

Check any file in one line:

```bash
for t in $(grep -oE "var\(--[a-z0-9-]+" FILE | sed 's/var(//' | sort -u); do
  grep -rq -- "$t:" frontend/css/sui/sui.css frontend/css/main.css || echo "UNDEFINED $t"
done
```

The real vocabulary, from the window that gets it right (`chat.html`, 202 token
references and 2 hex literals):

- **Colour** — `--text-body`, `--text-hint`, `--text-warning`,
  `--text-player-primary`, `--text-enemy-primary` (the game's semantic for
  DANGER — there is no `--text-error`), `--accent-primary`,
  `--accent-primary-active`, `--accent-secondary`, `--border-subtle`,
  `--border-strong`, `--surface-default`, `--surface-panel`, `--page-background`.
- **Spacing** — `--spacing-xs` … `--spacing-xxxl`. Not pixels.
- **Type** — a `sui-text-*` class in the markup, not a `font-size` in CSS.

## Traps that have actually bitten

- **A new window must link all four stylesheets, in order:** `css/normalize.css`,
  `css/structicons.css`, `css/sui/sui.css`, `css/main.css`. Linking only
  `main.css` gets the colours but neither the FONT nor any SUI component — the
  window renders as a plain web form beside pixel art.

- **`main.css` sets `text-align: center` on the body.** It is invisible while a
  node is shrink-to-fit and appears the moment one goes full-width or becomes a
  flex child that grows. Set `text-align: left` explicitly on new blocks. Hit
  three times in one day: the raid Comms rail, the Pay window, the Team Ops
  event feed. In the feed the better fix was removing an unnecessary
  `flex: 1 1 auto` — `margin-left: auto` on the last item already pins it right.

- **`.sui-input-text` is the LABEL wrapper, not the input.** The correct markup
  is `<label class="sui-input-text"><span>Label</span><input type="text"></label>`;
  descendant rules style the input. Putting the class on the input gets a bare
  white browser box.

- **SUI buttons are anchors.** `a.sui-screen-btn` with
  `href="javascript:void(0)"`. `disabled` does nothing on an anchor — use a
  class that both greys it out and sets `pointer-events: none`.

- **SUI fields have a `min-width` wider than a small window.** Override
  `min-width: 0` in narrow panes or you get a horizontal scrollbar.

- **Icons: use the game's own, never emoji.** Two systems — glyph icons from the
  icon font (`icon-*`, e.g. `icon-phone`, `icon-send-alpha`) and sprite icons.
  Verify one exists before using it:
  `grep -c "\.icon-name\b" frontend/css/structicons.css`.

- **Struct art is `img/structs/<type>/<type>-struct-base.png`**, portraits are
  composed from `img/pfp/<part>/pfp_<part>_<idx>.png`. Only assets that ship in
  the webapp — never invent artwork.

- **A builder that takes both markup and text is the bug.** The debug panel's
  `row(label, value)` fed `innerHTML` and escaped neither, because five of its
  38 callers legitimately pass `<span>`s. Split it: `row()` escapes,
  `rowHtml()` is the named opt-out. A call site must SAY which it is — you
  cannot tell by reading `row('Player', playerName)`.

- **SUI already has the button.** `a.sui-screen-btn` (plus `sui-mod-primary` /
  `sui-mod-secondary` for the accent outline) gives 8px ExtremeHazard,
  uppercase, correct padding and a box-shadow border. Hand-rolling `padding +
  border + color + border-radius + font-size` on an anchor reinvents it badly
  — and the hand-rolled ones reach for `0.9em`, which is fractional scaling on
  a pixel face. Two shipped in the debug panel before anyone noticed.

- **Check `main.css` before writing a utility class.** It already ships
  `.hidden { display: none !important }` globally, and every window links it.
  A local `#thing.hidden { display: none }` was written in the belief that
  none existed — beside two earlier restatements of the same rule in the same
  file. That is how a design system quietly forks: not by disagreeing with it,
  but by each person re-deriving a piece of it. `grep -n "^\.name" frontend/css/main.css`
  before adding any utility rule.

- **A `classList.toggle()` with no rule behind it fails silently.** The class
  lands, nothing moves, the control stays on screen. If a test asserts the
  hiding, do NOT assert `getComputedStyle(el).display === 'none'` — jsdom
  answered `'none'` for a `<select>` even with every matching rule deleted.
  Walk `document.styleSheets` and ask whether any rule with `display: none`
  matches the element (`el.matches(rule.selectorText)`); that also avoids
  hardcoding the selector the code uses.

- **`image-rendering: pixelated` is for UPSCALING only.** On a 128px source
  drawn at 20px it destroys the art.

## Frames: where the panel art belongs

A standalone SCREEN gets the game's panel shell, and it works — copy the
structure from `chat.html`: `.sui-panel.sui-theme-player` wrapping
`.sui-panel-top-fill-background`, `.sui-panel-bottom-fill-background`,
`.sui-panel-edge-left`, a `.sui-panel-chunk.sui-mod-grow.sui-mod-shrink`
holding a `.sui-screen` nav and a `.sui-page-body-screen` body, then
`.sui-panel-edge-right`. The Pay window is built this way.

An auxiliary panel INSIDE the raid view is different: the HUD owns the panel
art there, and the battle log sits frameless on the page. Wrapping the Comms
rail in `.sui-panel` was tried and reverted — the art did not render in that
context and added structure for nothing. Match the window you are in.

## Numbers

Alpha, ore and power are rendered on the game's own metric ladders — "9.4Kg",
not "9400 Alpha". Use `frontend/units.js` (`StructsUnits.fmtAlpha` / `fmtOre` /
`fmtWatts`); Rust uses `mcp/tools/format.rs`. Do not add a third copy: the two
that exist are held together by `scripts/harness-tests/units.test.mjs`, and an
earlier private copy had ore's Tg divisor wrong by a factor of a million.

## Where a hand-authored frontend file may live

`scripts/sync.sh` DELETES and re-copies these from the `structs-webapp`
submodule on every `make sync` / `make release` / `make clean`:

```
frontend/css/  frontend/fonts/  frontend/img/
frontend/lottie/  frontend/structicons/  frontend/js/  frontend/sui/
```

**Nothing hand-written may live in them.** `.gitignore` lines 2-10 mirror that
list exactly, so if `git check-ignore` says a path is ignored, it is a build
output. Repo-owned places: **top level of `frontend/`** (where `chatrow.js`,
`pfp.js`, `units.js`, every `*.html` already live) and **`frontend/vendor/`**.

This is not hypothetical. `frontend/css/chat-rows.css` — the shared chat row
component — was written there, destroyed by the next release build, and shipped
missing. Both the raid rail and the Comms window rendered as unstyled divs while
the whole test suite stayed green, through three rounds of "it still looks
wrong". `scripts/harness-tests/assets.test.mjs` now fails on it.

## Three ways to look, cheapest first

The single most expensive mistake available here is debugging a rendering
problem through `make release` + `sign.sh`. Do not.

1. **Inspect the app you already have.** `devtools` is an unconditional feature
   in `src-tauri/Cargo.toml`, not gated on `debug_assertions`, so EVERY window in
   the signed release build is inspectable: right-click → Inspect Element, or
   Safari → Develop → Structs → the window. A 404 in the network tab, or a
   computed style that is not what you wrote, answers most of these instantly.
2. **`make dev`.** No `devUrl` plus `frontendDist` pointing at a directory makes
   the Tauri CLI run its own dev server on `:1430`, serve `frontend/` **from
   disk**, watch it, and reload the window on every change. Frontend edits need
   no Rust rebuild and no signing. Caveats: pages come from
   `http://localhost:1430`, a different origin from `tauri://localhost`, so
   `localStorage` is empty and the main game window starts SIGNED OUT (fine for
   board/raid/chat/transfer, which need no game session); notifications are off
   outside a bundle; MCP port 8420 is shared with any running release app.
3. **The jsdom / static harness.** Fastest, but note what it cannot do: it serves
   the source tree, so it can never tell you whether something will SHIP. That is
   `assets.test.mjs`'s job, not the harness's.

## Verify by looking

jsdom asserts structure; it does not do layout. For anything visual, serve
`frontend/` and look at it in the Browser pane — every layout defect in this
codebase was found by a screenshot, not by a test.

**Cache-bust the SCRIPTS, not just the page.** The harness loads `board.js`,
`chat.js` and friends by `src`, so adding `?cb=…` to the HTML URL reloads the
document and re-runs the OLD script. A change will look like it did not apply.
Either re-fetch each script with `cache: 'reload'` before reloading, or check
what the browser actually has:

```js
const t = await (await fetch('board.js?probe=' + Math.random())).text();
t.includes('the thing you just wrote');   // false ⇒ you are reading a stale copy
```

Time was lost to this: a change that was correct on disk, correct in the served
file, and invisible in the window.
