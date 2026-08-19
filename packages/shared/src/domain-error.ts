/**
 * DomainError — 统一的领域错误基类。
 *
 * 大部分自定义 Error 子类的实现模式完全相同：
 *   1. 继承 Error
 *   2. 设置 this.name 为类名
 *   3. 持有 code / statusCode 字段
 *
 * 此基类消除重复的构造函数代码，子类只需关注自己的 code 和 statusCode 映射。
 *
 * 用法：
 *   export class MyServiceError extends DomainError {
 *     constructor(code: string, message: string, statusCode = 400) {
 *       super({ name: "MyServiceError", code, message, statusCode });
 *     }
 *   }
 */
export class DomainError extends Error {
  readonly code: string;
  readonly statusCode: number;

  constructor(opts: {
    name: string;
    code: string;
    message: string;
    statusCode?: number;
  }) {
    super(opts.message);
    this.name = opts.name;
    this.code = opts.code;
    this.statusCode = opts.statusCode ?? 500;
  }
}
