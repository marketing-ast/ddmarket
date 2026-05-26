# DD Market

DD Market - статический каталог продуктов с корзиной и заказом через WhatsApp. Сайт берет товары и цены из опубликованной Google Таблицы, показывает весовые и штучные товары, выделяет проблемные цены и формирует готовый текст заказа.

## Что внутри

- `index.html` - разметка каталога, корзины и навигации.
- `style.css` - mobile-first дизайн DD Market по брендбуку.
- `app.js` - загрузка CSV из Google Sheets, фильтры, корзина, кеш и WhatsApp.
- `data/ddmarket-products.csv` - резервная выгрузка текущего каталога.
- `scripts/convert-client-catalog.js` - конвертер клиентского Excel в формат каталога.
- `assets/fonts/` - локально подключенный фирменный шрифт Onest.
- `logo/` - логотип DD Market для интерфейса.

## Таблица Товаров

Сайт читает опубликованный CSV:

```text
https://docs.google.com/spreadsheets/d/e/2PACX-1vQy0tUi3LVSJ_o7DMI_2OAFxr-651J5wgDJBnL0cNq18YNAltbsgEPwYO0QDp4p00mOrwhY1i3IrT_m/pub?output=csv
```

Ожидаемые колонки:

```text
id,barcode,name,unit,category,availability,price,sale,emoji,image
```

Правила:

- `barcode`: штрихкод товара, участвует в поиске.
- `unit`: `кг` для весовых товаров, `шт` для упаковок и штучных товаров.
- `availability`: сейчас всем ставится `in stock`.
- `price`: если цены нет, ставится `100000`, а карточка на сайте становится чёрной.
- `sale`: пока всем `no`.
- `image`: необязательная ссылка на фото товара.
