// /api/stats — post-match team statistics for finished World Cup fixtures.
// Stats are static once a game ends, so we fetch once and cache hard.
// One key call resolves fixture IDs; batched ?ids= calls return stats inline.
// Uses the same APIFOOTBALL_KEY env var as /api/data. Free-tier friendly.

const LEAGUE = 1, SEASON = 2026;
const API = "https://v3.football.api-sports.io";

const key = s => (s || "").toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");
const ALIAS = { usa:"unitedstates", korearepublic:"southkorea", czechia:"czechrepublic",
  iriran:"iran", turkiye:"turkey", cotedivoire:"ivorycoast", caboverde:"capeverde",
  congodr:"drcongo", drcongo:"drcongo", democraticrepublicofthecongo:"drcongo" };
const lkey = s => { const k = key(s); return ALIAS[k] || k; };

async function timedFetch(url, opts = {}, ms = 4000) {
  const c = new AbortController();
  const t = setTimeout(() => c.abort(), ms);
  try { return await fetch(url, { ...opts, signal: c.signal }); }
  finally { clearTimeout(t); }
}

const pick = (arr, type) => { const x = (arr || []).find(s => s.type === type); return x && x.value != null ? x.value : null; };
function teamStats(block) {
  const a = block.statistics || [];
  return {
    shots: pick(a, "Total Shots"),
    sot: pick(a, "Shots on Goal"),
    poss: pick(a, "Ball Possession"),
    passes: pick(a, "Total passes"),
    passAcc: pick(a, "Passes %"),
    fouls: pick(a, "Fouls"),
    yellow: pick(a, "Yellow Cards"),
    red: pick(a, "Red Cards"),
    offsides: pick(a, "Offsides"),
    corners: pick(a, "Corner Kicks")
  };
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
  try {
    // 1) Resolve all WC fixtures (ids + status) — one call.
    const fr = await timedFetch(`${API}/fixtures?league=${LEAGUE}&season=${SEASON}`, { headers: H }, 4000);
    const fixtures = ((await fr.json()).response) || [];
    const finished = fixtures.filter(f => ["FT", "AET", "PEN"].includes(f.fixture?.status?.short));
    const ids = finished.map(f => f.fixture.id);

    // 2) Batched ?ids= calls (<=20 each), run in parallel to stay well under the timeout.
    const batches = [];
    for (let i = 0; i < ids.length; i += 20) batches.push(ids.slice(i, i + 20).join("-"));
    const results = await Promise.all(batches.map(b =>
      timedFetch(`${API}/fixtures?ids=${b}`, { headers: H }, 5000)
        .then(r => r.json()).then(j => j.response || []).catch(() => [])
    ));

    const stats = {};
    for (const arr of results) for (const f of arr) {
      const m = mapFixture(f);
      if (m) stats[lkey(f.teams.home.name) + "__" + lkey(f.teams.away.name)] = m;
    }

    // Finished-match stats never change — cache 6h at the edge.
    res.setHeader("Cache-Control", "s-maxage=21600, stale-while-revalidate=86400");
    res.status(200).json({ stats, count: Object.keys(stats).length, updated: new Date().toISOString() });
  } catch (e) {
    res.setHeader("Cache-Control", "s-maxage=120");
    res.status(200).json({ stats: {}, error: String(e) });
  }
}
