# Happy 私网访问：Tailscale、Shadowrocket 与 Clash Verge

更新于 2026-11-07。手机 Shadowrocket、Safari 登录页及当次直连已验证；Clash Verge
为按官方文档整理的配置示例，尚未实机验证。迁移、备份与服务启动详见[部署手册](../deployment.md)。

## 访问地址与宿主配置

| 用途 | 地址 |
| --- | --- |
| Happy Web | <https://desktop-8ut4p0p.taild92624.ts.net/happy/> |
| Happy 自定义服务器 / Relay 基址 | `https://desktop-8ut4p0p.taild92624.ts.net/home-relay` |
| Control REST / MCP | 同域名下 `/happy-control/v1`、`/happy-control/mcp` |
| Windows 宿主 Tailscale IP | `100.116.89.36` |

访问设备加入同一 tailnet，并有访问宿主的权限。管理台已启用 MagicDNS 与 HTTPS。
Windows Tailscale 保持在线，WSL 不另装 tailscaled；链路为
`客户端 → Tailscale Serve HTTPS → 127.0.0.1:18194 → 本机 Web / Relay / Control`。
服务只对 tailnet 开放，未启用 Funnel，旧 99.55 / 99.57 Happy 公网入口已退役。

宿主 PowerShell 配置 / 查看入口（已配置时只需执行 `serve status`）：

```powershell
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
& $ts serve --bg --yes http://127.0.0.1:18194
& $ts serve status
```

客户端 Happy 的服务器地址填 `/home-relay` 基址；Safari 打开 `/happy/`，使用原账号登录。

## iPhone：Shadowrocket 内置 Tailscale

