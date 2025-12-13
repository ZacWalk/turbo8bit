//
// @fileoverview Code Editor - Syntax-highlighted editor for C64 BASIC and Assembly
// @module emulator/editor
//
// This module provides a code editor component for C64 programs:
// - Syntax highlighting for BASIC and 6502 assembly
// - Real-time syntax error highlighting
// - Line numbers with error indicators
// - Monospace font with retro styling
// - Direct loading into C64 emulator memory
// - Copy/paste and standard editing features
//
// @see https://www.turbo8bit.com/
//

import {
    BASICTokenizer,
    highlightBasic,
    highlightAssembly,
    TokenType,
    BASIC_START
} from './basic-tokenizer.js';

// ============================================================================
// CODE EDITOR CLASS
// ============================================================================

//
// CodeEditor - A syntax-highlighted code editor for C64 BASIC and Assembly
//
export class CodeEditor {
    //
    // Create a code editor
    // @param {HTMLElement|string} container - Container element or selector
    // @param {Object} options - Configuration options
    //
    constructor(container, options = {}) {
        this.container = typeof container === 'string'
            ? document.querySelector(container)
            : container;

        if (!this.container) {
            throw new Error('CodeEditor: Container element not found');
        }

        this.options = {
            language: options.language || 'basic', // 'basic' or 'asm'
            theme: options.theme || 'c64',
            tabSize: options.tabSize || 2,
            fontSize: options.fontSize || 14,
            lineNumbers: options.lineNumbers !== false,
            highlightErrors: options.highlightErrors !== false,
            onLoad: options.onLoad || null,
            onChange: options.onChange || null,
            ...options
        };

        this.tokenizer = new BASICTokenizer();
        this.errors = [];
        this.value = '';

        this.init();
    }

    //
    // Initialize the editor UI
    // @private
    //
    init() {
        // Create editor structure
        this.container.classList.add('basic-editor');

        // Determine button layout based on language
        const isAsm = this.options.language === 'asm';
        const toolbarButtons = isAsm ? `
            <button class="editor-btn run-btn" title="Assemble and Run">
                <span class="btn-icon">▶</span> Run
            </button>
            <button class="editor-btn step-btn" title="Step one instruction">
                <span class="btn-icon">⏭</span> Step
            </button>
            <button class="editor-btn stop-btn" title="Stop execution">
                <span class="btn-icon">⏹</span> Stop
            </button>
        ` : `
            <button class="editor-btn load-btn" title="Load and Run">
                <span class="btn-icon">▶</span> Run
            </button>
        `;

        this.container.innerHTML = `
            <div class="editor-toolbar">
                <div class="toolbar-left">
                    <div class="search-container">
                        <input type="text" class="search-input" placeholder="Search..." title="F3 to search, Ctrl+F3 to search selection">
                        <button class="search-btn" title="Find next (F3)">🔍</button>
                    </div>
                </div>
                <div class="toolbar-right">
                    ${toolbarButtons}
                </div>
            </div>
            <div class="editor-container">
                <div class="line-numbers"></div>
                <div class="editor-wrapper">
                    <textarea class="editor-textarea" spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="off"></textarea>
                    <div class="editor-highlight"></div>
                </div>
            </div>
            <div class="editor-status">
                <span class="status-text">Ready</span>
                <span class="error-count"></span>
            </div>
        `;

        // Track highlighted line for debugging
        this.highlightedLine = null;

        // Search state
        this.searchText = '';

        // Get references to elements
        this.textarea = this.container.querySelector('.editor-textarea');
        this.highlight = this.container.querySelector('.editor-highlight');
        this.lineNumbers = this.container.querySelector('.line-numbers');
        this.statusText = this.container.querySelector('.status-text');
        this.errorCount = this.container.querySelector('.error-count');
        this.editorContainer = this.container.querySelector('.editor-container');

        // Button references (may be null depending on mode)
        this.loadBtn = this.container.querySelector('.load-btn');
        this.runBtn = this.container.querySelector('.run-btn');
        this.stepBtn = this.container.querySelector('.step-btn');
        this.stopBtn = this.container.querySelector('.stop-btn');

        // Search elements
        this.searchInput = this.container.querySelector('.search-input');
        this.searchBtn = this.container.querySelector('.search-btn');

        // Bind events
        this.bindEvents();

        // Set font size
        this.setFontSize(this.options.fontSize);

        // Initial update
        this.updateHighlight();
        this.updateLineNumbers();
    }

