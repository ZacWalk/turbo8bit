; Smooth Horizontal Scrolling
; Uses VIC-II scroll register to smoothly scroll text
; telling the story of the VIC-II chip designers
;
; $D016 bits 0-2 = horizontal scroll (0-7 pixels)
; When scroll reaches 0, shift all characters left

    ORG $0800

    SEI             ; Disable interrupts

    ; Disable CIA1 timer interrupts (they interfere!)
    LDA #$7F        ; Clear all CIA1 interrupt sources
    STA $DC0D
    LDA $DC0D       ; Read to acknowledge any pending

    ; Clear screen first
    LDA #$20        ; Space character
    LDX #$00
CLR:
    STA $0400,X     ; Screen RAM page 1
    STA $0500,X     ; Screen RAM page 2
    STA $0600,X     ; Screen RAM page 3
    STA $06E8,X     ; Screen RAM page 4
    INX
    BNE CLR

    ; Set colors
    LDA #$00        ; Black background
    STA $D021
    LDA #$06        ; Blue border
    STA $D020

    ; Set up raster IRQ for smooth timing
    LDA #$FC        ; Bottom of screen
    STA $D012
    LDA $D011
    AND #$7F
    STA $D011
    LDA #$01
    STA $D01A       ; Enable raster IRQ

    LDA #<IRQ       ; Low byte of IRQ handler
    STA $0314
    LDA #>IRQ       ; High byte of IRQ handler
    STA $0315

    ; Initialize scroll position
    LDA #$07
    STA XSCROLL     ; Start at scroll position 7
    LDA #$00
    STA TEXTPOS     ; Start at beginning of text

    CLI
    RTS

; IRQ handler - called every frame
IRQ:
    ; Decrement scroll counter
    DEC XSCROLL
    BPL SETSCROLL   ; If >= 0, just set scroll register

    ; Scroll wrapped - shift characters left
    LDA #$07
    STA XSCROLL     ; Reset scroll to 7

    ; Shift line 12 left by one character
    LDX #$00
SHIFT:
    LDA $05E1,X     ; Row 12, column X+1
    STA $05E0,X     ; Row 12, column X
    INX
    CPX #$27        ; 39 characters
    BNE SHIFT

    ; Put next character at rightmost position
    LDX TEXTPOS
    LDA TEXT,X      ; Get next character
    BNE NOTEND      ; If not zero, use it
    LDX #$00        ; Reset to start
    STX TEXTPOS
    LDA TEXT,X
NOTEND:
    INX
    STX TEXTPOS     ; Save next position

    ; Convert to screen code and display
    STA $0607       ; Row 12, column 39

SETSCROLL:
    ; Set VIC-II horizontal scroll
    LDA $D016       ; Get current value
    AND #$F8        ; Clear scroll bits
    ORA XSCROLL     ; Set new scroll
    STA $D016

    ; Acknowledge IRQ
    LDA #$01
    STA $D019
    JMP $EA31

; Variables
XSCROLL:
    BYTE $07
TEXTPOS:
    BYTE $00

; Scrolling message - story of VIC-II designers
; Screen codes: A-Z = $01-$1A, space = $20
TEXT:
    BYTE $20,$20,$20,$20,$20,$20,$20,$20  ; leading spaces
    ; "THE VIC-II CHIP WAS DESIGNED BY "
    BYTE $14,$08,$05,$20,$16,$09,$03,$2D
    BYTE $09,$09,$20,$03,$08,$09,$10,$20
    BYTE $17,$01,$13,$20,$04,$05,$13,$09
    BYTE $07,$0E,$05,$04,$20,$02,$19,$20
    ; "AL CHARPENTIER AND CHARLES WINTERBLE "
    BYTE $01,$0C,$20,$03,$08,$01,$12,$10
    BYTE $05,$0E,$14,$09,$05,$12,$20,$01
    BYTE $0E,$04,$20,$03,$08,$01,$12,$0C
    BYTE $05,$13,$20,$17,$09,$0E,$14,$05
    BYTE $12,$02,$0C,$05,$20
    ; "AT MOS TECHNOLOGY IN 1981. "
    BYTE $01,$14,$20,$0D,$0F,$13,$20,$14
    BYTE $05,$03,$08,$0E,$0F,$0C,$0F,$07
    BYTE $19,$20,$09,$0E,$20,$31,$39,$38
    BYTE $31,$2E,$20
    ; "IT COULD DISPLAY 320X200 PIXELS, "
    BYTE $09,$14,$20,$03,$0F,$15,$0C,$04
    BYTE $20,$04,$09,$13,$10,$0C,$01,$19
    BYTE $20,$33,$32,$30,$18,$32,$30,$30
    BYTE $20,$10,$09,$18,$05,$0C,$13,$2C
    BYTE $20
    ; "8 SPRITES, AND 16 COLORS. "
    BYTE $38,$20,$13,$10,$12,$09,$14,$05
    BYTE $13,$2C,$20,$01,$0E,$04,$20,$31
    BYTE $36,$20,$03,$0F,$0C,$0F,$12,$13
    BYTE $2E,$20
    ; "THE CHIP MADE THE C64 A GAMING LEGEND! "
    BYTE $14,$08,$05,$20,$03,$08,$09,$10
    BYTE $20,$0D,$01,$04,$05,$20,$14,$08
    BYTE $05,$20,$03,$36,$34,$20,$01,$20
    BYTE $07,$01,$0D,$09,$0E,$07,$20,$0C
    BYTE $05,$07,$05,$0E,$04,$21,$20
    BYTE $20,$20,$20,$20,$20,$20,$20,$20  ; trailing spaces
    BYTE $00  ; End marker