1. 使用支持内置 Tailscale / MagicDNS 的新版 Shadowrocket（[官方版本记录](https://apps.apple.com/us/app/shadowrocket/id932747118)）。
   手机独立 Tailscale App 断开，只开启 Shadowrocket 的 VPN；宿主 Tailscale 继续运行。
2. 在同一 tailnet 的[管理台](https://login.tailscale.com/admin/settings/keys)生成 Auth Key。
   个人常用手机可关闭 Reusable、Ephemeral；需要审批的网络还需批准设备。
3. Shadowrocket → 设置 → Tailscale：启用并填入 Auth Key，控制服务器保持默认
   `https://controlplane.tailscale.com`，不选择出口节点，关闭“始终使用 DERP”。
4. 使用“配置”模式，在当前配置的 `[Rule]` 最前面加入以下规则，保存并重新连接：

```ini
[Rule]
DOMAIN,desktop-8ut4p0p.taild92624.ts.net,TAILSCALE
IP-CIDR,100.116.89.36/32,TAILSCALE,no-resolve
```

5. Safari 打开上面的 Web 地址。此处 `TAILSCALE` 表示使用 Shadowrocket 内置隧道。
   Auth Key 只保存在客户端，不写入仓库或日志；设备注册与密钥有效期见
   [Tailscale Auth Key 说明](https://tailscale.com/docs/features/access-control/auth-keys)。

## Windows：Clash Verge Rev 配合独立 Tailscale

此方案由 Windows Tailscale 客户端接入同一 tailnet，Clash Verge 负责其他代理流量。
先确认只开 Tailscale 时能访问 Happy，再启用 Clash Verge 的系统代理，选择“规则”模式。

订阅右键 → 编辑规则 → 前置规则（prepend），按顺序加入以下规则；它们应位于订阅兜底规则前。
规则编辑器中每行对应一条；若使用 YAML 编辑，列表项前加 `- `。

```text
PROCESS-NAME,tailscaled.exe,DIRECT
DOMAIN-SUFFIX,taild92624.ts.net,DIRECT
IP-CIDR,100.64.0.0/10,DIRECT,no-resolve
IP-CIDR6,fd7a:115c:a1e0::/48,DIRECT,no-resolve
```

需要 TUN 模式时，在 TUN 设置的路由排除地址中追加以下网段，保留已有条目。
最终运行配置应包含：

```yaml
tun:
  route-exclude-address:
    - 100.64.0.0/10
    - fd7a:115c:a1e0::/48
```

若 Clash 接管 DNS，将 tailnet 域名交给 Tailscale 的 `100.100.100.100` 解析，并排除
Fake-IP。以下是应合并进现有配置的片段，适用于默认 `fake-ip-filter-mode: blacklist`：

```yaml
dns:
  fake-ip-filter:
    - "+.taild92624.ts.net"
  nameserver-policy:
    "+.taild92624.ts.net": "100.100.100.100"
  direct-nameserver-follow-policy: true
```

保留已有 `fake-ip-filter` 条目和 `nameserver-policy` 映射；若原过滤模式是 `rule`，
在过滤规则前追加 `DOMAIN-SUFFIX,taild92624.ts.net,real-ip`；`whitelist` 模式需按原配置
调整，不能直接套用上面的黑名单片段。解析宿主应得到 `100.116.89.36`，避免得到 Fake-IP。

保存后检查“运行配置”和连接记录，Happy 应匹配 `DIRECT` 并经系统 Tailscale 路由。
Clash 扩展配置可能整体替换 DNS 列表 / 映射，TUN 界面设置也可能覆盖扩展，请按
[Clash Verge 扩展合并规则](https://www.clashverge.dev/guide/extend.html)保留原配置；字段定义见
[Mihomo DNS](https://wiki.metacubex.one/config/dns/)与 [TUN](https://wiki.metacubex.one/config/inbound/tun/)。
本节采用独立客户端方案；新版内核另有[内置 Tailscale 出站](https://wiki.metacubex.one/config/proxies/tailscale/)，
需核对所装内核支持情况，不直接复制 Shadowrocket 的 `TAILSCALE` 策略名。

## 这次空白 / 转圈与 DERP 问题

- Relay health 是小响应，能看到文字只证明该接口可达。Web 还需下载、执行较大的 JS 等资源。
  迁移后的 Nginx 遗漏 gzip，主 JS、common JS、WASM 原始合计约 20.82 MB；补齐压缩后
  降至约 6.46 MB，并补充缓存策略。WASM 不等于登录首屏必定下载的资源。
- 同期手机曾经美国 DERP 中继，ping 约 329～1214 ms。压缩后隔离浏览器登录页通过，
  用户也确认 Safari 出现登录页；登录后的收发和附件上传仍未验证。
- 用户随后反馈速度很快，宿主 `status` 显示手机 `active; direct`，`ping` 显示对端
  UDP 地址、约 49 ms，确认当次直连成功；最初未直连的具体原因未确定。

“始终使用 DERP”关闭表示允许尝试直连；直连暂时无法建立时仍会自动中继，也可能稍后
升级为直连。换网后路径可能再次变化，见 [Tailscale 连接类型](https://tailscale.com/docs/reference/connection-types)。
判断以 `status` 的 `direct` / `relay` 与 `ping` 的实际路径为准；JSON 中仍有 `Relay: sfo`
不能单独证明仍在中继，直连时也可能保留该字段。

## 查看链路与服务日志

宿主 PowerShell（手机 IP 以 `status` 当前显示为准，此处为本次设备）：

```powershell
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
& $ts status
& $ts ping --c 3 --timeout 3s 100.93.129.83
& $ts netcheck
& $ts serve status
```

`ping` 输出 `via <对端IP:端口>` 表示直连，`via DERP(...)` 表示中继。
`netcheck` 的 `UDP: true` 只反映宿主探测结果，不能单独证明手机已直连。

WSL 查看最近日志与 HTTP 响应：

```sh
docker logs --since 10m --tail 100 happy-local-gateway-1
docker logs --since 10m --tail 100 happy-relay-relay-1
docker logs --since 10m --tail 100 happy-local-control-1
journalctl -u happy-automation-worker.service --since "10 min ago" -n 80 --no-pager
curl --noproxy '*' -fsS https://desktop-8ut4p0p.taild92624.ts.net/home-relay/health
curl --noproxy '*' -sSI -H 'Accept-Encoding: gzip' \
  https://desktop-8ut4p0p.taild92624.ts.net/happy/canvaskit.wasm
```

压缩响应应有 `Content-Encoding: gzip`，并检查 `Vary: Accept-Encoding`。
网关常规访问日志默认关闭，这次临时请求日志已撤销；`docker logs` 没有请求行不代表没有访问。
网页问题还需查看浏览器 Network / Console 的资源耗时、错误及非预期 4xx / 5xx。

手机查看 Shadowrocket 的连接 / 代理日志、DNS 日志；Clash Verge 查看连接匹配与日志，
导出时区分 GUI 日志和 `service` 内核日志，见[官方日志说明](https://www.clashverge.dev/guide/log.html)。
分享日志时去除 Auth Key、Token、订阅链接和认证头。完整压缩验证与证据路径见
[部署手册的首屏修复记录](../deployment.md#web-首屏加载缓慢修复2026-11-07)。
