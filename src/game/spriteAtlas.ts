import * as THREE from 'three/webgpu';

export type AtlasId =
  | 'pineTall' | 'pineShort'
  | 'deciduousRound' | 'deciduousTall'
  | 'barn' | 'silo' | 'fencePost' | 'haystack'
  | 'cottage' | 'cottageLit'
  | 'lighthouse' | 'lighthouseLit'
  | 'sailboat'
  | 'reeds' | 'cattail'
  | 'birdA' | 'birdB' | 'birdC'
  | 'seabirdA' | 'seabirdB' | 'seabirdC'
  | 'cloudSmall' | 'cloudMed' | 'cloudLarge'
  | 'hotAirBalloon'
  | 'shootingStarTrail'
  | 'whaleSpout' | 'whaleTail';

export interface AtlasEntry {
  rect: THREE.Vector4;       // u0, v0, u1, v1 in [0,1]
  anchor: THREE.Vector2;     // 0..1 within rect; bottom-center for ground sprites
  pxSize: THREE.Vector2;
}

export class SpriteAtlas {
  readonly texture: THREE.CanvasTexture;
  readonly entries: Record<AtlasId, AtlasEntry>;
  readonly size = 1024;

  constructor() {
    const canvas = document.createElement('canvas');
    canvas.width = this.size;
    canvas.height = this.size;
    const ctx = canvas.getContext('2d')!;
    this.entries = this.draw(ctx);
    this.texture = new THREE.CanvasTexture(canvas);
    this.texture.minFilter = THREE.LinearMipmapLinearFilter;
    this.texture.magFilter = THREE.LinearFilter;
    this.texture.colorSpace = THREE.SRGBColorSpace;
    this.texture.needsUpdate = true;
  }

  private draw(ctx: CanvasRenderingContext2D): Record<AtlasId, AtlasEntry> {
    const cell = 128;
    ctx.clearRect(0, 0, this.size, this.size);

    type Spec = {
      id: AtlasId;
      draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void;
      anchor?: [number, number];
    };
    const specs: Spec[] = [
      { id: 'pineTall',          draw: drawPineTall },
      { id: 'pineShort',         draw: drawPineShort },
      { id: 'deciduousRound',    draw: drawDeciduousRound },
      { id: 'deciduousTall',    draw: drawDeciduousTall },
      { id: 'barn',              draw: drawBarn },
      { id: 'silo',              draw: drawSilo },
      { id: 'fencePost',         draw: drawFencePost },
      { id: 'haystack',          draw: drawHaystack },
      { id: 'cottage',           draw: (c, w, h) => drawCottage(c, w, h, false) },
      { id: 'cottageLit',        draw: (c, w, h) => drawCottage(c, w, h, true) },
      { id: 'lighthouse',        draw: (c, w, h) => drawLighthouse(c, w, h, false) },
      { id: 'lighthouseLit',     draw: (c, w, h) => drawLighthouse(c, w, h, true) },
      { id: 'sailboat',          draw: drawSailboat },
      { id: 'reeds',             draw: drawReeds },
      { id: 'cattail',           draw: drawCattail },
      { id: 'birdA',             draw: (c, w, h) => drawBird(c, w, h, 0, false), anchor: [0.5, 0.5] },
      { id: 'birdB',             draw: (c, w, h) => drawBird(c, w, h, 1, false), anchor: [0.5, 0.5] },
      { id: 'birdC',             draw: (c, w, h) => drawBird(c, w, h, 2, false), anchor: [0.5, 0.5] },
      { id: 'seabirdA',          draw: (c, w, h) => drawBird(c, w, h, 0, true),  anchor: [0.5, 0.5] },
      { id: 'seabirdB',          draw: (c, w, h) => drawBird(c, w, h, 1, true),  anchor: [0.5, 0.5] },
      { id: 'seabirdC',          draw: (c, w, h) => drawBird(c, w, h, 2, true),  anchor: [0.5, 0.5] },
      { id: 'cloudSmall',        draw: (c, w, h) => drawCloud(c, w, h, 0.6),     anchor: [0.5, 0.5] },
      { id: 'cloudMed',          draw: (c, w, h) => drawCloud(c, w, h, 0.85),    anchor: [0.5, 0.5] },
      { id: 'cloudLarge',        draw: (c, w, h) => drawCloud(c, w, h, 1.0),     anchor: [0.5, 0.5] },
      { id: 'hotAirBalloon',     draw: drawHotAirBalloon, anchor: [0.5, 0.5] },
      { id: 'shootingStarTrail', draw: drawShootingStarTrail, anchor: [0.5, 0.5] },
      { id: 'whaleSpout',        draw: drawWhaleSpout, anchor: [0.5, 1.0] },
      { id: 'whaleTail',         draw: drawWhaleTail, anchor: [0.5, 1.0] },
    ];

    const entries = {} as Record<AtlasId, AtlasEntry>;
    specs.forEach((spec, i) => {
      const cx = (i % 8) * cell;
      const cy = Math.floor(i / 8) * cell;
      ctx.save();
      ctx.translate(cx, cy);
      spec.draw(ctx, cell, cell);
      ctx.restore();
      entries[spec.id] = {
        rect: new THREE.Vector4(cx / this.size, cy / this.size, (cx + cell) / this.size, (cy + cell) / this.size),
        anchor: new THREE.Vector2(spec.anchor?.[0] ?? 0.5, spec.anchor?.[1] ?? 1.0),
        pxSize: new THREE.Vector2(cell, cell),
      };
    });
    return entries;
  }
}

