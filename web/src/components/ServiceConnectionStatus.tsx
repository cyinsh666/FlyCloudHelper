import { Link } from "@tanstack/react-router";
import { StatusPill, type StatusTone } from "@/components/ui-kit";
import type { CloudService } from "@/lib/api";

/** 只展示已知的连接问题，业务错误不推断为登录过期。 */
export function getServiceConnectionIssue(service: CloudService): { title: string; description: string } | null {
  if (service.connectionStatus === "reauthorization_required" || service.status === "reauthorization_required") {
    return { title: "需重新授权", description: "服务登录已失效，请重新登录或更新连接配置。" };
  }
  if (service.providerType === "cloud123" && service.connectionStatus === "cloud123_business_failed") {
    return { title: "123 云盘接口异常", description: "123 云盘接口返回业务错误，具体原因尚未确定，可尝试重新登录后重试扫描。" };
  }
  return null;
}

/** 服务运行状态和连接状态一起展示，异常时不再显示正常。 */
export function ServiceStatePill({ service }: { service: CloudService }) {
  const issue = getServiceConnectionIssue(service);
  let label = "正常";
  let tone: StatusTone = "success";
  if (service.status === "disabled") {
    label = "已停用";
    tone = "neutral";
  } else if (issue) {
    label = issue.title;
    tone = "warning";
  } else if (service.status === "scanning") {
    label = "扫描中";
    tone = "primary";
  }
  return <StatusPill tone={tone}>{label}</StatusPill>;
}

/** 在服务卡片、详情和连接页展示异常，入口跳转到现有登录流程。 */
export function ServiceConnectionAlert({ service, admin, showLogin = true }: { service: CloudService; admin: boolean; showLogin?: boolean }) {
  const issue = getServiceConnectionIssue(service);
  if (!issue) return null;
  // 关键变量：管理员与普通用户分别进入各自的连接管理页面。
  const connectionPath = admin ? "/admin/services/$serviceId/connection" : "/app/services/$serviceId/connection";
  return (
    <div role="status" className="mt-4 rounded-xl border border-border bg-secondary/40 p-3 text-xs">
      <p className="text-foreground">{issue.description}</p>
      {showLogin && <Link to={connectionPath} params={{ serviceId: service.id }} className="mt-3 inline-flex rounded-lg border border-border px-3 py-2 text-foreground">重新登录 / 更新连接</Link>}
    </div>
  );
}
