import { createKnowledgeApi, type CreateKnowledgeApiOptions, type KnowledgeApi } from '@pellux/goodvibes-sdk/platform/knowledge/knowledge-api';
import type { RuntimeServices } from './services.ts';

export interface RuntimeKnowledgeApiServices
  extends Pick<RuntimeServices, 'knowledgeService' | 'memoryRegistry'> {}

export function createRuntimeKnowledgeApi(
  runtimeServices: RuntimeKnowledgeApiServices,
): KnowledgeApi {
  const options: CreateKnowledgeApiOptions = {
    memoryRegistry: runtimeServices.memoryRegistry,
  };
  return createKnowledgeApi(runtimeServices.knowledgeService, options);
}
