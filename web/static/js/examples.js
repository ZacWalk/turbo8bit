//
// @fileoverview Sample program picker shared by the BASIC and Assembly pages.
// @module examples
//
// Both /basic and /assembly ship an index.json of the form
//   { "examples": [ { "id", "title", "category", "file", ... } ] }
// alongside the source files themselves. This module turns that index into a
// grouped <select> and loads the source on demand.
//
// @see https://www.turbo8bit.com/
//

export class ExampleLibrary {
    //
    // @param {string} indexUrl - URL of the index.json describing the examples
    // @param {string} baseUrl - Directory the example `file` names are relative to
    //
    constructor(indexUrl, baseUrl) {
        this.indexUrl = indexUrl;
        this.baseUrl = baseUrl;
        this.byId = new Map();
    }

    //
    // Fetch the index and fill `select` with one <optgroup> per category.
    // @param {HTMLSelectElement} select
    //
    async populate(select) {
        const response = await fetch(this.indexUrl);
        if (!response.ok) {
            throw new Error(`Example index ${this.indexUrl}: HTTP ${response.status}`);
        }
        const { examples } = await response.json();

        const groups = new Map();
        for (const example of examples) {
            this.byId.set(example.id, example);
            if (!groups.has(example.category)) {
                groups.set(example.category, []);
            }
            groups.get(example.category).push(example);
        }

        const fragment = document.createDocumentFragment();
        for (const [category, items] of groups) {
            const optgroup = document.createElement('optgroup');
            optgroup.label = category;
            for (const example of items) {
                const option = document.createElement('option');
                option.value = example.id;
                option.textContent = example.title;
                optgroup.appendChild(option);
            }
            fragment.appendChild(optgroup);
        }
        select.replaceChildren(fragment);
    }

    //
    // @returns {Object|undefined} The metadata entry for an example id
    //
    get(id) {
        return this.byId.get(id);
    }

    //
    // @returns {Promise<string>} The example's source text, or '' if unknown
    //
    async source(id) {
        const example = this.byId.get(id);
        if (!example) return '';
        const response = await fetch(this.baseUrl + example.file);
        if (!response.ok) {
            throw new Error(`Example '${id}': HTTP ${response.status}`);
        }
        return response.text();
    }
}
