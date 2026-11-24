import { ALLOWED_CATEGORIES, budgetRepo, pengeluaranRepo, stateRepo } from '../config/db.js';
import { formatRupiah, getWibParts } from '../utils/time.js';
import { sendDualNotification } from './notifier.js';

/**
 * Evaluate monthly total & per-category expense budgets after an expense is added.
 * Sends a deduplicated Dual-Channel WA + Web Push warning once at >=80% and once at >=100%.
 */
export async function checkBudgetThresholds(monthStr = getWibParts().monthStr) {
  const budget = budgetRepo.get();
  const hasAnyLimit =
    budget.monthlyLimit > 0 || ALLOWED_CATEGORIES.some((cat) => (budget.byCategory[cat] || 0) > 0);
  if (!hasAnyLimit) return [];

  const summary = pengeluaranRepo.getSummary({ month: monthStr });
  const alertState = stateRepo.getJson('budget_alerts_sent', {}) || {};
  const monthAlerts = alertState[monthStr] || {};
  const triggered = [];

  // 1. Check total monthly limit
  if (budget.monthlyLimit > 0) {
    const pct = Math.round((summary.totalExpense / budget.monthlyLimit) * 100);
    if (pct >= 100 && !monthAlerts.total100) {
      monthAlerts.total100 = true;
      monthAlerts.total80 = true;
      triggered.push({
        scope: 'total',
        level: 100,
        title: `🚨 Budget Bulan ${monthStr} Terlampaui (${pct}%)!`,
        body: `Pengeluaran bulan ini sudah mencapai *${formatRupiah(summary.totalExpense)}* dari batas *${formatRupiah(budget.monthlyLimit)}*.\nYuk rem pengeluaran dulu ya!`,
      });
    } else if (pct >= 80 && !monthAlerts.total80) {
      monthAlerts.total80 = true;
      triggered.push({
        scope: 'total',
        level: 80,
        title: `⚠️ Peringatan Budget Bulanan (${pct}%)`,
        body: `Pengeluaran bulan ${monthStr} sudah *${formatRupiah(summary.totalExpense)}* dari batas *${formatRupiah(budget.monthlyLimit)}* (sisa *${formatRupiah(Math.max(0, budget.monthlyLimit - summary.totalExpense))}*).`,
      });
    }
  }

  // 2. Check per-category limits
  for (const cat of ALLOWED_CATEGORIES) {
    const limit = budget.byCategory[cat] || 0;
    if (limit <= 0) continue;
    const spent = summary.byCategory[cat] || 0;
    const pct = Math.round((spent / limit) * 100);
    const k80 = `cat80:${cat}`;
    const k100 = `cat100:${cat}`;

    if (pct >= 100 && !monthAlerts[k100]) {
      monthAlerts[k100] = true;
      monthAlerts[k80] = true;
      triggered.push({
        scope: cat,
        level: 100,
        title: `🚨 Budget Kategori "${cat}" Penuh (${pct}%)!`,
        body: `Pengeluaran kategori *${cat}* bulan ${monthStr} sudah *${formatRupiah(spent)}* dari batas *${formatRupiah(limit)}*.`,
      });
    } else if (pct >= 80 && !monthAlerts[k80]) {
      monthAlerts[k80] = true;
      triggered.push({
        scope: cat,
        level: 80,
        title: `⚠️ Budget Kategori "${cat}" Hampir Penuh (${pct}%)`,
        body: `Pengeluaran kategori *${cat}* sudah *${formatRupiah(spent)}* dari batas *${formatRupiah(limit)}* (sisa *${formatRupiah(Math.max(0, limit - spent))}*).`,
      });
    }
  }

  if (triggered.length > 0) {
    alertState[monthStr] = monthAlerts;
    stateRepo.setJson('budget_alerts_sent', alertState);

    if (process.env.NODE_ENV !== 'test') {
      for (const item of triggered) {
        await sendDualNotification(item.title, item.body, '/#keuangan', {
          recordForSnooze: false,
          tag: `budget-${monthStr}-${item.scope}-${item.level}`,
        }).catch(() => {});
      }
    }
  }

  return triggered;
}
