from __future__ import annotations

import json
import copy
import hashlib
import logging
import os
import re
import time
import uuid
from dataclasses import dataclass, field
from pathlib import Path

import requests
from dotenv import load_dotenv

from import_merge import extract_consolidated_records, format_number
from sheets_update import (
    GoogleSheetsClient,
    SheetConflictError,
    PRICE_REVIEW_SHEET,
    analyze_consolidated_file,
    apply_consolidated_file,
    format_report_message,
    load_sheets_config,
    validate_ruchnoi_ostatok,
    write_report_workbook,
)


STATE_DIR = Path("temp/telegram-import-bot")
DOWNLOADS_DIR = STATE_DIR / "downloads"
RUNS_DIR = STATE_DIR / "runs"
STATE_PATH = STATE_DIR / "state.json"
MODE_CONSOLIDATED = "consolidated"
MODE_MANUAL_STOCK = "manual_stock"
SESSION_TIMEOUT_SECONDS = 30 * 60
STARTUP_API_ATTEMPTS = 3
STARTUP_RETRY_SECONDS = 5
POLL_BACKOFF_SECONDS = (5, 10, 20, 30, 60)
LONG_OUTAGE_SECONDS = 10 * 60
MAX_UPLOAD_BYTES = 15 * 1024 * 1024
TELEGRAM_PRICE_REVIEW_LIMIT = 15

MENU_MARKUP = {
    "inline_keyboard": [
        [{"text": "Загрузить отчёт 1С", "callback_data": "upload_consolidated"}],
        [{"text": "Ввести ручной остаток", "callback_data": "ostatok_x"}],
    ]
}
AFTER_FILE_MARKUP = {
    "inline_keyboard": [
        [{"text": "Проверить файл", "callback_data": "continue"}],
        [{"text": "Начать снова", "callback_data": "restart"}],
        [{"text": "Закрыть сессию", "callback_data": "close"}],
    ]
}
def approval_markup(report: dict) -> dict:
    buttons = [
        [{"text": "Применить безопасные строки", "callback_data": "apply_safe"}],
    ]
    if report.get("summary", {}).get("price_review_required", 0):
        buttons.append(
            [{"text": "Применить всё, включая цены >20%", "callback_data": "apply_all"}]
        )
    buttons.append([{"text": "Отмена", "callback_data": "cancel_apply"}])
    return {"inline_keyboard": buttons}


def approval_prompt(report: dict) -> str:
    review_count = report.get("summary", {}).get("price_review_required", 0)
    if review_count:
        rows = report.get("issues", {}).get("price_change_over_20_percent", [])
        lines = [f"Найдено цен с изменением больше 20%: {review_count}."]
        if rows:
            lines.extend(["", "Позиции для подтверждения:"])
            for index, row in enumerate(rows[:TELEGRAM_PRICE_REVIEW_LIMIT], start=1):
                name = str(row.get("name") or "Без названия").strip()
                if len(name) > 70:
                    name = name[:67].rstrip() + "..."
                barcode = str(row.get("barcode") or "без штрихкода").strip()
                lines.append(
                    f"{index}. {name} [{barcode}]: "
                    f"{row.get('current_price', '—')} → {row.get('incoming_price', '—')} "
                    f"({row.get('change', '—')})"
                )
        if review_count > TELEGRAM_PRICE_REVIEW_LIMIT:
            lines.extend(
                [
                    "",
                    f"Показаны первые {TELEGRAM_PRICE_REVIEW_LIMIT} из {review_count}. "
                    f"Перед подтверждением обязательно ознакомься с полным списком "
                    f"на вкладке «{PRICE_REVIEW_SHEET}» в Excel-отчёте.",
                ]
            )
        lines.extend(["", "Выбери безопасное применение или явно разреши эти цены."])
        return "\n".join(lines)
    return "Применить проверенные строки?"


MANUAL_STOCK_CANCEL_MARKUP = {
    "inline_keyboard": [[{"text": "Прервать", "callback_data": "manual_stock_cancel"}]]
}
MANUAL_STOCK_CONFIRM_MARKUP = {
    "inline_keyboard": [
        [{"text": "Подтвердить", "callback_data": "manual_stock_confirm"}],
        [{"text": "Прервать", "callback_data": "manual_stock_cancel"}],
    ]
}

logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO"), format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


