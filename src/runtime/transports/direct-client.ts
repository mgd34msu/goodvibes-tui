import { createClientTransport, type ClientTransport } from './client-transport.ts';

export type DirectClientTransport<TOperator, TPeer> = ClientTransport<'direct', TOperator, TPeer>;

export function createDirectClientTransport<TOperator, TPeer>(
  operator: TOperator,
  peer: TPeer,
): DirectClientTransport<TOperator, TPeer> {
  return createClientTransport('direct', operator, peer);
}
