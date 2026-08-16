//
// @fileoverview C64 Architecture Simulator - 2D hardware visualization
// @module hardware
//
// Interactive 2D visualization of Commodore 64 hardware communication.
// Shows the C64 motherboard with chips (CPU, VIC-II, SID, CIA, ROM, RAM)
// connected via address and data buses. Animated packets show data flow.
//
// Features:
// - Canvas-based 2D rendering of C64 motherboard layout
// - Animated bus signals (red = address bus, yellow = data bus)
// - Chip highlighting and interaction
// - Log panel showing operations in real-time
// - Optional 3D chip images via chip3d.js
//
// Used on the /hardware page of Turbo8bit.
// For chip rendering, see chip3d.js.
//
// @see https://www.turbo8bit.com/
//

const canvas = document.getElementById('simCanvas');
const ctx = canvas.getContext('2d');
const logPanel = document.getElementById('logPanel');

// --- Pre-rendered 3D chip images (set by module script) ---
let chipImages = {};
let chipImageOpacity = {}; // Track fade-in opacity for each chip type

// Function to set chip images from external module
window.setChipImages = function (images) {
    chipImages = images;
    // Initialize fade-in for each new image
    for (const key of Object.keys(images)) {
        if (chipImageOpacity[key] === undefined) {
            chipImageOpacity[key] = 0; // Start fully transparent
        }
    }
};

// --- Configuration ---
const COLORS = {
    bg: '#352879',           // C64 board color
    text: '#ffffff',
    addressBus: '#ff5555',   // Red
    dataBus: '#ffff55',      // Yellow
    highlight: '#ffffff',
    dimRed: '#553333',
    dimYellow: '#555533',
    wireRed: '#774444',
    wireYellow: '#777744',
    busBackground: 'rgba(0,0,0,0.2)',
    labelDim: 'rgba(255,255,255,0.3)'
};

// --- Component Layout (Short Board 250469 - matches C64C motherboard photo) ---
// Note: This board has an MMU (252535-01) that combines PLA + glue logic,
// and a Super ROM (251913-01) that combines BASIC + KERNAL + CHAROM
const components = {
    // Processor Chips (left side)
    CPU: { x: 50, y: 50, w: 120, h: 100, label1: "CPU", label2: "MOS 6510", type: "proc", chipType: "CPU_6510" },
    VIC: { x: 50, y: 200, w: 120, h: 100, label1: "VIC-II", label2: "MOS 6569", type: "proc", chipType: "VIC_6569" },
    SID: { x: 50, y: 350, w: 120, h: 80, label1: "SID", label2: "MOS 6581", type: "io", chipType: "SID_6581" },
    CIA: { x: 50, y: 460, w: 120, h: 80, label1: "CIA", label2: "MOS 6526", type: "io", chipType: "CIA_6526" },

    // The Bus is the central spine
    BUS: { x: 250, y: 40, w: 200, h: 520, label1: "SYSTEM", label2: "BUS", type: "bus" },

    // Memory/Logic Chips (right side - Short Board 250469 layout)
    MMU: { x: 550, y: 50, w: 110, h: 90, label1: "MMU", label2: "252535-01", type: "mem", chipType: "MMU" },
    ROM: { x: 550, y: 170, w: 110, h: 90, label1: "SUPER ROM", label2: "251913-01", type: "mem", chipType: "ROM_COMBINED" },
    RAM1: { x: 550, y: 300, w: 100, h: 70, label1: "DRAM U9", label2: "4464", type: "mem", chipType: "RAM_4464" },
    RAM2: { x: 550, y: 400, w: 100, h: 70, label1: "DRAM U10", label2: "4464", type: "mem", chipType: "RAM_4464" }
};

// Connections define where wires are drawn
const connections = [
    { from: 'CPU', to: 'BUS' },
    { from: 'VIC', to: 'BUS' },
    { from: 'SID', to: 'BUS' },
    { from: 'CIA', to: 'BUS' },
    { from: 'BUS', to: 'MMU' },
    { from: 'BUS', to: 'ROM' },
    { from: 'BUS', to: 'RAM1' },
    { from: 'BUS', to: 'RAM2' }
];

