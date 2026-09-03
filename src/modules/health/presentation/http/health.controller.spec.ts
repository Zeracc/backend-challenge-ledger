import { describe, expect, it } from 'bun:test';

import { HealthController } from './health.controller.js';

describe('HealthController', () => {
  it('reports that the process is alive', () => {
    const controller = new HealthController();

    expect(controller.live()).toEqual({ status: 'ok' });
  });
});
