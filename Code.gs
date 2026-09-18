/**
 * Data Entry — Journal & Accounts (Web App API)
 * ------------------------------------------------
 * Deploy this as a Web App (Deploy > New deployment > Web app):
 *   Execute as:  Me
 *   Who has access: Anyone
 * Copy the resulting /exec URL into WEB_APP_URL at the top of index.html.
 *
 * Sheet 1 "Journal"   columns: date, jrnlNo, account, drCr, details, amount, finYear
 *   Line-item model: EVERY row is a single line (one account, one amount,
 *   tagged Dr or Cr). A "voucher" is a group of rows sharing the same jrnlNo.
 *   A simple transaction is a 2-line voucher (1 Dr + 1 Cr). A batch/compound
 *   transaction is a voucher with more than 2 lines, where only the TOTALS
 *   must balance (sum of Dr lines = sum of Cr lines) — not each line paired
 *   1:1 against a specific contra account.
 * Sheet 2 "Accounts"  columns: acno, bsie, type, acname, fullacname
 * Sheet 3 "BSIEcodes" columns: Type, mapping, Label
 *   Type is one of: Assets, Liabilities, Expenditure, Income
 *
 * NOTE: this replaces an earlier schema (date, jrnlNo, drAccount, crAccount,
 * details, amount, finYear). If your Journal sheet is still in that old
 * shape, run migrateJournalToLineItems() once from this editor BEFORE
 * deploying this version — see that function's comment for the exact steps.
 */

const JOURNAL_SHEET = 'Journal';
const ACCOUNTS_SHEET = 'Accounts';
const BSIE_SHEET = 'BSIEcodes';
const SETTINGS_SHEET = 'Settings';

// acno first digit <-> account type
const TYPE_PREFIX = { 'ASSET': '1', 'LIABILITY': '2', 'PAYMENT': '3', 'RECEIPT': '4' };

// BSIEcodes "Type" column <-> internal type key
const BSIE_TYPE_TO_KEY = { 'ASSETS': 'ASSET', 'LIABILITIES': 'LIABILITY', 'EXPENDITURE': 'PAYMENT', 'INCOME': 'RECEIPT' };

// Special BSIE mapping codes used as computed surplus/deficit plug lines
const LIABILITY_SURPLUS_CODE = '2-05'; // Excess of Income over Expenditure Carried over
const ASSET_DEFICIT_CODE = '1-07';     // Excess of Expenditure over Income Carried over
const EXPENDITURE_SURPLUS_CODE = '3-10'; // Excess of Income over Expenditure (I&E statement)
const INCOME_DEFICIT_CODE = '4-06';      // Excess of Expenditure over Income (I&E statement)

// Types whose normal balance is Debit - Credit vs Credit - Debit
const DEBIT_NORMAL_TYPES = { 'ASSET': true, 'PAYMENT': true };

// ---------------------------------------------------------------------
// Web App entry points
// ---------------------------------------------------------------------

function doGet(e) {
  try {
    const action = e.parameter.action;
    let data;
    if (action === 'journalForm') data = getJournalFormData();
    else if (action === 'accountsForm') data = getAccountsFormData();
    else if (action === 'nextAcno') data = { acno: getNextAcno(e.parameter.type) };
    else if (action === 'finYears') data = { finYears: getFinYearList_() };
    else if (action === 'ledger') data = getLedgerData(e.parameter.finYear, e.parameter.acno || 'ALL');
    else if (action === 'bsie') data = getBsieData(e.parameter.finYear);
    else if (action === 'accountsReport') data = getAccountsReport(e.parameter.finYear);
    else if (action === 'closeYearPreview') data = previewCloseFinancialYear(e.parameter.finYear);
    else if (action === 'orgSettings') data = getSettings_();
    else if (action === 'checkPasscode') data = { valid: isPasscodeValid_(e.parameter.passcode) };
    else throw new Error('Unknown action: ' + action);
    return jsonOutput_({ ok: true, data: data });
  } catch (err) {
    return jsonOutput_({ ok: false, error: err.message });
  }
}

function doPost(e) {
  try {
    // Sent as text/plain from the browser to avoid CORS preflight; parse manually.
    const body = JSON.parse(e.postData.contents);
    let data;
    if (body.action === 'journal') { checkPasscode_(body.passcode); data = submitJournalEntry(body.entry); }
    else if (body.action === 'batchJournal') { checkPasscode_(body.passcode); data = submitBatchJournal(body.entry); }
    else if (body.action === 'account') { checkPasscode_(body.passcode); data = submitAccountEntry(body.entry); }
    else if (body.action === 'closeYear') data = closeFinancialYear(body.finYear, body.passcode);
    else if (body.action === 'email') data = sendReportEmail(body.toEmail, body.subject, body.htmlBody);
    else throw new Error('Unknown action: ' + body.action);
    return jsonOutput_({ ok: true, data: data });
  } catch (err) {
    return jsonOutput_({ ok: false, error: err.message });
  }
}

