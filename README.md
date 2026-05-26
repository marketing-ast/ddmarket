# DD Market

DD Market - статический каталог продуктов с корзиной и заказом через WhatsApp. Сайт берет товары и цены из опубликованной Google Таблицы, показывает весовые и штучные товары, выделяет акции и формирует готовый текст заказа.

## Что внутри

- `index.html` - разметка каталога, корзины и нижней навигации.
- `style.css` - mobile-first дизайн DD Market по брендбуку.
- `app.js` - загрузка CSV из Google Sheets, парсинг товаров, корзина, кеш и WhatsApp.
- `assets/fonts/` - локально подключенный фирменный шрифт Onest.
- `logo/` - логотип DD Market для интерфейса.
- `.github/workflows/pages.yml` - деплой статического сайта на GitHub Pages.

## Таблица товаров

Сайт читает опубликованный CSV:

```text
https://docs.google.com/spreadsheets/d/e/2PACX-1vT2mxltvHlBrpAfIHJ5g9XEfRxmQckITPgY_muXeiL-pQtdSC5g0tWUkHo0iMB_FVRGz8ntdJ8rbm_E/pub?output=csv
```

Ожидаемые колонки:

```text
id,name,unit,category,availability,price,sale,emoji
```

Правила:

- `unit`: `кг` для весовых товаров, `шт` для штучных.
- Весовые товары добавляются с шагом из таблицы, например `0.1 кг` или `100 г`.
- `availability`: `in stock` показывает товар, `out of stock` скрывает.
- `sale`: `yes`, `акция` или `да` включает акционный бейдж.
- `emoji`: необязательная иконка товара.

## WhatsApp

Кнопка WhatsApp формирует сообщение с началом:

```text
Заказ на сайте DD Market.
```

Номер задается в `app.js` в константе `WHATSAPP_PHONE`.
