# Agent instructions

**Turbo8bit** — a Flask site on Google App Engine that teaches the Commodore 64,
built around a C64 emulator written from scratch in JavaScript. Hosted at
turbo8bit.com.

Prioritise **theory building** and **design for change**: the code should leave a
clear, shared mental model for the next human or agent to read it.

See [README.md](README.md) for the feature list, module table and setup. This
file covers what is *not* obvious from reading the code.

## Tech stack

- **Backend**: Python 3.10, Flask, App Engine Standard
- **Frontend**: vanilla ES6 modules, no build step, no framework, no bundler
- **Tests**: pytest driving the emulator's JavaScript through py_mini_racer

There is deliberately no npm, no transpiler and no build artifact — the browser
loads the modules exactly as they are written on disk. Three third-party
resources are loaded from the network and that is the whole list: Three.js (via
an import map in `hardware.html` and `sid.html`), Google Sign-In, and two Google
Fonts. Keep it that way.

## Commands

```powershell
.\dd.ps1 run             # dev server on http://localhost:8082
.\dd.ps1 test            # pytest; baseline is 476 passed, 25 skipped, 0 failed
.\dd.ps1 format          # Black (-Check to report without rewriting)
.\dd.ps1 deploy          # App Engine (project is hard-pinned inside dd.ps1)
.\dd.ps1 gen             # regenerate favicons + OG image
.\dd.ps1 crt             # publish CRT cartridges to Cloud Storage
```

The 25 skips are cartridge tests whose CRT dumps are not in the repo. The suite
collects 501 cases: the original 107 plus 394 review regressions. Investigate
unexpected drops in collection, and update this baseline when adding tests.

## Layout

```
dd.ps1                        # the only entry point for run/test/deploy/gen/crt/format
memory-map.txt                # source data for tools/parse_memmap.py
web/
  main.py                     # routes, SEO, Google auth, SITE_PAGES
  app.yaml                    # App Engine config; includes the git-ignored secrets.yaml
  templates/                  # base.html shell + one template per route
  static/
    css/style.css             # every style on the site, single file
    basic/  assembly/         # sample programs + index.json manifests
    sid/                      # .sid tunes
    js/
      examples.js             # sample picker shared by / and /asm
      hardware.js chip3d.js   # bus simulation canvas + Three.js DIP renderer
      memmap.js               # memory map explorer
      memmap-data.json        # generated annotations; only /memmap loads it
      emulator/               # the C64 emulator (see README for the module table)
tools/                        # gen_favicons.py, parse_memmap.py
tests/                        # pytest + py_mini_racer, helpers in tests/js/
```

Routes, nav labels and sitemap entries all come from `SITE_PAGES` in
[web/main.py](web/main.py) — add a page there and the nav and sitemap follow.

## Emulator invariants

These are load-bearing and easy to break.

**Everything goes through the bus.** `C64Machine.read(addr)` / `.write(addr, val)`
is the single place banking, I/O and cartridge mapping are decided. Indexing
`machine.ram` directly bypasses banking and makes ROM and I/O look like zeroed
RAM (`$E5CD: 00 BRK` instead of real KERNAL code).

**Display reads use `peek()`, not `read()`.** A real read has side effects: it
clears the sprite collision latches and the CIA interrupt registers, and can
bank-switch a cartridge. `machine.peek(addr)` makes the same banking decision
without them, and is what disassembly, hex dumps and step-over detection must
use — otherwise inspecting memory silently eats the running program's pending
interrupts.

**RAM is not a register mirror.** `machine.ram` holds physical RAM, including
the RAM underneath I/O. VIC/CIA registers and color RAM live separately.
Use `peek()` for a banking-aware CPU view, `peekIO()` for explicit chip-state
inspection, and `writeIO()` only for host-side hardware setup independent of
CPU banking. Emulated CPU stores still go through `write()`.

