//
// @fileoverview MOS6581/MOS8580 SID Chip Emulation
// @module emulator/sid
//
// Cycle-accurate emulation of the SID sound chip used in the Commodore 64.
// Inspired by libsidplayfp.
//
// This module contains:
// - Dac: Digital to Analog Converter with non-linear behavior modeling
// - SID: Main SID chip combining 3 voices, filters, and audio resampling
//
// The SID chip features:
// - 3 independent voices with multiple waveforms (triangle, sawtooth, pulse, noise)
// - Programmable ADSR envelope generators
// - Resonant multi-mode filter (low-pass, band-pass, high-pass)
// - Ring modulation and oscillator sync
//
// For SID file playback, see sid-player.js.
// For voice and envelope details, see voice.js.
// For filter details, see filter.js.
//
// @see https://www.turbo8bit.com/
//

import { Voice, getWaveformCalculator } from './voice.js';
import { Filter6581, Filter8580, ExternalFilter } from './filter.js';

// ============================================================================
// DAC
// ============================================================================

const MOSFET_LEAKAGE_6581 = 0.0075;
const MOSFET_LEAKAGE_8580 = 0.0035;

class Dac {
    constructor(bits) {
        this.dacLength = bits;
        this.dac = new Float64Array(bits);
        this.leakage = MOSFET_LEAKAGE_6581;
    }

    getOutput(input, saturate = false) {
        let dacValue = 0;
        for (let i = 0; i < this.dacLength; i++) {
            const transistorOn = (input & (1 << i)) !== 0;
            dacValue += transistorOn ? this.dac[i] : this.dac[i] * this.leakage;
        }
        if (saturate) {
            const GAIN = 1.1;
            const SAT = 1.1;
            dacValue = GAIN * dacValue + (1 - GAIN) * SAT * dacValue * dacValue * dacValue;
        }
        return dacValue;
    }

    kinkedDac(chipModel) {
        const R_INFINITY = 1e6;
        const _2R_div_R = chipModel === 'MOS6581' ? 2.20 : 2.00;
        const term = chipModel === 'MOS8580';
        this.leakage = chipModel === 'MOS6581' ? MOSFET_LEAKAGE_6581 : MOSFET_LEAKAGE_8580;

        let Vsum = 0;
        for (let setBit = 0; setBit < this.dacLength; setBit++) {
            let Vn = 1;
            const R = 1;
            const _2R = _2R_div_R * R;
            let Rn = term ? _2R : R_INFINITY;
            let bit;

            for (bit = 0; bit < setBit; bit++) {
                Rn = Rn === R_INFINITY ? R + _2R : R + (_2R * Rn) / (_2R + Rn);
            }

            if (Rn === R_INFINITY) {
                Rn = _2R;
            } else {
                Rn = (_2R * Rn) / (_2R + Rn);
                Vn = Vn * Rn / _2R;
            }

            for (++bit; bit < this.dacLength; bit++) {
                Rn += R;
                const I = Vn / Rn;
                Rn = (_2R * Rn) / (_2R + Rn);
                Vn = Rn * I;
            }

            this.dac[setBit] = Vn;
            Vsum += Vn;
        }

        for (let i = 0; i < this.dacLength; i++) {
            this.dac[i] /= Vsum;
        }
    }
}

// ============================================================================
// SID CHIP
// ============================================================================

export const ChipModel = {
    MOS6581: 'MOS6581',
    MOS8580: 'MOS8580'
};

export const CombinedWaveforms = {
    AVERAGE: 'AVERAGE',
    WEAK: 'WEAK',
    STRONG: 'STRONG'
};

export const SamplingMethod = {
    DECIMATE: 'DECIMATE',
    RESAMPLE: 'RESAMPLE'
};

const BUS_TTL_6581 = 0x01d00;
const BUS_TTL_8580 = 0xa2000;
const ENV_DAC_BITS = 8;
const OSC_DAC_BITS = 12;

