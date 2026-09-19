"""Synthetic bus, cartridge, and instruction-level timing regressions."""

import json

import pytest

from tests.test_utils import create_crt_context, eval_json


@pytest.fixture(scope="module")
def machine_context():
    ctx = create_crt_context()
    ctx.eval(
        """
        function regressionCRT(type = 32, exrom = 1, game = 0) {
            const bytes = new Uint8Array(0x40 + 2 * (16 + 8192));
            const view = new DataView(bytes.buffer);
            Array.from('C64 CARTRIDGE   ').forEach((c, i) => {
                bytes[i] = c.charCodeAt(0);
            });
            view.setUint32(0x10, 0x40);
            view.setUint16(0x14, 0x100);
            view.setUint16(0x16, type);
            bytes[0x18] = exrom;
            bytes[0x19] = game;
            [0x8000, 0xA000].forEach((address, index) => {
                const offset = 0x40 + index * (16 + 8192);
                Array.from('CHIP').forEach((c, i) => {
                    bytes[offset + i] = c.charCodeAt(0);
                });
                view.setUint32(offset + 4, 16 + 8192);
                view.setUint16(offset + 12, address);
                view.setUint16(offset + 14, 8192);
                bytes.fill(index ? 0x5A : 0xA5, offset + 16, offset + 16 + 8192);
                if (index) {
                    bytes[offset + 16 + 0x1FFC] = 0;
                    bytes[offset + 16 + 0x1FFD] = 0xE0;
                }
            });
            return bytes.buffer;
        }

        function regressionMachine(options = {}) {
            const machine = new C64Machine({audioEnabled: false, ...options});
            machine.loadCode([0x4C, 0x00, 0x02], 0x0200);
            machine.cpu.PC = 0x0200;
            machine.cpu.P = 0x24;
            return machine;
        }
        """
    )
    return ctx


@pytest.mark.parametrize("display_enabled", [False, True])
def test_bad_line_time_reaches_vic_and_both_cias(machine_context, display_enabled):
    result = eval_json(
        machine_context,
        f"""(() => {{
            const m = regressionMachine();
            m.write(0xD011, {0x9B if display_enabled else 0x8B});
            m.write(0xD012, 44);
            m.write(0xD01A, 1);
            for (const base of [0xDC00, 0xDD00]) {{
                for (const offset of [4, 6]) {{
                    m.write(base + offset, 0xFF);
                    m.write(base + offset + 1, 0xFF);
                }}
                m.write(base + 14, 0x11);
                m.write(base + 15, 0x11);
            }}
            const elapsed = m.runFrame();
            return {{
                elapsed,
                cpuCycles: m.cpu.cycles,
                rasterCycles: m.vic.rasterCycle,
                timerCycles: [
                    65535 - m.cia1.timerACounter,
                    65535 - m.cia1.timerBCounter,
                    65535 - m.cia2.timerACounter,
                    65535 - m.cia2.timerBCounter
                ],
                rasterIRQ: !!(m.vic.irqStatus & 1)
            }};
        }})()""",
    )
    assert result["cpuCycles"] == result["elapsed"]
    assert result["timerCycles"] == [result["elapsed"]] * 4
    assert result["rasterCycles"] == result["elapsed"] % 19656
    assert result["rasterIRQ"], "A visible display must not suppress raster IRQ 300"


def test_short_cia_periods_catch_up_across_stolen_cycles(machine_context):
    result = eval_json(
        machine_context,
        """(() => {
            const m = regressionMachine();
            m.write(0xDC04, 3);
            m.write(0xDC05, 0);
            m.write(0xDC06, 20);
            m.write(0xDC07, 0);
            m.write(0xDC0E, 0x11);
            m.write(0xDC0F, 0x51);
            const underflows = m.tickCIATimer(m.cia1, 'A', 40, () => {});
            m.tickCIATimerBFromA(m.cia1, () => {}, underflows);
            return {
                underflows,
                timerA: m.cia1.timerACounter,
                timerB: m.cia1.timerBCounter
            };
        })()""",
    )
    assert result == {"underflows": 10, "timerA": 3, "timerB": 10}


