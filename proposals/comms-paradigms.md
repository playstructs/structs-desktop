> **Superseded 2026-09-10.** None of these shipped; see `comms-redesign-2.md` for the second round and the decision that replaced both.

# Comms: is "rooms in cards" the right shape?

*2026-09-10 · options, not a build. Mockups are drawn with the game's own
components (the Terminal card frame, the shared chat rows, SUI nav, pfp
layers); the generator is `mockups/comms-paradigms/gen.py`.*

## Why ask now

The live pass this morning (send, reply, react, join across guilds, leave,
mute, FIND) found wire and layout bugs, all fixed, none of them about the
shape. The shape is what the sixteen player reviews kept circling: five
nouns (COMMS · ROOM · CHANNELS · WHO · FIND), a room list, join and leave,
sections and folds — Discord's vocabulary, carried into a game that already
has a stronger one. A Structs player talks **about a thing, under time
pressure** — a planet whose shield is dropping, a fleet two blocks out, a
counterparty for ore. The game already has the four places that talk could
live: the **subject** (every id is a card), the **wire** (GRASS), the
**line** (⌘K), and the **map** (the raid view). Each option below puts talk
*inside* one of those instead of in a chat app beside them.

What every option keeps, per the decisions already made: select-then-act with
`r e d + p esc`; a pinned rail; DMs through the person card; the raid rail
reads and says one thing; ids in text are plain links; a server is named by
its guild.

---

## A · Subject — talk lives on the thing

![Subject](mockups/comms-paradigms/a-subject.png)

There is no room list. A planet card, a fleet card, a player card, a guild
card each carry their conversation *under their state*, and the object's own
events (a fleet arriving, a shield reading, a raid resolving) are lines in
that conversation — the reply-to-a-fleet-arrival that the Wire mockup shows
is the same thing seen from the object. The one list left is **Signals**:
what names you, direct messages, invites, then *where people are talking*
ranked by activity. Topical rooms (`#help`, `#infrastructure`) become
**boards** pinned on the guild's card.

- **Nouns:** Signals · the object's talk · here (who is present at it) ·
  Find. COMMS, ROOM, CHANNELS and WHO stop being words; `ROOM 2-21411` is
  `2-21411`, the card you already open.
- **Rust it needs:** per-object rooms already exist for planets and fleets;
  players and guilds need the same (the DM and the lobby *are* those rooms,
  renamed). Activity ranking comes from sync data already held. Event
  interleaving is client-side from GRASS, which the tape card already reads.
- **Cost:** a guild with many topical boards is thinner here than in a
  channel list; a "browse every guild's rooms" directory becomes a search,
  not a place.

## B · Wire — one stream, said and done together

![Wire](mockups/comms-paradigms/b-wire.png)

The tape card and Comms merge: one chronological stream where a raid
resolving, a transfer landing and a person speaking are rows of the same
kind, each with a subject link. Filters (`everything · mine · war · people ·
guild`) are the only structure. `SAY` from a row goes to that row's subject;
the "seen up to here" rule is the read marker. The inbox is the *only what
names you* filter, not a separate surface.

- **Nouns:** Wire · said · done · only-you.
- **Rust it needs:** nothing new for messages; the roll-up the tape already
  does for GRASS volume (thousands of frames an hour) has to apply to the
  merged stream or people drown.
- **Cost:** a conversation stops being a place. Reading back a long exchange
  about one planet is a filter you have to set, and a room's continuity
  (pins, topic, members) has nowhere to sit. Best as A's *timeline*, not as
  the whole design.

## C · Line — the Terminal's scrollback is the chat

![Line](mockups/comms-paradigms/c-line.png)

No cards at all. Card outputs and lines people say share one log; the
command box is the composer, and `SAY`'s completion menu is where the target
is chosen (*direct · the planet, 4 listening · where you last spoke*). Every
incoming line carries its subject as a link, so `2-21411 ›` is one click from
the object.

- **Nouns:** line · SAY · names-you.
- **Cost:** cheapest to build and the most coherent with ⌘K, but the worst
  place to *read*: a hundred lines of scrollback is not a conversation, and
  the raid view gets nothing from it. Keep its one idea — `SAY` anywhere,
  target chosen by completion — which already exists.

## D · Local — talk drawn where the eyes are

![Local](mockups/comms-paradigms/d-local.png)

On the raid view and the map, a line said about the object appears **at the
object**, and presence is *who is watching* — your people's portraits by
your command ship, theirs by theirs. One composer: *everyone at 2-21411
hears*. This is items 2 and 3 of the open list (SAY follows the raid view;
mention where the eyes are) taken to their conclusion rather than bolted on.

- **Nouns:** here · watching · say.
- **Rust it needs:** a "watching" presence per object (a room-level presence
  we can derive from who has the object room open — the client already
  reports typing per room; watching is the same message).
- **Cost:** not an inbox and not a place to read back; it pairs with A or B.

---

## Recommendation

**A + D**, with B's interleaving as A's timeline and C's `SAY` left exactly
as it is. Concretely: a **Signals** card replaces COMMS/CHANNELS/WHO; every
object card grows a talk section (the current ROOM card's internals, moved,
with the object's events between the lines); the raid view draws lines and
watchers at the object. FIND stays.

What that rebuilds: the three list cards and the words that open them. What
it keeps: `board-comms.js` (the model), `chatrow.js`, the ROOM card's row and
composer code, FIND, the raid rail's composer, and all of the Rust except the
two additions above.

If a different option reads better to you, say which, and the next step is
the same either way: **one full-fidelity mockup of the chosen design** — the
Signals card, a planet card with its talk, the raid bubble — before any code.