function jsonOutput_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ---------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------

function getJournalSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(JOURNAL_SHEET);
  if (!sheet) throw new Error('Sheet "' + JOURNAL_SHEET + '" not found');
  return sheet;
}

function getAccountsSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(ACCOUNTS_SHEET);
  if (!sheet) throw new Error('Sheet "' + ACCOUNTS_SHEET + '" not found');
  return sheet;
}

function getBsieSheet_() {
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(BSIE_SHEET);
  if (!sheet) throw new Error('Sheet "' + BSIE_SHEET + '" not found');
  return sheet;
}

/** Reads BSIEcodes sheet -> [{type:'Assets', typeKey:'ASSET', mapping:'1-01', label:'Fixed Deposits'}, ...] */
function getBsieCodes_() {
  const values = getBsieSheet_().getDataRange().getValues();
  const col = headerMap_(values);
  const list = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const mapping = String(row[col['mapping']] || '').trim();
    if (!mapping) continue;
    const typeRaw = String(row[col['type']] || '').trim();
    const typeKey = BSIE_TYPE_TO_KEY[typeRaw.toUpperCase()];
    if (!typeKey) throw new Error('Unknown BSIE Type "' + typeRaw + '" in ' + BSIE_SHEET + ' (expected Assets/Liabilities/Expenditure/Income)');
    list.push({
      type: typeRaw,
      typeKey: typeKey,
      mapping: mapping,
      label: String(row[col['label']] || mapping).trim()
    });
  }
  return list;
}

function getBsieCodeInfo_(mapping) {
  const codes = getBsieCodes_();
  const found = codes.find(c => c.mapping === mapping);
  if (!found) throw new Error('Unknown BSIE mapping code: ' + mapping);
  return found;
}

function headerMap_(values) {
  const header = values[0].map(h => String(h).trim().toLowerCase());
  const map = {};
  header.forEach((h, i) => map[h] = i);
  return map;
}

/**
 * Reads the "Settings" sheet (Key | Value rows) once per execution and caches it.
 * Recognized keys: OrgName, FYStartMonth (1-12), SignatoryLabels (comma-separated).
 * Missing/blank keys fall back to sensible defaults so this sheet is optional.
 */
let _settingsCache_ = null;
function getSettings_() {
  if (_settingsCache_) return _settingsCache_;

  const map = {};
  const sheet = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(SETTINGS_SHEET);
  if (sheet) {
    const values = sheet.getDataRange().getValues();
    const col = headerMap_(values);
    for (let i = 1; i < values.length; i++) {
      const k = String(values[i][col['key']] || '').trim();
      if (k) map[k] = values[i][col['value']];
    }
  }

  const orgName = String(map['OrgName'] || 'Organization').trim();
  const fyStartMonth = parseInt(map['FYStartMonth'], 10) || 7; // default: July, matches original IBRA setup
  let signatoryLabels = ['President', 'General Secretary', 'Treasurer', 'Auditor'];
  if (map['SignatoryLabels']) {
    const parsed = String(map['SignatoryLabels']).split(',').map(s => s.trim()).filter(Boolean);
    if (parsed.length) signatoryLabels = parsed;
  }

  _settingsCache_ = { orgName: orgName, fyStartMonth: fyStartMonth, signatoryLabels: signatoryLabels };
  return _settingsCache_;
}

function finYearFromDate_(date) {
  const fyStartMonth = getSettings_().fyStartMonth; // 1-12
  const y = date.getFullYear();
  const m = date.getMonth() + 1; // 1-12
  return (m >= fyStartMonth) ? (y + '-' + String(y + 1).slice(-2)) : ((y - 1) + '-' + String(y).slice(-2));
}

function finYearBounds_(finYear) {
  const fyStartMonth = getSettings_().fyStartMonth; // 1-12
  const startYear = parseInt(finYear.split('-')[0], 10);
  const start = new Date(startYear, fyStartMonth - 1, 1);
  const end = new Date(startYear + 1, fyStartMonth - 1, 0); // day 0 = last day of the month before FY-start, next year
  return { start, end };
}

function compareFinYear_(a, b) {
  return parseInt(a.split('-')[0], 10) - parseInt(b.split('-')[0], 10);
}

function fmtDate_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd');
}

/** Display-only date format (dd/MM/yyyy) — used in report output, never for ISO bounds/validation. */
function fmtDateDisplay_(d) {
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'dd/MM/yyyy');
}

