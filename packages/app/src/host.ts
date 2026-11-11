/**
 * app 层子系统宿主（契约"app 层子系统接口"的最小实现）。
 *
 * - Subsystem：static id / deps + init(ctx)/update(dt)/dispose()；
 * - 子系统之间禁止互相 import，运行时经 ctx.get('id') 互访；
 * - ctx 提供 events / assets / config / time / get / has / peek。
 */
export interface Ctx {
  /** 跨子系统信号（松耦合事件总线） */
  readonly events: EventBus;
  /** JSON 资源加载（带缓存） */
  readonly assets: AssetCache;
  /** 只读配置 */
  readonly config: Readonly<Record<string, unknown>>;
  /** 时钟（渲染帧侧；core 禁用，此处仅供表现层） */
  readonly time: { now(): number };
  get<T>(id: string): T;
  has(id: string): boolean;
  peek<T>(id: string): T | undefined;
}

type Handler = (payload: unknown) => void;

export class EventBus {
  private readonly handlers = new Map<string, Set<Handler>>();
  on(type: string, fn: Handler): () => void {
    let set = this.handlers.get(type);
    if (!set) this.handlers.set(type, (set = new Set()));
    set.add(fn);
    return () => set.delete(fn);
  }
  emit(type: string, payload?: unknown): void {
    for (const fn of this.handlers.get(type) ?? []) fn(payload);
  }
}

export class AssetCache {
  private readonly cache = new Map<string, Promise<unknown>>();
  constructor(private readonly fetchImpl: typeof fetch = fetch.bind(globalThis)) {}
  json<T>(url: string): Promise<T> {
    let p = this.cache.get(url) as Promise<T> | undefined;
    if (!p) {
      p = this.fetchImpl(url).then((res) => {
        if (!res.ok) throw new Error(`fetch ${url} → ${res.status}`);
        return res.json() as Promise<T>;
      });
      this.cache.set(url, p);
    }
    return p;
  }
  /** 可选 JSON（404 = null）：fire 包等按角色可选的资源。 */
  jsonOptional<T>(url: string): Promise<T | null> {
    let p = this.cache.get(url) as Promise<T | null> | undefined;
    if (!p) {
      p = this.fetchImpl(url).then((res) => (res.ok ? (res.json() as Promise<T>) : null));
      this.cache.set(url, p);
    }
    return p;
  }
}

/** 子系统接口（契约：static id/deps 需实现方以 static 字段声明）。 */
export interface Subsystem {
  readonly id: string;
  readonly deps: readonly string[];
  init(ctx: Ctx): void | Promise<void>;
  update?(dtMs: number): void;
  dispose?(): void;
}

export class AppHost {
  private readonly systems: Subsystem[] = [];
  private readonly byId = new Map<string, Subsystem>();
  private readonly events = new EventBus();
  private readonly assets: AssetCache;
  private inited = false;

  constructor(
    config: Record<string, unknown> = {},
    assets?: AssetCache,
  ) {
    this.assets = assets ?? new AssetCache();
    this.configValue = config;
  }
  private configValue: Record<string, unknown>;

  /** 注册子系统（init 前调用；id 唯一）。 */
  use(sys: Subsystem): this {
    if (this.inited) throw new Error(`AppHost：init 后不得注册子系统（${sys.id}）`);
    if (this.byId.has(sys.id)) throw new Error(`AppHost：子系统 id 重复 ${sys.id}`);
    this.systems.push(sys);
    this.byId.set(sys.id, sys);
    return this;
  }

  private ctx: Ctx | null = null;

  /** 按依赖拓扑初始化全部子系统（deps 声明必须先 init 的 id）。 */
  async init(): Promise<void> {
    if (this.inited) return;
    const ctx: Ctx = {
      events: this.events,
      assets: this.assets,
      config: this.configValue,
      time: { now: () => performance.now() },
      get: <T>(id: string) => {
        const s = this.byId.get(id) as T | undefined;
        if (!s) throw new Error(`ctx.get：子系统未注册 ${id}`);
        return s;
      },
      has: (id: string) => this.byId.has(id),
      peek: <T>(id: string) => this.byId.get(id) as T | undefined,
    };
    this.ctx = ctx;
    const done = new Set<string>();
    const pending = [...this.systems];
    while (pending.length > 0) {
      const i = pending.findIndex((s) => s.deps.every((d) => done.has(d)));
      if (i < 0) throw new Error(`AppHost：子系统依赖无法满足（${pending.map((s) => s.id).join(',')}）`);
      const [sys] = pending.splice(i, 1);
      if (!sys) break;
      await sys.init(ctx);
      done.add(sys.id);
    }
    this.inited = true;
  }

  /** 每渲染帧：注册序推进全部子系统。 */
  update(dtMs: number): void {
    for (const s of this.systems) s.update?.(dtMs);
  }

  dispose(): void {
    for (const s of [...this.systems].reverse()) s.dispose?.();
    this.systems.length = 0;
    this.byId.clear();
    this.inited = false;
  }
}
