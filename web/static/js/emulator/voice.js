//
// @fileoverview SID Voice Components - Waveform and Envelope Generators
// @module emulator/voice
//
// This module provides the building blocks for SID voice emulation.
// Inspired by libsidplayfp.
//
// Components:
// - WaveformCalculator: Pre-calculates waveform lookup tables for combined waveforms
// - WaveformGenerator: 24-bit accumulator-based waveform generation (tri, saw, pulse, noise)
// - EnvelopeGenerator: ADSR envelope with 15-bit LFSR timing
// - Voice: Combines waveform and envelope generators into a complete voice
//
// Each SID chip has 3 identical voices. Voice features include:
// - 16-bit frequency control (0-4095 Hz range)
// - 12-bit pulse width for pulse waveform
// - Waveform selection (triangle, sawtooth, pulse, noise, or combinations)
// - Ring modulation with previous voice
// - Oscillator sync with previous voice
//
// For main SID chip, see sid.js.
// For filter emulation, see filter.js.
//
// @see https://www.turbo8bit.com/
//

// ============================================================================
// WAVEFORM CALCULATOR
// ============================================================================

//
// Combined waveform model parameters
// Derived from Monte Carlo analysis of real chip samples
//
const CONFIG_AVERAGE = [
    // 6581 parameters
    [
        { distFunc: 'exponential', threshold: 0.877322257, topbit: 1.11349654, pulsestrength: 0, distance1: 2.14537621, distance2: 9.08618164 },
        { distFunc: 'linear', threshold: 0.941692829, topbit: 1, pulsestrength: 1.80072665, distance1: 0.033124879, distance2: 0.232303441 },
        { distFunc: 'linear', threshold: 1.66494179, topbit: 1.03760982, pulsestrength: 5.62705326, distance1: 0.291590303, distance2: 0.283631504 },
        { distFunc: 'linear', threshold: 1.09762526, topbit: 0.975265801, pulsestrength: 1.52196741, distance1: 0.151528224, distance2: 0.841949463 },
        { distFunc: 'exponential', threshold: 0.96, topbit: 1, pulsestrength: 2.5, distance1: 1.1, distance2: 1.2 },
    ],
    // 8580 parameters
    [
        { distFunc: 'exponential', threshold: 0.853578329, topbit: 1.09615636, pulsestrength: 0, distance1: 1.8819375, distance2: 6.80794907 },
        { distFunc: 'exponential', threshold: 0.929835618, topbit: 1, pulsestrength: 1.12836814, distance1: 1.10453653, distance2: 1.48065746 },
        { distFunc: 'quadratic', threshold: 0.911938608, topbit: 0.996440411, pulsestrength: 1.2278074, distance1: 0.000117214302, distance2: 0.18948476 },
        { distFunc: 'exponential', threshold: 0.938004673, topbit: 1.04827631, pulsestrength: 1.21178246, distance1: 0.915959001, distance2: 1.42698038 },
        { distFunc: 'exponential', threshold: 0.95, topbit: 1, pulsestrength: 1.15, distance1: 1, distance2: 1.45 },
    ],
];

const DISTANCE_FUNCTIONS = {
    exponential: (distance, i) => Math.pow(distance, -i),
    linear: (distance, i) => 1 / (1 + i * distance),
    quadratic: (distance, i) => 1 / (1 + (i * i) * distance),
};

function triXor(val) {
    return (((val & 0x800) === 0) ? val : (val ^ 0xfff)) << 1;
}

function calculatePulldown(distanceTable, topbit, pulsestrength, threshold, accumulator) {
    const bit = new Float32Array(12);
    for (let i = 0; i < 12; i++) {
        bit[i] = (accumulator & (1 << i)) !== 0 ? 1 : 0;
    }
    bit[11] *= topbit;

    const pulldown = new Float32Array(12);
    for (let sb = 0; sb < 12; sb++) {
        let avg = 0, n = 0;
        for (let cb = 0; cb < 12; cb++) {
            if (cb === sb) continue;
            const weight = distanceTable[sb - cb + 12];
            avg += (1 - bit[cb]) * weight;
            n += weight;
        }
        avg -= pulsestrength;
        pulldown[sb] = avg / n;
    }

    let value = 0;
    for (let i = 0; i < 12; i++) {
        const bitValue = bit[i] > 0 ? 1 - pulldown[i] : 0;
        if (bitValue > threshold) {
            value |= 1 << i;
        }
    }
    return value;
}

