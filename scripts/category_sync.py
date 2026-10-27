"""DD Market: permanent product IDs and category dropdowns using the existing bot account.

No Telegram messages, prices, stock, photos or existing product IDs are rewritten.
Google dependencies are imported only by the service entry point, so planning tests
run using the Python standard library alone.
"""
from __future__ import annotations

import argparse
import copy
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import shlex
import time

REGISTRY = "_ddmarket_category_ids"
CAT_HEADERS = ["category0", "category1", "prefix", "base_id", "sort0", "sort1"]
REG_HEADERS = ["prefix", "category0", "category1", "sort0", "sort1", "last_sequence"]
PROTECTION = "DD Market: automatic category fields"
DEFAULT_ID = "1IcNPMvcEHIkpIIX9V1Ll7iax3zwVfnORNph83-haaWM"


def text(value):
    return re.sub(r"\s+", " ", str(value if value is not None else "")).strip()


def key(parent, child=""):
    return text(parent).upper(), text(child).upper()


def positive(value):
    try:
        n = float(value)
        return int(n) if n > 0 and n.is_integer() else 0
    except (ValueError, TypeError, OverflowError):
        return 0


def prefix(value):
    n = positive(value)
    return f"{n:02d}" if n else ""


def padded(row, width):
    return (list(row) + [""] * width)[:width]


