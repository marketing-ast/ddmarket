"use strict";

const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQy0tUi3LVSJ_o7DMI_2OAFxr-651J5wgDJBnL0cNq18YNAltbsgEPwYO0QDp4p00mOrwhY1i3IrT_m/pub?output=csv";
const SITE_PROMOS_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQy0tUi3LVSJ_o7DMI_2OAFxr-651J5wgDJBnL0cNq18YNAltbsgEPwYO0QDp4p00mOrwhY1i3IrT_m/pub?gid=1004&single=true&output=csv";
const FALLBACK_CSV_URL = "data/ddmarket-products.csv";
const WHATSAPP_PHONE = "77785252162";
const CACHE_KEY = "ddmarket_products_v6";
const CACHE_TIME_KEY = "ddmarket_products_ts_v6";
const CART_KEY = "ddmarket_cart_v3";
const ACTIVE_SCREEN_KEY = "ddmarket_active_screen";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const CART_TTL_MS = 24 * 60 * 60 * 1000;
const UNIT_KG = "кг";
const UNIT_PC = "шт";
const FALLBACK_CATEGORY0 = "Продукты";
const FALLBACK_CATEGORY1 = "Другое";
const CATEGORY0_ORDER = [
    "ОВОЩИ/ФРУКТЫ",
    "ГОТОВИМ САМИ",
    "МЯСО",
    "МЯСНОЙ ПРОДУКТ",
    "МОЛОКО/ЯЙЦО",
    "БАКАЛЕЯ",
    "ХЛЕБ/КОНДИТЕРКА",
    "ВОДА/НАПИТКИ",
    "ХИМИЯ/ПРОМ",
];
const CATEGORY1_ORDER = [
    "ОВОЩИ",
    "ФРУКТЫ",
    "ЯГОДЫ",
    "ЗЕЛЕНЬ",
    "СУХОФРУКТЫ",
    "ТАНДЫР",
    "ГРИЛЬ",
    "ВЫПЕЧКА",
    "ПРОЧЕЕ",
    "ГОВЯДИНА",
    "КОНИНА",
    "БАРАНИНА",
    "DD BOX",
    "КОЛБАСА",
    "КУРИЦА",
    "РЫБА",
    "МОЛОКО/КЕФИР",
    "СМЕТАНА/СЫР",
    "ТВОРОГ/ЙОГУРТ",
    "МАСЛО/МАРГАРИН",
    "МАЙОНЕЗ/КЕТЧУП",
    "ЯЙЦО",
    "КРУПЫ/ХЛОПЬЯ",
    "МАКАРОНЫ/ЛАПША",
    "МУКА/МАСЛО",
    "СНЕКИ",
    "ЧАЙ/КОФЕ/МЕД",
    "КОНСЕРВЫ/ВАРЕНЬЕ",
    "ДЕТСКОЕ ПИТАНИЕ",
    "ПП ПРОДУКТ",
    "СПЕЦИИ",
    "ПРОЧАЯ БАКАЛЕЯ",
    "ХЛЕБ",
    "ПЕЧЕНЬЕ",
    "СУШКИ",
    "ТОРТЫ",
    "КОНФЕТЫ",
    "ШОКОЛАД",
    "ГАЗИРОВКА",
    "ХОЛОДНЫЙ ЧАЙ",
    "СОКИ",
    "МИН.ВОДА",
    "ЭНЕРГЕТИКИ",
    "УХОД ЗА СОБОЙ",
    "УХОД ЗА ОДЕЖДОЙ",
    "САЛФЕТКИ/БУМАГА",
    "ПРОЧАЯ ХИМИЯ",
    "ПРОМ ТОВАРЫ",
];

const priceFormatter = new Intl.NumberFormat("ru-KZ", {
    maximumFractionDigits: 0,
});

let products = [];
let productsById = new Map(products.map((item) => [item.id, item]));
let cart = {};
let activeSuperCategory = null;
let activeCategory = null;
let refreshInProgress = false;

