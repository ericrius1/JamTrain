import * as THREE from 'three/webgpu';
import type { AtlasId } from './spriteAtlas';

export interface ShapeBuffers {
  positions: number[];
  colors: number[];
}

type Point = [number, number];
type Polygon = Point[];

export function appendSpriteShape(
  buffers: ShapeBuffers,
  id: AtlasId,
  originX: number,
  originY: number,
  scale: number,
  tint: THREE.Color,
  anchor: 'bottom' | 'center' = 'bottom',
): void {
  const yAnchor = anchor === 'center' ? 0.5 : 0;
  for (const poly of spritePolygons(id)) {
    appendPolygon(buffers, poly, originX, originY, scale, yAnchor, tint);
  }
}

function appendPolygon(
  buffers: ShapeBuffers,
  poly: Polygon,
  originX: number,
  originY: number,
  scale: number,
  yAnchor: number,
  tint: THREE.Color,
): void {
  if (poly.length < 3) return;
  for (let i = 1; i < poly.length - 1; i += 1) {
    appendVertex(buffers, poly[0], originX, originY, scale, yAnchor, tint);
    appendVertex(buffers, poly[i], originX, originY, scale, yAnchor, tint);
    appendVertex(buffers, poly[i + 1], originX, originY, scale, yAnchor, tint);
  }
}

function appendVertex(
  buffers: ShapeBuffers,
  point: Point,
  originX: number,
  originY: number,
  scale: number,
  yAnchor: number,
  tint: THREE.Color,
): void {
  const [x, y] = point;
  buffers.positions.push(originX + (x - 0.5) * scale, originY + (y - yAnchor) * scale, 0);
  buffers.colors.push(tint.r, tint.g, tint.b);
}