// ─────────────── generators ───────────────
// All draw a white silhouette (color comes from shader tint at render time).

function drawPineTall(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(w * 0.46, h * 0.78, w * 0.08, h * 0.22);
  for (let i = 0; i < 4; i += 1) {
    const yTop = h * (0.06 + i * 0.18);
    const yBot = h * (0.30 + i * 0.18);
    const halfW = w * (0.10 + i * 0.07);
    ctx.beginPath();
    ctx.moveTo(w * 0.5, yTop);
    ctx.lineTo(w * 0.5 - halfW, yBot);
    ctx.lineTo(w * 0.5 + halfW, yBot);
    ctx.closePath();
    ctx.fill();
  }
}

function drawPineShort(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(w * 0.46, h * 0.84, w * 0.08, h * 0.16);
  for (let i = 0; i < 2; i += 1) {
    const yTop = h * (0.30 + i * 0.22);
    const yBot = h * (0.58 + i * 0.22);
    const halfW = w * (0.16 + i * 0.06);
    ctx.beginPath();
    ctx.moveTo(w * 0.5, yTop);
    ctx.lineTo(w * 0.5 - halfW, yBot);
    ctx.lineTo(w * 0.5 + halfW, yBot);
    ctx.closePath();
    ctx.fill();
  }
}

