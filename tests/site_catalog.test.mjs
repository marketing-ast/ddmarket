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

    return { context, elements, localStorageData };
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

test("uses known quantity to hide zero stock and cap a piece item in the cart", () => {
    const { context } = loadApp();

    const products = context.normalizeProducts([
        { id: "010001", publish: "yes", barcode: "2000000177625", name: "In stock", unit: "шт", category0: "Catalog", category1: "Category", availability: "in stock", price: "100", quantity: "2" },
        { id: "010002", publish: "yes", barcode: "2000000177626", name: "Zero stock", unit: "шт", category0: "Catalog", category1: "Category", availability: "in stock", price: "100", quantity: "0" },
        { id: "010003", publish: "yes", barcode: "2000000177627", name: "Unknown stock", unit: "шт", category0: "Catalog", category1: "Category", availability: "in stock", price: "100", quantity: "" },
    ]);

    assert.deepEqual(products.map((product) => product.id), ["010001", "010003"]);
    assert.equal(products[0].quantity, 2);
    assert.equal(products[1].quantity, null);

    context.setProducts(products);
    context.changeCartItemQuantity("010001", "plus");
    context.changeCartItemQuantity("010001", "plus");
    context.changeCartItemQuantity("010001", "plus");

    const [item] = context.getCartItems();
    assert.equal(item.qty, 2);
    assert.match(context.renderProductCard(item), /disabled aria-disabled="true"/);
});

test("uses manual_quantity before the automatic 1C quantity", () => {
    const { context } = loadApp();

    const products = context.normalizeProducts([
        { id: "010001", publish: "yes", barcode: "2000000177625", name: "Manual stock", unit: "шт", category0: "Catalog", category1: "Category", availability: "in stock", price: "100", quantity: "2", manual_quantity: "7" },
        { id: "010002", publish: "yes", barcode: "2000000177626", name: "Manual zero", unit: "шт", category0: "Catalog", category1: "Category", availability: "in stock", price: "100", quantity: "8", manual_quantity: "0" },
        { id: "010003", publish: "yes", barcode: "2000000177627", name: "Automatic stock", unit: "шт", category0: "Catalog", category1: "Category", availability: "in stock", price: "100", quantity: "3", manual_quantity: "" },
    ]);

    assert.deepEqual(products.map((product) => product.id), ["010001", "010003"]);
    assert.equal(products[0].quantity, 7);
    assert.equal(products[1].quantity, 3);
});

