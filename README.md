# Strangereal Atlas

An interactive world map of Strangereal from Bandai Namco's [*Ace Combat*](https://en.wikipedia.org/wiki/Ace_Combat) series. Currently being developed using Leaflet and MongoDB.

## Technology

* [Leaflet.js](https://leafletjs.com/)
* [OSGeo4W](https://trac.osgeo.org/osgeo4w/)
* [MongoDB](https://www.mongodb.com/)
* [Node.js](https://nodejs.org/) with [Express.js](https://expressjs.com/)

## Setup

For local development, Strangereal Atlas uses the [MongoDB Compass](https://www.mongodb.com/try/download/compass) for the NoSQL database.

To install all Node.js dependencies, enter the following command:

```bash
$ npm install
```

To start the map server:

```bash
$ npm run server
```

If [Nodemon](https://nodemon.io/) is installed, the app may be run in development mode:

```bash
$ npm run dev
```

## Development

The app currently uses an XYZ tilemap created from a [fan-made rendition of the Strangereal world map by dynamitemcnamara](https://redd.it/czmiqi).

Features to be added:

* Shapes of each country (Osea and Yuktobania will be a pain to manually trace out...)
* A search feature to query countries and locations
* Implementation of the app in React.js

## Common Operating Picture (Global Live Tracking)

An Ace Combat 7-inspired holographic view of the **real world** with live
aircraft and maritime vessel tracking is served at
[`/index-cop.html`](http://localhost:3000/index-cop.html) and built on CesiumJS.

### Data sources

| Feed      | Provider                       | Endpoint                        |
|-----------|--------------------------------|---------------------------------|
| Aircraft  | [OpenSky Network](https://opensky-network.org/) REST | `GET /api/tracking/aircraft` |
| Vessels   | [AISStream.io](https://aisstream.io/) WebSocket      | `GET /api/tracking/vessels`  |
| Combined  | -                              | `GET /api/tracking/all`         |

All responses are normalized into the schema documented at the top of
[`controllers/tracking.js`](controllers/tracking.js). Nation attribution is
derived from ICAO24 prefixes (aircraft) and MMSI MIDs (vessels) so no extra
API call is required.

### Setup

```bash
npm install
export AISSTREAM_KEY=<your-aisstream-key>    # required for ship tracks
export OPENSKY_AUTH=user:pass                # optional, raises rate limits
export CESIUM_ION_TOKEN=<token>              # optional, enables 3D terrain
npm run server
```

Then open `http://localhost:3000/index-cop.html`.

### Commercial upgrade paths

* Aircraft: `FlightAware AeroAPI`, `ADS-B Exchange`
* Vessels:  `MarineTraffic`, `Spire Maritime`, `VesselFinder`
* Globe:    `Cesium Ion` world terrain + Bing imagery
