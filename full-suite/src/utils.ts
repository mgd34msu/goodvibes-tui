import { VERSION } from './index.ts';

export function formatVersion(): string {
  return `v${VERSION}`;
}

export function capitalize(str: string): string {
  return str.charAt(0).toUpperCase() + str.slice(1);
}

// Circular dependency test — imports from auth which imports from utils
export { getAuthToken } from './auth.ts';
