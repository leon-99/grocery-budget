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

interface BudgetData {
  currency: string;
  monthlyBudget: number;
  dailyBudget?: number;
  month: string;
  periodStart: string;
  updatedAt: string;
  transactions: Transaction[];
}

type View = "dashboard" | "stats";

let cachedBudgetData: BudgetData | null = null;

function getDailyBudget(data: BudgetData): number {
  return data.dailyBudget ?? 14;
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

function latestTransactionDate(data: BudgetData): string {
  if (data.transactions.length === 0) return data.periodStart;
  return data.transactions.reduce(
    (max, t) => (t.date > max ? t.date : max),
    data.transactions[0].date,
  );
}

function spendingByDate(data: BudgetData): Map<string, number> {
  const map = new Map<string, number>();
  for (const t of data.transactions) {
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

function formatMoney(amount: number, currency: string): string {
  return `${currency} ${amount.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
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

function formatMonth(ym: string): string {
  const [y, m] = ym.split("-").map(Number);
  if (!y || !m) return ym;
  return new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(
    new Date(y, m - 1, 1),
  );
}

function formatTxDayHeader(dateStr: string): string {
  const [y, m, d] = dateStr.split("-").map(Number);
  if (!y || !m || !d) return dateStr;
  return new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    year: "numeric",
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
  const res = await fetch(`${base}${path}`);
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
      <button type="button" class="view-tab${active === "dashboard" ? " active" : ""}" role="tab" aria-selected="${active === "dashboard"}" data-view="dashboard">Dashboard</button>
      <button type="button" class="view-tab${active === "stats" ? " active" : ""}" role="tab" aria-selected="${active === "stats"}" data-view="stats">Stats</button>
    </nav>`;
}

function renderStatsContent(data: BudgetData): string {
  const dailyBudget = getDailyBudget(data);
  const endDate = latestTransactionDate(data);
  const daysAsc = enumerateDays(data.periodStart, endDate);
  const daysDesc = [...daysAsc].reverse();
  const byDate = spendingByDate(data);

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

  const daysCovered = daysAsc.length;
  const allowance = daysCovered * dailyBudget;
  const periodSpent = daysAsc.reduce((sum, d) => sum + (byDate.get(d) ?? 0), 0);
  const diff = allowance - periodSpent;
  const periodSummary =
    diff >= 0
      ? `Available ${formatMoney(diff, data.currency)}`
      : `Overspent by ${formatMoney(-diff, data.currency)}`;

  const monthlySpent = data.transactions.reduce((sum, t) => sum + t.amount, 0);

  return `
    <header class="dashboard-header">
      <h1>Grocery Budget</h1>
      <p class="updated">Updated ${escapeHtml(formatUpdated(data.updatedAt))}</p>
    </header>
    ${renderViewTabs("stats")}
    <p class="subtitle">${escapeHtml(formatMonth(data.month))} · daily cap ${formatMoney(dailyBudget, data.currency)}</p>
    <div class="card">
      <div class="summary-grid">
        <div>
          <div class="stat-label">Days covered</div>
          <div class="stat-value stat-value-sm">${daysCovered}</div>
        </div>
        <div>
          <div class="stat-label">Allowance</div>
          <div class="stat-value stat-value-sm">${formatMoney(allowance, data.currency)}</div>
        </div>
        <div>
          <div class="stat-label">Period spent</div>
          <div class="stat-value stat-value-sm">${formatMoney(periodSpent, data.currency)}</div>
        </div>
        <div>
          <div class="stat-label">Monthly spent</div>
          <div class="stat-value stat-value-sm">${formatMoney(monthlySpent, data.currency)}</div>
        </div>
      </div>
      <p class="stats-highlight">${escapeHtml(periodSummary)}</p>
      <p class="stats-monthly">${formatMoney(monthlySpent, data.currency)} of ${formatMoney(data.monthlyBudget, data.currency)} monthly budget</p>
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
  const spent = data.transactions.reduce((sum, t) => sum + t.amount, 0);
  const left = data.monthlyBudget - spent;
  const pct = Math.min(100, (spent / data.monthlyBudget) * 100);
  const over = spent > data.monthlyBudget;

  const sorted = [...data.transactions].sort((a, b) => {
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
        <div>
          <div class="tx-shop">${escapeHtml(t.shop)}</div>
          <div class="tx-meta">${escapeHtml(t.date)} · ${escapeHtml(t.time)}</div>
        </div>
        <div class="tx-amount">${formatMoney(t.amount, data.currency)}</div>
      </li>`;

  const groupsHtml = groups
    .map((g) => {
      const dayTotal = g.items.reduce((sum, t) => sum + t.amount, 0);
      const items = g.items.map(renderTxItem).join("");
      return `
    <div class="tx-group">
      <div class="tx-day-header">
        <span>${escapeHtml(formatTxDayHeader(g.date))}</span>
        <span class="tx-day-total">${formatMoney(dayTotal, data.currency)}</span>
      </div>
      <ul class="tx-list">${items}</ul>
    </div>`;
    })
    .join("");

  const transactionsBlock =
    data.transactions.length === 0
      ? `<p class="tx-empty">No purchases yet</p>`
      : `<div class="tx-groups">${groupsHtml}</div>`;

  return `
    <header class="dashboard-header">
      <h1>Grocery Budget</h1>
      <p class="updated">Updated ${escapeHtml(formatUpdated(data.updatedAt))}</p>
    </header>
    ${renderViewTabs("dashboard")}
    <p class="subtitle">${escapeHtml(formatMonth(data.month))} · since ${escapeHtml(data.periodStart)}</p>
    <div class="card">
      <div class="stats">
        <div>
          <div class="stat-label">Spent</div>
          <div class="stat-value">${formatMoney(spent, data.currency)}</div>
        </div>
        <div>
          <div class="stat-label">Left</div>
          <div class="stat-value left">${formatMoney(left, data.currency)}</div>
        </div>
      </div>
      <div class="progress-wrap">
        <div class="progress-label">
          <span>${pct.toFixed(0)}% of budget</span>
          <span>${formatMoney(data.monthlyBudget, data.currency)} cap</span>
        </div>
        <div class="progress-bar" role="progressbar" aria-valuenow="${pct.toFixed(0)}" aria-valuemin="0" aria-valuemax="100">
          <div class="progress-fill${over ? " over" : ""}" style="width: ${pct}%"></div>
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
