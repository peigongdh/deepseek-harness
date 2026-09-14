# Agent Note: 已认证浏览器的设置访问

Status: implemented

[English](2026-09-15-authenticated-browser-settings.md) | 中文

## 问题

已认证的非 loopback 浏览器可以访问 Host API，但页面主机名检查会禁止其读取和写入设置。模型页面缺少设置文档时无法加载提供方目录，并显示 `settings are unavailable in this browser`。

## 决策

设置插件为所有通过 Remote 连接的浏览器使用 Host 持久化。Connection 按照[浏览器启动令牌认证](../architecture/2026-08-24-browser-token-authentication.zh.md)执行请求认证和 Host/Origin 校验。浏览器主机名分类不授予或撤销设置权限。显式的仅内存 scope 消费者仍可使用，且不写入 Host。

本决策仅取代 [Host 持久化 Web 偏好](2026-08-06-host-backed-web-preferences.zh.md)中的非 loopback 持久化限制。该记录继续规定共享镜像、revision、失效通知和释放规则。

## 曾考虑的替代方案

**仅从 loopback 配置模型。** 同一浏览器凭据授权完整 Host API，但已认证的网络用户仍无法管理设置。

**把受信任的网络地址标记为 loopback。** 主机名分类还影响其他浏览器行为。修改设置消费者可以保留该区分，并由 Connection 负责认证。

## 后果

无论页面主机名是什么，已认证浏览器均可读取和保存共享 Host 设置。此变更不增加监听地址、受信任地址、认证绕过或传输加密。部署仍负责网络暴露范围和传输安全。

插件单元测试覆盖两种 loopback 状态。无密钥模型浏览器场景分别使用 loopback 和受信任的非 loopback 主机名，对照各地址对应的 UI 快照验证设置及凭据写入。远程页面不显示原生配置文件操作。两类测试均不调用模型提供方。
