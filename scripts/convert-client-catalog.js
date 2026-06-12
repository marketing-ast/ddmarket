const fs = require("fs");
const path = require("path");
const XLSX = require(process.env.TEMP + "/ddmarket-xlsx-tools/node_modules/xlsx");

const sourceFile = process.env.XLS_FILE;
if (!sourceFile) {
    throw new Error("XLS_FILE is required");
}

throw new Error(
    "scripts/convert-client-catalog.js is deprecated. Use the Google Sheets/import bot flow with columns: " +
    "id,publish,barcode,name,name1s,unit,category0,category1,availability,price,quantity,sale,image,comment."
);

const workbook = XLSX.readFile(sourceFile, { raw: false });
const rows = XLSX.utils.sheet_to_json(workbook.Sheets[workbook.SheetNames[0]], {
    header: 1,
    defval: "",
    blankrows: false,
});

const explicitHeaders = new Map([
    ["Кондитерские изделия", "Кондитерские изделия"],
    ["Кофе/чай", "Чай и кофе"],
    ["Напитки безалкогольные", "Напитки"],
    ["Химия", "Бытовая химия"],
    ["Крупы/макароны/лапша", "Бакалея"],
    ["Масло/мука/майонез/кетчуп/яйца", "Бакалея"],
    ["Молочные изделия/колбасные изделия", "Молочные продукты"],
    ["Сушки/баранки", "Кондитерские изделия"],
    ["Консервы", "Консервы"],
    ["Снеки", "Снеки"],
    ["Овощи", "Овощи"],
    ["Фрукты", "Фрукты и ягоды"],
    ["Сухофрукты", "Сухофрукты и орехи"],
    ["Хлебобулочные изделия", "Хлеб и выпечка"],
    ["Кулинария", "Кулинария"],
    ["Мясо свежее", "Мясо"],
]);

const targetHeaders = ["id", "barcode", "name", "unit", "category", "availability", "price", "sale", "emoji", "image"];

function clean(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
}

function parsePrice(value) {
    const cleaned = String(value ?? "").replace(/[^\d]/g, "");
    const price = Number.parseInt(cleaned, 10);
    return Number.isFinite(price) && price > 0 ? price : 100000;
}

function isPriceMissing(value) {
    const cleaned = String(value ?? "").replace(/[^\d]/g, "");
    const price = Number.parseInt(cleaned, 10);
    return !Number.isFinite(price) || price <= 0;
}

function inferUnit(name) {
    const lower = name.toLowerCase();
    if (/(^|\s)вес\s*$|\bвесовой\b|\bвес\b\s*$/i.test(lower)) return "кг";
    if (/(^|\s)(кг|kg)\s*$/i.test(lower) && !/(\d+[\s,.]*(кг|kg))\s*$/i.test(lower)) return "кг";
    if (/\d+[\s,.]*(гр|г|g|кг|kg|мл|ml|л|l)\b/i.test(lower)) return "шт";
    if (/\b(шт|пучок|уп|пакет|стакан|бутыл|банка)\b/i.test(lower)) return "шт";
    return "шт";
}

function optimizeCategory(baseCategory, name) {
    const lower = name.toLowerCase();
    if (baseCategory === "Овощи" && /(кинза|укроп|петруш|мята|руккола|шпинат|джусай|щавель|салат|зелень)/i.test(lower)) {
        return "Зелень и салаты";
    }
    if (baseCategory === "Молочные продукты" && /(колбас|сервелат|конины|мусульманская|das|нәрлен)/i.test(lower)) {
        return "Колбасы";
    }
    if (baseCategory === "Кондитерские изделия" && /(мед|варенье)/i.test(lower)) {
        return "Мед и варенье";
    }
    if (baseCategory === "Бакалея" && /(яйц)/i.test(lower)) {
        return "Яйца";
    }
    return baseCategory;
}

