export type MediaProviderCapability = 'metadata' | 'understand' | 'transform' | 'generate' | 'attachment-store';
export type MediaProviderState = 'healthy' | 'degraded' | 'disabled' | 'unconfigured';

export interface MediaArtifact {
  readonly id?: string;
  readonly artifactId?: string;
  readonly mimeType: string;
  readonly dataBase64?: string;
  readonly uri?: string;
  readonly filename?: string;
  readonly sizeBytes?: number;
  readonly sha256?: string;
  readonly metadata: Record<string, unknown>;
}

export interface MediaProviderStatus {
  readonly id: string;
  readonly label: string;
  readonly state: MediaProviderState;
  readonly capabilities: readonly MediaProviderCapability[];
  readonly configured: boolean;
  readonly detail?: string;
  readonly metadata: Record<string, unknown>;
}

export interface MediaAnalysisRequest {
  readonly artifact: MediaArtifact;
  readonly prompt?: string;
  readonly modelId?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface MediaAnalysisResult {
  readonly providerId: string;
  readonly description?: string;
  readonly labels?: readonly string[];
  readonly text?: string;
  readonly metadata: Record<string, unknown>;
}

export interface MediaTransformRequest {
  readonly artifact: MediaArtifact;
  readonly operation: string;
  readonly outputMimeType?: string;
  readonly options?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

export interface MediaTransformResult {
  readonly providerId: string;
  readonly artifact: MediaArtifact;
  readonly metadata: Record<string, unknown>;
}

export interface MediaGenerationRequest {
  readonly prompt: string;
  readonly outputMimeType?: string;
  readonly modelId?: string;
  readonly options?: Record<string, unknown>;
  readonly metadata?: Record<string, unknown>;
}

export interface MediaGenerationResult {
  readonly providerId: string;
  readonly artifacts: readonly MediaArtifact[];
  readonly metadata: Record<string, unknown>;
}

export interface MediaProvider {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly MediaProviderCapability[];
  status?(): Promise<MediaProviderStatus> | MediaProviderStatus;
  analyze?(request: MediaAnalysisRequest): Promise<MediaAnalysisResult>;
  transform?(request: MediaTransformRequest): Promise<MediaTransformResult>;
  generate?(request: MediaGenerationRequest): Promise<MediaGenerationResult>;
}

export interface MediaProviderDescriptor {
  readonly id: string;
  readonly label: string;
  readonly capabilities: readonly MediaProviderCapability[];
}

export class MediaProviderRegistry {
  private readonly providers = new Map<string, MediaProvider>();

  register(provider: MediaProvider, options: { readonly replace?: boolean } = {}): () => void {
    const id = provider.id.trim();
    if (!id) throw new Error('Media provider id is required');
    if (this.providers.has(id) && !options.replace) {
      throw new Error(`Media provider already registered: ${id}`);
    }
    const registered = { ...provider, id };
    this.providers.set(id, registered);
    return () => {
      if (this.providers.get(id) === registered) this.unregister(id);
    };
  }

  unregister(id: string): boolean {
    return this.providers.delete(id);
  }

  get(id: string): MediaProvider | null {
    return this.providers.get(id) ?? null;
  }

  list(): MediaProviderDescriptor[] {
    return [...this.providers.values()]
      .map((provider) => ({
        id: provider.id,
        label: provider.label,
        capabilities: [...provider.capabilities],
      }))
      .sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
  }

  findProvider(capability: MediaProviderCapability, providerId?: string): MediaProvider | null {
    if (providerId) {
      const provider = this.get(providerId);
      return provider?.capabilities.includes(capability) ? provider : null;
    }
    return [...this.providers.values()].find((provider) => provider.capabilities.includes(capability)) ?? null;
  }

  async status(): Promise<MediaProviderStatus[]> {
    const statuses: MediaProviderStatus[] = [];
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