test("converts kilogram quantity to 100 gram cart portions", () => {
    const { context } = loadApp();

    context.setProducts([
        { id: "040009", publish: "yes", barcode: "2000000177621", name: "Parsley", unit: "0,1", category0: "Catalog", category1: "Greens", availability: "in stock", price: "312", quantity: "0,3" },
    ]);
    for (let index = 0; index < 4; index += 1) {
        context.changeCartItemQuantity("040009", "plus");
    }

    const [item] = context.getCartItems();
    assert.equal(item.qty, 300);
    assert.equal(context.getAvailableCartQuantity(item), 300);
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

test("uses DD placeholder when sheet image is empty", () => {
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

    assert.doesNotMatch(html, /class="product-image-btn"/);
    assert.doesNotMatch(html, /products\//);
    assert.match(html, /class="product-placeholder"/);
});

test("uses sheet image url as the only product image source", () => {
    const { context } = loadApp();

    const product = {
        id: "150005",
        barcode: "2200009857621",
        name: "DD product",
        unit: "шт",
        category0: "МЯСНОЙ ПРОДУКТ",
        category1: "КУРИЦА",
        price: 3099,
        image: "https://img.ddmarket.kz/items/products/2200009857621.webp?v=old",
    };
    const html = context.renderProductCard(product);

    assert.ok(html.includes(`data-image="https://img.ddmarket.kz/items/products/2200009857621.webp?v=old"`));
    assert.ok(html.includes(`src="https://img.ddmarket.kz/items/products/2200009857621.webp?v=old"`));
    assert.ok(!html.includes("data-fallbacks=\"products/"));
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

test("renders sale as the first global catalog view instead of a subcategory", () => {
    const { context, elements } = loadApp();

    context.setProducts([
        { id: "010001", publish: "yes", barcode: "2000000177625", name: "Огурцы", unit: "кг", category0: "ОВОЩИ/ФРУКТЫ", category1: "ОВОЩИ", availability: "in stock", price: "399", sale: "yes" },
        { id: "240001", publish: "yes", barcode: "2000000177627", name: "Лапша", unit: "шт", category0: "БАКАЛЕЯ", category1: "МАКАРОНЫ/ЛАПША", availability: "in stock", price: "399", sale: "yes" },
        { id: "020001", publish: "yes", barcode: "2000000177626", name: "Яблоко", unit: "кг", category0: "ОВОЩИ/ФРУКТЫ", category1: "ФРУКТЫ", availability: "in stock", price: "599", sale: "no" },
    ]);

    elements.get("#search-input").value = "";
    context.renderCategories();

    const topNavigation = elements.get("#supercategories-bar").innerHTML;
    assert.ok(topNavigation.indexOf("Акции") < topNavigation.indexOf("ОВОЩИ/ФРУКТЫ"));
    assert.doesNotMatch(elements.get("#categories-bar").innerHTML, /Акции/);
    assert.equal(elements.get("#categories-bar").hidden, true);
    assert.deepEqual(context.getFilteredProducts().map((product) => product.id), ["010001", "240001"]);
});

test("ordinary categories show their subcategories and keep sale products in the product list", () => {
    const { context, elements } = loadApp();

    context.setProducts([
        { id: "010001", publish: "yes", barcode: "2000000177625", name: "Огурцы", unit: "кг", category0: "ОВОЩИ/ФРУКТЫ", category1: "ОВОЩИ", availability: "in stock", price: "399", sale: "yes" },
        { id: "010002", publish: "yes", barcode: "2000000177626", name: "Картофель", unit: "кг", category0: "ОВОЩИ/ФРУКТЫ", category1: "ОВОЩИ", availability: "in stock", price: "219", sale: "no" },
        { id: "020001", publish: "yes", barcode: "2000000177627", name: "Яблоко", unit: "кг", category0: "ОВОЩИ/ФРУКТЫ", category1: "ФРУКТЫ", availability: "in stock", price: "599", sale: "no" },
    ]);

    elements.get("#search-input").value = "";
    context.renderCategories();
    context.selectSuperCategory("ОВОЩИ/ФРУКТЫ");

    assert.equal(elements.get("#categories-bar").hidden, false);
    assert.doesNotMatch(elements.get("#categories-bar").innerHTML, /Акции/);
    assert.match(elements.get("#categories-bar").innerHTML, /ОВОЩИ/);
    assert.match(elements.get("#categories-bar").innerHTML, /ФРУКТЫ/);

    const filtered = context.getFilteredProducts();
    assert.deepEqual(filtered.map((product) => product.id), ["010001", "010002"]);
    assert.match(context.renderProductCard(filtered[0]), /sale-pill/);
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

test("treats 0,1 unit as 100 gram portions", () => {
    const { context } = loadApp();

    const [product] = context.normalizeProducts([
        {
            id: "040009",
            publish: "yes",
            barcode: "2000000177621",
            name: "Parsley",
            unit: "0,1",
            category0: "Catalog",
            category1: "Greens",
            availability: "in stock",
            price: "312",
        },
    ]);

    assert.equal(product.quantityStep, 100);
    assert.equal(product.quantityPriceFactor, 0.01);
    const productHtml = context.renderProductCard(product);
    assert.match(productHtml, /312.+\/.+100/s);
    assert.match(productHtml, />весовой</);

    context.setProducts([
        {
            id: "040009",
            publish: "yes",
            barcode: "2000000177621",
            name: "Parsley",
            unit: "0,1",
            category0: "Catalog",
            category1: "Greens",
            availability: "in stock",
            price: "312",
        },
    ]);
    for (let index = 0; index < 5; index += 1) {
        context.changeCartItemQuantity("040009", "plus");
    }

    const items = context.getCartItems();

    assert.equal(items[0].qty, 500);
    assert.equal(context.getCartTotal(items), 1560);
    assert.match(context.buildOrderText(items), /Parsley - 500/);
});

test("ignores stale v6 catalog cache when loading 100 gram units", async () => {
    const { context, localStorageData } = loadApp();
    localStorageData.set("ddmarket_products_v6", JSON.stringify([
        {
            id: "040009",
            publish: true,
            barcode: "2000000177621",
            name: "Parsley",
            unit: "кг",
            category0: "Catalog",
            category1: "Greens",
            availability: "in stock",
            price: 312,
            quantityStep: 0.1,
        },
    ]));
    localStorageData.set("ddmarket_products_ts_v6", String(Date.now()));
    context.fetch = async () => ({
        ok: true,
        text: async () => [
            "id,publish,barcode,name,unit,category0,category1,availability,price",
            "040009,yes,2000000177621,Parsley,\"0,1\",Catalog,Greens,in stock,312",
        ].join("\n"),
    });

    await context.fetchProductsFromSheets();
    const product = context.getCartItems().length;
    const [freshProduct] = context.normalizeProducts(JSON.parse(localStorageData.get("ddmarket_products_v7")));

    assert.equal(product, 0);
    assert.equal(freshProduct.unit, "грамм");
    assert.equal(freshProduct.priceUnit, "100 грамм");
});

test("keeps WhatsApp order hidden until the minimum order amount is reached", () => {
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
            price: "7000",
        },
    ]);
    context.applySiteConfigRows([
        { slot: "min_order_amount", title: "12000", subtitle: "" },
        { slot: "free_delivery_amount", title: "30000", subtitle: "" },
    ]);
    context.changeCartItemQuantity("010001", "plus");
    context.renderCart();

    assert.equal(elements.get("#whatsapp-btn").hidden, true);
    assert.equal(
        elements.get("#cart-order-gate").textContent,
        "Минимальный заказ 12\u00a0000 тг. Добавьте еще 5\u00a0000 тг.",
    );
    assert.equal(
        elements.get("#cart-delivery-progress").textContent,
        "До бесплатной доставки осталось 23\u00a0000 тг.",
    );
});

test("shows WhatsApp order after minimum amount while keeping free delivery progress", () => {
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
            price: "12000",
        },
    ]);
    context.applySiteConfigRows([
        { slot: "min_order_amount", title: "12000", subtitle: "" },
        { slot: "free_delivery_amount", title: "30000", subtitle: "" },
    ]);
    context.changeCartItemQuantity("010001", "plus");
    context.renderCart();

    assert.equal(elements.get("#whatsapp-btn").hidden, false);
    assert.equal(elements.get("#cart-order-gate").hidden, true);
    assert.equal(
        elements.get("#cart-delivery-progress").textContent,
        "До бесплатной доставки осталось 18\u00a0000 тг.",
    );
});

test("shows free delivery confirmation after threshold is reached", () => {
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
            price: "30000",
        },
    ]);
    context.applySiteConfigRows([
        { slot: "min_order_amount", title: "12000", subtitle: "" },
        { slot: "free_delivery_amount", title: "30000", subtitle: "" },
    ]);
    context.changeCartItemQuantity("010001", "plus");
    context.renderCart();

    assert.equal(elements.get("#whatsapp-btn").hidden, false);
    assert.equal(elements.get("#cart-order-gate").hidden, true);
    assert.equal(
        elements.get("#cart-delivery-progress").textContent,
        "Поздравляем, доставка будет бесплатной.",
    );
});