// --- State ---
let packets = []; // Flying dots

// --- Helper Functions ---
function log(msg) {
    const div = document.createElement('div');
    div.className = 'log-entry';
    const time = new Date().toLocaleTimeString().split(' ')[0];
    div.innerHTML = `<span class="log-time">[${time}]</span> ${msg}`;
    logPanel.appendChild(div);
    logPanel.scrollTop = logPanel.scrollHeight;
}

function clearLog() {
    logPanel.innerHTML = '';
}

// --- Drawing System ---

function drawDIPChip(comp, highlight = false) {
    const x = comp.x;
    const y = comp.y;
    const w = comp.w;
    const h = comp.h;
    const padding = 8;

    // Always draw the label first (visible immediately)
    ctx.fillStyle = COLORS.text;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.font = "bold 12px 'VT323', 'Courier New', monospace";
    ctx.fillText(comp.label1, x + w / 2, y + h + padding + 2);
    ctx.font = "10px 'VT323', 'Courier New', monospace";
    ctx.fillStyle = '#aaaaaa';
    ctx.fillText(comp.label2, x + w / 2, y + h + padding + 16);

    // Draw 3D chip image with fade-in effect when available
    if (comp.chipType && chipImages[comp.chipType]) {
        const img = chipImages[comp.chipType];

        // Update opacity for fade-in effect
        if (chipImageOpacity[comp.chipType] < 1) {
            chipImageOpacity[comp.chipType] = Math.min(1, chipImageOpacity[comp.chipType] + 0.02);
        }

        // Draw with current opacity
        ctx.save();
        ctx.globalAlpha = chipImageOpacity[comp.chipType];
        ctx.drawImage(img, x - padding, y - padding, w + padding * 2, h + padding * 2);
        ctx.restore();
    }
}

function drawBus() {
    const bus = components.BUS;

    // Background for Bus Area
    ctx.fillStyle = COLORS.busBackground;
    ctx.fillRect(bus.x, bus.y, bus.w, bus.h);

    // Draw physical lines (Address = Red, Data = Yellow)
    const spineX_Addr = bus.x + bus.w * 0.33;
    const spineX_Data = bus.x + bus.w * 0.66;

    ctx.lineWidth = 12;

    // Vertical Bus Lines
    ctx.strokeStyle = COLORS.dimRed;
    ctx.beginPath();
    ctx.moveTo(spineX_Addr, bus.y);
    ctx.lineTo(spineX_Addr, bus.y + bus.h);
    ctx.stroke();

    ctx.strokeStyle = COLORS.dimYellow;
    ctx.beginPath();
    ctx.moveTo(spineX_Data, bus.y);
    ctx.lineTo(spineX_Data, bus.y + bus.h);
    ctx.stroke();

    // Connect components to spine
    ctx.lineWidth = 6;
    connections.forEach(conn => {
        let startPt, endPtAddr, endPtData;

        if (conn.from === 'BUS') {
            // From Bus (Right side) to Memory (Left side)
            const target = components[conn.to];
            const y = target.y + target.h / 2;
            startPt = { x: target.x, y: y };
            endPtAddr = { x: spineX_Addr, y: y };
            endPtData = { x: spineX_Data, y: y };
        } else {
            // From Comp (Right side) to Bus (Left side)
            const source = components[conn.from];
            const y = source.y + source.h / 2;
            startPt = { x: source.x + source.w, y: y };
            endPtAddr = { x: spineX_Addr, y: y };
            endPtData = { x: spineX_Data, y: y };
        }

        // Draw Wire Traces
        ctx.strokeStyle = COLORS.wireRed;
        ctx.beginPath();
        ctx.moveTo(startPt.x, startPt.y - 5);
        ctx.lineTo(endPtAddr.x, endPtAddr.y - 5);
        ctx.stroke();

        ctx.strokeStyle = COLORS.wireYellow;
        ctx.beginPath();
        ctx.moveTo(startPt.x, startPt.y + 5);
        ctx.lineTo(endPtData.x, endPtData.y + 5);
        ctx.stroke();
    });

    // Label the bus lines
    ctx.fillStyle = COLORS.labelDim;
    ctx.font = "14px 'VT323', 'Courier New', monospace";
    ctx.textAlign = "center";
    ctx.fillText("ADDR", spineX_Addr, bus.y + 20);
    ctx.fillText("DATA", spineX_Data, bus.y + 20);
}

