#!/usr/bin/env python3
"""Four paradigm mockups for how talk and game could sit together, drawn with
the game's own components (SUI panel/screen/nav, the shared chat rows, the
Terminal card frame, pfp layers). Static: no JS, real class names only."""
import os
B = 'http://127.0.0.1:8421/board/'
OUT = os.path.dirname(os.path.abspath(__file__))

HEAD = f'''<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="{B}css/normalize.css">
<link rel="stylesheet" href="{B}css/structicons.css">
<link rel="stylesheet" href="{B}css/sui/sui.css">
<link rel="stylesheet" href="{B}css/main.css">
<link rel="stylesheet" href="{B}chat-rows.css">
<link rel="stylesheet" href="{B}playercard.css">
<link rel="stylesheet" href="board-inline.rebased.css">
<style>
  body {{ background: var(--page-background); margin: 0; text-align: left; }}
  #board-layout {{ display: flex; gap: var(--spacing-md); padding: var(--spacing-md); align-items: flex-start; }}
  #board-layout .tm-card {{ flex: 0 0 auto; }}
  #board-layout .tm-card .tm-body {{ max-height: none; }}
  .mk-portrait {{ position: relative; width: 32px; height: 32px; flex: 0 0 32px; overflow: hidden; }}
  .mk-portrait img {{ position: absolute; inset: 0; width: 100%; height: 100%; }}
  .mk-row {{ display: flex; gap: var(--spacing-sm); align-items: center; }}
  .mk-stat {{ display: flex; gap: var(--spacing-lg); align-items: baseline; padding: var(--spacing-sm) 0; border-bottom: thin solid var(--border-subtle); }}
  .mk-stat b {{ font-size: inherit; }}
  .mk-caption {{ padding: var(--spacing-xs) 0; color: var(--text-hint); }}
  .mk-tag {{ color: var(--text-hint); min-width: 3.5em; display: inline-block; }}
  .mk-tag.is-war {{ color: var(--text-enemy-primary); }}
  .mk-tag.is-said {{ color: var(--text-player-primary); }}
  .mk-line {{ display: flex; gap: var(--spacing-sm); padding: 2px 0; align-items: baseline; }}
  .mk-line .t {{ color: var(--text-hint); flex: 0 0 3em; }}
  .mk-line .s {{ flex: 0 0 8em; }}
  .mk-line a {{ color: var(--text-player-primary); }}
  .mk-stage {{ position: relative; height: 300px; background: var(--surface-default); border: thin solid var(--border-subtle); overflow: hidden; }}
  .mk-ambit {{ position: absolute; left: 0; right: 0; height: 25%; border-bottom: thin dashed var(--border-subtle); }}
  .mk-ambit span {{ position: absolute; left: var(--spacing-sm); top: var(--spacing-xs); color: var(--text-hint); }}
  .mk-struct {{ position: absolute; width: 64px; }}
  .mk-bubble {{ position: absolute; max-width: 260px; }}
  .mk-eyes {{ position: absolute; display: flex; gap: 2px; align-items: center; }}
  .mk-eyes .mk-portrait {{ width: 20px; height: 20px; flex-basis: 20px; }}
  .mk-prompt {{ display: flex; gap: var(--spacing-sm); align-items: center; padding: var(--spacing-sm); background: var(--surface-default); border: thin solid var(--border-strong); }}
  .mk-prompt .caret {{ color: var(--accent-primary); }}
  .mk-prompt input {{ flex: 1; background: transparent; border: 0; color: var(--text-body); font: inherit; outline: 0; }}
  .mk-menu {{ border: thin solid var(--border-subtle); background: var(--surface-panel); }}
  .mk-menu div {{ padding: var(--spacing-xs) var(--spacing-sm); }}
  .mk-menu div.is-on {{ background: var(--accent-primary); color: var(--page-background); }}
</style></head><body><div id="board-layout">'''
FOOT = '</div></body></html>'

PFP = {
  'Marklifer': dict(head=49, neck=9, body=9, arms=26, background=6),
  'Reactin': dict(head=50, neck=5, body=13, arms=7, background=1),
  'chatrbocks': dict(arms=9, body=35, head=17, neck=4, background=5),
  'beezhan': dict(head=3, neck=6, body=10, arms=12, background=2),
  'worker12': dict(head=40, neck=3, body=25, arms=27, background=6),
}
def portrait(name):
    a = PFP[name]
    layers = ''.join(f'<img src="{B}img/pfp/{p}/pfp_{p}_{a[p]}.png" alt="">' for p in ('background', 'arms', 'body', 'neck', 'head'))
    return f'<span class="mk-portrait">{layers}</span>'