def test_frame_budgets_do_not_discard_raster_overshoot(machine_context):
    result = eval_json(
        machine_context,
        """(() => {
            const m = regressionMachine();
            const elapsed = m.runFrame() + m.runFrame() + m.runFrame();
            return {elapsed, rasterCycles: m.vic.rasterCycle};
        })()""",
    )
    assert result["rasterCycles"] == result["elapsed"] % 19656


@pytest.mark.parametrize(
    ("clock", "line_cycles", "frame_cycles"),
    [("CLOCK_PAL", 63, 19656), ("CLOCK_NTSC", 65, 17095)],
)
def test_video_standard_controls_frame_budget_and_raster_reads(
    machine_context, clock, line_cycles, frame_cycles
):
    result = eval_json(
        machine_context,
        f"""(() => {{
            const m = regressionMachine({{clockFrequency: {clock}}});
            m.vic.rasterCycle = 260 * {line_cycles};
            return {{
                budget: m.cyclesPerFrame,
                low: m.peek(0xD012),
                high: m.peek(0xD011) & 0x80
            }};
        }})()""",
    )
    assert result == {"budget": frame_cycles, "low": 4, "high": 0x80}


@pytest.mark.parametrize(
    ("clock", "frame_cycles"), [("CLOCK_PAL", 19656), ("CLOCK_NTSC", 17095)]
)
def test_video_standard_wraps_single_steps_and_full_frames(
    machine_context, clock, frame_cycles
):
    result = eval_json(
        machine_context,
        f"""(() => {{
            const m = regressionMachine({{clockFrequency: {clock}}});
            m.vic.rasterCycle = {frame_cycles} - 2;
            m.step();
            const steppedRaster = m.vic.rasterCycle;
            m.reset();
            m.cpu.PC = 0x0200;
            m.loadCode([0x4C, 0, 2], 0x0200);
            const elapsed = m.runFrame() + m.runFrame();
            return {{steppedRaster, elapsed, raster: m.vic.rasterCycle}};
        }})()""",
    )
    assert result["steppedRaster"] == 1
    assert result["raster"] == result["elapsed"] % frame_cycles


def test_buffered_frame_clocks_sid_for_every_elapsed_cycle_once(machine_context):
    result = eval_json(
        machine_context,
        """(() => {
            const m = regressionMachine({audioEnabled: true});
            const buffer = new Int16Array(4096);
            let clocked = 0;
            let end = 0;
            let continuous = true;
            const clock = m.sid.clock.bind(m.sid);
            m.sid.clock = (cycles, output, start) => {
                continuous = continuous && start === end;
                end = start + cycles;
                clocked += cycles;
                return clock(cycles, output, start);
            };
            const elapsed = m.runFrame(buffer);
            return {
                elapsed, clocked, continuous, end,
                samples: m.audioSamplesGenerated, capacity: buffer.length
            };
        })()""",
    )
    assert result["elapsed"] == result["clocked"] == result["end"]
    assert result["continuous"]
    assert 0 < result["samples"] <= result["capacity"]


def test_cia2_timer_b_uses_edge_triggered_nmi(machine_context):
    result = eval_json(
        machine_context,
        """(() => {
            const m = regressionMachine({cyclesPerFrame: 30});
            let triggers = 0;
            const triggerNMI = m.cpu.triggerNMI.bind(m.cpu);
            m.cpu.triggerNMI = () => { triggers++; triggerNMI(); };
            m.write(0xDD06, 1);
            m.write(0xDD07, 0);
            m.write(0xDD0D, 0x82);
            m.write(0xDD0F, 0x19);
            m.runFrame();
            const first = {triggers, flags: m.peekIO(0xDD0D), high: m.cia2.nmiLine};
            m.updateNMI();
            const repeated = triggers;
            const acknowledged = m.read(0xDD0D);
            const released = m.cia2.nmiLine;
            m.write(0xDD0F, 0x19);
            m.cpu.PC = 0x0200;
            m.runFrame();
            return {first, repeated, acknowledged, released, triggers};
        })()""",
    )
    assert result["first"] == {"triggers": 1, "flags": 0x82, "high": False}
    assert result["repeated"] == 1
    assert result["acknowledged"] == 0x82
    assert result["released"]
    assert result["triggers"] == 2


