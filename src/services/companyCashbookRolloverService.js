/**
 * Cashbook-specific opening calculation.  A year's projected closing becomes
 * the next year's opening, including verified legacy source vouchers whose
 * original SYS_CASH journal debit and credit improperly cancelled each other.
 *
 * Do NOT substitute this projection for the posted accounting / Balance Sheet
 * opening until the defective historical journals are reconciled.
 */
import { CompanyProfile, CompanyLedger } from '../models/index.js';
import { financialModels, financialCollectionExists } from './accountingService.js';
import { buildCompanyCashbook } from './companyCashbookEngine.js';
import { loadCompanyCashbookSources } from './companyCashbookSources.js';
import { rollForwardCashbook } from './cashbookPeriodService.js';
import { discoverFinancialYears } from './financialYearDiscoveryService.js';
import {applyCashCorrections} from './superadminBookCorrectionRules.js';

const money = n => Math.round((Number(n) || 0) * 100) / 100;
const validFY = fy => /^\d{4}-\d{2}$/.test(String(fy || '')) && Number(String(fy).slice(5)) === ((Number(String(fy).slice(0, 4)) + 1) % 100);

async function openingSeeds(tenantKey) {
  const [profile, ledgers] = await Promise.all([
    CompanyProfile.findOne({ tenantKey }).select('firstCashFinancialYear firstCashOpeningBalance').lean(),
    CompanyLedger.find({ tenantKey, systemAccountCode: 'SYS_CASH', status: { $ne: 'INACTIVE' } })
      .select('ownerType openingBalances').lean(),
  ]);
  const companyLedgers = ledgers.filter(x => x.ownerType === 'COMPANY');
  const sources = companyLedgers.length ? companyLedgers : ledgers;
  const seeds = new Map();
  for (const ledger of sources) {
    for (const record of ledger.openingBalances || []) {
      if (!validFY(record.financialYear)) continue;
      const signed = (String(record.type || 'DR').toUpperCase() === 'CR' ? -1 : 1) * Number(record.amount || 0);
      seeds.set(record.financialYear, money((seeds.get(record.financialYear) || 0) + signed));
    }
  }
  if (validFY(profile?.firstCashFinancialYear)) {
    // Superadmin Profile is authoritative for the FIRST FY. Never let a
    // stray user/company CASH ledger opening override it or restart a later FY.
    return { seeds:new Map([[profile.firstCashFinancialYear,money(profile.firstCashOpeningBalance)]]),
      openingSource:'SUPERADMIN_PROFILE',openingNeedsSetup:false };
  }
  // Legacy compatibility: do not discard existing ledgers, but flag their
  // opening as provisional until the first cash FY is set in Profile.
  return { seeds,openingSource:'LEGACY_CASH_LEDGER',openingNeedsSetup:true };
}

async function postedCashbookYearMovement({ tenantKey, financialYear }) {
  const hasLedger=await financialCollectionExists(tenantKey, financialYear, 'ledgerentries');
  const lines=hasLedger?await financialModels(tenantKey,financialYear).LedgerEntry
    .find({tenantKey,financialYear,status:'POSTED',accountCode:'SYS_CASH',transactionType:{$ne:'SUPERADMIN_BOOK_ADJUSTMENT'}})
    .select('_id transactionId transactionType date createdAt partyGlobalId debit credit narration')
    .sort({date:1,createdAt:1,_id:1}).lean():[];
  const sources=await loadCompanyCashbookSources({tenantKey,financialYear,lines});
  const book=buildCompanyCashbook({lines,...sources,openingBalance:0,enforceSourceDocuments:true});
  const models=financialModels(tenantKey,financialYear);
  const [corrections,adjustmentLines]=await Promise.all([
    models.BookCorrection.find({tenantKey,financialYear,book:'CASH'}).lean(),
    models.LedgerEntry.find({tenantKey,financialYear,status:'POSTED',accountCode:'SYS_CASH',transactionType:'SUPERADMIN_BOOK_ADJUSTMENT'}).select('debit credit').lean(),
  ]);
  const adjusted=applyCashCorrections(book.rows,corrections,0);
  const journalCorrection=adjustmentLines.reduce((n,x)=>n+Number(x.debit||0)-Number(x.credit||0),0);
  return {
    projectedMovement: adjusted.closingBalance,
    journalMovement: money(book.journalClosingBalance+journalCorrection),
    issueCount: adjusted.rows.filter(row=>row.needsCorrection).length,
  };
}

export async function companyCashbookYearOpening({ tenantKey, financialYear }) {
  if (!validFY(financialYear)) throw new Error('Valid Cashbook financial year is required');
  const targetYear = Number(financialYear.slice(0, 4));
  const openingConfig = await openingSeeds(tenantKey);
  const {seeds}=openingConfig;
  const seededYears = [...seeds.keys()].map(fy => Number(fy.slice(0, 4))).filter(y => y <= targetYear).sort((a, b) => a - b);
  // Start from the oldest ACTUAL data year, not registration FY or 15 years
  // of empty FY databases. A misdated Profile opening must not hide 2024-25
  // transactions merely because Profile was originally configured in 2025-26.
  const detected = await discoverFinancialYears({tenantKey,configured:[...seeds.keys()]});
  const discoveredStart = Number(String(detected.firstDataFinancialYear||'').slice(0,4));
  const startYear = Math.min(targetYear,...seededYears,...(discoveredStart>=2000&&discoveredStart<=targetYear?[discoveredStart]:[]));
  const initialFY = `${startYear}-${String((startYear + 1) % 100).padStart(2, '0')}`;
  // Historical FY reads are independent: load them in parallel instead of
  // waiting for N sequential year-database queries on every CASH page open.
  const historicalYears=Array.from({length:targetYear-startYear},(_,i)=>{
    const year=startYear+i;
    return `${year}-${String((year+1)%100).padStart(2,'0')}`;
  });
  const movements=new Map(await Promise.all(historicalYears.map(async fy=>[
    fy,await postedCashbookYearMovement({tenantKey,financialYear:fy}),
  ])));
  const projected = await rollForwardCashbook({
    startYear, targetYear,
    initialOpening: seeds.get(initialFY) || 0,
    explicitOpenings: seeds,
    getYearMovements: financialYear => movements.get(financialYear) || {projectedMovement:0,journalMovement:0,issueCount:0},
  });
  // Journal projection is already available from the same historical
  // snapshots; don't run a SECOND serial rollover just for a warning label.
  // Other finance reports continue to use their authoritative ledger API.
  const journalOpeningBalance = projected.calculatedJournalOpeningBalance;
  return {
    ...projected,
    openingSource:openingConfig.openingSource,
    openingNeedsSetup:openingConfig.openingNeedsSetup || Boolean(seededYears.length && discoveredStart < seededYears[0]),
    journalOpeningBalance,
    provisional: openingConfig.openingNeedsSetup || Boolean(seededYears.length && discoveredStart < seededYears[0]) || projected.priorYearIssues > 0 || projected.mismatchedManualOpenings.length > 0
      || Math.abs(projected.openingBalance - journalOpeningBalance) > 0.005,
    rolloverFromFY: `${targetYear - 1}-${String(targetYear % 100).padStart(2, '0')}`,
    rolloverStartFY: initialFY,
    unseededHistoryLookback: !seededYears.length,
  };
}
