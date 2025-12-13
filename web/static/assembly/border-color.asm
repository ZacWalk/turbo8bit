; Memory Poking - Change Border Color
; The C64 border color is at $D020
; Values 0-15 are the C64 color palette
    ORG $0800
    
    LDA #$02        ; Red color (2)
    STA $D020       ; Store to border color register
    
    LDA #$00        ; Black (0)
    STA $D021       ; Store to background color
    
    RTS