def plan_changes(category_rows, product_rows, registry_rows):
    if not category_rows or category_rows[0] != CAT_HEADERS:
        raise ValueError("Не меняйте заголовки и порядок первых шести колонок categories.")
    if not product_rows:
        raise ValueError("products пуст: изменения не применены.")
    col = {name: i for i, name in enumerate(product_rows[0])}
    required = ["id", "publish", "barcode", "name", "name1s", "unit", "category0", "category1"]
    if product_rows[0][:8] != required:
        raise ValueError("Неожиданная структура products; ID не изменены.")
    records, highwater, used = {}, {}, set()
    largest = 0
    if registry_rows and registry_rows[0] != REG_HEADERS:
        raise ValueError("Повреждён реестр ID; восстановите резервную копию.")
    for raw in registry_rows[1:]:
        row = padded(raw, 6)
        if not any(text(v) for v in row):
            continue
        p = prefix(row[0])
        seq = positive(row[5])
        if not p or p in records or seq > 9999 or (text(row[5]) not in {"", "0"} and not seq):
            raise ValueError("Повреждён реестр ID; изменения остановлены.")
        records[p] = dict(prefix=p, category0=text(row[1]), category1=text(row[2]),
                          sort0=positive(row[3]), sort1=positive(row[4]), sequence=seq)
        highwater[p] = seq
        largest = max(largest, int(p))
    for number, raw in enumerate(product_rows[1:], 2):
        row = padded(raw, len(col))
        ident = text(row[col["id"]]).lstrip("'")
        if not ident:
            continue
        if ident in used:
            raise ValueError(f"Повтор ID {ident} в products, строка {number}. Старые ID не изменены.")
        used.add(ident)
        if re.fullmatch(r"\d{6,}", ident):
            p = prefix(ident[:-4])
            if p:
                highwater[p] = max(highwater.get(p, 0), int(ident[-4:]))
                largest = max(largest, int(p))
    categories = [padded(r, 6) for r in category_rows[1:]]
    largest = max([largest] + [positive(r[2]) for r in categories])
    known = {key(r["category0"], r["category1"]): r for r in records.values() if r["category0"]}
    parents, sub_orders = {}, {}
    max_order = max([0] + [r["sort0"] for r in records.values()])
    for r in records.values():
        sub_orders[key(r["category0"])] = max(sub_orders.get(key(r["category0"]), 0), r["sort1"])
    for r in categories:
        if not text(r[0]) or not text(r[1]):
            continue
        parent, order = key(r[0]), positive(r[4])
        if order:
            if parent in parents and parents[parent] != order:
                raise ValueError(f"Разные значения sort0 у категории {text(r[0])}.")
            parents[parent] = order
            max_order = max(max_order, order)
        sub_orders[parent] = max(sub_orders.get(parent, 0), positive(r[5]))
    category_writes, product_writes, definitions, errors = [], [], [], []
    active, prefixes, parent_names = {}, set(), {}
    for number, row in enumerate(categories, 2):
        parent, child = text(row[0]), text(row[1])
        if not parent or not child:
            continue
        if parent == "__sale__" or re.match(r"[=+#@]", parent) or re.match(r"[=+#@]", child):
            raise ValueError(f"Недопустимое название в categories, строка {number}.")
        parent = parent_names.setdefault(key(parent), parent)
        pair = key(parent, child)
        if pair in active:
            raise ValueError(f"Повтор категории / подкатегории в categories, строка {number}.")
        previous = known.get(pair)
        p = prefix(row[2]) or (previous["prefix"] if previous else "")
        if not p:
            largest += 1
            p = prefix(largest)
        if int(p) > 99:
            raise ValueError("Достигнут предел 99 префиксов. Нужен переход формата; старые ID сохранены.")
        if p in prefixes or (previous and previous["prefix"] != p):
            raise ValueError(f"Повтор или изменение prefix {p}; старые ID сохранены.")
        old = records.get(p)
        if old and old["category0"] and key(old["category0"], old["category1"]) != pair:
            raise ValueError("Для переименования существующей пары нужен отдельный перенос. Добавьте новую пару в пустую строку.")
        prefixes.add(p)
        if key(parent) not in parents:
            max_order += 1
            parents[key(parent)] = max_order
        order1 = positive(row[5]) or (previous["sort1"] if previous else 0) or sub_orders.get(key(parent), 0) + 1
        sub_orders[key(parent)] = max(sub_orders.get(key(parent), 0), order1)
        record = dict(prefix=p, category0=parent, category1=child, sort0=parents[key(parent)],
                      sort1=order1, sequence=highwater.get(p, 0))
        records[p] = active[pair] = record
        definitions.append(record)
        values = [parent, child, p, p + "0000", record["sort0"], order1]
        for c, value in enumerate(values):
            if str(row[c]) != str(value):
                category_writes.append(dict(row=number, col=c + 1, value=value))
    if not definitions:
        raise ValueError("Нет ни одной заполненной пары categories; прежние данные сохранены.")
    for number, raw in enumerate(product_rows[1:], 2):
        row = padded(raw, len(col))
        record = active.get(key(row[col["category0"]], row[col["category1"]]))
        ready = text(row[col["name"]]) and text(row[col["barcode"]]) and text(row[col["unit"]])
        if not record:
            if ready:
                errors.append(f"products, строка {number}: выберите пару из categories")
            continue
        for name in ("category0", "category1"):
            if str(row[col[name]]) != record[name]:
                product_writes.append(dict(row=number, col=col[name] + 1, value=record[name]))
        if text(row[col["id"]]) or not ready:
            continue
        sequence = record["sequence"] + 1
        while f"{record['prefix']}{sequence:04d}" in used:
            sequence += 1
        if sequence > 9999:
            raise ValueError(f"Закончились ID подкатегории {record['category1']}; старые ID сохранены.")
        ident = f"{record['prefix']}{sequence:04d}"
        record["sequence"] = sequence
        used.add(ident)
        product_writes.append(dict(row=number, col=col["id"] + 1, value=ident))
        if not text(row[col["publish"]]):
            product_writes.append(dict(row=number, col=col["publish"] + 1, value="no"))
    for p, sequence in highwater.items():
        record = records.setdefault(p, dict(prefix=p, category0="", category1="", sort0=0, sort1=0, sequence=sequence))
        record["sequence"] = max(record["sequence"], sequence)
    registry = [REG_HEADERS] + [[r["prefix"], r["category0"], r["category1"], r["sort0"], r["sort1"], r["sequence"]]
                               for r in sorted(records.values(), key=lambda r: int(r["prefix"]))]
    return dict(category_writes=category_writes, product_writes=product_writes,
                definitions=definitions, registry=registry, columns=col, errors=errors)


