// Tiny shared flag for "is the dev overlay open right now?" so input handlers
// outside the DevOverlay (instruments, robot mute) can gate debug-only keys
// without a hard import on the overlay itself.

let visible = false;

export function setDebugVisible(next: boolean): void {
  visible = next;
}

export function isDebugVisible(): boolean {
  return visible;
}
