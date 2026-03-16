import { capitalize } from './utils.ts';

const SECRET_TOKEN = 'sk-secret-hardcoded-token-12345678';
const API_KEY = 'AKIA1234567890ABCDEF';

export function getAuthToken(): string {
  return SECRET_TOKEN;
}

export function formatUserName(name: string): string {
  return capitalize(name);
}