/** Builds one Journal row (in sheet-header order) for a single line. */
function buildJournalRow_(header, date, jrnlNo, account, drCr, details, amount, finYear) {
  return header.map(h => {
    switch (h) {
      case 'date': return date;
      case 'jrnlno': return jrnlNo;
      case 'account': return account;
      case 'drcr': return drCr;
      case 'details': return details;
      case 'amount': return amount;
      case 'finyear': return finYear;
      default: return '';
    }
  });
}

function getAccountsList_() {
  const values = getAccountsSheet_().getDataRange().getValues();
  const col = headerMap_(values);
  const list = [];
  for (let i = 1; i < values.length; i++) {
    if (values[i][col['fullacname']]) list.push(String(values[i][col['fullacname']]));
  }
  return list.sort();
}

function getAllAccounts_() {
  const values = getAccountsSheet_().getDataRange().getValues();
  const col = headerMap_(values);
  const list = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (!row[col['acno']]) continue;
    list.push({
      acno: String(row[col['acno']]),
      bsie: String(row[col['bsie']] || ''),
      type: String(row[col['type']] || '').toUpperCase(),
      acname: String(row[col['acname']] || ''),
      fullacname: String(row[col['fullacname']] || '')
    });
  }
  return list;
}

/** All Journal lines for a finYear, sorted by date then jrnlNo. */
function getJournalRowsForFY_(finYear) {
  const values = getJournalSheet_().getDataRange().getValues();
  const col = headerMap_(values);
  const rows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    if (String(row[col['finyear']]) !== finYear) continue;
    rows.push({
      date: row[col['date']],
      jrnlNo: row[col['jrnlno']],
      account: String(row[col['account']]),
      drCr: String(row[col['drcr']]).trim(),
      details: String(row[col['details']] || ''),
      amount: Number(row[col['amount']]) || 0
    });
  }
  rows.sort((a, b) => {
    const d = new Date(a.date) - new Date(b.date);
    return d !== 0 ? d : (Number(a.jrnlNo) - Number(b.jrnlNo));
  });
  return rows;
}

function getFinYearList_() {
  const values = getJournalSheet_().getDataRange().getValues();
  const col = headerMap_(values);
  const set = {};
  for (let i = 1; i < values.length; i++) {
    const fy = values[i][col['finyear']];
    if (fy) set[String(fy)] = true;
  }
  return Object.keys(set).sort(compareFinYear_);
}

// ---------------------------------------------------------------------
// Journal — simple (1 Dr + 1 Cr) entries
// ---------------------------------------------------------------------

function getJournalFormData() {
  const values = getJournalSheet_().getDataRange().getValues();
  const col = headerMap_(values);

  let maxFinYear = null;
  for (let i = 1; i < values.length; i++) {
    const fy = values[i][col['finyear']];
    if (fy) {
      const fyStr = String(fy);
      if (!maxFinYear || compareFinYear_(fyStr, maxFinYear) > 0) maxFinYear = fyStr;
    }
  }
  if (!maxFinYear) maxFinYear = finYearFromDate_(new Date());
  const bounds = finYearBounds_(maxFinYear);

  let maxJrnlNo = 0;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][col['finyear']]) !== maxFinYear) continue;
    const n = Number(values[i][col['jrnlno']]);
    if (!isNaN(n) && n > maxJrnlNo) maxJrnlNo = n;
  }

  return {
    finYear: maxFinYear,
    finYearStart: fmtDate_(bounds.start),
    finYearEnd: fmtDate_(bounds.end),
    nextJrnlNo: maxJrnlNo + 1,
    accounts: getAccountsList_()
  };
}

/** Simple entry: writes a 2-line voucher (one Dr line, one Cr line) sharing one new jrnlNo. */
function submitJournalEntry(entry) {
  const sheet = getJournalSheet_();
  const values = sheet.getDataRange().getValues();
  const col = headerMap_(values);

  const date = new Date(entry.date + 'T00:00:00');
  const bounds = finYearBounds_(entry.finYear);
  if (date < bounds.start || date > bounds.end) {
    throw new Error('Date ' + entry.date + ' is outside FY ' + entry.finYear +
      ' (' + fmtDate_(bounds.start) + ' to ' + fmtDate_(bounds.end) + ')');
  }
  if (!entry.drAccount || !entry.crAccount) throw new Error('Debit and Credit accounts are required');
  if (entry.drAccount === entry.crAccount) throw new Error('Debit and Credit accounts cannot be the same');
  const amount = Number(entry.amount);
  if (isNaN(amount) || amount <= 0) throw new Error('Amount must be a positive number');

  const validAccounts = new Set(getAccountsList_());
  if (!validAccounts.has(entry.drAccount)) throw new Error('Unknown Debit account: ' + entry.drAccount);
  if (!validAccounts.has(entry.crAccount)) throw new Error('Unknown Credit account: ' + entry.crAccount);

  let maxJrnlNo = 0;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][col['finyear']]) !== entry.finYear) continue;
    const n = Number(values[i][col['jrnlno']]);
    if (!isNaN(n) && n > maxJrnlNo) maxJrnlNo = n;
  }
  const jrnlNo = maxJrnlNo + 1;
  const header = values[0].map(h => String(h).trim().toLowerCase());
  const details = entry.details || '';

  const rows = [
    buildJournalRow_(header, date, jrnlNo, entry.drAccount, 'Dr', details, amount, entry.finYear),
    buildJournalRow_(header, date, jrnlNo, entry.crAccount, 'Cr', details, amount, entry.finYear)
  ];
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
  return { jrnlNo: jrnlNo };
}

