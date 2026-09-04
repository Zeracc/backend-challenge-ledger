import type { Clock } from '../../application/ports/clock.js';

export class SystemClock implements Clock {
  public now(): Date {
    return new Date();
  }
}
