; Smooth Vertical Scrolling - Star Wars Style
; Yellow text on black, scrolling upward
;
; Text lines: first byte = screen offset, then text, then $00 terminator
; Blank lines indicated by $FF marker (no text data needed)
; End of all lines marked by $FE

    ORG $0800

; Zero-page pointer (required for indirect indexed addressing)
LINEPTR = $FB       ; 2-byte pointer at $FB/$FC

    SEI             ; Disable interrupts

    ; Disable ALL CIA interrupts (only raster IRQ will run)
    LDA #$7F
    STA $DC0D       ; Disable CIA1 interrupts (keyboard scan, etc.)
    STA $DD0D       ; Disable CIA2 interrupts (NMI sources)
    LDA $DC0D       ; Acknowledge any pending CIA1
    LDA $DD0D       ; Acknowledge any pending CIA2

    ; Clear any pending VIC-II interrupts
    LDA #$FF
    STA $D019       ; Acknowledge all VIC-II interrupt flags

    ; Set colors FIRST - black background and border
    ; (so screen clear appears on black, not blue)
    LDA #$00
    STA $D021       ; Black background
    STA $D020       ; Black border

    ; Clear screen with spaces
    LDA #$20        ; Space character
    LDX #$00
CLR:
    STA $0400,X
    STA $0500,X
    STA $0600,X
    STA $06E8,X
    INX
    BNE CLR

    ; Set all color RAM to yellow ($07)
    LDA #$07        ; Yellow
    LDX #$00
SETCOL:
    STA $D800,X
    STA $D900,X
    STA $DA00,X
    STA $DAE8,X
    INX
    BNE SETCOL

    ; Set up raster IRQ at bottom of screen
    LDA #$FC
    STA $D012
    LDA $D011
    AND #$7F
    STA $D011
    LDA #$01
    STA $D01A       ; Enable raster IRQ

    LDA #<IRQ
    STA $0314
    LDA #>IRQ
    STA $0315

    ; Initialize scroll position and line pointer
    LDA #$07
    STA YSCROLL
    LDA #<LINES
    STA LINEPTR     ; Zero-page pointer low byte
    LDA #>LINES
    STA LINEPTR+1   ; Zero-page pointer high byte
    LDA #$00
    STA TRAILCT     ; Trailing blank counter
    LDA #$05        ; Start with 5 blank lines (quick scroll in from bottom)
    STA LEADBLK

    CLI

    ; Wait loop - runs until done scrolling
WAIT:
    LDA DONE
    BEQ WAIT
    RTS

; IRQ handler - called every frame
IRQ:
    ; Decrement scroll counter
    DEC YSCROLL
    BPL UPDATEREG   ; If >= 0, just update register

    ; Scroll wrapped - reset counter
    LDA #$07
    STA YSCROLL

    ; Update scroll register IMMEDIATELY
    ; This ensures the next frame starts with the correct scroll position
    ; even if the memory move takes a long time
    LDA $D011
    AND #$F8
    ORA YSCROLL
    STA $D011

    ; Shift entire screen up by one row
    ; This takes a long time (~13k cycles) but since we updated
    ; the scroll register first, the display will be stable
    LDX #$00
SHIFT1:
    LDA $0428,X
    STA $0400,X
    INX
    BNE SHIFT1
    LDX #$00
SHIFT2:
    LDA $0528,X
    STA $0500,X
    INX
    BNE SHIFT2
    LDX #$00
SHIFT3:
    LDA $0628,X
    STA $0600,X
    INX
    BNE SHIFT3
    LDX #$00
SHIFT4:
    LDA $0728,X
    STA $0700,X
    INX
    CPX #$C0
    BNE SHIFT4

    ; Draw next line at row 24
    JSR DRAWLINE
    
    ; Done with heavy lifting
    JMP ACKIRQ

UPDATEREG:
    LDA $D011
    AND #$F8
    ORA YSCROLL
    STA $D011

ACKIRQ:
    LDA #$01
    STA $D019       ; Acknowledge raster interrupt
    JMP $EA81       ; KERNAL IRQ exit (restore regs + RTI, no cursor/keyboard)

; Draw next line of text at row 24 ($07C0)
DRAWLINE:
    ; First clear row 24 with spaces
    LDA #$20
    LDX #$00
