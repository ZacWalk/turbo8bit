"""Regression coverage for the reference pages, without a browser or WebGL."""

import json
import re
from dataclasses import asdict
from html.parser import HTMLParser
from pathlib import Path

import pytest
from py_mini_racer import MiniRacer

from tools.parse_memmap import (
    clean_ocr_text,
    parse_address,
    parse_bits,
    parse_memmap,
)


ROOT = Path(__file__).resolve().parents[1]
JS = ROOT / "web" / "static" / "js"


class TemplateControls(HTMLParser):
    def __init__(self, text):
        super().__init__()
        self.elements = []
        self.feed(text)

    def handle_starttag(self, tag, attrs):
        attributes = dict(attrs)
        if "id" in attributes or tag == "button":
            self.elements.append({"tag": tag, "attributes": attributes})


DOM = r"""
class Element {
    constructor(tag = 'div') {
        this.tagName = tag.toUpperCase();
        this.attributes = {};
        this.dataset = {};
        this.className = '';
        this.children = [];
        this.parentNode = null;
        this.style = {};
        this.listeners = {};
        this.textContent = '';
        this.tabIndex = tag === 'button' ? 0 : -1;
        this.classList = {
            contains: value => this.className.split(/\s+/).includes(value),
            add: (...values) => {
                this.className = [...new Set([...this.className.split(/\s+/), ...values])]
                    .filter(Boolean).join(' ');
            },
            remove: (...values) => {
                this.className = this.className.split(/\s+/)
                    .filter(value => !values.includes(value)).join(' ');
            },
            toggle: (value, enabled = !this.classList.contains(value)) => {
                if (enabled) this.classList.add(value);
                else this.classList.remove(value);
            }
        };
    }
    set innerHTML(value) {
        this.html = value;
        this.children.forEach(child => { child.parentNode = null; });
        this.children = [];
    }
    get innerHTML() { return this.html || ''; }
    setAttribute(name, value) {
        this.attributes[name] = String(value);
        if (name === 'class') this.className = value;
        if (name === 'id') this.id = value;
        if (name === 'tabindex') this.tabIndex = Number(value);
        if (name.startsWith('data-')) {
            this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = String(value);
        }
    }
    getAttribute(name) {
        if (name.startsWith('data-')) {
            return this.dataset[name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase())] ?? null;
        }
        return this.attributes[name] ?? null;
    }
    appendChild(child) {
        child.parentNode = this;
        this.children.push(child);
        return child;
    }
    removeChild(child) {
        this.children = this.children.filter(node => node !== child);
        child.parentNode = null;
    }
    contains(node) {
        for (; node; node = node.parentNode) if (node === this) return true;
        return false;
    }
    matches(selector) {
        if (selector.includes(',')) return selector.split(',').some(s => this.matches(s.trim()));
        const tag = selector.match(/^[a-z]+/i)?.[0];
        if (tag && this.tagName !== tag.toUpperCase()) return false;
        for (const match of selector.matchAll(/\.([\w-]+)/g)) {
            if (!this.classList.contains(match[1])) return false;
        }
        for (const match of selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g)) {
            const value = this.getAttribute(match[1]);
            if (value === null || (match[2] !== undefined && value !== match[2])) return false;
        }
        return true;
    }
    querySelectorAll(selector) {
        const result = [];
        for (const child of this.children) {
            if (child.matches(selector)) result.push(child);
            result.push(...child.querySelectorAll(selector));
        }
        return result;
    }
    querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
    closest(selector) {
        for (let node = this; node; node = node.parentNode) {
            if (node.matches(selector)) return node;
        }
        return null;
    }
    addEventListener(type, callback) {
        (this.listeners[type] ||= []).push(callback);
    }
    fire(type, extra = {}) {
        const event = {target: this, currentTarget: this, preventDefault() {}, stopPropagation() {}, ...extra};
        for (const callback of this.listeners[type] || []) callback(event);
    }
    click() { this.fire('click'); }
    focus() { document.activeElement = this; this.fire('focus'); }
}
const root = new Element();
const document = {
    activeElement: null,
    listeners: {},
    createElement: tag => new Element(tag),
    createTextNode: text => Object.assign(new Element('text'), {textContent: text}),
    getElementById: id => root.querySelectorAll('[id]').find(node => node.id === id) || null,
    querySelectorAll: selector => root.querySelectorAll(selector),
    querySelector: selector => root.querySelector(selector),
    addEventListener(type, callback) { (this.listeners[type] ||= []).push(callback); },
    fire(type, extra = {}) {
        for (const callback of this.listeners[type] || []) {
            callback({target: this.activeElement, preventDefault() {}, ...extra});
        }
    }
};
"""


