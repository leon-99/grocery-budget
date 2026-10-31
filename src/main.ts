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
  month: string;
  periodStart: string;
  updatedAt: string;
  transactions: Transaction[];
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
      await renderDashboard(root);
    } else {
      errorEl.textContent = "Incorrect password.";
      input.select();
    }
  });
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

async function renderDashboard(root: HTMLElement): Promise<void> {
  const data = await loadJson<BudgetData>("data.json");
  root.innerHTML = renderDashboardContent(data);
}

async function boot(): Promise<void> {
  const root = document.querySelector<HTMLDivElement>("#app");
  if (!root) return;

  try {
    const config = await loadJson<AppConfig>("config.json");
    if (sessionStorage.getItem(AUTH_KEY) === "1") {
      await renderDashboard(root);
    } else {
      renderGate(root, config);
    }
  } catch (err) {
    root.innerHTML = `<div class="card"><p class="error">Could not load app data. Try again later.</p></div>`;
    console.error(err);
  }
}

boot();
