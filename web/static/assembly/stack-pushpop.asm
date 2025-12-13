; Stack Operations
; PHA pushes A to stack, PLA pops it
; Stack grows downward from $01FF
    ORG $0800
    
    LDA #$AA        ; A = $AA
    PHA             ; Push A (SP decreases)
    
    LDA #$BB        ; A = $BB
    PHA             ; Push again
    
    LDA #$00        ; Clear A
    
    PLA             ; Pop into A (gets $BB)
    PLA             ; Pop again (gets $AA)
    
    RTS