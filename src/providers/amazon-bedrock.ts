import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk';
import { AnthropicSdkProvider } from './anthropic-sdk-provider.ts';

const BEDROCK_MODELS = [
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5',
];

function hasAwsCredentials(): boolean {
  return Boolean(
    process.env['AWS_BEARER_TOKEN_BEDROCK']
    || (process.env['AWS_ACCESS_KEY_ID'] && process.env['AWS_SECRET_ACCESS_KEY'])
    || process.env['AWS_PROFILE'],
  );
}

export class AmazonBedrockProvider extends AnthropicSdkProvider {
  constructor() {
    const configured = hasAwsCredentials();
    super({
      name: 'amazon-bedrock',
      label: 'Amazon Bedrock',
      defaultModel: 'claude-sonnet-4-6',
      models: BEDROCK_MODELS,
      createClient: () => {
        const apiKey = process.env['AWS_BEARER_TOKEN_BEDROCK']?.trim();
        const awsAccessKey = process.env['AWS_ACCESS_KEY_ID']?.trim();
        const awsSecretKey = process.env['AWS_SECRET_ACCESS_KEY']?.trim();
        const awsSessionToken = process.env['AWS_SESSION_TOKEN']?.trim();
        const baseOptions = {
          ...(apiKey ? { apiKey } : {}),
          awsRegion: process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1',
        };
        if (awsAccessKey && awsSecretKey) {
          return new AnthropicBedrock({
            ...baseOptions,
            awsAccessKey,
            awsSecretKey,
            ...(awsSessionToken ? { awsSessionToken } : {}),
          });
        }
        return new AnthropicBedrock(baseOptions);
      },
      auth: {
        mode: configured ? 'api-key' : 'anonymous',
        configured,
        detail: configured
          ? 'AWS Bedrock credentials are available through bearer token or AWS credential resolution.'
          : 'Configure AWS_BEARER_TOKEN_BEDROCK or AWS credentials/profile for Amazon Bedrock.',
        envVars: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_REGION'],
        secretKeys: ['AWS_BEARER_TOKEN_BEDROCK'],
        allowAnonymous: true,
        anonymousConfigured: Boolean(process.env['AWS_PROFILE']),
        anonymousDetail: 'The AWS credential provider chain can satisfy Bedrock auth without storing an API key in GoodVibes.',
      },
      streamProtocol: 'anthropic-sdk-stream',
      notes: ['Claude-on-Bedrock models are exposed through the Anthropic Bedrock SDK.'],
    });
  }
}
