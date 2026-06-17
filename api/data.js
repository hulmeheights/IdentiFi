// /api/data — SportsAI prediction engine (Vercel serverless, Node 18+)
// Primary source: openfootball public JSON (keyless). Optional real-time overlay
// from API-Football if APIFOOTBALL_KEY is set as a Vercel environment variable.

const FEED = "https://raw.githubusercontent.com/openfootball/worldcup.json/master/2026/worldcup.json";

// --- My team strength ratings (Elo-style). This is the "model". ---
// Edit these to tune predictions. Default for any unlisted team: 1750.
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
// Name normaliser — maps feed spellings to my rating keys.
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
// Knockout slots ("2A", "W74", "3A/B/C/D/F") aren't real teams yet — skip prediction.
const isReal = n => n && !/[0-9/]/.test(n);
// Loose normaliser for matching API-Football team names to feed names.
const key = s => (s || "").toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");
const LIVE_ALIAS = { usa: "unitedstates", korearepublic: "southkorea", czechia: "czechrepublic",
  iriran: "iran", turkiye: "turkey", cotedivoire: "ivorycoast", caboverde: "capeverde",
  congodr: "drcongo", drcongo: "drcongo" };
const lkey = s => { const k = key(s); return LIVE_ALIAS[k] || k; };

// Win/Draw/Win from two ratings. Returns [home%, draw%, away%] integers summing 100.
function predict(home, away) {
  let rh = rating(home), ra = rating(away);
  // mild host edge during group games played in-country (approx: any host team)
  if (HOSTS.has(norm(home))) rh += 25;
  if (HOSTS.has(norm(away))) ra += 25;
  const d = rh - ra;
  const eHome = 1 / (1 + Math.pow(10, -d / 400));      // Elo expected score (0..1)
  const pDraw = 0.30 * Math.exp(-Math.abs(d) / 280);   // ~30% when even, decays with gap
  let ph = (1 - pDraw) * eHome;
  let pa = (1 - pDraw) * (1 - eHome);
  let arr = [ph, pDraw, pa].map(x => x * 100);
  // round to ints summing to 100
  let r = arr.map(Math.round);
  let diff = 100 - r.reduce((a, b) => a + b, 0);
  r[r.indexOf(Math.max(...r))] += diff;
  return r;
}

function buildStandings(matches) {
  const tbl = {};
  for (const m of matches) {
    if (!m.group || m.group === "?") continue;
    for (const t of [m.team1, m.team2]) {
      tbl[m.group] = tbl[m.group] || {};
      tbl[m.group][t] = tbl[m.group][t] || { team: t, P:0,W:0,D:0,L:0,GF:0,GA:0,Pts:0 };
    }
    const ft = m.score && m.score.ft;
    if (!ft) continue;
    const [h, a] = ft, g = tbl[m.group];
    g[m.team1].P++; g[m.team2].P++;
    g[m.team1].GF += h; g[m.team1].GA += a;
    g[m.team2].GF += a; g[m.team2].GA += h;
    if (h > a) { g[m.team1].W++; g[m.team1].Pts += 3; g[m.team2].L++; }
    else if (h < a) { g[m.team2].W++; g[m.team2].Pts += 3; g[m.team1].L++; }
    else { g[m.team1].D++; g[m.team2].D++; g[m.team1].Pts++; g[m.team2].Pts++; }
  }
  const out = {};
  for (const grp of Object.keys(tbl).sort()) {
    out[grp] = Object.values(tbl[grp]).sort((x, y) =>
      y.Pts - x.Pts || (y.GF - y.GA) - (x.GF - x.GA) || y.GF - x.GF);
  }
  return out;
}

// Strength-based championship estimate (not a full bracket sim — labelled as estimate).
function titleOdds(teams) {
  const w = teams.map(t => ({ t, w: Math.exp((rating(t) - 1900) / 55) }));
  const tot = w.reduce((s, x) => s + x.w, 0);
  return w.map(x => ({ team: x.t, pct: +(100 * x.w / tot).toFixed(1) }))
          .sort((a, b) => b.pct - a.pct);
}

async function fetchLiveOverlay() {
  const apiKey = process.env.APIFOOTBALL_KEY;
  if (!apiKey) return { live: false };
  try {
    // league=1 is the FIFA World Cup in API-Football; falls back to all live if empty.
    let r = await fetch("https://v3.football.api-sports.io/fixtures?live=all&league=1", {
      headers: { "x-apisports-key": apiKey }
    });
    let j = await r.json();
    if (!j.response || !j.response.length) {
      r = await fetch("https://v3.football.api-sports.io/fixtures?live=all", { headers: { "x-apisports-key": apiKey } });
      j = await r.json();
    }
    const fixtures = (j.response || []).map(f => ({
      home: f.teams.home.name, away: f.teams.away.name,
      gh: f.goals.home ?? 0, ga: f.goals.away ?? 0, minute: f.fixture.status.elapsed
    }));
    return { live: true, fixtures };
  } catch (e) { return { live: false, error: String(e) }; }
}

export default async function handler(req, res) {
  try {
    const r = await fetch(FEED, { headers: { "cache-control": "no-cache" } });
    const data = await r.json();
    const raw = data.matches || [];

    const matches = raw.map(m => {
      const ft = m.score && m.score.ft;
      const tbd = !(isReal(m.team1) && isReal(m.team2));
      const probs = tbd ? null : predict(m.team1, m.team2);
      const pickIdx = probs ? probs.indexOf(Math.max(...probs)) : -1;
      const pick = !probs ? null : (pickIdx === 1 ? "Draw" : [m.team1, null, m.team2][pickIdx]);
      return {
        round: m.round, group: m.group || null, date: m.date, time: m.time || null,
        home: m.team1, away: m.team2, ground: m.ground || null, tbd,
        played: !!ft, score: ft || null,
        probs, pick, confidence: probs ? probs[pickIdx] : null,
        hit: ft && probs ? ((ft[0] > ft[1] && pickIdx === 0) || (ft[0] < ft[1] && pickIdx === 2) || (ft[0] === ft[1] && pickIdx === 1)) : null
      };
    });

    const standings = buildStandings(raw);
    const teams = [...new Set(raw.flatMap(m => [m.team1, m.team2]).filter(isReal))];
    const odds = titleOdds(teams).slice(0, 10);
    const overlay = await fetchLiveOverlay();

    // Merge any in-play games onto our matches (match by normalised team names).
    let inPlayCount = 0;
    if (overlay.live) {
      for (const lf of overlay.fixtures) {
        const m = matches.find(x => !x.played && !x.tbd &&
          lkey(x.home) === lkey(lf.home) && lkey(x.away) === lkey(lf.away));
        if (m) { m.inPlay = true; m.score = [lf.gh, lf.ga]; m.minute = lf.minute; inPlayCount++; }
      }
    }

    const played = matches.filter(m => m.played);
    const hits = played.filter(m => m.hit).length;

    res.setHeader("Cache-Control", "s-maxage=900, stale-while-revalidate=1800");
    res.status(200).json({
      updated: new Date().toISOString(),
      source: "openfootball (keyless)" + (overlay.live ? " + API-Football live overlay" : ""),
      realtime: overlay.live,
      inPlay: inPlayCount,
      record: { played: played.length, correct: hits, pct: played.length ? Math.round(100 * hits / played.length) : null },
      matches, standings, titleOdds: odds
    });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
}
