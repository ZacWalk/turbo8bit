//
// @fileoverview 3D DIP Chip Renderer - Realistic chip visualization
// @module chip3d
//
// Reusable Three.js module for rendering realistic 3D DIP (Dual In-line Package)
// chips like those found in the Commodore 64.
//
// Features:
// - Procedural chip textures with MOS/CSG logo and part numbers
// - Realistic black epoxy body with silver legs
// - Configurable pin count and chip dimensions
// - Pre-defined configurations for common C64 chips
//
// Pre-defined chip types (C64_CHIPS):
// - CPU_6510: MOS 6510 processor (40-pin)
// - VIC_6569: VIC-II video chip (40-pin)
// - SID_6581: SID sound chip (28-pin)
// - CIA_6526: CIA I/O chip (40-pin)
// - RAM_4464: 64Kx4 DRAM (18-pin)
// - ROM_COMBINED: Combined ROM chip
// - MMU: Memory management unit
//
// Used on the SID and Hardware pages of Turbo8bit.
//
// @see https://www.turbo8bit.com/
//

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';

//
// Create a chip label texture with MOS/CSG logo and text
// @param {Object} options - Texture options
// @param {string} options.logo - Logo type: 'MOS' or 'CSG' (default: 'MOS')
// @param {string} options.partNumber - Main part number (e.g., '6581', '6510')
// @param {string} options.dateCode - Date code (e.g., '2483' for week 24, 1983)
// @param {string} options.secondary - Optional secondary text line
// @returns {THREE.CanvasTexture} The chip label texture
//
export function createChipTexture(options = {}) {
    const {
        logo = 'MOS',
        partNumber = '6581',
        dateCode = '2483',
        secondary = null
    } = options;

    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 256;
    const ctx = canvas.getContext('2d');

    // Black background
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const texture = new THREE.CanvasTexture(canvas);

    // Try to load logo image, fall back to text if not available
    const img = new Image();
    const logoFile = logo === 'CSG' ? '/static/csg.png' : '/static/mos.png';

    // Function to draw chip text (called after logo or on error)
    const drawChipText = () => {
        // White text for chip numbers
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 52px monospace';
        ctx.textAlign = 'center';

        // Part number
        ctx.fillText(partNumber, canvas.width / 2, 150);

        // Date code or secondary text
        if (secondary) {
            ctx.fillText(secondary, canvas.width / 2, 210);
        } else if (dateCode) {
            ctx.fillText(dateCode, canvas.width / 2, 210);
        }

        texture.needsUpdate = true;
    };

    // Function to draw text-based logo (fallback)
    const drawTextLogo = () => {
        ctx.fillStyle = '#ffffff';
        ctx.font = 'bold 36px monospace';
        ctx.textAlign = 'center';
        ctx.fillText(logo, canvas.width / 2, 60);
        drawChipText();
    };

    img.onload = () => {
        // Draw logo centered, scaled to fit
        const logoHeight = 60;
        const logoWidth = (img.width / img.height) * logoHeight;
        ctx.drawImage(img, (canvas.width - logoWidth) / 2, 30, logoWidth, logoHeight);
        drawChipText();
    };

    img.onerror = () => {
        // Logo image not found, use text fallback
        drawTextLogo();
    };

    img.src = logoFile;

    // Draw initial text in case image loading takes time
    drawChipText();

    return texture;
}

