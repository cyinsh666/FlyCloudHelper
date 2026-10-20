import {
  Link,
  Outlet,
  createRootRoute,
  createRoute,
  createRouter,
  redirect,
  useNavigate,
} from "@tanstack/react-router";
import { ShieldCheck } from "lucide-react";
import { useEffect, useState } from "react";
import { SessionBoundary } from "@/components/SessionBoundary";
import { ApiClientError, getCurrentUser, getSetupStatus } from "@/lib/api";
import { SetupPage, LoginPage, RegisterPage } from "@/pages/AuthPages";
import { OverviewPage } from "@/pages/OverviewPage";
import {
  AdminServiceConnectionPage,
  AdminServicesPage,
  ServiceCreatePage,
  UserServiceConnectionPage,
  UserServicesPage,
} from "@/pages/ServicePages";
import { AdminServiceBasicDetailPage, UserServiceBasicDetailPage } from "@/pages/ServiceBasicDetailPage";
import { LibraryCreatePage } from "@/pages/LibraryCreatePage";
import { LibraryFileBrowsePage } from "@/pages/LibraryFileBrowsePage";
import { LibraryAbsSettingsPage } from "@/pages/LibraryAbsSettingsPage";
import { NativeAudiobookServicesPage } from "@/pages/native-audiobook";
import {
  AdminCatalogPage,
  AdminJobsPage,
  UserCatalogPage,
  UserJobsPage,
} from "@/pages/JobCatalogPages";
import {
  AdminLibraryCatalogPage,
  AdminLibraryJellyfinSettingsPage,
  AdminLibrarySettingsPage,
  UserLibraryCatalogPage,
  UserLibraryJellyfinSettingsPage,
  UserLibrarySettingsPage,
} from "@/pages/LibraryPages";
import {
  AdminLibraryEmbySettingsPage,
  UserLibraryEmbySettingsPage,
} from "@/pages/LibraryEmbySettingsPage";
import {
  AdminAuditPage,
  AdminConfigurationPage,
  AdminOverviewPage,
  AdminPluginsPage,
  AdminSystemPage,
  AdminUsersPage,
} from "@/pages/AdminPages";
import { AdminAiModelsPage } from "@/pages/AiModelPages";
import { AdminMusicSourcesPage } from "@/pages/MusicSourcePages";
import { AdminNotificationSettingsPage } from "@/pages/AdminNotificationSettingsPage";
import {
  AdminLibraryScanSchedulePage,
  UserLibraryScanSchedulePage,
} from "@/pages/ScanSchedulePages";

/** 根路由容器。 */
function RootRouteComponent() {
  return <Outlet />;
}

/** 普通用户控制台路由容器。 */
function UserConsoleRouteComponent() {
  return <SessionBoundary requiredRole="user" />;
}

/** 超级管理员后台路由容器。 */
function AdminConsoleRouteComponent() {
  return <SessionBoundary requiredRole="super_admin" />;
}

