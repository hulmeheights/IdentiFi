// /api/data — identifi prediction engine (Vercel serverless, Node 18+)
// Schedule + canonical results: openfootball (keyless).
// LIVE layer: worldcup26.ir (keyless, real-time) — falls back to API-Football
// (env APIFOOTBALL_KEY) if the keyless source is unavailable.

const FEED = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";
const WC26 = "https://worldcup26.ir/get/games";

// --- My team strength ratings (Elo-style). This is the "model". ---
const RATINGS = {
  "Spain":2090,"France":2085,"Argentina":2070,"England":2050,"Germany":2040,
  "Brazil":2035,"Portugal":2010,"Netherlands":1990,"Belgium":1970,"Croatia":1950,
  "Uruguay":1945,"Colombia":1925,"Morocco":1920,"Mexico":1905,"United States":1895,
  "Switzerland":1890,"Japan":1885,"Senegal":1880,"Norway":1865,"Ecuador":1860,
  "Austria":1855,"South Korea":1845,"Czech Republic":1820,"Sweden":1820,"Australia":1820,
  "Canada":1815,"Ivory Coast":1815,"Turkey":1830,"Egypt":1810,"Iran":1805,
  "Algeria":1790,"Scotland":1790,"Ghana":1780,"Paraguay":1780,"Tunisia":1775,
  "Bosnia and Herzegovina":1775,"DR Congo":1760,"Saudi Arabia":1760,"Qatar":1755,
  "Uzbekistan":1740,"Panama":1730,"South Africa":1720,"Iraq":1710,"Cape Verde":1700,
  "Jordan":1700,"New Zealand":1690,"Curacao":1660,"Haiti":1650
};
const ALIAS = {
  "USA":"United States","Korea Republic":"South Korea","Czechia":"Czech Republic",
  "IR Iran":"Iran","Iran (Islamic Republic of)":"Iran","Türkiye":"Turkey","Turkiye":"Turkey",
  "Côte d'Ivoire":"Ivory Coast","Cote d'Ivoire":"Ivory Coast","Cabo Verde":"Cape Verde",
  "Curaçao":"Curacao","Congo DR":"DR Congo","Korea DPR":"North Korea",
  "Bosnia & Herzegovina":"Bosnia and Herzegovina"
};
const HOSTS = new Set(["Mexico","United States","Canada"]);
const norm = n => ALIAS[n] || n;
const rating = n => RATINGS[norm(n)] ?? 1750;
const isReal = n => n && !/[0-9/]/.test(n);
// Loose normaliser for matching team names across feeds.
const key = s => (s || "").toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");
const LIVE_ALIAS = { usa:"unitedstates", korearepublic:"southkorea", czechia:"czechrepublic",
  iriran:"iran", turkiye:"turkey", cotedivoire:"ivorycoast", caboverde:"capeverde",
  congodr:"drcongo", drcongo:"drcongo", democraticrepublicofthecongo:"drcongo" };
const lkey = s => { const k = key(s); return LIVE_ALIAS[k] || k; };

function predict(home, away) {
  let rh = rating(home), ra = rating(away);
  if (HOSTS.has(norm(home))) rh += 25;
  if (HOSTS.has(norm(away))) ra += 25;
  const d = rh - ra;
  const eHome = 1 / (1 + Math.pow(10, -d / 400));
  const pDraw = 0.30 * Math.exp(-Math.abs(d) / 280);
  let r = [(1 - pDraw) * eHome, pDraw, (1 - pDraw) * (1 - eHome)].map(x => Math.round(x * 100));
  r[r.indexOf(Math.max(...r))] += 100 - r.reduce((a, b) => a + b, 0);
  return r;
}
const hitOf = (pi, sc) => (sc[0] > sc[1] && pi === 0) || (sc[0] < sc[1] && pi === 2) || (sc[0] === sc[1] && pi === 1);

// Standings computed from the MERGED matches (so live results count immediately).
function buildStandings(matches) {
  const tbl = {};
  for (const m of matches) {
    if (!m.group || m.tbd) continue;
    const g = (tbl[m.group] = tbl[m.group] || {});
    for (const t of [m.home, m.away]) g[t] = g[t] || { team:t, P:0,W:0,D:0,L:0,GF:0,GA:0,Pts:0 };
    if (!m.played || !m.score) continue;
    const [h, a] = m.score;
    g[m.home].P++; g[m.away].P++;
    g[m.home].GF += h; g[m.home].GA += a; g[m.away].GF += a; g[m.away].GA += h;
    if (h > a) { g[m.home].W++; g[m.home].Pts += 3; g[m.away].L++; }
    else if (h < a) { g[m.away].W++; g[m.away].Pts += 3; g[m.home].L++; }
    else { g[m.home].D++; g[m.away].D++; g[m.home].Pts++; g[m.away].Pts++; }
  }
  const out = {};
  for (const grp of Object.keys(tbl).sort())
    out[grp] = Object.values(tbl[grp]).sort((x, y) =>
      y.Pts - x.Pts || (y.GF - y.GA) - (x.GF - x.GA) || y.GF - x.GF);
  return out;
}

function titleOdds(teams) {
  const w = teams.map(t => ({ t, w: Math.exp((rating(t) - 1900) / 55) }));
  const tot = w.reduce((s, x) => s + x.w, 0);
  return w.map(x => ({ team: x.t, pct: +(100 * x.w / tot).toFixed(1) }))
          .sort((a, b) => b.pct - a.pct);
}

