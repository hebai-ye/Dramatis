/**
 * 网页侧的同步客户端：实现已经移进内核（`@dramatis/core` 的 `sync/http-client.ts`），
 * 这样 Node 端的部署脚本与命令行工具能用同一份实现。这里保留转出，旧引用不用改。
 */
export {
  createHttpSyncTransport,
  createRemoteSpace,
  fetchRemoteSpace,
  type HttpSyncTransportOptions,
  type RemoteSpaceInput,
  type RemoteSpaceMeta,
} from '@dramatis/core';
