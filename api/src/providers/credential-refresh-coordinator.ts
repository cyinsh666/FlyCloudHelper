/** 已完成的凭据刷新结果，用于接住稍晚到达但仍携带旧凭据的请求。 */
interface RecentCredentialRefresh<TResult> {
  result: TResult;
  retainUntilMs: number;
}

/** 本次刷新结果的来源，调用方可据此记录并发复用日志。 */
export type CredentialRefreshSource = "started" | "joined" | "recent";

/** 按旧凭据值合并并发刷新，并短期保存已经完成的轮换结果。 */
export class CredentialRefreshCoordinator<TResult> {
  /** 正在执行的刷新；同一个旧凭据只能向上游提交一次。 */
  private readonly flights = new Map<string, Promise<TResult>>();
  /** 已完成的刷新；避免后到请求再次使用已经作废的旧凭据。 */
  private readonly recentResults = new Map<string, RecentCredentialRefresh<TResult>>();

  public constructor(private readonly retentionMs = 10 * 60_000) {}

  /** 获取共享刷新结果；不保存旧凭据，也不把凭据写入日志。 */
  public async execute(
    sourceCredential: string,
    refresh: () => Promise<TResult>,
  ): Promise<{ result: TResult; source: CredentialRefreshSource }> {
    this.removeExpiredResults();
    const recent = this.recentResults.get(sourceCredential);
    if (recent) return { result: recent.result, source: "recent" };

    let source: CredentialRefreshSource = "joined";
    let flight = this.flights.get(sourceCredential);
    if (!flight) {
      source = "started";
      flight = refresh();
      this.flights.set(sourceCredential, flight);
    }
    try {
      const result = await flight;
      this.recentResults.set(sourceCredential, {
        result,
        retainUntilMs: Date.now() + this.retentionMs,
      });
      return { result, source };
    } finally {
      if (this.flights.get(sourceCredential) === flight) this.flights.delete(sourceCredential);
    }
  }

  /** 删除过期结果，避免旧凭据和刷新结果长期停留在进程内存。 */
  private removeExpiredResults(): void {
    const now = Date.now();
    for (const [sourceCredential, recent] of this.recentResults) {
      if (recent.retainUntilMs <= now) this.recentResults.delete(sourceCredential);
    }
  }
}
