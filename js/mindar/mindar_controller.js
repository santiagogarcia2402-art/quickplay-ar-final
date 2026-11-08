import * as THREE from 'three';
import { MindARThree } from 'mindar-image-three';

class MindARController {

    constructor(container, threePlayer, debug = false) {
        this.container = container;
        this.threePlayer = threePlayer;
        this.debug = debug;
        this.isMobile = /Android|iPhone|iPod|iPad/i.test(navigator.userAgent);

        this.imageTargetSrc = 'assets/marker/targets.mind';

        this.mindar = null;
        this.anchors = [];
        this.started = false;

        this.listeners = {
            start: [],
            found: [],
            lost: [],
            update: [],
        };

        this.clickHandlerBound = false;
    }

    addListener(type, callback) { this.listeners[type].push(callback); }

    dispatch(type, event) {
        for (const listener of this.listeners[type]) {
            listener(event);
        }
    }

    async start() {

        if (this.started) return;

        // Limpia restos de un intento anterior (p.ej. un <video> huérfano).
        if (this.mindar) { this.stop(); }
        this.container.replaceChildren();
        this.anchors = [];

        const player = this.threePlayer;

        this.mindar = new MindARThree({
            container: this.container,
            imageTargetSrc: this.imageTargetSrc,
            filterMinCF: 0.001,
            filterBeta: 1000,
            warmupTolerance: 5,
            missTolerance: 5,
            uiLoading: 'no',
            uiScanning: 'no',
            uiError: 'yes',
        });

        const { scene, camera, renderer } = this.mindar;

        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setClearColor(0x000000, 0);

        const targetConfigs = [
            { index: 0, groupName: 'TARGET_GTA', label: 'GTA' },
            { index: 1, groupName: 'TARGET_CUPHEAD', label: 'CUPHEAD' },
            { index: 2, groupName: 'TARGET_FIFA', label: 'FIFA' },
            { index: 3, groupName: 'TARGET_TLOU', label: 'TLOU' },
        ];

        targetConfigs.forEach(({ index, groupName, label }) => {
            const anchor = this.mindar.addAnchor(index);
            const content = player?.scene?.getObjectByName(groupName);

            if (content) {
                content.scale.set(1.15, 1.15, 1.15);
                content.rotation.set(THREE.MathUtils.degToRad(90), 0, 0);
                content.visible = false;

                anchor.group.add(content);
            }

            if (this.debug) {
                this.addMarkerDebugHelpers(anchor.group);
            }

            anchor.onTargetFound = () => {
                console.log(`MindARController: target ${label} detectado (${index})`);
                if (content) content.visible = true;
                this.dispatch('found', { name: label, groupName, index, content });
            };

            anchor.onTargetLost = () => {
                console.log(`MindARController: target ${label} perdido (${index})`);
                if (content) content.visible = false;
                this.dispatch('lost', { name: label, groupName, index, content });
            };

            this.anchors.push(anchor);
        });

        this.copyEnvironment(scene, player);
        this.copyLights(scene, player);
        this.copyRendererSettings(renderer, player);

        // El player sigue corriendo (events update/audio) pero deja de pintar.
        if (player?.setRenderEnabled) player.setRenderEnabled(false);

        this.bindClickEvents();

        try {
            await this.mindar.start();
        } catch (e) {
            this.mindar = null;
            this.started = false;
            const detail = (e && e.message) ? `: ${e.message}` : '. Comprobá que la cámara esté disponible y permitas el acceso';
            throw new Error(`No se pudo iniciar la cámara AR${detail}`);
        }

        renderer.setAnimationLoop(() => {
            this.dispatch('update', {});
            renderer.render(scene, camera);
        });

        this.started = true;
        this.dispatch('start', {});
    }

    stop() {
        if (!this.mindar) return;
        if (this.mindar.renderer?.setAnimationLoop) {
            this.mindar.renderer.setAnimationLoop(null);
        }
        this.mindar.stop();
        this.mindar = null;
        this.started = false;
    }

    switchCamera() {
        this.mindar?.switchCamera();
    }

    copyEnvironment(scene, player) {
        const appScene = player?.scene;
        if (!appScene) return;

        if (appScene.environment) {
            scene.environment = appScene.environment;
        }
        if (appScene.environmentIntensity !== undefined) {
            scene.environmentIntensity = appScene.environmentIntensity;
        }
        if (appScene.environmentRotation) {
            scene.environmentRotation.copy(appScene.environmentRotation);
        }
    }

    copyLights(scene, player) {
        const appScene = player?.scene;
        if (!appScene) return;

        appScene.traverse((obj) => {
            if (obj.isLight && obj !== appScene) {
                scene.add(obj.clone());
            }
        });
    }

    copyRendererSettings(renderer, player) {
        const appRenderer = player?.renderer;
        if (!appRenderer || !renderer) return;

        renderer.toneMapping = appRenderer.toneMapping;
        renderer.toneMappingExposure = appRenderer.toneMappingExposure;
        renderer.shadowMap.enabled = appRenderer.shadowMap?.enabled === true && !this.isMobile;
        renderer.shadowMap.type = appRenderer.shadowMap?.type ?? THREE.PCFShadowMap;
    }

    bindClickEvents() {
        if (this.clickHandlerBound) return;
        this.clickHandlerBound = true;

        if (window.PointerEvent) {
            document.addEventListener('pointerdown', (ev) => this.onArClick(ev));
        } else {
            document.addEventListener('touchstart', (ev) => {
                const touch = ev.changedTouches?.[0];
                if (touch) this.onArClick(touch);
            });
            document.addEventListener('click', (ev) => this.onArClick(ev));
        }
    }

    onArClick(ev) {
        const mindar = this.mindar;
        if (!mindar) return;

        const { scene, camera, renderer } = mindar;
        const canvas = renderer?.domElement;

        const rect = canvas.getBoundingClientRect();
        const mouse = new THREE.Vector2(
            ((ev.clientX - rect.left) / rect.width) * 2 - 1,
            -((ev.clientY - rect.top) / rect.height) * 2 + 1
        );

        const raycaster = new THREE.Raycaster();
        raycaster.setFromCamera(mouse, camera);

        const hits = raycaster.intersectObjects(scene.children, true);
        for (const hit of hits) {
            let obj = hit.object;
            while (obj) {
                if (obj.onClick && typeof obj.onClick === 'function' && this.objIsActive(obj)) {
                    obj.onClick();
                    return;
                }
                obj = obj.parent;
            }
        }
    }

    objIsActive(obj) {
        if (obj.visible === false) return false;
        let active = true;
        obj.traverseAncestors((ancestor) => {
            if (ancestor.visible === false) active = false;
        });
        return active;
    }

    addMarkerDebugHelpers(root) {
        const planeSize = 0.5;
        const planeGeometry = new THREE.PlaneGeometry(planeSize, planeSize, 1, 1);
        const planeMaterial = new THREE.MeshBasicMaterial({
            color: 0x00ffff,
            transparent: true,
            opacity: 0.25,
            side: THREE.DoubleSide,
            depthWrite: false,
        });

        root.add(new THREE.Mesh(planeGeometry, planeMaterial));
        root.add(new THREE.LineSegments(
            new THREE.EdgesGeometry(planeGeometry),
            new THREE.LineBasicMaterial({ color: 0x00ffff })
        ));
        root.add(new THREE.AxesHelper(0.3));
    }

}

export { MindARController };