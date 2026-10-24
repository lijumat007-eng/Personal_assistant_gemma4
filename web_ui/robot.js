import * as THREE from './vendor/three/three.module.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';

const $ = id => document.getElementById(id);
let initialization;
export function initialize() {
    initialization ||= buildRobot().catch(error => { initialization = null; throw error; });
    return initialization;
}

async function buildRobot() {
    const viewport = $('robot-viewport');
    const status = $('robot-status');
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: 'low-power' });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.25;
    renderer.domElement.setAttribute('aria-label', '3D robot character');
    renderer.domElement.setAttribute('role', 'img');
    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, .1, 100);
    scene.add(new THREE.HemisphereLight(0xf2f6ff, 0x77716a, 2.8));
    const key = new THREE.DirectionalLight(0xfff4df, 3.2);
    key.position.set(4, 7, 6); scene.add(key);
    const rim = new THREE.DirectionalLight(0xa9c9ff, 1.6);
    rim.position.set(-4, 3, -4); scene.add(rim);

    let gltf;
    try {
        gltf = await new GLTFLoader().loadAsync('./assets/robot/RobotExpressive.glb');
    } catch (error) { renderer.dispose(); throw new Error('The character file could not be loaded. Reopen the preview to retry.'); }
    const model = gltf.scene;
    const bounds = new THREE.Box3().setFromObject(model);
    const size = bounds.getSize(new THREE.Vector3());
    const center = bounds.getCenter(new THREE.Vector3());
    // Use a parent for framing so animation tracks retain their original transforms.
    const rig = new THREE.Group();
    const scale = 3.6 / size.y;
    rig.scale.setScalar(scale);
    model.position.x -= center.x;
    model.position.z -= center.z;
    model.position.y -= bounds.min.y;
    rig.add(model); scene.add(rig);
    let face;
    model.traverse(object => { if (object.morphTargetDictionary?.Surprised !== undefined) face = object; });
    if (!face) { renderer.dispose(); throw new Error('The character has no expression controls.'); }

    // A tiny illuminated equalizer is attached to the face and follows the head rig.
    // This asset has expression morphs but no speech/viseme morphs.
    const mouth = new THREE.Group();
    mouth.position.set(0, -.0132, -.0034);
    const mouthMaterial = new THREE.MeshBasicMaterial({ color: 0xffdf9c });
    const bars = [];
    for (let i = 0; i < 5; i++) {
        const bar = new THREE.Mesh(new THREE.BoxGeometry(.001, .00016, .0004), mouthMaterial);
        bar.position.x = (i - 2) * .0016;
        mouth.add(bar); bars.push(bar);
    }
    face.add(mouth);
    const shadowCanvas = document.createElement('canvas'); shadowCanvas.width = shadowCanvas.height = 128;
    const ctx = shadowCanvas.getContext('2d');
    const gradient = ctx.createRadialGradient(64, 64, 0, 64, 64, 64);
    gradient.addColorStop(0, 'rgba(35,40,50,.22)'); gradient.addColorStop(1, 'rgba(35,40,50,0)');
    ctx.fillStyle = gradient; ctx.fillRect(0, 0, 128, 128);
    const shadowTexture = new THREE.CanvasTexture(shadowCanvas);
    const shadow = new THREE.Mesh(new THREE.PlaneGeometry(3.3, 2.5), new THREE.MeshBasicMaterial({ map: shadowTexture, transparent: true, depthWrite: false }));
    shadow.rotation.x = -Math.PI / 2; shadow.position.y = -.02; scene.add(shadow);
    shadow.visible = !window.jarvisDesktop;
    viewport.replaceChildren(renderer.domElement);

    const mixer = new THREE.AnimationMixer(model);
    const actions = Object.fromEntries(gltf.animations.map(clip => [clip.name, mixer.clipAction(clip)]));
    let activeAction, manualGesture = false, state = window.jarvisCompanion.getState();
    const quiet = $('robot-quiet');
    quiet.checked = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let savedColour;
    try { savedColour = localStorage.getItem('jarvis_robot_color'); } catch (_) {}
    const colours = { blue: '#4779ad', mint: '#588f7e' };
    const bodyMaterials = new Set();
    model.traverse(object => {
        const materials = object.material ? (Array.isArray(object.material) ? object.material : [object.material]) : [];
        materials.forEach(material => { if (material.name === 'Main') bodyMaterials.add(material); });
    });
    const originalColours = new Map([...bodyMaterials].map(material => [material, material.color.clone()]));
    function setColour(value) {
        bodyMaterials.forEach(material => material.color.copy(colours[value] ? new THREE.Color(colours[value]) : originalColours.get(material)));
        $('robot-color').value = colours[value] ? value : 'original';
        try { localStorage.setItem('jarvis_robot_color', $('robot-color').value); } catch (_) {}
    }
    setColour(savedColour);

    function expression(name = 'neutral', strength = 1) {
        face.morphTargetInfluences.fill(0);
        const index = face.morphTargetDictionary[name];
        if (index !== undefined) face.morphTargetInfluences[index] = strength;
        $('robot-expression').value = name;
    }
    function play(name, deliberate = true) {
        if (!actions[name]) return;
        manualGesture = deliberate && name !== 'Idle';
        const previous = activeAction;
        activeAction = actions[name];
        activeAction.reset().setEffectiveTimeScale(1).setEffectiveWeight(1);
        // Even Dance and Walking return to Idle instead of running indefinitely.
        activeAction.setLoop(name === 'Idle' ? THREE.LoopRepeat : THREE.LoopOnce, name === 'Idle' ? Infinity : 1);
        activeAction.clampWhenFinished = name !== 'Idle';
        activeAction.play();
        if (previous && previous !== activeAction) previous.crossFadeTo(activeAction, .25, false);
        $('robot-motion').value = name;
    }
    mixer.addEventListener('finished', event => {
        if (event.action === activeAction) { play('Idle', false); reflectState(); }
    });
    function reflectState() {
        const label = state.recording ? 'Listening…' : state.approval ? 'Waiting for your approval' : state.busy ? 'Thinking…' : state.speaking ? 'Speaking…' : state.speechPending ? 'Starting voice…' : state.error ? 'Something went wrong · see chat' : 'Ready when you are';
        if (status.textContent !== label) status.textContent = label;
        $('robot-stop-voice').hidden = !state.speaking && !state.speechPending;
        if (state.error) expression('Sad', .75);
        else if (state.approval) expression('Surprised', .6);
        else if (state.recording || state.busy) expression('Surprised', .2);
        else expression();
    }
    window.addEventListener('jarvis:state', event => { state = event.detail; reflectState(); });
    window.addEventListener('jarvis:speech-error', () => { status.textContent = 'Voice playback unavailable. Check your browser’s installed voices.'; });
    window.addEventListener('jarvis:reaction', event => {
        if (!$('robot-stage').hidden && !quiet.checked) play(event.detail, false);
    });
    document.querySelectorAll('[data-robot-animation]').forEach(button => {
        button.disabled = false;
        button.addEventListener('click', () => play(button.dataset.robotAnimation));
    });
    ['robot-motion', 'robot-expression', 'robot-color', 'robot-voice-test'].forEach(id => { $(id).disabled = false; });
    $('robot-motion').addEventListener('change', event => play(event.target.value));
    $('robot-expression').addEventListener('change', event => expression(event.target.value));
    $('robot-color').addEventListener('change', event => setColour(event.target.value));
    $('robot-voice-test').addEventListener('click', () => {
        if (!window.speechSynthesis) { status.textContent = 'Voice playback is unavailable in this browser.'; return; }
        window.jarvisCompanion.testVoice();
    });
    $('robot-stop-voice').addEventListener('click', () => window.jarvisCompanion.stopSpeech());
    function resize() {
        const { width, height } = viewport.getBoundingClientRect();
        if (!width || !height) return;
        renderer.setSize(width, height, false);
        camera.aspect = width / height;
        // Fit both the body and outstretched arms, including short mobile viewports.
        const distance = Math.max(6.8, 2.65 / (Math.tan(THREE.MathUtils.degToRad(19)) * camera.aspect));
        camera.position.set(.3, 2.25, distance);
        camera.lookAt(0, 1.9, 0); camera.updateProjectionMatrix();
    }
    const observer = new ResizeObserver(resize); observer.observe(viewport); resize();
    renderer.domElement.addEventListener('webglcontextlost', event => {
        event.preventDefault(); status.textContent = 'Graphics paused. Reload the page to restore the character.';
    });
    play('Idle', false); mixer.update(0); reflectState();
    const raycaster = new THREE.Raycaster();
    window.jarvisRobot = Object.freeze({
        play: name => { if (['Idle', 'Wave', 'Dance', 'Yes', 'No', 'ThumbsUp', 'Walking'].includes(name)) play(name); },
        hitTest: (clientX, clientY) => {
            const rect = renderer.domElement.getBoundingClientRect();
            if (!rect.width || !rect.height || clientX < rect.left || clientX > rect.right || clientY < rect.top || clientY > rect.bottom) return false;
            raycaster.setFromCamera(new THREE.Vector2((clientX - rect.left) / rect.width * 2 - 1, -(clientY - rect.top) / rect.height * 2 + 1), camera);
            model.updateWorldMatrix(true, true);
            return raycaster.intersectObject(model, true).length > 0;
        }
    });
    window.dispatchEvent(new CustomEvent('jarvis:robot-ready'));
    let lastFrame = 0, animationTime = 0, disposed = false;
    function render(time) {
        if (disposed) return;
        requestAnimationFrame(render);
        if (document.hidden || document.body.dataset.desktopHidden === 'true' || $('robot-stage').hidden || !viewport.clientHeight) { lastFrame = 0; return; }
        if (lastFrame && time - lastFrame < 1000 / 30) return;
        const delta = lastFrame ? Math.min((time - lastFrame) / 1000, .08) : 0;
        lastFrame = time; animationTime += delta;
        if (!quiet.checked || manualGesture || activeAction !== actions.Idle) mixer.update(delta);
        mouth.visible = state.speaking;
        bars.forEach((bar, i) => { bar.scale.z = state.speaking ? 1.5 + 2.5 * Math.abs(Math.sin(animationTime * 12 + i * 1.4)) : 1; });
        renderer.render(scene, camera);
    }
    requestAnimationFrame(render);
    window.addEventListener('pagehide', event => {
        if (event.persisted) return;
        disposed = true; observer.disconnect(); mixer.stopAllAction();
        scene.traverse(object => { object.geometry?.dispose(); });
        const materials = new Set();
        scene.traverse(object => {
            if (object.material) (Array.isArray(object.material) ? object.material : [object.material]).forEach(material => materials.add(material));
        });
        materials.forEach(material => material.dispose()); shadowTexture.dispose(); renderer.dispose();
    }, { once: true });
}
