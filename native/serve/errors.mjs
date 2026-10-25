// native/serve/errors.mjs —— 服务端的错误类型(HTTP/MCP 各自映射成自己的形状)

export class ServeError extends Error {
  /**
   * @param {string} message
   * @param {string} [code] 机器可读的错误码(**别把错误码塞进 message** —— 客户端要能分支)
   */
  constructor(message, code = "OUUUT_SERVE_ERROR") {
    super(message);
    this.name = "ServeError";
    this.error_code = code;
  }
}

/** 鉴权失败 / 没带令牌。 */
export class ServeAuthError extends ServeError {
  constructor(message = "鉴权失败:需要 Authorization: Bearer <token>") {
    super(message, "OUUUT_SERVE_UNAUTHORIZED");
    this.name = "ServeAuthError";
  }
}