@pytest.fixture
def memory_page():
    template = (ROOT / "web" / "templates" / "memmap.html").read_text(encoding="utf-8")
    controls = TemplateControls(template).elements
    entries = [
        dict(
            address=1,
            name="R6510",
            hex_addr="$0001",
            title="CPU port",
            region="zeropage",
        ),
        dict(
            address=0xD400,
            name="FRELO1",
            hex_addr="$D400",
            title="SID frequency",
            region="sid",
        ),
        dict(
            address=0xE000,
            name="KERNAL_TEST",
            hex_addr="$E000",
            title="Test entry",
            region="kernal",
        ),
    ]
    ctx = MiniRacer()
    ctx.eval(DOM)
    ctx.eval(
        "for (const spec of "
        + json.dumps(controls)
        + """) {
            const element = new Element(spec.tag);
            for (const [name, value] of Object.entries(spec.attributes)) {
                element.setAttribute(name, value || '');
            }
            if (element.classList.contains('bit-btn')) {
                const value = new Element('span');
                value.className = 'bit-value';
                element.appendChild(value);
            }
            root.appendChild(element);
        }"""
    )
    ctx.eval("const memoryEntries = " + json.dumps(entries) + ";")
    source = (JS / "memmap.js").read_text(encoding="utf-8")
    # Run the real DOM initialization synchronously, with an already-loaded dataset.
    body = source[source.index("    // Banking state") : source.rfind("});")]
    ctx.eval(
        "(function() {"
        + body
        + ";globalThis.referencePage = {state, getMemoryLayout, updateMemoryMap};})();"
    )
    yield ctx


# The published PLA table lists physical high/low latch levels, not asserted
# /GAME and /EXROM booleans: https://www.c64-wiki.com/wiki/Bank_Switching
# Columns are $1000, $8000, $A000, $C000, $D000, $E000; rows are C/H/L = 0..7.
PLA_ROWS = {
    "none": [
        "ram ram ram ram ram ram",
        "ram ram ram ram charrom ram",
        "ram ram ram ram charrom kernal",
        "ram ram basic ram charrom kernal",
        "ram ram ram ram ram ram",
        "ram ram ram ram io ram",
        "ram ram ram ram io kernal",
        "ram ram basic ram io kernal",
    ],
    "8k": [
        "ram ram ram ram ram ram",
        "ram ram ram ram charrom ram",
        "ram ram ram ram charrom kernal",
        "ram cart-lo basic ram charrom kernal",
        "ram ram ram ram ram ram",
        "ram ram ram ram io ram",
        "ram ram ram ram io kernal",
        "ram cart-lo basic ram io kernal",
    ],
    "16k": [
        "ram ram ram ram ram ram",
        "ram ram ram ram ram ram",
        "ram ram cart-hi ram charrom kernal",
        "ram cart-lo cart-hi ram charrom kernal",
        "ram ram ram ram ram ram",
        "ram ram ram ram io ram",
        "ram ram cart-hi ram io kernal",
        "ram cart-lo cart-hi ram io kernal",
    ],
    "ultimax": ["unmapped cart-lo unmapped unmapped io cart-hi"] * 8,
}


