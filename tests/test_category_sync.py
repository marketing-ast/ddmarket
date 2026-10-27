import copy
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("category_sync", Path(__file__).parents[1] / "scripts/category_sync.py")
sync = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sync)

HEAD = ["id", "publish", "barcode", "name", "name1s", "unit", "category0", "category1", "price", "ostatok", "sale", "image", "comment", "ostatok_1c", "reserve", "min_qty", "ruchnoi_ostatok"]


def cat(parent="FOOD", child="FRUIT", p="01", order0=1, order1=1):
    return [parent, child, p, p + "0000", order0, order1]


def product(ident="010001", parent="FOOD", child="FRUIT", name="Apple", barcode="123456789"):
    return [ident, "yes", barcode, name, "", "шт", parent, child, 100, 5]


def apply(rows, writes):
    result = copy.deepcopy(rows)
    for w in writes:
        result[w["row"] - 1] = sync.padded(result[w["row"] - 1], len(rows[0]))
        result[w["row"] - 1][w["col"] - 1] = w["value"]
    return result


class CategorySyncTest(unittest.TestCase):
    def setUp(self):
        self.cats = [sync.CAT_HEADERS, cat()]
        self.products = [HEAD, product()]

    def plan(self, cats=None, products=None, registry=None):
        return sync.plan_changes(cats or self.cats, products or self.products, registry or [])

    def test_initial_and_repeated_sync_leave_existing_data_untouched(self):
        first = self.plan()
        self.assertEqual(first["category_writes"], [])
        self.assertEqual(first["product_writes"], [])
        second = self.plan(registry=first["registry"])
        self.assertEqual(first["registry"], second["registry"])
        self.assertEqual(second["product_writes"], [])

    def test_bulk_new_pairs_assign_unique_codes_and_order(self):
        rows = self.cats + [["PETS", "CATS"], ["PETS", "DOGS"], ["FOOD", "SAUCES"]]
        result = apply(rows, self.plan(cats=rows)["category_writes"])
        self.assertEqual(result[2], ["PETS", "CATS", "02", "020000", 2, 1])
        self.assertEqual(result[3], ["PETS", "DOGS", "03", "030000", 2, 2])
        self.assertEqual(result[4], ["FOOD", "SAUCES", "04", "040000", 1, 2])

    def test_sort_and_product_move_keep_ids(self):
        cats = self.cats + [cat("PETS", "CATS", "02", 2, 1)]
        rows = self.products + [product(""), product("", "PETS", "CATS")]
        plan = self.plan(cats, rows)
        result = apply(rows, plan["product_writes"])
        self.assertEqual([r[0] for r in result[1:]], ["010001", "010002", "020001"])
        result[2][6:8] = ["PETS", "CATS"]
        again = self.plan([cats[0]] + cats[1:][::-1], [result[0]] + result[1:][::-1], plan["registry"])
        self.assertFalse(any(w["col"] == 1 for w in again["product_writes"]))

    def test_deleted_numbers_are_reserved_forever(self):
        first = self.plan(self.cats + [cat("PETS", "CATS", "02", 2, 1)], self.products + [product("010099"), product("020050", "PETS", "CATS")])
        second = self.plan(self.cats + [["NEW", "NEW"]], self.products + [product("")], first["registry"])
        self.assertEqual(next(w["value"] for w in second["product_writes"] if w["col"] == 1), "010100")
        self.assertEqual(second["definitions"][1]["prefix"], "03")

    def test_unknown_commit_result_is_idempotent(self):
        cats = self.cats + [["NEW", "NEW"]]
        rows = self.products + [product("", "NEW", "NEW")]
        first = self.plan(cats, rows)
        again = self.plan(apply(cats, first["category_writes"]), apply(rows, first["product_writes"]), first["registry"])
        self.assertFalse(again["category_writes"])
        self.assertFalse(again["product_writes"])

    def test_partial_legacy_reservation_skips_id_safely(self):
        cats = self.cats + [["NEW", "NEW"]]
        rows = self.products + [product("", "NEW", "NEW")]
        first = self.plan(cats, rows)
        again = self.plan(cats, rows, first["registry"])
        self.assertEqual(again["definitions"][1]["prefix"], "02")
        self.assertEqual(next(w["value"] for w in again["product_writes"] if w["col"] == 1), "020002")

    def test_duplicate_ids_stop_plan(self):
        with self.assertRaisesRegex(ValueError, "Повтор ID"):
            self.plan(products=self.products + [product()])

    def test_duplicate_names_are_case_and_space_insensitive(self):
        with self.assertRaisesRegex(ValueError, "Повтор категории"):
            self.plan(cats=self.cats + [[" food ", " FRUIT "]])

    def test_same_child_is_allowed_under_distinct_parents(self):
        self.assertEqual(len(self.plan(cats=self.cats + [["PETS", "FRUIT"]])["definitions"]), 2)

    def test_incomplete_input_waits_without_id_assignment(self):
        plan = self.plan(self.cats + [["PETS", ""]], self.products + [product("", barcode="")])
        self.assertFalse(plan["category_writes"])
        self.assertFalse(plan["product_writes"])

    def test_reserved_draft_ids_count_toward_sequence(self):
        reserve = product("010100")
        reserve[1] = "no"
        plan = self.plan(products=self.products + [reserve, product("")])
        self.assertEqual(next(w["value"] for w in plan["product_writes"] if w["col"] == 1), "010101")

    def test_exhaustion_fails_instead_of_reusing_ids(self):
        with self.assertRaisesRegex(ValueError, "Закончились ID"):
            self.plan(products=[HEAD, product("019999"), product("")])
        with self.assertRaisesRegex(ValueError, "99 префиксов"):
            self.plan(self.cats + [["NEW", "NEW"]], [HEAD, product("990001")])

    def test_existing_pair_rename_rejected(self):
        first = self.plan()
        with self.assertRaisesRegex(ValueError, "переименования"):
            self.plan([sync.CAT_HEADERS, cat("RENAMED")], registry=first["registry"])

    def test_new_product_defaults_to_draft(self):
        row = product("")
        row[1] = ""
        plan = self.plan(products=[HEAD, row])
        self.assertEqual(next(w["value"] for w in plan["product_writes"] if w["col"] == 2), "no")

    def snapshot(self):
        return dict(categories=self.cats, products=self.products, registry=[], metadata={"sheets": [
            {"properties": {"title": "categories", "sheetId": 1001, "gridProperties": {"rowCount": 100, "columnCount": 6}}},
            {"properties": {"title": "products", "sheetId": 0, "gridProperties": {"rowCount": 10, "columnCount": 18}}},
            {"properties": {"title": "_validation", "sheetId": 1003, "gridProperties": {"rowCount": 20, "columnCount": 12}}},
        ]})

    def test_batch_protects_ids_and_does_not_write_existing_product_cells(self):
        requests = sync.build_requests(self.snapshot(), self.plan(), "bot@example.com")
        writes = [r["updateCells"] for r in requests if "updateCells" in r]
        self.assertFalse(any(w["range"]["sheetId"] == 0 for w in writes))
        protections = [r["addProtectedRange"]["protectedRange"] for r in requests if "addProtectedRange" in r]
        self.assertTrue(any(p["range"] == {"sheetId": 0, "startColumnIndex": 0, "endColumnIndex": 1} for p in protections))
        self.assertTrue(any("addSheet" in r and r["addSheet"]["properties"]["hidden"] for r in requests))

    def test_dependent_rules_cover_every_row_and_no_broken_references(self):
        requests = sync.build_requests(self.snapshot(), self.plan(), "bot@example.com")
        rules = [r["setDataValidation"] for r in requests if "setDataValidation" in r]
        sub = [r for r in rules if r["range"]["sheetId"] == 0 and r["range"]["startColumnIndex"] == 7]
        covered = [i for rule in sub for i in range(rule["range"]["startRowIndex"], rule["range"]["endRowIndex"])]
        self.assertEqual(covered, list(range(1, 10)))
        self.assertNotIn("#REF!", str(rules))
        self.assertEqual(sub[-1]["rule"]["condition"]["type"], "CUSTOM_FORMULA")

    def test_formula_only_added_for_new_id_with_empty_stock(self):
        snapshot = self.snapshot()
        row = product("")
        row[9] = ""
        snapshot["products"] = self.products + [row]
        plan = self.plan(products=snapshot["products"])
        requests = sync.build_requests(snapshot, plan, "bot@example.com")
        formulas = [r["updateCells"] for r in requests if "updateCells" in r and "formulaValue" in str(r)]
        self.assertEqual(len(formulas), 1)
        self.assertEqual(formulas[0]["range"]["startRowIndex"], 2)
        self.assertIn('N3', formulas[0]["rows"][0]["values"][0]["userEnteredValue"]["formulaValue"])

    def test_price_and_stock_changes_do_not_trigger_id_processing(self):
        snapshot = self.snapshot()
        other = copy.deepcopy(snapshot)
        other["products"][1][8:10] = [777, 4]
        self.assertEqual(sync.signature(snapshot), sync.signature(other))
        other["products"][1][7] = "NEW"
        self.assertNotEqual(sync.signature(snapshot), sync.signature(other))


if __name__ == "__main__":
    unittest.main()
