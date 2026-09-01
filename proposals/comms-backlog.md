# Comms — outstanding work

The chat loop's backlog. It lives here rather than in conversation context so
an iteration that starts cold picks up where the last one stopped.

## Untrusted input, and where it lands

Every item below exists because Comms is the one window that renders text
**written by federated strangers**. A player's display name, a room topic, a
message body and an avatar all cross the trust boundary.

### XSS hardening

Baseline today is good and should be defended rather than assumed:

- `frontend/chat.js` builds the entire window with `textContent` — no
  `innerHTML` outside a comment. This is the property that makes the window
  safe by construction. **Pin it**: `safety.test.mjs` already asserts
  "builds no markup of its own from strings" for `board.js`; extend the same
  check to `chat.js` so the guarantee cannot erode silently.
- `frontend/raidview.js:2901` is the one place untrusted data reaches
  `innerHTML` — the tooltip carries a player's on-chain NAME. It is guarded
  by `esc` per-segment and pinned by `safety.test.mjs`. Leave the guard;
  harden the helper:
  - `esc` escapes `& < > "` but **not `'`**. In its current use (element
    content between `<br>`) that is harmless, but it makes the helper unsafe
    for any future single-quoted attribute. Complete it to match the Rust
    `html_escape()` in `mcp/tools/board.rs`, which already covers both quotes.
- ~~Audit `board-pages.js`'s ~43 `innerHTML` uses.~~ DONE 2026-08-30, and the
  result is better than assumed: **every one of them is a `= ''` clear**, as is
  the single one in `board-gamestats.js`. The whole frontend has exactly ONE
  sink that writes markup from data — the raidview tooltip — and it is esc'd
  and pinned. `chat.js` and `transfer.js` are now pinned as never assigning
  `innerHTML`/`outerHTML` at all (nor `insertAdjacentHTML`/`document.write`).
- **Matrix `formatted_body`**: we render plain `body` today. If HTML messages
  are ever rendered, they need a strict allowlist sanitizer — this is the
  single largest latent XSS surface in the protocol, and "render it like
  Element does" is not a design.
- ~~**Media URLs**.~~ DONE 2026-08-30 — on inspection this was already sound
  and is now pinned. `media_data_url` validates the `mxc://` shape, URL-encodes
  both segments, enforces a four-type RASTER allowlist (SVG deliberately absent
  — it is the one image type that carries script), caps the size, and hands the
  window **re-encoded bytes as a data URL**. The webview never resolves a
  remote URL that a stranger chose.
- **CSP** — investigated 2026-08-30, and **decided against**. Not deferred:
  the work was scoped against a working build and the trade came out bad.

  One is already configured app-wide in `tauri.conf.json`, and part of it does
  real work: `img-src 'self' data: blob:` means a hostile `avatar_url` cannot
  load a remote image at all. The weak part is `script-src 'unsafe-inline'
  'unsafe-eval'`, so the CSP is not a backstop for HTML injection.

  Removing `'unsafe-inline'` requires eliminating `javascript:` URLs, which are
  script-src governed. There are **90 of them across 12 of our files**, and
  every substitution fails on something concrete:

  - `href="#"` breaks the board, which is a HASH ROUTER
    (`location.hash.replace(/^#\/?/, '')`) — every such click would clear the
    current route.
  - Dropping `href` entirely loses `a.sui-screen-btn:link` / `:visited`, and
    the fix would live in `frontend/css/sui/sui.css` — which `sync.sh`
    `rm -rf`s and re-copies from the webapp submodule, so it is both off-limits
    and would be wiped on the next `make release`.
  - An app-wide strict `script-src` is impossible anyway: `index.html` hosts
    the game webapp itself, whose inline scripts and handlers are the
    submodule's and cannot be edited.

  A per-window meta CSP for chat/transfer/raidview alone could sidestep the
  webapp, but still needs ~50 of the 90 conversions and hits the same styling
  problem.

  Against all that, the benefit is defence-in-depth for a hole that does not
  exist: `chat.js` and `transfer.js` provably never assign `innerHTML`,
  `outerHTML`, `insertAdjacentHTML` or `document.write`, and `safety.test.mjs`
  now fails if that changes. Revisit only if a window genuinely needs to build
  markup from strings — at which point the construction guarantee is gone and
  the calculus flips.
- An on-chain identity wins outright — that name is nobody else's to take.
- Otherwise a self-chosen display name that matches a real player's name is
  disambiguated as `Claimed (localpart)` via
  `directory::name_belongs_to_a_player`.

Known gaps, roughly in order of how cheap the attack is:

- **Unicode confusables / homoglyphs.** `Marklifer` with a Cyrillic `а` is a
  different string, so `name_belongs_to_a_player` misses it and the name
  renders undisambiguated. Normalize (NFKC) and confusable-fold *before* the
  lookup.
- **Zero-width and bidi control characters.** ZWJ/ZWSP defeat the same check;
  RTL override can visually reorder a name. Strip them from display names.
- **Guild-tag mimicry.** Tags render as `[SN.C]` from the on-chain identity,
  but nothing stops a self-chosen display name from *containing* `[SN.C]`.
  Either strip bracketed prefixes from claimed names or render the real tag
  in a way a name cannot forge.
- ~~**Avatar impersonation.**~~ Investigated 2026-08-30 — the concern did not
  survive contact with the code, and the answer is now pinned rather than
  incidental. This client **never renders another account's Matrix avatar**: a
  portrait is drawn only from the chain's `pfpClientRenderAttributes`, anyone
  without an on-chain identity gets a bundled placeholder, and `matrix_media`
  serves image MESSAGES, not avatars. Wearing a guildmate's face is therefore
  structurally impossible rather than merely unhandled.

  Because it is held by construction it is also invisible — the obvious
  "improvement" is to fall back to the avatar we could easily fetch — so
  `safety.test.mjs` now asserts that every `pfp_attrs` is `None` or
  ident-derived, and that no `<img>` in the window is pointed at a URL from
  message data.

  One real (if low-severity) gap did turn up and is fixed: layer indices were
  interpolated into a path unvalidated, and `pfpClientRenderAttributes` is a
  free-form on-chain string chosen by the player it depicts. `../..`, a URL, a
  float, a negative, and a string that merely looks like a number now all fall
  back to the placeholder.
- ~~**Room name / topic.**~~ DONE 2026-08-30. Both are now sanitized at
  INGESTION — all three sites where a room name enters (joined-room state, the
  second state walk, and both public-directory listings) — so the name held in
  `Room.name` is the name on the screen.

  Sanitizing only kills the invisible tricks, though: names can still
  legitimately COLLIDE, and anyone may publish a public room under any name.
  So the browse list now prints each row's alias localpart, which is the one
  thing about a room that cannot be taken. Only the localpart: the server half
  is still shown separately and only for foreign rooms, because stamping every
  own-server row with its own server is noise on most of the list. Covered by a
  harness fixture that publishes a forgery sharing the guild room's exact
  display name.
- Consider making the localpart **always visible** for identities with no
  on-chain backing, rather than only on collision. Player id is the one name
  in this system that cannot be taken.

## XSS hardening: the debug panel's row builder — fixed 2026-08-31

One of the two standing items at the top of this file, closed for the debug
panel. Found by continuing the duplicate-logic sweep rather than by looking
for it: three HTML escapers existed, and chasing why led to the builder that
used none.

`structs-config.js` renders its panels as `innerHTML` strings. `row(label,
value)` interpolated BOTH arguments raw. 33 of its 38 callers pass plain text
— the player's own on-chain username, ids read back from the guild API, and
`e.message` out of a failed fetch — and nothing at a call site distinguished
those from the five that deliberately pass markup.