//
// Create a single realistic DIP pin
// @param {THREE.Material} pinMaterial - Material for the pin
// @param {number} side - Side multiplier (1 for right, -1 for left)
// @returns {THREE.Group} Pin group
//
function createPin(pinMaterial, side) {
    const pinGroup = new THREE.Group();

    // Pin dimensions
    const pinWidthWide = 0.05;   // Wide at chip body
    const pinWidthNarrow = 0.02; // Narrow below chip
    const pinThickness = 0.015;  // Thin
    const zDir = side > 0 ? 1 : -1; // Direction outward from chip

    // Horizontal section (comes out of chip side - WIDE and FLAT)
    const horizLength = 0.05;
    const horizGeo = new THREE.BoxGeometry(pinWidthWide, pinThickness, horizLength);
    const horiz = new THREE.Mesh(horizGeo, pinMaterial);
    horiz.position.z = zDir * horizLength / 2;
    pinGroup.add(horiz);

    // Bend section - smooth wide/flat curve using extruded arc shape
    const bendRadius = 0.025;

    // Create a 2D arc shape (quarter circle profile)
    const arcShape = new THREE.Shape();
    const innerRadius = bendRadius - pinThickness / 2;
    const outerRadius = bendRadius + pinThickness / 2;

    // Start at horizontal end (inner edge)
    arcShape.moveTo(0, innerRadius);
    // Arc to vertical (inner edge)
    arcShape.absarc(0, 0, innerRadius, Math.PI / 2, 0, true);
    // Line to outer edge
    arcShape.lineTo(outerRadius, 0);
    // Arc back (outer edge)
    arcShape.absarc(0, 0, outerRadius, 0, Math.PI / 2, false);
    // Close
    arcShape.closePath();

    // Extrude the arc shape with the pin width
    const arcExtrudeSettings = { depth: pinWidthWide, bevelEnabled: false };
    const arcGeo = new THREE.ExtrudeGeometry(arcShape, arcExtrudeSettings);

    // Position and rotate the bend
    const bendMesh = new THREE.Mesh(arcGeo, pinMaterial);
    // Center the extrusion
    bendMesh.geometry.translate(0, 0, -pinWidthWide / 2);
    // Rotate to correct orientation
    bendMesh.rotation.y = Math.PI / 2;
    bendMesh.rotation.z = zDir > 0 ? Math.PI / 2 : Math.PI * 2;
    bendMesh.position.set(0, zDir > 0 ? -zDir * horizLength / 2 : -horizLength / 2, zDir * horizLength);
    pinGroup.add(bendMesh);

    // Short vertical section after bend (still WIDE)
    const vertWideHeight = 0.03;
    const vertWideGeo = new THREE.BoxGeometry(pinWidthWide, vertWideHeight, pinThickness);
    const vertWide = new THREE.Mesh(vertWideGeo, pinMaterial);
    vertWide.position.set(0, -bendRadius - vertWideHeight / 2, zDir * (horizLength + bendRadius));
    pinGroup.add(vertWide);

    // Taper section (wide to narrow transition)
    const taperHeight = 0.05;
    const taperShape = new THREE.Shape();
    taperShape.moveTo(-pinWidthWide / 2, 0);
    taperShape.lineTo(pinWidthWide / 2, 0);
    taperShape.lineTo(pinWidthNarrow / 2, -taperHeight);
    taperShape.lineTo(-pinWidthNarrow / 2, -taperHeight);
    taperShape.closePath();

    const extrudeSettings = { depth: pinThickness, bevelEnabled: false };
    const taperGeo = new THREE.ExtrudeGeometry(taperShape, extrudeSettings);
    taperGeo.translate(0, 0, -pinThickness / 2);
    const taper = new THREE.Mesh(taperGeo, pinMaterial);
    taper.position.set(0, -bendRadius - vertWideHeight, zDir * (horizLength + bendRadius));
    pinGroup.add(taper);

    // Lower straight section (NARROW)
    const lowerHeight = 0.14;
    const lowerGeo = new THREE.BoxGeometry(pinWidthNarrow, lowerHeight, pinThickness);
    const lower = new THREE.Mesh(lowerGeo, pinMaterial);
    lower.position.set(0, -bendRadius - vertWideHeight - taperHeight - lowerHeight / 2, zDir * (horizLength + bendRadius));
    pinGroup.add(lower);

    // Pointed tip
    const tipHeight = 0.03;
    const tipShape = new THREE.Shape();
    tipShape.moveTo(-pinWidthNarrow / 2, 0);
    tipShape.lineTo(pinWidthNarrow / 2, 0);
    tipShape.lineTo(0, -tipHeight);
    tipShape.closePath();

    const tipGeo = new THREE.ExtrudeGeometry(tipShape, extrudeSettings);
    tipGeo.translate(0, 0, -pinThickness / 2);
    const tip = new THREE.Mesh(tipGeo, pinMaterial);
    tip.position.set(0, -bendRadius - vertWideHeight - taperHeight - lowerHeight, zDir * (horizLength + bendRadius));
    pinGroup.add(tip);

    return pinGroup;
}