// ---------------------------------------------------------------------
// Journal — batch (multi-line) vouchers
// ---------------------------------------------------------------------

/**
 * Batch entry: entry = {date, finYear, lines: [{account, drCr, details, amount}, ...]}.
 * Requires at least one Dr line and one Cr line, and sum(Dr) === sum(Cr) —
 * NOT that individual lines pair up. Writes all lines as one voucher (shared
 * new jrnlNo) in a single atomic write.
 */
function submitBatchJournal(entry) {
  const sheet = getJournalSheet_();
  const values = sheet.getDataRange().getValues();
  const col = headerMap_(values);

  const date = new Date(entry.date + 'T00:00:00');
  const bounds = finYearBounds_(entry.finYear);
  if (date < bounds.start || date > bounds.end) {
    throw new Error('Date ' + entry.date + ' is outside FY ' + entry.finYear +
      ' (' + fmtDate_(bounds.start) + ' to ' + fmtDate_(bounds.end) + ')');
  }

  const lines = entry.lines || [];
  if (lines.length < 2) throw new Error('A batch needs at least two lines');

  const validAccounts = new Set(getAccountsList_());
  let totalDr = 0, totalCr = 0, drCount = 0, crCount = 0;
  lines.forEach((l, idx) => {
    if (!l.account || !validAccounts.has(l.account)) throw new Error('Line ' + (idx + 1) + ': unknown account "' + l.account + '"');
    if (l.drCr !== 'Dr' && l.drCr !== 'Cr') throw new Error('Line ' + (idx + 1) + ': Dr/Cr must be Dr or Cr');
    const amt = Number(l.amount);
    if (isNaN(amt) || amt <= 0) throw new Error('Line ' + (idx + 1) + ': amount must be a positive number');
    if (l.drCr === 'Dr') { totalDr += amt; drCount++; } else { totalCr += amt; crCount++; }
  });
  if (drCount === 0 || crCount === 0) throw new Error('A batch needs at least one Dr line and one Cr line');
  if (Math.round(totalDr * 100) !== Math.round(totalCr * 100)) {
    throw new Error('Batch does not balance: Total Dr ' + totalDr.toFixed(2) + ' vs Total Cr ' + totalCr.toFixed(2));
  }

  let maxJrnlNo = 0;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][col['finyear']]) !== entry.finYear) continue;
    const n = Number(values[i][col['jrnlno']]);
    if (!isNaN(n) && n > maxJrnlNo) maxJrnlNo = n;
  }
  const jrnlNo = maxJrnlNo + 1;
  const header = values[0].map(h => String(h).trim().toLowerCase());

  const rows = lines.map(l =>
    buildJournalRow_(header, date, jrnlNo, l.account, l.drCr, l.details || '', Number(l.amount), entry.finYear)
  );
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
  return { jrnlNo: jrnlNo, linesCreated: rows.length };
}

// ---------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------

function getAccountsFormData() {
  return { bsieCodes: getBsieCodes_() };
}

function getNextAcno(type) {
  const prefix = TYPE_PREFIX[type];
  if (!prefix) throw new Error('Unknown account type: ' + type);

  const values = getAccountsSheet_().getDataRange().getValues();
  const col = headerMap_(values);
  let max = 0;
  for (let i = 1; i < values.length; i++) {
    const acno = String(values[i][col['acno']]);
    if (acno.charAt(0) === prefix && acno.length === 4) {
      const n = parseInt(acno.slice(1), 10);
      if (!isNaN(n) && n > max) max = n;
    }
  }
  return prefix + String(max + 1).padStart(3, '0');
}

