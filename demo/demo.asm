; C64 Walker Demo
; Panning over a large logo with per-cell colors

    ORG $0801
    ; BASIC Header: 10 SYS 2064 ($0810)
    BYTE $0B, $08, $0A, $00, $9E, $32, $30, $36, $34, $00, $00, $00

    ORG $0810
start:
    SEI             ; Disable interrupts
    
    ; Initialize VIC-II
    LDA #$00
    STA $D020       ; Border color: Black
    STA $D021       ; Background color: Black
    
    ; Set Charset to $2000 (Bank 0, offset $2000)
    ; VIC bank is default (Bank 0: $0000-$3FFF)
    ; Screen RAM is default ($0400)
    ; Charset pointer is in $D018
    ; Bits 1-3: Charset address / $800
    ; $2000 / $800 = 4 -> %100
    ; Bits 4-7: Screen RAM / $400
    ; $0400 / $400 = 1 -> %0001
    ; Value = %00011000 = $18
    LDA #$18
    STA $D018
    
    ; Initialize scroll variables
    LDA #0
    STA scroll_x
    LDA #1
    STA dir_x

main_loop:
    JSR wait_frame
    JSR update_scroll
    JSR draw_screen
    JMP main_loop

; ----------------------------------------------------------------------------
; Subroutines
; ----------------------------------------------------------------------------

wait_frame:
    ; Wait for raster line 250
    LDA #250
wait_l1:
    CMP $D012
    BNE wait_l1
    ; Wait for it to pass to avoid multiple updates per frame
    BIT $D011
    BMI wait_l1
    RTS

update_scroll:
    ; Update X only (horizontal scrolling)
    LDA scroll_x
    CLC
    ADC dir_x
    STA scroll_x
    
    ; Check bounds X (0 to 40)
    CMP #40
    BEQ reverse_x
    CMP #0
    BEQ reverse_x
    RTS

reverse_x:
    LDA dir_x
    EOR #$FF
    CLC
    ADC #1
    STA dir_x
    ; Clamp scroll_x to valid range to prevent sticking
    LDA scroll_x
    CMP #40
    BCC done_scroll
    LDA #39
    STA scroll_x
done_scroll:
    RTS

draw_screen:
    ; Copy 40x25 window from map to screen ($0400)
    ; And copy colors from color_data to Color RAM ($D800)
    ; Map address = map_data + scroll_x (no Y offset, map is 80x25)
    ; Color address = color_data + scroll_x
    
    ; Calculate source pointer for map (ptr)
    ; ptr = map_data + scroll_x
    LDA #<map_data
    CLC
    ADC scroll_x
    STA ptr
    LDA #>map_data
    ADC #0
    STA ptr+1
    
    ; Calculate source pointer for colors (cptr)
    ; cptr = color_data + scroll_x
    LDA #<color_data
    CLC
    ADC scroll_x
    STA cptr
    LDA #>color_data
    ADC #0
    STA cptr+1

copy_loop_init:
    ; Destination pointer for screen
    LDA #$00
    STA screen
    LDA #$04
    STA screen+1
    
    ; Destination pointer for color RAM
    LDA #$00
    STA color
    LDA #$D8
    STA color+1
    
    LDX #0          ; Row counter (0 to 24)

row_loop:
    LDY #0          ; Column counter (0 to 39)
col_loop:
    ; Copy screen data
    LDA (ptr),Y
    STA (screen),Y
    ; Copy color data
    LDA (cptr),Y
    STA (color),Y
    INY
    CPY #40
    BNE col_loop
    
    ; Advance pointers
    ; ptr += 80 (map width)
    LDA ptr
    CLC
    ADC #80
    STA ptr
    LDA ptr+1
    ADC #0
    STA ptr+1
    
    ; cptr += 80 (map width)
    LDA cptr
    CLC
    ADC #80
    STA cptr
    LDA cptr+1
    ADC #0
    STA cptr+1
    
    ; screen += 40 (screen width)
    LDA screen
    CLC
    ADC #40
    STA screen
    LDA screen+1
    ADC #0
    STA screen+1
    
    ; color += 40 (color RAM width)
    LDA color
    CLC
    ADC #40
    STA color
    LDA color+1
    ADC #0
    STA color+1
    
    INX
    CPX #25
    BNE row_loop
    
    RTS

; ----------------------------------------------------------------------------
; Variables
; ----------------------------------------------------------------------------

scroll_x: BYTE 0
dir_x:    BYTE 1

; Zero page pointers
ptr = $FB       ; Map source pointer
screen = $FD    ; Screen destination pointer
cptr = $22      ; Color source pointer
color = $24     ; Color RAM destination pointer

; ----------------------------------------------------------------------------
; Data
; ----------------------------------------------------------------------------

    ORG $2000
charset_data:
    INCBIN "walker_chars.bin"

    ORG $3000
map_data:
    INCBIN "walker_map.bin"

    ORG $4000
color_data:
    INCBIN "walker_colors.bin"
