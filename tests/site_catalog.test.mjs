import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

function createElement() {
    const classes = new Set();
    const attributes = new Map();
    return {
        addEventListener() {},
        classList: {
            add: (...values) => values.forEach((value) => classes.add(value)),
            contains: (value) => classes.has(value),
            remove: (...values) => values.forEach((value) => classes.delete(value)),
            toggle(value, force) {
                const shouldAdd = force ?? !classes.has(value);
                if (shouldAdd) classes.add(value);
                else classes.delete(value);
                return shouldAdd;
            },
        },
        dataset: {},
        getAttribute: (name) => attributes.get(name) ?? null,
        hidden: false,
        href: "",
        innerHTML: "",
        removeAttribute: (name) => attributes.delete(name),
        setAttribute: (name, value) => attributes.set(name, String(value)),
        src: "",
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
        addEventListener() {},
        body: createElement(),
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

test("renders product photos as lightbox buttons", () => {
    const { context } = loadApp();

    const html = context.renderProductCard({
        id: "010001",
        name: "DD РњРѕР»РѕРєРѕ",
        unit: "С€С‚",
        price: 899,
        image: "https://cdn.example.com/products/010001.webp",
    });

    assert.match(html, /class="product-image-btn"/);
    assert.match(html, /data-image="https:\/\/cdn\.example\.com\/products\/010001\.webp"/);
    assert.match(html, /class="product-image"/);
});

test("uses local barcode photo fallback when sheet image is empty", () => {
    const { context } = loadApp();

    const product = {
        id: "010001",
        barcode: "2000000177625",
        name: "DD product",
        unit: "шт",
        category0: "ОВОЩИ/ФРУКТЫ",
        category1: "ОВОЩИ",
        price: 899,
        image: "",
    };
    const html = context.renderProductCard(product);
    const expectedJpg = context.localProductImageUrl(product, "jpg");
    const expectedWebp = context.localProductImageUrl(product, "webp");
    const expectedPng = context.localProductImageUrl(product, "png");
    const expectedJpeg = context.localProductImageUrl(product, "jpeg");

    assert.match(html, /class="product-image-btn"/);
    assert.equal(expectedJpg, "products/%D0%9E%D0%92%D0%9E%D0%A9%D0%98-%D0%A4%D0%A0%D0%A3%D0%9A%D0%A2%D0%AB/%D0%9E%D0%92%D0%9E%D0%A9%D0%98/2000000177625.jpg");
    assert.ok(html.includes(`data-image="${expectedJpg}"`));
    assert.ok(html.includes(`data-fallbacks="${expectedWebp}|${expectedPng}|${expectedJpeg}"`));
    assert.ok(html.includes(`src="${expectedJpg}"`));
});

test("product thumbnails fit inside media frame without cropping", () => {
    const css = readFileSync(new URL("../style.css", import.meta.url), "utf8");
    const productImageRule = css.match(/\.product-image\s*\{[^}]+\}/)?.[0] ?? "";

    assert.match(productImageRule, /object-fit:\s*contain;/);
});

test("opens and closes the photo lightbox", () => {
    const { context, elements } = loadApp();
    const lightbox = elements.get("#photo-lightbox");
    const image = elements.get("#photo-lightbox-image");

    context.openPhotoLightbox("https://cdn.example.com/products/010001.webp", "DD РњРѕР»РѕРєРѕ");

    assert.equal(lightbox.hidden, false);
    assert.equal(lightbox.getAttribute("aria-hidden"), "false");
    assert.equal(image.src, "https://cdn.example.com/products/010001.webp");
    assert.equal(image.alt, "DD РњРѕР»РѕРєРѕ");
    assert.equal(context.document.body.classList.contains("lightbox-open"), true);

    context.closePhotoLightbox();

    assert.equal(lightbox.hidden, true);
    assert.equal(lightbox.getAttribute("aria-hidden"), "true");
    assert.equal(image.src, "");
    assert.equal(context.document.body.classList.contains("lightbox-open"), false);
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

test("normalizes promo rows by slot and keeps title or subtitle only rows", () => {
    const { context } = loadApp();

    const promos = context.normalizePromos([
        { slot: "3", title: "30% кешбэк", subtitle: "" },
        { slot: "1", title: "Прямые поставки", subtitle: "Без посредников в РК" },
        { slot: "2", title: "", subtitle: "Бесплатная" },
        { slot: "4", title: "", subtitle: "" },
    ]);

    assert.equal(JSON.stringify(promos), JSON.stringify([
        { slot: 1, title: "Прямые поставки", subtitle: "Без посредников в РК" },
        { slot: 2, title: "", subtitle: "Бесплатная" },
        { slot: 3, title: "30% кешбэк", subtitle: "" },
    ]));
});

test("renders notice promos with only present title and subtitle values", () => {
    const { context, elements } = loadApp();

    context.renderNoticePromos([
        { slot: 1, title: "Прямые поставки", subtitle: "Без посредников в РК" },
        { slot: 2, title: "", subtitle: "Бесплатная" },
        { slot: 3, title: "30% кешбэк", subtitle: "" },
    ]);

    const html = elements.get("#notice-panel").innerHTML;
    assert.match(html, /<strong>Прямые поставки<\/strong><span>Без посредников в РК<\/span>/);
    assert.match(html, /<p><span>Бесплатная<\/span><\/p>/);
    assert.match(html, /<p><strong>30% кешбэк<\/strong><\/p>/);
});

test("keeps settings rows out of notice promos", () => {
    const { context } = loadApp();

    const promos = context.normalizePromos([
        { slot: "1", title: "Promo one", subtitle: "Sub one" },
        { slot: "phone", title: "77785252162", subtitle: "" },
        { slot: "brand_tagline", title: "Fresh test tagline", subtitle: "" },
        { slot: "2", title: "Promo two", subtitle: "Sub two" },
    ]);

    assert.equal(JSON.stringify(promos), JSON.stringify([
        { slot: 1, title: "Promo one", subtitle: "Sub one" },
        { slot: 2, title: "Promo two", subtitle: "Sub two" },
    ]));
});

test("applies brand tagline from site settings rows", () => {
    const { context, elements } = loadApp();

    context.applySiteConfigRows([
        { slot: "1", title: "Promo", subtitle: "Sub" },
        { slot: "brand_tagline", title: "Fresh test tagline", subtitle: "" },
    ]);

    assert.equal(elements.get(".brand-tagline").textContent, "Fresh test tagline");
});

test("applies phone from site settings without changing order text", () => {
    const { context, elements } = loadApp();

    context.setProducts([
        {
            id: "010001",
            publish: "yes",
            barcode: "2000000177625",
            name: "Test Product",
            unit: "pc",
            category0: "Catalog",
            category1: "Category",
            availability: "in stock",
            price: "100",
        },
    ]);
    context.applySiteConfigRows([
        { slot: "phone", title: "+7 (701) 555-44-33", subtitle: "" },
    ]);
    context.changeCartItemQuantity("010001", "plus");
    context.renderCart();

    const href = elements.get("#whatsapp-btn").href;
    const url = new URL(href);

    assert.equal(url.origin + url.pathname, "https://wa.me/77015554433");
    assert.match(url.searchParams.get("text"), /Test Product - 1/);
    assert.match(url.searchParams.get("text"), /100/);
});
