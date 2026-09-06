import type { ApiConfig } from "../config.js";
import { ApiError } from "../errors.js";
import { AliyunDriveProvider } from "./aliyundrive.js";
import { BaiduPanProvider } from "./baidupan.js";
import { GuangyaProvider } from "./guangya.js";
import { GuangyaAuthorizationManager, GuangyaWebApiClient } from "./guangya-web-api.js";
import { GuangyaOpenApiClient } from "./guangya-open-api.js";
import type { ProviderAdapter, ProviderDescriptor } from "./types.js";
import { WebDavProvider } from "./webdav.js";
import { CloudAuthorizationManager } from "./auth/manager.js";
import { Cloud115AuthorizationDriver } from "./auth/cloud115-authorization.js";
import { Cloud123AuthorizationDriver } from "./auth/cloud123-authorization.js";
import { Cloud189AuthorizationDriver } from "./auth/cloud189-authorization.js";
import { QuarkAuthorizationDriver } from "./auth/quark-authorization.js";
import { Cloud115Provider } from "./cloud115.js";
import { Cloud123Provider } from "./cloud123.js";
import { Cloud189Provider } from "./cloud189.js";
import { QuarkProvider } from "./quark.js";

/** 管理内置 Provider 能力，扫描核心只依赖统一适配器契约。 */
export class ProviderRegistry {
  private readonly adapters = new Map<string, ProviderAdapter>();
  public readonly guangyaAuthorization: GuangyaAuthorizationManager;
  public readonly cloudAuthorization = new CloudAuthorizationManager();

  public constructor(
    config: ApiConfig,
    logConnectionFailure?: (fields: Record<string, string | number | boolean | null>) => void,
  ) {
    // 关键变量：扫码授权和 Provider 共用网页接口客户端，统一执行文件列表限频与 Token 刷新。
    const guangyaClient = new GuangyaWebApiClient(logConnectionFailure);
    this.guangyaAuthorization = new GuangyaAuthorizationManager(guangyaClient);
    const networkOptions = {
      allowInsecureHttp: config.allowInsecureProviderHttp,
      logConnectionFailure,
    };
    [
      new WebDavProvider(networkOptions),
      new AliyunDriveProvider(networkOptions),
      new BaiduPanProvider(networkOptions),
      new GuangyaProvider(guangyaClient, new GuangyaOpenApiClient(logConnectionFailure)),
    ].forEach((adapter) => this.adapters.set(adapter.descriptor.type, adapter));
    // 四种新增网盘属于内置能力，固定注册，不能受历史容器环境变量影响。
    this.add(new Cloud115Provider(networkOptions));
    this.cloudAuthorization.register(new Cloud115AuthorizationDriver(config.cloud115ClientId));
    this.add(new Cloud123Provider(networkOptions));
    this.cloudAuthorization.register(new Cloud123AuthorizationDriver());
    this.add(new Cloud189Provider(networkOptions));
    this.cloudAuthorization.register(new Cloud189AuthorizationDriver());
    this.add(new QuarkProvider(networkOptions));
    this.cloudAuthorization.register(new QuarkAuthorizationDriver());
  }

  /** 注册单个 Provider，保持构造函数中的启用逻辑清晰。 */
  private add(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.descriptor.type, adapter);
  }

  /** 返回指定 Provider，未知类型使用稳定错误码。 */
  public get(providerType: string): ProviderAdapter {
    const adapter = this.adapters.get(providerType);
    if (!adapter) {
      throw new ApiError(422, "provider_not_supported", `当前实例不支持 Provider：${providerType}`);
    }
    return adapter;
  }

  /** 返回当前实例全部 Provider 能力描述。 */
  public listDescriptors(): ProviderDescriptor[] {
    return [...this.adapters.values()].map((adapter) => adapter.descriptor);
  }
}
