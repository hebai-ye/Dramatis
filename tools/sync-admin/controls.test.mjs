import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createContext, runInContext } from 'node:vm';

const source = readFileSync(new URL('./web/app.js', import.meta.url), 'utf8');

function controls() {
  const context = createContext({
    document: { getElementById: () => ({ addEventListener() {} }) },
    window: { addEventListener() {} },
    AbortSignal,
    URLSearchParams,
    setTimeout,
    clearTimeout,
  });
  runInContext(source, context, { filename: 'tools/sync-admin/web/app.js' });
  const helpers = runInContext(
    `({
      capacityValue: typeof capacityValue === 'function' ? capacityValue : undefined,
      convertCapacity: typeof convertCapacity === 'function' ? convertCapacity : undefined,
    })`,
    context,
  );
  assert.equal(typeof helpers.capacityValue, 'function', '真实管理页应提供容量校验与字节转换');
  assert.equal(typeof helpers.convertCapacity, 'function', '真实管理页应提供 MB/GB 单位换算');
  return helpers;
}

test('管理容量按 1024 单位转换，固定配额保留 0 而 VIP 拒绝 0', () => {
  const { capacityValue } = controls();
  assert.equal(capacityValue('96', 'MB'), 96 * 1024 ** 2);
  assert.equal(capacityValue('1', 'GB'), 1024 ** 3);
  assert.equal(capacityValue('0', 'MB'), 0);
  assert.equal(capacityValue('0', 'GB', true), 0);
  assert.throws(() => capacityValue('0', 'MB', false));
  assert.throws(() => capacityValue('0.0000001', 'MB', false));
  assert.equal(capacityValue(String(1 / 1024 ** 2), 'MB', false), 1);
});

test('MB/GB 切换保持 1.5 GB 与小数容量的字节额度，往返不截断', () => {
  const { capacityValue, convertCapacity } = controls();
  const megabytes = convertCapacity('1.5', 'GB', 'MB');
  assert.equal(Number(megabytes), 1536);
  assert.equal(Number(convertCapacity(megabytes, 'MB', 'GB')), 1.5);
  assert.equal(capacityValue('1.5', 'GB'), capacityValue('1536', 'MB'));
  for (const [value, unit, other] of [
    ['0.1', 'GB', 'MB'],
    ['1.23456789', 'MB', 'GB'],
    [String(1 / 1024 ** 2), 'MB', 'GB'],
  ]) {
    const converted = convertCapacity(value, unit, other);
    const roundTrip = convertCapacity(converted, other, unit);
    assert.equal(capacityValue(converted, other), capacityValue(value, unit));
    assert.equal(capacityValue(roundTrip, unit), capacityValue(value, unit));
  }
  assert.equal(capacityValue('1.0000005', 'MB'), Math.round(1.0000005 * 1024 ** 2));
});

test('非法输入或单位被拒绝，1 TiB 上界允许且超过上界不被截断放行', () => {
  const { capacityValue, convertCapacity } = controls();
  for (const value of ['', ' ', 'NaN', 'Infinity', '-Infinity', '-1', 'bad-number'])
    assert.throws(() => capacityValue(value, 'MB'), `拒绝容量 ${JSON.stringify(value)}`);
  for (const unit of ['', 'KB', 'TB', 'mb']) assert.throws(() => capacityValue('1', unit));
  assert.equal(capacityValue('1024', 'GB'), 1024 ** 4);
  assert.equal(capacityValue(String(1024 ** 2), 'MB'), 1024 ** 4);
  assert.throws(() => capacityValue('1024.000001', 'GB'));
  assert.throws(() => capacityValue('1048576.000001', 'MB'));
  assert.throws(() => convertCapacity('1', 'KB', 'MB'));
  assert.throws(() => convertCapacity('1', 'MB', 'TB'));
});
