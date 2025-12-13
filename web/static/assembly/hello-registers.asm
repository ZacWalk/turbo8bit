; Hello Registers
; Load different values into A, X, Y
; and watch them change in the register display
    ORG $0800
    
    LDA #$42        ; Load hex 42 (66 decimal) into A
    LDX #$10        ; Load 16 into X
    LDY #$FF        ; Load 255 into Y
    
    ; Transfer between registers
    TAX             ; A -> X (now X = $42)
    TYA             ; Y -> A (now A = $FF)
    
    RTS             ; Return to BASIC