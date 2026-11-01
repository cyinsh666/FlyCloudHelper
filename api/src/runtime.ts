import type { LiveLibraryManager } from "./live/manager.js";
import type { ApiConfig } from "./config.js";
import type { AiModelManager } from "./ai/ai-model-manager.js";
import type { FlyCloudHelperDatabase } from "./database.js";
import type { MusicBrainzClient } from "./metadata/musicbrainz.js";
import type { TmdbMetadataCache } from "./metadata/tmdb-cache.js";
import type { TmdbKeyPool } from "./metadata/tmdb.js";
import type { MetadataPluginManager } from "./plugin-manager.js";
import type { ProviderRegistry } from "./providers/registry.js";
import type { ScanFailureReportService } from "./scan-failure-report-service.js";
import type { CredentialVault } from "./secrets.js";
import type { ServiceRepository } from "./service-repository.js";
import type { ScanWorker } from "./worker.js";
import type { PublicAccessService } from "./public-access.js";
import type { ServiceAccessService } from "./service-access.js";
import type { EmbyAccessService } from "./emby-access.js";
import type { AbsAccessService } from "./abs/access.js";
import type { MediaProbeWorker } from "./media-probe-worker.js";
import type { ScanScheduleStore, ScanScheduleWorker } from "./scan-schedule-service.js";
import type { TelegramNotificationService } from "./telegram-notification-service.js";
import type { ContentSourceManager } from "./content-sources/manager.js";
import type { ContentMusicManager } from "./content-sources/music-manager.js";
import type { ContentAudiobookManager } from "./content-sources/audiobook-manager.js";
import type { ContentSourceAutoSyncWorker } from "./content-sources/auto-sync.js";
import type { ContentSourceDiagnostics } from "./content-sources/diagnostics.js";
import type { ProtocolImageCache } from "./media/image-cache.js";
import type { ProtocolCollageService } from "./media/protocol-collage.js";

/** 后台路由共享的已初始化运行时依赖。 */
export interface ApiRuntime {
  config: ApiConfig;
  database: FlyCloudHelperDatabase;
  repository: ServiceRepository;
  providers: ProviderRegistry;
  vault: CredentialVault;
  tmdbCache: TmdbMetadataCache;
  /** 协议图片共用的本地文件缓存。 */
  imageCache: ProtocolImageCache;
  /** Jellyfin、Emby 的虚拟媒体库拼贴封面开关及文件。 */
  protocolCollage: ProtocolCollageService;
  tmdb: TmdbKeyPool;
  musicBrainz: MusicBrainzClient;
  worker: ScanWorker;
  mediaProbeWorker: MediaProbeWorker;
  scanSchedules: ScanScheduleStore;
  scanScheduleWorker: ScanScheduleWorker;
  plugins: MetadataPluginManager;
  /** 独立内容源插件、配置实例、在线目录与即时播放取址。 */
  contentSources: ContentSourceManager;
  /** 独立音乐源目录和播放定位，与网盘服务及文件扫描分开。 */
  contentMusic: ContentMusicManager;
  /** 在线有声书摘要、实时搜索、按需章节和播放取址，复用标准 ABS 出口。 */
  contentAudiobooks: ContentAudiobookManager;
  /** 独立直播频道订阅、常驻来源和即时 HLS 代理。 */
  liveLibraries: LiveLibraryManager;
  /** 用户主动开启的内容源更新计划，不与网盘定时扫描混用。 */
  contentSourceAutoSync: ContentSourceAutoSyncWorker;
  /** 内容源目录、线路抽查与最近播放失败的持久摘要。 */
  contentSourceDiagnostics: ContentSourceDiagnostics;
  aiModels: AiModelManager;
  failureReports: ScanFailureReportService;
  publicAccess: PublicAccessService;
  serviceAccess: ServiceAccessService;
  /** 独立 Emby 协议账号、令牌和会话服务，不能与 Jellyfin 共用。 */
  embyAccess: EmbyAccessService;
  /** 按有声书媒体库隔离的 ABS 账号、JWT 和刷新会话。 */
  absAccess: AbsAccessService;
  telegramNotifications: TelegramNotificationService;
  logBusinessEvent: (
    level: "info" | "warn",
    fields: Record<string, string | number | boolean | null>,
  ) => void;
}
