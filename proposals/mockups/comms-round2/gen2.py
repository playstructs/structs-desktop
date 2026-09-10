#!/usr/bin/env python3
"""Round 2: Local · Broadcasts · Intel · Groups — drawn from prior art (EVE
Local + fleet broadcasts, Ingress COMM, Subterfuge groups) on Matrix's own
machinery (per-object rooms, presence, receipts, custom events, spaces)."""
import os
from gen import HEAD, FOOT, card, msg, event, compose, cap, portrait, B
OUT = os.path.dirname(os.path.abspath(__file__))

EXTRA = '''<style>
  .lc-members { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); padding: var(--spacing-xs) 0 var(--spacing-sm); }
  .lc-member { display: flex; align-items: center; gap: 4px; }
  .lc-member .dot { width: 6px; height: 6px; background: var(--accent-primary); flex: 0 0 6px; }
  .lc-member.is-away .dot { background: var(--text-hint); }
  .lc-member.is-enemy span.n { color: var(--text-enemy-primary); }
  .lc-member.is-ally span.n { color: var(--text-player-primary); }
  .lc-orders { display: flex; gap: var(--spacing-sm); align-items: center; padding: var(--spacing-xs) var(--spacing-sm); border-left: 2px solid var(--accent-primary); background: var(--surface-default); margin: var(--spacing-xs) 0; }
  .lc-bc { display: flex; gap: var(--spacing-sm); align-items: center; padding: 3px var(--spacing-xs); background: var(--surface-default); margin: 2px 0; }
  .lc-bc .k { min-width: 4.5em; color: var(--text-player-primary); }
  .lc-bc.is-enemy .k { color: var(--text-enemy-primary); }
  .lc-bc .seen { margin-left: auto; color: var(--text-hint); white-space: nowrap; }
  .lc-keys { display: flex; gap: var(--spacing-xs); flex-wrap: wrap; padding: var(--spacing-sm) 0 0; }
  .lc-keys a { display: inline-flex; align-items: center; gap: 4px; }
  .lc-keys kbd { color: var(--text-hint); font: inherit; }
  .lc-lines { display: flex; flex-direction: column; }
  .in-row { display: flex; gap: var(--spacing-sm); align-items: flex-start; padding: 3px 0; border-bottom: thin solid var(--border-subtle); }
  .in-row .t { flex: 0 0 3em; color: var(--text-hint); }
  .in-row .w { flex: 0 0 5.5em; color: var(--text-hint); }
  .in-row.is-alert .w { color: var(--text-enemy-primary); }
  .in-row.is-order .w { color: var(--accent-primary); }
  .in-row .g { color: var(--text-hint); }
  .in-row .seen { margin-left: auto; color: var(--text-hint); white-space: nowrap; }
  .in-row a { color: var(--text-player-primary); }
  .sp-tree div { padding: 2px 0; display: flex; gap: var(--spacing-sm); align-items: center; }
  .sp-tree .d1 { padding-left: var(--spacing-lg); }
  .sp-tree .d2 { padding-left: var(--spacing-xxl); }
  .sp-tree .n { margin-left: auto; color: var(--text-hint); }
  .gp-deal { display: flex; gap: var(--spacing-md); align-items: center; padding: var(--spacing-sm); border: thin solid var(--border-strong); background: var(--surface-default); margin: var(--spacing-sm) 0; }
  .gp-deal .who { display: flex; gap: 4px; align-items: center; }
</style>'''
H2 = HEAD.replace('</head>', EXTRA + '</head>')

def member(name, tag, standing='', away=False, speaking=False):
    cls = 'lc-member' + (' is-' + standing if standing else '') + (' is-away' if away else '')
    return f'<span class="{cls}">{portrait(name)}<span class="dot"></span><span class="n">[{tag}] {name}</span>{"<span class=\"fstat-l\" style=\"color:var(--text-hint)\">speaking…</span>" if speaking else ""}</span>'

def bc(icon, kind, who, what, t, seen, enemy=False):
    return f'<div class="lc-bc{" is-enemy" if enemy else ""}"><i class="{icon} sui-icon-md"></i>{portrait(who)}<span class="k">{kind}</span><span>{what}</span><span class="seen fstat-l">{seen} · {t}</span></div>'

def key(n, icon, label):
    return f'<a class="sui-screen-btn sui-mod-secondary" href="javascript:void(0)"><kbd>{n}</kbd><i class="{icon} sui-icon-sm"></i>{label}</a>'