Severity is honest: the values reaching it today are the local player's own
data and structured chain ids, so this was **self-XSS at most**, not a live
remote exploit. The problem is that it was unsafe *by construction* and the
safe/unsafe split was invisible.

- `row()` now escapes. `rowHtml()` is the named opt-out, used by exactly five
  callers, and the one of those with a dynamic value escapes it at the call
  site.
- `listBlock()` escaped its title too. Every caller passes a literal today,
  which is precisely the state `row` was in before somebody passed it a
  username.
- The file had **two** escapers — one buried inside the agent-UI section where
  the panel builder could not reach it, which is a large part of why `row` had
  none. Now one at file scope.

Six mutations, each killed: `row` not escaping, a raw label, a raw address, a
raw `listBlock` title, an escaper that drops quotes, and a new unlisted
`rowHtml` caller.

### What was checked and found FINE

Worth recording so the next pass does not re-audit it:

- `board.js`'s escaper covers only `& < >`. Its one caller feeds
  `SUIOffcanvas.setHeader`, which does `innerHTML = header` — **content**
  position, where quote escaping is not required. Correct, if weaker than its
  siblings.
- `raidview.js`'s escaper covers all five and is used for tooltip bodies. (I
  first called it dead code: `.map(esc)` has no parenthesis, so a `grep esc(`
  missed the only call site.)

## Raid view: make Discuss a real chat rail

Asked for 2026-08-30. Today's `#rv-chat` is a bottom panel, `max-height:
22vh`, read-only, fed by `matrix_object_chatter` — a **cross-room search** for
messages naming this object, each row labelled with the room it came from.
Wanted instead: a right-hand rail that looks and behaves like the Comms
window, scoped to ONE room for the thing on screen.

Three separable pieces; the third is the real work. **1 and 2 shipped
2026-08-30** — the rail and its composer exist; 3 is still open.

1. ~~**Move it to the right.**~~ DONE. `#rv-left` holds map + battle log;
   `#rv-chat` is a full-height rail beside them, `clamp(240px, 26vw, 340px)`
   open and header-width collapsed so it never leaves an empty column.
   Original note: A raid is a wide, short scene — the map wants
   horizontal room, and a bottom panel eats the axis the map needs while a
   rail costs the axis it has spare. Mind `#rv-log` and the bottom-left action
   bar, which already contend for z-order here (`z-index: 45`).

2. ~~**Give it a composer.**~~ DONE. Room selector + input + send, defaulting
   to wherever the object was last discussed. `matrix_object_chatter` now
   ANSWERS with the guild it used, so the rail replies into the same guild it
   read from instead of inferring one a second time. Original note: Sending a message is not a value transfer, so
   unlike the Pay hand-off there is no authority reason to bounce the player
   to another window.

3. ~~**Scope it to a dedicated room.**~~ DONE 2026-08-31. See "How 3 was
   built" below. This is what makes 1 and 2 coherent, and it is why the
   composer did not exist at first — `wireChat` said it outright:
   *"Sending from here would mean guessing a room."* A per-object room removes
   the guess. It also changes the panel from a digest of scattered mentions
   into a conversation, which is what the request is really about.

### Design questions to answer before building 3

The sketch was `planet-id@defender.matrix.server` /
`fleet-id@attacker.matrix.server`. Matrix spells that `#planet-id:server` —
aliases are `#localpart:server`, `@` is for users — but the intent behind the
sketch is the interesting part and needs decisions:

- **Who hosts it.** A room lives on the homeserver that created it and
  federates from there. "Defender's server" for a planet and "attacker's
  server" for a fleet is a real choice, not just a naming convention: it
  decides who can delete the room and who keeps the history.
- **Who may join, and when.** A raid has two sides. One shared room where
  both sides talk is a very different game experience from two rooms that
  never see each other — and a spectator is a third case again. This is a
  gameplay decision before it is a Matrix one.
- **Lifecycle.** Raids end. Does the room persist as a record, get archived,
  or `m.room.tombstone` into the next raid on the same planet? Planets are
  raided repeatedly, so "one room per planet forever" and "one room per raid"
  give very different scrollbacks.
- **Creation cost.** Rooms would be created for objects that may never see a
  message. Prefer creating on first send, resolving by alias, and tolerating
  the room simply not existing yet.
- **Discovery and clutter.** These rooms must not flood the Comms room list.
  Consider keeping them out of the main list unless joined deliberately.
- **Untrusted content.** A rail that renders a room is a second surface with
  the trust boundary on it — every XSS and impersonation item above applies to
  it too. Reuse `chat.js`'s `textContent`-only construction rather than
  writing a second renderer with its own habits.

Keeping the existing cross-room digest alongside a room rail is worth
considering rather than assuming the room replaces it: "what has anyone
anywhere said about this planet" and "what is being said in this raid" are
genuinely different questions.

### How 3 was built, 2026-08-31

The digest was kept. It is not a fallback grudgingly retained — it is the
answer when the object belongs to a guild whose server has not created its
room, which is most objects most of the time. The rail therefore has two
modes, and the work was mostly in making them differ honestly.

Answers to the questions above, as built:

- **Who hosts it.** The OWNER's guild server, for planet and fleet alike —
  `rooms::alias_for` resolves owner → guild → homeserver on chain. Not
  attacker/defender: those are roles in one raid, and the room outlives it.
- **Lifecycle.** One room per object, forever. A planet raided ten times has
  one scrollback, which is the version that accumulates something worth
  reading.
- **Creation cost.** On first send, never on open. A raid window opens on
  every object the player merely looks at; creating a room for each would
  litter the directory with empty rooms. `matrix_object_room` therefore
  reports rather than acts, and `matrix_object_room_create` is the only
  writer.
- **Discovery and clutter.** Same reasoning applied to MEMBERSHIP: joining is
  bought by speaking, not by watching. A player who tours twenty raids joins
  nothing.
- **Who may join.** Public. Both sides and spectators, one room. A planet's
  conversation being readable by whoever is raiding it is a game property,
  not a leak — everything in there is about a public object.
- **Untrusted content.** The rail's renderer was already `textContent`-only
  and rows from a room are mapped into the same shape the digest produces, so
  there is one renderer, not two sets of habits.

Three things the tests caught that review had not:

- **The tag and the destination disagreed.** The digest appends the object id
  to outgoing text so the search can find it. That decision was made on
  `inRoom()` — where we stand — while delivery happened after a join, so a
  message sent into a room we were about to join got tagged anyway: a stray
  id in the one room that never needed one. Both now key off `reachableRoom()`
  — where the message ENDS UP.
- **`.hidden` was reinvented.** A local rule was added to hide the room
  selector, written in the belief that no `.hidden` rule reached this file.
  `main.css` ships `.hidden { display: none !important }` globally and
  raidview.html links it. Two further restatements of the same rule were
  already in the file. All three deleted.
- **A fleet was called a planet.** The kind ternary was written out three
  times — empty line and both placeholders — so a fleet window said "planet"
  wherever one was missed. Now one `objectWord()`.

Still open: the room is created public with `preset: "public_chat"`, whose
history is `shared` — so a non-member cannot read it, which is why membership
is bought on send. World-readable history would let spectators read without
joining, and is worth revisiting if the join-to-read step proves to be the
thing people trip on.

## ~~Pay should get its own small window~~ DONE 2026-08-30

Asked for 2026-08-30, after the first version shipped broken (the listener was
registered before `Board.T` existed, so Comms parked an intent and nothing ever
claimed it — fixed, and pinned in `safety.test.mjs`).

