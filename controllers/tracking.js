// Live tracking controller.
// - Aircraft: OpenSky Network REST API (/states/all)
// - Vessels:  AISStream.io WebSocket (server-side subscriber, cached in memory)
//
// Both feeds are normalized into a common "entity" shape consumed by the COP
// client (see public/js/cop.js):
//
//   {
//     id:        string,           // stable unique id
//     kind:      'air' | 'sea',
//     callsign:  string | null,
//     country:   string | null,    // ISO country name (best effort)
//     iso2:      string | null,    // 2-letter ISO code when known
//     lat:       number,
//     lon:       number,
//     alt:       number | null,    // meters (air only)
//     heading:   number | null,    // deg
//     speed:     number | null,    // m/s
//     type:      string | null,    // vessel/aircraft type hint
//     updated:   number            // unix seconds
//   }

const https = require('https');
const keys = require('../config/keys');

// ---------- Aircraft: OpenSky ----------------------------------------------

const OPENSKY_URL = 'https://opensky-network.org/api/states/all';
const OPENSKY_TOKEN_URL = 'https://auth.opensky-network.org/auth/realms/opensky-network/protocol/openid-connect/token';
const OPENSKY_TTL_MS = 10_000; // OpenSky anonymous cap ~10s; respect it.

let aircraftCache = { t: 0, data: [] };
let openskyToken = { access_token: null, expires_at: 0 };

function httpRequest(url, opts, body) {
    return new Promise((resolve, reject) => {
        const req = https.request(url, opts, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                if (res.statusCode < 200 || res.statusCode >= 300) {
                    return reject(new Error('HTTP ' + res.statusCode + ': ' + data.slice(0, 200)));
                }
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
            });
        });
        req.on('error', reject);
        if (body) req.write(body);
        req.end();
    });
}

async function getOpenSkyOAuthToken() {
    const c = keys.openskyClient;
    if (!c || !c.clientId || !c.clientSecret) return null;
    if (openskyToken.access_token && Date.now() < openskyToken.expires_at - 30_000) {
        return openskyToken.access_token;
    }
    const body = new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: c.clientId,
        client_secret: c.clientSecret
    }).toString();
    const json = await httpRequest(OPENSKY_TOKEN_URL, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(body)
        }
    }, body);
    openskyToken = {
        access_token: json.access_token,
        expires_at: Date.now() + (json.expires_in || 1800) * 1000
    };
    return openskyToken.access_token;
}

function httpGetJson(url, headers) {
    return httpRequest(url, { method: 'GET', headers: headers || {} });
}

// ICAO24 address prefix -> country (abridged; covers major bloc).
// Full allocation table: https://www.icao.int/publications/Documents/8585_200_en.pdf
const ICAO24_PREFIXES = [
    ['a', 'United States', 'US'],
    ['c0', 'Canada', 'CA'], ['c8', 'Australia', 'AU'],
    ['7c', 'Australia', 'AU'],
    ['40', 'United Kingdom', 'GB'], ['43', 'United Kingdom', 'GB'],
    ['3c', 'Germany', 'DE'], ['44', 'Belgium', 'BE'],
    ['45', 'Denmark', 'DK'], ['46', 'Finland', 'FI'],
    ['47', 'Greece', 'GR'], ['48', 'Hungary', 'HU'],
    ['49', 'Portugal', 'PT'], ['4a', 'Czechia', 'CZ'],
    ['4b', 'Switzerland', 'CH'], ['4c', 'Ireland', 'IE'],
    ['4d', 'Malta', 'MT'], ['4e', 'Iceland', 'IS'],
    ['38', 'France', 'FR'], ['39', 'France', 'FR'],
    ['30', 'Italy', 'IT'], ['31', 'Italy', 'IT'],
    ['34', 'Spain', 'ES'], ['35', 'Spain', 'ES'],
    ['36', 'Netherlands', 'NL'], ['44', 'Belgium', 'BE'],
    ['10', 'Russia', 'RU'], ['14', 'Russia', 'RU'],
    ['78', 'China', 'CN'], ['71', 'South Korea', 'KR'],
    ['86', 'Japan', 'JP'], ['80', 'India', 'IN'],
    ['e0', 'Argentina', 'AR'], ['e4', 'Brazil', 'BR'],
    ['0d', 'Mexico', 'MX'], ['e8', 'Chile', 'CL'],
    ['06', 'Egypt', 'EG'], ['00', 'Unknown', null]
];

