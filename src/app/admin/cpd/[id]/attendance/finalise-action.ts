'use server';

import { revalidatePath } from 'next/cache';
import { ApiError } from '@/lib/api/client';
import { apiAsUser } from '@/lib/auth/session';

export async function finaliseAction(eventId: string): Promise<{ ok: boolean; message: string }> {
  try {
    const { message } = await apiAsUser<{ present: number; markedAbsent: number }>(
      '/attendance/finalise',
      { method: 'POST', body: { eventId: Number(eventId) } },
    );
    revalidatePath(`/admin/cpd/${eventId}/attendance`);
    return { ok: true, message: message ?? 'The register is closed.' };
  } catch (err) {
    if (err instanceof ApiError) {
      return {
        ok: false,
        message: err.status === 403
          ? 'Your role does not allow closing the register.'
          : err.message,
      };
    }
    return { ok: false, message: 'We could not reach the server. Nothing has changed.' };
  }
}
