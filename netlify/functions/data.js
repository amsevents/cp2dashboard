// netlify/functions/data.js
//
// CP2 Logistics Dashboard — Netlify Function
// ===========================================
// Serves the same JSON shape the existing index.html already expects
// (see renderData() in the dashboard's <script>). This replaces the
// Python/Flask backend so the whole thing can deploy on Netlify.
//
// ⚠️ SAME CAVEAT AS THE PYTHON VERSION:
// The Alvys OAuth token exchange is confirmed against their docs. The exact
// resource paths and field names for /loads and /invoices are my best
// inference from Alvys's URL pattern, not confirmed against a live response.
// Check docs.alvys.com/en/api/reference (Loads, Invoices sections) and
// adjust ALVYS_ENDPOINTS / the field-name lookups below if they don't match.

const ALVYS_TOKEN_URL = "https://auth.alvys.com/oauth/token";
const ALVYS_AUDIENCE = "https://api.alvys.com/public/";
const ALVYS_API_BASE = "https://integrations.alvys.com";
const ALVYS_API_VERSION = process.env.ALVYS_API_VERSION || "1.0";

// Confirmed against docs.alvys.com after live testing: plain GET /loads only
// accepts id/loadNumber/orderNumber (single-record lookup, not a list). The
// real way to list/filter loads and invoices is the POST /search endpoints.
const ALVYS_ENDPOINTS = {
  loadsSearch: `/api/p/v${ALVYS_API_VERSION}/loads/search`,
  invoicesSearch: `/api/p/v${ALVYS_API_VERSION}/invoices/search`,
};

// Kept here per your call — server-side only, so it's not exposed to
// visitors even though it stays in the code rather than an env var.
const EIA_KEY = "fEHQ6dpfd8Ti6ipbvdJj969fWAqmOPqiRfjEcF7P";
const EIA_URL = "https://api.eia.gov/v2/petroleum/pri/gnd/data/";

// CP2's fuel surcharge matrix, ported from the existing frontend.
const FSC_MATRIX = [
  [3.20, 3.29, 0.00], [3.30, 3.39, 0.02], [3.40, 3.49, 0.03], [3.50, 3.59, 0.06],
  [3.60, 3.69, 0.08], [3.70, 3.79, 0.09], [3.80, 3.89, 0.11], [3.90, 3.99, 0.12],
  [4.00, 4.09, 0.14], [4.10, 4.19, 0.15], [4.20, 4.29, 0.17], [4.30, 4.39, 0.18],
  [4.40, 4.49, 0.20], [4.50, 4.59, 0.21], [4.60, 4.69, 0.24], [4.70, 4.79, 0.26],
  [4.80, 4.89, 0.27], [4.90, 4.99, 0.29], [5.00, 5.09, 0.30], [5.10, 5.19, 0.32],
  [5.20, 5.29, 0.34], [5.30, 5.39, 0.35], [5.40, 5.49, 0.37], [5.50, 5.59, 0.39],
  [5.60, 5.69, 0.40], [5.70, 5.79, 0.42], [5.80, 5.89, 0.44], [5.90, 5.99, 0.45],
];

function getFscRate(price) {
  if (price == null) return null;
  for (const [lo, hi, rate] of FSC_MATRIX) {
    if (price >= lo && price <= hi) return rate;
  }
  if (price < 3.20) return 0.0;
  if (price >= 6.0) return Math.round((0.45 + Math.floor((price - 5.9) / 0.1) * 0.02) * 100) / 100;
  return null;
}

// ── Alvys token cache ──────────────────────────────────────────────────────
// Note: Netlify Functions are stateless between cold starts, so this cache
// only helps on "warm" invocations. That's fine — it just means occasional
// extra token requests, not a correctness issue.
let tokenCache = { token: null, expiresAt: 0 };

