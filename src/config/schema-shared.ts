export interface ConfigSettingDefinition {
  key: string;
  type: 'boolean' | 'number' | 'string' | 'enum';
  default: unknown;
  description: string;
  enumValues?: string[];
  validate?: (value: unknown) => boolean;
}
