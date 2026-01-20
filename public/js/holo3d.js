// 3D Holographic Map Visualization
(function() {
    'use strict';

    let scene, camera, renderer, controls;
    let mapMesh, gridHelper;
    let locations = [];
    let markers = [];
    let selectedMarker = null;

    const MAP_SIZE = 100;

    init();
    animate();

    function init() {
        // Scene setup
        scene = new THREE.Scene();
        scene.fog = new THREE.FogExp2(0x000000, 0.002);

        // Camera
        camera = new THREE.PerspectiveCamera(
            60,
            window.innerWidth / window.innerHeight,
            0.1,
            1000
        );
        camera.position.set(0, 80, 120);
        camera.lookAt(0, 0, 0);

        // Renderer
        renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        renderer.setSize(window.innerWidth, window.innerHeight);
        renderer.setClearColor(0x000000, 1);
        document.getElementById('canvas-container').appendChild(renderer.domElement);

        // Controls
        controls = new THREE.OrbitControls(camera, renderer.domElement);
        controls.enableDamping = true;
        controls.dampingFactor = 0.05;
        controls.minDistance = 50;
        controls.maxDistance = 300;
        controls.maxPolarAngle = Math.PI / 2.1;

        // Lights
        const ambientLight = new THREE.AmbientLight(0x0066ff, 0.3);
        scene.add(ambientLight);

        const pointLight1 = new THREE.PointLight(0x00ccff, 1, 300);
        pointLight1.position.set(50, 50, 50);
        scene.add(pointLight1);

        const pointLight2 = new THREE.PointLight(0xff00ff, 0.8, 300);
        pointLight2.position.set(-50, 50, -50);
        scene.add(pointLight2);

        // Create holographic grid
        createHolographicGrid();

        // Create map terrain
        createMapTerrain();

        // Load location data
        loadLocations();

        // Event listeners
        window.addEventListener('resize', onWindowResize, false);
        renderer.domElement.addEventListener('click', onMapClick, false);
        renderer.domElement.addEventListener('mousemove', onMouseMove, false);

        // Hide loading
        setTimeout(() => {
            document.getElementById('loading').style.display = 'none';
        }, 1000);
    }

    function createHolographicGrid() {
        // Create glowing grid
        const gridSize = MAP_SIZE * 1.5;
        const divisions = 50;
        
        const gridGeometry = new THREE.PlaneGeometry(gridSize, gridSize, divisions, divisions);
        
        const gridMaterial = new THREE.ShaderMaterial({
            uniforms: {
                time: { value: 0 },
                color: { value: new THREE.Color(0x00ccff) }
            },
            vertexShader: `
                varying vec2 vUv;
                varying vec3 vPosition;
                void main() {
                    vUv = uv;
                    vPosition = position;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform float time;
                uniform vec3 color;
                varying vec2 vUv;
                varying vec3 vPosition;
                
                void main() {
                    float grid = 0.0;
                    vec2 coord = vUv * 50.0;
                    
                    // Create grid lines
                    vec2 grid_uv = fract(coord);
                    float line = min(
                        step(0.95, grid_uv.x) + step(grid_uv.x, 0.05),
                        step(0.95, grid_uv.y) + step(grid_uv.y, 0.05)
                    );
                    
                    // Pulsing effect
                    float pulse = sin(time * 2.0) * 0.3 + 0.7;
                    
                    // Distance fade
                    float dist = length(vPosition.xy) / 75.0;
                    float fade = 1.0 - smoothstep(0.5, 1.0, dist);
                    
                    gl_FragColor = vec4(color * pulse, line * fade * 0.3);
                }
            `,
            transparent: true,
            side: THREE.DoubleSide,
            depthWrite: false
        });

        const grid = new THREE.Mesh(gridGeometry, gridMaterial);
        grid.rotation.x = -Math.PI / 2;
        grid.position.y = -0.5;
        scene.add(grid);
    }

    function createMapTerrain() {
        // Create a simple terrain mesh with holographic material
        const geometry = new THREE.PlaneGeometry(MAP_SIZE, MAP_SIZE, 100, 100);
        
        // Add some height variation to vertices
        const positions = geometry.attributes.position;
        for (let i = 0; i < positions.count; i++) {
            const x = positions.getX(i);
            const y = positions.getY(i);
            const height = Math.sin(x * 0.1) * Math.cos(y * 0.1) * 2;
            positions.setZ(i, height);
        }
        geometry.computeVertexNormals();

        const material = new THREE.ShaderMaterial({
            uniforms: {
                time: { value: 0 },
                mainColor: { value: new THREE.Color(0x0088ff) },
                accentColor: { value: new THREE.Color(0xff0088) }
            },
            vertexShader: `
                varying vec3 vNormal;
                varying vec3 vPosition;
                varying float vHeight;
                
                void main() {
                    vNormal = normalize(normalMatrix * normal);
                    vPosition = position;
                    vHeight = position.z;
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform float time;
                uniform vec3 mainColor;
                uniform vec3 accentColor;
                varying vec3 vNormal;
                varying vec3 vPosition;
                varying float vHeight;
                
                void main() {
                    // Height-based coloring
                    float heightFactor = (vHeight + 3.0) / 6.0;
                    vec3 color = mix(mainColor, accentColor, heightFactor);
                    
                    // Holographic scan effect
                    float scan = sin(vPosition.y * 0.5 + time * 2.0) * 0.5 + 0.5;
                    
                    // Fresnel edge glow
                    float fresnel = pow(1.0 - abs(dot(vNormal, vec3(0, 0, 1))), 3.0);
                    
                    // Combine effects
                    vec3 finalColor = color * (0.5 + scan * 0.5) + fresnel * accentColor;
                    
                    // Transparency based on height
                    float alpha = 0.4 + heightFactor * 0.4 + fresnel * 0.2;
                    
                    gl_FragColor = vec4(finalColor, alpha);
                }
            `,
            transparent: true,
            side: THREE.DoubleSide,
            wireframe: false
        });

        mapMesh = new THREE.Mesh(geometry, material);
        mapMesh.rotation.x = -Math.PI / 2;
        scene.add(mapMesh);

        // Add wireframe overlay
        const wireframeGeo = geometry.clone();
        const wireframeMat = new THREE.MeshBasicMaterial({
            color: 0x00ccff,
            wireframe: true,
            transparent: true,
            opacity: 0.1
        });
        const wireframe = new THREE.Mesh(wireframeGeo, wireframeMat);
        wireframe.rotation.x = -Math.PI / 2;
        wireframe.position.y = 0.1;
        scene.add(wireframe);
    }

    function loadLocations() {
        api.getLocations(function(data) {
            locations = data;
            createLocationMarkers(locations);
        });
    }

    function createLocationMarkers(locs) {
        locs.forEach(loc => {
            const marker = createHolographicMarker(loc);
            if (marker) {
                scene.add(marker);
                markers.push({ mesh: marker, data: loc });
            }
        });
    }

    function createHolographicMarker(location) {
        if (!location.dms) return null;

        // Convert DMS to position on map
        const lat = location.dms.lat[0] + location.dms.lat[1]/60 + location.dms.lat[2]/3600;
        const lng = location.dms.lng[0] + location.dms.lng[1]/60 + location.dms.lng[2]/3600;

        // Map coordinates to 3D space (-50 to 50 for a 100 unit map)
        const x = (lng / 180) * MAP_SIZE * 0.5;
        const z = -(lat / 90) * MAP_SIZE * 0.5;

        // Create marker group
        const group = new THREE.Group();
        group.position.set(x, 0, z);

        // Marker type colors
        const colors = {
            'city': 0x00ffff,
            'capital': 0xff00ff,
            'base': 0xff0000,
            'airport': 0x00ff00,
            'superweapon': 0xffff00,
            'crater': 0xff8800
        };

        const color = colors[location.datatype] || 0x00ccff;

        // Create glowing sphere
        const sphereGeom = new THREE.SphereGeometry(0.5, 16, 16);
        const sphereMat = new THREE.ShaderMaterial({
            uniforms: {
                time: { value: 0 },
                color: { value: new THREE.Color(color) }
            },
            vertexShader: `
                varying vec3 vNormal;
                void main() {
                    vNormal = normalize(normalMatrix * normal);
                    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
                }
            `,
            fragmentShader: `
                uniform float time;
                uniform vec3 color;
                varying vec3 vNormal;
                
                void main() {
                    float intensity = pow(0.7 - dot(vNormal, vec3(0, 0, 1.0)), 2.0);
                    float pulse = sin(time * 3.0) * 0.3 + 0.7;
                    gl_FragColor = vec4(color * pulse, 1.0) * intensity;
                }
            `,
            transparent: true,
            blending: THREE.AdditiveBlending
        });

        const sphere = new THREE.Mesh(sphereGeom, sphereMat);
        sphere.userData.location = location;
        group.add(sphere);

        // Add vertical beam
        const beamGeom = new THREE.CylinderGeometry(0.1, 0.1, 15, 8);
        const beamMat = new THREE.MeshBasicMaterial({
            color: color,
            transparent: true,
            opacity: 0.3,
            blending: THREE.AdditiveBlending
        });
        const beam = new THREE.Mesh(beamGeom, beamMat);
        beam.position.y = 7.5;
        group.add(beam);

        // Add glow ring
        const ringGeom = new THREE.RingGeometry(1, 1.5, 32);
        const ringMat = new THREE.MeshBasicMaterial({
            color: color,
            transparent: true,
            opacity: 0.3,
            side: THREE.DoubleSide,
            blending: THREE.AdditiveBlending
        });
        const ring = new THREE.Mesh(ringGeom, ringMat);
        ring.rotation.x = -Math.PI / 2;
        ring.position.y = 0.1;
        group.add(ring);

        return group;
    }

    function onMouseMove(event) {
        const mouse = new THREE.Vector2(
            (event.clientX / window.innerWidth) * 2 - 1,
            -(event.clientY / window.innerHeight) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, camera);

        // Check intersection with markers
        const intersects = raycaster.intersectObjects(scene.children, true);
        
        for (let i = 0; i < intersects.length; i++) {
            if (intersects[i].object.userData.location) {
                document.getElementById('canvas-container').style.cursor = 'pointer';
                return;
            }
        }
        document.getElementById('canvas-container').style.cursor = 'default';
    }

    function onMapClick(event) {
        const mouse = new THREE.Vector2(
            (event.clientX / window.innerWidth) * 2 - 1,
            -(event.clientY / window.innerHeight) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, camera);

        const intersects = raycaster.intersectObjects(scene.children, true);
        
        for (let i = 0; i < intersects.length; i++) {
            if (intersects[i].object.userData.location) {
                showLocationInfo(intersects[i].object.userData.location);
                return;
            }
        }
        
        // Hide info panel if clicking elsewhere
        document.getElementById('info-panel').style.display = 'none';
    }

    function showLocationInfo(location) {
        const panel = document.getElementById('info-panel');
        const types = {
            "city": "City",
            "capital": "Capital City",
            "base": "Military Base",
            "airport": "Airport / Space Center",
            "superweapon": "Superweapon",
            "crater": "Ulysses Impact Crater"
        };

        panel.innerHTML = `
            <h2>${location.name}</h2>
            <p><strong>Type:</strong> ${types[location.datatype] || location.datatype}</p>
            ${location.desc ? `<p>${location.desc}</p>` : ''}
            ${location.url ? `<p><a href="${location.url}" target="_blank" style="color: #0cf;">More Info</a></p>` : ''}
        `;
        panel.style.display = 'block';
    }

    function onWindowResize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }

    let time = 0;
    function animate() {
        requestAnimationFrame(animate);
        
        time += 0.016;

        // Update shader uniforms
        if (mapMesh && mapMesh.material.uniforms) {
            mapMesh.material.uniforms.time.value = time;
        }

        // Update grid
        scene.children.forEach(child => {
            if (child.material && child.material.uniforms && child.material.uniforms.time) {
                child.material.uniforms.time.value = time;
            }
        });

        // Animate markers
        markers.forEach(marker => {
            marker.mesh.rotation.y += 0.01;
            if (marker.mesh.children[0] && marker.mesh.children[0].material.uniforms) {
                marker.mesh.children[0].material.uniforms.time.value = time;
            }
        });

        controls.update();
        renderer.render(scene, camera);
    }
})();