def cell(value):
    return {"userEnteredValue": {"numberValue" if isinstance(value, (int, float)) else "stringValue": value}}


def write_block(sheet_id, row, column, values, fields="userEnteredValue"):
    return {"updateCells": {"range": {"sheetId": sheet_id, "startRowIndex": row,
            "endRowIndex": row + len(values), "startColumnIndex": column,
            "endColumnIndex": column + len(values[0])},
            "rows": [{"values": [cell(v) for v in r]} for r in values], "fields": fields}}


def validation(sheet_id, start, end, column, formula, *, strict=True):
    return {"setDataValidation": {"range": {"sheetId": sheet_id, "startRowIndex": start,
            "endRowIndex": end, "startColumnIndex": column, "endColumnIndex": column + 1},
            "rule": {"condition": {"type": "ONE_OF_RANGE", "values": [{"userEnteredValue": formula}]},
                     "strict": strict, "showCustomUi": True}}}


def letter(index):
    result = ""
    while index:
        index, n = divmod(index - 1, 26)
        result = chr(65 + n) + result
    return result


def build_requests(snapshot, plan, service_email):
    sheets = {s["properties"]["title"]: s for s in snapshot["metadata"]["sheets"]}
    ids = {name: s["properties"]["sheetId"] for name, s in sheets.items()}
    requests = []
    next_id = max(ids.values()) + 1
    for name in (REGISTRY, "_validation"):
        if name not in ids:
            ids[name] = next_id
            next_id += 1
            props = dict(sheetId=ids[name], title=name, gridProperties=dict(rowCount=100, columnCount=12))
            if name == REGISTRY:
                props["hidden"] = True
            requests.append({"addSheet": {"properties": props}})
            sheets[name] = {"properties": props}

    def ensure_size(name, rows, columns):
        grid = sheets[name]["properties"]["gridProperties"]
        updates = {}
        if rows > grid["rowCount"]:
            updates["rowCount"] = rows
        if columns > grid["columnCount"]:
            updates["columnCount"] = columns
        if updates:
            requests.append({"updateSheetProperties": {"properties": {"sheetId": ids[name], "gridProperties": updates},
                             "fields": ",".join("gridProperties." + k for k in updates)}})

    ensure_size(REGISTRY, len(plan["registry"]), 6)
    requests.append(write_block(ids[REGISTRY], 0, 0, plan["registry"]))
    for name, writes in (("categories", plan["category_writes"]), ("products", plan["product_writes"])):
        for w in writes:
            requests.append(write_block(ids[name], w["row"] - 1, w["col"] - 1, [[w["value"]]]))
    groups = {}
    for r in sorted(plan["definitions"], key=lambda r: (r["sort0"], r["sort1"], r["category1"])):
        groups.setdefault(r["category0"], []).append(r["category1"])
    group_items = list(groups.items())
    height = max(len(groups), max(map(len, groups.values()))) + 1
    width = len(groups) + 3
    ensure_size("_validation", height, width)
    helper = [[""] * width for _ in range(height)]
    helper[0][0:2] = ["category0", "range_name"]
    sub_ranges = {}
    named_ranges = {r["name"]: r for r in snapshot["metadata"].get("namedRanges", [])}
    for i, (name, children) in enumerate(group_items):
        helper[i + 1][0:2] = [name, "ddmarket_parent_" + str(i + 1)]
        helper[0][i + 3] = name
        for j, child in enumerate(children):
            helper[j + 1][i + 3] = child
        c = letter(i + 4)
        sub_ranges[name] = f"='_validation'!${c}$2:${c}${len(children) + 1}"
        range_name = "ddmarket_parent_" + str(i + 1)
        grid_range = {"sheetId": ids["_validation"], "startRowIndex": 1, "endRowIndex": len(children) + 1,
                      "startColumnIndex": i + 3, "endColumnIndex": i + 4}
        if range_name in named_ranges:
            if named_ranges[range_name]["range"] != grid_range:
                requests.append({"updateNamedRange": {"namedRange": {"namedRangeId": named_ranges[range_name]["namedRangeId"], "range": grid_range}, "fields": "range"}})
        else:
            requests.append({"addNamedRange": {"namedRange": {"name": range_name, "range": grid_range}}})
    requests.append(write_block(ids["_validation"], 0, 0, helper))
    parent_range = f"='_validation'!$A$2:$A${len(groups) + 1}"
    rows = sheets["products"]["properties"]["gridProperties"]["rowCount"]
    cat_count = sheets["categories"]["properties"]["gridProperties"]["rowCount"]
    col = plan["columns"]
    requests.append(validation(ids["categories"], 1, cat_count, 0, parent_range, strict=False))
    requests.append(validation(ids["products"], 1, rows, col["category0"], parent_range))
    # Rebuild dependent rules in consecutive blocks. Blank parents have no broken #REF rule.
    current = copy.deepcopy(snapshot["products"])
    for w in plan["product_writes"]:
        current[w["row"] - 1] = padded(current[w["row"] - 1], len(col))
        current[w["row"] - 1][w["col"] - 1] = w["value"]
    last_formula, start = None, 1
    for r in range(1, rows + 1):
        formula = sub_ranges.get(text(padded(current[r], len(col))[col["category0"]])) if r < len(current) else None
        if r == 1:
            last_formula = formula
        if formula != last_formula or r == rows:
            if r > start:
                if last_formula:
                    requests.append(validation(ids["products"], start, r, col["category1"], last_formula))
                else:
                    requests.append({"setDataValidation": {"range": {"sheetId": ids["products"], "startRowIndex": start,
                        "endRowIndex": r, "startColumnIndex": col["category1"], "endColumnIndex": col["category1"] + 1},
                        "rule": {"condition": {"type": "CUSTOM_FORMULA", "values": [{"userEnteredValue": "=FALSE"}]},
                                 "strict": True, "inputMessage": "Сначала выберите категорию в предыдущей колонке."}}})
            start, last_formula = r, formula
    for w in plan["product_writes"]:
        if w["col"] != col["id"] + 1 or not all(k in col for k in ("ostatok", "ostatok_1c", "reserve", "min_qty")):
            continue
        row = padded(snapshot["products"][w["row"] - 1], len(col))
        if row[col["ostatok"]] != "":
            continue
        n = w["row"]
        ref = lambda name: f"{letter(col[name] + 1)}{n}"
        unit, stock, reserve, minimum = [ref(k) for k in ("unit", "ostatok_1c", "reserve", "min_qty")]
        formula = (f'=IF({stock}="";0;LET(raw;{stock};reserve;IF({reserve}="";0;{reserve})/100;'
                   f'weighted;OR(LOWER({unit})="кг";LOWER({unit})="kg";LOWER({unit})="0,1";'
                   f'LOWER({unit})="0.1";LOWER({unit})="100 г";LOWER({unit})="100г";LOWER({unit})="100g");'
                   'safe;IF(weighted;ROUNDDOWN(MAX(0;raw*(1-reserve));1);ROUNDDOWN(MAX(0;raw*(1-reserve));0));'
                   f'IF(AND({minimum}<>"";safe<{minimum});0;safe)))')
        request = write_block(ids["products"], n - 1, col["ostatok"], [[""]])
        request["updateCells"]["rows"][0]["values"][0] = {"userEnteredValue": {"formulaValue": formula}}
        requests.append(request)
    requests.append({"updateDimensionProperties": {"range": {"sheetId": ids["categories"], "dimension": "COLUMNS", "startIndex": 2, "endIndex": 6},
                     "properties": {"hiddenByUser": True}, "fields": "hiddenByUser"}})
    requests.append({"updateCells": {"range": {"sheetId": ids["categories"], "startRowIndex": 0, "endRowIndex": 1, "startColumnIndex": 0, "endColumnIndex": 1},
        "rows": [{"values": [{"note": "Добавьте категорию и подкатегорию в A:B. Коды и списки обновляются автоматически, обычно за 15–30 секунд. " + ("; ".join(plan["errors"][:5]) if plan["errors"] else "Проверка завершена успешно.")}]}], "fields": "note"}})
    # Owner always retains access; the bot alone edits the technical fields.
    for name, bounds in ((REGISTRY, {}), ("_validation", {}), ("categories", {"startColumnIndex": 2, "endColumnIndex": 6}),
                         ("products", {"startColumnIndex": col["id"], "endColumnIndex": col["id"] + 1})):
        if not any(p.get("description") == PROTECTION for p in sheets[name].get("protectedRanges", [])):
            requests.append({"addProtectedRange": {"protectedRange": {"range": {"sheetId": ids[name], **bounds},
                "description": PROTECTION, "warningOnly": False, "editors": {"users": [service_email]}}}})
    return requests