function icaoCountry(icao24) {
    if (!icao24) return { country: null, iso2: null };
    const a = icao24.toLowerCase();
    // Longest-prefix match
    let best = null;
    for (const [pfx, name, iso2] of ICAO24_PREFIXES) {
        if (a.startsWith(pfx) && (!best || pfx.length > best[0].length)) best = [pfx, name, iso2];
    }
    return best ? { country: best[1], iso2: best[2] } : { country: null, iso2: null };
}

async function refreshAircraft() {
    const headers = {};
    const token = await getOpenSkyOAuthToken().catch(e => {
        console.warn('[tracking] OpenSky OAuth failed, falling back:', e.message);
        return null;
    });
    if (token) {
        headers.Authorization = 'Bearer ' + token;
    } else if (keys.openskyAuth) {
        headers.Authorization = 'Basic ' + Buffer.from(keys.openskyAuth).toString('base64');
    }
    const raw = await httpGetJson(OPENSKY_URL, headers);
    const out = [];
    for (const s of (raw.states || [])) {
        const [icao24, callsign, origin_country, , , lon, lat, baro_alt, on_ground,
               velocity, true_track, , , geo_alt] = s;
        if (lat == null || lon == null) continue;
        const cc = icaoCountry(icao24);
        out.push({
            id: 'a:' + icao24,
            kind: 'air',
            callsign: (callsign || '').trim() || null,
            country: origin_country || cc.country,
            iso2: cc.iso2,
            lat, lon,
            alt: geo_alt != null ? geo_alt : baro_alt,
            heading: true_track,
            speed: velocity,
            type: on_ground ? 'ground' : 'airborne',
            updated: raw.time
        });
    }
    aircraftCache = { t: Date.now(), data: out };
    return out;
}

exports.getAircraft = async function (req, res) {
    try {
        if (Date.now() - aircraftCache.t > OPENSKY_TTL_MS) {
            await refreshAircraft();
        }
        res.json({ count: aircraftCache.data.length, updated: aircraftCache.t, entities: aircraftCache.data });
    } catch (e) {
        console.error('[tracking] aircraft fetch failed:', e.message);
        // Serve stale cache rather than break the HUD
        res.json({ count: aircraftCache.data.length, updated: aircraftCache.t, entities: aircraftCache.data, stale: true });
    }
};

// ---------- Vessels: AISStream.io ------------------------------------------
//
// AISStream requires a WebSocket subscription. We keep an in-memory map keyed
// by MMSI, expiring entries older than VESSEL_TTL_MS. The client hits
// /api/tracking/vessels which returns the current snapshot.

const VESSEL_TTL_MS = 10 * 60 * 1000; // 10 min since last report
const vessels = new Map();

// MMSI MID (first 3 digits) -> country. Abridged; extend as needed.
const MID = {
    '366':'United States','367':'United States','368':'United States','369':'United States',
    '338':'United States','303':'United States','379':'United States',
    '316':'Canada','232':'United Kingdom','233':'United Kingdom','234':'United Kingdom','235':'United Kingdom',
    '211':'Germany','218':'Germany','227':'France','228':'France','226':'France',
    '247':'Italy','248':'Malta','224':'Spain','225':'Spain',
    '244':'Netherlands','245':'Netherlands','246':'Netherlands',
    '273':'Russia','205':'Belgium','219':'Denmark','220':'Denmark',
    '230':'Finland','265':'Sweden','266':'Sweden','257':'Norway','258':'Norway','259':'Norway',
    '412':'China','413':'China','414':'China','416':'Taiwan',
    '431':'Japan','432':'Japan','440':'South Korea','441':'South Korea',
    '419':'India','563':'Singapore','525':'Indonesia','538':'Marshall Islands',
    '636':'Liberia','371':'Panama','370':'Panama','355':'Panama',
    '710':'Brazil','701':'Argentina','725':'Chile','730':'Colombia',
    '503':'Australia','512':'New Zealand'
};
function mmsiCountry(mmsi) {
    if (!mmsi) return null;
    return MID[String(mmsi).substring(0, 3)] || null;
}

