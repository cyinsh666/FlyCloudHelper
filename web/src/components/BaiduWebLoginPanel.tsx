import { useEffect, useRef, useState } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel } from "@/components/ui-kit";
import {
  cancelBaiduWebLogin, clearBaiduWebLogin, getBaiduWebLoginConfiguration,
  getBaiduWebLoginStatus, startBaiduWebLogin,
  type BaiduWebLoginStatus,
} from "@/lib/api";

/** 百度官网扫码会话只在本页存活，页面离开时主动释放服务端浏览器。 */
export function BaiduWebLoginPanel({ serviceId, admin }: { serviceId: string; admin: boolean }) {
  const [configured, setConfigured] = useState(false);
  const [sessionId, setSessionId] = useState("");
  const [status, setStatus] = useState<BaiduWebLoginStatus | null>(null);
  const [message, setMessage] = useState("");
  const [starting, setStarting] = useState(false);
  const [clearing, setClearing] = useState(false);
  const activeSessionId = useRef(""); // 关键变量：异步轮询和卸载回调始终读取当前会话。
  const polling = useRef(false);

  useEffect(() => {
    let mounted = true;
    void getBaiduWebLoginConfiguration(serviceId, admin).then((result) => {
      if (mounted) setConfigured(result.configured);
    }).catch((error) => {
      if (mounted) setMessage(error instanceof Error ? error.message : "补充登录状态读取失败");
    });
    return () => {
      mounted = false;
      if (activeSessionId.current) void cancelBaiduWebLogin(serviceId, activeSessionId.current, admin).catch(() => undefined);
    };
  }, [serviceId, admin]);

  /** 轮询只请求当前会话，避免截图请求重叠导致浏览器过载。 */
  async function pollSession(): Promise<void> {
    const currentId = activeSessionId.current;
    if (!currentId || polling.current) return;
    polling.current = true;
    try {
      const result = await getBaiduWebLoginStatus(serviceId, currentId, admin);
      if (activeSessionId.current !== currentId) return;
      setStatus(result);
      setMessage(result.message);
      if (result.state !== "waiting") {
        activeSessionId.current = "";
        setSessionId("");
        if (result.state === "authorized") setConfigured(true);
      }
    } catch (error) {
      if (activeSessionId.current === currentId) {
        setMessage(error instanceof Error ? error.message : "扫码状态读取失败");
        if (error instanceof Error && error.message.includes("已过期")) {
          activeSessionId.current = "";
          setSessionId("");
          setStatus(null);
        }
      }
    } finally {
      polling.current = false;
    }
  }

  useEffect(() => {
    if (!sessionId) return;
    const timer = window.setInterval(() => { void pollSession(); }, 2500);
    return () => window.clearInterval(timer);
  }, [sessionId, serviceId, admin]);

  /** 创建服务端隔离浏览器，并立即显示百度网页二维码。 */
  async function beginLogin(): Promise<void> {
    if (starting) return;
    setStarting(true);
    setMessage("正在打开百度官网扫码页面…");
    try {
      if (activeSessionId.current) {
        await cancelBaiduWebLogin(serviceId, activeSessionId.current, admin);
      }
      const session = await startBaiduWebLogin(serviceId, admin);
      activeSessionId.current = session.sessionId;
      setSessionId(session.sessionId);
      setStatus(null);
      await pollSession();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "百度扫码页面打开失败");
    } finally {
      setStarting(false);
    }
  }

  /** 清除当前网页会话，不影响百度网盘原有登录。 */
  async function removeLogin(): Promise<void> {
    if (clearing) return;
    setClearing(true);
    try {
      await clearBaiduWebLogin(serviceId, admin);
      setConfigured(false);
      setStatus(null);
      setMessage("补充网页登录已清除，视频继续使用原百度播放方式");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "清除补充登录失败");
    } finally {
      setClearing(false);
    }
  }

  return (
    <Panel title="百度补充网页登录" description="用当前百度网盘服务的同一账号扫描官网二维码。成功后，Jellyfin 和 Emby 视频优先尝试网页取链；不适合直连时按媒体库中转设置处理。">
      <p className="text-sm text-muted-foreground">当前状态：{configured ? "已配置" : "未配置"}</p>
      <div className="mt-4 flex flex-wrap gap-2">
        <PrimaryButton type="button" disabled={starting} onClick={() => void beginLogin()}>
          {starting ? "正在打开…" : configured ? "重新扫码登录" : "扫码登录"}
        </PrimaryButton>
        {configured && <SecondaryButton type="button" disabled={clearing} onClick={() => void removeLogin()}>
          {clearing ? "正在清除…" : "清除补充登录"}
        </SecondaryButton>}
      </div>
      {message && <p className="mt-3 text-sm text-muted-foreground">{message}</p>}
      {sessionId && status?.imageDataUrl && <div className="mt-4 overflow-auto rounded-xl border border-border bg-white p-2">
        <img src={status.imageDataUrl} alt="百度官网扫码登录页面" className="mx-auto block h-auto max-w-none" width={900} height={700} />
      </div>}
    </Panel>
  );
}