//
// Create a 3D DIP chip mesh
// @param {Object} options - Chip options
// @param {number} options.pinCount - Number of pins per side (default: 14 for 28-pin DIP)
// @param {number} options.length - Chip body length (default: 1.4)
// @param {number} options.width - Chip body width (default: 0.6)
// @param {THREE.Texture} options.texture - Label texture for chip top
// @returns {THREE.Group} The chip mesh group
//
export function createDIPChip(options = {}) {
    const {
        pinCount = 14,
        length = 1.4,
        width = 0.6,
        texture = null
    } = options;

    const height = 0.2;
    const pinPitch = length / (pinCount + 1);

    const chipGroup = new THREE.Group();

    // Materials
    const chipMaterial = new THREE.MeshStandardMaterial({ color: 0x1a1a1a, roughness: 0.7 });
    const topMaterial = texture
        ? new THREE.MeshStandardMaterial({ map: texture, roughness: 0.6 })
        : chipMaterial;

    const pinMaterial = new THREE.MeshStandardMaterial({
        color: 0xeeeeee,  // Silver color
        metalness: 0.9,
        roughness: 0.3
    });

    // Create chip body with textured top
    const bodyGeo = new THREE.BoxGeometry(length, height, width);
    // Materials: right, left, top, bottom, front, back
    const materials = [
        chipMaterial, chipMaterial,
        topMaterial, chipMaterial,
        chipMaterial, chipMaterial
    ];
    const chipBody = new THREE.Mesh(bodyGeo, materials);
    chipGroup.add(chipBody);

    // Add the "dimple" (Pin 1 marker)
    const dimpleGeo = new THREE.SphereGeometry(0.04, 16, 16);
    const dimple = new THREE.Mesh(dimpleGeo, chipMaterial);
    dimple.position.set(-length / 2 + 0.1, 0.08, -width / 2 + 0.1);
    chipBody.add(dimple);

    // Create pins on both sides
    function createPins(sideZ) {
        for (let i = 0; i < pinCount; i++) {
            const pin = createPin(pinMaterial, sideZ);
            const xPos = -length / 2 + pinPitch + (i * pinPitch);
            pin.position.set(xPos, 0, sideZ);
            chipBody.add(pin);
        }
    }

    createPins(width / 2);   // Right side pins
    createPins(-width / 2);  // Left side pins

    return chipGroup;
}

//
// Initialize a 3D chip scene in a container
// @param {HTMLElement} container - DOM element to render into
// @param {Object} options - Scene options
// @param {Object} options.chipOptions - Options for createDIPChip
// @param {Object} options.textureOptions - Options for createChipTexture
// @param {boolean} options.autoRotate - Enable auto-rotation (default: true)
// @param {number} options.autoRotateSpeed - Rotation speed (default: 1.0)
// @param {Object} options.cameraPosition - Camera position {x, y, z}
// @returns {Object} Scene controller with update/dispose methods
//
export function initChip3DScene(container, options = {}) {
    const {
        chipOptions = {},
        textureOptions = {},
        autoRotate = true,
        autoRotateSpeed = 1.0,
        cameraPosition = { x: 1.5, y: 1.2, z: 1.8 }
    } = options;

    const width = container.clientWidth || 300;
    const height = container.clientHeight || 300;

    // Scene setup
    const scene = new THREE.Scene();
    scene.background = null; // Transparent background

    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 1000);
    camera.position.set(cameraPosition.x, cameraPosition.y, cameraPosition.z);

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setSize(width, height);
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(0x000000, 0); // Transparent
    container.appendChild(renderer.domElement);

    // Controls
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.autoRotate = autoRotate;
    controls.autoRotateSpeed = autoRotateSpeed;

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(5, 5, 5);
    scene.add(dirLight);

    // Create chip texture and mesh
    const texture = createChipTexture(textureOptions);
    const chip = createDIPChip({ ...chipOptions, texture });
    scene.add(chip);

    // Animation
    let animationId = null;
    let isRunning = true;

    function animate() {
        if (!isRunning) return;
        animationId = requestAnimationFrame(animate);
        controls.update();
        renderer.render(scene, camera);
    }

    // Handle resize
    function onResize() {
        const newWidth = container.clientWidth || 300;
        const newHeight = container.clientHeight || 300;
        camera.aspect = newWidth / newHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(newWidth, newHeight);
    }

    window.addEventListener('resize', onResize);

    // Start animation
    animate();

    // Return controller
    return {
        scene,
        camera,
        renderer,
        controls,
        chip,

        // Stop animation and clean up
        dispose() {
            isRunning = false;
            if (animationId) {
                cancelAnimationFrame(animationId);
            }
            window.removeEventListener('resize', onResize);
            renderer.dispose();
            container.removeChild(renderer.domElement);
        },

        // Update chip texture
        updateTexture(newTextureOptions) {
            const newTexture = createChipTexture(newTextureOptions);
            // Update the top material
            if (chip.children[0] && chip.children[0].material) {
                const materials = chip.children[0].material;
                if (Array.isArray(materials)) {
                    materials[2].map = newTexture;
                    materials[2].needsUpdate = true;
                }
            }
        }
    };
}

