//
// @fileoverview C64 Memory Map Explorer - Interactive banking visualization
// @module memmap
//
// Interactive visualization of the C64's memory banking system.
// Simulates the PLA (Programmable Logic Array) that controls memory mapping
// based on CPU port ($0001) and cartridge signals (/GAME, /EXROM).
//
// Features:
// - Interactive control of LORAM, HIRAM, CHAREN signals
// - Cartridge signal simulation (/GAME, /EXROM)
// - VIC-II bank selection visualization
// - Real-time memory map updates showing visible regions
// - Address search and annotation display
//
// Memory regions visualized:
// - Zero Page ($0000-$00FF), Stack ($0100-$01FF)
// - BASIC ROM ($A000-$BFFF), KERNAL ROM ($E000-$FFFF)
// - I/O area vs Character ROM ($D000-$DFFF)
// - Cartridge ROM mapping
//
// Used on the /memmap page of Turbo8bit.
//
// @see https://www.turbo8bit.com/
//

// Memory entries data loaded from JSON
let memoryEntries = [];

// Load memory map data
async function loadMemoryData() {
    try {
        const response = await fetch('/static/js/memmap-data.json');
        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }
        const data = await response.json();
        memoryEntries = data.entries || [];
    } catch (error) {
        console.warn('Could not load memory map data:', error);
    }
}

