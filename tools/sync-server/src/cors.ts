/** 只给显式允许的来源回显 CORS；成功与错误响应使用同一规则。 */
export function allowedOriginHeaders(origin: string | null, allowedOrigins: readonly string[]): Record<string, string> {
  return {
    vary: 'Origin',
    ...(origin !== null && allowedOrigins.includes(origin) ? { 'access-control-allow-origin': origin } : {}),
  };
}