let wsStarted = false;
function startAisStream() {
    if (wsStarted) return;
    const apiKey = keys.aisStreamKey;
    if (!apiKey) {
        console.warn('[tracking] AISSTREAM_KEY not set; vessel feed disabled.');
        return;
    }
    let WebSocket;
    try { WebSocket = require('ws'); }
    catch { console.warn('[tracking] `ws` module not installed; run `npm i ws`.'); return; }

    wsStarted = true;

    function connect() {
        const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
        ws.on('open', () => {
            console.log('[tracking] AISStream connected');
            ws.send(JSON.stringify({
                APIKey: apiKey,
                BoundingBoxes: [[[-90, -180], [90, 180]]],
                FilterMessageTypes: ['PositionReport', 'ShipStaticData']
            }));
        });
        ws.on('message', buf => {
            try {
                const m = JSON.parse(buf.toString());
                const meta = m.MetaData || {};
                const mmsi = meta.MMSI || meta.MMSI_String;
                if (!mmsi) return;
                const prev = vessels.get(String(mmsi)) || {};
                const pos = (m.Message && (m.Message.PositionReport || {})) || {};
                const stat = (m.Message && (m.Message.ShipStaticData || {})) || {};
                const lat = pos.Latitude ?? prev.lat;
                const lon = pos.Longitude ?? prev.lon;
                if (lat == null || lon == null) return;
                vessels.set(String(mmsi), {
                    id: 's:' + mmsi,
                    kind: 'sea',
                    callsign: (stat.CallSign || meta.ShipName || prev.callsign || '').trim() || null,
                    country: mmsiCountry(mmsi) || prev.country || null,
                    iso2: null,
                    lat, lon,
                    alt: 0,
                    heading: pos.TrueHeading != null && pos.TrueHeading < 360 ? pos.TrueHeading : (pos.Cog ?? prev.heading ?? null),
                    speed: pos.Sog != null ? pos.Sog * 0.5144 : prev.speed ?? null, // knots -> m/s
                    type: stat.Type ? String(stat.Type) : prev.type || 'vessel',
                    updated: Math.floor(Date.now() / 1000)
                });
            } catch (e) { /* ignore malformed frame */ }
        });
        ws.on('close', () => { console.warn('[tracking] AISStream closed; reconnecting in 5s'); setTimeout(connect, 5000); });
        ws.on('error', e => { console.warn('[tracking] AISStream error:', e.message); try { ws.close(); } catch {} });
    }
    connect();

    // GC expired vessels
    setInterval(() => {
        const cutoff = Date.now() / 1000 - VESSEL_TTL_MS / 1000;
        for (const [k, v] of vessels) if (v.updated < cutoff) vessels.delete(k);
    }, 60_000).unref?.();
}

exports.getVessels = function (req, res) {
    startAisStream();
    const arr = Array.from(vessels.values());
    res.json({ count: arr.length, updated: Date.now(), entities: arr });
};

exports.getAll = async function (req, res) {
    try {
        if (Date.now() - aircraftCache.t > OPENSKY_TTL_MS) await refreshAircraft();
    } catch { /* serve stale */ }
    startAisStream();
    res.json({
        aircraft: aircraftCache.data,
        vessels: Array.from(vessels.values()),
        updated: Date.now()
    });
};

// Server-Sent Events stream. Pushes a single "snapshot" frame on connect, then
// "delta" frames every STREAM_INTERVAL_MS containing only entities that moved
// since the client's last-acknowledged timestamp.
const STREAM_INTERVAL_MS = 5_000;

exports.streamAll = function (req, res) {
    res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
        'X-Accel-Buffering': 'no'
    });
    res.write(': connected\n\n');
    startAisStream();

    let lastPush = 0;
    const send = (event, obj) => {
        res.write(`event: ${event}\ndata: ${JSON.stringify(obj)}\n\n`);
    };

    // Initial snapshot
    (async () => {
        try {
            if (Date.now() - aircraftCache.t > OPENSKY_TTL_MS) await refreshAircraft();
        } catch { /* stale ok */ }
        const all = aircraftCache.data.concat(Array.from(vessels.values()));
        send('snapshot', { entities: all, updated: Date.now() });
        lastPush = Date.now();
    })();

    const interval = setInterval(async () => {
        try {
            if (Date.now() - aircraftCache.t > OPENSKY_TTL_MS) await refreshAircraft();
        } catch { /* serve stale */ }
        const changed = [];
        const cutoff = (lastPush - 2_000) / 1000; // -2s slack
        for (const a of aircraftCache.data) if (a.updated >= cutoff) changed.push(a);
        for (const v of vessels.values())    if (v.updated >= cutoff) changed.push(v);
        send('delta', { entities: changed, updated: Date.now() });
        lastPush = Date.now();
    }, STREAM_INTERVAL_MS);

    // Heartbeat every 25s to keep proxies from closing the stream
    const hb = setInterval(() => res.write(': hb\n\n'), 25_000);

    req.on('close', () => { clearInterval(interval); clearInterval(hb); });
};

exports._startAisStream = startAisStream;
