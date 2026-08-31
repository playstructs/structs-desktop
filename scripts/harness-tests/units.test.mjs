// The game's unit ladders. One copy, used by the console and the small windows.
//
// This exists because the focused Pay window originally divided Alpha by its
// denom exponent and printed "9400 Alpha" — the same quantity the inventory
// page beside it calls "9.4Kg". Nothing was wrong with the arithmetic; the
// window was just telling a different story about the number than every other
// screen. A second ladder is a second story, so there is now only one.
import { readFileSync } from 'fs';

let failures = 0;
const check = (name, ok, detail) => {
  console.log((ok ? '  ok ' : 'FAIL ') + name + (ok || detail == null ? '' : ' — ' + detail));
  if (!ok) failures++;
};

const root = process.cwd();
const g = { window: undefined };
new Function('window', readFileSync(root + '/frontend/units.js', 'utf8'))(g);
const U = g.StructsUnits;

console.log('\n— printing');
// ualpha is MICROGRAMS: 1 g of Alpha is 1e6 ualpha, so "Alpha" and "gram" name
// the same unit. These are the strings the HUD prints.
for (const [raw, want] of [
  [9.4e9, '9.4Kg'], [2.5e6, '2.5g'], [1e3, '1mg'], [0, '0μg'], [1e18, '1Tg'],
]) {
  check(`${raw} ualpha reads as ${want}`, U.fmtAlpha(raw) === want, U.fmtAlpha(raw));
}
check('a missing value is a dash, not a zero', U.fmtAlpha(null) === '—', U.fmtAlpha(null));

console.log('\n— reading back');
// Whatever the ladder PRINTS has to parse, so a figure copied off any other
// screen can be pasted into the Pay window.
for (const [text, want] of [
  ['2.5', 2.5e6],        // bare number means grams — what "Alpha" names
  ['9.4Kg', 9.4e9],
  ['500mg', 5e5],
  ['2.5 g', 2.5e6],      // a space is not a syntax error
  ['1,000', 1e9],        // nor is a thousands separator
  ['1Tg', 1e18],
]) {
  check(`${JSON.stringify(text)} is ${want} ualpha`, U.parseAlpha(text) === want,
    String(U.parseAlpha(text)));
}

// Junk must be null, never 0. A form that reads junk as zero looks ready to
// send when nothing usable was typed.
for (const bad of ['junk', '', '   ', 'Kg', '1 banana', null, undefined]) {
  check(`${JSON.stringify(bad)} is unreadable, not zero`, U.parseAlpha(bad) === null,
    String(U.parseAlpha(bad)));
}

// `mg` and `Mg` are a factor of a billion apart. Case cannot be folded away.
check('mg is not Mg', U.parseAlpha('1mg') !== U.parse('1Mg', 'alpha'),
  U.parseAlpha('1mg') + ' vs ' + U.parse('1Mg', 'alpha'));

console.log('\n— round trip, and where it stops');
// Values that land ON a rung come back exactly, which is what lets a player
// paste a figure from another screen and mean it.
for (const raw of [1, 1e3, 2.5e6, 9.4e9, 1e12]) {
  const back = U.parseAlpha(U.fmtAlpha(raw));
  check(`${raw} survives print → parse`, back === raw, `${U.fmtAlpha(raw)} → ${back}`);
}

