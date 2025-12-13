; Print String Loop
; Uses indexed addressing to loop through a string
; and print each character
    ORG $0800
    
    LDX #$00        ; String index
LOOP:
    LDA MSG,X       ; Load character at MSG+X
    BEQ DONE        ; If zero (end of string), done
    JSR $FFD2       ; Print character
    INX             ; Next character
    JMP LOOP        ; Repeat
    
DONE:
    RTS
    
MSG:
    BYTE $48,$45,$4C,$4C,$4F,$20  ; "HELLO "
    BYTE $57,$4F,$52,$4C,$44,$21  ; "WORLD!"
    BYTE $0D,$00                   ; CR, null terminator