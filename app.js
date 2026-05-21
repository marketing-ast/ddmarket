"use strict";

const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vT2mxltvHlBrpAfIHJ5g9XEfRxmQckITPgY_muXeiL-pQtdSC5g0tWUkHo0iMB_FVRGz8ntdJ8rbm_E/pub?output=csv";
const WHATSAPP_PHONE = "77785252162";
const CACHE_KEY = "astore_products_v1";
const CACHE_TIME_KEY = "astore_products_ts_v1";
const CART_KEY = "astore_cart_v1";
const ACTIVE_SCREEN_KEY = "astore_active_screen";
const REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const CART_TTL_MS = 24 * 60 * 60 * 1000;
const UNIT_KG = "кг";
const UNIT_PC = "шт";

let products = [];
let productsById = new Map(products.map((item) => [item.id, item]));
let cart = {};
let activeCategory = "all";
let refreshInProgress = false;

const $ = (selector) => document.querySelector(selector);
const els = {
    productsList: $("#products-list"),
    emptyState: $("#empty-state"),
    searchInput: $("#search-input"),
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
};

function setProducts(nextProducts) {
    products = normalizeProducts(nextProducts);
    productsById = new Map(products.map((item) => [item.id, item]));
}

function normalizeProducts(rawProducts) {
    return rawProducts
        .map((item, index) => {
            const id = Number.parseInt(String(item.id ?? index + 1).replace(/[^\d]/g, ""), 10) || index + 1;
            const unitInfo = normalizeUnitInfo(item.unit);
            return {
                id,
                name: cleanText(item.name),
                unit: unitInfo.unit,
                category: cleanText(item.category) || "Другое",
                availability: item.availability,
                price: parsePrice(item.price),
                sale: parseSaleValue(item.sale),
                emoji: cleanText(item.emoji) || getProductEmoji(item.name, item.category),
                quantityStep: unitInfo.quantityStep,
            };
        })
        .filter((item) => item.name && item.price > 0 && parseAvailabilityValue(item.availability));
}

function cleanText(value) {
    return String(value ?? "").trim();
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

function parseSaleValue(value) {
    const normalized = cleanText(value).toLowerCase();
    return ["yes", "true", "1", "sale", "акция", "да"].includes(normalized);
}

function parseCSV(csvText) {
    const lines = csvText.trim().split(/\r?\n/).filter(Boolean);
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
        const response = await fetch(`${SHEET_CSV_URL}&t=${Date.now()}`, { cache: "no-store" });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);

        const csvText = await response.text();
        const parsed = normalizeProducts(parseCSV(csvText));
        if (parsed.length === 0) throw new Error("Empty catalog");

        setProducts(parsed);
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
        console.warn("[A-Store] Google Sheet is unavailable, fallback catalog is used.", error);
        updateLastUpdateDisplay(null);
        return false;
    } finally {
        refreshInProgress = false;
    }
}

function updateLastUpdateDisplay(timestamp) {
    if (!timestamp) {
        els.lastUpdate.textContent = "Работаем с резервным каталогом";
        return;
    }

    const date = new Date(timestamp);
    const time = date.toLocaleTimeString("ru-KZ", { hour: "2-digit", minute: "2-digit" });
    els.lastUpdate.textContent = `Цены обновлены в ${time}`;
}

function getCategories() {
    return [...new Set(products.map((item) => item.category))].sort((a, b) => a.localeCompare(b, "ru"));
}

function renderCategories() {
    const hasSale = products.some((item) => item.sale);
    const categories = [
        { id: "all", label: "Все" },
        ...(hasSale ? [{ id: "sale", label: "Акции" }] : []),
        ...getCategories().map((category) => ({ id: category, label: category })),
    ];

    if (!categories.some((category) => category.id === activeCategory)) {
        activeCategory = "all";
    }

    els.categoriesBar.innerHTML = categories.map((category) => `
        <button class="cat-chip${category.id === activeCategory ? " active" : ""}" type="button" data-category="${escapeHtml(category.id)}">
            ${escapeHtml(category.label)}
        </button>
    `).join("");
}

function getFilteredProducts() {
    const query = cleanText(els.searchInput.value).toLowerCase();
    return products.filter((item) => {
        const matchesCategory = activeCategory === "all"
            || (activeCategory === "sale" ? item.sale : item.category === activeCategory);
        const matchesQuery = !query
            || item.name.toLowerCase().includes(query)
            || item.category.toLowerCase().includes(query);
        return matchesCategory && matchesQuery;
    });
}

