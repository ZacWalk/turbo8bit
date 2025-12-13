//
// @fileoverview VIC-II Graphics - Video rendering for Turbo8bit
// @module emulator/vic_ii
//
// This module provides VIC-II video chip emulation and rendering:
// - C64 color palette (VICE default)
// - All VIC-II graphics modes:
//   - Standard Character Mode (text mode)
//   - Multicolor Character Mode
//   - Standard Bitmap Mode (hires)
//   - Multicolor Bitmap Mode
//   - Extended Background Color Mode (ECM)
// - Sprite rendering with multicolor and expansion support
//
// For the visual emulator UI, see emulator.js (C64Emulator).
// For the core machine emulation, see machine.js (C64Machine).
//
// @see https://www.turbo8bit.com/
//

import { rom_chars } from './roms.js';

// ============================================================================
// VIC-II CONTROL REGISTERS
// ============================================================================

// Control Register 1 ($D011)
// Bit 7: Raster compare bit 8
// Bit 6: ECM - Extended Color Mode
// Bit 5: BMM - Bitmap Mode
// Bit 4: DEN - Display Enable
// Bit 3: RSEL - Row Select (24/25 rows)
// Bits 0-2: YSCROLL
export const VIC_CTRL1 = 0xD011;

// Control Register 2 ($D016)
// Bit 5: RES - Reset (unused)
// Bit 4: MCM - Multicolor Mode
// Bit 3: CSEL - Column Select (38/40 columns)
// Bits 0-2: XSCROLL
export const VIC_CTRL2 = 0xD016;

// Memory Control Register ($D018)
// Bits 4-7: Video matrix base address (VM13-VM10)
// Bits 1-3: Character generator base address (CB13-CB11)
// Bit 0: Unused
export const VIC_MEMORY = 0xD018;

// Background color registers
export const VIC_BGCOLOR0 = 0xD021;  // Background color 0
export const VIC_BGCOLOR1 = 0xD022;  // Background color 1 (multicolor/ECM)
export const VIC_BGCOLOR2 = 0xD023;  // Background color 2 (multicolor/ECM)
export const VIC_BGCOLOR3 = 0xD024;  // Background color 3 (ECM only)

// Border color register
export const VIC_BORDER = 0xD020;

// ============================================================================
// VIC-II GRAPHICS MODE BITS
// ============================================================================

// Mode control bits from D011/D016
export const ECM_BIT = 0x40;  // Extended Color Mode (D011 bit 6)
export const BMM_BIT = 0x20;  // Bitmap Mode (D011 bit 5)
export const MCM_BIT = 0x10;  // Multicolor Mode (D016 bit 4)

// ============================================================================
// VIC-II GRAPHICS MODE CONSTANTS
// ============================================================================

// Graphics mode numerical constants (more efficient than strings)
export const MODE_STANDARD_CHARACTER = 0;
export const MODE_MULTICOLOR_CHARACTER = 1;
export const MODE_STANDARD_BITMAP = 2;
export const MODE_MULTICOLOR_BITMAP = 3;
export const MODE_EXTENDED_BACKGROUND = 4;
export const MODE_INVALID = 5;

// ============================================================================
// VIC-II MEMORY ADDRESSES
// ============================================================================

// Default screen memory address ($0400)
export const SCREEN_ADDR = 0x0400;

// Color RAM address ($D800)
export const COLOR_RAM = 0xD800;

// Sprite enable register ($D015)
export const SPRITE_ENABLE = 0xD015;

// Sprite X expand register ($D01D)
export const SPRITE_X_EXPAND = 0xD01D;

// Sprite Y expand register ($D017)
export const SPRITE_Y_EXPAND = 0xD017;

// Sprite multicolor mode register ($D01C)
export const SPRITE_MULTICOLOR = 0xD01C;

// Sprite data priority register ($D01B)
// Bit = 0: Sprite is in front of background
// Bit = 1: Sprite is behind background
export const SPRITE_PRIORITY = 0xD01B;

