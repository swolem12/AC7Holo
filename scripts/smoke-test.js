// Live test: OAuth2 token exchange + one /states/all call + AIS WS handshake.
const tracking = require('../controllers/tracking');

(async () => {
    // Fake res object to capture payload.
    const mock = () => {
        let captured;
        return {
            json: o => { captured = o; return mock; },
            get payload() { return captured; }
        };
    };

    console.log('--- OpenSky ---');
    const ar = mock();
    await tracking.getAircraft({}, ar);
    const p = ar.payload;
    console.log('aircraft count:', p && p.count, 'stale:', p && p.stale || false);
    if (p && p.entities && p.entities.length) {
        const sample = p.entities[0];
        console.log('sample:', { id: sample.id, cs: sample.callsign, cty: sample.country, lat: sample.lat, lon: sample.lon });
    }

    console.log('\n--- AISStream (WS handshake, 8s listen window) ---');
    tracking._startAisStream();
    const start = Date.now();
    await new Promise(r => setTimeout(r, 8000));
    const vr = mock();
    tracking.getVessels({}, vr);
    const vp = vr.payload;
    console.log('vessel count after 8s:', vp && vp.count);
    if (vp && vp.entities && vp.entities.length) {
        const v = vp.entities[0];
        console.log('sample:', { id: v.id, cty: v.country, lat: v.lat, lon: v.lon });
    }
    console.log('\nDone. If counts look real, everything is wired up.');
    process.exit(0);
})();
