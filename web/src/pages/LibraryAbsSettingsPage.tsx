import { Link } from "@tanstack/react-router";
import { Copy, Pencil, Plus, Settings2, Trash2, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { PageHeader, PrimaryButton, SecondaryButton } from "@/components/ConsoleShell";
import { Panel, StatusPill } from "@/components/ui-kit";
import { ProtocolPasswordInput } from "@/components/ProtocolPasswordInput";
import { getLibrary } from "@/lib/api";
import {
  createAbsAccount,
  deleteAbsAccount,
  getAbsSettings,
  resolveAbsAddress,
  revokeAbsSessions,
  updateAbsAccount,
  updateAbsSettings,
  type AbsAccount,
  type AbsAccountPatch,
  type AbsSettingsPatch,
} from "@/lib/abs-api";
import { useApiResource } from "@/lib/use-api-resource";

/** 复制用户主动选择的地址或本次生成的凭据，兼容普通 HTTP 页面。 */
async function copyAbsText(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value);
  } catch {
    const input = document.createElement("textarea");
    input.value = value;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.appendChild(input);
    input.select();
    const copied = document.execCommand("copy");
    input.remove();
    if (!copied) throw new Error("复制失败，请手动复制");
  }
}

/** 每个媒体库独立管理标准 Audiobookshelf 访问地址与账号。 */
export function LibraryAbsSettingsPage({ serviceId, admin = false }: { serviceId: string; admin?: boolean }) {
  const resource = useApiResource(async () => {
    const [detail, settings] = await Promise.all([
      getLibrary(serviceId, admin),
      getAbsSettings(serviceId, admin),
    ]);
    if (detail.library.dataType !== "audiobook") throw new Error("只有有声书库提供 ABS 协议设置");
    return { library: detail.library, settings };
  }, [serviceId, admin]);
  const [message, setMessage] = useState<string | null>(null);
  const [action, setAction] = useState<string | null>(null);
  // 关键变量：立即锁定本次操作，避免 React 重绘前重复创建或修改同一个账号。
  const actionRef = useRef<string | null>(null);
  const [pathSuffix, setPathSuffix] = useState("");
  const [createOpen, setCreateOpen] = useState(false);
  const [newUsername, setNewUsername] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [newNoPassword, setNewNoPassword] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editingUsername, setEditingUsername] = useState("");
  const [editingPassword, setEditingPassword] = useState("");
  const [editingNoPassword, setEditingNoPassword] = useState(false);
  // 关键变量：明文仅在用户创建账号后的当前页面内存中保留，不写入本地存储。
  const [createdCredential, setCreatedCredential] = useState<{
    account: AbsAccount;
    password: string;
  } | null>(null);
  const settings = resource.data?.settings;
  const settingsPath = admin ? "/admin/libraries/$serviceId/settings" : "/app/libraries/$serviceId/settings";
  useEffect(() => {
    setPathSuffix(settings?.pathSuffix ?? "");
  }, [settings?.pathSuffix]);

  /** 串行保存协议或账号操作，刷新时不清空页面已有内容。 */
  async function perform(
    name: string,
    operation: () => Promise<void>,
    successMessage: string,
  ): Promise<void> {
    if (actionRef.current) return;
    actionRef.current = name;
    setAction(name);
    setMessage(null);
    try {
      await operation();
      setMessage(successMessage);
      await resource.refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "ABS 设置保存失败");
    } finally {
      actionRef.current = null;
      setAction(null);
    }
  }

  /** 保存 ABS 启用或中转开关，不更改其他协议。 */
  async function saveSwitch(patch: AbsSettingsPatch): Promise<void> {
    await perform(
      "switch",
      async () => {
        await updateAbsSettings(serviceId, patch, admin);
      },
      "ABS 设置已保存",
    );
  }

  /** 保存固定 /abs/ 前缀后的单层地址后缀。 */
  async function savePath(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    const suffix = pathSuffix.trim();
    if (!/^[\p{L}\p{N}_-]{1,64}$/u.test(suffix)) {
      setMessage("地址后缀应为 1 到 64 个文字、数字、短横线或下划线");
      return;
    }
    await perform(
      "path",
      async () => {
        await updateAbsSettings(serviceId, { pathSuffix: suffix }, admin);
      },
      "ABS 地址已保存",
    );
  }

  /** 创建独立账号；只有这个明确动作会新增协议账号。 */
  async function createAccount(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!newUsername.trim()) return;
    await perform(
      "create",
      async () => {
        const created = await createAbsAccount(
          serviceId,
          { username: newUsername.trim(), ...(newNoPassword ? { password: "" } : newPassword ? { password: newPassword } : {}) },
          admin,
        );
        setCreatedCredential(created.account.hasPassword ? created : null);
        setNewUsername("");
        setNewPassword("");
        setNewNoPassword(false);
        setCreateOpen(false);
      },
      newNoPassword ? "ABS 免密码账号已创建" : "ABS 账号已创建，请保存本次显示的密码",
    );
  }

  /** 打开已有账号编辑区，密码留空表示不修改。 */
  function beginEdit(account: AbsAccount): void {
    if (actionRef.current) return;
    setEditingId(account.id);
    setEditingUsername(account.username);
    setEditingPassword("");
    setEditingNoPassword(!account.hasPassword);
  }

  /** 保存显式修改的用户名或新密码。 */
  async function saveAccount(event: FormEvent<HTMLFormElement>, account: AbsAccount): Promise<void> {
    event.preventDefault();
    const patch: AbsAccountPatch = {};
    if (editingUsername.trim() !== account.username) patch.username = editingUsername.trim();
    if (editingNoPassword && account.hasPassword) patch.password = "";
    else if (!editingNoPassword && editingPassword) patch.password = editingPassword;
    if (!editingNoPassword && !account.hasPassword && !editingPassword) { setMessage("请设置新密码或勾选无密码"); return; }
    if (patch.username === undefined && patch.password === undefined) {
      setMessage("账号没有修改");
      return;
    }
    await perform(
      `edit:${account.id}`,
      async () => {
        await updateAbsAccount(serviceId, account.id, patch, admin);
        if (createdCredential?.account.id === account.id) setCreatedCredential(null);
        setEditingId(null);
        setEditingPassword("");
      },
      "ABS 账号已保存",
    );
  }

  /** 切换已有账号状态。 */
  async function toggleAccount(account: AbsAccount): Promise<void> {
    if (actionRef.current) return;
    if (account.status === "active" && !window.confirm(`确定停用 ABS 账号“${account.username}”吗？其现有登录会话会被撤销。`)) return;
    await perform(
      `status:${account.id}`,
      async () => {
        await updateAbsAccount(
          serviceId,
          account.id,
          { status: account.status === "active" ? "disabled" : "active" },
          admin,
        );
      },
      account.status === "active" ? "ABS 账号已停用" : "ABS 账号已启用",
    );
  }

  /** 单独保存账号下载权限，默认允许，播放权限保持不变。 */
  async function toggleDownload(account: AbsAccount): Promise<void> {
    const canDownload = account.canDownload === false;
    await perform(
      `download:${account.id}`,
      async () => {
        await updateAbsAccount(serviceId, account.id, { canDownload }, admin);
      },
      canDownload ? "已允许该账号下载" : "已关闭该账号下载权限",
    );
  }

  /** 撤销登录会话，保留账号和收听记录。 */
  async function revoke(account: AbsAccount): Promise<void> {
    if (actionRef.current) return;
    if (!window.confirm(`撤销“${account.username}”的全部登录会话？各设备需要重新登录。`)) return;
    await perform(
      `revoke:${account.id}`,
      async () => {
        await revokeAbsSessions(serviceId, account.id, admin);
      },
      "ABS 登录会话已撤销",
    );
  }

  /** 删除账号及所属独立记录。 */
  async function remove(account: AbsAccount): Promise<void> {
    if (actionRef.current) return;
    if (!window.confirm(`删除 ABS 账号“${account.username}”及其独立使用记录？`)) return;
    await perform(
      `delete:${account.id}`,
      async () => {
        await deleteAbsAccount(serviceId, account.id, admin);
        if (createdCredential?.account.id === account.id) setCreatedCredential(null);
        if (editingId === account.id) setEditingId(null);
      },
      "ABS 账号已删除",
    );
  }

  /** 复制客户端所需的地址；已有账号密码不会尝试从服务器读取。 */
  async function copy(value: string): Promise<void> {
    try {
      await copyAbsText(value);
      setMessage("已复制");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "复制失败");
    }
  }

  if (!resource.data)
    return (
      <Panel>
        {resource.error ? (
          <p role="alert" className="text-sm text-destructive">
            {resource.error}
          </p>
        ) : (
          <div aria-label="ABS 设置加载中" className="animate-pulse space-y-3">
            <div className="h-6 w-48 rounded bg-muted" />
            <div className="h-16 rounded bg-muted" />
            <div className="h-32 rounded bg-muted" />
          </div>
        )}
      </Panel>
    );
  const { library, settings: currentSettings } = resource.data;
  const address = resolveAbsAddress(currentSettings);
  const busy = action !== null;
  return (
    <>
      <PageHeader
        title={`${library.displayName} · ABS 配置`}
        actions={<Link to={settingsPath} params={{ serviceId }}><SecondaryButton>返回媒体库设置</SecondaryButton></Link>}
      />
      {(message || resource.error) && (
        <Panel className="mb-4">
          <p role={resource.error ? "alert" : "status"} className={`text-sm ${resource.error ? "text-destructive" : "text-muted-foreground"}`}>
            {resource.error || message}
          </p>
        </Panel>
      )}
      <Panel title="ABS 设置" description={library.libraryKind === "content_source_audiobook"
        ? "已选源分类显示为多个 ABS 库，共用下方服务地址和账号；源站未提供分类的搜索命中显示在“搜索结果”库。"
        : "协议播放和服务地址集中管理，使用 ABS 客户端访问当前有声书库。"}>
        <div className="grid gap-2 md:grid-cols-2">
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/35 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium">启用 ABS</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">通过当前媒体库的独立地址和账号连接</p>
            </div>
            <button
              type="button" role="switch" aria-checked={currentSettings.enabled} aria-label="启用 ABS 协议" disabled={busy}
              onClick={() => void saveSwitch({ enabled: !currentSettings.enabled })}
              className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${currentSettings.enabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}
            ><span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${currentSettings.enabled ? "translate-x-5" : "translate-x-0"}`} /></button>
          </div>
          <div className="flex items-center justify-between gap-3 rounded-lg border border-border bg-secondary/35 px-3 py-2.5">
            <div className="min-w-0">
              <p className="text-sm font-medium">中转播放</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">关闭后优先使用源站或网盘原始地址</p>
            </div>
            <button
              type="button" role="switch" aria-checked={currentSettings.relayPlaybackEnabled} aria-label="启用 ABS 中转播放" disabled={busy}
              onClick={() => void saveSwitch({ relayPlaybackEnabled: !currentSettings.relayPlaybackEnabled })}
              className={`relative h-7 w-12 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${currentSettings.relayPlaybackEnabled ? "border-primary bg-primary" : "border-border bg-secondary"}`}
            ><span className={`absolute top-0.5 left-0.5 size-5 rounded-full bg-white shadow-sm transition-transform ${currentSettings.relayPlaybackEnabled ? "translate-x-5" : "translate-x-0"}`} /></button>
          </div>
        </div>
        <div className="mt-3 grid gap-3 border-t border-border pt-3 xl:grid-cols-[minmax(0,3fr)_minmax(260px,2fr)]">
          <form onSubmit={(event) => void savePath(event)} className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
            <div className="flex min-w-0 flex-1 overflow-hidden rounded-lg border border-input bg-background/50">
              <span className="flex shrink-0 items-center border-r border-border bg-secondary/60 px-3 font-mono text-sm text-muted-foreground">/abs/</span>
              <input aria-label="ABS 地址后缀" required value={pathSuffix} maxLength={64} disabled={busy}
                onChange={(event) => setPathSuffix(event.target.value)} className="min-w-0 flex-1 bg-transparent px-3 py-2 font-mono text-sm outline-none" />
            </div>
            <PrimaryButton type="submit" disabled={busy}><Settings2 className="size-4" /> {action === "path" ? "保存中…" : "保存地址"}</PrimaryButton>
          </form>
          <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-border bg-secondary/25 px-3 py-2">
            <p className="min-w-0 truncate font-mono text-xs" title={address}>{address}</p>
            <SecondaryButton type="button" disabled={!address} onClick={() => void copy(address)}><Copy className="size-4" /> 复制</SecondaryButton>
          </div>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">固定 /abs/ 前缀；地址后缀支持文字、数字、短横线和下划线，不能包含多级路径。</p>
        <p className="mt-1 text-[11px] text-muted-foreground">音频原样传输，不转码。来源需要额外请求头时仍使用中转。</p>
      </Panel>
      <Panel
        title="ABS 访问账号"
        description={`共 ${currentSettings.accounts.length} 个账号；同一账号在多个客户端共享收听进度，不同账号的记录独立。`}
        className="mt-4"
        action={<SecondaryButton type="button" disabled={busy} onClick={() => setCreateOpen((value) => !value)}><Plus className="size-4" /> 添加账号</SecondaryButton>}
      >
        {createOpen && (
          <form onSubmit={(event) => void createAccount(event)} className="mb-3 grid gap-2 rounded-lg border border-border bg-secondary/35 p-3 md:grid-cols-2">
            <label>
              <span className="text-xs text-muted-foreground">新账号用户名</span>
              <input required minLength={4} maxLength={255} autoComplete="off" disabled={busy} value={newUsername}
                onChange={(event) => setNewUsername(event.target.value)} className="mt-1.5 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-sm" />
            </label>
            <div><span className="text-xs text-muted-foreground">登录密码</span><ProtocolPasswordInput state={{ value: newPassword, noPassword: newNoPassword, disabled: busy, placeholder: "留空时自动生成密码", onChange: setNewPassword, onNoPasswordChange: setNewNoPassword }} /></div>
            <div className="flex flex-wrap gap-2 md:col-span-2">
              <PrimaryButton type="submit" disabled={busy || !newUsername.trim()}><Plus className="size-4" /> {action === "create" ? "正在创建…" : "创建账号"}</PrimaryButton>
              <SecondaryButton type="button" disabled={busy} onClick={() => setCreateOpen(false)}>取消</SecondaryButton>
            </div>
          </form>
        )}
        {createdCredential && (
          <div role="status" className="mb-3 rounded-lg border border-border bg-secondary/35 p-3">
            <div className="flex items-start justify-between gap-3">
              <div><p className="text-sm font-medium">新账号密码</p><p className="mt-1 text-[11px] text-muted-foreground">密码仅在本次页面中显示，请保存后关闭。</p></div>
              <button type="button" aria-label="关闭新账号密码" onClick={() => setCreatedCredential(null)} className="rounded-lg p-1 text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
            </div>
            <div className="mt-3 flex flex-wrap items-center gap-3">
              <span className="font-mono text-sm">{createdCredential.account.username}</span>
              <code className="break-all text-sm">{createdCredential.password}</code>
              <SecondaryButton type="button" onClick={() => void copy(`ABS 地址：${address}\n用户名：${createdCredential.account.username}\n密码：${createdCredential.password}`)}><Copy className="size-4" /> 复制账号</SecondaryButton>
            </div>
          </div>
        )}
        <div className="space-y-2">
          {currentSettings.accounts.map((account) => {
            const editing = editingId === account.id;
            return (
              <article key={account.id} className="rounded-lg border border-border bg-secondary/35 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-medium">{account.username}</p>
                      <StatusPill tone={account.status === "active" ? "success" : "neutral"}>{account.status === "active" ? "已启用" : "已停用"}</StatusPill>
                    </div>
                    <p className="mt-1 text-[11px] text-muted-foreground">{account.hasPassword ? "需要密码" : "未设置密码"} · {account.canDownload !== false ? "允许下载" : "禁止下载"}</p>
                  </div>
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="flex items-center gap-2 pr-1">
                      <span className="text-xs text-muted-foreground">允许下载</span>
                      <button type="button" role="switch" aria-checked={account.canDownload !== false} aria-label={`允许 ABS 账号 ${account.username} 下载`} disabled={busy}
                        onClick={() => void toggleDownload(account)}
                        className={`relative h-5 w-9 shrink-0 rounded-full border transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${account.canDownload !== false ? "border-primary bg-primary" : "border-border bg-secondary"}`}
                      ><span className={`absolute top-0.5 left-0.5 size-3 rounded-full bg-white shadow-sm transition-transform ${account.canDownload !== false ? "translate-x-4" : "translate-x-0"}`} /></button>
                    </div>
                    <SecondaryButton type="button" disabled={busy} onClick={() => beginEdit(account)}><Pencil className="size-4" /> 编辑</SecondaryButton>
                    <SecondaryButton type="button" disabled={busy} onClick={() => void revoke(account)}>撤销会话</SecondaryButton>
                    <SecondaryButton type="button" disabled={busy} onClick={() => void toggleAccount(account)}>{account.status === "active" ? "停用" : "启用"}</SecondaryButton>
                    <button type="button" aria-label={`删除 ABS 账号 ${account.username}`} disabled={busy} onClick={() => void remove(account)}
                      className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-destructive/40 bg-destructive/8 px-3 py-2 text-xs text-destructive transition-colors hover:bg-destructive/15 disabled:cursor-not-allowed disabled:opacity-40"
                    ><Trash2 className="size-3.5" /> {action === `delete:${account.id}` ? "正在删除…" : "删除"}</button>
                  </div>
                </div>
                {editing && (
                  <form onSubmit={(event) => void saveAccount(event, account)} className="mt-3 grid gap-2 border-t border-border pt-3 md:grid-cols-2">
                    <label>
                      <span className="text-xs text-muted-foreground">访问用户名</span>
                      <input required minLength={4} maxLength={255} disabled={busy} value={editingUsername}
                        onChange={(event) => setEditingUsername(event.target.value)} className="mt-1.5 w-full rounded-lg border border-input bg-background/50 px-3 py-2 text-sm" />
                    </label>
                    <div><span className="text-xs text-muted-foreground">新密码</span><ProtocolPasswordInput state={{ value: editingPassword, noPassword: editingNoPassword, disabled: busy, required: !account.hasPassword, placeholder: "留空表示不修改", onChange: setEditingPassword, onNoPasswordChange: setEditingNoPassword }} /></div>
                    <div className="flex flex-wrap gap-2 md:col-span-2">
                      <PrimaryButton type="submit" disabled={busy}><Settings2 className="size-4" /> {action === `edit:${account.id}` ? "正在保存…" : "保存账号"}</PrimaryButton>
                      <SecondaryButton type="button" disabled={busy} onClick={() => { setEditingId(null); setEditingPassword(""); }}>取消</SecondaryButton>
                    </div>
                  </form>
                )}
              </article>
            );
          })}
          {currentSettings.accounts.length === 0 && <p className="py-4 text-sm text-muted-foreground">暂无 ABS 账号，点击“添加账号”后使用客户端登录。</p>}
        </div>
        <p className="mt-3 text-[11px] text-muted-foreground">已有密码无法查看，可通过编辑设置新密码；收听记录在修改密码后保留。</p>
      </Panel>
    </>
  );
}
