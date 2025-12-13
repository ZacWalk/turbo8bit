//
// @fileoverview C64 Architecture Simulator - 3D hardware visualization
// @module hardware-3d
//
// Interactive 3D visualization of Commodore 64 hardware using Three.js.
// Shows the C64 motherboard with spinning 3D chip models connected
// via animated bus traces.
//
// Features:
// - Three.js-based 3D rendering with orbit controls
// - Realistic DIP chip models with laser-etched labels
// - Animated packet flow on bus traces
// - Chip highlighting and selection
//
// Dependencies:
// - Three.js (imported from CDN)
// - chip3d.js for chip texture generation
//
// For 2D version, see hardware.js.
// For chip rendering, see chip3d.js.
//
// @see https://www.turbo8bit.com/
//

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { createChipTexture, createDIPChip, C64_CHIPS } from '/static/js/chip3d.js';

// Chip layout configuration (positions in 3D space)
const CHIP_LAYOUT = {
    CPU: { x: -4, y: 0, z: 2, config: C64_CHIPS.CPU_6510, label: 'CPU' },
    VIC: { x: -4, y: 0, z: 0, config: C64_CHIPS.VIC_6569, label: 'VIC-II' },
    SID: { x: -4, y: 0, z: -2, config: C64_CHIPS.SID_6581, label: 'SID' },
    CIA: { x: -4, y: 0, z: -4, config: C64_CHIPS.CIA_6526, label: 'CIA' },
    MMU: { x: 4, y: 0, z: 2, config: C64_CHIPS.MMU, label: 'MMU' },
    ROM: { x: 4, y: 0, z: 0, config: C64_CHIPS.ROM_COMBINED, label: 'ROM' },
    RAM1: { x: 4, y: 0, z: -2, config: C64_CHIPS.RAM_4464, label: 'RAM' },
    RAM2: { x: 4, y: 0, z: -3.5, config: C64_CHIPS.RAM_4464, label: 'RAM' }
};

// Colors for bus signals
const COLORS = {
    addressBus: 0xff5555,  // Red
    dataBus: 0xffff55,     // Yellow
    busLine: 0x444444,     // Dark grey
    board: 0x352879        // C64 blue
};

export class Hardware3DSimulator {
    constructor(container) {
        this.container = container;
        this.chips = {};
        this.packets = [];
        this.logPanel = document.getElementById('logPanel');

        this.init();
    }

    init() {
        const width = this.container.clientWidth || 800;
        const height = this.container.clientHeight || 600;

        // Scene setup
        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(COLORS.board);

        // Camera - looking down at the board at an angle
        this.camera = new THREE.PerspectiveCamera(50, width / height, 0.1, 1000);
        this.camera.position.set(0, 12, 8);
        this.camera.lookAt(0, 0, -1);

        // Renderer
        this.renderer = new THREE.WebGLRenderer({ antialias: true });
        this.renderer.setSize(width, height);
        this.renderer.setPixelRatio(window.devicePixelRatio);
        this.container.appendChild(this.renderer.domElement);

        // Controls
        this.controls = new OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.maxPolarAngle = Math.PI / 2.2;
        this.controls.minDistance = 5;
        this.controls.maxDistance = 25;

        // Lights
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
        this.scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 1.0);
        dirLight.position.set(5, 10, 5);
        this.scene.add(dirLight);

        const dirLight2 = new THREE.DirectionalLight(0xffffff, 0.3);
        dirLight2.position.set(-5, 5, -5);
        this.scene.add(dirLight2);

        // Create PCB board
        this.createBoard();

        // Create chips
        this.createChips();

        // Create bus lines
        this.createBusLines();

        // Handle resize
        window.addEventListener('resize', () => this.onResize());

