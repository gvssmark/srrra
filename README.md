# Accounts App — Setup

A single installable web app (PWA) covering Journal entry, Batch Transactions,
Account Addition, BSIE Reports, Ledger Reports, Accounts Report, and Financial
Year Closing — backed by a Google Sheet via an Apps Script Web App.

This codebase (`Code.gs` + `index.html`) is **organization-agnostic** — the
same two files can be deployed for any organization. Everything specific to
one organization (its name, financial year start month, and report signatory
roles) lives in the Sheet's **Settings** tab, not in the code. Deploying for a
second organization means: new Google Sheet, new Apps Script Web App
deployment (new URL), same `Code.gs` and `index.html` (just update the
`WEB_APP_URL` line). See **Section 5 (Reusing this app for another organization)**.

## ⚠️ If you have an existing "old schema" Journal sheet

If your Journal sheet currently has columns `date, jrnlNo, drAccount,
crAccount, details, amount, finYear`, you're on the **old schema** and must
migrate before deploying this version of `Code.gs` — it expects the new
line-item schema below. See **Section 4 (Migration)**.

## 1. Google Sheet — four tabs, exact header rows

**Journal** *(line-item schema — one row per Dr or Cr line, not per pair)*
```
date | jrnlNo | account | drCr | details | amount | finYear
```
- `drCr` is exactly `Dr` or `Cr`.
- `jrnlNo` is the **voucher number** — multiple rows share the same jrnlNo to
  form one voucher. A simple transaction is 2 rows (1 Dr + 1 Cr) sharing a
  jrnlNo; a batch/compound transaction is however many rows are needed, as
  long as the Dr rows and Cr rows for that jrnlNo sum to the same total.

**Accounts**
```
acno | bsie | type | acname | fullacname
```
- `acno` is **4 to 7 digits, numeric only**. The first digit is fixed by
  type (`1`=Asset, `2`=Liability, `3`=Payment/Expenditure, `4`=Receipt/Income);
  the remaining 3-6 digits are free-form — e.g. a structured code like
  tower+floor+flat for per-unit accounts (apartment complex use case).
  The "suggest next number" feature on the Account Addition screen only
  auto-increments within the standard 4-digit pool; longer, structured codes
  are typed in directly.

**BSIEcodes**
```
Type | mapping | Label
```
`Type` must be exactly one of: `Assets`, `Liabilities`, `Expenditure`, `Income`.
Must include `2-05` (Liabilities, surplus carry-over) and `1-07` (Assets,
deficit carry-over) for Financial Year Closing and the BSIE report to balance.

**Settings** *(optional — sensible defaults apply if this tab or any row is missing)*
```
Key | Value
```
| Key | Meaning | Default if missing |
|---|---|---|
| `OrgName` | Organization name shown in the header, About page, report headings, PDF filenames, and WhatsApp share text | `Organization` |
| `FYStartMonth` | Financial year start month, `1`–`12` (e.g. `4` = April–March, `7` = July–June, `1` = calendar year) | `7` |
| `SignatoryLabels` | Comma-separated roles for the signature block at the end of BSIE/Ledger reports, e.g. `President,Secretary,Treasurer` | `President,General Secretary,Treasurer,Auditor` |

## 2. Deploy the Apps Script backend
1. In the Sheet: **Extensions > Apps Script**.
2. Replace the code in `Code.gs` with the contents of `Code.gs` from this package.
3. **Set the admin passcode**: Project Settings (gear icon) > **Script Properties**
   > Add property: key `ADMIN_PASSCODE`, value = whatever passcode you want to
   protect Financial Year Closing with. (Skip if already set from before — it
   survives redeployments.)
4. **Deploy > New deployment > Web app** (first time only)
   - Execute as: **Me**
   - Who has access: **Anyone**
5. Deploy, authorize when prompted, copy the **Web app URL** (ends `/exec`).

Whenever you edit `Code.gs` later: **Deploy > Manage deployments > ✎ Edit >
New version > Deploy** (same `/exec` URL keeps working).

## 3. Configure and host the app
1. Open `index.html`, replace `PASTE_YOUR_APPS_SCRIPT_WEB_APP_URL_HERE` with your `/exec` URL.
2. Push `index.html`, `manifest.json`, `icon.svg`, `sw.js` to a GitHub repo (same folder).
3. Enable **GitHub Pages** (Settings > Pages > deploy from branch).
4. Share the resulting URL (e.g. `https://yourname.github.io/repo/`).
5. On a phone: open the link > browser menu > **Add to Home Screen / Install app**.

### After making changes later

