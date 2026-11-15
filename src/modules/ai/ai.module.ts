import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { MediaAnalysisRepository } from '@/database/repositories/media-analysis.repository';
import { PlatformSettingRepository } from '@/database/repositories/platform-setting.repository';
import { GeminiClient } from './gemini.client';
import { MediaDownloader } from './media-downloader';
import { MediaAnalysisService } from './media-analysis.service';

/**
 * Everything that talks to a model, and nothing that does not.
 *
 * The seam is deliberate: the inbox queues media here and reads descriptions
 * back, but knows nothing about Gemini — so changing provider is a change
 * inside this module rather than across the inbox.
 */
@Module({
  imports: [TypeOrmModule.forFeature([])],
  providers: [
    GeminiClient,
    MediaDownloader,
    MediaAnalysisService,
    MediaAnalysisRepository,
    PlatformSettingRepository,
  ],
  exports: [MediaAnalysisService, GeminiClient, MediaAnalysisRepository, PlatformSettingRepository],
})
export class AiModule {}