def telegram_error_summary(error: Exception) -> str:
    response = getattr(error, "response", None)
    status_code = getattr(response, "status_code", None)
    return f"status={status_code}" if status_code else f"type={type(error).__name__}"


@dataclass
class ChatState:
    started_by_user_id: str | None = None
    expires_at: float | None = None
    mode: str | None = None
    prices_path: str | None = None
    barcodes_path: str | None = None
    merged_path: str | None = None
    prices_name: str | None = None
    barcodes_name: str | None = None
    merged_name: str | None = None
    pending_plan_path: str | None = None
    pending_report_path: str | None = None
    manual_stock_step: str | None = None
    manual_stock_suffix: str | None = None
    manual_stock_candidates: list[dict] = field(default_factory=list)
    manual_stock_selected: dict | None = None
    manual_stock_value: str | None = None
    callback_token: str | None = None
    pending_sheet_fingerprint: str | None = None
    pending_file_fingerprint: str | None = None


@dataclass
class BotState:
    chats: dict[str, ChatState] = field(default_factory=dict)
    next_update_id: int | None = None


class TelegramImportBot:
    def __init__(self, token: str, allowed_chat_id: str, bot_username: str | None = None):
        self.token = token
        self.allowed_chat_id = str(allowed_chat_id)
        username = bot_username or os.environ.get("DDMARKET_TELEGRAM_BOT_USERNAME")
        self.bot_username = username.lstrip("@") if username else None
        self.api_url = f"https://api.telegram.org/bot{token}"
        self.file_url = f"https://api.telegram.org/file/bot{token}"
        self.state = self.load_state()

    @staticmethod
    def load_state() -> BotState:
        if not STATE_PATH.exists():
            return BotState()
        raw = json.loads(STATE_PATH.read_text(encoding="utf-8"))
        chats = {}
        for old_key, value in raw.get("chats", {}).items():
            state = ChatState(**value)
            if not state.started_by_user_id:
                continue
            # Migrate the old group-wide session without giving it to another user.
            key = old_key if ":" in old_key else f"{old_key}:{state.started_by_user_id}"
            chats[key] = state
        return BotState(chats=chats, next_update_id=raw.get("next_update_id"))

    def save_state(self) -> None:
        STATE_DIR.mkdir(parents=True, exist_ok=True)
        temporary = STATE_PATH.with_suffix(".json.tmp")
        temporary.write_text(
            json.dumps({"version": 2, "next_update_id": self.state.next_update_id,
                        "chats": {key: state.__dict__ for key, state in self.state.chats.items()}}, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        temporary.chmod(0o600)
        temporary.replace(STATE_PATH)

    def api(self, method: str, **kwargs):
        try:
            response = requests.post(f"{self.api_url}/{method}", timeout=60, **kwargs)
        except requests.exceptions.RequestException as error:
            # requests exceptions include the bot token in the URL. Never propagate it.
            raise requests.exceptions.RequestException(f"Telegram {method}: {type(error).__name__}") from None
        try:
            payload = response.json()
        except ValueError:
            raise requests.exceptions.RequestException(f"Telegram {method}: invalid response", response=response) from None
        if response.status_code >= 400:
            raise requests.exceptions.HTTPError(f"Telegram {method}: HTTP {response.status_code}", response=response) from None
        if not payload.get("ok"):
            raise requests.exceptions.RequestException(f"Telegram {method}: API error", response=response)
        return payload["result"]

    def send_message(self, chat_id: str, text: str, reply_markup: dict | None = None, *, session: ChatState | None = None) -> dict:
        data = {"chat_id": chat_id, "text": text}
        if reply_markup:
            if session and reply_markup is not MENU_MARKUP:
                # Bind each workflow keyboard to its owner and the current step.
                session.callback_token = uuid.uuid4().hex[:12]
                self.touch_session(chat_id, session)
                reply_markup = copy.deepcopy(reply_markup)
                for row in reply_markup["inline_keyboard"]:
                    for button in row:
                        button["callback_data"] += f"|{session.started_by_user_id}|{session.callback_token}"
            data["reply_markup"] = json.dumps(reply_markup, ensure_ascii=False)
        for attempt in range(STARTUP_API_ATTEMPTS):
            try:
                return self.api("sendMessage", data=data)
            except requests.exceptions.RequestException as error:
                if attempt < STARTUP_API_ATTEMPTS - 1:
                    self.log_api_error("sendMessage", error, STARTUP_RETRY_SECONDS)
                    time.sleep(STARTUP_RETRY_SECONDS)
                    continue
                self.log_api_error("sendMessage", error)
                return {}

    def send_document(self, chat_id: str, path: Path, caption: str) -> None:
        with path.open("rb") as file:
            self.api("sendDocument", data={"chat_id": chat_id, "caption": caption}, files={"document": (path.name, file)})

    def answer_callback_query(self, callback_query_id: str, text: str | None = None) -> bool:
        data = {"callback_query_id": callback_query_id}
        if text:
            data.update(text=text, show_alert=True)
        try:
            self.api("answerCallbackQuery", data=data)
            return True
        except requests.exceptions.RequestException as error:
            self.log_api_error("answerCallbackQuery", error)
            # Expired/rejected callbacks must neither crash the poller nor perform writes.
            return False

    def log_api_error(self, method: str, error: Exception, retry_in: int | None = None) -> None:
        if retry_in is None:
            logger.warning("telegram api error method=%s %s", method, telegram_error_summary(error))
        else:
            logger.warning("telegram api error method=%s %s retry_in=%ss", method, telegram_error_summary(error), retry_in)

    def ensure_bot_username(self) -> None:
        if self.bot_username:
            return
        try:
            username = self.api("getMe").get("username")
            if username:
                self.bot_username = username
        except requests.exceptions.RequestException as error:
            self.log_api_error("getMe", error)

    def register_bot_commands(self) -> None:
        try:
            self.api(
                "setMyCommands",
                json={"commands": [{"command": "start", "description": "Открыть меню"}, {"command": "stop", "description": "Закрыть сессию"}]},
            )
        except requests.exceptions.RequestException as error:
            self.log_api_error("setMyCommands", error)

    def start_command(self) -> str:
        return f"/start@{self.bot_username}" if self.bot_username else "/start"

    def is_addressed_command(self, text: str, command: str, message: dict) -> bool:
        first_token = text.strip().split(maxsplit=1)[0].lower()
        bare = f"/{command}"
        chat_type = (message.get("chat") or {}).get("type")
        if chat_type not in {"group", "supergroup"}:
            return first_token == bare or (self.bot_username and first_token == f"{bare}@{self.bot_username.lower()}")
        return bool(self.bot_username and first_token == f"{bare}@{self.bot_username.lower()}")

    def begin_session(self, chat_id: str, user_id: str | int | None) -> ChatState:
        if user_id is None:
            raise ValueError("Telegram user ID is required")
        chat_state = ChatState(started_by_user_id=str(user_id) if user_id is not None else None)
        self.state.chats[self.session_key(chat_id, user_id)] = chat_state
        self.touch_session(chat_id, chat_state)
        return chat_state

    def touch_session(self, chat_id: str, chat_state: ChatState) -> None:
        chat_state.expires_at = time.time() + SESSION_TIMEOUT_SECONDS
        self.save_state()

    @staticmethod
    def session_key(chat_id: str, user_id: str | int | None) -> str:
        return f"{chat_id}:{user_id}"

    def clear_session(self, chat_id: str, user_id: str | int | None) -> None:
        self.state.chats.pop(self.session_key(chat_id, user_id), None)
        self.save_state()

    def get_chat_state(self, chat_id: str, user_id: str | int | None) -> ChatState:
        return self.state.chats.get(self.session_key(chat_id, user_id), ChatState())

    def start_manual_stock_flow(self, chat_id: str, chat_state: ChatState) -> None:
        chat_state.mode = MODE_MANUAL_STOCK
        chat_state.manual_stock_step = "barcode"
        chat_state.manual_stock_suffix = None
        chat_state.manual_stock_candidates = []
        chat_state.manual_stock_selected = None
        chat_state.manual_stock_value = None
        self.touch_session(chat_id, chat_state)
        self.send_message(
            chat_id,
            "Введи один штрихкод: только цифры, минимум 7 знаков. Можно ввести полный штрихкод.",
            reply_markup=MANUAL_STOCK_CANCEL_MARKUP, session=chat_state,
        )

    def cancel_manual_stock_flow(self, chat_id: str, user_id: str | int | None) -> None:
        self.begin_session(chat_id, user_id)
        self.send_message(chat_id, "Ввод ручного остатка прерван. Данные не менял.", reply_markup=MENU_MARKUP)

    @staticmethod
    def manual_stock_candidate_text(candidate: dict) -> str:
        name = str(candidate.get("name") or "Товар")
        short_name = name if len(name) <= 42 else f"{name[:39]}…"
        return f"{short_name} · {candidate.get('barcode', '')}"

    def manual_stock_candidates_markup(self, candidates: list[dict]) -> dict:
        return {
            "inline_keyboard": [
                *[
                    [{"text": self.manual_stock_candidate_text(candidate), "callback_data": f"manual_stock_select:{candidate['row_number']}"}]
                    for candidate in candidates
                ],
                [{"text": "Прервать", "callback_data": "manual_stock_cancel"}],
            ]
        }

    def select_manual_stock_candidate(self, chat_id: str, chat_state: ChatState, candidate: dict) -> None:
        chat_state.manual_stock_selected = candidate
        chat_state.manual_stock_value = None
        chat_state.manual_stock_step = "value"
        self.touch_session(chat_id, chat_state)
        current = candidate.get("ruchnoi_ostatok") or "пусто — работает расчёт 1С"
        self.send_message(
            chat_id,
            "Выбран товар:\n"
            f"{candidate.get('name') or 'Без названия'}\n"
            f"Штрихкод: {candidate.get('barcode')}\n"
            f"Текущий ручной остаток: {current}\n\n"
            "Введи новый ручной остаток от 0 до 1000. Для весового товара — с точностью до 0,1.",
            reply_markup=MANUAL_STOCK_CANCEL_MARKUP, session=chat_state,
        )

    def handle_manual_stock_text(self, chat_id: str, user_id: str | int | None, text: str) -> bool:
        chat_state = self.require_active_session(chat_id, user_id, notify=False)
        if not chat_state or chat_state.mode != MODE_MANUAL_STOCK:
            return False

        if chat_state.manual_stock_step == "barcode":
            if not re.fullmatch(r"\d{7,20}", text):
                self.send_message(
                    chat_id,
                    "Введите один штрихкод: только цифры, минимум 7 знаков. Несколько кодов за раз не принимаются.",
                    reply_markup=MANUAL_STOCK_CANCEL_MARKUP, session=chat_state,
                )
                return True
            config = load_sheets_config()
            if not config:
                self.send_message(chat_id, "На сервере не настроен доступ к Google Sheets.", reply_markup=MANUAL_STOCK_CANCEL_MARKUP, session=chat_state)
                return True
            try:
                candidates = GoogleSheetsClient(config).find_manual_stock_candidates(text)
            except Exception as error:
                logger.exception("manual stock candidate search failed")
                self.send_message(chat_id, f"Не смог найти товар: {error}", reply_markup=MANUAL_STOCK_CANCEL_MARKUP, session=chat_state)
                return True
            if not candidates:
                self.send_message(
                    chat_id,
                    "Товар с таким окончанием штрихкода среди опубликованных позиций не найден. Введи другой штрихкод.",
                    reply_markup=MANUAL_STOCK_CANCEL_MARKUP, session=chat_state,
                )
                return True
            if len(candidates) > 10:
                self.send_message(
                    chat_id,
                    "Найдено слишком много позиций. Введи больше цифр штрихкода.",
                    reply_markup=MANUAL_STOCK_CANCEL_MARKUP, session=chat_state,
                )
                return True
            chat_state.manual_stock_suffix = text
            chat_state.manual_stock_candidates = candidates
            self.touch_session(chat_id, chat_state)
            if len(candidates) == 1:
                self.select_manual_stock_candidate(chat_id, chat_state, candidates[0])
                return True
            self.send_message(
                chat_id,
                f"Найдено позиций: {len(candidates)}. Выбери нужную:",
                reply_markup=self.manual_stock_candidates_markup(candidates), session=chat_state,
            )
            return True

        if chat_state.manual_stock_step == "value":
            candidate = chat_state.manual_stock_selected
            if not candidate:
                self.send_message(chat_id, "Товар не выбран. Введи штрихкод заново.", reply_markup=MANUAL_STOCK_CANCEL_MARKUP, session=chat_state)
                self.start_manual_stock_flow(chat_id, chat_state)
                return True
            if not re.fullmatch(r"\d+(?:[.,]\d+)?", text):
                self.send_message(
                    chat_id,
                    "Введите одно число от 0 до 1000. Слова и несколько значений не принимаются.",
                    reply_markup=MANUAL_STOCK_CANCEL_MARKUP, session=chat_state,
                )
                return True
            quantity = validate_ruchnoi_ostatok(text, candidate.get("unit"))
            if isinstance(quantity, str):
                self.send_message(chat_id, quantity, reply_markup=MANUAL_STOCK_CANCEL_MARKUP, session=chat_state)
                return True
            chat_state.manual_stock_value = format_number(quantity)
            chat_state.manual_stock_step = "confirm"
            self.touch_session(chat_id, chat_state)
            self.send_message(
                chat_id,
                "Подтвердить ручной остаток?\n"
                f"Товар: {candidate.get('name') or 'Без названия'}\n"
                f"Штрихкод: {candidate.get('barcode')}\n"
                f"Новый ручной остаток: {chat_state.manual_stock_value}",
                reply_markup=MANUAL_STOCK_CONFIRM_MARKUP, session=chat_state,
            )
            return True

        self.send_message(chat_id, "Ожидаю подтверждение или кнопку «Прервать».", reply_markup=MANUAL_STOCK_CONFIRM_MARKUP, session=chat_state)
        return True

    def handle_manual_stock_confirmation(self, chat_id: str, user_id: str | int | None) -> None:
        chat_state = self.require_active_session(chat_id, user_id, notify=True)
        if not chat_state or chat_state.mode != MODE_MANUAL_STOCK:
            return
        candidate = chat_state.manual_stock_selected
        value = chat_state.manual_stock_value
        if chat_state.manual_stock_step != "confirm" or not candidate or value is None:
            self.send_message(chat_id, "Не хватает данных для подтверждения. Введи штрихкод заново.", reply_markup=MANUAL_STOCK_CANCEL_MARKUP, session=chat_state)
            self.start_manual_stock_flow(chat_id, chat_state)
            return
        config = load_sheets_config()
        if not config:
            self.send_message(chat_id, "На сервере не настроен доступ к Google Sheets.", reply_markup=MANUAL_STOCK_CANCEL_MARKUP, session=chat_state)
            return
        try:
            updated = GoogleSheetsClient(config).set_ruchnoi_ostatok(
                row_number=int(candidate["row_number"]),
                product_id=str(candidate["id"]),
                barcode=str(candidate["barcode"]),
                value=value,
                expected_value=candidate.get("ruchnoi_ostatok", ""),
                expected_unit=candidate.get("unit", ""),
            )
        except SheetConflictError as error:
            self.send_message(chat_id, str(error))
            self.start_manual_stock_flow(chat_id, chat_state)
            return
        except Exception as error:
            logger.exception("manual stock update failed")
            self.send_message(chat_id, f"Не смог установить ручной остаток: {error}", reply_markup=MANUAL_STOCK_CANCEL_MARKUP, session=chat_state)
            return
        self.begin_session(chat_id, user_id)
        self.send_message(
            chat_id,
            "Готово. Ручной остаток установлен:\n"
            f"{updated['name'] or 'Без названия'}\n"
            f"Штрихкод: {updated['barcode']}\n"
            f"Ручной остаток: {updated['ruchnoi_ostatok']}\n\n"
            "Данные 1С продолжают обновляться в фоне.",
            reply_markup=MENU_MARKUP,
        )

    def require_active_session(self, chat_id: str, user_id: str | int | None, notify: bool = False) -> ChatState | None:
        chat_state = self.get_chat_state(chat_id, user_id)
        caller = str(user_id) if user_id is not None else None
        if not chat_state.started_by_user_id:
            if notify:
                self.send_message(chat_id, f"Сеанс не начат. Напиши {self.start_command()}.")
            return None
        if chat_state.expires_at and time.time() > chat_state.expires_at:
            self.clear_session(chat_id, user_id)
            if notify:
                self.send_message(chat_id, f"Сеанс истёк. Начни заново: {self.start_command()}")
            return None
        if caller and caller != chat_state.started_by_user_id:
            if notify:
                self.send_message(chat_id, f"Начни свой сеанс: {self.start_command()}")
            return None
        return chat_state

    def download_document(self, document: dict, chat_id: str, user_id: str | int) -> Path:
        file_name = Path(document.get("file_name") or "report.xlsx").name
        file_info = self.api("getFile", data={"file_id": document["file_id"]})
        response = requests.get(f"{self.file_url}/{file_info['file_path']}", timeout=120)
        response.raise_for_status()
        target_dir = DOWNLOADS_DIR / chat_id / str(user_id)
        target_dir.mkdir(parents=True, exist_ok=True)
        target_path = target_dir / f"{uuid.uuid4().hex}-{file_name}"
        target_path.write_bytes(response.content)
        return target_path

    def handle_callback_query(self, callback_query: dict) -> None:
        message = callback_query.get("message") or {}
        chat_id = str((message.get("chat") or {}).get("id", ""))
        user_id = (callback_query.get("from") or {}).get("id")
        if chat_id != self.allowed_chat_id or user_id is None:
            return
        parts = str(callback_query.get("data", "")).split("|")
        action = parts[0]
        entry_actions = {"ostatok_x", "upload_consolidated", "upload_merged", "upload_sources"}
        if action not in entry_actions:
            state = self.require_active_session(chat_id, user_id)
            if len(parts) != 3 or parts[1] != str(user_id) or not state or parts[2] != state.callback_token:
                self.answer_callback_query(callback_query["id"], "Это чужая или устаревшая кнопка. Откройте свой сеанс через /start.")
                return
        if not self.answer_callback_query(callback_query["id"]):
            return
        if action == "ostatok_x":
            chat_state = self.require_active_session(chat_id, user_id) or self.begin_session(chat_id, user_id)
            self.start_manual_stock_flow(chat_id, chat_state)
            return
        if action == "manual_stock_cancel":
            if self.require_active_session(chat_id, user_id, notify=True):
                self.cancel_manual_stock_flow(chat_id, user_id)
            return
        if action and action.startswith("manual_stock_select:"):
            chat_state = self.require_active_session(chat_id, user_id, notify=True)
            if not chat_state or chat_state.mode != MODE_MANUAL_STOCK:
                return
            row_number = action.removeprefix("manual_stock_select:")
            candidate = next(
                (item for item in chat_state.manual_stock_candidates if str(item.get("row_number")) == row_number),
                None,
            )
            if not candidate:
                self.send_message(chat_id, "Список товаров устарел. Введи штрихкод заново.", reply_markup=MANUAL_STOCK_CANCEL_MARKUP, session=chat_state)
                self.start_manual_stock_flow(chat_id, chat_state)
                return
            self.select_manual_stock_candidate(chat_id, chat_state, candidate)
            return
        if action == "manual_stock_confirm":
            self.handle_manual_stock_confirmation(chat_id, user_id)
            return
        if action in {"upload_consolidated", "upload_merged", "upload_sources"}:
            chat_state = self.require_active_session(chat_id, user_id) or self.begin_session(chat_id, user_id)
            chat_state.mode = MODE_CONSOLIDATED
            chat_state.merged_path = None
            chat_state.merged_name = None
            chat_state.pending_plan_path = None
            chat_state.pending_report_path = None
            chat_state.pending_sheet_fingerprint = None
            chat_state.pending_file_fingerprint = None
            chat_state.callback_token = None
            self.touch_session(chat_id, chat_state)
            self.send_message(
                chat_id,
                "Пришли один XLSX-отчёт 1С «Остатки на складах». В нём должны быть наименование, штрихкод, розничная цена, «Основной → Количество» и «Итого → Количество».",
            )
            return
        if action == "restart":
            if self.require_active_session(chat_id, user_id, notify=True):
                self.begin_session(chat_id, user_id)
                self.send_message(chat_id, "Начинаем заново. Нажми кнопку и пришли один отчёт 1С.", reply_markup=MENU_MARKUP)
            return
        if action == "close":
            if self.require_active_session(chat_id, user_id, notify=True):
                self.clear_session(chat_id, user_id)
                self.send_message(chat_id, "Сессия закрыта.")
            return
        if action == "continue":
            if self.require_active_session(chat_id, user_id, notify=True):
                self.handle_continue(chat_id, user_id)
            return
        if action in {"apply_confirm", "apply_safe", "apply_all"}:
            if self.require_active_session(chat_id, user_id, notify=True):
                self.handle_apply(
                    chat_id,
                    allow_large_price_changes=action == "apply_all",
                    confirmed_by_user_id=user_id,
                )
            return
        if action == "cancel_apply":
            if self.require_active_session(chat_id, user_id, notify=True):
                self.clear_session(chat_id, user_id)
                self.send_message(chat_id, "Отменено. Google Sheets не менял.")

    def handle_document(self, chat_id: str, document: dict, user_id: str | int | None) -> None:
        chat_state = self.require_active_session(chat_id, user_id, notify=True)
        if not chat_state:
            return
        if chat_state.mode != MODE_CONSOLIDATED:
            self.send_message(chat_id, "Сначала нажми «Загрузить отчёт 1С».")
            return
        file_name = document.get("file_name", "")
        if not file_name.lower().endswith(".xlsx"):
            self.send_message(chat_id, "Нужен только XLSX-файл.")
            return
        if document.get("file_size", 0) > MAX_UPLOAD_BYTES:
            self.send_message(chat_id, "Файл больше 15 МБ. Пришли выгрузку без лишних листов.")
            return
        self.touch_session(chat_id, chat_state)
        path = self.download_document(document, chat_id, user_id)
        try:
            records = extract_consolidated_records(path)
        except ValueError as error:
            self.send_message(chat_id, f"Файл не соответствует шаблону 1С: {error}")
            return
        chat_state.merged_path = str(path)
        chat_state.merged_name = file_name
        chat_state.pending_sheet_fingerprint = None
        chat_state.pending_file_fingerprint = None
        self.touch_session(chat_id, chat_state)
        self.send_message(
            chat_id,
            f"Файл соответствует шаблону: {file_name}. Товарных строк: {len(records)}. Теперь проверю его против Google Sheets.",
            reply_markup=AFTER_FILE_MARKUP, session=chat_state,
        )

    def handle_continue(self, chat_id: str, user_id: str | int) -> None:
        chat_state = self.get_chat_state(chat_id, user_id)
        path = Path(chat_state.merged_path or "")
        if not path.is_file():
            self.send_message(chat_id, "Файл этой сессии не найден. Пришли его заново.")
            return
        config = load_sheets_config()
        if not config:
            self.send_message(chat_id, "На сервере не настроен доступ к Google Sheets.")
            return
        try:
            client = GoogleSheetsClient(config)
            _headers, report = analyze_consolidated_file(path, client)
            client.write_import_report(report)
        except Exception as error:
            logger.exception("google sheets analysis failed")
            self.send_message(chat_id, f"Не смог проверить файл: {error}")
            return
        report_path = RUNS_DIR / chat_id / str(user_id) / uuid.uuid4().hex / "inventory-import-report.xlsx"
        write_report_workbook(report, report_path)
        chat_state.pending_report_path = str(report_path)
        chat_state.pending_sheet_fingerprint = report["sheet_fingerprint"]
        chat_state.pending_file_fingerprint = hashlib.sha256(path.read_bytes()).hexdigest()
        self.touch_session(chat_id, chat_state)
        self.send_message(chat_id, format_report_message(report))
        self.send_document(chat_id, report_path, "Полный отчёт проверки.")
        if report["fatal_errors"]:
            self.send_message(chat_id, "Ничего не применял. Пришли полный корректный файл и проверь отчёт.", reply_markup=AFTER_FILE_MARKUP, session=chat_state)
            return
        self.send_message(
            chat_id,
            approval_prompt(report),
            reply_markup=approval_markup(report), session=chat_state,
        )

    def handle_apply(
        self,
        chat_id: str,
        *,
        allow_large_price_changes: bool = False,
        confirmed_by_user_id: str | int | None = None,
    ) -> None:
        chat_state = self.get_chat_state(chat_id, confirmed_by_user_id)
        path = Path(chat_state.merged_path or "")
        if not path.is_file():
            self.send_message(chat_id, "Файл этой сессии не найден. Пришли его заново.")
            return
        if (not chat_state.pending_sheet_fingerprint or not chat_state.pending_file_fingerprint
                or hashlib.sha256(path.read_bytes()).hexdigest() != chat_state.pending_file_fingerprint):
            self.send_message(chat_id, "Сначала проверь этот файл заново.", reply_markup=AFTER_FILE_MARKUP, session=chat_state)
            return
        config = load_sheets_config()
        if not config:
            self.send_message(chat_id, "На сервере не настроен доступ к Google Sheets.")
            return
        try:
            client = GoogleSheetsClient(config)
            logger.info(
                "applying import chat_id=%s user_id=%s allow_large_price_changes=%s",
                chat_id,
                confirmed_by_user_id,
                allow_large_price_changes,
            )
            _headers, report, applied_rows = apply_consolidated_file(
                path,
                client,
                allow_large_price_changes=allow_large_price_changes,
                expected_fingerprint=chat_state.pending_sheet_fingerprint,
            )
            client.write_import_report(report, applied=not report["fatal_errors"])
        except SheetConflictError as error:
            chat_state.pending_sheet_fingerprint = None
            self.send_message(chat_id, str(error), reply_markup=AFTER_FILE_MARKUP, session=chat_state)
            return
        except Exception as error:
            logger.exception("google sheets apply failed")
            self.send_message(chat_id, f"Не смог применить импорт: {error}")
            return
        if report["fatal_errors"]:
            self.send_message(chat_id, "Таблица изменилась после проверки или файл недостаточно полный. Импорт не выполнен.\n\n" + format_report_message(report))
            return
        self.clear_session(chat_id, confirmed_by_user_id)
        confirmed_prices = report["summary"].get("price_review_applied", 0)
        self.send_message(
            chat_id,
            f"Готово. Обновлено строк в Google Sheets: {applied_rows}. "
            f"Подтверждено цен >20%: {confirmed_prices}.",
        )

    def handle_message(self, message: dict) -> None:
        chat_id = str(message["chat"]["id"])
        user_id = (message.get("from") or {}).get("id")
        if chat_id != self.allowed_chat_id or user_id is None:
            return
        raw_text = str(message.get("text", "")).strip()
        text = raw_text.lower()
        if text and (self.is_addressed_command(text, "start", message) or self.is_addressed_command(text, "help", message)):
            self.begin_session(chat_id, user_id)
            self.send_message(chat_id, "Пришли один консолидированный XLSX-отчёт 1С.", reply_markup=MENU_MARKUP)
            return
        if text and self.is_addressed_command(text, "stop", message):
            self.clear_session(chat_id, user_id)
            self.send_message(chat_id, "Сессия закрыта.")
            return
        if raw_text and self.handle_manual_stock_text(chat_id, user_id, raw_text):
            return
        if "document" in message:
            self.handle_document(chat_id, message["document"], user_id)

    def process_update(self, update: dict) -> bool:
        update_id = int(update["update_id"])
        if self.state.next_update_id is not None and update_id < self.state.next_update_id:
            return False
        # Persist before dispatch: after an uncertain write/restart, never replay it.
        # The next incoming user action can re-read the real sheet and retry safely.
        self.state.next_update_id = update_id + 1
        self.save_state()
        try:
            if update.get("callback_query"):
                self.handle_callback_query(update["callback_query"])
            elif update.get("message"):
                self.handle_message(update["message"])
        except Exception as error:
            logger.error("update failed update_id=%s %s", update_id, telegram_error_summary(error))
        return True

    def poll(self) -> None:
        outage_started_at: float | None = None
        backoff_index = 0
        logger.info("bot polling started allowed_chat_id=%s", self.allowed_chat_id)
        self.ensure_bot_username()
        self.register_bot_commands()
        while True:
            params = {"timeout": 30}
            if self.state.next_update_id is not None:
                params["offset"] = self.state.next_update_id
            try:
                updates = self.api("getUpdates", data=params)
            except requests.exceptions.RequestException as error:
                outage_started_at = outage_started_at or time.time()
                retry_in = POLL_BACKOFF_SECONDS[min(backoff_index, len(POLL_BACKOFF_SECONDS) - 1)]
                backoff_index += 1
                self.log_api_error("getUpdates", error, retry_in)
                time.sleep(retry_in)
                continue
            if outage_started_at and time.time() - outage_started_at >= LONG_OUTAGE_SECONDS:
                self.send_message(self.allowed_chat_id, "Связь с Telegram восстановлена.")
            outage_started_at = None
            backoff_index = 0
            for update in updates:
                self.process_update(update)


def main() -> None:
    load_dotenv()
    token = os.environ.get("DDMARKET_TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("DDMARKET_TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        raise SystemExit("Set DDMARKET_TELEGRAM_BOT_TOKEN and DDMARKET_TELEGRAM_CHAT_ID.")
    # One poller/serial writer only, including manual command-line launches.
    import fcntl
    STATE_DIR.mkdir(parents=True, exist_ok=True)
    with (STATE_DIR / "process.lock").open("w") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        TelegramImportBot(token=token, allowed_chat_id=chat_id, bot_username=os.environ.get("DDMARKET_TELEGRAM_BOT_USERNAME")).poll()


if __name__ == "__main__":
    main()