function submitAccountEntry(entry) {
  const sheet = getAccountsSheet_();
  const values = sheet.getDataRange().getValues();
  const col = headerMap_(values);

  if (!entry.bsie) throw new Error('BSIE mapping is required');
  const bsieInfo = getBsieCodeInfo_(entry.bsie); // throws if unknown code
  const type = bsieInfo.typeKey;

  if (!/^[1-4]\d{3}$/.test(entry.acno)) {
    throw new Error('Account number must be 4 digits, first digit 1-4 (1=Asset,2=Liability,3=Payment,4=Receipt)');
  }
  if (entry.acno.charAt(0) !== TYPE_PREFIX[type]) {
    throw new Error('Account number ' + entry.acno + ' should start with ' + TYPE_PREFIX[type] +
      ' for BSIE type ' + bsieInfo.type + ' (' + type + ')');
  }
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][col['acno']]) === entry.acno) {
      throw new Error('Account number ' + entry.acno + ' already exists');
    }
  }
  if (!entry.acname) throw new Error('Account name is required');

  const fullacname = entry.acno + '-' + entry.acname;
  const header = values[0].map(h => String(h).trim().toLowerCase());
  const row = header.map(h => {
    switch (h) {
      case 'acno': return entry.acno;
      case 'bsie': return entry.bsie;
      case 'type': return type;
      case 'acname': return entry.acname;
      case 'fullacname': return fullacname;
      default: return '';
    }
  });

  sheet.appendRow(row);
  return { fullacname: fullacname };
}

// ---------------------------------------------------------------------
// Balances / Ledger / BSIE / Accounts Report
// ---------------------------------------------------------------------

/**
 * Per-account Total Debits / Total Credits / Balance for a given finYear.
 */
function computeAccountBalances_(finYear) {
  const accounts = getAllAccounts_();
  const rows = getJournalRowsForFY_(finYear);

  const byFullName = {};
  accounts.forEach(a => {
    byFullName[a.fullacname] = { account: a, totalDebits: 0, totalCredits: 0 };
  });

  rows.forEach(r => {
    if (!byFullName[r.account]) return;
    if (r.drCr === 'Dr') byFullName[r.account].totalDebits += r.amount;
    else if (r.drCr === 'Cr') byFullName[r.account].totalCredits += r.amount;
  });

  Object.keys(byFullName).forEach(k => {
    const rec = byFullName[k];
    const debitNormal = !!DEBIT_NORMAL_TYPES[rec.account.type];
    rec.balance = debitNormal
      ? (rec.totalDebits - rec.totalCredits)
      : (rec.totalCredits - rec.totalDebits);
  });

  return byFullName; // fullacname -> {account, totalDebits, totalCredits, balance}
}

/**
 * Accounts Report for a finYear: AccountNo, BSIE, Name, debit count, total debits,
 * credit count, total credits, balance — sorted by account number.
 */
function getAccountsReport(finYear) {
  if (!finYear) throw new Error('finYear is required');
  const accounts = getAllAccounts_();
  const rows = getJournalRowsForFY_(finYear);

  const counts = {}; // fullacname -> {debitCount, creditCount}
  accounts.forEach(a => { counts[a.fullacname] = { debitCount: 0, creditCount: 0 }; });
  rows.forEach(r => {
    if (!counts[r.account]) return;
    if (r.drCr === 'Dr') counts[r.account].debitCount++;
    else if (r.drCr === 'Cr') counts[r.account].creditCount++;
  });

  const balances = computeAccountBalances_(finYear);

  const result = accounts
    .slice()
    .sort((a, b) => a.acno.localeCompare(b.acno))
    .map(a => {
      const bal = balances[a.fullacname];
      const cnt = counts[a.fullacname];
      return {
        acno: a.acno,
        bsie: a.bsie,
        acname: a.acname,
        debitCount: cnt.debitCount,
        totalDebits: bal.totalDebits,
        creditCount: cnt.creditCount,
        totalCredits: bal.totalCredits,
        balance: bal.balance
      };
    });

  return { finYear: finYear, accounts: result, orgName: getSettings_().orgName };
}

/**
 * Ledger for a finYear. acno = 'ALL' for every account, or a specific fullacname.
 *
 * Particulars rule (matches how a voucher's line count reads):
 *  - voucher has exactly 2 lines total -> simple entry -> show the other account's name
 *  - voucher has exactly 1 line (a historical single-sided row, pre-migration) -> blank
 *  - voucher has 3+ lines -> genuine batch/compound entry -> "Batch / Sundries"
 */