Even working, dropping someone into Team Ops for a one-line payment is wrong:
Team Ops is a six-area console, and the hand-off lands them in Industry ▸
Inventory with a drawer open. Wanted instead: a small window that does this one
thing.

Built as `frontend/transfer.html` + `transfer.js`, opened by
`matrix_open_transfer`. The gate was resolved by the FIRST option below, but
narrowly: `require_board` gained a sibling, `require_window(w, &[..])`, and
only `mcp_transfer_execute` names the transfer window. Adding the label to
`require_board` itself would have handed the new window every mass action,
config write and roster command as a side effect.

The original note on the obstacle: `mcp_transfer_execute` is `require_board(&window)` — it will
refuse any window that is not `board`. So a focused window needs one of:

- **Extend the gate to a named transfer window.** Defensible, and arguably
  BETTER than today: a single-purpose window is a narrower surface than a
  six-area console, and the gate's real job is keeping the executing command
  away from windows that render federated text. It must stay a strict
  allowlist of window labels — never "not chat".
- **Keep execution on the board window, invisibly.** More complex, and it
  gives up the thing that makes the gate easy to reason about.

Whichever is chosen, the properties that must survive: the address is still
resolved on chain and never taken from a message, the preview still runs
server-side before the commit, and the confirm still names the recipient.

Worth reusing rather than reinventing: the raid view is already a small
single-purpose window (`mcp_raid_view_open`), so its window-building path is
the shape to copy.

## Comms in Team Ops

The board's three Comms touchpoints — presence dots, message-a-player, share —
were all OUTBOUND. Nothing told a player working the console that the guild was
talking, or that they had been named. The two halves of the app ran side by side
without either knowing the other was busy.

**Done 2026-08-30:** a Comms control in the board's nav aside, on every page.
It polls `matrix_unread` (a synchronous read of state the sync loop already
maintains) and opens Comms on click.

The property that makes it meaningful: `start_sync` runs app-wide from `boot()`
for any guild with a stored session and stops only on a deliberate disconnect —
it is NOT tied to the Comms window. An indicator that could only be right while
the chat window was open would be worse than none.

Two deliberate behaviours, both pinned by `boardcomms.test.mjs`:

- **Silence is silent.** The control hides at zero rather than showing a zero.
  A console full of zeroes is a console people stop reading, which costs more
  than the indicator gains. "Comms not signed in" reaches the code as a
  rejected promise and is treated as silence, not as an error — the whole
  feature stays hidden for a player who has never opened Comms.
- **A mention is not unread traffic.** It is addressed to you, so it takes the
  warning colour the console reserves for things wanting a decision, and it
  shows even when the unread count is zero — the count is decoration, the
  mention is the event.

### Still worth doing here

- ~~A "tell the guild" on a feed line.~~ DONE 2026-08-30. Every feed row (and
  every alert) carries a share control that hands Comms a DRAFT — which room a
  line belongs in is a judgement the console cannot make, and a feed row that
  published itself to a guild channel would be a nasty surprise.

  Quiet by design: hidden until hover or keyboard focus, because one visible
  button per row turns a list people read for its text into a column of
  buttons. A shared row stays marked, so a glance down the feed says what has
  been passed on.

  The subtle part is folding. A repeated line folds into the row above and
  shows the NEWEST numbers, so the share reads the text off the row rather than
  capturing it when the row was built — otherwise the guild gets told a stale
  count. Pinned by test, and the stale-capture version was confirmed to fail
  it.
- ~~Game stats rivalry has no social surface.~~ **This note was wrong** —
  checked 2026-08-30. Leaderboard rows already carry `Board.presenceDot` and
  `Board.reachLinks` (message + share), the same two affordances the roster
  has, on the same players. Nothing to build.

  Looking for the gap did turn up a real one elsewhere, now fixed: **on-chain
  names were not sanitized**. That string is the most trusted in the app — it
  renders with no player id beside it, because `sender_display` returns early
  on the grounds that the chain settles who owns it. But owning a name and the
  name being LEGIBLE are different things, and the chain settles only the
  first: nothing stops registering one carrying a bidi override or a
  zero-width joiner. Now sanitized at all four ingestion points — both
  directory paths for Comms, and the guild-roster path the leaderboard reads
  through, which is separate. The comment claiming "nobody else's to take"
  now says what that does and does not buy.

## Review pass, 2026-08-30

A pass over the session's unsigned work rather than new features. Assets and
SUI class names all resolve; the one real defect found:

**The focused Pay window was speaking its own unit language.** It divided
Alpha by the denom exponent and printed "9400 Alpha". The board does not do
that — for `ualpha` it calls `fmtAlpha`, the game's metric ladder, and shows
"9.4Kg". Same quantity, different story from every other screen, on the one
window where the number is money.

Fixed by extracting the ladders to `frontend/units.js`: board.js now delegates
to it (aliasing the names so its ~40 call sites read unchanged) and the Pay
window uses it, so there is one ladder rather than two that can drift. The
input accepts what the ladder PRINTS — `2.5`, `9.4Kg`, `500mg` — so a figure
copied off another screen pastes back in; a bare number means grams, which is
what "Alpha" names.

Worth knowing, and now written into `units.test.mjs`: **printing is lossy.**
Two decimals on a 1000x ladder means 999μg prints as "1mg" and reads back as
1000, so a player pasting their shown balance to send everything can ask for
slightly more than they hold. That is a display ladder working as intended, and
it is safe because `mcp_transfer_preview` answers "balance is X, short by Y"
and `mcp_transfer_execute` re-runs that preview server-side — the over-send is
refused and named rather than silently clamped. A "Max" control that uses the
exact base amount sidesteps it entirely — **built 2026-08-30** as an "all" link
beside the balance. It carries a base-unit override that bypasses the text
parse, so it sends 9,400,000,999 where typing the displayed "9.4Kg" back would
send 9,400,000,000 and strand the rest.

Typing clears the override (otherwise editing the box would silently still send
everything), as does a new recipient and a completed send. Verified in the
browser against a deliberately lossy balance, and pinned in `safety.test.mjs`;
the "typing does not clear it" mutation is caught.

## Review pass, continued

Two more defects of the same class as the units one — the same thing meaning
different things depending on where you are.

**Two unit ladders, in two languages.** `units.js` (windows) and
`mcp/tools/format.rs` (everything Rust renders, including the chat ref cards)
each hold the tables. They agree today, and they have NOT always: the Rust
suite still carries the note "Ore's Tg divisor is 1e12 — the JS copy had 1e18",
a factor of a million on a number players read as a holding.

`units.test.mjs` now parses the Rust ladders and asserts all three match the JS
ones. Comparing the tables is sufficient — both formatters already round
identically (digit-length picks the rung, two decimals, trailing zeros
trimmed), so drift can only enter through the numbers. Mutation-tested in both
directions, including reintroducing the exact historical ore bug.

**`@name` did not work in the raid rail.** Comms resolves mentions against the
room's members via its own address book; the rail composer, added earlier
today, has none. So `@Marklifer` typed during a raid — precisely when you would
type it — notified nobody and gave no sign of having failed.

Fixed the same way as the ladder: one implementation, moved down. `matrix_send`
now resolves `@name` against the on-chain directory when the caller supplied
nothing, building `@<player-id>:<guild-server>` (a player id is the localpart,
which is why any player in the galaxy is addressable). Comms still wins when it
found something, because its address book reaches people the chain does not.

