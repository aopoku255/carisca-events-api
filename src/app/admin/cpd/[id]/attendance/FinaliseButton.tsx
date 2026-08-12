'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Callout } from '@/components/ui';
import { finaliseAction } from './finalise-action';

/**
 * Closing the register is irreversible in effect — everyone unmarked becomes
 * absent, and absent people do not get certificates. So it confirms, and says
 * exactly how many people it is about to affect.
 */
export function FinaliseButton({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [state, setState] = useState<{ ok?: boolean; message?: string } | null>(null);
  const [busy, setBusy] = useState(false);

  return (
    <div style={{ marginTop: 'var(--space-4)' }}>
      {state?.message && (
        <div style={{ marginBottom: 'var(--space-3)' }}>
          <Callout tone={state.ok ? 'success' : 'danger'}>{state.message}</Callout>
        </div>
      )}
      <Button
        variant="secondary"
        disabled={busy}
        onClick={async () => {
          if (!window.confirm(
            'Close the register? Everyone not checked in will be marked absent, '
            + 'and absent participants do not receive a certificate.',
          )) return;
          setBusy(true);
          setState(await finaliseAction(eventId));
          setBusy(false);
          router.refresh();
        }}
      >
        {busy ? 'Closing…' : 'Close the register'}
      </Button>
    </div>
  );
}
