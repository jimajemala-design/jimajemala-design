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

  // ─── Canvas Texture Generators ───────────────────────────────────────

  function makeAppleTex() {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(256, 140, 10, 256, 290, 290);
    g.addColorStop(0.00, '#e8dc00');
    g.addColorStop(0.08, '#ff5520');
    g.addColorStop(0.30, '#cc2200');
    g.addColorStop(0.70, '#aa1500');
    g.addColorStop(1.00, '#780e00');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 6; i++) {
      const x = (i / 6) * 512 + 40;
      const bandG = ctx.createLinearGradient(x - 30, 0, x + 30, 512);
      bandG.addColorStop(0,   'rgba(255,120,0,0.12)');
      bandG.addColorStop(0.5, 'rgba(255,80,0,0.06)');
      bandG.addColorStop(1,   'rgba(180,0,0,0.10)');
      ctx.fillStyle = bandG;
      ctx.fillRect(x - 30, 0, 60, 512);
    }
    for (let i = 0; i < 2800; i++) {
      const x = Math.random() * 512, y = Math.random() * 512;
      ctx.beginPath();
      ctx.arc(x, y, 0.6 + Math.random() * 1.8, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(0,0,0,${0.04 + Math.random() * 0.09})`;
      ctx.fill();
    }
    for (let i = 0; i < 600; i++) {
      const x = Math.random() * 512, y = Math.random() * 512;
      ctx.beginPath();
      ctx.arc(x, y, 0.6, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,200,150,${0.05 + Math.random() * 0.08})`;
      ctx.fill();
    }
    return new THREE.CanvasTexture(c);
  }

  function makeBananaTex() {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0.00, '#1e4000');
    g.addColorStop(0.07, '#8db800');
    g.addColorStop(0.18, '#fac72c');
    g.addColorStop(0.50, '#ffdb44');
    g.addColorStop(0.82, '#fac72c');
    g.addColorStop(0.93, '#8db800');
    g.addColorStop(1.00, '#1e4000');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 512);
    ctx.lineWidth = 2.5;
    for (let i = 0; i < 5; i++) {
      const x = (i / 5) * 512 + 52;
      ctx.beginPath();
      for (let y = 0; y <= 512; y += 4) {
        const wave = Math.sin(y / 80) * 5;
        if (y === 0) ctx.moveTo(x + wave, y); else ctx.lineTo(x + wave, y);
      }
      ctx.strokeStyle = 'rgba(100,60,0,0.18)';
      ctx.stroke();
    }
    for (let i = 0; i < 120; i++) {
      const x = Math.random() * 512, y = 50 + Math.random() * 412;
      const r = 1.2 + Math.random() * 5.5;
      const a = 0.35 + Math.random() * 0.55;
      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(70,35,5,${a})`;
      ctx.fill();
      ctx.beginPath();
      ctx.arc(x, y, r * 1.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(60,30,5,${a * 0.2})`;
      ctx.fill();
    }
    return new THREE.CanvasTexture(c);
  }

  function makeChickenTex() {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(260, 230, 20, 256, 256, 280);
    g.addColorStop(0.00, '#f5b0a8');
    g.addColorStop(0.25, '#edc89a');
    g.addColorStop(0.60, '#d9a870');
    g.addColorStop(1.00, '#bf8f55');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 512);
    const fiber = (angle, spacing, alpha) => {
      ctx.save();
      ctx.translate(256, 256);
      ctx.rotate(angle);
      ctx.translate(-256, -256);
      ctx.lineWidth = 0.8;
      for (let i = 0; i < 512 / spacing + 2; i++) {
        const y = i * spacing;
        ctx.beginPath();
        ctx.moveTo(0,   y + Math.sin(i * 1.3) * 6);
        ctx.lineTo(512, y + Math.sin(i * 1.3 + 2) * 6);
        ctx.strokeStyle = `rgba(140,80,40,${alpha})`;
        ctx.stroke();
      }
      ctx.restore();
    };
    fiber(0.10, 6.5, 0.13);
    fiber(-0.06, 9, 0.09);
    ctx.lineWidth = 2.5;
    for (let i = 0; i < 14; i++) {
      const sx = 60 + Math.random() * 390, sy = 60 + Math.random() * 390;
      ctx.beginPath();
      ctx.moveTo(sx, sy);
      ctx.bezierCurveTo(
        sx + (Math.random() - 0.5) * 110, sy + (Math.random() - 0.5) * 60,
        sx + (Math.random() - 0.5) * 90,  sy + (Math.random() - 0.5) * 60,
        sx + (Math.random() - 0.5) * 140, sy + (Math.random() - 0.5) * 80
      );
      ctx.strokeStyle = `rgba(255,240,200,${0.18 + Math.random() * 0.22})`;
      ctx.stroke();
    }
    for (let i = 0; i < 300; i++) {
      const x = Math.random() * 512, y = Math.random() * 512;
      ctx.beginPath();
      ctx.arc(x, y, 0.8 + Math.random() * 2.5, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(120,60,20,${0.05 + Math.random() * 0.12})`;
      ctx.fill();
    }
    return new THREE.CanvasTexture(c);
  }

  function makeFishTex() {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 0, 512);
    g.addColorStop(0.00, '#a0b4c8');
    g.addColorStop(0.30, '#c8c0d0');
    g.addColorStop(0.55, '#ff8060');
    g.addColorStop(0.80, '#e87050');
    g.addColorStop(1.00, '#c0b8c8');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 512);
    const sz = 26;
    const rows = Math.ceil(512 / (sz * 0.68)) + 3;
    const cols = Math.ceil(512 / sz) + 3;
    for (let row = 0; row < rows; row++) {
      for (let col = 0; col < cols; col++) {
        const ox = (row % 2) * sz * 0.5;
        const x = (col - 1) * sz + ox;
        const y = (row - 1) * sz * 0.65;
        ctx.beginPath();
        ctx.arc(x, y + sz * 0.4, sz * 0.52, -Math.PI, 0);
        ctx.strokeStyle = 'rgba(100,120,150,0.45)';
        ctx.lineWidth = 0.9;
        ctx.stroke();
        const sg = ctx.createRadialGradient(x - 3, y + sz * 0.2, 0, x, y + sz * 0.4, sz * 0.45);
        sg.addColorStop(0, 'rgba(255,255,255,0.18)');
        sg.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = sg;
        ctx.beginPath();
        ctx.arc(x, y + sz * 0.4, sz * 0.52, -Math.PI, 0);
        ctx.fill();
      }
    }
    ctx.beginPath();
    for (let x = 0; x <= 512; x += 4) {
      const y = 200 + Math.sin(x / 60) * 8;
      if (x === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.strokeStyle = 'rgba(60,80,100,0.55)';
    ctx.lineWidth = 1.5;
    ctx.stroke();
    return new THREE.CanvasTexture(c);
  }

  function makeAlmondTex() {
    const c = document.createElement('canvas');
    c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0, 0, 512, 512);
    g.addColorStop(0.0, '#b08830');
    g.addColorStop(0.5, '#8b6914');
    g.addColorStop(1.0, '#5c400c');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 18; i++) {
      const xBase = (i / 18) * 512;
      ctx.beginPath();
      ctx.moveTo(xBase, 0);
      for (let y = 0; y <= 512; y += 6) {
        const wave = Math.sin(y / 55 + i * 1.4) * 7;
        ctx.lineTo(xBase + wave, y);
      }
      const dark = i % 3 === 0;
      ctx.strokeStyle = dark
        ? `rgba(40,20,0,${0.3 + Math.random() * 0.2})`
        : `rgba(180,130,40,${0.15 + Math.random() * 0.15})`;
      ctx.lineWidth = dark ? 1.5 : 0.8;
      ctx.stroke();
    }
    for (let i = 0; i < 1800; i++) {
      const x = Math.random() * 512, y = Math.random() * 512;
      ctx.beginPath();
      ctx.arc(x, y, 0.5 + Math.random() * 1.8, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${Math.random() > 0.5 ? '30,12,0' : '200,150,60'},${0.06 + Math.random() * 0.18})`;
      ctx.fill();
    }
    return new THREE.CanvasTexture(c);
  }

  // ─── Food Builders ───────────────────────────────────────────────────

  function buildApple() {
    const g = new THREE.Group();
    const tex = makeAppleTex();
    const pts = [
      new THREE.Vector2(0.00, -1.02),
      new THREE.Vector2(0.30, -1.00),
      new THREE.Vector2(0.62, -0.88),
      new THREE.Vector2(0.88, -0.65),
      new THREE.Vector2(1.02, -0.32),
      new THREE.Vector2(1.04,  0.05),
      new THREE.Vector2(1.00,  0.40),
      new THREE.Vector2(0.90,  0.66),
      new THREE.Vector2(0.72,  0.84),
      new THREE.Vector2(0.48,  0.94),
      new THREE.Vector2(0.22,  1.00),
      new THREE.Vector2(0.06,  1.02),
      new THREE.Vector2(0.00,  1.02),
    ];
    const bodyMat = new THREE.MeshPhysicalMaterial({
      map: tex,
      roughness: 0.18,
      metalness: 0.0,
      clearcoat: 1.0,
      clearcoatRoughness: 0.08,
      envMapIntensity: 1.2,
    });
    const body = new THREE.Mesh(new THREE.LatheGeometry(pts, 80), bodyMat);
    body.castShadow = body.receiveShadow = true;
    g.add(body);
    const indentMat = new THREE.MeshPhysicalMaterial({
      color: 0x7a0e00, roughness: 0.55, metalness: 0, clearcoat: 0.2,
    });
    const topIndent = new THREE.Mesh(new THREE.SphereGeometry(0.24, 24, 24), indentMat);
    topIndent.position.y = 0.98;
    topIndent.scale.set(1, 0.40, 1);
    g.add(topIndent);
    const botIndent = new THREE.Mesh(new THREE.SphereGeometry(0.18, 20, 20), indentMat);
    botIndent.position.y = -1.02;
    botIndent.scale.set(1, 0.32, 1);
    g.add(botIndent);
    const stemCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0.00,  1.02, 0.00),
      new THREE.Vector3(0.05,  1.18, 0.02),
      new THREE.Vector3(0.09,  1.36,-0.01),
      new THREE.Vector3(0.08,  1.52, 0.01),
    ]);
    g.add(new THREE.Mesh(
      new THREE.TubeGeometry(stemCurve, 12, 0.026, 8, false),
      new THREE.MeshStandardMaterial({ color: 0x2e1a08, roughness: 0.96, metalness: 0 })));
    const leafShape = new THREE.Shape();
    leafShape.moveTo(0, 0);
    leafShape.bezierCurveTo(0.10, 0.20, 0.28, 0.30, 0.42, 0.18);
    leafShape.bezierCurveTo(0.48, 0.06, 0.35,-0.06, 0.16, 0.00);
    leafShape.bezierCurveTo(0.06,-0.04, 0,-0.02, 0, 0);
    const leaf = new THREE.Mesh(
      new THREE.ShapeGeometry(leafShape, 8),
      new THREE.MeshStandardMaterial({ color: 0x1a6b20, roughness: 0.72, metalness: 0, side: THREE.DoubleSide })
    );
    leaf.position.set(0.1, 1.46, 0.04);
    leaf.rotation.set(0.12, 0.28, -0.45);
    g.add(leaf);
    return g;
  }

  function buildBanana() {
    const g = new THREE.Group();
    const tex = makeBananaTex();
    const spine = new THREE.CatmullRomCurve3([
      new THREE.Vector3( 0.00, -1.45, 0.00),
      new THREE.Vector3(-0.08, -0.85, 0.00),
      new THREE.Vector3(-0.28,  0.00, 0.04),
      new THREE.Vector3(-0.48,  0.75, 0.00),
      new THREE.Vector3(-0.54,  1.25,-0.04),
      new THREE.Vector3(-0.40,  1.52, 0.00),
    ]);
    const T_SEGS = 52, R_SEGS = 5;
    const frames = spine.computeFrenetFrames(T_SEGS, false);
    const verts = [], norms = [], uvArr = [], idxArr = [];
    for (let i = 0; i <= T_SEGS; i++) {
      const t = i / T_SEGS;
      const pos = spine.getPointAt(t);
      const nr = frames.normals[Math.min(i,  frames.normals.length - 1)];
      const bn = frames.binormals[Math.min(i, frames.binormals.length - 1)];
      const r = 0.095 + Math.sin(t * Math.PI) * 0.22;
      for (let j = 0; j <= R_SEGS; j++) {
        const a = (j / R_SEGS) * Math.PI * 2;
        const rx = Math.cos(a) * r, ry = Math.sin(a) * r * 0.80;
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
      map: tex, roughness: 0.62, metalness: 0, clearcoat: 0.12, clearcoatRoughness: 0.35,
    }));
    body.castShadow = body.receiveShadow = true;
    g.add(body);
    const tipMat = new THREE.MeshStandardMaterial({ color: 0x2e1200, roughness: 0.92, metalness: 0 });
    const tip1 = new THREE.Mesh(new THREE.SphereGeometry(0.085, 10, 10), tipMat);
    tip1.position.copy(spine.getPointAt(0));
    tip1.scale.set(0.8, 1.6, 0.8);
    g.add(tip1);
    const tip2 = new THREE.Mesh(new THREE.SphereGeometry(0.065, 10, 10), tipMat);
    tip2.position.copy(spine.getPointAt(1));
    tip2.scale.set(0.7, 1.5, 0.7);
    g.add(tip2);
    return g;
  }

  function buildChicken() {
    const g = new THREE.Group();
    const tex = makeChickenTex();
    const meatMat = new THREE.MeshStandardMaterial({ map: tex, color: 0xe8c49a, roughness: 0.88, metalness: 0 });
    const main = new THREE.Mesh(new THREE.SphereGeometry(1, 56, 36), meatMat);
    main.scale.set(1.28, 0.54, 0.92);
    main.castShadow = main.receiveShadow = true;
    g.add(main);
    const lobe2Mat = new THREE.MeshStandardMaterial({ color: 0xdcb07a, roughness: 0.90, metalness: 0 });
    const lobe2 = new THREE.Mesh(new THREE.SphereGeometry(0.72, 36, 28), lobe2Mat);
    lobe2.scale.set(0.88, 0.48, 0.82);
    lobe2.position.set(0.48, 0.06, 0.28);
    lobe2.castShadow = true;
    g.add(lobe2);
    const thin = new THREE.Mesh(new THREE.SphereGeometry(0.52, 28, 20), meatMat);
    thin.scale.set(0.78, 0.38, 0.60);
    thin.position.set(-1.0, 0, 0.08);
    g.add(thin);
    const fatMat = new THREE.MeshPhysicalMaterial({
      color: 0xfffae0, roughness: 0.55, metalness: 0,
      clearcoat: 0.35, clearcoatRoughness: 0.42, transparent: true, opacity: 0.55,
    });
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 1.8 - 0.5;
      const fat = new THREE.Mesh(new THREE.SphereGeometry(0.10 + i * 0.04, 8, 8), fatMat);
      fat.position.set(Math.cos(a) * 0.65, (Math.random() - 0.5) * 0.18, Math.sin(a) * 0.38 + 0.32);
      fat.scale.set(1.6, 0.28, 1.3);
      g.add(fat);
    }
    const boneMat = new THREE.MeshPhysicalMaterial({
      color: 0xf5f0e8, roughness: 0.48, metalness: 0, clearcoat: 0.30, clearcoatRoughness: 0.22,
    });
    const boneCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-1.05, 0.06, 0),
      new THREE.Vector3(-1.40, 0.10, 0.04),
      new THREE.Vector3(-1.80, 0.08, 0),
      new THREE.Vector3(-2.05, 0.04, 0),
    ]);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(boneCurve, 14, 0.052, 9, false), boneMat));
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.145, 14, 14), boneMat);
    knob.position.set(-2.10, 0.04, 0);
    g.add(knob);
    return g;
  }

  function buildFish() {
    const g = new THREE.Group();
    const tex = makeFishTex();
    const bodyMat = new THREE.MeshPhysicalMaterial({
      map: tex, roughness: 0.28, metalness: 0.08,
      clearcoat: 0.55, clearcoatRoughness: 0.18, envMapIntensity: 0.8,
    });
    const bodyPts = [
      new THREE.Vector2(0.00, -1.40), new THREE.Vector2(0.18, -1.22),
      new THREE.Vector2(0.32, -0.95), new THREE.Vector2(0.44, -0.60),
      new THREE.Vector2(0.52, -0.15), new THREE.Vector2(0.54,  0.22),
      new THREE.Vector2(0.50,  0.58), new THREE.Vector2(0.40,  0.88),
      new THREE.Vector2(0.26,  1.14), new THREE.Vector2(0.12,  1.32),
      new THREE.Vector2(0.00,  1.40),
    ];
    const body = new THREE.Mesh(new THREE.LatheGeometry(bodyPts, 64), bodyMat);
    body.rotation.z = -Math.PI / 2;
    body.scale.set(1.0, 0.85, 0.42);
    body.castShadow = body.receiveShadow = true;
    g.add(body);
    const finMat = new THREE.MeshStandardMaterial({
      color: 0xb85c38, roughness: 0.62, metalness: 0,
      side: THREE.DoubleSide, transparent: true, opacity: 0.82,
    });
    const tailShape = new THREE.Shape();
    tailShape.moveTo(0, 0);
    tailShape.bezierCurveTo(-0.12, 0.12,-0.38, 0.38,-0.58, 0.52);
    tailShape.bezierCurveTo(-0.52, 0.30,-0.46, 0.12,-0.32, 0.03);
    tailShape.bezierCurveTo(-0.30, 0.01,-0.28,-0.01,-0.32,-0.03);
    tailShape.bezierCurveTo(-0.46,-0.12,-0.52,-0.30,-0.58,-0.52);
    tailShape.bezierCurveTo(-0.38,-0.38,-0.12,-0.12, 0, 0);
    const tail = new THREE.Mesh(new THREE.ShapeGeometry(tailShape, 8), finMat);
    tail.position.set(-1.40, 0, 0);
    tail.rotation.y = Math.PI / 2;
    g.add(tail);
    const dorsalShape = new THREE.Shape();
    dorsalShape.moveTo(0, 0);
    dorsalShape.bezierCurveTo(0.20, 0.18, 0.42, 0.40, 0.60, 0.46);
    dorsalShape.bezierCurveTo(0.72, 0.42, 0.85, 0.18, 1.00, 0);
    const dorsal = new THREE.Mesh(new THREE.ShapeGeometry(dorsalShape, 6), finMat);
    dorsal.position.set(-0.85, 0.44, 0);
    dorsal.rotation.y = Math.PI / 2;
    g.add(dorsal);
    const pectShape = new THREE.Shape();
    pectShape.moveTo(0, 0);
    pectShape.bezierCurveTo(0.08,-0.08, 0.24,-0.14, 0.34,-0.05);
    pectShape.bezierCurveTo(0.26, 0.05, 0.08, 0.06, 0, 0);
    const pect = new THREE.Mesh(new THREE.ShapeGeometry(pectShape, 5), finMat);
    pect.position.set(0.10, -0.08, 0.20);
    pect.rotation.set(0.35,-0.25, 0.45);
    g.add(pect);
    const eyeBase = new THREE.Mesh(
      new THREE.SphereGeometry(0.076, 18, 18),
      new THREE.MeshPhysicalMaterial({ color: 0xfafafa, roughness: 0.04, metalness: 0, clearcoat: 1.0, clearcoatRoughness: 0.03 })
    );
    eyeBase.position.set(1.12, 0.16, 0.18);
    g.add(eyeBase);
    const pupil = new THREE.Mesh(
      new THREE.SphereGeometry(0.048, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0x040404 })
    );
    pupil.position.set(1.15, 0.16, 0.21);
    g.add(pupil);
    return g;
  }

  function buildAlmond() {
    const g = new THREE.Group();
    const tex = makeAlmondTex();
    const pts = [
      new THREE.Vector2(0.00, -1.12), new THREE.Vector2(0.09, -1.06),
      new THREE.Vector2(0.24, -0.88), new THREE.Vector2(0.38, -0.62),
      new THREE.Vector2(0.48, -0.32), new THREE.Vector2(0.52,  0.00),
      new THREE.Vector2(0.49,  0.32), new THREE.Vector2(0.40,  0.60),
      new THREE.Vector2(0.26,  0.85), new THREE.Vector2(0.12,  1.02),
      new THREE.Vector2(0.00,  1.12),
    ];
    const bodyMat = new THREE.MeshStandardMaterial({
      map: tex, color: 0xa07828, roughness: 0.82, metalness: 0,
    });
    const body = new THREE.Mesh(new THREE.LatheGeometry(pts, 52), bodyMat);
    body.scale.set(1, 1, 0.78);
    body.castShadow = body.receiveShadow = true;
    g.add(body);
    const ridgeMat = new THREE.MeshStandardMaterial({ color: 0x4a2c08, roughness: 0.96, metalness: 0 });
    for (let i = 0; i < 7; i++) {
      const phi = (i / 7) * Math.PI;
      const ridge = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.010, 4, 36, Math.PI), ridgeMat);
      ridge.rotation.y = phi;
      ridge.scale.set(1, 1.38, 0.78);
      g.add(ridge);
    }
    const tipMesh = new THREE.Mesh(
      new THREE.SphereGeometry(0.13, 12, 12),
      new THREE.MeshStandardMaterial({ color: 0xf0d880, roughness: 0.58, metalness: 0 })
    );
    tipMesh.position.y = 1.08;
    tipMesh.scale.set(0.55, 0.45, 0.45);
    g.add(tipMesh);
    g.rotation.z = 0.28;
    return g;
  }

  // ─── Scene Initialisation ────────────────────────────────────────────

  function init(canvas) {
    renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,              // transparent — CSS gradient bg shows through
      powerPreference: 'high-performance',
    });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.6;
    renderer.outputEncoding = THREE.sRGBEncoding;

    scene = new THREE.Scene();
    // No scene.background — transparent to show CSS gradient

    const sz = canvas.parentElement.clientWidth;
    camera = new THREE.PerspectiveCamera(45, 1, 0.05, 120);
    camera.position.set(0, 0.4, 4.8);
    renderer.setSize(sz, sz);

    setupLights();
    setupEvents(canvas);
    animate();
  }

  function setupLights() {
    // Minimal ambient — dark, cinematic
    scene.add(new THREE.AmbientLight(0x0a1020, 0.6));

    // Hemisphere: deep teal sky → dark ground
    scene.add(new THREE.HemisphereLight(0x1a3a2a, 0x080c14, 0.4));

    // Key light: warm gold from upper-right, casts shadows
    const key = new THREE.DirectionalLight(0xfff0cc, 2.2);
    key.position.set(4.0, 6.0, 4.0);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near   = 0.5;
    key.shadow.camera.far    = 30;
    key.shadow.camera.left   = -5;
    key.shadow.camera.right  =  5;
    key.shadow.camera.top    =  5;
    key.shadow.camera.bottom = -5;
    key.shadow.radius = 8;
    key.shadow.bias   = -0.001;
    scene.add(key);

    // Fill: cool blue-green from left
    const fill = new THREE.DirectionalLight(0x22c55e, 0.5);
    fill.position.set(-5, 1, 2);
    scene.add(fill);

    // Rim: pure white edge highlight from behind
    rimLight = new THREE.DirectionalLight(0xffffff, 1.8);
    rimLight.position.set(0, 3, -5);
    scene.add(rimLight);

    // Accent point: gold from below (cinematic underlight)
    const accent = new THREE.PointLight(0xf59e0b, 1.0, 10);
    accent.position.set(0, -2.5, 2);
    scene.add(accent);

    // Green accent: nature/nutrition feel
    const greenPt = new THREE.PointLight(0x22c55e, 0.8, 14);
    greenPt.position.set(-3, 3, 0);
    scene.add(greenPt);
  }

  // ─── Platform + Particles ────────────────────────────────────────────

  function addPlatform() {
    const plane = new THREE.Mesh(
      new THREE.PlaneGeometry(12, 12),
      new THREE.ShadowMaterial({ opacity: 0.5 })
    );
    plane.rotation.x = -Math.PI / 2;
    plane.position.y = -1.85;
    plane.receiveShadow = true;
    scene.add(plane);
    shadowPlane = plane;

    // Glowing disc — green accent
    const discGeo = new THREE.CylinderGeometry(1.2, 1.2, 0.014, 80);
    const discMat = new THREE.MeshStandardMaterial({
      color: 0x22c55e,
      emissive: 0x22c55e,
      emissiveIntensity: 0.9,
      roughness: 0.05,
      metalness: 0.6,
      transparent: true,
      opacity: 0.35,
    });
    platformDisc = new THREE.Mesh(discGeo, discMat);
    platformDisc.position.y = -1.84;
    platformDisc.receiveShadow = true;
    scene.add(platformDisc);

    // Outer ring
    const ringGeo = new THREE.TorusGeometry(1.4, 0.012, 6, 80);
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0xf59e0b,
      emissive: 0xf59e0b,
      emissiveIntensity: 0.6,
      transparent: true,
      opacity: 0.45,
    });
    const ring = new THREE.Mesh(ringGeo, ringMat);
    ring.rotation.x = Math.PI / 2;
    ring.position.y = -1.83;
    scene.add(ring);
  }

  function addParticles(colorHex) {
    const count = 200;
    const pos = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = 3.2 + Math.random() * 2.5;
      const theta = Math.random() * Math.PI * 2;
      const phi   = Math.acos(2 * Math.random() - 1);
      pos[i*3]   = r * Math.sin(phi) * Math.cos(theta);
      pos[i*3+1] = r * Math.sin(phi) * Math.sin(theta);
      pos[i*3+2] = r * Math.cos(phi);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    particleSystem = new THREE.Points(geo, new THREE.PointsMaterial({
      color: colorHex,
      size: 0.025,
      transparent: true,
      opacity: 0.5,
      sizeAttenuation: true,
    }));
    scene.add(particleSystem);
  }

  // ─── Interaction ─────────────────────────────────────────────────────

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
      const s = canvas.parentElement.clientWidth;
      renderer.setSize(s, s);
      camera.updateProjectionMatrix();
    });
  }

  // ─── Scene Management ─────────────────────────────────────────────────

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
    // Remove ring if present
    scene.children.filter(c => c.isMesh && c.geometry.type === 'TorusGeometry').forEach(c => scene.remove(c));
    foodGroup = particleSystem = null;
  }

  const builders = {
    apple:   buildApple,
    banana:  buildBanana,
    chicken: buildChicken,
    fish:    buildFish,
    almond:  buildAlmond,
  };

  const particleColors = {
    apple:   0xff4422,
    banana:  0xf59e0b,
    chicken: 0xf0c080,
    fish:    0x60a5fa,
    almond:  0xd4b060,
  };

  function loadFood(id) {
    clearScene();
    autoRotate = true;
    targetRotY  = 0.50;  currentRotY  = 0.50;
    targetRotX  = 0.08;  currentRotX  = 0.08;
    camera.position.set(0, 0.4, 4.8);
    floatT = 0;

    const fn = builders[id];
    if (!fn) return;
    foodGroup = fn();
    scene.add(foodGroup);
    addPlatform();
    addParticles(particleColors[id] || 0x22c55e);
  }

  // ─── Animation Loop ───────────────────────────────────────────────────

  function animate() {
    animId = requestAnimationFrame(animate);
    floatT += 0.007;

    if (foodGroup) {
      if (autoRotate) targetRotY += 0.004;
      currentRotX = lerp(currentRotX, targetRotX, 0.07);
      currentRotY = lerp(currentRotY, targetRotY, 0.07);
      foodGroup.rotation.x = currentRotX;
      foodGroup.rotation.y = currentRotY;
      foodGroup.position.y = Math.sin(floatT) * 0.065;
    }

    if (platformDisc) {
      platformDisc.rotation.y += 0.005;
      platformDisc.material.opacity = 0.25 + Math.sin(floatT * 0.8) * 0.12;
      platformDisc.material.emissiveIntensity = 0.7 + Math.sin(floatT * 1.2) * 0.3;
    }

    if (particleSystem) {
      particleSystem.rotation.y += 0.0007;
      particleSystem.rotation.x  = Math.sin(floatT * 0.3) * 0.05;
    }

    // Subtle rim light pulsing
    if (rimLight) {
      rimLight.intensity = 1.6 + Math.sin(floatT * 0.7) * 0.3;
    }

    renderer.render(scene, camera);
  }

  function destroy() {
    if (animId) cancelAnimationFrame(animId);
    clearScene();
    renderer.dispose();
  }

  return { init, loadFood, destroy };
})();