These two update mechanisms are independent — a change to one file never
requires touching the other, but each file has to be pushed out its own way:

| You changed... | What to do | Do you need to touch the other file? |
|---|---|---|
| `Code.gs` | **Deploy > Manage deployments > ✎ Edit > New version > Deploy** (same `/exec` URL keeps working) | No — `index.html`'s `WEB_APP_URL` doesn't change |
| `index.html` (or `manifest.json`/`icon.svg`/`sw.js`) | Just push the updated file(s) to GitHub — Pages picks it up automatically | No Apps Script redeploy needed |

If a piece of work touched both files (as most feature additions do — a new
report needs a new backend action *and* new frontend code to call it), do
**both** steps above; neither one alone is enough.

## 4. Migration (old schema → new schema)

Only needed once, if your Journal sheet still has `drAccount`/`crAccount` columns.

1. In the Apps Script editor, with the **old** `Code.gs` still in place (or
   paste in just the `migrateJournalToLineItems` function from the new one),
   select `migrateJournalToLineItems` in the function dropdown and click **Run**.
2. This creates a new sheet called `Journal_NEW` — your existing `Journal`
   sheet is **not** touched. Check `Journal_NEW`: it should have roughly
   double the row count of the old `Journal` (each old paired row becomes two
   line rows).
3. Rename the old `Journal` sheet to `Journal_OLD_backup`.
4. Rename `Journal_NEW` to `Journal`.
5. **Now** replace `Code.gs` with the new version and redeploy (Section 2).

## 5. Reusing this app for another organization

Since the organization's identity lives entirely in the Sheet's **Settings**
tab (Section 1), deploying a second, completely independent copy for a
different organization needs **no code changes** — just:

1. Create a **new Google Sheet** with the four tabs (Section 1) — `Journal`,
   `Accounts`, `BSIEcodes`, `Settings` — and fill in that organization's own
   data (its chart of accounts, its BSIE code labels, and its `Settings` row
   values: `OrgName`, `FYStartMonth`, `SignatoryLabels`).
2. In that new Sheet: **Extensions > Apps Script**, paste in the *same*
   `Code.gs` unchanged, set its own `ADMIN_PASSCODE`, and deploy as a Web App
   (Section 2) — this gives you a **new, separate** `/exec` URL, because each
   Google Sheet needs its own Apps Script deployment.
3. Copy `index.html` (unchanged) into a separate folder/repo for that
   organization, and update only the `WEB_APP_URL` line to point at the new
   deployment's URL.
4. `manifest.json` (app name shown on the home-screen icon) and `icon.svg`
   are static files fetched by the browser before any of the app's own code
   runs — these can't read from the Settings tab. Edit these two files by
   hand for each organization's deployment (a one-line change to
   `manifest.json`'s `name`/`short_name`, and optionally a different icon).
5. Host and install exactly as in Section 3, under whichever URL/repo you
   set up for that organization.

Each organization ends up with its own Google Sheet, its own Apps Script
Web App URL, and its own copy of `index.html`/`manifest.json`/`icon.svg` —
but all running the identical `Code.gs` and (apart from the `WEB_APP_URL`
line) identical `index.html`.

## Access control

Reports (About, BSIE, Ledger, Accounts Report) are open to anyone with the
app link — no passcode needed. **Journal, Batch Transactions, Account
Addition, and Financial Year Closing** all require the same `ADMIN_PASSCODE`
(the same one already used for Financial Year Closing).

- In the nav menu, those four items are hidden until unlocked. A **"🔒 Unlock
  Data Entry"** link at the bottom of the menu prompts for the passcode; once
  verified, it becomes **"🔓 Lock Data Entry"** and the four menu items appear.
- The unlock is remembered in the browser's `localStorage`, so it persists
  across visits until someone deliberately locks it again (or clears their
  browser storage) — it is **not** re-asked every session.
- This is enforced **on the backend**, not just by hiding buttons: every
  Journal/Batch/Account write is checked against `ADMIN_PASSCODE` server-side
  (`doPost` in `Code.gs`), so directly calling the API without the right
  passcode is rejected too.
- **What this is not**: real per-person identity. Everyone who has the
  passcode is indistinguishable to the system — there's no "logged in as X"
  concept and no audit trail of who entered what. It's a shared secret, the
  same trust model as `ADMIN_PASSCODE` elsewhere in this app — appropriate for
  a small trusted group, not a substitute for real authentication.
- If a stored passcode is ever rejected (e.g. the admin changed
  `ADMIN_PASSCODE`), the app automatically re-locks that device and shows a
  message asking to unlock again.