export class SID {
    constructor() {
        this.voice = [new Voice(), new Voice(), new Voice()];
        this.voice[0].setOtherVoices(this.voice[2], this.voice[1]);
        this.voice[1].setOtherVoices(this.voice[0], this.voice[2]);
        this.voice[2].setOtherVoices(this.voice[1], this.voice[0]);

        this.filter6581 = new Filter6581();
        this.filter8580 = new Filter8580();
        this.filter = this.filter8580;
        this.externalFilter = new ExternalFilter();

        this.envDAC = new Float32Array(1 << ENV_DAC_BITS);
        this.oscDAC = new Float32Array(1 << OSC_DAC_BITS);

        this.clockFrequency = 985248;
        this.samplingFrequency = 44100;
        this.cyclesPerSample = Math.floor(this.clockFrequency / this.samplingFrequency * 1024);
        this.sampleOffset = 0;
        this.cachedSample = 0;
        this.outputValue = 0;

        this.firCoeffs = null;
        this.firBuffer = null;
        this.firIndex = 0;
        this.firLen = 0;

        this.model = ChipModel.MOS8580;
        this.cws = CombinedWaveforms.AVERAGE;
        this.scaleFactor = 0.5;
        this.modelTTL = BUS_TTL_8580;

        this.busValue = 0;
        this.busValueTtl = 0;
        this.nextVoiceSync = 0x7fffffff;

        this.writeQueue = [];
        this.writeQueueIndex = 0;  // Index pointer to avoid shift() overhead
        this.currentCycle = 0;
        this.dcOffset = 0;
        this.lastDcOutput = 0;

        this.initFIRFilter(this.clockFrequency, this.samplingFrequency);
        this.setChipModel(ChipModel.MOS8580);
        this.reset();
    }

    setChipModel(model) {
        switch (model) {
            case ChipModel.MOS6581:
                this.filter = this.filter6581;
                // [FIX] Lower scale factor to prevent clipping (was 0.6)
                this.scaleFactor = 0.3;
                this.modelTTL = BUS_TTL_6581;
                break;
            case ChipModel.MOS8580:
                this.filter = this.filter8580;
                // [FIX] Lower scale factor to prevent clipping (was 0.9)
                this.scaleFactor = 0.4;
                this.modelTTL = BUS_TTL_8580;
                break;
            default:
                throw new Error('Unknown chip model');
        }

        this.model = model;

        const waveCalc = getWaveformCalculator();
        const wavetables = waveCalc.getWaveTable();
        const pulldowntables = waveCalc.buildPulldownTable(model, this.cws);

        const envDac = new Dac(ENV_DAC_BITS);
        envDac.kinkedDac(model);
        for (let i = 0; i < (1 << ENV_DAC_BITS); i++) {
            this.envDAC[i] = envDac.getOutput(i);
        }

        const is6581 = model === ChipModel.MOS6581;
        const oscDac = new Dac(OSC_DAC_BITS);
        oscDac.kinkedDac(model);
        const offset = oscDac.getOutput(0x7ff, is6581);
        for (let i = 0; i < (1 << OSC_DAC_BITS); i++) {
            const dacValue = oscDac.getOutput(i, is6581);
            this.oscDAC[i] = dacValue - offset;
        }

        for (let i = 0; i < 3; i++) {
            this.voice[i].setEnvDAC(this.envDAC);
            this.voice[i].setWavDAC(this.oscDAC);
            this.voice[i].wave().setModel(is6581);
            this.voice[i].wave().setWaveformModels(wavetables);
            this.voice[i].wave().setPulldownModels(pulldowntables);
        }
    }

    getChipModel() { return this.model; }

    setCombinedWaveforms(cws) {
        this.cws = cws;
        const waveCalc = getWaveformCalculator();
        const pulldowntables = waveCalc.buildPulldownTable(this.model, cws);
        for (let i = 0; i < 3; i++) {
            this.voice[i].wave().setPulldownModels(pulldowntables);
        }
    }

