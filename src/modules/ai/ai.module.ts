import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaAnalysisRepository } from '@/database/repositories/media-analysis.repository';
import { PlatformSettingRepository } from '@/database/repositories/platform-setting.repository';
import { GeminiClient } from './gemini.client';
import { OpenAiClient } from './openai.client';
import { MediaDownloader } from './media-downloader';
import { MediaAnalysisService } from './media-analysis.service';

/**
 * Everything that talks to a model, and nothing that does not.
 *
 * The seam is deliberate: the inbox queues media here and reads descriptions
 * back, but knows nothing about Gemini — so changing provider is a change
 * inside this module rather than across the inbox.
 *
 * TWO PROVIDERS, TWO JOBS. Gemini describes media, because it is the one that
 * reads audio and video inline; OpenAI holds text conversations. They have
 * separate switches, keys and bills, and neither is a fallback for the other.
 */
@Module({
  imports: [TypeOrmModule.forFeature([])],
  providers: [
    GeminiClient,
    OpenAiClient,
    MediaDownloader,
    MediaAnalysisService,
    MediaAnalysisRepository,
    PlatformSettingRepository,
  ],
  exports: [
    MediaAnalysisService,
    GeminiClient,
    OpenAiClient,
    MediaAnalysisRepository,
    PlatformSettingRepository,
  ],
})
export class AiModule {}
