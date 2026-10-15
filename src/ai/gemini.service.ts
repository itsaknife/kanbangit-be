import { ApiError, GoogleGenAI } from '@google/genai';
import {
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Env } from '../config/env.js';

/** Số chiều của vector, phải khớp với cột vector(768) trong database. */
export const EMBEDDING_DIMENSIONS = 768;

export type EmbeddingPurpose = 'document' | 'query';

/** Mọi lời gọi tới Gemini đều đi qua đây: sinh văn bản, sinh JSON, và tạo embedding. */
@Injectable()
export class GeminiService {
  private readonly logger = new Logger(GeminiService.name);
  private client: GoogleGenAI | null = null;

  constructor(private readonly config: ConfigService<Env, true>) {}

  get isConfigured(): boolean {
    return Boolean(this.config.get('GEMINI_API_KEY', { infer: true }));
  }

  async generateText(systemInstruction: string, prompt: string): Promise<string> {
    const response = await this.call(() =>
      this.ai().models.generateContent({
        model: this.config.get('GEMINI_MODEL', { infer: true }),
        contents: prompt,
        config: { systemInstruction, temperature: 0.3 },
      }),
    );
    const text = response.text?.trim();
    if (!text) throw new ServiceUnavailableException('AI không trả về nội dung, hãy thử lại');
    return text;
  }

  /** Yêu cầu LLM trả về JSON đúng theo `schema` (JSON Schema). */
  async generateJson<T>(systemInstruction: string, prompt: string, schema: object): Promise<T> {
    const response = await this.call(() =>
      this.ai().models.generateContent({
        model: this.config.get('GEMINI_MODEL', { infer: true }),
        contents: prompt,
        config: {
          systemInstruction,
          temperature: 0,
          responseMimeType: 'application/json',
          responseJsonSchema: schema,
        },
      }),
    );
    try {
      return JSON.parse(response.text ?? '') as T;
    } catch {
      this.logger.warn(`LLM trả về JSON không hợp lệ: ${response.text}`);
      throw new ServiceUnavailableException('AI trả về kết quả không đọc được, hãy thử lại');
    }
  }

  /** Đổi các đoạn văn bản thành vector. `document` cho issue đã lưu, `query` cho issue đang kiểm tra. */
  async embed(texts: string[], purpose: EmbeddingPurpose): Promise<number[][]> {
    const model = this.config.get('GEMINI_EMBEDDING_MODEL', { infer: true });
    // gemini-embedding-2 không nhận tham số taskType, loại tác vụ được ghi ngay trong nội dung
    const supportsTaskType = !model.includes('embedding-2');
    const contents =
      supportsTaskType || purpose === 'document'
        ? texts
        : texts.map((text) => `task: search result | query: ${text}`);

    const response = await this.call(() =>
      this.ai().models.embedContent({
        model,
        contents,
        config: {
          outputDimensionality: EMBEDDING_DIMENSIONS,
          ...(supportsTaskType && {
            taskType: purpose === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT',
          }),
        },
      }),
    );
    return (response.embeddings ?? []).map((item) => item.values ?? []);
  }

  private ai(): GoogleGenAI {
    const apiKey = this.config.get('GEMINI_API_KEY', { infer: true });
    if (!apiKey) throw new ServiceUnavailableException('Chưa cấu hình GEMINI_API_KEY cho backend');
    this.client ??= new GoogleGenAI({ apiKey });
    return this.client;
  }

  /** Đổi lỗi của Gemini thành lỗi HTTP dễ hiểu (đặc biệt là hết lượt gọi của gói miễn phí). */
  private async call<T>(action: () => Promise<T>): Promise<T> {
    try {
      return await action();
    } catch (error) {
      if (error instanceof HttpException) throw error;
      if (error instanceof ApiError && error.status === 429) {
        throw new HttpException(
          'Đã hết lượt gọi AI miễn phí tạm thời, hãy thử lại sau ít phút',
          HttpStatus.TOO_MANY_REQUESTS,
        );
      }
      this.logger.error(`Gọi Gemini thất bại: ${(error as Error).message}`);
      throw new ServiceUnavailableException('Dịch vụ AI tạm thời không phản hồi');
    }
  }
}
