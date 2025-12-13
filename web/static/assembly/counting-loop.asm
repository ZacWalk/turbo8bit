; Counting Loop
; Watch X increment from 0 to 255, then wrap to 0
; The Zero flag (Z) becomes set when X = 0
    ORG $0800
    
    LDX #$00        ; Start X at 0
LOOP:
    INX             ; X = X + 1
    BNE LOOP        ; Branch if Not Equal to zero
                    ; (repeats until X wraps from $FF to $00)
    
    RTS             ; Return when X = 0