    reset() {
        for (let i = 0; i < 3; i++) {
            this.voice[i].reset();
        }
        this.filter6581.reset();
        this.filter8580.reset();
        this.externalFilter.reset();
        this.busValue = 0;
        this.busValueTtl = 0;
        this.writeQueue = [];
        this.writeQueueIndex = 0;
        this.currentCycle = 0;
        this.dcOffset = 0;
        this.lastDcOutput = 0;
        if (this.firBuffer) {
            this.firBuffer.fill(0);
            this.firIndex = 0;
        }
        this.sampleOffset = 0;
        this.cachedSample = 0;
        this.outputValue = 0;
        this.voiceSync(false);
    }

    input(value) {
        this.filter6581.input(value);
        this.filter8580.input(value);
    }

    ageBusValue(n) {
        if (this.busValueTtl !== 0) {
            this.busValueTtl -= n;
            if (this.busValueTtl <= 0) {
                this.busValue = 0;
                this.busValueTtl = 0;
            }
        }
    }

    voiceSync(sync) {
        if (sync) {
            for (let i = 0; i < 3; i++) {
                this.voice[i].wave().synchronize();
            }
        }
        this.nextVoiceSync = 0x7fffffff;
        for (let i = 0; i < 3; i++) {
            const wave = this.voice[i].wave();
            const freq = wave.readFreq();
            if (wave.readTest() || freq === 0 || !wave.readFollowingVoiceSync()) {
                continue;
            }
            const accumulator = wave.readAccumulator();
            const thisVoiceSync = (((0x7fffff - accumulator) & 0xffffff) / freq + 1) | 0;
            if (thisVoiceSync < this.nextVoiceSync) {
                this.nextVoiceSync = thisVoiceSync;
            }
        }
    }

    read(offset) {
        switch (offset) {
            case 0x19: case 0x1a:
                this.busValue = 0xff;
                this.busValueTtl = this.modelTTL;
                break;
            case 0x1b:
                this.busValue = this.voice[2].wave().readOSC();
                this.busValueTtl = this.modelTTL;
                break;
            case 0x1c:
                this.busValue = this.voice[2].envelope().readENV();
                this.busValueTtl = this.modelTTL;
                break;
            default:
                this.busValueTtl = (this.busValueTtl / 2) | 0;
                break;
        }
        return this.busValue;
    }

    write(offset, value, cycle = null) {
        const writeCycle = cycle !== null ? cycle : this.currentCycle;
        this.writeQueue.push({
            offset: offset & 0x1f,
            value: value & 0xff,
            cycle: writeCycle
        });
    }

    applyRegisterWrite(offset, value) {
        this.busValue = value;
        this.busValueTtl = this.modelTTL;

        switch (offset) {
            case 0x00: this.voice[0].wave().writeFREQ_LO(value); break;
            case 0x01: this.voice[0].wave().writeFREQ_HI(value); break;
            case 0x02: this.voice[0].wave().writePW_LO(value); break;
            case 0x03: this.voice[0].wave().writePW_HI(value); break;
            case 0x04: this.voice[0].writeCONTROL_REG(value); break;
            case 0x05: this.voice[0].envelope().writeATTACK_DECAY(value); break;
            case 0x06: this.voice[0].envelope().writeSUSTAIN_RELEASE(value); break;
            case 0x07: this.voice[1].wave().writeFREQ_LO(value); break;
            case 0x08: this.voice[1].wave().writeFREQ_HI(value); break;
            case 0x09: this.voice[1].wave().writePW_LO(value); break;
            case 0x0a: this.voice[1].wave().writePW_HI(value); break;
            case 0x0b: this.voice[1].writeCONTROL_REG(value); break;
            case 0x0c: this.voice[1].envelope().writeATTACK_DECAY(value); break;
            case 0x0d: this.voice[1].envelope().writeSUSTAIN_RELEASE(value); break;
            case 0x0e: this.voice[2].wave().writeFREQ_LO(value); break;
            case 0x0f: this.voice[2].wave().writeFREQ_HI(value); break;
            case 0x10: this.voice[2].wave().writePW_LO(value); break;
            case 0x11: this.voice[2].wave().writePW_HI(value); break;
            case 0x12: this.voice[2].writeCONTROL_REG(value); break;
            case 0x13: this.voice[2].envelope().writeATTACK_DECAY(value); break;
            case 0x14: this.voice[2].envelope().writeSUSTAIN_RELEASE(value); break;
            case 0x15:
                this.filter6581.writeFC_LO(value);
                this.filter8580.writeFC_LO(value);
                break;
            case 0x16:
                this.filter6581.writeFC_HI(value);
                this.filter8580.writeFC_HI(value);
                break;
            case 0x17:
                this.filter6581.writeRES_FILT(value);
                this.filter8580.writeRES_FILT(value);
                break;
            case 0x18:
                this.filter6581.writeMODE_VOL(value);
                this.filter8580.writeMODE_VOL(value);
                break;
        }
        this.voiceSync(false);
    }

