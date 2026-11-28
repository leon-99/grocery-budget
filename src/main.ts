import "./style.css";

const AUTH_KEY = "grocery-budget-auth";
const base = import.meta.env.BASE_URL;

interface AppConfig {
  passwordSha256: string;
}

interface Transaction {
  date: string;
  time: string;
  shop: string;
  amount: number;
}

interface BudgetPolicy {
  monthlyAllowance: number;
  anchorMonth: string;
}

interface BudgetData {
  currency: string;
  monthlyBudget: number;
  month: string;
  periodStart: string;
  periodEnd?: string;
  updatedAt: string;
  budget?: BudgetPolicy;
  transactions: Transaction[];
}

interface MonthLedger {
  month: string;
  allowance: number;
  carried: number;
  opening: number;
  spent: number;
  closing: number;
}

type View = "dashboard" | "stats";

let cachedBudgetData: BudgetData | null = null;

function todayYmdInDubai(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Dubai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function calendarMonthBoundsInDubai(): {
  periodStart: string;
  periodEnd: string;
  daysInMonth: number;
} {
  const today = todayYmdInDubai();
  const [y, m] = today.split("-").map(Number);
  const mm = String(m).padStart(2, "0");
  const periodStart = `${y}-${mm}-01`;
  const daysInMonth = new Date(y, m, 0).getDate();
  const periodEnd = `${y}-${mm}-${String(daysInMonth).padStart(2, "0")}`;
  return { periodStart, periodEnd, daysInMonth };
}

function hasCustomPeriod(data: BudgetData): boolean {
  return Boolean(data.periodStart && data.periodEnd);
}

function effectivePeriod(data: BudgetData): {
  periodStart: string;
  periodEnd: string;
  dayCount: number;
} {
  if (hasCustomPeriod(data)) {
    const periodStart = data.periodStart;
    const periodEnd = data.periodEnd!;
    return {
      periodStart,
      periodEnd,
      dayCount: enumerateDays(periodStart, periodEnd).length,
    };
  }
  const dubai = calendarMonthBoundsInDubai();
  return {
    periodStart: dubai.periodStart,
    periodEnd: dubai.periodEnd,
    dayCount: dubai.daysInMonth,
  };
}

function getDailyBudget(opening: number, dayCount: number): number {
  if (dayCount <= 0) return 0;
  return opening / dayCount;
}

function transactionsInEffectivePeriod(data: BudgetData): Transaction[] {
  const { periodStart, periodEnd } = effectivePeriod(data);
  return data.transactions.filter(
    (t) => t.date >= periodStart && t.date <= periodEnd,
  );
}

function formatPeriodRangeLabel(startYmd: string, endYmd: string): string {
  const [sy, sm, sd] = startYmd.split("-").map(Number);
  const [ey, em, ed] = endYmd.split("-").map(Number);
  const start = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
  }).format(new Date(sy, sm - 1, sd));
  const end = new Intl.DateTimeFormat("en-GB", {
    day: "numeric",
    month: "short",
    year: "numeric",
  }).format(new Date(ey, em - 1, ed));
  return `${start} – ${end}`;
}