// ---- LIVE source 1: worldcup26.ir (keyless) ----
async function fetchWC26() {
  try {
    const r = await fetch(WC26, { headers: { accept: "application/json" } });
    if (!r.ok) return null;
    const j = await r.json();
    return Array.isArray(j.games) ? j.games : null;
  } catch (e) { return null; }
}
function wc26State(g) {
  const score = [parseInt(g.home_score) || 0, parseInt(g.away_score) || 0];
  const t = (g.time_elapsed ?? "").toString().trim().toLowerCase();
  if (g.finished === "TRUE" || t === "finished" || t === "ft") return { finished: true, score };
  if (t === "" || t === "notstarted" || t === "ns" || t === "upcoming") return { finished: false, inPlay: false };
  if (t.includes("ht") || t.includes("half")) return { finished: false, inPlay: true, minute: 45, status: "HT", score };
  const num = parseInt(t, 10);
  if (!isNaN(num)) return { finished: false, inPlay: true, minute: num, status: num > 45 ? "2H" : "1H", score };
  return { finished: false, inPlay: true, minute: null, status: "LIVE", score };
}

// ---- LIVE source 2 (fallback): API-Football ----
async function fetchAPIFootball() {
  const apiKey = process.env.APIFOOTBALL_KEY;
  if (!apiKey) return null;
  try {
    let r = await fetch("https://v3.football.api-sports.io/fixtures?live=all&league=1", { headers: { "x-apisports-key": apiKey } });
    let j = await r.json();
    if (!j.response || !j.response.length) {
      r = await fetch("https://v3.football.api-sports.io/fixtures?live=all", { headers: { "x-apisports-key": apiKey } });
      j = await r.json();
    }
    return (j.response || []).map(f => ({
      home: f.teams.home.name, away: f.teams.away.name,
      gh: f.goals.home ?? 0, ga: f.goals.away ?? 0,
      minute: f.fixture.status.elapsed, status: f.fixture.status.short
    }));
  } catch (e) { return null; }
}

export default async function handler(req, res) {
  try {
    const r = await fetch(FEED, { headers: { "cache-control": "no-cache" } });
    const raw = (await r.json()).matches || [];

    const matches = raw.map(m => {
      const ft = m.score && m.score.ft;
      const tbd = !(isReal(m.team1) && isReal(m.team2));
      const probs = tbd ? null : predict(m.team1, m.team2);
      const pi = probs ? probs.indexOf(Math.max(...probs)) : -1;
      return {
        round: m.round, group: m.group || null, date: m.date, time: m.time || null,
        home: m.team1, away: m.team2, ground: m.ground || null, tbd,
        played: !!ft, score: ft || null,
        probs, pick: !probs ? null : (pi === 1 ? "Draw" : [m.team1, null, m.team2][pi]),
        confidence: probs ? probs[pi] : null,
        hit: ft && probs ? hitOf(pi, ft) : null
      };
    });
    const findMatch = (h, a) => matches.find(x => !x.tbd && lkey(x.home) === lkey(h) && lkey(x.away) === lkey(a));

    let source = "openfootball (keyless)", realtime = false, inPlayCount = 0, refreshMs = 900000;

    // LIVE 1: worldcup26.ir — keyless, poll fast
    const wc26 = await fetchWC26();
    if (wc26) {
      source = "openfootball + worldcup26.ir (keyless live)"; realtime = true; refreshMs = 60000;
      for (const g of wc26) {
        const m = findMatch(g.home_team_name_en, g.away_team_name_en);
        if (!m) continue;
        const st = wc26State(g);
        if (st.finished && st.score) {
          if (!m.played) { m.played = true; m.inPlay = false; m.score = st.score;
            const pi = m.probs ? m.probs.indexOf(Math.max(...m.probs)) : -1;
            m.hit = m.probs ? hitOf(pi, st.score) : null; }
        } else if (st.inPlay) {
          m.inPlay = true; m.score = st.score; m.minute = st.minute; m.status = st.status; inPlayCount++;
        }
      }
    } else {
      // LIVE 2 (fallback): API-Football — capped, so keep the slow refresh
      const fx = await fetchAPIFootball();
      if (fx) {
        source = "openfootball + API-Football live overlay"; realtime = true; refreshMs = 900000;
        for (const lf of fx) {
          const m = matches.find(x => !x.played && !x.tbd && lkey(x.home) === lkey(lf.home) && lkey(x.away) === lkey(lf.away));
          if (m) { m.inPlay = true; m.score = [lf.gh, lf.ga]; m.minute = lf.minute; m.status = lf.status; inPlayCount++; }
        }
      }
    }

    const standings = buildStandings(matches);
    const teams = [...new Set(matches.flatMap(m => [m.home, m.away]).filter(isReal))];
    const odds = titleOdds(teams).slice(0, 10);
    const played = matches.filter(m => m.played);
    const hits = played.filter(m => m.hit).length;

    res.setHeader("Cache-Control", `s-maxage=${realtime ? 60 : 900}, stale-while-revalidate=120`);
    res.status(200).json({
      updated: new Date().toISOString(), source, realtime, inPlay: inPlayCount, refreshMs,
      record: { played: played.length, correct: hits, pct: played.length ? Math.round(100 * hits / played.length) : null },
      matches, standings, titleOdds: odds
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