@pytest.mark.parametrize("banked_out", [0x30, 0x33])
def test_ram_under_io_is_not_hardware_state(machine_context, banked_out):
    result = eval_json(
        machine_context,
        f"""(() => {{
            const m = regressionMachine();
            m.write(0xD020, 6);
            m.write(0xD800, 2);
            m.write(0xDD00, 3);
            m.write(1, {banked_out});
            m.write(0xD020, 0xAB);
            m.write(0xD800, 0xCD);
            m.write(0xDD00, 0);
            const hiddenRegisters = [
                m.peekIO(0xD020) & 15, m.peekIO(0xD800), m.peekIO(0xDD00) & 3
            ];
            m.write(1, 0x37);
            const visibleRegisters = [
                m.read(0xD020) & 15, m.read(0xD800), m.read(0xDD00) & 3
            ];
            const vicBank = m.vic.renderer.getMemoryAddresses(m).vicBank;
            m.write(0xD020, 7);
            m.write(0xD800, 5);
            m.write(0xDD00, 2);
            m.write(1, 0x30);
            return {{
                hiddenRegisters, visibleRegisters, vicBank,
                ram: [m.read(0xD020), m.read(0xD800), m.read(0xDD00)]
            }};
        }})()""",
    )
    assert result["hiddenRegisters"] == [6, 2, 3]
    assert result["visibleRegisters"] == [6, 2, 3]
    assert result["vicBank"] == 0
    assert result["ram"] == [0xAB, 0xCD, 0]


def test_peek_io_is_live_mirrored_and_side_effect_free(machine_context):
    result = eval_json(
        machine_context,
        """(() => {
            const m = regressionMachine();
            m.io[0x01E] = 3;
            m.cia1.icrData = 0x81;
            m.cia1.timerACounter = 0x1234;
            m.vic.rasterCycle = 300 * 63;
            m.write(0xD060, 7);
            const peek = {
                collisions: m.peek(0xD05E),
                flags: m.peek(0xDC1D),
                timerLow: m.peek(0xDC14),
                timerHigh: m.peek(0xDC15),
                rasterHigh: m.peek(0xD051) & 0x80,
                rasterLow: m.peek(0xD052),
                border: m.peek(0xD020) & 15
            };
            const beforeRead = [m.io[0x01E], m.cia1.icrData];
            const read = [m.read(0xD05E), m.read(0xDC1D)];
            m.write(1, 0x30);
            return {
                peek, beforeRead, read,
                cleared: [m.io[0x01E], m.cia1.icrData],
                physical: m.peek(0xD020),
                hardware: m.peekIO(0xD020) & 15
            };
        })()""",
    )
    assert result["peek"] == {
        "collisions": 3,
        "flags": 0x81,
        "timerLow": 0x34,
        "timerHigh": 0x12,
        "rasterHigh": 0x80,
        "rasterLow": 44,
        "border": 7,
    }
    assert result["beforeRead"] == [3, 0x81]
    assert result["read"] == [3, 0x81]
    assert result["cleared"] == [0, 0]
    assert result["physical"] == 0
    assert result["hardware"] == 7


def test_ddr_input_pins_control_cpu_banking(machine_context):
    result = eval_json(
        machine_context,
        """(() => {
            const m = regressionMachine();
            m.write(1, 0);
            m.write(0, 0);
            return {
                pins: m.read(1) & 7,
                peekPins: m.peek(1) & 7,
                basic: m.isBasicOn,
                kernal: m.isKernalOn,
                io: m.isIOOn
            };
        })()""",
    )
    assert result == {
        "pins": 7,
        "peekPins": 7,
        "basic": True,
        "kernal": True,
        "io": True,
    }


def test_explicit_hardware_writes_and_binary_loads_use_separate_stores(machine_context):
    result = eval_json(
        machine_context,
        """(() => {
            const m = regressionMachine();
            m.write(1, 0x30);
            m.writeIO(0xD020, 7);
            m.loadCode([0xAB], 0xD020);
            return {ram: m.peek(0xD020), hardware: m.peekIO(0xD020) & 15};
        })()""",
    )
    assert result == {"ram": 0xAB, "hardware": 7}