def signature(snapshot):
    important = dict(categories=snapshot["categories"], registry=snapshot["registry"],
                     products=[padded(r, 8) for r in snapshot["products"]],
                     sizes=[s["properties"] for s in snapshot["metadata"]["sheets"] if s["properties"]["title"] in {"categories", "products", REGISTRY, "_validation"}])
    return hashlib.sha256(json.dumps(important, ensure_ascii=False, sort_keys=True).encode()).hexdigest()


def read_snapshot(api, spreadsheet_id):
    metadata = api.get(spreadsheetId=spreadsheet_id, fields="spreadsheetId,namedRanges,sheets(properties,protectedRanges)").execute()
    props = {s["properties"]["title"]: s["properties"] for s in metadata["sheets"]}
    for name in ("products", "categories"):
        if name not in props:
            raise ValueError(f"Нет листа {name}.")
    ranges = [f"categories!A1:F{props['categories']['gridProperties']['rowCount']}",
              f"products!A1:{letter(props['products']['gridProperties']['columnCount'])}{props['products']['gridProperties']['rowCount']}"]
    if REGISTRY in props:
        ranges.append(f"'{REGISTRY}'!A1:F{props[REGISTRY]['gridProperties']['rowCount']}")
    result = api.values().batchGet(spreadsheetId=spreadsheet_id, ranges=ranges, valueRenderOption="FORMULA").execute()["valueRanges"]
    return dict(metadata=metadata, categories=result[0].get("values", []), products=result[1].get("values", []),
                registry=result[2].get("values", []) if len(result) > 2 else [])


