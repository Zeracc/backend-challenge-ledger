import type { CanActivate } from '@nestjs/common';
import { Injectable } from '@nestjs/common';

@Injectable()
export class NoOpAuthGuard implements CanActivate {
  public canActivate(): boolean {
    return true;
  }
}
