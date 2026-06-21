# Site Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the existing `site_promos` Google Sheet tab also control the logo tagline and WhatsApp order recipient phone.

**Architecture:** Keep promo rows in `site_promos!A1:C4`. Add separate key/value settings below the promo table: `brand_tagline` in `A8:B8` and `phone` in `A10:B10`. `app.js` parses numeric `slot` rows as promos and non-numeric first-column rows as settings, applying safe fallbacks when settings are blank.

**Tech Stack:** Static HTML/CSS/JS, Google Sheets published CSV, Node built-in test runner.

---

### Task 1: Add Failing Tests

**Files:**
- Modify: `tests/site_catalog.test.mjs`

- [ ] Add tests that numeric `slot` rows remain the only promo rows.
- [ ] Add tests that `brand_tagline` updates `.brand-tagline`.
- [ ] Add tests that `phone` changes the `wa.me` recipient while preserving the generated order text.
- [ ] Run `node --test tests/site_catalog.test.mjs` and confirm the new tests fail before implementation.

### Task 2: Implement Site Settings

**Files:**
- Modify: `app.js`

- [ ] Replace the fixed WhatsApp constant with a fallback constant plus mutable current phone.
- [ ] Add settings normalization from non-numeric first-column rows.
- [ ] Apply `brand_tagline` and sanitized `phone` after loading `site_promos`.
- [ ] Keep existing order text generation unchanged.

### Task 3: Update Google Sheet

**Files:**
- Edit Google Sheet: `ddmarket_price`, tab `site_promos`

- [ ] Write `brand_tagline | Свежие продукты рядом` to `A8:B8`.
- [ ] Write `phone | 77785252162` to `A10:B10`.
- [ ] Verify `site_promos!A1:C10` reads back with promo rows and settings rows.

### Task 4: Verify

**Files:**
- Test: `tests/site_catalog.test.mjs`

- [ ] Run `node --test tests/site_catalog.test.mjs`.
- [ ] Run `python -m pytest`.
- [ ] Fetch the published `site_promos` CSV and confirm it includes `brand_tagline` and `phone`.
