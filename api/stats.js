// /api/stats — post-match team statistics for finished World Cup fixtures.
// Stats are static once a game ends, so we fetch once and cache hard.
// Resolves fixture IDs (season query, with a date-range fallback) then batches
// ?ids= calls which return statistics inline. Uses APIFOOTBALL_KEY. Free-friendly.
// Emits a lightweight _diag so coverage/plan issues are visible.

const LEAGUE = 1, SEASON = 2026;
const API = "https://v3.football.api-sports.io";

const key = s => (s || "").toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");
const ALIAS = { usa:"unitedstates", korearepublic:"southkorea", czechia:"czechrepublic",
  iriran:"iran", turkiye:"turkey", cotedivoire:"ivorycoast", caboverde:"capeverde",
  congodr:"drcongo", drcongo:"drcongo", democraticrepublicofthecongo:"drcongo" };
const lkey = s => { const k = key(s); return ALIAS[k] || k; };

async function timedFetch(url, opts = {}, ms = 4500) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); }
  finally { clearTimeout(t); }
}
async function afFetch(url, H, ms = 4500) {
  try { const r = await timedFetch(url, { headers: H }, ms); let j = {}; try { j = await r.json(); } catch {} return { http: r.status, j }; }
  catch (e) { return { http: 0, j: { errors: String(e) } }; }
}

const pick = (arr, type) => { const x = (arr || []).find(s => s.type === type); return x && x.value != null ? x.value : null; };
function teamStats(block) {
  const a = block.statistics || [];
  return { shots: pick(a,"Total Shots"), sot: pick(a,"Shots on Goal"), poss: pick(a,"Ball Possession"),
    passes: pick(a,"Total passes"), passAcc: pick(a,"Passes %"), fouls: pick(a,"Fouls"),
    yellow: pick(a,"Yellow Cards"), red: pick(a,"Red Cards"), offsides: pick(a,"Offsides"), corners: pick(a,"Corner Kicks") };
}
function mapFixture(f) {
  const st = f.statistics || [];
  if (!st.length) return null;
  const h = st.find(s => s.team && s.team.id === f.teams.home.id);
  const a = st.find(s => s.team && s.team.id === f.teams.away.id);
  if (!h && !a) return null;
  return { home: h ? teamStats(h) : null, away: a ? teamStats(a) : null };
}

export default async function handler(req, res) {
  const apiKey = process.env.APIFOOTBALL_KEY;
  if (!apiKey) { res.setHeader("Cache-Control", "s-maxage=300"); return res.status(200).json({ stats: {}, note: "no key" }); }
  const H = { "x-apisports-key": apiKey };
  const diag = {};
  try {
    const today = new Date().toISOString().slice(0, 10);

    // Probe plan/quota (free, doesn't count against quota).
    const st = await afFetch(`${API}/status`, H, 3000);
    diag.plan = st.j?.response?.subscription?.plan ?? null;
    diag.requests = st.j?.response?.requests ?? null;

    // Primary: league + season.
    const a = await afFetch(`${API}/fixtures?league=${LEAGUE}&season=${SEASON}`, H);
    diag.seasonQuery = { http: a.http, results: a.j.results ?? null, errors: a.j.errors ?? null };
    let fixtures = a.j.response || [];

    // Fallback: date range without season (in case season is plan-gated).
    if (!fixtures.length) {
      const b = await afFetch(`${API}/fixtures?league=${LEAGUE}&from=2026-06-11&to=${today}`, H);
      diag.dateRange = { http: b.http, results: b.j.results ?? null, errors: b.j.errors ?? null };
      fixtures = b.j.response || [];
    }

    diag.sample = fixtures[0] ? { id: fixtures[0].fixture?.id, home: fixtures[0].teams?.home?.name,
      away: fixtures[0].teams?.away?.name, status: fixtures[0].fixture?.status?.short } : null;

    const finished = fixtures.filter(f => ["FT", "AET", "PEN"].includes(f.fixture?.status?.short));
    diag.finishedCount = finished.length;
    const ids = finished.map(f => f.fixture.id);

    const batches = [];
    for (let i = 0; i < ids.length; i += 20) batches.push(ids.slice(i, i + 20).join("-"));
    const results = await Promise.all(batches.map(b =>
      afFetch(`${API}/fixtures?ids=${b}`, H, 5000).then(x => x.j.response || []).catch(() => [])));

    const stats = {};
    for (const arr of results) for (const f of arr) {
      const m = mapFixture(f);
      if (m) stats[lkey(f.teams.home.name) + "__" + lkey(f.teams.away.name)] = m;
    }
    const count = Object.keys(stats).length;
    // Cache hard only when we actually have data; keep it short while empty so we can recover.
    res.setHeader("Cache-Control", count ? "s-maxage=21600, stale-while-revalidate=86400" : "s-maxage=120");
    res.status(200).json({ stats, count, _diag: diag, updated: new Date().toISOString() });
  } catch (e) {
    res.setHeader("Cache-Control", "s-maxage=60");
    res.status(200).json({ stats: {}, error: String(e), _diag: diag });
  }
}
