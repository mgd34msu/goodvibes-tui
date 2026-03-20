import type { Line } from '../types/grid.ts';
import type { Panel, PanelCategory } from './types.ts';

export abstract class BasePanel implements Panel {
  public needsRender = true;
  public isTransient = false;
  public isPinned = false;

  constructor(
    public readonly id: string,
    public readonly name: string,
    public readonly icon: string,
    public readonly category: PanelCategory,
  ) {}

  onActivate(): void { this.needsRender = true; }
  onDeactivate(): void {}
  onDestroy(): void {}

  abstract render(width: number, height: number): Line[];

  protected markDirty(): void { this.needsRender = true; }
}
