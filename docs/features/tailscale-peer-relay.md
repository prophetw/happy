# Tailscale 原生客户端与 Peer Relay（MiniNeo）

更新于 2026-11-08。记录在 MiniNeo（Windows 11）安装原生 Tailscale 客户端、加入
`taild92624.ts.net`，以及把本机 UDP 40000 配置为 Peer Relay 的过程与排障经验。
安装、登录、MagicDNS 访问和 peer-relay 转发均已实测；动态公网 IP 的静态端点方案
未启用，见“动态公网 IP”一节。

相关文档：[Happy 私网访问：Tailscale、Shadowrocket 与 Clash Verge](tailscale-access.md)、
[部署手册](../deployment.md)。

## 环境与目标

| 项目 | 值 |
| --- | --- |
| 本机 | MiniNeo，Windows 11 |
| Tailscale | 1.104.5 |
| 设备名 / Tailscale IP | `minineo` / `100.71.62.40` |
| tailnet | `taild92624.ts.net` |
| 宿主 | `desktop-8ut4p0p` / `100.116.89.36` |
| Happy Relay | `https://desktop-8ut4p0p.taild92624.ts.net/home-relay` |

MiniNeo 之前通过 Clash Verge 的内置 Tailscale 出站（登记设备 `happy-other-pc`）访问
`/home-relay`。安装原生客户端后两者可以并存：原生客户端负责系统级 tailnet 路由，
Clash 的 `Happy-Tailscale` 出站与 `tailscale-happy` 状态目录保留，不要删除。

## 安装原生客户端

### 下载

当前网络下 `winget` 源更新失败，找不到 `tailscale.tailscale`，改用官方 MSI：

<https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi>

正常网络下直接下载即可：

```powershell
$dir = "$env:USERPROFILE\Downloads\tailscale-install"
New-Item -ItemType Directory -Force $dir | Out-Null
curl.exe -L -o "$dir\tailscale-setup.msi" `
  https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi
```

如果 Clash TUN / DNS 异常导致域名下载失败，可临时绑定 WLAN 网卡、并用路由器 DNS
解析出的 CDN 地址固定目标（下面的 `--resolve` IP 只是当次快照）：

```powershell
$wlanIp = (Get-NetIPAddress -InterfaceAlias WLAN -AddressFamily IPv4).IPAddress
$cdnIp = (Resolve-DnsName pkgs.tailscale.com -Server 192.168.1.1 -Type A |
  Where-Object { $_.IPAddress } | Select-Object -First 1 -ExpandProperty IPAddress)
curl.exe --interface $wlanIp -4 -L --resolve "pkgs.tailscale.com:443:$cdnIp" `
  -o "$dir\tailscale-setup.msi" `
  https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi
```

下载后校验官方签名：

```powershell
Get-AuthenticodeSignature "$dir\tailscale-setup.msi" |
  Select-Object Status, @{n = 'Signer'; e = { $_.SignerCertificate.Subject } }
# Status: Valid
# Signer: CN=Tailscale Inc., O=Tailscale Inc., ...
```

### 安装

MSI 需要管理员权限，会弹 UAC：

```powershell
$msi = "$env:USERPROFILE\Downloads\tailscale-install\tailscale-setup.msi"
Start-Process msiexec.exe -Verb RunAs -Wait -ArgumentList @(
  '/i', "`"$msi`"", '/qb', '/norestart',
  '/l*v', "`"$env:USERPROFILE\Downloads\tailscale-install\install.log`""
)
```

安装完成后核对：

```powershell
Get-Service Tailscale | Select-Object Status, StartType   # Running / Automatic
& 'C:\Program Files\Tailscale\tailscale.exe' version      # 1.104.5 ...
Get-NetAdapter | Where-Object { $_.InterfaceDescription -match 'Tailscale' }
# 应出现 Status 为 Up 的 Tailscale 虚拟网卡
```

说明：未提权时 `IsInRole(Administrator)` 返回 False 是正常现象，`whoami /groups`
里 `BUILTIN\Administrators` 显示 `Group used for deny only` 只是 UAC 过滤令牌；
账号在管理员组里就可以通过 UAC 提权。若 UAC 被取消，重新执行或直接双击 MSI。

### 登录

```powershell
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
& $ts up --hostname=minineo
```

命令会在 stderr 输出一次性授权地址（`https://login.tailscale.com/a/...`）。在浏览器
打开并登录，或把这一个 URL 拿到手机 / 其他设备上打开。**授权 URL 只用一次，不要写入
仓库、日志或文档。**

验证：

```powershell
& $ts status
& $ts ip -4
& $ts ping -c 3 desktop-8ut4p0p
```

`status` 应显示 `minineo` 和 `desktop-8ut4p0p`；`ping` 初期可能显示
`via DERP(lax)`，配置 peer relay 后会升级为 `peer-relay` 路径。

Happy Relay 健康检查（Windows `curl` 需加 `--ssl-no-revoke`，原因见排障）：