function parseYmd(ymd: string): Date {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function formatYmd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function minYmd(a: string, b: string): string {
  return a <= b ? a : b;
}

/** Stats daily breakdown: through Dubai today, not beyond period end. */
function statsBreakdownEndYmd(periodEnd: string): string {
  return minYmd(todayYmdInDubai(), periodEnd);
}

/** Calendar-month and custom-period stats: elapsed days from period start through Dubai today (inclusive). */
function statsElapsedDaysAsc(periodStart: string, periodEnd: string): string[] {
  const breakdownEnd = statsBreakdownEndYmd(periodEnd);
  return enumerateDays(periodStart, breakdownEnd);
}

function statsPaceSummary(
  elapsedDaysAsc: string[],
  periodTx: Transaction[],
  dailyBudget: number,
  currency: string,
): {
  daysCovered: number;
  totalAllowed: number;
  actualSpent: number;
  extraAvailable: number;
  extraLine: string;
} {
  const byDate = spendingByDate(periodTx);
  const daysCovered = elapsedDaysAsc.length;
  const totalAllowed = daysCovered * dailyBudget;
  const actualSpent = elapsedDaysAsc.reduce((sum, d) => sum + (byDate.get(d) ?? 0), 0);
  const extraAvailable = totalAllowed - actualSpent;
  const extraLine =
    extraAvailable >= 0
      ? `<div class="stats-summary-row stats-summary-row-under">
          <span class="stats-summary-label">Extra available</span>
          <span class="stats-summary-value">${formatMoney(extraAvailable, currency)}</span>
        </div>`
      : `<div class="stats-summary-row stats-summary-row-over">
          <span class="stats-summary-label">Over by</span>
          <span class="stats-summary-value">${formatMoney(-extraAvailable, currency)}</span>
        </div>`;
  return { daysCovered, totalAllowed, actualSpent, extraAvailable, extraLine };
}

function enumerateDays(startYmd: string, endYmd: string): string[] {
  const days: string[] = [];
  let cur = parseYmd(startYmd);
  const end = parseYmd(endYmd);
  while (cur <= end) {
    days.push(formatYmd(cur));
    cur = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1);
  }
  return days;
}

function spendingByDate(transactions: Transaction[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of transactions) {
    map.set(t.date, (map.get(t.date) ?? 0) + t.amount);
  }
  return map;
}