The boundary rule is the part that goes wrong, and is tested: longest name
first so `@Netlag` is Netlag rather than Net with a stray "lag", bounded on the
right so a name is not found inside a longer one, case-insensitive because
nobody types a display name exactly, and each person once however often named.

## Review pass, third round

**A slash meant different things in the two composers.** `/me waves` is an
emote in Comms and was a literal message in the raid rail — and worse, any
other command (`/sweep all`) would have been PUBLISHED to the guild rather than
answered, so the rail turned a typed mistake into a posted one.

The interesting part is why this could not be fixed the way the mention gap
was. Mentions moved down into `matrix_send` because a server-side fallback is
strictly better than nothing. A slash cannot: Comms strips `/me` itself and
sends the remainder, and its `//` escape — which exists so a player CAN say
"/me waves" literally — arrives as the plain body `/me waves`. A server-side
re-parse would turn the escaped text back into the emote the player escaped to
avoid. So the rule "one implementation, moved down" has a boundary, and the
escape is where it sits.

The rail now applies Comms' two rules in Comms' order (escape first, then
`/me`), and refuses anything else with "Commands live in Comms — this sends
messages" rather than sending it. Tested including the ordering: disabling the
escape makes `//me waves` fail as an unknown command, which is caught.

## Review pass, fourth round — older Comms code

Widened past this session's work. Matrix-correctness audit; most of it held up.

**A replayed sync batch duplicated the whole conversation.** The real find.
`apply_sync` appended rendered events with no dedup on event id, while
`apply_reaction` fifty lines earlier explicitly guards the same case, saying
"Sync replays events on reconnect, so this is the normal case, not an edge."
It is: a client retries `/sync` with the SAME `since` until it gets a response
it managed to process, so a dropped connection mid-conversation reprinted the
whole batch.

Fixed by keying on the server's event id — only ids the homeserver has actually
named, so a local echo (no id yet) and a gap marker (a rendering of a
discontinuity, not an event) are untouched. Tested for the overlap case too,
which is the realistic one: a retry returning what we hold PLUS what arrived
since must keep the new message and report only it in the delta, since a delta
carrying the duplicate would repaint it however well the buffer behaved.

**A load-bearing check had a false rationale.** `apply_edit` correctly refuses
an `m.replace` whose sender differs from the original's — and its comment said
"The homeserver enforces this too". The spec puts that obligation on the
CLIENT: a replacement must carry the same sender, and a client is to ignore one
that does not. The check is the only thing standing between a stranger and
words in your mouth, and a comment calling it a double of a server check is how
it gets deleted as redundant later. Corrected in both the function doc and the
test.

**Audited and sound, no change needed:** reactions (keyed by target+key, per
sender dedup, bounded key length, redaction undoes), encrypted rooms (banner
plus a per-message notice rather than an empty-looking room — Element makes DMs
encrypted by default so this is not rare), redaction fallbacks for both room
versions, and the gap marker for `limited: true`.

## Review pass, fifth round — the timeline cache

Followed the duplication thread through the rest of the message pipeline.

**Audited and sound:** local echo reconciliation (`dropEcho` drops an echo once
the homeserver's copy arrives, and also dedupes incoming against existing —
which is why last round's Rust duplication was masked in LIVE use and only
showed on a freshly opened window reading the stored buffer), and
`seed_timeline`'s merge, which correctly dedupes the page against what arrived
during the fetch.

**A bound worth writing down, not a bug.** Backfill asks for 40; the cache caps
at 500. The page goes in FRONT and the trim takes the front, so in a room
already at the cap the 40 messages discarded are exactly the 40 just fetched —
every live message survives untouched. That is the right policy for a cache
whose job is the most recent conversation, and it costs the player nothing
visible, because `matrix_backfill` hands the page straight to the window rather
than having it re-read from the cache.

It is now stated at the trim, with the specific warning not to "fix" it by
trimming from the end (the end is the newest, which is what the cache exists to
hold) — because the merge directly above reads as though seeding preserves the
page, when what it preserves is messages that arrived DURING the fetch. A test
pins the behaviour either way.

## Review pass, sixth round — sync/auth, and a third ladder

**Sync and auth audited, sound.** `since` advances only from `next_batch` on a
successful apply, so a failed sync retries the same batch rather than skipping
one (losing messages would be worse than the duplication fixed last round).
Token refresh IS implemented — `authed_on` refreshes once on `M_UNKNOWN_TOKEN`
when a refresh token exists — so the sync loop's `M_UNKNOWN_TOKEN` branch is
correctly the TERMINAL case after refresh already failed, not a premature
sign-out. That matters under MAS/OIDC, where access tokens are short-lived.

**A third unit ladder, in the main game window.** `structs-config.js` carried
its own copy of all three tables for the debug panel — after board.js's and
Rust's. Compared tier by tier including the trim regex: they agreed. That is
precisely what was true of the ore divisor before it drifted, so agreement now
is not the property worth relying on.

`formatUnit` now delegates to `units.js`, which `index.html` loads. Verified
behaviour-identical across 88 cases (four denoms x 22 magnitudes, zero
differences) rather than assumed, since this one renders in the window the
player actually plays in.

`units.test.mjs` now asserts that NO window carries its own tables — the guard
is the absence of private copies, not that the copies match — and that every
window which formats units actually loads `units.js`, which is the failure a
static check would otherwise miss entirely.

## Review pass, seventh round — notifications

**"Was this aimed at me" had two answers, and each was missing what the other
had.** The badge (`Message.mentions_me`) read the spec's `m.mentions.user_ids`
and nothing else. The notifier (`maybe_notify`) matched the body text against
your names and nothing else. So:

- a mention that named you PROPERLY — Element's pill, where the body need not
  spell your name — highlighted in the window and **never interrupted you**;
- a mention from a client too old to send `m.mentions` interrupted you and
  **never highlighted**.

The comment above the exact check even described the intended relationship —
"the word-boundary guess in the window is only a fallback for clients that do
not send it" — but nothing actually applied it as a fallback.

Now computed once where the message is built: the exact signal, OR the text
match when there is no exact signal. `maybe_notify` asks the message rather
than forming its own opinion, since a notifier with an opinion is how the badge
and the notification came to disagree in the first place. `my_names` now takes
a user id rather than a whole session, which is all it ever used and what lets
both sites share it.

Tested across all six cases (exact-only, text-only, player id as a name,
ordinary message, somebody ELSE mentioned, name inside a longer word), and both
halves mutation-tested: reverting to exact-only or giving the notifier its own
opinion each fail.

## Review pass, eighth round — and a flaky test of my own making

**A cross-language check that could not fail.** `chat.test.mjs` compared the
window's `REF_KINDS` to a hard-coded `'0,1,2,4,5,9,10'` while its comment
claimed to be holding JS and Rust to the same list. It never read `refs.rs`, so
changing `is_referenceable` alone would have left it green while the two
languages disagreed — the exact failure it existed to catch. It now parses the
Rust set, and also checks the id SHAPE agreement (the window decides what looks
like an id, Rust decides what is one). Both Rust-side mutations are caught.

**DM-ness was read off the wrong field.** `player_id` is only set when the other
side's Matrix id parses as a PLAYER id, so a direct message with a bot or a
service account has none — and the window, which inferred DM-ness from it,
rendered that room as a channel with a member count, while Rust classified it
`direct` and notified it as a DM. The window now uses `section === 'direct'`,
which is what `dm_with` actually produces, and keeps `player_id` for the
player-specific parts (the portrait, the PID subtitle).