class WaveformCalculator {
    constructor() {
        this.wftable = [
            new Int16Array(4096),
            new Int16Array(4096),
            new Int16Array(4096),
            new Int16Array(4096),
        ];

        for (let idx = 0; idx < 4096; idx++) {
            const saw = idx;
            const tri = triXor(idx);
            this.wftable[0][idx] = 0xfff;
            this.wftable[1][idx] = tri;
            this.wftable[2][idx] = saw;
            this.wftable[3][idx] = saw & (saw << 1);
        }

        this.pulldownCache = new Map();
    }

    getWaveTable() {
        return this.wftable;
    }

    buildPulldownTable(model, cws = 'AVERAGE') {
        const cacheKey = `${model}_${cws}`;
        if (this.pulldownCache.has(cacheKey)) {
            return this.pulldownCache.get(cacheKey);
        }

        const modelIdx = model === 'MOS6581' ? 0 : 1;
        const config = CONFIG_AVERAGE[modelIdx];
        const pulldownTables = [];

        for (let wf = 0; wf < 5; wf++) {
            const cfg = config[wf];
            const distFunc = DISTANCE_FUNCTIONS[cfg.distFunc];

            const distanceTable = new Float32Array(25);
            for (let i = 0; i < 25; i++) {
                const dist = i < 12 ? cfg.distance1 : cfg.distance2;
                distanceTable[i] = distFunc(dist, Math.abs(i - 12));
            }

            const pulldownTable = new Int16Array(4096);
            for (let idx = 0; idx < 4096; idx++) {
                pulldownTable[idx] = calculatePulldown(
                    distanceTable, cfg.topbit, cfg.pulsestrength, cfg.threshold, idx
                );
            }
            pulldownTables.push(pulldownTable);
        }

        this.pulldownCache.set(cacheKey, pulldownTables);
        return pulldownTables;
    }
}

let waveformCalculatorInstance = null;

export function getWaveformCalculator() {
    if (!waveformCalculatorInstance) {
        waveformCalculatorInstance = new WaveformCalculator();
    }
    return waveformCalculatorInstance;
}

// ============================================================================
// ENVELOPE GENERATOR
// ============================================================================

const EnvelopeState = {
    ATTACK: 0,
    DECAY_SUSTAIN: 1,
    RELEASE: 2
};

const ADSR_TABLE = new Uint16Array([
    0x007f, 0x3000, 0x1e00, 0x0660, 0x0182, 0x5573, 0x000e, 0x3805,
    0x2424, 0x2220, 0x090c, 0x0ecd, 0x010e, 0x23f7, 0x5237, 0x64a8
]);

export class EnvelopeGenerator {
    constructor() {
        this.lfsr = 0x7fff;
        this.rate = 0;
        this.exponentialCounter = 0;
        this.exponentialCounterPeriod = 1;
        this.newExponentialCounterPeriod = 0;
        this.statePipeline = 0;
        this.envelopePipeline = 0;
        this.exponentialPipeline = 0;
        this.state = EnvelopeState.RELEASE;
        this.nextState = EnvelopeState.RELEASE;
        this.counterEnabled = true;
        this.gate = false;
        this.resetLfsr = false;
        this.envelopeCounter = 0xaa;
        this.attack = 0;
        this.decay = 0;
        this.sustain = 0;
        this.release = 0;
        this.env3 = 0;
    }

    reset() {
        this.envelopePipeline = 0;
        this.statePipeline = 0;
        this.attack = 0;
        this.decay = 0;
        this.sustain = 0;
        this.release = 0;
        this.gate = false;
        this.resetLfsr = true;
        this.exponentialCounter = 0;
        this.exponentialCounterPeriod = 1;
        this.newExponentialCounterPeriod = 0;
        this.state = EnvelopeState.RELEASE;
        this.counterEnabled = false;
        this.rate = ADSR_TABLE[this.release];
        this.envelopeCounter = 0;
    }

