; Subroutine Call
; JSR pushes PC+2 to stack, jumps to address
; RTS pops address and returns
; Watch the Stack Pointer (SP) change!
    ORG $0800
    
    LDA #$00        ; A = 0
    JSR ADDTEN      ; Call subroutine
    ; A is now 10
    JSR ADDTEN      ; Call again
    ; A is now 20
    RTS
    
ADDTEN:
    CLC             ; Clear carry for addition
    ADC #$0A        ; Add 10 to A
    RTS             ; Return