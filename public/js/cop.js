// Common Operating Picture - globe + live tracking client.
// Styled after Ace Combat 7's holographic tactical display.
(function () {
    'use strict';

    // Surface any fatal error directly into the boot overlay so the page never
    // just sits there silently.
    window.addEventListener('error', ev => {
        const log = document.getElementById('bootlog');
        if (log) {
            const d = document.createElement('div');
            d.style.color = '#ff3a3a';
            d.textContent = '> FATAL: ' + (ev.message || ev.error);
            log.appendChild(d);
        }
    });

    if (typeof Cesium === 'undefined') {
        const log = document.getElementById('bootlog');
        log.innerHTML = '<div style="color:#ff3a3a">> FATAL: Cesium failed to load from CDN.</div>' +
                        '<div style="color:#ffb300">> Check network / ad-blocker / CSP for cdn.jsdelivr.net.</div>';
        return;
    }

    // Cesium ion token is optional; without it we use OSM imagery only.
    if (window.CESIUM_ION_TOKEN) Cesium.Ion.defaultAccessToken = window.CESIUM_ION_TOKEN;

    const viewerOpts = {
        animation: false, timeline: false, baseLayerPicker: false, geocoder: false,
        homeButton: false, sceneModePicker: false, navigationHelpButton: false,
        fullscreenButton: false, infoBox: false, selectionIndicator: false
    };
    // If no Ion token, fall back to OSM raster tiles. With a token, let Cesium
    // use its default Ion Bing Maps imagery (higher-res + reliable async load).
    if (!window.CESIUM_ION_TOKEN) {
        const osmProvider = new Cesium.UrlTemplateImageryProvider({
            url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
            credit: '© OpenStreetMap',
            maximumLevel: 19
        });
        if (Cesium.ImageryLayer && Cesium.ImageryLayer.fromProviderAsync) {
            viewerOpts.baseLayer = Cesium.ImageryLayer.fromProviderAsync(Promise.resolve(osmProvider));
        } else {
            viewerOpts.imageryProvider = osmProvider;
        }
    }

    let viewer;
    try {
        viewer = new Cesium.Viewer('cesium', viewerOpts);
    } catch (e) {
        const log = document.getElementById('bootlog');
        log.innerHTML = '<div style="color:#ff3a3a">> FATAL: Cesium viewer init failed.</div>' +
                        '<div style="color:#ffb300">> ' + e.message + '</div>';
        return;
    }

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
    // Make the globe opaque to its own depth so billboards on the far side
    // are correctly occluded by the Earth (no more "hollow globe" bleed).
    scene.globe.translucency.enabled = false;
    scene.globe.depthTestAgainstTerrain = true;
    viewer.cesiumWidget.creditContainer.style.display = 'none';

    // Desaturate imagery for a radar feel (applies once the base layer exists).
    function tintBaseLayer() {
        const layer = viewer.imageryLayers.get(0);
        if (!layer) return;
        // Previously tinted very dark + low saturation, which made the globe
        // blend into space and made moving icons visually disappear. Keep
        // some holographic tint but let actual land/ocean show through.
        layer.saturation = 0.55;
        layer.brightness = 1.05;
        layer.contrast = 1.15;
        layer.hue = 3.4; // push toward cyan
    }
    tintBaseLayer();
    viewer.imageryLayers.layerAdded.addEventListener(tintBaseLayer);

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

    // FlightRadar-style vector icons. SVG points NORTH (+Y up on screen) at
    // rotation=0, then we apply screen-space rotation = -heading so the
    // silhouette lines up with the compass bearing just like FR24 / ADSBX.
    const svgUrl = svg => 'data:image/svg+xml;utf8,' + encodeURIComponent(svg.trim());
    const PLANE_SVG = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="-20 -20 40 40">
  <path fill="white" stroke="white" stroke-width="0.5" stroke-linejoin="round"
    d="M0,-18 L2.2,-6 L18,3 L18,5.5 L2.2,1.5 L2.2,10 L7,13 L7,15 L0,13.5 L-7,15 L-7,13 L-2.2,10 L-2.2,1.5 L-18,5.5 L-18,3 L-2.2,-6 Z"/>
</svg>`);
    const HELI_SVG = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40" viewBox="-20 -20 40 40">
  <g fill="white" stroke="white" stroke-width="0.8">
    <rect x="-18" y="-1.5" width="36" height="3" rx="1.2"/>
    <rect x="-1.5" y="-18" width="3" height="36" rx="1.2"/>
    <circle cx="0" cy="0" r="5"/>
    <rect x="-0.8" y="5" width="1.6" height="9"/>
  </g>
</svg>`);
    const SHIP_SVG = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="-10 -14 20 28">
  <path fill="white" stroke="white" stroke-width="0.5" stroke-linejoin="round"
    d="M0,-12 L5,-3 L5,8 L3,12 L-3,12 L-5,8 L-5,-3 Z"/>
</svg>`);
    // Cargo ship: long flat hull with stacked containers.
    const CARGO_SVG = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="28" height="44" viewBox="-10 -16 20 32">
  <g fill="white" stroke="white" stroke-width="0.4" stroke-linejoin="round">
    <path d="M0,-15 L4,-9 L4,10 L2.5,14 L-2.5,14 L-4,10 L-4,-9 Z"/>
    <rect x="-3" y="-7" width="6" height="2.2"/>
    <rect x="-3" y="-4" width="6" height="2.2"/>
    <rect x="-3" y="-1" width="6" height="2.2"/>
    <rect x="-3" y="2" width="6" height="2.2"/>
    <rect x="-1.6" y="6" width="3.2" height="3.2"/>
  </g>
</svg>`);
    // Tanker: smooth hull with two cylindrical tank domes.
    const TANKER_SVG = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="28" height="44" viewBox="-10 -16 20 32">
  <g fill="white" stroke="white" stroke-width="0.4" stroke-linejoin="round">
    <path d="M0,-15 L4.2,-9 L4.2,10 L2.5,14 L-2.5,14 L-4.2,10 L-4.2,-9 Z"/>
    <ellipse cx="0" cy="-4" rx="2.8" ry="1.6"/>
    <ellipse cx="0" cy="2"  rx="2.8" ry="1.6"/>
    <rect x="-1.4" y="7" width="2.8" height="3.2"/>
  </g>