    //
    // Bind event handlers
    // @private
    //
    bindEvents() {
        // Text input handling
        this.textarea.addEventListener('input', () => {
            this.value = this.textarea.value;
            this.updateHighlight();
            this.updateLineNumbers();
            this.validateCode();
            if (this.options.onChange) {
                this.options.onChange(this.value);
            }
        });

        // Sync scroll between textarea and highlight
        this.textarea.addEventListener('scroll', () => {
            this.highlight.scrollTop = this.textarea.scrollTop;
            this.highlight.scrollLeft = this.textarea.scrollLeft;
            this.lineNumbers.scrollTop = this.textarea.scrollTop;
        });

        // Focus handling for highlighted border
        this.textarea.addEventListener('focus', () => {
            this.editorContainer.classList.add('focused');
        });

        this.textarea.addEventListener('blur', () => {
            this.editorContainer.classList.remove('focused');
        });

        // Handle tab key and search shortcuts
        this.textarea.addEventListener('keydown', (e) => {
            if (e.key === 'Tab') {
                e.preventDefault();
                this.insertText(' '.repeat(this.options.tabSize));
            }
            // Ctrl+F3: Search for selected text
            if (e.key === 'F3' && e.ctrlKey) {
                e.preventDefault();
                const selection = this.getSelectedText();
                if (selection) {
                    this.searchInput.value = selection;
                    this.searchText = selection;
                    this.findNext();
                }
            }
            // F3: Find next
            else if (e.key === 'F3') {
                e.preventDefault();
                if (this.searchInput.value) {
                    this.searchText = this.searchInput.value;
                    this.findNext();
                } else {
                    this.searchInput.focus();
                }
            }
        });

        // Search input handling
        this.searchInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === 'F3') {
                e.preventDefault();
                this.searchText = this.searchInput.value;
                this.findNext();
            }
            if (e.key === 'Escape') {
                this.textarea.focus();
            }
        });

        // Search button
        this.searchBtn.addEventListener('click', () => {
            this.searchText = this.searchInput.value;
            this.findNext();
        });

        // Load button (BASIC mode)
        if (this.loadBtn) {
            this.loadBtn.addEventListener('click', () => {
                if (this.options.onLoad) {
                    const result = this.tokenize();
                    this.options.onLoad(result);
                }
            });
        }

        // Run button (ASM mode)
        if (this.runBtn) {
            this.runBtn.addEventListener('click', () => {
                if (this.options.onRun) {
                    this.options.onRun();
                }
            });
        }

        // Step button (ASM mode)
        if (this.stepBtn) {
            this.stepBtn.addEventListener('click', () => {
                if (this.options.onStep) {
                    this.options.onStep();
                }
            });
        }

        // Stop button (ASM mode)
        if (this.stopBtn) {
            this.stopBtn.addEventListener('click', () => {
                if (this.options.onStop) {
                    this.options.onStop();
                }
            });
        }

        // Handle paste (normalize line endings)
        this.textarea.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = (e.clipboardData || window.clipboardData).getData('text');
            const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
            this.insertText(normalized);
        });
    }

    //
    // Get currently selected text
    // @returns {string} Selected text or empty string
    //
    getSelectedText() {
        const start = this.textarea.selectionStart;
        const end = this.textarea.selectionEnd;
        return this.textarea.value.substring(start, end);
    }

    //
    // Find next occurrence of search text
    //
    findNext() {
        if (!this.searchText) {
            return;
        }

        const text = this.textarea.value.toLowerCase();
        const search = this.searchText.toLowerCase();
        const cursorPos = this.textarea.selectionEnd;

        // Search from cursor position
        let index = text.indexOf(search, cursorPos);

        // Wrap around to beginning if not found
        if (index === -1) {
            index = text.indexOf(search);
        }

        if (index !== -1) {
            this.textarea.focus();
            this.textarea.setSelectionRange(index, index + this.searchText.length);
            // Scroll the selection into view
            // Calculate line number and scroll
            const linesBefore = this.textarea.value.substring(0, index).split('\n');
            const lineNum = linesBefore.length;
            this.scrollToLine(lineNum);
        } else {
            this.statusText.textContent = `"${this.searchText}" not found`;
        }
    }

    //
    // Scroll editor to show a specific line
    // @param {number} lineNum - 1-based line number
    //
    scrollToLine(lineNum) {
        const lineHeight = parseInt(getComputedStyle(this.textarea).lineHeight) || 20;
        const targetScroll = (lineNum - 3) * lineHeight;  // Show some context above
        this.textarea.scrollTop = Math.max(0, targetScroll);
        this.highlight.scrollTop = this.textarea.scrollTop;
        this.lineNumbers.scrollTop = this.textarea.scrollTop;
    }

    //
    // Highlight a specific line in the editor (for debugging)
    // @param {number|null} lineNum - 1-based line number, or null to clear
    //
    highlightLine(lineNum) {
        this.highlightedLine = lineNum;
        this.updateLineNumbers();

        if (lineNum !== null) {
            this.scrollToLine(lineNum);
        }
    }

    //
    // Clear the debug line highlight
    //
    clearHighlight() {
        this.highlightedLine = null;
        this.updateLineNumbers();
    }

    //
    // Insert text at cursor position
    // @param {string} text - Text to insert
    //
    insertText(text) {
        const start = this.textarea.selectionStart;
        const end = this.textarea.selectionEnd;
        const before = this.textarea.value.substring(0, start);
        const after = this.textarea.value.substring(end);

        this.textarea.value = before + text + after;
        this.textarea.selectionStart = this.textarea.selectionEnd = start + text.length;

        this.value = this.textarea.value;
        this.updateHighlight();
        this.updateLineNumbers();
        this.validateCode();

        if (this.options.onChange) {
            this.options.onChange(this.value);
        }
    }

    //
    // Update the syntax highlighting overlay
    // @private
    //
    updateHighlight() {
        const source = this.textarea.value;

        // Get highlighted tokens
        const tokens = this.options.language === 'asm'
            ? highlightAssembly(source)
            : highlightBasic(source);

        // Build HTML from tokens
        let html = '';
        for (const token of tokens) {
            const escaped = this.escapeHtml(token.text);
            if (token.type === TokenType.DEFAULT || token.text === '\n') {
                html += escaped;
            } else {
                html += `<span class="token-${token.type}">${escaped}</span>`;
            }
        }

        // Add trailing newline to match textarea behavior
        if (!html.endsWith('\n')) {
            html += '\n';
        }

        this.highlight.innerHTML = html;
    }

    //
    // Update line numbers
    // @private
    //
    updateLineNumbers() {
        if (!this.options.lineNumbers) {
            this.lineNumbers.style.display = 'none';
            return;
        }

        const lines = this.textarea.value.split('\n');
        const errorLines = new Set(this.errors.map(e => e.line));

        let html = '';
        for (let i = 1; i <= lines.length; i++) {
            const hasError = errorLines.has(i);
            const isHighlighted = this.highlightedLine === i;
            let cls = 'line-number';
            if (hasError) cls += ' error';
            if (isHighlighted) cls += ' debug-highlight';
            html += `<div class="${cls}">${i}</div>`;
        }

        this.lineNumbers.innerHTML = html;
    }

    //
    // Validate the code and update error markers
    // @private
    //
    validateCode() {
        if (this.options.language !== 'basic' || !this.options.highlightErrors) {
            this.errors = [];
            this.updateStatus();
            return;
        }

        this.errors = this.tokenizer.validate(this.textarea.value);
        this.updateLineNumbers();
        this.updateStatus();
    }

    //
    // Update status bar
    // @private
    //
    updateStatus() {
        const lines = this.textarea.value.split('\n').length;
        const chars = this.textarea.value.length;

        if (this.errors.length === 0) {
            this.statusText.textContent = `${lines} line${lines !== 1 ? 's' : ''}, ${chars} characters`;
            this.errorCount.textContent = '';
            this.errorCount.className = 'error-count';
        } else {
            const errorCount = this.errors.filter(e => e.type === 'error').length;
            const warnCount = this.errors.filter(e => e.type === 'warning').length;

            this.statusText.textContent = this.errors[0].message;

            let countText = '';
            if (errorCount > 0) countText += `${errorCount} error${errorCount !== 1 ? 's' : ''}`;
            if (warnCount > 0) {
                if (countText) countText += ', ';
                countText += `${warnCount} warning${warnCount !== 1 ? 's' : ''}`;
            }
            this.errorCount.textContent = countText;
            this.errorCount.className = 'error-count ' + (errorCount > 0 ? 'has-errors' : 'has-warnings');
        }
    }

    //
    // Escape HTML special characters
    // @private
    //
    escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    //
    // Set the editor value
    // @param {string} text - The text to set
    //
    setValue(text) {
        this.textarea.value = text;
        this.value = text;
        this.updateHighlight();
        this.updateLineNumbers();
        this.validateCode();

        if (this.options.onChange) {
            this.options.onChange(this.value);
        }
    }

    //
    // Get the editor value
    // @returns {string} The current text
    //
    getValue() {
        return this.textarea.value;
    }

    //
    // Tokenize the current program
    // @returns {{ bytes: Uint8Array, errors: Array, lines: Array }}
    //
    tokenize() {
        return this.tokenizer.tokenize(this.textarea.value, BASIC_START);
    }

    //
    // Get current errors
    // @returns {Array} Array of error objects
    //
    getErrors() {
        return this.errors;
    }

    //
    // Set the font size
    // @param {number} size - Font size in pixels
    //
    setFontSize(size) {
        this.options.fontSize = size;
        this.textarea.style.fontSize = `${size}px`;
        this.highlight.style.fontSize = `${size}px`;
        this.lineNumbers.style.fontSize = `${size}px`;

        // Line height should be approximately 1.4x font size
        const lineHeight = Math.round(size * 1.4);
        this.textarea.style.lineHeight = `${lineHeight}px`;
        this.highlight.style.lineHeight = `${lineHeight}px`;
        this.lineNumbers.style.lineHeight = `${lineHeight}px`;
    }

    //
    // Set the language mode
    // @param {string} lang - 'basic' or 'asm'
    //
    setLanguage(lang) {
        this.options.language = lang;
        this.updateHighlight();
        this.validateCode();
    }

    //
    // Focus the editor
    //
    focus() {
        this.textarea.focus();
    }

    //
    // Set the onLoad callback
    // @param {Function} callback - Called when Load button is clicked
    //
    setOnLoad(callback) {
        this.options.onLoad = callback;
    }

    //
    // Set the onRun callback (ASM mode)
    // @param {Function} callback - Called when Run button is clicked
    //
    setOnRun(callback) {
        this.options.onRun = callback;
    }

    //
    // Set the onStep callback (ASM mode)
    // @param {Function} callback - Called when Step button is clicked
    //
    setOnStep(callback) {
        this.options.onStep = callback;
    }

    //
    // Set the onStop callback (ASM mode)
    // @param {Function} callback - Called when Stop button is clicked
    //
    setOnStop(callback) {
        this.options.onStop = callback;
    }

    //
    // Enable or disable error highlighting
    // @param {boolean} enabled - Whether to show errors
    //
    setHighlightErrors(enabled) {
        this.options.highlightErrors = enabled;
        this.validateCode();
        this.updateLineNumbers();
    }
}

// Backwards compatibility alias
export const BASICEditor = CodeEditor;

export default CodeEditor;