```powershell
curl.exe --ssl-no-revoke -sS -w "`nHTTP %{http_code}`n" `
  https://desktop-8ut4p0p.taild92624.ts.net/home-relay/health
# {"status":"ok","timestamp":"...","service":"happy-server"}
# HTTP 200
```

## Peer Relay 配置

### 原理与前提

Peer Relay 让 tailnet 内的设备在直连失败时，优先经另一台设备的中继转发，而不是直接
落到 DERP。中继流量仍由 WireGuard 端到端加密，中继机看不到明文。要求：

- 中继机 Tailscale >= 1.86，且不能是 iOS / Apple TV / Android；
- 中继机至少有一个对其他 tailnet 设备可达的 UDP 端口；
- 使用中继的设备同样 >= 1.86，并有 `tailscale.com/cap/relay` 授权；
- 只在直连失败时启用；DERP 仍负责握手协商和兜底，Peer Relay 不是公网 DERP 的替代品。

参考：[Tailscale Peer Relays](https://tailscale.com/docs/features/peer-relay)。

### 本机启用

```powershell
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
& $ts set --relay-server-port=40000
& $ts get relay-server-port          # 40000

Get-NetUDPEndpoint -LocalPort 40000 |
  Select-Object LocalAddress, LocalPort, OwningProcess
# 0.0.0.0:40000 和 [::]:40000，OwningProcess 为 tailscaled
```

该偏好保存在 tailscaled 配置中，服务重启后仍保留；防火墙规则同样是持久的。

Windows 防火墙需要放行入站 UDP 40000（管理员）：

```powershell
netsh advfirewall firewall add rule name="Tailscale Peer Relay UDP 40000" `
  dir=in action=allow protocol=UDP localport=40000 profile=any
```

核对规则：

```powershell
Get-NetFirewallRule -DisplayName "Tailscale Peer Relay UDP 40000" |
  Select-Object Enabled, Direction, Action, Profile
```

路由器 / 光猫上的 40000 端口映射必须是 **UDP**（或 TCP+UDP）。只做 TCP 映射时
Peer Relay 不可用。

关闭并回滚：

```powershell
& $ts set --relay-server-port=""
# 管理员：
Remove-NetFirewallRule -DisplayName "Tailscale Peer Relay UDP 40000"
```

### 管理台授权

