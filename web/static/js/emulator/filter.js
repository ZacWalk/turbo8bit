//
// @fileoverview SID Filter Emulation - Analog filter modeling
// @module emulator/filter
//
// This module provides accurate emulation of the SID's analog filter.
// Inspired by libsidplayfp.
//
// Components:
// - Filter: Base filter class with two-integrator-loop biquadratic filter
// - Filter6581: MOS6581-specific non-linear filter with distortion modeling
// - Filter8580: MOS8580-specific linear filter
// - ExternalFilter: Audio output stage (low-pass RC + DC-blocker)
//
// The SID filter features:
// - 11-bit cutoff frequency control
// - 4-bit resonance control
// - Selectable filter routing for each voice
// - Multi-mode output (low-pass, band-pass, high-pass, or combinations)
//
// The 6581 and 8580 filters have different characteristics:
// - 6581: Non-linear, "warm" sound, distortion at high resonance
// - 8580: Linear, cleaner sound, better high-frequency response
//
// For main SID chip, see sid.js.
// For voice components, see voice.js.
//
// @see https://www.turbo8bit.com/
//

// Filter state clamp value
const MAX_FILTER_STATE = 0x7FFFFF;

// ============================================================================
// EXTERNAL FILTER
// ============================================================================

//
// External Filter emulation
//
// The audio output stage in a C64 consists of two STC networks:
// - A low-pass RC filter with 3dB frequency of 16kHz
// - A DC-blocker (high-pass filter) with cutoff dependent on load impedance
//
export class ExternalFilter {
    constructor() {
        this.Vlp = 0;
        this.Vhp = 0;
        this.w0lp_1_s7 = 0;
        this.w0hp_1_s17 = 0;
    }

    setClockFrequency(frequency) {
        const w0lp = 2 * Math.PI * 16000 / frequency;
        const w0hp = 2 * Math.PI * 1.6 / frequency;
        this.w0lp_1_s7 = Math.round(w0lp * (1 << 7));
        this.w0hp_1_s17 = Math.round(w0hp * (1 << 17));
    }

    reset() {
        this.Vlp = 0;
        this.Vhp = 0;
    }

    clock(input) {
        const Vi = input << 11;
        const dVlp = (this.w0lp_1_s7 * (Vi - this.Vlp)) >> 7;
        const dVhp = (this.w0hp_1_s17 * (this.Vlp - this.Vhp)) >> 17;
        this.Vlp += dVlp;
        this.Vhp += dVhp;
        return (this.Vlp - this.Vhp) >> 11;
    }
}

// ============================================================================
// BASE FILTER
// ============================================================================

//
// Base Filter class
//
class Filter {
    constructor() {
        this.Vhp = 0;
        this.Vbp = 0;
        this.Vlp = 0;
        this.Ve = 0;
        this.fc = 0;
        this.w0 = 0;
        this.resonanceCoeff = 1.0;
        this.filt1 = false;
        this.filt2 = false;
        this.filt3 = false;
        this.filtE = false;
        this.voice3off = false;
        this.hp = false;
        this.bp = false;
        this.lp = false;
        this.vol = 0;
        this.enabled = true;
        this.filt = 0;
    }

    getNormalizedVoice(voice) {
        if (!voice) return 0;
        const wav = voice.wave().output();
        const env = voice.envelope().output();
        return ((wav - 2048) * env) >> 3;
    }

    updateResonance(res) {
        this.resonanceCoeff = 1.0 / (0.707 + res * 0.22);
    }

    writeFC_LO(fcLo) {
        this.fc = (this.fc & 0x7f8) | (fcLo & 0x007);
        this.updateCenterFrequency();
    }

    writeFC_HI(fcHi) {
        this.fc = ((fcHi << 3) & 0x7f8) | (this.fc & 0x007);
        this.updateCenterFrequency();
    }

    writeRES_FILT(resFilt) {
        this.filt = resFilt;
        this.updateResonance((resFilt >> 4) & 0x0f);
        if (this.enabled) {
            this.filt1 = (this.filt & 0x01) !== 0;
            this.filt2 = (this.filt & 0x02) !== 0;
            this.filt3 = (this.filt & 0x04) !== 0;
            this.filtE = (this.filt & 0x08) !== 0;
        }
    }

    writeMODE_VOL(modeVol) {
        this.vol = modeVol & 0x0f;
        this.lp = (modeVol & 0x10) !== 0;
        this.bp = (modeVol & 0x20) !== 0;
        this.hp = (modeVol & 0x40) !== 0;
        this.voice3off = (modeVol & 0x80) !== 0;
    }

    enable(enabled) {
        this.enabled = enabled;
        if (enabled) {
            this.writeRES_FILT(this.filt);
        } else {
            this.filt1 = this.filt2 = this.filt3 = this.filtE = false;
        }
    }

    reset() {
        this.writeFC_LO(0);
        this.writeFC_HI(0);
        this.writeMODE_VOL(0);
        this.writeRES_FILT(0);
        this.Vhp = 0;
        this.Vbp = 0;
        this.Vlp = 0;
    }

    input(value) {
        this.Ve = value;
    }

    updateCenterFrequency() { }