function getLedgerData(finYear, acnoOrAll) {
  if (!finYear) throw new Error('finYear is required');
  const accounts = getAllAccounts_();
  const rows = getJournalRowsForFY_(finYear);

  const byVoucher = {}; // jrnlNo -> [rows in this voucher]
  rows.forEach(r => {
    const key = String(r.jrnlNo);
    (byVoucher[key] = byVoucher[key] || []).push(r);
  });

  const targets = (acnoOrAll === 'ALL')
    ? accounts.slice().sort((a, b) => a.acno.localeCompare(b.acno))
    : accounts.filter(a => a.fullacname === acnoOrAll);

  const result = targets.map(acc => {
    const debitNormal = !!DEBIT_NORMAL_TYPES[acc.type];
    let running = 0;
    const entries = [];
    rows.forEach(r => {
      if (r.account !== acc.fullacname) return;
      const debit = r.drCr === 'Dr' ? r.amount : 0;
      const credit = r.drCr === 'Cr' ? r.amount : 0;
      running += debitNormal ? (debit - credit) : (credit - debit);

      const siblings = byVoucher[String(r.jrnlNo)] || [r];
      let particulars;
      if (siblings.length === 2) {
        const other = siblings.find(s => s !== r);
        particulars = other ? other.account : '';
      } else if (siblings.length <= 1) {
        particulars = '';
      } else {
        particulars = 'Batch / Sundries';
      }

      entries.push({
        date: fmtDateDisplay_(new Date(r.date)),
        jrnlNo: r.jrnlNo,
        particulars: particulars,
        details: r.details,
        debit: debit,
        credit: credit,
        balance: running
      });
    });
    return {
      acno: acc.acno,
      fullacname: acc.fullacname,
      type: acc.type,
      entries: entries,
      closingBalance: running
    };
  }).filter(a => acnoOrAll !== 'ALL' || a.entries.length > 0);

  // Flat summary of every line belonging to a genuine batch voucher (3+ lines),
  // across all accounts — meant for a "Batch Transactions" summary page at the
  // end of the full Ledger report.
  const batchLines = [];
  rows.forEach(r => {
    const siblings = byVoucher[String(r.jrnlNo)] || [r];
    if (siblings.length <= 2) return;
    batchLines.push({
      date: fmtDateDisplay_(new Date(r.date)),
      jrnlNo: r.jrnlNo,
      particulars: r.account + (r.details ? (' — ' + r.details) : ''),
      drCr: r.drCr,
      amount: r.amount
    });
  });

  return { finYear: finYear, accounts: result, batchLines: batchLines, orgName: getSettings_().orgName, asOnDate: fmtDateDisplay_(finYearBounds_(finYear).end) };
}

/**
 * Balance Sheet + Income & Expenditure for a finYear, grouped by BSIE code
 * using the BSIEcodes sheet as the structural source of truth (labels,
 * ordering, and inclusion of zero-balance lines).
 */
function getBsieData(finYear) {
  if (!finYear) throw new Error('finYear is required');
  const balances = computeAccountBalances_(finYear);
  const codes = getBsieCodes_();

  function sectionFor(typeKey) {
    return codes.filter(c => c.typeKey === typeKey).map(c => {
      const lines = [];
      let subtotal = 0;
      Object.keys(balances).forEach(fullacname => {
        const rec = balances[fullacname];
        if (rec.account.type === typeKey && rec.account.bsie === c.mapping) {
          lines.push({ acno: rec.account.acno, acname: rec.account.acname, balance: rec.balance });
          subtotal += rec.balance;
        }
      });
      return { mapping: c.mapping, label: c.label, lines: lines, subtotal: subtotal };
    });
  }

  const liabilities = sectionFor('LIABILITY');
  const assets = sectionFor('ASSET');
  const expenditure = sectionFor('PAYMENT');
  const income = sectionFor('RECEIPT');

  const sum = arr => arr.reduce((s, g) => s + g.subtotal, 0);
  const excess = sum(income) - sum(expenditure); // positive = surplus, negative = deficit

  function setPlug(list, mapping, amount) {
    const g = list.find(x => x.mapping === mapping);
    if (!g) return; // code not present in BSIEcodes sheet — silently skip
    if (Math.abs(amount) > 0.005) {
      g.subtotal = amount;
      g.lines = [{ acno: '', acname: '(computed)', balance: amount }];
    } else {
      g.subtotal = 0;
      g.lines = [];
    }
  }

  if (excess >= 0) {
    setPlug(liabilities, LIABILITY_SURPLUS_CODE, excess);
    setPlug(assets, ASSET_DEFICIT_CODE, 0);
    setPlug(expenditure, EXPENDITURE_SURPLUS_CODE, excess);
    setPlug(income, INCOME_DEFICIT_CODE, 0);
  } else {
    setPlug(liabilities, LIABILITY_SURPLUS_CODE, 0);
    setPlug(assets, ASSET_DEFICIT_CODE, -excess);
    setPlug(expenditure, EXPENDITURE_SURPLUS_CODE, 0);
    setPlug(income, INCOME_DEFICIT_CODE, -excess);
  }

  const totalLiabilities = sum(liabilities);
  const totalAssets = sum(assets);
  const totalExpenditure = sum(expenditure);
  const totalIncome = sum(income);

  return {
    finYear: finYear,
    liabilities: liabilities,
    assets: assets,
    income: income,
    expenditure: expenditure,
    excess: excess,
    totalLiabilities: totalLiabilities,
    totalAssets: totalAssets,
    balanced: Math.abs(totalLiabilities - totalAssets) < 0.01,
    totalIncome: totalIncome,
    totalExpenditure: totalExpenditure,
    orgName: getSettings_().orgName,
    asOnDate: fmtDateDisplay_(finYearBounds_(finYear).end)
  };
}

