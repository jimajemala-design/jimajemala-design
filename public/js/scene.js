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

  function makeBroccoliTex() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(256,200,20,256,256,320);
    g.addColorStop(0,'#1a4d22'); g.addColorStop(0.5,'#155c1e'); g.addColorStop(1,'#0d3a14');
    ctx.fillStyle = g; ctx.fillRect(0,0,512,512);
    for (let i=0;i<3000;i++) {
      const x=Math.random()*512,y=Math.random()*512,r=1+Math.random()*4;
      ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2);
      ctx.fillStyle=Math.random()>0.4?`rgba(20,80,25,${0.2+Math.random()*0.4})`:`rgba(40,120,40,${0.1+Math.random()*0.2})`;
      ctx.fill();
    }
    const sp=ctx.createRadialGradient(180,140,5,180,200,200);
    sp.addColorStop(0,'rgba(100,200,80,0.18)'); sp.addColorStop(1,'rgba(100,200,80,0)');
    ctx.fillStyle=sp; ctx.fillRect(0,0,400,400);
    return new THREE.CanvasTexture(c);
  }

  function makeAvocadoTex() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(256,200,10,256,320,340);
    g.addColorStop(0,'#1a3a1a'); g.addColorStop(0.6,'#2d5a1b'); g.addColorStop(1,'#0f2210');
    ctx.fillStyle=g; ctx.fillRect(0,0,512,512);
    for (let i=0;i<4000;i++) {
      const x=Math.random()*512,y=Math.random()*512;
      ctx.beginPath(); ctx.arc(x,y,0.8+Math.random()*3,0,Math.PI*2);
      ctx.fillStyle=Math.random()>0.5?`rgba(8,28,8,${0.1+Math.random()*0.25})`:`rgba(60,100,30,${0.05+Math.random()*0.12})`;
      ctx.fill();
    }
    const bump=ctx.createRadialGradient(256,256,80,256,256,260);
    bump.addColorStop(0,'rgba(0,0,0,0)'); bump.addColorStop(1,'rgba(0,0,0,0.35)');
    ctx.fillStyle=bump; ctx.fillRect(0,0,512,512);
    return new THREE.CanvasTexture(c);
  }

  function makeBlueberryTex() {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(100,80,8,128,128,160);
    g.addColorStop(0,'#6b5fb5'); g.addColorStop(0.5,'#3d2e7c'); g.addColorStop(1,'#1e1545');
    ctx.fillStyle=g; ctx.fillRect(0,0,256,256);
    const bloom=ctx.createRadialGradient(90,70,2,90,90,90);
    bloom.addColorStop(0,'rgba(200,195,240,0.28)'); bloom.addColorStop(1,'rgba(200,195,240,0)');
    ctx.fillStyle=bloom; ctx.fillRect(0,0,200,200);
    for (let i=0;i<800;i++) {
      const x=Math.random()*256,y=Math.random()*256;
      ctx.beginPath(); ctx.arc(x,y,0.5+Math.random()*2,0,Math.PI*2);
      ctx.fillStyle=`rgba(30,20,80,${0.1+Math.random()*0.3})`; ctx.fill();
    }
    return new THREE.CanvasTexture(c);
  }

  function makeSpinachTex() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0,0,512,512);
    g.addColorStop(0,'#1b4d1e'); g.addColorStop(0.5,'#14401a'); g.addColorStop(1,'#0e3014');
    ctx.fillStyle=g; ctx.fillRect(0,0,512,512);
    const veinG=ctx.createLinearGradient(0,0,512,512);
    veinG.addColorStop(0,'rgba(40,120,40,0.25)'); veinG.addColorStop(1,'rgba(20,80,20,0)');
    ctx.fillStyle=veinG; ctx.fillRect(0,0,512,512);
    for (let i=0;i<12;i++) {
      const x=(i/12)*512; ctx.beginPath(); ctx.moveTo(x,0);
      for (let y=0;y<=512;y+=6) ctx.lineTo(x+Math.sin(y/40+i)*6,y);
      ctx.strokeStyle=`rgba(10,60,15,${0.15+Math.random()*0.2})`; ctx.lineWidth=1.2; ctx.stroke();
    }
    for (let i=0;i<2000;i++) {
      const x=Math.random()*512,y=Math.random()*512;
      ctx.beginPath(); ctx.arc(x,y,0.5+Math.random()*2.5,0,Math.PI*2);
      ctx.fillStyle=`rgba(${Math.random()>0.5?'8,50,12':'50,140,40'},${0.06+Math.random()*0.15})`; ctx.fill();
    }
    return new THREE.CanvasTexture(c);
  }

  function makeYogurtTex() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(256,200,10,256,256,300);
    g.addColorStop(0,'#fefefe'); g.addColorStop(0.5,'#f8f5f0'); g.addColorStop(1,'#ede8e0');
    ctx.fillStyle=g; ctx.fillRect(0,0,512,512);
    for (let i=0;i<3;i++) {
      const rg=ctx.createLinearGradient(0,i*80+180,512,i*80+220);
      rg.addColorStop(0,'rgba(220,215,205,0)'); rg.addColorStop(0.5,'rgba(220,215,205,0.1)'); rg.addColorStop(1,'rgba(220,215,205,0)');
      ctx.fillStyle=rg; ctx.fillRect(0,i*80+180,512,40);
    }
    const sp=ctx.createRadialGradient(180,130,5,180,160,220);
    sp.addColorStop(0,'rgba(255,255,255,0.7)'); sp.addColorStop(1,'rgba(255,255,255,0)');
    ctx.fillStyle=sp; ctx.fillRect(0,0,420,380);
    return new THREE.CanvasTexture(c);
  }

  function makeCarrotTex() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0,0,0,512);
    g.addColorStop(0,'#7a1f00'); g.addColorStop(0.15,'#d94800'); g.addColorStop(0.5,'#f97316'); g.addColorStop(0.85,'#d94800'); g.addColorStop(1,'#7a1f00');
    ctx.fillStyle=g; ctx.fillRect(0,0,512,512);
    for (let i=0;i<18;i++) {
      const x=(i/18)*512; ctx.beginPath(); ctx.moveTo(x,0);
      for (let y=0;y<=512;y+=5) ctx.lineTo(x+Math.sin(y/50+i)*8,y);
      ctx.strokeStyle=i%3===0?`rgba(180,60,0,0.3)`:`rgba(255,140,40,0.15)`; ctx.lineWidth=i%3===0?2:1; ctx.stroke();
    }
    for (let i=0;i<3000;i++) {
      const x=Math.random()*512,y=Math.random()*512;
      ctx.beginPath(); ctx.arc(x,y,0.5+Math.random()*2.5,0,Math.PI*2);
      ctx.fillStyle=`rgba(${Math.random()>0.5?'120,40,0':'255,160,60'},${0.05+Math.random()*0.15})`; ctx.fill();
    }
    const sh=ctx.createRadialGradient(180,150,8,180,200,260);
    sh.addColorStop(0,'rgba(255,200,100,0.2)'); sh.addColorStop(1,'rgba(255,200,100,0)');
    ctx.fillStyle=sh; ctx.fillRect(0,0,460,450);
    return new THREE.CanvasTexture(c);
  }

  function makeOatsTex() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(256,200,20,256,300,320);
    g.addColorStop(0,'#e8d5a0'); g.addColorStop(0.6,'#c8b07a'); g.addColorStop(1,'#a89060');
    ctx.fillStyle=g; ctx.fillRect(0,0,512,512);
    for (let i=0;i<2000;i++) {
      const x=Math.random()*512,y=Math.random()*512,r=1+Math.random()*5;
      ctx.beginPath(); ctx.ellipse(x,y,r,r*0.5,Math.random()*Math.PI,0,Math.PI*2);
      ctx.fillStyle=`rgba(${Math.random()>0.5?'100,75,30':'220,195,130'},${0.1+Math.random()*0.3})`; ctx.fill();
    }
    const sp=ctx.createRadialGradient(160,130,5,160,160,200);
    sp.addColorStop(0,'rgba(255,245,210,0.4)'); sp.addColorStop(1,'rgba(255,245,210,0)');
    ctx.fillStyle=sp; ctx.fillRect(0,0,380,380);
    return new THREE.CanvasTexture(c);
  }

  function makeLemonTex() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(512,180,20,512,400,520);
    g.addColorStop(0,'#fff176'); g.addColorStop(0.4,'#fde047'); g.addColorStop(1,'#ca9800');
    ctx.fillStyle=g; ctx.fillRect(0,0,512,512);
    for (let i=0;i<5000;i++) {
      const x=Math.random()*512,y=Math.random()*512;
      ctx.beginPath(); ctx.arc(x,y,0.5+Math.random()*2,0,Math.PI*2);
      ctx.fillStyle=`rgba(${Math.random()>0.5?'160,100,0':'255,255,160'},${0.04+Math.random()*0.12})`; ctx.fill();
    }
    const oil=ctx.createRadialGradient(200,160,3,200,200,260);
    oil.addColorStop(0,'rgba(255,255,200,0.55)'); oil.addColorStop(1,'rgba(255,255,200,0)');
    ctx.fillStyle=oil; ctx.fillRect(0,0,460,440);
    return new THREE.CanvasTexture(c);
  }

  function makeWalnutTex() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0,0,512,512);
    g.addColorStop(0,'#a07040'); g.addColorStop(0.5,'#7a5020'); g.addColorStop(1,'#4a2c0a');
    ctx.fillStyle=g; ctx.fillRect(0,0,512,512);
    for (let i=0;i<28;i++) {
      ctx.beginPath(); ctx.moveTo(Math.random()*512,0);
      for (let y=0;y<=512;y+=5) ctx.lineTo(Math.random()*512,y);
      ctx.strokeStyle=i%4===0?`rgba(30,14,2,0.35)`:`rgba(140,95,40,0.18)`; ctx.lineWidth=i%4===0?2.5:1; ctx.stroke();
    }
    for (let i=0;i<2500;i++) {
      const x=Math.random()*512,y=Math.random()*512;
      ctx.beginPath(); ctx.arc(x,y,0.5+Math.random()*3,0,Math.PI*2);
      ctx.fillStyle=`rgba(${Math.random()>0.5?'25,12,2':'180,130,60'},${0.06+Math.random()*0.18})`; ctx.fill();
    }
    return new THREE.CanvasTexture(c);
  }

  function makeTomatoTex() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(512,170,15,512,380,520);
    g.addColorStop(0,'#ff8c69'); g.addColorStop(0.3,'#dc2626'); g.addColorStop(0.8,'#991b1b'); g.addColorStop(1,'#660f0f');
    ctx.fillStyle=g; ctx.fillRect(0,0,512,512);
    for (let i=0;i<8;i++) {
      const x=(i/8)*512;
      const rg=ctx.createLinearGradient(x-30,0,x+30,512);
      rg.addColorStop(0,'rgba(220,0,0,0)'); rg.addColorStop(0.5,`rgba(${i%2?180:255},${i%2?0:50},0,0.06)`); rg.addColorStop(1,'rgba(220,0,0,0)');
      ctx.fillStyle=rg; ctx.fillRect(x-30,0,60,512);
    }
    for (let i=0;i<3000;i++) {
      const x=Math.random()*512,y=Math.random()*512;
      ctx.beginPath(); ctx.arc(x,y,0.5+Math.random()*2,0,Math.PI*2);
      ctx.fillStyle=`rgba(${Math.random()>0.5?'80,0,0':'255,180,160'},${0.03+Math.random()*0.09})`; ctx.fill();
    }
    const wax=ctx.createRadialGradient(240,185,5,240,200,280);
    wax.addColorStop(0,'rgba(255,220,200,0.45)'); wax.addColorStop(1,'rgba(255,220,200,0)');
    ctx.fillStyle=wax; ctx.fillRect(0,0,500,460);
    return new THREE.CanvasTexture(c);
  }

  function makeGarlicTex() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(256,200,10,256,300,340);
    g.addColorStop(0,'#fefdf8'); g.addColorStop(0.5,'#f0ecdc'); g.addColorStop(1,'#ddd4b8');
    ctx.fillStyle=g; ctx.fillRect(0,0,512,512);
    for (let i=0;i<14;i++) {
      const x=(i/14)*512; ctx.beginPath(); ctx.moveTo(x,0);
      for (let y=0;y<=512;y+=8) ctx.lineTo(x+Math.sin(y/60+i)*4,y);
      ctx.strokeStyle=`rgba(180,160,100,${0.08+Math.random()*0.12})`; ctx.lineWidth=0.8; ctx.stroke();
    }
    const purp=ctx.createLinearGradient(0,200,512,512);
    purp.addColorStop(0,'rgba(180,140,200,0)'); purp.addColorStop(0.5,'rgba(180,140,200,0.06)'); purp.addColorStop(1,'rgba(180,140,200,0)');
    ctx.fillStyle=purp; ctx.fillRect(0,200,512,312);
    for (let i=0;i<1200;i++) {
      const x=Math.random()*512,y=Math.random()*512;
      ctx.beginPath(); ctx.arc(x,y,0.4+Math.random()*1.8,0,Math.PI*2);
      ctx.fillStyle=`rgba(150,130,80,${0.04+Math.random()*0.1})`; ctx.fill();
    }
    return new THREE.CanvasTexture(c);
  }

  function makeChocolateTex() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0,0,512,512);
    g.addColorStop(0,'#5a2d0c'); g.addColorStop(0.5,'#3d1a06'); g.addColorStop(1,'#250e02');
    ctx.fillStyle=g; ctx.fillRect(0,0,512,512);
    for (let i=0;i<1800;i++) {
      const x=Math.random()*512,y=Math.random()*512;
      ctx.beginPath(); ctx.arc(x,y,0.5+Math.random()*2.5,0,Math.PI*2);
      ctx.fillStyle=`rgba(${Math.random()>0.5?'15,5,0':'120,60,20'},${0.05+Math.random()*0.15})`; ctx.fill();
    }
    const sh=ctx.createLinearGradient(0,0,512,0);
    sh.addColorStop(0,'rgba(200,100,40,0.18)'); sh.addColorStop(0.5,'rgba(200,100,40,0)'); sh.addColorStop(1,'rgba(200,100,40,0.12)');
    ctx.fillStyle=sh; ctx.fillRect(0,0,512,512);
    const sp=ctx.createRadialGradient(120,80,5,120,100,200);
    sp.addColorStop(0,'rgba(200,140,80,0.35)'); sp.addColorStop(1,'rgba(200,140,80,0)');
    ctx.fillStyle=sp; ctx.fillRect(0,0,340,320);
    return new THREE.CanvasTexture(c);
  }

  function makeKiwiTex() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(256,200,15,256,300,340);
    g.addColorStop(0,'#6b4c2a'); g.addColorStop(0.6,'#4a3018'); g.addColorStop(1,'#2c1c0a');
    ctx.fillStyle=g; ctx.fillRect(0,0,512,512);
    for (let i=0;i<6000;i++) {
      const x=Math.random()*512,y=Math.random()*512,r=0.5+Math.random()*2.5;
      ctx.beginPath(); ctx.arc(x,y,r,0,Math.PI*2);
      ctx.fillStyle=`rgba(${Math.random()>0.5?'20,10,4':'120,80,40'},${0.08+Math.random()*0.2})`; ctx.fill();
    }
    for (let i=0;i<500;i++) {
      const x=Math.random()*512,y=Math.random()*512;
      ctx.beginPath(); ctx.arc(x,y,0.5+Math.random()*1.5,0,Math.PI*2);
      ctx.fillStyle=`rgba(180,130,70,${0.15+Math.random()*0.3})`; ctx.fill();
    }
    const sh=ctx.createRadialGradient(180,150,5,180,180,220);
    sh.addColorStop(0,'rgba(160,110,60,0.25)'); sh.addColorStop(1,'rgba(160,110,60,0)');
    ctx.fillStyle=sh; ctx.fillRect(0,0,400,400);
    return new THREE.CanvasTexture(c);
  }

  function makeQuinoaTex() {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const ctx = c.getContext('2d');
    ctx.fillStyle='#cfc0a0'; ctx.fillRect(0,0,256,256);
    for (let i=0;i<1200;i++) {
      const x=Math.random()*256,y=Math.random()*256,r=1+Math.random()*3.5;
      ctx.beginPath(); ctx.ellipse(x,y,r,r*0.6,Math.random()*Math.PI,0,Math.PI*2);
      ctx.fillStyle=`rgba(${Math.random()>0.5?'80,60,30':'220,200,160'},${0.2+Math.random()*0.4})`; ctx.fill();
    }
    const sp=ctx.createRadialGradient(80,60,2,80,80,120);
    sp.addColorStop(0,'rgba(255,245,220,0.5)'); sp.addColorStop(1,'rgba(255,245,220,0)');
    ctx.fillStyle=sp; ctx.fillRect(0,0,200,200);
    return new THREE.CanvasTexture(c);
  }

  function makeGingerTex() {
    const c = document.createElement('canvas'); c.width = c.height = 512;
    const ctx = c.getContext('2d');
    const g = ctx.createLinearGradient(0,0,512,512);
    g.addColorStop(0,'#d4a96a'); g.addColorStop(0.5,'#c08840'); g.addColorStop(1,'#8a6028');
    ctx.fillStyle=g; ctx.fillRect(0,0,512,512);
    for (let i=0;i<20;i++) {
      const x=(i/20)*512; ctx.beginPath(); ctx.moveTo(x,0);
      for (let y=0;y<=512;y+=6) ctx.lineTo(x+Math.sin(y/45+i*1.4)*9,y);
      ctx.strokeStyle=i%4===0?`rgba(80,44,8,0.3)`:`rgba(200,150,60,0.15)`; ctx.lineWidth=i%4===0?2:0.8; ctx.stroke();
    }
    for (let i=0;i<3500;i++) {
      const x=Math.random()*512,y=Math.random()*512;
      ctx.beginPath(); ctx.arc(x,y,0.5+Math.random()*2.5,0,Math.PI*2);
      ctx.fillStyle=`rgba(${Math.random()>0.5?'70,38,8':'220,170,80'},${0.06+Math.random()*0.16})`; ctx.fill();
    }
    const sh=ctx.createRadialGradient(190,150,5,190,190,240);
    sh.addColorStop(0,'rgba(240,200,120,0.28)'); sh.addColorStop(1,'rgba(240,200,120,0)');
    ctx.fillStyle=sh; ctx.fillRect(0,0,460,440);
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

  function buildBroccoli() {
    const g = new THREE.Group();
    const tex = makeBroccoliTex();
    const stemMat = new THREE.MeshStandardMaterial({ color: 0x4a9e40, roughness: 0.78, metalness: 0 });
    const floretMat = new THREE.MeshPhysicalMaterial({ map: tex, color: 0x1a5c22, roughness: 0.85, metalness: 0 });
    const darkFloretMat = new THREE.MeshStandardMaterial({ color: 0x0f3d16, roughness: 0.90, metalness: 0 });

    // Main stem
    const stemCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0,-1.5,0), new THREE.Vector3(0.04,-0.8,0.02), new THREE.Vector3(0,-0.2,0),
    ]);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(stemCurve,12,0.14,8,false), stemMat));

    // Branch forks
    const bOff = [[0.32,0.20,0.14],[-0.30,0.18,0.10],[0.18,0.28,-0.22],[-0.20,0.24,-0.18],[0.08,0.32,0.26],[-0.10,0.30,-0.24]];
    bOff.forEach(([x,y,z]) => {
      const bc = new THREE.CatmullRomCurve3([new THREE.Vector3(0,0,0), new THREE.Vector3(x*0.5,y*0.5,z*0.5), new THREE.Vector3(x,y,z)]);
      g.add(new THREE.Mesh(new THREE.TubeGeometry(bc,6,0.06,6,false), stemMat));
    });

    // Floret dome clusters
    const clusterPos = [[0,0.85,0],[0.32,0.68,0.14],[-0.30,0.66,0.10],[0.18,0.72,-0.22],[-0.20,0.70,-0.18],[0.08,0.78,0.26],[-0.10,0.76,-0.24]];
    clusterPos.forEach(([cx,cy,cz],ci) => {
      const r = ci===0 ? 0.42 : 0.28;
      for (let j=0;j<(ci===0?22:12);j++) {
        const theta=Math.random()*Math.PI*2, phi=Math.random()*Math.PI*0.55;
        const fr = r*(0.7+Math.random()*0.3);
        const fx=cx+fr*Math.sin(phi)*Math.cos(theta), fy=cy+fr*Math.cos(phi)*0.7, fz=cz+fr*Math.sin(phi)*Math.sin(theta);
        const fs = 0.08+Math.random()*0.10;
        const floret = new THREE.Mesh(new THREE.SphereGeometry(fs,8,6), j%5===0?darkFloretMat:floretMat);
        floret.position.set(fx,fy,fz);
        floret.castShadow = true;
        g.add(floret);
      }
    });

    g.scale.set(0.95,0.95,0.95);
    return g;
  }

  function buildAvocado() {
    const g = new THREE.Group();
    const tex = makeAvocadoTex();

    // Pear-shaped body via lathe
    const pts = [
      new THREE.Vector2(0.00,-1.28), new THREE.Vector2(0.12,-1.18), new THREE.Vector2(0.28,-0.98),
      new THREE.Vector2(0.46,-0.68), new THREE.Vector2(0.64,-0.30), new THREE.Vector2(0.80, 0.12),
      new THREE.Vector2(0.90, 0.52), new THREE.Vector2(0.88, 0.86), new THREE.Vector2(0.76, 1.10),
      new THREE.Vector2(0.52, 1.28), new THREE.Vector2(0.28, 1.38), new THREE.Vector2(0.00, 1.42),
    ];
    const body = new THREE.Mesh(new THREE.LatheGeometry(pts,64),
      new THREE.MeshPhysicalMaterial({ map: tex, roughness: 0.88, metalness: 0, clearcoat: 0.08, clearcoatRoughness: 0.6 })
    );
    body.scale.set(1,1,0.90);
    body.castShadow = body.receiveShadow = true;
    g.add(body);

    // Bumpy surface pebbles
    const bumpMat = new THREE.MeshStandardMaterial({ color: 0x1a3a1a, roughness: 0.95, metalness: 0 });
    for (let i=0;i<40;i++) {
      const theta=Math.random()*Math.PI*2, phi=0.3+Math.random()*Math.PI*0.65;
      const bump = new THREE.Mesh(new THREE.SphereGeometry(0.04+Math.random()*0.055,5,5), bumpMat);
      const r=0.82+Math.random()*0.08;
      bump.position.set(r*Math.sin(phi)*Math.cos(theta), -0.3+r*Math.cos(phi)*1.8, r*Math.sin(phi)*Math.sin(theta)*0.9);
      bump.scale.set(1,0.45,1);
      g.add(bump);
    }

    // Short stem
    const stemCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0,1.40,0), new THREE.Vector3(0.02,1.58,0.01), new THREE.Vector3(0.04,1.75,0),
    ]);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(stemCurve,6,0.038,6,false),
      new THREE.MeshStandardMaterial({ color: 0x2a1206, roughness: 0.96, metalness: 0 })
    ));
    return g;
  }

  function buildBlueberry() {
    const g = new THREE.Group();
    const tex = makeBlueberryTex();
    const berryMat = new THREE.MeshPhysicalMaterial({
      map: tex, color: 0x3d2e7c, roughness: 0.35, metalness: 0.04, clearcoat: 0.55, clearcoatRoughness: 0.20,
    });
    const calyxMat = new THREE.MeshStandardMaterial({ color: 0x1e145a, roughness: 0.70, metalness: 0 });

    const positions = [
      [0,0.18,0],[0.38,0,0.08],[-0.36,0.05,0.10],[0.18,0,-0.38],[-0.18,0.08,-0.36],
      [0.36,0.28,-0.10],[-0.30,0.30,-0.08],[0.08,0.28,0.38],
    ];
    positions.forEach(([x,y,z],i) => {
      const r = 0.24+Math.random()*0.08;
      const berry = new THREE.Mesh(new THREE.SphereGeometry(r,16,14), berryMat);
      berry.position.set(x,y,z);
      berry.castShadow = true;
      g.add(berry);

      // Tiny crown ring at top of each berry
      const crown = new THREE.Mesh(new THREE.TorusGeometry(r*0.28,0.014,4,10),
        new THREE.MeshStandardMaterial({ color: 0x0d0a30, roughness: 0.9 })
      );
      crown.position.set(x, y+r*0.75, z);
      crown.rotation.x = Math.PI/2;
      g.add(crown);
    });

    return g;
  }

  function buildSpinach() {
    const g = new THREE.Group();
    const tex = makeSpinachTex();
    const leafMat = new THREE.MeshStandardMaterial({
      map: tex, color: 0x1a5020, roughness: 0.80, metalness: 0,
      side: THREE.DoubleSide, transparent: true, opacity: 0.94,
    });
    const veinMat = new THREE.MeshStandardMaterial({ color: 0x0d3814, roughness: 0.85, metalness: 0 });

    const leafConfigs = [
      { ry:0,    rx:0.08, rz:0,    tx:0,    ty:-0.10, tz:0    },
      { ry:0.8,  rx:0.12, rz:0.15, tx:0.20, ty:-0.15, tz:0.10 },
      { ry:-0.7, rx:0.10, rz:-0.12,tx:-0.18,ty:-0.12, tz:0.08 },
      { ry:1.6,  rx:0.06, rz:0.20, tx:0.10, ty: 0.05, tz:-0.15},
      { ry:2.4,  rx:0.09, rz:-0.18,tx:-0.12,ty: 0.08, tz:-0.12},
      { ry:0.3,  rx:0.14, rz:0.10, tx:0.22, ty: 0.10, tz: 0.18},
    ];
    leafConfigs.forEach(({ ry, rx, rz, tx, ty, tz }) => {
      const leafShape = new THREE.Shape();
      leafShape.moveTo(0,0);
      leafShape.bezierCurveTo(0.10, 0.32, 0.40, 0.58, 0.62, 0.50);
      leafShape.bezierCurveTo(0.72, 0.42, 0.68, 0.16, 0.50, 0.02);
      leafShape.bezierCurveTo(0.32,-0.08, 0.08,-0.04, 0, 0);
      const leaf = new THREE.Mesh(new THREE.ShapeGeometry(leafShape,10), leafMat);
      leaf.position.set(tx-0.31, ty+0.10, tz);
      leaf.rotation.set(rx, ry, rz);
      leaf.castShadow = true;
      g.add(leaf);

      // Midrib vein
      const vein = new THREE.Mesh(
        new THREE.TubeGeometry(new THREE.LineCurve3(new THREE.Vector3(0,0,0.002), new THREE.Vector3(0.56,0.46,0.002)),5,0.008,4,false),
        veinMat
      );
      vein.position.set(tx-0.31, ty+0.10, tz+0.001);
      vein.rotation.set(rx, ry, rz);
      g.add(vein);
    });

    // Small stem cluster base
    const stemBase = new THREE.Mesh(new THREE.SphereGeometry(0.12,10,8),
      new THREE.MeshStandardMaterial({ color: 0x2a6a30, roughness: 0.88 })
    );
    stemBase.position.y = -0.22;
    g.add(stemBase);

    return g;
  }

  function buildGreekYogurt() {
    const g = new THREE.Group();
    const yogurtTex = makeYogurtTex();

    // Glass/ceramic bowl via lathe
    const bowlPts = [
      new THREE.Vector2(0.28,-0.20), new THREE.Vector2(0.60,-0.16), new THREE.Vector2(0.88,-0.04),
      new THREE.Vector2(1.02, 0.16), new THREE.Vector2(1.06, 0.44), new THREE.Vector2(1.04, 0.78),
      new THREE.Vector2(0.98, 0.96), new THREE.Vector2(0.90, 1.00),
    ];
    const bowl = new THREE.Mesh(new THREE.LatheGeometry(bowlPts,52),
      new THREE.MeshPhysicalMaterial({
        color: 0xfaf7f2, roughness: 0.12, metalness: 0.02,
        transparent: true, opacity: 0.72, clearcoat: 0.88, clearcoatRoughness: 0.08,
      })
    );
    bowl.castShadow = bowl.receiveShadow = true;
    g.add(bowl);

    // Yogurt fill (slightly inside bowl)
    const fillPts = [
      new THREE.Vector2(0.00, 0.60), new THREE.Vector2(0.30, 0.60), new THREE.Vector2(0.60, 0.60),
      new THREE.Vector2(0.85, 0.58), new THREE.Vector2(0.96, 0.55),
    ];
    const fill = new THREE.Mesh(new THREE.LatheGeometry(fillPts,48),
      new THREE.MeshPhysicalMaterial({
        map: yogurtTex, color: 0xfdfcf8, roughness: 0.14, metalness: 0, clearcoat: 0.50, clearcoatRoughness: 0.12,
      })
    );
    fill.position.y = 0;
    g.add(fill);

    // Surface ripple rings
    for (let i=1;i<=3;i++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(i*0.22, 0.006, 4, 40),
        new THREE.MeshStandardMaterial({ color: 0xe8e4dc, roughness: 0.55, metalness: 0 })
      );
      ring.rotation.x = Math.PI/2;
      ring.position.y = 0.60;
      g.add(ring);
    }

    // Bowl bottom disc
    const bowlBase = new THREE.Mesh(new THREE.CylinderGeometry(0.27,0.27,0.04,32),
      new THREE.MeshStandardMaterial({ color: 0xfaf7f2, roughness: 0.18, metalness: 0.02 })
    );
    bowlBase.position.y = -0.20;
    g.add(bowlBase);

    g.scale.set(0.90,0.90,0.90);
    return g;
  }

  function buildCarrot() {
    const g = new THREE.Group();
    const tex = makeCarrotTex();

    const pts = [
      new THREE.Vector2(0.00, 1.50), new THREE.Vector2(0.06, 1.40), new THREE.Vector2(0.14, 1.20),
      new THREE.Vector2(0.24, 0.90), new THREE.Vector2(0.34, 0.55), new THREE.Vector2(0.42, 0.15),
      new THREE.Vector2(0.46,-0.20), new THREE.Vector2(0.44,-0.55), new THREE.Vector2(0.38,-0.88),
      new THREE.Vector2(0.26,-1.12), new THREE.Vector2(0.10,-1.34), new THREE.Vector2(0.00,-1.48),
    ];
    const body = new THREE.Mesh(new THREE.LatheGeometry(pts,48),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.76, metalness: 0 })
    );
    body.castShadow = body.receiveShadow = true;
    g.add(body);

    // Surface root hairs (tiny bumps)
    const bumpMat = new THREE.MeshStandardMaterial({ color: 0xc05010, roughness: 0.85 });
    for (let i=0;i<8;i++) {
      const theta = (i/8)*Math.PI*2;
      const b = new THREE.Mesh(new THREE.SphereGeometry(0.03,4,4), bumpMat);
      b.position.set(Math.cos(theta)*0.43, -0.2+Math.random()*1.0, Math.sin(theta)*0.43);
      b.scale.set(1,0.4,1);
      g.add(b);
    }

    // Green leafy top — 4 feathery fronds
    const leafMat = new THREE.MeshStandardMaterial({ color: 0x2d7a30, roughness: 0.75, metalness: 0, side: THREE.DoubleSide });
    for (let i=0;i<4;i++) {
      const angle = (i/4)*Math.PI*2;
      const frondCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0,1.50,0),
        new THREE.Vector3(Math.cos(angle)*0.18, 1.96, Math.sin(angle)*0.18),
        new THREE.Vector3(Math.cos(angle)*0.34, 2.28, Math.sin(angle)*0.34),
        new THREE.Vector3(Math.cos(angle)*0.28, 2.56, Math.sin(angle)*0.28),
      ]);
      g.add(new THREE.Mesh(new THREE.TubeGeometry(frondCurve,8,0.018,5,false), leafMat));
      // Side leaflets
      for (let j=1;j<=3;j++) {
        const lf = new THREE.Mesh(
          new THREE.CylinderGeometry(0.005,0.005,0.22,4),
          leafMat
        );
        const tp = frondCurve.getPointAt(j*0.28);
        lf.position.copy(tp);
        lf.rotation.z = Math.PI/2 + angle + (j%2?0.4:-0.4);
        g.add(lf);
      }
    }
    g.rotation.z = 0.10;
    return g;
  }

  function buildOats() {
    const g = new THREE.Group();
    const tex = makeOatsTex();

    // Bowl via lathe
    const bowlPts = [
      new THREE.Vector2(0.22,-0.22), new THREE.Vector2(0.56,-0.18), new THREE.Vector2(0.84,-0.04),
      new THREE.Vector2(0.98, 0.20), new THREE.Vector2(1.04, 0.52), new THREE.Vector2(1.02, 0.80),
      new THREE.Vector2(0.94, 0.96), new THREE.Vector2(0.84, 1.00),
    ];
    const bowl = new THREE.Mesh(new THREE.LatheGeometry(bowlPts,48),
      new THREE.MeshStandardMaterial({ color: 0xfaf6ee, roughness: 0.45, metalness: 0.02 })
    );
    bowl.castShadow = bowl.receiveShadow = true;
    g.add(bowl);

    // Oatmeal surface — bumpy textured disc
    const oatSurf = new THREE.Mesh(new THREE.CylinderGeometry(0.92,0.92,0.08,40),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 })
    );
    oatSurf.position.y = 0.62;
    g.add(oatSurf);

    // Individual oat flake bumps on surface
    const flakeMat = new THREE.MeshStandardMaterial({ color: 0xd4b87a, roughness: 0.88, metalness: 0 });
    for (let i=0;i<55;i++) {
      const r = Math.random()*0.82;
      const theta = Math.random()*Math.PI*2;
      const flake = new THREE.Mesh(new THREE.SphereGeometry(0.04+Math.random()*0.06,5,4), flakeMat);
      flake.position.set(Math.cos(theta)*r, 0.68+Math.random()*0.06, Math.sin(theta)*r);
      flake.scale.set(1.4,0.35,0.9);
      flake.rotation.y = Math.random()*Math.PI;
      g.add(flake);
    }

    // Bowl base
    const oatBase = new THREE.Mesh(new THREE.CylinderGeometry(0.22,0.22,0.06,28),
      new THREE.MeshStandardMaterial({ color: 0xf8f4ec, roughness: 0.48 })
    );
    oatBase.position.y = -0.22;
    g.add(oatBase);

    g.scale.set(0.88,0.88,0.88);
    return g;
  }

  function buildLemon() {
    const g = new THREE.Group();
    const tex = makeLemonTex();

    // Oval lemon body
    const pts = [
      new THREE.Vector2(0.00,-1.10), new THREE.Vector2(0.16,-1.04), new THREE.Vector2(0.38,-0.88),
      new THREE.Vector2(0.58,-0.62), new THREE.Vector2(0.72,-0.30), new THREE.Vector2(0.78, 0.02),
      new THREE.Vector2(0.76, 0.34), new THREE.Vector2(0.66, 0.64), new THREE.Vector2(0.50, 0.86),
      new THREE.Vector2(0.30, 1.00), new THREE.Vector2(0.10, 1.06), new THREE.Vector2(0.00, 1.08),
    ];
    const body = new THREE.Mesh(new THREE.LatheGeometry(pts,64),
      new THREE.MeshPhysicalMaterial({
        map: tex, color: 0xfde047, roughness: 0.22, metalness: 0,
        clearcoat: 0.68, clearcoatRoughness: 0.12,
      })
    );
    body.scale.set(1,1,0.88);
    body.castShadow = body.receiveShadow = true;
    g.add(body);

    // Nipple bumps at each end
    const nubMat = new THREE.MeshPhysicalMaterial({ color: 0xeac000, roughness: 0.50, clearcoat: 0.4 });
    const nub1 = new THREE.Mesh(new THREE.SphereGeometry(0.14,12,12), nubMat);
    nub1.position.y = 1.02; nub1.scale.set(0.7,0.55,0.7); g.add(nub1);
    const nub2 = new THREE.Mesh(new THREE.SphereGeometry(0.10,10,10), nubMat);
    nub2.position.y = -1.06; nub2.scale.set(0.65,0.48,0.65); g.add(nub2);

    g.rotation.z = 0.25;
    return g;
  }

  function buildWalnut() {
    const g = new THREE.Group();
    const tex = makeWalnutTex();
    const shellMat = new THREE.MeshStandardMaterial({ map: tex, color: 0x7a5020, roughness: 0.84, metalness: 0 });
    const innerMat = new THREE.MeshStandardMaterial({ color: 0xd4943a, roughness: 0.72, metalness: 0 });
    const ridgeMat = new THREE.MeshStandardMaterial({ color: 0x3a1e06, roughness: 0.96, metalness: 0 });

    // Two half-shells
    [-1,1].forEach(side => {
      const half = new THREE.Mesh(new THREE.SphereGeometry(0.72,40,32,0,Math.PI*2,0,Math.PI*0.5), shellMat);
      half.rotation.x = side > 0 ? 0 : Math.PI;
      half.position.set(side*0.04, 0, 0);
      half.scale.set(1.0, 0.75, 0.86);
      half.castShadow = true;
      g.add(half);

      // Inner brain-lobe ridges
      for (let i=0;i<14;i++) {
        const theta=(i/14)*Math.PI*2, r=0.46+Math.random()*0.14;
        const ridge = new THREE.Mesh(new THREE.TorusGeometry(r*0.25,0.026,4,12,Math.PI*0.55), innerMat);
        ridge.position.set(side*0.04+Math.cos(theta)*r*0.35, -0.05+Math.sin(theta)*r*0.28, Math.cos(theta*0.7)*0.22);
        ridge.rotation.set(Math.random()*Math.PI, Math.random()*Math.PI, Math.random()*Math.PI);
        ridge.scale.set(0.86,0.70,0.86);
        g.add(ridge);
      }
    });

    // Central seam ridge line
    const seamCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.72,0,0), new THREE.Vector3(-0.36,0.06,0.22), new THREE.Vector3(0,0.08,0.26),
      new THREE.Vector3(0.36,0.06,0.22), new THREE.Vector3(0.72,0,0),
    ]);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(seamCurve,16,0.018,6,false), ridgeMat));

    g.rotation.z = 0.18;
    return g;
  }

  function buildTomato() {
    const g = new THREE.Group();
    const tex = makeTomatoTex();

    // Body — sphere with slight squash
    const body = new THREE.Mesh(new THREE.SphereGeometry(1.02,64,48),
      new THREE.MeshPhysicalMaterial({
        map: tex, color: 0xdc2626, roughness: 0.18, metalness: 0,
        clearcoat: 0.85, clearcoatRoughness: 0.08,
      })
    );
    body.scale.set(1,0.86,1);
    body.castShadow = body.receiveShadow = true;
    g.add(body);

    // Top dimple
    const dimple = new THREE.Mesh(new THREE.SphereGeometry(0.22,14,14),
      new THREE.MeshStandardMaterial({ color: 0x8b1010, roughness: 0.55, metalness: 0 })
    );
    dimple.position.y = 0.80; dimple.scale.set(1,0.30,1); g.add(dimple);

    // Green star calyx (5 petals)
    const calyxMat = new THREE.MeshStandardMaterial({ color: 0x2d6e2a, roughness: 0.72, metalness: 0, side: THREE.DoubleSide });
    for (let i=0;i<5;i++) {
      const angle = (i/5)*Math.PI*2;
      const petalShape = new THREE.Shape();
      petalShape.moveTo(0,0);
      petalShape.bezierCurveTo(0.05,0.12, 0.04,0.28, 0.00,0.38);
      petalShape.bezierCurveTo(-0.04,0.28,-0.05,0.12, 0,0);
      const petal = new THREE.Mesh(new THREE.ShapeGeometry(petalShape,6), calyxMat);
      petal.position.set(Math.cos(angle)*0.18, 0.82, Math.sin(angle)*0.18);
      petal.rotation.set(-0.30, angle, 0);
      g.add(petal);
    }

    // Tiny stem
    const tomatoStem = new THREE.Mesh(new THREE.CylinderGeometry(0.026,0.032,0.28,6),
      new THREE.MeshStandardMaterial({ color: 0x1a4a18, roughness: 0.90 })
    );
    tomatoStem.position.y = 0.92;
    g.add(tomatoStem);

    return g;
  }

  function buildGarlic() {
    const g = new THREE.Group();
    const tex = makeGarlicTex();
    const bulbMat = new THREE.MeshPhysicalMaterial({
      map: tex, color: 0xf5f0dc, roughness: 0.68, metalness: 0, clearcoat: 0.14, clearcoatRoughness: 0.55,
    });
    const cloveMat = new THREE.MeshStandardMaterial({ color: 0xf0e8c8, roughness: 0.72, metalness: 0 });
    const paperyMat = new THREE.MeshStandardMaterial({ color: 0xeae0c0, roughness: 0.90, metalness: 0, side: THREE.DoubleSide });

    // Central main bulb
    const main = new THREE.Mesh(new THREE.SphereGeometry(0.72,32,28), bulbMat);
    main.scale.set(1,0.88,1); main.castShadow = main.receiveShadow = true; g.add(main);

    // 5 surrounding cloves
    for (let i=0;i<5;i++) {
      const angle = (i/5)*Math.PI*2;
      const r = 0.66;
      const clove = new THREE.Mesh(new THREE.SphereGeometry(0.30,16,14), cloveMat);
      clove.position.set(Math.cos(angle)*r, -0.10, Math.sin(angle)*r);
      clove.scale.set(0.88,1.18,0.88);
      clove.castShadow = true;
      g.add(clove);
      // Papery skin flap
      const papery = new THREE.Mesh(new THREE.SphereGeometry(0.32,10,8), paperyMat);
      papery.position.copy(clove.position);
      papery.scale.set(0.94,1.24,0.94);
      papery.material = new THREE.MeshStandardMaterial({
        color: 0xe8dfc0, roughness: 0.95, transparent: true, opacity: 0.55, side: THREE.DoubleSide
      });
      g.add(papery);
    }

    // Dried root hairs at base
    const rootMat = new THREE.MeshStandardMaterial({ color: 0xbba870, roughness: 0.98 });
    for (let i=0;i<8;i++) {
      const angle=(i/8)*Math.PI*2;
      const rootCurve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(0,-0.68,0),
        new THREE.Vector3(Math.cos(angle)*0.15,-0.88,Math.sin(angle)*0.15),
        new THREE.Vector3(Math.cos(angle)*0.22,-1.06,Math.sin(angle)*0.22),
      ]);
      g.add(new THREE.Mesh(new THREE.TubeGeometry(rootCurve,5,0.012,4,false), rootMat));
    }

    // Short top stem stub
    const garlicTop = new THREE.Mesh(new THREE.CylinderGeometry(0.10,0.14,0.32,8),
      new THREE.MeshStandardMaterial({ color: 0xd4c898, roughness: 0.90 })
    );
    garlicTop.position.y = 0.84;
    g.add(garlicTop);

    return g;
  }

  function buildDarkChocolate() {
    const g = new THREE.Group();
    const tex = makeChocolateTex();
    const chocMat = new THREE.MeshPhysicalMaterial({
      map: tex, color: 0x3d1a06, roughness: 0.28, metalness: 0.04,
      clearcoat: 0.72, clearcoatRoughness: 0.10,
    });
    const darkGroove = new THREE.MeshStandardMaterial({ color: 0x1a0a02, roughness: 0.65, metalness: 0 });

    // Main bar block
    const bar = new THREE.Mesh(new THREE.BoxGeometry(2.20, 0.28, 1.40), chocMat);
    bar.castShadow = bar.receiveShadow = true; g.add(bar);

    // Square panel divisions (4×3 grid = 12 squares)
    const cols=4, rows=3;
    const pw=2.20/cols, ph=1.40/rows;
    for (let ci=0;ci<cols-1;ci++) {
      const groove = new THREE.Mesh(new THREE.BoxGeometry(0.032,0.32,1.40), darkGroove);
      groove.position.set(-1.10+pw*(ci+1), 0, 0); g.add(groove);
    }
    for (let ri=0;ri<rows-1;ri++) {
      const groove = new THREE.Mesh(new THREE.BoxGeometry(2.20,0.32,0.030), darkGroove);
      groove.position.set(0, 0, -0.70+ph*(ri+1)); g.add(groove);
    }

    // Slight chamfer edge highlight
    const edgeMat = new THREE.MeshStandardMaterial({ color: 0x5a2d0c, roughness: 0.40, metalness: 0 });
    const chamferH = new THREE.Mesh(new THREE.BoxGeometry(2.24,0.08,0.04), edgeMat);
    chamferH.position.set(0,0.14,0.70); g.add(chamferH);
    const chamferH2 = chamferH.clone(); chamferH2.position.set(0,0.14,-0.70); g.add(chamferH2);

    // Tilt slightly
    g.rotation.x = -0.18; g.rotation.z = 0.08;
    return g;
  }

  function buildKiwi() {
    const g = new THREE.Group();
    const tex = makeKiwiTex();

    // Oval fuzzy exterior via lathe
    const pts = [
      new THREE.Vector2(0.00,-0.98), new THREE.Vector2(0.18,-0.90), new THREE.Vector2(0.38,-0.72),
      new THREE.Vector2(0.56,-0.45), new THREE.Vector2(0.66,-0.14), new THREE.Vector2(0.68, 0.16),
      new THREE.Vector2(0.62, 0.46), new THREE.Vector2(0.50, 0.70), new THREE.Vector2(0.32, 0.88),
      new THREE.Vector2(0.12, 0.96), new THREE.Vector2(0.00, 0.98),
    ];
    const body = new THREE.Mesh(new THREE.LatheGeometry(pts,56),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.92, metalness: 0 })
    );
    body.scale.set(1,1,0.88);
    body.castShadow = body.receiveShadow = true;
    g.add(body);

    // Fuzz bumps on surface
    const fuzzMat = new THREE.MeshStandardMaterial({ color: 0x5c3c1a, roughness: 0.98, metalness: 0 });
    for (let i=0;i<80;i++) {
      const theta=Math.random()*Math.PI*2, phi=0.25+Math.random()*Math.PI*0.55;
      const fuzz = new THREE.Mesh(new THREE.CylinderGeometry(0.008,0.004,0.045,3), fuzzMat);
      fuzz.position.set(Math.sin(phi)*Math.cos(theta)*0.69, Math.cos(phi)*0.97, Math.sin(phi)*Math.sin(theta)*0.62);
      fuzz.lookAt(fuzz.position.clone().multiplyScalar(2));
      g.add(fuzz);
    }

    // Light brown end caps
    const capMat = new THREE.MeshStandardMaterial({ color: 0x4a2c0e, roughness: 0.88 });
    const cap1 = new THREE.Mesh(new THREE.SphereGeometry(0.14,10,8), capMat);
    cap1.position.y = 0.94; cap1.scale.set(1,0.5,1); g.add(cap1);
    const cap2 = new THREE.Mesh(new THREE.SphereGeometry(0.12,10,8), capMat);
    cap2.position.y = -0.94; cap2.scale.set(1,0.48,1); g.add(cap2);

    g.rotation.z = 0.22;
    return g;
  }

  function buildQuinoa() {
    const g = new THREE.Group();
    const tex = makeQuinoaTex();

    // Bowl
    const bowlPts = [
      new THREE.Vector2(0.24,-0.18), new THREE.Vector2(0.58,-0.14), new THREE.Vector2(0.86,-0.02),
      new THREE.Vector2(1.00, 0.18), new THREE.Vector2(1.06, 0.46), new THREE.Vector2(1.04, 0.76),
      new THREE.Vector2(0.98, 0.90), new THREE.Vector2(0.90, 0.94),
    ];
    const bowl = new THREE.Mesh(new THREE.LatheGeometry(bowlPts,48),
      new THREE.MeshStandardMaterial({ color: 0xe8d8b8, roughness: 0.60, metalness: 0 })
    );
    bowl.castShadow = bowl.receiveShadow = true; g.add(bowl);

    // Flat grain surface
    const surf = new THREE.Mesh(new THREE.CylinderGeometry(0.90,0.90,0.06,36),
      new THREE.MeshStandardMaterial({ map: tex, roughness: 0.94, metalness: 0 })
    );
    surf.position.y = 0.58; g.add(surf);

    // Individual grain pebbles
    const grainMat = new THREE.MeshStandardMaterial({ color: 0xd4c090, roughness: 0.90 });
    const grainMat2 = new THREE.MeshStandardMaterial({ color: 0xf0e0b0, roughness: 0.88 });
    for (let i=0;i<120;i++) {
      const r = Math.random()*0.78;
      const theta = Math.random()*Math.PI*2;
      const grain = new THREE.Mesh(new THREE.SphereGeometry(0.028+Math.random()*0.022,5,4), i%3===0?grainMat2:grainMat);
      grain.position.set(Math.cos(theta)*r, 0.64+Math.random()*0.08, Math.sin(theta)*r);
      grain.scale.set(1,0.7+Math.random()*0.5,1);
      g.add(grain);
    }

    const quinoaBase = new THREE.Mesh(new THREE.CylinderGeometry(0.24,0.24,0.04,28),
      new THREE.MeshStandardMaterial({ color: 0xe8d8b8, roughness: 0.60 })
    );
    quinoaBase.position.y = -0.18;
    g.add(quinoaBase);

    g.scale.set(0.86,0.86,0.86);
    return g;
  }

  function buildGinger() {
    const g = new THREE.Group();
    const tex = makeGingerTex();
    const rootMat = new THREE.MeshStandardMaterial({ map: tex, color: 0xc89050, roughness: 0.80, metalness: 0 });
    const nodeMat = new THREE.MeshStandardMaterial({ color: 0xb87840, roughness: 0.84, metalness: 0 });

    // Main body — irregular elongated knob
    const mainCurve = new THREE.CatmullRomCurve3([
      new THREE.Vector3(-0.80,-0.08,0), new THREE.Vector3(-0.28, 0.06,0.08),
      new THREE.Vector3( 0.22, 0.10,0), new THREE.Vector3( 0.80,-0.04,0),
    ]);
    g.add(new THREE.Mesh(new THREE.TubeGeometry(mainCurve,20,0.30,10,false), rootMat));

    // Side knobs (the characteristic ginger fingers)
    const knobs = [
      { pos: [-0.42, 0.30, 0.10], dir: [0.08, 0.86, 0.04], len: 0.55 },
      { pos: [ 0.38, 0.30,-0.10], dir: [-0.04, 0.88,-0.04], len: 0.50 },
      { pos: [-0.70, 0.10, 0.28], dir: [-0.12, 0.80, 0.16], len: 0.42 },
      { pos: [ 0.62, 0.10,-0.24], dir: [ 0.08, 0.82,-0.12], len: 0.40 },
    ];
    knobs.forEach(({ pos, dir, len }) => {
      const kc = new THREE.CatmullRomCurve3([
        new THREE.Vector3(...pos),
        new THREE.Vector3(pos[0]+dir[0]*len*0.5, pos[1]+dir[1]*len*0.5, pos[2]+dir[2]*len*0.5),
        new THREE.Vector3(pos[0]+dir[0]*len, pos[1]+dir[1]*len, pos[2]+dir[2]*len),
      ]);
      g.add(new THREE.Mesh(new THREE.TubeGeometry(kc,10,0.18,8,false), nodeMat));

      // Rounded tip on each knob
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.18,10,8), nodeMat);
      tip.position.set(pos[0]+dir[0]*len, pos[1]+dir[1]*len, pos[2]+dir[2]*len);
      g.add(tip);
    });

    // Fibrous hair roots
    const rootHairMat = new THREE.MeshStandardMaterial({ color: 0x9a6830, roughness: 0.97 });
    for (let i=0;i<12;i++) {
      const x=(Math.random()-0.5)*1.4, y=-0.30+Math.random()*0.10, z=(Math.random()-0.5)*0.5;
      const hc = new THREE.CatmullRomCurve3([
        new THREE.Vector3(x,y,z),
        new THREE.Vector3(x+(Math.random()-0.5)*0.18, y-0.18, z+(Math.random()-0.5)*0.14),
        new THREE.Vector3(x+(Math.random()-0.5)*0.24, y-0.34, z+(Math.random()-0.5)*0.18),
      ]);
      g.add(new THREE.Mesh(new THREE.TubeGeometry(hc,5,0.008,4,false), rootHairMat));
    }

    g.position.y = 0.10;
    g.rotation.z = -0.14;
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
    broccoli: buildBroccoli, avocado: buildAvocado, blueberry: buildBlueberry,
    spinach: buildSpinach, greekyogurt: buildGreekYogurt, carrot: buildCarrot,
    oats: buildOats, lemon: buildLemon, walnut: buildWalnut,
    tomato: buildTomato, garlic: buildGarlic, darkchocolate: buildDarkChocolate,
    kiwi: buildKiwi, quinoa: buildQuinoa, ginger: buildGinger,
  };
  const PARTICLE_COLORS = {
    apple: 0xff4422, banana: 0xf5c600,
    chicken: 0xf0c080, fish: 0x60a5fa, almond: 0xd4b060,
    egg: 0xfffce8, sweetpotato: 0xff6820,
    broccoli: 0x22c55e, avocado: 0x4ade80, blueberry: 0x818cf8,
    spinach: 0x16a34a, greekyogurt: 0xf0ede6, carrot: 0xf97316,
    oats: 0xd4a853, lemon: 0xfde047, walnut: 0xa07040,
    tomato: 0xef4444, garlic: 0xf5f0dc, darkchocolate: 0x7c3f1a,
    kiwi: 0x86efac, quinoa: 0xd4c5a0, ginger: 0xc8a96e,
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