document.addEventListener('DOMContentLoaded', async () => {
    // Load memory data first
    await loadMemoryData();
    // Banking state
    const state = {
        loram: true,   // Bit 0 - BASIC ROM visible
        hiram: true,   // Bit 1 - KERNAL ROM visible
        charen: true,  // Bit 2 - I/O visible (vs Char ROM)
        game: false,   // /GAME signal (active LOW, false = inactive/high)
        exrom: false,  // /EXROM signal (active LOW, false = inactive/high)
        vicBank: 0,    // VIC-II bank (0-3), controlled by CIA2 $DD00
        // VIC-II $D018 register settings (default values)
        screenOffset: 0x0400,  // Screen memory offset within bank (bits 4-7, *1024)
        charOffset: 0x1000,    // Character set offset within bank (bits 1-3, *2048)
        bitmapMode: false      // Bitmap mode enabled
    };

    // Memory region definitions
    const regions = {
        zeropage: { start: 0x0000, end: 0x00FF, name: 'ZERO PAGE', size: '256 bytes' },
        stack: { start: 0x0100, end: 0x01FF, name: 'STACK', size: '256 bytes' },
        lowram: { start: 0x0200, end: 0x7FFF, name: 'RAM', size: '31.5 KB' },
        cartlo: { start: 0x8000, end: 0x9FFF, name: 'CARTRIDGE ROM LO', size: '8 KB' },
        basic: { start: 0xA000, end: 0xBFFF, name: 'BASIC ROM', size: '8 KB' },
        highram: { start: 0xC000, end: 0xCFFF, name: 'RAM', size: '4 KB' },
        io: { start: 0xD000, end: 0xDFFF, name: 'I/O', size: '4 KB' },
        charrom: { start: 0xD000, end: 0xDFFF, name: 'CHARACTER ROM', size: '4 KB' },
        kernal: { start: 0xE000, end: 0xFFFF, name: 'KERNAL ROM', size: '8 KB' },
        ram8000: { start: 0x8000, end: 0x9FFF, name: 'RAM', size: '8 KB' },
        ramA000: { start: 0xA000, end: 0xBFFF, name: 'RAM', size: '8 KB' },
        ramD000: { start: 0xD000, end: 0xDFFF, name: 'RAM', size: '4 KB' },
        ramE000: { start: 0xE000, end: 0xFFFF, name: 'RAM', size: '8 KB' },
        carthi: { start: 0xA000, end: 0xBFFF, name: 'CARTRIDGE ROM HI', size: '8 KB' },
        carhiE: { start: 0xE000, end: 0xFFFF, name: 'CARTRIDGE ROM HI', size: '8 KB' }
    };

    const regionDescriptions = {
        zeropage: 'Zero page allows shorter, faster CPU instructions. BASIC and the KERNAL keep working variables here. $0000 and $0001 are the 6510 data-direction register and CPU port, not ordinary RAM.',
        stack: 'The hardware stack occupies $0100-$01FF. The CPU pushes return addresses and saved registers here; its 8-bit stack pointer moves downward on a push and upward on a pull.',
        lowram: 'RAM used by system workspaces, the default screen at $0400, and BASIC programs beginning at $0801. In Ultimax mode, only $0000-$0FFF remains connected to onboard RAM.',
        ram: 'Onboard RAM selected for CPU reads and writes. Banking ROM out exposes the RAM underneath; it does not erase it.',
        highram: 'This 4KB RAM area is normally available alongside BASIC and the KERNAL, making it useful for machine-code programs. It is unmapped in Ultimax mode.',
        basic: 'The 8KB BASIC V2 interpreter. Without a 16KB or Ultimax cartridge, both LORAM and HIRAM must be high to select BASIC ROM. Writes go to the underlying RAM, not the ROM.',
        kernal: 'The 8KB KERNAL operating system provides I/O routines, keyboard scanning and interrupt handling. HIRAM selects it except in Ultimax mode. Writes go to underlying RAM.',
        io: 'Memory-mapped VIC-II, SID, color RAM and CIA registers, plus the cartridge I/O windows. Reads and writes access the devices rather than the RAM underneath. Some reads have side effects.',
        charrom: 'The CPU can read the built-in character shapes here when the PLA selects character ROM. Writes still go to RAM underneath. The VIC-II has a separate view of character ROM in banks 0 and 2.',
        'cart-lo': 'The cartridge ROML window. In 8KB and 16KB modes it is selected when both LORAM and HIRAM are high; in Ultimax mode it is always selected. Cartridge hardware determines write behavior.',
        'cart-hi': 'The cartridge ROMH window: $A000-$BFFF in 16KB mode when HIRAM is high, or $E000-$FFFF in Ultimax mode regardless of the CPU port. Cartridge hardware determines write behavior.',
        unmapped: 'No onboard RAM or ROM is selected here in Ultimax mode. Reads are open bus, not ordinary RAM; the observed value depends on bus activity and cartridge hardware.'
    };

    // Get DOM elements
    const bitButtons = document.querySelectorAll('.bit-btn');
    const signalButtons = document.querySelectorAll('.signal-btn');
    const presetButtons = document.querySelectorAll('.preset-btn');
    const vicBankButtons = document.querySelectorAll('.vic-bank-btn');
    const memoryTableBody = document.getElementById('memory-table-body');
    const portValueDisplay = document.getElementById('port-value');
    const vicRangeDisplay = document.getElementById('vic-range');
    const configSummary = document.getElementById('config-summary');

    // Initialize
    updateMemoryMap();
    setupEventListeners();

    function setupEventListeners() {
        // Bit button toggles
        bitButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const bit = btn.dataset.bit;
                state[bit] = !state[bit];
                updateBitButtons();
                clearActivePreset();
                updateMemoryMap();
            });
        });

        // VIC bank button toggles
        vicBankButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const bank = parseInt(btn.dataset.bank);
                state.vicBank = bank;
                updateMemoryMap();
            });
        });

        // Signal button toggles
        signalButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const signal = btn.dataset.signal;
                state[signal] = !state[signal];
                updateSignalButtons();
                clearActivePreset();
                updateMemoryMap();
            });
        });

        // Preset buttons
        presetButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const preset = btn.dataset.preset;
                applyPreset(preset);
                presetButtons.forEach(p => setActive(p, p === btn));
            });
        });
    }

    function clearActivePreset() {
        presetButtons.forEach(p => setActive(p, false));
    }

    function setActive(button, active) {
        button.classList.toggle('active', active);
        button.setAttribute('aria-pressed', String(active));
    }

    function applyPreset(preset) {
        switch (preset) {
            case 'default':
                state.loram = true;
                state.hiram = true;
                state.charen = true;
                state.game = false;
                state.exrom = false;
                break;
            case 'allram':
                state.loram = false;
                state.hiram = false;
                state.charen = false;
                state.game = false;
                state.exrom = false;
                break;
            case 'nobasic':
                state.loram = false;
                state.hiram = true;
                state.charen = true;
                state.game = false;
                state.exrom = false;
                break;
            case 'nokernal':
                state.loram = true;
                state.hiram = false;
                state.charen = true;
                state.game = false;
                state.exrom = false;
                break;
            case 'charrom':
                state.loram = true;
                state.hiram = true;
                state.charen = false;
                state.game = false;
                state.exrom = false;
                break;
            case 'ultimax':
                state.loram = false;
                state.hiram = false;
                state.charen = false;
                state.game = true;
                state.exrom = false;
                break;
        }

        updateBitButtons();
        updateSignalButtons();
        updateMemoryMap();
    }

    function updateBitButtons() {
        bitButtons.forEach(btn => {
            const bit = btn.dataset.bit;
            setActive(btn, state[bit]);
            const valueSpan = btn.querySelector('.bit-value');
            if (valueSpan) {
                valueSpan.textContent = state[bit] ? '1' : '0';
            }
        });
    }

    function updateSignalButtons() {
        signalButtons.forEach(btn => {
            const signal = btn.dataset.signal;
            setActive(btn, state[signal]);
        });
    }

    function calculatePortValue() {
        let value = 0x30; // Bits 4,5 always set (datasette motor off, etc.)
        if (state.loram) value |= 0x01;
        if (state.hiram) value |= 0x02;
        if (state.charen) value |= 0x04;
        return value;
    }

    function getMemoryLayout() {
        // Cartridge booleans mean asserted LOW; CPU-port booleans mean HIGH.
        // These are CPU read selections. ROM writes and the VIC use other paths.
        const ultimax = state.game && !state.exrom;
        const cart16k = state.game && state.exrom;
        const roml = ultimax || (state.exrom && state.loram && state.hiram);
        const romh = cart16k && state.hiram;
        const basic = !state.game && state.loram && state.hiram;
        const characterRom = !state.charen && (state.hiram || (!state.game && state.loram));
        const layout = [];
        const unmapped = (start, end, size) => ({
            start, end, size, name: 'UNMAPPED', type: 'unmapped', infoId: 'unmapped'
        });

        // $0000-$00FF: Zero Page
        layout.push({ ...regions.zeropage, type: 'ram', infoId: 'zeropage' });

        // $0100-$01FF: Stack (grows downward)
        layout.push({ ...regions.stack, type: 'ram', infoId: 'stack' });

        if (ultimax) {
            layout.push({
                start: 0x0200, end: 0x0FFF, name: 'RAM', size: '3.5 KB',
                type: 'ram', infoId: 'lowram'
            });
            layout.push(unmapped(0x1000, 0x7FFF, '28 KB'));
        } else {
            layout.push({ ...regions.lowram, type: 'ram', infoId: 'lowram' });
        }

        // $8000-$9FFF: RAM, or Cart ROML
        if (roml) {
            layout.push({ ...regions.cartlo, type: 'cart-lo', infoId: 'cart-lo' });
        } else {
            layout.push({ ...regions.ram8000, type: 'ram', infoId: 'ram' });
        }

        // $A000-$BFFF: RAM, BASIC, or Cart ROMH
        if (ultimax) {
            layout.push(unmapped(0xA000, 0xBFFF, '8 KB'));
        } else if (romh) {
            layout.push({ ...regions.carthi, type: 'cart-hi', infoId: 'cart-hi' });
        } else if (basic) {
            layout.push({ ...regions.basic, type: 'basic', infoId: 'basic' });
        } else {
            // RAM visible when LORAM=0 OR HIRAM=0
            layout.push({ ...regions.ramA000, type: 'ram', infoId: 'ram' });
        }

        layout.push(ultimax
            ? unmapped(0xC000, 0xCFFF, '4 KB')
            : { ...regions.highram, type: 'ram', infoId: 'highram' });

        // $D000-$DFFF: I/O, Char ROM, or RAM
        // In 16KB mode, LORAM alone cannot select character ROM.
        if (ultimax || (state.charen && (state.loram || state.hiram))) {
            layout.push({ ...regions.io, type: 'io', infoId: 'io' });
        } else if (characterRom) {
            layout.push({ ...regions.charrom, type: 'charrom', infoId: 'charrom' });
        } else {
            layout.push({ ...regions.ramD000, type: 'ram', infoId: 'ram' });
        }

        // $E000-$FFFF: KERNAL, RAM, or Cart ROMH (Ultimax)
        if (ultimax) {
            layout.push({ ...regions.carhiE, type: 'cart-hi', infoId: 'cart-hi' });
        } else if (state.hiram) {
            layout.push({ ...regions.kernal, type: 'kernal', infoId: 'kernal' });
        } else {
            layout.push({ ...regions.ramE000, type: 'ram', infoId: 'ram' });
        }

        return layout;
    }

    function formatAddress(address) {
        return '$' + address.toString(16).toUpperCase().padStart(4, '0');
    }

    function formatRange(start, end) {
        return `${formatAddress(start)}-${formatAddress(end)}`;
    }

    function createMemoryButton(className, label, key, address, inspect) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = className;
        button.setAttribute('aria-label', label);
        button.dataset.focusKey = key;
        button.dataset.address = address;
        button.addEventListener('click', inspect);
        button.addEventListener('focus', inspect);
        button.addEventListener('mouseenter', inspect);
        return button;
    }

    //
    // Define the fixed 4KB grid rows for the memory map
    // Each row represents a 4KB block, except zero page and stack which are special
    //
    function getGridRows() {
        return [
            { start: 0xF000, end: 0xFFFF, label: '$F000' },
            { start: 0xE000, end: 0xEFFF, label: '$E000' },
            { start: 0xD000, end: 0xDFFF, label: '$D000' },
            { start: 0xC000, end: 0xCFFF, label: '$C000' },
            { start: 0xB000, end: 0xBFFF, label: '$B000' },
            { start: 0xA000, end: 0xAFFF, label: '$A000' },
            { start: 0x9000, end: 0x9FFF, label: '$9000' },
            { start: 0x8000, end: 0x8FFF, label: '$8000' },
            { start: 0x7000, end: 0x7FFF, label: '$7000' },
            { start: 0x6000, end: 0x6FFF, label: '$6000' },
            { start: 0x5000, end: 0x5FFF, label: '$5000' },
            { start: 0x4000, end: 0x4FFF, label: '$4000' },
            { start: 0x3000, end: 0x3FFF, label: '$3000' },
            { start: 0x2000, end: 0x2FFF, label: '$2000' },
            { start: 0x1000, end: 0x1FFF, label: '$1000' },
            { start: 0x0200, end: 0x0FFF, label: '$0200', special: 'lowram' },
            { start: 0x0100, end: 0x01FF, label: '$0100', special: 'stack' },
            { start: 0x0000, end: 0x00FF, label: '$0000', special: 'zeropage' }
        ];
    }

    //
    // Find which region from layout covers a given address range
    //
    function findRegionForRange(layout, start, end) {
        return layout.find(r => r.start <= start && r.end >= end);
    }

    //
    // Determine what VIC-II uses this memory region for
    // VIC-II layout within a 16KB bank:
    // - Screen memory: 1KB at configurable offset (bits 4-7 of $D018 * 1024)
    // - Character set: 2KB at configurable offset (bits 1-3 of $D018 * 2048)
    // - Bitmap data: 8KB when bitmap mode enabled
    // - Sprite data: 64 bytes per sprite, anywhere in bank
    // In banks 0 and 2, the VIC sees Character ROM at $1000-$1FFF instead of RAM
    //
    function getVicRegionInfo(gridStart, gridEnd, vicBankStart) {
        const offsetInBank = gridStart - vicBankStart;
        const blockSize = gridEnd - gridStart + 1;

        // Default screen at $0400, character set at $1000 (pointing to char ROM)
        const screenStart = state.screenOffset;
        const screenEnd = screenStart + 0x03FF; // 1KB screen memory
        const charStart = state.charOffset;
        const charEnd = charStart + 0x07FF; // 2KB character set

        // Check for character ROM in banks 0 and 2 ($1000-$1FFF)
        const hasCharRom = (state.vicBank === 0 || state.vicBank === 2);
        const charRomStart = 0x1000;
        const charRomEnd = 0x1FFF;

        // Collect all uses for this 4KB block
        const uses = [];

        // Check if screen memory overlaps this block
        if (screenStart < (offsetInBank + blockSize) && screenEnd >= offsetInBank) {
            uses.push({ type: 'vic-screen', label: 'SCREEN', detail: '1KB', priority: 1 });
        }

        // Check if character ROM is in this block (banks 0 and 2 only)
        if (hasCharRom && offsetInBank >= charRomStart && offsetInBank <= charRomEnd) {
            uses.push({ type: 'charrom', label: 'CHAR ROM', detail: '4KB', priority: 3 });
        }
        // Check if character set pointer is in this block (when not using char ROM)
        else if (charStart < (offsetInBank + blockSize) && charEnd >= offsetInBank) {
            uses.push({ type: 'vic-chars', label: 'CHARSET', detail: '2KB', priority: 2 });
        }

        // If bitmap mode, check for bitmap memory (8KB aligned)
        if (state.bitmapMode) {
            const bitmapStart = (state.charOffset & 0x2000); // Bit 3 of $D018 selects 8KB half
            const bitmapEnd = bitmapStart + 0x1FFF;
            if (offsetInBank >= bitmapStart && offsetInBank <= bitmapEnd) {
                uses.push({ type: 'vic-bitmap', label: 'BITMAP', detail: '8KB', priority: 0 });
            }
        }

        // Return the highest priority use, or RAM if none
        if (uses.length === 0) {
            return { type: 'ram', label: 'RAM', detail: '' };
        }

        // Sort by priority and return highest
        uses.sort((a, b) => a.priority - b.priority);

        // If multiple uses, show combined label
        if (uses.length > 1) {
            const labels = uses.map(u => u.label);
            return {
                type: uses[0].type,
                label: uses[0].label,
                detail: labels.slice(1).join(' + ')
            };
        }

        return uses[0];
    }

    function updateMemoryMap() {
        const focused = document.activeElement;
        const focusKey = memoryTableBody.contains(focused) ? focused.dataset.focusKey : null;
        const focusAddress = focusKey ? Number(focused.dataset.address) : null;
        const layout = getMemoryLayout();
        const portValue = calculatePortValue();
        const gridRows = getGridRows();

        // Update port value display
        portValueDisplay.textContent = '$' + portValue.toString(16).toUpperCase().padStart(2, '0');
        updateBitButtons();
        updateSignalButtons();
        vicBankButtons.forEach(button => setActive(button, Number(button.dataset.bank) === state.vicBank));
        presetButtons.forEach(button => setActive(button, button.classList.contains('active')));

        // Clear table body
        memoryTableBody.innerHTML = '';

        // VIC bank boundaries
        const vicBankStart = state.vicBank * 0x4000;
        const vicBankEnd = vicBankStart + 0x3FFF;

        // Track which regions we've started (for rowspan)
        const regionSpans = new Map(); // region -> { startRowIdx, rowspan }

        // Track VIC cell rowspans for combining identical adjacent cells
        const vicSpans = new Map(); // vicLabel -> { startRowIdx, rowspan, vicResult }

        // First pass: calculate rowspans for each region
        gridRows.forEach((gridRow, idx) => {
            const region = findRegionForRange(layout, gridRow.start, gridRow.end);
            if (region) {
                const key = `${region.start}-${region.end}`;
                if (!regionSpans.has(key)) {
                    regionSpans.set(key, { startRowIdx: idx, rowspan: 1, region });
                } else {
                    regionSpans.get(key).rowspan++;
                }
            }
        });

        // First pass for VIC cells: calculate rowspans for identical adjacent cells
        let lastVicLabel = null;
        let lastVicKey = null;
        gridRows.forEach((gridRow, idx) => {
            const isInVicBank = gridRow.end >= vicBankStart && gridRow.start <= vicBankEnd;
            if (isInVicBank) {
                const vicResult = getVicRegionInfo(gridRow.start, gridRow.end, vicBankStart);
                const vicLabel = vicResult.label;
                // Check if same as previous VIC cell
                if (vicLabel === lastVicLabel && lastVicKey !== null) {
                    // Extend the rowspan of the previous key
                    vicSpans.get(lastVicKey).rowspan++;
                } else {
                    // New VIC cell group
                    const key = `vic-${idx}`;
                    vicSpans.set(key, { startRowIdx: idx, rowspan: 1, vicResult, gridRow });
                    lastVicKey = key;
                    lastVicLabel = vicLabel;
                }
            } else {
                // Not in VIC bank - reset tracking
                lastVicLabel = null;
                lastVicKey = null;
            }
        });

        // Second pass: create table rows
        const renderedRegions = new Set();

        gridRows.forEach((gridRow, idx) => {
            const row = document.createElement('tr');

            // Find the region that covers this grid row
            const region = findRegionForRange(layout, gridRow.start, gridRow.end);
            const regionKey = region ? `${region.start}-${region.end}` : null;
            const spanInfo = regionKey ? regionSpans.get(regionKey) : null;

            // === Address Cell ===
            const addrCell = document.createElement('td');
            addrCell.className = 'addr-cell';
            addrCell.innerHTML = `<span class="addr-start">${gridRow.label}</span>`;
            row.appendChild(addrCell);

            // === CPU Cell ===
            if (region && !renderedRegions.has(regionKey)) {
                // First row for this region - create cell with rowspan
                const cpuCell = document.createElement('td');
                cpuCell.className = `cpu-cell region-${region.type}`;
                if (spanInfo.rowspan > 1) {
                    cpuCell.rowSpan = spanInfo.rowspan;
                }

                const cpuDiv = createMemoryButton(
                    `memory-cell region-${region.type}`,
                    `${region.name}, ${formatRange(region.start, region.end)}`,
                    `cpu-${region.start}`, region.start, () => showRegionInfo(region)
                );
                cpuDiv.dataset.info = region.infoId;
                cpuDiv.dataset.cpuStart = region.start;
                cpuDiv.dataset.cpuEnd = region.end;

                if (region.infoId === 'stack') {
                    // Special layout for stack with arrow on right
                    cpuDiv.innerHTML = `
                            <span>
                            <span class="region-name">${region.name}</span>
                            <span class="region-size">${region.size}</span>
                            <span class="stack-arrow">grows down</span>
                            </span>
                            `;
                } else {
                    cpuDiv.innerHTML = `
                            <span>
                            <span class="region-name">${region.name}</span>
                            <span class="region-size">${region.size}</span>
                            </span>
                            `;
                }

                cpuCell.appendChild(cpuDiv);
                row.appendChild(cpuCell);

                renderedRegions.add(regionKey);
            } else if (!region) {
                // No region - empty cell
                const cpuCell = document.createElement('td');
                cpuCell.className = 'cpu-cell';
                cpuCell.innerHTML = '<div class="memory-cell region-ram"><div class="region-name">RAM</div></div>';
                row.appendChild(cpuCell);
            }
            // If region already rendered with rowspan, skip creating cell

            // === Details Cell ===
            const detailsCell = document.createElement('td');
            detailsCell.className = 'details-cell';
            const detailsDiv = document.createElement('div');
            detailsDiv.className = 'details-cells';
            detailsDiv.dataset.start = gridRow.start;
            detailsDiv.dataset.end = gridRow.end;
            // Store the region type for styling
            if (region) {
                detailsDiv.dataset.regionType = region.type;
                detailsCell.classList.add(`region-${region.type}`);
            }
            detailsCell.appendChild(detailsDiv);
            row.appendChild(detailsCell);

            // === VIC Cell ===
            const isInVicBank = gridRow.end >= vicBankStart && gridRow.start <= vicBankEnd;

            // Find if this row starts a VIC span
            const vicKey = `vic-${idx}`;
            const vicSpanInfo = vicSpans.get(vicKey);

            // Only render if this is the first row of a VIC span, or not in VIC bank
            const shouldRenderVicCell = vicSpanInfo || !isInVicBank;

            if (shouldRenderVicCell) {
                const vicCell = document.createElement('td');
                vicCell.className = 'vic-cell';

                let vicDiv;

                if (isInVicBank && vicSpanInfo) {
                    // Apply rowspan if greater than 1
                    if (vicSpanInfo.rowspan > 1) {
                        vicCell.rowSpan = vicSpanInfo.rowspan;
                    }

                    const vicResult = vicSpanInfo.vicResult;
                    // Calculate the full range for this merged cell
                    const spanEndRow = gridRows[idx + vicSpanInfo.rowspan - 1];
                    const spanStart = spanEndRow ? spanEndRow.start : gridRow.start;
                    const spanEnd = gridRow.end;

                    const vicRegionInfo = {
                        name: vicResult.label,
                        start: spanStart,
                        end: spanEnd,
                        type: vicResult.type
                    };
                    vicDiv = createMemoryButton(
                        `memory-cell region-${vicResult.type} vic-visible`,
                        `VIC-II ${vicResult.label}, ${formatRange(spanStart, spanEnd)}`,
                        `vic-${spanStart}`, spanStart, () => showVicRegionInfo(vicRegionInfo)
                    );
                    vicDiv.innerHTML = `
                            <span>
                            <span class="region-name">${vicResult.label}</span>
                            ${vicResult.detail ? `<span class="region-size">${vicResult.detail}</span>` : ''}
                            </span>
                            `;
                } else if (!isInVicBank) {
                    vicDiv = document.createElement('div');
                    vicDiv.className = 'memory-cell region-vic-empty';
                    vicDiv.innerHTML = '<span class="vic-inactive">—</span>';
                }

                vicCell.appendChild(vicDiv);
                row.appendChild(vicCell);
            }

            memoryTableBody.appendChild(row);
        });

        // Populate detail cells with current layout for visibility filtering
        populateDetailsCells(layout);

        // Update config summary
        updateConfigSummary(layout);

        // Update VIC range display
        if (vicRangeDisplay) {
            vicRangeDisplay.textContent = `$${vicBankStart.toString(16).toUpperCase().padStart(4, '0')}-$${vicBankEnd.toString(16).toUpperCase().padStart(4, '0')}`;
        }

        if (focusKey) {
            const buttons = [...memoryTableBody.querySelectorAll('[data-focus-key]')];
            const replacement = buttons.find(button => button.dataset.focusKey === focusKey)
                || buttons.find(button => button.dataset.cpuStart !== undefined
                    && Number(button.dataset.cpuStart) <= focusAddress
                    && Number(button.dataset.cpuEnd) >= focusAddress);
            replacement?.focus({ preventScroll: true });
        }
    }

    //
    // Populate the details cells with memory entry indicators
    // @param {Array} layout - Current memory layout for visibility filtering
    //
    function populateDetailsCells(layout) {
        const detailContainers = document.querySelectorAll('.details-cells');

        // Determine which ROM regions are currently visible
        const hasBasic = layout.some(r => r.type === 'basic');
        const hasKernal = layout.some(r => r.type === 'kernal');
        const hasIO = layout.some(r => r.type === 'io');

        detailContainers.forEach(container => {
            const start = parseInt(container.dataset.start);
            const end = parseInt(container.dataset.end);

            // Find entries in this range
            const entriesInRange = memoryEntries.filter(entry => {
                const addr = entry.address;
                if (addr < start || addr > end) return false;
                if (layout.some(r => r.type === 'unmapped' && r.start <= addr && r.end >= addr)) return false;

                // Filter based on banking - hide entries for banked-out ROMs
                const region = entry.region;
                if (region === 'basic' && !hasBasic) return false;
                if (region === 'kernal' && !hasKernal) return false;
                // VIC, SID, CIA entries only visible when I/O is visible
                if (['vic', 'sid', 'colorram', 'cia1', 'cia2', 'io'].includes(region) && !hasIO) return false;

                return true;
            });

            // Create cells for each entry
            entriesInRange.forEach(entry => {
                const label = `${entry.hex_addr} - ${entry.name}`;
                const cell = createMemoryButton(
                    'mem-cell', label, `entry-${entry.address}-${entry.name}`,
                    entry.address, () => showEntryDetails(entry)
                );
                cell.title = label;
                container.appendChild(cell);
            });
        });
    }

    function showVicRegionInfo(region) {
        const nameEl = document.getElementById('entry-name');
        const addressEl = document.getElementById('entry-address');
        const titleEl = document.getElementById('entry-title');
        const descEl = document.getElementById('entry-description');
        const bitsContainer = document.getElementById('entry-bits-container');

        nameEl.textContent = region.name;
        addressEl.textContent = `$${region.start.toString(16).toUpperCase().padStart(4, '0')}-$${region.end.toString(16).toUpperCase().padStart(4, '0')}`;
        titleEl.textContent = 'VIC-II Memory Bank ' + state.vicBank;
        titleEl.style.display = 'block';

        let desc = '';
        if (region.type === 'vic-screen') {
            desc = 'This area typically contains video screen memory (40×25 characters = 1000 bytes) and sprite pointers (8 bytes at the end of screen memory). The VIC-II reads character codes from here.';
        } else if (region.type === 'charrom') {
            desc = 'In banks 0 and 2, the VIC-II sees the built-in character ROM here instead of RAM, independently of CPU banking. This provides the default character set.';
        } else if (region.type === 'vic-chars') {
            desc = 'The character-set pointer selects 2KB of RAM in this block. Banks 1 and 3 have no built-in character ROM, so character shapes must be supplied in RAM.';
        } else if (region.type === 'vic-bitmap') {
            desc = 'This 8KB area is commonly used for high-resolution bitmap graphics (8000 bytes) or sprite shape data (64 bytes per sprite × 256 possible sprites). Can also hold custom character sets.';
        } else if (region.type === 'ram') {
            desc = 'RAM visible to the VIC-II chip. The VIC always sees RAM here, regardless of CPU banking configuration (BASIC/KERNAL/I/O).';
        } else {
            desc = 'RAM visible to the VIC-II chip for video data.';
        }
        descEl.textContent = desc;
        bitsContainer.style.display = 'none';
    }

    function updateConfigSummary(layout) {
        const parts = [];

        const hasBasic = layout.some(r => r.type === 'basic');
        const hasKernal = layout.some(r => r.type === 'kernal');
        const hasIO = layout.some(r => r.type === 'io');
        const hasCharRom = layout.some(r => r.type === 'charrom');
        const hasCartLo = layout.some(r => r.type === 'cart-lo');
        const hasCartHi = layout.some(r => r.type === 'cart-hi');

        if (hasBasic) parts.push('BASIC');
        if (hasKernal) parts.push('KERNAL');
        if (hasIO) parts.push('I/O');
        if (hasCharRom) parts.push('CHAR ROM');
        if (hasCartLo) parts.push('CART ROML');
        if (hasCartHi) parts.push('CART ROMH');

        if (parts.length === 0) {
            configSummary.textContent = 'ALL 64KB RAM visible';
        } else {
            configSummary.textContent = parts.join(' + ') + ' visible';
        }

        // Add special mode indicators
        if (state.game && !state.exrom) {
            configSummary.textContent = 'ULTIMAX MODE - ' + configSummary.textContent;
        }
    }

    function showRegionInfo(region) {
        document.getElementById('entry-name').textContent = region.name;
        document.getElementById('entry-address').textContent = formatRange(region.start, region.end);
        document.getElementById('entry-description').textContent = regionDescriptions[region.infoId];
        document.getElementById('entry-title').style.display = 'none';
        document.getElementById('entry-bits-container').style.display = 'none';
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.repeat || e.ctrlKey || e.altKey || e.metaKey
            || e.target?.closest?.('input, textarea, select, [contenteditable="true"]')) return;
        if (e.key === '1') {
            const btn = document.querySelector('[data-bit="loram"]');
            if (btn) btn.click();
        } else if (e.key === '2') {
            const btn = document.querySelector('[data-bit="hiram"]');
            if (btn) btn.click();
        } else if (e.key === '3') {
            const btn = document.querySelector('[data-bit="charen"]');
            if (btn) btn.click();
        } else if (e.key === 'Escape') {
            resetEntryDetails();
        }
    });

    //
    // Show details for a specific memory entry in the info panel
    //
    function showEntryDetails(entry) {
        const nameEl = document.getElementById('entry-name');
        const addressEl = document.getElementById('entry-address');
        const titleEl = document.getElementById('entry-title');
        const descEl = document.getElementById('entry-description');
        const bitsContainer = document.getElementById('entry-bits-container');
        const bitsEl = document.getElementById('entry-bits');

        // Format address
        let addrStr = `$${entry.address.toString(16).toUpperCase().padStart(4, '0')}`;
        if (entry.address_end) {
            addrStr += `-$${entry.address_end.toString(16).toUpperCase().padStart(4, '0')}`;
        }
        addrStr += ` (${entry.address})`;

        nameEl.textContent = entry.name;
        addressEl.textContent = addrStr;

        // Show title if available
        if (entry.title) {
            titleEl.textContent = entry.title;
            titleEl.style.display = 'block';
        } else {
            titleEl.style.display = 'none';
        }

        // Clean and show description (first paragraph or truncated)
        let desc = entry.description || 'No description available.';
        // Clean OCR artifacts
        desc = desc.replace(/\n+/g, ' ').replace(/\s+/g, ' ');
        // Truncate to reasonable length
        if (desc.length > 400) {
            desc = desc.substring(0, 400) + '...';
        }
        descEl.textContent = desc;

        // Show bit fields if available
        if (entry.bits && entry.bits.length > 0) {
            bitsContainer.style.display = 'block';
            bitsEl.innerHTML = '';
            entry.bits.forEach(bit => {
                const li = document.createElement('li');
                const bitLabel = bit.bit_end !== null && bit.bit_end !== undefined
                    ? `Bits ${bit.bit}-${bit.bit_end}`
                    : `Bit ${bit.bit}`;
                // Use textContent to avoid HTML injection from JSON data.
                const labelSpan = document.createElement('span');
                labelSpan.className = 'label';
                labelSpan.textContent = `${bitLabel}:`;
                li.appendChild(labelSpan);
                li.appendChild(document.createTextNode(' ' + (bit.description || '')));
                bitsEl.appendChild(li);
            });
        } else {
            bitsContainer.style.display = 'none';
        }
    }

    //
    // Reset entry details to default state
    //
    function resetEntryDetails() {
        const nameEl = document.getElementById('entry-name');
        const addressEl = document.getElementById('entry-address');
        const titleEl = document.getElementById('entry-title');
        const descEl = document.getElementById('entry-description');
        const bitsContainer = document.getElementById('entry-bits-container');

        nameEl.textContent = 'Memory Map';
        addressEl.textContent = 'Focus, click or hover over cells for details';
        titleEl.style.display = 'none';
        descEl.textContent = 'The cells on the right of each memory region show documented memory locations from "Mapping the Commodore 64".';
        bitsContainer.style.display = 'none';

        document.querySelectorAll('.mem-cell.active').forEach(c => c.classList.remove('active'));
    }
});