// Sprite data pointer base address ($07F8)
export const SPRITE_DATA_PTR = 0x07F8;

// ============================================================================
// VIC-II COORDINATE SYSTEM
// ============================================================================
// Sprites use absolute VIC-II coordinates where:
// - X=24 is the first visible column of the display window
// - Y=50 is the first visible row of the display window
// These offsets convert between VIC coordinates and our canvas coordinates
export const SPRITE_X_OFFSET = 24;
export const SPRITE_Y_OFFSET = 50;

// ============================================================================
// C64 COLOR PALETTE
// ============================================================================

//
// C64 Color Palette (VICE default)
// 16 colors indexed 0-15: black, white, red, cyan, purple, green, blue, yellow,
// orange, brown, light red, dark grey, grey, light green, light blue, light grey
//
export const PALETTE = [
    0x000000, 0xFFFFFF, 0x68372B, 0x70A4B2,
    0x6F3D86, 0x588D43, 0x352879, 0xB8C76F,
    0x6F4F25, 0x433900, 0x9A6759, 0x444444,
    0x6C6C6C, 0x9AD284, 0x6C5EB5, 0x959595
];

// ============================================================================
// CHARACTER ROM
// ============================================================================
// VIC-II RENDERER
// ============================================================================

//
// VIC-II Renderer - Handles all C64 graphics rendering
//
// Renders the C64 screen including:
// - Border and background colors
// - All VIC-II graphics modes:
//   - Standard Character Mode (text mode)
//   - Multicolor Character Mode
//   - Standard Bitmap Mode (hires)
//   - Multicolor Bitmap Mode
//   - Extended Background Color Mode (ECM)
// - Sprites (8 hardware sprites with multicolor and expansion)
//
// Frame buffer dimensions for scanline rendering
// We render to a frame buffer during CPU execution, then blit to canvas
export const FRAME_BUFFER_WIDTH = 384;   // Canvas width including border
export const FRAME_BUFFER_HEIGHT = 272;  // Canvas height including border
// VIC-II raster line that corresponds to the top of our visible canvas (including border)
// Screen content starts at raster 51, but we show 36 pixels of border above it
export const FIRST_VISIBLE_RASTER = 51 - 36;  // = 15
export const VISIBLE_RASTER_LINES = 272; // Number of visible raster lines

export class VICIIRenderer {
    //
    // Create a VIC-II renderer
    // @param {number} width - Canvas width (default 384 for border)
    // @param {number} height - Canvas height (default 272 for border)
    //
    constructor(width = 384, height = 272) {
        this.width = width;
        this.height = height;
        this.screenWidth = 320;
        this.screenHeight = 200;
        this.borderX = (width - this.screenWidth) >> 1;
        this.borderY = (height - this.screenHeight) >> 1;

        // Pre-allocate ImageData to avoid GC pressure (384*272*4 = 417KB)
        // ImageData is a browser API - check if available (not in Node/test environments)
        if (typeof ImageData !== 'undefined') {
            this.imageData = new ImageData(width, height);
            this.imageDataArray = this.imageData.data;
        } else {
            this.imageData = null;
            this.imageDataArray = null;
        }
    }

    //
    // Get the current graphics mode from VIC-II registers
    // @param {Uint8Array} ram - C64 RAM
    // @returns {number} Graphics mode constant (MODE_*)
    //
    getGraphicsMode(ram) {
        const ctrl1 = ram[VIC_CTRL1];
        const ctrl2 = ram[VIC_CTRL2];

        const ecm = ctrl1 & ECM_BIT;  // Extended Color Mode
        const bmm = ctrl1 & BMM_BIT;  // Bitmap Mode
        const mcm = ctrl2 & MCM_BIT;  // Multicolor Mode

        // Determine the graphics mode (some combinations are invalid)
        // ECM + BMM or ECM + BMM + MCM produce invalid modes (black screen)
        if (ecm && bmm) {
            return MODE_INVALID;
        } else if (bmm && mcm) {
            return MODE_MULTICOLOR_BITMAP;
        } else if (bmm) {
            return MODE_STANDARD_BITMAP;
        } else if (ecm) {
            return MODE_EXTENDED_BACKGROUND;
        } else if (mcm) {
            return MODE_MULTICOLOR_CHARACTER;
        } else {
            return MODE_STANDARD_CHARACTER;
        }
    }

