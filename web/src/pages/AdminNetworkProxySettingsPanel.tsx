import { useState, type FormEvent } from "react";
import { Panel } from "@/components/ui-kit";
import { PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { getAdminNetworkProxy, testAdminNetworkProxy, updateAdminNetworkProxy } from "@/lib/api";
import { useApiResource } from "@/lib/use-api-resource";

/** 全局出站代理配置页，账号密码均可留空，密码原文不会回显。 */
export function AdminNetworkProxySettingsPanel() {
  const resource = useApiResource(() => getAdminNetworkProxy(), []);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /** 保存代理配置；留空密码保留原值，勾选清除则提交空密码。 */
  async function save(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const values = new FormData(event.currentTarget);
    const password = String(values.get("password") ?? "");
    const clearPassword = values.get("clearPassword") === "on";
    const protocol = values.get("protocol") === "socks5" ? "socks5" : "http";
    setBusy(true);
    setMessage(null);
    try {
      await updateAdminNetworkProxy({
        enabled: values.get("enabled") === "on",
        protocol,
        host: String(values.get("host") ?? "").trim(),
        port: Number(values.get("port") ?? 0),
        username: String(values.get("username") ?? "").trim(),
        ...(clearPassword || password ? { password: clearPassword ? "" : password } : {}),
      });
      await resource.refresh();
      setMessage("代理设置已保存，后续出站请求立即生效");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "代理设置保存失败");
    } finally {
      setBusy(false);
    }
  }

  /** 使用已保存的配置测试代理是否能访问公开站点。 */
  async function test(): Promise<void> {
    setBusy(true);
    setMessage("正在测试代理连接…");
    try {
      const result = await testAdminNetworkProxy();
      setMessage(result.reachable ? `代理连接成功（HTTP ${result.statusCode}）` : `目标站点返回 HTTP ${result.statusCode}`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "代理连接失败");
    } finally {
      setBusy(false);
    }
  }

  if (resource.loading && !resource.data) return <Panel className="mt-4"><p className="py-8 text-center text-sm text-muted-foreground">正在读取代理设置…</p></Panel>;
  if (resource.error && !resource.data) return <Panel className="mt-4"><p className="text-sm text-destructive">{resource.error}</p></Panel>;
  const settings = resource.data;
  if (!settings) return null;

  return <Panel title="全局出站代理" description="用于云助手服务端访问外部网站、插件源和图片。HTTP 与 SOCKS5 的账号密码均可不填。" className="mt-4">
    <form key={settings.configurationRevision} onSubmit={(event) => void save(event)} className="grid gap-4">
      <label className="flex items-center gap-2 text-sm"><input name="enabled" type="checkbox" defaultChecked={settings.enabled} />启用代理</label>
      <div className="grid gap-4 md:grid-cols-[180px_1fr_160px]">
        <label className="block"><span className="text-xs font-medium">协议</span><select name="protocol" defaultValue={settings.protocol} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm"><option value="http">HTTP</option><option value="socks5">SOCKS5</option></select></label>
        <label className="block"><span className="text-xs font-medium">主机</span><input name="host" defaultValue={settings.host} placeholder="代理服务器域名或 IP" className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
        <label className="block"><span className="text-xs font-medium">端口</span><input name="port" type="number" min="1" max="65535" defaultValue={settings.port || ""} placeholder="端口" className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
      </div>
      <div className="grid gap-4 md:grid-cols-2">
        <label className="block"><span className="text-xs font-medium">用户名（可选）</span><input name="username" autoComplete="off" defaultValue={settings.username} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
        <label className="block"><span className="text-xs font-medium">密码（可选）</span><input name="password" type="password" autoComplete="new-password" placeholder={settings.passwordConfigured ? "已配置，留空保持不变" : "不需要鉴权时留空"} className="mt-2 w-full rounded-lg border border-input bg-background/50 px-3.5 py-3 text-sm" /></label>
      </div>
      {settings.passwordConfigured && <label className="flex items-center gap-2 text-xs text-muted-foreground"><input name="clearPassword" type="checkbox" />清除已保存的密码</label>}
      <div className="flex flex-wrap gap-2"><PrimaryButton type="submit" disabled={busy}>保存设置</PrimaryButton><SecondaryButton type="button" disabled={busy || !settings.enabled} onClick={() => void test()}>测试连接</SecondaryButton><SecondaryButton type="button" disabled={busy} onClick={() => void resource.refresh()}>刷新</SecondaryButton></div>
    </form>
    {message && <p role="status" className="mt-4 text-sm text-muted-foreground">{message}</p>}
  </Panel>;
}
