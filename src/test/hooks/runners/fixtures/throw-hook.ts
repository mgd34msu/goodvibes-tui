export default async function handler(): Promise<never> {
  throw new Error('handler exploded');
}