def card(title, doors, body, w='tm-w3', width=None, extra=''):
    style = f' style="width:{width}px"' if width else ''
    ds = ''.join(f'<a class="tm-door tm-door-own" href="javascript:void(0)" title="{t}"><i class="{i} sui-icon-sm"></i></a>' for i, t in doors)
    return f'''<div class="sui-panel sui-theme-player tm-card {w} tm-h-grow {extra}"{style}>
<div class="sui-panel-top-fill-background"></div><div class="sui-panel-bottom-fill-background"></div><div class="sui-panel-edge-left"></div>
<div class="sui-panel-chunk sui-mod-grow sui-mod-shrink tm-chunk">
<div class="sui-screen sui-screen-full-width tm-head-screen"><div class="sui-screen-nav tm-head"><div class="sui-screen-nav-items"><span class="sui-screen-nav-item sui-mod-header sui-mod-active tm-title">{title}</span></div><span class="tm-age fstat-l">now</span><span class="tm-doors">{ds}</span></div></div>
<div class="sui-screen sui-screen-full-width sui-screen-shrink tm-body-screen"><div class="sui-page-body-screen tm-body">{body}</div></div>
</div><div class="sui-panel-edge-right"></div></div>'''

def msg(name, tag, text, t, self_=False, reply=None):
    q = f'<a class="chat-reply-quote"><span class="chat-reply-who">{reply[0]}</span><span class="chat-reply-text">{reply[1]}</span></a>' if reply else ''
    return f'''<div class="chat-msg{' is-self' if self_ else ''}"><div class="chat-msg-head"><div class="chat-msg-sender{' chat-mod-self' if self_ else ''}"><span class="chat-msg-tag">[{tag}]</span><span>{name}</span></div><div class="chat-msg-meta"><div class="chat-msg-time">{t}</div></div></div>{q}<div class="chat-msg-body">{text}</div></div>'''

def event(who, what, t):
    return f'<div class="chat-event"><span class="chat-event-who">{who}</span><span class="chat-event-what">{what}</span><span class="chat-event-time">{t}</span></div>'

def compose(placeholder):
    return f'''<div class="cm-compose"><div class="chat-composer-panel mk-row" style="padding:var(--spacing-sm)">{portrait('Marklifer')}<label class="sui-input-text" style="flex:1;min-width:0"><input type="text" placeholder="{placeholder}"></label><a class="sui-screen-btn sui-mod-primary" href="javascript:void(0)"><i class="icon-send-alpha sui-icon-md"></i></a></div></div>'''

def cap(text):
    return f'<div class="tm-cap fstat-l mk-caption">{text}</div>'

# ── A. Subject: talk lives on the thing ──────────────────────────────────────
A_body = (
  '<div class="mk-stat fstat-l"><span><b>125</b> shield</span><span><b>5g</b> ore</span><span><b>3</b> structs</span><span>[OH] 1-54 owns it</span><span>2 fleets here</span></div>'
  + '<div class="cm-timeline" style="max-height:none">'
  + event('[SN] worker12', 'fleet 9-2034 arrived at 2-21411', '13:41')
  + msg('Reactin', 'OH', 'they brought a cruiser. water ambit, we have nothing that reaches water', '13:42')
  + event('[SN] worker12', 'raid on 2-21411 — shield 100% → 61%', '13:44')
  + msg('Marklifer', 'OH', 'moving 9-194 in. two blocks.', '13:44', self_=True)
  + event('chain', 'shield 61% → 24%', '13:45')
  + msg('Reactin', 'OH', 'go now or it is gone', '13:45', reply=('Marklifer', 'moving 9-194 in. two blocks.'))
  + event('Marklifer', 'fleet 9-194 arrived · defending', '13:46')
  + event('chain', 'raid on 2-21411 — attacker defeated', '13:47')
  + msg('chatrbocks', 'OH', 'ha. that cruiser is scrap', '13:47')
  + '</div>'
  + compose('Say something about 2-21411')
)
A_side = (
  cap('what is waiting for you')
  + '<div class="cm-room is-mention"><div class="mk-row">' + portrait('Reactin') + '<div><div><span class="cm-room-name">Reactin</span> <span class="cm-badge is-mention">YOU</span></div><div class="cm-room-sub fstat-l">at 2-21411 · “go now or it is gone”</div></div></div></div>'
  + '<div class="cm-room is-unread"><div class="mk-row">' + portrait('beezhan') + '<div><div><span class="cm-room-name">beezhan</span> <span class="cm-badge">2</span></div><div class="cm-room-sub fstat-l">direct · “are you selling ore”</div></div></div></div>'
  + '<div class="cm-room"><div class="mk-row"><i class="icon-guild-directory sui-icon-md"></i><div><div><span class="cm-room-name">Fleet 9-3076</span></div><div class="cm-room-sub fstat-l">invited you · Orbital Hydro</div></div></div></div>'
  + cap('where people are talking')
  + '<div class="cm-room"><div class="mk-row"><i class="icon-planet sui-icon-md"></i><div><div><span class="cm-room-name">Planet 2-15361</span></div><div class="cm-room-sub fstat-l">6 said in the last hour · raid live</div></div></div></div>'
  + '<div class="cm-room"><div class="mk-row"><i class="icon-guild-directory sui-icon-md"></i><div><div><span class="cm-room-name">Orbital Hydro</span></div><div class="cm-room-sub fstat-l">3 here · quiet</div></div></div></div>'
)
A = HEAD + card('Planet 2-21411', [('icon-member', 'Who is here'), ('icon-alert', 'Mentions only'), ('icon-link-out', 'Open on the map')], A_body, width=640) \
    + card('Signals', [('icon-okay', 'Mark all read')], A_side, w='tm-w1', width=330) + FOOT