    //
    // Get scroll values from VIC-II registers
    // @param {Uint8Array} ram - C64 RAM
    // @returns {Object} { xscroll, yscroll }
    //
    getScrollValues(ram) {
        const ctrl1 = ram[VIC_CTRL1];
        const ctrl2 = ram[VIC_CTRL2];

        // XSCROLL: bits 0-2 of $D016 (0-7 pixels horizontal scroll)
        // YSCROLL: bits 0-2 of $D011 (0-7 pixels vertical scroll)
        const xscroll = ctrl2 & 0x07;
        const yscroll = ctrl1 & 0x07;

        return { xscroll, yscroll };
    }

    //
    // Get video matrix (screen) and character/bitmap memory addresses
    // Based on VIC-II bank and memory control register ($D018)
    //
    // VIC-II bank is controlled by CIA2 Port A ($DD00) bits 0-1 (inverted):
    //   %11 = bank 0: $0000-$3FFF
    //   %10 = bank 1: $4000-$7FFF
    //   %01 = bank 2: $8000-$BFFF
    //   %00 = bank 3: $C000-$FFFF
    //
    // Character ROM is visible to VIC-II at:
    //   Bank 0: $1000-$1FFF and $1800-$1FFF
    //   Bank 2: $9000-$9FFF and $9800-$9FFF
    //   (Not visible in banks 1 and 3)
    //
    // @param {Uint8Array} ram - C64 RAM
    // @returns {Object} { vicBank, screenAddr, charAddr, bitmapAddr, useCharROM }
    //
    getMemoryAddresses(ram) {
        // Get VIC bank from CIA2 $DD00 (bits 0-1, inverted)
        const cia2PortA = ram[0xDD00];
        const vicBankNum = (~cia2PortA) & 0x03;  // Invert bits 0-1
        const vicBank = vicBankNum * 0x4000;     // Bank base address: 0, $4000, $8000, $C000

        const memCtrl = ram[VIC_MEMORY];

        // Screen memory: bits 4-7 of $D018 * 0x0400 + VIC bank
        const screenAddr = vicBank + ((memCtrl >> 4) & 0x0F) * 0x0400;

        // Character memory: bits 1-3 of $D018 * 0x0800 + VIC bank
        // In bitmap mode, this becomes bitmap base (bit 3 only matters: 0 = $0000, 1 = $2000)
        const charOffset = ((memCtrl >> 1) & 0x07) * 0x0800;
        const charAddr = vicBank + charOffset;
        const bitmapAddr = vicBank + ((memCtrl & 0x08) ? 0x2000 : 0x0000);

        // Character ROM is visible to VIC-II at $1000-$1FFF within banks 0 and 2
        // (i.e., at absolute addresses $1000-$1FFF and $9000-$9FFF)
        // In banks 1 and 3, character ROM is NOT visible (VIC sees RAM instead)
        const useCharROM = (vicBankNum === 0 || vicBankNum === 2) &&
            (charOffset === 0x1000 || charOffset === 0x1800);

        return { vicBank, screenAddr, charAddr, bitmapAddr, useCharROM };
    }

    //
    // Check if the current raster line is a "Bad Line"
    // A Bad Line occurs when the VIC-II needs to fetch character pointers,
    // stunning the CPU for ~40 cycles.
    // Conditions:
    // 1. Display enabled (DEN = 1)
    // 2. Raster line is within the text display area ($30-$F7)
    // 3. Lower 3 bits of raster line match YSCROLL
    //
    // @param {Uint8Array} ram - C64 RAM
    // @param {number} rasterLine - Current raster line
    // @returns {boolean} True if Bad Line
    //
    checkBadLine(ram, rasterLine) {
        const ctrl1 = ram[VIC_CTRL1];

        // 1. Display enabled (Bit 4)
        if (!(ctrl1 & 0x10)) return false;

        // 2. Within text display area (approx $30-$F7)
        // Note: This range is for PAL. NTSC might differ slightly but this is standard.
        if (rasterLine < 0x30 || rasterLine > 0xF7) return false;

        // 3. Raster line bits 0-2 match YSCROLL
        const yscroll = ctrl1 & 0x07;
        return (rasterLine & 0x07) === yscroll;
    }

