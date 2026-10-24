// space.js - Clean, Lightweight Starfield Background (Wisely Optimized)

let scene, camera, renderer;
let starGeometry, starMaterial, starParticles;
let isWarping = false;
let warpProgress = 0;
let currentWarpFactor = 1.0;

function initSpace() {
    const canvas = document.getElementById('space-canvas');
    if (!canvas) return;

    scene = new THREE.Scene();
    scene.fog = new THREE.FogExp2(0x04060e, 0.0012);

    camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 2000);
    camera.position.z = 1000;

    renderer = new THREE.WebGLRenderer({
        canvas: canvas,
        alpha: true,
        antialias: false,
        powerPreference: "high-performance"
    });
    renderer.setSize(window.innerWidth, window.innerHeight);
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

    // Starfield
    const starCount = 1200;
    starGeometry = new THREE.BufferGeometry();
    const starPositions = new Float32Array(starCount * 3);

    for (let i = 0; i < starCount * 3; i += 3) {
        starPositions[i] = (Math.random() - 0.5) * 2000;
        starPositions[i + 1] = (Math.random() - 0.5) * 2000;
        starPositions[i + 2] = (Math.random() - 0.5) * 2000;
    }

    starGeometry.setAttribute('position', new THREE.BufferAttribute(starPositions, 3));

    starMaterial = new THREE.PointsMaterial({
        color: 0x00f0ff,
        size: 1.5,
        transparent: true,
        opacity: 0.5,
        blending: THREE.AdditiveBlending
    });

    starParticles = new THREE.Points(starGeometry, starMaterial);
    scene.add(starParticles);

    window.addEventListener('resize', onWindowResize, false);
    animate();
}

function onWindowResize() {
    if (!camera || !renderer) return;
    camera.aspect = window.innerWidth / window.innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(window.innerWidth, window.innerHeight);
}

function animate() {
    requestAnimationFrame(animate);

    if (starParticles) {
        starParticles.rotation.y += 0.0002;
        starParticles.rotation.x += 0.0001;

        if (isWarping) {
            starParticles.position.z += 12;
            if (starParticles.position.z > 800) {
                starParticles.position.z = -400;
            }
        }
    }

    if (renderer && scene && camera) {
        renderer.render(scene, camera);
    }
}

function triggerWarp(duration = 2000) {
    isWarping = true;
    setTimeout(() => {
        isWarping = false;
        if (starParticles) starParticles.position.z = 0;
    }, duration);
}

// Global stubs for backward-compatibility
window.triggerWarp = triggerWarp;
window.setFaceState = () => {};
window.setMicVolume = () => {};

document.addEventListener('DOMContentLoaded', initSpace);
