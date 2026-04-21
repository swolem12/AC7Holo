module.exports = {
    mongoURI: process.env.MONGO_URI,
    secretOrKey: process.env.SECRET_OR_KEY,
    openskyAuth: process.env.OPENSKY_AUTH || null,
    aisStreamKey: process.env.AISSTREAM_KEY || null,
    cesiumIonToken: process.env.CESIUM_ION_TOKEN || null
};