    //
    // Render a single scanline to a frame buffer (Uint32Array)
    // Called during CPU execution for accurate per-scanline graphics
    //
    // @param {Uint32Array} frameBuffer - Frame buffer (width * height pixels, RGBA packed)
    // @param {Uint8Array} ram - C64 RAM (64KB)
    // @param {number} rasterLine - VIC-II raster line number (0-311)
    //
    renderScanline(frameBuffer, ram, rasterLine) {
        // Convert VIC-II raster line to canvas Y coordinate
        const canvasY = rasterLine - FIRST_VISIBLE_RASTER;

        // Skip if outside visible area
        if (canvasY < 0 || canvasY >= this.height) return;

        const w = this.width;

        // Get colors for this scanline
        const borderColor = PALETTE[ram[0xD020] & 0x0F];
        const bgColor = PALETTE[ram[0xD021] & 0x0F];

        // Determine if this scanline is in the main display area (Y)
        const inScreenY = canvasY >= this.borderY && canvasY < (this.borderY + this.screenHeight);

        // First, fill the entire scanline with border/background color
        const rowOffset = canvasY * w;
        for (let x = 0; x < w; x++) {
            const inScreenX = x >= this.borderX && x < (this.borderX + this.screenWidth);
            if (inScreenX && inScreenY) {
                frameBuffer[rowOffset + x] = bgColor;
            } else {
                frameBuffer[rowOffset + x] = borderColor;
            }
        }

        // If not in the main display area, we're done (border only)
        if (!inScreenY) return;

        // Get graphics mode
        const mode = this.getGraphicsMode(ram);
        if (mode === MODE_INVALID) return; // Black screen for invalid modes (already bg)

        // Get memory addresses and scroll values once for this scanline
        const memAddrs = this.getMemoryAddresses(ram);
        const { xscroll, yscroll } = this.getScrollValues(ram);
        const rsel = (ram[VIC_CTRL1] & 0x08) !== 0;

        // Calculate which character row this scanline belongs to
        // Screen area starts at canvasY = borderY
        // YSCROLL shifts the display down by 0-7 pixels within the display window
        const screenY = canvasY - this.borderY;  // 0-199 within the 200-line screen area

        // RSEL (24-row) masking
        // When RSEL=0, the display window is 192 lines high (24 rows).
        // The top 4 and bottom 4 lines of the 200-line area are covered by border.
        if (!rsel && (screenY < 4 || screenY >= 196)) return;

        const adjustedScreenY = screenY - yscroll;  // Adjust for vertical scroll

        // If adjusted Y is outside the 0-199 range, this scanline shows background only
        if (adjustedScreenY < 0 || adjustedScreenY >= 200) return;

        const charRow = (adjustedScreenY >> 3);          // Character row 0-24
        const charPixelY = adjustedScreenY & 7;          // Pixel row within character 0-7

        // Render the appropriate graphics mode for this scanline
        switch (mode) {
            case MODE_STANDARD_CHARACTER:
                this.renderScanlineStandardCharacter(frameBuffer, ram, canvasY, charRow, charPixelY, memAddrs, xscroll);
                break;
            case MODE_MULTICOLOR_CHARACTER:
                this.renderScanlineMulticolorCharacter(frameBuffer, ram, canvasY, charRow, charPixelY, memAddrs, xscroll);
                break;
            case MODE_STANDARD_BITMAP:
                this.renderScanlineStandardBitmap(frameBuffer, ram, canvasY, charRow, charPixelY, memAddrs, xscroll);
                break;
            case MODE_MULTICOLOR_BITMAP:
                this.renderScanlineMulticolorBitmap(frameBuffer, ram, canvasY, charRow, charPixelY, memAddrs, xscroll);
                break;
            case MODE_EXTENDED_BACKGROUND:
                this.renderScanlineExtendedBackground(frameBuffer, ram, canvasY, charRow, charPixelY, memAddrs, xscroll);
                break;
        }

        // Render sprites for this scanline
        this.renderSpriteScanline(frameBuffer, ram, canvasY, rasterLine, memAddrs);
    }