function drawPackets() {
    packets.forEach(p => {
        // Draw packet with glow effect
        ctx.shadowColor = p.type === 'addr' ? COLORS.addressBus : COLORS.dataBus;
        ctx.shadowBlur = 10;

        ctx.fillStyle = p.type === 'addr' ? COLORS.addressBus : COLORS.dataBus;
        ctx.beginPath();
        ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
        ctx.fill();

        ctx.shadowBlur = 0;

        // Move packet
        const dx = p.tx - p.x;
        const dy = p.ty - p.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 5) {
            p.finished = true;
        } else {
            p.x += (dx / dist) * 8; // Speed
            p.y += (dy / dist) * 8;
        }
    });
    // Remove finished packets
    packets = packets.filter(p => !p.finished);
}

function render() {
    if (!renderRunning) return;

    // Clear canvas with background color
    ctx.fillStyle = COLORS.bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    drawBus();

    for (const key in components) {
        if (key !== 'BUS') drawDIPChip(components[key]);
    }

    drawPackets();

    requestAnimationFrame(render);
}

// The canvas animates continuously, so only run it while it is on screen.
let renderRunning = false;

function startRender() {
    if (renderRunning) return;
    renderRunning = true;
    render();
}

// --- Simulation Logic ---

// Every timer the running scenario has scheduled. Keeping them lets a new
// scenario cancel the old one instead of interleaving its log lines with it.
let scenarioTimers = [];

function after(delay, fn) {
    scenarioTimers.push(setTimeout(fn, delay));
}

function cancelScenario() {
    scenarioTimers.forEach(clearTimeout);
    scenarioTimers = [];
    packets = [];
}

// A signal travels component -> spine -> component, one leg per interval.
const SIGNAL_LEG_MS = 200;

function sendSignal(from, to, type, delay = 0) {
    after(delay, () => {
        const startComp = components[from];
        const endComp = components[to];
        const bus = components.BUS;

        const startY = startComp.y + startComp.h / 2;
        const endY = endComp.y + endComp.h / 2;

        // Offset Y slightly for Address vs Data
        const yOffset = type === 'addr' ? -5 : 5;
        const spineX = type === 'addr' ? bus.x + bus.w * 0.33 : bus.x + bus.w * 0.66;

        // Leg 1: component to spine
        if (from !== 'BUS') {
            packets.push({
                x: startComp.x + startComp.w, y: startY + yOffset,
                tx: spineX, ty: startY + yOffset,
                type, finished: false
            });
        }

        // Leg 2: along the spine
        after(SIGNAL_LEG_MS, () => {
            packets.push({
                x: spineX, y: startY + yOffset,
                tx: spineX, ty: endY + yOffset,
                type, finished: false
            });

            // Leg 3: spine to target
            after(SIGNAL_LEG_MS, () => {
                if (to === 'BUS') return;
                packets.push({
                    x: spineX, y: endY + yOffset,
                    tx: endComp.x, ty: endY + yOffset,
                    type, finished: false
                });
            });
        });
    });
}

