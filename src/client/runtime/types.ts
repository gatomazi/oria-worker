import type { PageType, Values } from '../../shared/fields.ts';
import type { Theme } from '../../shared/identity.ts';
import type { CartService } from './cart.ts';
import type { Floating } from './floating.ts';

export interface ModuleContext {
  id: string;
  settings: Values;
  theme: Theme;
  page: PageType;
  basePath: string;
  storeId: string;
  version: number;
  preview: boolean;
  device: 'mobile' | 'desktop';
  /** Abortado na desmontagem: todo listener do módulo usa este sinal. */
  signal: AbortSignal;
  cart: CartService;
  floating: Floating;
  /** Pede ao carregador uma nova reconciliação (ex.: vigência que começou/terminou). */
  requestReconcile(atMs?: number): void;
}

export interface Instance {
  destroy(): void;
}

export interface ClientModule {
  mount(ctx: ModuleContext): Instance | null | Promise<Instance | null>;
}