    //
    // Render a complete frame by blitting the frame buffer to the canvas
    // The frame buffer is populated by renderScanline() during CPU execution
    // @param {CanvasRenderingContext2D} ctx - Canvas context
    // @param {Object} vic - VIC-II state with frame buffer
    //
    render(ctx, vic) {
        // Lazy-initialize if not done in constructor (e.g., non-browser environment)
        if (this.imageDataArray) {
            this.blitFrameBuffer(this.imageDataArray, vic.frameBuffer);
            ctx.putImageData(this.imageData, 0, 0);
        }
    }

    //
    // Blit frame buffer (Uint32Array of RGB values) to ImageData
    // @param {Uint8ClampedArray} imageData - Canvas ImageData array
    // @param {Uint32Array} frameBuffer - Frame buffer with packed RGB values
    //
    blitFrameBuffer(imageData, frameBuffer) {
        const len = this.width * this.height;
        for (let i = 0; i < len; i++) {
            const color = frameBuffer[i];
            const o = i << 2;
            imageData[o] = (color >> 16) & 255;     // R
            imageData[o + 1] = (color >> 8) & 255;  // G
            imageData[o + 2] = color & 255;         // B
            imageData[o + 3] = 255;                 // A
        }
    }

    // ========================================================================
    // SCANLINE RENDERING METHODS (for frame buffer rendering)
    // ========================================================================

    //
    // Render one scanline of standard character mode to frame buffer
    // @private
    //
    renderScanlineStandardCharacter(frameBuffer, ram, canvasY, charRow, charPixelY, memAddrs, scrollX) {
        const { screenAddr, charAddr, useCharROM } = memAddrs;
        const w = this.width;
        const rowOffset = canvasY * w;
        const chars = useCharROM ? rom_chars : null;

        for (let c = 0; c < 40; c++) {
            const cell = screenAddr + charRow * 40 + c;
            const charCode = ram[cell];
            const color = PALETTE[ram[COLOR_RAM + charRow * 40 + c] & 0x0F];
            const glyphAddr = charCode * 8;

            const line = useCharROM
                ? (chars[glyphAddr + charPixelY] || 0)
                : ram[charAddr + glyphAddr + charPixelY];

            for (let cx = 0; cx < 8; cx++) {
                if (line & (0x80 >> cx)) {
                    const px = this.borderX + c * 8 + cx + scrollX;
                    if (px >= 0 && px < w) {
                        frameBuffer[rowOffset + px] = color;
                    }
                }
            }
        }
    }