# ── E. Local, on the raid view ───────────────────────────────────────────────
E_stage = (
  '<div class="mk-stage" style="height:520px">'
  + '<div class="mk-ambit" style="top:0"><span class="fstat-l"><i class="sui-icon sui-icon-space sui-icon-sm"></i> space</span></div>'
  + '<div class="mk-ambit" style="top:25%"><span class="fstat-l"><i class="sui-icon sui-icon-air sui-icon-sm"></i> air</span></div>'
  + '<div class="mk-ambit" style="top:50%"><span class="fstat-l"><i class="sui-icon sui-icon-land sui-icon-sm"></i> land</span></div>'
  + '<div class="mk-ambit" style="top:75%;border:0"><span class="fstat-l"><i class="sui-icon sui-icon-water sui-icon-sm"></i> water</span></div>'
  + f'<img class="mk-struct" src="{B}img/structs/cmd-ship/cmd-ship-struct-base.png" style="left:60px;top:30px">'
  + f'<img class="mk-struct" src="{B}img/structs/ore-bunker/ore-bunker-struct-base.png" style="left:200px;top:290px">'
  + f'<img class="mk-struct" src="{B}img/structs/cruiser/cruiser-struct-base.png" style="left:280px;top:420px">'
  + '<div class="mk-eyes" style="left:250px;top:400px"><span class="fstat-l" style="color:var(--text-enemy-primary)"><i class="icon-detected sui-icon-sm"></i> COVER · water — Reactin</span></div>'
  + '</div>'
  + '<div class="mk-stat fstat-l"><span><b>2-21411</b> · raid live</span><span>shield <b>24%</b></span><span>[OH] 1-54 defends</span><span>[SN] worker12 attacks</span></div>'
)
E_local = (
  cap('here now · by standing')
  + '<div class="lc-members">' + member('Marklifer', 'OH', 'ally') + member('Reactin', 'OH', 'ally', speaking=True) + member('chatrbocks', 'OH', 'ally', away=True) + member('worker12', 'SN', 'enemy') + member('beezhan', 'SN', '', away=True) + '</div>'
  + '<div class="lc-orders"><i class="icon-cmd-post sui-icon-md"></i><span><b>Hold the water line; nobody launches alone.</b> <span class="fstat-l" style="color:var(--text-hint)">— Reactin, 13:40 · seen by 11 of 14</span></span></div>'
  + '<div class="lc-lines">'
  + bc('icon-defend', 'COVER', 'Reactin', '<a>2-21411</a> · water', '13:44', 'seen 5 · ack 2')
  + msg('Marklifer', 'OH', 'moving 9-194 in. two blocks.', '13:44', self_=True)
  + bc('icon-move', 'MOVING', 'Marklifer', '<a>9-194</a> → <a>2-21411</a> · 2 blocks', '13:44', 'seen 5')
  + event('chain', 'shield 61% → 24% · [SN] worker12 fires from water', '13:45')
  + bc('icon-raid', 'HIT', 'worker12', '<a>2-21411</a> · land', '13:45', 'seen 3', enemy=True)
  + msg('Reactin', 'OH', 'go now or it is gone', '13:45')
  + event('chain', 'fleet 9-194 arrived · defending', '13:46')
  + bc('icon-success', 'CLEAR', 'Marklifer', '<a>2-21411</a> · attacker defeated', '13:47', 'seen 6 · ack 4')
  + msg('chatrbocks', 'OH', 'ha. that cruiser is scrap', '13:47')
  + '</div>'
  + '<div class="lc-keys fstat-l">' + key(1, 'icon-defend', 'cover') + key(2, 'icon-raid', 'hit') + key(3, 'icon-move', 'moving') + key(4, 'icon-planetary-shield', 'shield') + key(5, 'icon-blocked', 'hold') + key(6, 'icon-success', 'clear') + '</div>'
  + compose('Say it at 2-21411')
)
E = H2 + card('Raid · 2-21411', [('icon-link-out', 'Open the planet')], E_stage, width=460) \
    + card('Local · 2-21411', [('icon-alert', 'Mentions only'), ('icon-disabled', 'Mute')], E_local, width=600) + FOOT

# ── F. Intel: the guild's feed, shared with allies ───────────────────────────
def inrow(t, kind, what, guild='', cls='', seen=''):
    return f'<div class="in-row {cls}"><span class="t fstat-l">{t}</span><span class="w fstat-l">{kind}</span><span>{what}{f" <span class=g>· {guild}</span>" if guild else ""}</span>{f"<span class=seen>{seen}</span>" if seen else ""}</div>'
