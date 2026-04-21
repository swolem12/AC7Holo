const fs = require('fs');
const path = require('path');

// Try to load local secrets in this order:
//   1. config/keys_local.js   (git-ignored, wins over everything)
//   2. ../credentials.json    (OpenSky OAuth2 client-credentials dump)
//   3. process.env            (CI / production-style)
let local = {};
try { local = require('./keys_local'); } catch {}

let openskyClient = null;
try {
    const credPath = path.join(__dirname, '..', 'credentials.json');
    if (fs.existsSync(credPath)) {
        const c = JSON.parse(fs.readFileSync(credPath, 'utf8'));
        if (c.clientId && c.clientSecret) {
            openskyClient = { clientId: c.clientId, clientSecret: c.clientSecret };
        }
    }
} catch (e) { console.warn('[keys] credentials.json unreadable:', e.message); }

module.exports = {
    mongoURI: local.mongoURI || process.env.MONGO_URI || `mongodb://localhost:27017/strangereal-db`,
    secretOrKey: local.secretOrKey || process.env.SECRET_OR_KEY || '<!-- SECRET OR KEY -->',

    // OpenSky OAuth2 (new format): { clientId, clientSecret }
    openskyClient: local.openskyClient || openskyClient,
    // Legacy Basic auth: "username:password"
    openskyAuth: local.openskyAuth || process.env.OPENSKY_AUTH || null,

    // AISStream.io API key. Free tier at https://aisstream.io/
    aisStreamKey: local.aisStreamKey || process.env.AISSTREAM_KEY || null,

    // Cesium Ion token for premium imagery/terrain.
    cesiumIonToken: local.cesiumIonToken || process.env.CESIUM_ION_TOKEN || null
};