const $ = (selector) => document.querySelector(selector);
const els = {
    productsList: $("#products-list"),
    noticePanel: $("#notice-panel"),
    emptyState: $("#empty-state"),
    searchInput: $("#search-input"),
    supercategoriesBar: $("#supercategories-bar"),
    categoriesBar: $("#categories-bar"),
    lastUpdate: $("#last-update"),
    cartItems: $("#cart-items"),
    cartEmpty: $("#cart-empty"),
    cartSummary: $("#cart-summary"),
    cartText: $("#cart-text"),
    cartTotalPrice: $("#cart-total-price"),
    cartBadge: $("#cart-badge"),
    whatsappBtn: $("#whatsapp-btn"),
    copyCartBtn: $("#copy-cart-btn"),
    clearCartBtn: $("#clear-cart-btn"),
    photoLightbox: $("#photo-lightbox"),
    photoLightboxImage: $("#photo-lightbox-image"),
    photoLightboxClose: $("#photo-lightbox-close"),
};

function setProducts(nextProducts) {
    products = normalizeProducts(nextProducts);
    productsById = new Map(products.map((item) => [item.id, item]));
}

function normalizeProducts(rawProducts) {
    return rawProducts
        .map((item, index) => {
            const id = normalizeProductId(item.id, index);
            const unitInfo = normalizeUnitInfo(item.unit);
            const name = cleanText(item.name);
            const barcode = cleanText(item.barcode);
            const category1 = cleanText(item.category1) || cleanText(item.category) || FALLBACK_CATEGORY1;
            const category0 = cleanText(item.category0) || getCategory0FromLegacyCategory(category1);
            return {
                id,
                publish: parsePublishValue(item.publish),
                barcode,
                name,
                name1s: cleanText(item.name1s),
                unit: unitInfo.unit,
                category0,
                category1,
                availability: item.availability,
                price: parsePrice(item.price),
                sale: parseSaleValue(item.sale),
                image: normalizeImageUrl(item.image),
                quantityStep: unitInfo.quantityStep,
            };
        })
        .filter((item) => (
            item.publish
            && item.barcode
            && item.name
            && item.price > 0
            && parseAvailabilityValue(item.availability)
        ));
}

function cleanText(value) {
    return String(value ?? "").trim();
}