# ── B. Wire: one stream, said and done interleaved ───────────────────────────
def wire(t, tag, subject, text, war=False, said=False):
    cls = 'mk-tag' + (' is-war' if war else '') + (' is-said' if said else '')
    return f'<div class="mk-line"><span class="t fstat-l">{t}</span><span class="{cls} fstat-l">{tag}</span><span class="s"><a href="javascript:void(0)">{subject}</a></span><span>{text}</span></div>'
B_body = (
  '<div class="sui-screen-nav" style="margin-bottom:var(--spacing-sm)"><div class="sui-screen-nav-items">'
  + '<span class="sui-screen-nav-item sui-mod-active">everything</span><span class="sui-screen-nav-item">mine</span><span class="sui-screen-nav-item">war</span><span class="sui-screen-nav-item">people</span><span class="sui-screen-nav-item">guild</span></div></div>'
  + wire('13:47', 'RAID', '2-21411', 'attacker defeated — [SN] worker12 loses fleet 9-2034', war=True)
  + wire('13:47', 'SAID', 'chatrbocks', 'ha. that cruiser is scrap', said=True)
  + wire('13:46', 'MOVED', '9-194', 'arrived at 2-21411 · defending')
  + wire('13:45', 'SAID', 'Reactin', '↳ go now or it is gone', said=True)
  + wire('13:45', 'SHIELD', '2-21411', '61% → 24%', war=True)
  + wire('13:44', 'SAID', 'you', 'moving 9-194 in. two blocks.', said=True)
  + wire('13:44', 'RAID', '2-21411', 'begins — [SN] worker12 with a cruiser, water', war=True)
  + wire('13:41', 'SENT', '1-194 → 1-271', '10Kg alpha')
  + wire('13:40', 'BUILT', '2-21740', 'ore bunker · land slot 2')
  + wire('13:38', 'SAID', 'beezhan', '→ you: are you selling ore', said=True)
  + wire('13:31', 'MINED', '2-21740', '+2g · refined 1g')
  + wire('13:30', 'SAID', 'Reactin', 'at 2-15361: that one is ours by dinner', said=True)
  + '<div class="chat-new" role="separator"><span class="fstat-l">seen up to here</span></div>'
  + wire('13:12', 'RAID', '2-15361', 'attacker defeated', war=True)
  + compose('Say it on the wire — about 2-21411')
)
Bm = HEAD + card('Wire', [('icon-detected', 'Find'), ('icon-alert', 'Only what names you')], B_body, width=820) + FOOT

# ── C. Line: the Terminal's own scrollback ───────────────────────────────────
def line(text, kind=''):
    return f'<div class="mk-line {kind}">{text}</div>'