async function getAlvysToken() {
  const clientId = process.env.ALVYS_CLIENT_ID;
  const clientSecret = process.env.ALVYS_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new Error(
      "ALVYS_CLIENT_ID / ALVYS_CLIENT_SECRET not set. Add them in Netlify: " +
      "Site settings -> Environment variables."
    );
  }

  const now = Date.now() / 1000;
  if (tokenCache.token && now < tokenCache.expiresAt - 30) {
    return tokenCache.token;
  }

  const resp = await fetch(ALVYS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      client_secret: clientSecret,
      audience: ALVYS_AUDIENCE,
      grant_type: "client_credentials",
    }),
  });
  if (!resp.ok) {
    throw new Error(`Alvys token request failed: ${resp.status} ${await resp.text()}`);
  }
  const data = await resp.json();
  tokenCache.token = data.access_token;
  tokenCache.expiresAt = now + (data.expires_in || 3600);
  return tokenCache.token;
}

async function alvysGet(path, params = {}) {
  const token = await getAlvysToken();
  const url = new URL(ALVYS_API_BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) {
    throw new Error(`Alvys API ${path} failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

async function alvysPost(path, body) {
  const token = await getAlvysToken();
  const resp = await fetch(`${ALVYS_API_BASE}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    throw new Error(`Alvys API ${path} failed: ${resp.status} ${await resp.text()}`);
  }
  return resp.json();
}

// ── Data fetchers ──────────────────────────────────────────────────────────

async function fetchLoads() {
  try {
    // Confirmed request shape from docs.alvys.com/reference/loads/search-loads.
    // Status enum confirmed from the docs: In Review, Open, Quoted, Reserved,
    // Covered, Dispatched, In Transit, Delivered, TONU, Released, Queued,
    // Invoiced, Financed, Completed, Paid, Cancelled.
    const data = await alvysPost(ALVYS_ENDPOINTS.loadsSearch, {
      Page: 0,
      PageSize: 200,
      Status: ["Dispatched", "In Transit"],
    });
    // Logging the FULL first item (no truncation) — the earlier 1000-char
    // slice cut off before reaching rate/miles/second-stop data, which is
    // exactly what we need to confirm next.
    console.log("Alvys /loads/search Total:", data.Total, "| First item keys:", Object.keys(data.Items?.[0] || {}));
    console.log("Alvys /loads/search FULL first item:", JSON.stringify(data.Items?.[0]));

    const rawLoads = data.Items || data.items || data.results || data.loads || (Array.isArray(data) ? data : []);

    let totalMiles = 0;
    let totalRevenue = 0;
    const loads = rawLoads.map((l) => {
      // Confirmed structure: each load has a Stops array, each stop has an
      // Address object. First stop ≈ origin, last stop ≈ destination.
      const stops = l.Stops || l.stops || [];
      const firstStop = stops[0];
      const lastStop = stops[stops.length - 1];
      const originAddr = firstStop?.Address || firstStop?.address;
      const destAddr = lastStop?.Address || lastStop?.address;

      // Miles/revenue fields not yet confirmed from a live response — still
      // guessing here. Logging the full object above so we can lock these
      // in on the next pass once the log shows where they actually live.
      const miles = l.miles ?? l.Miles ?? l.totalMiles ?? l.TotalMiles ?? 0;
      const revenue = l.revenue ?? l.Revenue ?? l.rate?.total ?? l.Rate?.Total ?? l.RateTotal ?? 0;
      totalMiles += miles;
      totalRevenue += revenue;
      return {
        id: l.LoadNumber ?? l.loadNumber ?? l.Id ?? l.id,
        origin: originAddr ? `${originAddr.City ?? originAddr.city}, ${originAddr.State ?? originAddr.state}` : "—",
        destination: destAddr ? `${destAddr.City ?? destAddr.city}, ${destAddr.State ?? destAddr.state}` : "—",
        miles,
        revenue,
        agent: l.CustomerSalesAgentName ?? l.customerSalesAgentName ?? l.salesAgent ?? "—",
        driver: l.DriverName ?? l.driverName ?? "—",
        status: l.Status ?? l.status ?? "—",
      };
    });

    return { loads, loadCount: loads.length, totalMiles, totalRevenue, error: null };
  } catch (e) {
    console.error("fetchLoads failed", e);
    return { loads: [], loadCount: 0, totalMiles: 0, totalRevenue: 0, error: `Loads: ${e.message}` };
  }
}

async function fetchAging() {
  try {
    // Confirmed request shape from docs.alvys.com/reference/invoices/search-invoices.
    // Status is conditionally required alongside date ranges — using a wide
    // InvoicedDateRange instead of guessing at invoice status enum values
    // (which weren't documented anywhere I could confirm), then computing
    // "open/unpaid" client-side from each invoice's balance.
    const now = new Date();
    const twoYearsAgo = new Date(now);
    twoYearsAgo.setFullYear(now.getFullYear() - 2);

    const data = await alvysPost(ALVYS_ENDPOINTS.invoicesSearch, {
      Page: 0,
      PageSize: 200,
      InvoicedDateRange: {
        Start: twoYearsAgo.toISOString(),
        End: now.toISOString(),
      },
      // Alvys requires at least one of Status/PONumbers/CustomerId/LoadNumbers/
      // OrderNumbers to be non-empty. "AwaitingPayment" is confirmed directly
      // from Alvys's own validation error message (the real enum is Draft,
      // AwaitingPayment, Paid) — this is what "unpaid/outstanding" means here.
      Status: ["AwaitingPayment"],
    });
    console.log("Alvys /invoices/search Total:", data.Total, "| First item keys:", Object.keys(data.Items?.[0] || {}));
    console.log("Alvys /invoices/search FULL first item:", JSON.stringify(data.Items?.[0]));

    const rawInvoices = data.Items || data.items || data.results || data.invoices || (Array.isArray(data) ? data : []);

    const buckets = { current: 0, d31_60: 0, d61_90: 0, d90plus: 0 };
    const overdueInvoices = [];
    let total = 0;

    for (const inv of rawInvoices) {
      const balance = inv.balance ?? inv.Balance ?? inv.balanceAmount ?? 0;
      // Only count invoices that still have money owed on them.
      if (!balance || balance <= 0) continue;

      const dateStr = inv.invoicedDate ?? inv.InvoicedDate ?? inv.dueDate ?? inv.DueDate;
      let ageDays = 0;
      if (dateStr) {
        const invDate = new Date(dateStr);
        if (!isNaN(invDate)) {
          ageDays = Math.floor((now - invDate) / (1000 * 60 * 60 * 24));
        }
      }
      total += balance;

      const entry = {
        load_id: inv.loadNumber ?? inv.LoadNumber ?? inv.loadNumbers?.[0] ?? "—",
        customer: inv.customerName ?? inv.CustomerName ?? "—",
        balance,
        age_days: ageDays,
      };

      if (ageDays <= 30) buckets.current += balance;
      else if (ageDays <= 60) { buckets.d31_60 += balance; overdueInvoices.push(entry); }
      else if (ageDays <= 90) { buckets.d61_90 += balance; overdueInvoices.push(entry); }
      else { buckets.d90plus += balance; overdueInvoices.push(entry); }
    }

    return {
      aging: { total, ...buckets, overdue_invoices: overdueInvoices },
      error: null,
    };
  } catch (e) {
    console.error("fetchAging failed", e);
    return { aging: { total: 0 }, error: `AR Aging: ${e.message}` };
  }
}

async function fetchDieselPrice() {
  try {
    const url = new URL(EIA_URL);
    const params = {
      api_key: EIA_KEY,
      frequency: "weekly",
      "data[0]": "value",
      "facets[product][]": "EPD2D",
      "facets[process][]": "PTE",
      "facets[duoarea][]": "NUS",
      "sort[0][column]": "period",
      "sort[0][direction]": "desc",
      length: 1,
    };
    Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`EIA request failed: ${resp.status}`);
    const data = await resp.json();
    const item = data?.response?.data?.[0];
    if (!item) throw new Error("EIA returned no data");
    return { price: parseFloat(item.value), period: item.period, error: null };
  } catch (e) {
    console.error("fetchDieselPrice failed", e);
    return { price: null, period: null, error: `Diesel price: ${e.message}` };
  }
}