//
// Render a 3D chip to a 2D image (for use in 2D canvas)
// @param {Object} options - Render options
// @param {Object} options.chipOptions - Options for createDIPChip
// @param {Object} options.textureOptions - Options for createChipTexture
// @param {number} options.width - Output image width (default: 150)
// @param {number} options.height - Output image height (default: 120)
// @param {Object} options.cameraAngle - Camera angle {x, y, z} (default: isometric view)
// @param {number} options.rotationY - Y rotation of chip in radians (default: 0)
// @returns {Promise<HTMLImageElement>} Promise resolving to rendered image
//
export async function renderChipToImage(options = {}) {
    const {
        chipOptions = {},
        textureOptions = {},
        width = 150,
        height = 120,
        cameraAngle = { x: 1.5, y: 1.2, z: 1.5 },
        rotationY = 0
    } = options;

    // Create offscreen renderer
    const renderer = new THREE.WebGLRenderer({
        antialias: true,
        alpha: true,
        preserveDrawingBuffer: true
    });
    renderer.setSize(width, height);
    renderer.setPixelRatio(1); // Use 1 for consistent sizing
    renderer.setClearColor(0x000000, 0);

    // Scene
    const scene = new THREE.Scene();

    // Camera
    const camera = new THREE.PerspectiveCamera(45, width / height, 0.1, 100);
    camera.position.set(cameraAngle.x, cameraAngle.y, cameraAngle.z);
    camera.lookAt(0, 0, 0);

    // Lights
    const ambientLight = new THREE.AmbientLight(0xffffff, 0.6);
    scene.add(ambientLight);

    const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
    dirLight.position.set(5, 5, 5);
    scene.add(dirLight);

    // Create chip
    const texture = createChipTexture(textureOptions);
    const chip = createDIPChip({ ...chipOptions, texture });
    chip.rotation.y = rotationY;
    scene.add(chip);

    // Wait for texture to load (logo image)
    await new Promise(resolve => setTimeout(resolve, 100));

    // Render
    renderer.render(scene, camera);

    // Get image data
    const dataURL = renderer.domElement.toDataURL('image/png');

    // Cleanup
    renderer.dispose();

    // Return as Image element
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = dataURL;
    });
}

//
// Pre-render all C64 chips to images for use in 2D canvas
// @param {number} width - Image width
// @param {number} height - Image height
// @returns {Promise<Object>} Object mapping chip names to Image elements
//
export async function preRenderAllChips(width = 120, height = 100) {
    const chipImages = {};

    for (const [name, config] of Object.entries(C64_CHIPS)) {
        try {
            chipImages[name] = await renderChipToImage({
                chipOptions: config.chipOptions,
                textureOptions: config.textureOptions,
                width,
                height,
                rotationY: Math.PI / 6 // Slight angle for nice 3D look
            });
        } catch (e) {
            console.warn(`Failed to render chip ${name}:`, e);
        }
    }

    return chipImages;
}