function dailyVarianceText(spent: number, dailyBudget: number, currency: string): string {
  if (spent > dailyBudget) {
    return `Over by ${formatMoney(spent - dailyBudget, currency)}`;
  }
  return `Under by ${formatMoney(dailyBudget - spent, currency)}`;
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function roundMoney(amount: number): number {
  return Math.round(amount * 100) / 100;
}

function formatMoney(amount: number, currency: string): string {
  const abs = Math.abs(amount).toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return amount < 0 ? `-${currency} ${abs}` : `${currency} ${abs}`;
}

function budgetPolicy(data: BudgetData): BudgetPolicy {
  return {
    monthlyAllowance: data.budget?.monthlyAllowance ?? data.monthlyBudget,
    anchorMonth: data.budget?.anchorMonth ?? data.month,
  };
}

function shiftMonth(yearMonth: string, delta: number): string {
  const [year, month] = yearMonth.split("-").map(Number);
  const date = new Date(year, month - 1 + delta, 1);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

function spendInMonth(transactions: Transaction[], yearMonth: string): number {
  return roundMoney(
    transactions
      .filter((t) => t.date.startsWith(`${yearMonth}-`))
      .reduce((sum, t) => sum + t.amount, 0),
  );
}

/** Opening balance chains from the anchor month. Earlier months do not carry in. */
function monthLedger(data: BudgetData, yearMonth: string): MonthLedger {
  const { monthlyAllowance, anchorMonth } = budgetPolicy(data);
  if (yearMonth < anchorMonth) {
    const spent = spendInMonth(data.transactions, yearMonth);
    return {
      month: yearMonth,
      allowance: monthlyAllowance,
      carried: 0,
      opening: monthlyAllowance,
      spent,
      closing: roundMoney(monthlyAllowance - spent),
    };
  }

  let carried = 0;
  let opening = monthlyAllowance;
  let spent = 0;
  let closing = monthlyAllowance;
  let cursor = anchorMonth;
  while (cursor <= yearMonth) {
    carried = cursor === anchorMonth ? 0 : closing;
    opening = roundMoney(monthlyAllowance + carried);
    spent = spendInMonth(data.transactions, cursor);
    closing = roundMoney(opening - spent);
    if (cursor === yearMonth) break;
    cursor = shiftMonth(cursor, 1);
  }
  return { month: yearMonth, allowance: monthlyAllowance, carried, opening, spent, closing };
}

function focusMonth(data: BudgetData): string {
  if (hasCustomPeriod(data)) return data.periodStart.slice(0, 7);
  return todayYmdInDubai().slice(0, 7);
}

function openingLine(ledger: MonthLedger, currency: string): string {
  const carriedAmount = formatMoney(Math.abs(ledger.carried), currency);
  const joiner = ledger.carried < 0 ? "−" : "+";
  return `Opening ${formatMoney(ledger.opening, currency)} = ${formatMoney(ledger.allowance, currency)} ${joiner} ${carriedAmount} carried`;
}

function budgetProgress(spent: number, opening: number): { label: string; width: number; over: boolean } {
  const over = spent > opening || opening < 0;
  if (opening <= 0) {
    return { label: "Over opening", width: 100, over: true };
  }
  const pct = (spent / opening) * 100;
  return {
    label: `${pct.toFixed(0)}% of opening`,
    width: Math.max(0, Math.min(100, pct)),
    over,
  };
}

function formatUpdated(iso: string): string {
  try {
    return new Intl.DateTimeFormat(undefined, {
      dateStyle: "medium",
      timeStyle: "short",
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function formatTxGroupDayTitle(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "long",
    day: "numeric",
    month: "short",
  }).format(new Date(y, m - 1, d));
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

async function loadJson<T>(path: string): Promise<T> {
  const res = await fetch(`${base}${path}?t=${Date.now()}`, {
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Failed to load ${path}`);
  return res.json() as Promise<T>;
}

function renderGate(root: HTMLElement, config: AppConfig): void {
  root.innerHTML = `
    <div class="gate">
      <div class="card">
        <h1>Grocery Budget</h1>
        <form id="gate-form" autocomplete="off">
          <label for="password">Password</label>
          <p class="error" id="gate-error" role="alert"></p>
          <input id="password" name="password" type="password" inputmode="text" required autofocus />
          <button type="submit">Unlock</button>
        </form>
      </div>
    </div>
  `;

  const form = root.querySelector<HTMLFormElement>("#gate-form")!;
  const errorEl = root.querySelector<HTMLParagraphElement>("#gate-error")!;
  const input = root.querySelector<HTMLInputElement>("#password")!;

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorEl.textContent = "";
    const hash = await sha256Hex(input.value);
    if (hash === config.passwordSha256) {
      sessionStorage.setItem(AUTH_KEY, "1");
      await renderApp(root, "dashboard");
    } else {
      errorEl.textContent = "Incorrect password.";
      input.select();
    }
  });
}

function renderViewTabs(active: View): string {
  return `
    <nav class="view-tabs" role="tablist" aria-label="Views">
      <button type="button" class="view-tab${active === "dashboard" ? " active" : ""}" role="tab" aria-selected="${active === "dashboard"}" data-view="dashboard">Groceries</button>
      <button type="button" class="view-tab${active === "stats" ? " active" : ""}" role="tab" aria-selected="${active === "stats"}" data-view="stats">Stats</button>
    </nav>`;
}

function renderStatsContent(data: BudgetData): string {
  const { periodStart, periodEnd, dayCount } = effectivePeriod(data);
  const periodTx = transactionsInEffectivePeriod(data);
  const ledger = monthLedger(data, focusMonth(data));
  const dailyBudget = getDailyBudget(ledger.opening, dayCount);
  const elapsedDaysAsc = statsElapsedDaysAsc(periodStart, periodEnd);
  const daysDesc = [...elapsedDaysAsc].reverse();
  const byDate = spendingByDate(periodTx);

  const tableRows = daysDesc
    .map((date) => {
      const spent = byDate.get(date) ?? 0;
      const variance = dailyVarianceText(spent, dailyBudget, data.currency);
      const varianceClass = spent > dailyBudget ? " variance-over" : " variance-under";
      return `
      <tr>
        <td>${escapeHtml(date)}</td>
        <td class="num">${formatMoney(spent, data.currency)}</td>
        <td class="num${varianceClass}">${escapeHtml(variance)}</td>
      </tr>`;
    })
    .join("");

  const { daysCovered, totalAllowed, actualSpent, extraLine } = statsPaceSummary(
    elapsedDaysAsc,
    periodTx,
    dailyBudget,
    data.currency,
  );

  const monthlySpent = roundMoney(periodTx.reduce((sum, t) => sum + t.amount, 0));
  const monthlyLeft = roundMoney(ledger.opening - monthlySpent);
  const monthlyClass =
    monthlyLeft < 0 ? " stats-monthly-over" : monthlyLeft > 0 ? " stats-monthly-under" : "";
  const periodLabel = formatPeriodRangeLabel(periodStart, periodEnd);
  const customNote = hasCustomPeriod(data)
    ? `<p class="opening-note">Custom dates use this month's opening balance. Carry still follows calendar months from ${escapeHtml(budgetPolicy(data).anchorMonth)}.</p>`
    : "";

  return `
    <header class="dashboard-header">
      <h1>Grocery Budget</h1>
      <p class="updated">Updated ${escapeHtml(formatUpdated(data.updatedAt))}</p>
    </header>
    ${renderViewTabs("stats")}
    <p class="subtitle">${escapeHtml(periodLabel)} · ${formatMoney(dailyBudget, data.currency)}/day</p>
    <div class="card">
      <p class="opening-line${ledger.opening < 0 ? " over" : ""}">${escapeHtml(openingLine(ledger, data.currency))}</p>
      ${customNote}
      <div class="stats-summary">
        <div class="stats-summary-row">
          <span class="stats-summary-label">Days covered</span>
          <span class="stats-summary-value">${daysCovered}</span>
        </div>
        <div class="stats-summary-row">
          <span class="stats-summary-label">Total allowed</span>
          <span class="stats-summary-value">${formatMoney(totalAllowed, data.currency)}</span>
        </div>
        <div class="stats-summary-row">
          <span class="stats-summary-label">Actual spent</span>
          <span class="stats-summary-value">${formatMoney(actualSpent, data.currency)}</span>
        </div>
        ${extraLine}
      </div>
      <p class="stats-monthly${monthlyClass}">${formatMoney(monthlySpent, data.currency)} spent, ${monthlyLeft < 0 ? "over by" : "left"} ${formatMoney(monthlyLeft, data.currency)}</p>
    </div>
    <div class="card">
      <h2 class="section-title">Daily breakdown</h2>
      <div class="stats-table-wrap">
        <table class="stats-table">
          <thead>
            <tr>
              <th scope="col">Date</th>
              <th scope="col">Spent</th>
              <th scope="col">vs ${formatMoney(dailyBudget, data.currency)}</th>
            </tr>
          </thead>
          <tbody>${tableRows}</tbody>
        </table>
      </div>
    </div>
  `;
}

function renderDashboardContent(data: BudgetData): string {
  const { periodStart, periodEnd, dayCount } = effectivePeriod(data);
  const periodTx = transactionsInEffectivePeriod(data);
  const ledger = monthLedger(data, focusMonth(data));
  const dailyBudget = getDailyBudget(ledger.opening, dayCount);
  const spent = roundMoney(periodTx.reduce((sum, t) => sum + t.amount, 0));
  const left = roundMoney(ledger.opening - spent);
  const progress = budgetProgress(spent, ledger.opening);
  const leftLabel = left < 0 ? "Over by" : "Left";
  const leftClass = left < 0 ? "over" : "left";

  const sorted = [...periodTx].sort((a, b) => {
    const byDate = b.date.localeCompare(a.date);
    return byDate !== 0 ? byDate : b.time.localeCompare(a.time);
  });

  const groups: { date: string; items: Transaction[] }[] = [];
  for (const t of sorted) {
    const last = groups[groups.length - 1];
    if (last && last.date === t.date) {
      last.items.push(t);
    } else {
      groups.push({ date: t.date, items: [t] });
    }
  }

  const renderTxItem = (t: Transaction) => `
      <li class="tx-item">
        <div class="tx-item-main">
          <span class="tx-time">${escapeHtml(t.time)}</span>
          <span class="tx-shop">${escapeHtml(t.shop)}</span>
        </div>
        <div class="tx-amount">${formatMoney(t.amount, data.currency)}</div>
      </li>`;

  const groupsHtml = groups
    .map((g) => {
      const dayTotal = g.items.reduce((sum, t) => sum + t.amount, 0);
      const count = g.items.length;
      const countLabel = count === 1 ? "1 item" : `${count} items`;
      const items = g.items.map(renderTxItem).join("");
      return `
    <section class="tx-group" aria-label="${escapeHtml(formatTxGroupDayTitle(g.date))}">
      <header class="tx-group-head">
        <h3 class="tx-group-title">${escapeHtml(formatTxGroupDayTitle(g.date))}</h3>
        <div class="tx-group-meta">
          <span class="tx-group-count">${countLabel}</span>
          <span class="tx-group-total">Day total ${formatMoney(dayTotal, data.currency)}</span>
        </div>
      </header>
      <ul class="tx-list">${items}</ul>
    </section>`;
    })
    .join("");

  const transactionsBlock =
    periodTx.length === 0
      ? `<p class="tx-empty">No purchases yet</p>`
      : `<div class="tx-groups">${groupsHtml}</div>`;

  const periodLabel = formatPeriodRangeLabel(periodStart, periodEnd);
  const customNote = hasCustomPeriod(data)
    ? `<p class="opening-note">Custom dates use this month's opening balance. Carry still follows calendar months from ${escapeHtml(budgetPolicy(data).anchorMonth)}.</p>`
    : "";

  return `
    <header class="dashboard-header">
      <h1>Grocery Budget</h1>
      <p class="updated">Updated ${escapeHtml(formatUpdated(data.updatedAt))}</p>
    </header>
    ${renderViewTabs("dashboard")}
    <p class="subtitle">${escapeHtml(periodLabel)} · ${formatMoney(dailyBudget, data.currency)}/day</p>
    <div class="card">
      <p class="opening-line${ledger.opening < 0 ? " over" : ""}">${escapeHtml(openingLine(ledger, data.currency))}</p>
      ${customNote}
      <div class="stats">
        <div>
          <div class="stat-label">Spent</div>
          <div class="stat-value">${formatMoney(spent, data.currency)}</div>
        </div>
        <div>
          <div class="stat-label">${leftLabel}</div>
          <div class="stat-value ${leftClass}">${formatMoney(left, data.currency)}</div>
        </div>
      </div>
      <div class="progress-wrap">
        <div class="progress-label">
          <span>${escapeHtml(progress.label)}</span>
          <span>${formatMoney(ledger.opening, data.currency)} opening</span>
        </div>
        <div class="progress-bar" role="progressbar" aria-valuenow="${progress.width.toFixed(0)}" aria-valuemin="0" aria-valuemax="100">
          <div class="progress-fill${progress.over ? " over" : ""}" style="width: ${progress.width}%"></div>
        </div>
      </div>
    </div>
    <div class="card">
      <h2 style="margin:0 0 0.75rem;font-size:1rem;font-weight:600">Transactions</h2>
      ${transactionsBlock}
    </div>
  `;
}

function attachViewTabHandlers(root: HTMLElement, view: View): void {
  root.querySelectorAll<HTMLButtonElement>(".view-tab").forEach((btn) => {
    btn.addEventListener("click", () => {
      const next = btn.dataset.view as View | undefined;
      if (next && next !== view) void renderApp(root, next);
    });
  });
}

async function renderApp(root: HTMLElement, view: View = "dashboard"): Promise<void> {
  if (!cachedBudgetData) {
    cachedBudgetData = await loadJson<BudgetData>("data.json");
  }
  const data = cachedBudgetData;
  
  root.innerHTML = view === "stats" ? renderStatsContent(data) : renderDashboardContent(data);
  
  attachViewTabHandlers(root, view);
}

async function boot(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) return;

  try {
    const config = await loadJson<AppConfig>("config.json");
    if (sessionStorage.getItem(AUTH_KEY) === "1") {
      await renderApp(root, "dashboard");
    } else {
      renderGate(root, config);
    }
  } catch (err) {
    root.innerHTML = `<div class="card"><p class="error">Could not load app data. Try again later.</p></div>`;
    console.error(err);
  }
}

boot();