@pytest.mark.parametrize("port", range(8))
@pytest.mark.parametrize("mode", PLA_ROWS)
def test_pla_all_32_modes(memory_page, mode, port):
    state = {
        "loram": bool(port & 1),
        "hiram": bool(port & 2),
        "charen": bool(port & 4),
        "game": mode in ("16k", "ultimax"),
        "exrom": mode in ("8k", "16k"),
    }
    memory_page.eval("Object.assign(referencePage.state, " + json.dumps(state) + ");")
    layout = json.loads(
        memory_page.eval("JSON.stringify(referencePage.getMemoryLayout())")
    )
    assert layout[0]["start"] == 0
    assert layout[-1]["end"] == 0xFFFF
    assert all(a["end"] + 1 == b["start"] for a, b in zip(layout, layout[1:]))
    addresses = (0x1000, 0x8000, 0xA000, 0xC000, 0xD000, 0xE000)
    actual = [
        next(r["type"] for r in layout if r["start"] <= a <= r["end"])
        for a in addresses
    ]
    assert actual == PLA_ROWS[mode][port].split()
    assert next(r["type"] for r in layout if r["start"] <= 0x0FFF <= r["end"]) == "ram"


@pytest.mark.parametrize(
    ("info_id", "name", "address"),
    [
        ("zeropage", "ZERO PAGE", "$0000-$00FF"),
        ("stack", "STACK", "$0100-$01FF"),
        ("basic", "BASIC ROM", "$A000-$BFFF"),
        ("kernal", "KERNAL ROM", "$E000-$FFFF"),
        ("io", "I/O", "$D000-$DFFF"),
    ],
)
def test_cpu_region_details_use_the_region_model(memory_page, info_id, name, address):
    memory_page.eval(f"document.querySelector('[data-info=\"{info_id}\"]').click();")
    assert memory_page.eval("document.getElementById('entry-name').textContent") == name
    assert (
        memory_page.eval("document.getElementById('entry-address').textContent")
        == address
    )
    assert (
        len(
            memory_page.eval("document.getElementById('entry-description').textContent")
        )
        > 30
    )


@pytest.mark.parametrize("bank", range(4))
def test_vic_merged_ranges_are_ascending(memory_page, bank):
    memory_page.eval(
        f"referencePage.state.vicBank = {bank}; referencePage.updateMemoryMap();"
    )
    ranges = json.loads(
        memory_page.eval(
            """JSON.stringify(document.querySelectorAll('.vic-visible').map(cell => {
                cell.fire('mouseenter');
                return document.getElementById('entry-address').textContent;
            }))"""
        )
    )
    bounds = [
        [int(part.removeprefix("$"), 16) for part in span.split("-")] for span in ranges
    ]
    assert all(start <= end for start, end in bounds)
    assert sum(end - start + 1 for start, end in bounds) == 0x4000
    assert min(start for start, _ in bounds) == bank * 0x4000
    assert max(end for _, end in bounds) == bank * 0x4000 + 0x3FFF


def test_vic_character_rom_is_described_as_rom(memory_page):
    memory_page.eval(
        "document.querySelector('.vic-visible.region-charrom').fire('mouseenter');"
    )
    description = memory_page.eval(
        "document.getElementById('entry-description').textContent"
    )
    assert "ROM" in description
    assert "instead of RAM" in description


def test_memory_details_are_native_labelled_keyboard_controls(memory_page):
    assert memory_page.eval(
        """document.querySelectorAll('.memory-cell, .mem-cell')
            .filter(cell => cell.listeners.click)
            .every(cell => cell.tagName === 'BUTTON' && cell.tabIndex >= 0 && cell.getAttribute('aria-label'))"""
    )
    memory_page.eval("document.querySelector('.mem-cell').focus();")
    assert (
        memory_page.eval("document.getElementById('entry-name').textContent")
        == "KERNAL_TEST"
    )


def test_annotations_keep_focus_after_banking_redraw(memory_page):
    memory_page.eval(
        """document.querySelectorAll('.mem-cell')
            .find(cell => cell.getAttribute('aria-label')?.includes('R6510')).focus();
        document.fire('keydown', {key: '1'});"""
    )
    assert memory_page.eval(
        "document.getElementById('memory-table-body').contains(document.activeElement)"
    )
    assert "R6510" in memory_page.eval(
        "document.activeElement.getAttribute('aria-label')"
    )


