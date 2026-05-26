# Деплой DD Market

## Быстрый Деплой

1. Обновите Google Таблицу.
2. Проверьте, что она опубликована как CSV через `File -> Share -> Publish to web`.
3. Проверьте, что ссылка в `app.js` указывает на опубликованный CSV:

```js
const SHEET_CSV_URL = "https://docs.google.com/spreadsheets/d/e/2PACX-1vQy0tUi3LVSJ_o7DMI_2OAFxr-651J5wgDJBnL0cNq18YNAltbsgEPwYO0QDp4p00mOrwhY1i3IrT_m/pub?output=csv";
```

4. Сделайте коммит в ветку `main`.
5. Запушьте изменения в GitHub:

```bash
git push origin main
```

6. GitHub Actions запустит workflow `Deploy static site to GitHub Pages`.

## Проверка После Деплоя

- Откройте опубликованный GitHub Pages URL.
- Убедитесь, что товары загрузились из Google Таблицы.
- Проверьте поиск по названию, `id` и `barcode`.
- Проверьте, что товары с ценой `100000` отображаются чёрными карточками.
- Проверьте WhatsApp-заказ из корзины.