// Motive's real API, confirmed from https://developer.gomotive.com:
//   - Base URL: https://api.gomotive.com
//   - Auth: simple per-company API key in the "X-Api-Key" header
//     (generate it in Motive: Admin -> Developers -> +Request API Key)
//   - Endpoint used here: v1/hours_of_service — returns HOS/duty status
//     for all drivers in one call.
//
// ⚠️ I confirmed the endpoint and auth header from Motive's docs, but not
// the exact field names in its JSON response (their docs describe the data
// in prose, not a sample payload). The mapping below is my best guess —
// once this runs once, check Netlify's function logs for the raw Motive
// response and adjust the field names if they don't line up.
const MOTIVE_API_BASE = "https://api.gomotive.com";

async function fetchMotive() {
  const apiKey = process.env.MOTIVE_API_KEY;
  if (!apiKey) {
    return { motive: { drivers: [] }, error: "Motive: MOTIVE_API_KEY not set — panel disabled" };
  }

  try {
    const resp = await fetch(`${MOTIVE_API_BASE}/v1/hours_of_service`, {
      headers: { "X-Api-Key": apiKey },
    });
    if (!resp.ok) {
      throw new Error(`Motive API failed: ${resp.status} ${await resp.text()}`);
    }
    const data = await resp.json();
    // Confirmed shape: {"hours_of_services":[{"hours_of_service":{...}}]} —
    // each record is wrapped one level deeper than I originally guessed.
    const rawEntries = data.hours_of_services || data.hours_of_service || data.drivers || (Array.isArray(data) ? data : []);
    console.log("Motive: total records:", rawEntries.length, "| First entry FULL:", JSON.stringify(rawEntries[0]));

    // ⚠️ Confirmed from a live response: this endpoint gives duration
    // ALREADY LOGGED today (driving_duration, on_duty_duration, etc., in
    // seconds) — not remaining/available time. Your dashboard's labels say
    // "drive left" / "shift left", which implies remaining allowance, so
    // these numbers won't mean what those labels say until we either
    // relabel them or switch to Motive's v1/available_time endpoint, which
    // is the one actually meant for "remaining time." Flagging rather than
    // quietly mislabeling.
    function formatDuration(seconds) {
      if (seconds == null) return null;
      const h = Math.floor(seconds / 3600);
      const m = Math.floor((seconds % 3600) / 60);
      return `${h}:${String(m).padStart(2, "0")}`;
    }

    const drivers = rawEntries.map((entry) => {
      const hos = entry.hours_of_service || entry;
      const d = hos.driver || {};
      return {
        name: d.first_name ? `${d.first_name} ${d.last_name || ""}`.trim() : d.name || "—",
        vehicle: "", // Not present on this endpoint's response.
        status: "", // Not present on this endpoint's response — see note above.
        location: "", // Not present on this endpoint's response.
        hos_drive: formatDuration(hos.driving_duration),
        hos_shift: formatDuration(hos.on_duty_duration),
        hos_cycle: null, // Not available from this endpoint.
      };
    });

    return { motive: { drivers }, error: null };
  } catch (e) {
    console.error("fetchMotive failed", e);
    return { motive: { drivers: [] }, error: `Motive: ${e.message}` };
  }
}

// ── Handler ─────────────────────────────────────────────────────────────────

export default async function handler(request, context) {
  const errors = [];

  const [loadsResult, agingResult, dieselResult, motiveResult] = await Promise.all([
    fetchLoads(),
    fetchAging(),
    fetchDieselPrice(),
    fetchMotive(),
  ]);

  if (loadsResult.error) errors.push(loadsResult.error);
  if (agingResult.error) errors.push(agingResult.error);
  if (dieselResult.error) errors.push(dieselResult.error);
  if (motiveResult.error) errors.push(motiveResult.error);

  const fscRate = getFscRate(dieselResult.price);
  const now = new Date();

  const body = {
    diesel_price: dieselResult.price,
    diesel_period: dieselResult.period,
    fsc_rate: fscRate,
    loads: loadsResult.loads,
    load_count: loadsResult.loadCount,
    total_miles: loadsResult.totalMiles,
    total_revenue: loadsResult.totalRevenue,
    aging: agingResult.aging,
    motive: motiveResult.motive,
    last_updated: now.toLocaleDateString("en-US") + " " +
      now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true }),
    errors,
  };

  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

export const config = {
  path: "/api/data",
};