Peer Relay 需要管理台显式授权。打开
[Access controls → JSON editor](https://login.tailscale.com/admin/acls/file)，
在 `grants` 数组中加入：

```json
{
  "grants": [
    {
      "src": ["autogroup:member"],
      "dst": ["100.71.62.40"],
      "app": {
        "tailscale.com/cap/relay": []
      }
    }
  ]
}
```

说明：

- `dst` 是做中继的设备，这里用 minineo 的 Tailscale IP `100.71.62.40`；`src` 是可以
  经该中继访问的设备。个人 tailnet 用 `autogroup:member` 即可，也可以列出具体主机名 /
  Tailscale IP。不要用 `*`，否则所有设备都会尝试使用该中继。
- Tailscale IP 对设备是固定的，不随公网 IP 变化；只有删除 / 重建该设备时才会变。
- 如果现有策略里已经有 `grants`，把该对象追加进去，不要覆盖原有规则。
- 实际保存时 `dst: ["minineo"]` 会报
  `Error: dst="minineo": "minineo": invalid address`：该字段按地址 / 前缀解析，裸主机名
  不合法。直接用 Tailscale IP；要用名字则先在 `hosts` 中定义别名。
- `tailscale.com/cap/relay` 本身就是访问控制，不需要再单独给中继设备加网络 grant。

### 验证

在另一台设备上查看候选中继：

```powershell
tailscale debug peer-relay-servers
# 例：["100.71.62.40"]
```

在中继机 minineo 上查看实际会话：

```powershell
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
& $ts debug peer-relay-sessions
# Server port: 40000
# Sessions count: 5
# VNI ... Packets ... Bytes ...

& $ts status
# <peer> ... active; peer-relay [<endpoint>]:40000:vni:<id>, tx ... rx ...
```

本次配置后的实测结果：`desktop-8ut4p0p` 从 `relay (DERP)` 变为
`active; peer-relay [<IPv6>]:40000:vni:2`，当时 `peer-relay-sessions` 显示 5 个活跃会话。
分享 `status` / `peer-relay-sessions` 时请隐去公网 IP、IPv6 地址和 VNI 细节。

注意：Peer Relay 只在直连失败时启用。`status` 显示 `direct` 不代表配置失败；
`debug peer-relay-servers` 只说明候选存在，真正生效要看 `status` / `ping` 的路径。

### 动态公网 IP

`--relay-server-static-endpoints` 接收逗号分隔的 `ip:port` 列表，适用于端口映射 /
负载均衡等自动发现覆盖不到的场景；它**不接受主机名**。动态公网 IP 不要写死。

本次验证中 Tailscale 自动发现了中继端点（`status` 里的 peer-relay 端点为本机 IPv6
地址的 `:40000`），因此保持静态端点为空：

```powershell
& $ts get relay-server-static-endpoints   # 空
```

如果换到没有 IPv6、或者 IPv4 端口映射无法被自动发现的网络，再用计划任务在公网 IP
变化时刷新静态端点。下面脚本未在本机启用，属于备用方案（未验证）：

```powershell
$ts = 'C:\Program Files\Tailscale\tailscale.exe'
$port = 40000
$ip = $null
foreach ($url in @('https://api.ipify.org', 'https://ipv4.icanhazip.com', 'https://ip.sb')) {
    try {
        $v = (& curl.exe --ssl-no-revoke -4 -s -m 10 $url).Trim()
        if ($v -match '^\d{1,3}(\.\d{1,3}){3}$') { $ip = $v; break }
    } catch { }
}
if (-not $ip) { exit 1 }
$desired = "${ip}:${port}"
$current = (& $ts get relay-server-static-endpoints 2>$null)
if ($current -ne $desired) {
    & $ts set --relay-server-static-endpoints="$desired"
}
```

用任务计划程序每 5–10 分钟运行一次即可；`tailscale set` 只改这一项偏好，不会覆盖其他
设置。记录日志时不要包含 Token、Auth Key 或完整的公网地址。

## 排障经验

### Clash Verge TUN 残留导致 DNS 黑洞

症状：Clash 处于 TUN 模式，`Meta` 虚拟网卡仍存在且默认路由指向它，但网卡 DNS
`198.18.0.2` 无响应；所有域名解析超时，IP 直连却正常。Clash Verge 日志里可见
`启动核心失败 (code 1006): ... core exited before its IPC endpoint became ready`，
随后降级为 Sidecar 运行，残留的 TUN 适配器把流量黑洞掉。

排查：

```powershell
Resolve-DnsName www.baidu.com -Server 198.18.0.2 -QuickTimeout   # 无结果
Resolve-DnsName www.baidu.com -Server 223.5.5.5 -QuickTimeout    # 正常
curl.exe -k -sI -m 10 --interface <WLAN-IP> https://223.5.5.5    # HTTP 404，说明链路正常
```

处理：在 Clash Verge 里关闭 TUN（或改用系统代理），确认 `Meta` 网卡消失后，
`curl https://www.baidu.com` 应恢复 200。本次处理后的状态是
`enable_tun_mode: false`、`enable_system_proxy: true`、mixed-port 7897。

教训：安装 / 登录 Tailscale 前先确认系统 DNS 与默认路由正常。TUN 残留时反复重试
下载或登录只会浪费排查时间。

### Windows curl 的证书错误

- `CRYPT_E_REVOCATION_OFFLINE` / `schannel: next InitializeSecurityContext failed`
  是证书吊销检查连不上，不代表 TCP 不通；对 Tailscale 域名加 `--ssl-no-revoke`。
- 直接访问 `https://100.116.89.36` 会因证书域名不匹配失败，必须用 MagicDNS 域名
  `https://desktop-8ut4p0p.taild92624.ts.net/...`。
- Tailscale 客户端使用 Go 的 TLS 栈，不依赖 schannel；所以 `curl` 报吊销错误时，
  `tailscale up` / `login` 仍可能正常。

### winget 与 UAC

- `winget search --id tailscale.tailscale` 在当前网络下报源更新失败、找不到包；
  直接用官方 MSI，不依赖 winget。
- MSI 必须提权；UAC 取消后重新触发或双击安装包即可。确认账号在管理员组，
  `IsInRole(Administrator)` 为 False 并不代表账号没有管理员权限。

## 当前状态（2026-11-08）

已完成并验证：

- 原生客户端 1.104.5 安装，`Tailscale` 服务自动启动；
- 登录设备 `minineo`，Tailscale IP `100.71.62.40`；
- MagicDNS 可解析，`/home-relay/health` 返回 HTTP 200；
- `relay-server-port=40000`，UDP 40000 已监听，Windows 防火墙入站规则已添加；
- ACL grant 生效后，`desktop-8ut4p0p` 显示
  `active; peer-relay [...]:40000:vni:2`，`peer-relay-sessions` 当时有 5 个活跃会话。

保持 / 待观察：

- `--relay-server-static-endpoints` 为空；当前依赖自动发现（IPv6 `:40000`）。
  换网络后如果自动发现不到端点，再启用上面的动态公网 IP 更新脚本。
- 中继会话会随直连是否成功而出现 / 消失；`status` 显示 `direct` 时不是故障。
- 分享诊断输出前隐去公网 IP、IPv6 地址、Auth Key、Token 和订阅链接。

## 参考

- [Tailscale Peer Relays](https://tailscale.com/docs/features/peer-relay)
- [Tailscale CLI `set`](https://tailscale.com/docs/reference/tailscale-cli#set)
- [Tailscale 防火墙集成](https://tailscale.com/docs/integrations/firewalls)
