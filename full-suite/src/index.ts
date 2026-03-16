export function greet(name: string): string {
  return `Hello, ${name}!`;
}

export function add(a: number, b: number): number {
  return a + b;
}

export const VERSION = '1.0.0';

export class UserService {
  private users: Map<string, { name: string; email: string }> = new Map();

  addUser(id: string, name: string, email: string): void {
    this.users.set(id, { name, email });
  }

  getUser(id: string): { name: string; email: string } | undefined {
    return this.users.get(id);
  }

  listUsers(): string[] {
    return Array.from(this.users.keys());
  }
}

// This function is never imported anywhere — dead code
export function unusedHelper(): void {
  console.log('I am never called');
}
