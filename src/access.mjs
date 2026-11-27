/**
 * 请求访问控制（模式参考 dsh-quota-watch、dsh-m host.ts 守卫式委派，MIT）。
 *
 * - 全部路由：官方信任检查。「守卫式委派」按 DSH 版本择优，两套官方入口语义相通：
 *   - DSH >= 0.2.2-rc.2：connection.admit({ headers, method, url, socket }) →
 *     { rejection: 401|403|503 } | { peer }（requestRejection 已在该版本删除，
 *     docs/upgrade-guide/v0.2.2-rc.2/connection-page-peer：「Use admit instead」）；
 *   - 更早版本：connection.requestRejection({ headers }) → 401|403|undefined。
 *   admit 内部先过来源栅栏（Host / Origin / sec-fetch-site，DNS rebinding 免疫）再验凭据，
 *   与 requestRejection 的判定面一致，是同一道官方围栏。
 * - 两个入口都查不到 / 抛错：一律 fail-closed 403（warn 一次）。
 * - 写路由：官方检查之外再强制同源（sec-fetch-site + Origin/Host 双校验），纵深防御。
 */

/** admit 需要的 request 形状（ConnectionTrustRequest）：headers 之外补 method/url/socket */
function trustRequestOf(req) {
  const request = { headers: req.headers };
  if (typeof req.method === "string") request.method = req.method;
  // host 头缺失时 admit 的来源栅栏必然拒绝；补一个可解析的绝对 URL 只为形状完整
  const host = typeof req.headers?.host === "string" && req.headers.host !== "" ? req.headers.host : "localhost";
  request.url = `http://${host}${typeof req.url === "string" ? req.url : "/"}`;
  if (req.socket) request.socket = { destroyed: req.socket.destroyed === true };
  if (req.signal) request.signal = req.signal;
  return request;
}

/**
 * 官方信任检查的守卫式委派：返回 401 | 403 | 503（拒绝）或 undefined（放行）。
 * @param ctx cordis 上下文（connection 经非抛式 ctx.get 查询）
 * @param logger 只需 warn/mark；诊断不经此处
 */
export function createTrustGuard(ctx, logger = console) {
  let warned = false;
  let warnedKind = null;
  const warnOnce = (kind, err) => {
    if (warned && warnedKind === kind) return;
    warned = true;
    warnedKind = kind;
    if (kind === "missing") {
      logger?.warn?.("stock-kanban: 官方 connection 信任检查（admit / requestRejection）不可用，全路由 fail-closed 403");
    } else {
      logger?.warn?.("stock-kanban: 官方 connection 信任检查执行抛错，全路由 fail-closed 403");
    }
    if (err) logger?.warn?.(err);
  };

  return (req) => {
    try {
      // 非抛式服务查询（cordis Local 对未注入属性的直接读取会抛，不得用作探测）。
      const connection = ctx?.get?.("connection");
      // 优先新 API：admit 在 0.2.2-rc.2 起是唯一入口，返回值是判别式对象。
      const admit = connection?.admit;
      if (typeof admit === "function") {
        const admission = admit.call(connection, trustRequestOf(req));
        if (admission && typeof admission === "object" && "rejection" in admission) {
          const rejection = admission.rejection;
          return typeof rejection === "number" ? rejection : 403;
        }
        return undefined; // { peer } 或空 = 放行
      }
      // 回落旧 API：仍在声明下界（0.2.0-rc.1）与 0.2.2-rc.1 之间生效。
      const reject = connection?.requestRejection;
      if (typeof reject === "function") {
        return reject.call(connection, { headers: req.headers }) ?? undefined;
      }
      warnOnce("missing");
      return 403;
    } catch (err) {
      warnOnce("throw", err);
      return 403;
    }
  };
}

export function isSameOriginRequest(req) {
  if (req.headers["sec-fetch-site"] === "cross-site") return false;
  const origin = req.headers.origin;
  if (origin === undefined || origin === null || origin === "") {
    const site = req.headers["sec-fetch-site"];
    return site === undefined || site === "same-origin" || site === "same-site" || site === "none";
  }
  const host = req.headers.host;
  if (typeof host !== "string" || host === "") return false;
  try {
    const parsed = new URL(origin);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.host === host;
  } catch {
    return false;
  }
}