// But printing is LOSSY: two decimals on a 1000x ladder means 999μg prints as
// "1mg", and reading that back gives 1000. So a player who pastes their shown
// balance to send everything can ask for very slightly more than they hold.
//
// That is a display ladder working as intended, not a bug to round away — and
// it is safe because it is caught where it matters: `mcp_transfer_preview`
// answers "balance is X, short by Y", and `mcp_transfer_execute` re-runs that
// preview server-side, so the over-send is refused and named rather than
// silently clamped.
{
  const back = U.parseAlpha(U.fmtAlpha(999));
  check('a value between rungs does NOT round-trip', back !== 999, String(back));
  check('…and the error is display rounding, so it stays under 1%',
    Math.abs(back - 999) / 999 < 0.01, `${999} → ${back}`);
  const pages = readFileSync(root + '/src-tauri/src/mcp/tools/board_pages.rs', 'utf8');
  check('…which the preview refuses rather than the window guessing',
    /problems\.push\(format!\("balance is \{balance\}/.test(pages));
}

console.log('\n— one ladder, not two');
// There were THREE private copies: board.js, structs-config.js, and Rust's.
// They agreed on the numbers when checked, which is exactly what was true of
// the ore divisor before it drifted — so the guard is that no window carries
// its own tables at all, not that the tables currently match.
for (const f of ['board.js', 'structs-config.js', 'board-pages.js', 'board-gamestats.js']) {
  const src = readFileSync(root + '/frontend/' + f, 'utf8');
  // The tell is a unit postfix sitting next to a power-of-ten divisor.
  const ladderish = /(1e18|1e12|1e9|Math\.pow\(10,\s*(?:18|12|9|6|3))[\s\S]{0,120}?['"](?:Tg|Kg|TW|MW|KW|μg|mg)['"]/.test(src);
  check(f + ' does not carry its own ladder', !ladderish);
}
const board = readFileSync(root + '/frontend/board.js', 'utf8');
check('…and board.js uses the shared one', /window\.StructsUnits/.test(board));
const cfg = readFileSync(root + '/frontend/structs-config.js', 'utf8');
check('…as does the main window\'s debug panel', /window\.StructsUnits/.test(cfg));

// A window that formats units must actually LOAD them, or it fails at runtime
// in a way no static check would show.
for (const [html, why] of [
  ['board.html', 'board.js aliases the ladders at module load'],
  ['transfer.html', 'the Pay window prints Alpha'],
  ['index.html', 'the debug panel formats Alpha, ore and power'],
]) {
  const src = readFileSync(root + '/frontend/' + html, 'utf8');
  check(html + ' loads units.js — ' + why, /src="units\.js"/.test(src));
}

console.log('\n— the same ladder in both languages');
// There are TWO implementations of these ladders: units.js here, and
// `mcp/tools/format.rs` for everything Rust renders (the chat ref cards format
// their numbers server-side). They must agree, and they have not always: the
// Rust suite still carries the note "Ore's Tg divisor is 1e12 — the JS copy had
// 1e18", which is a factor of a million on the unit a player reads as a
// holding.
//
// Comparing the TABLES is enough. The two formatters already round the same
// way — digit-length picks the rung, two decimals, trailing zeros trimmed — so
// drift can only enter through the numbers below.
{
  const rs = readFileSync(root + '/src-tauri/src/mcp/tools/format.rs', 'utf8');
  const ladderOf = (fnName) => {
    const at = rs.indexOf('pub fn ' + fnName);
    if (at < 0) return null;
    const after = rs.slice(at + 1);
    const end = after.indexOf('\npub fn ');
    const body = end < 0 ? after : after.slice(0, end);
    const steps = [...body.matchAll(/\((\d+),\s*([0-9.e+]+),\s*"([^"]+)"\)/g)];
    return steps.map((m) => [Number(m[1]), Number(m[2]), m[3]]);
  };
  for (const [kind, fn] of [['alpha', 'format_alpha'], ['ore', 'format_ore'], ['power', 'format_power']]) {
    const rust = ladderOf(fn);
    const js = U.SCALES[kind];
    check(`${kind}: Rust and JS agree on the ladder`,
      !!rust && JSON.stringify(rust) === JSON.stringify(js),
      `rust ${JSON.stringify(rust)} vs js ${JSON.stringify(js)}`);
  }
}

console.log(failures ? `\n${failures} failing check(s)` : '\nall checks passed');
process.exit(failures ? 1 : 0);
