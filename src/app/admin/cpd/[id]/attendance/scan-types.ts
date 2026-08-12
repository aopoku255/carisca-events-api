/** Kept out of the "use server" module, which may only export async functions. */
export type ScanOutcome =
  | {
      kind: 'admitted' | 'already';
      name: string;
      organization: string | null;
      reference: string;
      checkedInAt: string;
      warnings: string[];
    }
  | { kind: 'refused'; message: string; reference?: string; status?: string }
  | { kind: 'unknown'; message: string }
  | { kind: 'error'; message: string }
  | { kind: 'offline'; message: string };

/** A scan waiting to be sent, held in localStorage while offline. */
export interface QueuedScan {
  id: string;
  qrToken?: string;
  reference?: string;
  sessionId: number | null;
  scannedAt: string;
}
