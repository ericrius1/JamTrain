import { sanitizeRoomName } from './roomNames';

export function readRoomFromUrl(): string {
  const seg = window.location.pathname.split('/').filter(Boolean)[0] ?? '';
  return sanitizeRoomName(decodeURIComponent(seg));
}

export function writeRoomToUrl(room: string): void {
  const sanitized = sanitizeRoomName(room);
  if (!sanitized) return;
  const next = `/${sanitized}`;
  if (window.location.pathname === next) return;
  window.history.replaceState({ room: sanitized }, '', next);
}

export function onUrlRoomChange(handler: (room: string) => void): () => void {
  const listener = () => handler(readRoomFromUrl());
  window.addEventListener('popstate', listener);
  return () => window.removeEventListener('popstate', listener);
}

export function shareUrlFor(room: string): string {
  const sanitized = sanitizeRoomName(room);
  return `${window.location.origin}/${sanitized}`;
}