    setCycleCount(cycle) { this.currentCycle = cycle; }

    applyPendingWrites() {
        while (this.writeQueueIndex < this.writeQueue.length) {
            const cmd = this.writeQueue[this.writeQueueIndex++];
            this.applyRegisterWrite(cmd.offset, cmd.value);
        }
        // Clear queue when fully consumed
        if (this.writeQueueIndex >= this.writeQueue.length) {
            this.writeQueue.length = 0;
            this.writeQueueIndex = 0;
        }
    }

    beginFrame() {
        // Reset queue index and sort pending writes
        this.writeQueueIndex = 0;
        this.writeQueue.sort((a, b) => a.cycle - b.cycle);
    }

    setSamplingParameters(clockFrequency, method, samplingFrequency) {
        this.clockFrequency = clockFrequency;
        this.samplingFrequency = samplingFrequency;
        this.cyclesPerSample = Math.floor(clockFrequency / samplingFrequency * 1024);
        this.sampleOffset = 0;
        this.cachedSample = 0;
        this.externalFilter.setClockFrequency(clockFrequency);
        this.initFIRFilter(clockFrequency, samplingFrequency);
    }

    initFIRFilter(clockFrequency, samplingFrequency) {
        const oversampleRatio = clockFrequency / samplingFrequency;
        const filterLen = 32;
        const cutoff = 0.9 / oversampleRatio;

        this.firCoeffs = new Float32Array(filterLen);
        const center = (filterLen - 1) / 2;
        let sum = 0;

        for (let i = 0; i < filterLen; i++) {
            const x = i - center;
            let sinc;
            if (Math.abs(x) < 0.0001) {
                sinc = 1.0;
            } else {
                const arg = Math.PI * x * cutoff * 2;
                sinc = Math.sin(arg) / arg;
            }
            const window = 0.42 - 0.5 * Math.cos(2 * Math.PI * i / (filterLen - 1))
                + 0.08 * Math.cos(4 * Math.PI * i / (filterLen - 1));
            this.firCoeffs[i] = sinc * window;
            sum += this.firCoeffs[i];
        }

        for (let i = 0; i < filterLen; i++) {
            this.firCoeffs[i] /= sum;
        }

        this.firBuffer = new Float32Array(filterLen);
        this.firIndex = 0;
        this.firLen = filterLen;
    }

    resamplerInput(sample) {
        this.firBuffer[this.firIndex] = sample;
        this.firIndex = (this.firIndex + 1) % this.firLen;

        let ready = false;
        if (this.sampleOffset < 1024) {
            let filtered = 0;
            let bufIdx = this.firIndex;
            for (let i = 0; i < this.firLen; i++) {
                bufIdx = (bufIdx - 1 + this.firLen) % this.firLen;
                filtered += this.firBuffer[bufIdx] * this.firCoeffs[i];
            }
            this.outputValue = filtered;
            ready = true;
            this.sampleOffset += this.cyclesPerSample;
        }
        this.sampleOffset -= 1024;
        this.cachedSample = sample;
        return ready;
    }