**A flaky test I introduced, found by running the suite ten times.** The new
mention tests reused player id `1-194` and the username "Marklifer" — which an
existing impersonation test also registers. `matrix::directory` is a
process-global map and Rust tests run in parallel, so one test's cleanup removed
an entry another was still reading: about one failure in six runs. Both tests
now use invented ids and names nothing else touches (`7-8001`/"Solenne",
`7-9001`/"Thessaly"). Ten consecutive clean runs; noted in memory, since one
green run proves nothing about a race.

## Known spec gap: redacting an EDIT

Per the spec, redacting a replacement event should revert the message to its
original text. This client does not: `apply_edit` overwrites `Message.body` in
place and keeps no original, and `redact_message` matches a message's own
`event_id` — an edit event's id never appears as a row, so the redaction finds
nothing and the message keeps its edited text.

Deliberately not fixed. The cost is real state — an original body plus which
edit produced the current one — on every message in the buffer, and the case is
bounded on both sides:

- **Not reachable from this client.** The window only ever redacts by
  `serverIdOf(m)`, which is the MESSAGE's id, so a player here can redact the
  message but not one of its edits. It takes a client like Element to create
  the situation at all.
- **Not a correctness or safety problem when it happens.** The message goes on
  showing what its author most recently said. It is stale relative to what
  Element would show, not wrong about who said what — and redacting the message
  itself works normally, edited or not.

Worth revisiting if messages ever gain an edit HISTORY, since the original body
would then already be stored and this becomes nearly free.

## "<name> joined" on every sign-in — fixed

Reported from live play 2026-08-30. Signing in raised a desktop notification
reading "Marklifer joined", every time.

`maybe_notify` allowed anything whose kind was not `unknown`, and TEN different
things render as kind `event` — a join, a rename, a topic change, a pin, an
invitation. In a DM (which notifies on everything, by design) each of those
interrupted the player. The one channel that should only ever mean "a person is
talking to you" was firing for room bookkeeping.

