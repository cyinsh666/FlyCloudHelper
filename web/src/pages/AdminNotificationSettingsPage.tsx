import { Link } from "@tanstack/react-router";
import { Bot, MessageCircle, Send, UserRound } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel, StatusPill } from "@/components/ui-kit";
import {
  getAdminNotificationSettings,
  testAdminTelegramNotification,
  updateAdminNotificationEvents,
  updateAdminTelegramNotificationSettings,
  type NotificationEventSettings,
} from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";
import { cn } from "@/lib/utils";

// 关键变量：四类业务完成或异常通知可分别关闭，Telegram 渠道总开关仍独立生效。
const eventOptions = [
  { key: "credentialAbnormal", label: "凭据异常", description: "网盘登录失效等需重新授权的情况" },
  { key: "organizeCompleted", label: "整理执行完成", description: "通知本次整理的影片数和文件数" },
  { key: "scanCompleted", label: "扫描识别完成", description: "扫描任务结束后发送结果" },
  { key: "mediaProbeCompleted", label: "视频规格分析完成", description: "规格分析任务结束后发送结果" },
] as const;
type EventSwitches = Omit<NotificationEventSettings, "configurationRevision">;

/** Telegram 通知配置区块。 */
export function AdminTelegramNotificationSettingsPanel() {
  const resource = useApiResource(() => getAdminNotificationSettings(), []);
  const [enabled, setEnabled] = useState(false);
  const [botToken, setBotToken] = useState("");
  const [chatId, setChatId] = useState("");
  const [telegramUserId, setTelegramUserId] = useState("");
  const [events, setEvents] = useState<EventSwitches>({ credentialAbnormal: true, organizeCompleted: true,
    scanCompleted: true, mediaProbeCompleted: true });
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savingEvents, setSavingEvents] = useState(false);
  const [testing, setTesting] = useState(false);
  // 关键变量：只在服务端配置修订变化时同步表单，避免刷新响应覆盖用户正在输入的内容。
  const synchronizedRevisionRef = useRef<number | null>(null);
  const synchronizedEventRevisionRef = useRef<number | null>(null);

  useEffect(() => {
    const settings = resource.data?.telegram;
    if (!settings || synchronizedRevisionRef.current === settings.configurationRevision) return;
    synchronizedRevisionRef.current = settings.configurationRevision;
    setEnabled(settings.enabled);
    setChatId(settings.chatId);
    setTelegramUserId(settings.telegramUserId);
    setBotToken("");
  }, [resource.data?.telegram]);

  useEffect(() => {
    const settings = resource.data?.events;
    if (!settings || synchronizedEventRevisionRef.current === settings.configurationRevision) return;
    synchronizedEventRevisionRef.current = settings.configurationRevision;
    setEvents({ credentialAbnormal: settings.credentialAbnormal, organizeCompleted: settings.organizeCompleted,
      scanCompleted: settings.scanCompleted, mediaProbeCompleted: settings.mediaProbeCompleted });
  }, [resource.data?.events]);

  /** 保存四类业务通知开关，成功后按新修订刷新页面数据。 */
  async function saveEvents(): Promise<void> {
    if (savingEvents) return;
    setSavingEvents(true);
    setMessage(null);
    try {
      const saved = await updateAdminNotificationEvents(events);
      synchronizedEventRevisionRef.current = saved.configurationRevision;
      setMessage("通知项目已保存，新任务将按当前开关发送通知");
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "通知项目保存失败");
    } finally {
      setSavingEvents(false);
    }
  }

  /** 保存 Telegram Bot、接收目标和启用状态。 */
  async function saveTelegramSettings(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (saving) return;
    const normalizedChatId = chatId.trim();
    const normalizedTelegramUserId = telegramUserId.trim();
    if (normalizedChatId && normalizedTelegramUserId) {
      setMessage("群聊 Chat ID 和个人 TG ID 只能填写一个，请清空其中一项");
      return;
    }
    if (enabled && !normalizedChatId && !normalizedTelegramUserId) {
      setMessage("启用 Telegram 通知时，群聊 Chat ID 和个人 TG ID 必须填写一个");
      return;
    }
    setSaving(true);
    setMessage("正在保存 Telegram 通知设置…");
    try {
      const settings = await updateAdminTelegramNotificationSettings({
        enabled,
        botToken: botToken.trim(),
        chatId: normalizedChatId,
        telegramUserId: normalizedTelegramUserId,
      });
      synchronizedRevisionRef.current = settings.configurationRevision;
      setBotToken("");
      setMessage(settings.enabled ? "Telegram 通知已启用" : "Telegram 通知设置已保存，当前未启用");
      await resource.refresh();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Telegram 通知设置保存失败";
      console.warn("codex-flycloud-telegram-notification", {
        事件: "网页保存Telegram通知设置失败",
        错误信息: errorMessage,
      });
      setMessage(errorMessage);
    } finally {
      setSaving(false);
    }
  }

  /** 使用服务端已经保存的配置发送测试通知。 */
  async function sendTelegramTest(): Promise<void> {
    if (testing) return;
    const normalizedChatId = chatId.trim();
    const normalizedTelegramUserId = telegramUserId.trim();
    if (normalizedChatId && normalizedTelegramUserId) {
      setMessage("群聊 Chat ID 和个人 TG ID 只能填写一个，请清空其中一项后再测试");
      return;
    }
    if (!normalizedChatId && !normalizedTelegramUserId) {
      setMessage("请填写群聊 Chat ID 或个人 TG ID 后再测试");
      return;
    }
    setTesting(true);
    setMessage("正在发送云助手介绍消息…");
    try {
      await testAdminTelegramNotification({
        botToken: botToken.trim(),
        chatId: normalizedChatId,
        telegramUserId: normalizedTelegramUserId,
      });
      setMessage("云助手介绍消息已发送，请检查 Telegram 接收目标");
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : "Telegram 测试通知发送失败";
      console.warn("codex-flycloud-telegram-notification", {
        事件: "网页发送Telegram测试通知失败",
        错误信息: errorMessage,
      });
      setMessage(errorMessage);
    } finally {
      setTesting(false);
    }
  }

  const telegramSettings = resource.data?.telegram;

  return (
    <section className="mt-4">
      {resource.error && <Panel className="mb-4"><p className="text-sm text-destructive">{resource.error}</p></Panel>}
      {message && <Panel className="mb-4"><p className="text-sm text-muted-foreground">{message}</p></Panel>}
      <Panel title="通知项目" description="控制对应的站内通知；Telegram 推送还需启用下方渠道，扫描与规格分析沿用媒体库的任务通知开关。" className="mb-3">
        {!resource.data ? <div className="grid gap-2 sm:grid-cols-2">{[0, 1, 2, 3].map((item) => <div key={item} className="h-16 animate-pulse rounded-lg bg-secondary" />)}</div> : <>
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {eventOptions.map((option) => <div key={option.key} className="flex items-center justify-between gap-2 rounded-lg border border-border bg-secondary/20 p-3">
              <div className="min-w-0"><p className="text-sm font-medium">{option.label}</p><p className="mt-0.5 text-[11px] text-muted-foreground">{option.description}</p></div>
              <button type="button" role="switch" aria-checked={events[option.key]} aria-label={option.label}
                onClick={() => setEvents((current) => ({ ...current, [option.key]: !current[option.key] }))}
                className={cn("relative h-6 w-10 shrink-0 rounded-full border transition-colors", events[option.key] ? "border-foreground/30 bg-foreground" : "border-border bg-secondary")}>
                <span className={cn("absolute top-0.5 left-0.5 size-4 rounded-full bg-background shadow-sm transition-transform", events[option.key] && "translate-x-4")} />
              </button>
            </div>)}
          </div>
          <div className="mt-3 flex justify-end"><PrimaryButton type="button" disabled={savingEvents} onClick={() => void saveEvents()}>{savingEvents ? "保存中…" : "保存通知项目"}</PrimaryButton></div>
        </>}
      </Panel>
      <Panel title="Telegram 通知" description="通过指定 Telegram Bot 同步发送已开启的通知。">
          {!resource.data ? (
            <p className="py-12 text-center text-sm text-muted-foreground">正在读取 Telegram 通知设置…</p>
          ) : (
            <form onSubmit={(event) => void saveTelegramSettings(event)} className="grid gap-3">
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-secondary/40 p-3">
                <div className="flex min-w-0 items-center gap-3">
                  <div className="grid size-9 shrink-0 place-items-center rounded-xl border border-border bg-background/60"><Bot className="size-4" /></div>
                  <div className="min-w-0">
                    <p className="text-sm font-medium">Telegram Bot</p>
                    <p className="text-xs text-muted-foreground">{telegramSettings?.botTokenConfigured ? `Bot Token 已加密保存 · 配置 r${telegramSettings.configurationRevision}` : "尚未配置 Bot Token"}</p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <StatusPill tone={enabled ? "success" : "neutral"}>{enabled ? "已启用" : "未启用"}</StatusPill>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={enabled}
                    aria-label="启用 Telegram 通知"
                    onClick={() => setEnabled((current) => !current)}
                    className={cn("relative h-7 w-12 rounded-full border transition-colors", enabled ? "border-foreground/30 bg-foreground" : "border-border bg-secondary")}
                  >
                    <span className={cn("absolute top-0.5 left-0.5 size-5 rounded-full bg-background shadow-sm transition-transform", enabled && "translate-x-5")} />
                  </button>
                </div>
              </div>

              <label className="block">
                <span className="text-xs font-medium">Bot Token</span>
                <span className="mt-1 block text-[11px] text-muted-foreground">在 BotFather 创建机器人后取得。已有 Token 不会回显，留空表示保留当前 Token。</span>
                <input
                  type="password"
                  value={botToken}
                  onChange={(event) => setBotToken(event.target.value)}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={telegramSettings?.botTokenConfigured ? "留空以保留已保存的 Bot Token" : "例如 123456789:AA..."}
                  className="mt-1 w-full rounded-lg border border-input bg-background/50 px-3 py-2 font-mono text-sm"
                />
              </label>

              <fieldset>
                <legend className="text-xs font-medium">发送目标</legend>
                <p className="mt-1 text-[11px] text-muted-foreground">群聊 Chat ID 与个人 TG ID 只能填写一个，同时填写时无法保存或测试发送。</p>
                <div className="mt-2 grid gap-3 lg:grid-cols-2">
                  <label className="rounded-xl border border-border bg-secondary/20 p-3">
                    <span className="flex items-center gap-2 text-sm font-medium"><MessageCircle className="size-4" /> 群聊 Chat ID</span>
                    <span className="mt-1 block text-[11px] text-muted-foreground">查看群聊资料中的 t.me/xxx 链接，只填写 t.me/ 后面的 xxx。发送时会自动在最前面拼接 @，机器人必须已加入该群聊。</span>
                    <input
                      type="text"
                      inputMode="text"
                      value={chatId}
                      onChange={(event) => setChatId(event.target.value)}
                      placeholder="例如 yaiinotice"
                      className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3 py-2 font-mono text-sm"
                    />
                  </label>
                  <label className="rounded-xl border border-border bg-secondary/20 p-3">
                    <span className="flex items-center gap-2 text-sm font-medium"><UserRound className="size-4" /> 个人 TG ID</span>
                    <span className="mt-1 block text-[11px] text-muted-foreground">在 Telegram 中搜索 @userinfobot 获取你的用户 ID。必须先主动给机器人发送一条消息，否则机器人无法向你发消息。</span>
                    <input
                      type="text"
                      inputMode="numeric"
                      value={telegramUserId}
                      onChange={(event) => setTelegramUserId(event.target.value)}
                      placeholder="例如 123456789"
                      className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3 py-2 font-mono text-sm"
                    />
                  </label>
                </div>
              </fieldset>

              <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
                <p className="text-xs text-muted-foreground">测试发送使用当前表单目标；Bot Token 留空时使用服务端已保存的 Token，不会修改配置。</p>
                <div className="flex flex-wrap gap-2">
                  <SecondaryButton type="button" disabled={testing} onClick={() => void sendTelegramTest()}><Send className="size-4" /> {testing ? "正在发送…" : "测试发送"}</SecondaryButton>
                  <PrimaryButton type="submit" disabled={saving}><Bot className="size-4" /> {saving ? "正在保存…" : "保存 Telegram 设置"}</PrimaryButton>
                </div>
              </div>
            </form>
          )}
      </Panel>
    </section>
  );
}

/** 从系统设置入口进入的独立通知设置页面。 */
export function AdminNotificationSettingsPage() {
  return (
    <>
      <PageHeader
        title="通知设置"
        actions={<Link to="/admin/config"><SecondaryButton>返回系统设置</SecondaryButton></Link>}
      />
      <AdminTelegramNotificationSettingsPanel />
    </>
  );
}