def test_banked_out_annotation_moves_focus_to_its_cpu_region(memory_page):
    memory_page.eval(
        """document.querySelectorAll('.mem-cell')
            .find(cell => cell.getAttribute('aria-label')?.includes('KERNAL_TEST')).focus();
        document.fire('keydown', {key: '2'});"""
    )
    assert memory_page.eval(
        "document.getElementById('memory-table-body').contains(document.activeElement)"
    )
    assert (
        memory_page.eval("document.getElementById('entry-name').textContent") == "RAM"
    )
    assert (
        memory_page.eval("document.getElementById('entry-address').textContent")
        == "$E000-$FFFF"
    )


def test_toggle_controls_expose_their_current_state(memory_page):
    memory_page.eval(
        """document.querySelector('[data-signal="exrom"]').click();
        document.querySelector('[data-bank="2"]').click();
        document.querySelector('[data-preset="allram"]').click();"""
    )
    assert memory_page.eval(
        """document.querySelectorAll('.bit-btn, .signal-btn, .vic-bank-btn, .preset-btn')
            .every(button => button.getAttribute('aria-pressed') === String(button.classList.contains('active')))"""
    )


@pytest.mark.parametrize(
    ("header", "address", "end", "name"),
    [
        ("$0 D6510", 0, None, "D6510"),
        ("1 15-138 $73-$8il CHRGET", 115, 138, "CHRGET"),
        ("54272 $D400 FRELOl", 0xD400, None, "FRELO1"),
        ("54276 $D404 VCREGl", 0xD404, None, "VCREG1"),
        ("56320 $DCOO CIAPRA", 0xDC00, None, "CIAPRA"),
        ("56576 $DDOO CI2PRA", 0xDD00, None, "CI2PRA"),
        ("776-771 $308-$309 IGONE", 776, 777, "IGONE"),
    ],
)
def test_evidenced_ocr_headers(header, address, end, name):
    source = (ROOT / "memory-map.txt").read_text(encoding="utf-8")
    assert header in source
    entries = parse_memmap(
        clean_ocr_text(header + "\n\nFixture title\n\nFixture description.")
    )
    assert [(e.address, e.address_end, e.name) for e in entries] == [
        (address, end, name)
    ]


@pytest.mark.parametrize("token", ["128 $80\nEND", "164 $A4 TO", "180 $B4\nSGN"])
def test_basic_token_tables_do_not_become_zero_page_entries(token):
    source = (
        "40972-41041 $A00C-$A051 STMDSP\n\nStatement vectors\n\n"
        "Token # Keyword\n\n"
        + token
        + "\n\n41042-41087 $A052-$A07F FUNDSP\n\nFunction vectors\n"
    )
    entries = parse_memmap(clean_ocr_text(source))
    assert [entry.name for entry in entries] == ["STMDSP", "FUNDSP"]
    assert token in entries[0].description


@pytest.mark.parametrize("address", ["65536", "-1", "776-771", "100-65536", "10extra"])
def test_invalid_addresses_are_rejected(address):
    with pytest.raises(ValueError):
        parse_address(address)


def test_disagreeing_decimal_and_hex_headers_are_not_published():
    with pytest.warns(UserWarning, match="address"):
        entries = parse_memmap("84-85 $54-$56 JMPER\n\nAmbiguous OCR header\n")
    assert entries == []


@pytest.mark.parametrize(
    "rejected_header", ["84-85 $54-$56 JMPER", "85-84 $55-$54 BACKWARDS"]
)
@pytest.mark.parametrize("following_entry", [False, True])
def test_rejected_address_headings_still_bound_descriptions(
    rejected_header, following_entry
):
    source = (
        "83 $53 FIRST\n\nValid title\n\nFirst description.\n\n"
        f"{rejected_header}\n\nRejected title\n\n"
        "This description belongs to the rejected address.\n"
        "Bit 0: This bit belongs to the rejected address.\n\n"
    )
    if following_entry:
        source += "87 $57 NEXT\n\nNext title\n\nNext description.\n"
    with pytest.warns(UserWarning, match="address"):
        entries = parse_memmap(source)
    assert entries[0].description == "First description."
    assert entries[0].bits == []
    assert [entry.name for entry in entries] == (
        ["FIRST", "NEXT"] if following_entry else ["FIRST"]
    )
    if following_entry:
        assert entries[1].description == "Next description."