/** 根路径根据初始化状态和当前会话进入正确入口。 */
function RootIndexRouteComponent() {
  const navigate = useNavigate();
  const [message, setMessage] = useState("正在确认实例状态…");

  useEffect(() => {
    let active = true;

    /** 依次判断首次初始化状态和当前登录角色。 */
    async function resolveRootDestination(): Promise<void> {
      try {
        const setupState = await getSetupStatus();
        if (!active) {
          return;
        }
        if (setupState.setupRequired) {
          await navigate({ to: "/setup", replace: true });
          return;
        }

        try {
          const user = await getCurrentUser();
          if (!active) {
            return;
          }
          if (setupState.credentialKeyBackupRequired) {
            if (user.role === "super_admin") {
              await navigate({ to: "/setup", replace: true });
            } else {
              setMessage("实例正在等待超级管理员完成凭据主密钥备份");
            }
            return;
          }
          await navigate({
            to: user.role === "super_admin" ? "/admin" : "/app",
            replace: true,
          });
        } catch (error) {
          if (error instanceof ApiClientError && error.status === 401) {
            await navigate({ to: "/login", replace: true });
            return;
          }
          throw error;
        }
      } catch (error) {
        if (active) {
          setMessage(error instanceof Error ? error.message : "无法读取实例状态");
        }
      }
    }

    void resolveRootDestination();
    return () => {
      active = false;
    };
  }, [navigate]);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="surface max-w-md p-8 text-center">
        <h1 className="text-xl font-semibold">正在进入 FlyCloudHelper</h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

/** 接收光鸭官方人机验证回调，把一次性结果发送给打开本窗口的服务配置页。 */
function GuangyaCaptchaCallbackPage() {
  const [message, setMessage] = useState("正在确认光鸭人机验证结果…");

  useEffect(() => {
    const parameters = new URLSearchParams(window.location.search);
    const captchaToken = parameters.get("captcha_token") ?? "";
    const state = parameters.get("state") ?? "";
    if (!captchaToken || !state || !window.opener) {
      setMessage("未收到有效的人机验证结果，请关闭窗口后重新获取验证码");
      return;
    }
    window.opener.postMessage({
      type: "flycloud-helper-guangya-captcha",
      captchaToken,
      state,
    }, window.location.origin);
    setMessage("人机验证已完成，正在关闭窗口…");
    const closeTimer = window.setTimeout(() => window.close(), 300);
    return () => window.clearTimeout(closeTimer);
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="surface max-w-md p-8 text-center">
        <ShieldCheck className="mx-auto size-10 text-success" />
        <h1 className="mt-4 text-xl font-semibold">光鸭人机验证</h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
      </div>
    </div>
  );
}

/** 处理普通用户服务详情路由参数。 */
function UserServiceDetailRouteComponent() {
  const { serviceId } = userServiceDetailRoute.useParams();
  return <UserServiceBasicDetailPage serviceId={serviceId} />;
}

/** 处理普通用户服务连接管理路由参数。 */
function UserServiceConnectionRouteComponent() {
  const { serviceId } = userServiceConnectionRoute.useParams();
  return <UserServiceConnectionPage serviceId={serviceId} />;
}

/** 处理普通用户媒体库扫描定时任务路由参数。 */
function UserLibraryScanScheduleRouteComponent() {
  const { serviceId } = userLibraryScanScheduleRoute.useParams();
  return <UserLibraryScanSchedulePage libraryId={serviceId} />;
}

/** 处理普通用户媒体库设置路由参数。 */
function UserLibrarySettingsRouteComponent() {
  const { serviceId } = userLibrarySettingsRoute.useParams();
  return <UserLibrarySettingsPage serviceId={serviceId} />;
}

/** 普通用户 Emby 协议配置路由。 */
function UserLibraryEmbySettingsRouteComponent() {
  const { serviceId } = userLibraryEmbySettingsRoute.useParams();
  return <UserLibraryEmbySettingsPage serviceId={serviceId} />;
}

/** 个人媒体库的 ABS 协议设置。 */
function UserLibraryAbsSettingsRouteComponent() {
  const { serviceId } = userLibraryAbsSettingsRoute.useParams();
  return <LibraryAbsSettingsPage key={`${serviceId}:user`} serviceId={serviceId} />;
}

/** 普通用户统一管理听书入口，实际库链接只负责预选和筛选。 */
function UserNativeAudiobookRouteComponent() {
  const { libraryId } = userNativeAudiobookRoute.useSearch();
  return <NativeAudiobookServicesPage key={`user:${libraryId ?? "all"}`} libraryId={libraryId} />;
}

/** 管理员复用同一入口页面，库归属仍由服务端校验。 */
function AdminNativeAudiobookRouteComponent() {
  const { libraryId } = adminNativeAudiobookRoute.useSearch();
  return <NativeAudiobookServicesPage key={`admin:${libraryId ?? "all"}`} libraryId={libraryId} admin />;
}

/** 仅接受有限的库 ID 作为设置页上下文，不从 URL 接收账号凭据。 */
function nativeAudiobookSearch(input: Record<string, unknown>): { libraryId?: string } {
  return typeof input.libraryId === "string" && input.libraryId.length <= 128 ? { libraryId: input.libraryId } : {};
}

/** 处理普通用户媒体库海报墙路由参数。 */
function UserLibraryCatalogRouteComponent() {
  const { serviceId } = userLibraryCatalogRoute.useParams();
  return <UserLibraryCatalogPage serviceId={serviceId} />;
}

/** 普通用户视频媒体库文件浏览。 */
function UserLibraryFileBrowseRouteComponent() {
  const { serviceId } = userLibraryFileBrowseRoute.useParams();
  return <LibraryFileBrowsePage libraryId={serviceId} />;
}

/** 处理普通用户媒体库 Jellyfin 配置路由参数。 */
function UserLibraryJellyfinSettingsRouteComponent() {
  const { serviceId } = userLibraryJellyfinSettingsRoute.useParams();
  return <UserLibraryJellyfinSettingsPage serviceId={serviceId} />;
}

/** 处理管理员服务详情路由参数。 */
function AdminServiceDetailRouteComponent() {
  const { serviceId } = adminServiceDetailRoute.useParams();
  return <AdminServiceBasicDetailPage serviceId={serviceId} />;
}

/** 从网盘服务快捷创建媒体库。 */
function UserLibraryCreateRouteComponent() {
  const { serviceId } = userLibraryCreateRoute.useParams();
  return <LibraryCreatePage serviceId={serviceId} />;
}

/** 从媒体库管理进入统一创建页。 */
function UserLibraryCreateWithoutSourceRouteComponent() {
  return <LibraryCreatePage />;
}

/** 处理管理员服务连接管理路由参数。 */
function AdminServiceConnectionRouteComponent() {
  const { serviceId } = adminServiceConnectionRoute.useParams();
  return <AdminServiceConnectionPage serviceId={serviceId} />;
}

/** 处理管理员媒体库扫描定时任务路由参数。 */
function AdminLibraryScanScheduleRouteComponent() {
  const { serviceId } = adminLibraryScanScheduleRoute.useParams();
  return <AdminLibraryScanSchedulePage libraryId={serviceId} />;
}

/** 处理管理员媒体库设置路由参数。 */
function AdminLibrarySettingsRouteComponent() {
  const { serviceId } = adminLibrarySettingsRoute.useParams();
  return <AdminLibrarySettingsPage serviceId={serviceId} />;
}

/** 管理端 Emby 协议配置路由。 */
function AdminLibraryEmbySettingsRouteComponent() {
  const { serviceId } = adminLibraryEmbySettingsRoute.useParams();
  return <AdminLibraryEmbySettingsPage serviceId={serviceId} />;
}

/** 管理员查看指定媒体库的 ABS 协议设置。 */
function AdminLibraryAbsSettingsRouteComponent() {
  const { serviceId } = adminLibraryAbsSettingsRoute.useParams();
  return <LibraryAbsSettingsPage key={`${serviceId}:admin`} serviceId={serviceId} admin />;
}

/** 处理管理员媒体库海报墙路由参数。 */
function AdminLibraryCatalogRouteComponent() {
  const { serviceId } = adminLibraryCatalogRoute.useParams();
  return <AdminLibraryCatalogPage serviceId={serviceId} />;
}

/** 管理员视频媒体库文件浏览。 */
function AdminLibraryFileBrowseRouteComponent() {
  const { serviceId } = adminLibraryFileBrowseRoute.useParams();
  return <LibraryFileBrowsePage libraryId={serviceId} admin />;
}

/** 处理管理员媒体库 Jellyfin 配置路由参数。 */
function AdminLibraryJellyfinSettingsRouteComponent() {
  const { serviceId } = adminLibraryJellyfinSettingsRoute.useParams();
  return <AdminLibraryJellyfinSettingsPage serviceId={serviceId} />;
}

/** 全局 404 页面。 */
function NotFoundPage() {
  return (
    <div className="flex min-h-screen items-center justify-center px-4">
      <div className="surface max-w-md p-8 text-center">
        <p className="font-display text-6xl font-semibold text-gradient">404</p>
        <h1 className="mt-4 text-xl font-semibold">页面不存在</h1>
        <p className="mt-2 text-sm text-muted-foreground">页面已移动、链接无效，或当前版本尚未实现该页面。</p>
        <Link
          to="/login"
          className="mt-6 inline-flex rounded-lg bg-primary px-4 py-2.5 text-sm text-primary-foreground"
        >
          返回登录
        </Link>
      </div>
    </div>
  );
}

const rootRoute = createRootRoute({
  component: RootRouteComponent,
  notFoundComponent: NotFoundPage,
});

const rootIndexRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/",
  component: RootIndexRouteComponent,
});

const setupRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "setup",
  component: SetupPage,
});

const loginRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "login",
  component: LoginPage,
});

const registerRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "register",
  component: RegisterPage,
});

const guangyaCaptchaCallbackRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "guangya-captcha-callback",
  component: GuangyaCaptchaCallbackPage,
});

const appRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "app",
  component: UserConsoleRouteComponent,
});

const appIndexRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "/",
  component: OverviewPage,
});

const userServicesRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "services",
  component: UserServicesPage,
});

const userServiceCreateRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "services/new",
  component: ServiceCreatePage,
});

const userServiceDetailRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "services/$serviceId",
  component: UserServiceDetailRouteComponent,
});

const userServiceConnectionRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "services/$serviceId/connection",
  component: UserServiceConnectionRouteComponent,
});

const userJobsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "jobs",
  component: UserJobsPage,
});

const userCatalogRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "catalog",
  component: UserCatalogPage,
});

const userLibrarySettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "libraries/$serviceId/settings",
  component: UserLibrarySettingsRouteComponent,
});

const userLibraryCreateRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "libraries/new/$serviceId",
  component: UserLibraryCreateRouteComponent,
});

const userLibraryCreateWithoutSourceRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "libraries/new",
  component: UserLibraryCreateWithoutSourceRouteComponent,
});

const userLibraryCatalogRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "libraries/$serviceId/catalog",
  component: UserLibraryCatalogRouteComponent,
});

const userLibraryFileBrowseRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "libraries/$serviceId/files",
  component: UserLibraryFileBrowseRouteComponent,
});

const userLibraryScanScheduleRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "libraries/$serviceId/scan-schedules",
  component: UserLibraryScanScheduleRouteComponent,
});

const userLibraryJellyfinSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "libraries/$serviceId/jellyfin",
  component: UserLibraryJellyfinSettingsRouteComponent,
});

const userLibraryEmbySettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "libraries/$serviceId/emby",
  component: UserLibraryEmbySettingsRouteComponent,
});

const userLibraryAbsSettingsRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "libraries/$serviceId/abs",
  component: UserLibraryAbsSettingsRouteComponent,
});

const userNativeAudiobookRoute = createRoute({
  getParentRoute: () => appRoute,
  path: "audiobook-services",
  validateSearch: nativeAudiobookSearch,
  component: UserNativeAudiobookRouteComponent,
});

const adminRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "admin",
  component: AdminConsoleRouteComponent,
});

const adminIndexRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "/",
  component: AdminOverviewPage,
});

const adminUsersRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "users",
  component: AdminUsersPage,
});

const adminServicesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "services",
  component: AdminServicesPage,
});

/** 旧管理员创建地址切换到个人模式，创建归属当前登录账户。 */
const adminServiceCreateRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "services/new",
  beforeLoad: () => {
    throw redirect({ to: "/app/services/new", replace: true });
  },
});

const adminServiceDetailRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "services/$serviceId",
  component: AdminServiceDetailRouteComponent,
});

const adminServiceConnectionRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "services/$serviceId/connection",
  component: AdminServiceConnectionRouteComponent,
});

const adminJobsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "jobs",
  component: AdminJobsPage,
});

const adminCatalogRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "catalog",
  component: AdminCatalogPage,
});

const adminLibrarySettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "libraries/$serviceId/settings",
  component: AdminLibrarySettingsRouteComponent,
});

const adminLibraryCatalogRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "libraries/$serviceId/catalog",
  component: AdminLibraryCatalogRouteComponent,
});

const adminLibraryFileBrowseRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "libraries/$serviceId/files",
  component: AdminLibraryFileBrowseRouteComponent,
});

const adminLibraryScanScheduleRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "libraries/$serviceId/scan-schedules",
  component: AdminLibraryScanScheduleRouteComponent,
});

const adminLibraryJellyfinSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "libraries/$serviceId/jellyfin",
  component: AdminLibraryJellyfinSettingsRouteComponent,
});

const adminLibraryEmbySettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "libraries/$serviceId/emby",
  component: AdminLibraryEmbySettingsRouteComponent,
});

const adminLibraryAbsSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "libraries/$serviceId/abs",
  component: AdminLibraryAbsSettingsRouteComponent,
});

const adminNativeAudiobookRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "audiobook-services",
  validateSearch: nativeAudiobookSearch,
  component: AdminNativeAudiobookRouteComponent,
});

const adminPluginsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "plugins",
  component: AdminPluginsPage,
});

const adminAiModelsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "ai-models",
  component: AdminAiModelsPage,
});

const adminSystemRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "system",
  component: AdminSystemPage,
});

const adminConfigurationRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "config",
  component: AdminConfigurationPage,
});

const adminMusicSourcesRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "config/music-sources",
  component: AdminMusicSourcesPage,
});

const adminNotificationSettingsRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "config/notifications",
  component: AdminNotificationSettingsPage,
});

const adminAuditRoute = createRoute({
  getParentRoute: () => adminRoute,
  path: "audit",
  component: AdminAuditPage,
});

/** 组合普通用户控制台子路由。 */
const appRouteTree = appRoute.addChildren([
  appIndexRoute,
  userServicesRoute,
  userServiceCreateRoute,
  userServiceDetailRoute,
  userServiceConnectionRoute,
  userJobsRoute,
  userCatalogRoute,
  userLibraryCreateRoute,
  userLibraryCreateWithoutSourceRoute,
  userLibrarySettingsRoute,
  userLibraryCatalogRoute,
  userLibraryFileBrowseRoute,
  userLibraryScanScheduleRoute,
  userLibraryJellyfinSettingsRoute,
  userLibraryEmbySettingsRoute,
  userLibraryAbsSettingsRoute,
  userNativeAudiobookRoute,
]);

/** 组合超级管理员后台子路由。 */
const adminRouteTree = adminRoute.addChildren([
  adminIndexRoute,
  adminUsersRoute,
  adminServicesRoute,
  adminServiceCreateRoute,
  adminServiceDetailRoute,
  adminServiceConnectionRoute,
  adminJobsRoute,
  adminCatalogRoute,
  adminLibrarySettingsRoute,
  adminLibraryCatalogRoute,
  adminLibraryFileBrowseRoute,
  adminLibraryScanScheduleRoute,
  adminLibraryJellyfinSettingsRoute,
  adminLibraryEmbySettingsRoute,
  adminLibraryAbsSettingsRoute,
  adminNativeAudiobookRoute,
  adminPluginsRoute,
  adminAiModelsRoute,
  adminConfigurationRoute,
  adminMusicSourcesRoute,
  adminNotificationSettingsRoute,
  adminSystemRoute,
  adminAuditRoute,
]);

/** FlyCloudHelper Web 完整路由树。 */
const routeTree = rootRoute.addChildren([
  rootIndexRoute,
  setupRoute,
  loginRoute,
  registerRoute,
  guangyaCaptchaCallbackRoute,
  appRouteTree,
  adminRouteTree,
]);

/** FlyCloudHelper Web 路由实例。 */
export const router = createRouter({
  routeTree,
  defaultPreload: "intent",
  scrollRestoration: true,
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
