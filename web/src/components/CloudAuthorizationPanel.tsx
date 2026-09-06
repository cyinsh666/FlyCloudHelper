import { LoaderCircle, LogIn, RotateCcw } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { StatusPill } from "@/components/ui-kit";
import {
  completeCloudAuthorization,
  pollCloudAuthorization,
  startCloudAuthorization,
  type CloudAuthorizationStatus,
  type ProviderDescriptor,
} from "@/lib/api";

interface CloudAuthorizationPanelProps {
  descriptor: ProviderDescriptor;
  admin: boolean;
  targetUserId?: string;
  resetKey: string;
  onAuthorizationChange: (authorization: CloudAuthorizationStatus | null) => void;
}

const stateLabels: Record<CloudAuthorizationStatus["state"], string> = {
  waiting: "等待扫码", scanned: "已扫码", confirmed: "正在完成", authorized: "授权成功",
  rejected: "已拒绝", expired: "已过期", cancelled: "已取消", failed: "授权失败",
};

/** 返回Provider推荐的登录来源，缺少推荐项时使用列表第一项。 */
function getDefaultAuthSource(descriptor: ProviderDescriptor): string {
  return descriptor.authSources?.find((item) => item.recommended)?.value
    ?? descriptor.authSources?.[0]?.value
    ?? "";
}

