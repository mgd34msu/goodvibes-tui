import type {
  VoiceProvider,
  VoiceProviderCapability,
  VoiceProviderStatus,
} from './types.ts';

export interface VoiceProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly VoiceProviderCapability[];
}

export class VoiceProviderRegistry {
  private readonly providers = new Map<string, VoiceProvider>();

  register(provider: VoiceProvider, options: { readonly replace?: boolean } = {}): () => void {
    const id = provider.id.trim();
    if (!id) throw new Error('Voice provider id is required');
    if (this.providers.has(id) && !options.replace) {
      throw new Error(`Voice provider already registered: ${id}`);
    }
    const registered = { ...provider, id };
    this.providers.set(id, registered);
    return () => {
      const current = this.providers.get(id);
      if (current === registered) this.unregister(id);
    };
  }

  unregister(id: string): boolean {
    return this.providers.delete(id);
  }

  get(id: string): VoiceProvider | null {
    return this.providers.get(id) ?? null;
  }

  list(): VoiceProviderDescriptor[] {
    return [...this.providers.values()]
      .map((provider) => ({
        id: provider.id,
        label: provider.label,
        capabilities: [...provider.capabilities],
      }))
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }

  findProvider(capability: VoiceProviderCapability, providerId?: string): VoiceProvider | null {
    if (providerId) {
      const provider = this.get(providerId);
      return provider?.capabilities.includes(capability) ? provider : null;
    }
    return [...this.providers.values()].find((provider) => provider.capabilities.includes(capability)) ?? null;
  }

  async status(): Promise<VoiceProviderStatus[]> {
    const statuses: VoiceProviderStatus[] = [];
    for (const provider of this.providers.values()) {
      if (provider.status) {
        statuses.push(await provider.status());
        continue;
      }
      statuses.push({
        id: provider.id,
        label: provider.label,
        state: 'healthy',
        capabilities: [...provider.capabilities],
        configured: true,
        metadata: {},
      });
    }
    return statuses.sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }
}