//
// Chip configurations for common C64 chips
//
export const C64_CHIPS = {
    // The "Big Three" Custom Chips
    SID_6581: {
        textureOptions: { logo: 'MOS', partNumber: '6581', dateCode: '2483' },
        chipOptions: { pinCount: 14, length: 1.4 }
    },
    SID_8580: {
        textureOptions: { logo: 'CSG', partNumber: '8580', dateCode: '4087' },
        chipOptions: { pinCount: 14, length: 1.4 }
    },
    CPU_6510: {
        textureOptions: { logo: 'MOS', partNumber: '6510', dateCode: '2583' },
        chipOptions: { pinCount: 20, length: 1.6 }
    },
    CPU_8500: {
        textureOptions: { logo: 'CSG', partNumber: '8500', dateCode: '0188' },
        chipOptions: { pinCount: 20, length: 1.6 }
    },
    VIC_6569: {
        textureOptions: { logo: 'MOS', partNumber: '6569', dateCode: '1084' },
        chipOptions: { pinCount: 20, length: 1.8 }
    },
    VIC_6567: {
        textureOptions: { logo: 'MOS', partNumber: '6567', dateCode: '2383' },
        chipOptions: { pinCount: 20, length: 1.8 }
    },
    VIC_8565: {
        textureOptions: { logo: 'CSG', partNumber: '8565', dateCode: '2288' },
        chipOptions: { pinCount: 20, length: 1.8 }
    },
    VIC_8562: {
        textureOptions: { logo: 'CSG', partNumber: '8562', dateCode: '1588' },
        chipOptions: { pinCount: 20, length: 1.8 }
    },

    // Support Chips
    CIA_6526: {
        textureOptions: { logo: 'MOS', partNumber: '6526', dateCode: '2684' },
        chipOptions: { pinCount: 20, length: 1.6 }
    },
    CIA_8521: {
        textureOptions: { logo: 'CSG', partNumber: '8521', dateCode: '4587' },
        chipOptions: { pinCount: 20, length: 1.6 }
    },
    PLA_906114: {
        textureOptions: { logo: 'MOS', partNumber: '906114', secondary: '-01' },
        chipOptions: { pinCount: 14, length: 1.4 }
    },
    PLA_251715: {
        textureOptions: { logo: 'CSG', partNumber: '251715', secondary: '-01' },
        chipOptions: { pinCount: 14, length: 1.4 }
    },

    // ROM Chips
    KERNAL: {
        textureOptions: { logo: 'MOS', partNumber: '901227', secondary: '-03' },
        chipOptions: { pinCount: 12, length: 1.2 }
    },
    BASIC: {
        textureOptions: { logo: 'MOS', partNumber: '901226', secondary: '-01' },
        chipOptions: { pinCount: 12, length: 1.2 }
    },
    CHAROM: {
        textureOptions: { logo: 'MOS', partNumber: '901225', secondary: '-01' },
        chipOptions: { pinCount: 12, length: 1.2 }
    },
    // Combined ROM (C64C short board - all ROMs in one chip)
    ROM_COMBINED: {
        textureOptions: { logo: 'CSG', partNumber: '251913', secondary: '-01' },
        chipOptions: { pinCount: 14, length: 1.4 }
    },

    // MMU (Memory Management - same as PLA on C64C)
    MMU: {
        textureOptions: { logo: 'CSG', partNumber: '252535', secondary: '-01' },
        chipOptions: { pinCount: 24, length: 1.8 }
    },

    // RAM (generic - typically not MOS branded)
    RAM_4164: {
        textureOptions: { logo: 'MOS', partNumber: '4164', dateCode: '' },
        chipOptions: { pinCount: 8, length: 0.9, width: 0.4 }
    },
    // RAM for C64C (2 chips of 4464)
    RAM_4464: {
        textureOptions: { logo: 'NEC', partNumber: '4464', dateCode: '' },
        chipOptions: { pinCount: 9, length: 1.0, width: 0.4 }
    }
};

export default {
    createChipTexture,
    createDIPChip,
    initChip3DScene,
    renderChipToImage,
    preRenderAllChips,
    C64_CHIPS
};
