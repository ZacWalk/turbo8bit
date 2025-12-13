; Raster Interrupt Demo
; Changes border/background color halfway down the screen
; Uses IRQ to split the screen at raster line 150
;
; VIC-II registers:
;   $D011 - Control register (bit 7 = raster bit 8)
;   $D012 - Raster line to trigger interrupt
;   $D019 - Interrupt status (write to acknowledge)
;   $D01A - Interrupt enable (bit 0 = raster IRQ)
;   $D020 - Border color
;   $D021 - Background color

    ORG $0800

    SEI             ; Disable interrupts

    ; Disable CIA1 timer interrupts (they interfere!)
    LDA #$7F        ; Clear all CIA1 interrupt sources
    STA $DC0D
    LDA $DC0D       ; Read to acknowledge any pending

    ; Set initial colors (blue - top of screen)
    LDA #$06        ; Blue
    STA $D020       ; Border color
    STA $D021       ; Background color

    ; Set up first raster interrupt at line 50 (top)
    LDA #$32        ; Raster line 50
    STA $D012
    LDA $D011       ; Clear bit 7 (raster line < 256)
    AND #$7F
    STA $D011

    ; Enable raster interrupts
    LDA #$01        ; Enable raster IRQ
    STA $D01A

    ; Point IRQ vector to our handler
    LDA #<IRQ1      ; Low byte of IRQ1 address
    STA $0314       ; IRQ vector low byte
    LDA #>IRQ1      ; High byte of IRQ1 address
    STA $0315       ; IRQ vector high byte

    CLI             ; Enable interrupts
    RTS             ; Return to BASIC (IRQ keeps running)

; First IRQ handler - top of screen (blue)
IRQ1:
    LDA #$06        ; Blue
    STA $D020       ; Border color
    STA $D021       ; Background color

    ; Set up next interrupt at line 150 (middle)
    LDA #$96        ; Raster line 150
    STA $D012

    ; Point to second handler
    LDA #<IRQ2
    STA $0314
    LDA #>IRQ2
    STA $0315

    ; Acknowledge interrupt
    LDA #$01
    STA $D019       ; Clear raster IRQ flag

    JMP $EA31       ; Jump to KERNAL IRQ handler

; Second IRQ handler - bottom of screen (red)
IRQ2:
    LDA #$02        ; Red
    STA $D020       ; Border color
    STA $D021       ; Background color

    ; Set up next interrupt at line 50 (wrap to top)
    LDA #$32        ; Raster line 50
    STA $D012

    ; Point back to first handler
    LDA #<IRQ1
    STA $0314
    LDA #>IRQ1
    STA $0315

    ; Acknowledge interrupt
    LDA #$01
    STA $D019       ; Clear raster IRQ flag

    JMP $EA31       ; Jump to KERNAL IRQ handler