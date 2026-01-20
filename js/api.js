let api = (function () {
    "use strict";

    // Cache for loaded data
    let locationsData = null;

    // sends a JSON request
    function send(method, url, data, callback) {
        let xhr = new XMLHttpRequest();
        xhr.onload = function () {
            if (xhr.status !== 200) callback(`[${xhr.status}] ${xhr.responseText}`, null);
            else callback(null, JSON.parse(xhr.responseText));
        };
        xhr.open(method, url, true);
        if (!data) xhr.send();
        else {
            xhr.setRequestHeader('Content-Type', 'application/json');
            xhr.send(JSON.stringify(data));
        }
    }

    let module = {};

    // gets all locations
    module.getLocations = function (callback) {
        if (locationsData) {
            callback(locationsData);
            return;
        }
        send(`GET`, `./datasets/locations.json`, null, (err, locations) => {
            if (err) return console.error(err);
            locationsData = locations;
            callback(locations);
        });
    }

    module.getLocationSummary = function (id, callback) {
        module.getLocations(locations => {
            const location = locations.find(loc => loc._id === id);
            if (location) {
                callback(location);
            } else {
                console.error(`Location ${id} not found`);
            }
        });
    }

    // get polygon
    module.getPolygon = function (id, callback) {
        send(`GET`, `./datasets/polygons/${id}.json`, null, (err, polygon) => {
            if (err) return console.error(err);
            callback(polygon);
        });
    }

    return module;

})();