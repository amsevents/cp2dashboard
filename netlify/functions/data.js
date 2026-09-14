// netlify/functions/data.js
//
// CP2 Logistics Dashboard — Netlify Function

const ALVYS_TOKEN_URL = "https://auth.alvys.com/oauth/token";
const ALVYS_AUDIENCE = "https://api.alvys.com/public/";
const ALVYS_API_BASE = "https://integrations.alvys.com";
const ALVYS_API_VERSION = process.env.ALVYS_API_VERSION || "1.0";

const ALVYS_ENDPOINTS = {
        loadsSearch: `/api/p/v${ALVYS_API_VERSION}/loads/search`,
};

const EIA_KEY = "fEHQ6dpfd8Ti6ipbvdJj969fWAqmOPqiRfjEcF7P";
const EIA_URL = "https://api.eia.gov/v2/petroleum/pri/gnd/data/";

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

let tokenCache = { token: null, expiresAt: 0 };

async function getAlvysToken() {
        const clientId = process.env.ALVYS_CLIENT_ID;
        const clientSecret = process.env.ALVYS_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
                  throw new Error("ALVYS_CLIENT_ID / ALVYS_CLIENT_SECRET not set.");
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

async function fetchLoads() {
        try {
                  const data = await alvysPost(ALVYS_ENDPOINTS.loadsSearch, {
                              Page: 0,
                              PageSize: 200,
                              Status: ["Dispatched", "In Transit"],
                  });
                  console.log("Alvys /loads/search Total:", data.Total);

          const rawLoads = data.Items || data.items || data.results || data.loads || (Array.isArray(data) ? data : []);

          let totalMiles = 0;
                  let totalRevenue = 0;
                  const loads = rawLoads.map((l) => {
                              const stops = l.Stops || [];
                              const pickup = stops.find((s) => s.StopType === "Pickup") || stops[0];
                              const delivery = [...stops].reverse().find((s) => s.StopType === "Delivery") || stops[stops.length - 1];

                                                   const miles = l.CustomerMileage?.Distance?.Value ?? 0;
                              const revenue = l.CustomerRate?.Amount ?? 0;
                              totalMiles += miles;
                              totalRevenue += revenue;

                                                   return {
                                                                 id: l.LoadNumber ?? l.Id,
                                                                 origin: pickup?.Address ? `${pickup.Address.City}, ${pickup.Address.State}` : "—",
                                                                 destination: delivery?.Address ? `${delivery.Address.City}, ${delivery.Address.State}` : "—",
                                                                 miles,
                                                                 revenue,
                                                                 agent: "—",
                                                                 driver: "—",
                                                                 status: l.Status ?? "—",
                                                   };
                  });

          return { loads, loadCount: loads.length, totalMiles, totalRevenue, error: null };
        } catch (e) {
                  console.error("fetchLoads failed", e);
                  return { loads: [], loadCount: 0, totalMiles: 0, totalRevenue: 0, error: `Loads: ${e.message}` };
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

const MOTIVE_API_BASE = "https://api.gomotive.com";

async function fetchMotive() {
        const apiKey = process.env.MOTIVE_API_KEY;
        if (!apiKey) {
                  return { motive: { drivers: [] }, error: "Motive: MOTIVE_API_KEY not set" };
        }

  try {
            const resp = await fetch(`${MOTIVE_API_BASE}/v1/hours_of_service`, {
                        headers: { "X-Api-Key": apiKey },
            });
            if (!resp.ok) {
                        throw new Error(`Motive API failed: ${resp.status} ${await resp.text()}`);
            }
            const data = await resp.json();
            const rawEntries = data.hours_of_services || data.hours_of_service || data.drivers || (Array.isArray(data) ? data : []);
            console.log("Motive: total records:", rawEntries.length);

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
                                    vehicle: "",
                                    status: "",
                                    location: "",
                                    hos_drive: formatDuration(hos.driving_duration),
                                    hos_shift: formatDuration(hos.on_duty_duration),
                                    hos_cycle: null,
                      };
          });

          return { motive: { drivers }, error: null };
  } catch (e) {
            console.error("fetchMotive failed", e);
            return { motive: { drivers: [] }, error: `Motive: ${e.message}` };
  }
}

export default async function handler(request, context) {
        const errors = [];

  const [loadsResult, dieselResult, motiveResult] = await Promise.all([
            fetchLoads(),
            fetchDieselPrice(),
            fetchMotive(),
          ]);

  if (loadsResult.error) errors.push(loadsResult.error);
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
