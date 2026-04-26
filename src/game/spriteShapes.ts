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
        rect(0.46, 0.00, 0.54, 0.24),
        tri(0.50, 0.98, 0.35, 0.68, 0.65, 0.68),
        tri(0.50, 0.82, 0.28, 0.48, 0.72, 0.48),
        tri(0.50, 0.66, 0.22, 0.28, 0.78, 0.28),
        tri(0.50, 0.50, 0.16, 0.08, 0.84, 0.08),
      ];
    case 'pineShort':
      return [
        rect(0.46, 0.00, 0.54, 0.18),
        tri(0.50, 0.74, 0.32, 0.38, 0.68, 0.38),
        tri(0.50, 0.54, 0.22, 0.12, 0.78, 0.12),
      ];
    case 'deciduousRound':
      return [
        rect(0.46, 0.00, 0.54, 0.30),
        ellipse(0.50, 0.57, 0.30, 0.28, 14),
        ellipse(0.35, 0.48, 0.18, 0.18, 12),
        ellipse(0.65, 0.48, 0.18, 0.18, 12),
        ellipse(0.43, 0.70, 0.18, 0.18, 12),
        ellipse(0.58, 0.70, 0.18, 0.18, 12),
      ];
    case 'deciduousTall':
      return [
        rect(0.47, 0.00, 0.53, 0.36),
        ellipse(0.50, 0.54, 0.20, 0.36, 16),
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
    case 'birdA':
    case 'seabirdA':
      return [
        tri(0.50, 0.50, 0.18, 0.70, 0.44, 0.54),
        tri(0.50, 0.50, 0.82, 0.70, 0.56, 0.54),
      ];
    case 'birdB':
    case 'seabirdB':
      return [
        tri(0.50, 0.50, 0.18, 0.52, 0.44, 0.46),
        tri(0.50, 0.50, 0.82, 0.52, 0.56, 0.46),
      ];
    case 'birdC':
    case 'seabirdC':
      return [
        tri(0.50, 0.50, 0.20, 0.34, 0.44, 0.46),
        tri(0.50, 0.50, 0.80, 0.34, 0.56, 0.46),
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