// ---------------------------------------------------------------------
// Financial Year Closing
// ---------------------------------------------------------------------

function isPasscodeValid_(candidate) {
  const expected = PropertiesService.getScriptProperties().getProperty('ADMIN_PASSCODE');
  return !!expected && !!candidate && candidate === expected;
}

function checkPasscode_(candidate) {
  if (!PropertiesService.getScriptProperties().getProperty('ADMIN_PASSCODE')) {
    throw new Error('Admin passcode is not configured. In Apps Script: Project Settings > Script Properties, add ADMIN_PASSCODE.');
  }
  if (!isPasscodeValid_(candidate)) throw new Error('Incorrect passcode');
}

function nextFinYear_(finYear) {
  const startYear = parseInt(finYear.split('-')[0], 10);
  const newStart = startYear + 1;
  return newStart + '-' + String(newStart + 1).slice(-2);
}

/**
 * Computes the single opening-balance VOUCHER that Financial Year Closing
 * would post (one jrnlNo, many lines), without writing anything. Every
 * non-zero Asset account becomes a Dr line; every non-zero Liability account
 * (other than the B/f account itself) becomes a Cr line; the B/f account
 * (BSIE code 2-01) takes whichever side balances the voucher. Payment/
 * Receipt (nominal) accounts are not carried forward — they naturally start
 * the new FY at zero since the Journal is filtered per finYear.
 */
function buildCloseYearPlan_(oldFinYear) {
  if (!oldFinYear) throw new Error('finYear is required');
  const newFinYear = nextFinYear_(oldFinYear);
  const balances = computeAccountBalances_(oldFinYear);
  const accounts = getAllAccounts_();

  const bfCandidates = accounts.filter(a => a.type === 'LIABILITY' && a.bsie === '2-01');
  if (bfCandidates.length === 0) throw new Error('No account is mapped to BSIE code 2-01 (B/f Previous Balance Sheet) — add one in Accounts before closing.');
  if (bfCandidates.length > 1) throw new Error('More than one account is mapped to BSIE code 2-01 — there should be exactly one.');
  const bfAccount = bfCandidates[0];

  const lines = [];
  let assetSum = 0, otherLiabSum = 0;
  accounts.forEach(acc => {
    if (acc.fullacname === bfAccount.fullacname) return;
    if (acc.type !== 'ASSET' && acc.type !== 'LIABILITY') return; // nominal accounts reset, not carried
    const rec = balances[acc.fullacname];
    const balance = rec ? rec.balance : 0;
    if (Math.abs(balance) < 0.005) return;
    const rounded = Math.round(balance * 100) / 100;

    if (acc.type === 'ASSET') {
      lines.push({ account: acc.fullacname, drCr: 'Dr', amount: rounded });
      assetSum += rounded;
    } else {
      lines.push({ account: acc.fullacname, drCr: 'Cr', amount: rounded });
      otherLiabSum += rounded;
    }
  });

  const bfAmount = Math.round((assetSum - otherLiabSum) * 100) / 100;
  if (Math.abs(bfAmount) > 0.005) {
    if (bfAmount >= 0) lines.push({ account: bfAccount.fullacname, drCr: 'Cr', amount: bfAmount });
    else lines.push({ account: bfAccount.fullacname, drCr: 'Dr', amount: -bfAmount });
  }

  return { oldFinYear: oldFinYear, newFinYear: newFinYear, bfAccount: bfAccount.fullacname, lines: lines };
}

function previewCloseFinancialYear(oldFinYear) {
  const plan = buildCloseYearPlan_(oldFinYear);
  const existing = getJournalRowsForFY_(plan.newFinYear);
  return {
    oldFinYear: plan.oldFinYear,
    newFinYear: plan.newFinYear,
    bfAccount: plan.bfAccount,
    lines: plan.lines,
    newFinYearAlreadyHasEntries: existing.length > 0
  };
}

