/**
 * A temporary native overlay is not the same as the user closing Carvis.
 * Keep the runtime alive through foreground exit; the SDK sends a separate
 * terminal event when the app has genuinely been dismissed.
 */
export type HostLifecycleAction = 'resume' | 'cover' | 'cleanup' | 'ignore';

export function hostLifecycleAction(eventType: number): HostLifecycleAction {
  switch (eventType) {
    case 4: return 'resume';
    case 5: return 'cover';
    case 6:
    case 7: return 'cleanup';
    default: return 'ignore';
  }
}
