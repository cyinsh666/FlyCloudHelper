import { useState } from "react";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel, StatusPill } from "@/components/ui-kit";
import { useApiResource } from "@/lib/use-api-resource";
import { configureTelegramBot, generateTelegramBindingCode, getTelegramBinding, getTelegramBotStatus,
  manageTelegramBinding, type TelegramBindingCode } from "@/lib/telegram-bot-api";

/** 在指定用户下生成绑定码，个人设置使用同一块展示绑定信息。 */
export function TelegramBindingPanel({ userId, username }: { userId?: string; username?: string }) {
  // 关键变量：只有当前页面生成的码保存明文，刷新绑定状态后移除已使用的码。
  const [generated, setGenerated] = useState<Array<TelegramBindingCode & { code: string }>>([]);
  const resource = useApiResource(async () => {
    const summary = await getTelegramBinding(userId);
    const activeIds = new Set(summary.codes.map((code) => code.id));
    setGenerated((previous) => previous.filter((code) => activeIds.has(code.id)));
    return summary;
  }, [userId]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  /** 每次生成独立的绑定码，可立即复制。 */
  async function generate(): Promise<void> {
    if (busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const code = await generateTelegramBindingCode(userId);
      setGenerated((previous) => [code, ...previous]);
      await resource.refresh();
    }
    catch (error) { setMessage(error instanceof Error ? error.message : "生成绑定码失败"); }
    finally { setBusy(false); }
  }

  /** 禁用或解绑均需要明确操作，解除绑定保留已有任务和订阅。 */
  async function manage(action: "enable" | "disable" | "unbind", telegramId: string): Promise<void> {
    if (busy) return;
    if (action === "unbind" && !window.confirm(`确定解除 TG 账号 ${telegramId} 的绑定吗？该账号重新使用机器人时需要新绑定码。`)) return;
    setBusy(true);
    setMessage(null);
    try {
      await manageTelegramBinding(action, telegramId, userId);
      setMessage(action === "unbind" ? "已解除绑定" : action === "disable" ? "已禁用机器人交互" : "已启用机器人交互");
      await resource.refresh();
    } catch (error) { setMessage(error instanceof Error ? error.message : "操作失败"); }
    finally { setBusy(false); }
  }

  /** 复制失败时保留可手动选中的绑定码。 */
  async function copyCode(code: string): Promise<void> {
    try { await navigator.clipboard.writeText(code); setMessage("绑定码已复制，请私聊机器人发送"); }
    catch { setMessage("无法自动复制，请手动选中绑定码复制"); }
  }

  const bindings = resource.data?.bindings ?? [];
  const bot = resource.data?.bot;
  const plaintext = new Map(generated.map(({ id, code }) => [id, code]));
  const codes = new Map<string, TelegramBindingCode>([...(resource.data?.codes ?? []), ...generated].map((code) => [code.id, code]));
  const activeCodes = [...codes.values()].filter((code) => Date.parse(code.expiresAt) > Date.now());
  return <Panel title={username ? `${username} · Telegram 绑定` : "Telegram 绑定"}
    description="私聊机器人发送绑定码后，机器人使用该云助手用户的网盘、订阅和任务权限。" className="mt-4">
    {resource.error && <p role="alert" className="mb-3 text-sm text-destructive">{resource.error}</p>}
    {message && <p role="status" className="mb-3 text-sm text-muted-foreground">{message}</p>}
    {!resource.data ? <div className="h-24 animate-pulse rounded-lg bg-secondary" /> : <>
      {!bot?.enabled && <p className="mb-3 text-xs text-muted-foreground">机器人交互尚未开启，请管理员在通知设置中启用。</p>}
      <div className="grid gap-2">
      {bindings.length === 0 && <p className="text-sm text-muted-foreground">尚未绑定 Telegram</p>}
      {bindings.map((binding) => <div key={binding.telegramId} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border p-3">
        <div><p className="text-sm">{binding.displayName} · TG ID {binding.telegramId}</p>
          <p className="mt-1 text-xs text-muted-foreground">绑定时间：{new Date(binding.boundAt).toLocaleString("zh-CN")}</p></div>
        <div className="flex flex-wrap items-center gap-2"><StatusPill tone={binding.enabled ? "success" : "neutral"}>{binding.enabled ? "已绑定" : "已禁用"}</StatusPill>
          {userId && <SecondaryButton disabled={busy} onClick={() => void manage(binding.enabled ? "disable" : "enable", binding.telegramId)}>{binding.enabled ? "禁用" : "启用"}</SecondaryButton>}
          <SecondaryButton disabled={busy} onClick={() => void manage("unbind", binding.telegramId)}>解除绑定</SecondaryButton></div>
      </div>)}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <PrimaryButton disabled={busy || resource.loading} onClick={() => void generate()}>生成绑定码</PrimaryButton>
        {bot?.username && <a href={`https://t.me/${bot.username}`} target="_blank" rel="noreferrer" className="text-sm underline">打开机器人 @{bot.username}</a>}
        <SecondaryButton disabled={busy || resource.loading} onClick={() => void resource.refresh()}>刷新绑定状态</SecondaryButton>
      </div>
      {activeCodes.length > 0 && <div className="mt-4 grid gap-2">
        <h3 className="text-sm font-medium">可用绑定码（{activeCodes.length}）</h3>
        <p className="text-xs text-muted-foreground">每个绑定码 10 分钟内可使用一次。绑定多个 TG 账号时，请为每个账号使用不同的码。</p>
        {activeCodes.map(({ id, expiresAt }) => {
          const code = plaintext.get(id);
          return <div key={id} className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border border-border bg-secondary/20 p-3">
            {code ? <><code className="select-all font-mono text-lg tracking-widest">{code}</code>
              <SecondaryButton onClick={() => void copyCode(code)}>复制绑定码</SecondaryButton></>
              : <span className="text-sm text-muted-foreground">已生成的绑定码</span>}
            <span className="text-xs text-muted-foreground">有效期至 {new Date(expiresAt).toLocaleString("zh-CN")}</span>
          </div>;
        })}
      </div>}
    </>}
  </Panel>;
}

/** 机器人交互开关放在现有 Telegram 通知设置下，管理员通知保持独立。 */
export function AdminTelegramBotPanel() {
  const resource = useApiResource(getTelegramBotStatus, []);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  /** 开启时由服务端检查 Token 和接收方式冲突。 */
  async function toggle(): Promise<void> {
    if (busy || !resource.data) return;
    setBusy(true);
    setMessage(null);
    try { await configureTelegramBot(!resource.data.enabled); await resource.refresh(); setMessage("机器人设置已保存"); }
    catch (error) { setMessage(error instanceof Error ? error.message : "机器人设置保存失败"); }
    finally { setBusy(false); }
  }

  return <Panel title="Telegram 机器人交互" description="复用上方 Bot Token，支持私聊绑定、搜索资源、分享转存、订阅及任务查询。" className="mt-3">
    {resource.error && <p role="alert" className="mb-3 text-sm text-destructive">{resource.error}</p>}
    {message && <p role="status" className="mb-3 text-sm text-muted-foreground">{message}</p>}
    {!resource.data ? <div className="h-20 animate-pulse rounded-lg bg-secondary" /> : <>
      <div className="flex flex-wrap items-center justify-between gap-3"><div className="text-sm">
        <p>{resource.data.enabled ? "机器人交互已开启" : "机器人交互未开启"}{resource.data.username ? ` · @${resource.data.username}` : ""}</p>
        <p className="mt-1 text-xs text-muted-foreground">{!resource.data.workerEnabled ? "当前实例已关闭后台任务，不接收 Telegram 消息。" : resource.data.receiving ? "当前实例正在接收消息。" : "开启后由后台实例接收消息，共享数据库时仅一个实例接收。"}</p>
      </div><div className="flex gap-2"><SecondaryButton disabled={busy} onClick={() => void resource.refresh()}>刷新状态</SecondaryButton>
        <PrimaryButton disabled={busy || (!resource.data.enabled && !resource.data.botTokenConfigured)} onClick={() => void toggle()}>{busy ? "处理中…" : resource.data.enabled ? "关闭机器人交互" : "开启机器人交互"}</PrimaryButton></div></div>
      {!resource.data.botTokenConfigured && <p className="mt-3 text-xs text-muted-foreground">请先在上方保存 Bot Token。</p>}
      {resource.data.error && <p role="alert" className="mt-3 text-sm text-destructive">{resource.data.error}</p>}
      <p className="mt-3 text-xs text-muted-foreground">在用户管理中为指定用户生成绑定码。个人任务通知发送给该用户已启用的 TG 账号，管理员通知沿用上方配置。</p>
    </>}
  </Panel>;
}
