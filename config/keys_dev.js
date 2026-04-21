module.exports = {
    mongoURI: `mongodb://localhost:27017/strangereal-db`,
    secretOrKey: '<!-- SECRET OR KEY -->',

    // Optional: OpenSky basic-auth credentials "username:password".
    // Anonymous usage works but is rate-limited to one poll per 10s.
    openskyAuth: process.env.OPENSKY_AUTH || null,

    // Required for live vessel tracking. Get a free key at https://aisstream.io/
    aisStreamKey: process.env.AISSTREAM_KEY || null,

    // Optional: Cesium Ion token for high-res terrain/imagery.
    cesiumIonToken: process.env.CESIUM_ION_TOKEN || null
};