    clock() {
        this.env3 = this.envelopeCounter;

        if (this.newExponentialCounterPeriod > 0) {
            this.exponentialCounterPeriod = this.newExponentialCounterPeriod;
            this.newExponentialCounterPeriod = 0;
        }

        if (this.statePipeline) {
            this.stateChange();
        }

        if (this.envelopePipeline !== 0 && (--this.envelopePipeline === 0)) {
            if (this.counterEnabled) {
                if (this.state === EnvelopeState.ATTACK) {
                    if (++this.envelopeCounter === 0xff) {
                        this.nextState = EnvelopeState.DECAY_SUSTAIN;
                        this.statePipeline = 3;
                    }
                } else if (this.state === EnvelopeState.DECAY_SUSTAIN || this.state === EnvelopeState.RELEASE) {
                    if (--this.envelopeCounter === 0x00) {
                        this.counterEnabled = false;
                    }
                }
                this.setExponentialCounter();
            }
        } else if (this.exponentialPipeline !== 0 && (--this.exponentialPipeline === 0)) {
            this.exponentialCounter = 0;
            if ((this.state === EnvelopeState.DECAY_SUSTAIN && this.envelopeCounter !== this.sustain) ||
                this.state === EnvelopeState.RELEASE) {
                this.envelopePipeline = 1;
            }
        } else if (this.resetLfsr) {
            this.lfsr = 0x7fff;
            this.resetLfsr = false;
            if (this.state === EnvelopeState.ATTACK) {
                this.exponentialCounter = 0;
                this.envelopePipeline = 2;
            } else {
                if (this.counterEnabled && (++this.exponentialCounter === this.exponentialCounterPeriod)) {
                    this.exponentialPipeline = this.exponentialCounterPeriod !== 1 ? 2 : 1;
                }
            }
        }

        if (this.lfsr !== this.rate) {
            const feedback = ((this.lfsr << 14) ^ (this.lfsr << 13)) & 0x4000;
            this.lfsr = ((this.lfsr >> 1) | feedback) & 0x7fff;
        } else {
            this.resetLfsr = true;
        }
    }

    stateChange() {
        this.statePipeline--;
        switch (this.nextState) {
            case EnvelopeState.ATTACK:
                if (this.statePipeline === 1) {
                    this.rate = ADSR_TABLE[this.decay];
                } else if (this.statePipeline === 0) {
                    this.state = EnvelopeState.ATTACK;
                    this.rate = ADSR_TABLE[this.attack];
                    this.counterEnabled = true;
                }
                break;
            case EnvelopeState.DECAY_SUSTAIN:
                if (this.statePipeline === 0) {
                    this.state = EnvelopeState.DECAY_SUSTAIN;
                    this.rate = ADSR_TABLE[this.decay];
                }
                break;
            case EnvelopeState.RELEASE:
                if ((this.state === EnvelopeState.ATTACK && this.statePipeline === 0) ||
                    (this.state === EnvelopeState.DECAY_SUSTAIN && this.statePipeline === 1)) {
                    this.state = EnvelopeState.RELEASE;
                    this.rate = ADSR_TABLE[this.release];
                }
                break;
        }
    }

    setExponentialCounter() {
        switch (this.envelopeCounter) {
            case 0xff: case 0x00: this.newExponentialCounterPeriod = 1; break;
            case 0x5d: this.newExponentialCounterPeriod = 2; break;
            case 0x36: this.newExponentialCounterPeriod = 4; break;
            case 0x1a: this.newExponentialCounterPeriod = 8; break;
            case 0x0e: this.newExponentialCounterPeriod = 16; break;
            case 0x06: this.newExponentialCounterPeriod = 30; break;
        }
    }

    output() { return this.envelopeCounter; }
    readENV() { return this.env3; }

    writeCONTROL_REG(control) {
        const gateNext = (control & 0x01) !== 0;
        if (gateNext !== this.gate) {
            this.gate = gateNext;
            if (gateNext) {
                this.nextState = EnvelopeState.ATTACK;
                this.statePipeline = 2;
                if (this.resetLfsr || this.exponentialPipeline === 2) {
                    this.envelopePipeline = (this.exponentialCounterPeriod === 1 || this.exponentialPipeline === 2) ? 2 : 4;
                } else if (this.exponentialPipeline === 1) {
                    this.statePipeline = 3;
                }
            } else {
                this.nextState = EnvelopeState.RELEASE;
                this.statePipeline = this.envelopePipeline > 0 ? 3 : 2;
            }
        }
    }