C_body = (
  line('<span class="t fstat-l">13:44</span><span style="color:var(--accent-primary)">&gt; ROOM 2-21411</span>')
  + line('<span class="t"></span><span class="fstat-l">Planet 2-21411 · [OH] 1-54 · shield 61% · 2 fleets here · 4 in the conversation</span>')
  + line('<span class="t fstat-l">13:44</span><span class="s">[OH] Reactin</span><span><a>2-21411</a> › they brought a cruiser. water ambit.</span>')
  + line('<span class="t fstat-l">13:44</span><span style="color:var(--accent-primary)">&gt; SAY 2-21411 moving 9-194 in. two blocks.</span>')
  + line('<span class="t fstat-l">13:44</span><span class="s">you</span><span><a>2-21411</a> › moving 9-194 in. two blocks.</span>')
  + line('<span class="t fstat-l">13:45</span><span class="s fstat-l" style="color:var(--text-enemy-primary)">chain</span><span><a>2-21411</a> shield 61% → 24%</span>')
  + line('<span class="t fstat-l">13:45</span><span class="s">[OH] Reactin</span><span><a>2-21411</a> › go now or it is gone</span>')
  + line('<span class="t fstat-l">13:46</span><span style="color:var(--accent-primary)">&gt; STAGE 9-194 2-21411</span>')
  + line('<span class="t"></span><span class="fstat-l">fleet 9-194 → 2-21411 · signed · 2 blocks</span>')
  + line('<span class="t fstat-l">13:47</span><span class="s fstat-l">chain</span><span><a>2-21411</a> attacker defeated</span>')
  + line('<span class="t fstat-l">13:47</span><span class="s">[OH] chatrbocks</span><span><a>2-21411</a> › ha. that cruiser is scrap</span>')
  + line('<span class="t fstat-l">13:48</span><span class="s">[SN] beezhan</span><span><a>you</a> › are you selling ore</span>', 'is-unread')
  + '<div class="mk-prompt" style="margin-top:var(--spacing-md)"><span class="caret">&gt;</span><input value="SAY beezhan not this week"></div>'
  + '<div class="mk-menu fstat-l"><div class="is-on">SAY beezhan … · direct, 1-471</div><div>SAY 2-21411 … · the planet, 4 listening</div><div>SAY … · where you last spoke: 2-21411</div></div>'
  + cap('1 line names you · 2 unread · Esc clears')
)
Cm = HEAD + card('Terminal', [('icon-detected', 'Find'), ('icon-alert', 'Only what names you')], C_body, width=820) + FOOT

# ── D. Local: at the object, on the map ──────────────────────────────────────
D_body = (
  '<div class="mk-stage">'
  + '<div class="mk-ambit" style="top:0"><span class="fstat-l"><i class="sui-icon sui-icon-space sui-icon-sm"></i> space</span></div>'
  + '<div class="mk-ambit" style="top:25%"><span class="fstat-l"><i class="sui-icon sui-icon-air sui-icon-sm"></i> air</span></div>'
  + '<div class="mk-ambit" style="top:50%"><span class="fstat-l"><i class="sui-icon sui-icon-land sui-icon-sm"></i> land</span></div>'
  + '<div class="mk-ambit" style="top:75%;border:0"><span class="fstat-l"><i class="sui-icon sui-icon-water sui-icon-sm"></i> water</span></div>'
  + f'<img class="mk-struct" src="{B}img/structs/cmd-ship/cmd-ship-struct-base.png" style="left:120px;top:14px">'
  + f'<img class="mk-struct" src="{B}img/structs/cruiser/cruiser-struct-base.png" style="left:560px;top:230px">'
  + f'<img class="mk-struct" src="{B}img/structs/ore-bunker/ore-bunker-struct-base.png" style="left:300px;top:160px">'
  + '<div class="mk-eyes" style="left:110px;top:88px">' + portrait('Marklifer') + portrait('Reactin') + portrait('chatrbocks') + '<span class="fstat-l" style="margin-left:4px">3 watching</span></div>'
  + '<div class="mk-eyes" style="left:556px;top:206px">' + portrait('worker12') + '<span class="fstat-l" style="margin-left:4px;color:var(--text-enemy-primary)">[SN] worker12 · here</span></div>'
  + '<div class="mk-bubble" style="left:200px;top:40px">' + msg('Reactin', 'OH', 'go now or it is gone', '13:45') + '</div>'
  + '<div class="mk-bubble" style="left:380px;top:250px">' + msg('worker12', 'SN', 'gg', '13:47') + '</div>'
  + '</div>'
  + '<div class="mk-stat fstat-l"><span><b>2-21411</b> · raid live</span><span>shield <b>24%</b></span><span>[OH] 1-54 defends</span><span>[SN] worker12 attacks</span><span>3 of yours watching</span></div>'
  + compose('Say it here — everyone at 2-21411 hears')
)
Dm = HEAD + card('Raid · 2-21411', [('icon-member', 'Who is watching'), ('icon-alert', 'Mentions only')], D_body, width=760) + FOOT

for name, html in (('a-subject', A), ('b-wire', Bm), ('c-line', Cm), ('d-local', Dm)):
    open(os.path.join(OUT, name + '.html'), 'w').write(html)
print('wrote 4 mockups')
