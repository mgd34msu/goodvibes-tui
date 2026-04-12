import type { GatewayMethodDescriptor } from './method-catalog-shared.ts';
import { builtinGatewayControlAutomationMethodDescriptors } from './method-catalog-control-automation.ts';
import { builtinGatewayControlCoreMethodDescriptors } from './method-catalog-control-core.ts';

export const builtinGatewayControlMethodDescriptors: readonly GatewayMethodDescriptor[] = [
  ...builtinGatewayControlCoreMethodDescriptors,
  ...builtinGatewayControlAutomationMethodDescriptors,
];