def test_bit_fields_accept_plural_and_wrapped_descriptions():
    bits = parse_bits("Bits 0-3: volume\ncontinued here\n\nBit 4: filter\n")
    assert bits == [
        {"bit": 0, "bit_end": 3, "description": "volume continued here"},
        {"bit": 4, "bit_end": None, "description": "filter"},
    ]


def test_bit_references_in_prose_are_not_fields():
    assert parse_bits("Bits 3-5 of this register control the cassette.\n") == []


def test_generated_data_is_valid_and_reproducible():
    source = clean_ocr_text((ROOT / "memory-map.txt").read_text(encoding="utf-8"))
    with pytest.warns(UserWarning, match="address"):
        entries = [asdict(entry) for entry in parse_memmap(source)]
    published = json.loads((JS / "memmap-data.json").read_text(encoding="utf-8"))[
        "entries"
    ]
    assert entries == published
    addresses = [entry["address"] for entry in entries]
    identities = [(e["address"], e["address_end"], e["name"]) for e in entries]
    assert len(identities) == len(set(identities))
    # FAC2 is the range $69-$6E; ARGEXP is its first byte, not a duplicate entry.
    assert {(e["address_end"], e["name"]) for e in entries if e["address"] == 105} == {
        (110, "FAC2"),
        (None, "ARGEXP"),
    }
    assert all(
        0 <= e["address"] <= (e["address_end"] or e["address"]) <= 65535
        for e in entries
    )
    assert {0, 1, 0xD400, 0xD404, 0xDC00, 0xDD00} <= set(addresses)
    assert not any(
        e["address"] < 256 and e["name"] in {"END", "FOR", "TO", "SGN"} for e in entries
    )


SCENE_ENVIRONMENT = r"""
class Events {
    constructor() { this.listeners = {}; }
    addEventListener(type, callback) { (this.listeners[type] ||= new Set()).add(callback); }
    removeEventListener(type, callback) { this.listeners[type]?.delete(callback); }
    fire(type) { for (const callback of this.listeners[type] || []) callback({type}); }
}
let nextFrame = 0;
const frames = new Map();
function requestAnimationFrame(callback) { frames.set(++nextFrame, callback); return nextFrame; }
function cancelAnimationFrame(id) { frames.delete(id); }
function tick() {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach(callback => callback());
}
const motion = new Events();
motion.matches = false;
const window = new Events();
window.devicePixelRatio = 2;
window.matchMedia = () => motion;
const document = new Events();
document.hidden = false;
const observers = [];
class IntersectionObserver {
    constructor(callback) { this.callback = callback; this.disconnected = false; observers.push(this); }
    observe() {}
    disconnect() { this.disconnected = true; }
    show(visible) { this.callback([{isIntersecting: visible}]); }
}
class Base {
    constructor() { this.position = {set() {}}; }
    add() {}
    updateProjectionMatrix() {}
}
const counts = {renders: 0, renderers: 0, controls: 0, geometries: 0, materials: 0, textures: 0, contexts: 0};
class Renderer {
    constructor() { this.domElement = {setAttribute() {}, parentNode: null}; }
    setSize() {}
    setPixelRatio() {}
    setClearColor() {}
    render() { counts.renders++; }
    dispose() { counts.renderers++; }
    forceContextLoss() { counts.contexts++; }
}
const THREE = {Scene: Base, PerspectiveCamera: Base, WebGLRenderer: Renderer, AmbientLight: Base, DirectionalLight: Base};
class OrbitControls extends Events {
    constructor() { super(); this.changed = false; }
    update() {
        const changed = this.changed;
        this.changed = false;
        if (changed) this.fire('change');
        return changed;
    }
    dispose() { counts.controls++; }
}
const textures = [];
function createChipTexture(options, onChange) {
    const texture = {onChange, disposeCount: 0, dispose() { this.disposeCount++; counts.textures++; }};
    textures.push(texture);
    if (onChange) onChange();
    return texture;
}
function createDIPChip({texture}) {
    const plastic = {dispose() { counts.materials++; }};
    const top = {map: texture, dispose() { counts.materials++; }};
    const geometry = {dispose() { counts.geometries++; }};
    const body = {geometry, material: [plastic, plastic, top, plastic]};
    return {children: [body], traverse(callback) { callback(body); callback({geometry, material: plastic}); }};
}
function container() {
    return {
        clientWidth: 240, clientHeight: 180,
        getBoundingClientRect: () => ({top: 2000, bottom: 2180, left: 0, right: 240}),
        appendChild(node) { node.parentNode = this; },
        removeChild(node) { node.parentNode = null; }
    };
}
"""