**Audio flows one way.** `machine.runFrame(buf)` is the only correct audio path:
it interleaves `sid.clock()` with CPU execution once per scanline so
cycle-timestamped SID writes land in the right place, and reports the sample
count in `machine.audioSamplesGenerated`. `C64Emulator` moves those samples into
a ring buffer that Web Audio drains. `SIDPlayer` services audio requests from
complete frames using a sample FIFO, retaining the unused tail for the next
request. Initialization and visualization also clock complete buffered frames,
discarding their output when appropriate. Never clock SID again after
`runFrame(buf)`. `machine.generateAudio()` exists only for isolated tests.
Worklet delivery is request-driven even at startup; an unsolicited priming
block breaks pending-request accounting and can evict valid queued samples.

**A muted machine still needs its SID drained.** When `audioEnabled` is false
nothing clocks the SID, so `runFrame` calls `sid.applyPendingWrites()`. Without
it the write queue grows without bound.

**Two separate keyboard paths, never mixed.**
- Physical keys → `machine.setKey(row, col, pressed)`, the real 8×8 matrix. The
  KERNAL's scan routine does the PETSCII conversion, which is what makes shifted
  characters, key repeat and games that read the matrix directly all work.
- Synthetic typing → `machine.addKey(petscii)`, injected straight into the KERNAL
  buffer at `$0277`.

Driving the same keystroke through both produces duplicate characters, because
the KERNAL scan would inject the matrix key on top of the one you buffered.

**Only `updateShiftKey()` may touch matrix position [1,7].** A PC and a C64 put
SHIFT in different places: `*` is SHIFT+8 on a PC but an unshifted C64 key, while
`'` is unshifted on a PC and SHIFT+7 on a C64. So each mapping entry declares
whether it needs the C64 SHIFT on, off, or inherited from the physical key, and
one function resolves them. Letting a key press [1,7] itself desyncs the moment
two shifted keys overlap or the OS repeats a keydown.

**The KERNAL scans the matrix once per frame (~20ms).** A keypress whose down and
up both land inside one frame is invisible to it, so `C64Emulator` defers such
releases until a frame has run. Anything else that pokes the matrix needs the
same treatment.

**Key identity is physical; character mapping is logical.** Use `event.code`
to pair keydown/keyup, with `event.key` only as a fallback. Releasing Shift can
change `event.key` before the character key is released. Native page controls
must keep their keyboard events; only keys actually captured by the emulator
should have their releases consumed.

**Wait for cold boot before loading lab programs.** `whenBasicReady()` observes
the empty BASIC pointers and `READY.` screen codes after completed frames.
It is a latched fresh-boot signal, not a detector for arbitrary program
completion. Resets/cartridge changes invalidate pending requests. Assembly
Stop uses `resetToBasic()` because arbitrary code can halt the CPU or replace
banking and interrupt state; a normal RTS must not take that reset path.
Numbered BASIC editor loads also reset first. A wall-clock delay after
`pressStop()` is not a reliable way to stop code: it depends on later emulated
frames and functioning KERNAL interrupts. The screen RUN command and direct
typing deliberately retain machine state.
Page controllers clear stale debug metadata through `C64Emulator.onReset`, so
cartridge resets and explicit reset buttons follow the same cleanup path.

**A stack change is not a subroutine return.** Both debugger controllers use
`isTopLevelRTS()` to check the fetched opcode, entry stack depth and actual
two-byte pop. TXS or an interrupt that preempts an RTS must not end stepping.
The Assembly page additionally checks its known BASIC return address.

**The VIC-II renders per scanline, not per frame.** `runFrame` renders the
*previous* line on each line transition, which gives a raster IRQ handler its
full ~63 cycles to change registers first. Batch-rendering a whole frame would
break every split-screen effect.

**A Bad Line stalls the CPU, not machine time.** CIA timers and the raster clock
still advance during stolen cycles. Instruction overshoot carries into the next
frame budget instead of being discarded.
Raster timing follows the selected clock standard: PAL is 63 cycles x 312
lines, NTSC is 65 x 263. Frame budgets and raster-register reads must agree.

**Sprite collision registers `$D01E`/`$D01F` clear on read.** They are latches;
the renderer accumulates into them and `readVIC` resets them.

