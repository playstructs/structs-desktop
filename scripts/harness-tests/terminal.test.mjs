// The Structs Terminal (board-terminal.js) against the static harness.
//
//   bash scripts/make_harness.sh && node scripts/harness-tests/terminal.test.mjs
//
// Structural: what rendered from a saved layout, what a card holds, what the
// doors invoke, and that a pop-out window shows one card and nothing else.
import { JSDOM } from 'jsdom';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const harness = resolve(repo, 'frontend', '_harness.html');
const read = (p) => readFileSync(resolve(repo, p), 'utf8');
if (!existsSync(harness)) { console.error('missing frontend/_harness.html — run: bash scripts/make_harness.sh'); process.exit(2); }

let failures = 0;
function check(name, ok, detail) {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
}
function load(query) {
  return JSDOM.fromFile(harness, { url: pathToFileURL(harness).href + query, runScripts: 'dangerously', resources: 'usable', pretendToBeVisual: true });
}
async function until(fn, ms = 6000) {
  const t0 = Date.now();
  for (;;) { const v = fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await new Promise((r) => setTimeout(r, 50)); }
}
const tick = (ms) => new Promise((r) => setTimeout(r, ms));

// ── The page: a saved layout, every card drawn by its type ────────────────
{
  const dom = await load('?view=terminal');
  const w = dom.window, d = w.document;
  await until(() => d.querySelectorAll('#tm-grid .tm-card').length >= 5);
  check('solo attribute set', d.documentElement.getAttribute('data-solo') === 'terminal');
  const cards = [...d.querySelectorAll('#tm-grid .tm-card')];
  check('the saved layout is drawn, in its order — a saved whole-page card migrated into the cards that carry its data', cards.map((c) => c.getAttribute('data-card')).join(',') === 'people-1,market-1,pow-1,tasks-1,player-1,stats-1', cards.map((c) => c.getAttribute('data-card')).join(','));
  check('no card is titled after a window', [...d.querySelectorAll('#tm-grid .tm-title')].every((t) => !/Team Ops|Game Stats/.test(t.textContent)));
  check('widths come from the layout', cards[1].classList.contains('tm-w2') && cards[0].classList.contains('tm-w1'));
  /* ── The palette replaced the bar ───────────────────────────────────────
   *
   * A bar that is always there is a bar the cards are always paying for, and
   * everything it did is one keystroke away. Opened empty the palette IS the
   * card menu — so it is a strict superset of the picker it replaced, not a
   * second way in. */
  check('the command bar is GONE until asked for — no permanent slab over the cards',
    d.getElementById('tm-palette') !== null && d.getElementById('tm-palette').hidden
      && d.querySelector('.tm-chrome .sui-screen-nav.tm-bar') === null);
  /* Being temporary is what lets it stop being a bar. A strip wedged into the
   * chrome had to stay narrow; a Spotlight over the whole board does not — so
   * it is a scrim on the BODY with one panel floating on it, and the scrim is
   * the game's own (`.sui-message-system-model-overlay`, what the game dims
   * the board with for its system modals) rather than a second one invented
   * here. */
  {
    const pal = d.getElementById('tm-palette');
    check('…and when it comes it is a Spotlight over the whole board, not a strip in the chrome',
      pal.parentNode === d.body
      && pal.classList.contains('sui-message-system-model-overlay')
      && pal.querySelector('.tm-palette-box.sui-panel .sui-screen-nav.tm-bar #tm-cmd') !== null,
      pal.className);
    check('…sitting high in it, because the matches grow downward',
      /#tm-palette \{[^}]*justify-content: flex-start/.test(read('frontend/board.html'))
      && /#tm-palette \{[^}]*padding: 16vh/.test(read('frontend/board.html')));
    check('…and the line you type is at reading size, which a bar could never afford',
      d.getElementById('tm-cmd').classList.contains('sui-text-paragraph'));
  }
  check('…and a mouse has a door to it, because a hidden feature with no affordance is one nobody finds',
    d.querySelector('#tm-ws-doors .tm-door[title^="Command palette"]') !== null);
  check('every card is the game\'s own panel: edges, chunk, a nav screen for the header with the title as the active tab and the doors beside it, a page-body screen for the body', cards.every((c) => c.classList.contains('sui-panel') && c.classList.contains('sui-theme-player') && c.querySelector(':scope > .sui-panel-edge-left') && c.querySelector(':scope > .sui-panel-edge-right') && c.querySelector(':scope > .sui-panel-chunk > .sui-screen > .sui-screen-nav .sui-screen-nav-item.sui-mod-active.tm-title') && c.querySelector('.sui-screen-nav .tm-doors') && c.querySelector(':scope > .sui-panel-chunk > .sui-screen > .sui-page-body-screen.tm-body')));
  const wsItems = [...d.querySelectorAll('#tm-ws-items .sui-screen-nav-item')].map((a) => a.textContent);
  check('the workspace strip lists every workspace and a door to a new one', wsItems.join(',') === 'main,war-room,+' && d.querySelector('#tm-ws-items .sui-mod-active').textContent === 'main', wsItems.join(','));

  await until(() => d.querySelector('#tm-people-1 .pc-person'));
  check('liveness card: the Game Stats people card, inside the Terminal', d.querySelectorAll('#tm-people-1 .pc-person').length === 12);
  await until(() => d.querySelectorAll('#tm-market-1 .sui-planet-card').length === 2);
  const offers = [...d.querySelectorAll('#tm-market-1 .sui-planet-card')];
  check('market card: one provider card per offer, from terminal_market', offers.length === 2);
  check('…an open offer can be rented, a guild-market one cannot', d.querySelectorAll('#tm-market-1 .tm-offer')[0].querySelector('[title="Rent capacity"]') !== null && d.querySelectorAll('#tm-market-1 .tm-offer')[1].querySelector('[title="Rent capacity"]') === null);
  /* ── The market as a QUOTE BOARD ────────────────────────────────────────
   *
   * Offers are quoted in whatever the seller likes — alpha, or any guild's own
   * token — so "1 alpha" beside "3 ohm" is not a comparison and the board had
   * no ordering at all: alpha-priced offers led and the rest kept their chain
   * order behind them. Restated off the guild banks' collateral ratios, the
   * cheapest capacity in the galaxy is the top row whoever is selling it.
   */
  {
    const mkt = d.querySelector('#tm-market-1');
    const tiles = [...mkt.querySelectorAll('.fstat')].map((t) => t.textContent.replace(/\s+/g, ' ').trim());
    check('the board opens with the market: best, median, and how much is actually for sale',
      tiles.length === 3 && /16\.36Kg/.test(tiles[0]) && /best/i.test(tiles[0])
        && /49\.09Kg/.test(tiles[1]) && /1\.05MW/.test(tiles[2]), tiles.join(' | '));
    const cmp = [...mkt.querySelectorAll('.xp-compare')].map((n) => n.textContent.replace(/\s+/g, ' ').trim());
    check('…and every offer leads with that one comparable unit, cheapest first',
      cmp.join(' , ') === '16.36Kg / kW / day , 49.09Kg / kW / day', cmp.join(' , '));
    check('…while the seller\'s own quote stays beside it, per MILLIWATT — the unit the chain charges in',
      /1 \/ mW \/ blk/.test(offers[0].textContent.replace(/\s+/g, ' ')) && /3 ohm \/ mW \/ blk/i.test(offers[1].textContent.replace(/\s+/g, ' ')),
      offers[1].textContent.replace(/\s+/g, ' '));
  }
  await until(() => d.querySelector('#tm-pow-1 .fstat'));
  check('proof queue card: six tiles, not three tiles over three wrapping label rows, and no constant 64 anywhere', d.querySelectorAll('#tm-pow-1 .fstat').length === 6 && /GPU/.test(d.querySelector('#tm-pow-1').textContent) && /auto-tuned/.test(d.querySelector('#tm-pow-1').textContent) && !/64/.test(d.querySelector('#tm-pow-1').textContent), d.querySelector('#tm-pow-1').textContent);
  /* A tile that reads 0 forever is not a reading. `done` counted completed
   * tasks, which reap themselves, so it was always 0 — live 2026-09-07 the
   * card said 0 running / 0 done / 1,657 waiting while the GPU was solving
   * 161 an hour. What is working is what it has SOLVED, from the pow stats
   * already in the same payload. */
  check('…and the third tile is what the engine has SOLVED, not a `done` count that reaps itself to zero', /solved/.test(d.querySelector('#tm-pow-1').textContent) && /310/.test(d.querySelector('#tm-pow-1').textContent) && !/done/i.test(d.querySelector('#tm-pow-1').textContent), d.querySelector('#tm-pow-1').textContent);
  await until(() => d.querySelector('#tm-tasks-1 .pc-row'));
  check('tasks card: a row per UNFINISHED proof, the running one first with its progress bar and its difficulty (the constant 64 dropped)', d.querySelectorAll('#tm-tasks-1 .pc-row').length === 2 && /5-12:mine/.test(d.querySelector('#tm-tasks-1 .pc-row').textContent) && d.querySelector('#tm-tasks-1 .pc-row .sui-action-bar-progress-bar') !== null && /12difficulty/.test(d.querySelector('#tm-tasks-1 .pc-row').textContent) && !/64/.test(d.querySelector('#tm-tasks-1 .pc-row').textContent), d.querySelector('#tm-tasks-1 .pc-row') && d.querySelector('#tm-tasks-1 .pc-row').textContent);
  check('…finished proofs are set aside, and the caption says how many', /1 finished hidden/.test(d.querySelector('#tm-tasks-1 .tm-cap').textContent), d.querySelector('#tm-tasks-1 .tm-cap').textContent);
  check('…and an unfinished proof can be cancelled', d.querySelector('#tm-tasks-1 .pc-row .pc-act[title="Cancel this proof"]') !== null);
  check('…the running proof wears the struct it is for as its emblem', d.querySelector('#tm-tasks-1 .pc-row .gc-emblem img') !== null && /img\/structs\/extractor\//.test(d.querySelector('#tm-tasks-1 .pc-row .gc-emblem img').getAttribute('src') || ''), d.querySelector('#tm-tasks-1 .pc-row .gc-emblem img') && d.querySelector('#tm-tasks-1 .pc-row .gc-emblem img').getAttribute('src'));
  check('the Team Ops pages themselves are not offered as cards (only the settings forms)', !w.Board.Terminal.suggestFor('').some((o) => /Team Ops/.test(o.what)) && !w.Board.Terminal.types().some((t) => t.type === 'page'));
  /* Forty-two cards in one flat scroll is an inventory, not a menu. They are
   * filed under the board's OWN area names, so the vocabulary the tabs teach
   * is the vocabulary that finds a card — and nothing may fall through: a
   * card nobody filed is a card nobody will find. */
  {
    const groups = w.Board.Terminal.groups();
    const filed = groups.flatMap((g) => g.options.map((o) => o.value));
    const all = w.Board.Terminal.types().map((t) => t.type);
    const empty = w.Board.Terminal.suggestFor('');
    check('the card menu is grouped by the board\'s areas, not one flat list', groups.length >= 6 && groups.every((g) => g.group && g.options.length)
      && new Set(empty.map((o) => o.group)).size === groups.length);
    check('…every registered card is filed in exactly one named group', groups.every((g) => g.group !== 'More') && all.every((t) => filed.filter((f) => f === t).length === 1) && filed.length === all.length, all.filter((t) => !filed.includes(t)).join(','));
    /* Opened EMPTY, the palette is the card menu: every card, grouped, each
     * row naming the word that opens it. That is what lets the picker go — a
     * strict superset, not a second way in. */
    check('…and an empty palette still offers every card the picker did, each named by the word that opens it',
      empty.length === all.length && empty.every((o) => o.words && o.what), empty.length + ' of ' + all.length);
    check('…in the same groups, in the same order', empty.map((o) => o.group).filter((g, i, a) => g !== a[i - 1]).join(' ') === groups.map((g) => g.group).join(' '));
    /* Named explicitly, not left to the "everything is filed" rule above: the
     * two achievement cards are the newest, and "is it in the palette yet?"
     * is the first question a build raises about them. */
    // `words` is the single word the row is opened by, a string — not a list.
    const at = (t) => empty.find((o) => String(o.words || '').toUpperCase() === t);
    check('the service record is in the palette, under Explore, as RECORD',
      at('RECORD') && at('RECORD').group === 'Explore', JSON.stringify(at('RECORD') || null));
    check('…and the hull tally under War, as TALLY',
      at('TALLY') && at('TALLY').group === 'War', JSON.stringify(at('TALLY') || null));
  }
  await until(() => d.querySelector('#tm-player-1 .pc-card'));
  {
    const pc = d.querySelector('#tm-player-1 .pc-card');
    // The card reads the PROFILE, not the roster's `mcp_player_detail` —
    // which answers "primary" with no figures at all for anybody outside our
    // own virtual roster, and drew a card that was a title over an empty
    // frame. Name, guild, portrait, alpha, ore, energy and struct count all
    // come off the one read Explore uses.
    check('player card: the shared card for the named player, filled from the profile', /JPEG/.test(pc?.textContent || '') && !/PRIMARY/i.test(pc?.textContent || ''));
    check('…the guild is named and tagged, not left as an id', /\[OH\]/.test(pc.textContent) && /Orbital Hydro/.test(pc.textContent));
    check('…the portrait is the player\'s own on-chain one', pc.querySelector('.pc-pfp img') !== null, pc.querySelector('.pc-pfp')?.innerHTML.slice(0, 120));
    check('…alpha, ore, energy and the struct count are all readings', pc.querySelectorAll('.pc-res').length >= 4 && /13/.test(pc.textContent));
    const strip = d.querySelector('#tm-player-1 .tm-tiles');
    check('…and the guild\'s record of what they have done rides under it', strip !== null && /planets/.test(strip.textContent) && /raids/.test(strip.textContent) && /mined/.test(strip.textContent));
    const chips = d.querySelectorAll('#tm-player-1 .tm-player-chips .sc-chip, #tm-player-1 .tm-player-chips .gc-chip');
    check('…with their guild, planet and fleet as chips that open cards of their own', chips.length === 3);
  }
  await until(() => d.querySelector('#tm-stats-1 .fstat'));
  check('stats card: one Game Stats section', /RAID PRESSURE/i.test(d.querySelector('#tm-stats-1')?.textContent || ''));

  /* The guild's stat store, which nothing but the galaxy roll-up on Game
   * Stats had ever read. A chart of ONE object's history, from
   * `terminal_series` — and the nulls before the first sample must break the
   * line, never land on the floor as zeros. */
  {
    w.Board.Terminal.add('series', { id: '2-29604', metric: 'ore', window: '86400' }, 2);
    const id = w.Board.Terminal.state.layout.cards.slice(-1)[0].id;
    await until(() => d.querySelector('#tm-' + id + ' .gs-chart svg path'));
    const node = d.querySelector('#tm-' + id);
    const call = (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_series').slice(-1)[0];
    check('history card: asks the stat store for that object, metric and window', call && call.args.object === '2-29604' && call.args.metric === 'ore' && call.args.windowS === 86400);
    check('…and draws it with the Game Stats chart, in the metric\'s own unit', node.querySelector('.gs-chart svg path') !== null && /Kg|g\b/.test(node.querySelector('.gs-axis-top').textContent), node.querySelector('.gs-axis-top')?.textContent);
    const dpath = node.querySelector('.gs-chart svg path').getAttribute('d');
    check('…with the slots before the first sample left out of the line, not drawn as zero', dpath.split('M').length === 2 && !/NaN/.test(dpath));
    w.Board.Terminal.remove(id);   // the layout below is the default one
  }

  /* ── BUILD: the last verb with no way in ────────────────────────────────
   *
   * `build` takes an ambit and a SLOT, and a slot number is not something a
   * person knows: offered as a bare number it is a guess the chain refuses.
   * What is offered has to be what is FREE.
   */
  {
    const T = w.Board.Terminal;
    T.execute('BUILD 2-15361');
    await until(() => d.querySelector('#tm-grid [data-type="build"] .tm-ambits'));
    const b = [...d.querySelectorAll('#tm-grid [data-type="build"]')].slice(-1)[0];
    const chips = [...b.querySelectorAll('.tm-ambit')].map((n) => n.textContent);
    check('the card counts free slots per ambit, in the same order every time',
      chips.join(' ') === 'space 1/2 air 2/2 land 0/4 water 2/4', chips.join(' '));
    check('…and a full ambit is not lit', [...b.querySelectorAll('.tm-ambit')].find((n) => /land/.test(n.textContent)).classList.contains('is-on') === false);
    b.querySelector('.tm-doors-row a').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await tick(30);
    const sel = (label) => [...b.querySelectorAll('.tm-ticket label')].find((l) => new RegExp(label, 'i').test(l.textContent))?.querySelector('select');
    check('…the ambit choices are only the ones with room — a full ambit is a refusal, not an option',
      [...sel('Ambit').options].map((o) => o.value).join(' ') === 'space air water', [...sel('Ambit').options].map((o) => o.value).join(' '));
    check('…and the slot choices are the free ones of the chosen ambit, not 0..n',
      [...sel('Slot').options].map((o) => o.value).join(' ') === '1', [...sel('Slot').options].map((o) => o.value).join(' '));
    check('…the type list is the chain\'s, filtered to what can stand on a planet, with the charge it costs',
      [...sel('Type').options].map((o) => o.value).join(' ') === 'Planetary Defense Cannon Ore Extractor'
        && /charge/.test(sel('Type').textContent), [...sel('Type').options].map((o) => o.value).join(' '));
    /* Changing the ambit re-asks which slots are free — the numbers of one
     * ambit mean nothing in another. */
    sel('Ambit').value = 'water';
    sel('Ambit').dispatchEvent(new w.Event('change', { bubbles: true }));
    await tick(30);
    /* This also pins a bug in the SHARED ticket helper: it cleared `inputs`
     * before asking the field function for its shape, so a field that depends
     * on another read an empty form — every ambit offered the first ambit's
     * slots. Fuel and Allocations use function fields too. */
    check('…and changing the ambit re-offers that ambit\'s free slots', [...sel('Slot').options].map((o) => o.value).join(' ') === '2 3',
      [...sel('Slot').options].map((o) => o.value).join(' '));
    check('…because the rebuilt fields are seeded with what the form held', /paintFields\(keep\)/.test(read('frontend/board-terminal-ops.js')));
    T.remove(b.getAttribute('data-card'));
  }

  /* ── Finishing a virtual player ─────────────────────────────────────────
   *
   * A newly created virtual player is an empty guild membership: no planet,
   * no fleet, no command ship. `explore` gives it all three, and until it runs
   * every other verb refuses. The Armada card could CREATE one and had no way
   * to finish it.
   */
  {
    const T = w.Board.Terminal;
    T.execute('ARMADA');
    await until(() => d.querySelector('#tm-grid [data-type="armada"] .pc-row'));
    const arm = [...d.querySelectorAll('#tm-grid [data-type="armada"]')].slice(-1)[0];
    const fresh = [...arm.querySelectorAll('.pc-row')].find((r) => /FRESH-6/.test(r.textContent));
    check('a player that has never explored says so, rather than reading as a stale row',
      fresh !== undefined && /never explored/.test(fresh.textContent), fresh && fresh.textContent);
    check('…and carries the one door that finishes it', fresh.querySelector('.pc-act[title^="Explore"]') !== null);
    const started = [...arm.querySelectorAll('.pc-row')].find((r) => /MARKLIFER/.test(r.textContent));
    check('…which a player who already has a planet is not offered', started.querySelector('.pc-act[title^="Explore"]') === null);
    /* Its own command: `explore` is not a struct action, so `mcp_struct_act`
     * refuses it, and `mcp_players` is closed to list/create/state on purpose
     * — widening either would hand a window far more than this one verb. */
    const src = read('frontend/board-terminal-ops.js');
    check('…through a command that does exactly one thing', /invoke\('terminal_player_explore', \{ player: r\.player_id \}\)/.test(src));
    T.remove(arm.getAttribute('data-card'));
  }

  /* ── A guild's people ───────────────────────────────────────────────────
   *
   * The guild card answers "how big is it", which is a statistic, not a
   * community. Who is still playing, who has gone quiet, who can be reached —
   * and a member we have never seen act must say so rather than sorting as if
   * they were merely the quietest.
   */
  {
    const T = w.Board.Terminal;
    T.execute('MEMBERS 0-1');
    await until(() => d.querySelector('#tm-grid [data-type="members"] .pc-row'));
    const mem = [...d.querySelectorAll('#tm-grid [data-type="members"]')].slice(-1)[0];
    const rows = [...mem.querySelectorAll('.pc-row')];
    check('the roster leads with the people still playing', /JPEG/.test(rows[0].textContent) && /quiet/.test(rows[0].textContent), rows[0].textContent);
    check('…and a member we have never seen act says exactly that, rather than reading as the quietest',
      /never seen acting/.test(rows[2].textContent) && !/quiet/.test(rows[2].textContent), rows[2].textContent);
    check('…the tiles separate "acted today" from "never seen"', /acted/.test(mem.textContent) && /never seen/.test(mem.textContent));
    /* Our standing travels with the person, wherever we draw them. */
    check('…and a member our own team marked off-limits says so here too',
      /OFF-LIMITS/.test(rows[1].textContent), rows[1].textContent);
    /* But NOT "their guild is allied" on every row of that guild's own member
     * list — that is a property of the card's subject, not of the person, and
     * it drowns out the two standings that are about the individual. */
    check('…while a guild-wide standing is left off a list whose subject IS that guild',
      !/ALLY/.test(mem.textContent), mem.textContent.slice(0, 160));
    const ls = await T.standingLists();
    check('…though it still reads elsewhere, where the guild is not the subject',
      T.standingOf(ls, '1-999', '0-1').badge.text === 'ALLY'
        && T.standingOf(ls, '1-999', '0-1', { personOnly: true }) === null);
    check('…every row carries the doors that reach them', rows[0].querySelectorAll('.pc-act').length >= 2);
    T.remove(mem.getAttribute('data-card'));
  }

  /* ── OPS: the game's verbs, on the struct in front of you ───────────────
   *
   * `mcp_action` exposes fourteen verbs and exactly two had reached a card —
   * raid, from the target board, and refine, from the wallet. The Terminal
   * could see a rig sitting offline and offer no way to turn it on.
   *
   * The verbs offered depend on what the struct IS and what state it is in,
   * so the card shows what would actually go through rather than a menu of
   * refusals.
   */
  {
    const T = w.Board.Terminal;
    T.execute('OPS 5-4559');            // an Ore Extractor, built, OFFLINE
    await until(() => d.querySelector('#tm-grid [data-type="ops"] .tm-doors-row'));
    const ops = [...d.querySelectorAll('#tm-grid [data-type="ops"]')].slice(-1)[0];
    const labels = () => [...ops.querySelectorAll('.tm-doors-row a')].map((a) => a.textContent);
    check('an offline rig is offered the verb that starts it, not the one that stops it',
      labels().includes('Bring online') && !labels().includes('Take offline'), labels().join(' | '));
    check('…and a mine cycle is not offered while it is offline — the cycle begins when it comes online',
      !labels().includes('Start a mine cycle'), labels().join(' | '));
    check('…while the verbs that always apply to a built struct are there', labels().includes('Attack') && labels().includes('Defend another struct'));
    /* Every verb goes through the ticket, so nothing is signed by a single
     * click — the ticket is what carries the confirm. */
    const before = (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'mcp_action').length;
    ops.querySelectorAll('.tm-doors-row a')[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await tick(20);
    check('…choosing a verb opens a ticket rather than signing on the spot',
      ops.querySelector('.tm-ticket') !== null
        && (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'mcp_action').length === before);
    /* A verb that needs a target names the field it needs, so a half-command
     * cannot be sent. */
    ops.querySelectorAll('.tm-doors-row a').forEach((a) => { if (a.textContent === 'Attack') a.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); });
    await tick(20);
    check('…and a verb that needs a target asks for one', [...ops.querySelectorAll('.tm-ticket label')].some((l) => /Target/i.test(l.textContent)),
      [...ops.querySelectorAll('.tm-ticket label')].map((l) => l.textContent).join(' | '));
    /* Struct verbs go through `mcp_struct_act`, which takes the acting PLAYER
     * — a rig owned by a worker is switched on by that worker, not by the
     * primary — and carries verbs `mcp_action` does not expose at all.
     * `mine`/`refine` start a proof rather than acting on the struct, so they
     * keep the other path. */
    const opsSrc = read('frontend/board-terminal-ops.js');
    check('…struct verbs sign AS the struct\'s owner, through the map\'s own allowlist',
      /invoke\('mcp_struct_act', \{ player: ref\.owner \|\| 'primary'/.test(opsSrc));
    check('…and reach verbs mcp_action never exposed', /defense_clear/.test(opsSrc) && /build_cancel/.test(opsSrc));
    T.remove(ops.getAttribute('data-card'));

    T.execute('OPS 5-88');              // a Tank, built, ONLINE
    await until(() => [...d.querySelectorAll('#tm-grid [data-type="ops"]')].length > 0);
    const tank = [...d.querySelectorAll('#tm-grid [data-type="ops"]')].slice(-1)[0];
    const tl = [...tank.querySelectorAll('.tm-doors-row a')].map((a) => a.textContent);
    check('an online struct is offered the verb that stops it', tl.includes('Take offline') && !tl.includes('Bring online'), tl.join(' | '));
    check('…and a Tank is offered no mine or refine cycle, because it can do neither',
      !tl.some((x) => /cycle/.test(x)), tl.join(' | '));

    /* ── Reposition ────────────────────────────────────────────────────────
     *
     * `deploy` is `struct_move`, the verb behind the reach doctrine: you win
     * by standing where the enemy neither reaches nor occupies. A destination
     * is legal only if the HULL may enter that ambit and a slot there is open,
     * and neither is something a person knows — offered as free text it is a
     * guess the chain refuses with no explanation. So the form is built from a
     * read, and offers nothing that would be refused. */
    check('a built struct can be repositioned', tl.includes('Reposition'), tl.join(' | '));
    tank.querySelectorAll('.tm-doors-row a').forEach((a) => { if (a.textContent === 'Reposition') a.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); });
    await until(() => tank.querySelector('.tm-ticket select'));
    const ambitSel = tank.querySelector('.tm-ticket select');
    const opts = [...ambitSel.options].map((o) => o.value);
    check('…and the ambits it is offered are the ones its hull may ENTER — an air-blind Tank is never offered the sky',
      opts.includes('water') && opts.includes('land') && !opts.includes('air') && !opts.includes('space'), opts.join(','));
    check('…each saying how much room is there, and which one it stands in now',
      /land · 3\/4 open · here now/.test([...ambitSel.options].map((o) => o.textContent).join(' | ')),
      [...ambitSel.options].map((o) => o.textContent).join(' | '));
    const slotSel = tank.querySelectorAll('.tm-ticket select')[1];
    check('…and the slots offered are the FREE ones in that ambit, never the occupied one',
      [...slotSel.options].map((o) => o.value).join(',') === '1,2,3',
      [...slotSel.options].map((o) => o.value).join(','));
    /* Its own slot is not counted as taken on the way out, so "same slot,
     * different ambit" is a move — it vacates as it goes. */
    ambitSel.value = 'water'; ambitSel.dispatchEvent(new w.Event('change', { bubbles: true }));
    await tick(20);
    check('…moving ambit re-reads the slots for the ambit chosen, including the number it occupies today',
      [...tank.querySelectorAll('.tm-ticket select')[1].options].map((o) => o.value).join(',') === '0,1,2,3',
      [...tank.querySelectorAll('.tm-ticket select')[1].options].map((o) => o.value).join(','));
    const moves = (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'mcp_struct_act' && c.args && c.args.action === 'deploy').length;
    check('…and nothing is signed until the ticket is confirmed', moves === 0);
    T.remove(tank.getAttribute('data-card'));
  }

  /* ── Staging a fleet ──────────────────────────────────────────────────
   *
   * A raid needs the fleet AT the planet, so `move_fleet` is the verb between
   * reading a target and taking it — and it was primary-only, because
   * `action_move_fleet` reads the fleet id out of GAME_STATE. On this roster
   * the fleet you stage is usually a worker's.
   *
   * Where it stands is read from the FLEET's own location. The player row's
   * planet follows the fleet on arrival, so asking it would agree with the
   * destination the moment we got there and could never say "away".
   */
  {
    const T = w.Board.Terminal;
    T.execute('FLEET 1-194');
    await until(() => d.querySelector('#tm-grid [data-type="fleet"] .tm-doors-row'));
    const card = [...d.querySelectorAll('#tm-grid [data-type="fleet"]')].slice(-1)[0];
    check('a fleet card says where the fleet stands and where home is', /9-194/.test(card.textContent) && /2-15361/.test(card.textContent) && /2-223/.test(card.textContent), card.textContent);
    check('…and being away from home is called out, because it arms our own raid clock',
      /Away from home/.test(card.textContent) && card.querySelector('.tm-alert, .sc-attn, [class*="alert"]') !== null, card.textContent);
    const doors = [...card.querySelectorAll('.tm-doors-row a')].map((a) => a.textContent);
    check('…and a fleet that is away is offered the way back, which the home guard never blocks',
      doors.includes('Move') && doors.includes('Return home'), doors.join(' | '));
    const before = (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_fleet_move').length;
    card.querySelectorAll('.tm-doors-row a').forEach((a) => { if (a.textContent === 'Return home') a.dispatchEvent(new w.MouseEvent('click', { bubbles: true })); });
    await tick(20);
    check('…and even the retreat goes through a ticket rather than a single click',
      card.querySelector('.tm-ticket') !== null
        && (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_fleet_move').length === before);
    T.remove(card.getAttribute('data-card'));

    /* Signing as the PLAYER, not always the primary — the whole point. */
    const opsSrc = read('frontend/board-terminal-ops.js');
    check('…and the move is signed as the player whose fleet it is',
      /terminal_fleet_move', \{ player: d\.player \|\| 'primary'/.test(opsSrc));
    /* The guard is the policy engine's, applied server-side. The card must not
     * restate it — a second copy is a copy that drifts. */
    const rs = read('src-tauri/src/mcp/terminal.rs');
    check('…while the home guard stays in the policy engine, called not copied',
      /home_guard_block_reason\(\)/.test(rs) && !/max_stored_ore/.test(opsSrc));
  }

  /* ── Where we stand with someone ────────────────────────────────────────
   *
   * The team keeps four lists — grudges, allied guilds, priority guilds, and
   * players who are off-limits — and they were visible only on the WAR cards
   * that own them. The automation obeys them; a person about to act should
   * see what the automation sees.
   */
  {
    const T = w.Board.Terminal;
    const lists = await T.standingLists();
    check('off-limits outranks everything — it is the one that stops an action',
      T.standingOf(lists, '1-248', '0-1').badge.text === 'OFF-LIMITS');
    check('…a grudge names what it cost us, not just that we hold one',
      T.standingOf(lists, '1-1957', '0-5').badge.text === 'GRUDGE'
        && /3 attacks/.test(T.standingOf(lists, '1-1957', '0-5').note), T.standingOf(lists, '1-1957', '0-5').note);
    check('…an allied guild is read off the guild, not the player', T.standingOf(lists, '1-999', '0-1').badge.text === 'ALLY');
    check('…a priority guild is its own standing', T.standingOf(lists, '1-999', '0-5').badge.text === 'PRIORITY');
    check('…and somebody we have no view of draws nothing at all', T.standingOf(lists, '1-999', '0-9') === null);
    /* On the dossier it outranks the role they play for us: a card about
     * someone our own team marked never-attack should say so. */
    T.execute('PLAYER 1-248');
    await until(() => [...d.querySelectorAll('#tm-grid [data-type="player"]')].some((n) => /OFF-LIMITS/.test(n.textContent)));
    const dossier = [...d.querySelectorAll('#tm-grid [data-type="player"]')].slice(-1)[0];
    check('the player card leads with our standing, and says why',
      /OFF-LIMITS/.test(dossier.textContent) && /never-attack/.test(dossier.textContent), dossier.textContent.slice(0, 120));
    T.remove(dossier.getAttribute('data-card'));
  }

  /* ── SCOUT: the ambit they neither reach nor occupy ─────────────────────
   *
   * Every fleet weapon in the game does 2 damage, so hulls differ by REACH,
   * not firepower — and a counter fires when the defender's weapon reaches
   * your ambit OR the defender is standing in it. The card's job is to say
   * which ambit is neither, because nobody can union nine hulls' reach in
   * their head while a raid's four-minute window runs.
   */
  {
    w.Board.Terminal.execute('SCOUT 2-15361');
    await until(() => d.querySelector('#tm-grid [data-type="scout"] .tm-ambits'));
    const sc = d.querySelector('#tm-grid [data-type="scout"]');
    const rowOf = (label) => [...sc.querySelectorAll('.tm-ambits')].find((r) => r.firstChild.textContent === label);
    const on = (label) => [...rowOf(label).querySelectorAll('.tm-ambit.is-on')].map((n) => n.textContent).join(' ');
    check('scout leads with the FREE ambits — the answer, before the working', on('free') === 'air'
      && sc.querySelector('.tm-ambits').firstChild.textContent === 'free', on('free'));
    check('…and shows both ways an ambit is covered, separately',
      on('they reach') === 'land water' && on('they stand in') === 'space land', on('they reach') + ' | ' + on('they stand in'));
    /* Space is the case the whole correction exists for: nothing they own can
     * shoot into space, and space is still not free, because their Command
     * Ship is parked there and counters same-ambit for 2. */
    check('…so an ambit they cannot REACH but do OCCUPY is not offered as free',
      on('they reach').includes('space') === false && on('they stand in').includes('space') && !on('free').includes('space'));
    check('…names the command ship, whose loss strands the fleet', /Command Ship 5-9/.test(sc.textContent) && /space/.test(sc.textContent));
    check('…counts who would counter from each ambit', /counters from/.test(sc.textContent) && /air 0/.test(sc.textContent) && /land 2/.test(sc.textContent));
    const hull = sc.querySelector('.pc-row[data-kind="struct"]');
    /* Who holds it, and where we stand, BEFORE the hulls: "off-limits" is a
     * thing you find out before you look at their fleet, not after. */
    check('scout names the holder and our standing with them, above the fleet',
      /beezhan/.test(sc.textContent) && /GRUDGE/.test(sc.textContent)
        && /3 attacks/.test(sc.textContent)
        && sc.textContent.indexOf('GRUDGE') < sc.textContent.indexOf('reaches'), sc.textContent.slice(0, 140));
    check('…and every hull says what it can shoot at, since that is all that differs',
      /reaches land/.test(hull.textContent) && /COMMAND/.test(sc.textContent), hull.textContent);
    w.Board.Terminal.remove(sc.getAttribute('data-card'));
    /* And it is reachable from where the question arises: the board that
     * SCORES a target says nothing about which ambit you can shoot from, and
     * mid-raid the four minutes it takes to work out by hand are the window. */
    check('…and both the target board and a live raid carry a door to it',
      /Scout .* where can we shoot from\?/.test(read('frontend/board-terminal-ops.js'))
        && (read('frontend/board-terminal-ops.js').match(/add\('scout', \{ id:/g) || []).length === 2);
  }

  /* ── How much room a card may take ──────────────────────────────────────
   *
   * A CAP, not a floor: a card with less to say still takes only what it
   * needs, and `grow` lifts the cap. `tall` is what every card did before
   * this existed, so a saved layout that never chose changes nothing.
   */
  {
    const T = w.Board.Terminal;
    const card = d.getElementById('tm-pow-1');
    check('a card that never chose is `tall` — the height every card already had',
      T.heightOf('pow-1') === 'tall' && card.classList.contains('tm-h-tall')
        && !T.state.layout.cards.find((c) => c.id === 'pow-1').h);
    T.setHeight('pow-1', 'short');
    check('choosing one moves the class, and the class is what the CSS caps on',
      card.classList.contains('tm-h-short') && !card.classList.contains('tm-h-tall')
        && T.state.layout.cards.find((c) => c.id === 'pow-1').h === 'short');
    check('…and every choice has a rule, including the one that lifts the cap',
      ['short', 'medium', 'tall'].every((h) => new RegExp('\\.tm-h-' + h + ' \\.tm-body \\{[^}]*max-height:\\s*\\d+vh').test(read('frontend/board.html')))
        && /\.tm-h-grow \.tm-body \{[^}]*max-height:\s*none/.test(read('frontend/board.html')));
    check('…an embedded page has no content to measure, so the choice sizes the FRAME too',
      /\.tm-h-short \.tm-frame \{[^}]*height:\s*\d+vh/.test(read('frontend/board.html')));
    T.setHeight('pow-1', 'nonsense');
    check('an unknown height falls back to the default rather than sticking',
      T.heightOf('pow-1') === 'tall' && card.classList.contains('tm-h-tall'));
    // Width and height are separate axes and must not overwrite each other.
    T.setHeight('pow-1', 'grow');
    T.resizeTo('pow-1', 2);
    check('resizing keeps the height, and vice versa',
      card.classList.contains('tm-w2') && card.classList.contains('tm-h-grow'));
    T.setHeight('pow-1', '');
    T.resizeTo('pow-1', 1);
  }

  /* ── The chain's own clock ──────────────────────────────────────────────
   *
   * Card ages say when WE last read. That is only half the question: a card
   * can honestly read "now" over a feed that has not heard from the chain in
   * ten minutes. Structs is block-paced, so whether the height is still moving
   * is the reading that says whether ANY of this is real — and the honest
   * default before a block arrives is the alarming one, not a blank.
   */
  {
    const clock = d.getElementById('tm-clock');
    check('the header carries the chain clock, alarming until a block actually arrives',
      clock !== null && /no block/i.test(clock.textContent) && clock.className.includes('tm-clock-quiet'), clock && clock.textContent);
    w.__HARNESS_EMIT__('grass-event', { category: 'block', subject: 'consensus', timestamp: Date.now(), detail: { height: 2520256, updated_at: 'now' } });
    await tick(30);
    check('…and a block frame sets it, from the chain\'s own heartbeat rather than a poll of ours',
      clock.textContent === '2,520,256' && !clock.className.includes('tm-clock-quiet') && /Block 2,520,256/.test(clock.title), clock.textContent);
    // Silence is the signal: nothing for long enough and the clock says so.
    w.Board.Terminal.clockState.atMs = Date.now() - 120000;
    w.Board.Terminal.paintClock();
    check('…and silence turns it, naming what that means for everything below',
      clock.className.includes('tm-clock-quiet') && /nothing since/i.test(clock.title) && /kept up to date/.test(clock.title), clock.title);
    w.Board.Terminal.clockState.atMs = Date.now();
    w.Board.Terminal.paintClock();
  }

  /* ── How old is what you are looking at? ────────────────────────────────
   *
   * A number with no age is a number you cannot act on: a card that lost its
   * connection five minutes ago looked exactly like one that updated a second
   * ago. And a failed refresh used to ERASE the card — throwing away the only
   * data the operator had. A stale reading you can see and date beats a blank
   * you cannot.
   */
  {
    const card = d.getElementById('tm-market-1');
    check('every card says how old its content is', card.querySelector('.tm-age') !== null && /now|s$/.test(card.querySelector('.tm-age').textContent), card.querySelector('.tm-age')?.textContent);
    const body = card.querySelector('.tm-body').textContent;
    w.__HARNESS_REJECT__['terminal_market'] = 'guild API unreachable';
    await w.Board.Terminal.refresh('market-1', true);
    await tick(50);
    check('a failed refresh KEEPS the last good answer and marks the card stale',
      card.querySelector('.tm-body').textContent === body && card.classList.contains('tm-stale'));
    check('…dating the GOOD data, with what went wrong on hover',
      /unreachable/.test(card.querySelector('.tm-age').title) && /Last good read/.test(card.querySelector('.tm-age').title),
      card.querySelector('.tm-age').title);
    check('…and the stale mark dims the content rather than hiding it',
      /\.tm-card\.tm-stale \.tm-body \{[^}]*opacity/.test(read('frontend/board.html')));
    delete w.__HARNESS_REJECT__['terminal_market'];
    await w.Board.Terminal.refresh('market-1', true);
    await tick(50);
    check('…and a good read clears it', !card.classList.contains('tm-stale') && !/failed/.test(card.querySelector('.tm-age').title));
    /* A card that has never rendered has nothing to keep — there the error IS
     * the content, which is the behaviour that already existed. */
    w.__HARNESS_REJECT__['mcp_work'] = 'no engine';
    w.Board.Terminal.add('solve', {});
    const solveId = w.Board.Terminal.state.layout.cards.slice(-1)[0].id;
    await until(() => d.querySelector('#tm-' + solveId + ' .sui-message-inline-alert, #tm-' + solveId + ' .ops-muted'));
    check('a card that never rendered shows the error itself — there is nothing to preserve',
      /no engine/.test(d.querySelector('#tm-' + solveId).textContent), d.querySelector('#tm-' + solveId).textContent.slice(0, 80));
    delete w.__HARNESS_REJECT__['mcp_work'];
    w.Board.Terminal.remove(solveId);
  }

  // Doors.
  const set = () => (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_layout_set');
  // No move doors: the header drags (tested below); the keyboard API remains.
  check('a card has no refresh or move doors', d.querySelectorAll('#tm-grid [title="Refresh"], #tm-grid [title="Move up"], #tm-grid [title="Move down"]').length === 0);
  w.Board.Terminal.move('people-1', 1);
  check('move down reorders', d.querySelectorAll('#tm-grid .tm-card')[1].getAttribute('data-card') === 'people-1');
  d.querySelector('#tm-stats-1 [title="Remove"]').click();
  check('remove takes the card off the page', d.getElementById('tm-stats-1') === null && w.Board.Terminal.state.layout.cards.length === 5);
  d.querySelector('#tm-market-1 [title="Pop out"]').click();
  await tick(20);
  check('pop out asks Rust for a window on that card, in this workspace, named as the card is', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'open_terminal_card' && c.args && c.args.cardId === 'market-1' && c.args.workspace === 'main' && c.args.title === 'Energy market'));

  // Configure: change the player, widen the card.
  d.querySelector('#tm-player-1 [title="Configure"]').click();
  const cfg = d.querySelector('#tm-player-1 .tm-config');
  check('configure opens the params strip', cfg && !cfg.hidden && cfg.querySelector('input'));
  cfg.querySelector('input').value = '1-248';
  cfg.querySelector('.tm-config-width').value = '2';
  cfg.querySelector('a.sui-mod-primary').click();
  await until(() => /PHONIFFER/.test(d.querySelector('#tm-player-1')?.textContent || ''));
  check('…and the card re-renders on the new player', /PHONIFFER/.test(d.querySelector('#tm-player-1').textContent) && d.getElementById('tm-player-1').classList.contains('tm-w2'));
  check('the title follows the params', d.querySelector('#tm-player-1 .tm-title').textContent === 'Player 1-248');

  // Every card configures — its name, its refresh cadence, its width and how
  // much room it may take —
  // not only the ones with params. A player's name for a card outlives the
  // type's own title; a paused card refreshes by hand only.
  check('a card with no params still has a Configure door', d.querySelector('#tm-pow-1 [title="Configure"]') !== null);
  d.querySelector('#tm-pow-1 [title="Configure"]').click();
  const cfg2 = d.querySelector('#tm-pow-1 .tm-config');
  check('…opening name, refresh, width and height', cfg2.querySelector('.tm-config-name') !== null && cfg2.querySelector('.tm-config-cadence') !== null && cfg2.querySelector('.tm-config-width') !== null && cfg2.querySelector('.tm-config-height') !== null);
  cfg2.querySelector('.tm-config-name').value = 'GPU corner';
  cfg2.querySelector('.tm-config-cadence').value = '0';
  cfg2.querySelector('a.sui-mod-primary').click();
  await tick();
  check('the player\'s name is the title', d.querySelector('#tm-pow-1 .tm-title').textContent === 'GPU corner');
  check('Apply closes the strip, and the stylesheet honours that (display:flex used to beat [hidden])', cfg2.hidden === true && /\.tm-config\[hidden\]\s*\{\s*display:\s*none/.test(read('frontend/board.html')));
  // The harness answers terminal_layout_get with its fixture, so persistence
  // is checked on what the page SENDS: the card carries both fields.
  await w.Board.Terminal.flushSave();
  const savedPow = (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_layout_set').pop().args.layout.cards.find((c) => c.id === 'pow-1');
  check('…and both are saved on the card', savedPow && savedPow.title === 'GPU corner' && savedPow.cadence === 0, JSON.stringify(savedPow));
  check('paused: the frame says so and the tick will not refresh it', d.getElementById('tm-pow-1').classList.contains('tm-paused') && w.Board.Terminal.cadenceOf('pow-1') === 0 && d.querySelector('#tm-pow-1 .tm-title').title === 'Paused');
  check('…both persisted on the card in the layout', (() => { const c = w.Board.Terminal.state.layout.cards.find((x) => x.id === 'pow-1'); return c.title === 'GPU corner' && c.cadence === 0; })());
  check('auto restores the type\'s own cadence and title', (w.Board.Terminal.setCadence('pow-1', ''), w.Board.Terminal.setTitle('pow-1', ''), w.Board.Terminal.cadenceOf('pow-1') > 0 && d.querySelector('#tm-pow-1 .tm-title').textContent === 'Proof queue' && !d.getElementById('tm-pow-1').classList.contains('tm-paused')));

  /* Add from the PALETTE, which replaced the picker. A card that needs an id
   * cannot be added without one — the row fills the line instead of running
   * something incomplete, which is the picker's old refusal in the shape the
   * palette can express. */
  const cmdBox = d.getElementById('tm-cmd');
  /* Clicking off it is the way out you reach for when the pointer is already
   * in your hand. The scrim ITSELF only: a press that lands on the panel is
   * not a press on the board behind it. */
  {
    const pal = d.getElementById('tm-palette');
    w.Board.Terminal.openPalette();
    pal.querySelector('.tm-palette-box').dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    check('a press inside the palette does not dismiss it', !pal.hidden);
    pal.dispatchEvent(new w.MouseEvent('mousedown', { bubbles: true }));
    check('…a press on the scrim around it does', pal.hidden);
  }
  w.Board.Terminal.openPalette();
  cmdBox.value = 'GUILD';
  cmdBox.dispatchEvent(new w.Event('input', { bubbles: true }));
  const before5 = d.querySelectorAll('#tm-grid .tm-card').length;
  cmdBox.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  check('a type that needs an id is not added without one — the line is filled instead',
    d.querySelectorAll('#tm-grid .tm-card').length === before5 && cmdBox.value === 'GUILD ', JSON.stringify(cmdBox.value));
  cmdBox.value = 'GUILD 0-1';
  cmdBox.dispatchEvent(new w.Event('input', { bubbles: true }));
  cmdBox.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  check('adding places the card last with a fresh id', d.querySelectorAll('#tm-grid .tm-card').length === before5 + 1 && [...d.querySelectorAll('#tm-grid .tm-card')].slice(-1)[0].getAttribute('data-card') === 'guild-1');
  check('…and running something puts the palette away', d.getElementById('tm-palette').hidden);
  await tick(400);
  const saved = set();
  check('every change is saved through Rust, debounced', saved.length >= 1 && saved[saved.length - 1].args.layout.cards.some((c) => c.id === 'guild-1'));
  check('the saved layout carries a bumped version', saved[saved.length - 1].args.layout.version > 3 && saved[saved.length - 1].args.workspace === 'main');

  // The command line.
  const cmd = d.getElementById('tm-cmd');
  const run = (line) => { cmd.value = line; cmd.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); };
  run('MKT');
  check('MKT opens a market card', d.querySelectorAll('#tm-grid [data-type="market"]').length === 2 && cmd.value === '');
  // HELP: every word, as a card. A row with no argument opens its card; one
  // that needs an argument lands in the command box.
  run('HELP');
  await until(() => d.querySelector('#tm-grid [data-type="help"] .tm-help-row'));
  const help = d.querySelector('#tm-grid [data-type="help"]');
  const helpWords = [...help.querySelectorAll('.tm-help-row b')].map((b) => b.textContent);
  check('HELP opens the command reference, one row per target, every word present', help !== null && Object.keys(w.Board.Terminal.WORDS).every((word) => helpWords.some((t) => t.split(' · ').includes(word))), helpWords.join(' | '));
  check('…naming what each opens and the argument it takes', [...help.querySelectorAll('.tm-help-row')].some((r) => /GT/.test(r.textContent) && /<id>/.test(r.textContent) && /Guild token/i.test(r.textContent)), [...help.querySelectorAll('.tm-help-row')].map((r) => r.textContent).join(' | ').slice(0, 300));
  const cardsBeforeHelp = d.querySelectorAll('#tm-grid .tm-card').length;
  [...help.querySelectorAll('.tm-help-row')].find((r) => /^PEOPLE/.test(r.textContent)).click();
  check('a word with no argument opens its card on click', d.querySelectorAll('#tm-grid [data-type="people"]').length === 2 && d.querySelectorAll('#tm-grid .tm-card').length === cardsBeforeHelp + 1);
  [...help.querySelectorAll('.tm-help-row')].find((r) => /^GT/.test(r.textContent)).click();
  check('a word that needs an id lands in the command box, ready for it', cmd.value === 'GT ' && d.activeElement === cmd, cmd.value);
  cmd.value = '';
  run('?');
  check('? is HELP, and there is only ever one', d.querySelectorAll('#tm-grid [data-type="help"]').length === 1);
  run('NONSENSE');
  check('an unknown word is refused visibly and left to correct', cmd.classList.contains('is-err') && cmd.value === 'NONSENSE');
  cmd.value = '';
  w.Board.Terminal.remove(help.getAttribute('data-card'));
  w.Board.Terminal.remove(d.querySelectorAll('#tm-grid [data-type="people"]')[1].getAttribute('data-card'));
  run('1-248');
  /* ── The grammar ────────────────────────────────────────────────────────
   *
   * A terminal is only as fast as the distance between a thought and the
   * screen. Two orders, because people think in two orders — and the second,
   * subject first, is the one an expert falls into: you are looking at
   * 2-29604 and you want the map, then the log, then its ore history.
   */
  {
    const T = w.Board.Terminal;
    const plan = (l) => T.parse(l);
    check('subject first: `2-29604 LOG` is the same command as `LOG 2-29604`',
      JSON.stringify(plan('2-29604 LOG')) === JSON.stringify(plan('LOG 2-29604'))
        && plan('2-29604 LOG').type === 'log' && plan('2-29604 LOG').params.id === '2-29604');
    check('…and the subject-first form works for every word that takes an id',
      plan('1-61 WALLET').type === 'wallet' && plan('1-61 WALLET').params.id === '1-61'
        && plan('0-1 GT').type === 'gt' && plan('2-29604 HIST').type === 'series');
    check('a bare id still opens the card that IS that object',
      plan('2-29604').type === 'planet' && plan('1-61').type === 'player'
        && plan('0-1').type === 'guild' && plan('9-61').type === 'map' && plan('5-1').type === 'inspector');
    /* `parse` exists so the command line can know what Enter will do without
     * doing it — otherwise the menu has to guess, and what it promises drifts
     * from what happens. */
    check('parsing is pure: asking what a line would do opens nothing',
      (() => { const before = w.Board.Terminal.state.layout.cards.length;
               ['MKT', '2-29604 LOG', 'nonsense', ''].forEach(plan);
               return w.Board.Terminal.state.layout.cards.length === before; })());
    check('…and `canRun` agrees with it, so Enter and the menu cannot disagree',
      T.canRun('MKT') && T.canRun('2-29604 HIST') && !T.canRun('PLAYER') && !T.canRun('nope') && !T.canRun(''));

    /* The completion menu never invents: a function is offered for a subject
     * only when the CARD's own `kinds` accepts it. */
    const words = (l) => T.suggestFor(l).map((s) => s.words);
    check('typing an id offers every question you can ask OF it, named by the card it opens',
      words('2-29604 ').join(' ') === 'COMMS MAP PLANET INSPECT WATCH LOG HIST SCOUT BUILD'
        && T.suggestFor('2-29604 ')[0].what === 'Comms about an object', words('2-29604 ').join(' '));
    check('…a player is asked different questions than a planet',
      words('1-61 ').includes('WALLET') && words('1-61 ').includes('BOOK')
        && !words('1-61 ').includes('LOG') && !words('2-29604 ').includes('WALLET'));
    check('…and a partial word narrows them', words('2-29604 L').join(' ') === 'LOG');
    check('a word being typed offers the words that start that way, one row per card',
      words('MA').join(' ') === 'MAP MARGINS MARKET');
    check('…and aliases for one card share a row rather than repeating it',
      (() => { const r = T.suggestFor('MK')[0]; return r && /MKT/.test(r.words) && T.suggestFor('MK').length === 1; })());
    check('every id param declares the object kinds it accepts, or the menu would be guessing',
      T.types().every((t) => (t.params || []).every((p) => p.kind !== 'id' || 'kinds' in p)),
      T.types().filter((t) => (t.params || []).some((p) => p.kind === 'id' && !('kinds' in p))).map((t) => t.type).join(','));

    /* The menu in the DOM: keyboard-first, and the row Enter takes is the one
     * that is highlighted. */
    const cmd = d.getElementById('tm-cmd');
    const menu = d.querySelector('.tm-suggest');
    /* The matches are CONTENT of the palette, inside the same frame under the
     * line, not a dropdown hanging off its edge — which is the whole reason
     * the box is a panel and not a bar. */
    check('the matches sit inside the palette\'s own frame, under the line you are typing',
      menu !== null && menu.closest('.tm-palette-results') !== null
      && menu.closest('.tm-palette-box') === cmd.closest('.tm-palette-box'));
    /* Flowing inside the frame means the frame has to go when there is nothing
     * in it: an empty `sui-screen` is still a screen, and it read as a stray
     * bar under the line. */
    const results = menu.closest('.tm-palette-results');
    cmd.value = 'zzzznotacommand';
    cmd.dispatchEvent(new w.Event('input', { bubbles: true }));
    check('…and with no matches the frame under the line goes with them', menu.hidden && results.hidden);
    cmd.value = '';
    cmd.dispatchEvent(new w.Event('input', { bubbles: true }));
    check('…while an empty line is the card menu, so the palette is a superset of the picker it replaced',
      !menu.hidden && !results.hidden && menu.querySelectorAll('.tm-suggest-row').length > 5,
      String(menu.querySelectorAll('.tm-suggest-row').length));
    cmd.dispatchEvent(new w.Event('focus'));
    cmd.value = '1-61 ';
    cmd.dispatchEvent(new w.Event('input', { bubbles: true }));
    check('…which fills as you type, first row highlighted', !menu.hidden && menu.children.length === T.functionsFor('1-61').length && menu.children[0].classList.contains('is-on'), String(menu.children.length));
    const down = () => cmd.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
    down(); down();
    check('…arrows walk it', menu.children[2].classList.contains('is-on') && !menu.children[0].classList.contains('is-on'));
    const before = w.Board.Terminal.state.layout.cards.length;
    cmd.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const added = w.Board.Terminal.state.layout.cards.slice(-1)[0];
    check('…and Enter opens the highlighted row, for that subject', w.Board.Terminal.state.layout.cards.length === before + 1 && added.type === 'inspector' && added.params.id === '1-61' && cmd.value === '' && menu.hidden, added.type + ' ' + added.params.id);
    w.Board.Terminal.remove(added.id);
    /* A line that already runs runs AS TYPED: MKT opens the market even
     * though MARGINS and MARKET are both listed under it. */
    cmd.value = 'MKT';
    cmd.dispatchEvent(new w.Event('input', { bubbles: true }));
    const before2 = w.Board.Terminal.state.layout.cards.length;
    cmd.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    const added2 = w.Board.Terminal.state.layout.cards.slice(-1)[0];
    check('a complete command runs as typed, never as the highlighted completion', w.Board.Terminal.state.layout.cards.length === before2 + 1 && added2.type === 'market', added2.type);
    // History: Up walks back through what was run.
    cmd.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    check('Up recalls the last command an expert ran', cmd.value === 'MKT', cmd.value);
    cmd.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true, cancelable: true }));
    check('…and the one before it', cmd.value === '1-61 INSPECT', cmd.value);
    cmd.value = '';
    w.Board.Terminal.remove(added2.id);
  }
  check('a bare player id opens that player', d.querySelector('#tm-grid [data-card="player-2"]')?.getAttribute('data-type') === 'player' && w.Board.Terminal.state.layout.cards.find((c) => c.id === 'player-2').params.id === '1-248');
  run('GUILD 0-2');
  check('GUILD opens a guild', w.Board.Terminal.state.layout.cards.some((c) => c.type === 'guild' && c.params.id === '0-2'));
  run('2-15361');
  check('a planet id opens the planet view', w.Board.Terminal.state.layout.cards.find((c) => c.type === 'planet')?.params.id === '2-15361');
  await until(() => d.querySelector('#tm-grid [data-type="planet"] iframe.tm-frame-map'));
  {
    // The planet card is the live map: no hand-drawn slot grid any more.
    const pc = d.querySelector('#tm-grid [data-type="planet"]');
    check('…as the live map, not a hand-drawn slot grid', pc.querySelector('iframe.tm-frame-map') !== null && pc.querySelectorAll('.tm-planet-row, .tm-planet-slot').length === 0);
    check('…and the map is asked for THIS planet', /planet=2-15361/.test(pc.querySelector('iframe.tm-frame-map').getAttribute('src')));
  }
  run('9-61');
  check('a fleet id opens the map', w.Board.Terminal.state.layout.cards.find((c) => c.type === 'map' && c.params.id === '9-61'));
  // FLEET is the game's word for a 9-… object; the roster is the ARMADA.
  run('FLEET 9-12');
  check('FLEET with an id opens that fleet on the map, not the roster', w.Board.Terminal.state.layout.cards.some((c) => c.type === 'map' && c.params.id === '9-12'));
  check('…and a layout saved when the roster was called `fleet` still opens', w.Board.Terminal.migrate({ cards: [{ id: 'fleet-9', type: 'fleet', params: {}, w: 2 }] }).cards[0].type === 'armada');
  run('5-4559');
  check('any other id opens the inspector, which asks Comms\' reference cards', w.Board.Terminal.state.layout.cards.find((c) => c.type === 'inspector')?.params.id === '5-4559');
  await tick(80);
  await until(() => /Ore Extractor/.test(d.querySelector('#tm-grid [data-type="inspector"]')?.textContent || ''));
  check('…drawing Comms\' reference record for it, from the shared cache when it is already known',
    /Ore Extractor/.test(d.querySelector('#tm-grid [data-type="inspector"]').textContent)
      && (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'matrix_refs'));
  run('STATS ORE');
  check('STATS opens a section', w.Board.Terminal.state.layout.cards.find((c) => c.type === 'stats' && c.params.section === 'ore') !== undefined);
  run('HALT');
  await until(() => d.querySelector('#tm-grid [data-type="halt"] .pc-row'));
  const haltRows = [...d.querySelectorAll('#tm-grid [data-type="halt"] .pc-row')];
  check('HALT lists the roster by margin, worst first', haltRows.length === 2 && /Marklifer/.test(haltRows[0].textContent) && /thin margin/.test(haltRows[0].textContent) && /1 under 20% margin/.test(d.querySelector('#tm-grid [data-type="halt"]').textContent));
  run('ORE');
  await until(() => d.querySelector('#tm-grid [data-type="ore"] .pc-row'));
  // The ore radar, not the leaderboard: rows are PLANETS, so each one names
  // where the ore actually sits — which is what a raider needs.
  {
    const ore = d.querySelector('#tm-grid [data-type="ore"]');
    const first = ore.querySelector('.pc-row');
    check('ORE lists the planets holding ore, richest first, from the radar', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'terminal_ore_radar') && first.getAttribute('data-kind') === 'planet' && /#1/.test(first.textContent), first.textContent.slice(0, 80));
    check('…saying how many planets hold ore across the galaxy', /holding ore/.test(ore.textContent) && /in the galaxy/.test(ore.textContent), ore.querySelector('.tm-cap').textContent);
    check('…and each row opens the planet, its owner, or the target board', first.querySelector('.pc-act[title^="Watch"]') !== null && first.querySelector('.pc-act[title="Target board"]') !== null);
  }
  run('BOOK 1-194');
  await until(() => d.querySelector('#tm-grid [data-type="book"] .pc-row'));
  const book = d.querySelector('#tm-grid [data-type="book"]');
  check('BOOK shows what was bought and sold and when the first runs out', /1-170/.test(book.textContent) && /1-482/.test(book.textContent) && /BOUGHT/.test(book.textContent) && /SOLD/.test(book.textContent) && /First expiry/i.test(book.textContent) && (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'terminal_agreements' && c.args.player === '1-194'), book.textContent.slice(0, 200));
  check('…each agreement is a catalogue row with a countdown over its term', book.querySelectorAll('.pc-row[data-kind="agreement"] .sc-count').length === book.querySelectorAll('.pc-row').length && book.querySelectorAll('.pc-row').length > 0);
  /* `market.best_rate` is now the COMPARABLE price — alpha per kW per day,
   * across every denomination — so the threshold is in that unit. It used to
   * read the raw rate of alpha-priced offers only, which means an alarm on
   * "the market got cheap" could not see a cheap offer quoted in a guild's own
   * token. */
  run('ALERTS market.best_rate < 20000; halt.min_margin > 50; nonsense');
  await until(() => d.querySelectorAll('#tm-grid [data-type="alerts"] .tm-alert').length === 3);
  const alerts = [...d.querySelectorAll('#tm-grid [data-type="alerts"] .tm-alert')].map((r) => r.className.replace(/.*tm-alert-/, ''));
  check('ALERTS judges each rule against a live reading: fired, quiet, and a bad rule named as such', alerts.join(',') === 'fired,quiet,bad', alerts.join(','));
  check('a rule parses to metric, op and value', JSON.stringify(w.Board.Terminal.parseRules('raids.live >= 1')[0]) === JSON.stringify({ metric: 'raids.live', op: '>=', value: 1, text: 'raids.live >= 1' }));

  /* ── Watching one THING ─────────────────────────────────────────────────
   *
   * The galaxy readings are not an expert's alarms. "That planet's shield is
   * down", "that worker is out of charge" — a subject reading takes a chain id
   * the same way the command line does, and refuses an id of the wrong kind
   * rather than sitting quiet forever, which is the failure that makes people
   * stop trusting alarms.
   */
  {
    const T = w.Board.Terminal;
    check('a subject rule parses, dashes and all', JSON.stringify(T.parseRules('shield.2-15361 = 0')[0]) === JSON.stringify({ metric: 'shield.2-15361', op: '=', value: 0, text: 'shield.2-15361 = 0' }));
    check('…and resolves to a reading of that one object', typeof T.readingFor('shield.2-15361') === 'function' && typeof T.readingFor('charge.1-271') === 'function');
    check('…while an id of the WRONG KIND is refused, not read as nothing',
      T.readingFor('shield.1-271') === null && T.readingFor('charge.2-15361') === null && T.readingFor('shield.nope') === null && T.readingFor('bogus.2-15361') === null);
    const shield = await T.readingFor('shield.2-15361')();
    const charge = await T.readingFor('charge.1-271')();
    check('…reading the real number off a source the board already polls', shield === 0 && charge === 5, shield + ' / ' + charge);
    run('ALERTS shield.2-15361 = 0; charge.1-271 > 9');
    await until(() => d.querySelectorAll('#tm-grid [data-type="alerts"]:last-of-type .tm-alert').length === 2);
    const subj = [...d.querySelectorAll('#tm-grid [data-type="alerts"]')].slice(-1)[0];
    check('…and an alert on one object fires on that object', [...subj.querySelectorAll('.tm-alert')].map((r) => r.className.replace(/.*tm-alert-/, '')).join(',') === 'fired,quiet',
      [...subj.querySelectorAll('.tm-alert')].map((r) => r.className.replace(/.*tm-alert-/, '')).join(','));
    T.remove(subj.getAttribute('data-card'));
  }
  run('BANKS');
  await until(() => d.querySelector('#tm-grid [data-type="banks"] .pc-row, #tm-grid [data-type="banks"] .gc-row'));
  const banks = d.querySelector('#tm-grid [data-type="banks"]');
  check('BANKS screens every guild token by ratio, richest first', /2 guild tokens/.test(banks.textContent) && /4700\.000/.test(banks.textContent) && banks.textContent.indexOf('SN Corp') < banks.textContent.indexOf('Orbital Hydro'));
  run('GT 0-1');
  const gtId = w.Board.Terminal.state.layout.cards.find((c) => c.type === 'gt' && c.params.id === '0-1').id;
  await until(() => d.querySelectorAll('#tm-' + gtId + ' svg').length === 2);
  const gt = d.getElementById('tm-' + gtId);
  check('GT draws the ratio as this app sampled it, and the ledger\'s supply', gt.querySelectorAll('svg').length === 2 && /30 samples/.test(gt.textContent) && /supply — 30 days/.test(gt.textContent));
  run('MINT');
  await until(() => d.querySelector('#tm-grid [data-type="bank"] input'));
  const bank = d.querySelector('#tm-grid [data-type="bank"]');
  const inputs = bank.querySelectorAll('input');
  inputs[0].value = '1000000'; inputs[1].value = '1000';
  bank.querySelector('a.sui-mod-primary').click();
  await tick(50);
  const confirmBtn = [...d.querySelectorAll('.ops-modal-overlay a, .ops-modal-overlay button')].find((b) => /^sign$/i.test(b.textContent.trim()));
  check('the ticket confirms before it signs, repeating the figures', !!confirmBtn && /Mint 1,000 tokens for 1,000,000 ualpha/.test(d.querySelector('.ops-modal-overlay').textContent));
  if (confirmBtn) confirmBtn.click();
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'terminal_guild_bank_mint'));
  const mintCall = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'terminal_guild_bank_mint');
  check('MINT signs through the app\'s own ledger with the figures typed', !!mintCall && mintCall.args.amountAlpha === 1000000 && mintCall.args.amountToken === 1000);
  run('TS 1-61');
  await until(() => d.querySelector('#tm-grid [data-type="sheet"] .pc-card'));
  const sheet = d.querySelector('#tm-grid [data-type="sheet"]');
  check('TS is the tearsheet: the card with ranks, standing, and the guild API\'s sections as they arrive', /JPEG/.test(sheet.textContent) && /#1/.test(sheet.textContent) && /Raids launched/.test(sheet.textContent) && /launched/.test(sheet.textContent) && /unavailable: Login required/.test(sheet.textContent));
  // Moving by hand: a drop lands before or after the target; a grid drop goes last.
  const order = () => [...d.querySelectorAll('#tm-grid .tm-card')].map((c) => c.getAttribute('data-card')).join(',');
  const first = d.querySelector('#tm-grid .tm-card').getAttribute('data-card');
  const last = [...d.querySelectorAll('#tm-grid .tm-card')].pop().getAttribute('data-card');
  w.Board.Terminal.dropOn(first, last, true);
  check('dragging a card onto another lands it after that card', order().split(',').pop() === first, order());
  w.Board.Terminal.dropOn(first, null, true);
  check('…and a drop on the grid keeps it last', order().split(',').pop() === first);
  // The drag itself, driven by pointer events: press on a header, move past
  // the 4px arm, release over the right half of another card.
  {
    const ids = order().split(',');
    const src = d.querySelector('#tm-' + ids[1]), dst = d.querySelector('#tm-' + ids[3]);
    d.elementFromPoint = (x) => (x >= 500 ? dst.querySelector('.tm-body') : null);
    dst.getBoundingClientRect = () => ({ left: 400, width: 300, top: 0, height: 100, right: 700, bottom: 100 });
    const ev = (type, x, y, el) => (el || w).dispatchEvent(new w.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    ev('pointerdown', 10, 10, src.querySelector('.tm-head'));
    ev('pointermove', 12, 10);
    check('a press that barely moves is not a drag', !w.Board.Terminal.state.drag);
    ev('pointermove', 650, 50);
    // A silhouette of the card's exact size stands where it would land, the
    // card itself leaves the flow, and nothing can be text-selected meanwhile.
    const ghost = d.querySelector('#tm-grid .tm-ghost');
    check('past the arm a silhouette shows where it would land, sized like the card', w.Board.Terminal.state.drag === ids[1] && ghost !== null && ghost.classList.contains('tm-w' + (w.Board.Terminal.state.layout.cards.find((c) => c.id === ids[1]).w || 1)));
    check('…the card leaves the flow so the others move aside', src.hidden === true && src.classList.contains('tm-dragging'));
    check('…and the drag cannot also select text', d.body.classList.contains('tm-dragging-cards') && /body\.tm-dragging-cards \*/.test(read('frontend/board.html')));
    check('…the silhouette sits after the card the pointer is over', ghost.previousElementSibling === dst);
    ev('pointerup', 650, 50);
    check('release lands it after that card, and saves', order().split(',').indexOf(ids[1]) === order().split(',').indexOf(ids[3]) + 1 && !w.Board.Terminal.state.drag && !d.querySelector('.tm-ghost, .tm-dragging'));
    check('…and the card is back in the flow, selection allowed again', src.hidden === false && !d.body.classList.contains('tm-dragging-cards'));
    delete d.elementFromPoint;
  }
  /* ── Reaching the part of the board you cannot see ────────────────────────
   *
   * The drag above never leaves one screen. A board four screens tall could
   * not be rearranged past the first: you picked a card up, ran out of pixels,
   * and had nowhere left to drag to. jsdom lays nothing out and never paints,
   * so the scroller is stubbed and the frames are stepped by hand — which also
   * makes the speed curve assertable rather than a thing you feel.
   */
  {
    const ids = order().split(',');
    const src = d.querySelector('#tm-' + ids[1]);
    const head = src.querySelector('.tm-head');
    const sc = d.querySelector('.ops-scroll');
    sc.style.overflowY = 'auto';
    Object.defineProperty(sc, 'scrollHeight', { value: 4000, configurable: true });
    Object.defineProperty(sc, 'clientHeight', { value: 500, configurable: true });
    sc.getBoundingClientRect = () => ({ left: 0, top: 100, right: 800, bottom: 600, width: 800, height: 500 });
    sc.scrollTop = 2000;
    d.elementFromPoint = () => null;
    const frames = [];
    const realRaf = w.requestAnimationFrame;
    w.requestAnimationFrame = (fn) => frames.push(fn);
    w.cancelAnimationFrame = () => { frames.length = 0; };
    const step = (n) => { for (let i = 0; i < n; i++) frames.splice(0).forEach((f) => f()); };
    const ev = (type, x, y, el) => (el || w).dispatchEvent(new w.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));

    ev('pointerdown', 300, 300, head);
    ev('pointermove', 340, 340);
    check('the card you are carrying says its name under the cursor — once the board scrolls it is the only thing that does',
      d.querySelector('.tm-drag-chip') !== null
      && d.querySelector('.tm-drag-chip').textContent === w.Board.Terminal.titleOf(w.Board.Terminal.state.layout.cards.find((c) => c.id === ids[1])),
      d.querySelector('.tm-drag-chip') && d.querySelector('.tm-drag-chip').textContent);

    ev('pointermove', 300, 110);   // 10px inside the top band
    const top0 = sc.scrollTop;
    step(4);
    const up = top0 - sc.scrollTop;
    check('holding the pointer at the top edge scrolls the board up under it, with the pointer standing still', up > 0, String(up));

    ev('pointermove', 300, 590);   // 10px inside the bottom band
    const bot0 = sc.scrollTop;
    step(4);
    check('…and at the bottom edge, down', sc.scrollTop - bot0 > 0, String(sc.scrollTop - bot0));

    /* Squared, not linear: the far side of the band is a nudge and the edge
     * is a sprint. A linear ramp reads as one speed — you creep the whole way
     * or you overshoot. */
    ev('pointermove', 300, 165);   // 65px in: nearly out of the band
    const slow0 = sc.scrollTop; step(1); const slow = slow0 - sc.scrollTop;
    ev('pointermove', 300, 101);   // hard against it
    const fast0 = sc.scrollTop; step(1); const fast = fast0 - sc.scrollTop;
    check('…and the speed grows with how far into the band you are, squared rather than linearly',
      fast > slow * 4, fast + ' vs ' + slow);

    ev('pointermove', 300, 350);   // out of both bands
    const still0 = sc.scrollTop; step(3);
    check('…and the middle of the board does not scroll at all', sc.scrollTop === still0);

    /* A drag you cannot abandon has to be finished somewhere, and on a board
     * you have scrolled away from that is a guess. */
    const wasOrder = order();
    d.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    check('escape puts the card back and leaves the order alone',
      order() === wasOrder && !w.Board.Terminal.state.drag
      && !d.querySelector('.tm-ghost, .tm-drag-chip') && src.hidden === false
      && !d.body.classList.contains('tm-dragging-cards'));
    check('…and the autoscroller stops with it', (step(3), sc.scrollTop === still0));

    w.requestAnimationFrame = realRaf;
    delete d.elementFromPoint;
    delete sc.getBoundingClientRect;
  }

  /* ── Moving without holding a button down ────────────────────────────────
   *
   * Dragging is the worst way to send a card the length of a long board: you
   * hold a button through the whole journey, and one slip drops it somewhere
   * you did not mean. The header is a drag handle, so it is a keyboard one.
   */
  {
    const ids = order().split(',');
    const id = ids[2];
    const key = (k, alt) => d.querySelector('#tm-' + id + ' .tm-head')
      .dispatchEvent(new w.KeyboardEvent('keydown', { key: k, altKey: alt !== false, bubbles: true }));
    key('ArrowLeft');
    check('alt+← steps a card back past its neighbour', order().split(',')[1] === id, order());
    key('ArrowRight');
    check('alt+→ steps it forward again', order().split(',')[2] === id, order());
    key('Home');
    check('alt+home sends it the whole way to the front', order().split(',')[0] === id, order());
    key('End');
    check('alt+end sends it to the back', order().split(',').pop() === id, order());
    const settled = order();
    key('End');
    check('…and the ends are walls, not wraps', order() === settled);
    key('ArrowLeft', false);
    check('a bare arrow is left alone — it belongs to whatever the header is inside', order() === settled);
    check('the header takes focus so a keyboard can reach it at all',
      d.querySelector('#tm-' + id + ' .tm-head').tabIndex === 0
      && /\.tm-head:focus-visible/.test(read('frontend/board.html')));
  }

  /* Two things a synthetic pointer cannot show, pinned as text: an iframe
   * consumes real pointer events (Comms, Pay and the viewer are whole
   * documents), and a touch drag on an unguarded handle scrolls the board
   * instead of lifting the card. */
  check('an iframe card cannot swallow a drag crossing it',
    /body\.tm-dragging-cards iframe \{[^}]*pointer-events: none/.test(read('frontend/board.html'))
    && /setPointerCapture/.test(read('frontend/board-terminal.js')));
  check('…and a touch drag lifts the card rather than scrolling the board',
    /\.tm-head \{[^}]*touch-action: none/.test(read('frontend/board.html')));

  check('every card carries a resize grip', d.querySelectorAll('#tm-grid .tm-card .tm-resize').length === d.querySelectorAll('#tm-grid .tm-card').length);
  w.Board.Terminal.resizeTo(first, 3, false);
  check('a resize commits the width to the layout', d.querySelector('#tm-' + first).classList.contains('tm-w3') && w.Board.Terminal.state.layout.cards.find((c) => c.id === first).w === 3);
  w.Board.Terminal.resizeTo(first, 9, false);
  check('…clamped to the grid', w.Board.Terminal.state.layout.cards.find((c) => c.id === first).w === 3);

  // Page views and the battle log.
  // The ops cards: every one renders from the page's own command, no whole page.
  for (const [word, type, expect] of [
    ['QUEUE', 'queue', /StructBuildInitiate/], ['RESULTS', 'results', /insufficient charge/], ['SOLVE', 'solve', /GPU/],
    ['GRID', 'grid', /connections/i], ['FUEL', 'fuel', /Auto infuse/], ['ALLOC', 'allocations', /6-53/], ['ARMADA', 'armada', /MARKLIFER/],
    ['RAIDS', 'raids', /shields vulnerable/], ['POSTURE', 'posture', /Auto response/], ['TARGETS', 'targets', /NO-GO/],
    ['GRUDGES', 'grudges', /beezhan/], ['VETOES', 'vetoes', /Protected player/], ['INCIDENTS', 'incidents', /2-287/],
    ['WALLET', 'wallet', /\[OH\]\s*Hydro/], ['HEALTH', 'health', /./],
  ]) {
    run(word);
    const sel = '#tm-grid [data-type="' + type + '"]';
    await until(() => d.querySelector(sel) && !/…$/.test(d.querySelector(sel + ' .tm-body').textContent.trim()) && d.querySelector(sel + ' .tm-body').textContent.trim() !== '');
    const body = d.querySelector(sel + ' .tm-body');
    check(word + ' renders the ' + type + ' card from its own data', !!body && expect.test(body.textContent) && !/unavailable/.test(body.textContent), body && body.textContent.slice(0, 120));
  }
  // Actionable: a queued signing can be cancelled from its row…
  check('queue rows are catalogue rows: rank first, cancel as a destructive door, in flight without doors', d.querySelectorAll('#tm-grid [data-type="queue"] .pc-row').length > 0 && d.querySelector('#tm-grid [data-type="queue"] .pc-act[title="Cancel"]').classList.contains('sc-destructive'));
  [...d.querySelectorAll('#tm-grid [data-type="queue"] .pc-act')].find((a) => a.title === 'Cancel').click();
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_tx_mutate' && c.args.op === 'cancel'));
  check('…the queue card cancels through the same command as the page', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_tx_mutate' && c.args.op === 'cancel' && c.args.id === 't2'));
  // …a combat loop toggles from the posture card…
  const raidSwitch = d.querySelector('#tm-grid [data-type="posture"] [data-loop="raid"] input');
  check('the posture card draws each loop as a loop card with the game\'s own switch', raidSwitch !== null && d.querySelectorAll('#tm-grid [data-type="posture"] .pc-card').length === 2 && raidSwitch.checked === false);
  raidSwitch.checked = true; raidSwitch.dispatchEvent(new w.Event('change', { bubbles: true }));
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_config_set' && c.args.domain === 'loop'));
  const loopCall = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'mcp_config_set' && c.args.domain === 'loop');
  check('…the posture card switches a loop by sending its whole config back', loopCall.args.payload.loop === 'raid' && loopCall.args.payload.config.enabled === true && loopCall.args.payload.config.posture === 'opportunist');
  // …and a target can be grudged from the board.
  // The board scores a target and can now launch it — the same verb the
  // agent uses, behind a confirm because it seizes ore and starts a fight.
  {
    const go = d.querySelector('#tm-grid [data-type="targets"] .pc-row.sc-bad');
    const raidDoor = go.querySelector('.pc-act[title^="Raid "]');
    check('a GO target offers the raid itself, as a destructive door', raidDoor !== null && raidDoor.classList.contains('sc-destructive'));
    check('…and a NO-GO target does not', [...d.querySelectorAll('#tm-grid [data-type="targets"] .pc-row')].filter((r) => !r.classList.contains('sc-bad')).every((r) => !r.querySelector('.pc-act[title^="Raid "]')));
    raidDoor.click();
    await until(() => d.querySelector('.ops-modal-overlay'));
    check('…asking first, naming the ore at stake', /seizes their ore/i.test(d.querySelector('.ops-modal-overlay').textContent));
    [...d.querySelectorAll('.ops-modal-overlay .sui-message-system-modal-cta-btn-wrapper a')][1].click();
    await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_action'));
    const act = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'mcp_action');
    check('…then raids through the game\'s own action path', act.args.action === 'raid' && act.args.args.target_id === '2-15361', JSON.stringify(act.args));
  }
  {
    const ore = [...d.querySelectorAll('#tm-grid [data-type="wallet"] .pc-row')].find((r) => /not sendable/.test(r.textContent));
    check('ore offers the one thing you can do with it', ore.querySelector('.pc-act[title="Refine ore into alpha"]') !== null);
  }
  const goRow = d.querySelector('#tm-grid [data-type="targets"] .pc-row.sc-bad');
  check('the target board draws catalogue rows: GO as the stripe and badge, the planet as a chip, the veto as a destructive door', goRow !== null && /GO/.test(goRow.querySelector('.sui-badge').textContent) && goRow.querySelector('.sc-chip[data-kind="planet"]') !== null && goRow.querySelector('.pc-act[title^="Never attack"]').classList.contains('sc-destructive'));
  check('a blocked target says why on its row', [...d.querySelectorAll('#tm-grid [data-type="targets"] .pc-row')].some((r) => /protected/.test(r.querySelector('.pc-attn')?.textContent || '') && r.querySelector('.sui-badge').textContent === 'NO-GO'));
  check('grudges are rows with the weight as the badge and mute and forget as doors', d.querySelector('#tm-grid [data-type="grudges"] .pc-row .sui-badge')?.textContent.startsWith('×') && d.querySelector('#tm-grid [data-type="grudges"] .pc-act[title="Forget this grudge"]') !== null);
  check('vetoes are rows with Remove as a destructive door', d.querySelector('#tm-grid [data-type="vetoes"] .pc-row .pc-act[title^="Remove"]')?.classList.contains('sc-destructive'));
  d.querySelector('#tm-grid [data-type="targets"] .pc-act[title^="Add 1-61"]').click();
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_config_set' && c.args.domain === 'combat_lists'));
  check('…the target board adds a grudge through combat_lists', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_config_set' && c.args.domain === 'combat_lists' && c.args.payload.kind === 'grudge' && c.args.payload.id === '1-61'));
  // Energy acts now: the two cards that named a problem and offered no remedy.
  {
    const fuel = d.querySelector('#tm-grid [data-type="fuel"]');
    check('the fuel card carries a ticket: op, reactor, amount', fuel.querySelector('.tm-ticket') !== null && fuel.querySelectorAll('.tm-ticket-fields select').length === 2 && fuel.querySelector('.tm-ticket-fields input') !== null);
    const amount = fuel.querySelector('.tm-ticket-fields input');
    amount.value = '1000000';
    amount.dispatchEvent(new w.Event('input', { bubbles: true }));
    await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_infusion_preview'));
    const prev = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'mcp_infusion_preview');
    check('…which previews before it signs, naming reactor and amount', prev.args.op === 'infuse' && prev.args.amountUalpha === 1000000 && !!prev.args.destinationId && !!prev.args.address);
    await until(() => fuel.querySelector('.tm-ticket-note .fstat'));
    check('…and shows what the chain would do', /capacity gained/i.test(fuel.querySelector('.tm-ticket-note').textContent));
    fuel.querySelector('.tm-ticket a.sui-screen-btn').click();
    await until(() => d.querySelector('.ops-modal-overlay'));
    check('…asking before it signs', /Stake this alpha/i.test(d.querySelector('.ops-modal-overlay').textContent));
    [...d.querySelectorAll('.ops-modal-overlay .sui-message-system-modal-cta-btn-wrapper a')][1].click();
    await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_infusion_infuse'));
    check('…then infuses', (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'mcp_infusion_infuse').args.amountUalpha === 1000000);
  }
  {
    const alloc = d.querySelector('#tm-grid [data-type="allocations"]');
    check('an allocation row offers to set its power', alloc.querySelector('.pc-row .pc-act[title^="Set the power"]') !== null);
    alloc.querySelector('.pc-row .pc-act[title^="Set the power"]').click();
    await until(() => alloc.querySelector('.tm-ticket-slot .tm-ticket'));
    const mw = alloc.querySelector('.tm-ticket-slot input');
    // It previews the CURRENT value on open, then again on every edit.
    await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_allocation_preview'));
    mw.value = '5000';
    mw.dispatchEvent(new w.Event('input', { bubbles: true }));
    await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_allocation_preview' && c.args.powerMw === 5000));
    check('…previewing the change against the budget', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_allocation_preview' && c.args.powerMw === 5000 && c.args.allocationId === '6-53'));
    check('…and a locked allocation offers nothing', [...alloc.querySelectorAll('.pc-row')].every((r) => !/locked/.test(r.textContent) || !r.querySelector('.pc-act')));
  }
  // The roster can be added to, not only managed.
  {
    const armada = d.querySelector('#tm-grid [data-type="armada"]');
    [...armada.querySelectorAll('a.sui-screen-btn')].find((a) => a.textContent === 'New player').click();
    await until(() => armada.querySelector('.tm-ticket-slot .tm-ticket'));
    const t = armada.querySelector('.tm-ticket-slot');
    t.querySelector('input').value = 'Test Pilot';
    t.querySelector('a.sui-screen-btn').click();
    await until(() => d.querySelector('.ops-modal-overlay'));
    check('a new virtual player is asked about before it is made', /Create a virtual player/.test(d.querySelector('.ops-modal-overlay').textContent));
    [...d.querySelectorAll('.ops-modal-overlay .sui-message-system-modal-cta-btn-wrapper a')][1].click();
    await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_players'));
    const made = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'mcp_players');
    check('…through the roster\'s own create, which picks the HD index and joins the guild', made.args.command === 'create' && made.args.name === 'Test Pilot');
  }
  // Comms splits into rooms and people, each its own card.
  {
    const before = w.Board.Terminal.state.layout.cards.length;
    run('DMS');
    const dm = w.Board.Terminal.state.layout.cards[w.Board.Terminal.state.layout.cards.length - 1];
    check('DMS opens a Comms card showing only direct messages', w.Board.Terminal.state.layout.cards.length === before + 1 && dm.type === 'chat' && dm.params.list === 'direct');
    await until(() => d.querySelector('#tm-' + dm.id + ' iframe'));
    check('…and the page is asked for that list', /list=direct/.test(d.querySelector('#tm-' + dm.id + ' iframe').getAttribute('src')));
    w.Board.Terminal.remove(dm.id);
  }

  /* ── Deliver is a CARD now, not a window in a card ────────────────────────────
   *
   * `transfer.html` in an iframe was the cause of every frame, header and
   * scaling bug that panel had: a whole document carrying its own `.sui-panel`,
   * its own nav bar and the game's menu-page scaler inside a frame that
   * already drew all three. The window still exists — Comms opens it, and
   * there it IS a window — but the card draws itself.
   */
  {
    const pay = w.Board.Terminal.add('deliver', { to: '1-61' });
    const node = d.querySelector('#tm-' + pay.id);
    await until(() => node.querySelector('.deliver-parties .pc-person'));
    check('Deliver draws itself — no page embedded in the card',
      node.querySelector('iframe') === null && node.querySelector('.deliver-parties') !== null);

    /* A payment names two PEOPLE. Seeing the recipient's face and id is what
     * catches a mis-send before it is signed; an address never does. */
    const sides = node.querySelectorAll('.deliver-party');
    check('…and it names BOTH parties, as people', sides.length === 2
      && /1-194/.test(sides[0].textContent)
      && /JPEG/.test(sides[1].textContent) && /1-61/.test(sides[1].textContent)
      && sides[0].querySelector('.pc-pfp') !== null && sides[1].querySelector('.pc-pfp') !== null,
      [...sides].map((s) => s.textContent).join(' | '));
    /* `resolve_player` answers with the ROLE label until the game window has
     * reported a callsign, so the payer was drawn as a person called
     * "primary". An unnamed player is shown by id. */
    check('…and the payer is never a person called "primary"',
      !/primary/i.test(sides[0].textContent), sides[0].textContent);
    check('…the recipient shown with the address the payment would actually go to',
      /structs1qqqq/.test(sides[1].querySelector('.deliver-addr').textContent));
    /* `fstat-l` upper-cases. An address that cannot be pasted back is not an
     * address the player can check. */
    check('…in the lowercase it is really written in',
      !/STRUCTS1/.test(sides[1].querySelector('.deliver-addr').textContent));

    /* `amount` is the FLOORED display figure, `amount_p` the precise base one:
     * 40230000000 µg is 40.23 Kg, and reading the wrong field would have shown
     * a balance a millionth of the truth. */
    const amount = node.querySelector('.amount-input');
    const facts = () => node.querySelector('.deliver-facts').textContent;
    check('the balance is the PRECISE holding, not the floored display figure', /40\.23Kg/.test(facts()), facts());
    /* The picker is always there, even holding one thing: the list IS the
     * answer to "what can I send", and a control that only appears once you
     * happen to hold a second token is one nobody knows exists. */
    const picker = () => node.querySelector('.deliver-amount-host select');
    const denoms = () => [...picker().options].map((o) => o.textContent);
    check('the asset picker is always drawn, with Alpha first and the guild token beside it',
      picker() !== null && /alpha/i.test(denoms()[0]) && denoms().some((t) => /Hydro/.test(t)),
      denoms().join(' | '));
    check('…offering only what the SERVER says may leave a wallet — ore is not a bank asset',
      !denoms().some((t) => /ore/i.test(t)), denoms().join(' | '));
    check('…and each option says how much of it you hold', /40\.23Kg/.test(denoms()[0]), denoms()[0]);

    /* A guild token is not on Alpha's ladder: it has whatever exponent and
     * display name its guild chose, read off the chain. Without them there
     * was no way to spell "3 Hydro" and the player counted millionths. */
    picker().value = 'uguild.0-1';
    picker().dispatchEvent(new w.Event('change', { bubbles: true }));
    await until(() => /Hydro/.test(node.querySelector('.deliver-facts').textContent));
    check('switching asset re-denominates the balance in that token\'s OWN units',
      /12 Hydro/.test(node.querySelector('.deliver-facts').textContent),
      node.querySelector('.deliver-facts').textContent);
    check('…and the unit picker offers that guild\'s rungs, not Alpha\'s',
      [...node.querySelectorAll('.amount-unit option')].map((o) => o.value).join(',') === 'Hydro,uhydro',
      [...node.querySelectorAll('.amount-unit option')].map((o) => o.value).join(','));
    picker().value = 'ualpha';
    picker().dispatchEvent(new w.Event('change', { bubbles: true }));
    await until(() => /40\.23Kg/.test(node.querySelector('.deliver-facts').textContent));

    amount.value = '5';
    amount.dispatchEvent(new w.Event('input', { bubbles: true }));
    // Wait for the PREVIEW, not just the local arithmetic: "after" is worked
    // out here, the route is the server's answer, and only the second means
    // the round trip landed.
    await until(() => /primary signing queue/.test(facts()));
    check('an amount previews what it costs you and which queue signs it',
      /35\.23Kg/.test(facts()) && /primary signing queue/.test(facts()), facts());
    const cta = () => node.querySelector('.deliver-actions a');
    check('…and the button says what it will do, not "submit"', / Send 5Kg/.test(cta().textContent), cta().textContent);
    /* …and says it in a face that HAS the units. `sui-screen-btn` is
     * ExtremeHazard, all-caps with no lowercase, so a 1μg send read "SEND 1MG"
     * — a thousandfold misreading on the control that states what is about to
     * be signed. The quantity is drawn in DirectiveZero instead. */
    check('…with the quantity in the face that can spell μg, mg and Kg apart',
      cta().querySelector('.deliver-qty') !== null
      && cta().querySelector('.deliver-qty').textContent === '5Kg',
      cta().innerHTML);
    check('…and is live, because the preview says the chain would take it', !cta().classList.contains('deliver-off'));

    /* The card's whole job is to refuse what the chain would refuse. */
    amount.value = '999';
    amount.dispatchEvent(new w.Event('input', { bubbles: true }));
    await until(() => /short by/.test(node.querySelector('.deliver-note').textContent));
    check('spending more than you hold is refused HERE, with the chain\'s own reason',
      cta().classList.contains('deliver-off') && /short by/.test(node.querySelector('.deliver-note').textContent),
      node.querySelector('.deliver-note').textContent);

    /* Paying someone else gives up only the thing that must be re-decided. */
    sides[1].querySelector('.deliver-clear').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
    await until(() => node.querySelector('.deliver-party input'));
    check('changing the recipient hands back the search, and refuses to send meanwhile',
      node.querySelector('.deliver-party input') !== null && cta().classList.contains('deliver-off'));

    /* Half an id is not a name, and the guild API's name search says so with a
     * 400. That reached the card verbatim — a URL, a JSON body and "this value
     * is not valid", upper-cased over six lines where the answer goes. */
    {
      const box = node.querySelector('.deliver-party input');
      const hits = () => node.querySelector('.deliver-hits').textContent;
      const type = async (v) => {
        box.value = v;
        box.dispatchEvent(new w.Event('input', { bubbles: true }));
        await new Promise((r) => setTimeout(r, 320));
      };
      const before = (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'mcp_player_search').length;
      await type('1-');
      const asked = (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'mcp_player_search').length;
      check('half an id is not asked of the name search at all', asked === before, String(asked - before));
      await type('1-61');
      check('…and a whole one is offered, not searched for', /1-61/.test(hits()), hits());
      await type('JPE');
      await until(() => /JPEG/.test(hits()));
      check('…while a name is still a search', /JPEG/.test(hits()), hits());
      check('…and the raw failure never reaches the card',
        !/http|json|\{|\}/i.test(hits()) && /search unavailable|\bno one\b|JPEG|1-61/.test(hits()), hits());
    }

    /* ── The payer is a pick too ────────────────────────────────────────────
     *
     * It was hardcoded to the primary, so an account holding the Alpha could
     * not be the one to spend it — and the only way to change it would have
     * been a card setting, which puts a signing identity behind a config
     * strip and makes it stick across sessions. It is the same picker the
     * recipient uses, in the card, defaulting to the primary.
     *
     * The candidate SET is what differs: the roster, not the galaxy, because a
     * payer is an account we hold a key to. */
    {
      const fromSide = () => node.querySelectorAll('.deliver-party')[0];
      // The block above left the recipient in its search box; put one back, so
      // what is being tested here is the PAYER and not a half-filled form.
      {
        const to = node.querySelectorAll('.deliver-party')[1].querySelector('input');
        to.value = '1-61';
        to.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        await until(() => node.querySelectorAll('.deliver-party')[1].querySelector('.deliver-addr'));
      }
      check('the payer opens as the primary, with a way to change it',
        /1-194/.test(fromSide().textContent) && fromSide().querySelector('.deliver-clear') !== null);

      fromSide().querySelector('.deliver-clear').dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await until(() => fromSide().querySelector('input'));
      check('changing the payer hands back a search, in the FROM slot',
        /FROM/.test(fromSide().querySelector('.fstat-l').textContent)
        && fromSide().querySelector('input') !== null);
      /* Eight hundred callsigns is not a list you type your way into blind,
       * and "who can afford this" is the question a payer picker is asked. */
      await until(() => fromSide().querySelectorAll('.deliver-hit').length);
      check('…which opens already showing the roster rather than an empty box',
        fromSide().querySelectorAll('.deliver-hit').length > 0
        && /1-194/.test(fromSide().textContent), fromSide().textContent);

      const box = fromSide().querySelector('input');
      const before = (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'mcp_player_search').length;
      box.value = 'miner';
      box.dispatchEvent(new w.Event('input', { bubbles: true }));
      await until(() => fromSide().querySelectorAll('.deliver-hit').length === 1);
      check('…filters the cached roster rather than asking a server per keystroke',
        (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'mcp_player_search').length === before
        && /1-272/.test(fromSide().textContent), fromSide().textContent);

      fromSide().querySelectorAll('.deliver-hit')[0].dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
      await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_inventory' && c.args && c.args.player === '1-272'));
      check('picking a payer re-reads THAT account\'s wallet, not the primary\'s',
        (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_inventory' && c.args.player === '1-272'));
      /* A different account holds different assets, so the denom, the typed
       * amount and the preview are all answers to a question no longer asked. */
      check('…and clears the amount rather than carrying it to a new balance',
        !node.querySelector('.amount-input').value, node.querySelector('.amount-input').value);
      /* Nothing is previewed on the switch alone — there is no amount to
       * price yet. Type one and it goes out as THEM. */
      check('…and previews nothing until there is an amount again',
        !(w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_transfer_preview' && c.args && c.args.from === '1-272'));
      const amt = node.querySelector('.amount-input');
      amt.value = '2';
      amt.dispatchEvent(new w.Event('input', { bubbles: true }));
      await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_transfer_preview' && c.args && c.args.from === '1-272'));
      check('…and the payment is then priced AS them, not as the primary',
        (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_transfer_preview' && c.args.from === '1-272')
        && !(w.__HARNESS_CALLS__ || []).slice(-3).some((c) => c.cmd === 'mcp_transfer_preview' && c.args.from === 'primary'));
      check('the payer is never a card setting — a signing identity does not belong in a config strip',
        !(w.Board.Terminal.types().find((t) => t.type === 'deliver').params || [])
          .some((p) => /from|payer/i.test(p.key)));
    }

    /* ── The Terminal may sign a transfer; an embedded page may not ─────────
     *
     * Deliver is a Terminal card, and the Terminal's windows are labelled
     * `terminal` / `terminal-<workspace>-<card>` — never `board`. The gate is
     * an exact-match allowlist, so the card drew a whole payment and was then
     * refused by its own app at the signature: "command restricted to 'board'
     * or 'transfer' (called from 'terminal')".
     *
     * Naming the Terminal there is only safe with the other half in place. A
     * card can embed a page, an iframe shares its HOST window's label, and the
     * frame bridge used to forward any command at all — so the Comms window,
     * which renders text written by federated strangers, could have asked the
     * Terminal to sign for it. */
    {
      const rs = read('src-tauri/src/mcp/tools/board_pages.rs');
      check('the transfer gate names the Terminal, since that is where Deliver lives',
        /require_window\(&window, &\["board", "transfer", "terminal"\]\)/.test(rs));
      check('…and "terminal" in an allowlist is the CLASS — the popped-out card labels are minted per card',
        /allowed\.contains\(&"terminal"\)\s*&&\s*crate::mcp::terminal::is_terminal_label\(label\)/.test(rs));
      /* Widening `require_board` itself would have handed the Terminal every
       * mass action, every config write and every roster command as a side
       * effect. It earns one capability. */
      check('…and it did NOT widen the board gate to get there',
        /pub\(crate\) fn require_board[^}]*require_window\(window, &\["board"\]\)/s.test(rs));

      const may = w.Board.Terminal.frameMayInvoke;
      check('an embedded page cannot borrow the signature it just unlocked',
        !may('mcp_transfer_execute') && !may('mcp_action') && !may('mcp_mass_action')
        && !may('mcp_config_set') && !may('terminal_guild_bank_mint'));
      check('…while everything Comms and the raid map really call still goes through',
        ['matrix_send', 'matrix_timeline', 'mcp_raid_state', 'mcp_struct_act', 'mcp_roster',
         'mcp_inventory', 'log_ui_events', 'close_chat_window'].every(may));

      /* The allowlist is MEASURED, not remembered: re-derive it from the pages
       * themselves so a page that grows a call fails here rather than in the
       * window, silently, on a control nobody clicks in a test. */
      const framed = ['chat.html', 'raidview.html'].flatMap((page) => {
        const html = read('frontend/' + page);
        return [...html.matchAll(/src="([a-z0-9_.-]+\.js)"/g)].map((m) => m[1]);
      });
      const called = new Set();
      [...new Set(framed)].forEach((f) => {
        for (const m of read('frontend/' + f).matchAll(/invoke\(\s*'([a-zA-Z_0-9]+)'/g)) called.add(m[1]);
      });
      const refused = [...called].filter((c) => !may(c));
      check('…and every command those pages actually invoke is on the list',
        refused.length === 0, refused.join(', '));
      check('…which is a real restriction, not a list of everything', called.size < 60 && !may('terminal_layout_set'),
        String(called.size));
    }

    /* The direction between the two parties is drawn with an icon the font
     * actually has: `icon-arrow-right` is not one, so it rendered nothing. */
    check('the arrow between the parties is a real glyph',
      node.querySelector('.deliver-arrow i').className.split(/\s+/).includes('icon-arrow'),
      node.querySelector('.deliver-arrow i').className);

    /* The card was called `pay` and is called `deliver`. A layout saved under
     * the old name still opens, the way `fleet` still opens as `armada`. */
    /* ── A card window keeps the game's frame ──────────────────────────────
   *
   * `html[data-card]` hides the BOARD's panel art, because in a card window
   * the OS window is the outer frame. Written unscoped, those selectors also
   * hit the CARD's panel — `frame()` builds every card from the same five
   * parts — so a popped-out card lost its borders and the window stopped
   * looking like Structs. The same shape of mistake as stripping every
   * `.sui-panel` in embed.css and taking the floating HUD with it.
   *
   * Asserted against the SOURCE: jsdom does not cascade these reliably, and
   * what matters is that the selector names the outer panel. */
  {
    const css = read('frontend/board.html');
    const rules = css.split('\n').filter((l) => /html\[data-card\]/.test(l) && /sui-panel/.test(l));
    check('every card-window panel rule names the BOARD panel, not any panel',
      rules.length > 0 && rules.every((l) => /#board-layout > \.sui-panel >/.test(l)),
      rules.filter((l) => !/#board-layout > \.sui-panel >/.test(l)).join(' | ').slice(0, 200));
    /* A card builds its own panel from these five, which is where its frame
     * comes from — if that ever stops being true this test is measuring
     * nothing. */
    const bt = read('frontend/board-terminal.js');
    const at = bt.indexOf('function frame(card');
    const frameFn = bt.slice(at, at + 900);
    check('…and the card really does build one of its own to protect',
      ['sui-panel-top-fill-background', 'sui-panel-bottom-fill-background',
       'sui-panel-edge-left', 'sui-panel-edge-right', 'sui-panel-chunk']
        .every((c) => frameFn.includes(c)));
  }

  /* ── Forgiving subjects: a name or the wrong-kind id both resolve ───────
   *
   * Looking AT a planet used to mean looking UP its id first. The id anyone
   * actually has is the player's, or their callsign, and one
   * `mcp_player_search` row carries the player, their planet and their fleet.
   *
   * The rules are pure (`searchSubject` / `searchRows`) so what the palette
   * offers is decided here rather than by whatever the network returned. */
  {
    const T = w.Board.Terminal;
    const HIT = [{ player_id: '1-61', username: 'JPEG', guild_id: '0-1', planet_id: '2-9462', fleet_id: '9-61' }];

    // What gets asked, and — more importantly — what does not.
    check('a whole id is looked up, because that is how a player becomes their planet',
      T.searchSubject('PLANET 1-61') === '1-61' && T.searchSubject('1-61') === '1-61');
    check('…so is a name', T.searchSubject('PLANET jpeg') === 'jpeg' && T.searchSubject('jpeg') === 'jpeg');
    /* The guild API answers `1-` with a 400, which the Pay window learned by
     * printing one at the player. */
    check('…and half an id is never asked of anyone',
      T.searchSubject('PLANET 1-') === null && T.searchSubject('1-') === null);
    check('…nor is a single letter, or a word still being typed',
      T.searchSubject('P') === null && T.searchSubject('PLANET') === null && T.searchSubject('') === null);

    // WORD + subject → the id the CARD wants.
    const rows = T.searchRows('PLANET 1-61', HIT);
    check('a player id resolves to the planet the card asked for',
      rows.length === 1 && rows[0].line === 'PLANET 2-9462' && rows[0].run === true,
      JSON.stringify(rows));
    check('…labelled with who it belongs to, not just the id',
      /JPEG/.test(rows[0].what) && /planet/.test(rows[0].what), rows[0].what);
    check('…and a name resolves the same way',
      T.searchRows('PLANET jpeg', HIT)[0].line === 'PLANET 2-9462');
    check('…while MAP, which wants a fleet, gets the fleet',
      T.searchRows('MAP jpeg', HIT).some((r) => r.line === 'MAP 9-61'),
      JSON.stringify(T.searchRows('MAP jpeg', HIT)));
    check('…and a card that takes ANY object is left alone — there is nothing to resolve',
      T.searchRows('INSPECT jpeg', HIT).length === 0);
    check('…and an id that is already the right kind offers nothing to change',
      T.searchRows('PLANET 2-9462', HIT).length === 0);

    /* A bare subject hands back the OBJECTS, not a card: putting the id in the
     * box is what makes the subject-first completion list everything askable
     * of it. */
    const bare = T.searchRows('jpeg', HIT);
    check('a bare name offers the player and the objects they own',
      bare.map((r) => r.words).join(',') === '1-61,2-9462,9-61', JSON.stringify(bare.map((r) => r.words)));
    check('…as subjects to complete, not as cards to open', bare.every((r) => r.run === false && /\s$/.test(r.line)));
    check('…and a bare player id skips itself and offers what it owns',
      T.searchRows('1-61', HIT).map((r) => r.words).join(',') === '2-9462,9-61');
    check('the block is bounded — a busy name cannot bury the grammar',
      T.searchRows('a', new Array(20).fill(HIT[0])).length <= 6);

    /* Enter must not run the wrong object. `PLANET 1-61` used to PARSE, which
     * meant Enter ran it and drew a player id as a planet — and because it
     * parsed, the menu's own rule handed it the line rather than the resolved
     * completion sitting right there. */
    check('a wrong-kind id is not a command at all', T.canRun('PLANET 1-61') === false);
    check('…so the resolved row is what Enter takes', T.canRun('PLANET 2-9462') === true);
    check('…and a card that takes any object still accepts anything',
      T.canRun('INSPECT 1-61') === true && T.canRun('INSPECT 2-9462') === true);
    check('…and nothing else about the grammar moved',
      T.canRun('MKT') === true && T.canRun('1-61') === true && T.canRun('PLAYER 1-61') === true);
  }

  /* ── A door in a popped-out card window ──────────────────────────────
     *
     * A card window IS one card: `renderGrid` filters to the solo id, so a
     * door that called `add()` mounted its card NOWHERE and read as dead —
     * while `save()` still wrote it into the workspace, leaving a stray card
     * in the Terminal on every click. Doors now open another window, which is
     * the only place a second card can go from there. */
    {
      const before = (w.__HARNESS_CALLS__ || []).length;
      const cardsBefore = w.Board.Terminal.state.layout.cards.length;
      w.Board.Terminal.state.solo = 'deliver-9';       // pretend this is a card window
      const ret = w.Board.Terminal.add('sheet', { id: '1-61' });
      const calls = (w.__HARNESS_CALLS__ || []).slice(before);
      w.Board.Terminal.state.solo = null;

      check('a door in a card window opens ANOTHER window, not a card nobody can see',
        calls.some((c) => c.cmd === 'open_terminal_card_new' && c.args.kind === 'sheet' && c.args.params.id === '1-61'),
        JSON.stringify(calls.map((c) => c.cmd)));
      check('…and leaves no stray card behind in the workspace',
        w.Board.Terminal.state.layout.cards.length === cardsBefore
        && !calls.some((c) => c.cmd === 'terminal_layout_set'),
        w.Board.Terminal.state.layout.cards.length + ' vs ' + cardsBefore);
      /* Sixty-eight call sites go through `add`, and `Terminal.execute` is the
       * only one that reads the result — as a boolean. */
      check('…and still answers truthy, so every door and the command line agree', ret === true);
    }

    check('a workspace saved when the card was called `pay` still opens',
      w.Board.Terminal.migrate({ cards: [{ id: 'pay-9', type: 'pay', params: {}, w: 1 }] })
        .cards[0].type === 'deliver');
    check('…and PAY still runs it from the palette, alongside DELIVER and SEND',
      ['DELIVER 1-61', 'PAY 1-61', 'SEND 1-61'].every((line) => {
        const plan = w.Board.Terminal.parse(line);
        return plan && plan.type === 'deliver';
      }));

    w.Board.Terminal.remove(pay.id);
  }
  check('an incident row names the attacker as a person and the shots as its badge', /1-1957/.test(d.querySelector('#tm-grid [data-type="incidents"] .pc-row').textContent) && /2-287/.test(d.querySelector('#tm-grid [data-type="incidents"] .pc-row').textContent) && d.querySelector('#tm-grid [data-type="incidents"] .pc-row .sui-badge') !== null);
  check('a raid row stacks attacker vs defender and keeps the live one\'s status word', /Marklifer/.test(d.querySelector('#tm-grid [data-type="raids"] .pc-row').textContent) && /JPEG/.test(d.querySelector('#tm-grid [data-type="raids"] .pc-row').textContent) && d.querySelector('#tm-grid [data-type="raids"] .pc-row.sc-bad') !== null);
  check('a wallet row is an asset row: ore marked not sendable and without a Deliver door', [...d.querySelectorAll('#tm-grid [data-type="wallet"] .pc-row')].some((r) => /not sendable/.test(r.textContent) && !r.querySelector('.pc-act[title="Deliver"]')) && [...d.querySelectorAll('#tm-grid [data-type="wallet"] .pc-row')].some((r) => r.querySelector('.pc-act[title="Deliver"]')));
  // The sweep prices itself before it moves anything.
  const sweepBtn = [...d.querySelectorAll('#tm-grid [data-type="armada"] a')].find((a) => a.textContent === 'Sweep Alpha');
  sweepBtn.click();
  await until(() => /Confirm sweep/.test(sweepBtn.textContent));
  check('the Armada card\'s sweep is a dry run first, and says what a second click will do', /Confirm sweep of 1/.test(sweepBtn.textContent) && !(w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_mass_action' && c.args.request.mode === 'execute'));
  // Embedded pages: one header. The Comms card's frame carries the Comms nav
  // as doors and the page is asked to drop its own bar (`?embed=1`).
  run('CHAT');
  await until(() => d.querySelector('#tm-grid [data-type="chat"] iframe.tm-frame'));
  const chatCard = d.querySelector('#tm-grid [data-type="chat"]');
  const chatId = chatCard.getAttribute('data-card');
  /* Framed like every other card. `frameless` once gave the embedded page's
   * own bar the header job — which cost the card the frame every other card
   * wears AND the three panel tools, leaving it a black box beside them. The
   * card draws its header; the page gives up whatever that header now says
   * twice (Pay's whole bar, Comms' pop-out and close). */
  check('the Comms card wears the same frame and header as every other card, and the page learns its card id',
    !chatCard.classList.contains('tm-frameless')
      && chatCard.querySelector('iframe.tm-frame').getAttribute('src') === 'chat.html?embed=1&card=' + chatId
      && chatCard.querySelector('.tm-head-screen .tm-title') !== null);
  check('…including the three panel tools and its age',
    ['Configure', 'Pop out', 'Remove'].every((t) => chatCard.querySelector('.tm-head [title="' + t + '"]') !== null)
      && chatCard.querySelector('.tm-age') !== null,
    [...chatCard.querySelectorAll('.tm-head .tm-door')].map((a) => a.title).join(' | '));
  check('…and the embedded page drops what the header now says twice',
    /html\[data-embed\] #tx-bar \{ display: none; \}/.test(read('frontend/embed.css'))
      && /#chat-nav-popout,\s*\n?html\[data-embed\] #menu-page-nav-close \{ display: none; \}/.test(read('frontend/embed.css')));
  /* The SCREEN, not just the bar inside it: hiding `.tm-head` alone left its
   * `.sui-screen` wrapper standing — an empty 8px box with a 4px border all
   * round — and the embedded page's own header opened one row too low. */
  /* jsdom does not cascade descendant selectors, so this asserts the rule
   * names an element that really is in the card — hiding `.tm-head` alone
   * left this `.sui-screen` wrapper standing (an empty 8px box with a 4px
   * border all round) and the page's own header opened one row too low. */
  check('…and the rule names the header SCREEN, which is the element actually in the card',
    chatCard.querySelector('.tm-head-screen') !== null
      && chatCard.querySelector('.tm-head-screen').classList.contains('sui-screen'));
  // The page has no bridge of its own: it asks this window to invoke and to
  // listen for it (bridge.js), and only frames this page embeds are answered.
  {
    const replies = [];
    const fakeSource = { postMessage: (m) => replies.push(m) };
    const stranger = { postMessage: (m) => replies.push(m) };
    const frame = chatCard.querySelector('iframe.tm-frame');
    Object.defineProperty(frame, 'contentWindow', { value: fakeSource, configurable: true });
    // `mcp_roster`, not `terminal_workspaces`: the proxy now answers only what
    // the embedded pages really call, and rearranging the operator's own
    // workspaces is not something Comms has any business asking for.
    w.Board.Terminal.answerFrame({ origin: '', source: fakeSource, data: { structs: 'bridge', kind: 'invoke', id: 7, cmd: 'mcp_roster', args: {} } });
    await until(() => replies.length === 1);
    check('an embedded page\'s invoke is run by this window and answered by message', replies[0].kind === 'result' && replies[0].id === 7 && replies[0].ok === true && Array.isArray(replies[0].value.rows));
    // On the list, so it reaches the bridge — and fails there, as it should.
    w.Board.Terminal.answerFrame({ origin: '', source: fakeSource, data: { structs: 'bridge', kind: 'invoke', id: 8, cmd: 'matrix_no_such_command', args: {} } });
    await until(() => replies.length === 2);
    check('…a failing invoke answers with the error', replies[1].ok === false && /no fixture/.test(replies[1].error));
    /* OFF the list: refused here, and never handed to the bridge at all. The
     * refusal is an answer, not silence — a page waiting forever on a promise
     * is a worse bug than a page told no. */
    w.Board.Terminal.answerFrame({ origin: '', source: fakeSource, data: { structs: 'bridge', kind: 'invoke', id: 10, cmd: 'mcp_transfer_execute', args: {} } });
    await until(() => replies.length === 3);
    check('…and a command off the list is refused by the PROXY, with a reason',
      replies[2].ok === false && /not available to an embedded page/.test(replies[2].error)
      && !(w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_transfer_execute'), replies[2].error);
    const took = w.Board.Terminal.answerFrame({ origin: '', source: stranger, data: { structs: 'bridge', kind: 'invoke', id: 9, cmd: 'mcp_roster', args: {} } });
    check('…a frame this page does not embed is not answered', took === false && replies.length === 3);
    w.Board.Terminal.answerFrame({ origin: '', source: fakeSource, data: { structs: 'bridge', kind: 'listen', name: 'matrix::typing' } });
    w.__HARNESS_EMIT__('matrix::typing', { room: '!x' });
    await until(() => replies.some((m) => m.kind === 'event'));
    check('…a listen subscribes here and forwards the event to the page', replies.some((m) => m.kind === 'event' && m.name === 'matrix::typing' && m.payload.room === '!x'));
  }
  // The page's bar asks for pop-out and close by message; only our origin.
  w.dispatchEvent(new w.MessageEvent('message', { data: { structs: 'card', card: chatId, act: 'popout' }, origin: '' }));
  check('…its pop-out asks Rust for a window on this card', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'open_terminal_card' && c.args.cardId === chatId));
  w.dispatchEvent(new w.MessageEvent('message', { data: { structs: 'card', card: chatId, act: 'remove' }, origin: 'https://evil.example' }));
  check('…a message from another origin is ignored', d.querySelector('#tm-grid [data-card="' + chatId + '"]') !== null);
  w.dispatchEvent(new w.MessageEvent('message', { data: { structs: 'card', card: chatId, act: 'remove' }, origin: '' }));
  check('…and its close removes the card', d.querySelector('#tm-grid [data-card="' + chatId + '"]') === null);
  // A Terminal window has one header: the board's nav bar, with the
  // workspace tabs and their doors mounted into it.
  const boardNav = d.querySelector('.sui-screen-nav:has(> #board-tabs)');
  // The console's own controls stay put while the cards scroll under them.
  {
    const css = read('frontend/board.html').replace(/\s+/g, ' ');
    const chrome = d.querySelector('.tm-chrome');
    const scroller = d.querySelector('.ops-scroll');
    scroller.scrollTop = 400;
    check('the command line is pinned inside the scroller, so it is reachable from anywhere on the page', /\.tm-chrome \{[^}]*position: sticky/.test(css) && chrome.closest('.ops-scroll') === scroller);
    check('a configure strip lays its fields side by side rather than one per row', /\.tm-config > \* \{ flex: 1 1 200px/.test(css));
  }
  check('in a Terminal window the workspace tabs sit in the board\'s nav bar, doors beside the refresh, and no strip of their own', boardNav.querySelector('#tm-ws-items .sui-mod-active') !== null && boardNav.querySelector('.board-navaside #tm-ws-doors [title="Rename this workspace"]') !== null && d.querySelector('.tm-workspaces #tm-ws-nav') === null && d.getElementById('board-refresh') === null);
  // A planet is the LIVE MAP: the spectator view embedded, fed by a watch
  // addressed to this card, with the neighbouring surfaces as doors.
  run('PLANET 2-15361');
  await until(() => d.querySelector('#tm-grid [data-type="planet"] iframe.tm-frame-map'));
  const planetCard = [...d.querySelectorAll('#tm-grid [data-type="planet"]')].slice(-1)[0];
  const planetId = planetCard.getAttribute('data-card');
  const src = planetCard.querySelector('iframe.tm-frame-map').getAttribute('src');
  check('the planet card embeds the map for that planet, labelled for this card', /^raidview\.html\?planet=2-15361&label=board%3A/.test(src) && src.includes('embed=1') && src.includes('card=' + planetId), src);
  const watch = (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'mcp_raid_view_watch' && c.args && c.args.planetId === '2-15361').slice(-1)[0];
  check('…and asks Rust to push that planet\'s feed to this card', watch && watch.args.planetId === '2-15361' && watch.args.label === 'board:' + planetId);
  check('…with the log, Comms and the full window as doors', [...planetCard.querySelectorAll('.tm-door-own')].map((a) => a.title).join(',') === 'Battle log,Comms about this planet,Watch in its own window');
  w.Board.Terminal.remove(planetId);
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_raid_view_unwatch'));
  const unwatch = (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'mcp_raid_view_unwatch' && c.args && c.args.planetId === '2-15361').slice(-1)[0];
  check('removing the card stops the feed', unwatch.args.label === 'board:' + planetId && unwatch.args.planetId === '2-15361');
  // The two cards the audit said were missing entirely.
  run('FEED');
  await until(() => d.querySelector('#tm-grid [data-type="feed"] .sc-tape'));
  {
    const feed = d.querySelector('#tm-grid [data-type="feed"]');
    check('FEED shows what the loops and the watchdog did, newest first', d.querySelectorAll('#tm-grid [data-type="feed"] .sc-tape').length === 2 && /watchdog/.test(feed.querySelector('.sc-tape').textContent) && /wedged/.test(feed.querySelector('.sc-tape').textContent), feed.querySelector('.sc-tape').textContent);
    w.__HARNESS_EMIT__('board-feed', { ts_ms: Date.now(), severity: 'error', source: 'tx', message: 'signing bridge down' });
    await until(() => /signing bridge down/.test(feed.textContent));
    check('…and a live entry lands on top', /signing bridge down/.test(feed.querySelector('.sc-tape').textContent) && feed.querySelector('.sc-tape').classList.contains('is-new'));
  }
  run('NEXT');
  await until(() => d.querySelector('#tm-grid [data-type="next"] .pc-row, #tm-grid [data-type="next"] .sui-message-inline-alert'));
  {
    const next = d.querySelector('#tm-grid [data-type="next"]');
    const rows = [...next.querySelectorAll('.pc-row')];
    // The fixture galaxy has no brownout and no raid against us, so the most
    // urgent thing it CAN find is a warning — and that is what leads.
    const RANK = { 'sc-bad': 0, 'sc-warn': 1, 'sc-live': 2 };
    const order = rows.map((r) => ['sc-bad', 'sc-warn', 'sc-live'].find((c) => r.classList.contains(c)));
    check('NEXT derives what needs doing from live readings, worst first', rows.length > 0 && order.every((c) => c !== undefined) && order.map((c) => RANK[c]).every((v, i, a) => i === 0 || a[i - 1] <= v), order.join(','));
    check('…each naming what is wrong and why it matters', /earns nothing|waiting|failed|paused|GO/i.test(rows[0].textContent) && /\w/.test(rows[0].querySelector('.pc-id').textContent), rows.map((r) => r.textContent.replace(/\s+/g, ' ').slice(0, 40)).join(' | '));
    check('…and opens the card that fixes it', rows[0].querySelector('.pc-act[title^="Open "]') !== null);
    const before = d.querySelectorAll('#tm-grid .tm-card').length;
    rows[0].querySelector('.pc-act[title^="Open "]').click();
    check('…as a real card, not a description of one', d.querySelectorAll('#tm-grid .tm-card').length === before + 1);
  }
  run('TAPE');
  check('TAPE is a live stream with a filter, economy by default', w.Board.Terminal.state.layout.cards.some((c) => c.type === 'tape') && w.Board.Terminal.types().find((t) => t.type === 'tape').params[0].options.map((o) => o.value).join(',') === 'economy,combat,all');
  run('SETTINGS');
  check('SETTINGS is the one page still reached as a page, plainly titled', w.Board.Terminal.state.layout.cards.some((c) => c.type === 'page' && c.params.page === 'config') && !/Team Ops/.test(d.querySelector('#tm-grid [data-type="page"] .tm-title').textContent));
  // The battle log and Comms are the raid view's own rails, embedded: two of
  // them can coexist because each is its own document.
  run('LOG 2-15361');
  await until(() => d.querySelector('#tm-grid [data-type="log"] iframe.tm-frame-rail'));
  {
    const src = d.querySelector('#tm-grid [data-type="log"] iframe.tm-frame-rail').getAttribute('src');
    check('LOG embeds the raid view showing only its battle log rail', /^raidview\.html\?planet=2-15361/.test(src) && src.includes('only=log') && src.includes('embed=1'), src);
    check('…and asks Rust to feed that planet to this card', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'mcp_raid_view_watch' && c.args.planetId === '2-15361'));
  }
  run('LOG 2-1');
  check('…and a second battle log is allowed, because each rail is its own document', w.Board.Terminal.state.layout.cards.filter((c) => c.type === 'log').length === 2);
  w.Board.Terminal.remove(w.Board.Terminal.state.layout.cards.filter((c) => c.type === 'log')[1].id);

  // Sharing: export → import round-trips into a new workspace.
  const code = w.Board.Terminal.exportWorkspace();
  check('a workspace exports as a terminal: code', /^terminal:[A-Za-z0-9+/=]+$/.test(code));
  const parsed = w.Board.Terminal.parseShared('please IMPORT ' + code + ' thanks');
  check('…that parses back with every card, even from inside a chat message', parsed && parsed.name === w.Board.Terminal.state.ws && parsed.cards.length === w.Board.Terminal.state.layout.cards.length);
  check('a bad code is refused, not thrown', w.Board.Terminal.parseShared('terminal:!!!') === null && w.Board.Terminal.parseShared('{"cards":"x"}') === null);
  const before = w.Board.Terminal.state.ws;
  await w.Board.Terminal.importWorkspace(code);
  check('IMPORT makes a new workspace beside the old one', w.Board.Terminal.state.ws !== before && w.Board.Terminal.state.ws.startsWith(before) && w.Board.Terminal.state.workspaces.includes(w.Board.Terminal.state.ws));
  // Role presets: a starting workspace per kind of player.
  run('PRESET trader');
  await tick(20);
  check('PRESET makes the role\'s workspace and goes there', w.Board.Terminal.state.ws === 'trader' && w.Board.Terminal.state.layout.cards.some((c) => c.type === 'market') && w.Board.Terminal.state.layout.cards.some((c) => c.type === 'book'));
  check('every preset names only registered card types and unique ids', Object.keys(w.Board.Terminal.PRESETS).every((k) => { const l = w.Board.Terminal.presetLayout(k); const ids = l.cards.map((c) => c.id); return l.cards.every((c) => w.Board.Terminal.known(c.type)) && new Set(ids).size === ids.length; }));
  [...d.querySelectorAll('#tm-ws-items .sui-screen-nav-item')].find((a) => a.textContent === '+').click();
  check('the new-workspace row offers the presets', !!d.querySelector('#tm-ws-preset') && d.querySelectorAll('#tm-ws-preset option').length === Object.keys(w.Board.Terminal.PRESETS).length + 1);
  run('SHARE');
  check('SHARE opens the share row with the code and a door to Comms', d.querySelector('#tm-ws-share input')?.value === w.Board.Terminal.exportWorkspace() && [...d.querySelectorAll('#tm-ws-share a')].some((a) => a.textContent === 'Send to Comms'));
  [...d.querySelectorAll('#tm-ws-share a')].find((a) => a.textContent === 'Send to Comms').click();
  await tick(10);
  check('…which shares it as a message', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'matrix_share' && /IMPORT terminal:/.test(c.args.text)));

  // Two windows, one workspace: a save adopts the version Rust answers, an
  // announced newer version from elsewhere reloads the page's copy.
  await w.Board.Terminal.flushSave();
  check('a save adopts the version Rust stored', w.Board.Terminal.state.layout.version === 4);
  check('the page listens for other windows\' saves', w.StructsEvents.names().includes('terminal-layout'));
  {
    const before = w.Board.Terminal.state.layout.cards.length;
    w.__HARNESS_EMIT__('terminal-layout', { workspace: w.Board.Terminal.state.ws, version: 4 });
    await tick(30);
    check('…an announcement at its own version changes nothing', w.Board.Terminal.state.layout.cards.length === before);
    w.__HARNESS_EMIT__('terminal-layout', { workspace: 'somewhere-else', version: 99 });
    await tick(30);
    check('…nor one for another workspace', w.Board.Terminal.state.layout.cards.length === before);
    w.__HARNESS_EMIT__('terminal-layout', { workspace: w.Board.Terminal.state.ws, version: 99 });
    await until(() => w.Board.Terminal.state.layout.cards.length !== before);
    // A workspace change elsewhere: the list follows, and a window showing a
    // deleted workspace moves to the active one rather than saving it back.
    w.__HARNESS_EMIT__('terminal-workspaces', { active: 'main', names: ['main', 'war-room', 'ops-2'] });
    await tick();
    check('a workspace list announced by another window is taken up by the strip', w.Board.Terminal.state.workspaces.join(',') === 'main,war-room,ops-2' && [...d.querySelectorAll('#tm-ws-items .sui-screen-nav-item')].some((n) => n.textContent === 'ops-2'));
    const wsBefore = w.Board.Terminal.state.ws;
    w.__HARNESS_EMIT__('terminal-workspaces', { active: 'war-room', names: ['war-room'] });
    await until(() => w.Board.Terminal.state.ws === 'war-room');
    check('…and a window whose workspace was deleted switches to the active one', wsBefore !== 'war-room' && w.Board.Terminal.state.ws === 'war-room' && w.Board.Terminal.state.workspaces.join(',') === 'war-room');
    w.__HARNESS_EMIT__('terminal-workspaces', { active: 'main', names: ['main', 'war-room'] });
    await w.Board.Terminal.switchWorkspace('main');
    check('…but a newer version for this workspace reloads the layout from Rust', w.Board.Terminal.state.layout.cards.length === 6 && d.querySelectorAll('#tm-grid .tm-card').length === 6);
  }

  run('NOPE');
  check('an unknown word is refused in place, not swallowed', cmd.classList.contains('is-err') && cmd.value === 'NOPE');

  // Workspaces.
  [...d.querySelectorAll('#tm-ws-items .sui-screen-nav-item')].find((a) => a.textContent === 'war-room').click();
  await until(() => w.Board.Terminal.state.ws === 'war-room');
  check('picking a workspace switches the page and activates it', w.Board.Terminal.state.ws === 'war-room' && (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'terminal_workspace_activate' && c.args.name === 'war-room'));
  // Delete asks first; the strip's delete door never acts on one click.
  const delCallsBefore = (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_workspace_delete').length;
  d.querySelector('#tm-ws-doors [title="Delete this workspace"]').click();
  await until(() => d.querySelector('.ops-modal-overlay'));
  check('delete asks first, naming the workspace', d.querySelector('.ops-modal-overlay') !== null && /war-room/.test(d.querySelector('.ops-modal-overlay').textContent) && (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_workspace_delete').length === delCallsBefore);
  d.querySelector('.ops-modal-overlay .sui-message-system-modal-cta-btn-wrapper a').click();
  check('…and Cancel keeps it', d.querySelector('.ops-modal-overlay') === null && w.Board.Terminal.state.workspaces.includes('war-room'));
  // Rename: the door opens a name box; Enter renames through Rust, closes the
  // old windows first, and the strip follows the new name.
  await w.Board.Terminal.switchWorkspace('main');
  d.querySelector('#tm-ws-doors [title="Rename this workspace"]').click();
  const renameBox = d.getElementById('tm-ws-rename-name');
  check('rename opens a box holding the current name', renameBox !== null && renameBox.value === 'main');
  renameBox.value = 'ops';
  renameBox.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => w.Board.Terminal.state.ws === 'ops');
  const renameCall = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'terminal_workspace_rename');
  const calls = (w.__HARNESS_CALLS__ || []);
  check('Enter renames through Rust, old windows closed first', renameCall && renameCall.args.from === 'main' && renameCall.args.to === 'ops' && calls.findIndex((c) => c.cmd === 'terminal_workspace_windows_close' && c.args.name === 'main') < calls.indexOf(renameCall));
  check('…and the strip and the page follow the new name', w.Board.Terminal.state.ws === 'ops' && d.querySelector('#tm-ws-items .sui-mod-active').textContent === 'ops' && [...d.querySelectorAll('#tm-ws-items a, #tm-ws-items button')].every((n) => n.textContent !== 'main'));
  check('a taken name is refused without touching Rust', (w.Board.Terminal.renameWorkspace('ops', 'war-room'), (w.__HARNESS_CALLS__ || []).filter((c) => c.cmd === 'terminal_workspace_rename').length === 1));
  await w.Board.Terminal.renameWorkspace('ops', 'main');
  await w.Board.Terminal.switchWorkspace('war-room');
  // Order: the strip is arranged by the player, through Rust, and the doors
  // know the ends — war-room is last, so right is off and left is live.
  // Order: drag a tab along the strip — the same pointer drag the cards use.
  check('there are no nudge doors; the tabs drag', d.querySelectorAll('#tm-ws-doors [title^="Move this workspace"]').length === 0 && d.querySelector('#tm-ws-items [data-ws="war-room"]').title === 'Drag to move');
  {
    const src = d.querySelector('#tm-ws-items [data-ws="war-room"]'), dst = d.querySelector('#tm-ws-items [data-ws]');
    d.elementFromPoint = (x) => (x < 100 ? dst : null);
    dst.getBoundingClientRect = () => ({ left: 0, width: 80, top: 0, height: 30, right: 80, bottom: 30 });
    const ev = (type, x, y, el) => (el || w).dispatchEvent(new w.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 }));
    ev('pointerdown', 300, 10, src);
    ev('pointermove', 20, 10);
    check('while dragging, the tab under the pointer shows the drop side', dst.classList.contains('tm-drop-before'));
    ev('pointerup', 20, 10);
    delete d.elementFromPoint;
  }
  await until(() => (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'terminal_workspace_order'));
  const orderCall = (w.__HARNESS_CALLS__ || []).find((c) => c.cmd === 'terminal_workspace_order');
  // (The rename fixture answers a fixed list, so only war-room's move is pinned, not its neighbour's name.)
  check('a nudge sends the whole order to Rust and redraws the strip in it', orderCall.args.names[0] === 'war-room' && orderCall.args.names.length === w.Board.Terminal.state.workspaces.length && d.querySelector('#tm-ws-items .sui-screen-nav-item').textContent === 'war-room', orderCall.args.names.join(','));
  await w.Board.Terminal.dropWorkspace('war-room', null, true);
  check('…loading that workspace\'s own layout', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'terminal_layout_get' && c.args && c.args.workspace === 'war-room'));
  d.querySelector('#tm-ws-doors [title="Open this workspace in its own window"]').click();
  await tick(10);
  check('a workspace can be a window of its own', (w.__HARNESS_CALLS__ || []).some((c) => c.cmd === 'open_terminal_workspace' && c.args.name === 'war-room'));
  [...d.querySelectorAll('#tm-ws-items .sui-screen-nav-item')].find((a) => a.textContent === '+').click();
  const nameBox = d.getElementById('tm-ws-new');
  check('+ asks for a name', nameBox !== null);
  nameBox.value = 'ore desk'; nameBox.dispatchEvent(new w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await until(() => w.Board.Terminal.state.ws === 'oredesk');
  check('a new workspace takes a plain name and becomes the page', w.Board.Terminal.state.ws === 'oredesk' && w.Board.Terminal.state.workspaces.includes('oredesk'));
}

// ── A pop-out: one card, no toolbar, full width ────────────────────────────
{
  const dom = await load('?view=terminal&card=market-1');
  const w = dom.window, d = w.document;
  await until(() => d.querySelectorAll('#tm-grid .tm-card').length >= 1);
  check('a pop-out shows exactly its card', d.querySelectorAll('#tm-grid .tm-card').length === 1 && d.querySelector('#tm-grid .tm-card').getAttribute('data-card') === 'market-1');
  /* No toolbar in the window's own chrome. `.tm-bar` alone is too blunt now:
   * the palette carries one INSIDE its hidden scrim, and a card window answers
   * ⌘K like every other surface. So this asks the question it meant — is there
   * a bar on the page — and pins the palette's state separately. */
  check('…full width, with no command bar and no layout doors',
    d.querySelector('#terminal-body .tm-bar') === null
    && d.querySelector('#tm-market-1').classList.contains('tm-w3')
    && d.querySelector('#tm-market-1 [title="Remove"]') === null);
  check('…but ⌘K still reaches it, closed until asked for',
    d.getElementById('tm-palette') !== null && d.getElementById('tm-palette').hidden === true);
  check('…and no refresh door either: it refreshes on its cadence', d.querySelector('#tm-market-1 [title="Refresh"]') === null && w.Board.Terminal.cadenceOf('market-1') > 0);
  /* The window IS the card: it draws the game's frame itself, so the board's
   * panel (two fill bands, two edges) and its nav bar — empty in a card
   * window — must not wrap a second container around it, with the bottom fill
   * lying over the card's own bottom border. The card's OWN header is a
   * `.sui-screen-nav` too, so the rule has to name the board's top bar by its
   * path and nothing else. */
  const board = read('frontend/board.html');
  check('…the window strips the board\'s panel frame and its empty nav bar off data-card', d.documentElement.getAttribute('data-card') === '1' && /html\[data-card\] #board-layout > \.sui-panel > \.sui-panel-chunk > \.sui-screen:has\(> \.sui-screen-nav\)/.test(board) && /html\[data-card\][^{]*\.sui-panel-bottom-fill-background/.test(board));
  check('…and the card keeps its own header', d.querySelector('#tm-market-1 .tm-head') !== null && d.querySelector('#tm-market-1 .tm-title') !== null);
}

// ── No layout yet: the default page ────────────────────────────────────────
{
  const dom = await load('?view=terminal');
  const w = dom.window, d = w.document;
  await until(() => w.Board && w.Board.Terminal);
  w.__HARNESS_REJECT__.terminal_layout_get = 'no file';
  try { w.localStorage.removeItem('structs.terminal.layout'); } catch (e) { /* file: origin has none */ }
  await w.Board.Terminal.enter();
  await until(() => d.querySelectorAll('#tm-grid .tm-card').length >= 7);
  check('with nothing saved, the default page has seven cards', d.querySelectorAll('#tm-grid .tm-card').length === 7);
  await until(() => d.querySelector('#tm-grid [data-type="tape"] ul.tm-tape'));
  check('a card kept by id from the last layout is re-rendered for its new params', /UNIVERSE/.test(d.querySelector('#tm-stats-1')?.textContent || ''));
  check('…including the flow tape, drawn as the stream draws its rows', d.querySelector('#tm-grid [data-type="tape"] ul.tm-tape') !== null);
  // A live frame arrives: ONE tape line (structs-cards.js), folded by the
  // board's own grass algorithm (old→new, block lifted out), newest striped.
  w.__HARNESS_EMIT__('grass-event', { category: 'ore', subject: 'structs.grid.planet.2-29577.1-422', timestamp: Date.now(), detail: { object_id: '2-29577', object_type: 'planet', player_id: '1-422', attribute_type: 'ore', value: 12, value_old: 11, block_height: 2507904 } });
  await until(() => d.querySelector('#tm-grid [data-type="tape"] .sc-tape'));
  const tapeLine = d.querySelector('#tm-grid [data-type="tape"] .sc-tape');
  check('…and a tape line opens what it is about', (() => { const before = w.Board.Terminal.state.layout.cards.length; d.querySelector('#tm-grid [data-type="tape"] .sc-tape').click(); return w.Board.Terminal.state.layout.cards.length === before + 1; })());
  check('a tape event reads as a header (time, short kind, what it is about) over the ONE figure that changed — the four chips restating the header are dropped', tapeLine.classList.contains('is-new') && /planet/.test(tapeLine.querySelector('.sc-tape-subj').textContent) && /2-29577/.test(tapeLine.querySelector('.sc-tape-subj').textContent) && /11g → 12g/.test(tapeLine.textContent) && /#2,507,904/.test(tapeLine.querySelector('.sc-tape-blk').textContent) && tapeLine.querySelectorAll('.sc-tape-kv').length === 1 && !/object_type/.test(tapeLine.textContent) && !/block_height/.test(tapeLine.textContent), tapeLine.textContent);
  check('…with the whole event on hover', /object_id 2-29577/.test(tapeLine.querySelector('.sc-tape-body').title));
  /* Half a repeat is still a repeat. The grass algorithm resolves ids to
   * names, so a `player_id` chip comes back as "1-422 (Marklifer)" — and the
   * id half is already standing in the header. Live 2026-09-07. */
  w.__HARNESS_EMIT__('grass-event', { category: 'ore', subject: 'structs.grid.planet.2-28908.1-462', timestamp: Date.now(), detail: { player_id: '1-462 (Colin-Lewis)', value: 5, value_old: 4, block_height: 2518613 } });
  await until(() => /Colin-Lewis/.test(d.querySelector('#tm-grid [data-type="tape"]').textContent));
  const named = [...d.querySelectorAll('#tm-grid [data-type="tape"] .sc-tape')].find((n) => /Colin-Lewis/.test(n.textContent));
  check('a chip that half-repeats the header keeps only the new half — the name, not the id again', /Colin-Lewis/.test(named.textContent) && named.querySelectorAll('.sc-tape-kv').length === 2 && !/1-462 \(/.test(named.querySelector('.sc-tape-body').textContent) && /1-462/.test(named.querySelector('.sc-tape-subj').textContent), named.textContent);
  /* Every inventory subject ends in a 44-character bech32 address. As the
   * head word it filled the whole header band and left nothing for the ids
   * beside it — live 2026-09-07, on every SENT / MINTED / REFINED frame. */
  w.__HARNESS_EMIT__('grass-event', { category: 'transfer', subject: 'structs.inventory.ualpha.0-1.structs1rwfvu2k78ajl5nljj8hfl79zmm0l96xyqw0tc9', timestamp: Date.now(), detail: { amount: '1', denom: 'ualpha', block_height: 2518623 } });
  await until(() => /structs1rwfv…/.test(d.querySelector('#tm-grid [data-type="tape"]').textContent));
  const addr = [...d.querySelectorAll('#tm-grid [data-type="tape"] .sc-tape')].find((n) => /structs1rwfv…/.test(n.textContent));
  check('an address in the subject is shortened, and rides with the ids so it is never the half that ellipses', /structs1rwfv…qw0tc9/.test(addr.querySelector('.sc-tape-ids').textContent) && /ualpha/.test(addr.querySelector('.sc-tape-word').textContent) && /structs1rwfvu2k78ajl5nljj8hfl79zmm0l96xyqw0tc9/.test(addr.querySelector('.sc-tape-subj').title), addr.textContent);
  /* A quiet stream and a DEAD stream looked the same. Live 2026-09-07 the
   * card read "no economic frames yet" while 177 frames an hour were landing
   * as block / struct_status / structsLoad — none of which the economy filter
   * matches. And the line said "economic" whichever stream was chosen. */
  {
    const before = w.Board.Terminal.state.layout.cards.length;
    w.Board.Terminal.add('tape', { filter: 'combat' }, 1);
    const quiet = w.Board.Terminal.state.layout.cards.slice(-1)[0].id;
    await until(() => d.querySelector('#tm-' + quiet + ' .ops-feed'));
    const line = d.querySelector('#tm-' + quiet + ' .ops-muted');
    check('an empty stream names ITSELF and says what is arriving elsewhere', /nothing on the combat stream/.test(line.textContent) && /other frames/.test(line.textContent), line.textContent);
    w.Board.Terminal.remove(quiet);
    check('…and the card came off again', w.Board.Terminal.state.layout.cards.length === before);
  }
}

console.log(failures ? failures + ' failing check(s)' : 'all checks passed');
process.exit(failures ? 1 : 0);