function normalizeProductId(value, index) {
    const raw = cleanText(value).replace(/^'/, "");
    return raw || String(index + 1);
}

function normalizeImageUrl(value) {
    const raw = cleanText(value);
    if (!raw) return "";

    const fileMatch = raw.match(/drive\.google\.com\/file\/d\/([^/]+)/);
    if (fileMatch) {
        return `https://drive.google.com/thumbnail?id=${fileMatch[1]}&sz=w900`;
    }

    const openMatch = raw.match(/[?&]id=([^&]+)/);
    if (raw.includes("drive.google.com") && openMatch) {
        return `https://drive.google.com/thumbnail?id=${openMatch[1]}&sz=w900`;
    }

    return raw;
}

function localProductPathSegment(value) {
    const segment = cleanText(value)
        .replace(/[<>:"/\\|?*\u0000-\u001F]+/g, "-")
        .replace(/\s+/g, " ")
        .replace(/^[.\s]+|[.\s]+$/g, "");
    return segment || "_Без категории";
}

function localProductImageUrl(product, extension = "jpg") {
    const barcode = cleanText(product?.barcode).replace(/[^\dA-Za-z_-]/g, "");
    if (!barcode) return "";
    const category0 = localProductPathSegment(product?.category0);
    const category1 = localProductPathSegment(product?.category1);
    const safeExtension = cleanText(extension).replace(/[^a-z0-9]/gi, "") || "jpg";
    return ["products", category0, category1, `${barcode}.${safeExtension}`]
        .map((segment) => encodeURIComponent(segment))
        .join("/");
}

function productImageCandidates(product) {
    const explicitImage = cleanText(product?.image);
    if (explicitImage) return [explicitImage];
    const primary = localProductImageUrl(product, "jpg");
    if (!primary) return [];
    return [
        primary,
        localProductImageUrl(product, "webp"),
        localProductImageUrl(product, "png"),
        localProductImageUrl(product, "jpeg"),
    ];
}

function normalizeUnitInfo(value) {
    const rawUnit = cleanText(value).toLowerCase().replace(",", ".");
    const gramsMatch = rawUnit.match(/(\d+(?:\.\d+)?)\s*(г|g)(?![a-zа-яё])/i);
    if (gramsMatch) {
        const grams = Number.parseFloat(gramsMatch[1]);
        if (Number.isFinite(grams) && grams > 0) {
            return { unit: UNIT_KG, quantityStep: roundQty(grams / 1000) };
        }
    }

    const numericUnit = Number.parseFloat(rawUnit);
    if (Number.isFinite(numericUnit) && numericUnit > 0) {
        return { unit: UNIT_KG, quantityStep: roundQty(numericUnit) };
    }

    if (rawUnit.includes("кг") || rawUnit.includes("kg")) {
        return { unit: UNIT_KG, quantityStep: 1 };
    }

    if (rawUnit.includes("шт") || rawUnit.includes("pc") || rawUnit.includes("pcs")) {
        return { unit: UNIT_PC, quantityStep: 1 };
    }

    return { unit: rawUnit || UNIT_PC, quantityStep: 1 };
}

function parsePrice(value) {
    return Number.parseInt(String(value ?? "").replace(/[^\d]/g, ""), 10) || 0;
}

function parseAvailabilityValue(value) {
    const normalized = cleanText(value).toLowerCase();
    if (!normalized) return true;
    return !["out of stock", "unavailable", "нет", "no", "false", "0"].some((marker) => normalized.includes(marker));
}

function parsePublishValue(value) {
    const normalized = cleanText(value).toLowerCase();
    return !["no", "false", "0", "нет", "не публиковать"].includes(normalized);
}

function parseSaleValue(value) {
    const normalized = cleanText(value).toLowerCase();
    return ["yes", "true", "1", "sale", "акция", "акции", "да"].includes(normalized);
}

function parseCSV(csvText) {
    const normalizedText = csvText.replace(/^\uFEFF/, "");
    const lines = normalizedText.trim().split(/\r?\n/).filter(Boolean);
    if (lines.length < 2) return [];

    const headers = parseCSVLine(lines[0]).map((header) => header.trim().toLowerCase());
    return lines.slice(1).map((line) => {
        const columns = parseCSVLine(line);
        return headers.reduce((row, header, index) => {
            row[header] = columns[index] ?? "";
            return row;
        }, {});
    });
}

function parseCSVLine(line) {
    const result = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
        const char = line[i];
        if (char === "\"") {
            if (inQuotes && line[i + 1] === "\"") {
                current += "\"";
                i += 1;
            } else {
                inQuotes = !inQuotes;
            }
            continue;
        }
        if (char === "," && !inQuotes) {
            result.push(current);
            current = "";
            continue;
        }
        current += char;
    }

    result.push(current);
    return result;
}

function normalizePromos(rawPromos) {
    return rawPromos
        .map((item, index) => {
            const slot = Number.parseInt(cleanText(item.slot), 10);
            return {
                slot: Number.isFinite(slot) ? slot : index + 1,
                title: cleanText(item.title),
                subtitle: cleanText(item.subtitle),
            };
        })
        .filter((item) => item.title || item.subtitle)
        .sort((a, b) => a.slot - b.slot)
        .slice(0, 3);
}

function renderNoticePromos(promos) {
    const normalizedPromos = normalizePromos(promos);
    if (normalizedPromos.length === 0) return false;

    els.noticePanel.innerHTML = normalizedPromos.map((promo) => {
        const title = promo.title ? `<strong>${escapeHtml(promo.title)}</strong>` : "";
        const subtitle = promo.subtitle ? `<span>${escapeHtml(promo.subtitle)}</span>` : "";
        return `<p>${title}${subtitle}</p>`;
    }).join("");
    return true;
}

async function fetchPromosFromSheets() {
    try {
        const parsedPromos = await loadPromosFromUrl(SITE_PROMOS_CSV_URL);
        return renderNoticePromos(parsedPromos);
    } catch (error) {
        console.warn("[DD Market] Promo sheet is unavailable.", error);
        return false;
    }
}

async function loadPromosFromUrl(url) {
    const separator = url.includes("?") ? "&" : "?";
    const response = await fetch(`${url}${separator}t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const csvText = await response.text();
    const parsed = normalizePromos(parseCSV(csvText));
    if (parsed.length === 0) throw new Error("Empty promos");
    return parsed;
}

async function fetchProductsFromSheets() {
    if (refreshInProgress) return false;
    refreshInProgress = true;

    try {
        const cachedTime = Number(localStorage.getItem(CACHE_TIME_KEY) || 0);
        const cached = localStorage.getItem(CACHE_KEY);
        if (cached && cachedTime && Date.now() - cachedTime < REFRESH_INTERVAL_MS) {
            setProducts(JSON.parse(cached));
            updateLastUpdateDisplay(cachedTime);
            return true;
        }
    } catch {
        // Continue with live fetch when localStorage is unavailable.
    }

    try {
        const parsedProducts = await loadCatalogFromUrl(SHEET_CSV_URL);
        setProducts(parsedProducts);
        const now = Date.now();
        try {
            localStorage.setItem(CACHE_KEY, JSON.stringify(products));
            localStorage.setItem(CACHE_TIME_KEY, String(now));
        } catch {
            // Cache is optional.
        }
        updateLastUpdateDisplay(now);
        return true;
    } catch (error) {
        console.warn("[DD Market] Google Sheet is unavailable.", error);
        try {
            const fallbackProducts = await loadCatalogFromUrl(FALLBACK_CSV_URL);
            setProducts(fallbackProducts);
            updateLastUpdateDisplay(Date.now());
            return true;
        } catch (fallbackError) {
            console.warn("[DD Market] Fallback catalog is unavailable.", fallbackError);
            updateLastUpdateDisplay(null);
            return false;
        }
    } finally {
        refreshInProgress = false;
    }
}

async function loadCatalogFromUrl(url) {
    const separator = url.includes("?") ? "&" : "?";
    const response = await fetch(`${url}${separator}t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);

    const csvText = await response.text();
    const parsed = normalizeProducts(parseCSV(csvText));
    if (parsed.length === 0) throw new Error("Empty catalog");
    return parsed;
}

function updateLastUpdateDisplay(timestamp) {
    if (!timestamp) {
        els.lastUpdate.textContent = "Не удалось обновить цены. Проверьте подключение.";
        return;
    }

    const date = new Date(timestamp);
    const time = new Intl.DateTimeFormat("ru-KZ", { hour: "2-digit", minute: "2-digit" }).format(date);
    els.lastUpdate.textContent = `Цены обновлены в ${time}`;
}

function getCategory0FromLegacyCategory(category1) {
    if (["Овощи", "Зелень и салаты", "Фрукты", "Ягоды", "Сухофрукты и орехи"].includes(category1)) {
        return "ОВОЩИ/ФРУКТЫ";
    }
    if (["Бытовая химия", "Бумага и салфетки", "Уход за собой", "Стирка и дом", "Прочая химия"].includes(category1)) {
        return "ХИМИЯ/ПРОМ";
    }
    return FALLBACK_CATEGORY0;
}

function getSuperCategories() {
    const available = new Set(products.map((item) => item.category0));
    const ordered = CATEGORY0_ORDER.filter((category0) => available.has(category0));
    const extra = [...available]
        .filter((category0) => !CATEGORY0_ORDER.includes(category0))
        .sort((a, b) => a.localeCompare(b, "ru"));
    return [...ordered, ...extra];
}

function getCategory1SortIndex(category1) {
    const index = CATEGORY1_ORDER.indexOf(category1);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
}

function getCategoriesForSuperCategory(category0) {
    return [...new Set(
        products
            .filter((item) => item.category0 === category0)
            .map((item) => item.category1)
    )].sort((a, b) => {
        const byOrder = getCategory1SortIndex(a) - getCategory1SortIndex(b);
        return byOrder || a.localeCompare(b, "ru");
    });
}

function renderCategories() {
    const superCategories = getSuperCategories();
    if (!superCategories.includes(activeSuperCategory)) {
        activeSuperCategory = superCategories[0] || null;
    }

    els.supercategoriesBar.innerHTML = superCategories.map((category) => `
        <button class="super-chip${category === activeSuperCategory ? " active" : ""}" type="button" data-super-category="${escapeHtml(category)}">
            ${escapeHtml(category)}
        </button>
    `).join("");

    const scopedProducts = products.filter((item) => item.category0 === activeSuperCategory);
    const hasSale = scopedProducts.some((item) => item.sale);
    const categories = [
        ...(hasSale ? [{ id: "sale", label: "Акции", sale: true }] : []),
        ...getCategoriesForSuperCategory(activeSuperCategory)
            .map((category1) => ({ id: category1, label: category1, sale: false })),
    ];

    if (!categories.some((category) => category.id === activeCategory)) {
        activeCategory = categories[0]?.id || null;
    }

    els.categoriesBar.innerHTML = categories.map((category) => `
        <button class="cat-chip${category.sale ? " sale-chip" : ""}${category.id === activeCategory ? " active" : ""}" type="button" data-category="${escapeHtml(category.id)}">
            ${escapeHtml(category.label)}
        </button>
    `).join("");
}

function getFilteredProducts() {
    const query = cleanText(els.searchInput.value).toLowerCase();
    return products.filter((item) => {
        const matchesSuperCategory = query ? true : item.category0 === activeSuperCategory;
        const matchesCategory = query ? true : activeCategory === "sale" ? item.sale : item.category1 === activeCategory;
        const matchesQuery = !query
            || item.name.toLowerCase().includes(query)
            || item.name1s.toLowerCase().includes(query)
            || item.category0.toLowerCase().includes(query)
            || item.category1.toLowerCase().includes(query)
            || String(item.barcode || "").toLowerCase().includes(query)
            || String(item.id || "").toLowerCase().includes(query);
        return matchesSuperCategory && matchesCategory && matchesQuery;
    });
}

function renderProducts() {
    const filtered = getFilteredProducts();
    els.emptyState.hidden = filtered.length > 0;

    if (filtered.length === 0) {
        els.productsList.innerHTML = "";
        return;
    }

    const query = cleanText(els.searchInput.value);
    const title = query ? "Результаты поиска" : activeCategory === "sale" ? "Акции" : activeCategory;
    els.productsList.innerHTML = `
        <section class="category-section" aria-label="${escapeHtml(title)}">
            <div class="category-header">
                <span class="category-name">${escapeHtml(title)}</span>
                <span class="category-count">${filtered.length}</span>
            </div>
            ${filtered.map(renderProductCard).join("")}
        </section>
    `;
}

function renderProductCard(product) {
    const qty = cart[product.id] || 0;
    const unitLabel = product.unit === UNIT_KG ? "весовой" : "штучный";
    const priceMissing = product.price >= 100000;
    const imageCandidates = productImageCandidates(product);
    const image = imageCandidates[0] || "";
    const fallbackImages = imageCandidates.slice(1).join("|");
    const media = image
        ? `<button class="product-image-btn" type="button" data-image="${escapeHtml(image)}" data-fallbacks="${escapeHtml(fallbackImages)}" data-name="${escapeHtml(product.name)}" aria-label="Открыть фото ${escapeHtml(product.name)}"><img class="product-image" src="${escapeHtml(image)}" data-fallbacks="${escapeHtml(fallbackImages)}" alt="${escapeHtml(product.name)}" width="360" height="360" loading="lazy"></button>`
        : "<span class=\"product-placeholder\" aria-hidden=\"true\">DD</span>";

    return `
        <article class="product-card${qty > 0 ? " in-cart" : ""}${product.sale ? " sale-card" : ""}${priceMissing ? " price-missing-card" : ""}" data-id="${product.id}">
            <div class="product-media">
                ${media}
                ${priceMissing ? "<span class=\"missing-price-pill\">Проверить цену</span>" : ""}
                ${product.sale ? "<span class=\"sale-pill\">Акция</span>" : `<span class="unit-pill">${unitLabel}</span>`}
            </div>
            <div class="product-info">
                <h3 class="product-name">${escapeHtml(product.name)}</h3>
                <div class="product-price">${formatPrice(product.price)} / ${escapeHtml(product.unit)}</div>
            </div>
            <div class="counter" aria-label="Количество ${escapeHtml(product.name)}">
                <button class="counter-btn minus" type="button" data-id="${product.id}" data-action="minus" aria-label="Уменьшить количество ${escapeHtml(product.name)}">-</button>
                <div class="counter-value-wrap">
                    <span class="counter-val">${formatQty(qty)}</span>
                    <span class="counter-unit">${escapeHtml(product.unit)}</span>
                </div>
                <button class="counter-btn plus" type="button" data-id="${product.id}" data-action="plus" aria-label="Добавить ${escapeHtml(product.name)}">+</button>
            </div>
        </article>
    `;
}

function changeCartItemQuantity(id, action) {
    const product = productsById.get(String(id));
    if (!product) return 0;

    const current = Number(cart[id] || 0);
    const next = action === "plus" ? current + product.quantityStep : current - product.quantityStep;
    const rounded = roundQty(Math.max(0, next));

    if (rounded > 0) {
        cart[id] = rounded;
    } else {
        delete cart[id];
    }

    saveCartToStorage();
    updateCartBadge();
    return rounded;
}

function roundQty(value) {
    return Math.round(Number(value || 0) * 1000) / 1000;
}

function formatQty(value) {
    const rounded = roundQty(value);
    if (Number.isInteger(rounded)) return String(rounded);
    return rounded.toFixed(3).replace(/0+$/, "").replace(/\.$/, "").replace(".", ",");
}

function formatPrice(value) {
    return `${priceFormatter.format(Math.round(Number(value || 0)))} тг`;
}

function getCartItems() {
    return Object.entries(cart)
        .map(([id, qty]) => {
            const product = productsById.get(String(id));
            return product ? { ...product, qty: Number(qty) } : null;
        })
        .filter(Boolean);
}

function renderCart() {
    const items = getCartItems();
    els.cartEmpty.hidden = items.length > 0;
    els.cartSummary.hidden = items.length === 0;
    els.whatsappBtn.hidden = items.length === 0;

    els.cartItems.innerHTML = items.map((item) => `
        <div class="cart-item">
            <div>
                <span class="cart-item-name">${escapeHtml(item.name)}</span>
                <span class="cart-item-price">${formatPrice(item.price * item.qty)}</span>
            </div>
            <div class="counter">
                <button class="counter-btn minus cart-counter-btn" type="button" data-id="${item.id}" data-action="minus" aria-label="Уменьшить количество ${escapeHtml(item.name)}">-</button>
                <div class="counter-value-wrap">
                    <span class="counter-val">${formatQty(item.qty)}</span>
                    <span class="counter-unit">${escapeHtml(item.unit)}</span>
                </div>
                <button class="counter-btn plus cart-counter-btn" type="button" data-id="${item.id}" data-action="plus" aria-label="Добавить ${escapeHtml(item.name)}">+</button>
            </div>
        </div>
    `).join("");

    const orderText = buildOrderText(items);
    els.cartText.textContent = orderText;
    els.cartTotalPrice.textContent = formatPrice(getCartTotal(items));
    els.whatsappBtn.href = `https://wa.me/${WHATSAPP_PHONE}?text=${encodeURIComponent(orderText)}`;
    els.copyCartBtn.dataset.copyText = orderText;
}

function getCartTotal(items) {
    return items.reduce((sum, item) => sum + item.price * item.qty, 0);
}

function buildOrderText(items) {
    const lines = ["Заказ на сайте DD Market.", ""];
    items.forEach((item) => {
        lines.push(`${item.name} - ${formatQty(item.qty)} ${item.unit}`);
    });
    lines.push("");
    lines.push(`Примерная сумма: ${formatPrice(getCartTotal(items))}.`);
    lines.push("Финальная сумма после точного взвешивания.");
    return lines.join("\n");
}

function openPhotoLightbox(imageUrl, name) {
    if (!imageUrl) return;
    els.photoLightboxImage.src = imageUrl;
    els.photoLightboxImage.alt = name || "";
    els.photoLightbox.hidden = false;
    els.photoLightbox.setAttribute("aria-hidden", "false");
    document.body.classList.add("lightbox-open");
}

function closePhotoLightbox() {
    els.photoLightbox.hidden = true;
    els.photoLightbox.setAttribute("aria-hidden", "true");
    els.photoLightboxImage.src = "";
    els.photoLightboxImage.alt = "";
    document.body.classList.remove("lightbox-open");
}

function saveCartToStorage() {
    try {
        localStorage.setItem(CART_KEY, JSON.stringify({ updatedAt: Date.now(), cart }));
    } catch {
        // Cart persistence is optional.
    }
}

function loadCartFromStorage() {
    try {
        const raw = localStorage.getItem(CART_KEY);
        if (!raw) return;

        const parsed = JSON.parse(raw);
        if (!parsed.updatedAt || Date.now() - parsed.updatedAt > CART_TTL_MS) {
            localStorage.removeItem(CART_KEY);
            return;
        }

        cart = Object.entries(parsed.cart || {}).reduce((nextCart, [id, qty]) => {
            const value = Number(qty);
            if (value > 0) nextCart[id] = roundQty(value);
            return nextCart;
        }, {});
    } catch {
        cart = {};
    }
}

function updateCartBadge() {
    const total = getCartItems().length;
    els.cartBadge.hidden = total <= 0;
    els.cartBadge.textContent = String(total);
}

function setActiveScreen(screenId) {
    const nextScreen = screenId === "cart-screen" ? "cart-screen" : "catalog-screen";
    document.querySelectorAll(".screen").forEach((screen) => {
        screen.classList.toggle("active", screen.id === nextScreen);
    });
    document.querySelectorAll(".nav-btn").forEach((button) => {
        button.classList.toggle("active", button.dataset.screen === nextScreen);
    });
    if (nextScreen === "cart-screen") renderCart();
    try {
        localStorage.setItem(ACTIVE_SCREEN_KEY, nextScreen);
    } catch {
        // Active screen persistence is optional.
    }
}

function escapeHtml(value) {
    return String(value ?? "")
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll("\"", "&quot;")
        .replaceAll("'", "&#039;");
}

function bindEvents() {
    els.supercategoriesBar.addEventListener("click", (event) => {
        const button = event.target.closest(".super-chip");
        if (!button) return;
        activeSuperCategory = button.dataset.superCategory;
        activeCategory = null;
        renderCategories();
        renderProducts();
    });

    els.categoriesBar.addEventListener("click", (event) => {
        const button = event.target.closest(".cat-chip");
        if (!button) return;
        activeCategory = button.dataset.category;
        renderCategories();
        renderProducts();
    });

    els.productsList.addEventListener("click", (event) => {
        const imageButton = event.target.closest(".product-image-btn");
        if (imageButton) {
            openPhotoLightbox(imageButton.dataset.image, imageButton.dataset.name);
            return;
        }
        const button = event.target.closest(".counter-btn");
        if (!button) return;
        changeCartItemQuantity(button.dataset.id, button.dataset.action);
        renderProducts();
    });

    els.productsList.addEventListener("error", (event) => {
        const image = event.target.closest(".product-image");
        if (!image) return;
        const fallbacks = (image.dataset.fallbacks || "").split("|").filter(Boolean);
        const next = fallbacks.shift();
        if (next) {
            image.dataset.fallbacks = fallbacks.join("|");
            image.closest(".product-image-btn")?.setAttribute("data-image", next);
            image.src = next;
            return;
        }
        const media = image.closest(".product-media");
        if (media) {
            media.innerHTML = "<span class=\"product-placeholder\" aria-hidden=\"true\">DD</span>";
        }
    }, true);

    els.cartItems.addEventListener("click", (event) => {
        const button = event.target.closest(".cart-counter-btn");
        if (!button) return;
        changeCartItemQuantity(button.dataset.id, button.dataset.action);
        renderCart();
        renderProducts();
    });

    els.searchInput.addEventListener("input", () => {
        renderProducts();
    });

    els.photoLightboxClose.addEventListener("click", closePhotoLightbox);
    els.photoLightbox.addEventListener("click", (event) => {
        if (event.target === els.photoLightbox) closePhotoLightbox();
    });

    document.querySelectorAll(".nav-btn").forEach((button) => {
        button.addEventListener("click", () => setActiveScreen(button.dataset.screen));
    });

    els.clearCartBtn.addEventListener("click", () => {
        const hasItems = Object.keys(cart).length > 0;
        if (!hasItems) return;
        const confirmed = window.confirm("Очистить корзину?");
        if (!confirmed) return;
        cart = {};
        saveCartToStorage();
        updateCartBadge();
        renderCart();
        renderProducts();
    });

    els.copyCartBtn.addEventListener("click", async () => {
        const text = els.copyCartBtn.dataset.copyText || "";
        if (!text) return;
        await navigator.clipboard.writeText(text);
        const oldText = els.copyCartBtn.textContent;
        els.copyCartBtn.textContent = "Скопировано";
        setTimeout(() => {
            els.copyCartBtn.textContent = oldText;
        }, 1200);
    });
}

async function init() {
    bindEvents();
    loadCartFromStorage();
    updateCartBadge();
    renderCategories();
    renderProducts();
    await Promise.all([fetchProductsFromSheets(), fetchPromosFromSheets()]);
    renderCategories();
    renderProducts();

    const savedScreen = localStorage.getItem(ACTIVE_SCREEN_KEY);
    setActiveScreen(savedScreen || "catalog-screen");

    setInterval(async () => {
        if (document.hidden) return;
        const [updated] = await Promise.all([fetchProductsFromSheets(), fetchPromosFromSheets()]);
        if (updated) {
            renderCategories();
            renderProducts();
            if ($("#cart-screen").classList.contains("active")) renderCart();
        }
    }, REFRESH_INTERVAL_MS);
}

init();
