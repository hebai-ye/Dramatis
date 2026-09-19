/**
 * 加密相关的错误类型（P2-6 第二步）。
 *
 * 单开一个类型是为了让上层能分辨「密码错 / 数据被改过」与「环境不支持」
 * 这类问题——前者要提示用户，后者要提示部署方式（见 SYNC.md §7 的验收）。
 */
export class CryptoError extends Error {
  override readonly name = 'CryptoError';
}