        // Start animation
        this.animate();
    }

    createBoard() {
        // PCB board
        const boardGeo = new THREE.BoxGeometry(14, 0.2, 12);
        const boardMat = new THREE.MeshStandardMaterial({
            color: COLORS.board,
            roughness: 0.8
        });
        const board = new THREE.Mesh(boardGeo, boardMat);
        board.position.y = -0.2;
        this.scene.add(board);

        // Grid lines on board (traces)
        const gridHelper = new THREE.GridHelper(12, 24, 0x4a3a8a, 0x3a2a7a);
        gridHelper.position.y = -0.08;
        this.scene.add(gridHelper);
    }

    createChips() {
        Object.entries(CHIP_LAYOUT).forEach(([name, layout]) => {
            const texture = createChipTexture(layout.config.textureOptions);
            const chip = createDIPChip({
                ...layout.config.chipOptions,
                texture,
                // Scale down chips for the board view
                length: (layout.config.chipOptions.length || 1.4) * 0.6,
                width: (layout.config.chipOptions.width || 0.6) * 0.6
            });

            chip.position.set(layout.x, 0.15, layout.z);
            chip.rotation.y = Math.PI / 2; // Rotate to face forward

            this.scene.add(chip);
            this.chips[name] = {
                mesh: chip,
                layout: layout,
                baseY: 0.15,
                rotationSpeed: 0.005 + Math.random() * 0.005
            };

            // Add label below chip
            this.addChipLabel(layout.label, layout.x, layout.z);
        });
    }

    addChipLabel(text, x, z) {
        const canvas = document.createElement('canvas');
        canvas.width = 128;
        canvas.height = 32;
        const ctx = canvas.getContext('2d');

        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 20px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(text, 64, 24);

        const texture = new THREE.CanvasTexture(canvas);
        const spriteMat = new THREE.SpriteMaterial({ map: texture, transparent: true });
        const sprite = new THREE.Sprite(spriteMat);
        sprite.position.set(x, -0.05, z + 1);
        sprite.scale.set(1.5, 0.4, 1);
        this.scene.add(sprite);
    }

    createBusLines() {
        // Central bus (vertical line)
        const busGeo = new THREE.BoxGeometry(0.8, 0.05, 10);
        const busMat = new THREE.MeshStandardMaterial({
            color: COLORS.busLine,
            roughness: 0.5,
            metalness: 0.3
        });
        const bus = new THREE.Mesh(busGeo, busMat);
        bus.position.set(0, 0, -1);
        this.scene.add(bus);

        // Horizontal connection lines from each chip to bus
        const lineMat = new THREE.MeshStandardMaterial({
            color: 0x555555,
            roughness: 0.6
        });

        Object.values(CHIP_LAYOUT).forEach(layout => {
            const lineGeo = new THREE.BoxGeometry(Math.abs(layout.x) - 0.5, 0.03, 0.1);
            const line = new THREE.Mesh(lineGeo, lineMat);
            line.position.set(layout.x / 2, 0, layout.z);
            this.scene.add(line);
        });
    }

    // Send a signal packet between two chips
    sendSignal(fromChip, toChip, type = 'addr', delay = 0) {
        setTimeout(() => {
            const from = this.chips[fromChip];
            const to = this.chips[toChip];
            if (!from || !to) return;

            const color = type === 'addr' ? COLORS.addressBus : COLORS.dataBus;

            // Create glowing sphere for packet
            const geo = new THREE.SphereGeometry(0.15, 16, 16);
            const mat = new THREE.MeshBasicMaterial({
                color: color,
                transparent: true,
                opacity: 0.9
            });
            const packet = new THREE.Mesh(geo, mat);

            // Start position
            packet.position.set(from.layout.x, 0.5, from.layout.z);
            this.scene.add(packet);

            // Animation data
            this.packets.push({
                mesh: packet,
                from: new THREE.Vector3(from.layout.x, 0.5, from.layout.z),
                mid: new THREE.Vector3(0, 0.5, from.layout.z), // Go through bus
                to: new THREE.Vector3(to.layout.x, 0.5, to.layout.z),
                progress: 0,
                phase: 0 // 0: to bus, 1: along bus, 2: to chip
            });

        }, delay);
    }

    log(msg) {
        if (!this.logPanel) return;
        const div = document.createElement('div');
        div.className = 'log-entry';
        const time = new Date().toLocaleTimeString().split(' ')[0];
        div.innerHTML = `<span class="log-time">[${time}]</span> ${msg}`;
        this.logPanel.appendChild(div);
        this.logPanel.scrollTop = this.logPanel.scrollHeight;
    }

    clearLog() {
        if (this.logPanel) {
            this.logPanel.innerHTML = '';
        }
    }

    animate() {
        requestAnimationFrame(() => this.animate());

        // Rotate chips slowly
        Object.values(this.chips).forEach(chip => {
            chip.mesh.rotation.y += chip.rotationSpeed;
        });

        // Animate packets
        this.packets = this.packets.filter(packet => {
            packet.progress += 0.02;

            if (packet.progress >= 1) {
                if (packet.phase < 2) {
                    // Move to next phase
                    packet.phase++;
                    packet.progress = 0;

                    if (packet.phase === 1) {
                        packet.from = packet.mid;
                        packet.mid = new THREE.Vector3(0, 0.5, packet.to.z);
                    } else {
                        packet.from = new THREE.Vector3(0, 0.5, packet.to.z);
                    }
                } else {
                    // Remove packet
                    this.scene.remove(packet.mesh);
                    packet.mesh.geometry.dispose();
                    packet.mesh.material.dispose();
                    return false;
                }
            }

            // Interpolate position
            const target = packet.phase === 2 ? packet.to : packet.mid;
            packet.mesh.position.lerpVectors(packet.from, target, packet.progress);

            return true;
        });

        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }

    onResize() {
        const width = this.container.clientWidth || 800;
        const height = this.container.clientHeight || 600;
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(width, height);
    }

    // Scenario implementations
    runScenario(scenario) {
        this.clearLog();

        switch (scenario) {
            case 'boot':
                this.log('⚡ Power On - System Reset');
                this.log('CPU reads reset vector from KERNAL ROM...');
                this.sendSignal('CPU', 'ROM', 'addr', 100);
                this.sendSignal('ROM', 'CPU', 'data', 400);
                this.log('CPU begins executing KERNAL initialization...');
                this.sendSignal('CPU', 'VIC', 'addr', 800);
                this.sendSignal('CPU', 'SID', 'addr', 1000);
                this.sendSignal('CPU', 'CIA', 'addr', 1200);
                this.log('System initialized. READY.');
                break;

            case 'typing':
                this.log('⌨️ Key pressed on keyboard');
                this.log('CIA 1 detects keypress, triggers IRQ...');
                this.sendSignal('CIA', 'CPU', 'addr', 100);
                this.log('CPU reads key matrix from CIA...');
                this.sendSignal('CPU', 'CIA', 'addr', 400);
                this.sendSignal('CIA', 'CPU', 'data', 600);
                this.log('CPU converts to PETSCII, stores in screen RAM...');
                this.sendSignal('CPU', 'RAM1', 'addr', 900);
                this.sendSignal('CPU', 'RAM1', 'data', 1100);
                break;

            case 'vic':
                this.log('📺 VIC-II begins screen refresh');
                this.log('VIC reads character codes from RAM...');
                this.sendSignal('VIC', 'RAM1', 'addr', 100);
                this.sendSignal('RAM1', 'VIC', 'data', 300);
                this.log('VIC reads character shapes from ROM...');
                this.sendSignal('VIC', 'ROM', 'addr', 500);
                this.sendSignal('ROM', 'VIC', 'data', 700);
                this.log('VIC reads color data...');
                this.sendSignal('VIC', 'RAM2', 'addr', 900);
                this.sendSignal('RAM2', 'VIC', 'data', 1100);
                break;

            case 'sound':
                this.log('🎵 Playing a note on SID');
                this.log('CPU sets frequency registers...');
                this.sendSignal('CPU', 'SID', 'addr', 100);
                this.sendSignal('CPU', 'SID', 'data', 250);
                this.log('CPU sets ADSR envelope...');
                this.sendSignal('CPU', 'SID', 'addr', 400);
                this.sendSignal('CPU', 'SID', 'data', 550);
                this.log('CPU triggers gate (note on)...');
                this.sendSignal('CPU', 'SID', 'addr', 700);
                this.sendSignal('CPU', 'SID', 'data', 850);
                this.log('♪ Note plays through SID!');
                break;
        }
    }

    dispose() {
        this.renderer.dispose();
        this.container.removeChild(this.renderer.domElement);
    }
}

// Export for use
export default Hardware3DSimulator;