## What's inside
| Menu item | What it does |
|---|---|
| About / Dos & Don'ts | Landing page (default view) |
| Journal | Simple 1-debit/1-credit entry; account fields filter as you type |
| Batch Transactions | Multi-line voucher — add several Dr and/or Cr lines, post once totals balance |
| Account Addition | Add a new Account by picking a BSIE mapping (Type + acno prefix auto-derived) |
| BSIE Reports | Balance Sheet + Income & Expenditure for any FY — Save PDF or Share via WhatsApp |
| Ledger Reports | Per-account transaction history + running balance for any FY, plus a Batch Transactions Summary page when viewing All Accounts — Save PDF or Share via WhatsApp |
| Accounts Report | AC / BSIE / Name / Dr count / Total Debits / Cr count / Total Credits / Balance, per account |
| Financial Year Closing | Passcode-protected. Preview then approve — posts one opening-balance voucher into the next FY |

## Key design notes
- **Organization identity is data, not code**: `OrgName`, `FYStartMonth`, and
  `SignatoryLabels` all come from the Settings tab and flow through the API
  into every heading, PDF, filename, and the WhatsApp share text — `Code.gs`
  and `index.html` contain no organization-specific text at all.
- **Line-item Journal**: every row is one account + one amount + Dr or Cr.
  A "voucher" is every row sharing a `jrnlNo`. This is what makes batch/compound
  entries possible — only the voucher's Dr total and Cr total need to match,
  not each individual line against a specific counterpart.
- **Ledger "Particulars"**: for a 2-line voucher (the simple case), shows the
  contra account's name, same as always. For a voucher with 3+ lines (a real
  batch entry — including the one Financial Year Closing posts), shows
  "Batch / Sundries" instead, per standard ledger convention.
- **Per-year scoping**: reports filter the continuous Journal by `finYear`.
- **Sign convention**: Asset/Expenditure accounts are debit-normal; Liability/Income accounts are credit-normal.
- **jrnlNo resets to 1 each financial year** (scoped per FY, not a global sequence).
- **Financial Year Closing** posts **one voucher** (one shared jrnlNo): every
  non-zero Asset balance as a Dr line, every non-zero Liability balance
  (other than the B/f account, BSIE code `2-01`) as a Cr line, and the B/f
  account itself takes whichever side balances the voucher. Payment/Receipt
  (nominal) accounts are *not* carried forward — they naturally start at zero.
  Refuses to run if the next FY already has entries.
- **No in-app delete/purge/account-edit** — by design, you handle those
  directly in the Google Sheet.
- **Data entry is passcode-gated; reports are open to everyone.** See
  "Access control" below.
- **Journal numbers may duplicate** if two people submit at nearly the same
  moment — the app doesn't block this; fix duplicates directly in the Sheet
  if it happens.
- **Dates display as dd/mm/yyyy** in reports (Ledger, PDFs). The underlying
  data and date-picker inputs still use ISO format internally — only the
  printed/displayed text is dd/mm/yyyy.
- **Numbers display in Indian grouping** (e.g. `12,34,567.00`, lakhs/crores),
  forced via `'en-IN'` locale regardless of the viewer's browser/device locale.
- **Batch Transactions Summary**: when viewing the Ledger with "All Accounts"
  selected, a flat list of every line belonging to a genuine batch voucher
  (3+ lines) appears after the per-account sections — in the PDF this is a
  genuinely separate page (`doc.addPage()`), not just a visual break. It does
  not appear when viewing a single account's ledger.
- **PDF reports** are drawn as real vector tables via `jsPDF` + `jspdf-autotable`
  (not a screenshot of the page) — this avoids clipping/overflow issues and
  produces selectable text. "Share via WhatsApp" only appears when the
  browser supports attaching a file via the Web Share API; otherwise only
  "Save PDF" shows.
- **PWA**: installable via `manifest.json` + `sw.js`; the service worker only
  caches the app shell (HTML/CSS/JS) for offline *loading* — it does not queue
  offline Journal/Batch submissions. You still need connectivity to actually
  save data or load reports.

## Easy tweaks
- **Financial year start month**: edit `FYStartMonth` in the Settings tab —
  no code change needed (see Section 1).
- **The "YYYY-YY" finYear label format itself** (as opposed to which month it
  starts in): change `finYearFromDate_()` / `nextFinYear_()`.
- **Change admin passcode**: edit the `ADMIN_PASSCODE` Script Property — no redeploy needed.
- **Ledger "Batch / Sundries" wording**: change the string in `getLedgerData()`.
