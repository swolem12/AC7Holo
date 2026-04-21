const k = require('../config/keys');
console.log('opensky OAuth2:', k.openskyClient ? 'OK (' + k.openskyClient.clientId + ')' : 'MISSING');
console.log('aisstream:     ', k.aisStreamKey ? 'OK (' + k.aisStreamKey.slice(0, 6) + '...)' : 'MISSING');
console.log('cesium ion:    ', k.cesiumIonToken ? 'OK (token len ' + k.cesiumIonToken.length + ')' : 'MISSING');
