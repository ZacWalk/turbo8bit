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
        console.log(`Loaded ${memoryEntries.length} memory entries`);
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

    // Get DOM elements
    const bitButtons = document.querySelectorAll('.bit-btn');
    const signalButtons = document.querySelectorAll('.signal-btn');
    const presetButtons = document.querySelectorAll('.preset-btn');
    const vicBankButtons = document.querySelectorAll('.vic-bank-btn');
    const memoryTableBody = document.getElementById('memory-table-body');
    const portValueDisplay = document.getElementById('port-value');
    const vicRangeDisplay = document.getElementById('vic-range');
    const configSummary = document.getElementById('config-summary');

    // Track previous layout to detect changes
    let previousLayout = null;

    // Initialize
    updateMemoryMap();
    setupEventListeners();

    function setupEventListeners() {
        // Bit button toggles
        bitButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const bit = btn.dataset.bit;
                state[bit] = !state[bit];
                btn.classList.toggle('active', state[bit]);
                const valueEl = btn.querySelector(':not(.bit-name)');
                if (valueEl) {
                    valueEl.textContent = state[bit] ? '1' : '0';
                }
                clearActivePreset();
                updateMemoryMap();
            });
        });

        // VIC bank button toggles
        vicBankButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const bank = parseInt(btn.dataset.bank);
                state.vicBank = bank;
                vicBankButtons.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                updateMemoryMap();
            });
        });

        // Signal button toggles
        signalButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const signal = btn.dataset.signal;
                state[signal] = !state[signal];
                btn.classList.toggle('active', state[signal]);
                clearActivePreset();
                updateMemoryMap();
            });
        });

        // Preset buttons
        presetButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                const preset = btn.dataset.preset;
                applyPreset(preset);
                presetButtons.forEach(p => p.classList.remove('active'));
                btn.classList.add('active');
            });
        });
    }

    function clearActivePreset() {
        presetButtons.forEach(p => p.classList.remove('active'));
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
            btn.classList.toggle('active', state[bit]);
            const valueSpan = btn.querySelector('.bit-value');
            if (valueSpan) {
                valueSpan.textContent = state[bit] ? '1' : '0';
            }
        });
    }

    function updateSignalButtons() {
        signalButtons.forEach(btn => {
            const signal = btn.dataset.signal;
            btn.classList.toggle('active', state[signal]);
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
        // Determine what's visible at each memory region based on PLA logic
        const layout = [];

        // $0000-$00FF: Zero Page
        layout.push({ ...regions.zeropage, type: 'ram', infoId: 'zeropage' });

        // $0100-$01FF: Stack (grows downward)
        layout.push({ ...regions.stack, type: 'ram', infoId: 'stack' });

        // $0200-$7FFF: Always RAM
        layout.push({ ...regions.lowram, type: 'ram', infoId: 'lowram' });

        // $8000-$9FFF: RAM, or Cart ROML
        if (state.exrom && !state.game) {
            // Cartridge ROML visible
            layout.push({ ...regions.cartlo, type: 'cart-lo', infoId: 'cart-lo' });
        } else if (state.game && !state.exrom) {
            // Ultimax mode - ROML visible
            layout.push({ ...regions.cartlo, type: 'cart-lo', infoId: 'cart-lo' });
        } else {
            layout.push({ ...regions.ram8000, type: 'ram', infoId: 'ram' });
        }

        // $A000-$BFFF: RAM, BASIC, or Cart ROMH
        if (state.game && !state.exrom) {
            // Ultimax mode - nothing here (open bus), show as RAM
            layout.push({ ...regions.ramA000, type: 'ram', infoId: 'ram' });
        } else if (state.exrom && !state.game && state.hiram && state.loram) {
            // 16K cart mode - ROMH at $A000
            layout.push({ ...regions.carthi, type: 'cart-hi', infoId: 'cart-hi' });
        } else if (state.loram && state.hiram) {
            // BASIC visible only when both LORAM=1 AND HIRAM=1
            layout.push({ ...regions.basic, type: 'basic', infoId: 'basic' });
        } else {
            // RAM visible when LORAM=0 OR HIRAM=0
            layout.push({ ...regions.ramA000, type: 'ram', infoId: 'ram' });
        }

        // $C000-$CFFF: Always RAM
        layout.push({ ...regions.highram, type: 'ram', infoId: 'highram' });

        // $D000-$DFFF: I/O, Char ROM, or RAM
        // I/O visible when (HIRAM=1 OR LORAM=1) AND CHAREN=1
        // CHAR ROM visible when (HIRAM=1 OR LORAM=1) AND CHAREN=0
        // RAM visible when HIRAM=0 AND LORAM=0
        if (state.game && !state.exrom) {
            // Ultimax mode - I/O always visible
            layout.push({ ...regions.io, type: 'io', infoId: 'io' });
        } else if (!state.hiram && !state.loram) {
            // All RAM mode
            layout.push({ ...regions.ramD000, type: 'ram', infoId: 'ram' });
        } else if (state.charen) {
            layout.push({ ...regions.io, type: 'io', infoId: 'io' });
        } else {
            layout.push({ ...regions.charrom, type: 'charrom', infoId: 'charrom' });
        }

        // $E000-$FFFF: KERNAL, RAM, or Cart ROMH (Ultimax)
        if (state.game && !state.exrom) {
            // Ultimax mode - ROMH at $E000
            layout.push({
                start: 0xE000, end: 0xFFFF,
                name: 'CARTRIDGE ROM HI', size: '8 KB',
                type: 'cart-hi', infoId: 'cart-hi'
            });
        } else if (state.hiram) {
            layout.push({ ...regions.kernal, type: 'kernal', infoId: 'kernal' });
        } else {
            layout.push({ ...regions.ramE000, type: 'ram', infoId: 'ram' });
        }

        return layout;
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
        const layout = getMemoryLayout();
        const portValue = calculatePortValue();
        const gridRows = getGridRows();

        // Update port value display
        portValueDisplay.textContent = '$' + portValue.toString(16).toUpperCase().padStart(2, '0');

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

                const cpuDiv = document.createElement('div');
                cpuDiv.className = `memory-cell region-${region.type}`;
                cpuDiv.dataset.info = region.infoId;

                if (region.infoId === 'stack') {
                    // Special layout for stack with arrow on right
                    cpuDiv.innerHTML = `
                            <div>
                            <div class="region-name">${region.name}</div>
                            <div class="region-size">${region.size}</div>
                            <div class="stack-arrow">grows down</div>
                            </div>
                            `;
                } else {
                    cpuDiv.innerHTML = `
                            <div>
                            <div class="region-name">${region.name}</div>
                            <div class="region-size">${region.size}</div>
                            </div>
                            `;
                }

                cpuDiv.addEventListener('click', () => showRegionInfo(region.infoId));
                cpuDiv.addEventListener('mouseenter', () => showRegionInfo(region.infoId));
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

                const vicDiv = document.createElement('div');

                if (isInVicBank && vicSpanInfo) {
                    // Apply rowspan if greater than 1
                    if (vicSpanInfo.rowspan > 1) {
                        vicCell.rowSpan = vicSpanInfo.rowspan;
                    }

                    const vicResult = vicSpanInfo.vicResult;
                    // Calculate the full range for this merged cell
                    const spanEndRow = gridRows[idx + vicSpanInfo.rowspan - 1];
                    const spanStart = gridRow.start;
                    const spanEnd = spanEndRow ? spanEndRow.end : gridRow.end;

                    vicDiv.className = `memory-cell region-${vicResult.type} vic-visible`;
                    vicDiv.innerHTML = `
                            <div>
                            <div class="region-name">${vicResult.label}</div>
                            ${vicResult.detail ? `<div class="region-size">${vicResult.detail}</div>` : ''}
                            </div>
                            `;

                    const vicRegionInfo = {
                        name: vicResult.label,
                        start: spanStart,
                        end: spanEnd,
                        type: vicResult.type
                    };
                    vicDiv.addEventListener('click', () => showVicRegionInfo(vicRegionInfo));
                    vicDiv.addEventListener('mouseenter', () => showVicRegionInfo(vicRegionInfo));
                } else if (!isInVicBank) {
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

        // Store layout for next comparison
        previousLayout = layout;

        // Update config summary
        updateConfigSummary(layout);

        // Update VIC range display
        if (vicRangeDisplay) {
            vicRangeDisplay.textContent = `$${vicBankStart.toString(16).toUpperCase().padStart(4, '0')}-$${vicBankEnd.toString(16).toUpperCase().padStart(4, '0')}`;
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
        const hasCharRom = layout.some(r => r.type === 'charrom');

        detailContainers.forEach(container => {
            const start = parseInt(container.dataset.start);
            const end = parseInt(container.dataset.end);

            // Find entries in this range
            const entriesInRange = memoryEntries.filter(entry => {
                const addr = entry.address;
                if (addr < start || addr > end) return false;

                // Filter based on banking - hide entries for banked-out ROMs
                const region = entry.region;
                if (region === 'basic' && !hasBasic) return false;
                if (region === 'kernal' && !hasKernal) return false;
                // VIC, SID, CIA entries only visible when I/O is visible
                if ((region === 'vic' || region === 'sid' || region === 'cia1' || region === 'cia2') && !hasIO) return false;

                return true;
            });

            // Create cells for each entry
            entriesInRange.forEach(entry => {
                const cell = document.createElement('div');
                cell.className = 'mem-cell';
                cell.title = `$${entry.hex_addr} - ${entry.name}`;
                cell.addEventListener('click', (e) => {
                    e.stopPropagation();
                    showEntryDetails(entry);
                });
                cell.addEventListener('mouseenter', () => showEntryDetails(entry));
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
        } else if (region.type === 'vic-chars') {
            desc = 'In banks 0 and 2, the VIC-II sees the built-in character ROM here instead of RAM. This provides the default character set. In banks 1 and 3, this is regular RAM for custom character sets.';
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

    function showRegionInfo(infoId) {
        // Get region information from info panels
        const infoPanel = document.getElementById(`info-${infoId}`);
        if (infoPanel) {
            const title = infoPanel.querySelector('h3')?.textContent || 'Memory Region';
            const range = infoPanel.querySelector('.range')?.textContent || '';
            const desc = infoPanel.querySelector('p')?.textContent || '';

            // Update the main entry details panel with region info
            document.getElementById('entry-name').textContent = title;
            document.getElementById('entry-address').textContent = range;
            document.getElementById('entry-description').textContent = desc;
            document.getElementById('entry-title').style.display = 'none';
            document.getElementById('entry-bits-container').style.display = 'none';
        }

        // Highlight the clicked region
        document.querySelectorAll('.memory-region').forEach(region => {
            region.style.outline = 'none';
        });

        const clickedRegions = document.querySelectorAll(`.memory-region[data-info="${infoId}"]`);
        clickedRegions.forEach(region => {
            region.style.outline = '2px solid var(--c64-yellow)';
        });
    }

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
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
            document.querySelectorAll('.memory-region').forEach(r => r.style.outline = 'none');
            resetEntryDetails();
        }
    });

    //
    // Show details for a specific memory entry in the info panel
    //
    function showEntryDetails(entry, persist = false) {
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
                const bitLabel = bit.bit_end
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
        addressEl.textContent = 'Hover over cells for details';
        titleEl.style.display = 'none';
        descEl.textContent = 'The cells on the right of each memory region show documented memory locations from "Mapping the Commodore 64".';
        bitsContainer.style.display = 'none';

        document.querySelectorAll('.mem-cell.active').forEach(c => c.classList.remove('active'));
    }
});