function closeFinancialYear(oldFinYear, passcode) {
  checkPasscode_(passcode);
  const plan = buildCloseYearPlan_(oldFinYear);

  const existing = getJournalRowsForFY_(plan.newFinYear);
  if (existing.length > 0) {
    throw new Error('FY ' + plan.newFinYear + ' already has ' + existing.length +
      ' journal lines — closing again would duplicate opening balances. Remove them first if you need to redo this.');
  }
  if (plan.lines.length === 0) throw new Error('Nothing to carry forward — no non-zero Asset/Liability balances found for ' + oldFinYear);

  const sheet = getJournalSheet_();
  const values = sheet.getDataRange().getValues();
  const col = headerMap_(values);
  const header = values[0].map(h => String(h).trim().toLowerCase());

  let maxJrnlNo = 0;
  for (let i = 1; i < values.length; i++) {
    if (String(values[i][col['finyear']]) !== plan.newFinYear) continue;
    const n = Number(values[i][col['jrnlno']]);
    if (!isNaN(n) && n > maxJrnlNo) maxJrnlNo = n;
  }
  const jrnlNo = maxJrnlNo + 1; // one voucher number for the whole opening-balance posting
  const openDate = finYearBounds_(plan.newFinYear).start;
  const details = 'Opening Balance b/f from ' + plan.oldFinYear;

  const rows = plan.lines.map(l => buildJournalRow_(header, openDate, jrnlNo, l.account, l.drCr, details, l.amount, plan.newFinYear));
  sheet.getRange(sheet.getLastRow() + 1, 1, rows.length, header.length).setValues(rows);
  return { newFinYear: plan.newFinYear, entriesCreated: rows.length, jrnlNo: jrnlNo };
}

// ---------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------

function sendReportEmail(toEmail, subject, htmlBody) {
  if (!toEmail || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(toEmail)) throw new Error('Please enter a valid email address');
  if (!subject) subject = 'Report';
  MailApp.sendEmail({
    to: toEmail,
    subject: subject,
    htmlBody: htmlBody,
    body: 'This report requires an HTML-capable email client to view.'
  });
  return { sent: true, to: toEmail };
}

// ---------------------------------------------------------------------
// ONE-TIME MIGRATION — old schema -> new line-item schema
// ---------------------------------------------------------------------

/**
 * Run this ONCE, manually, from the Apps Script editor — select
 * "migrateJournalToLineItems" in the function dropdown and click Run.
 * Do NOT call this via the Web App; it is not wired to doGet/doPost.
 *
 * Converts the OLD Journal schema (date, jrnlNo, drAccount, crAccount,
 * details, amount, finYear) into the NEW line-item schema (date, jrnlNo,
 * account, drCr, details, amount, finYear), writing the result into a NEW
 * sheet called "Journal_NEW". It does NOT touch, clear, or delete your
 * existing "Journal" sheet — this is safe to run and re-run.
 *
 * Each old row that has both drAccount and crAccount filled becomes a
 * 2-line voucher (sharing that row's original jrnlNo) — these will show
 * their contra account normally in the Ledger, same as before. Any old row
 * that was already single-sided (only drAccount OR only crAccount filled —
 * this happened historically for some opening-balance rows) becomes exactly
 * one line, preserved as-is.
 *
 * AFTER running, verify "Journal_NEW" looks right, then manually:
 *   1. Rename the old "Journal" sheet to "Journal_OLD_backup"
 *   2. Rename "Journal_NEW" to "Journal"
 * Only THEN deploy this version of Code.gs (Deploy > Manage deployments >
 * New version). Deploying before renaming will break the live app, since it
 * expects the new column names on a sheet literally named "Journal".
 */
function migrateJournalToLineItems() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const oldSheet = ss.getSheetByName('Journal');
  if (!oldSheet) throw new Error('Sheet "Journal" not found');

  const values = oldSheet.getDataRange().getValues();
  const header = values[0].map(h => String(h).trim().toLowerCase());
  const col = {};
  header.forEach((h, i) => col[h] = i);

  const required = ['date', 'jrnlno', 'draccount', 'craccount', 'details', 'amount', 'finyear'];
  required.forEach(r => {
    if (!(r in col)) throw new Error('Old Journal sheet is missing expected column "' + r + '" — it may already be in the new schema.');
  });

  const newRows = [];
  for (let i = 1; i < values.length; i++) {
    const row = values[i];
    const dr = row[col['draccount']];
    const cr = row[col['craccount']];
    if (!row[col['jrnlno']] && !dr && !cr) continue; // skip fully blank rows

    const date = row[col['date']];
    const jrnlNo = row[col['jrnlno']];
    const details = row[col['details']];
    const amount = row[col['amount']];
    const finYear = row[col['finyear']];

    if (dr) newRows.push([date, jrnlNo, dr, 'Dr', details, amount, finYear]);
    if (cr) newRows.push([date, jrnlNo, cr, 'Cr', details, amount, finYear]);
  }

  let newSheet = ss.getSheetByName('Journal_NEW');
  if (newSheet) ss.deleteSheet(newSheet); // re-run safe: clears any previous attempt
  newSheet = ss.insertSheet('Journal_NEW');
  newSheet.getRange(1, 1, 1, 7).setValues([['date', 'jrnlNo', 'account', 'drCr', 'details', 'amount', 'finYear']]);
  if (newRows.length) newSheet.getRange(2, 1, newRows.length, 7).setValues(newRows);

  Logger.log('Migrated ' + (values.length - 1) + ' old rows into ' + newRows.length + ' new line-item rows in "Journal_NEW".');
  return newRows.length;
}
