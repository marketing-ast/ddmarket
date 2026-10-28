"""Regression tests for staff isolation, callbacks, replay and competing sheet writes."""
import copy
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import telegram_import_bot as botmod
import sheets_update as sheets

CHAT = "-100123"
HEADERS = ["id", "publish", "barcode", "name", "name1s", "unit", "category0", "category1",
           "price", "ostatok", "sale", "image", "comment", "ostatok_1c", "reserve", "min_qty", "ruchnoi_ostatok"]
VALUES = [HEADERS, ["010001", "yes", "2000000177625", "Картофель", "Картофель", "кг", "ОВОЩИ", "ОВОЩИ", 149, 10, "no", "", "", 10, 0, 0, ""]]


def callback(user, data, query_id="q1"):
    return {"id": query_id, "from": {"id": user}, "message": {"chat": {"id": CHAT}}, "data": data}


def message(user, text):
    return {"chat": {"id": CHAT, "type": "supergroup"}, "from": {"id": user}, "text": text}


class BotTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        for name, value in {"STATE_DIR": root, "STATE_PATH": root / "state.json",
                            "DOWNLOADS_DIR": root / "downloads", "RUNS_DIR": root / "runs"}.items():
            p = patch.object(botmod, name, value)
            p.start()
            self.addCleanup(p.stop)
        self.bot = botmod.TelegramImportBot("fake-token", CHAT, "test_bot")
        self.bot.api = Mock(return_value={"message_id": 1})

    def buttons(self):
        for call in reversed(self.bot.api.call_args_list):
            if call.args[0] == "sendMessage" and "reply_markup" in call.kwargs["data"]:
                return json.loads(call.kwargs["data"]["reply_markup"])["inline_keyboard"]
        self.fail("No keyboard sent")

    def test_two_staff_start_independent_sessions(self):
        self.bot.handle_message(message(11, "/start@test_bot"))
        first = self.bot.require_active_session(CHAT, 11)
        self.bot.handle_message(message(22, "/start@test_bot"))
        self.assertIs(self.bot.require_active_session(CHAT, 11), first)
        self.assertIsNotNone(self.bot.require_active_session(CHAT, 22))
        self.assertEqual(len(self.bot.state.chats), 2)

    def test_shared_menu_starts_own_session_without_blocking_other_staff(self):
        self.bot.handle_callback_query(callback(11, "ostatok_x"))
        first = self.bot.require_active_session(CHAT, 11)
        self.bot.handle_callback_query(callback(22, "ostatok_x", "q2"))
        self.assertEqual(first.manual_stock_step, "barcode")
        self.assertEqual(self.bot.require_active_session(CHAT, 22).manual_stock_step, "barcode")

    def test_stop_and_expiry_affect_only_the_caller(self):
        a = self.bot.begin_session(CHAT, 11)
        b = self.bot.begin_session(CHAT, 22)
        a.expires_at = 1
        self.assertIsNone(self.bot.require_active_session(CHAT, 11))
        self.assertIs(self.bot.require_active_session(CHAT, 22), b)
        self.bot.begin_session(CHAT, 11)
        self.bot.handle_message(message(11, "/stop@test_bot"))
        self.assertIs(self.bot.require_active_session(CHAT, 22), b)

    def test_foreign_and_stale_buttons_cannot_confirm(self):
        state = self.bot.begin_session(CHAT, 11)
        self.bot.send_message(CHAT, "Confirm", botmod.MANUAL_STOCK_CONFIRM_MARKUP, session=state)
        old = self.buttons()[0][0]["callback_data"]
        self.bot.handle_manual_stock_confirmation = Mock()
        self.bot.begin_session(CHAT, 22)
        self.bot.handle_callback_query(callback(22, old))
        self.bot.send_message(CHAT, "New confirm", botmod.MANUAL_STOCK_CONFIRM_MARKUP, session=state)
        current = self.buttons()[0][0]["callback_data"]
        self.bot.handle_callback_query(callback(11, old))
        self.bot.handle_callback_query(callback(11, "manual_stock_confirm"))
        self.bot.handle_manual_stock_confirmation.assert_not_called()
        self.bot.handle_callback_query(callback(11, current))
        self.bot.handle_manual_stock_confirmation.assert_called_once_with(CHAT, 11)

    def test_expired_telegram_callback_does_not_crash_or_start_work(self):
        response = Mock(status_code=400)
        self.bot.api.side_effect = botmod.requests.exceptions.HTTPError("expired", response=response)
        self.bot.handle_callback_query(callback(11, "ostatok_x"))
        self.assertFalse(self.bot.state.chats)

    def test_duplicate_update_is_not_replayed_after_restart(self):
        self.bot.handle_message = Mock()
        update = {"update_id": 123, "message": message(11, "/start@test_bot")}
        self.assertTrue(self.bot.process_update(update))
        self.assertFalse(self.bot.process_update(update))
        restarted = botmod.TelegramImportBot("fake", CHAT, "test_bot")
        restarted.handle_message = Mock()
        self.assertFalse(restarted.process_update(update))
        restarted.handle_message.assert_not_called()
        self.bot.handle_message.assert_called_once()

    def test_failed_update_does_not_poison_next_update(self):
        self.bot.handle_message = Mock(side_effect=[RuntimeError("failure"), None])
        self.bot.process_update({"update_id": 1, "message": message(11, "a")})
        self.bot.process_update({"update_id": 2, "message": message(22, "b")})
        self.assertEqual(self.bot.state.next_update_id, 3)
        self.assertEqual(self.bot.handle_message.call_count, 2)

    def test_legacy_group_session_migrates_only_to_its_owner(self):
        botmod.STATE_PATH.write_text(json.dumps({"chats": {CHAT: {"started_by_user_id": "11", "mode": "manual_stock", "expires_at": 9999999999}}}), encoding="utf-8")
        restored = botmod.TelegramImportBot("fake", CHAT, "test_bot")
        self.assertEqual(restored.require_active_session(CHAT, 11).mode, "manual_stock")
        self.assertIsNone(restored.require_active_session(CHAT, 22))

    def test_ordinary_group_messages_do_not_produce_session_refusals(self):
        self.bot.begin_session(CHAT, 11)
        self.bot.handle_message(message(22, "Добрый день"))
        self.bot.api.assert_not_called()

    def test_same_named_uploads_have_distinct_owner_paths(self):
        self.bot.api.return_value = {"file_path": "document.xlsx"}
        response = Mock(content=b"test")
        with patch.object(botmod.requests, "get", return_value=response):
            doc = {"file_id": "x", "file_name": "report.xlsx"}
            a = self.bot.download_document(doc, CHAT, 11)
            b = self.bot.download_document(doc, CHAT, 22)
            c = self.bot.download_document(doc, CHAT, 11)
        self.assertEqual(len({a, b, c}), 3)
        self.assertEqual(a.parent.name, "11")
        self.assertEqual(b.parent.name, "22")

    def test_sensitive_api_url_is_not_exposed_in_exceptions(self):
        real_api = botmod.TelegramImportBot.api.__get__(self.bot)
        response = Mock(status_code=400)
        response.json.return_value = {"ok": False}
        with patch.object(botmod.requests, "post", return_value=response):
            with self.assertRaises(botmod.requests.exceptions.HTTPError) as caught:
                real_api("answerCallbackQuery", data={})
        self.assertNotIn("fake-token", str(caught.exception))
        self.assertNotIn("https://", str(caught.exception))

    def test_keyboard_callback_fits_telegram_limit(self):
        state = self.bot.begin_session(CHAT, 1234567890123)
        self.bot.send_message(CHAT, "choose", self.bot.manual_stock_candidates_markup([{"row_number": 10000000}]), session=state)
        for row in self.buttons():
            self.assertLessEqual(len(row[0]["callback_data"].encode()), 64)

    def test_pending_import_requires_original_reviewed_file(self):
        state = self.bot.begin_session(CHAT, 11)
        path = Path(self.tmp.name) / "report.xlsx"
        path.write_bytes(b"original")
        state.merged_path = str(path)
        state.pending_sheet_fingerprint = "reviewed"
        state.pending_file_fingerprint = hashlib.sha256(b"other file").hexdigest()
        with patch.object(botmod, "apply_consolidated_file") as apply:
            self.bot.handle_apply(CHAT, confirmed_by_user_id=11)
            apply.assert_not_called()