function renderProducts() {
    const filtered = getFilteredProducts();
    els.emptyState.hidden = filtered.length > 0;

    if (filtered.length === 0) {
        els.productsList.innerHTML = "";
        return;
    }

    if (activeCategory === "all") {
        const grouped = groupByCategory(filtered);
        els.productsList.innerHTML = Object.entries(grouped)
            .map(([category, items]) => `
                <section class="category-section" aria-label="${escapeHtml(category)}">
                    <div class="category-header">
                        <span class="category-name">${escapeHtml(category)}</span>
                        <span class="category-count">${items.length}</span>
                    </div>
                    ${items.map(renderProductCard).join("")}
                </section>
            `).join("");
        return;
    }

    els.productsList.innerHTML = filtered.map(renderProductCard).join("");
}

function groupByCategory(items) {
    return items.reduce((groups, item) => {
        if (!groups[item.category]) groups[item.category] = [];
        groups[item.category].push(item);
        return groups;
    }, {});
}

function renderProductCard(product) {
    const qty = cart[product.id] || 0;
    const unitLabel = product.unit === UNIT_KG ? "весовой" : "штучный";
    return `
        <article class="product-card${qty > 0 ? " in-cart" : ""}${product.sale ? " sale-card" : ""}" data-id="${product.id}">
            <div class="product-topline">
                <div class="product-emoji" aria-hidden="true">${escapeHtml(product.emoji)}</div>
                <div>
                    ${product.sale ? "<span class=\"sale-pill\">Акция</span>" : `<span class="unit-pill">${unitLabel}</span>`}
                </div>
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
    const product = productsById.get(Number(id));
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
    return `${Math.round(Number(value || 0)).toLocaleString("ru-KZ")} тг`;
}

function getCartItems() {
    return Object.entries(cart)
        .map(([id, qty]) => {
            const product = productsById.get(Number(id));
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
                <span class="cart-item-name">${escapeHtml(item.emoji)} ${escapeHtml(item.name)}</span>
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
    const lines = ["Заказ на сайте A-Store.", ""];
    items.forEach((item) => {
        lines.push(`${item.name} - ${formatQty(item.qty)} ${item.unit}`);
    });
    lines.push("");
    lines.push(`Примерная сумма: ${formatPrice(getCartTotal(items))}.`);
    lines.push("Финальная сумма после точного взвешивания.");
    return lines.join("\n");
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

function getProductEmoji(name, category) {
    const text = `${name || ""} ${category || ""}`.toLowerCase();
    const dictionary = [
        ["молок", "🥛"], ["сыр", "🧀"], ["йогур", "🥛"], ["хлеб", "🍞"],
        ["яблок", "🍎"], ["груш", "🍐"], ["банан", "🍌"], ["апельс", "🍊"],
        ["мандар", "🍊"], ["лимон", "🍋"], ["карто", "🥔"], ["томат", "🍅"],
        ["огур", "🥒"], ["морков", "🥕"], ["капуст", "🥬"], ["мяс", "🥩"],
        ["кур", "🍗"], ["рыб", "🐟"], ["конф", "🍬"], ["печен", "🍪"],
    ];
    const found = dictionary.find(([key]) => text.includes(key));
    return found ? found[1] : "🛒";
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
    els.categoriesBar.addEventListener("click", (event) => {
        const button = event.target.closest(".cat-chip");
        if (!button) return;
        activeCategory = button.dataset.category;
        renderCategories();
        renderProducts();
    });

    els.productsList.addEventListener("click", (event) => {
        const button = event.target.closest(".counter-btn");
        if (!button) return;
        changeCartItemQuantity(button.dataset.id, button.dataset.action);
        renderProducts();
    });

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

    document.querySelectorAll(".nav-btn").forEach((button) => {
        button.addEventListener("click", () => setActiveScreen(button.dataset.screen));
    });

    els.clearCartBtn.addEventListener("click", () => {
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
    await fetchProductsFromSheets();
    renderCategories();
    renderProducts();

    const savedScreen = localStorage.getItem(ACTIVE_SCREEN_KEY);
    setActiveScreen(savedScreen || "catalog-screen");

    setInterval(async () => {
        if (document.hidden) return;
        const updated = await fetchProductsFromSheets();
        if (updated) {
            renderCategories();
            renderProducts();
            if ($("#cart-screen").classList.contains("active")) renderCart();
        }
    }, REFRESH_INTERVAL_MS);
}

init();
