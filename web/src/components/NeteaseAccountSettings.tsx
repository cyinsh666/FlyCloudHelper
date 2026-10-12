import { QRCodeSVG } from "qrcode.react";
import { useEffect, useRef, useState } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { ContentSourceSettingsDialog } from "@/components/ContentSourceSettingsDialog";
import { StatusPill } from "@/components/ui-kit";
import {
  checkNeteaseAccount,
  checkNeteaseQrSession,
  createNeteaseQrSession,
  getNeteaseAccount,
  importNeteaseWebSession,
  logoutNeteaseAccount,
  type NeteaseAccountState,
  type NeteaseQrCheckResult,
  type NeteaseQrSession,
} from "@/lib/content-music-account-api";

/** 网易扫码登录仅接收当前音乐库状态，不改变客户端的连接信息。 */
interface NeteaseAccountSettingsState {
  libraryId: string;
  admin: boolean;
  onChanged: () => Promise<void>;
}

const qrStatusLabels: Record<NeteaseQrCheckResult["status"], string> = {
  waiting: "等待扫码", scanned: "已扫码，请在网易云音乐 App 中确认", expired: "二维码已过期", authorized: "登录成功",
  verification_required: "网易限制了这次扫码登录，可查看原站说明或使用网页登录会话",
};

/** 仅展示网易官方 HTTPS 验证入口，签名地址只用于用户主动打开。 */
function readOfficialVerificationUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password
      || (url.hostname !== "163.com" && !url.hostname.endsWith(".163.com"))) return null;
    return url.href;
  } catch { return null; }
}