/** 四类新增网盘共用的扫码面板，页面永远接触不到 Token 或 Cookie。 */
export function CloudAuthorizationPanel({ descriptor, admin, targetUserId, resetKey, onAuthorizationChange }: CloudAuthorizationPanelProps) {
  const [authorization, setAuthorization] = useState<CloudAuthorizationStatus | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [pollingRevision, setPollingRevision] = useState(0);
  const [selectedAuthSource, setSelectedAuthSource] = useState(() => getDefaultAuthSource(descriptor));
  // 关键变量：保持父级回调稳定，避免表单重渲染重复创建轮询定时器。
  const authorizationChangeRef = useRef(onAuthorizationChange);

  useEffect(() => { authorizationChangeRef.current = onAuthorizationChange; }, [onAuthorizationChange]);
  useEffect(() => {
    setAuthorization(null);
    setMessage(null);
    setPollingRevision(0);
    setSelectedAuthSource(getDefaultAuthSource(descriptor));
    authorizationChangeRef.current(null);
  }, [descriptor, resetKey]);

  useEffect(() => {
    if (!authorization || !["waiting", "scanned", "confirmed"].includes(authorization.state)) return;
    const delay = Math.max(1, authorization.pollIntervalSeconds) * 1_000;
    const timer = window.setTimeout(() => {
      const action = authorization.state === "confirmed"
        ? completeCloudAuthorization(descriptor.type, authorization.authorizationSessionId, admin)
        : pollCloudAuthorization(descriptor.type, authorization.authorizationSessionId, admin);
      void action.then((next) => {
        setAuthorization(next);
        authorizationChangeRef.current(next);
      }).catch((error) => {
        setMessage(error instanceof Error ? error.message : `${descriptor.displayName}扫码状态查询失败`);
        setPollingRevision((current) => current + 1);
      });
    }, delay);
    return () => window.clearTimeout(timer);
  }, [admin, authorization, descriptor.displayName, descriptor.type, pollingRevision]);

  /** 创建只归属当前用户的一次性扫码会话。 */
  async function start(): Promise<void> {
    if (admin && !targetUserId) { setMessage("请先选择所属用户，再进行扫码登录"); return; }
    setWorking(true);
    setMessage(`正在获取${descriptor.displayName}二维码…`);
    try {
      const next = await startCloudAuthorization(
        descriptor.type,
        admin,
        targetUserId,
        selectedAuthSource ? { clientType: selectedAuthSource } : {},
      );
      setAuthorization(next);
      authorizationChangeRef.current(next);
      const sourceLabel = descriptor.authSources?.find((item) => item.value === selectedAuthSource)?.label;
      setMessage(`请使用${descriptor.displayName}客户端扫码并确认${sourceLabel ? `，当前来源：${sourceLabel}` : ""}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : `无法启动${descriptor.displayName}扫码登录`);
    } finally { setWorking(false); }
  }

  const active = authorization && ["waiting", "scanned", "confirmed"].includes(authorization.state);
  const tone = authorization?.state === "authorized" ? "success" : authorization && ["failed", "rejected"].includes(authorization.state) ? "danger" : "primary";
  const selectedSourceLabel = descriptor.authSources?.find((item) => item.value === selectedAuthSource)?.label;
  return (
    <div className="rounded-xl border border-border bg-secondary/25 p-4 lg:col-span-2">
      <div className="flex items-start justify-between gap-3">
        <div><p className="text-sm font-medium">{descriptor.displayName}扫码登录</p><p className="mt-1 text-xs text-muted-foreground">由 Fly云助手直接请求网盘官方接口，凭据加密保存在当前实例。</p></div>
        {authorization && <StatusPill tone={tone}>{stateLabels[authorization.state]}</StatusPill>}
      </div>
      {descriptor.authSources && descriptor.authSources.length > 0 && (
        <label className="mt-4 block">
          <span className="text-xs text-muted-foreground">登录来源</span>
          <select
            value={selectedAuthSource}
            disabled={working || Boolean(active)}
            onChange={(event) => {
              setSelectedAuthSource(event.target.value);
              setAuthorization(null);
              setMessage(null);
              authorizationChangeRef.current(null);
            }}
            className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm disabled:cursor-not-allowed disabled:opacity-60"
          >
            {descriptor.authSources.map((source) => <option key={source.value} value={source.value}>{source.label}{source.recommended ? "（推荐）" : ""}</option>)}
          </select>
          <span className="mt-2 block text-[11px] text-muted-foreground">{selectedAuthSource === "openapi" ? "官方 OpenAPI 直接完成设备码授权。" : "客户端来源会先完成115扫码登录，再由云助手内部转换为可刷新的 OpenAPI 凭据。"}</span>
        </label>
      )}
      {active && authorization.qrCodeContent && (
        <div className="mt-4 grid gap-4 rounded-lg border border-border bg-background/35 p-4 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
          <div className="w-fit rounded-lg bg-white p-2"><QRCodeSVG value={authorization.qrCodeContent} size={176} bgColor="#ffffff" fgColor="#111827" level="M" marginSize={1} title={`${descriptor.displayName}扫码登录`} /></div>
          <div><p className="text-sm font-medium">使用{descriptor.displayName}客户端扫描并确认</p>{selectedSourceLabel && <p className="mt-1 text-xs text-muted-foreground">当前来源：{selectedSourceLabel}</p>}<p className="mt-2 text-xs text-muted-foreground">{authorization.message || "等待扫码确认"}</p><p className="mt-2 text-[11px] text-muted-foreground">二维码有效期至 {new Date(authorization.expiresAt).toLocaleTimeString("zh-CN")}</p></div>
        </div>
      )}
      {authorization?.state === "authorized" && <p className="mt-4 text-sm text-success">授权成功{authorization.accountSummary ? `，账号 ${authorization.accountSummary}` : ""}。</p>}
      <div className="mt-4 flex items-center gap-3">
        {authorization ? <SecondaryButton type="button" disabled={working || Boolean(active)} onClick={() => void start()}>{working ? <LoaderCircle className="size-4 animate-spin" /> : <RotateCcw className="size-4" />}重新获取二维码</SecondaryButton>
          : <PrimaryButton type="button" disabled={working} onClick={() => void start()}>{working ? <LoaderCircle className="size-4 animate-spin" /> : <LogIn className="size-4" />}{working ? "正在获取…" : "开始扫码登录"}</PrimaryButton>}
      </div>
      {message && <p role="status" aria-live="polite" className="mt-3 text-xs text-muted-foreground">{message}</p>}
    </div>
  );
}
