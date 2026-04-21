// Common Operating Picture - globe + live tracking client.
// Styled after Ace Combat 7's holographic tactical display.
(function () {
    'use strict';

    // Cesium ion token is optional; without it we use OSM imagery only.
    // Set window.CESIUM_ION_TOKEN before this script to enable terrain.
    if (window.CESIUM_ION_TOKEN) Cesium.Ion.defaultAccessToken = window.CESIUM_ION_TOKEN;

    const viewer = new Cesium.Viewer('cesium', {
        animation: false, timeline: false, baseLayerPicker: false, geocoder: false,
        homeButton: false, sceneModePicker: false, navigationHelpButton: false,
        fullscreenButton: false, infoBox: false, selectionIndicator: false,
        imageryProvider: new Cesium.UrlTemplateImageryProvider({
            url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            credit: '© OpenStreetMap',
            maximumLevel: 19
        })
    });

    // Holographic tint: dim the globe and tint toward cyan via atmosphere.
    const scene = viewer.scene;
    scene.globe.baseColor = Cesium.Color.fromCssColorString('#02101a');
    scene.globe.showGroundAtmosphere = true;
    scene.globe.atmosphereLightIntensity = 6;
    scene.globe.atmosphereHueShift = 0.55;
    scene.globe.atmosphereSaturationShift = 0.3;
    scene.skyAtmosphere.hueShift = 0.55;
    scene.skyAtmosphere.saturationShift = 0.4;
    scene.skyAtmosphere.brightnessShift = -0.1;
    scene.backgroundColor = Cesium.Color.fromCssColorString('#02060b');
    scene.globe.enableLighting = false;
    viewer.cesiumWidget.creditContainer.style.display = 'none';

    // Desaturate imagery for a radar feel.
    const layer = viewer.imageryLayers.get(0);
    layer.saturation = 0.25;
    layer.brightness = 0.85;
    layer.contrast = 1.2;
    layer.hue = 3.4; // push toward cyan

    viewer.camera.setView({
        destination: Cesium.Cartesian3.fromDegrees(0, 20, 22_000_000)
    });

    // Enable a continuous clock so SampledPositionProperty interpolates.
    viewer.clock.shouldAnimate = true;
    viewer.clock.clockRange = Cesium.ClockRange.UNBOUNDED;
    viewer.clock.multiplier = 1;

    // ---- Post-processing: bloom + AC7 hex-grid overlay -----------------------
    if (scene.postProcessStages && scene.postProcessStages.bloom) {
        const bloom = scene.postProcessStages.bloom;
        bloom.enabled = true;
        bloom.uniforms.glowOnly = false;
        bloom.uniforms.contrast = 128;
        bloom.uniforms.brightness = -0.2;
        bloom.uniforms.delta = 1.0;
        bloom.uniforms.sigma = 2.6;
        bloom.uniforms.stepSize = 1.0;
    }
    // Hex-grid + scanline overlay rendered in screen space so it tracks the camera.
    try {
        const hexStage = new Cesium.PostProcessStage({
            fragmentShader: `
                uniform sampler2D colorTexture;
                in vec2 v_textureCoordinates;
                // Hex grid math from https://www.shadertoy.com/view/Xljczw
                vec4 hex(vec2 p) {
                    p.x *= 0.57735 * 2.0;
                    p.y += mod(floor(p.x), 2.0) * 0.5;
                    p = abs(mod(p, 1.0) - 0.5);
                    return vec4(p, 0.5 - max(p.x * 1.5 + p.y, p.y * 2.0), 0.0);
                }
                void main() {
                    vec4 base = texture(colorTexture, v_textureCoordinates);
                    vec2 uv = v_textureCoordinates * vec2(czm_viewport.z, czm_viewport.w) / 46.0;
                    vec4 h = hex(uv);
                    float line = smoothstep(0.02, 0.0, h.z);
                    float scan = 0.06 * sin(v_textureCoordinates.y * czm_viewport.w * 1.4 + czm_frameNumber * 0.08);
                    vec3 tint = vec3(0.24, 0.94, 1.0);
                    vec3 col = base.rgb + line * tint * 0.08 + scan * tint;
                    out_FragColor = vec4(col, base.a);
                }
            `
        });
        scene.postProcessStages.add(hexStage);
    } catch (e) {
        console.warn('hex-grid post-process unavailable:', e.message);
    }

    // ---- Entity bookkeeping --------------------------------------------------
    const entities = new Map(); // id -> Cesium Entity
    const AIR_COLOR_CIV = Cesium.Color.fromCssColorString('#3df0ff');
    const AIR_COLOR_MIL = Cesium.Color.fromCssColorString('#ff2d9c');
    const SEA_COLOR_CIV = Cesium.Color.fromCssColorString('#7affc8');
    const SEA_COLOR_MIL = Cesium.Color.fromCssColorString('#ff2d9c');
    const UNKNOWN_COLOR = Cesium.Color.fromCssColorString('#ffb300');
    const SEL_COLOR     = Cesium.Color.fromCssColorString('#ffffff');

    // Published ICAO24 military ranges (abridged, major operators).
    const MIL_ICAO24_RANGES = [
        ['ae0000', 'afffff'], // US military
        ['adf7c8', 'afffff'],
        ['43c000', '43ffff'], // UK military
        ['3b0000', '3bffff'], // Germany Luftwaffe (partial)
        ['33ff00', '33ffff'],
        ['71c000', '71ffff'], // ROKAF
        ['738a00', '7389ff']
    ];
    function isMilAircraft(d) {
        if (!d.id || !d.id.startsWith('a:')) return false;
        const hex = d.id.substring(2).toLowerCase();
        for (const [lo, hi] of MIL_ICAO24_RANGES) {
            if (hex >= lo && hex <= hi) return true;
        }
        // Common military callsign prefixes
        const cs = (d.callsign || '').toUpperCase();
        return /^(RCH|SAM|PAT|SHELL|BLUE|GRIM|HOMR|KNIFE|CNV|NAVY|ARMY|POLZON|DUKE)/.test(cs);
    }
    // AIS ship type codes 35 and 55 are military/law-enforcement.
    function isMilVessel(d) {
        const t = parseInt(d.type, 10);
        return t === 35 || t === 55;
    }
    function colorFor(d) {
        if (d.kind === 'air') return isMilAircraft(d) ? AIR_COLOR_MIL : AIR_COLOR_CIV;
        if (d.kind === 'sea') return isMilVessel(d)   ? SEA_COLOR_MIL : SEA_COLOR_CIV;
        return UNKNOWN_COLOR;
    }

    let filter = 'all';
    document.querySelectorAll('#filters .btn').forEach(b => {
        b.addEventListener('click', () => {
            document.querySelectorAll('#filters .btn').forEach(x => x.classList.remove('active'));
            b.classList.add('active');
            filter = b.dataset.f;
            applyFilter();
        });
    });

    function applyFilter() {
        for (const e of entities.values()) {
            const kind = e._kind;
            e.show = (filter === 'all') || (filter === kind);
        }
    }

    function upsertEntity(d) {
        const color = colorFor(d);
        const now = Cesium.JulianDate.fromDate(new Date((d.updated || Date.now() / 1000) * 1000));
        const pos = Cesium.Cartesian3.fromDegrees(d.lon, d.lat, d.alt || 0);
        let e = entities.get(d.id);
        if (!e) {
            // SampledPositionProperty gives smooth interpolation between reports.
            const sampled = new Cesium.SampledPositionProperty();
            sampled.setInterpolationOptions({
                interpolationDegree: 1,
                interpolationAlgorithm: Cesium.LinearApproximation
            });
            sampled.forwardExtrapolationType = Cesium.ExtrapolationType.HOLD;
            sampled.forwardExtrapolationDuration = 300; // extrapolate up to 5 min on lost signal
            sampled.addSample(now, pos);

            e = viewer.entities.add({
                id: d.id,
                position: sampled,
                orientation: new Cesium.VelocityOrientationProperty(sampled),
                point: {
                    pixelSize: d.kind === 'air' ? 7 : 8,
                    color: color.withAlpha(0.95),
                    outlineColor: color,
                    outlineWidth: 1,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                },
                // 5-minute glowing trail; the trail length is in seconds.
                path: {
                    show: true,
                    width: 1.5,
                    leadTime: 0,
                    trailTime: 300,
                    resolution: 10,
                    material: new Cesium.PolylineGlowMaterialProperty({
                        glowPower: 0.25,
                        color: color.withAlpha(0.75)
                    })
                },
                // Altitude drop-line for aircraft (recomputed per tick).
                polyline: d.kind === 'air' ? {
                    positions: new Cesium.CallbackProperty(() => {
                        const p = sampled.getValue(viewer.clock.currentTime);
                        if (!p) return [];
                        const c = Cesium.Cartographic.fromCartesian(p);
                        return [
                            Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, 0),
                            Cesium.Cartesian3.fromRadians(c.longitude, c.latitude, c.height)
                        ];
                    }, false),
                    width: 1,
                    material: color.withAlpha(0.28),
                    arcType: Cesium.ArcType.NONE
                } : undefined
            });
            e._kind = d.kind;
            e._sampled = sampled;
            entities.set(d.id, e);
        } else {
            // Only append a new sample if the position changed; avoids jitter.
            const prev = e._data;
            if (!prev || prev.lat !== d.lat || prev.lon !== d.lon || prev.alt !== d.alt) {
                e._sampled.addSample(now, pos);
            }
        }
        e._data = d;
        e._lastSeen = Date.now();
        e.show = (filter === 'all') || (filter === d.kind);
        // Advance the clock so interpolation is always "now"
        viewer.clock.currentTime = Cesium.JulianDate.fromDate(new Date());
        return e;
    }

    function gcStale() {
        const cutoff = Date.now() - 5 * 60_000;
        for (const [id, e] of entities) {
            if (e._lastSeen < cutoff) {
                viewer.entities.remove(e);
                entities.delete(id);
            }
        }
    }

    // ---- HUD -----------------------------------------------------------------
    const $ = id => document.getElementById(id);
    function updateHud() {
        let air = 0, sea = 0;
        for (const e of entities.values()) {
            if (e._kind === 'air') air++; else if (e._kind === 'sea') sea++;
        }
        $('cAir').textContent = air;
        $('cSea').textContent = sea;
        $('cTot').textContent = air + sea;
    }

    setInterval(() => {
        $('utc').textContent = new Date().toISOString().substring(11, 19) + 'Z';
    }, 500);

    viewer.camera.changed.addEventListener(() => {
        const c = viewer.camera.positionCartographic;
        $('camLat').textContent = Cesium.Math.toDegrees(c.latitude).toFixed(2);
        $('camLon').textContent = Cesium.Math.toDegrees(c.longitude).toFixed(2);
        $('camAlt').textContent = Math.round(c.height / 1000) + ' km';
    });

    // ---- Selection -----------------------------------------------------------
    let selected = null;
    const handler = new Cesium.ScreenSpaceEventHandler(viewer.canvas);
    handler.setInputAction(click => {
        const picked = viewer.scene.pick(click.position);
        if (picked && picked.id && entities.has(picked.id.id)) {
            selectEntity(entities.get(picked.id.id));
        } else {
            clearSelection();
        }
    }, Cesium.ScreenSpaceEventType.LEFT_CLICK);

    function selectEntity(e) {
        clearSelection();
        selected = e;
        const baseColor = colorFor(e._data);
        e._baseColor = baseColor;
        e.point.color = SEL_COLOR;
        e.point.pixelSize = 12;
        e.point.outlineColor = SEL_COLOR;
        showSelPanel(e._data);
    }
    function clearSelection() {
        if (!selected) return;
        const baseColor = selected._baseColor || colorFor(selected._data);
        selected.point.color = baseColor.withAlpha(0.95);
        selected.point.pixelSize = selected._kind === 'air' ? 7 : 8;
        selected.point.outlineColor = baseColor;
        selected = null;
        hideSelPanel();
    }

    function showSelPanel(d) {
        const panel = $('bl');
        panel.style.display = 'block';
        $('sel_title').textContent = (d.callsign || d.id).toUpperCase();
        $('sel_id').textContent = d.id;
        $('sel_ct').textContent = d.country || 'UNKNOWN';
        $('sel_tp').textContent = (d.kind === 'air' ? 'AIRCRAFT' : 'VESSEL') + (d.type ? ' / ' + d.type.toUpperCase() : '');
        $('sel_la').textContent = d.lat.toFixed(4);
        $('sel_lo').textContent = d.lon.toFixed(4);
        $('sel_al').textContent = d.alt != null ? Math.round(d.alt) + ' m' : '---';
        $('sel_hd').textContent = d.heading != null ? Math.round(d.heading) + '°' : '---';
        $('sel_sp').textContent = d.speed != null ? Math.round(d.speed * 1.94384) + ' kt' : '---';
    }
    function hideSelPanel() { $('bl').style.display = 'none'; }
    hideSelPanel();

    // ---- Feed: prefer SSE stream, fall back to polling ----------------------
    // On GitHub Pages (static hosting) the backend proxies don't exist, so we
    // probe /api/tracking/aircraft once; on failure we call OpenSky directly
    // from the browser. OpenSky's anonymous /states/all endpoint returns CORS
    // headers that allow this. AISStream requires a server-side WebSocket key
    // so vessels only appear when the Node backend is reachable OR when the
    // user sets window.AISSTREAM_KEY (advanced, exposes the key).
    const HAS_BACKEND_P = (async () => {
        try {
            const r = await fetch('/api/tracking/aircraft', { method: 'HEAD' });
            return r.ok;
        } catch { return false; }
    })();

    async function poll(url, onData) {
        try {
            const r = await fetch(url);
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const j = await r.json();
            onData(j);
            $('status').textContent = 'ONLINE';
        } catch (e) {
            console.warn('feed error', url, e.message);
            $('status').textContent = 'DEGRADED';
        }
    }

    function ingest(json) {
        if (!json || !json.entities) return;
        for (const d of json.entities) upsertEntity(d);
    }

    // ---- Direct OpenSky fetch (browser) -------------------------------------
    // Same ICAO24-prefix -> country table and normalization the backend uses.
    const ICAO24_PREFIXES = [
        ['a', 'United States'], ['c0', 'Canada'], ['c8', 'Australia'], ['7c', 'Australia'],
        ['40', 'United Kingdom'], ['43', 'United Kingdom'],
        ['3c', 'Germany'], ['39', 'France'], ['38', 'France'],
        ['30', 'Italy'], ['31', 'Italy'], ['34', 'Spain'], ['35', 'Spain'],
        ['36', 'Netherlands'], ['44', 'Belgium'], ['45', 'Denmark'],
        ['46', 'Finland'], ['47', 'Greece'], ['4b', 'Switzerland'],
        ['10', 'Russia'], ['14', 'Russia'], ['78', 'China'],
        ['71', 'South Korea'], ['86', 'Japan'], ['80', 'India']
    ];
    function icaoCountry(icao24) {
        if (!icao24) return null;
        const a = icao24.toLowerCase();
        let best = null;
        for (const [pfx, name] of ICAO24_PREFIXES) {
            if (a.startsWith(pfx) && (!best || pfx.length > best[0].length)) best = [pfx, name];
        }
        return best ? best[1] : null;
    }

    async function fetchOpenSkyDirect() {
        try {
            const r = await fetch('https://opensky-network.org/api/states/all');
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const raw = await r.json();
            const entities = [];
            for (const s of (raw.states || [])) {
                const [icao24, callsign, origin_country, , , lon, lat, baro_alt,
                       on_ground, velocity, true_track, , , geo_alt] = s;
                if (lat == null || lon == null) continue;
                entities.push({
                    id: 'a:' + icao24,
                    kind: 'air',
                    callsign: (callsign || '').trim() || null,
                    country: origin_country || icaoCountry(icao24),
                    iso2: null,
                    lat, lon,
                    alt: geo_alt != null ? geo_alt : baro_alt,
                    heading: true_track,
                    speed: velocity,
                    type: on_ground ? 'ground' : 'airborne',
                    updated: raw.time
                });
            }
            ingest({ entities });
            $('status').textContent = 'DIRECT';
        } catch (e) {
            console.warn('OpenSky direct failed:', e.message);
            $('status').textContent = 'DEGRADED';
        }
    }

    // ---- Direct AISStream (browser WS, optional) ----------------------------
    // Only activates if window.AISSTREAM_KEY is set. Exposing a key client-side
    // is only appropriate for free/throttled keys you're comfortable burning.
    const MID_BROWSER = {
        '366':'United States','367':'United States','368':'United States','369':'United States',
        '232':'United Kingdom','233':'United Kingdom','234':'United Kingdom','235':'United Kingdom',
        '211':'Germany','227':'France','247':'Italy','224':'Spain','244':'Netherlands',
        '273':'Russia','412':'China','431':'Japan','440':'South Korea','419':'India',
        '563':'Singapore','503':'Australia','636':'Liberia','371':'Panama'
    };
    function startAisBrowser(apiKey) {
        try {
            const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
            ws.onopen = () => {
                ws.send(JSON.stringify({
                    APIKey: apiKey,
                    BoundingBoxes: [[[-90, -180], [90, 180]]],
                    FilterMessageTypes: ['PositionReport', 'ShipStaticData']
                }));
            };
            ws.onmessage = ev => {
                try {
                    const m = JSON.parse(ev.data);
                    const meta = m.MetaData || {};
                    const mmsi = meta.MMSI || meta.MMSI_String;
                    if (!mmsi) return;
                    const pos = (m.Message && (m.Message.PositionReport || {})) || {};
                    const stat = (m.Message && (m.Message.ShipStaticData || {})) || {};
                    if (pos.Latitude == null || pos.Longitude == null) return;
                    ingest({ entities: [{
                        id: 's:' + mmsi, kind: 'sea',
                        callsign: (stat.CallSign || meta.ShipName || '').trim() || null,
                        country: MID_BROWSER[String(mmsi).substring(0, 3)] || null,
                        iso2: null,
                        lat: pos.Latitude, lon: pos.Longitude, alt: 0,
                        heading: pos.TrueHeading != null && pos.TrueHeading < 360 ? pos.TrueHeading : (pos.Cog ?? null),
                        speed: pos.Sog != null ? pos.Sog * 0.5144 : null,
                        type: stat.Type ? String(stat.Type) : 'vessel',
                        updated: Math.floor(Date.now() / 1000)
                    }]});
                } catch {}
            };
            ws.onerror = () => console.warn('AISStream WS error');
            ws.onclose = () => setTimeout(() => startAisBrowser(apiKey), 5000);
        } catch (e) { console.warn('AISStream start failed:', e.message); }
    }

    async function pollTick() {
        const hasBackend = await HAS_BACKEND_P;
        if (hasBackend) {
            await Promise.all([
                poll('/api/tracking/aircraft', ingest),
                poll('/api/tracking/vessels', ingest)
            ]);
        } else {
            await fetchOpenSkyDirect();
        }
        gcStale();
        updateHud();
    }

    let feedMode = 'polling';
    let pollTimer = null;
    async function startSse() {
        if (typeof EventSource === 'undefined') return false;
        if (!(await HAS_BACKEND_P)) return false;
        try {
            const es = new EventSource('/api/tracking/stream');
            es.addEventListener('snapshot', ev => {
                try { ingest(JSON.parse(ev.data)); gcStale(); updateHud();
                      $('status').textContent = 'STREAMING'; feedMode = 'sse'; } catch {}
            });
            es.addEventListener('delta', ev => {
                try { ingest(JSON.parse(ev.data)); gcStale(); updateHud(); } catch {}
            });
            es.onerror = () => {
                if (feedMode !== 'sse') {
                    es.close();
                    if (!pollTimer) pollTimer = setInterval(pollTick, 10_000);
                }
            };
            return true;
        } catch { return false; }
    }

    // Boot sequence + kick off feed.
    const bootSteps = [
        { t: 'HANDSHAKE.....................', ok: true },
        { t: 'CRYPTO KEY EXCHANGE...........', ok: true },
        { t: 'LOADING REFERENCE DATA........', ok: true },
        { t: 'SUBSCRIBING TO ADS-B FEED.....', ok: true },
        { t: 'SUBSCRIBING TO AIS FEED.......', ok: true },
        { t: 'LINK ESTABLISHED // COP ONLINE', ok: true }
    ];
    async function runBoot() {
        const log = $('bootlog');
        for (const s of bootSteps) {
            const line = document.createElement('div');
            line.innerHTML = `> ${s.t} <span class="${s.ok ? 'ok' : 'warn'}">[${s.ok ? 'OK' : 'WARN'}]</span>`;
            log.appendChild(line);
            await new Promise(r => setTimeout(r, 240));
        }
        const caret = document.createElement('div');
        caret.className = 'caret';
        caret.textContent = '> ';
        log.appendChild(caret);
        await new Promise(r => setTimeout(r, 400));
        $('boot').classList.add('hide');
    }

    runBoot();
    pollTick(); // first frame immediately
    (async () => {
        const sseOk = await startSse();
        if (!sseOk && !pollTimer) {
            pollTimer = setInterval(pollTick, 10_000);
        }
        // If we're on a static site (no backend) and a key is provided, open AIS WS.
        if (!(await HAS_BACKEND_P) && window.AISSTREAM_KEY) {
            startAisBrowser(window.AISSTREAM_KEY);
        }
    })();

    // ---- Keyboard bindings ---------------------------------------------------
    window.addEventListener('keydown', ev => {
        if (ev.target && /INPUT|TEXTAREA/.test(ev.target.tagName)) return;
        switch (ev.key) {
            case '1': document.querySelector('#filters .btn[data-f="air"]').click(); break;
            case '2': document.querySelector('#filters .btn[data-f="sea"]').click(); break;
            case '3': document.querySelector('#filters .btn[data-f="all"]').click(); break;
            case 'f': case 'F':
                if (selected) {
                    viewer.trackedEntity = viewer.trackedEntity === selected ? undefined : selected;
                }
                break;
            case 'Escape':
                viewer.trackedEntity = undefined;
                clearSelection();
                break;
            case 'b': case 'B':
                document.querySelector('#layers .btn[data-layer="bases"]').click();
                break;
            case 't': case 'T':
                document.querySelector('#layers .btn[data-layer="trails"]').click();
                break;
        }
    });

    // ---- Bases overlay -------------------------------------------------------
    const baseCollection = new Cesium.CustomDataSource('bases');
    viewer.dataSources.add(baseCollection);

    async function loadBases() {
        // Try backend proxy first, fall back to the static JSON bundled with the site.
        try {
            const r = await fetch('/api/reference/bases');
            if (r.ok) return (await r.json()).bases || [];
        } catch {}
        try {
            const r = await fetch('./datasets/bases-static.json');
            if (r.ok) return (await r.json()).bases || [];
        } catch {}
        return [];
    }

    loadBases().then(bases => {
        const airColor = Cesium.Color.fromCssColorString('#3df0ff').withAlpha(0.85);
        const navColor = Cesium.Color.fromCssColorString('#ff2d9c').withAlpha(0.85);
        for (const b of bases) {
            const col = b.type === 'naval' ? navColor : airColor;
            baseCollection.entities.add({
                position: Cesium.Cartesian3.fromDegrees(b.lon, b.lat, 0),
                point: {
                    pixelSize: 8,
                    color: col.withAlpha(0.35),
                    outlineColor: col,
                    outlineWidth: 1.5,
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                },
                label: {
                    text: b.name.toUpperCase(),
                    font: '10px "Share Tech Mono", monospace',
                    fillColor: col,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(10, -6),
                    showBackground: false,
                    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 6_000_000),
                    disableDepthTestDistance: Number.POSITIVE_INFINITY
                },
                description: `${b.branch || ''} · ${b.country}`
            });
        }
    }).catch(e => console.warn('bases fetch failed:', e.message));

    // ---- Layer toggles -------------------------------------------------------
    document.querySelectorAll('#layers .btn').forEach(btn => {
        btn.addEventListener('click', () => {
            btn.classList.toggle('active');
            const on = btn.classList.contains('active');
            if (btn.dataset.layer === 'bases') baseCollection.show = on;
            if (btn.dataset.layer === 'trails') {
                for (const e of entities.values()) e.path.show = on;
            }
        });
    });

    // ---- Radial context menu -------------------------------------------------
    const radial = $('radial');
    handler.setInputAction(ev => {
        const picked = viewer.scene.pick(ev.position);
        if (picked && picked.id && entities.has(picked.id.id)) {
            selectEntity(entities.get(picked.id.id));
            radial.style.left = ev.position.x + 'px';
            radial.style.top  = ev.position.y + 'px';
            radial.classList.add('show');
        } else {
            radial.classList.remove('show');
        }
    }, Cesium.ScreenSpaceEventType.RIGHT_CLICK);

    document.addEventListener('click', e => {
        if (!radial.contains(e.target)) radial.classList.remove('show');
    });

    radial.querySelectorAll('.slice').forEach(s => {
        s.addEventListener('click', () => {
            const act = s.dataset.act;
            if (!selected) return;
            if (act === 'track') {
                viewer.trackedEntity = viewer.trackedEntity === selected ? undefined : selected;
            } else if (act === 'vector') {
                viewer.flyTo(selected, { duration: 1.2, offset: new Cesium.HeadingPitchRange(0, -0.6, 200_000) });
            } else if (act === 'intel') {
                const d = selected._data;
                alert(`${(d.callsign || d.id).toUpperCase()}\nNation: ${d.country || 'UNKNOWN'}\nType: ${d.kind}\nLast seen: ${new Date(d.updated * 1000).toISOString()}`);
            } else if (act === 'designate') {
                selected.point.color = Cesium.Color.RED;
                selected.point.outlineColor = Cesium.Color.RED;
                selected.point.pixelSize = 14;
            }
            radial.classList.remove('show');
        });
    });

    // ---- Universe toggle: Earth <-> Strangereal -----------------------------
    document.querySelectorAll('#universe .ubtn').forEach(b => {
        b.addEventListener('click', () => {
            const u = b.dataset.u;
            if (u === 'strangereal') {
                // Hand off to the existing Strangereal atlas (Leaflet page).
                window.location.href = './index.html';
            } else {
                document.querySelectorAll('#universe .ubtn').forEach(x => x.classList.remove('active'));
                b.classList.add('active');
            }
        });
    });
})();
