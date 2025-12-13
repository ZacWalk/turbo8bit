# Copilot Instructions

You are an expert software engineer who prioritizes **Theory Building** and **Design for Change**. Your goal is to write code that is not just syntactically correct, but creates a clear, shared mental model for both human developers and future AI agents.

This project is **Turbo8bit** - a Python Google App Engine website celebrating the Commodore 64. It is hosted at turbo8bit.com.

The site features interactive C64 history, hardware documentation, a SID chip player, memory map explorer, and an in-browser C64 emulator.

## Tech Stack
- **Backend**: Python 3.10, Flask, Google App Engine Standard Environment
- **Frontend**: Vanilla JavaScript (ES6 modules), CSS3
- **Audio**: Custom SID chip emulator
- **Testing**: pytest, py_mini_racer (runs JS in Python for testing)

## Coding Style
- Follow PEP 8 guidelines for Python
- Use descriptive variable names
- Prefer simple, readable code over complex one-liners
- JavaScript uses ES6 modules with explicit imports/exports

## Project Structure

```
├── dd.ps1                  # CLI tool: run, deploy, test, gen, format
├── web/                    # Flask application
│   ├── main.py             # Routes and Flask app
│   ├── app.yaml            # Google App Engine configuration
│   ├── requirements.txt    # Python dependencies
│   ├── templates/          # Jinja2 templates
│   │   ├── base.html       # Base template with header/footer
│   │   ├── index.html      # C64 timeline homepage
│   │   ├── c64.html        # C64 emulator page
│   │   ├── hardware.html   # Hardware block diagram
│   │   ├── memmap.html     # Memory map explorer
│   │   ├── sid.html        # SID chip info and player
│   │   ├── library.html    # PDF book library
│   │   └── about.html      # About page
│   └── static/
│       ├── css/style.css   # C64-themed retro styles
│       ├── js/
│       │   ├── timeline.js # Timeline scrolling and effects
│       │   ├── hardware.js # Hardware diagram interactions
│       │   ├── memmap.js   # Memory map explorer
│       │   ├── covers.js   # Cover sprite sheet data
│       │   ├── sprites.js  # Sprite sheet handling
│       │   └── emulator/   # C64 & SID emulator modules (ES6)
│       │       ├── emulator.js         # C64Emulator UI (entry point for index.html)
│       │       ├── sid-player.js       # SIDPlayer class (entry point for sid.html)
│       │       ├── machine.js          # C64Machine + clock constants
│       │       ├── mos6510.js          # 6510 CPU emulator
│       │       ├── roms.js             # C64 ROM data (BASIC, KERNAL, CHARS)
│       │       ├── sid.js              # SID chip + DAC emulation
│       │       ├── psid-driver.js      # PSID driver installation
│       │       ├── voice.js            # Voice + envelope + waveform generators
│       │       ├── filter.js           # SID filter + external filter
│       │       ├── vic-ii.js           # VIC-II graphics rendering (5 display modes)
│       │       ├── cartridge.js        # CRT cartridge format + bank switching
│       │       └── editor.js           # Syntax-highlighted code editor
│       ├── sid/            # SID music files (.sid format)
│       ├── pdf/            # C64 programming books (PDF)
│       └── screenshots/    # Cover images
├── raw-images/             # Source images for cover generation
├── tools/                  # CLI utilities
│   ├── build_covers.py     # Generate cover sprite sheets
│   ├── entities.py         # Data management CLI
│   ├── fetch_wiki_data.py  # Wikipedia data fetcher
│   ├── populate_entities.py
│   ├── parse_memmap.py     # Memory map parser
│   ├── update_things.py
│   └── wiki.py             # Wikipedia helper
└── tests/                  # Test suite (pytest + py_mini_racer)
    ├── conftest.py         # Shared fixtures
    ├── test_sid_load.py    # SID file loading tests
    ├── test_sid_*.py       # Various SID tests
    ├── test_giana_*.py     # Great Giana Sisters specific tests
    └── test_*.py           # Other JavaScript tests
```

## CLI Tool (dd.ps1)
- `.\dd.ps1 run` - Start local dev server at http://localhost:8082
- `.\dd.ps1 test` - Run all tests using pytest
- `.\dd.ps1 deploy` - Deploy to Google App Engine
- `.\dd.ps1 gen` - Generate cover sprites from raw-images/
- `.\dd.ps1 format` - Format Python files with Black
- `.\dd.ps1 help` - Show all commands

## Routes
- `/` - C64 timeline homepage
- `/c64` - Interactive C64 emulator
- `/hardware` - C64 hardware block diagram
- `/memmap` - Memory map explorer
- `/sid` - SID chip information and music player
- `/library` - PDF book library
- `/about` - About page

## Testing Strategy

Tests use **py_mini_racer** to run JavaScript code in Python. This allows testing the C64 emulator, SID chip, CPU emulation, and audio generation without a browser.

```python
from py_mini_racer import MiniRacer

ctx = MiniRacer()
ctx.eval("// JavaScript code here")
```

