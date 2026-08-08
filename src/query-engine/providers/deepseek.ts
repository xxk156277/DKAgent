import { OpenAIProvider } from './openai.js';

export class DeepSeekProvider extends OpenAIProvider {
    name = 'deepseek';

    constructor(apiKey: string) {
        super(apiKey, 'https://api.deepseek.com');
    }
}