def test_sid_inspection_delegates_to_pure_device_view(machine_context):
    result = eval_json(
        machine_context,
        """(() => {
            const m = regressionMachine();
            const registers = [];
            m.sid.busValue = 0x77;
            m.sid.peek = offset => {
                registers.push(offset);
                return offset === 0x1B ? 0xA5 : 0x32;
            };
            m.write(1, 0x30);
            m.loadCode([0x31], 0xD41B);
            const ram = m.peek(0xD41B);
            const oscillator = m.peekIO(0xD41B);
            const envelope = m.peekIO(0xD41C);
            m.write(1, 0x37);
            const mirrored = m.peek(0xD47B);
            return {ram, oscillator, envelope, mirrored, registers, bus: m.sid.busValue};
        })()""",
    )
    assert result == {
        "ram": 0x31,
        "oscillator": 0xA5,
        "envelope": 0x32,
        "mirrored": 0xA5,
        "registers": [0x1B, 0x1C, 0x1B],
        "bus": 0x77,
    }


# Columns are $8000, $A000, $D000, $E000; rows are $01 bits CHAREN/HIRAM/LORAM.
# R=RAM, B=BASIC, C=character ROM, I=I/O, K=KERNAL, L/H=cartridge ROM, O=open bus.
# https://www.c64-wiki.com/wiki/Bank_Switching#Mode_Table
PLA_LAYOUTS = {
    (1, 1): ("RRRR", "RRCR", "RRCK", "RBCK", "RRRR", "RRIR", "RRIK", "RBIK"),
    (0, 1): ("RRRR", "RRCR", "RRCK", "LBCK", "RRRR", "RRIR", "RRIK", "LBIK"),
    (0, 0): ("RRRR", "RRRR", "RHCK", "LHCK", "RRRR", "RRIR", "RHIK", "LHIK"),
    (1, 0): ("LOIH",) * 8,
}


@pytest.mark.parametrize(
    "exrom,game,port,layout",
    [
        (exrom, game, port, layout)
        for (exrom, game), layouts in PLA_LAYOUTS.items()
        for port, layout in enumerate(layouts)
    ],
)
def test_cpu_pla_memory_layout(machine_context, exrom, game, port, layout):
    result = eval_json(
        machine_context,
        f"""(() => {{
            const m = regressionMachine();
            m.loadCartridge(regressionCRT(0, {exrom}, {game}));
            const addresses = [0x8000, 0xA000, 0xD000, 0xE000];
            addresses.forEach((addr, i) => m.ram[addr] = 0x11 + i);
            m.ram[0x1000] = 0x51;
            m.ram[0xC000] = 0x52;
            m.writeIO(0xD000, 0x66);
            m.write(1, {port});
            const expected = Array.from({json.dumps(layout)}, (kind, i) => {{
                const addr = addresses[i];
                switch (kind) {{
                    case 'R': return m.ram[addr];
                    case 'B': return rom_basic[addr & 0x1FFF];
                    case 'C': return rom_chars[addr & 0x0FFF];
                    case 'I': return 0x66;
                    case 'K': return rom_kernal[addr & 0x1FFF];
                    case 'L': return 0xA5;
                    case 'H': return 0x5A;
                    case 'O': return 0xFF;
                }}
            }});
            return {{
                read: addresses.map(addr => m.read(addr)),
                peek: addresses.map(addr => m.peek(addr)),
                expected,
                holes: [m.read(0x1000), m.read(0xC000)]
            }};
        }})()""",
    )
    assert result["read"] == result["expected"]
    assert result["peek"] == result["expected"]
    assert result["holes"] == (
        [0xFF, 0xFF] if (exrom, game) == (1, 0) else [0x51, 0x52]
    )


def test_cartridge_mode_changes_and_reset_rebuild_page_map(machine_context):
    result = eval_json(
        machine_context,
        """(() => {
            const m = regressionMachine();
            m.loadCartridge(regressionCRT());
            const ultimax = [m.read(0x8000), m.read(0xE000), m.cpu.PC];
            m.write(0xDE02, 7);
            const mode16K = {
                low: m.read(0x8000), high: m.read(0xA000),
                kernal: m.read(0xE000) === rom_kernal[0],
                ultimax: m.cartridge.ultimaxMode
            };
            m.write(0xDE02, 4);
            const off = {
                low: m.read(0x8000), basic: m.read(0xA000) === rom_basic[0],
                kernal: m.read(0xE000) === rom_kernal[0]
            };
            m.reset();
            const reset = [m.read(0x8000), m.read(0xE000), m.cpu.PC];
            m.write(1, 0);
            m.write(0xDE02, 7);
            return {
                ultimax, mode16K, off, reset,
                ultimaxIO: m.cartridge.easyFlashControl
            };
        })()""",
    )
    assert result["ultimax"] == [0xA5, 0x5A, 0xE000]
    assert result["mode16K"] == {
        "low": 0xA5,
        "high": 0x5A,
        "kernal": True,
        "ultimax": False,
    }
    assert result["off"] == {"low": 0, "basic": True, "kernal": True}
    assert result["reset"] == result["ultimax"]
    assert result["ultimaxIO"] == 7