    writeATTACK_DECAY(attackDecay) {
        this.attack = (attackDecay >> 4) & 0x0f;
        this.decay = attackDecay & 0x0f;
        if (this.state === EnvelopeState.ATTACK) {
            this.rate = ADSR_TABLE[this.attack];
        } else if (this.state === EnvelopeState.DECAY_SUSTAIN) {
            this.rate = ADSR_TABLE[this.decay];
        }
    }

    writeSUSTAIN_RELEASE(sustainRelease) {
        this.sustain = (sustainRelease & 0xf0) | ((sustainRelease >> 4) & 0x0f);
        this.release = sustainRelease & 0x0f;
        if (this.state === EnvelopeState.RELEASE) {
            this.rate = ADSR_TABLE[this.release];
        }
    }
}

// ============================================================================
// WAVEFORM GENERATOR
// ============================================================================

const FLOATING_OUTPUT_TTL_6581R3 = 54000;
const FLOATING_OUTPUT_TTL_8580R5 = 800000;
const SHIFT_REGISTER_RESET_6581R3 = 50000;
const SHIFT_REGISTER_RESET_8580R5 = 986000;

export class WaveformGenerator {
    constructor() {
        this.modelWave = null;
        this.modelPulldown = null;
        this.wave = null;
        this.pulldown = null;
        this.pw = 0;
        this.shiftRegister = 0x7fffff;
        this.shiftLatch = 0;
        this.shiftPipeline = 0;
        this.ringMsbMask = 0;
        this.noNoise = 0;
        this.noiseOutput = 0;
        this.noNoiseOrNoiseOutput = 0;
        this.noPulse = 0;
        this.pulseOutput = 0;
        this.waveform = 0;
        this.waveformOutput = 0;
        this.accumulator = 0x555555;
        this.freq = 0;
        this.triSawPipeline = 0x555;
        this.osc3 = 0;
        this.shiftRegisterReset = 0;
        this.floatingOutputTtl = 0;
        this.test = false;
        this.sync = false;
        this.testOrReset = false;
        this.msbRising = false;
        this.is6581 = true;
        this.prevVoice = null;
        this.nextVoice = null;
    }

    setWaveformModels(models) {
        this.modelWave = models;
        if (this.waveform < models.length) {
            this.wave = models[this.waveform];
        }
    }

    setPulldownModels(models) {
        this.modelPulldown = models;
        if (models && this.waveform >= 3 && this.waveform < models.length + 3) {
            this.pulldown = models[this.waveform - 3];
        } else {
            this.pulldown = null;
        }
    }

    setOtherWaveforms(prev, next) {
        this.prevVoice = prev;
        this.nextVoice = next;
    }

    setModel(is6581) {
        this.is6581 = is6581;
    }

    reset() {
        this.accumulator = 0x555555;
        this.freq = 0;
        this.pw = 0;
        this.waveform = 0;
        this.test = false;
        this.sync = false;
        this.msbRising = false;
        this.shiftRegister = 0x7fffff;
        this.shiftLatch = 0;
        this.shiftPipeline = 0;
        this.pulseOutput = 0xfff;
        this.waveformOutput = 0;
        this.osc3 = 0;
        this.floatingOutputTtl = 0;
        this.shiftRegisterReset = 0;
        this.noNoise = 0xfff;
        this.noPulse = 0xfff;
        this.ringMsbMask = 0;
        this.testOrReset = false;
        this.triSawPipeline = 0x555;
        this.noiseOutput = 0;
        this.noNoiseOrNoiseOutput = this.noNoise;
        if (this.modelWave) {
            this.wave = this.modelWave[0];
        }
        this.pulldown = null;
    }

    clock() {
        if (this.test) {
            if (this.shiftRegisterReset !== 0 && --this.shiftRegisterReset === 0) {
                this.shiftregBitfade();
                this.shiftLatch = this.shiftRegister;
                this.setNoiseOutput();
            }
            this.testOrReset = true;
            this.pulseOutput = 0xfff;
        } else {
            const accumulatorOld = this.accumulator;
            this.accumulator = (this.accumulator + this.freq) & 0xffffff;
            const accumulatorBitsSet = ~accumulatorOld & this.accumulator;
            this.msbRising = (accumulatorBitsSet & 0x800000) !== 0;

            if ((accumulatorBitsSet & 0x080000) !== 0) {
                this.shiftPipeline = 2;
            } else if (this.shiftPipeline !== 0) {
                if (--this.shiftPipeline === 0) {
                    this.shiftPhase2(this.waveform, this.waveform);
                } else {
                    this.testOrReset = false;
                    this.shiftLatch = this.shiftRegister;
                }
            }
        }
    }