F_body = (
  '<label class="sui-input-text" style="display:block;min-width:0"><input type="text" placeholder="find anything said or seen"></label>'
  + '<div class="sui-screen-nav" style="margin:var(--spacing-sm) 0"><div class="sui-screen-nav-items"><span class="sui-screen-nav-item sui-mod-active">all</span><span class="sui-screen-nav-item">alerts · 3</span><span class="sui-screen-nav-item">mine</span><span class="sui-screen-nav-item">orders</span></div></div>'
  + '<div class="lc-orders"><i class="icon-cmd-post sui-icon-md"></i><span><b>Water hulls to 2-21411 and 2-15361 until Friday.</b> <span class="fstat-l" style="color:var(--text-hint)">— Reactin · standing orders · seen by 11 of 14</span></span></div>'
  + inrow('13:47', 'CLEAR', '<a>2-21411</a> attacker defeated — Marklifer', seen='seen 6')
  + inrow('13:45', 'SIGHTING', '[SN] worker12 · cruiser, water, at <a>2-21411</a> (yours)', cls='is-alert', seen='seen 5')
  + inrow('13:44', 'COVER', '<a>2-21411</a> · water — Reactin', cls='is-alert', seen='ack 2')
  + inrow('13:44', 'SAID', 'Marklifer at <a>2-21411</a>: moving 9-194 in. two blocks.')
  + inrow('13:41', 'SIGHTING', '[SN] worker12 · fleet 9-2034 arrived at <a>2-21411</a> (yours)', cls='is-alert')
  + inrow('13:38', 'SAID', 'beezhan → you: are you selling ore', cls='is-alert')
  + inrow('13:30', 'SIGHTING', '[KC] raider7 · 2 destroyers at <a>2-30383</a>', guild='Imperial One')
  + inrow('13:22', 'ORDER', 'Imperial One: their war fleet is staging at 2-30380', guild='Imperial One', cls='is-order', seen='seen 4')
  + inrow('13:12', 'CLEAR', '<a>2-15361</a> attacker defeated — auto_response')
  + '<div class="chat-new" role="separator"><span class="fstat-l">seen up to here</span></div>'
  + inrow('12:58', 'SAID', 'chatrbocks in Orbital Hydro: anyone selling a cruiser hull')
  + cap('Orbital Hydro · shared with Imperial One and Lucky Star · 3 servers')
)
F = H2 + card('Intel', [('icon-beacon', 'Post a sighting'), ('icon-okay', 'Mark all seen')], F_body, width=760) + FOOT

# ── G. Groups + the guild space ──────────────────────────────────────────────
G_tree = (
  '<div class="sp-tree">'
  + '<div><i class="icon-guild sui-icon-md"></i><b>Orbital Hydro</b><span class="n fstat-l">your guild</span></div>'
  + '<div class="d1"><i class="icon-beacon sui-icon-sm"></i>Intel<span class="n fstat-l">3 alerts</span></div>'
  + '<div class="d1"><i class="icon-member sui-icon-sm"></i>Hub<span class="n fstat-l">5 here</span></div>'
  + '<div class="d1"><i class="icon-info sui-icon-sm"></i>Help<span class="n fstat-l">quiet</span></div>'
  + '<div class="d1"><i class="icon-planet sui-icon-sm"></i>Planet 2-21411<span class="n fstat-l">raid live · 5 here</span></div>'
  + '<div class="d1"><i class="icon-fleet-tile sui-icon-sm"></i>Fleet 9-172<span class="n fstat-l">2 here</span></div>'
  + '<div class="d1 fstat-l" style="color:var(--text-hint)">▸ 14 more objects</div>'
  + '<div><i class="icon-guild sui-icon-md"></i><b>OH × Imperial One</b><span class="n fstat-l">alliance · 2 servers</span></div>'
  + '<div class="d1"><i class="icon-beacon sui-icon-sm"></i>Shared intel<span class="n fstat-l">1 alert</span></div>'
  + '<div class="d1"><i class="icon-cmd-post sui-icon-sm"></i>Leaders<span class="n fstat-l">restricted</span></div>'
  + '<div><i class="icon-member sui-icon-md"></i><b>Groups</b><span class="n fstat-l">yours</span></div>'
  + '<div class="d1"><i class="icon-transfers sui-icon-sm"></i>Ore deal<span class="n fstat-l">beezhan, Reactin · 1 new</span></div>'
  + '<div class="d1"><i class="icon-member sui-icon-sm"></i>beezhan<span class="n fstat-l">direct</span></div>'
  + '<div class="d1 fstat-l" style="color:var(--text-hint)">▸ 5 more people</div>'
  + '<div><i class="icon-guild-directory sui-icon-md"></i><b>Other guilds</b><span class="n fstat-l">3 answered</span></div>'
  + '</div>'
)
G_room = (
  '<div class="lc-members">' + member('Marklifer', 'OH', 'ally') + member('Reactin', 'OH', 'ally') + member('beezhan', 'SN', '', away=True) + '</div>'
  + cap('private · you started it · only these three can read')
  + msg('beezhan', 'SN', 'are you selling ore', '13:38')
  + msg('Marklifer', 'OH', 'not this week. Reactin might, adding him', '13:50', self_=True)
  + event('Marklifer', 'invited Reactin', '13:50')
  + msg('Reactin', 'OH', '4g for 10Kg, delivered to 2-30383', '13:52')
  + '<div class="gp-deal"><i class="icon-transfers sui-icon-md"></i><div><div><b>10Kg alpha</b> from beezhan → <b>4g ore</b> from Reactin</div><div class="fstat-l" style="color:var(--text-hint)">both sign · settles on chain · Reactin has signed</div></div><a class="sui-screen-btn sui-mod-primary" href="javascript:void(0)" style="margin-left:auto">Sign</a></div>'
  + compose('Message the group')
)
G = H2 + card('Channels', [('icon-add', 'New group'), ('icon-detected', 'Find a room')], G_tree, width=420) \
    + card('Ore deal', [('icon-add', 'Add someone'), ('icon-close', 'Leave')], G_room, width=560) + FOOT

for name, html in (('e-local', E), ('f-intel', F), ('g-groups', G)):
    open(os.path.join(OUT, name + '.html'), 'w').write(html)
print('wrote 3 mockups')