    resamplerOutput() {
        let sample = (this.outputValue * this.scaleFactor) | 0;
        sample = Math.max(-32768, Math.min(32767, sample));
        const dcFiltered = sample - this.dcOffset;
        this.dcOffset += dcFiltered * 0.005;
        return Math.max(-32768, Math.min(32767, dcFiltered | 0));
    }

    clock(cycles, buf, startCycle = 0) {
        this.ageBusValue(cycles);
        let s = 0;
        const endCycle = startCycle + cycles;
        let currentCycle = startCycle;

        // Cache voice/wave/envelope references to avoid repeated property lookups in hot loop
        const v0 = this.voice[0], v1 = this.voice[1], v2 = this.voice[2];
        const w0 = v0.wave(), w1 = v1.wave(), w2 = v2.wave();
        const e0 = v0.envelope(), e1 = v1.envelope(), e2 = v2.envelope();
        const filter = this.filter;
        const externalFilter = this.externalFilter;
        const writeQueue = this.writeQueue;

        while (currentCycle < endCycle) {
            // Process pending writes using index pointer (avoids O(n) shift)
            while (this.writeQueueIndex < writeQueue.length && writeQueue[this.writeQueueIndex].cycle <= currentCycle) {
                const cmd = writeQueue[this.writeQueueIndex++];
                this.applyRegisterWrite(cmd.offset, cmd.value);
            }

            let nextEventCycle = endCycle;
            if (this.writeQueueIndex < writeQueue.length) {
                nextEventCycle = Math.min(nextEventCycle, writeQueue[this.writeQueueIndex].cycle);
            }

            const cyclesToRun = Math.min(
                nextEventCycle - currentCycle,
                this.nextVoiceSync
            );

            if (cyclesToRun <= 0) {
                currentCycle++;
                continue;
            }

            for (let i = 0; i < cyclesToRun; i++) {
                w0.clock();
                w1.clock();
                w2.clock();
                e0.clock();
                e1.clock();
                e2.clock();

                const sidOutput = filter.clock(v0, v1, v2) | 0;

                // [FIX] Removed incorrect (-32768) offset which was causing severe DC clipping
                const c64Output = externalFilter.clock(sidOutput) | 0;

                if (this.resamplerInput(c64Output)) {
                    buf[s++] = this.resamplerOutput();
                }
            }

            currentCycle += cyclesToRun;
            this.nextVoiceSync -= cyclesToRun;

            if (this.nextVoiceSync <= 0) {
                this.voiceSync(true);
            }
        }

        // Clear consumed queue entries
        if (this.writeQueueIndex >= writeQueue.length) {
            writeQueue.length = 0;
            this.writeQueueIndex = 0;
        }

        this.currentCycle = endCycle;
        return s;
    }

    clockSilent(cycles) {
        this.ageBusValue(cycles);
        while (cycles > 0) {
            const deltaT = Math.min(this.nextVoiceSync, cycles);
            if (deltaT > 0) {
                for (let i = 0; i < deltaT; i++) {
                    this.voice[0].wave().clock();
                    this.voice[1].wave().clock();
                    this.voice[2].wave().clock();
                    this.voice[0].wave().output();
                    this.voice[1].wave().output();
                    this.voice[2].wave().output();
                    this.voice[2].envelope().clock();
                }
                cycles -= deltaT;
                this.nextVoiceSync -= deltaT;
            }
            if (this.nextVoiceSync === 0) {
                this.voiceSync(true);
            }
        }
    }

    setFilter6581Curve(filterCurve) { this.filter6581.setFilterCurve(filterCurve); }
    setFilter6581Range(adjustment) { this.filter6581.setFilterRange(adjustment); }
    setFilter8580Curve(filterCurve) { this.filter8580.setFilterCurve(filterCurve); }

    enableFilter(enable) {
        this.filter6581.enable(enable);
        this.filter8580.enable(enable);
    }
}