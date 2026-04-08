import { UserAuthManager } from '../security/user-auth.ts';

let sharedUserAuthManager: UserAuthManager | null = null;

export function getLocalUserAuthManager(): UserAuthManager {
  if (sharedUserAuthManager === null) {
    sharedUserAuthManager = new UserAuthManager();
  }
  return sharedUserAuthManager;
}

export function setLocalUserAuthManager(manager: UserAuthManager): void {
  sharedUserAuthManager = manager;
}

export function resetLocalUserAuthManagerForTesting(): void {
  sharedUserAuthManager = null;
}
