/**
 * 同步/账户密码的统一规矩（审计 A9）。
 *
 * 空间句柄可以由账户 ID 推出来，服务端的元数据接口又会把「用密码包起来的主密钥」
 * 交给任何人——所以弱密码可以被离线字典跑出来。**新建空间**与**换密码**必须用同一条
 * 下限；而**加入已有空间**绝不能拦（老用户的旧密码可能比下限短，拦了就再也进不去）。
 */
export const MIN_PASSWORD_LENGTH = 6;

/** 新建空间 / 注册 / 换密码时调用；太短就抛一句能直接给人看的话。 */
export function assertPassword(password: string): void {
  if (password.trim().length < MIN_PASSWORD_LENGTH) {
    throw new Error(`密码太短了，至少 ${String(MIN_PASSWORD_LENGTH)} 位（它要挡住猜密码的人）。`);
  }
}

export type PasswordStrength = 'too-short' | 'weak' | 'ok' | 'strong';

/**
 * 粗略的强度估计：只看长度与字符种类，不做字典——够给一句提示，不拦人。
 */
export function passwordStrength(password: string): PasswordStrength {
  const value = password.trim();
  if (value.length < MIN_PASSWORD_LENGTH) return 'too-short';
  const kinds = [/[a-z]/, /[A-Z]/, /[0-9]/, /[^A-Za-z0-9]/].filter((pattern) => pattern.test(value)).length;
  const allSame = /^(.)\1*$/.test(value);
  const onlyDigits = /^[0-9]+$/.test(value);
  if (allSame || (onlyDigits && value.length < 12) || (value.length < 10 && kinds < 2)) return 'weak';
  if (value.length >= 14 || (value.length >= 10 && kinds >= 3)) return 'strong';
  return 'ok';
}

/** 给界面的一句提示；空串时返回 null（还没开始输入就别唠叨）。 */
export function passwordStrengthHint(password: string): string | null {
  if (password === '') return null;
  switch (passwordStrength(password)) {
    case 'too-short':
      return `太短：至少 ${String(MIN_PASSWORD_LENGTH)} 位。`;
    case 'weak':
      return '偏弱：纯数字、重复字符或太短的密码容易被猜中，建议更长或混用字母数字符号。';
    case 'ok':
      return '还行：再长一些会更安全。';
    case 'strong':
      return '够强。';
  }
}
