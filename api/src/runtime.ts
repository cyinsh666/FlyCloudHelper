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
import type { MediaProbeWorker } from "./media-probe-worker.js";
import type { ScanScheduleStore, ScanScheduleWorker } from "./scan-schedule-service.js";
import type { TelegramNotificationService } from "./telegram-notification-service.js";
import type { ContentSourceManager } from "./content-sources/manager.js";
import type { ContentMusicManager } from "./content-sources/music-manager.js";
import type { ContentSourceAutoSyncWorker } from "./content-sources/auto-sync.js";
import type { ContentSourceDiagnostics } from "./content-sources/diagnostics.js";

/** 后台路由共享的已初始化运行时依赖。 */
export interface ApiRuntime {
  config: ApiConfig;
  database: FlyCloudHelperDatabase;
  repository: ServiceRepository;
  providers: ProviderRegistry;
  vault: CredentialVault;
  tmdbCache: TmdbMetadataCache;
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
  telegramNotifications: TelegramNotificationService;
  logBusinessEvent: (
    level: "info" | "warn",
    fields: Record<string, string | number | boolean | null>,
  ) => void;
}