function spritePolygons(id: AtlasId): Polygon[] {
  switch (id) {
    case 'pineTall':
      return [
        rect(0.46, 0.00, 0.54, 0.25),
        tri(0.50, 0.99, 0.38, 0.72, 0.64, 0.69),
        tri(0.49, 0.88, 0.30, 0.56, 0.72, 0.52),
        tri(0.52, 0.74, 0.22, 0.36, 0.80, 0.32),
        tri(0.48, 0.58, 0.15, 0.13, 0.84, 0.10),
        tri(0.40, 0.57, 0.24, 0.48, 0.49, 0.46),
        tri(0.61, 0.50, 0.79, 0.40, 0.51, 0.39),
      ];
    case 'pineShort':
      return [
        rect(0.46, 0.00, 0.54, 0.22),
        tri(0.50, 0.76, 0.31, 0.47, 0.70, 0.43),
        tri(0.48, 0.58, 0.20, 0.25, 0.78, 0.20),
        tri(0.53, 0.42, 0.26, 0.08, 0.82, 0.07),
        tri(0.36, 0.42, 0.24, 0.34, 0.51, 0.32),
      ];
    case 'cedarSweep':
      return [
        poly([0.46, 0.00], [0.54, 0.00], [0.56, 0.78], [0.50, 1.00], [0.45, 0.78]),
        tri(0.49, 0.91, 0.36, 0.72, 0.66, 0.69),
        tri(0.52, 0.75, 0.22, 0.52, 0.76, 0.48),
        tri(0.47, 0.57, 0.16, 0.34, 0.82, 0.29),
        tri(0.54, 0.38, 0.23, 0.14, 0.79, 0.10),
      ];
    case 'birchGrove':
      return [
        poly([0.29, 0.00], [0.38, 0.00], [0.37, 0.58], [0.32, 0.58]),
        poly([0.46, 0.00], [0.56, 0.00], [0.54, 0.66], [0.48, 0.66]),
        poly([0.63, 0.00], [0.71, 0.00], [0.69, 0.54], [0.65, 0.54]),
        ellipse(0.34, 0.62, 0.18, 0.18, 12),
        ellipse(0.48, 0.75, 0.20, 0.22, 14),
        ellipse(0.63, 0.64, 0.18, 0.19, 12),
        ellipse(0.44, 0.52, 0.22, 0.17, 12),
        ellipse(0.61, 0.50, 0.21, 0.16, 12),
      ];
    case 'windsweptOak':
      return [
        poly([0.38, 0.00], [0.46, 0.00], [0.50, 0.34], [0.60, 0.56], [0.55, 0.62], [0.44, 0.38]),
        poly([0.52, 0.48], [0.77, 0.68], [0.74, 0.74], [0.48, 0.56]),
        ellipse(0.58, 0.72, 0.24, 0.20, 14),
        ellipse(0.77, 0.69, 0.23, 0.17, 12),
        ellipse(0.46, 0.63, 0.20, 0.18, 12),
        ellipse(0.66, 0.83, 0.18, 0.15, 10),
        ellipse(0.34, 0.53, 0.16, 0.15, 10),
      ];
    case 'deciduousRound':
      return [
        poly([0.45, 0.00], [0.55, 0.00], [0.53, 0.36], [0.50, 0.45], [0.47, 0.36]),
        ellipse(0.50, 0.58, 0.30, 0.25, 14),
        ellipse(0.34, 0.50, 0.19, 0.18, 12),
        ellipse(0.68, 0.49, 0.20, 0.19, 12),
        ellipse(0.45, 0.72, 0.17, 0.15, 10),
        ellipse(0.60, 0.70, 0.19, 0.16, 10),
        ellipse(0.50, 0.42, 0.24, 0.14, 10),
      ];
    case 'deciduousTall':
      return [
        poly([0.46, 0.00], [0.54, 0.00], [0.53, 0.40], [0.48, 0.44]),
        ellipse(0.50, 0.58, 0.18, 0.34, 16),
        ellipse(0.42, 0.50, 0.13, 0.18, 10),
        ellipse(0.59, 0.49, 0.14, 0.20, 10),
      ];
    case 'barn':
      return [
        poly([0.18, 0.00], [0.18, 0.45], [0.50, 0.70], [0.82, 0.45], [0.82, 0.00]),
        rect(0.42, 0.00, 0.58, 0.24),
      ];
    case 'silo':
      return [
        rect(0.40, 0.00, 0.60, 0.70),
        ellipse(0.50, 0.70, 0.10, 0.10, 10),
      ];
    case 'fencePost':
      return [
        rect(0.48, 0.00, 0.52, 0.55),
        rect(0.24, 0.38, 0.76, 0.44),
        rect(0.26, 0.18, 0.74, 0.23),
      ];
    case 'haystack':
      return [halfEllipse(0.50, 0.00, 0.36, 0.45, 14)];
    case 'cottage':
    case 'cottageLit':
      return [
        rect(0.20, 0.00, 0.80, 0.45),
        tri(0.16, 0.45, 0.50, 0.70, 0.84, 0.45),
        rect(0.66, 0.48, 0.73, 0.64),
      ];
    case 'lighthouse':
    case 'lighthouseLit':
      return [
        poly([0.38, 0.00], [0.43, 0.72], [0.57, 0.72], [0.62, 0.00]),
        rect(0.34, 0.72, 0.66, 0.82),
        tri(0.36, 0.82, 0.50, 0.95, 0.64, 0.82),
      ];
    case 'sailboat':
      return [
        poly([0.20, 0.12], [0.80, 0.12], [0.68, 0.02], [0.32, 0.02]),
        tri(0.48, 0.16, 0.48, 0.84, 0.22, 0.16),
        tri(0.52, 0.16, 0.52, 0.72, 0.76, 0.16),
      ];
    case 'reeds':
      return [
        reed(0.30, 0.06, 0.48),
        reed(0.44, 0.02, 0.62),
        reed(0.58, 0.05, 0.54),
        reed(0.72, 0.02, 0.45),
      ];
    case 'cattail':
      return [
        reed(0.42, 0.00, 0.60),
        reed(0.58, 0.00, 0.50),
        ellipse(0.42, 0.62, 0.035, 0.10, 8),
        ellipse(0.58, 0.52, 0.030, 0.09, 8),
      ];
    case 'kelp':
      return [
        reed(0.34, 0.00, 0.88),
        reed(0.49, 0.00, 0.96),
        reed(0.64, 0.00, 0.82),
        ellipse(0.28, 0.27, 0.08, 0.030, 8),
        ellipse(0.43, 0.45, 0.09, 0.032, 8),
        ellipse(0.57, 0.35, 0.08, 0.030, 8),
        ellipse(0.71, 0.54, 0.08, 0.030, 8),
        ellipse(0.42, 0.70, 0.07, 0.028, 8),
        ellipse(0.61, 0.76, 0.07, 0.028, 8),
      ];
    case 'seaGrass':
      return [
        reed(0.18, 0.00, 0.42),
        reed(0.26, 0.00, 0.58),
        reed(0.34, 0.00, 0.48),
        reed(0.43, 0.00, 0.68),
        reed(0.52, 0.00, 0.56),
        reed(0.61, 0.00, 0.72),
        reed(0.70, 0.00, 0.50),
        reed(0.80, 0.00, 0.38),
      ];
    case 'coralFan':
      return [
        reed(0.50, 0.00, 0.72),
        branch(0.50, 0.28, 0.28, 0.56, 0.018),
        branch(0.50, 0.34, 0.72, 0.60, 0.018),
        branch(0.48, 0.47, 0.34, 0.78, 0.014),
        branch(0.52, 0.45, 0.70, 0.84, 0.014),
        branch(0.42, 0.38, 0.18, 0.70, 0.012),
        branch(0.58, 0.38, 0.84, 0.74, 0.012),
        ellipse(0.28, 0.56, 0.040, 0.040, 8),
        ellipse(0.72, 0.60, 0.040, 0.040, 8),
        ellipse(0.34, 0.78, 0.034, 0.034, 8),
        ellipse(0.70, 0.84, 0.034, 0.034, 8),
        ellipse(0.18, 0.70, 0.030, 0.030, 8),
        ellipse(0.84, 0.74, 0.030, 0.030, 8),
      ];
    case 'fishTiny':
      return [
        ellipse(0.52, 0.50, 0.22, 0.11, 12),
        tri(0.31, 0.50, 0.13, 0.36, 0.15, 0.64),
        tri(0.56, 0.43, 0.46, 0.25, 0.66, 0.39),
      ];
    case 'rayFish':
      return [
        poly([0.10, 0.50], [0.38, 0.28], [0.88, 0.44], [0.52, 0.58], [0.12, 0.72]),
        tri(0.82, 0.48, 0.98, 0.42, 0.90, 0.55),
      ];
    case 'jellyfish':
      return [
        halfEllipse(0.50, 0.45, 0.23, 0.22, 12),
        reed(0.36, 0.08, 0.45),
        reed(0.45, 0.00, 0.45),
        reed(0.54, 0.03, 0.45),
        reed(0.63, 0.10, 0.45),
      ];
    case 'birdA':
    case 'seabirdA':
      return [
        poly([0.18, 0.46], [0.78, 0.43], [0.92, 0.50], [0.78, 0.57], [0.18, 0.54]),
        tri(0.06, 0.50, 0.20, 0.44, 0.20, 0.56),
        tri(0.40, 0.50, 0.55, 0.84, 0.68, 0.50),
      ];
    case 'birdB':
    case 'seabirdB':
      return [
        poly([0.18, 0.46], [0.78, 0.43], [0.92, 0.50], [0.78, 0.57], [0.18, 0.54]),
        tri(0.06, 0.50, 0.20, 0.44, 0.20, 0.56),
        tri(0.40, 0.50, 0.54, 0.66, 0.68, 0.50),
        tri(0.40, 0.50, 0.54, 0.34, 0.68, 0.50),
      ];
    case 'birdC':
    case 'seabirdC':
      return [
        poly([0.18, 0.46], [0.78, 0.43], [0.92, 0.50], [0.78, 0.57], [0.18, 0.54]),
        tri(0.06, 0.50, 0.20, 0.44, 0.20, 0.56),
        tri(0.40, 0.50, 0.55, 0.16, 0.68, 0.50),
      ];
    case 'cloudSmall':
      return [ellipse(0.50, 0.50, 0.26, 0.13, 14), ellipse(0.38, 0.52, 0.15, 0.11, 10), ellipse(0.62, 0.54, 0.18, 0.12, 10)];
    case 'cloudMed':
      return [ellipse(0.50, 0.50, 0.34, 0.16, 16), ellipse(0.34, 0.52, 0.18, 0.13, 10), ellipse(0.62, 0.56, 0.22, 0.15, 12)];
    case 'cloudLarge':
      return [ellipse(0.50, 0.50, 0.40, 0.18, 18), ellipse(0.30, 0.52, 0.20, 0.14, 12), ellipse(0.55, 0.60, 0.26, 0.17, 12), ellipse(0.76, 0.50, 0.16, 0.12, 10)];
    case 'hotAirBalloon':
      return [
        ellipse(0.50, 0.62, 0.22, 0.30, 18),
        rect(0.42, 0.18, 0.58, 0.28),
        rect(0.46, 0.08, 0.54, 0.18),
      ];
    case 'shootingStarTrail':
      return [
        poly([0.05, 0.46], [0.74, 0.40], [0.95, 0.50], [0.74, 0.60], [0.05, 0.54]),
        ellipse(0.86, 0.50, 0.11, 0.11, 12),
      ];
    case 'whaleSpout':
      return [
        reed(0.46, 0.00, 0.68),
        reed(0.54, 0.00, 0.62),
        ellipse(0.38, 0.68, 0.10, 0.08, 10),
        ellipse(0.58, 0.70, 0.12, 0.09, 10),
        ellipse(0.50, 0.86, 0.08, 0.07, 10),
      ];
    case 'whaleTail':
      return [
        rect(0.48, 0.00, 0.52, 0.34),
        tri(0.50, 0.34, 0.20, 0.60, 0.44, 0.36),
        tri(0.50, 0.34, 0.80, 0.60, 0.56, 0.36),
      ];
  }
}

