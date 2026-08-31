// Curated, realistic travel inventory for the TripPilot demo.
//
// This is deliberately static so the demo is rock-solid live and on video — the
// "real" part of the demo is the Paylink card issuance + passkey approval, not the
// flight search. Each option carries the merchant + merchant_url + price the agent
// passes straight into Paylink `request_payment` so the issued one-time card is
// scoped to that exact merchant.

const FLIGHTS = [
  {
    id: "fl_ua_sfo_jfk",
    merchant: "United Airlines",
    merchant_url: "https://united.com",
    carrier: "United",
    flight_no: "UA 523",
    origin: "SFO",
    destination: "JFK",
    depart: "07:25",
    arrive: "16:05",
    duration: "5h 40m",
    stops: "Nonstop",
    cabin: "Economy",
    price_cents: 38400,
  },
  {
    id: "fl_dl_sfo_jfk",
    merchant: "Delta Air Lines",
    merchant_url: "https://delta.com",
    carrier: "Delta",
    flight_no: "DL 1180",
    origin: "SFO",
    destination: "JFK",
    depart: "10:10",
    arrive: "18:42",
    duration: "5h 32m",
    stops: "Nonstop",
    cabin: "Main Cabin",
    price_cents: 41200,
  },
  {
    id: "fl_b6_sfo_jfk",
    merchant: "JetBlue",
    merchant_url: "https://jetblue.com",
    carrier: "JetBlue",
    flight_no: "B6 916",
    origin: "SFO",
    destination: "JFK",
    depart: "21:55",
    arrive: "06:18",
    duration: "5h 23m",
    stops: "Nonstop",
    cabin: "Blue",
    price_cents: 29900,
  },
  {
    id: "fl_aa_lax_ord",
    merchant: "American Airlines",
    merchant_url: "https://aa.com",
    carrier: "American",
    flight_no: "AA 388",
    origin: "LAX",
    destination: "ORD",
    depart: "08:40",
    arrive: "14:52",
    duration: "4h 12m",
    stops: "Nonstop",
    cabin: "Economy",
    price_cents: 24800,
  },
];

const HOTELS = [
  {
    id: "ht_marriott_downtown",
    merchant: "Marriott",
    merchant_url: "https://marriott.com",
    name: "NYC Marriott Downtown",
    city: "New York",
    area: "Financial District",
    rating: 4.5,
    nightly_cents: 31900,
  },
  {
    id: "ht_westin_times_sq",
    merchant: "Westin",
    merchant_url: "https://westin.com",
    name: "The Westin Times Square",
    city: "New York",
    area: "Midtown",
    rating: 4.3,
    nightly_cents: 28900,
  },
  {
    id: "ht_hyatt_chicago",
    merchant: "Hyatt",
    merchant_url: "https://hyatt.com",
    name: "Hyatt Regency Chicago",
    city: "Chicago",
    area: "Riverfront / Loop",
    rating: 4.4,
    nightly_cents: 25400,
  },
];

const norm = (s) => String(s || "").trim().toLowerCase();

// Match a city name or airport code loosely; empty query returns everything.
export function searchFlights({ origin, destination } = {}) {
  const o = norm(origin), d = norm(destination);
  const hits = FLIGHTS.filter(
    (f) => (!o || norm(f.origin).includes(o) || o.includes(norm(f.origin))) &&
           (!d || norm(f.destination).includes(d) || d.includes(norm(f.destination)))
  );
  return (hits.length ? hits : FLIGHTS).map(withDollars);
}

export function searchHotels({ city } = {}) {
  const c = norm(city);
  const hits = HOTELS.filter((h) => !c || norm(h.city).includes(c) || norm(h.area).includes(c) || norm(h.name).includes(c));
  return (hits.length ? hits : HOTELS).map(withDollars);
}

function withDollars(item) {
  const out = { ...item };
  if (item.price_cents != null) out.price = `$${(item.price_cents / 100).toFixed(2)}`;
  if (item.nightly_cents != null) out.nightly = `$${(item.nightly_cents / 100).toFixed(2)}/night`;
  return out;
}
