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
id,publish,barcode,name,name1s,unit,category0,category1,availability,price,quantity,sale,image,comment
```

Правила:

- `barcode`: штрихкод товара, участвует в поиске.
- `publish`: `yes` публикует товар, `no` скрывает его от сайта.
- `unit`: `кг` для весовых товаров, `шт` для упаковок и штучных товаров.
- `category0`: верхняя категория для первого ряда навигации на сайте.
- `category1`: категория внутри `category0`, показывается вторым рядом.
- `availability`: сайт показывает только `in stock`.
- `price`: сайт показывает только товары с ценой больше нуля.
- `quantity`: остаток; сейчас может быть пустым, когда поставщик его не дает.
- `sale`: пока всем `no`.
- `image`: необязательная ссылка на фото товара.
- `comment`: ручной комментарий, на сайт не выводится как служебная диагностика.

Сайт игнорирует строки без `barcode`, с `publish=no`, с `availability=out of stock` и без валидной цены.