function rect(x0: number, y0: number, x1: number, y1: number): Polygon {
  return poly([x0, y0], [x1, y0], [x1, y1], [x0, y1]);
}

function tri(x0: number, y0: number, x1: number, y1: number, x2: number, y2: number): Polygon {
  return poly([x0, y0], [x1, y1], [x2, y2]);
}

function poly(...points: Point[]): Polygon {
  return points;
}

function ellipse(cx: number, cy: number, rx: number, ry: number, steps: number): Polygon {
  const pts: Polygon = [];
  for (let i = 0; i < steps; i += 1) {
    const a = (i / steps) * Math.PI * 2;
    pts.push([cx + Math.cos(a) * rx, cy + Math.sin(a) * ry]);
  }
  return pts;
}

function halfEllipse(cx: number, y0: number, rx: number, ry: number, steps: number): Polygon {
  const pts: Polygon = [[cx - rx, y0]];
  for (let i = 0; i <= steps; i += 1) {
    const a = Math.PI - (i / steps) * Math.PI;
    pts.push([cx + Math.cos(a) * rx, y0 + Math.sin(a) * ry]);
  }
  pts.push([cx + rx, y0]);
  return pts;
}

function reed(x: number, y0: number, y1: number): Polygon {
  const w = 0.012;
  return poly([x - w, y0], [x + w, y0], [x + w * 0.5, y1], [x - w * 0.5, y1]);
}

function branch(x0: number, y0: number, x1: number, y1: number, w: number): Polygon {
  const dx = x1 - x0;
  const dy = y1 - y0;
  const len = Math.max(0.0001, Math.hypot(dx, dy));
  const nx = -dy / len * w;
  const ny = dx / len * w;
  return poly(
    [x0 - nx, y0 - ny],
    [x0 + nx, y0 + ny],
    [x1 + nx * 0.6, y1 + ny * 0.6],
    [x1 - nx * 0.6, y1 - ny * 0.6],
  );
}