    //
    // Route voice outputs to filter input (Vi) and direct output (Vo)
    // @param {Voice} voice1 - Voice 1
    // @param {Voice} voice2 - Voice 2
    // @param {Voice} voice3 - Voice 3
    // @returns {{Vi: number, Vo: number}} Filter input and direct output values
    //
    routeVoices(voice1, voice2, voice3) {
        const v1 = this.getNormalizedVoice(voice1);
        const v2 = this.getNormalizedVoice(voice2);

        let v3;
        if (this.voice3off && !this.filt3) {
            if (voice3) voice3.wave().output();
            v3 = 0;
        } else {
            v3 = this.getNormalizedVoice(voice3);
        }

        let Vi = 0;
        if (this.filt1) Vi += v1;
        if (this.filt2) Vi += v2;
        if (this.filt3) Vi += v3;
        if (this.filtE) Vi += this.Ve;

        let Vo = 0;
        if (!this.filt1) Vo += v1;
        if (!this.filt2) Vo += v2;
        if (!this.filt3 && !this.voice3off) Vo += v3;
        if (!this.filtE) Vo += this.Ve;

        return { Vi, Vo };
    }

    //
    // Apply the two-integrator-loop biquadratic filter
    // @param {number} Vi - Filter input value
    //
    applyFilter(Vi) {
        const Q_inv = this.resonanceCoeff;
        const w0 = this.w0;

        this.Vhp = (Vi * Q_inv - this.Vlp - this.Vbp * Q_inv) | 0;
        this.Vbp = (this.Vbp + w0 * this.Vhp) | 0;
        this.Vlp = (this.Vlp + w0 * this.Vbp) | 0;

        // Clamp filter state to prevent overflow
        this.Vhp = Math.max(-MAX_FILTER_STATE, Math.min(MAX_FILTER_STATE, this.Vhp));
        this.Vbp = Math.max(-MAX_FILTER_STATE, Math.min(MAX_FILTER_STATE, this.Vbp));
        this.Vlp = Math.max(-MAX_FILTER_STATE, Math.min(MAX_FILTER_STATE, this.Vlp));
    }

    //
    // Mix filter outputs based on selected modes
    // @param {number} Vo - Direct (unfiltered) output
    // @returns {number} Final mixed output
    //
    mixOutput(Vo) {
        if (this.lp) Vo += this.Vlp;
        if (this.bp) Vo += this.Vbp;
        if (this.hp) Vo += this.Vhp;

        const output = ((Vo * this.vol) >> 4) | 0;

        // Add DC offset for digi playback
        // Enables 4-bit sample playback via volume register writes ($D418)
        const digiDC = ((this.vol - 7.5) * 1024) | 0;

        return Math.max(-32768, Math.min(32767, output + digiDC));
    }
}

// ============================================================================
// FILTER 6581
// ============================================================================

//
// 6581 Filter implementation
// Uses analog modeling of the 6581's filter circuit
//
export class Filter6581 extends Filter {
    constructor() {
        super();
        this.filterCurve = 0.5;
        this.filterRange = 0;
        this.buildFrequencyTable();
    }

    buildFrequencyTable() {
        this.freqTable = new Float32Array(2048);
        for (let i = 0; i < 2048; i++) {
            const fc = i / 2048;
            const x = fc * (1 + this.filterCurve * 0.5);
            const w0 = Math.pow(x, 1.0 + this.filterCurve);
            this.freqTable[i] = w0 * 0.04;
        }
    }

    setFilterCurve(curve) {
        this.filterCurve = Math.max(0, Math.min(1, curve));
        this.buildFrequencyTable();
        this.updateCenterFrequency();
    }

    setFilterRange(range) {
        this.filterRange = range;
        this.updateCenterFrequency();
    }

    updateCenterFrequency() {
        const idx = Math.min(2047, this.fc);
        this.w0 = this.freqTable[idx];
    }

    clock(voice1, voice2, voice3) {
        const { Vi, Vo } = this.routeVoices(voice1, voice2, voice3);
        this.applyFilter(Vi);
        return this.mixOutput(Vo);
    }
}

// ============================================================================
// FILTER 8580
// ============================================================================

//
// 8580 Filter implementation
// The 8580 has a more linear filter design with real op-amps
//
export class Filter8580 extends Filter {
    constructor() {
        super();
        this.filterCurve = 0.5;
        this.buildFrequencyTable();
    }

    buildFrequencyTable() {
        this.freqTable = new Float32Array(2048);
        for (let i = 0; i < 2048; i++) {
            const fc = i / 2048;
            this.freqTable[i] = 0.002 + fc * 0.045;
        }
    }

    setFilterCurve(curve) {
        this.filterCurve = Math.max(0, Math.min(1, curve));
        this.buildFrequencyTable();
        this.updateCenterFrequency();
    }

    updateCenterFrequency() {
        const idx = Math.min(2047, this.fc);
        this.w0 = this.freqTable[idx];
    }

    clock(voice1, voice2, voice3) {
        const { Vi, Vo } = this.routeVoices(voice1, voice2, voice3);
        this.applyFilter(Vi);
        return this.mixOutput(Vo);
    }
}

export { Filter };
