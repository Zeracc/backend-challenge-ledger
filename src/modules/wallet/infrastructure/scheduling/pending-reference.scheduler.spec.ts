import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { Logger } from '@nestjs/common';
import { ReprocessPendingReferencesUseCase } from '../../application/use-cases/reprocess-pending-references.js';
import { PendingReferenceScheduler } from './pending-reference.scheduler.js';
import type { ReprocessPendingReferencesResult } from '../../application/ports/wager-transaction.processor.js';

describe('PendingReferenceScheduler', () => {
  afterEach(() => {
    timerSpy?.mockRestore();
  });
  let timerSpy:
    ReturnType<typeof spyOn<typeof globalThis, 'setInterval'>> | undefined;

  it('evita sobreposição e aguarda trabalho em andamento no shutdown', async () => {
    let tick: () => void = () => {};
    const original = globalThis.setInterval;
    timerSpy = spyOn(globalThis, 'setInterval').mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
    ) => {
      tick = handler as () => void;
      return original(handler, timeout);
    }) as typeof setInterval);
    let finish: () => void = () => {};
    let calls = 0;
    const useCase = new ReprocessPendingReferencesUseCase(
      {
        reprocessDue: async (): Promise<ReprocessPendingReferencesResult> => {
          calls++;
          await new Promise<void>((resolve) => {
            finish = resolve;
          });
          return { scanned: 0, processed: 0, rejected: 0, rescheduled: 0 };
        },
      },
      { now: (): Date => new Date() },
    );
    const scheduler = new PendingReferenceScheduler(useCase);
    scheduler.onModuleInit();
    tick();
    tick();
    expect(calls).toBe(1);
    let stopped = false;
    const closing = scheduler.onModuleDestroy().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish();
    await closing;
    tick();
    expect(calls).toBe(1);
    expect(stopped).toBe(true);
  });

  it('registra falha sem expor SQL ou payload', async () => {
    let tick: () => void = () => {};
    const original = globalThis.setInterval;
    timerSpy = spyOn(globalThis, 'setInterval').mockImplementation(((
      handler: TimerHandler,
      timeout?: number,
    ) => {
      tick = handler as () => void;
      return original(handler, timeout);
    }) as typeof setInterval);
    const log = spyOn(Logger.prototype, 'error').mockImplementation(
      () => undefined,
    );
    const scheduler = new PendingReferenceScheduler(
      new ReprocessPendingReferencesUseCase(
        {
          reprocessDue: (): Promise<ReprocessPendingReferencesResult> =>
            Promise.reject(new Error('SQL com payload sensível')),
        },
        { now: (): Date => new Date() },
      ),
    );
    try {
      scheduler.onModuleInit();
      tick();
      await scheduler.onModuleDestroy();
      expect(log).toHaveBeenCalledWith({
        event: 'pending_reference_batch_failed',
        code: 'REFERENCE_REPROCESSING_FAILED',
      });
    } finally {
      log.mockRestore();
    }
  });
});