    //
    // Render one scanline of multicolor character mode to frame buffer
    // @private
    //
    renderScanlineMulticolorCharacter(frameBuffer, ram, canvasY, charRow, charPixelY, memAddrs, scrollX) {
        const { screenAddr, charAddr, useCharROM } = memAddrs;
        const w = this.width;
        const rowOffset = canvasY * w;

        const bgColor0 = PALETTE[ram[VIC_BGCOLOR0] & 0x0F];
        const bgColor1 = PALETTE[ram[VIC_BGCOLOR1] & 0x0F];
        const bgColor2 = PALETTE[ram[VIC_BGCOLOR2] & 0x0F];
        const chars = useCharROM ? rom_chars : null;

        for (let c = 0; c < 40; c++) {
            const cell = screenAddr + charRow * 40 + c;
            const charCode = ram[cell];
            const colorRAM = ram[COLOR_RAM + charRow * 40 + c];
            const isMulticolor = (colorRAM & 0x08) !== 0;
            const fgColor = colorRAM & 0x07;
            const glyphAddr = charCode * 8;

            const line = useCharROM
                ? (chars[glyphAddr + charPixelY] || 0)
                : ram[charAddr + glyphAddr + charPixelY];

            if (isMulticolor) {
                for (let cx = 0; cx < 4; cx++) {
                    const bitPair = (line >> (6 - cx * 2)) & 0x03;
                    let color;
                    switch (bitPair) {
                        case 0: color = bgColor0; break;
                        case 1: color = bgColor1; break;
                        case 2: color = bgColor2; break;
                        case 3: color = PALETTE[fgColor]; break;
                    }
                    const px = this.borderX + c * 8 + cx * 2 + scrollX;
                    if (px >= 0 && px + 1 < w) {
                        frameBuffer[rowOffset + px] = color;
                        frameBuffer[rowOffset + px + 1] = color;
                    }
                }
            } else {
                const color = PALETTE[colorRAM & 0x0F];
                for (let cx = 0; cx < 8; cx++) {
                    if (line & (0x80 >> cx)) {
                        const px = this.borderX + c * 8 + cx + scrollX;
                        if (px >= 0 && px < w) {
                            frameBuffer[rowOffset + px] = color;
                        }
                    }
                }
            }
        }
    }

    //
    // Render one scanline of standard bitmap mode to frame buffer
    // @private
    //
    renderScanlineStandardBitmap(frameBuffer, ram, canvasY, charRow, charPixelY, memAddrs, scrollX) {
        const { screenAddr, bitmapAddr } = memAddrs;
        const w = this.width;
        const rowOffset = canvasY * w;

        for (let charCol = 0; charCol < 40; charCol++) {
            const colorByte = ram[screenAddr + charRow * 40 + charCol];
            const fgColor = PALETTE[(colorByte >> 4) & 0x0F];
            const bgColor = PALETTE[colorByte & 0x0F];

            const cellBitmapAddr = bitmapAddr + (charRow * 40 + charCol) * 8;
            const line = ram[cellBitmapAddr + charPixelY];

            for (let cx = 0; cx < 8; cx++) {
                const bit = (line >> (7 - cx)) & 1;
                const color = bit ? fgColor : bgColor;
                const px = this.borderX + charCol * 8 + cx + scrollX;
                if (px >= 0 && px < w) {
                    frameBuffer[rowOffset + px] = color;
                }
            }
        }
    }

    //
    // Render one scanline of multicolor bitmap mode to frame buffer
    // @private
    //
    renderScanlineMulticolorBitmap(frameBuffer, ram, canvasY, charRow, charPixelY, memAddrs, scrollX) {
        const { screenAddr, bitmapAddr } = memAddrs;
        const w = this.width;
        const rowOffset = canvasY * w;
        const bgColor0 = PALETTE[ram[VIC_BGCOLOR0] & 0x0F];

        for (let charCol = 0; charCol < 40; charCol++) {
            const screenByte = ram[screenAddr + charRow * 40 + charCol];
            const colorRAMByte = ram[COLOR_RAM + charRow * 40 + charCol];

            const color1 = PALETTE[(screenByte >> 4) & 0x0F];
            const color2 = PALETTE[screenByte & 0x0F];
            const color3 = PALETTE[colorRAMByte & 0x0F];

            const cellBitmapAddr = bitmapAddr + (charRow * 40 + charCol) * 8;
            const line = ram[cellBitmapAddr + charPixelY];

            for (let cx = 0; cx < 4; cx++) {
                const bitPair = (line >> (6 - cx * 2)) & 0x03;
                let color;
                switch (bitPair) {
                    case 0: color = bgColor0; break;
                    case 1: color = color1; break;
                    case 2: color = color2; break;
                    case 3: color = color3; break;
                }
                const px = this.borderX + charCol * 8 + cx * 2 + scrollX;
                if (px >= 0 && px + 1 < w) {
                    frameBuffer[rowOffset + px] = color;
                    frameBuffer[rowOffset + px + 1] = color;
                }
            }
        }
    }