/** 展示账号摘要和紧凑扫码弹窗，授权凭据始终由云助手处理。 */
export function NeteaseAccountSettings({ state }: { state: NeteaseAccountSettingsState }) {
  const { libraryId, admin, onChanged } = state;
  const [account, setAccount] = useState<NeteaseAccountState | null>(null);
  const [loading, setLoading] = useState(true);
  // 关键变量：摘要读取失败单独保留恢复入口，不把扫码轮询错误当作登录损坏。
  const [summaryFailed, setSummaryFailed] = useState(false);
  const [operation, setOperation] = useState<"qr" | "check" | "logout" | "session" | null>(null);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [qrSession, setQrSession] = useState<NeteaseQrSession | null>(null);
  const [qrStatus, setQrStatus] = useState<NeteaseQrCheckResult["status"]>("waiting");
  // 关键变量：验证地址仅属于本次扫码会话，关闭或刷新时立即清除。
  const [verificationUrl, setVerificationUrl] = useState<string | null>(null);
  // 关键变量：网页登录凭据只保留在当前弹窗输入中，完成、刷新或关闭即清空。
  const [webSessionValue, setWebSessionValue] = useState("");
  // 关键变量：备用登录的错误独立展示，二维码查询成功不应清除这条错误。
  const [webSessionError, setWebSessionError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  // 关键变量：同步锁住操作入口，避免一次重渲染前重复创建会话或退出账号。
  const operationRef = useRef<"qr" | "check" | "logout" | "session" | null>(null);
  // 关键变量：会话身份变化后，旧请求不得覆盖新二维码或新账号状态。
  const activeSessionIdRef = useRef<string | null>(null);
  const actionControllerRef = useRef<AbortController | null>(null);
  const onChangedRef = useRef(onChanged);
  onChangedRef.current = onChanged;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setAccount(null);
    setWebSessionValue("");
    setWebSessionError(null);
    setSummaryFailed(false);
    setError(null);
    void getNeteaseAccount(libraryId, admin, controller.signal).then((next) => {
      if (!controller.signal.aborted) setAccount(next);
    }).catch((loadError) => {
      if (!controller.signal.aborted) {
        setSummaryFailed(true);
        setError(loadError instanceof Error ? loadError.message : "网易账号状态读取失败");
      }
    }).finally(() => {
      if (!controller.signal.aborted) setLoading(false);
    });
    return () => {
      controller.abort();
      actionControllerRef.current?.abort();
      activeSessionIdRef.current = null;
    };
  }, [libraryId, admin]);

  useEffect(() => {
    if (!dialogOpen || !qrSession || operation === "session"
      || !["waiting", "scanned", "verification_required"].includes(qrStatus)) return;
    const controller = new AbortController();
    const sessionId = qrSession.sessionId;
    const delay = Math.max(1, qrSession.pollIntervalSeconds) * 1_000;
    // 关键变量：当前会话有效期固定，刷新二维码后旧轮询立即退出。
    const expiresAt = new Date(qrSession.expiresAt).getTime();
    let timer: number | undefined;

    /** 每次请求前后读取当前操作锁，网页登录开始后旧二维码结果不再生效。 */
    function isCurrentSession(): boolean {
      return !controller.signal.aborted && activeSessionIdRef.current === sessionId
        && operationRef.current !== "session";
    }

    /** 前一次查询完成后再安排下一次，避免慢接口导致轮询重叠。 */
    async function pollSession(): Promise<void> {
      if (!isCurrentSession()) return;
      if (Date.now() >= expiresAt) {
        setQrStatus("expired");
        setVerificationUrl(null);
        return;
      }
      try {
        const next = await checkNeteaseQrSession(libraryId, sessionId, admin, controller.signal);
        if (!isCurrentSession()) return;
        setError(null);
        if (next.status === "authorized") {
          // 关键变量：部分服务版本授权结果只给状态，成功后再读取一次账号摘要。
          const nextAccount = next.account ?? await getNeteaseAccount(libraryId, admin, controller.signal);
          if (!isCurrentSession()) return;
          setAccount(nextAccount);
          setSummaryFailed(false);
          setQrStatus("authorized");
          setVerificationUrl(null);
          setWebSessionValue("");
          setWebSessionError(null);
          setMessage(`网易账号${nextAccount.profile?.nickname ? ` ${nextAccount.profile.nickname}` : ""}已登录`);
          void onChangedRef.current().catch(() => undefined);
          return;
        }
        setQrStatus(next.status);
        setVerificationUrl(next.status === "verification_required" ? readOfficialVerificationUrl(next.verificationUrl) : null);
        if (next.status === "expired") return;
      } catch (pollError) {
        if (!isCurrentSession()) return;
        setError(pollError instanceof Error ? pollError.message : "网易扫码状态查询失败");
      }
      if (isCurrentSession()) {
        timer = window.setTimeout(() => void pollSession(), delay);
      }
    }

    timer = window.setTimeout(() => void pollSession(), delay);
    return () => {
      controller.abort();
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [libraryId, admin, dialogOpen, qrSession, qrStatus, operation]);

  /** 获取新的二维码；更换会话前取消旧请求，使切换账号可直接重新扫码。 */
  async function startLogin(): Promise<void> {
    if (loading || operationRef.current !== null) return;
    operationRef.current = "qr";
    setOperation("qr");
    actionControllerRef.current?.abort();
    const controller = new AbortController();
    actionControllerRef.current = controller;
    activeSessionIdRef.current = null;
    setQrSession(null);
    setQrStatus("waiting");
    setVerificationUrl(null);
    setWebSessionValue("");
    setWebSessionError(null);
    setMessage(null);
    setError(null);
    setDialogOpen(true);
    try {
      const session = await createNeteaseQrSession(libraryId, admin, controller.signal);
      if (controller.signal.aborted || actionControllerRef.current !== controller) return;
      activeSessionIdRef.current = session.sessionId;
      setQrSession(session);
    } catch (loginError) {
      if (!controller.signal.aborted) setError(loginError instanceof Error ? loginError.message : "网易二维码获取失败");
    } finally {
      if (actionControllerRef.current === controller) {
        operationRef.current = null;
        setOperation(null);
      }
    }
  }

  /** 关闭即停止本次二维码查询，已完成的登录结果继续保留。 */
  function closeLogin(): void {
    // 关键变量：会话验证包含服务端保存，等待返回结果后再关闭弹窗。
    if (operationRef.current === "session") return;
    activeSessionIdRef.current = null;
    actionControllerRef.current?.abort();
    actionControllerRef.current = null;
    operationRef.current = null;
    setOperation(null);
    setDialogOpen(false);
    setQrSession(null);
    setVerificationUrl(null);
    setWebSessionValue("");
    setWebSessionError(null);
    setError(null);
  }

  /** 用户确认后验证网页登录凭据，成功时停止旧二维码并清除本地输入。 */
  async function loginWithWebSession(): Promise<void> {
    if (loading || !dialogOpen || operationRef.current !== null) return;
    // 关键变量：允许直接粘贴值或 MUSIC_U=值，仅为当前请求构造 Cookie。
    const cookieValue = webSessionValue.trim().replace(/^MUSIC_U\s*=\s*/iu, "").trim();
    if (!cookieValue) {
      setWebSessionError("请粘贴网易网页登录凭据 MUSIC_U 的值");
      return;
    }
    const cookie = `MUSIC_U=${cookieValue}`;
    if (cookie.length > 32 * 1024) {
      setWebSessionError("登录凭据过长，请仅粘贴 MUSIC_U 的值");
      return;
    }
    operationRef.current = "session";
    setOperation("session");
    setWebSessionError(null);
    setError(null);
    setMessage(null);
    actionControllerRef.current?.abort();
    const controller = new AbortController();
    actionControllerRef.current = controller;
    try {
      const nextAccount = await importNeteaseWebSession(libraryId, cookie, admin, controller.signal);
      if (controller.signal.aborted || actionControllerRef.current !== controller) return;
      activeSessionIdRef.current = null;
      setAccount(nextAccount);
      setSummaryFailed(false);
      setWebSessionValue("");
      setWebSessionError(null);
      setQrSession(null);
      setVerificationUrl(null);
      setQrStatus("authorized");
      setMessage(`网易账号${nextAccount.profile?.nickname ? ` ${nextAccount.profile.nickname}` : ""}已登录`);
      void onChangedRef.current().catch(() => undefined);
    } catch (loginError) {
      if (!controller.signal.aborted && actionControllerRef.current === controller) {
        setWebSessionError(loginError instanceof Error ? loginError.message : "网易网页登录会话验证失败");
      }
    } finally {
      if (actionControllerRef.current === controller) {
        operationRef.current = null;
        setOperation(null);
      }
    }
  }

  /** 校验或清除当前网易登录，只更新账号状态而不调整音乐库目录。 */
  async function updateAccount(action: "check" | "logout"): Promise<void> {
    if (loading || dialogOpen || operationRef.current !== null) return;
    operationRef.current = action;
    setOperation(action);
    setError(null);
    setMessage(null);
    const controller = new AbortController();
    actionControllerRef.current = controller;
    try {
      const next = action === "logout"
        ? await logoutNeteaseAccount(libraryId, admin, controller.signal)
        : await checkNeteaseAccount(libraryId, admin, controller.signal);
      if (controller.signal.aborted) return;
      setAccount(next);
      setSummaryFailed(false);
      setMessage(action === "logout" ? "已退出网易账号，公开可播歌曲仍可匿名播放" : next.status === "expired" ? "网易登录已失效，请重新扫码" : "网易账号状态已更新");
      void onChangedRef.current().catch(() => undefined);
    } catch (accountError) {
      if (!controller.signal.aborted) setError(accountError instanceof Error ? accountError.message : "网易账号操作失败");
    } finally {
      if (actionControllerRef.current === controller) {
        operationRef.current = null;
        setOperation(null);
      }
    }
  }

  const blocked = loading || operation !== null || dialogOpen;
  const accountLabel = account?.status === "logged_in"
    ? account.profile?.nickname || "已登录"
    : account?.status === "expired" ? "已失效" : "匿名访问";

  return <div>
    <div className="grid min-h-12 min-w-0 grid-cols-1 items-center gap-x-4 gap-y-2 py-1 sm:grid-cols-[minmax(0,1fr)_auto] lg:grid-cols-[8rem_minmax(0,1fr)_auto]">
      <p className="text-sm">网易账号</p>
      <div className="min-w-0 sm:col-span-2 sm:row-start-2 lg:col-span-1 lg:col-start-2 lg:row-start-1">
        {loading ? <div aria-label="网易账号状态加载中" className="animate-pulse"><div className="h-5 w-36 rounded bg-muted" /></div>
          : <div className="flex flex-wrap items-center gap-2"><StatusPill tone={account?.status === "logged_in" ? "success" : account?.status === "expired" ? "danger" : undefined}>{accountLabel}</StatusPill>{account?.status === "expired" && account.profile?.nickname && <span className="break-all text-xs text-muted-foreground">{account.profile.nickname}</span>}</div>}
      </div>
      <div className="flex flex-wrap justify-end gap-2 sm:col-start-2 sm:row-start-1 lg:col-start-3 [&_button]:px-3 [&_button]:py-2">
        <SecondaryButton disabled={blocked} onClick={() => void startLogin()}>{account?.status === "logged_in" ? "切换账号" : "扫码登录"}</SecondaryButton>
        <SecondaryButton disabled={blocked} onClick={() => void updateAccount("check")}>{operation === "check" ? "检查中…" : "检查状态"}</SecondaryButton>
        {((account && account.status !== "anonymous") || summaryFailed) && <SecondaryButton disabled={blocked} onClick={() => void updateAccount("logout")}>{operation === "logout" ? "退出中…" : account ? "退出" : "清除登录"}</SecondaryButton>}
      </div>
    </div>
    {!dialogOpen && error && <p role="alert" className="mt-1 text-xs text-destructive">{error}</p>}
    {!dialogOpen && message && <p role="status" className="mt-1 text-xs text-muted-foreground">{message}</p>}
    {dialogOpen && <ContentSourceSettingsDialog state={{ title: "网易云音乐账号登录", busy: operation === "session", onClose: closeLogin, children: <div className="grid gap-4">
      <p className="text-xs text-muted-foreground">使用网易云音乐 App 扫码并确认。登录后沿用当前 Navidrome 连接，歌曲能否播放取决于账号权限。</p>
      {operation === "qr" && <div aria-label="网易登录二维码加载中" className="animate-pulse flex flex-col items-center gap-3 py-3"><div className="size-48 rounded-lg bg-muted" /><div className="h-4 w-36 rounded bg-muted" /></div>}
      {qrSession && qrStatus !== "authorized" && <div className="grid justify-items-center gap-3 py-1">
        <div className={`w-fit rounded-lg bg-white p-2${qrStatus === "expired" ? " opacity-35" : ""}`}><QRCodeSVG value={qrSession.qrCodeContent} size={176} bgColor="#ffffff" fgColor="#111827" level="M" marginSize={1} title="网易云音乐扫码登录" /></div>
        <p role="status" aria-live="polite" className="text-sm">{qrStatusLabels[qrStatus]}</p>
        {qrStatus !== "expired" && <p className="text-xs text-muted-foreground">有效期至 {new Date(qrSession.expiresAt).toLocaleTimeString("zh-CN")}</p>}
      </div>}
      {qrStatus === "authorized" && <p role="status" className="py-3 text-sm text-success">{message || "网易账号登录成功"}</p>}
      {qrStatus === "verification_required" && <div className="grid justify-items-center gap-3">
        {verificationUrl && <a href={verificationUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-secondary/50 px-3 py-2 text-sm text-muted-foreground transition-colors hover:text-foreground">查看网易安全提示</a>}
      </div>}
      {qrStatus !== "authorized" && <details className="border-t border-border pt-4">
        <summary className="cursor-pointer text-sm text-muted-foreground">网页登录（备用）</summary>
        <div className="mt-3 grid gap-3">
        <a href="https://music.163.com/" target="_blank" rel="noopener noreferrer" className="justify-self-start text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground">打开网易云音乐官网</a>
        <p className="text-xs text-muted-foreground">在网易官网登录后，在浏览器开发者工具的 Cookies 中复制 MUSIC_U 的值，粘贴到这里。</p>
        <label className="grid gap-2"><span className="text-xs text-muted-foreground">网页登录凭据 MUSIC_U</span><input type="password" autoComplete="off" spellCheck={false} maxLength={32 * 1024} value={webSessionValue} disabled={operation !== null} onChange={(event) => setWebSessionValue(event.target.value)} placeholder="粘贴 MUSIC_U 的值" className="w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:opacity-60" /></label>
        {webSessionError && <p role="alert" className="text-xs text-destructive">{webSessionError}</p>}
        <div className="flex justify-end [&_button]:px-3 [&_button]:py-2"><PrimaryButton disabled={operation !== null || !webSessionValue.trim()} onClick={() => void loginWithWebSession()}>{operation === "session" ? "正在验证…" : "验证并登录"}</PrimaryButton></div>
        </div>
      </details>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
      <div className="flex justify-end gap-2 [&_button]:px-3 [&_button]:py-2">
        <SecondaryButton disabled={operation === "session"} onClick={closeLogin}>{qrStatus === "authorized" ? "完成" : "取消"}</SecondaryButton>
        {qrStatus !== "authorized" && <PrimaryButton disabled={operation !== null} onClick={() => void startLogin()}>{operation === "qr" ? "正在获取…" : "刷新二维码"}</PrimaryButton>}
      </div>
    </div> }} />}
  </div>;
}
