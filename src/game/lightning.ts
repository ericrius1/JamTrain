import { mulberry32 } from './seedRandom';

export interface BoltSegment {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface BoltGeometry {
  segments: BoltSegment[];
}

// Recursive midpoint-displacement bolt with up to 3 levels of subdivision and
// at most a few small forks. Coordinates are normalized 0..1 across the canvas.
export function generateBolt(seed: number): BoltGeometry {
  const rand = mulberry32(seed);
  const startX = 0.18 + rand() * 0.64;
  const endX = startX + (rand() - 0.5) * 0.20;
  const segments: BoltSegment[] = [];
  subdivide(startX, 0.04, endX, 0.94, 3, rand, segments);
  return { segments };
}

function subdivide(
  x0: number, y0: number, x1: number, y1: number,
  level: number, rand: () => number, out: BoltSegment[],
): void {
  if (level === 0) {
    out.push({ x0, y0, x1, y1 });
    return;
  }
  const mx = (x0 + x1) * 0.5;
  const my = (y0 + y1) * 0.5;
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const px = -dy / len;
  const py = dx / len;
  const jitter = (rand() - 0.5) * 0.16 * len;
  const mxJ = mx + px * jitter;
  const myJ = my + py * jitter;
  subdivide(x0, y0, mxJ, myJ, level - 1, rand, out);
  subdivide(mxJ, myJ, x1, y1, level - 1, rand, out);
  if (level >= 2 && rand() < 0.30) {
    const fx = mxJ + (rand() - 0.3) * 0.18;
    const fy = myJ + 0.05 + rand() * 0.20;
    subdivide(mxJ, myJ, fx, Math.min(0.96, fy), level - 1, rand, out);
  }
}

export function rasterizeBolt(geo: BoltGeometry, w = 256, h = 128): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, w, h);
  ctx.lineCap = 'round';
  // Glow pass
  ctx.strokeStyle = 'rgba(255,238,200,0.30)';
  ctx.lineWidth = 7;
  drawSegments(ctx, geo.segments, w, h);
  ctx.strokeStyle = 'rgba(255,242,210,0.55)';
  ctx.lineWidth = 4;
  drawSegments(ctx, geo.segments, w, h);
  // Core pass
  ctx.strokeStyle = 'rgba(255,250,235,1.0)';
  ctx.lineWidth = 1.6;
  drawSegments(ctx, geo.segments, w, h);
  return canvas;
}

function drawSegments(ctx: CanvasRenderingContext2D, segs: BoltSegment[], w: number, h: number): void {
  for (const s of segs) {
    ctx.beginPath();
    ctx.moveTo(s.x0 * w, s.y0 * h);
    ctx.lineTo(s.x1 * w, s.y1 * h);
    ctx.stroke();
  }
}