def js_function(source, name):
    match = re.search(r"(?:export )?(?:async )?function " + name + r"\(", source)
    if match is None:
        return ""
    opening = source.index("{", source.index(") {", match.start()))
    depth = 1
    end = opening + 1
    while depth:
        depth += (source[end] == "{") - (source[end] == "}")
        end += 1
    return source[match.start() : end].removeprefix("export ")


@pytest.fixture
def chip_scene():
    source = (JS / "chip3d.js").read_text(encoding="utf-8")
    ctx = MiniRacer()
    ctx.eval(SCENE_ENVIRONMENT)
    ctx.eval(js_function(source, "disposeChipResources"))
    ctx.eval(js_function(source, "initChip3DScene"))
    yield ctx


def test_chip_animation_only_runs_while_visible(chip_scene):
    chip_scene.eval("const scene = initChip3DScene(container());")
    assert chip_scene.eval("frames.size") == 0
    chip_scene.eval("observers[0].show(true); tick();")
    assert chip_scene.eval("counts.renders") == 1
    assert chip_scene.eval("frames.size") == 1
    chip_scene.eval("observers[0].show(false); tick();")
    assert chip_scene.eval("counts.renders") == 1
    assert chip_scene.eval("frames.size") == 0
    chip_scene.eval("observers[0].show(true); tick();")
    assert chip_scene.eval("counts.renders") == 2


def test_chip_respects_reduced_motion_and_can_resume(chip_scene):
    chip_scene.eval(
        "motion.matches = true; const scene = initChip3DScene(container());"
    )
    chip_scene.eval("observers[0].show(true); tick(); tick();")
    assert chip_scene.eval("scene.controls.autoRotate") is False
    assert chip_scene.eval("counts.renders") == 1
    assert chip_scene.eval("frames.size") == 0
    chip_scene.eval("motion.matches = false; motion.fire('change'); tick();")
    assert chip_scene.eval("scene.controls.autoRotate") is True
    assert chip_scene.eval("frames.size") == 1
    chip_scene.eval("motion.matches = true; motion.fire('change'); tick(); tick();")
    assert chip_scene.eval("frames.size") == 0


def test_hidden_document_cancels_and_resumes_chip_animation(chip_scene):
    chip_scene.eval(
        "const scene = initChip3DScene(container()); observers[0].show(true); tick();"
    )
    chip_scene.eval(
        "document.hidden = true; document.fire('visibilitychange'); tick();"
    )
    assert chip_scene.eval("frames.size") == 0
    assert chip_scene.eval("counts.renders") == 1
    chip_scene.eval(
        "document.hidden = false; document.fire('visibilitychange'); tick();"
    )
    assert chip_scene.eval("counts.renders") == 2


def test_static_chip_renders_on_interaction_resize_and_texture_load(chip_scene):
    chip_scene.eval("const scene = initChip3DScene(container(), {autoRotate: false});")
    chip_scene.eval("observers[0].show(true); tick(); tick();")
    assert chip_scene.eval("frames.size") == 0
    assert chip_scene.eval("counts.renders") == 1
    chip_scene.eval("scene.controls.fire('change'); tick();")
    assert chip_scene.eval("counts.renders") == 2
    chip_scene.eval("window.fire('resize'); tick();")
    assert chip_scene.eval("counts.renders") == 3
    chip_scene.eval("textures[0].onChange(); tick();")
    assert chip_scene.eval("counts.renders") == 4