Key test areas:
- **C64 Emulator**: Startup sequence, READY prompt, BASIC program execution
- **SID file parsing**: Verify PSID/RSID files parse correctly
- **Player initialization**: Test tune loading and CPU setup
- **Audio generation**: Verify samples are generated correctly
- **CPU emulation**: Test 6510 instruction execution

Run tests:
```powershell
.\dd.ps1 test
```

## Emulator Architecture

The C64 emulator uses a unified Bus interface architecture:

```
C64Emulator (UI layer)
    ├── Web Audio API (ScriptProcessorNode)
    ├── Canvas rendering (384x272)
    └── Keyboard input handling
           │
           ▼
C64Machine (Bus interface: read/write methods)
    ├── MOS6510 CPU (cycle-exact 6502/6510)
    ├── SID chip (MOS6581/MOS8580 audio)
    ├── 64KB RAM
    ├── ROM mapping (BASIC $A000, KERNAL $E000)
    └── I/O mapping (VIC-II $D000, SID $D400, CIA $DC00)
```

### Key Modules

| Module | Purpose |
|--------|---------|
| `emulator.js` | C64Emulator UI - entry point for index.html (canvas, keyboard, audio) |
| `sid-player.js` | SIDPlayer class - entry point for sid.html (SID file playback) |
| `machine.js` | C64Machine (motherboard/Bus) + CLOCK_PAL/CLOCK_NTSC constants |
| `mos6510.js` | Cycle-exact CPU accepting Bus interface |
| `roms.js` | BASIC, KERNAL, and Character ROM data |
| `sid.js` | SID chip emulation + DAC modeling |
| `voice.js` | Voice, envelope generator, waveform generator |
| `filter.js` | SID filter (6581/8580) + external filter |
| `psid-driver.js` | PSID driver installation for SID playback |
| `vic-ii.js` | VIC-II graphics rendering (all 5 display modes) |
| `cartridge.js` | CRT cartridge format support with bank switching |
| `editor.js` | Syntax-highlighted code editor for BASIC and Assembly |

## Development Setup

```powershell
# Create virtual environment
python -m venv .venv
.\.venv\Scripts\Activate.ps1

# Install dependencies
pip install -r web/requirements.txt
pip install pytest py_mini_racer

# Run locally
.\dd.ps1 run
```

## UI/UX Design Philosophy

### Two-Panel Workspace Layout

All interactive screens follow a consistent **two-panel layout** pattern for a unified user experience:

```
┌─────────────────────────────────────────────────────────────────┐
│  HEADER (navigation)                                            │
├──────────────────────────┬──────────────────────────────────────┤
│                          │                                      │
│   PRIMARY PANEL (50%)    │      SECONDARY PANEL (50%)           │
│   - Main visualization   │      - Controls & configuration      │
│   - Interactive element  │      - Code editor / selector        │
│   - Monitor display      │      - Real-time feedback            │
│                          │                                      │
│   (fills vertical space) │      (fills vertical space)          │
│                          │                                      │
├──────────────────────────┴──────────────────────────────────────┤
│  INFORMATION SECTION (multi-column, scrollable)                 │
│  - Reference documentation                                      │
│  - Quick-start guides                                           │
│  - Detailed explanations                                        │
└─────────────────────────────────────────────────────────────────┘
```

### Screen Layouts

| Route | Primary Panel | Secondary Panel | Info Section |
|-------|--------------|-----------------|--------------|
| `/` (BASIC) | C64 Emulator screen | BASIC code editor | BASIC Quick Start |
| `/asm` | C64 Emulator + registers | Assembly editor | 6502 Quick Start |
| `/hardware` | Bus simulation canvas | Scenario controls + log | Chip reference cards |
| `/memmap` | Banking controls + legend | Memory map table | Memory regions guide |
| `/sid` | Voice visualizer + filter | Song selector + registers | SID chip documentation |

### CSS Classes

Use these unified layout classes for consistency:

```css
.workspace              /* Main two-panel container (flex, fills height) */
.workspace-primary      /* Left panel (flex: 1, 50%) */
.workspace-secondary    /* Right panel (flex: 1, 50%) */
.panel-content          /* Inner panel wrapper (border, padding) */
.panel-header           /* Title and controls bar */
.panel-body             /* Scrollable content area */
.panel-footer           /* Controls below content */
.info-section-below     /* Information section after workspace */
.info-columns           /* Multi-column grid (auto-fit, min 300px) */
.info-column            /* Single column in info grid */
```

### Responsive Behavior

- **Desktop (>1024px)**: Two panels side-by-side, 50/50 split
- **Tablet/Mobile (<1024px)**: Panels stack vertically
- **Information section**: Columns collapse to single column on narrow screens

### Design Principles

1. **Consistency**: Every screen follows the same layout pattern
2. **Information Hierarchy**: Main interaction above, reference below
3. **Responsive**: Works on all screen sizes
4. **C64 Aesthetic**: Retro color palette (blue background, cyan/yellow accents)
5. **Discoverability**: Quick-start guides always visible below main workspace