class SheetRaceTests(unittest.TestCase):
    def client(self, snapshots):
        client = object.__new__(sheets.GoogleSheetsClient)
        client.spreadsheet_id = "test-copy"
        client.service = Mock()
        client.get_product_values = Mock(side_effect=copy.deepcopy(snapshots))
        return client

    def manual(self, client, value=5):
        return client.set_ruchnoi_ostatok(2, "010001", "2000000177625", value, expected_value="", expected_unit="кг")

    def test_second_staff_confirmation_cannot_overwrite_first(self):
        changed = copy.deepcopy(VALUES)
        changed[1][16] = 7
        client = self.client([changed])
        with self.assertRaises(sheets.SheetConflictError):
            self.manual(client)
        client.service.spreadsheets.assert_not_called()

    def test_row_moved_or_replaced_before_confirmation_is_rejected(self):
        changed = copy.deepcopy(VALUES)
        changed[1][0] = "020002"
        client = self.client([changed])
        with self.assertRaises(sheets.SheetConflictError):
            self.manual(client)
        client.service.spreadsheets.assert_not_called()

    def test_change_between_read_and_write_is_rejected(self):
        changed = copy.deepcopy(VALUES)
        changed[1][16] = 7
        client = self.client([VALUES, changed])
        with self.assertRaises(sheets.SheetConflictError):
            self.manual(client)
        client.service.spreadsheets.assert_not_called()

    def test_manual_write_targets_only_manual_column_and_verifies_result(self):
        after = copy.deepcopy(VALUES)
        after[1][16] = 5
        client = self.client([VALUES, VALUES, after])
        result = self.manual(client)
        update = client.service.spreadsheets().values().update
        self.assertEqual(update.call_args.kwargs["range"], "products!Q2")
        self.assertEqual(result["ruchnoi_ostatok"], "5")

    def test_uncertain_result_does_not_report_success_or_retry(self):
        client = self.client([VALUES, VALUES, VALUES])
        with self.assertRaises(sheets.SheetConflictError):
            self.manual(client)
        self.assertEqual(client.service.spreadsheets().values().update.call_count, 1)

    def test_second_import_rejects_changes_since_its_review(self):
        changed = copy.deepcopy(VALUES)
        changed[1][8] = 200
        client = self.client([changed])
        with self.assertRaises(sheets.SheetConflictError):
            sheets.apply_consolidated_file("unused.xlsx", client, expected_fingerprint=sheets.product_snapshot_fingerprint(VALUES))
        client.service.spreadsheets.assert_not_called()

    def test_reviewed_import_applies_only_if_snapshot_remains_current(self):
        client = self.client([VALUES, VALUES, VALUES])
        client.ensure_ostatok_formulas = Mock()
        client.apply_updates = Mock(return_value=1)
        report = {"fatal_errors": [], "updates": [{"row_number": 2}]}
        with patch.object(sheets, "extract_consolidated_records", return_value=[]), patch.object(sheets, "build_update_report", return_value=(HEADERS, report)):
            _, _, count = sheets.apply_consolidated_file("unused.xlsx", client, expected_fingerprint=sheets.product_snapshot_fingerprint(VALUES))
        self.assertEqual(count, 1)
        client.apply_updates.assert_called_once_with(HEADERS, report)

    def test_import_change_during_preparation_blocks_price_and_stock_writes(self):
        changed = copy.deepcopy(VALUES)
        changed[1][13] = 88
        client = self.client([VALUES, changed])
        client.ensure_ostatok_formulas = Mock()
        client.apply_updates = Mock()
        with patch.object(sheets, "extract_consolidated_records", return_value=[]), patch.object(sheets, "build_update_report", return_value=(HEADERS, {"fatal_errors": []})):
            with self.assertRaises(sheets.SheetConflictError):
                sheets.apply_consolidated_file("unused.xlsx", client, expected_fingerprint=sheets.product_snapshot_fingerprint(VALUES))
        client.ensure_ostatok_formulas.assert_not_called()
        client.apply_updates.assert_not_called()

    def test_fingerprint_detects_identity_and_manual_edits_but_not_derived_stock(self):
        before = sheets.product_snapshot_fingerprint(VALUES)
        for column in (0, 2, 5, 8, 13, 16):
            changed = copy.deepcopy(VALUES)
            changed[1][column] = "changed"
            self.assertNotEqual(before, sheets.product_snapshot_fingerprint(changed))
        changed = copy.deepcopy(VALUES)
        changed[1][9] = 99
        self.assertEqual(before, sheets.product_snapshot_fingerprint(changed))


if __name__ == "__main__":
    unittest.main()
