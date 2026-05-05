/**
 * Panel health monitor — backward-compat shim.
 *
 * Re-exports the SDK's ComponentHealthMonitor so that the TUI and the SDK
 * share a single class declaration. This eliminates the TypeScript nominal
 * incompatibility that arises from two classes having separate `private`
 * field declarations with the same name.
 *
 * All call-sites that previously imported the TUI-local ComponentHealthMonitor
 * now receive the SDK's canonical class without any behavioral change —
 * the public API is identical (register/deregister/canRender/recordRender/
 * getHealth/getAllHealth/getContract/resetHealth).
 */

export {
  ComponentHealthMonitor,
  ComponentHealthMonitor as PanelHealthMonitor,
} from '@/runtime/index.ts';
