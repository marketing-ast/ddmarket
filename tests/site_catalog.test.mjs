import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function createElement() {
    return {
        addEventListener() {},
        classList: {
            contains() { return false; },
            toggle() {},
        },
        dataset: {},
        hidden: false,
        href: "",
        innerHTML: "",
        textContent: "",
        value: "",
    };
}

function loadApp() {
    const elements = new Map();
    const getElement = (selector) => {
        if (!elements.has(selector)) elements.set(selector, createElement());
        return elements.get(selector);
    };

    const document = {
        querySelector: getElement,
        querySelectorAll: () => [],
    };

    const localStorageData = new Map();
    const localStorage = {
        getItem: (key) => localStorageData.get(key) ?? null,
        removeItem: (key) => localStorageData.delete(key),
        setItem: (key, value) => localStorageData.set(key, String(value)),
    };

    const context = {
        console,
        document,
        Intl,
        localStorage,
        navigator: { clipboard: { writeText: async () => {} } },
        setInterval: () => 0,
        setTimeout: () => 0,
        window: { confirm: () => true },
    };
    context.globalThis = context;

    const appSource = readFileSync(new URL("../app.js", import.meta.url), "utf8")
        .replace(/\r?\ninit\(\);\s*$/, "");
    vm.runInNewContext(appSource, context, { filename: "app.js" });

    return { context, elements };
}

test("normalizes only published products with barcode, price, and stock", () => {
    const { context } = loadApp();

    const products = context.normalizeProducts([
        {
            id: "010001",
            publish: "yes",
            barcode: "2000000177625",
            name: "Картофель",
            name1s: "DD Картофель вес",
            unit: "кг",
            category0: "ОВОЩИ/ФРУКТЫ",
            category1: "ОВОЩИ",
            availability: "in stock",
            price: "219",
            sale: "no",
        },
        { id: "010002", publish: "no", barcode: "2000000000002", name: "Draft", unit: "шт", category0: "БАКАЛЕЯ", category1: "СНЕКИ", availability: "in stock", price: "100" },
        { id: "010003", publish: "yes", barcode: "", name: "No barcode", unit: "шт", category0: "БАКАЛЕЯ", category1: "СНЕКИ", availability: "in stock", price: "100" },
        { id: "010004", publish: "yes", barcode: "2000000000004", name: "No stock", unit: "шт", category0: "БАКАЛЕЯ", category1: "СНЕКИ", availability: "out of stock", price: "100" },
        { id: "010005", publish: "yes", barcode: "2000000000005", name: "No price", unit: "шт", category0: "БАКАЛЕЯ", category1: "СНЕКИ", availability: "in stock", price: "" },
    ]);

    assert.equal(products.length, 1);
    assert.equal(products[0].id, "010001");
    assert.equal(products[0].barcode, "2000000177625");
    assert.equal(products[0].category0, "ОВОЩИ/ФРУКТЫ");
    assert.equal(products[0].category1, "ОВОЩИ");
    assert.equal(products[0].category, undefined);
    assert.equal(products[0].emoji, undefined);
});

test("renders category0 as top navigation and category1 as subnavigation", () => {
    const { context, elements } = loadApp();

    context.setProducts([
        { id: "010001", publish: "yes", barcode: "2000000177625", name: "Картофель", unit: "кг", category0: "ОВОЩИ/ФРУКТЫ", category1: "ОВОЩИ", availability: "in stock", price: "219" },
        { id: "020001", publish: "yes", barcode: "2000000177626", name: "Яблоко", unit: "кг", category0: "ОВОЩИ/ФРУКТЫ", category1: "ФРУКТЫ", availability: "in stock", price: "599" },
        { id: "240001", publish: "yes", barcode: "2000000177627", name: "Лапша", unit: "шт", category0: "БАКАЛЕЯ", category1: "МАКАРОНЫ/ЛАПША", availability: "in stock", price: "399" },
    ]);

    elements.get("#search-input").value = "";
    context.renderCategories();

    assert.match(elements.get("#supercategories-bar").innerHTML, /ОВОЩИ\/ФРУКТЫ/);
    assert.match(elements.get("#supercategories-bar").innerHTML, /БАКАЛЕЯ/);
    assert.match(elements.get("#categories-bar").innerHTML, /ОВОЩИ/);
    assert.match(elements.get("#categories-bar").innerHTML, /ФРУКТЫ/);
    assert.doesNotMatch(elements.get("#categories-bar").innerHTML, /МАКАРОНЫ\/ЛАПША/);
});

test("search matches barcode, category0, and category1 without category filters", () => {
    const { context, elements } = loadApp();

    context.setProducts([
        { id: "010001", publish: "yes", barcode: "2000000177625", name: "Картофель", unit: "кг", category0: "ОВОЩИ/ФРУКТЫ", category1: "ОВОЩИ", availability: "in stock", price: "219" },
        { id: "240001", publish: "yes", barcode: "74603005212", name: "Samyang лапша", unit: "шт", category0: "БАКАЛЕЯ", category1: "МАКАРОНЫ/ЛАПША", availability: "in stock", price: "1299" },
    ]);

    context.renderCategories();
    elements.get("#search-input").value = "макароны";

    const found = context.getFilteredProducts();

    assert.equal(found.length, 1);
    assert.equal(found[0].id, "240001");
});