def test_chip_disposal_releases_shared_resources_once(chip_scene):
    chip_scene.eval(
        "const scene = initChip3DScene(container()); observers[0].show(true); tick();"
    )
    chip_scene.eval("scene.dispose(); scene.dispose();")
    counts = json.loads(chip_scene.eval("JSON.stringify(counts)"))
    assert counts["renderers"] == 1
    assert counts["controls"] == 1
    assert counts["geometries"] == 1
    assert counts["materials"] == 2
    assert counts["textures"] == 1
    assert counts["contexts"] == 1
    assert chip_scene.eval("observers[0].disconnected")
    assert chip_scene.eval("frames.size") == 0
    chip_scene.eval(
        "textures[0].onChange(); window.fire('resize'); motion.fire('change'); tick();"
    )
    assert chip_scene.eval("counts.renders") == 1


def test_replacing_chip_texture_disposes_the_previous_texture(chip_scene):
    chip_scene.eval("const scene = initChip3DScene(container(), {autoRotate: false});")
    chip_scene.eval(
        "observers[0].show(true); tick(); scene.updateTexture({partNumber: '8580'}); tick();"
    )
    assert chip_scene.eval("textures[0].disposeCount") == 1
    assert chip_scene.eval("counts.renders") == 2
    chip_scene.eval("scene.dispose();")
    assert chip_scene.eval("textures[0].disposeCount") == 1
    assert chip_scene.eval("textures[1].disposeCount") == 1


def test_nine_decorative_chips_do_not_keep_rendering_offscreen(chip_scene):
    chip_scene.eval(
        """motion.matches = true;
        const scenes = Array.from({length: 9}, () => initChip3DScene(container()));
        for (let i = 0; i < 60; i++) tick();"""
    )
    assert chip_scene.eval("counts.renders") == 0
    assert chip_scene.eval("frames.size") == 0
    chip_scene.eval(
        """observers.forEach(observer => observer.show(true));
        for (let i = 0; i < 60; i++) tick();"""
    )
    assert chip_scene.eval("counts.renders") == 9
    assert chip_scene.eval("frames.size") == 0


@pytest.mark.parametrize("logo_result", ["loaded", "failed", "text"])
def test_chip_texture_notifies_static_scenes_when_ready(logo_result):
    ctx = MiniRacer()
    ctx.eval(
        """
        const LOGO_IMAGE = 'fixture-logo';
        const images = [];
        let redraws = 0, ready = false;
        const document = {
            createElement: () => ({
                getContext: () => ({fillRect() {}, fillText() {}, drawImage() {}})
            })
        };
        const THREE = {CanvasTexture: class { constructor() { this.userData = {}; } }};
        class Image {
            constructor() { this.width = 128; this.height = 64; images.push(this); }
        }
        """
    )
    source = (JS / "chip3d.js").read_text(encoding="utf-8")
    ctx.eval(js_function(source, "createChipTexture"))
    logo = "CSG" if logo_result == "text" else "MOS"
    ctx.eval(
        f"const texture = createChipTexture({{logo: '{logo}'}}, () => redraws++);"
        "texture.userData.ready.then(() => { ready = true; });"
    )
    if logo_result != "text":
        assert ctx.eval("ready") is False
        assert ctx.eval("redraws") == 1
        ctx.eval(
            "images[0]." + ("onload" if logo_result == "loaded" else "onerror") + "();"
        )
    assert ctx.eval("ready") is True
    assert ctx.eval("redraws") == 2


def test_complete_chip_module_compiles():
    source = (JS / "chip3d.js").read_text(encoding="utf-8")
    source = re.sub(r"^import .*\n", "", source, flags=re.MULTILINE)
    source = re.sub(r"\bexport (?=(?:async )?function|const)", "", source)
    source = source.replace("export default {", "const chipExports = {")
    ctx = MiniRacer()
    ctx.eval(source)
    assert ctx.eval("Object.keys(chipExports).length") == 6