    output() {
        if (this.waveform !== 0) {
            const prevAcc = this.prevVoice ? this.prevVoice.accumulator : 0;
            const ix = (this.accumulator ^ (~prevAcc & this.ringMsbMask)) >>> 12;

            this.waveformOutput = (this.wave ? this.wave[ix] : 0) &
                (this.noPulse | this.pulseOutput) &
                this.noNoiseOrNoiseOutput;

            if (this.pulldown !== null) {
                this.waveformOutput = this.pulldown[this.waveformOutput] || this.waveformOutput;
            }

            if ((this.waveform & 3) && !this.is6581) {
                this.osc3 = this.triSawPipeline & (this.noPulse | this.pulseOutput) & this.noNoiseOrNoiseOutput;
                if (this.pulldown !== null) {
                    this.osc3 = this.pulldown[this.osc3] || this.osc3;
                }
                this.triSawPipeline = this.wave ? this.wave[ix] : 0;
            } else {
                this.osc3 = this.waveformOutput;
            }

            if (this.is6581 && (this.waveform & 0x2) && (this.waveformOutput & 0x800) === 0) {
                this.msbRising = false;
                this.accumulator &= 0x7fffff;
            }
            this.writeShiftRegister();
        } else {
            if (this.floatingOutputTtl !== 0 && --this.floatingOutputTtl === 0) {
                this.waveBitfade();
            }
        }
        this.pulseOutput = ((this.accumulator >>> 12) >= this.pw) ? 0xfff : 0x000;
        return this.waveformOutput;
    }

    synchronize() {
        if (this.msbRising && this.nextVoice && this.nextVoice.sync) {
            this.nextVoice.accumulator = 0;
        }
    }

    shiftPhase2(waveformOld, waveformNew) {
        const bit0 = ((this.shiftLatch >> 22) ^ (this.shiftLatch >> 17)) & 1;
        this.shiftRegister = ((this.shiftLatch << 1) | (this.testOrReset ? 0 : bit0)) & 0x7fffff;
        if (waveformNew >= 8) {
            this.setNoiseOutput();
        }
    }

    setNoiseOutput() {
        this.noiseOutput =
            ((this.shiftRegister & (1 << 2)) << 9) |
            ((this.shiftRegister & (1 << 4)) << 6) |
            ((this.shiftRegister & (1 << 8)) << 1) |
            ((this.shiftRegister & (1 << 11)) >> 3) |
            ((this.shiftRegister & (1 << 13)) >> 6) |
            ((this.shiftRegister & (1 << 17)) >> 12) |
            ((this.shiftRegister & (1 << 20)) >> 16) |
            ((this.shiftRegister & (1 << 22)) >> 22);
        this.setNoNoiseOrNoiseOutput();
    }

    setNoNoiseOrNoiseOutput() {
        this.noNoiseOrNoiseOutput = this.noNoise | this.noiseOutput;
    }

    writeShiftRegister() {
        if ((this.waveform & 8) !== 0 && (this.waveformOutput & 0x800) === 0) {
            const bit20 = (this.waveformOutput & (1 << 11)) !== 0;
            const bit18 = (this.waveformOutput & (1 << 10)) !== 0;
            const bit14 = (this.waveformOutput & (1 << 9)) !== 0;
            const bit11 = (this.waveformOutput & (1 << 8)) !== 0;
            const bit9 = (this.waveformOutput & (1 << 7)) !== 0;
            const bit5 = (this.waveformOutput & (1 << 5)) !== 0;
            const bit2 = (this.waveformOutput & (1 << 4)) !== 0;
            const bit0 = (this.waveformOutput & 1) !== 0;

            if (!bit20) this.shiftRegister &= ~(1 << 2);
            if (!bit18) this.shiftRegister &= ~(1 << 4);
            if (!bit14) this.shiftRegister &= ~(1 << 8);
            if (!bit11) this.shiftRegister &= ~(1 << 11);
            if (!bit9) this.shiftRegister &= ~(1 << 13);
            if (!bit5) this.shiftRegister &= ~(1 << 17);
            if (!bit2) this.shiftRegister &= ~(1 << 20);
            if (!bit0) this.shiftRegister &= ~(1 << 22);
        }
    }

