/* scene.js — AAA-quality PBR food renderer · NutriBase Georgia */
const FoodScene = (() => {
  'use strict';

  let renderer, scene, camera, animId;
  let foodGroup = null, platformDisc = null, shadowPlane = null, particleSystem = null;
  let rimLight = null;
  let autoRotate = true, autoRotateTimer = null;
  let isDragging = false, prevMouse = { x: 0, y: 0 };
  let targetRotY = 0.5, currentRotY = 0.5;
  let targetRotX = 0.08, currentRotX = 0.08;
  let floatT = 0;

  const lerp  = (a, b, t) => a + (b - a) * t;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

  // ─── Canvas Texture Generators (1024×1024 PBR quality) ──────────────────

  function makeAppleTex() {
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const ctx = c.getContext('2d');

    // Deep radial gradient: bright stem-area → dark red belly
    const g = ctx.createRadialGradient(512, 170, 18, 512, 360, 600);
    g.addColorStop(0.00, '#ead800');
    g.addColorStop(0.04, '#ff6218');
    g.addColorStop(0.18, '#cc2200');
    g.addColorStop(0.55, '#a81200');
    g.addColorStop(1.00, '#720e00');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 1024);

    // Vertical color-band variegation (real apples have subtle stripes)
    for (let i = 0; i < 9; i++) {
      const x = (i / 9) * 1024;
      const light = i % 2 === 0;
      const bG = ctx.createLinearGradient(x - 55, 0, x + 55, 1024);
      bG.addColorStop(0,   `rgba(255,${light ? 110 : 55},0,0.09)`);
      bG.addColorStop(0.5, `rgba(255,${light ? 70  : 30},0,0.04)`);
      bG.addColorStop(1,   `rgba(${light ? 190 : 140},0,0,0.10)`);
      ctx.fillStyle = bG;
      ctx.fillRect(Math.max(0, x - 55), 0, 110, 1024);
    }

    // Fine pore texture (dark)
    for (let i = 0; i < 7000; i++) {
      const x = Math.random() * 1024, y = Math.random() * 1024;
      ctx.beginPath();
      ctx.arc(x, y, 0.5 + Math.random() * 2.2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,0,0,${0.03 + Math.random() * 0.09})`;
      ctx.fill();
    }
    // Fine pore highlights
    for (let i = 0; i < 1500; i++) {
      const x = Math.random() * 1024, y = Math.random() * 1024;
      ctx.beginPath();
      ctx.arc(x, y, 0.7, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,190,165,${0.03 + Math.random() * 0.06})`;
      ctx.fill();
    }

    // Waxy specular highlight swipe (upper-left)
    const wax = ctx.createRadialGradient(260, 195, 15, 260, 195, 280);
    wax.addColorStop(0, 'rgba(255,255,190,0.16)');
    wax.addColorStop(1, 'rgba(255,255,190,0)');
    ctx.fillStyle = wax;
    ctx.fillRect(0, 0, 600, 580);

    return new THREE.CanvasTexture(c);
  }

  function makeBananaTex() {
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const ctx = c.getContext('2d');

    // Longitudinal gradient: dark green tips → golden yellow body
    const g = ctx.createLinearGradient(0, 0, 0, 1024);
    g.addColorStop(0.00, '#183600');
    g.addColorStop(0.07, '#79b200');
    g.addColorStop(0.16, '#f0c400');
    g.addColorStop(0.50, '#ffd600');
    g.addColorStop(0.84, '#f0c400');
    g.addColorStop(0.93, '#79b200');
    g.addColorStop(1.00, '#183600');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 1024);

    // Edge darkening
    const sG = ctx.createLinearGradient(0, 0, 1024, 0);
    sG.addColorStop(0.0,  'rgba(0,0,0,0.18)');
    sG.addColorStop(0.14, 'rgba(0,0,0,0)');
    sG.addColorStop(0.86, 'rgba(0,0,0,0)');
    sG.addColorStop(1.0,  'rgba(0,0,0,0.18)');
    ctx.fillStyle = sG;
    ctx.fillRect(0, 0, 1024, 1024);

    // Five longitudinal ridge lines
    for (let i = 0; i < 5; i++) {
      const x = (i / 5) * 1024 + 100;
      ctx.beginPath();
      for (let y = 0; y <= 1024; y += 4) {
        const wave = Math.sin(y / 95) * 7;
        if (y === 0) ctx.moveTo(x + wave, y);
        else ctx.lineTo(x + wave, y);
      }
      ctx.strokeStyle = 'rgba(80,48,0,0.22)';
      ctx.lineWidth = 2.5;
      ctx.stroke();
    }

    // Organic brown freckle spots with soft halos
    for (let i = 0; i < 200; i++) {
      const x = 44 + Math.random() * 936;
      const y = 90 + Math.random() * 844;
      const r = 1.5 + Math.random() * 8;
      const alpha = 0.28 + Math.random() * 0.55;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(72,36,4,${alpha})`;
      ctx.fill();
      const h = ctx.createRadialGradient(x, y, r * 0.5, x, y, r * 2.8);
      h.addColorStop(0, `rgba(65,32,3,${alpha * 0.32})`);
      h.addColorStop(1, 'rgba(65,32,3,0)');
      ctx.fillStyle = h;
      ctx.beginPath();
      ctx.arc(x, y, r * 2.8, 0, Math.PI * 2);
      ctx.fill();
    }

    // Waxy sheen
    const sheen = ctx.createRadialGradient(280, 185, 8, 280, 330, 420);
    sheen.addColorStop(0, 'rgba(255,255,195,0.13)');
    sheen.addColorStop(1, 'rgba(255,255,195,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, 680, 680);

    return new THREE.CanvasTexture(c);
  }

  function makeChickenTex() {
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const ctx = c.getContext('2d');

    // Base: radial gradient pink-center → tan → browned edge
    const g = ctx.createRadialGradient(512, 420, 25, 512, 512, 580);
    g.addColorStop(0.00, '#f2b8a5');
    g.addColorStop(0.18, '#eecb95');
    g.addColorStop(0.52, '#d8a568');
    g.addColorStop(1.00, '#bb8045');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 1024);

    // Muscle fiber crosshatch — 3 angles for depth
    const fiber = (angle, spacing, alpha, w) => {
      ctx.save();
      ctx.translate(512, 512);
      ctx.rotate(angle);
      ctx.translate(-512, -512);
      ctx.lineWidth = w || 0.8;
      for (let i = -2; i < 1024 / spacing + 4; i++) {
        const y = i * spacing;
        const wave = Math.sin(i * 1.6) * 5;
        ctx.beginPath();
        ctx.moveTo(0,    y + wave);
        ctx.lineTo(1024, y + wave + Math.sin(i * 0.85 + 1.2) * 4);
        ctx.strokeStyle = `rgba(120,60,28,${alpha})`;
        ctx.stroke();
      }
      ctx.restore();
    };
    fiber(0.13,  8,  0.13);
    fiber(-0.09, 11, 0.09);
    fiber(0.26,  15, 0.06);

    // Fat marbling: bright curving streaks
    ctx.lineWidth = 2.5;
    for (let i = 0; i < 22; i++) {
      const sx = 80 + Math.random() * 864;
      const sy = 80 + Math.random() * 864;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.bezierCurveTo(
        sx + (Math.random() - 0.5) * 150, sy + (Math.random() - 0.5) * 90,
        sx + (Math.random() - 0.5) * 130, sy + (Math.random() - 0.5) * 75,
        sx + (Math.random() - 0.5) * 190, sy + (Math.random() - 0.5) * 110
      );
      ctx.strokeStyle = `rgba(255,242,210,${0.14 + Math.random() * 0.22})`;
      ctx.stroke();
    }

    // Surface imperfections
    for (let i = 0; i < 600; i++) {
      const x = Math.random() * 1024, y = Math.random() * 1024;
      ctx.beginPath();
      ctx.arc(x, y, 0.6 + Math.random() * 3.2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(100,48,16,${0.04 + Math.random() * 0.12})`;
      ctx.fill();
    }

    return new THREE.CanvasTexture(c);
  }

  function makeFishTex() {
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const ctx = c.getContext('2d');

    // Silver-grey back → salmon-orange belly
    const g = ctx.createLinearGradient(0, 0, 0, 1024);
    g.addColorStop(0.00, '#90accc');
    g.addColorStop(0.22, '#bab8d5');
    g.addColorStop(0.50, '#ff7d50');
    g.addColorStop(0.78, '#e06848');
    g.addColorStop(1.00, '#b0afc2');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 1024);

    // Overlapping-circle scale pattern
    const sz = 34;
    const rows = Math.ceil(1024 / (sz * 0.62)) + 5;
    const cols = Math.ceil(1024 / sz) + 5;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const ox = (row % 2) * sz * 0.5;
        const x  = (col - 1) * sz + ox;
        const y  = (row - 1) * sz * 0.60;

        ctx.beginPath();
        ctx.arc(x, y + sz * 0.44, sz * 0.54, -Math.PI, 0);
        ctx.strokeStyle = 'rgba(70,95,130,0.42)';
        ctx.lineWidth = 1.0;
        ctx.stroke();

        // Per-scale shimmer highlight
        const sg = ctx.createRadialGradient(x - 4, y + sz * 0.16, 0, x, y + sz * 0.38, sz * 0.50);
        sg.addColorStop(0,   'rgba(255,255,255,0.25)');
        sg.addColorStop(0.6, 'rgba(255,255,255,0.07)');
        sg.addColorStop(1,   'rgba(255,255,255,0)');
        ctx.fillStyle = sg;
        ctx.beginPath();
        ctx.arc(x, y + sz * 0.44, sz * 0.54, -Math.PI, 0);
        ctx.fill();

        ctx.beginPath();
        ctx.arc(x, y + sz * 0.44, sz * 0.54, 0, Math.PI);
        ctx.strokeStyle = 'rgba(30,50,80,0.20)';
        ctx.lineWidth = 0.7;
        ctx.stroke();
      }
    }

    // Lateral line stripe
    ctx.beginPath();
    for (let x2 = 0; x2 <= 1024; x2 += 5) {
      const yL = 375 + Math.sin(x2 / 88) * 13;
      if (x2 === 0) ctx.moveTo(x2, yL); else ctx.lineTo(x2, yL);
    }
    ctx.strokeStyle = 'rgba(44,66,105,0.58)';
    ctx.lineWidth = 2.2;
    ctx.stroke();

    // Iridescent sheen overlay (approximated in canvas — r128 has no native iridescence)
    const irid = ctx.createLinearGradient(0, 180, 1024, 580);
    irid.addColorStop(0,    'rgba(165,215,255,0.10)');
    irid.addColorStop(0.33, 'rgba(255,195,215,0.07)');
    irid.addColorStop(0.66, 'rgba(195,255,195,0.06)');
    irid.addColorStop(1,    'rgba(165,215,255,0.10)');
    ctx.fillStyle = irid;
    ctx.fillRect(0, 0, 1024, 1024);

    return new THREE.CanvasTexture(c);
  }

  function makeAlmondTex() {
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const ctx = c.getContext('2d');

    // Warm golden-brown base
    const g = ctx.createLinearGradient(0, 0, 1024, 1024);
    g.addColorStop(0.0, '#c09030');
    g.addColorStop(0.4, '#8b6914');
    g.addColorStop(1.0, '#543c0c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 1024);

    // Characteristic longitudinal grain/ridge lines
    for (let i = 0; i < 24; i++) {
      const xBase = (i / 24) * 1024;
      ctx.beginPath();
      ctx.moveTo(xBase, 0);
      for (let y = 0; y <= 1024; y += 6) {
        const wave = Math.sin(y / 68 + i * 1.9) * 10 + Math.cos(y / 138 + i) * 4;
        ctx.lineTo(xBase + wave, y);
      }
      const isDark = i % 3 === 0;
      ctx.strokeStyle = isDark
        ? `rgba(34,16,2,${0.30 + Math.random() * 0.22})`
        : `rgba(168,122,32,${0.13 + Math.random() * 0.15})`;
      ctx.lineWidth = isDark ? 2.0 : 1.0;
      ctx.stroke();
    }

    // Lighter valley highlights between ridges
    for (let i = 0; i < 11; i++) {
      const xBase = (i / 11) * 1024 + 46;
      const vG = ctx.createLinearGradient(xBase - 22, 0, xBase + 22, 0);
      vG.addColorStop(0,   'rgba(205,162,76,0)');
      vG.addColorStop(0.5, 'rgba(205,162,76,0.13)');
      vG.addColorStop(1,   'rgba(205,162,76,0)');
      ctx.fillStyle = vG;
      ctx.fillRect(xBase - 22, 0, 44, 1024);
    }

    // Fine surface noise
    for (let i = 0; i < 3500; i++) {
      const x = Math.random() * 1024, y = Math.random() * 1024;
      const dark = Math.random() > 0.5;
      ctx.beginPath();
      ctx.arc(x, y, 0.5 + Math.random() * 2.2, 0, Math.PI * 2);
      ctx.fillStyle = dark
        ? `rgba(24,10,2,${0.05 + Math.random() * 0.15})`
        : `rgba(195,150,50,${0.04 + Math.random() * 0.11})`;
      ctx.fill();
    }

    // Pale cream tip
    const tipG = ctx.createRadialGradient(512, 48, 0, 512, 48, 210);
    tipG.addColorStop(0, 'rgba(242,218,135,0.38)');
    tipG.addColorStop(1, 'rgba(242,218,135,0)');
    ctx.fillStyle = tipG;
    ctx.fillRect(0, 0, 1024, 260);

    return new THREE.CanvasTexture(c);
  }

  function makeEggTex() {
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const ctx = c.getContext('2d');

    // Warm cream/off-white base with subtle radial highlight
    const g = ctx.createRadialGradient(512, 280, 20, 512, 480, 620);
    g.addColorStop(0,   '#fefefc');
    g.addColorStop(0.4, '#f5f0e8');
    g.addColorStop(1,   '#e5ddd0');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 1024);

    // Micro-pore speckle (real eggshells have thousands of tiny pores)
    for (let i = 0; i < 2800; i++) {
      const x = Math.random() * 1024, y = Math.random() * 1024;
      ctx.beginPath();
      ctx.arc(x, y, 0.6 + Math.random() * 2.2, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(155,120,85,${0.03 + Math.random() * 0.09})`;
      ctx.fill();
    }

    // Subtle warm shadow on lower half
    const shadow = ctx.createLinearGradient(0, 380, 0, 1024);
    shadow.addColorStop(0, 'rgba(190,165,130,0)');
    shadow.addColorStop(1, 'rgba(190,165,130,0.14)');
    ctx.fillStyle = shadow;
    ctx.fillRect(0, 380, 1024, 644);

    // Soft specular highlight (upper-left)
    const spec = ctx.createRadialGradient(340, 240, 5, 340, 240, 260);
    spec.addColorStop(0, 'rgba(255,255,255,0.55)');
    spec.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = spec;
    ctx.fillRect(0, 0, 700, 600);

    return new THREE.CanvasTexture(c);
  }

  function makeSweetPotatoTex() {
    const c = document.createElement('canvas');
    c.width = c.height = 1024;
    const ctx = c.getContext('2d');

    // Longitudinal gradient: dark ends → bright orange center
    const g = ctx.createLinearGradient(0, 0, 0, 1024);
    g.addColorStop(0.00, '#6e2800');
    g.addColorStop(0.12, '#c04400');
    g.addColorStop(0.35, '#e85e1a');
    g.addColorStop(0.50, '#ff7028');
    g.addColorStop(0.65, '#e85e1a');
    g.addColorStop(0.88, '#c04400');
    g.addColorStop(1.00, '#6e2800');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 1024, 1024);

    // Slight edge darkening
    const edgeG = ctx.createLinearGradient(0, 0, 1024, 0);
    edgeG.addColorStop(0.0,  'rgba(0,0,0,0.16)');
    edgeG.addColorStop(0.12, 'rgba(0,0,0,0)');
    edgeG.addColorStop(0.88, 'rgba(0,0,0,0)');
    edgeG.addColorStop(1.0,  'rgba(0,0,0,0.16)');
    ctx.fillStyle = edgeG;
    ctx.fillRect(0, 0, 1024, 1024);

    // Longitudinal wrinkle lines (characteristic sweet potato surface)
    for (let i = 0; i < 16; i++) {
      const xBase = (i / 16) * 1024;
      ctx.beginPath();
      ctx.moveTo(xBase, 0);
      for (let y = 0; y <= 1024; y += 7) {
        const wave = Math.sin(y / 78 + i * 2.4) * 13 + Math.cos(y / 152 + i * 0.7) * 5;
        ctx.lineTo(xBase + wave, y);
      }
      const isDark = i % 3 === 0;
      ctx.strokeStyle = isDark
        ? `rgba(55,14,0,${0.32 + Math.random() * 0.18})`
        : `rgba(255,125,40,${0.14 + Math.random() * 0.13})`;
      ctx.lineWidth = isDark ? 2.2 : 1.0;
      ctx.stroke();
    }

    // Surface bumps and imperfections
    for (let i = 0; i < 4500; i++) {
      const x = Math.random() * 1024, y = Math.random() * 1024;
      const dark = Math.random() > 0.38;
      ctx.beginPath();
      ctx.arc(x, y, 0.5 + Math.random() * 3.5, 0, Math.PI * 2);
      ctx.fillStyle = dark
        ? `rgba(75,22,0,${0.04 + Math.random() * 0.13})`
        : `rgba(255,145,48,${0.03 + Math.random() * 0.09})`;
      ctx.fill();
    }

    // Subtle waxy sheen
    const sheen = ctx.createRadialGradient(310, 220, 10, 310, 340, 360);
    sheen.addColorStop(0, 'rgba(255,200,100,0.14)');
    sheen.addColorStop(1, 'rgba(255,200,100,0)');
    ctx.fillStyle = sheen;
    ctx.fillRect(0, 0, 700, 680);

    return new THREE.CanvasTexture(c);
  }

  // ─── Food Model Builders ─────────────────────────────────────────────────

  function buildApple() {
    const g = new THREE.Group();
    const tex = makeAppleTex();

    // 96-segment lathe for silky-smooth silhouette
    const pts = [
      new THREE.Vector2(0.000, -1.050),
      new THREE.Vector2(0.175, -1.022),
      new THREE.Vector2(0.415, -0.965),
      new THREE.Vector2(0.675, -0.822),
      new THREE.Vector2(0.895, -0.580),
      new THREE.Vector2(1.018, -0.280),
      new THREE.Vector2(1.058,  0.040),
      new THREE.Vector2(1.032,  0.360),
      new THREE.Vector2(0.942,  0.625),
      new THREE.Vector2(0.798,  0.802),
      new THREE.Vector2(0.598,  0.925),
      new THREE.Vector2(0.355,  0.982),
      new THREE.Vector2(0.158,  1.018),
      new THREE.Vector2(0.040,  1.040),
      new THREE.Vector2(0.000,  1.040),
    ];
    const body = new THREE.Mesh(new THREE.LatheGeometry(pts, 96),
      new THREE.MeshPhysicalMaterial({
        map: tex,
        roughness: 0.20,
        metalness: 0.00,
        clearcoat: 1.00,
        clearcoatRoughness: 0.06,
        envMapIntensity: 0.90,
      })
    );
    body.castShadow = body.receiveShadow = true;
    g.add(body);

    const dimpleMat = new THREE.MeshPhysicalMaterial({
      color: 0x7a0c00, roughness: 0.62, metalness: 0, clearcoat: 0.14,
    });
    const dimple = new THREE.Mesh(new THREE.SphereGeometry(0.28, 28, 28), dimpleMat);
    dimple.position.y = 0.99;
    dimple.scale.set(1, 0.35, 1);
    g.add(dimple);

    const navel = new THREE.Mesh(new THREE.SphereGeometry(0.20, 20, 20), dimpleMat);
    navel.position.y = -1.04;
    navel.scale.set(1, 0.28, 1);
    g.add(navel);

    // Organic curved stem
    const stemCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.000,  1.032, 0.000),
      new THREE.Vector3(0.038,  1.175, 0.010),
      new THREE.Vector3(0.088,  1.345,-0.008),
      new THREE.Vector3(0.108,  1.555, 0.000),
    ]);
    g.add(new THREE.Mesh(
      new THREE.TubeGeometry(stemCurve, 14, 0.026, 9, false),
      new THREE.MeshStandardMaterial({ color: 0x2a1606, roughness: 0.95, metalness: 0 })
    ));

    // Leaf with midrib vein
    const leafShape = new THREE.Shape();
    leafShape.moveTo(0, 0);
    leafShape.bezierCurveTo(0.07, 0.19, 0.23, 0.29, 0.42, 0.17);
    leafShape.bezierCurveTo(0.48, 0.04, 0.34,-0.07, 0.13, 0.00);
    leafShape.bezierCurveTo(0.05,-0.04, 0,-0.02, 0, 0);
    const leaf = new THREE.Mesh(
      new THREE.ShapeGeometry(leafShape, 10),
      new THREE.MeshStandardMaterial({
        color: 0x1a6e28, roughness: 0.68, metalness: 0,
        side: THREE.DoubleSide, transparent: true, opacity: 0.92,
      })
    );
    leaf.position.set(0.086, 1.496, 0.038);
    leaf.rotation.set(0.10, 0.30, -0.40);
    g.add(leaf);

    const vein = new THREE.Mesh(
      new THREE.TubeGeometry(
        new THREE.LineCurve3(new THREE.Vector3(0, 0, 0.002), new THREE.Vector3(0.38, 0.12, 0.002)),
        4, 0.005, 4, false
      ),
      new THREE.MeshStandardMaterial({ color: 0x145a1e, roughness: 0.8 })
    );
    vein.position.set(0.086, 1.496, 0.038);
    vein.rotation.set(0.10, 0.30, -0.40);
    g.add(vein);

    return g;
  }

  function buildBanana() {
    const g = new THREE.Group();
    const tex = makeBananaTex();

    // Pronounced banana arc spine
    const spine = new THREE.CatmullRomCurve3([
      new THREE.Vector3( 0.00, -1.52,  0.00),
      new THREE.Vector3(-0.05, -0.92,  0.00),
      new THREE.Vector3(-0.22,  0.00,  0.04),
      new THREE.Vector3(-0.44,  0.80,  0.00),
      new THREE.Vector3(-0.52,  1.30, -0.04),
      new THREE.Vector3(-0.36,  1.58,  0.00),
    ]);

    // 6-sided cross-section, tapered ends
    const T_SEGS = 64, R_SEGS = 6;
    const frames = spine.computeFrenetFrames(T_SEGS, false);
    const verts = [], norms = [], uvArr = [], idxArr = [];

    for (let i = 0; i <= T_SEGS; i++) {
      const t   = i / T_SEGS;
      const pos = spine.getPointAt(t);
      const nr  = frames.normals[Math.min(i, frames.normals.length - 1)];
      const bn  = frames.binormals[Math.min(i, frames.binormals.length - 1)];
      const r   = 0.088 + Math.sin(t * Math.PI) * 0.238;
      const asp = 0.76;

      for (let j = 0; j <= R_SEGS; j++) {
        const a = (j / R_SEGS) * Math.PI * 2;
        const rx = Math.cos(a) * r;
        const ry = Math.sin(a) * r * asp;
        verts.push(pos.x + rx*nr.x + ry*bn.x, pos.y + rx*nr.y + ry*bn.y, pos.z + rx*nr.z + ry*bn.z);
        norms.push(rx*nr.x + ry*bn.x, rx*nr.y + ry*bn.y, rx*nr.z + ry*bn.z);
        uvArr.push(j / R_SEGS, t);
      }
    }
    for (let i = 0; i < T_SEGS; i++) {
      for (let j = 0; j < R_SEGS; j++) {
        const a = (R_SEGS+1)*i+j, b = (R_SEGS+1)*(i+1)+j,
              c2 = (R_SEGS+1)*(i+1)+j+1, d = (R_SEGS+1)*i+j+1;
        idxArr.push(a, b, d, b, c2, d);
      }
    }
    const bGeo = new THREE.BufferGeometry();
    bGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(verts), 3));
    bGeo.setAttribute('normal',   new THREE.BufferAttribute(new Float32Array(norms), 3));
    bGeo.setAttribute('uv',       new THREE.BufferAttribute(new Float32Array(uvArr), 2));
    bGeo.setIndex(idxArr);
    bGeo.computeVertexNormals();

    const body = new THREE.Mesh(bGeo, new THREE.MeshPhysicalMaterial({
      map: tex, roughness: 0.58, metalness: 0, clearcoat: 0.18, clearcoatRoughness: 0.32,
    }));
    body.castShadow = body.receiveShadow = true;
    g.add(body);

    const tipMat = new THREE.MeshStandardMaterial({ color: 0x281000, roughness: 0.94, metalness: 0 });
    const t1 = new THREE.Mesh(new THREE.SphereGeometry(0.090, 12, 12), tipMat);
    t1.position.copy(spine.getPointAt(0));
    t1.scale.set(0.72, 1.75, 0.72);
    g.add(t1);
    const t2 = new THREE.Mesh(new THREE.SphereGeometry(0.065, 12, 12), tipMat);
    t2.position.copy(spine.getPointAt(1));
    t2.scale.set(0.65, 1.65, 0.65);
    g.add(t2);

    return g;
  }

  function buildChicken() {
    const g = new THREE.Group();
    const tex = makeChickenTex();

    const meatMat = new THREE.MeshStandardMaterial({
      map: tex, color: 0xe8c49a, roughness: 0.90, metalness: 0,
    });

    // Main breast lobe
    const main = new THREE.Mesh(new THREE.SphereGeometry(1, 64, 48), meatMat);
    main.scale.set(1.32, 0.52, 0.96);
    main.castShadow = main.receiveShadow = true;
    g.add(main);

    // Second lobe (split by keel ridge)
    const lobe2 = new THREE.Mesh(new THREE.SphereGeometry(0.74, 40, 32),
      new THREE.MeshStandardMaterial({ map: tex, color: 0xdcb078, roughness: 0.92, metalness: 0 })
    );
    lobe2.scale.set(0.88, 0.46, 0.84);
    lobe2.position.set(0.54, 0.05, 0.32);
    lobe2.castShadow = true;
    g.add(lobe2);

    // Tapered tenderloin end
    const thin = new THREE.Mesh(new THREE.SphereGeometry(0.56, 30, 22), meatMat);
    thin.scale.set(0.80, 0.35, 0.60);
    thin.position.set(-1.06, -0.02, 0.07);
    g.add(thin);

    // Visible fat patches with clearcoat gloss
    const fatMat = new THREE.MeshPhysicalMaterial({
      color: 0xfffce0, roughness: 0.48, metalness: 0,
      clearcoat: 0.42, clearcoatRoughness: 0.36, transparent: true, opacity: 0.54,
    });
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 1.9 - 0.54;
      const fat = new THREE.Mesh(new THREE.SphereGeometry(0.08 + i * 0.04, 8, 8), fatMat);
      fat.position.set(Math.cos(a) * 0.70, (Math.random() - 0.5) * 0.20, Math.sin(a) * 0.43 + 0.35);
      fat.scale.set(1.72, 0.26, 1.42);
      g.add(fat);
    }

    // Glossy ivory bone
    const boneMat = new THREE.MeshPhysicalMaterial({
      color: 0xf5f0e8, roughness: 0.44, metalness: 0, clearcoat: 0.36, clearcoatRoughness: 0.18,
    });
    const boneCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-1.08, 0.06,  0.00),
      new THREE.Vector3(-1.46, 0.12,  0.04),
      new THREE.Vector3(-1.90, 0.09,  0.00),
      new THREE.Vector3(-2.14, 0.04,  0.00),
    ]);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(boneCurve, 16, 0.056, 10, false), boneMat));
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.158, 16, 16), boneMat);
    knob.position.set(-2.20, 0.04, 0);
    g.add(knob);

    return g;
  }

  function buildFish() {
    const g = new THREE.Group();
    const tex = makeFishTex();

    const bodyMat = new THREE.MeshPhysicalMaterial({
      map: tex, roughness: 0.24, metalness: 0.06,
      clearcoat: 0.62, clearcoatRoughness: 0.14, envMapIntensity: 0.88,
    });

    // Fish body via lathe, rotated sideways
    const bodyPts = [
      new THREE.Vector2(0.00, -1.46),
      new THREE.Vector2(0.14, -1.28),
      new THREE.Vector2(0.28, -1.00),
      new THREE.Vector2(0.40, -0.66),
      new THREE.Vector2(0.50, -0.22),
      new THREE.Vector2(0.56,  0.18),
      new THREE.Vector2(0.54,  0.54),
      new THREE.Vector2(0.46,  0.84),
      new THREE.Vector2(0.34,  1.10),
      new THREE.Vector2(0.20,  1.30),
      new THREE.Vector2(0.08,  1.40),
      new THREE.Vector2(0.00,  1.46),
    ];
    const body = new THREE.Mesh(new THREE.LatheGeometry(bodyPts, 72), bodyMat);
    body.rotation.z = -Math.PI / 2;
    body.scale.set(1.0, 0.86, 0.42);
    body.castShadow = body.receiveShadow = true;
    g.add(body);

    const finMat = new THREE.MeshStandardMaterial({
      color: 0xb45835, roughness: 0.56, metalness: 0,
      side: THREE.DoubleSide, transparent: true, opacity: 0.80,
    });

    // Forked tail fin
    const tailShape = new THREE.Shape();
    tailShape.moveTo(0, 0);
    tailShape.bezierCurveTo(-0.09, 0.11,-0.34, 0.42,-0.58, 0.58);
    tailShape.bezierCurveTo(-0.52, 0.32,-0.46, 0.14,-0.32, 0.04);
    tailShape.bezierCurveTo(-0.30, 0.01,-0.28,-0.01,-0.32,-0.04);
    tailShape.bezierCurveTo(-0.46,-0.14,-0.52,-0.32,-0.58,-0.58);
    tailShape.bezierCurveTo(-0.34,-0.42,-0.09,-0.11, 0, 0);
    const tail = new THREE.Mesh(new THREE.ShapeGeometry(tailShape, 10), finMat);
    tail.position.set(-1.46, 0, 0);
    tail.rotation.y = Math.PI / 2;
    g.add(tail);

    // Dorsal fin
    const dorsalShape = new THREE.Shape();
    dorsalShape.moveTo(0, 0);
    dorsalShape.bezierCurveTo(0.18, 0.17, 0.38, 0.40, 0.58, 0.46);
    dorsalShape.bezierCurveTo(0.72, 0.42, 0.88, 0.16, 1.02, 0);
    const dorsal = new THREE.Mesh(new THREE.ShapeGeometry(dorsalShape, 8), finMat);
    dorsal.position.set(-0.86, 0.44, 0);
    dorsal.rotation.y = Math.PI / 2;
    g.add(dorsal);

    // Pectoral fin
    const pectShape = new THREE.Shape();
    pectShape.moveTo(0, 0);
    pectShape.bezierCurveTo(0.06,-0.09, 0.24,-0.15, 0.36,-0.06);
    pectShape.bezierCurveTo(0.30, 0.06, 0.08, 0.07, 0, 0);
    const pect = new THREE.Mesh(new THREE.ShapeGeometry(pectShape, 6), finMat);
    pect.position.set(0.14, -0.08, 0.22);
    pect.rotation.set(0.35,-0.25, 0.46);
    g.add(pect);

    // Eye: sclera + iris + pupil + wet cornea layer
    const sclera = new THREE.Mesh(new THREE.SphereGeometry(0.082, 20, 20),
      new THREE.MeshPhysicalMaterial({
        color: 0xfafafa, roughness: 0.03, metalness: 0, clearcoat: 1.0, clearcoatRoughness: 0.02,
      })
    );
    sclera.position.set(1.16, 0.19, 0.22);
    g.add(sclera);

    const iris = new THREE.Mesh(new THREE.SphereGeometry(0.053, 14, 14),
      new THREE.MeshStandardMaterial({ color: 0x190e06, roughness: 0.10, metalness: 0 })
    );
    iris.position.set(1.19, 0.19, 0.245);
    g.add(iris);

    const pupil = new THREE.Mesh(new THREE.SphereGeometry(0.032, 10, 10),
      new THREE.MeshStandardMaterial({ color: 0x010101, roughness: 0 })
    );
    pupil.position.set(1.20, 0.19, 0.258);
    g.add(pupil);

    const cornea = new THREE.Mesh(new THREE.SphereGeometry(0.084, 20, 20),
      new THREE.MeshPhysicalMaterial({
        color: 0xffffff, roughness: 0, metalness: 0,
        clearcoat: 1.0, clearcoatRoughness: 0, transparent: true, opacity: 0.14,
      })
    );
    cornea.position.set(1.16, 0.19, 0.22);
    g.add(cornea);

    return g;
  }

  function buildAlmond() {
    const g = new THREE.Group();
    const tex = makeAlmondTex();

    const pts = [
      new THREE.Vector2(0.00, -1.16),
      new THREE.Vector2(0.07, -1.11),
      new THREE.Vector2(0.20, -0.94),
      new THREE.Vector2(0.34, -0.72),
      new THREE.Vector2(0.47, -0.43),
      new THREE.Vector2(0.53, -0.10),
      new THREE.Vector2(0.55,  0.16),
      new THREE.Vector2(0.51,  0.43),
      new THREE.Vector2(0.41,  0.67),
      new THREE.Vector2(0.27,  0.89),
      new THREE.Vector2(0.12,  1.07),
      new THREE.Vector2(0.00,  1.16),
    ];
    const body = new THREE.Mesh(new THREE.LatheGeometry(pts, 56),
      new THREE.MeshStandardMaterial({ map: tex, color: 0xa07828, roughness: 0.82, metalness: 0 })
    );
    body.scale.set(1, 1, 0.74);
    body.castShadow = body.receiveShadow = true;
    g.add(body);

    // Surface ridge grooves via torus arcs
    const ridgeMat = new THREE.MeshStandardMaterial({ color: 0x462a06, roughness: 0.96, metalness: 0 });
    for (let i = 0; i < 8; i++) {
      const ridge = new THREE.Mesh(new THREE.TorusGeometry(0.30, 0.0095, 4, 42, Math.PI), ridgeMat);
      ridge.rotation.y = (i / 8) * Math.PI;
      ridge.scale.set(1, 1.44, 0.74);
      g.add(ridge);
    }

    // Pale cream tip
    const tip = new THREE.Mesh(new THREE.SphereGeometry(0.14, 14, 14),
      new THREE.MeshStandardMaterial({ color: 0xf0dd7c, roughness: 0.56, metalness: 0 })
    );
    tip.position.y = 1.11;
    tip.scale.set(0.50, 0.42, 0.40);
    g.add(tip);

    g.rotation.z = 0.28;
    return g;
  }

  function buildEgg() {
    const g = new THREE.Group();
    const eggTex = makeEggTex();

    const shellMat = new THREE.MeshPhysicalMaterial({
      map: eggTex,
      color: 0xf5f0e8,
      roughness: 0.30,
      metalness: 0.10,
      clearcoat: 0.45,
      clearcoatRoughness: 0.10,
    });

    // Yolk: warm deep orange sphere, visible through shell
    const yolkMat = new THREE.MeshStandardMaterial({
      color: 0xff9a00,
      emissive: 0xe06000,
      emissiveIntensity: 0.28,
      roughness: 0.55,
      metalness: 0,
    });

    // Egg 1 — main foreground egg, tilted left
    const yolk1 = new THREE.Mesh(new THREE.SphereGeometry(0.28, 18, 18), yolkMat);
    yolk1.position.set(-0.45, -0.06, 0);
    g.add(yolk1);

    const shell1 = new THREE.Mesh(new THREE.SphereGeometry(0.60, 36, 36),
      new THREE.MeshPhysicalMaterial({
        ...shellMat,
        transparent: true,
        opacity: 0.88,
      })
    );
    shell1.scale.set(1, 1.32, 1);
    shell1.position.set(-0.45, 0, 0);
    shell1.rotation.z = -0.16;
    shell1.castShadow = true;
    g.add(shell1);

    // Egg 2 — slightly behind and right
    const yolk2 = new THREE.Mesh(new THREE.SphereGeometry(0.26, 16, 16), yolkMat);
    yolk2.position.set(0.44, -0.10, -0.22);
    g.add(yolk2);

    const shell2 = new THREE.Mesh(new THREE.SphereGeometry(0.56, 32, 32),
      new THREE.MeshPhysicalMaterial({
        ...shellMat,
        transparent: true,
        opacity: 0.85,
      })
    );
    shell2.scale.set(1, 1.30, 1);
    shell2.position.set(0.44, -0.06, -0.22);
    shell2.rotation.z = 0.20;
    shell2.castShadow = true;
    g.add(shell2);

    // Nest materials
    const nestDark = new THREE.MeshStandardMaterial({ color: 0x3e2208, roughness: 0.99, metalness: 0 });
    const nestMid  = new THREE.MeshStandardMaterial({ color: 0x5c3412, roughness: 0.99, metalness: 0 });

    // Nest bowl ring
    const bowl = new THREE.Mesh(
      new THREE.TorusGeometry(0.92, 0.26, 10, 42),
      nestDark
    );
    bowl.rotation.x = Math.PI / 2;
    bowl.position.y = -0.80;
    bowl.scale.set(1, 1, 0.52);
    bowl.receiveShadow = true;
    g.add(bowl);

    // Flat nest base disc
    g.add(new THREE.Mesh(
      new THREE.CylinderGeometry(0.76, 0.62, 0.18, 32),
      nestDark
    )).position.y = -0.96;

    // Woven twig layers — radial and cross-hatched sticks
    for (let i = 0; i < 14; i++) {
      const angle  = (i / 14) * Math.PI;
      const mat    = i % 3 === 0 ? nestMid : nestDark;
      const radius = 0.60 + Math.random() * 0.28;
      const twig   = new THREE.Mesh(new THREE.CylinderGeometry(0.011, 0.011, radius * 2, 5), mat);
      twig.rotation.z = Math.PI / 2;
      twig.rotation.y = angle;
      twig.position.y = -0.72 + (Math.random() - 0.5) * 0.16;
      g.add(twig);
    }
    // A few crossing sticks at different angles for texture depth
    for (let i = 0; i < 8; i++) {
      const angle = (i / 8) * Math.PI + 0.2;
      const twig  = new THREE.Mesh(new THREE.CylinderGeometry(0.009, 0.009, 1.5, 5), nestMid);
      twig.rotation.z = Math.PI / 2;
      twig.rotation.y = angle;
      twig.position.set(0, -0.62 + i * 0.04, 0);
      g.add(twig);
    }

    return g;
  }

  function buildSweetPotato() {
    const g = new THREE.Group();
    const tex = makeSweetPotatoTex();

    // Elongated asymmetric lathe profile (wider in the lower-middle, tapered ends)
    const pts = [
      new THREE.Vector2(0.00, -1.32),
      new THREE.Vector2(0.08, -1.25),
      new THREE.Vector2(0.22, -1.06),
      new THREE.Vector2(0.40, -0.78),
      new THREE.Vector2(0.56, -0.44),
      new THREE.Vector2(0.66, -0.06),
      new THREE.Vector2(0.70,  0.24),
      new THREE.Vector2(0.65,  0.54),
      new THREE.Vector2(0.52,  0.82),
      new THREE.Vector2(0.35,  1.05),
      new THREE.Vector2(0.16,  1.24),
      new THREE.Vector2(0.00,  1.32),
    ];
    const body = new THREE.Mesh(new THREE.LatheGeometry(pts, 64),
      new THREE.MeshStandardMaterial({
        map: tex,
        roughness: 0.72,
        metalness: 0,
      })
    );
    body.scale.set(1, 1, 0.80);
    body.castShadow = body.receiveShadow = true;
    g.add(body);

    // Small surface bump protrusions (characteristic sweet potato lumps)
    const bumpMat = new THREE.MeshStandardMaterial({ color: 0xc05018, roughness: 0.80, metalness: 0 });
    const bumpPositions = [
      [ 0.60, 0.10, 0.15], [-0.58, -0.20, 0.18], [ 0.52, -0.50, -0.16],
      [-0.48,  0.40,-0.20], [ 0.44,  0.58, 0.12], [-0.40, -0.65,-0.12],
    ];
    bumpPositions.forEach(([x, y, z]) => {
      const bump = new THREE.Mesh(new THREE.SphereGeometry(0.065, 8, 8), bumpMat);
      bump.position.set(x, y, z * 0.8);
      bump.scale.set(1, 0.55, 0.85);
      g.add(bump);
    });

    // Dried brown stem at the top end
    const stemCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.00,  1.30, 0.00),
      new THREE.Vector3(0.02,  1.48, 0.01),
      new THREE.Vector3(0.05,  1.65,-0.01),
      new THREE.Vector3(0.04,  1.80, 0.01),
    ]);
    g.add(new THREE.Mesh(
      new THREE.TubeGeometry(stemCurve, 10, 0.028, 7, false),
      new THREE.MeshStandardMaterial({ color: 0x361606, roughness: 0.97, metalness: 0 })
    ));

    // Short root tendrils at the bottom
    const rootMat = new THREE.MeshStandardMaterial({ color: 0x5c2606, roughness: 0.98, metalness: 0 });
    [[0, -1.32, 0], [0.05, -1.30, 0.04], [-0.04, -1.30,-0.04]].forEach(([x, y, z], i) => {
      const root = new THREE.Mesh(new THREE.SphereGeometry(0.048, 6, 6), rootMat);
      root.position.set(x, y, z);
      root.scale.set(0.6, 2.0 + i * 0.3, 0.6);
      g.add(root);
    });

    g.rotation.z = 0.16;
    return g;
  }

  // ─── Scene Setup ─────────────────────────────────────────────────────────

  function makeSceneBackground() {
    const c = document.createElement('canvas');
    c.width = 4; c.height = 512;
    const ctx = c.getContext('2d');
    const grd = ctx.createLinearGradient(0, 0, 0, 512);
    grd.addColorStop(0,   '#08091a');
    grd.addColorStop(0.5, '#0d1225');
    grd.addColorStop(1,   '#181d38');
    ctx.fillStyle = grd;
    ctx.fillRect(0, 0, 4, 512);
    return new THREE.CanvasTexture(c);
  }

  function setupLights() {
    scene.add(new THREE.AmbientLight(0x404040, 0.50));
    scene.add(new THREE.HemisphereLight(0x8ab2cc, 0x6b4422, 0.36));

    // Key: warm white, upper-right front, casts shadows
    const key = new THREE.DirectionalLight(0xfff5e0, 2.0);
    key.position.set(4.2, 6.2, 4.2);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near   = 0.5;
    key.shadow.camera.far    = 32;
    key.shadow.camera.left   = -5;
    key.shadow.camera.right  =  5;
    key.shadow.camera.top    =  5;
    key.shadow.camera.bottom = -5;
    key.shadow.radius = 10;
    key.shadow.bias   = -0.001;
    scene.add(key);

    // Fill: cool blue from left
    const fill = new THREE.DirectionalLight(0xe0f0ff, 0.80);
    fill.position.set(-5, 1.8, 2);
    scene.add(fill);

    // Rim: bright white from behind for silhouette pop
    rimLight = new THREE.DirectionalLight(0xffffff, 1.50);
    rimLight.position.set(0, 4, -6);
    scene.add(rimLight);

    // Subtle warm under-fill
    const under = new THREE.DirectionalLight(0xffe0c0, 0.24);
    under.position.set(0, -4, 2);
    scene.add(under);
  }

  // ─── Platform + Particles ─────────────────────────────────────────────────

  function addPlatform() {
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(16, 16),
      new THREE.ShadowMaterial({ opacity: 0.48 })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = -1.92;
    plane.receiveShadow = true;
    scene.add(plane);
    shadowPlane = plane;

    platformDisc = new THREE.Mesh(
      new THREE.CylinderGeometry(1.26, 1.26, 0.012, 90),
      new THREE.MeshStandardMaterial({
        color: 0x22c55e, emissive: 0x22c55e, emissiveIntensity: 1.0,
        roughness: 0.04, metalness: 0.55, transparent: true, opacity: 0.30,
      })
    );
    platformDisc.position.y = -1.91;
    platformDisc.receiveShadow = true;
    scene.add(platformDisc);

    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(1.52, 0.013, 6, 92),
      new THREE.MeshStandardMaterial({
        color: 0xf59e0b, emissive: 0xf59e0b, emissiveIntensity: 0.72,
        transparent: true, opacity: 0.52,
      })
    );
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -1.90;
    scene.add(ring);
  }

  function addParticles(colorHex) {
    const count = 220;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r     = 3.5 + Math.random() * 2.5;
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      pos[i*3]   = r * Math.sin(phi) * Math.cos(theta);
      pos[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i*3+2] = r * Math.cos(phi);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    particleSystem = new THREE.Points(geo, new THREE.PointsMaterial({
      color: colorHex, size: 0.022,
      transparent: true, opacity: 0.55, sizeAttenuation: true,
    }));
    scene.add(particleSystem);
  }

  // ─── Event Handling ───────────────────────────────────────────────────────

  function setupEvents(canvas) {
    const onStart = (x, y) => {
      isDragging = true;
      clearTimeout(autoRotateTimer);
      autoRotate = false;
      prevMouse = { x, y };
    };
    const onMove = (x, y) => {
      if (!isDragging) return;
      targetRotY += (x - prevMouse.x) * 0.007;
      targetRotX  = clamp(targetRotX + (y - prevMouse.y) * 0.007, -1.0, 1.0);
      prevMouse = { x, y };
    };
    const onEnd = () => {
      isDragging = false;
      autoRotateTimer = setTimeout(() => { autoRotate = true; }, 3000);
    };

    canvas.addEventListener('mousedown',  e => onStart(e.clientX, e.clientY));
    canvas.addEventListener('mousemove',  e => onMove(e.clientX, e.clientY));
    canvas.addEventListener('mouseup',    onEnd);
    canvas.addEventListener('mouseleave', onEnd);
    canvas.addEventListener('touchstart', e => onStart(e.touches[0].clientX, e.touches[0].clientY), { passive: true });
    canvas.addEventListener('touchmove',  e => {
      onMove(e.touches[0].clientX, e.touches[0].clientY);
      e.preventDefault();
    }, { passive: false });
    canvas.addEventListener('touchend', onEnd);
    canvas.addEventListener('wheel', e => {
      camera.position.z = clamp(camera.position.z + e.deltaY * 0.005, 2.5, 8.0);
      e.preventDefault();
    }, { passive: false });
    window.addEventListener('resize', () => {
      const s = canvas.parentElement ? canvas.parentElement.clientWidth : 400;
      renderer.setSize(s, s);
      camera.updateProjectionMatrix();
    });
  }

  // ─── Scene Management ─────────────────────────────────────────────────────

  function disposeObject(obj) {
    if (!obj) return;
    obj.traverse(child => {
      if (!child.isMesh && !child.isPoints) return;
      child.geometry.dispose();
      const mats = Array.isArray(child.material) ? child.material : [child.material];
      mats.forEach(m => {
        Object.values(m).forEach(v => { if (v && v.isTexture) v.dispose(); });
        m.dispose();
      });
    });
    scene.remove(obj);
  }

  function clearScene() {
    disposeObject(foodGroup);
    disposeObject(particleSystem);
    if (shadowPlane)  { scene.remove(shadowPlane);  shadowPlane  = null; }
    if (platformDisc) { scene.remove(platformDisc); platformDisc = null; }
    scene.children
      .filter(c => c.isMesh && c.geometry && c.geometry.type === 'TorusGeometry')
      .forEach(c => scene.remove(c));
    foodGroup = particleSystem = null;
  }

  const BUILDERS = {
    apple: buildApple, banana: buildBanana,
    chicken: buildChicken, fish: buildFish, almond: buildAlmond,
    egg: buildEgg, sweetpotato: buildSweetPotato,
  };
  const PARTICLE_COLORS = {
    apple: 0xff4422, banana: 0xf5c600,
    chicken: 0xf0c080, fish: 0x60a5fa, almond: 0xd4b060,
    egg: 0xfffce8, sweetpotato: 0xff6820,
  };

  // ─── Public API ────────────────────────────────────────────────────────────

  function init(canvas) {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: false,
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.55;
    renderer.outputEncoding = THREE.sRGBEncoding;

    scene = new THREE.Scene();
    scene.background = makeSceneBackground();

    const sz = canvas.parentElement ? canvas.parentElement.clientWidth : 400;
    camera = new THREE.PerspectiveCamera(45, 1, 0.05, 120);
    camera.position.set(0, 0.4, 4.8);
    renderer.setSize(sz, sz);

    setupLights();
    setupEvents(canvas);
    animate();
  }

  function loadFood(id) {
    clearScene();
    autoRotate = true;
    targetRotY = 0.50; currentRotY = 0.50;
    targetRotX = 0.08; currentRotX = 0.08;
    camera.position.set(0, 0.4, 4.8);
    floatT = 0;

    const fn = BUILDERS[id];
    if (!fn) return;
    foodGroup = fn();
    scene.add(foodGroup);
    addPlatform();
    addParticles(PARTICLE_COLORS[id] || 0x22c55e);
  }

  // ─── Animation Loop ────────────────────────────────────────────────────────

  function animate() {
    animId = requestAnimationFrame(animate);
    floatT += 0.007;

    if (foodGroup) {
      if (autoRotate) targetRotY += 0.0038;
      currentRotX = lerp(currentRotX, targetRotX, 0.07);
      currentRotY = lerp(currentRotY, targetRotY, 0.07);
      foodGroup.rotation.x = currentRotX;
      foodGroup.rotation.y = currentRotY;
      foodGroup.position.y = Math.sin(floatT) * 0.065;
    }

    if (platformDisc) {
      platformDisc.rotation.y += 0.006;
      platformDisc.material.opacity = 0.22 + Math.sin(floatT * 0.80) * 0.12;
      platformDisc.material.emissiveIntensity = 0.80 + Math.sin(floatT * 1.10) * 0.30;
    }

    if (particleSystem) {
      particleSystem.rotation.y += 0.00072;
      particleSystem.rotation.x  = Math.sin(floatT * 0.30) * 0.04;
    }

    if (rimLight) {
      rimLight.intensity = 1.42 + Math.sin(floatT * 0.60) * 0.24;
    }

    renderer.render(scene, camera);
  }

  function destroy() {
    if (animId) cancelAnimationFrame(animId);
    clearScene();
    if (renderer) renderer.dispose();
  }

  return { init, loadFood, destroy };
})();