    //
    // Render one scanline of extended background color mode to frame buffer
    // @private
    //
    renderScanlineExtendedBackground(frameBuffer, ram, canvasY, charRow, charPixelY, memAddrs, scrollX) {
        const { screenAddr, charAddr, useCharROM } = memAddrs;
        const w = this.width;
        const rowOffset = canvasY * w;
        const chars = useCharROM ? rom_chars : null;

        const bgColors = [
            PALETTE[ram[VIC_BGCOLOR0] & 0x0F],
            PALETTE[ram[VIC_BGCOLOR1] & 0x0F],
            PALETTE[ram[VIC_BGCOLOR2] & 0x0F],
            PALETTE[ram[VIC_BGCOLOR3] & 0x0F]
        ];

        for (let c = 0; c < 40; c++) {
            const cell = screenAddr + charRow * 40 + c;
            const charCode = ram[cell];
            const actualCharCode = charCode & 0x3F;
            const bgSelect = (charCode >> 6) & 0x03;
            const bgColor = bgColors[bgSelect];
            const fgColor = PALETTE[ram[COLOR_RAM + charRow * 40 + c] & 0x0F];
            const glyphAddr = actualCharCode * 8;

            const line = useCharROM
                ? (chars[glyphAddr + charPixelY] || 0)
                : ram[charAddr + glyphAddr + charPixelY];

            for (let cx = 0; cx < 8; cx++) {
                const px = this.borderX + c * 8 + cx + scrollX;
                if (px >= 0 && px < w) {
                    if (line & (0x80 >> cx)) {
                        frameBuffer[rowOffset + px] = fgColor;
                    } else {
                        frameBuffer[rowOffset + px] = bgColor;
                    }
                }
            }
        }
    }