//
// Scenarios are data, not code: each step fires at `at` milliseconds from the
// start, writes its `log` lines and launches its `send` signals
// ([from, to, type, delay]).
//
const SCENARIOS = {
    boot: {
        title: 'Power On / Boot',
        steps: [
            { at: 0, log: ['CPU resets. Looks for the reset vector at $FFFC.', 'MMU maps KERNAL ROM into the address space.'], send: [['CPU', 'MMU', 'addr']] },
            { at: 400, send: [['MMU', 'ROM', 'addr']] },
            { at: 1000, log: ['Super ROM sends the boot routine address to the CPU.'], send: [['ROM', 'CPU', 'data']] },
            { at: 1800, log: ['CPU initialises the BASIC interpreter.'], send: [['CPU', 'ROM', 'addr']] },
            { at: 2400, log: ['Super ROM returns the BASIC entry point.'], send: [['ROM', 'CPU', 'data']] },
            { at: 3200, log: ['CPU checks RAM size and clears memory.'], send: [['CPU', 'RAM1', 'addr'], ['CPU', 'RAM2', 'data', 200]] },
            { at: 4000, log: ['RAM confirms the memory test passed.'], send: [['RAM1', 'CPU', 'data']] },
            { at: 4800, log: ['**** COMMODORE 64 BASIC V2 ****', '64K RAM SYSTEM  38911 BASIC BYTES FREE', 'READY.'] }
        ]
    },

    typing: {
        title: 'Typing a Character',
        steps: [
            { at: 0, log: ['User presses a key on the keyboard.', 'CIA #1 detects the key matrix signal.'], send: [['CIA', 'CPU', 'data']] },
            { at: 1000, log: ['CPU receives an IRQ from the CIA.', 'CPU reads the CIA to determine which key.'], send: [['CPU', 'CIA', 'addr']] },
            { at: 1600, log: ['CIA returns the key scan code.'], send: [['CIA', 'CPU', 'data']] },
            { at: 2400, log: ['CPU converts to PETSCII and writes to screen RAM.'], send: [['CPU', 'RAM1', 'addr'], ['CPU', 'RAM1', 'data', 200]] },
            { at: 3200, log: ['VIC-II reads screen RAM during the next raster.'], send: [['VIC', 'RAM1', 'addr']] },
            { at: 3800, log: ['RAM returns the character code to VIC-II.'], send: [['RAM1', 'VIC', 'data']] },
            { at: 4400, log: ['Character appears on screen!'] }
        ]
    },

    vic: {
        title: 'VIC-II Screen Refresh',
        steps: [
            { at: 0, log: ['VIC-II starts a new raster line.', 'VIC-II asserts BA (Bus Available) low.', 'CPU paused - VIC steals bus cycles!'] },
            // Five character fetches, one every 400ms.
            ...Array.from({ length: 5 }, (_, i) => ({
                at: i * 400,
                log: [`VIC-II fetches character ${i + 1} from screen RAM.`],
                send: [['VIC', 'RAM1', 'addr'], ['RAM1', 'VIC', 'data', 300]]
            })),
            { at: 2200, log: ['VIC-II fetches character shapes from Super ROM.'], send: [['VIC', 'ROM', 'addr'], ['ROM', 'VIC', 'data', 400]] },
            { at: 3200, log: ['VIC-II releases the bus (BA high).', 'CPU resumes execution.'] }
        ]
    },

    sound: {
        title: 'SID Sound Event',
        steps: [
            { at: 0, log: ['BASIC executes: POKE 54296,15 (volume max)'], send: [['CPU', 'SID', 'addr'], ['CPU', 'SID', 'data', 200]] },
            { at: 800, log: ['POKE 54277,9 (attack/decay envelope)'], send: [['CPU', 'SID', 'addr'], ['CPU', 'SID', 'data', 200]] },
            { at: 1400, log: ['POKE 54273,34 (frequency high byte)'], send: [['CPU', 'SID', 'addr'], ['CPU', 'SID', 'data', 200]] },
            { at: 2000, log: ['POKE 54276,17 (gate on + triangle wave)'], send: [['CPU', 'SID', 'addr'], ['CPU', 'SID', 'data', 200]] },
            { at: 2800, log: ['SID oscillator generates the waveform.', 'Sound plays through the audio output.'] }
        ]
    }
};

// Called from the scenario buttons in hardware.html
window.runScenario = function (name) {
    const scenario = SCENARIOS[name];
    if (!scenario) return;

    cancelScenario();
    clearLog();
    startRender();
    log(`--- Starting: ${scenario.title.toUpperCase()} ---`);

    for (const step of scenario.steps) {
        after(step.at, () => {
            (step.log || []).forEach(log);
            (step.send || []).forEach(([from, to, type, delay]) => sendSignal(from, to, type, delay));
        });
    }
};

// Draw the board immediately, then keep animating only while it is visible.
startRender();
new IntersectionObserver(([entry]) => {
    if (entry.isIntersecting) {
        startRender();
    } else {
        renderRunning = false;
    }
}).observe(canvas);