Now an allowlist: `text | emote | image`. `notice` is deliberately excluded —
it carries real `m.notice` messages but is ALSO the kind this file gives its own
synthesized lines ("message removed", "this room has been replaced", "encrypted
message — this app cannot read it"), none of which is a person speaking, and a
redaction notifying you about a message you were already notified about is the
same bug wearing a different hat.

Pinned in `safety.test.mjs` by reading the SOURCE — the first version of the
Rust test asserted its own local copy of the list and passed happily while the
real filter was reverted.

## Carried over

- **Unbuilt / unsigned** — everything since the first loop's third iteration.
  `make build && bash scripts/sign.sh`; codesign needs an interactive
  Terminal (see `codesign_needs_interactive_shell`).
- **Shared PoW** (`proposals/shared-proof-of-work.md`) — reviewed and built,
  never exercised end-to-end against a real homeserver and chain.
- **Never verified live**: the OIDC ladder against MAS, reactions/edits
  round-tripping with Element, avatar upload.
- **"Chat during game things"** — raid view is the only in-game surface wired
  so far.

## Game stats: a chart that invented readings — fixed 2026-08-31

Not a Comms item, but it belongs with the review passes above because it is
the same failure shape: a display that answers confidently when it does not
know.

`game_stats.rs` records one series point per block. Three of its fields —
`raids`, `structs`, `draw` — are read out of the `totals` map, which is empty
until the first sweep lands. `num()` answers **0** for a missing key, so every
block before that first sweep was recorded as a hard zero, and the ring holds
720 of them — about an hour at 5.28s a block.

A sparkline scales from its own minimum. One false zero therefore did two
things at once: it drew a cliff out of a galaxy that had never been empty, and
it flattened every real movement in the window into a sliver at the top of the
chart. Both are worse than showing nothing.

Fixed on both sides of the wire:

- `opt_num()` reports absence as `null`, distinct from a genuine `0` — keyed
  off the KEY being present, never the value being falsy, because "no raids"
  is data and must still plot.
- `seriesValues()` keeps the null instead of `Number(x) || 0`, which had
  collapsed unknown and zero into each other in both directions.
- The sparkline BREAKS its line across a gap. Drawing through it would invent
  readings nobody took; drawing zero invents a crash. A break is the honest
  shape, and it also keeps `NaN` out of the `d` attribute — one non-finite
  value anywhere in that string invalidates the whole path and the chart
  silently renders nothing.

One more silent-empty case found while testing: `nums.length >= 2` was the
test for "there is a line to draw", and it is not. `[5, null, 7]` passes it
and produces two lone movetos, which SVG draws as nothing. The fallback now
asks whether a segment was actually drawn.

The harness fixture was changed to carry leading nulls, so it mirrors what the
producer really sends at a cold start rather than a shape that never occurs.

## Team Ops: two sections called "Doctrine" — fixed 2026-08-31

`War → Doctrine` and `System → Doctrine` both shipped with that label, and the
sub-nav is the only thing that distinguishes them. The game's own vocabulary
settles which keeps the word: `structs_doctrine` means posture and autonomy,
which is System's page. War's is RESPONSE SETTINGS, TARGETING GATES and
SCORING WEIGHTS — knobs, not stance — so it is now **Tuning**.

Two manifest invariants now guard `AREAS`, since a mistake in it produces a
section a player cannot find or cannot tell apart, and nothing else fails:

- no section label is used in two areas;
- every section points at a registered page (a tab that goes nowhere).

## First sign-in always failed at the consent step — fixed 2026-08-31

Reported as "whenever a player logs on the first time this fails, and then Try
Again works perfectly — can we just retry automatically?" The retry is the
symptom's shape, not the fix.

`consent()` handled exactly ONE page: post the form, follow once, and if that
landed on another page, error with *"the authorization chain stopped at
…/consent/… instead of returning a code"*. A first-ever sign-in on MAS is more
than one page.

That also explains the Try Again, precisely: the failed attempt's POST had
already **recorded the grant on the server**, so the second attempt had
nothing left to consent to and sailed through. The button was not retrying a
flaky operation — it was benefiting from a side effect of the first one.

An automatic retry would therefore have "worked", and would have been the
wrong fix: it papers over a step the client never learned to answer, costs
every new player a visible failure and a full second round trip, and hides the
next auth change behind the same shrug.

`consent()` now walks up to `MAX_CONSENT_PAGES` (4) forms, answering each,
and the issuer-host check is re-run on **every** hop rather than only the
first — a later page is as much an opportunity to be walked somewhere else.
Bounded rather than unbounded: a service that keeps serving the same form is a
loop, and posting one forever is worse than saying so.

Ruled out while diagnosing: the chain client already sets `cookie_store(true)`,
so the consent POST was correctly associated with the session. The second page
was real, not a re-render of the first.

### Tested against a socket, not a mock

The bug was in how many times a chain was walked, so a unit test on
`parse_form` could not see it — and did not. The tests stand up a stand-in
issuer on a real `TcpListener` and count the forms posted: one page still
returns the code, two pages must post BOTH, an endless server is reported
rather than ridden, and a consent page off the issuer host is refused.
Reverting to the one-shot handler fails them.

## Message opened the window but not the DM — fixed 2026-08-31

Reported twice on the same day, from the game-stats leaderboard and from the
Armada roster. One defect: both rows build their button with the same
`messageLink()`, so both had it.

The Rust side was doing everything right — open the window, resolve the DM,
store it as pending, AND emit `matrix::show_room`. The window dropped it:

```js
if (target.guild_id && target.guild_id !== S.guildId) return;   // before
if (target.guild_id && S.guildId && target.guild_id !== S.guildId) return;
```

`S.guildId` is filled by `refreshStatus()`, and the event listeners are
registered *before* that call returns. The ordinary case for this button is a
click that OPENS the window, and Team Ops emits as soon as the DM resolves —
which can beat the first status round-trip. `S.guildId` was then `null`, the
comparison read "not my guild", and the request was discarded in silence: the
window opened on the channel list and the conversation never appeared.

**A guild we do not know yet is not a different guild.** Only a guild we
actually know and that actually differs is a reason to ignore a request.

The two existing tests could not catch this — they emit after boot, when the
guild is already known. A third now covers the race, and both directions are
mutation-checked: restoring the old condition fails, and dropping the guild
check entirely fails too (a request for another network must still be ignored).

Not yet ruled out, and worth checking if a report survives this fix: the
pending-room safety net (`matrix_take_pending_room`) is claimed once, after
`refreshStatus()` and `refreshRooms()`, so a slow boot could still claim
before Rust has stored anything. That path is only reachable on a COLD window;
a window already open relies entirely on the emit.

## ~~TASK: chat as a vplayer, in its own window~~ BUILT 2026-08-31

Approved and built the same day. The five blockers below were each addressed;
the notes under them record what the answer turned out to be.

**The load-bearing idea: sessions are keyed by IDENTITY, not by guild.**

`store::key_for(guild, player)` produces `0-5` for the primary and
`0-5#1-271` for a roster player. The primary deliberately keeps the BARE guild
id, so every session stored before this existed still loads and every caller
that passes a plain guild id still finds it — a scheme that keyed the primary
as `0-5#` would have silently signed everyone out on upgrade.

`#` cannot occur in either half (both are `<n>-<n>`), so the split is
unambiguous. A separator that *could* occur — `-`, say — would make `0-5`
parse as guild `0`, player `5`; there is a test that says so.

Because `store`, `client::STATE` and `start_sync` were **already keyed by an
opaque String**, the key threads through all of them untouched. The window
learns who it is once, from `?as=1-271` in its URL, and passes the session key
in the `guildId` slot from then on — so none of the 26 `session_for` call
sites needed changing. That was the surprise: blocker 3 mostly dissolved.

What each blocker actually needed:

1. **Signing as the right wallet.** `sign_login` now takes the player, looks
   up its HD index in the vplayer store, and passes that to the façade. The
   façade derives the key itself and never hands it out, and still BUILDS the
   login message from (guild, address, timestamp) rather than accepting one —
   so the selector does not turn it into a generic signing oracle, which was
   the property the original comment was protecting.
   *Gotcha:* `__vpDerive` was `const` inside the vplayers façade's `try {}`
   block, and the Comms façade is a separate appended block — block scope
   meant a `ReferenceError` at sign-in. It is now `var` (function-scoped) so
   there is one deriver rather than a second copy of the key handling.
2. **Session store.** Done, above.
3. **26 call sites.** Not needed — see above. Only four places genuinely meant
   *guild* rather than *session*: three guild-config lookups in `directory.rs`
   and `discovery.rs`, normalised with `guild_of()` (idempotent on a plain
   id). `refs.rs`'s lookup takes a chain guild id from a ref card and was left
   alone.
4. **Window capabilities.** `chat-*` added beside `raid-*`, which already
   proved globs work there.
5. **Event routing.** Mostly free: every event already carries `guild_id`, and
   that is now the session key, so the existing filters separate identities.
   The exception is `matrix::status`, which the connect ladder emits without
   one — those now carry `as_player`, and a window drops a status addressed to
   somebody else. **An untagged push is still accepted by every window**: that
   is the sync loop's error-only push, and a filter that dropped it would
   leave a roster window never learning its session had died — it would just
   stop receiving messages, silently.

The icon is `icon-member` on the Armada roster only, and never on the
leaderboards' shared `reachLinks`: those list the whole galaxy, and a
"speak as" control must not appear beside a player whose keys we do not hold.
The primary gets no icon — its window is the ordinary Comms window. The
window title says whose voice it is, because two identical title bars is how
you send as the wrong player.

### A test that was measuring the wrong thing

The status-filter test first watched `S.networks`, which a ladder payload does
not carry at all — so it passed whether or not the filter existed. It now
watches `connecting`/`steps`, which the ladder actually sets.

A second gap showed up the same way: a mutation that made the filter drop
untagged payloads survived, because the test only exercised the PRIMARY
window, where `null` and "untagged" behave alike. Only the roster window
distinguishes them. Both directions are covered now.

## TASK (original scoping): chat as a vplayer, in its own window

Asked 2026-08-31, off the Armada roster: every player in that list is a real
player on chain with its own authority to speak, so could a second icon open a
chat window signed in AS that player — two accounts, two windows?

**Feasible. The identity model already supports it**, which is the surprising
part:

- Matrix localpart **is the player id** (`@1-271:matrix.crew.oh.energy`), so a
  vplayer already has a distinct, real Matrix identity waiting for it.
- Sign-in is a wallet signature, not a password (`auth.rs`). We hold every
  vplayer's key, and the vplayer bridge already signs as arbitrary vplayers
  for chain work.
- The guild webapp issues OIDC tokens for "addresses approved on its own
  guild", and vplayers ARE guild members.

**Five things block it, all understood:**

1. `sign_login()` passes only `{guild_id, timestamp}` to the bridge, so it
   always signs as the primary. Needs a player selector. Note this stays
   compatible with the façade's deliberate design — it signs a FIXED message
   shape, never an arbitrary string, so it still cannot become a signing
   oracle.
2. `store` is `BTreeMap<guild_id, Session>` — one session per guild. Needs
   keying by (guild, player).
3. 26 call sites resolve a session with `session_for(&guild)` alone. Each
   would have to say which identity it is acting as.
4. A second window needs its own label AND an entry in
   `capabilities/default.json` — omit it and every `event.listen` in that
   window is silently dead, which has already cost this project a debugging
   session once.
5. Event routing. A plain `listen()` targets Any, so two chat windows would
   receive each other's `matrix::timeline` emits. Emit once with a filter, or
   namespace the event names per window — the raid viewer already had to.

**Worth deciding before building, not after:** this is a sockpuppet
capability. The accounts are legitimately ours, but nobody else in the
federation can tell that 182 voices are one operator, and "anti-impersonation"
is a standing item at the top of this file. That is a product call, not a
technical one.

## Pay window: parties, every sendable asset, and a unit control — 2026-08-31

Three asks, one of which needed a decision rather than code.

**1. From/To are player cards.** The window printed the word "primary" on both
lines, naming neither party and giving no way to notice you were about to pay
the wrong one. Both are now the roster's `sui-result-row`: portrait, name, id
and address. The recipient's face arrives with the PREVIEW rather than the
intent, because only the server resolves an address to one of our players —
and an external destination therefore has no face, which is exactly the
distinction worth drawing. Portraits go through the shared `pfp.js` composer,
so another player's on-chain string is validated before it reaches a path.

**2. Every sendable asset.** `SENDABLE_DENOMS` excluded `uguild.*` with the
note *"observed only in provider/guild flows, so it stays read-only until
proven otherwise"*, and immediately below it a comment recording that the
chain does NOT validate a send's `toAddress` — a bad one is a silent burn.
Widening that on inference would have been the wrong kind of confident, so it
was checked against the production ledger:

| | evidence |
|---|---|
| the bank moves them | `uguild.0-5`: 1252 `sent`, 1252 `received` — matched, nothing burned |
| a player can SEND one | 11 sends originated from real player addresses |
| a player can HOLD one | 1251 received by real player addresses |
| player→player | **never done** — every player-originated send went to a module or guild address |

The last row is the honest caveat: that exact combination is new. There is no
mechanism by which it would differ — `MsgPlayerSend` is a bank send and bank
sends do not inspect the pair — but it is worth knowing it is untrodden.

Still an allow-list: `ualpha.infused` and `ualpha.defusing` are real denoms in
the ledger and are staking states, not balances, so they stay refused. The
guild shape is checked (`uguild.<digits and dashes>`), not prefix-matched.

The existing test asserting guild tokens were read-only was **inverted rather
than deleted** — the policy changed on evidence, and that is worth being able
to read later.

**3. A unit control.** Alpha offers the game's own ladder from `units.js`
(Tg/Kg/g/mg/μg). A guild token offers the two names its guild actually
published — inventing Kg and mg for somebody else's token would be making
units up. A typed suffix still wins over the control, so a figure copied off
any other screen pastes back in and means what it says.

### The window finally has a harness

There was none, and three new controls that decide what leaves a wallet should
not ship unexercised. `_harness_transfer.html` + `transfer.test.mjs` assert the
denom and amount that would REALLY have been sent — including that "all" still
spends the un-printable remainder, for the guild token as well as for Alpha.

Two notes on the testing itself:

- A source-grep in `safety.test.mjs` broke on a rename (`S.alpha.amount` →
  `asset().amount`). The property it guarded was still true; it was pinned to
  a spelling. It now matches the new one AND the behaviour is asserted
  properly in the new harness, which is where it belonged.
- Two of six mutations appeared to survive and had simply not landed — one
  matched `μ` as `\xb5` (it is U+03BC). A mutation run that cannot tell
  "didn't apply" from "wasn't caught" reports false confidence in both
  directions.

## The raid rail is now the Comms row, not a lookalike — 2026-08-31

Asked for twice. The first time I mirrored the styling — copied the intent
into `.rv-chat-*` rules — which is exactly how the two drifted apart again,
and why the second ask was *"I don't understand why it needs to be styled in a
unique way."* It didn't. The answer was to share the component, not to imitate
it harder.

Two new shared files, and both windows use them:

- **`frontend/chat-rows.css`** — the row's presentation, lifted verbatim
  out of `chat.html`. Presentation only: the react/reply/pin/edit hover
  machinery stays behind, because a rail has none of it and should not inherit
  it.
- **`frontend/chatrow.js`** — `StructsChatRow.render(m, prev, opts)`. What
  differs between the two windows is not the row, it is what the row can DO,
  so the interactive controls arrive through an `opts.controls` hook. The
  embedded version is the same component with less bolted on.

What the rail gained by not being a lookalike any more, none of which was
deliberate omission — it simply never had them:

- **room events render as events.** "MARKLIFER joined" was being drawn as a
  message with a sender header, as though somebody had said the word "joined".
- a clock on every message;
- run-collapsing, so three lines from one speaker are one header;
- emotes as one line rather than a header plus a body;
- the sender tag as a tag rather than glued to the name.

`chat.js`'s `messageNode` now delegates too — otherwise there would still be
two renderers, one of them merely better hidden. The old `.rv-chat-*` rules
are deleted rather than left dead.

### Two testing notes

- Four assertions dereferenced `querySelector(...).textContent` directly. When
  a mutation removed the rows — precisely what those checks exist to catch —
  the run died with a TypeError instead of failing. A crash and a failure are
  not the same signal, and a mutation run cannot tell "the guard worked" from
  "the harness broke". They read through a default now, and the same mutation
  reports 11 clean failures.
- The `sui.test.mjs` guard added earlier caught `chatrow.js` immediately and
  refused to let it join the app without joining the audit. Working as
  intended.

## The rail: no channel picker, and the game's own composer — 2026-08-31

The third attempt at one request, and the first two both missed it. Worth
recording why.

- **Attempt 1** mirrored the styling into `.rv-chat-*` rules. Same intent,
  separate spelling — which is how they drifted.
- **Attempt 2** shared the message ROW and stopped there. The rows were right
  and nothing looked different, because the visible chrome — the composer, the
  empty state, and a channel dropdown — was still bespoke, and an empty rail
  shows no rows at all.

The lesson is narrow and worth keeping: sharing the part that is *hard* is not
the same as sharing the part that is *seen*.

**No channel picker.** It is deleted, not hidden. It existed because the
search path had to guess which room a reply belonged in — but a rail titled
"this planet" offering to send into `#chatrbocks` was never what it meant.
Removing it made the id-tagging branch **unreachable** (`sendChat` returns when
no room is reachable), so that went too.

**The composer is the game's own.** `StructsChatRow.composer()` builds the
`sui-panel` Comms uses — portrait well, the message on an inset screen, and
send as a `sui-panel-btn` with `icon-arrow` — and both windows call it. The
rail was drawing a bare input in a `sui-screen` with a text link that said
"send".

**And a room the rail can always reach.** Removing the picker exposed a real
gap: `can_create` is only true in our OWN homeserver's namespace, so for an
enemy planet nobody we could ask had made the room — the rail would have been
read-only for exactly the planets people most want to talk about. Room
resolution is now an ORDER rather than one address: prefer the owner's guild's
room, fall back to one on our own server. Both are "the planet's channel"; the
second is our guild's copy of that conversation, which is what we would have
had anyway.

### Testing

The default harness fixture now says "no room yet, and it is ours to make",
because that is the ordinary case rather than the exception it was written as.

Twice in this pass a crash was mistaken for a pass, because the runner grepped
for `^FAIL` and a syntax error produces none. The run script now requires a
suite to have printed one of its own summary lines, and treats anything else
as CRASHED. This is the third time this exact ambiguity has cost something
today.

## The rail's chrome, and why the last two attempts "looked identical"

Third pass, and this one was verified in a browser rather than asserted.

Done: the header is SUI's `.sui-page-header` carrying the room's NAME, with the
room's own topic underneath, exactly as the Comms room page draws it. No tab
strip — there is one channel here, and a tab strip with a single tab is a
control that decides nothing. No "open in comms" link: this IS the room, so a
door out of it was a leftover from when the rail was only a digest. The
timeline is `.chat-scroll`, moved into the shared stylesheet with `.chat-topic`
for the same reason the rows were.

**Two real defects that only rendering could find**, both invisible to jsdom:

1. **Every message body rendered CENTRED.** `main.css` sets
   `text-align: center` and it is inherited by anything full-width; the Comms
   window happened to override it further up and the rail did not. Now set on
   the component, so no window has to remember. This is the fourth time that
   rule has bitten.
2. **The composer's input was 72px** at the rail's 240px minimum — measured,
   not guessed. The portrait well and send button took 91px of a 223px panel.
   The portrait is now dropped below ~300px of rail: it says who you are,
   which this window has never been in doubt about, while the message is the
   point. It returns at 340px.

The media query first used `:first-of-type`, which matches the first `div`
sibling — `.sui-panel-edge-left`, not the portrait chunk. The chunk carries a
class of its own now.

### Why "it looks the exact same" happened twice

Attempt 1 mirrored the styling. Attempt 2 shared the message ROW and stopped —
and on an empty rail there are no rows, so nothing visible changed at all.
Sharing the part that is hard is not the same as sharing the part that is seen.

### The harness lied three times

Reloading a harness after an edit re-ran the CACHED `chatrow.js` against the
new markup, which reads exactly like "the change did not work" — twice while
trying to demonstrate that a change HAD landed. `make_harness.sh` now stamps
every local asset URL in the generated `_harness*.html` with the build time, so
a rebuild is always a fresh fetch. One of my own assertions then failed on the
stamp, because it compared the whole href; it compares the path now.

## Why three "verified" fixes all shipped broken — 2026-08-31

Not a styling bug at any point. `frontend/css/chat-rows.css` — the shared chat
row extracted from `chat.html` — was hand-authored into a directory that
`scripts/sync.sh` DELETES and re-copies from the webapp submodule:

```
rm -rf "$FRONTEND_DIR/css" … ; cp -r "$WEBAPP_DIR/src/public/css" "$FRONTEND_DIR/css"
```

`make release` destroyed it before the build. `strings` on the shipped binary:
`chat-rows` occurs **0** times while `main.css`, `sui.css`, `chatrow`, `pfp.js`
and `raidview` all occur — the JS shipped, the stylesheet did not. The `<link>`
404'd, so none of the row, scroll or topic rules applied. The file was also
**untracked**, `.gitignore:2` covering `frontend/css/`, so it only ever existed
on one machine.

It broke **both** windows: 20 rules had been moved out of `chat.html`, so Comms
was equally unstyled. Nobody noticed because nobody opened it.

**Nothing could have caught it.** The jsdom and static harnesses serve
`frontend/` off disk, where the file exists — they were faithful to the source
tree and never to the build, and structurally cannot answer "will this ship".
`raidview.test.mjs` asserted the markup string `css/chat-rows.css` appeared in
the `<link>` list, which passes with the file deleted. No test anywhere resolved
a `<link>` or `<script>` to a real file.

### Fixed

- `frontend/chat-rows.css` at the **top level**, beside `chatrow.js`, `pfp.js`,
  `units.js` — repo-owned, git-tracked, and matched by no `rm` in the pipeline
  (checked mechanically, not by eye).
- **`scripts/harness-tests/assets.test.mjs`**: every `<link>`/`<script>` in every
  window must resolve to a real file, and any asset `git check-ignore` calls
  generated must also exist in the webapp source it is copied from. `.gitignore`
  lines 2-10 already mirror sync.sh's wipe list exactly, so git is the authority
  rather than a second copy of the list. It failed on the live bug before the
  move and names the fix in its message.
- `.gitignore` globs `frontend/_harness*` / `_fixtures*`. The per-file list had
  drifted; the two newest harnesses were tracked by accident.

### The loop was never this slow

Two things were available the whole time and went unused:

- **Devtools are ON in the release build** — `tauri = { features = ["devtools"] }`
  in `src-tauri/Cargo.toml`, unconditional, not gated on `debug_assertions`.
  Every window in the signed app is inspectable. One look at the network tab
  would have shown a 404 and ended this in the first round.
- **`make dev` hot-reloads.** No `devUrl` + `frontendDist` as a directory makes
  the Tauri CLI serve `frontend/` from disk on `:1430` and reload the window on
  every change — no Rust rebuild, no codesign. Signing only ever blocked the
  *build* path, and that got generalised into "everything needs a signed build".

Both are now in `.claude/skills/sui-design/SKILL.md` with the caveats, and
`.claude/launch.json` has an `app` entry for `cargo tauri dev`.

## The empty channel, and "how is this not the same code?" — 2026-08-31

Two separate things, and the first was the visible one.

### It could not START a conversation

A raid window opened on a planet nobody had discussed showed a header saying
**"Comms"**, no topic, no composer, and a bare line of hint text. Not a styling
problem: the room never resolved.

`rooms::alias_for` answers `None` whenever the owner cannot be resolved to a
guild with a known Matrix server — **most of the galaxy**, since we hold config
for few guilds. That path set `can_create: false`, and a rail with no room has
no name, no topic and no composer. An earlier fix had added a fallback to our
own homeserver, but only for the case where the alias resolved and the room did
not exist. The far commoner case — no alias at all — still fell through.

Room resolution is now `rooms::resolve(owner, owner_room, mine, mine_room,
own_server)`: a **pure function**, extracted precisely because this is the logic
that has been wrong twice and the part a network call cannot be pointed at.
Six tests; three mutations killed, including the exact regression.

The rail also stopped waiting for the room to answer before naming itself. It
has never been in doubt about which planet it is showing, so the header says
`Planet 2-16116` and the topic says `Everything said about planet 2-16116.`
from the first paint — the same sentence the room is created with, so nothing
reshapes when somebody finally speaks.

### Sharing the leaves is not sharing the look

The fair challenge was "how is this not basically the same code?" It now is,
and the honest measure:

| | shared | window-specific |
|---|---|---|
| `chat-rows.css` | 35 rules | `chat.html` 19 (all control hover states), `raidview.html` 1 (tighter row spacing in a rail) |
| `chatrow.js` | `render`, `composer`, `notice`, `continues`, `fmtTime` | — |

What was still bespoke and is not any more: the **empty state**. Comms drew
`noticeBlock('Quiet', …)` — a title and a sentence — while the rail drew a bare
`.rv-log-empty` div. That is the state a channel is MOST often seen in, so it
was the worst possible thing to leave un-shared.

One real leak the move exposed: `.chat-msg-edited` is emitted by the **shared**
renderer but was styled only in `chat.html`, so an edited message rendered bare
in the rail. A new check in `units.test.mjs` now walks every class `chatrow.js`
emits and fails if the shared sheet does not style it. It found two more
immediately — `chat-composer-portrait` and its connector — which are genuine
HOOKS with no appearance of their own, so they are a named exception, with a
second assertion that fails if either ever gains styling and stops being a hook.

### Method

The suite was green through all of this, again. Two more of my own checks were
measuring nothing: one asserted the header said "Comms", one asserted the topic
was hidden — both pinned to the broken behaviour. And the crash-vs-pass
detector missed a suite because `raidview.test.mjs` prints `failure(s)` while
others print `failing check`; the runner now requires one of every suite's own
summary wordings.

## The composer was real classes in an invented arrangement — 2026-08-31

"Still looks like a temu version of the real action bar. Are we not using real
components yet?" — a fair question, and the answer was no, not really.

`composer()` was copied from `chat.js`'s composer, which was itself hand-built.
So neither was the game's. It used the right CLASSES in a layout I invented:

| the game's `#notification-dialogue` | what I had |
|---|---|
| button in `.sui-dialogue-btn-chunk > -col` | `.sui-action-bar-btn-group` (the ACTION BAR's grouping) |
| `.sui-panel-chunk-spacer-btn-a` above the button | omitted |
| `.sui-panel-chunk-spacer-indicator` in the portrait chunk | omitted |
| middle chunk `sui-mod-grow` | `sui-mod-grow sui-mod-shrink` |
| right edge `sui-panel-edge-right sui-theme-player` | unthemed |

The spacers are not decoration. They seat the button and the portrait against
the panel's own art; without them the pieces float in a frame they do not fit,
which is precisely what a recreated-looking panel looks like.

Rebuilt structurally from `structs-webapp/src/templates/game/index.html.twig`
— the game's own dialogue panel, the thing that actually puts a portrait, a
message and a button on a `sui-panel`. Verified in a browser: the button is
44x48 carrying the real `panel-btn-default.png` sprite, the right edge is
themed, and the panel is 72px like the game's.

The lesson generalises past this component: **using SUI class names is not the
same as using a SUI component.** The arrangement is part of the component, and
the only way to get it right is to read the game's markup rather than assemble
something plausible from its vocabulary. Five assertions now pin the
arrangement, not just the classes.

## The rail header is the topic — 2026-08-31

The header said "PLANET 2-16116" and the topic sat on a second line beneath it.
The map beside the panel already names the planet in its own banner, so the
rail was saying it twice and spending a line on the repetition. The header is
now the topic ("Everything said about planet 2-16116."), ellipsised for a
240px rail, and the separate line is gone.