def sync_once(api, spreadsheet_id, service_email, *, dry_run=False, previous=None, backup_dir=None):
    snapshot = read_snapshot(api, spreadsheet_id)
    before_signature = signature(snapshot)
    if previous == before_signature:
        return before_signature, {"changed": False}
    plan = plan_changes(snapshot["categories"], snapshot["products"], snapshot["registry"])
    requests = build_requests(snapshot, plan, service_email)
    report = {"changed": True, "existing_ids": sum(bool(r and text(r[0])) for r in snapshot["products"][1:]),
              "new_ids": sum(w["col"] == 1 for w in plan["product_writes"]), "category_pairs": len(plan["definitions"]),
              "requests": len(requests), "warnings": plan["errors"][:5]}
    if dry_run:
        return before_signature, report
    if backup_dir and not snapshot["registry"]:
        folder = Path(backup_dir)
        folder.mkdir(parents=True, exist_ok=True)
        target = folder / f"categories-before-{time.time_ns()}.json"
        with target.open("x", encoding="utf-8") as stream:
            json.dump(snapshot, stream, ensure_ascii=False)
        target.chmod(0o600)
    # Optimistic guard against a user sorting/pasting during the read/plan interval.
    if signature(read_snapshot(api, spreadsheet_id)) != before_signature:
        raise ValueError("Таблица изменилась во время обработки; повтор на следующем проходе.")
    # IDs and durable reservations commit in one atomic Sheets batch.
    api.batchUpdate(spreadsheetId=spreadsheet_id, body={"requests": requests}).execute()
    after = read_snapshot(api, spreadsheet_id)
    before_ids = [padded(r, 8)[0] for r in snapshot["products"][1:]]
    after_ids = [padded(r, 8)[0] for r in after["products"][1:]]
    for i, old in enumerate(before_ids):
        if old and (i >= len(after_ids) or str(after_ids[i]) != str(old)):
            raise RuntimeError("Столбец ID изменился во время проверки. Требуется проверка владельцем.")
    # Return the committed expected signature, not arbitrary changes made by a person
    # between commit and readback, so concurrent newly-entered rows run next time.
    expected = copy.deepcopy(snapshot)
    expected["registry"] = plan["registry"]
    expected["metadata"] = after["metadata"]
    for name, writes in (("categories", plan["category_writes"]), ("products", plan["product_writes"])):
        for w in writes:
            expected[name][w["row"] - 1] = padded(expected[name][w["row"] - 1], max(len(expected[name][0]), w["col"]))
            expected[name][w["row"] - 1][w["col"] - 1] = w["value"]
    return signature(expected), report