CLRROW:
    STA $07C0,X
    INX
    CPX #$28
    BNE CLRROW

    ; Check if we're in leading blank phase
    LDA LEADBLK
    BEQ CHKTEXT
    DEC LEADBLK
    RTS

CHKTEXT:
    ; Get line marker
    LDY #$00
    LDA (LINEPTR),Y
    CMP #$FE        ; End marker?
    BNE NOTDONE
    ; All done - start trailing blanks
    INC TRAILCT
    LDA TRAILCT
    CMP #$1A        ; 26 trailing blanks (scroll off + 1)
    BNE NOTFIN
    LDA #$01
    STA DONE
NOTFIN:
    RTS

NOTDONE:
    CMP #$FF        ; Blank line marker?
    BNE HASTEXT
    ; Skip to next line
    INC LINEPTR
    BNE NOHI1
    INC LINEPTR+1
NOHI1:
    RTS

HASTEXT:
    ; First byte is offset
    TAX             ; X = screen offset
    INY             ; Point to text

COPYLOOP:
    LDA (LINEPTR),Y
    BEQ LINEDONE    ; Zero terminator
    STA $07C0,X
    INX
    INY
    BNE COPYLOOP    ; Always branches

LINEDONE:
    ; Advance pointer past this line
    INY             ; Skip the zero terminator
    TYA
    CLC
    ADC LINEPTR
    STA LINEPTR
    BCC NOHI2
    INC LINEPTR+1
NOHI2:
    RTS

; Variables (in main memory, not zero-page)
YSCROLL:
    BYTE $07
LEADBLK:
    BYTE $05        ; 5 leading blank lines
TRAILCT:
    BYTE $00        ; Trailing blank counter
DONE:
    BYTE $00        ; Done flag

; Text lines - format: offset, text bytes, $00 terminator
; $FF = blank line, $FE = end of all lines
; Screen codes: A=$01, B=$02, etc. Space=$20, 0-9=$30-$39

LINES:
    ; "A LONG TIME AGO IN A GALAXY FAR FAR AWAY" (40 chars, offset 0)
    BYTE $00
    BYTE $01,$20,$0C,$0F,$0E,$07,$20,$14,$09,$0D,$05,$20,$01,$07,$0F
    BYTE $20,$09,$0E,$20,$01,$20,$07,$01,$0C,$01,$18,$19,$20,$06,$01
    BYTE $12,$20,$06,$01,$12,$20,$01,$17,$01,$19,$00
    ; blank
    BYTE $FF
    ; "WHEN 64KB WAS ENOUGH" (20 chars, offset 10)
    BYTE $0A
    BYTE $17,$08,$05,$0E,$20,$36,$34,$0B,$02,$20,$17,$01,$13,$20,$05
    BYTE $0E,$0F,$15,$07,$08,$00
    ; blank
    BYTE $FF
    ; "THE UNIVERSE FIT ON A 5.25 INCH FLOPPY" (38 chars, offset 1)
    BYTE $01
    BYTE $14,$08,$05,$20,$15,$0E,$09,$16,$05,$12,$13,$05,$20,$06,$09
    BYTE $14,$20,$0F,$0E,$20,$01,$20,$35,$2E,$32,$35,$20,$09,$0E,$03
    BYTE $08,$20,$06,$0C,$0F,$10,$10,$19,$00
    ; blank
    BYTE $FF
    ; "WHERE 16 COLORS WERE ALL A REBEL NEEDED" (39 chars, offset 0)
    BYTE $00
    BYTE $17,$08,$05,$12,$05,$20,$31,$36,$20,$03,$0F,$0C,$0F,$12,$13
    BYTE $20,$17,$05,$12,$05,$20,$01,$0C,$0C,$20,$01,$20,$12,$05,$02
    BYTE $05,$0C,$20,$0E,$05,$05,$04,$05,$04,$00
    ; blank
    BYTE $FF
    ; "A SINGLE POKE COULD TURN SKY TO BLACK" (37 chars, offset 1)
    BYTE $01
    BYTE $01,$20,$13,$09,$0E,$07,$0C,$05,$20,$10,$0F,$0B,$05,$20,$03
    BYTE $0F,$15,$0C,$04,$20,$14,$15,$12,$0E,$20,$13,$0B,$19,$20,$14
    BYTE $0F,$20,$02,$0C,$01,$03,$0B,$00
    ; End marker
    BYTE $FE