</svg>`);
    // Passenger ship / ferry / cruise: tall superstructure.
    const PASSENGER_SVG = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="28" height="44" viewBox="-10 -16 20 32">
  <g fill="white" stroke="white" stroke-width="0.4" stroke-linejoin="round">
    <path d="M0,-15 L4,-10 L4,10 L2.5,14 L-2.5,14 L-4,10 L-4,-10 Z"/>
    <rect x="-3" y="-8" width="6" height="12" rx="0.6"/>
    <rect x="-2.2" y="-6" width="1.2" height="1.2" fill="black"/>
    <rect x="-0.6" y="-6" width="1.2" height="1.2" fill="black"/>
    <rect x="1.0"  y="-6" width="1.2" height="1.2" fill="black"/>
    <rect x="-2.2" y="-3" width="1.2" height="1.2" fill="black"/>
    <rect x="-0.6" y="-3" width="1.2" height="1.2" fill="black"/>
    <rect x="1.0"  y="-3" width="1.2" height="1.2" fill="black"/>
  </g>
</svg>`);
    // Naval / warship: angular hull with deck gun + mast.
    const NAVAL_SVG = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="28" height="44" viewBox="-10 -16 20 32">
  <g fill="white" stroke="white" stroke-width="0.4" stroke-linejoin="round">
    <path d="M0,-15 L3.6,-9 L3.6,9 L2.2,14 L-2.2,14 L-3.6,9 L-3.6,-9 Z"/>
    <rect x="-0.4" y="-13" width="0.8" height="6"/>
    <rect x="-2"   y="-5"  width="4"   height="3"/>
    <polygon points="0,-9 -1.6,-5 1.6,-5"/>
    <rect x="-1"   y="3"   width="2"   height="5"/>
  </g>