def load_environment(path):
    if not path:
        return
    for line in Path(path).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, value = line.split("=", 1)
        tokens = shlex.split(value, comments=True)
        os.environ.setdefault(name.strip(), tokens[0] if tokens else "")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--spreadsheet-id", default=None)
    parser.add_argument("--env-file")
    parser.add_argument("--once", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    parser.add_argument("--interval", type=int, default=15)
    parser.add_argument("--backup-dir", default="/opt/ddmarket-import-bot/backups/categories")
    parser.add_argument("--lock-file", default="/run/ddmarket-category-sync.lock")
    args = parser.parse_args()
    load_environment(args.env_file)
    from google.oauth2 import service_account
    from googleapiclient.discovery import build
    import fcntl
    # Only this one worker writes IDs. A second invocation exits instead of racing.
    with open(args.lock_file, "w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        credentials_path = os.environ.get("DDMARKET_GOOGLE_SERVICE_ACCOUNT_JSON") or os.environ.get("GOOGLE_APPLICATION_CREDENTIALS")
        if not credentials_path:
            raise ValueError("Не настроены существующие Google credentials бота.")
        credentials = service_account.Credentials.from_service_account_file(credentials_path, scopes=["https://www.googleapis.com/auth/spreadsheets"])
        api = build("sheets", "v4", credentials=credentials, cache_discovery=False).spreadsheets()
        spreadsheet_id = args.spreadsheet_id or os.environ.get("DDMARKET_SPREADSHEET_ID") or DEFAULT_ID
        logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
        previous, last_repair, last_error = None, 0, None
        while True:
            try:
                # Periodic repair includes blank-row rules after structural edits.
                if time.monotonic() - last_repair > 300:
                    previous = None
                previous, report = sync_once(api, spreadsheet_id, credentials.service_account_email,
                    dry_run=args.dry_run, previous=previous, backup_dir=args.backup_dir)
                if report["changed"]:
                    logging.info("Category sync: %s", json.dumps(report, ensure_ascii=False))
                    last_repair = time.monotonic()
                last_error = None
                if args.once or args.dry_run:
                    return
            except Exception as error:
                message = str(error)
                if args.dry_run:
                    raise
                if message != last_error:
                    logging.error("Category sync stopped safely: %s", message)
                    # Visible diagnosis without altering user-entered category/product values.
                    try:
                        meta = api.get(spreadsheetId=spreadsheet_id, fields="sheets.properties").execute()
                        sid = next(s["properties"]["sheetId"] for s in meta["sheets"] if s["properties"]["title"] == "categories")
                        api.batchUpdate(spreadsheetId=spreadsheet_id, body={"requests": [{"updateCells": {
                            "range": {"sheetId":sid,"startRowIndex":0,"endRowIndex":1,"startColumnIndex":0,"endColumnIndex":1},
                            "rows":[{"values":[{"note":"DD Market: " + message[:1500]}]}],"fields":"note"}}]}).execute()
                    except Exception:
                        logging.error("Could not display diagnostic note.")
                    last_error = message
                previous = None
                if args.once or args.dry_run:
                    raise
            time.sleep(max(5, args.interval))


if __name__ == "__main__":
    main()
