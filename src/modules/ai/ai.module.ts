import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { CryptoModule } from '@/shared/crypto';
import { MediaAnalysisRepository } from '@/database/repositories/media-analysis.repository';
import { ModelCallRepository } from '@/database/repositories/model-call.repository';
import { PlatformSettingRepository } from '@/database/repositories/platform-setting.repository';
import { GeminiClient } from './gemini.client';
import { OpenAiClient } from './openai.client';
import { ChatService } from './chat.service';
import { WireCaptureService } from './wire-capture.service';
import { ModelRouter } from './model-router.service';
import { MediaDownloader } from './media-downloader';
import { MediaAnalysisService } from './media-analysis.service';
import { ToolRunnerService } from './tools';
import { AssistantToolCallRepository } from '@/database/repositories/assistant-tool-call.repository';
import { CallbackRequestRepository } from '@/database/repositories/callback-request.repository';
import { CustomerRepository } from '@/database/repositories/customer.repository';
import { ConversationRepository } from '@/database/repositories/conversation.repository';
import { RewardWalletRepository } from '@/database/repositories/reward-wallet.repository';
import { RewardEntitlementRepository } from '@/database/repositories/reward-entitlement.repository';
import { MessageRepository } from '@/database/repositories/message.repository';
import { MessageAttachmentRepository } from '@/database/repositories/message-attachment.repository';

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
  /* CryptoModule: a console-held API key is stored encrypted, like a Meta token. */
  imports: [TypeOrmModule.forFeature([]), CryptoModule],
  providers: [
    GeminiClient,
    OpenAiClient,
    ModelRouter,
    ChatService,
    WireCaptureService,
    MediaDownloader,
    MediaAnalysisService,
    MediaAnalysisRepository,
    ModelCallRepository,
    PlatformSettingRepository,
    /*
     * THE TOOLS LIVE WITH THE MODEL, not with the inbox.
     *
     * A tool is something a MODEL can ask for, and the thing that decides
     * what may be asked for is the same thing that writes the prompt saying
     * so. The inbox drives the loop and knows nothing about which tools
     * exist — the same seam that lets the provider change without the inbox
     * noticing.
     *
     * The repositories a tool reads are provided here rather than imported,
     * for the reason the inbox provides GraphApiClient: importing the module
     * that holds them would be a cycle, and a repository is stateless.
     */
    ToolRunnerService,
    AssistantToolCallRepository,
    CallbackRequestRepository,
    CustomerRepository,
    MessageRepository,
    MessageAttachmentRepository,
    /*
     * The three the newest tools read. Provided here for the reason the ones
     * above are: importing the modules that own them would be a cycle, and a
     * repository holds no state worth sharing an instance of.
     */
    ConversationRepository,
    RewardWalletRepository,
    RewardEntitlementRepository,
  ],
  exports: [
    MediaAnalysisService,
    GeminiClient,
    OpenAiClient,
    ModelRouter,
    ChatService,
    MediaAnalysisRepository,
    ModelCallRepository,
    PlatformSettingRepository,
    ToolRunnerService,
    WireCaptureService,
  ],
})
export class AiModule {}