</svg>`);
    // Fishing / tug / small craft: small stubby hull.
    const FISHING_SVG = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="34" viewBox="-8 -12 16 24">
  <g fill="white" stroke="white" stroke-width="0.4" stroke-linejoin="round">
    <path d="M0,-11 L3.6,-4 L3.6,7 L2.2,11 L-2.2,11 L-3.6,7 L-3.6,-4 Z"/>
    <rect x="-1.8" y="-2" width="3.6" height="4.5"/>
    <rect x="-0.3" y="-7" width="0.6" height="5"/>
  </g>
</svg>`);
    // Yacht / sailing / pleasure craft.
    const YACHT_SVG = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="24" height="34" viewBox="-8 -12 16 24">
  <g fill="white" stroke="white" stroke-width="0.4" stroke-linejoin="round">
    <path d="M-3.6,6 L3.6,6 L2.4,10 L-2.4,10 Z"/>
    <rect x="-0.25" y="-11" width="0.5" height="17"/>
    <polygon points="0.4,-10 4,5 0.4,5"/>
    <polygon points="-0.4,-6 -3,5 -0.4,5"/>
  </g>
</svg>`);
    const GROUND_SVG = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="-10 -10 20 20">
  <circle cx="0" cy="0" r="6" fill="white" stroke="white" stroke-width="1"/>
</svg>`);

    // Facility icons for route endpoints. These are draw-once-rotation-fixed
    // billboards (alignedAxis=Z keeps them upright as the camera moves).
    // Airport: control tower + runway cross.
    const AIRPORT_SVG = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="-15 -15 30 30">
  <g fill="white" stroke="white" stroke-width="0.8" stroke-linejoin="round">
    <rect x="-11" y="-0.8" width="22" height="1.6" transform="rotate(35)"/>
    <rect x="-11" y="-0.8" width="22" height="1.6" transform="rotate(-35)"/>
    <rect x="-1.2" y="-11" width="2.4" height="13"/>
    <polygon points="-3,-11 3,-11 1.5,-13 -1.5,-13"/>
    <circle cx="0" cy="-8" r="0.9" fill="black"/>
  </g>
</svg>`);
    // Seaport: anchor symbol.
    const PORT_SVG = svgUrl(`
<svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="-15 -15 30 30">
  <g fill="none" stroke="white" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
    <circle cx="0" cy="-10" r="2.2" fill="white"/>
    <line x1="0" y1="-7.5" x2="0" y2="10"/>
    <line x1="-4" y1="-5" x2="4" y2="-5"/>
    <path d="M-10,4 Q-10,10 0,11 Q10,10 10,4"/>
    <line x1="-10" y1="4" x2="-7" y2="2.5"/>
    <line x1="10"  y1="4" x2="7"  y2="2.5"/>
  </g>