def test_read_triggered_cartridge_disable_refreshes_map_without_peek_effects(
    machine_context,
):
    result = eval_json(
        machine_context,
        """(() => {
            const m = regressionMachine();
            m.loadCartridge(regressionCRT(23, 0, 0));
            m.peek(0xDF00);
            const before = [m.cartridge.enabled, m.read(0xA000)];
            m.read(0xDF00);
            const after = {
                enabled: m.cartridge.enabled,
                basic: m.read(0xA000) === rom_basic[0]
            };
            m.reset();
            return {before, after, reset: m.read(0xA000)};
        })()""",
    )
    assert result["before"] == [True, 0x5A]
    assert result["after"] == {"enabled": False, "basic": True}
    assert result["reset"] == 0x5A


def test_peek_does_not_select_cartridge_banks(machine_context):
    result = eval_json(
        machine_context,
        """(() => {
            const m = regressionMachine();
            m.loadCartridge(regressionCRT(15, 0, 1));
            m.peek(0xDE01);
            const initial = [m.cartridge.currentBank, m.read(0x8000)];
            m.read(0xDE01);
            m.peekIO(0xDE00);
            const selected = m.cartridge.currentBank;
            m.read(0xDE00);
            return {initial, selected, restored: m.read(0x8000)};
        })()""",
    )
    assert result == {"initial": [0, 0xA5], "selected": 1, "restored": 0xA5}


@pytest.mark.parametrize(
    "control,exrom,game,ultimax",
    [
        (0, 1, 0, True),
        (4, 1, 1, False),
        (5, 1, 0, True),
        (6, 0, 1, False),
        (7, 0, 0, False),
    ],
)
def test_easyflash_control_line_polarity(
    machine_context, control, exrom, game, ultimax
):
    result = eval_json(
        machine_context,
        f"""(() => {{
            const m = regressionMachine();
            m.loadCartridge(regressionCRT());
            m.write(0xDE02, {control});
            return [
                m.cartridge.exrom, m.cartridge.game, m.cartridge.ultimaxMode,
                m.cartExrom, m.cartGame
            ];
        }})()""",
    )
    assert result == [exrom, game, ultimax, bool(exrom), bool(game)]


def test_ultimax_unmapped_writes_do_not_reach_physical_ram(machine_context):
    result = eval_json(
        machine_context,
        """(() => {
            const m = regressionMachine();
            m.loadCartridge(regressionCRT());
            const addresses = [0x1000, 0x8000, 0xA000, 0xC000, 0xE000];
            addresses.forEach(addr => m.ram[addr] = 0x23);
            addresses.forEach(addr => m.write(addr, 0x45));
            return addresses.map(addr => m.ram[addr]);
        })()""",
    )
    assert result == [0x23] * 5


def test_legacy_cartridge_api_shares_mapping_without_resetting_ram(machine_context):
    result = eval_json(
        machine_context,
        """(() => {
            const m = regressionMachine();
            m.ram[0x1000] = 0x42;
            const bytes = new Uint8Array(regressionCRT(0, 0, 0));
            const padded = new Uint8Array(bytes.length + 8);
            padded.set(bytes, 4);
            const info = m.loadCrt(padded.subarray(4, padded.length - 4));
            const loaded = [m.read(0x8000), m.read(0xA000), info.chips.length];
            m.removeCartridge();
            return {
                loaded,
                basic: m.read(0xA000) === rom_basic[0],
                remaining: m.getCartridgeInfo(),
                preservedRAM: m.ram[0x1000]
            };
        })()""",
    )
    assert result["loaded"] == [0xA5, 0x5A, 2]
    assert result["basic"]
    assert result["remaining"] is None
    assert result["preservedRAM"] == 0x42