function drawDeciduousRound(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(w * 0.46, h * 0.74, w * 0.08, h * 0.26);
  // overlapping circles for canopy
  const blobs: Array<[number, number, number]> = [
    [0.50, 0.42, 0.30],
    [0.36, 0.50, 0.22],
    [0.64, 0.50, 0.22],
    [0.46, 0.30, 0.18],
    [0.58, 0.32, 0.18],
  ];
  for (const [cx, cy, r] of blobs) {
    ctx.beginPath();
    ctx.arc(w * cx, h * cy, w * r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawDeciduousTall(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(w * 0.47, h * 0.66, w * 0.06, h * 0.34);
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 0.40, w * 0.20, h * 0.36, 0, 0, Math.PI * 2);
  ctx.fill();
}

function drawBarn(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#ffffff';
  // Body
  ctx.beginPath();
  ctx.moveTo(w * 0.18, h * 1.00);
  ctx.lineTo(w * 0.18, h * 0.55);
  ctx.lineTo(w * 0.50, h * 0.30);
  ctx.lineTo(w * 0.82, h * 0.55);
  ctx.lineTo(w * 0.82, h * 1.00);
  ctx.closePath();
  ctx.fill();
  // Door cut-out — draw in dark to "cut" the silhouette via composite
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';
  ctx.fillStyle = '#000';
  ctx.fillRect(w * 0.42, h * 0.72, w * 0.16, h * 0.28);
  ctx.restore();
}

function drawSilo(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(w * 0.40, h * 0.30, w * 0.20, h * 0.70);
  ctx.beginPath();
  ctx.arc(w * 0.5, h * 0.30, w * 0.10, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
}

function drawFencePost(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(w * 0.48, h * 0.45, w * 0.04, h * 0.55);
  ctx.fillRect(w * 0.30, h * 0.58, w * 0.40, h * 0.04);
  ctx.fillRect(w * 0.30, h * 0.78, w * 0.40, h * 0.04);
}

function drawHaystack(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 1.00, w * 0.36, h * 0.45, 0, Math.PI, 0);
  ctx.closePath();
  ctx.fill();
}

function drawCottage(ctx: CanvasRenderingContext2D, w: number, h: number, lit: boolean): void {
  ctx.fillStyle = '#ffffff';
  // Body
  ctx.fillRect(w * 0.20, h * 0.55, w * 0.60, h * 0.45);
  // Roof
  ctx.beginPath();
  ctx.moveTo(w * 0.16, h * 0.55);
  ctx.lineTo(w * 0.50, h * 0.30);
  ctx.lineTo(w * 0.84, h * 0.55);
  ctx.closePath();
  ctx.fill();
  // Chimney
  ctx.fillRect(w * 0.66, h * 0.32, w * 0.07, h * 0.16);
  if (lit) {
    ctx.fillStyle = '#ffd58a';
    ctx.fillRect(w * 0.30, h * 0.66, w * 0.12, h * 0.14);
    ctx.fillRect(w * 0.58, h * 0.66, w * 0.12, h * 0.14);
  }
}

function drawLighthouse(ctx: CanvasRenderingContext2D, w: number, h: number, lit: boolean): void {
  ctx.fillStyle = '#ffffff';
  // Tapered tower
  ctx.beginPath();
  ctx.moveTo(w * 0.42, h * 1.00);
  ctx.lineTo(w * 0.46, h * 0.30);
  ctx.lineTo(w * 0.54, h * 0.30);
  ctx.lineTo(w * 0.58, h * 1.00);
  ctx.closePath();
  ctx.fill();
  // Cap
  ctx.fillRect(w * 0.40, h * 0.20, w * 0.20, h * 0.10);
  ctx.beginPath();
  ctx.moveTo(w * 0.40, h * 0.20);
  ctx.lineTo(w * 0.50, h * 0.06);
  ctx.lineTo(w * 0.60, h * 0.20);
  ctx.closePath();
  ctx.fill();
  if (lit) {
    ctx.fillStyle = '#ffe28a';
    ctx.beginPath();
    ctx.arc(w * 0.5, h * 0.25, w * 0.05, 0, Math.PI * 2);
    ctx.fill();
    // Soft glow streak
    const g = ctx.createLinearGradient(0, h * 0.25, w, h * 0.25);
    g.addColorStop(0.0, 'rgba(255,226,138,0)');
    g.addColorStop(0.5, 'rgba(255,226,138,0.6)');
    g.addColorStop(1.0, 'rgba(255,226,138,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, h * 0.22, w, h * 0.06);
  }
}

function drawSailboat(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#ffffff';
  // Sail
  ctx.beginPath();
  ctx.moveTo(w * 0.50, h * 0.20);
  ctx.lineTo(w * 0.50, h * 0.70);
  ctx.lineTo(w * 0.78, h * 0.70);
  ctx.closePath();
  ctx.fill();
  // Hull arc
  ctx.beginPath();
  ctx.moveTo(w * 0.30, h * 0.72);
  ctx.quadraticCurveTo(w * 0.50, h * 0.92, w * 0.84, h * 0.72);
  ctx.lineTo(w * 0.30, h * 0.72);
  ctx.closePath();
  ctx.fill();
}

function drawReeds(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  const stalks = 7;
  for (let i = 0; i < stalks; i += 1) {
    const x = w * (0.18 + (i / (stalks - 1)) * 0.64);
    const top = h * (0.30 + Math.abs(Math.sin(i * 1.7)) * 0.25);
    ctx.beginPath();
    ctx.moveTo(x, h * 1.00);
    ctx.lineTo(x + (i % 2 ? 2 : -2), top);
    ctx.stroke();
  }
}

function drawCattail(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  drawReeds(ctx, w, h);
  ctx.fillStyle = '#ffffff';
  // tips on the middle two stalks
  const positions: Array<[number, number]> = [[w * 0.42, h * 0.32], [w * 0.58, h * 0.36]];
  for (const [x, y] of positions) {
    ctx.beginPath();
    ctx.ellipse(x, y, w * 0.04, h * 0.10, 0, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawBird(ctx: CanvasRenderingContext2D, w: number, h: number, frame: 0 | 1 | 2, sea: boolean): void {
  ctx.fillStyle = '#ffffff';
  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = sea ? 4 : 3;
  ctx.lineCap = 'round';
  // Body
  ctx.beginPath();
  ctx.arc(w * 0.5, h * 0.5, sea ? 4 : 3, 0, Math.PI * 2);
  ctx.fill();
  const span = sea ? 0.32 : 0.26;
  const lift = frame === 0 ? -0.18 : frame === 1 ? -0.04 : 0.10;
  ctx.beginPath();
  ctx.moveTo(w * 0.5, h * 0.5);
  ctx.quadraticCurveTo(w * (0.5 - span * 0.5), h * (0.5 + lift), w * (0.5 - span), h * 0.5);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(w * 0.5, h * 0.5);
  ctx.quadraticCurveTo(w * (0.5 + span * 0.5), h * (0.5 + lift), w * (0.5 + span), h * 0.5);
  ctx.stroke();
}

function drawCloud(ctx: CanvasRenderingContext2D, w: number, h: number, scale: number): void {
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  const blobs: Array<[number, number, number]> = [
    [0.50, 0.55, 0.26],
    [0.32, 0.60, 0.20],
    [0.68, 0.60, 0.20],
    [0.42, 0.42, 0.18],
    [0.60, 0.42, 0.18],
  ];
  for (const [cx, cy, r] of blobs) {
    ctx.beginPath();
    ctx.arc(w * cx, h * cy, w * r * scale, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawHotAirBalloon(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#ffffff';
  // Balloon
  ctx.beginPath();
  ctx.ellipse(w * 0.5, h * 0.40, w * 0.28, h * 0.34, 0, 0, Math.PI * 2);
  ctx.fill();
  // Basket
  ctx.fillRect(w * 0.42, h * 0.78, w * 0.16, h * 0.10);
  // Ropes
  ctx.lineWidth = 2;
  ctx.strokeStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(w * 0.42, h * 0.78);
  ctx.lineTo(w * 0.30, h * 0.66);
  ctx.moveTo(w * 0.58, h * 0.78);
  ctx.lineTo(w * 0.70, h * 0.66);
  ctx.stroke();
}

function drawShootingStarTrail(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  // Bright dot at right edge, fading horizontal gradient streak to the left
  const g = ctx.createLinearGradient(0, h * 0.5, w, h * 0.5);
  g.addColorStop(0.0, 'rgba(255,255,255,0.0)');
  g.addColorStop(0.7, 'rgba(255,250,235,0.6)');
  g.addColorStop(1.0, 'rgba(255,255,255,1.0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, h * 0.46, w, h * 0.08);
  ctx.beginPath();
  ctx.fillStyle = '#ffffff';
  ctx.arc(w * 0.92, h * 0.5, w * 0.05, 0, Math.PI * 2);
  ctx.fill();
}

function drawWhaleSpout(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = 'rgba(255,255,255,0.85)';
  ctx.beginPath();
  ctx.moveTo(w * 0.46, h * 1.00);
  ctx.lineTo(w * 0.30, h * 0.16);
  ctx.lineTo(w * 0.50, h * 0.30);
  ctx.lineTo(w * 0.70, h * 0.16);
  ctx.lineTo(w * 0.54, h * 1.00);
  ctx.closePath();
  ctx.fill();
}

function drawWhaleTail(ctx: CanvasRenderingContext2D, w: number, h: number): void {
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.moveTo(w * 0.50, h * 1.00);
  ctx.quadraticCurveTo(w * 0.20, h * 0.70, w * 0.10, h * 0.30);
  ctx.quadraticCurveTo(w * 0.40, h * 0.55, w * 0.50, h * 0.70);
  ctx.quadraticCurveTo(w * 0.60, h * 0.55, w * 0.90, h * 0.30);
  ctx.quadraticCurveTo(w * 0.80, h * 0.70, w * 0.50, h * 1.00);
  ctx.closePath();
  ctx.fill();
}
