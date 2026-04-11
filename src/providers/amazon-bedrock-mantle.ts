import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import { AnthropicSdkProvider } from './anthropic-sdk-provider.ts';

const BEDROCK_MANTLE_MODELS = [
  'claude-sonnet-4-6',
  'claude-opus-4-6',
  'claude-haiku-4-5',
];

function hasMantleCredentials(): boolean {
  return Boolean(
    process.env['AWS_BEARER_TOKEN_BEDROCK']
    || (process.env['AWS_ACCESS_KEY_ID'] && process.env['AWS_SECRET_ACCESS_KEY'])
    || process.env['AWS_PROFILE'],
  );
}

export class AmazonBedrockMantleProvider extends AnthropicSdkProvider {
  constructor() {
    const configured = hasMantleCredentials();
    super({
      name: 'amazon-bedrock-mantle',
      label: 'Amazon Bedrock Mantle',
      defaultModel: 'claude-sonnet-4-6',
      models: BEDROCK_MANTLE_MODELS,
      createClient: () => new AnthropicBedrockMantle({
        apiKey: process.env['AWS_BEARER_TOKEN_BEDROCK'],
        awsAccessKey: process.env['AWS_ACCESS_KEY_ID'] ?? null,
        awsSecretAccessKey: process.env['AWS_SECRET_ACCESS_KEY'] ?? null,
        awsSessionToken: process.env['AWS_SESSION_TOKEN'] ?? null,
        awsProfile: process.env['AWS_PROFILE'],
        awsRegion: process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'us-east-1',
      }),
      auth: {
        mode: configured ? 'api-key' : 'anonymous',
        configured,
        detail: configured
          ? 'Bedrock Mantle auth is available through bearer token or AWS credential resolution.'
          : 'Configure AWS_BEARER_TOKEN_BEDROCK or AWS credentials/profile for Bedrock Mantle.',
        envVars: ['AWS_BEARER_TOKEN_BEDROCK', 'AWS_ACCESS_KEY_ID', 'AWS_SECRET_ACCESS_KEY', 'AWS_SESSION_TOKEN', 'AWS_PROFILE', 'AWS_REGION'],
        secretKeys: ['AWS_BEARER_TOKEN_BEDROCK'],
        allowAnonymous: true,
        anonymousConfigured: Boolean(process.env['AWS_PROFILE']),
        anonymousDetail: 'Bedrock Mantle can also use the AWS credential provider chain.',
      },
      streamProtocol: 'anthropic-sdk-stream',
      notes: ['Bedrock Mantle uses the Anthropic Bedrock Mantle SDK path.'],
    });
  }
}