    waveBitfade() {
        this.waveformOutput &= this.waveformOutput >>> 1;
    }

    shiftregBitfade() {
        this.shiftRegister |= 0x400000;
        this.shiftRegister &= 0x7fffff;
    }

    writeFREQ_LO(value) { this.freq = (this.freq & 0xff00) | (value & 0xff); }
    writeFREQ_HI(value) { this.freq = ((value << 8) & 0xff00) | (this.freq & 0xff); }
    writePW_LO(value) { this.pw = (this.pw & 0xf00) | (value & 0x0ff); }
    writePW_HI(value) { this.pw = ((value << 8) & 0xf00) | (this.pw & 0x0ff); }

    writeCONTROL_REG(control) {
        const waveformOld = this.waveform;
        const waveformNew = (control >> 4) & 0x0f;
        this.waveform = waveformNew;

        if (this.modelWave && waveformNew < this.modelWave.length) {
            this.wave = this.modelWave[waveformNew];
        }

        if (this.modelPulldown && waveformNew >= 3) {
            const pulldownIdx = waveformNew - 3;
            this.pulldown = pulldownIdx < this.modelPulldown.length ?
                this.modelPulldown[pulldownIdx] : null;
        } else {
            this.pulldown = null;
        }

        this.ringMsbMask = (control & 0x04) ? 0x800000 : 0;
        this.sync = (control & 0x02) !== 0;
        const testOld = this.test;
        this.test = (control & 0x08) !== 0;

        if (waveformNew >= 8) {
            this.noNoise = 0;
            this.setNoiseOutput();
        } else {
            this.noNoise = 0xfff;
            this.setNoNoiseOrNoiseOutput();
        }

        if (waveformNew >= 4 && waveformNew < 8) {
            this.noPulse = 0;
        } else {
            this.noPulse = 0xfff;
        }

        if (!testOld && this.test) {
            this.accumulator = 0;
            this.shiftRegisterReset = this.is6581 ? SHIFT_REGISTER_RESET_6581R3 : SHIFT_REGISTER_RESET_8580R5;
            this.shiftPipeline = 0;
            this.pulseOutput = 0xfff;
        } else if (testOld && !this.test) {
            this.shiftLatch = this.shiftRegister;
            this.shiftPipeline = 1;
            this.floatingOutputTtl = this.is6581 ? FLOATING_OUTPUT_TTL_6581R3 : FLOATING_OUTPUT_TTL_8580R5;
        }
    }

    readOSC() { return (this.osc3 >>> 4) & 0xff; }
    readAccumulator() { return this.accumulator; }
    readFreq() { return this.freq; }
    readTest() { return this.test; }
    readFollowingVoiceSync() { return this.nextVoice ? this.nextVoice.sync : false; }
}

// ============================================================================
// VOICE
// ============================================================================

export class Voice {
    constructor() {
        this.waveformGenerator = new WaveformGenerator();
        this.envelopeGenerator = new EnvelopeGenerator();
        this.wavDAC = null;
        this.envDAC = null;
    }

    output() {
        const wav = this.waveformGenerator.output();
        const env = this.envelopeGenerator.output();
        if (this.wavDAC && this.envDAC) {
            return this.wavDAC[wav] * this.envDAC[env];
        }
        const wavNorm = (wav - 2048) / 2048;
        const envNorm = env / 255;
        return wavNorm * envNorm;
    }

    setWavDAC(dac) { this.wavDAC = dac; }
    setEnvDAC(dac) { this.envDAC = dac; }

    setOtherVoices(prev, next) {
        this.waveformGenerator.setOtherWaveforms(prev.wave(), next.wave());
    }

    wave() { return this.waveformGenerator; }
    envelope() { return this.envelopeGenerator; }

    writeCONTROL_REG(control) {
        this.waveformGenerator.writeCONTROL_REG(control);
        this.envelopeGenerator.writeCONTROL_REG(control);
    }

    reset() {
        this.waveformGenerator.reset();
        this.envelopeGenerator.reset();
    }
}