    //
    // Render sprites for a single scanline to frame buffer
    // @private
    //
    renderSpriteScanline(frameBuffer, ram, canvasY, rasterLine, memAddrs) {
        const spriteEnable = ram[SPRITE_ENABLE];
        if (spriteEnable === 0) return;

        // Initialize collision buffer if needed
        if (!this.spriteCollisionBuffer || this.spriteCollisionBuffer.length !== this.width) {
            this.spriteCollisionBuffer = new Int8Array(this.width);
        }
        this.spriteCollisionBuffer.fill(-1);

        const spriteXExpand = ram[SPRITE_X_EXPAND];
        const spriteYExpand = ram[SPRITE_Y_EXPAND];
        const spriteMulticolor = ram[SPRITE_MULTICOLOR];
        const spritePriority = ram[SPRITE_PRIORITY];

        const spriteMulticolor0 = ram[0xD025] & 0x0F;
        const spriteMulticolor1 = ram[0xD026] & 0x0F;

        const { vicBank, screenAddr } = memAddrs;
        const spritePtrBase = screenAddr + 0x03F8;
        const bgColor = ram[0xD021] & 0x0F;
        const w = this.width;
        const rowOffset = canvasY * w;

        // Render sprites in reverse order (7 to 0) so lower-numbered sprites appear on top
        for (let sprite = 7; sprite >= 0; sprite--) {
            if (!(spriteEnable & (1 << sprite))) continue;

            const vicX = ram[0xD000 + sprite * 2] | ((ram[0xD010] & (1 << sprite)) ? 0x100 : 0);
            const vicY = ram[0xD001 + sprite * 2];

            // Convert VIC-II coordinates to canvas coordinates
            const spriteX = vicX - SPRITE_X_OFFSET + this.borderX;
            const spriteY = vicY - SPRITE_Y_OFFSET + this.borderY;

            const yExpand = spriteYExpand & (1 << sprite);
            const spriteHeight = yExpand ? 42 : 21;

            // Check if this scanline intersects the sprite
            if (canvasY < spriteY || canvasY >= spriteY + spriteHeight) continue;

            // Calculate which row of the sprite we're rendering
            const spriteRow = yExpand ? Math.floor((canvasY - spriteY) / 2) : (canvasY - spriteY);

            const spritePtr = ram[spritePtrBase + sprite];
            const spriteDataAddr = vicBank + spritePtr * 64;
            const spriteColor = ram[0xD027 + sprite] & 0x0F;

            const isMulticolor = spriteMulticolor & (1 << sprite);
            const xExpand = spriteXExpand & (1 << sprite);
            const isBehindBackground = spritePriority & (1 << sprite);

            // Render this row of the sprite (3 bytes = 24 pixels)
            for (let byteCol = 0; byteCol < 3; byteCol++) {
                const spriteDataByte = ram[spriteDataAddr + spriteRow * 3 + byteCol];

                if (isMulticolor) {
                    // Multicolor mode: 12 double-width pixels per row
                    for (let bitPairIdx = 0; bitPairIdx < 4; bitPairIdx++) {
                        const colorBits = (spriteDataByte >> (6 - bitPairIdx * 2)) & 0x03;
                        if (colorBits === 0) continue; // Transparent

                        let pixelColor;
                        switch (colorBits) {
                            case 1: pixelColor = spriteMulticolor0; break;
                            case 2: pixelColor = spriteColor; break;
                            case 3: pixelColor = spriteMulticolor1; break;
                        }

                        // Calculate pixel positions
                        const baseX = spriteX + byteCol * 8 + bitPairIdx * 2;
                        const xWidth = xExpand ? 4 : 2;

                        for (let dx = 0; dx < xWidth; dx++) {
                            const px = baseX + (xExpand ? dx * 1 : dx);
                            if (px >= 0 && px < w) {
                                // Collision checks
                                const otherSprite = this.spriteCollisionBuffer[px];
                                if (otherSprite !== -1) {
                                    ram[0xD01E] |= (1 << sprite) | (1 << otherSprite);
                                }
                                this.spriteCollisionBuffer[px] = sprite;

                                const bgPalette = PALETTE[ram[0xD021] & 0x0F];
                                if (frameBuffer[rowOffset + px] !== bgPalette) {
                                    ram[0xD01F] |= (1 << sprite);
                                }

                                // Priority check: if behind background, only draw on background pixels
                                if (isBehindBackground) {
                                    const existingColor = frameBuffer[rowOffset + px];
                                    // const bgPalette = PALETTE[bgColor];
                                    if (existingColor !== bgPalette) continue;
                                }
                                frameBuffer[rowOffset + px] = PALETTE[pixelColor];
                            }
                        }
                    }
                } else {
                    // Single color mode
                    for (let bit = 0; bit < 8; bit++) {
                        if (!(spriteDataByte & (0x80 >> bit))) continue;

                        const baseX = spriteX + byteCol * 8 + bit;
                        const xWidth = xExpand ? 2 : 1;

                        for (let dx = 0; dx < xWidth; dx++) {
                            const px = baseX + (xExpand ? dx : 0);
                            if (px >= 0 && px < w) {
                                // Collision checks
                                const otherSprite = this.spriteCollisionBuffer[px];
                                if (otherSprite !== -1) {
                                    ram[0xD01E] |= (1 << sprite) | (1 << otherSprite);
                                }
                                this.spriteCollisionBuffer[px] = sprite;

                                const bgPalette = PALETTE[ram[0xD021] & 0x0F];
                                if (frameBuffer[rowOffset + px] !== bgPalette) {
                                    ram[0xD01F] |= (1 << sprite);
                                }

                                // Priority check
                                if (isBehindBackground) {
                                    const existingColor = frameBuffer[rowOffset + px];
                                    const bgPalette = PALETTE[bgColor];
                                    if (existingColor !== bgPalette) continue;
                                }
                                frameBuffer[rowOffset + px] = PALETTE[spriteColor];
                            }
                        }
                    }
                }
            }
        }
    }
}