</svg>`);

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

    // Pick the right silhouette for an entity. Ships are classified by AIS
    // type code (30..89); aircraft by ICAO type designator.
    // AIS categories: 30 fishing, 31-32 tug, 35 military, 36 sailing,
    // 37 pleasure, 40-49 high-speed, 50-59 pilot/patrol, 60-69 passenger,
    // 70-79 cargo, 80-89 tanker.
    function shipIcon(d) {
        const t = parseInt(d.type, 10);
        if (!Number.isFinite(t)) return SHIP_SVG;
        if (t === 30) return FISHING_SVG;
        if (t === 31 || t === 32 || t === 33 || t === 52) return FISHING_SVG; // tugs/pilot small
        if (t === 35) return NAVAL_SVG;
        if (t === 36 || t === 37) return YACHT_SVG;
        if (t >= 60 && t <= 69) return PASSENGER_SVG;
        if (t >= 70 && t <= 79) return CARGO_SVG;
        if (t >= 80 && t <= 89) return TANKER_SVG;
        return SHIP_SVG;
    }
    function iconFor(d) {
        if (d.kind === 'sea') return shipIcon(d);
        if (d.kind !== 'air') return GROUND_SVG;
        if (d.type === 'ground' || (d.alt != null && d.alt < 50 && (d.speed || 0) < 30)) return GROUND_SVG;
        const t = (d.type || '').toUpperCase();
        if (t.startsWith('H') || t.startsWith('EC') || t.startsWith('R44')) return HELI_SVG;
        return PLANE_SVG;
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
                // FlightRadar-style silhouette icon. Color tints the white SVG,
                // rotation is screen-space from compass heading (negated because
                // Cesium rotation is CCW while compass bearing is CW-from-N).
                billboard: {
                    image: iconFor(d),
                    color: color,
                    scale: d.kind === 'air' ? 0.55 : 0.5,
                    // Grow when the camera is close, shrink when far away.
                    scaleByDistance: new Cesium.NearFarScalar(
                        5e4, 1.8,       // <= 50km cam dist: 1.8x
                        5e6, 1.0        // >= 5000km cam dist: 1.0x
                    ),
                    rotation: new Cesium.CallbackProperty(() => {
                        const h = e && e._data && e._data.heading;
                        return h != null ? Cesium.Math.toRadians(-h) : 0;
                    }, false),
                    alignedAxis: Cesium.Cartesian3.ZERO,
                    // Depth test against the globe so far-side entities hide
                    // behind the Earth; close-in icons still render on top of
                    // terrain via the small buffer below.
                    disableDepthTestDistance: 1000,
                    heightReference: Cesium.HeightReference.NONE
                },
                // Callsign tag — only visible when the camera is close enough
                // that the full string fits without cluttering the view.
                label: {
                    text: (d.callsign || d.id.split(':').pop() || '').toUpperCase(),
                    font: 'bold 11px "Share Tech Mono", monospace',
                    fillColor: color,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2.5,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(12, 0),
                    horizontalOrigin: Cesium.HorizontalOrigin.LEFT,
                    verticalOrigin: Cesium.VerticalOrigin.CENTER,
                    showBackground: true,
                    backgroundColor: new Cesium.Color(0, 0.05, 0.08, 0.7),
                    backgroundPadding: new Cesium.Cartesian2(5, 3),
                    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 3_000_000),
                    scaleByDistance: new Cesium.NearFarScalar(5e4, 1.3, 3e6, 0.8),
                    disableDepthTestDistance: 1000
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
        if (e.billboard) {
            e.billboard.color = SEL_COLOR;
            e.billboard.scale = e._kind === 'air' ? 0.85 : 0.8;
        }
        showSelPanel(e._data);
    }
    function clearSelection() {
        if (!selected) return;
        const baseColor = selected._baseColor || colorFor(selected._data);
        if (selected.billboard) {
            selected.billboard.color = baseColor;
            selected.billboard.scale = selected._kind === 'air' ? 0.55 : 0.5;
        }
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

        // Flight-route enrichment (aircraft only). routeCache is populated
        // asynchronously by routeTick(); if the record isn't ready yet,
        // retry once after 4 seconds so the panel self-updates.
        const cs = (d.callsign || '').trim();
        const r  = cs && typeof routeCache !== 'undefined' ? routeCache.get(cs) : null;
        $('sel_airline').textContent = (r && r.airline)  ? r.airline                                 : (d.kind === 'air' ? (cs ? '(looking up…)' : '---') : '---');
        $('sel_orig').textContent    = (r && r.orig)     ? `${r.orig.iata || '?'} — ${r.orig.name || ''}` : '---';
        $('sel_dest').textContent    = (r && r.dest)     ? `${r.dest.iata || '?'} — ${r.dest.name || ''}` : '---';
        if (d.kind === 'air' && cs && !r && selected && selected._data && selected._data.id === d.id) {
            setTimeout(() => { if (selected && selected._data && selected._data.id === d.id) showSelPanel(selected._data); }, 4000);
        }
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
        for (const d of json.entities) {
            upsertEntity(d);
            // Queue route lookup for any new aircraft callsign.
            if (typeof queueRoute === 'function') queueRoute(d);
        }
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

    // adsb.lol / OpenSky don't send CORS headers, so when we're running as a
    // static site (e.g. GitHub Pages) we route the requests through a public
    // CORS proxy. allorigins.win echoes the upstream body and adds the
    // correct `Access-Control-Allow-Origin` header for the requesting origin.
    const CORS_PROXY = 'https://api.allorigins.win/raw?url=';
    const viaProxy = url => CORS_PROXY + encodeURIComponent(url);

    async function fetchAircraftDirect() {
        // Primary: adsb.lol — open, no auth, global coverage — via CORS proxy.
        // Endpoint returns aircraft within 250 nm of a lat/lon; we tile a few
        // strategic regions to get worldwide sampling without hammering a
        // single point. 250 nm = ~463 km radius.
        const regions = [
            [40, -100],  // North America
            [50,   10],  // Europe
            [35,  105],  // East Asia
            [-5,   35],  // Africa / Middle East
            [-25, 135],  // Australia
            [-15, -55],  // South America
            [20,   80]   // India / South Asia
        ];
        let gotAny = false;
        for (const [lat, lon] of regions) {
            try {
                const url = `https://api.adsb.lol/v2/lat/${lat}/lon/${lon}/dist/250`;
                const r = await fetch(viaProxy(url));
                if (!r.ok) continue;
                const j = await r.json();
                const entities = [];
                for (const ac of (j.ac || [])) {
                    if (ac.lat == null || ac.lon == null) continue;
                    entities.push({
                        id: 'a:' + (ac.hex || ac.r || ac.flight || Math.random().toString(36)),
                        kind: 'air',
                        callsign: (ac.flight || '').trim() || ac.r || null,
                        country: icaoCountry(ac.hex),
                        iso2: null,
                        lat: ac.lat,
                        lon: ac.lon,
                        alt: ac.alt_geom != null ? ac.alt_geom * 0.3048 // ft -> m
                           : ac.alt_baro != null ? ac.alt_baro * 0.3048 : null,
                        heading: ac.track != null ? ac.track : ac.true_heading,
                        speed: ac.gs != null ? ac.gs * 0.5144 : null, // kt -> m/s
                        type: ac.t || (ac.alt_baro === 'ground' ? 'ground' : 'airborne'),
                        updated: Math.floor(Date.now() / 1000)
                    });
                }
                if (entities.length) { ingest({ entities }); gotAny = true; }
            } catch (e) {
                console.warn('adsb.lol region', lat, lon, 'failed:', e.message);
            }
        }
        if (gotAny) {
            $('status').textContent = 'DIRECT';
        } else {
            // Last-ditch: OpenSky anonymous via proxy.
            try {
                const r = await fetch(viaProxy('https://opensky-network.org/api/states/all'));
                if (!r.ok) throw new Error('HTTP ' + r.status);
                const raw = await r.json();
                const entities = [];
                for (const s of (raw.states || [])) {
                    const [icao24, callsign, origin_country, , , lon, lat, baro_alt,
                           on_ground, velocity, true_track, , , geo_alt] = s;
                    if (lat == null || lon == null) continue;
                    entities.push({
                        id: 'a:' + icao24, kind: 'air',
                        callsign: (callsign || '').trim() || null,
                        country: origin_country || icaoCountry(icao24),
                        iso2: null, lat, lon,
                        alt: geo_alt != null ? geo_alt : baro_alt,
                        heading: true_track, speed: velocity,
                        type: on_ground ? 'ground' : 'airborne',
                        updated: raw.time
                    });
                }
                ingest({ entities });
                $('status').textContent = 'DIRECT';
            } catch (e) {
                console.warn('All aircraft feeds failed:', e.message);
                $('status').textContent = 'DEGRADED';
            }
        }
    }
    // Keep old name for call sites below.
    const fetchOpenSkyDirect = fetchAircraftDirect;

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
    let aisMsgCount = 0;
    function startAisBrowser(apiKey) {
        try {
            console.info('[AIS] connecting to aisstream.io…');
            const ws = new WebSocket('wss://stream.aisstream.io/v0/stream');
            ws.onopen = () => {
                console.info('[AIS] WS open — subscribing to global bounding box');
                ws.send(JSON.stringify({
                    APIKey: apiKey,
                    BoundingBoxes: [[[-90, -180], [90, 180]]],
                    FilterMessageTypes: ['PositionReport', 'ShipStaticData']
                }));
            };
            ws.onmessage = ev => {
                try {
                    const m = JSON.parse(ev.data);
                    if (m.error || m.Error) { console.warn('[AIS] error msg:', m.error || m.Error); return; }
                    aisMsgCount++;
                    if (aisMsgCount === 1) console.info('[AIS] first message received');
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
            ws.onerror = err => console.warn('[AIS] WS error', err);
            ws.onclose = ev => {
                console.warn(`[AIS] WS closed code=${ev.code} reason=${ev.reason || '(none)'} — reconnecting in 5s`);
                setTimeout(() => startAisBrowser(apiKey), 5000);
            };
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
                    scaleByDistance: new Cesium.NearFarScalar(1e5, 1.6, 5e6, 1.0),
                    disableDepthTestDistance: 1000
                },
                label: {
                    text: b.name.toUpperCase(),
                    font: 'bold 12px "Share Tech Mono", monospace',
                    fillColor: col,
                    outlineColor: Cesium.Color.BLACK,
                    outlineWidth: 2.5,
                    style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                    pixelOffset: new Cesium.Cartesian2(10, -6),
                    showBackground: true,
                    backgroundColor: new Cesium.Color(0, 0.05, 0.08, 0.55),
                    backgroundPadding: new Cesium.Cartesian2(5, 3),
                    // Labels at readable size when close (1.4x), still visible
                    // at global view (0.8x) but not cluttering.
                    scaleByDistance: new Cesium.NearFarScalar(1e5, 1.4, 1.5e7, 0.8),
                    distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2.5e7),
                    disableDepthTestDistance: 1000
                },
                description: `${b.branch || ''} · ${b.country}`
            });
        }
    }).catch(e => console.warn('bases fetch failed:', e.message));

    // ---- Flight routes (origin -> destination) ------------------------------
    // adsb.lol's /api/0/routeset resolves a callsign to its scheduled origin
    // and destination airports (with lat/lon). We batch-query for every new
    // callsign we see, cache the answer, then draw a geodesic arc from the
    // departure airport through the current aircraft position to the arrival
    // airport. This is how flight-tracker style visualisations work — the
    // great-circle path and airport pins make the globe feel alive.
    const routeLines = new Cesium.CustomDataSource('routes');
    const airportPins = new Cesium.CustomDataSource('airports');
    viewer.dataSources.add(routeLines);
    viewer.dataSources.add(airportPins);

    // Top ICAO airline designators so we can show a readable airline name in
    // the selection panel. Missing codes fall back to the raw 3-letter code.
    const AIRLINES = {
        UAL:'United Airlines', AAL:'American Airlines', DAL:'Delta Air Lines',
        SWA:'Southwest Airlines', JBU:'JetBlue', ASA:'Alaska Airlines',
        FFT:'Frontier', NKS:'Spirit', HAL:'Hawaiian', SKW:'SkyWest',
        ACA:'Air Canada', WJA:'WestJet', TSC:'Air Transat',
        BAW:'British Airways', VIR:'Virgin Atlantic', EZY:'easyJet', RYR:'Ryanair',
        DLH:'Lufthansa', AFR:'Air France', KLM:'KLM', SAS:'Scandinavian',
        IBE:'Iberia', SWR:'Swiss', AUA:'Austrian', TAP:'TAP Portugal',
        FIN:'Finnair', AZA:'ITA Airways', THY:'Turkish Airlines',
        UAE:'Emirates', QTR:'Qatar Airways', ETD:'Etihad', SVA:'Saudia',
        SIA:'Singapore Airlines', CPA:'Cathay Pacific', ANA:'All Nippon Airways',
        JAL:'Japan Airlines', KAL:'Korean Air', AAR:'Asiana',
        CCA:'Air China', CES:'China Eastern', CSN:'China Southern',
        AIC:'Air India', AXB:'Air India Express', IGO:'IndiGo',
        QFA:'Qantas', VOZ:'Virgin Australia', ANZ:'Air New Zealand',
        FDX:'FedEx', UPS:'UPS', DHL:'DHL', GTI:'Atlas Air',
        RCH:'USAF Air Mobility', KNF:'USN', CNV:'USN', LOG:'US Coast Guard'
    };

    const routeCache = new Map();       // callsign -> { airline, flight, orig, dest } | null (miss)
    const routeEntityByCs = new Map();  // callsign -> Cesium polyline entity
    const airportSeen = new Set();      // iata we've already dropped a pin for
    const pendingRoutes = new Set();    // callsigns awaiting lookup
    let routesVisible = true;

    function addAirportPin(ap, kind) {
        if (!ap || ap.lat == null || ap.lon == null || !ap.iata) return;
        const key = ap.iata + ':' + kind;
        if (airportSeen.has(key)) return;
        airportSeen.add(key);
        const col = kind === 'orig'
            ? Cesium.Color.fromCssColorString('#3dff9c')  // green = departure
            : Cesium.Color.fromCssColorString('#ffb347'); // amber = arrival
        airportPins.entities.add({
            position: Cesium.Cartesian3.fromDegrees(ap.lon, ap.lat, 0),
            billboard: {
                image: AIRPORT_SVG,
                color: col,
                scale: 0.7,
                // Screen-aligned — ignore aircraft-style heading rotation.
                alignedAxis: Cesium.Cartesian3.ZERO,
                rotation: 0,
                scaleByDistance: new Cesium.NearFarScalar(1e5, 1.6, 5e6, 0.9),
                disableDepthTestDistance: 1000,
                heightReference: Cesium.HeightReference.NONE
            },
            label: {
                text: ap.iata + (ap.name ? '\n' + ap.name.toUpperCase() : ''),
                font: 'bold 11px "Share Tech Mono", monospace',
                fillColor: col,
                outlineColor: Cesium.Color.BLACK,
                outlineWidth: 2.5,
                style: Cesium.LabelStyle.FILL_AND_OUTLINE,
                pixelOffset: new Cesium.Cartesian2(0, -22),
                showBackground: true,
                backgroundColor: new Cesium.Color(0, 0.05, 0.08, 0.6),
                backgroundPadding: new Cesium.Cartesian2(5, 3),
                disableDepthTestDistance: 1000,
                scaleByDistance: new Cesium.NearFarScalar(1e5, 1.5, 1.5e7, 0.7),
                distanceDisplayCondition: new Cesium.DistanceDisplayCondition(0, 2.5e7)
            },
            _apInfo: { ap, kind }
        });
    }

    function drawRouteFor(callsign, entity) {
        const r = routeCache.get(callsign);
        if (!r || !entity) return;
        // Don't add twice.
        if (routeEntityByCs.has(callsign)) return;
        const col = colorFor(entity._data).withAlpha(0.55);
        // Build the polyline positions dynamically: orig -> live plane -> dest.
        // Using a CallbackProperty keeps the middle vertex pinned to the
        // aircraft as it moves, so you see the flown vs remaining segments.
        const origPos = Cesium.Cartesian3.fromDegrees(r.orig.lon, r.orig.lat, 0);
        const destPos = Cesium.Cartesian3.fromDegrees(r.dest.lon, r.dest.lat, 0);
        const line = routeLines.entities.add({
            polyline: {
                positions: new Cesium.CallbackProperty(() => {
                    const mid = entity._sampled.getValue(viewer.clock.currentTime);
                    return mid ? [origPos, mid, destPos] : [origPos, destPos];
                }, false),
                width: 1.2,
                arcType: Cesium.ArcType.GEODESIC,
                material: new Cesium.PolylineDashMaterialProperty({
                    color: col,
                    dashLength: 16
                })
            }
        });
        routeEntityByCs.set(callsign, line);
        addAirportPin(r.orig, 'orig');
        addAirportPin(r.dest, 'dest');
    }

    async function resolveRouteBatch(batch) {
        // batch: [{callsign, lat, lng}]
        try {
            const r = await fetch('https://api.adsb.lol/api/0/routeset', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ planes: batch })
            });
            if (!r.ok) return;
            const arr = await r.json();
            for (let i = 0; i < arr.length; i++) {
                const row = arr[i];
                const cs = (batch[i].callsign || '').trim();
                if (!cs) continue;
                const aps = row && row._airports;
                if (!aps || aps.length < 2) { routeCache.set(cs, null); continue; }
                const orig = aps[0], dest = aps[aps.length - 1];
                if (orig.lat == null || dest.lat == null) { routeCache.set(cs, null); continue; }
                routeCache.set(cs, {
                    airline: AIRLINES[row.airline_code] || row.airline_code || null,
                    flight:  row.number || null,
                    orig: { lat: orig.lat, lon: orig.lon, iata: orig.iata, name: orig.name },
                    dest: { lat: dest.lat, lon: dest.lon, iata: dest.iata, name: dest.name }
                });
            }
            // After the cache is warm, render routes for any matching entities.
            for (const e of entities.values()) {
                const cs = e._data && e._data.callsign && e._data.callsign.trim();
                if (cs && routeCache.get(cs)) drawRouteFor(cs, e);
            }
        } catch (e) { console.warn('routeset failed:', e.message); }
    }

    async function routeTick() {
        if (pendingRoutes.size === 0) return;
        const batch = [];
        for (const cs of pendingRoutes) {
            const e = [...entities.values()].find(x => x._data && (x._data.callsign || '').trim() === cs);
            if (!e) continue;
            batch.push({ callsign: cs, lat: e._data.lat, lng: e._data.lon });
            if (batch.length >= 100) break;
        }
        for (const p of batch) pendingRoutes.delete(p.callsign);
        if (batch.length) await resolveRouteBatch(batch);
    }

    // Queue route lookups for new aircraft callsigns. Called from ingest().
    function queueRoute(d) {
        if (!routesVisible) return;
        if (d.kind !== 'air') return;
        const cs = (d.callsign || '').trim();
        if (!cs) return;
        if (routeCache.has(cs)) {
            const ent = entities.get(d.id);
            if (ent && routeCache.get(cs)) drawRouteFor(cs, ent);
            return;
        }
        pendingRoutes.add(cs);
    }
    setInterval(routeTick, 3000);

    // ---- Layer toggles -------------------------------------------------------
    document.querySelectorAll('#layers .btn').forEach(btn => {
        btn.addEventListener('click', () => {
            btn.classList.toggle('active');
            const on = btn.classList.contains('active');
            if (btn.dataset.layer === 'bases') baseCollection.show = on;
            if (btn.dataset.layer === 'trails') {
                for (const e of entities.values()) e.path.show = on;
            }
            if (btn.dataset.layer === 'routes') {
                routesVisible = on;
                routeLines.show = on;
                airportPins.show = on;
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
                if (selected.billboard) {
                    selected.billboard.color = Cesium.Color.RED;
                    selected.billboard.scale = selected._kind === 'air' ? 0.9 : 0.8;
                }
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