function emojiFor(category, name) {
    const text = `${category} ${name}`.toLowerCase();
    if (/сухофрукт|орех|арахис|изюм|курага|финик|чернослив|фисташ/.test(text)) return "🥜";
    if (/фрукты|ягоды|яблок|груш|банан|апельс|мандар|лимон|виноград|арбуз|дыня/.test(text)) return "🍎";
    if (/овощ|картоф|капуст|томат|огур|морков|лук|перец|свекл/.test(text)) return "🥕";
    if (/зелень|салат|укроп|кинза|петруш|руккола/.test(text)) return "🥬";
    if (/мясо|жылқы|қой|сиыр|фарш|қазы|шұжық/.test(text)) return "🥩";
    if (/молоч|сыр|сметан|молоко|кумыс|шубат/.test(text)) return "🥛";
    if (/колбас/.test(text)) return "🥓";
    if (/хлеб|выпеч|лаваш|батон|самса|булоч|лепеш/.test(text)) return "🍞";
    if (/напит|cola|pepsi|fanta|sprite|сок|вода|чай/.test(text)) return "🥤";
    if (/кофе/.test(text)) return "☕";
    if (/кондитер|печенье|шоколад|конф|ваф|сушки|баранки|снеки|чипсы/.test(text)) return "🍪";
    if (/бакалея|круп|макарон|лапша|мука|масло|майонез|кетчуп|соль|сахар/.test(text)) return "🛒";
    if (/химия|бумага|салфет|шамп|порошок|мыло|зуб/.test(text)) return "🧴";
    if (/консерв|горошек|кукуруз|оливки|маслины|шпрот|тушен/.test(text)) return "🥫";
    return "🛒";
}

function csvEscape(value) {
    const text = String(value ?? "");
    if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
    return text;
}

let currentCategory = "";
const products = [];
const ambiguous = [];
const headersSeen = [];

for (let i = 1; i < rows.length; i += 1) {
    const row = rows[i];
    const barcode = clean(row[0]);
    const name = clean(row[1]);
    const priceRaw = row[2];
    if (!name) continue;

    if (!barcode && explicitHeaders.has(name)) {
        currentCategory = explicitHeaders.get(name);
        headersSeen.push({ row: i + 1, source: name, category: currentCategory });
        continue;
    }

    if (!currentCategory) currentCategory = "Прочее";
    const category = optimizeCategory(currentCategory, name);
    const unit = inferUnit(name);
    const lower = name.toLowerCase();
    if (
        unit === "шт"
        && !/\d+[\s,.]*(гр|г|g|кг|kg|мл|ml|л|l)\b|\b(шт|пучок|уп|пакет|стакан|бутыл|банка)\b/i.test(lower)
        && !/(^|\s)вес\s*$|\bвесовой\b|\bвес\b\s*$/i.test(lower)
    ) {
        ambiguous.push({ row: i + 1, name, unit });
    }

    products.push({
        sourceRow: i + 1,
        barcode,
        name,
        unit,
        category,
        availability: "in stock",
        price: parsePrice(priceRaw),
        priceMissing: isPriceMissing(priceRaw),
        sale: "no",
        emoji: emojiFor(category, name),
        image: "",
    });
}

const categoryOrder = [];
for (const item of products) {
    if (!categoryOrder.includes(item.category)) categoryOrder.push(item.category);
}

const categoryPrefixes = new Map(categoryOrder.map((category, index) => [category, 101 + index]));
const counters = new Map();
for (const item of products) {
    const prefix = categoryPrefixes.get(item.category);
    const next = (counters.get(item.category) || 0) + 1;
    counters.set(item.category, next);
    item.id = String(prefix * 1000 + next).padStart(6, "0");
}

const outputRows = products.map((item) => targetHeaders.map((header) => item[header]));
const csv = [targetHeaders.join(","), ...outputRows.map((row) => row.map(csvEscape).join(","))].join("\r\n") + "\r\n";

fs.mkdirSync("data", { recursive: true });
fs.writeFileSync(path.join("data", "ddmarket-products.csv"), csv, "utf8");
fs.writeFileSync(path.join("data", "ddmarket-products.json"), JSON.stringify(products, null, 2), "utf8");
fs.writeFileSync(path.join("data", "ddmarket-sheet-values.json"), JSON.stringify([targetHeaders, ...outputRows], null, 2), "utf8");
fs.writeFileSync(path.join("data", "ddmarket-import-summary.json"), JSON.stringify({
    totalProducts: products.length,
    headersSeen,
    categories: categoryOrder.map((category) => ({
        category,
        prefix: categoryPrefixes.get(category),
        count: counters.get(category),
    })),
    missingPrices: products.filter((product) => product.priceMissing).map((product) => ({
        row: product.sourceRow,
        id: product.id,
        name: product.name,
        category: product.category,
    })),
    ambiguousUnitCount: ambiguous.length,
    ambiguousUnitSample: ambiguous.slice(0, 30),
    sample: products.slice(0, 12),
}, null, 2), "utf8");

console.log(JSON.stringify({
    totalProducts: products.length,
    categories: categoryOrder.length,
    missingPrices: products.filter((product) => product.priceMissing).length,
    output: "data/ddmarket-products.csv",
}, null, 2));