## Testing

Tests execute the emulator's JavaScript in Python via py_mini_racer, so no
browser is needed:

```python
from py_mini_racer import MiniRacer
ctx = MiniRacer()
ctx.eval("// JavaScript here")
```

The test harness shims a `window` object. That means browser globals in hot paths
compile and run under test while silently costing performance in the browser —
don't reach for `window` inside per-instruction or per-pixel code.

Covered: CPU instruction behaviour, C64 startup to the READY prompt, BASIC
tokenizing and execution, PSID/RSID parsing, SID register writes and audio
generation, CIA timer/NMI timing, and CRT cartridge loading.

To verify a change that only shows up visually, drive a real browser against
`.\dd.ps1 run` and read the screen matrix out of `machine.ram[0x0400..]`. Those
are *screen codes*, not PETSCII: 1-26 are A-Z, 32 is space, 34 is `"`.

Playwright's synthetic key events are not a faithful keyboard: `keyboard.type()`
never sends the Shift keydown that a real layout needs for `*` or `"`, and
`press('8')` with Shift held still reports `key: '8'`. To exercise the real path,
dispatch `new KeyboardEvent('keydown', { key: '*' })` at the canvas while holding
Shift. Remember to reload the page after editing a module — the browser caches it.

## Conventions

- PEP 8 for Python, Black-formatted. Descriptive names over clever one-liners.
- ES6 modules with explicit imports/exports.
- **No `console.log` on normal paths.** Loading any page should leave the console
  empty, and so should ordinary interaction. `console.warn`/`console.error` are
  for genuine failures; the only informational logs left report a dropped `.prg`
  or `.crt`, which is a deliberate user action.
- Comments say what the code cannot: an invariant, a hardware quirk, the reason
  for a constant. Not a restatement of the next line.

## UI layout

Every interactive screen is a two-panel workspace with reference material below:

```
┌──────────────────────────┬──────────────────────────────────────┐
│  PRIMARY (50%)           │  SECONDARY (50%)                     │
│  visualisation / screen  │  controls, editor, live feedback     │
├──────────────────────────┴──────────────────────────────────────┤
│  INFORMATION SECTION — reference docs, quick-start guides       │
└─────────────────────────────────────────────────────────────────┘
```

| Route | Primary | Secondary | Below |
|-------|---------|-----------|-------|
| `/` | C64 screen | BASIC editor | BASIC quick start |
| `/asm` | C64 screen + registers | Assembly editor | 6502 quick start |
| `/hardware` | Bus simulation canvas | Scenario controls + log | Chip reference cards |
| `/memmap` | Banking controls | Memory map table | Memory regions guide |
| `/sid` | Voice visualiser + filter | Song selector + registers | SID documentation |

`/` and `/asm` use the emulator-specific `.c64-page` variant; `/hardware`,
`/memmap` and `/sid` use `.workspace`. `/memmap` adds a third
`.workspace-tertiary` column for region details.

Layout classes: `.workspace`, `.workspace-primary`, `.workspace-secondary`,
`.panel-content`, `.panel-header`, `.panel-body`, `.panel-footer`,
`.info-section-below`, `.info-columns`, `.info-column`.

Panels sit side by side above 1024px and stack below it.

### Design principles

1. **Consistency** — every screen follows the same pattern.
2. **Hierarchy** — interact above, read below.
3. **C64 aesthetic** — the CSS `:root` colours mirror the C64 palette; the
   emulator's own `PALETTE` in `vic-ii.js` is the VICE table.
4. **Discoverability** — quick-start guides are always visible, never hidden
   behind a tab.
5. **Accessible** — interactive canvases carry an `aria-label` and are focusable,
   keyboard focus is always visible via `:focus-visible`, and animation respects
   `prefers-reduced-motion`.
6. **Lightweight** — no framework and no bundler. The only third-party runtime
   code is Three.js, Google Sign-In and Google Fonts, all loaded straight from
   the network. Keep it that way.
