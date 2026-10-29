// 境界で拒否した理由を、秘密値を含まないコードと日本語の説明で返す。
export class BoundaryError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}
